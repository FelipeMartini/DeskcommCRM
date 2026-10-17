/**
 * O adaptador do banco para a passada por organização (migration 0688).
 *
 * Mora aqui, e não dentro do `app/api/v1/cron/data-retention/route.ts`, por uma
 * razão medida: `tests/unit/poda-de-nonces-aceita-os-nomes-das-irmas.test.ts`
 * exige que o ARQUIVO do cron cite só os dois nomes de argumento das podas
 * drenadas pelo laço (`p_retencao_dias` e `p_limite`) — é a cerca que impede o
 * conserto de um nome de parâmetro de voltar a ser invisível (issue #966). Esta
 * função fala outros três nomes (`p_tipo`, `p_organizacao`, `p_limite`) e não
 * pode ser confundida com o laço das irmãs; em outro arquivo, a cerca segue
 * valendo como foi escrita.
 *
 * O PostgREST resolve a sobrecarga pelo NOME do argumento. Os três daqui são os
 * que `fn_expurgar_por_organizacao` declara; o gate
 * `rpc-do-codigo-nasce-no-schema` confere que as duas funções existem no schema.
 *
 * As duas funções são novas e não estão em `lib/database.types.ts` (gerado a
 * partir de um projeto Supabase vivo) — mesmo tratamento que o cron dá a
 * `fn_enfileirar_midia_vencida`.
 */
import type { PodaPorOrganizacaoDb } from "@/lib/retencao/poda-por-organizacao";
import type { createAdminClient } from "@/lib/supabase/admin";

export function podaPorOrganizacaoDb(
  admin: ReturnType<typeof createAdminClient>,
): PodaPorOrganizacaoDb {
  return {
    async listarPrazos() {
      const { data, error } = await admin.rpc("fn_organizacoes_com_prazo_proprio" as never);
      return { data: Array.isArray(data) ? (data as unknown[]) : null, error };
    },
    async expurgar(tipo, organizacao, lote) {
      const { data, error } = await admin.rpc(
        "fn_expurgar_por_organizacao" as never,
        { p_tipo: tipo, p_organizacao: organizacao, p_limite: lote } as never,
      );
      return { data: typeof data === "number" ? data : null, error };
    },
  };
}
