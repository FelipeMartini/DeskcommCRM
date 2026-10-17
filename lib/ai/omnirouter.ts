/**
 * O OMNIROUTER DA INSTALAÇÃO — a ÚNICA rota de IA de texto que a instalação oferece além das chaves.
 *
 * O OmniRouter é um roteador que fala a API da OpenAI (chat/completions). Este módulo é o ÚNICO lugar
 * que decide se uma chamada do agente vai a ele quando a organização pede o provedor `anthropic` e não
 * tem credencial própria. Ele SUBSTITUIU a antiga ponte de IA (removida a pedido do dono, 16/10/2026:
 * "vai ficar só o omnirouter configurável").
 *
 * ═══ A regra (misto: o endereço e a chave são da INSTALAÇÃO, a escolha é da ORGANIZAÇÃO) ═══
 *
 *   1. A credencial PRÓPRIA da organização para o provedor, ativa e validada, SEMPRE vence: vai ao
 *      endereço dela com a chave dela, como sempre foi.
 *   2. O OmniRouter só entra quando a organização NÃO tem credencial própria executável E foi escolhida:
 *      `settings.omnirouter.habilitado === true` (admin da plataforma, tela do tenant), ou — sem escolha
 *      nenhuma gravada — a instalação oferece a TODAS (`OMNIROUTER_PARA_TODAS = true`). O `false`
 *      explícito da organização sempre vence a oferta geral.
 *   3. Sem endereço nem chave configurados, este módulo devolve `null` sem olhar para mais nada: o
 *      produto se comporta exatamente como antes.
 *
 * ═══ Por que a chave do OmniRouter NUNCA vai para outro endereço (e a das empresas, nunca para ele) ═══
 *
 * São dois segredos de donos diferentes. Aqui eles não se cruzam por construção:
 *   - a fábrica de cada provedor nativo NÃO lê o endereço do OmniRouter: vai sempre ao endpoint canônico;
 *   - a fábrica do OmniRouter (`FABRICA_DO_OMNIROUTER`) só é escolhida quando ESTE módulo resolveu o
 *     OmniRouter, e só fala com a origem validada aqui, com a chave daqui, sem seguir redirecionamento.
 *
 * ═══ O que NUNCA acontece ═══
 *
 * Variável posta e MALFORMADA para uma organização atendida não cai no endereço de outro provedor:
 * lança. A mensagem do erro não repete o valor (uma URL com `user:senha@`, ou a chave, não vai parar
 * em log). Para organização NÃO atendida (ou com credencial própria) nada disto é sequer avaliado: um
 * valor torto não derruba quem não usa o OmniRouter.
 *
 * Sem DOM, sem banco, sem logger e sem importar `@/lib/env` de propósito: é usado pelo motor do worker
 * (`edge/`) e pelo app. QUEM LÊ os valores da instalação (banco primeiro, `.env` como piso) é
 * `lib/instalacao/config-sql.ts` no motor e `lib/ai/omnirouter-ativo.ts` no app; este módulo só decide.
 */

/**
 * A chave da fábrica do OmniRouter no registry do motor. Não é um provedor: é um DESTINO do provedor
 * `anthropic`. Por isso é um `symbol`, e não um texto:
 *
 *   - `ai_provider_credentials.provider` e `settings.llm.provider` são texto livre no banco; uma chave
 *     de texto no registry seria alcançável por um nome escrito por quem administra uma organização.
 *     Um `symbol` não tem como ser gravado nem digitado;
 *   - a lista de provedores da tela e o registry continuam sendo a MESMA lista
 *     (`tests/unit/provedores-x-registry.test.ts`): `Object.keys` não enxerga `symbol`.
 *
 * `Symbol.for` (registro global) para que duas cópias do módulo no mesmo processo concordem.
 */
export const FABRICA_DO_OMNIROUTER: unique symbol = Symbol.for("omnirouter.fabrica");

/** As três chaves da instalação, como o motor as recebe (piso do `.env` ou valor do banco). */
// `type` (e não `interface`): só o alias de objeto literal é atribuível a `Record<string, string | undefined>`,
// que é o que o leitor do motor (`valoresDaInstalacaoNoMotor`) espera como piso do `.env`.
export type VariaveisDoOmniRouter = {
  OMNIROUTER_BASE_URL?: string | undefined;
  OMNIROUTER_API_KEY?: string | undefined;
  /** `"true"` = oferece a todas as organizações sem chave própria que não recusaram. */
  OMNIROUTER_PARA_TODAS?: string | undefined;
};

/** Os nomes, na ordem em que a tela e o `.env` os mostram. Um só lugar para não divergirem. */
export const CHAVES_DO_OMNIROUTER = [
  "OMNIROUTER_BASE_URL",
  "OMNIROUTER_API_KEY",
  "OMNIROUTER_PARA_TODAS",
] as const;

/**
 * Extrai do ambiente SÓ as três variáveis do OmniRouter. Existe para o `llmEdgeConfigFromEnv` montar o
 * PISO da instalação sem que cada processo (app, worker, voice-agent) repita os três nomes.
 */
export function variaveisDoOmniRouter(
  fonte: Partial<Record<(typeof CHAVES_DO_OMNIROUTER)[number], string | undefined>>,
): VariaveisDoOmniRouter {
  return {
    OMNIROUTER_BASE_URL: fonte.OMNIROUTER_BASE_URL,
    OMNIROUTER_API_KEY: fonte.OMNIROUTER_API_KEY,
    OMNIROUTER_PARA_TODAS: fonte.OMNIROUTER_PARA_TODAS,
  };
}

export type MotivoDoOmniRouterInvalido =
  | "nao_e_url"
  | "esquema"
  | "credenciais_na_url"
  | "consulta_ou_fragmento"
  | "chave_ausente";

/**
 * Variáveis do OmniRouter postas e inutilizáveis para uma organização que o usaria. Não é erro de rede
 * nem do provedor: é configuração da instalação, e quem a corrige é quem opera o painel de Credenciais.
 * Nenhum byte saiu quando isto foi lançado.
 */
export class OmniRouterInvalidoError extends Error {
  override readonly name = "OmniRouterInvalidoError";
  readonly motivo: MotivoDoOmniRouterInvalido;
  constructor(motivo: MotivoDoOmniRouterInvalido) {
    super(
      `omnirouter_invalido:${motivo}: corrija o endereço e a chave do OmniRouter em Admin › Credenciais ` +
        `(ex.: https://omnirouter.example.com/v1); nenhuma chave foi enviada a lugar nenhum`,
    );
    this.motivo = motivo;
  }
}

/** O que a escada de credenciais precisa saber do OmniRouter para esta organização. */
export interface OmniRouterDaOrganizacao {
  /** A chave que o OmniRouter exige. Não é uma chave de nenhum provedor. */
  apiKey: string;
  /** Esquema + host + porta, sem barra final. É o que a allowlist de egress compara. */
  origem: string;
  /** O `baseURL` do SDK OpenAI-compatível: a origem mais o caminho informado (`/v1` se vazio). */
  baseURL: string;
}

/**
 * A escolha da organização: `settings.omnirouter.habilitado`. Só o booleano vale; ausente, texto, número
 * ou lixo = SEM escolha (`undefined`), e então decide a oferta geral da instalação.
 */
export function escolhaDoOmniRouterNasConfiguracoes(omnirouter: unknown): boolean | undefined {
  if (omnirouter === null || typeof omnirouter !== "object" || Array.isArray(omnirouter)) {
    return undefined;
  }
  const habilitado = (omnirouter as { habilitado?: unknown }).habilitado;
  return typeof habilitado === "boolean" ? habilitado : undefined;
}

/** `OMNIROUTER_PARA_TODAS` é verdadeira? Só a palavra `true` (qualquer caixa) liga. */
function paraTodas(bruto: string | undefined): boolean {
  return (bruto ?? "").trim().toLowerCase() === "true";
}

/**
 * A organização foi ESCOLHIDA para o OmniRouter? A escolha própria vence a oferta geral nos dois
 * sentidos: `true` atende mesmo sem a oferta geral; `false` recusa mesmo com ela.
 */
export function omniRouterEscolhido(
  escolha: boolean | undefined,
  variaveis: VariaveisDoOmniRouter | undefined,
): boolean {
  if (escolha !== undefined) return escolha;
  return paraTodas(variaveis?.OMNIROUTER_PARA_TODAS);
}

/**
 * Valida o endereço. Aceita a raiz (`https://omnirouter.example.com`, que vira `…/v1`) ou qualquer
 * caminho já completo (`…/v1`, `…/api/v1`); recusa credencial na URL, consulta e fragmento, porque o
 * SDK monta toda URL a partir do `baseURL` e um `?x=` ou um `#` quebraria o caminho de forma
 * irreconhecível (404 sem relação aparente com a variável).
 */
export function lerEnderecoDoOmniRouter(bruto: string | undefined): {
  origem: string;
  baseURL: string;
} {
  const texto = (bruto ?? "").trim();
  let url: URL;
  try {
    url = new URL(texto);
  } catch {
    throw new OmniRouterInvalidoError("nao_e_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new OmniRouterInvalidoError("esquema");
  }
  if (url.username !== "" || url.password !== "") {
    throw new OmniRouterInvalidoError("credenciais_na_url");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new OmniRouterInvalidoError("consulta_ou_fragmento");
  }
  const caminho = url.pathname.replace(/\/+$/, "");
  return { origem: url.origin, baseURL: `${url.origin}${caminho === "" ? "/v1" : caminho}` };
}

/**
 * O OmniRouter desta organização, ou `null` quando ela NÃO é atendida por ele.
 *
 * Quem chama já sabe que a organização não tem credencial própria executável (é o degrau seguinte da
 * escada de `resolveOrgLlmConfig`); a regra 1 mora lá, na ordem dos degraus.
 *
 * `null` quando: a organização não foi escolhida, ou a instalação não configurou NADA (nem endereço,
 * nem chave). Lança `OmniRouterInvalidoError` quando a organização É atendida e a configuração está
 * pela metade ou malformada.
 */
export function omniRouterDaOrganizacao(
  variaveis: VariaveisDoOmniRouter | undefined,
  escolha: boolean | undefined,
): OmniRouterDaOrganizacao | null {
  if (variaveis === undefined) return null;
  if (!omniRouterEscolhido(escolha, variaveis)) return null;

  const endereco = (variaveis.OMNIROUTER_BASE_URL ?? "").trim();
  const apiKey = (variaveis.OMNIROUTER_API_KEY ?? "").trim();
  if (endereco === "" && apiKey === "") return null;

  const { origem, baseURL } = lerEnderecoDoOmniRouter(endereco);
  if (apiKey === "" || /\s/.test(apiKey)) throw new OmniRouterInvalidoError("chave_ausente");
  return { apiKey, origem, baseURL };
}

/**
 * A pergunta de EXISTÊNCIA, para quem decide se um agente pode ser SALVO ou PUBLICADO ("esta instalação
 * tem chave para este provedor?"): o OmniRouter atende esta organização, com a configuração em ordem?
 *
 * Nunca lança e nunca devolve a chave: configuração malformada dá `false` (a mesma recusa de antes:
 * "esta instalação não tem chave"), e o motivo exato continua aparecendo onde o turno falha
 * (`omnirouter_invalido:<motivo>`, em Execuções).
 */
export function omniRouterAtendeAOrganizacao(
  variaveis: VariaveisDoOmniRouter | undefined,
  escolha: boolean | undefined,
): boolean {
  try {
    return omniRouterDaOrganizacao(variaveis, escolha) !== null;
  } catch (erro) {
    if (erro instanceof OmniRouterInvalidoError) return false;
    throw erro;
  }
}

/**
 * `fetch` que só fala com a origem do OmniRouter e não segue redirect.
 *
 * O SDK monta toda URL a partir do `baseURL`, então o desvio de host não deveria acontecer; a
 * conferência existe porque é barata e porque "nenhum byte vai a outro host" é a promessa deste módulo.
 * Redirect é recusado porque um 3xx levaria a chamada, e a chave do cabeçalho `Authorization` (que o
 * `fetch` tira num redirect entre origens, mas não dentro dela), para onde ninguém autorizou.
 */
export function fetchContidoDoOmniRouter(origem: string, interno?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let destino: string;
    try {
      destino = new URL(url).origin;
    } catch {
      throw new Error("omnirouter_destino_invalido");
    }
    if (destino !== origem) throw new Error("omnirouter_destino_fora_da_origem");
    const chamar =
      interno ?? ((i: Parameters<typeof fetch>[0], n?: RequestInit) => globalThis.fetch(i, n));
    const res = await chamar(input, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) throw new Error("omnirouter_redirect_bloqueado");
    return limparAvisoDoModeloReal(res);
  };
}

/**
 * O aviso que o OmniRouter pode escrever NO INÍCIO do texto da resposta de `/chat/completions`
 * (`> 🤖 **[Modelo Real: <modelo> (<rota>)]**`, medido pela ProjetoMylab em 16/10/2026; o formato
 * Anthropic `/messages` vem limpo, mas o CRM fala Chat Completions, ver `FABRICA_DO_OMNIROUTER`).
 * É informação para quem opera o roteador, e o texto do agente vira mensagem de WhatsApp para o
 * cliente: sem este filtro o cliente leria o nome do modelo e da rota. Só o início do texto, só
 * este formato, e as quebras de linha que o seguem.
 */
const AVISO_DO_MODELO_REAL =
  /^\s*>[ \t]*(?:🤖[ \t]*)?\*\*\[Modelo Real:[^\]\n]*\]\*\*[ \t]*(?:\r?\n)*/;

/** Tira o aviso do começo do texto. Idempotente; texto sem o aviso volta igual. */
export function tirarAvisoDoModeloReal(texto: string): string {
  return texto.replace(AVISO_DO_MODELO_REAL, "");
}

/**
 * Limpa o aviso das respostas JSON bem-sucedidas (o agente chama sem streaming). Resposta de erro,
 * fluxo de eventos (`text/event-stream`), corpo que não é JSON ou sem `choices` passam INTACTOS: este
 * filtro nunca derruba uma chamada nem reescreve o que não conhece. Corpo grande demais não é lido.
 */
async function limparAvisoDoModeloReal(res: Response): Promise<Response> {
  try {
    if (!res.ok) return res;
    if (!(res.headers.get("content-type") ?? "").toLowerCase().includes("application/json"))
      return res;
    const tamanho = Number(res.headers.get("content-length") ?? "0");
    if (tamanho > 5_000_000) return res;
    const texto = await res.clone().text();
    const corpo: unknown = JSON.parse(texto);
    const escolhas = (corpo as { choices?: unknown } | null)?.choices;
    if (!Array.isArray(escolhas)) return res;
    let mudou = false;
    for (const escolha of escolhas) {
      const mensagem = (escolha as { message?: { content?: unknown } } | null)?.message;
      if (mensagem && typeof mensagem.content === "string") {
        const limpo = tirarAvisoDoModeloReal(mensagem.content);
        if (limpo !== mensagem.content) {
          mensagem.content = limpo;
          mudou = true;
        }
      }
    }
    if (!mudou) return res;
    const cabecalhos = new Headers(res.headers);
    // O corpo novo tem outro tamanho e já chegou decodificado: os dois cabeçalhos antigos passam a mentir.
    cabecalhos.delete("content-length");
    cabecalhos.delete("content-encoding");
    return new Response(JSON.stringify(corpo), {
      status: res.status,
      statusText: res.statusText,
      headers: cabecalhos,
    });
  } catch {
    return res;
  }
}

/**
 * As opções do SDK OpenAI-compatível para o OmniRouter. O `baseURL` é REVALIDADO aqui (a fábrica não
 * confia no que recebe): endereço com credencial, consulta ou esquema estranho lança antes de qualquer
 * byte.
 *
 * `contido` deixa o motor do worker passar a contenção DELE (a allowlist de egress, com evento de
 * segurança); quem não tem uma recebe `fetchContidoDoOmniRouter`.
 */
export function opcoesDoOmniRouter(
  apiKey: string,
  baseURL: string | undefined,
  contido?: (origem: string) => typeof fetch,
): { apiKey: string; baseURL: string; fetch: typeof fetch } {
  const endereco = lerEnderecoDoOmniRouter(baseURL);
  const interno = contido ? contido(endereco.origem) : fetchContidoDoOmniRouter(endereco.origem);
  return {
    apiKey,
    baseURL: endereco.baseURL,
    // A contenção do motor não bloqueia redirect por si: o `fetchContidoDoOmniRouter` fica por fora
    // dela quando o motor a fornece, para as duas promessas valerem juntas.
    fetch: contido ? fetchContidoDoOmniRouter(endereco.origem, interno) : interno,
  };
}
