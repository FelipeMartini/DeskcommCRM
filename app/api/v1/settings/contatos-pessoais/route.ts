/**
 * GET   /api/v1/settings/contatos-pessoais — os dois interruptores do contato pessoal.
 * PATCH /api/v1/settings/contatos-pessoais — liga ou desliga (manager+).
 *
 * `comando_pelo_celular`: o `#pessoal` digitado no chat do contato marca o contato
 * como pessoal. `novos_nascem_pessoais`: o contato que aparece pela primeira vez
 * já nasce pessoal, salvo se a primeira mensagem casa uma campanha por palavra.
 * Os dois nascem desligados e só o booleano `true` liga (`lerConfigPessoal`).
 *
 * Manager+ é o mesmo papel que marca um contato pessoal pela tela
 * (`contacts/[id]/personal`): esta rota só automatiza o mesmo gesto. A regra e a
 * gravação (ler, mesclar, gravar o jsonb sem apagar as outras chaves) moram em
 * `lib/contacts/configuracao-pessoal.ts`.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  configPessoalMudancaSchema,
  gravarConfigPessoal,
  lerConfigPessoal,
} from "@/lib/contacts/configuracao-pessoal";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "personal_contacts_settings" });
  if (!authz.ok) return authz.response;

  const { data, error } = await createAdminClient()
    .from("organizations")
    .select("settings")
    .eq("id", authz.org.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(lerConfigPessoal((data as { settings?: unknown } | null)?.settings), { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "personal_contacts_settings" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = configPessoalMudancaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  // O orgId vem do papel resolvido acima, nunca do corpo (o schema é strict).
  const resultado = await gravarConfigPessoal(createAdminClient(), authz.org.orgId, parsed.data);
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
      action: "settings.personal_contacts_updated",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "organization",
      resourceId: authz.org.orgId,
      requestId,
      metadata: { pedido: parsed.data, depois: resultado.config },
    });
  }

  return ok(resultado.config, { requestId });
}
