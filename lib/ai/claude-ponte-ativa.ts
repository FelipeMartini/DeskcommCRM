/**
 * O INTERRUPTOR DA CLAUDE-PONTE, POR ORGANIZAÇÃO.
 *
 * A ponte (`lib/ai/claude-ponte.ts`) é decidida pela INSTALAÇÃO: as três variáveis `CLAUDE_PONTE_*` do
 * `.env` dizem se ela existe e para quem. Este módulo acrescenta a escolha da ORGANIZAÇÃO dentro disso:
 * quem a instalação atende pode desligar a ponte no seu espaço (tela de Credenciais) e voltar a ligá-la.
 *
 * ═══ A regra (ordem do dono, 11/10/2026) ═══
 *
 *   - O PADRÃO É LIGADA. Organização sem a chave `settings.llm.ponte_ativa` — todas as que existem hoje —
 *     usa a ponte assim que a instalação a oferece, sem ninguém ter marcado nada.
 *   - Só o valor booleano `false` desliga. Ausente, `true`, texto, número, `null` ou lixo valem LIGADA: um
 *     valor torto no jsonb não pode tirar a IA de uma empresa em silêncio. É o oposto de uma cerca de
 *     segurança (quem nega por padrão): isto é uma preferência, e a falha dela é para o lado do padrão.
 *   - Desligar NÃO é uma cerca contra a ponte (a lista `CLAUDE_PONTE_ORGS` segue sendo quem manda sobre quem
 *     PODE usá-la); é a organização abrindo mão de uma oferta da instalação. A credencial PRÓPRIA dela
 *     continua vencendo a ponte em qualquer caso (regra 1 do módulo da ponte).
 *
 * Sem DOM, sem `@/lib/env` e sem logger, como o módulo da ponte: é lido pelo motor do worker, pelas rotas e
 * pelas páginas. O cliente do banco chega por parâmetro (só o formato mínimo do `from`).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { ponteCobreOProvedor, type FonteDeAmbiente } from "@/lib/instalacao/ambiente";

/** O pedaço do cliente do Supabase que a leitura usa — a sessão ou o admin servem. */
export type LeitorDeOrganizacao = Pick<SupabaseClient, "from">;

/**
 * A ponte está ligada nas configurações de IA (`organizations.settings.llm`)? Pura: o motor já leu o
 * jsonb e só precisa da resposta. Só o `false` booleano desliga.
 */
export function ponteLigadaNasConfiguracoes(llm: unknown): boolean {
  if (llm === null || typeof llm !== "object" || Array.isArray(llm)) return true;
  return (llm as { ponte_ativa?: unknown }).ponte_ativa !== false;
}

/**
 * Lê o interruptor da organização no banco. Erro de leitura ou organização sem linha valem LIGADA (o
 * padrão): quem decide é a instalação, e uma falha de leitura não pode desligar a IA de ninguém. O motivo
 * exato de um banco fora do ar aparece nas outras consultas do mesmo pedido.
 */
export async function ponteLigadaDaOrganizacao(
  db: LeitorDeOrganizacao,
  organizationId: string,
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    if (error || data === null || typeof data !== "object") return true;
    const settings = (data as { settings?: unknown }).settings;
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return true;
    return ponteLigadaNasConfiguracoes((settings as { llm?: unknown }).llm);
  } catch {
    return true;
  }
}

/**
 * A ponte SERVE este provedor a esta organização AGORA? É a pergunta dos portões de salvar e publicar
 * agente ("a instalação tem chave para este provedor?"): a instalação a oferece (`CLAUDE_PONTE_*` em
 * ordem e a organização na lista) **e** a organização não a desligou. A parte do `.env` é síncrona e vai
 * primeiro: só quem a instalação atende gasta uma ida ao banco.
 */
export async function ponteServeAOrganizacao(
  db: LeitorDeOrganizacao,
  provider: string,
  organizationId: string,
  source?: FonteDeAmbiente,
): Promise<boolean> {
  if (!ponteCobreOProvedor(provider, organizationId, source)) return false;
  return ponteLigadaDaOrganizacao(db, organizationId);
}
