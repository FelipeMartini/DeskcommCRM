/**
 * A CLAUDE-PONTE — um caminho SEPARADO, e só da instalação.
 *
 * A `claude-ponte` é um serviço do laboratório que fala o protocolo da API de
 * Mensagens da Anthropic, mas atende pela assinatura de uma pessoa. Este módulo
 * é o ÚNICO lugar que decide se uma chamada do agente vai a ela.
 *
 * ═══ A regra (ordem do dono, 10/10/2026) ═══
 *
 *   1. A credencial PRÓPRIA da organização para a Anthropic, ativa e validada,
 *      SEMPRE vence: vai a `api.anthropic.com` com a chave dela, como sempre foi.
 *   2. A ponte só entra quando a organização NÃO tem credencial própria
 *      executável E está na lista `CLAUDE_PONTE_ORGS` E as variáveis estão válidas.
 *   3. Sem as variáveis, o produto se comporta exatamente como antes: este módulo
 *      devolve `null` sem olhar para mais nada.
 *
 * ═══ Por que variáveis PRÓPRIAS, e não um `ANTHROPIC_BASE_URL` ═══
 *
 * Uma variável global de endereço da Anthropic redirecionaria também a chave
 * Anthropic REAL de quem a cadastrou (ou a da instalação) para a ponte, e a
 * chave da ponte para a Anthropic se a variável fosse apagada pela metade. São
 * dois segredos de donos diferentes. Aqui eles nunca se cruzam, por construção:
 *
 *   - a fábrica `anthropic` do registry NÃO lê variável nenhuma: vai sempre a
 *     `https://api.anthropic.com`, com a chave que lhe entregam;
 *   - a fábrica da ponte (`FABRICA_DA_PONTE`) só é escolhida quando ESTE módulo
 *     resolveu a ponte, e só fala com a origem validada aqui, com a chave daqui.
 *
 * ═══ Quem pode usar: a lista, e a lista vazia é ninguém ═══
 *
 * Em modo assinatura, nenhum tráfego de cliente pode passar pela ponte. Por isso
 * a lista é de ids de organização e vazia significa NINGUÉM; `*` (todas as
 * organizações sem credencial própria) é uma escolha explícita do operador, e só
 * cabe quando a ponte atende em modo de API paga, com teto.
 *
 * ═══ O que NUNCA acontece ═══
 *
 * Variável posta e MALFORMADA para uma organização da lista não cai no endereço
 * da Anthropic: lança. A mensagem do erro não repete o valor (uma URL com
 * `user:senha@`, ou a chave, não vai parar em log). Para uma organização FORA da
 * lista (ou com credencial própria) nada disto é sequer avaliado: um `.env` com
 * erro na ponte não derruba quem não usa a ponte.
 *
 * Sem DOM, sem banco, sem logger e sem importar `@/lib/env` de propósito: é
 * usado pelo motor do worker (`edge/`) e pelo app, e os testes que simulam
 * `@/lib/env` não precisam conhecê-lo.
 */

/**
 * A chave da fábrica da ponte no registry do motor. Não é um provedor: é um DESTINO do provedor
 * `anthropic`. Por isso é um `symbol`, e não um texto:
 *
 *   - `ai_provider_credentials.provider` e `settings.llm.provider` são texto livre no banco; uma
 *     chave de texto no registry seria alcançável por um nome escrito por quem administra uma
 *     organização. Um `symbol` não tem como ser gravado nem digitado;
 *   - a lista de provedores da tela e o registry continuam sendo a MESMA lista
 *     (`tests/unit/provedores-x-registry.test.ts`): `Object.keys` não enxerga `symbol`, então nenhuma
 *     exceção foi aberta nessa cerca.
 *
 * `Symbol.for` (registro global) para que duas cópias do módulo no mesmo processo concordem.
 */
export const FABRICA_DA_PONTE: unique symbol = Symbol.for("claude-ponte.fabrica");

/** As três variáveis, na ordem em que o operador as escreve no `.env`. */
export interface VariaveisDaPonte {
  CLAUDE_PONTE_BASE_URL?: string | undefined;
  CLAUDE_PONTE_API_KEY?: string | undefined;
  CLAUDE_PONTE_ORGS?: string | undefined;
}

export type MotivoDaPonteInvalida =
  | "nao_e_url"
  | "esquema"
  | "credenciais_na_url"
  | "consulta_ou_fragmento"
  | "caminho"
  | "chave_ausente"
  | "lista_invalida";

/**
 * Variáveis da ponte postas e inutilizáveis para uma organização que a usaria.
 * Não é erro de rede nem do provedor: é configuração da instalação, e quem a
 * corrige é quem opera o `.env`. Nenhum byte saiu quando isto foi lançado.
 */
export class ClaudePonteInvalidaError extends Error {
  override readonly name = "ClaudePonteInvalidaError";
  readonly motivo: MotivoDaPonteInvalida;
  constructor(motivo: MotivoDaPonteInvalida) {
    super(
      `claude_ponte_invalida:${motivo}: corrija CLAUDE_PONTE_BASE_URL, CLAUDE_PONTE_API_KEY e ` +
        `CLAUDE_PONTE_ORGS no .env da instalação (ex.: http://claude-ponte:8080); ` +
        `nenhuma chave foi enviada a lugar nenhum`,
    );
    this.motivo = motivo;
  }
}

/** O que a escada de credenciais precisa saber da ponte para esta organização. */
export interface PonteDaOrganizacao {
  /** A chave que a PONTE exige. Não é uma chave da Anthropic. */
  apiKey: string;
  /** Esquema + host + porta, sem barra final. É o que a allowlist de egress compara. */
  origem: string;
  /** O `baseURL` do `@ai-sdk/anthropic`: a origem mais `/v1`. */
  baseURL: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lê `CLAUDE_PONTE_ORGS`. `vazio` = ninguém; `todas` = o `*`; senão o conjunto
 * de ids (minúsculos). Lança `lista_invalida` para o que não é uma coisa nem
 * outra: um typo na lista não pode virar "ninguém" em silêncio (a organização
 * ficaria sem o que o operador achou ter ligado) nem "todas".
 */
function lerALista(bruto: string | undefined): "vazio" | "todas" | ReadonlySet<string> {
  const itens = (bruto ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (itens.length === 0) return "vazio";
  if (itens.includes("*")) {
    if (itens.length > 1) throw new ClaudePonteInvalidaError("lista_invalida");
    return "todas";
  }
  const ids = new Set<string>();
  for (const item of itens) {
    if (!UUID.test(item)) throw new ClaudePonteInvalidaError("lista_invalida");
    ids.add(item.toLowerCase());
  }
  return ids;
}

/**
 * Valida o endereço da ponte. Aceita a raiz (`http://claude-ponte:8080`) ou a
 * raiz com `/v1`; recusa o resto, porque um caminho qualquer faria o SDK montar
 * `…/caminho/v1/messages` e o erro apareceria como um 404 sem relação aparente
 * com a variável.
 */
export function lerEnderecoDaPonte(bruto: string | undefined): { origem: string; baseURL: string } {
  const texto = (bruto ?? "").trim();
  let url: URL;
  try {
    url = new URL(texto);
  } catch {
    throw new ClaudePonteInvalidaError("nao_e_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new ClaudePonteInvalidaError("esquema");
  if (url.username !== "" || url.password !== "")
    throw new ClaudePonteInvalidaError("credenciais_na_url");
  if (url.search !== "" || url.hash !== "")
    throw new ClaudePonteInvalidaError("consulta_ou_fragmento");
  if (!/^\/(v1\/?)?$/.test(url.pathname)) throw new ClaudePonteInvalidaError("caminho");
  return { origem: url.origin, baseURL: `${url.origin}/v1` };
}

/**
 * A ponte desta organização, ou `null` quando ela NÃO é atendida pela ponte.
 *
 * Quem chama já sabe que a organização não tem credencial própria executável
 * (é o degrau seguinte da escada de `resolveOrgLlmConfig`); a regra 1 mora
 * lá, na ordem dos degraus, e este módulo não repete a consulta ao banco.
 *
 * `null` quando: a lista está vazia/ausente, ou a organização não está nela.
 * Lança `ClaudePonteInvalidaError` quando a organização É atendida e as
 * variáveis não prestam.
 */
export function ponteDaOrganizacao(
  variaveis: VariaveisDaPonte | undefined,
  organizationId: string,
): PonteDaOrganizacao | null {
  if (variaveis === undefined) return null;
  const lista = lerALista(variaveis.CLAUDE_PONTE_ORGS);
  if (lista === "vazio") return null;
  if (lista !== "todas" && !lista.has(organizationId.toLowerCase())) return null;

  const { origem, baseURL } = lerEnderecoDaPonte(variaveis.CLAUDE_PONTE_BASE_URL);
  const apiKey = (variaveis.CLAUDE_PONTE_API_KEY ?? "").trim();
  if (apiKey === "" || /\s/.test(apiKey)) throw new ClaudePonteInvalidaError("chave_ausente");
  return { apiKey, origem, baseURL };
}

/**
 * A pergunta de EXISTÊNCIA, para quem decide se um agente pode ser SALVO ou PUBLICADO
 * ("esta instalação tem chave para este provedor?"): a ponte atende esta organização, com as
 * variáveis em ordem?
 *
 * Existe porque esses portões conferiam só `ANTHROPIC_API_KEY`, e a ponte é justamente a
 * instalação atender sem essa variável. Sem esta pergunta, a tela recusava "a chave desta
 * instalação" para uma organização que o motor sabe atender.
 *
 * Nunca lança e nunca devolve a chave: variável malformada, lista com typo ou `*` misturado dão
 * `false` (a mesma recusa de antes: "esta instalação não tem chave"), e o motivo exato continua
 * aparecendo onde o turno falha (`claude_ponte_invalida:<motivo>`, em Execuções).
 */
export function ponteAtendeAOrganizacao(
  variaveis: VariaveisDaPonte | undefined,
  organizationId: string,
): boolean {
  try {
    return ponteDaOrganizacao(variaveis, organizationId) !== null;
  } catch (erro) {
    if (erro instanceof ClaudePonteInvalidaError) return false;
    throw erro;
  }
}

/**
 * `fetch` que só fala com a origem da ponte e não segue redirect.
 *
 * O SDK monta toda URL a partir do `baseURL`, então o desvio de host não
 * deveria acontecer; a conferência existe porque é barata e porque "nenhum byte
 * vai a outro host" é a promessa deste módulo. Redirect é recusado porque um
 * 3xx levaria a chamada, e o `x-api-key` (que o fetch NÃO tira num redirect
 * entre origens, só o `Authorization`), para onde ninguém autorizou.
 */
export function fetchContidoDaPonte(origem: string, interno?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let destino: string;
    try {
      destino = new URL(url).origin;
    } catch {
      throw new Error("claude_ponte_destino_invalido");
    }
    if (destino !== origem) throw new Error("claude_ponte_destino_fora_da_origem");
    const chamar =
      interno ?? ((i: Parameters<typeof fetch>[0], n?: RequestInit) => globalThis.fetch(i, n));
    const res = await chamar(input, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) throw new Error("claude_ponte_redirect_bloqueado");
    return res;
  };
}

/**
 * As opções de `createAnthropic(...)` para a ponte. O `baseURL` é REVALIDADO
 * aqui (a fábrica não confia no que recebe): endereço com credencial, caminho
 * ou esquema estranho lança antes de qualquer byte.
 *
 * `contido` deixa o motor do worker passar a contenção DELE (a allowlist de
 * egress, com evento de segurança); quem não tem uma recebe `fetchContidoDaPonte`.
 */
export function opcoesDaPonte(
  apiKey: string,
  baseURL: string | undefined,
  contido?: (origem: string) => typeof fetch,
): { apiKey: string; baseURL: string; fetch: typeof fetch } {
  const endereco = lerEnderecoDaPonte(baseURL);
  return {
    apiKey,
    baseURL: endereco.baseURL,
    fetch: contido ? contido(endereco.origem) : fetchContidoDaPonte(endereco.origem),
  };
}
