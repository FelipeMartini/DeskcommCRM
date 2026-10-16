/**
 * O OMNIROUTER DA INSTALAÇÃO, LIDO PELO APP — o que a tela e os portões de agente perguntam.
 *
 * `lib/ai/omnirouter.ts` decide (puro). Este módulo LÊ: o endereço, a chave e a oferta geral vêm da
 * tela de Credenciais da instalação (`platform_config`, com o `.env` como piso — `valorDaInstalacao`),
 * e a ESCOLHA da organização vem de `organizations.settings.omnirouter.habilitado`. O motor do worker
 * lê as mesmas fontes por outro caminho (`lib/instalacao/config-sql.ts`), pela mesma regra.
 *
 * ═══ A regra (ordem do dono, 16/10/2026, no modelo misto) ═══
 *
 *   - O endereço, a chave e a oferta geral (`OMNIROUTER_PARA_TODAS`) são da INSTALAÇÃO: quem os grava é
 *     o administrador da plataforma, em Credenciais.
 *   - Quem o OmniRouter atende é escolha da ORGANIZAÇÃO, feita pelo administrador da plataforma no
 *     cartão da organização (`/api/v1/admin/tenants/[id]/ai`): `habilitado: true` atende; `false`
 *     recusa mesmo com a oferta geral; sem escolha, vale a oferta geral.
 *   - A credencial PRÓPRIA da organização continua vencendo o OmniRouter em qualquer caso.
 *
 * Os leitores devolvem "não" em caso de dúvida (banco fora, linha ausente): quem decide é a instalação,
 * e uma falha de leitura não promete uma chave que o motor talvez não encontre.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { valorDaInstalacao } from "@/lib/instalacao/config";

import {
  OmniRouterInvalidoError,
  escolhaDoOmniRouterNasConfiguracoes,
  omniRouterAtendeAOrganizacao,
  omniRouterDaOrganizacao,
  type VariaveisDoOmniRouter,
} from "./omnirouter";

/** O pedaço do cliente do Supabase que a leitura usa — a sessão ou o admin servem. */
export type LeitorDeOrganizacao = Pick<SupabaseClient, "from">;

/**
 * Endereço, chave e oferta geral EM VIGOR na instalação: o que a tela gravou, e senão o `.env`.
 * Cada chave é lida pelo resolvedor (`valorDaInstalacao`) — é o que mantém o painel honesto.
 */
export async function variaveisDoOmniRouterDaInstalacao(): Promise<VariaveisDoOmniRouter> {
  const [endereco, chave, paraTodas] = await Promise.all([
    valorDaInstalacao("OMNIROUTER_BASE_URL"),
    valorDaInstalacao("OMNIROUTER_API_KEY"),
    valorDaInstalacao("OMNIROUTER_PARA_TODAS"),
  ]);
  return {
    OMNIROUTER_BASE_URL: endereco.valor ?? undefined,
    OMNIROUTER_API_KEY: chave.valor ?? undefined,
    OMNIROUTER_PARA_TODAS: paraTodas.valor ?? undefined,
  };
}

/** A instalação tem endereço E chave que prestam? (Ignora quem é atendido: é a pergunta da tela.) */
export function omniRouterConfigurado(variaveis: VariaveisDoOmniRouter): boolean {
  try {
    return omniRouterDaOrganizacao(variaveis, true) !== null;
  } catch (erro) {
    if (erro instanceof OmniRouterInvalidoError) return false;
    throw erro;
  }
}

/**
 * A escolha da organização (`settings.omnirouter.habilitado`), ou `undefined` quando ela não escolheu.
 * Erro de leitura, organização sem linha e valor torto valem "sem escolha": decide a oferta geral.
 */
export async function escolhaDoOmniRouterDaOrganizacao(
  db: LeitorDeOrganizacao,
  organizationId: string,
): Promise<boolean | undefined> {
  try {
    const { data, error } = await db
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    if (error || data === null || typeof data !== "object") return undefined;
    const settings = (data as { settings?: unknown }).settings;
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return undefined;
    return escolhaDoOmniRouterNasConfiguracoes((settings as { omnirouter?: unknown }).omnirouter);
  } catch {
    return undefined;
  }
}

/**
 * O OmniRouter SERVE este provedor a esta organização AGORA? É a pergunta dos portões de salvar e
 * publicar agente ("a instalação tem chave para este provedor?"): só o `anthropic` tem OmniRouter, a
 * instalação precisa tê-lo configurado e a organização precisa ter sido escolhida (ou a oferta geral
 * valer para ela). A parte da instalação vai primeiro: quem não tem OmniRouter não gasta uma ida ao
 * banco da organização.
 */
export async function omniRouterServeAOrganizacao(
  db: LeitorDeOrganizacao,
  provider: string,
  organizationId: string,
): Promise<boolean> {
  if (provider !== "anthropic") return false;
  const variaveis = await variaveisDoOmniRouterDaInstalacao();
  if (!omniRouterConfigurado(variaveis)) return false;
  return omniRouterAtendeAOrganizacao(
    variaveis,
    await escolhaDoOmniRouterDaOrganizacao(db, organizationId),
  );
}
