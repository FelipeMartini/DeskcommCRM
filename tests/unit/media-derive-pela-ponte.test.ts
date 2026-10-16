/**
 * A FOTO DO CLIENTE NÃO PODE SAIR PARA `api.anthropic.com` QUANDO A INSTALAÇÃO USA A PONTE.
 *
 * O que aconteceu (medido pela Mylab em 15/10/2026, no contador de kernel do contêiner): o
 * `media-derive-worker` montava a `LlmEdgeConfig` à mão, campo a campo, e NÃO levava `ponte`.
 * Sem ela o degrau da claude-ponte de `resolveOrgLlmConfig` era pulado para toda organização, a
 * escada caía na chave da INSTALAÇÃO (`ANTHROPIC_API_KEY`, no servidor a mesma do OmniRoute) e a
 * fábrica `anthropic` — que tem o endereço fixo e não lê nenhum outro — mandava a foto do
 * cliente (~77 KB) e essa chave para fora do laboratório. Três tentativas, todas recusadas com
 * 401, mas o byte já tinha saído. É ponto de LGPD, e a ordem do dono (10–11/10) é que TODA
 * chamada à Anthropic do CRM passe pela ponte.
 *
 * Por que os testes que já existiam não pegaram: todos eles dublam `resolveOrgLlmConfig`, o
 * `createDefaultRegistry` ou os dois — então a pergunta "a ponte chega ao worker?" ficava
 * mascarada pelos dublês. Aqui nada disso é dublê: o worker é o real, a escada de credenciais é a
 * real, o registro de provedores é o real e o SDK é o real, com `globalThis.fetch` interceptado
 * para dizer QUEM foi chamado, com QUE chave e levando O QUÊ. Só o banco, o `deriveMediaText`
 * (a fronteira) e a consulta de capacidade do catálogo são dublês.
 *
 * Valores sintéticos: nenhuma chave real, nenhuma rede.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── O banco: as consultas que a escada e o worker fazem ─────────────────────
//
// `derivePool()` do worker guarda o pool numa variável de módulo; por isso o `query` lê o estado
// MUTÁVEL no momento da chamada (cada caso escolhe o que a organização tem cadastrado).
const banco = vi.hoisted(() => ({
  credenciais: [] as unknown[],
  settings: { provider: "anthropic", default_model: "claude-haiku-4-5" } as unknown,
}));
vi.mock("@/lib/agent-engine/db/pool", () => ({
  createPool: () => ({
    query: async (sql: string) => {
      if (sql.includes("settings->'llm'")) return { rows: [{ llm: banco.settings }] };
      if (sql.includes("from ai_purpose_bindings")) return { rows: [] };
      if (sql.includes("from ai_provider_credentials")) return { rows: banco.credenciais };
      return { rows: [] };
    },
  }),
}));

vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: () => Buffer.from(""),
  decryptKey: () => "chave-propria-da-org-sintetica",
}));

// ─── O admin do Supabase: responde por TABELA (mensagem / binding / Central) ──
const inboxInsertMock = vi.fn();
/** As linhas de custo que o worker grava em `llm_calls` (pelo admin, fire-and-forget). */
const custoInsertMock = vi.fn();
const downloadMock = vi.fn();
const linhaDaMensagem = {
  id: "msg1",
  organization_id: "11111111-1111-4111-8111-111111111111",
  type: "image",
  media_mime: "image/png",
  media_storage_path: "org/conv1/msg1.png",
  media_derived_status: null as string | null,
};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      // Sem binding de visão: o worker segue pela escada padrão da organização.
      const linha =
        tabela === "ai_purpose_bindings" || tabela === "agent_inbox_items" ? null : linhaDaMensagem;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const terminais: any = {
        maybeSingle: async () => ({ data: linha, error: null }),
        single: async () => ({ data: linha, error: null }),
        insert: async (row: Record<string, unknown>) => {
          if (tabela === "agent_inbox_items") inboxInsertMock(row);
          if (tabela === "llm_calls") custoInsertMock(row);
          return { error: null };
        },
        update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: linha ? [linha] : [], error: null }).then(resolve),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = new Proxy(terminais, {
        get: (alvo, prop) => (prop in alvo ? alvo[prop as keyof typeof alvo] : () => chain),
      });
      return chain;
    },
    storage: { from: () => ({ download: downloadMock }) },
  }),
}));

// `deriveMediaText` é a fronteira: o caso lê as deps que o worker montou e chama `describeImage`.
vi.mock("@/lib/messaging/media/derive", () => ({
  deriveMediaText: vi.fn(async () => "derivado de mentira"),
}));

// Num roteador isto consultaria o catálogo no banco; o modelo é dado como capaz para a chamada
// chegar à rede, que é onde está o assunto.
vi.mock("@/lib/ai/pontos/capacidade-em-vigor", () => ({
  visaoEmVigor: vi.fn(async () => ({ enxerga: true, sabemos: true })),
}));

// ─── O ambiente: o worker lê as chaves e a ponte pelo `env` do app ───────────
const ambiente = vi.hoisted(() => ({
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  OPENROUTER_API_KEY: "",
  CLAUDE_PONTE_BASE_URL: "",
  CLAUDE_PONTE_API_KEY: "",
  CLAUDE_PONTE_ORGS: "",
}));
vi.mock("@/lib/env", async (importOriginal) => {
  const real = await importOriginal<{ env: Env }>();
  return {
    env: {
      ...real.env,
      // Os getters vencem o que o `.env.local` de quem roda a suíte tiver: o caso é dono de tudo.
      get ANTHROPIC_API_KEY() {
        return ambiente.ANTHROPIC_API_KEY;
      },
      get OPENAI_API_KEY() {
        return ambiente.OPENAI_API_KEY;
      },
      get OPENROUTER_API_KEY() {
        return ambiente.OPENROUTER_API_KEY;
      },
      get CLAUDE_PONTE_BASE_URL() {
        return ambiente.CLAUDE_PONTE_BASE_URL;
      },
      get CLAUDE_PONTE_API_KEY() {
        return ambiente.CLAUDE_PONTE_API_KEY;
      },
      get CLAUDE_PONTE_ORGS() {
        return ambiente.CLAUDE_PONTE_ORGS;
      },
    },
  };
});

import { deriveMessageMedia } from "@/workers/media-derive-worker";
import { deriveMediaText, type DeriveDeps } from "@/lib/messaging/media/derive";
import type { Env } from "@/lib/env";

const PONTE = "http://claude-ponte:8080";
const CHAVE_DA_PONTE = "chave-da-ponte-sintetica";
const CHAVE_DA_INSTALACAO = "chave-anthropic-da-instalacao-sintetica";
const CHAVE_DA_ORG = "chave-propria-da-org-sintetica";
const ORG_NA_LISTA = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "22222222-2222-4222-8222-222222222222";
/** Montado em partes: é valor de teste, não segredo. */
const COM_CREDENCIAL = ["http://", "usuario", ":", "valor-sintetico", "@claude-ponte:8080"].join(
  "",
);

const COM_BYOK = [{ id: "cred-1", api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" }];

/** Os bytes da "foto do cliente": o que importa é saber PARA ONDE eles vão. */
const FOTO = Buffer.from("foto-do-cliente-sintetica-0123456789");
const FOTO_EM_BASE64 = FOTO.toString("base64");

const MENSAGEM_DA_ANTHROPIC = {
  id: "msg_teste",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5",
  content: [{ type: "text", text: "uma sandália azul sobre a mesa" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1200, output_tokens: 12 },
};

interface Chamada {
  url: string;
  host: string;
  chave: string | null;
  redirect: RequestRedirect | undefined;
  corpo: string;
}

function eventRow(orgId: string) {
  return {
    id: "ev1",
    organization_id: orgId,
    event_type: "media.derive_requested",
    entity_kind: "message",
    entity_id: "msg1",
    payload: { message_id: "msg1" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

/** As deps que o worker montou, ou erro explícito se a derivação nem começou. */
function depsDaChamada(): DeriveDeps {
  const chamada = vi.mocked(deriveMediaText).mock.calls[0];
  if (!chamada)
    throw new Error("deriveMediaText não foi chamado: a derivação parou antes das deps");
  const deps = chamada[3];
  if (!deps) throw new Error("deriveMediaText foi chamado sem deps");
  return deps;
}

function corposDaCentral(): string[] {
  return inboxInsertMock.mock.calls.map((c) =>
    String((c[0] as { body?: string } | undefined)?.body ?? ""),
  );
}

/** A instalação do Felipe: a ponte para todas as organizações, e a chave da instalação ao fundo. */
function comAPonteParaTodos(orgs = "*"): void {
  ambiente.ANTHROPIC_API_KEY = CHAVE_DA_INSTALACAO;
  ambiente.CLAUDE_PONTE_BASE_URL = PONTE;
  ambiente.CLAUDE_PONTE_API_KEY = CHAVE_DA_PONTE;
  ambiente.CLAUDE_PONTE_ORGS = orgs;
}

describe("worker de mídia: a descrição da foto passa pela claude-ponte", () => {
  let fetchOriginal: typeof globalThis.fetch;
  let chamadas: Chamada[];
  /** O que o servidor do outro lado responde; cada caso pode trocar (a ponte recusando, por exemplo). */
  let responder: () => Response;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    banco.credenciais = [];
    Object.assign(ambiente, {
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      OPENROUTER_API_KEY: "",
      CLAUDE_PONTE_BASE_URL: "",
      CLAUDE_PONTE_API_KEY: "",
      CLAUDE_PONTE_ORGS: "",
    });
    downloadMock.mockResolvedValue({
      data: { arrayBuffer: async () => new ArrayBuffer(8) },
      error: null,
    });
    chamadas = [];
    responder = () =>
      new Response(JSON.stringify(MENSAGEM_DA_ANTHROPIC), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    fetchOriginal = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      chamadas.push({
        url,
        host: new URL(url).host,
        chave: new Headers(init?.headers).get("x-api-key"),
        redirect: init?.redirect,
        corpo: typeof init?.body === "string" ? init.body : "",
      });
      return responder();
    }) as typeof globalThis.fetch;
    // A fábrica `anthropic` ignora esta variável; limpá-la deixa o ambiente do caso previsível.
    vi.stubEnv("ANTHROPIC_BASE_URL", undefined);
  });

  afterEach(() => {
    globalThis.fetch = fetchOriginal;
    vi.unstubAllEnvs();
  });

  const hosts = () => [...new Set(chamadas.map((c) => c.host))];

  it("⭐ organização da lista, sem credencial própria: a foto vai SÓ à ponte, com a chave da ponte", async () => {
    comAPonteParaTodos(ORG_NA_LISTA);

    await deriveMessageMedia(eventRow(ORG_NA_LISTA));
    const texto = await depsDaChamada().describeImage(FOTO, "image/png");

    // Uma chamada, à ponte, no caminho do SDK, sem seguir redirect.
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toMatchObject({
      url: `${PONTE}/v1/messages`,
      host: "claude-ponte:8080",
      chave: CHAVE_DA_PONTE,
      redirect: "manual",
    });
    // E é a FOTO que foi: sem isto o caso passaria também se o worker mandasse só o texto.
    expect(chamadas[0]!.corpo, "a foto do cliente não chegou à ponte").toContain(FOTO_EM_BASE64);
    // Nada saiu para a Anthropic, e a chave da instalação não participou de chamada nenhuma.
    expect(hosts()).toEqual(["claude-ponte:8080"]);
    expect(chamadas.some((c) => c.chave === CHAVE_DA_INSTALACAO)).toBe(false);
    // A descrição voltou e nada foi dado como "mídia não lida" ao operador.
    expect(texto).toBe("uma sandália azul sobre a mesa");
    expect(corposDaCentral()).toEqual([]);
  });

  it("a ponte para TODAS (`*`) atende a organização sem credencial própria do mesmo jeito", async () => {
    comAPonteParaTodos("*");

    await deriveMessageMedia(eventRow(OUTRA_ORG));
    await depsDaChamada().describeImage(FOTO, "image/png");

    expect(hosts()).toEqual(["claude-ponte:8080"]);
    expect(chamadas[0]!.chave).toBe(CHAVE_DA_PONTE);
  });

  it("⭐ a chamada que saiu é registrada em llm_calls como da Anthropic (o custo não some)", async () => {
    comAPonteParaTodos(ORG_NA_LISTA);

    await deriveMessageMedia(eventRow(ORG_NA_LISTA));
    await depsDaChamada().describeImage(FOTO, "image/png");

    // A linha é fire-and-forget: espera ela assentar em vez de supor a ordem.
    await vi.waitFor(() => expect(custoInsertMock).toHaveBeenCalledTimes(1));
    expect(custoInsertMock.mock.calls[0]![0]).toMatchObject({
      organization_id: ORG_NA_LISTA,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      status: "ok",
      input_tokens: 1200,
      output_tokens: 12,
    });
  });

  it("⭐ a ponte RECUSANDO (429 da cota): a descrição falha em voz alta e a foto NÃO cai na Anthropic de reserva", async () => {
    // A cota semanal da assinatura já esgotou na prática (429 por quase 40 h em 14–15/10). Falhar
    // fechado é a garantia: a recusa vira erro do worker (que o drain repete e, esgotadas as
    // tentativas, mostra ao operador), e jamais um segundo destino que ninguém autorizou.
    comAPonteParaTodos(ORG_NA_LISTA);
    responder = () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "teto da ponte" },
        }),
        // `retry-after-ms` curto: o SDK repete por padrão e o caso não precisa esperar o backoff.
        { status: 429, headers: { "content-type": "application/json", "retry-after-ms": "1" } },
      );

    await deriveMessageMedia(eventRow(ORG_NA_LISTA));
    await expect(depsDaChamada().describeImage(FOTO, "image/png")).rejects.toThrow();

    expect(chamadas.length).toBeGreaterThan(0);
    expect(hosts(), "a foto foi para outro destino quando a ponte recusou").toEqual([
      "claude-ponte:8080",
    ]);
    expect(chamadas.every((c) => c.chave === CHAVE_DA_PONTE)).toBe(true);
    // A falha deixa rastro de custo/erro para a tela de Execuções, como qualquer outra.
    await vi.waitFor(() => expect(custoInsertMock).toHaveBeenCalledTimes(1));
    expect(custoInsertMock.mock.calls[0]![0]).toMatchObject({
      provider: "anthropic",
      status: "erro",
    });
  });

  it("⭐ E10: organização da lista COM credencial própria: vai à Anthropic com a chave DELA, e a ponte nem vê", async () => {
    comAPonteParaTodos(ORG_NA_LISTA);
    banco.credenciais = COM_BYOK;

    await deriveMessageMedia(eventRow(ORG_NA_LISTA));
    await depsDaChamada().describeImage(FOTO, "image/png");

    expect(hosts()).toEqual(["api.anthropic.com"]);
    expect(chamadas.every((c) => c.chave === CHAVE_DA_ORG)).toBe(true);
    expect(chamadas.some((c) => c.host === "claude-ponte:8080")).toBe(false);
  });

  it("CONTROLE — instalação sem ponte: segue como sempre, pela chave da instalação (regressão zero)", async () => {
    // Sem `CLAUDE_PONTE_*` nada da ponte existe. Sem este caso, uma correção que mandasse TUDO
    // para a ponte deixaria os de cima verdes — e quebraria quem nunca ligou a ponte.
    ambiente.ANTHROPIC_API_KEY = CHAVE_DA_INSTALACAO;

    await deriveMessageMedia(eventRow(ORG_NA_LISTA));
    await depsDaChamada().describeImage(FOTO, "image/png");

    expect(hosts()).toEqual(["api.anthropic.com"]);
    expect(chamadas.every((c) => c.chave === CHAVE_DA_INSTALACAO)).toBe(true);
  });

  it("CONTROLE — organização FORA da lista: a ponte não a atende e o caminho de sempre segue", async () => {
    comAPonteParaTodos(ORG_NA_LISTA);

    await deriveMessageMedia(eventRow(OUTRA_ORG));
    await depsDaChamada().describeImage(FOTO, "image/png");

    expect(hosts()).toEqual(["api.anthropic.com"]);
    expect(chamadas.every((c) => c.chave === CHAVE_DA_INSTALACAO)).toBe(true);
    expect(chamadas.some((c) => c.host === "claude-ponte:8080")).toBe(false);
  });

  it("⭐ variável da ponte malformada para quem a usaria: NENHUM byte sai, nem para a Anthropic", async () => {
    // Endereço com credencial embutida: a ponte recusa em vez de cair no endereço padrão ou na
    // chave da instalação. Falhar fechado é a garantia — quem escolhe a ponte não recebe a
    // Anthropic de brinde.
    comAPonteParaTodos(ORG_NA_LISTA);
    ambiente.CLAUDE_PONTE_BASE_URL = COM_CREDENCIAL;

    const r = await deriveMessageMedia(eventRow(ORG_NA_LISTA));
    const deps = vi.mocked(deriveMediaText).mock.calls[0]?.[3];
    if (deps) await deps.describeImage(FOTO, "image/png");

    expect(chamadas, "a foto saiu com a ponte malformada").toHaveLength(0);
    expect(r.status).not.toBe("ok");
  });
});
