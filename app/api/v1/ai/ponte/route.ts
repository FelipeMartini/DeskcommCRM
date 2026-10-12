import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET /api/v1/ai/ponte — a claude-ponte atende esta organização, e ela está ligada?
 * PUT /api/v1/ai/ponte — liga ou desliga a ponte para esta organização.
 *
 * A ponte (`lib/ai/claude-ponte.ts`) é oferecida pela INSTALAÇÃO: as três variáveis `CLAUDE_PONTE_*`
 * do `.env` dizem se ela existe e para quem. Esta rota é a escolha da ORGANIZAÇÃO dentro disso (ordem
 * do dono, 11/10/2026: "tem que ter como ativar e desativar pelo sistema, mas o padrão é tudo ligado").
 *
 * A escolha mora em `organizations.settings.llm.ponte_ativa` e este é o ÚNICO lugar que a escreve. O
 * PADRÃO É LIGADA: sem a chave, ou com qualquer valor que não seja o booleano `false`, vale ligada
 * (`lib/ai/claude-ponte-ativa.ts`). Quem LÊ a escolha é o motor do worker (`resolveOrgLlmConfig`), os
 * portões de salvar/publicar agente e as páginas de agente — a rota só a grava.
 *
 * GET — manager+. Devolve `{ disponivel, ativa }`. `disponivel` é a pergunta da INSTALAÇÃO (o `.env` e a
 * lista de organizações); fora dela a tela não mostra interruptor nenhum, e `ativa` volta `true` (o
 * padrão), nunca o valor que sobrou no jsonb de uma época em que a ponte existia.
 *
 * PUT — admin, `{ ativa: boolean }`. Organização que a instalação não atende recebe 409: gravar uma
 * preferência sobre algo que não existe só confundiria o dia em que a ponte for ligada para ela. Pedir o
 * valor que já vale não é mutação (nada é gravado nem auditado). Audita `ai.claude_bridge_toggled`.
 *
 * Desligar NÃO apaga nem toca credencial: a chave PRÓPRIA da organização continua vencendo a ponte em
 * qualquer caso. Desligar só faz o motor deixar de usar a assinatura da instalação para esta organização
 * — e, sem chave própria nem `ANTHROPIC_API_KEY`, os agentes dela ficam sem IA até religar.
 *
 * `organizations` só aceita escrita de platform admin pela RLS, então a escrita é pelo admin client com
 * `.eq("id", orgId)` da sessão, e em MERGE: `settings` é jsonb compartilhado com marca, MFA e o resto
 * (mesmo desenho de `app/api/v1/ai/knowledge/provedor/route.ts`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ponteLigadaNasConfiguracoes } from "@/lib/ai/claude-ponte-ativa";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { ponteCobreOProvedor } from "@/lib/instalacao/ambiente";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({ ativa: z.boolean() }).strict();

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_ponte" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const disponivel = ponteCobreOProvedor("anthropic", org.orgId);
  if (!disponivel) return ok({ disponivel: false, ativa: true }, { requestId });

  const { data } = await (
    await createClient()
  )
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  const settings = (data as { settings?: { llm?: unknown } } | null)?.settings;
  return ok({ disponivel: true, ativa: ponteLigadaNasConfiguracoes(settings?.llm) }, { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_ponte" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;
  const t = (texto: string) => traduzir(texto, user.idioma);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = corpoSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { ativa } = parsed.data;

  if (!ponteCobreOProvedor("anthropic", org.orgId)) {
    return fail(
      "ponte_indisponivel",
      t("A assinatura de IA da instalação não atende esta organização."),
      409,
      { requestId },
    );
  }

  const admin = createAdminClient();
  const { data: orgAtual } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  const settingsAtuais = ((orgAtual as { settings?: Record<string, unknown> } | null)?.settings ??
    {}) as Record<string, unknown>;
  const llmAtual =
    settingsAtuais.llm !== null &&
    typeof settingsAtuais.llm === "object" &&
    !Array.isArray(settingsAtuais.llm)
      ? (settingsAtuais.llm as Record<string, unknown>)
      : {};

  // Pedir o valor que já vale não é mutação: nada é gravado nem auditado.
  if (ponteLigadaNasConfiguracoes(llmAtual) === ativa) {
    return ok({ ativa, mudou: false }, { requestId });
  }

  const { data: gravado, error: escritaErr } = orgAtual
    ? await admin
        .from("organizations")
        .update({ settings: { ...settingsAtuais, llm: { ...llmAtual, ponte_ativa: ativa } } })
        .eq("id", org.orgId)
        .select("id")
        .maybeSingle()
    : { data: null, error: null };
  // Leitura vazia não pode virar `settings` novo em branco (apagaria marca, MFA e o resto), e zero
  // linhas na escrita volta como SUCESSO no PostgREST: sem esta conferência a tela diria "salvo"
  // sem nada gravado.
  if (escritaErr || !gravado) {
    logger.error("[ai-ponte] falha ao gravar a escolha", {
      error: escritaErr?.message ?? "nenhuma_linha",
      requestId,
    });
    return fail("internal_error", t("Não foi possível salvar a escolha."), 500, { requestId });
  }

  void audit({
    action: "ai.claude_bridge_toggled",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    requestId,
    metadata: { ativa },
  });

  return ok({ ativa, mudou: true }, { requestId });
}
