import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH /api/v1/pipelines/[id]/config — vocabulário, campos personalizados,
 * motivos de perda e de ganho e reabertura de UM funil.
 *
 * É a mesma escrita da tela Configurações › Funis (`updatePipelineConfig`):
 * a mesclagem vive em `lib/pipelines/aplicar-config.ts`, e as duas portas
 * chamam a MESMA função. Sem esta rota, quem configura o CRM por código não tinha
 * como dar ao funil o vocabulário do negócio (o que o atendimento por IA fala) —
 * só a tela ou o banco à mão.
 *
 * Auth: sessão de navegador (papel admin, como a tela) OU Bearer `dsk_...`
 * (`lib/api/auth-dual.ts`) com o escopo PRÓPRIO `config:write` e papel admin no
 * token. A org sai da sessão ou da linha do token — nunca do body nem da URL — e a
 * consulta e o update filtram `organization_id` à mão (o client do token é o
 * admin, a RLS não vale). Funil de outra organização é 404, igual a um inexistente.
 *
 * O corpo é ESTRITO: chave desconhecida é recusada em vez de ignorada, porque um
 * `lost_reason` digitado errado que devolve 200 sem gravar nada é o pior desfecho
 * para quem automatiza. Corpo vazio também é recusado.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { aplicarConfigDoFunil, resumoDaConfig } from "@/lib/pipelines/aplicar-config";
import { pipelineConfigPatchSchema } from "@/lib/schemas/settings";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const corpoEstrito = pipelineConfigPatchSchema.strict();

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: pipelineId } = await ctx.params;
  if (!UUID_RX.test(pipelineId)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_pipelines",
    role: "admin",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
  const orgId = authz.organizationId;

  const teto = await tetoDeEscritaDoToken(authz, "crm_pipelines_config", requestId);
  if (teto) return teto;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo não é JSON válido."), 400, { requestId });
  }

  const parsed = corpoEstrito.safeParse(json);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  if (Object.keys(parsed.data).length === 0) {
    return fail("unprocessable_entity", t("Nada para alterar."), 422, { requestId });
  }

  const resultado = await aplicarConfigDoFunil(authz.supabase, orgId, pipelineId, parsed.data, {
    idioma: authz.idioma,
  });
  if (!resultado.ok) {
    if (resultado.error === "not_found") {
      return fail("not_found", t("Funil não encontrado."), 404, { requestId });
    }
    return fail("internal_error", resultado.error, 500, { requestId });
  }

  void audit({
    action: "pipeline.config_updated",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: orgId,
    resourceType: "pipeline",
    resourceId: pipelineId,
    requestId,
    metadata: resumoDaConfig(parsed.data),
  });

  return ok({ id: pipelineId }, { requestId });
}
