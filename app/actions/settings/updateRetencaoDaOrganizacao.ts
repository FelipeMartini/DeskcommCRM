"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { supportWriteError } from "@/lib/impersonate/support";
import {
  prazosParaGravar,
  validarPrazosDaOrganizacao,
  type PrazosDaOrganizacao,
  type RecusaDoPrazo,
  type TipoDePrazoDaOrganizacao,
} from "@/lib/retencao/prazos-da-organizacao";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * O estado DESEJADO dos quatro prazos: número de dias, ou `null`/ausente para
 * "volte a seguir o prazo da instalação". Não é um patch — o que não vier aqui
 * deixa de ter prazo próprio.
 */
export type PrazosEmEdicao = Partial<Record<TipoDePrazoDaOrganizacao, number | null>>;

export type UpdateRetencaoDaOrganizacaoResult =
  | { ok: true; prazos: PrazosDaOrganizacao }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "mfa_required"
        | "nao_gravou"
        | "db_error";
      /** Só em `validation_failed` que a regra de domínio acusou antes de chegar ao banco. */
      recusas?: RecusaDoPrazo[];
    };

/**
 * Grava os prazos de retenção do dado pessoal de terceiros que ESTA organização
 * escolheu (`organizations.settings.retencao`, migration 0693).
 *
 * ── O que a escolha significa ────────────────────────────────────────────────
 *
 * A organização só ENCURTA. O prazo da instalação segue valendo para todas (a
 * poda global roda antes), e o da organização apaga além dele; por isso um valor
 * igual ou maior que o global é aceito e inofensivo, e quem avisa que ele "não
 * terá efeito" é a tela (`prazoSemEfeito`), não esta action. Abaixo do piso de
 * cada tipo o banco recusa, e a regra de domínio recusa antes dele para a tela
 * dizer qual campo e qual mínimo.
 *
 * ── Por que RPC, e por que o gate daqui não é o que garante a regra ──────────
 *
 * Mesmas razões de `updateMarcaDaOrganizacao`: `organizations.settings` tem vários
 * donos, cada um regravando o jsonb inteiro em round-trips separados, e um quarto
 * escritor com esse padrão reverteria em silêncio decisões alheias (a visibilidade
 * das conversas, por exemplo). A escrita é UMA instrução dentro de
 * `fn_definir_retencao_da_organizacao`, que também re-resolve o papel no banco
 * (42501). O que o banco NÃO enxerga é o segundo fator da sessão, e por isso
 * `mfaEmDivida` fica aqui, depois do papel.
 *
 * ── A organização vem da SESSÃO ──────────────────────────────────────────────
 *
 * Nunca do argumento: quem chama a action por POST direto não escolhe em qual
 * organização grava.
 *
 * Auditoria: `org.retention_updated`, com os prazos como foram gravados. Não emite
 * `event_log` — nenhum handler consome um evento de retenção, e um evento sem
 * consumidor nasceria `pending` para sempre (anti-pattern nº 3 do CLAUDE.md).
 */
export async function updateRetencaoDaOrganizacao(
  input: PrazosEmEdicao,
): Promise<UpdateRetencaoDaOrganizacaoResult> {
  const validacao = validarPrazosDaOrganizacao(input);
  if (!validacao.ok) {
    return { ok: false, error: "validation_failed", recusas: validacao.recusas };
  }

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden_role" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(authUser, activeOrg)) {
    return { ok: false, error: "forbidden_role" };
  }
  // DEPOIS do papel, de propósito: quem nem tem o papel recebe `forbidden_role`, que
  // é a verdade sobre ele; só quem passaria pelo papel é cobrado pelo segundo fator.
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = ipDoCliente(hdrs);
  const userAgent = hdrs.get("user-agent") ?? null;

  const gravar = prazosParaGravar(validacao.prazos);
  // Nenhum prazo próprio = apagar a chave `retencao`. A função entende `{}` e
  // `null` como a mesma coisa; `{}` é o que a regra de domínio já devolve.
  //
  // A função é nova e não está em `lib/database.types.ts` (gerado de um projeto
  // Supabase vivo) — o mesmo tratamento que o cron dá às irmãs da migration 0693.
  const { data, error } = await createAdminClient().rpc(
    "fn_definir_retencao_da_organizacao" as never,
    { p_org: activeOrg.orgId, p_actor: authUser.id, p_prazos: gravar } as never,
  );

  if (error) {
    // `42501` é papel: o snapshot de membership de cima estava velho, que é o caso
    // que a duplicação no banco existe para pegar. `22023` é valor que o banco
    // recusou (a regra de domínio é a mesma, então só chega aqui se divergirem).
    if (error.code === "42501") return { ok: false, error: "forbidden_role" };
    if (error.code === "22023") return { ok: false, error: "validation_failed" };
    return { ok: false, error: "db_error" };
  }

  // A catraca da issue #144: `data` é o `row_count` do UPDATE. 0 = a organização
  // não casou o filtro, e sem esta linha a tela diria "salvo" com nada gravado.
  if (data !== 1) return { ok: false, error: "nao_gravou" };

  await audit({
    action: "org.retention_updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    ip,
    userAgent,
    metadata: {
      // Os números como o banco os guardou (`<tipo>_dias`). Sem dado de cliente.
      prazos: gravar,
      voltou_ao_prazo_da_instalacao: Object.keys(gravar).length === 0,
    },
  });

  revalidatePath("/app/settings/tenant");
  return { ok: true, prazos: validacao.prazos };
}
