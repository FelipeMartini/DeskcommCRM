/**
 * A FOTO DO CLIENTE NÃO PODE SAIR PARA `api.anthropic.com` QUANDO A INSTALAÇÃO USA O OMNIROUTER.
 *
 * O que aconteceu (medido pela Mylab em 15/10/2026, no contador de kernel do contêiner): o
 * `media-derive-worker` montava a `LlmEdgeConfig` à mão, campo a campo, e NÃO levava o gateway da
 * instalação. Sem ele o degrau do gateway de `resolveOrgLlmConfig` era pulado para toda organização, a
 * escada caía na chave da INSTALAÇÃO (`ANTHROPIC_API_KEY`) e a fábrica `anthropic` — que tem o
 * endereço fixo e não lê nenhum outro — mandava a foto do cliente (~77 KB) e essa chave para fora do
 * laboratório. Três tentativas, todas recusadas com 401, mas o byte já tinha saído. É ponto de LGPD.
 *
 * O gateway de hoje é o OmniRouter (`lib/ai/omnirouter.ts`), configurável na tela de Credenciais; o
 * `.env` é só o piso. Este arquivo é o sucessor do teste que existia para a antiga ponte.
 *
 * Por que os testes que já existiam não pegaram: todos eles dublam `resolveOrgLlmConfig`, o
 * `createDefaultRegistry` ou os dois — então a pergunta "o gateway chega ao worker?" ficava mascarada
 * pelos dublês. Aqui nada disso é dublê: o worker é o real, a escada de credenciais é a real, o
 * registro de provedores é o real e o SDK é o real, com `globalThis.fetch` interceptado para dizer
 * QUEM foi chamado, com QUE chave e levando O QUÊ. Só o banco, o `deriveMediaText` (a fronteira) e a
 * consulta de capacidade do catálogo são dublês.
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
  /** `organizations.settings->'omnirouter'`: a ESCOLHA da organização. `undefined` = nunca escolheu. */
  escolha: undefined as unknown,
  /** O que a tela de Credenciais gravou em `platform_config` (vence o `.env`). */
  platformConfig: [] as unknown[],
  /** A organização do evento em curso: a mensagem e o caminho da mídia dela acompanham. */
  orgDoEvento: "11111111-1111-4111-8111-111111111111",
}));
vi.mock("@/lib/agent-engine/db/pool", () => ({
  createPool: () => ({
    query: async (sql: string) => {
      if (sql.includes("settings->'llm'")) {
        return { rows: [{ llm: banco.settings, omnirouter: banco.escolha }] };
      }
      if (sql.includes("from platform_config")) return { rows: banco.platformConfig };
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
// A mídia mora sob o id da organização dona dela (`<org>/<conversa>/<arquivo>`): o worker recusa o
// objeto que o caminho não prova ser da org do evento (`isMediaPathInOrganization`, #3592). Por isso a
// linha acompanha a organização do evento em vez de ter uma org fixa.
const linhaDaMensagem = () => ({
  id: "msg1",
  organization_id: banco.orgDoEvento,
  type: "image",
  media_mime: "image/png",
  media_storage_path: `${banco.orgDoEvento}/conv1/msg1.png`,
  media_derived_status: null as string | null,
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      // Sem binding de visão: o worker segue pela escada padrão da organização.
      const linha =
        tabela === "ai_purpose_bindings" || tabela === "agent_inbox_items" ? null : linhaDaMensagem();
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

// ─── O ambiente: o worker lê as chaves e o gateway pelo `env` do app (o PISO) ─
const ambiente = vi.hoisted(() => ({
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  OPENROUTER_API_KEY: "",
  OMNIROUTER_BASE_URL: "",
  OMNIROUTER_API_KEY: "",
  OMNIROUTER_PARA_TODAS: "",
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
      get OMNIROUTER_BASE_URL() {
        return ambiente.OMNIROUTER_BASE_URL;
      },
      get OMNIROUTER_API_KEY() {
        return ambiente.OMNIROUTER_API_KEY;
      },
      get OMNIROUTER_PARA_TODAS() {
        return ambiente.OMNIROUTER_PARA_TODAS;
      },
    },
  };
});

import { deriveMessageMedia } from "@/workers/media-derive-worker";
import { deriveMediaText, type DeriveDeps } from "@/lib/messaging/media/derive";
import type { Env } from "@/lib/env";

const OMNI = "http://omnirouter:20128";
const CHAVE_DO_OMNI = "chave-do-omnirouter-sintetica";
const CHAVE_DA_INSTALACAO = "chave-anthropic-da-instalacao-sintetica";
const CHAVE_DA_ORG = "chave-propria-da-org-sintetica";
const ORG_ESCOLHIDA = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "22222222-2222-4222-8222-222222222222";
/** Montado em partes: é valor de teste, não segredo. */
const COM_CREDENCIAL = ["http://", "usuario", ":", "valor-sintetico", "@omnirouter:20128"].join("");

const COM_BYOK = [{ id: "cred-1", api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" }];

/** Os bytes da "foto do cliente": o que importa é saber PARA ONDE eles vão. */
const FOTO = Buffer.from("foto-do-cliente-sintetica-0123456789");
const FOTO_EM_BASE64 = FOTO.toString("base64");

/** A resposta do OmniRouter (API OpenAI chat/completions). */
const COMPLETION_DA_FOTO = {
  id: "chatcmpl-teste",
  object: "chat.completion",
  created: 1,
  model: "claude-haiku-4-5",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "uma sandália azul sobre a mesa" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 1200, completion_tokens: 12, total_tokens: 1212 },
};

/** A resposta da Anthropic direta (API de mensagens) — só para o caminho em que o gateway não entra. */
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
  /** `Authorization: Bearer …` (OmniRouter) ou `x-api-key` (Anthropic direta), o que vier. */
  chave: string | null;
  redirect: RequestRedirect | undefined;
  corpo: string;
}

function eventRow(orgId: string) {
  banco.orgDoEvento = orgId;
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

/** O OmniRouter no `.env` (o piso), com a chave real da instalação ao fundo. */
function comOOmniRouterNoEnv(): void {
  ambiente.ANTHROPIC_API_KEY = CHAVE_DA_INSTALACAO;
  ambiente.OMNIROUTER_BASE_URL = OMNI;
  ambiente.OMNIROUTER_API_KEY = CHAVE_DO_OMNI;
}

/** A linha de `platform_config` como a tela de Credenciais a grava (texto simples ou segredo). */
function linhaDaTela(chave: string, valor: string | null, segredo = false) {
  return {
    chave,
    valor: segredo ? null : valor,
    ciphertext: segredo ? "c" : null,
    iv: segredo ? "i" : null,
    tag: segredo ? "t" : null,
    eh_segredo: segredo,
    semeado_do_env: false,
  };
}

describe("worker de mídia: a descrição da foto passa pelo OmniRouter", () => {
  let fetchOriginal: typeof globalThis.fetch;
  let chamadas: Chamada[];
  /** O que o servidor do outro lado responde; cada caso pode trocar (o OmniRouter recusando, por exemplo). */
  let responder: (c: Chamada) => Response;

  const respostaDoOmniRouter = () =>
    new Response(JSON.stringify(COMPLETION_DA_FOTO), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const respostaDaAnthropic = () =>
    new Response(JSON.stringify(MENSAGEM_DA_ANTHROPIC), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    banco.credenciais = [];
    banco.escolha = undefined;
    banco.platformConfig = [];
    Object.assign(ambiente, {
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      OPENROUTER_API_KEY: "",
      OMNIROUTER_BASE_URL: "",
      OMNIROUTER_API_KEY: "",
      OMNIROUTER_PARA_TODAS: "",
    });
    downloadMock.mockResolvedValue({
      data: { arrayBuffer: async () => new ArrayBuffer(8) },
      error: null,
    });
    chamadas = [];
    // Cada destino responde no formato da sua própria API; o caso só troca o que quiser quebrar.
    responder = (c) => (c.host === "api.anthropic.com" ? respostaDaAnthropic() : respostaDoOmniRouter());
    fetchOriginal = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const cabecalhos = new Headers(init?.headers);
      const chamada: Chamada = {
        url,
        host: new URL(url).host,
        chave: cabecalhos.get("x-api-key") ?? cabecalhos.get("authorization")?.replace(/^Bearer /, "") ?? null,
        redirect: init?.redirect,
        corpo: typeof init?.body === "string" ? init.body : "",
      };
      chamadas.push(chamada);
      return responder(chamada);
    }) as typeof globalThis.fetch;
    // A fábrica `anthropic` ignora esta variável; limpá-la deixa o ambiente do caso previsível.
    vi.stubEnv("ANTHROPIC_BASE_URL", undefined);
  });

  afterEach(() => {
    globalThis.fetch = fetchOriginal;
    vi.unstubAllEnvs();
  });

  const hosts = () => [...new Set(chamadas.map((c) => c.host))];

  it("⭐ organização escolhida, sem credencial própria: a foto vai SÓ ao OmniRouter, com a chave dele", async () => {
    comOOmniRouterNoEnv();
    banco.escolha = { habilitado: true };

    await deriveMessageMedia(eventRow(ORG_ESCOLHIDA));
    const texto = await depsDaChamada().describeImage(FOTO, "image/png");

    // Uma chamada, ao OmniRouter, no caminho do SDK, sem seguir redirect.
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toMatchObject({
      url: `${OMNI}/v1/chat/completions`,
      host: "omnirouter:20128",
      chave: CHAVE_DO_OMNI,
      redirect: "manual",
    });
    // E é a FOTO que foi: sem isto o caso passaria também se o worker mandasse só o texto.
    expect(chamadas[0]!.corpo, "a foto do cliente não chegou ao OmniRouter").toContain(FOTO_EM_BASE64);
    // Nada saiu para a Anthropic, e a chave da instalação não participou de chamada nenhuma.
    expect(hosts()).toEqual(["omnirouter:20128"]);
    expect(chamadas.some((c) => c.chave === CHAVE_DA_INSTALACAO)).toBe(false);
    // A descrição voltou e nada foi dado como "mídia não lida" ao operador.
    expect(texto).toBe("uma sandália azul sobre a mesa");
    expect(corposDaCentral()).toEqual([]);
  });

  it("a oferta geral da instalação (`OMNIROUTER_PARA_TODAS`) atende quem nunca escolheu", async () => {
    comOOmniRouterNoEnv();
    ambiente.OMNIROUTER_PARA_TODAS = "true";

    await deriveMessageMedia(eventRow(OUTRA_ORG));
    await depsDaChamada().describeImage(FOTO, "image/png");

    expect(hosts()).toEqual(["omnirouter:20128"]);
    expect(chamadas[0]!.chave).toBe(CHAVE_DO_OMNI);
  });

  it("⭐ a oferta geral NÃO vale para a organização que RECUSOU: a foto não vai ao OmniRouter", async () => {
    comOOmniRouterNoEnv();
    ambiente.OMNIROUTER_PARA_TODAS = "true";
    banco.escolha = { habilitado: false };

    await deriveMessageMedia(eventRow(ORG_ESCOLHIDA));
    await depsDaChamada().describeImage(FOTO, "image/png");

    expect(chamadas.some((c) => c.host === "omnirouter:20128")).toBe(false);
    // Quem recusou segue o caminho de sempre (a chave da instalação), nunca a de outro dono.
    expect(hosts()).toEqual(["api.anthropic.com"]);
    expect(chamadas.every((c) => c.chave === CHAVE_DA_INSTALACAO)).toBe(true);
  });

  it("⭐ o que a TELA de Credenciais gravou vence o `.env`: a foto vai ao endereço e com a chave do painel", async () => {
    // O `.env` aponta para um OmniRouter antigo; o painel (banco) aponta para o novo. O motor lê o banco.
    comOOmniRouterNoEnv();
    banco.escolha = { habilitado: true };
    banco.platformConfig = [
      linhaDaTela("OMNIROUTER_BASE_URL", "http://omnirouter-novo:20128"),
      linhaDaTela("OMNIROUTER_API_KEY", null, true),
    ];

    await deriveMessageMedia(eventRow(ORG_ESCOLHIDA));
    await depsDaChamada().describeImage(FOTO, "image/png");

    expect(hosts()).toEqual(["omnirouter-novo:20128"]);
    // O `decryptKey` fingido devolve "chave-propria-da-org-sintetica" para qualquer envelope: o que
    // importa é que NÃO foi a chave do `.env` (o painel venceu).
    expect(chamadas.some((c) => c.chave === CHAVE_DO_OMNI)).toBe(false);
    expect(chamadas.every((c) => c.chave === CHAVE_DA_ORG)).toBe(true);
  });

  it("⭐ só o painel (sem nada no `.env`) já basta: o OmniRouter existe para o motor", async () => {
    banco.escolha = { habilitado: true };
    banco.platformConfig = [
      linhaDaTela("OMNIROUTER_BASE_URL", OMNI),
      linhaDaTela("OMNIROUTER_API_KEY", null, true),
    ];

    await deriveMessageMedia(eventRow(ORG_ESCOLHIDA));
    await depsDaChamada().describeImage(FOTO, "image/png");

    expect(hosts()).toEqual(["omnirouter:20128"]);
  });

  it("⭐ a chamada que saiu é registrada em llm_calls como da Anthropic (o custo não some)", async () => {
    comOOmniRouterNoEnv();
    banco.escolha = { habilitado: true };

    await deriveMessageMedia(eventRow(ORG_ESCOLHIDA));
    await depsDaChamada().describeImage(FOTO, "image/png");

    // A linha é fire-and-forget: espera ela assentar em vez de supor a ordem.
    await vi.waitFor(() => expect(custoInsertMock).toHaveBeenCalledTimes(1));
    expect(custoInsertMock.mock.calls[0]![0]).toMatchObject({
      organization_id: ORG_ESCOLHIDA,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      status: "ok",
      input_tokens: 1200,
      output_tokens: 12,
    });
  });

  it("⭐ o OmniRouter RECUSANDO (429): a descrição falha em voz alta e a foto NÃO cai na Anthropic de reserva", async () => {
    // Falhar fechado é a garantia: a recusa vira erro do worker (que o drain repete e, esgotadas as
    // tentativas, mostra ao operador), e jamais um segundo destino que ninguém autorizou.
    comOOmniRouterNoEnv();
    banco.escolha = { habilitado: true };
    responder = () =>
      new Response(
        JSON.stringify({ error: { message: "teto do gateway", type: "rate_limit_error" } }),
        // `retry-after-ms` curto: o SDK repete por padrão e o caso não precisa esperar o backoff.
        { status: 429, headers: { "content-type": "application/json", "retry-after-ms": "1" } },
      );

    await deriveMessageMedia(eventRow(ORG_ESCOLHIDA));
    await expect(depsDaChamada().describeImage(FOTO, "image/png")).rejects.toThrow();

    expect(chamadas.length).toBeGreaterThan(0);
    expect(hosts(), "a foto foi para outro destino quando o OmniRouter recusou").toEqual([
      "omnirouter:20128",
    ]);
    expect(chamadas.every((c) => c.chave === CHAVE_DO_OMNI)).toBe(true);
    // A falha deixa rastro de custo/erro para a tela de Execuções, como qualquer outra.
    await vi.waitFor(() => expect(custoInsertMock).toHaveBeenCalledTimes(1));
    expect(custoInsertMock.mock.calls[0]![0]).toMatchObject({
      provider: "anthropic",
      status: "erro",
    });
  });

  it("⭐ organização escolhida COM credencial própria: vai à Anthropic com a chave DELA, e o OmniRouter nem vê", async () => {
    comOOmniRouterNoEnv();
    banco.escolha = { habilitado: true };
    banco.credenciais = COM_BYOK;

    await deriveMessageMedia(eventRow(ORG_ESCOLHIDA));
    await depsDaChamada().describeImage(FOTO, "image/png");

    expect(hosts()).toEqual(["api.anthropic.com"]);
    expect(chamadas.every((c) => c.chave === CHAVE_DA_ORG)).toBe(true);
    expect(chamadas.some((c) => c.host === "omnirouter:20128")).toBe(false);
  });

  it("CONTROLE — instalação sem OmniRouter: segue como sempre, pela chave da instalação (regressão zero)", async () => {
    // Sem `OMNIROUTER_*` nada do gateway existe. Sem este caso, uma correção que mandasse TUDO para
    // o OmniRouter deixaria os de cima verdes — e quebraria quem nunca o configurou.
    ambiente.ANTHROPIC_API_KEY = CHAVE_DA_INSTALACAO;
    banco.escolha = { habilitado: true };

    await deriveMessageMedia(eventRow(ORG_ESCOLHIDA));
    await depsDaChamada().describeImage(FOTO, "image/png");

    expect(hosts()).toEqual(["api.anthropic.com"]);
    expect(chamadas.every((c) => c.chave === CHAVE_DA_INSTALACAO)).toBe(true);
  });

  it("CONTROLE — organização que NÃO foi escolhida: o OmniRouter não a atende e o caminho de sempre segue", async () => {
    comOOmniRouterNoEnv();

    await deriveMessageMedia(eventRow(OUTRA_ORG));
    await depsDaChamada().describeImage(FOTO, "image/png");

    expect(hosts()).toEqual(["api.anthropic.com"]);
    expect(chamadas.every((c) => c.chave === CHAVE_DA_INSTALACAO)).toBe(true);
    expect(chamadas.some((c) => c.host === "omnirouter:20128")).toBe(false);
  });

  it("⭐ endereço do OmniRouter malformado para quem o usaria: NENHUM byte sai, nem para a Anthropic", async () => {
    // Endereço com credencial embutida: o módulo recusa em vez de cair no endereço padrão ou na chave
    // da instalação. Falhar fechado é a garantia — quem escolhe o OmniRouter não recebe a Anthropic
    // de brinde.
    comOOmniRouterNoEnv();
    ambiente.OMNIROUTER_BASE_URL = COM_CREDENCIAL;
    banco.escolha = { habilitado: true };

    const r = await deriveMessageMedia(eventRow(ORG_ESCOLHIDA));
    const deps = vi.mocked(deriveMediaText).mock.calls[0]?.[3];
    if (deps) await deps.describeImage(FOTO, "image/png");

    expect(chamadas, "a foto saiu com o OmniRouter malformado").toHaveLength(0);
    expect(r.status).not.toBe("ok");
  });
});
