/**
 * O ENDEREÇO DA ANTHROPIC — um lugar só.
 *
 * Todo ponto do produto que fala com a API de Mensagens da Anthropic (o turno do
 * agente, os workers de ponto, o ensaio, o validador da chave, a prova de crédito
 * e a contagem de tokens) pergunta o endereço AQUI. Antes eram seis literais
 * `https://api.anthropic.com`, e quem precisasse de um proxy compatível (um
 * gateway da empresa, a `claude-ponte` do laboratório) teria de achar os seis.
 *
 * ═══ Quem escolhe o endereço: a INSTALAÇÃO, e só ela ═══
 *
 * O endereço vem de `ANTHROPIC_BASE_URL`, no `.env` de quem opera o servidor
 * (o mesmo desenho de `OPENROUTER_BASE_URL`). NÃO vem da credencial da
 * organização: `ai_provider_credentials.base_url` continua valendo só para o
 * provedor personalizado (`custom`), e para `anthropic` a rota segue recusando
 * (`aceitaEndpointProprio: false`). É a decisão 22-d (#1004): um endereço
 * escolhido por uma ORGANIZAÇÃO nunca aponta para dentro da rede do servidor,
 * e este (http, nome de contêiner, IP privado) é justamente um endereço de
 * dentro. Quem o escreve é quem paga a máquina.
 *
 * Duas consequências que valem ser ditas, porque são o preço do desenho:
 *   - é GLOBAL: enquanto a variável estiver posta, TODA chamada à Anthropic
 *     desta instalação vai para o endereço dela, de todas as organizações. Ligar
 *     e desligar é editar o `.env` e recriar `app` e `worker`;
 *   - a chave que viaja é a da credencial de cada organização. O endereço novo
 *     precisa aceitar essa chave, ou responde 401, e o 401 é o sinal correto.
 *
 * ═══ O que NUNCA acontece ═══
 *
 * Variável posta e MALFORMADA não cai no endereço padrão: lança. Cair no padrão
 * mandaria a chave pensada para o proxy à Anthropic, em silêncio, que é o jeito
 * pior de errar. A mensagem do erro não repete o valor (uma URL com `user:senha@`
 * não vai parar em log).
 *
 * Sem DOM, sem banco, sem logger e sem importar `@/lib/env` de propósito: é
 * usado pelo motor do worker (`edge/`), pelos workers de ponto e pelo app, e os
 * testes que simulam `@/lib/env` não precisam conhecê-lo.
 */

/** O endereço de sempre: o que vale quando a variável está vazia. */
export const ORIGEM_PADRAO_DA_ANTHROPIC = "https://api.anthropic.com";

export type MotivoDeBaseUrlInvalida =
  "nao_e_url" | "esquema" | "credenciais_na_url" | "consulta_ou_fragmento" | "caminho";

/**
 * `ANTHROPIC_BASE_URL` posta e inutilizável. Não é erro de rede nem do
 * provedor: é configuração da instalação, e quem a corrige é quem opera o
 * `.env`. Nenhum byte saiu quando isto foi lançado.
 */
export class AnthropicBaseUrlInvalidaError extends Error {
  override readonly name = "AnthropicBaseUrlInvalidaError";
  readonly motivo: MotivoDeBaseUrlInvalida;
  constructor(motivo: MotivoDeBaseUrlInvalida) {
    super(
      `anthropic_base_url_invalida:${motivo}: corrija ANTHROPIC_BASE_URL no .env da instalação ` +
        `(ex.: http://nome-do-conteiner:8080 ou https://proxy.example.com; a chave não foi enviada a lugar nenhum)`,
    );
    this.motivo = motivo;
  }
}

export interface EnderecoDaAnthropic {
  /** Esquema + host + porta, sem barra final. É o que a allowlist de egress compara. */
  origem: string;
  /** O `baseURL` do `@ai-sdk/anthropic`: a origem mais `/v1`. */
  baseURL: string;
  /** `true` quando a instalação apontou para um endereço diferente do padrão. */
  daInstalacao: boolean;
}

/**
 * Resolve o endereço. Lê `ANTHROPIC_BASE_URL` a CADA chamada (barato, e deixa o
 * teste e o operador trocarem sem reiniciar o módulo); `bruto` existe para os
 * testes.
 *
 * Aceita a raiz (`http://claude-ponte:8080`, como a Anthropic documenta
 * `ANTHROPIC_BASE_URL`) ou a raiz com `/v1`. Recusa o resto: um caminho
 * qualquer faria o SDK montar `…/caminho/v1/messages` e o erro apareceria só
 * como um 404 sem relação aparente com a variável.
 */
export function enderecoDaAnthropic(
  bruto: string | undefined = process.env.ANTHROPIC_BASE_URL,
): EnderecoDaAnthropic {
  const texto = (bruto ?? "").trim();
  if (texto === "") {
    return {
      origem: ORIGEM_PADRAO_DA_ANTHROPIC,
      baseURL: `${ORIGEM_PADRAO_DA_ANTHROPIC}/v1`,
      daInstalacao: false,
    };
  }

  let url: URL;
  try {
    url = new URL(texto);
  } catch {
    throw new AnthropicBaseUrlInvalidaError("nao_e_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new AnthropicBaseUrlInvalidaError("esquema");
  if (url.username !== "" || url.password !== "")
    throw new AnthropicBaseUrlInvalidaError("credenciais_na_url");
  if (url.search !== "" || url.hash !== "")
    throw new AnthropicBaseUrlInvalidaError("consulta_ou_fragmento");
  if (!/^\/(v1\/?)?$/.test(url.pathname)) throw new AnthropicBaseUrlInvalidaError("caminho");

  return {
    origem: url.origin,
    baseURL: `${url.origin}/v1`,
    daInstalacao: url.origin !== ORIGEM_PADRAO_DA_ANTHROPIC,
  };
}

/**
 * `fetch` que só fala com a origem escolhida e não segue redirect.
 *
 * O SDK monta toda URL a partir do `baseURL`, então o desvio de host não
 * deveria acontecer; a conferência existe porque é barata e porque "nenhum byte
 * vai a outro host" é a promessa que o endereço da instalação precisa cumprir.
 * Redirect é recusado pelo mesmo motivo do `fetchParaDestinoDaOrganizacao`: um
 * 3xx levaria a chamada, e o `x-api-key` (que o fetch NÃO tira num redirect
 * entre origens, só o `Authorization`), para onde ninguém autorizou.
 */
export function fetchContidoDaAnthropic(origem: string, interno?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let destino: string;
    try {
      destino = new URL(url).origin;
    } catch {
      throw new Error("anthropic_destino_invalido");
    }
    if (destino !== origem) throw new Error("anthropic_destino_fora_da_origem");
    const chamar =
      interno ?? ((i: Parameters<typeof fetch>[0], n?: RequestInit) => globalThis.fetch(i, n));
    const res = await chamar(input, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) throw new Error("anthropic_redirect_bloqueado");
    return res;
  };
}

/**
 * As opções de `createAnthropic(...)` para o endereço em vigor — o que os pontos
 * de código usam em vez de montar `{ apiKey }` à mão.
 *
 * `contido` deixa o motor do worker passar a contenção DELE (a allowlist de
 * egress, com evento de segurança e hosts extras); quem não tem uma recebe a
 * de `fetchContidoDaAnthropic`. Em qualquer dos dois, sem a variável o destino
 * é exatamente `https://api.anthropic.com/v1`, o padrão do SDK.
 */
export function opcoesDaAnthropic(
  apiKey: string,
  contido?: (origem: string) => typeof fetch,
): { apiKey: string; baseURL: string; fetch: typeof fetch } {
  const { origem, baseURL } = enderecoDaAnthropic();
  return { apiKey, baseURL, fetch: contido ? contido(origem) : fetchContidoDaAnthropic(origem) };
}
