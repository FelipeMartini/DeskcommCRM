/**
 * `ANTHROPIC_BASE_URL` — o endereço da Anthropic é da INSTALAÇÃO, e vale em TODO
 * caminho que fala com ela (decisão 22-d; `lib/ai/anthropic-endpoint.ts`).
 *
 * Seis pontos criavam o cliente com `https://api.anthropic.com` fixo (o turno do
 * worker, o ensaio, o ponto de IA da organização, a chave da instalação, o
 * validador da chave e a prova de crédito) mais a contagem de tokens. Quem
 * quisesse apontar para um proxy compatível (a `claude-ponte` do laboratório, um
 * gateway da empresa) teria de achar os seis — e o que sobrasse mandaria a chave
 * pensada para o proxy à Anthropic, em silêncio.
 *
 * O que este arquivo prova (contrato da tarefa `T-20261010-MYLAB-01`):
 *   1. sem a variável, os pontos vão a `https://api.anthropic.com/v1/...`
 *      exatamente como antes (regressão zero);
 *   2. com ela, vão a `<base>/v1/...`, com a chave da credencial, e a ÚNICA
 *      origem tocada é a escolhida;
 *   3. variável malformada recusa antes de qualquer byte, sem o valor na
 *      mensagem — nunca cai no endereço padrão;
 *   4. o `base_url` da credencial NÃO desvia a Anthropic (só vale no `custom`);
 *   5. redirect 3xx não é seguido;
 *   6. 503, 429, 401 e 404 chegam classificados como os da Anthropic real.
 *
 * Técnica: `globalThis.fetch` interceptado, SDK REAL no caminho, nenhuma chamada
 * de rede sai. A asserção é a URL e o cabeçalho que o SDK montou. Valores
 * sintéticos de ponta a ponta: nenhuma chave real, nenhum endereço real.
 */
import type { LanguageModel } from "ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));

// Só o caso do binding da organização lê banco: provedor `anthropic`, com um
// `base_url` malicioso gravado na linha — que tem de ser IGNORADO.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const linha =
        tabela === "ai_purpose_bindings"
          ? {
              provider: "anthropic",
              credential_id: "cred-1",
              model_id: "claude-haiku-4-5",
              base_url: "http://intruso.example.com",
            }
          : { api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" };
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        maybeSingle: async () => ({ data: linha }),
      };
      return chain;
    },
  }),
}));

vi.mock("@/lib/crypto/aes_gcm", () => ({
  decryptKey: () => "chave-decifrada-da-organizacao",
  byteaToBuffer: (v: unknown) => v,
}));

import { logger } from "@/lib/logger";
import {
  AnthropicBaseUrlInvalidaError,
  enderecoDaAnthropic,
  fetchContidoDaAnthropic,
  opcoesDaAnthropic,
} from "@/lib/ai/anthropic-endpoint";

const PONTE = "http://claude-ponte:8080";
const VALOR_DA_CHAVE = "chave-sintetica-do-teste";
const VALOR_DA_ORGANIZACAO = "chave-decifrada-da-organizacao";
const ORG = "33333333-3333-4333-8333-333333333333";
/** Endereço com credencial embutida, montado em partes: é um valor de teste, não um segredo. */
const COM_CREDENCIAL = ["http://", "usuario", ":", "valor-sintetico", "@claude-ponte:8080"].join(
  "",
);

const MENSAGEM_OK = {
  id: "msg_teste",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5",
  content: [{ type: "text", text: "oi" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 1 },
};

interface Chamada {
  url: string;
  host: string;
  cabecalhoDaChave: string | null;
  redirect: RequestRedirect | undefined;
}

let fetchOriginal: typeof globalThis.fetch;
let chamadas: Chamada[];
let responder: () => Response;
let logDeErro: ReturnType<typeof vi.spyOn>;

function resposta(status: number, corpo: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Roda uma geração e devolve o erro que subiu (ou `null` se deu certo). `maxRetries: 0` isola a 1ª tentativa. */
async function geracao(model: LanguageModel): Promise<unknown> {
  const { generateText } = await import("ai");
  try {
    await generateText({ model, prompt: "oi", maxRetries: 0 });
    return null;
  } catch (erro) {
    return erro;
  }
}

/** O erro que uma montagem (que pode lançar antes de qualquer byte) devolve, ou `null`. */
function erroDe(montar: () => unknown): unknown {
  try {
    montar();
    return null;
  } catch (erro) {
    return erro;
  }
}

// A primeira importação de `lib/ai/runtime/agent` transforma um grafo grande
// (medido: 34s numa máquina com load 63). Paga-se aqui, com prazo próprio.
beforeAll(async () => {
  await import("@/lib/ai/runtime/agent");
  await import("@/lib/ai/gateway-binding");
  await import("@/lib/ai/provider-validators");
  await import("@/lib/instalacao/prova-de-credito");
}, 120_000);

beforeEach(() => {
  chamadas = [];
  responder = () => resposta(200, MENSAGEM_OK);
  fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    chamadas.push({
      url,
      host: new URL(url).host,
      cabecalhoDaChave: new Headers(init?.headers).get("x-api-key"),
      redirect: init?.redirect,
    });
    return responder();
  }) as typeof globalThis.fetch;
  // AUSENTE, que é o estado de produção hoje. O estado "presente porém vazia" (o que o template
  // do `.env` gera) tem o seu próprio bloco abaixo: o `@ai-sdk/anthropic` LÊ esta mesma variável
  // sozinho quando não recebe `baseURL`, e com ela vazia lança "baseURL must be a non-empty string".
  vi.stubEnv("ANTHROPIC_BASE_URL", undefined);
  logDeErro = vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  vi.unstubAllEnvs();
  logDeErro.mockRestore();
  delete envMock.ANTHROPIC_API_KEY;
});

// ─── O resolvedor ───────────────────────────────────────────────────────────

describe("enderecoDaAnthropic", () => {
  it("vazio, ausente e só espaço valem o endereço de sempre", () => {
    for (const bruto of [undefined, "", "   "]) {
      expect(enderecoDaAnthropic(bruto)).toEqual({
        origem: "https://api.anthropic.com",
        baseURL: "https://api.anthropic.com/v1",
        daInstalacao: false,
      });
    }
  });

  it.each([
    [PONTE],
    [`${PONTE}/`],
    [`${PONTE}/v1`],
    [`${PONTE}/v1/`],
    [`  ${PONTE}  `],
    ["HTTP://Claude-Ponte:8080"],
  ])("aceita %j e devolve a raiz + /v1", (bruto) => {
    expect(enderecoDaAnthropic(bruto)).toEqual({
      origem: PONTE,
      baseURL: `${PONTE}/v1`,
      daInstalacao: true,
    });
  });

  it("https com a porta padrão perde a porta; apontar para o próprio padrão não é desvio", () => {
    expect(enderecoDaAnthropic("https://proxy.exemplo.com:443/v1").origem).toBe(
      "https://proxy.exemplo.com",
    );
    expect(enderecoDaAnthropic("https://api.anthropic.com").daInstalacao).toBe(false);
  });

  it.each([
    ["claude-ponte:8080", "esquema"],
    ["ftp://claude-ponte", "esquema"],
    ["file:///etc/passwd", "esquema"],
    ["isto não é url", "nao_e_url"],
    [COM_CREDENCIAL, "credenciais_na_url"],
    [`${PONTE}/v1?parametro=1`, "consulta_ou_fragmento"],
    [`${PONTE}/v1#x`, "consulta_ou_fragmento"],
    [`${PONTE}/v2`, "caminho"],
    [`${PONTE}/outro/v1`, "caminho"],
  ])("recusa %j (%s) em vez de cair no endereço padrão", (bruto, motivo) => {
    const erro = erroDe(() => enderecoDaAnthropic(bruto));
    expect(erro).toBeInstanceOf(AnthropicBaseUrlInvalidaError);
    expect((erro as AnthropicBaseUrlInvalidaError).motivo).toBe(motivo);
    // O valor NÃO é repetido: um endereço com credencial embutida não vai parar em log.
    expect((erro as Error).message).not.toContain("valor-sintetico");
    expect((erro as Error).message).not.toContain("parametro=1");
  });
});

describe("fetchContidoDaAnthropic", () => {
  it("origem diferente da escolhida: lança sem chamar o fetch", async () => {
    const interno = vi.fn();
    const f = fetchContidoDaAnthropic(PONTE, interno as unknown as typeof fetch);
    await expect(f("https://api.anthropic.com/v1/messages")).rejects.toThrow(
      "anthropic_destino_fora_da_origem",
    );
    await expect(f("não é url")).rejects.toThrow("anthropic_destino_invalido");
    expect(interno).not.toHaveBeenCalled();
  });

  it("3xx vira recusa, e o fetch é chamado com redirect manual", async () => {
    const interno = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://x.example" } }),
    );
    const f = fetchContidoDaAnthropic(PONTE, interno as unknown as typeof fetch);
    await expect(f(`${PONTE}/v1/messages`)).rejects.toThrow("anthropic_redirect_bloqueado");
    expect(interno).toHaveBeenCalledTimes(1);
    expect((interno.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: "manual" });
  });

  it("resposta comum passa intacta", async () => {
    const interno = vi.fn(async () => new Response("ok", { status: 200 }));
    const f = fetchContidoDaAnthropic(PONTE, interno as unknown as typeof fetch);
    const res = await f(new URL(`${PONTE}/v1/models`));
    expect(res.status).toBe(200);
  });
});

describe("opcoesDaAnthropic", () => {
  it("devolve o baseURL e um fetch contido à origem", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", PONTE);
    const o = opcoesDaAnthropic(VALOR_DA_CHAVE);
    expect(o.baseURL).toBe(`${PONTE}/v1`);
    await expect(o.fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow(
      "anthropic_destino_fora_da_origem",
    );
    expect(chamadas).toHaveLength(0);
  });

  it("aceita a contenção do chamador (a allowlist do motor) no lugar da padrão", () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", PONTE);
    const contido = vi.fn(
      (_origem: string) => (async () => new Response("{}")) as unknown as typeof fetch,
    );
    opcoesDaAnthropic(VALOR_DA_CHAVE, contido);
    expect(contido).toHaveBeenCalledWith(PONTE);
  });
});

// ─── Os pontos que criam o cliente ──────────────────────────────────────────

interface Ponto {
  nome: string;
  /** Monta o modelo (pode lançar com a variável malformada) e diz qual valor de chave deve viajar. */
  montar: () => Promise<LanguageModel | null>;
  esperada: string;
}

const PONTOS: Ponto[] = [
  {
    nome: "turno do worker (registry de produção)",
    esperada: VALOR_DA_CHAVE,
    montar: async () => {
      const { createDefaultRegistry } = await import("@/lib/agent-engine/edge/llm/providers");
      return createDefaultRegistry().anthropic!(VALOR_DA_CHAVE, "claude-haiku-4-5");
    },
  },
  {
    nome: "agente publicado (ensaio e runtime do app)",
    esperada: VALOR_DA_CHAVE,
    montar: async () => {
      const { buildModel } = await import("@/lib/ai/runtime/agent");
      return buildModel("anthropic", VALOR_DA_CHAVE, "claude-haiku-4-5");
    },
  },
  {
    nome: "ponto de IA com credencial da organização",
    esperada: VALOR_DA_ORGANIZACAO,
    montar: async () => {
      const { resolverModeloDoPonto } = await import("@/lib/ai/gateway-binding");
      const r = await resolverModeloDoPonto(
        "sentiment_classify",
        ORG,
        "anthropic/claude-haiku-4-5",
      );
      return r?.model ?? null;
    },
  },
  {
    nome: "chave da instalação (resolveLanguageModel)",
    esperada: VALOR_DA_CHAVE,
    montar: async () => {
      envMock.ANTHROPIC_API_KEY = VALOR_DA_CHAVE;
      const { resolveLanguageModel } = await import("@/lib/ai/gateway");
      return resolveLanguageModel("anthropic/claude-haiku-4-5");
    },
  },
];

describe("sem a variável: os pontos vão à Anthropic como sempre foram (regressão zero)", () => {
  it.each(PONTOS)("$nome", async ({ montar, esperada }) => {
    const model = await montar();
    expect(model).not.toBeNull();
    expect(await geracao(model!)).toBeNull();
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(chamadas[0]!.cabecalhoDaChave).toBe(esperada);
  });
});

describe("variável presente porém vazia (o `.env` gerado do template traz `ANTHROPIC_BASE_URL=`)", () => {
  // O SDK, sozinho, trataria "" como endereço e lançaria. Todos os pontos passam o `baseURL`
  // explícito justamente por isso: vazia vale o endereço de sempre, como ausente.
  it.each(PONTOS)("$nome", async ({ montar, esperada }) => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "");
    const model = await montar();
    expect(model).not.toBeNull();
    expect(await geracao(model!)).toBeNull();
    expect(chamadas.map((c) => c.url)).toEqual(["https://api.anthropic.com/v1/messages"]);
    expect(chamadas[0]!.cabecalhoDaChave).toBe(esperada);
  });
});

describe("com a variável: os pontos vão ao endereço da instalação, e só a ele", () => {
  it.each(PONTOS)("$nome", async ({ montar, esperada }) => {
    vi.stubEnv("ANTHROPIC_BASE_URL", PONTE);
    const model = await montar();
    expect(model).not.toBeNull();
    expect(await geracao(model!)).toBeNull();
    expect(chamadas.map((c) => c.url)).toEqual([`${PONTE}/v1/messages`]);
    // A chave que viaja é a da credencial; o endereço novo é quem a aceita ou recusa.
    expect(chamadas[0]!.cabecalhoDaChave).toBe(esperada);
    expect(chamadas[0]!.redirect).toBe("manual");
  });

  it("aceita a raiz já com /v1", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", `${PONTE}/v1/`);
    const { createDefaultRegistry } = await import("@/lib/agent-engine/edge/llm/providers");
    await geracao(createDefaultRegistry().anthropic!(VALOR_DA_CHAVE, "claude-haiku-4-5"));
    expect(chamadas.map((c) => c.url)).toEqual([`${PONTE}/v1/messages`]);
  });
});

describe("o base_url da credencial NÃO desvia a Anthropic (só vale no `custom`)", () => {
  it("registry: o terceiro parâmetro é ignorado", async () => {
    const { createDefaultRegistry } = await import("@/lib/agent-engine/edge/llm/providers");
    await geracao(
      createDefaultRegistry().anthropic!(
        VALOR_DA_CHAVE,
        "claude-haiku-4-5",
        "http://intruso.example.com",
      ),
    );
    expect(chamadas.map((c) => c.host)).toEqual(["api.anthropic.com"]);
  });

  it("ensaio do agente: o quarto parâmetro é ignorado", async () => {
    const { buildModel } = await import("@/lib/ai/runtime/agent");
    await geracao(
      buildModel("anthropic", VALOR_DA_CHAVE, "claude-haiku-4-5", "http://intruso.example.com"),
    );
    expect(chamadas.map((c) => c.host)).toEqual(["api.anthropic.com"]);
  });

  it("binding da organização com base_url gravado na linha: o gravado é ignorado", async () => {
    const { resolverModeloDoPonto } = await import("@/lib/ai/gateway-binding");
    const r = await resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5");
    expect(r?.origem).toBe("binding");
    await geracao(r!.model);
    expect(chamadas.map((c) => c.host)).toEqual(["api.anthropic.com"]);
  });
});

describe("variável malformada: recusa antes de qualquer byte e nunca cai no padrão", () => {
  beforeEach(() => vi.stubEnv("ANTHROPIC_BASE_URL", COM_CREDENCIAL));

  // Os que montam o modelo na hora lançam; o ponto de IA da organização devolve `null` e loga.
  it.each(PONTOS.filter((p) => !p.nome.startsWith("ponto de IA")))(
    "$nome lança AnthropicBaseUrlInvalidaError",
    async ({ montar }) => {
      let erro: unknown = null;
      try {
        await montar();
      } catch (e) {
        erro = e;
      }
      expect(erro).toBeInstanceOf(AnthropicBaseUrlInvalidaError);
      expect((erro as Error).message).not.toContain("valor-sintetico");
      expect((erro as Error).message).not.toContain(VALOR_DA_CHAVE);
      expect(chamadas).toHaveLength(0);
    },
  );

  it("ponto de IA da organização: devolve null, loga em error e não chama a rede (a tela e os workers seguem de pé)", async () => {
    const { resolverModeloDoPonto } = await import("@/lib/ai/gateway-binding");
    expect(
      await resolverModeloDoPonto("sentiment_classify", ORG, "anthropic/claude-haiku-4-5"),
    ).toBeNull();
    expect(logDeErro).toHaveBeenCalledTimes(1);
    const [mensagem, contexto] = logDeErro.mock.calls[0] as [string, Record<string, unknown>];
    expect(mensagem).toContain("ANTHROPIC_BASE_URL");
    expect(contexto).toMatchObject({
      organization_id: ORG,
      purpose: "sentiment_classify",
      motivo: "credenciais_na_url",
    });
    // O log leva o motivo, nunca o valor.
    expect(JSON.stringify(logDeErro.mock.calls)).not.toContain("valor-sintetico");
    expect(chamadas).toHaveLength(0);
  });

  it("a tela de Execuções recebe um código próprio, e não 'erro_desconhecido'", async () => {
    const { normalizarErro } = await import("@/lib/agent-engine/edge/llm/run-model-call");
    const { createDefaultRegistry } = await import("@/lib/agent-engine/edge/llm/providers");
    const erro = erroDe(() =>
      createDefaultRegistry().anthropic!(VALOR_DA_CHAVE, "claude-haiku-4-5"),
    );
    expect(erro).toBeInstanceOf(AnthropicBaseUrlInvalidaError);
    const n = normalizarErro(erro);
    expect(n.error_code).toBe("anthropic_base_url_invalida");
    expect(n.http_status).toBeNull();
    expect(n.error_message).toContain("ANTHROPIC_BASE_URL");
    expect(n.error_message).not.toContain("valor-sintetico");
  });

  it("o worker não sobe (loadEnv) e diz o NOME da variável, não o valor", async () => {
    const { loadEnv } = await import("@/lib/agent-engine/env");
    const base = {
      SUPABASE_DB_URL: "postgres://host-do-banco:5432/banco",
      NEXT_PUBLIC_SUPABASE_URL: "https://exemplo.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "servico",
      ANTHROPIC_BASE_URL: COM_CREDENCIAL,
    } as unknown as NodeJS.ProcessEnv;
    const erro = erroDe(() => loadEnv(base));
    const mensagem = String((erro as Error | null)?.message ?? "");
    expect(mensagem).toContain("ANTHROPIC_BASE_URL");
    expect(mensagem).not.toContain("valor-sintetico");
  });

  it("o worker sobe com a variável vazia e com um endereço válido", async () => {
    const { loadEnv } = await import("@/lib/agent-engine/env");
    const base = {
      SUPABASE_DB_URL: "postgres://host-do-banco:5432/banco",
      NEXT_PUBLIC_SUPABASE_URL: "https://exemplo.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "servico",
    };
    expect(
      erroDe(() => loadEnv({ ...base, ANTHROPIC_BASE_URL: "" } as unknown as NodeJS.ProcessEnv)),
    ).toBeNull();
    expect(
      erroDe(() => loadEnv({ ...base, ANTHROPIC_BASE_URL: PONTE } as unknown as NodeJS.ProcessEnv)),
    ).toBeNull();
  });
});

// ─── Redirect ───────────────────────────────────────────────────────────────

describe("redirect 3xx vindo do endereço configurado é bloqueado", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_BASE_URL", PONTE);
    responder = () =>
      new Response(null, { status: 302, headers: { location: "https://coletor.example/x" } });
  });

  it.each(PONTOS)("$nome", async ({ montar }) => {
    const model = await montar();
    expect(model).not.toBeNull();
    expect(await geracao(model!)).not.toBeNull();
    // Uma tentativa, ao endereço escolhido; o destino do Location nunca é alcançado.
    expect(chamadas.map((c) => c.host)).toEqual(["claude-ponte:8080"]);
  });
});

// ─── Erros ──────────────────────────────────────────────────────────────────

/** O corpo de erro no formato da API de Mensagens (a ponte devolve o mesmo). */
function erroDaAnthropic(tipo: string) {
  return { type: "error", error: { type: tipo, message: "mensagem do provedor" } };
}

describe("503, 429, 401 e 404 chegam classificados como os da Anthropic real", () => {
  const CASOS: Array<[number, string, string]> = [
    [503, "overloaded_error", "provedor_indisponivel"], // ponte desligada ou sobrecarregada
    [429, "rate_limit_error", "limite_ou_saldo"], // a fila da ponte estourou
    [401, "authentication_error", "credencial_recusada"], // segredo errado
    [404, "not_found_error", "modelo_inexistente"], // modelo que a ponte não conhece
  ];

  it.each(CASOS)("HTTP %i (%s) → %s", async (status, tipo, esperado) => {
    const { normalizarErro } = await import("@/lib/agent-engine/edge/llm/run-model-call");
    const { createDefaultRegistry } = await import("@/lib/agent-engine/edge/llm/providers");
    responder = () => resposta(status, erroDaAnthropic(tipo));

    // O mesmo erro, no endereço de sempre e no da instalação: a classificação é uma só.
    const noPadrao = normalizarErro(
      await geracao(createDefaultRegistry().anthropic!(VALOR_DA_CHAVE, "claude-haiku-4-5")),
    );
    vi.stubEnv("ANTHROPIC_BASE_URL", PONTE);
    const naPonte = normalizarErro(
      await geracao(createDefaultRegistry().anthropic!(VALOR_DA_CHAVE, "claude-haiku-4-5")),
    );

    expect(noPadrao).toMatchObject({ error_code: esperado, http_status: status });
    expect(naPonte).toMatchObject({ error_code: esperado, http_status: status });
    // Sem laço: `maxRetries: 0` na prova; cada pedido saiu uma vez para cada endereço.
    expect(chamadas.map((c) => c.host)).toEqual(["api.anthropic.com", "claude-ponte:8080"]);
    // E a chave nunca aparece no texto que a tela de Execuções mostra.
    expect(naPonte.error_message).not.toContain(VALOR_DA_CHAVE);
  });
});

// ─── Validador, prova de crédito e contagem de tokens ───────────────────────

describe("validateAnthropicKey", () => {
  it("sem a variável: GET https://api.anthropic.com/v1/models", async () => {
    responder = () => resposta(200, { data: [{ id: "claude-haiku-4-5" }] });
    const { validateAnthropicKey } = await import("@/lib/ai/provider-validators");
    expect(await validateAnthropicKey(VALOR_DA_CHAVE)).toEqual({
      ok: true,
      models: ["claude-haiku-4-5"],
    });
    expect(chamadas.map((c) => c.url)).toEqual(["https://api.anthropic.com/v1/models"]);
  });

  it("com a variável: a chave vai ao endereço da instalação, não à Anthropic", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", PONTE);
    responder = () =>
      resposta(200, { data: [{ id: "claude-haiku-4-5" }, { id: "claude-sonnet-5" }] });
    const { validateAnthropicKey } = await import("@/lib/ai/provider-validators");
    expect(await validateAnthropicKey(VALOR_DA_CHAVE)).toEqual({
      ok: true,
      models: ["claude-haiku-4-5", "claude-sonnet-5"],
    });
    expect(chamadas.map((c) => c.url)).toEqual([`${PONTE}/v1/models`]);
    expect(chamadas[0]!.cabecalhoDaChave).toBe(VALOR_DA_CHAVE);
    expect(chamadas[0]!.redirect).toBe("manual");
  });

  it("3xx não é seguido: vira provider_status_302 e a chave não vai adiante", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", PONTE);
    responder = () =>
      new Response(null, { status: 302, headers: { location: "https://coletor.example/x" } });
    const { validateAnthropicKey } = await import("@/lib/ai/provider-validators");
    expect(await validateAnthropicKey(VALOR_DA_CHAVE)).toEqual({
      ok: false,
      error: "provider_status_302",
    });
    expect(chamadas.map((c) => c.host)).toEqual(["claude-ponte:8080"]);
  });

  it("variável malformada: recusa sem chamar a rede", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "claude-ponte:8080");
    const { validateAnthropicKey } = await import("@/lib/ai/provider-validators");
    expect(await validateAnthropicKey(VALOR_DA_CHAVE)).toEqual({
      ok: false,
      error: "anthropic_base_url_invalida",
    });
    expect(chamadas).toHaveLength(0);
  });

  it("401 da ponte é chave errada, como na Anthropic", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", PONTE);
    responder = () => resposta(401, erroDaAnthropic("authentication_error"));
    const { validateAnthropicKey } = await import("@/lib/ai/provider-validators");
    expect(await validateAnthropicKey(VALOR_DA_CHAVE)).toEqual({
      ok: false,
      error: "auth_failed_401",
    });
  });
});

describe("prova de crédito (montarRequisicaoDeProva / provarSaldo)", () => {
  it("sem a variável: POST https://api.anthropic.com/v1/messages", async () => {
    const { montarRequisicaoDeProva } = await import("@/lib/instalacao/prova-de-credito");
    expect(montarRequisicaoDeProva("anthropic", VALOR_DA_CHAVE, "claude-haiku-4-5")?.url).toBe(
      "https://api.anthropic.com/v1/messages",
    );
  });

  it("com a variável: o endereço da instalação, e o baseUrl do parâmetro não desvia", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", PONTE);
    const { montarRequisicaoDeProva } = await import("@/lib/instalacao/prova-de-credito");
    expect(
      montarRequisicaoDeProva(
        "anthropic",
        VALOR_DA_CHAVE,
        "claude-haiku-4-5",
        "http://intruso.example.com",
      )?.url,
    ).toBe(`${PONTE}/v1/messages`);
  });

  it("malformada: provarSaldo devolve o motivo e não chama a rede", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "ftp://claude-ponte");
    const { provarSaldo } = await import("@/lib/instalacao/prova-de-credito");
    const r = await provarSaldo("anthropic", VALOR_DA_CHAVE, "claude-haiku-4-5");
    expect(r).toMatchObject({ ok: false, codigo: "anthropic_base_url_invalida", httpStatus: null });
    expect(chamadas).toHaveLength(0);
  });

  it("3xx não é seguido", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", PONTE);
    responder = () =>
      new Response(null, { status: 302, headers: { location: "https://coletor.example/x" } });
    const { provarSaldo } = await import("@/lib/instalacao/prova-de-credito");
    const r = await provarSaldo("anthropic", VALOR_DA_CHAVE, "claude-haiku-4-5");
    expect(r.ok).toBe(false);
    expect(chamadas.map((c) => c.host)).toEqual(["claude-ponte:8080"]);
  });
});

describe("contagem de tokens (count_tokens)", () => {
  async function contar() {
    const { countPrefixTokens } = await import("@/lib/agent-engine/edge/llm/count-tokens");
    return countPrefixTokens({
      apiKey: VALOR_DA_CHAVE,
      model: "claude-haiku-4-5",
      system: "Você atende.",
    });
  }

  it("sem a variável: https://api.anthropic.com/v1/messages/count_tokens", async () => {
    responder = () => resposta(200, { input_tokens: 7 });
    await contar();
    // São duas medições (com e sem o prefixo), por desenho: o prefixo é a subtração.
    expect(chamadas.map((c) => c.url)).toEqual([
      "https://api.anthropic.com/v1/messages/count_tokens",
      "https://api.anthropic.com/v1/messages/count_tokens",
    ]);
  });

  it("com a variável: o endereço da instalação, com a chave da credencial", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", PONTE);
    responder = () => resposta(200, { input_tokens: 7 });
    await contar();
    expect(chamadas.map((c) => c.url)).toEqual([
      `${PONTE}/v1/messages/count_tokens`,
      `${PONTE}/v1/messages/count_tokens`,
    ]);
    expect(chamadas.every((c) => c.cabecalhoDaChave === VALOR_DA_CHAVE)).toBe(true);
  });

  it("variável malformada: lança sem chamar a rede", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "http://claude-ponte:8080/v2");
    await expect(contar()).rejects.toBeInstanceOf(AnthropicBaseUrlInvalidaError);
    expect(chamadas).toHaveLength(0);
  });
});
