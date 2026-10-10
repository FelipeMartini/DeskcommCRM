/**
 * GET /api/v1/settings/campanhas-whatsapp — a lista de campanhas por palavra (admin).
 * PUT /api/v1/settings/campanhas-whatsapp — substitui a lista inteira (admin).
 *
 * É o editor que o `user-journey-map` (J20) declarava como dívida: sem ele a lista
 * `organizations.settings.campanhas_whatsapp` só se escrevia por SQL. Uma mensagem
 * que casa uma campanha torna o contato elegível à IA quando o canal está em
 * "restrita por origem", e impede o contato de nascer pessoal quando
 * `novos_nascem_pessoais` está ligado — por isso é decisão de admin, o mesmo papel
 * que muda o alcance da IA por canal (`channel-sessions/[id]/ai-access`).
 *
 * PUT, e não PATCH: o corpo é a lista inteira, e a ordem importa (a primeira que
 * casa vence). A regra de formato mora em `lib/ai/elegibilidade/campanha-gravacao.ts`.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { lerCampanhas } from "@/lib/ai/elegibilidade/campanha";
import {
  MAX_CAMPANHAS,
  MIN_FRASE_NORMALIZADA,
  campanhasEntradaSchema,
  canaisForaDaOrganizacao,
  contarDescartadas,
  gravarCampanhas,
} from "@/lib/ai/elegibilidade/campanha-gravacao";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", {
    requestId,
    resource: "campaign_keywords",
    allowPlatformAdmin: "leitura",
  });
  if (!authz.ok) return authz.response;

  const { data, error } = await createAdminClient()
    .from("organizations")
    .select("settings")
    .eq("id", authz.org.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const settings = (data as { settings?: unknown } | null)?.settings;
  return ok(
    {
      campanhas: lerCampanhas(settings),
      descartadas: contarDescartadas(settings),
      limite: MAX_CAMPANHAS,
      frase_minima: MIN_FRASE_NORMALIZADA,
    },
    { requestId },
  );
}

export async function PUT(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("admin", {
    requestId,
    resource: "campaign_keywords",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = campanhasEntradaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { campanhas } = parsed.data;

  const admin = createAdminClient();
  // Um canal de outra organização nunca casaria nada aqui — mas gravá-lo é gravar
  // uma referência que o operador acredita ser sua.
  const fora = await canaisForaDaOrganizacao(admin, authz.org.orgId, campanhas);
  if (fora === null) return fail("internal_error", t("Não consegui salvar."), 500, { requestId });
  if (fora.length > 0) {
    return fail(
      "validation_failed",
      t("Um dos números escolhidos não pertence a esta organização."),
      422,
      {
        requestId,
      },
    );
  }

  const resultado = await gravarCampanhas(admin, authz.org.orgId, campanhas);
  if (!resultado.ok) {
    return fail(
      "internal_error",
      t(
        resultado.motivo === "leitura_falhou"
          ? "Não consegui ler a configuração."
          : "Não consegui salvar.",
      ),
      500,
      { requestId },
    );
  }

  if (resultado.alterado) {
    void audit({
      action: "settings.campaign_keywords_updated",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "organization",
      resourceId: authz.org.orgId,
      requestId,
      metadata: { total: resultado.campanhas.length, ...resultado.diferenca },
    });
  }

  return ok({ campanhas: resultado.campanhas }, { requestId });
}
