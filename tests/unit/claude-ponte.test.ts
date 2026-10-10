/**
 * A CLAUDE-PONTE — um caminho SEPARADO (`CLAUDE_PONTE_*`), e só da instalação.
 *
 * Ordem do dono (10/10/2026): "uma variável separada exclusiva nossa", "separar e
 * isolar", "não podemos quebrar o que já funcionava no CRM". O que este arquivo
 * prova, do contrato da tarefa `T-20261010-MYLAB-01` (refeita):
 *
 *   1. SEM as variáveis, o produto é o de hoje (regressão zero): nada é avaliado,
 *      nada é lido, a chave da instalação segue valendo;
 *   2. a lista `CLAUDE_PONTE_ORGS` manda: vazia = ninguém, id = só aquela
 *      organização, `*` = todas; lista malformada recusa em vez de virar "ninguém";
 *   3. a credencial PRÓPRIA da organização (ativa e validada) SEMPRE vence e vai a
 *      `api.anthropic.com` com a chave dela — a ponte nem vê a chamada (E10);
 *   4. a ponte só atende quem NÃO tem credencial própria, está na lista e tem as
 *      variáveis válidas; fora da lista nada da ponte é avaliado;
 *   5. a chave da ponte nunca chega à Anthropic e a chave da Anthropic nunca chega
 *      à ponte: são DUAS fábricas, e nenhuma aceita as duas;
 *   6. variável malformada para quem a usaria recusa antes de qualquer byte, sem o
 *      valor na mensagem, e nunca cai no endereço padrão nem na chave da instalação;
 *   7. a chamada não segue redirect e só fala com a origem validada.
 *
 * Técnica: pool fingido + registry espião (quem foi chamado, com qual chave e qual
 * endereço) e, no fim, o SDK REAL com `globalThis.fetch` interceptado (a URL e o
 * cabeçalho que ele montou). Nenhuma rede, nenhuma chave real: valores sintéticos.
 */
import { MockLanguageModelV3 } from "ai/test";
import { generateText, type LanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: () => Buffer.from(""),
  decryptKey: () => "chave-propria-da-org-sintetica",
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));

import {
  ClaudePonteInvalidaError,
  FABRICA_DA_PONTE,
  fetchContidoDaPonte,
  lerEnderecoDaPonte,
  opcoesDaPonte,
  ponteDaOrganizacao,
  type VariaveisDaPonte,
} from "@/lib/ai/claude-ponte";
import {
  LlmNotConfiguredError,
  llmEdgeConfigFromEnv,
  resolveOrgLlmConfig,
  type LlmEdgeConfig,
} from "@/lib/agent-engine/edge/llm/credentials";
import {
  createDefaultRegistry,
  createFakeRegistry,
  type ProviderRegistry,
} from "@/lib/agent-engine/edge/llm/providers";
import {
  LlmProviderUnknownError,
  normalizarErro,
  runModelCall,
} from "@/lib/agent-engine/edge/llm/run-model-call";

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

const PONTE_LIGADA: VariaveisDaPonte = {
  CLAUDE_PONTE_BASE_URL: PONTE,
  CLAUDE_PONTE_API_KEY: CHAVE_DA_PONTE,
  CLAUDE_PONTE_ORGS: ORG_NA_LISTA,
};

function erroDe(montar: () => unknown): unknown {
  try {
    montar();
    return null;
  } catch (erro) {
    return erro;
  }
}

// ─── O módulo: quem a ponte atende e o que ela exige ────────────────────────

describe("ponteDaOrganizacao — quem é atendido", () => {
  it.each([
    ["sem variáveis", undefined],
    ["objeto vazio", {}],
    [
      "lista ausente, com endereço e chave postos",
      { ...PONTE_LIGADA, CLAUDE_PONTE_ORGS: undefined },
    ],
    ["lista vazia, com endereço e chave postos", { ...PONTE_LIGADA, CLAUDE_PONTE_ORGS: "" }],
    ["lista só de espaços e vírgulas", { ...PONTE_LIGADA, CLAUDE_PONTE_ORGS: " , ,  " }],
  ])("%s: ninguém (null), nem avalia o resto", (_nome, variaveis) => {
    expect(ponteDaOrganizacao(variaveis, ORG_NA_LISTA)).toBeNull();
  });

  it("a organização da lista recebe a chave da ponte, a origem e o baseURL com /v1", () => {
    expect(ponteDaOrganizacao(PONTE_LIGADA, ORG_NA_LISTA)).toEqual({
      apiKey: CHAVE_DA_PONTE,
      origem: PONTE,
      baseURL: `${PONTE}/v1`,
    });
  });

  it("a organização FORA da lista não é atendida", () => {
    expect(ponteDaOrganizacao(PONTE_LIGADA, OUTRA_ORG)).toBeNull();
  });

  it("⭐ fora da lista NADA da ponte é avaliado: endereço malformado e chave ausente não derrubam", () => {
    const quebrada: VariaveisDaPonte = {
      CLAUDE_PONTE_BASE_URL: "isto não é url",
      CLAUDE_PONTE_API_KEY: "",
      CLAUDE_PONTE_ORGS: ORG_NA_LISTA,
    };
    expect(ponteDaOrganizacao(quebrada, OUTRA_ORG)).toBeNull();
    // e para quem está na lista a MESMA configuração recusa:
    expect(erroDe(() => ponteDaOrganizacao(quebrada, ORG_NA_LISTA))).toBeInstanceOf(
      ClaudePonteInvalidaError,
    );
  });

  it("a lista aceita vários ids, espaços e maiúsculas (uuid não distingue caixa)", () => {
    const lista = ` ${ORG_NA_LISTA.toUpperCase()} , ${OUTRA_ORG} `;
    const v = { ...PONTE_LIGADA, CLAUDE_PONTE_ORGS: lista };
    expect(ponteDaOrganizacao(v, ORG_NA_LISTA)?.apiKey).toBe(CHAVE_DA_PONTE);
    expect(ponteDaOrganizacao(v, OUTRA_ORG.toUpperCase())?.apiKey).toBe(CHAVE_DA_PONTE);
    expect(ponteDaOrganizacao(v, "33333333-3333-4333-8333-333333333333")).toBeNull();
  });

  it("`*` sozinho vale para todas as organizações (escolha explícita do operador)", () => {
    const v = { ...PONTE_LIGADA, CLAUDE_PONTE_ORGS: " * " };
    expect(ponteDaOrganizacao(v, ORG_NA_LISTA)?.baseURL).toBe(`${PONTE}/v1`);
    expect(ponteDaOrganizacao(v, OUTRA_ORG)?.baseURL).toBe(`${PONTE}/v1`);
  });

  it.each([
    ["`*` misturado com ids", `*,${ORG_NA_LISTA}`],
    ["id que não é uuid", "expandacentral"],
    ["uuid com um caractere a mais", `${ORG_NA_LISTA}0`],
    ["um id bom e um lixo", `${ORG_NA_LISTA},lixo`],
  ])("lista malformada (%s) recusa com lista_invalida em vez de virar ninguém", (_nome, lista) => {
    const erro = erroDe(() =>
      ponteDaOrganizacao({ ...PONTE_LIGADA, CLAUDE_PONTE_ORGS: lista }, ORG_NA_LISTA),
    );
    expect(erro).toBeInstanceOf(ClaudePonteInvalidaError);
    expect((erro as ClaudePonteInvalidaError).motivo).toBe("lista_invalida");
  });
});

describe("ponteDaOrganizacao — o que a ponte exige de quem a usa", () => {
  it.each([
    ["claude-ponte:8080 (sem esquema)", "claude-ponte:8080", "esquema"],
    ["ftp", "ftp://claude-ponte", "esquema"],
    ["file", "file:///etc/passwd", "esquema"],
    ["texto solto", "isto não é url", "nao_e_url"],
    ["ausente", undefined, "nao_e_url"],
    ["só espaços", "   ", "nao_e_url"],
    ["credencial embutida", COM_CREDENCIAL, "credenciais_na_url"],
    ["com consulta", `${PONTE}/v1?parametro=1`, "consulta_ou_fragmento"],
    ["com fragmento", `${PONTE}/v1#x`, "consulta_ou_fragmento"],
    ["caminho /v2", `${PONTE}/v2`, "caminho"],
    ["caminho /outro/v1", `${PONTE}/outro/v1`, "caminho"],
  ])("endereço inválido (%s) recusa com o motivo certo", (_nome, bruto, motivo) => {
    const erro = erroDe(() =>
      ponteDaOrganizacao({ ...PONTE_LIGADA, CLAUDE_PONTE_BASE_URL: bruto }, ORG_NA_LISTA),
    );
    expect(erro).toBeInstanceOf(ClaudePonteInvalidaError);
    expect((erro as ClaudePonteInvalidaError).motivo).toBe(motivo);
    // O valor NÃO é repetido: URL com credencial embutida não vai parar em log.
    expect((erro as Error).message).not.toContain("valor-sintetico");
    expect((erro as Error).message).not.toContain("parametro=1");
  });

  it.each([
    ["ausente", undefined],
    ["vazia", ""],
    ["só espaços", "   "],
    ["com espaço no meio", "duas palavras"],
  ])(
    "chave da ponte %s recusa com chave_ausente (e não cai na chave da instalação)",
    (_nome, chave) => {
      const erro = erroDe(() =>
        ponteDaOrganizacao({ ...PONTE_LIGADA, CLAUDE_PONTE_API_KEY: chave }, ORG_NA_LISTA),
      );
      expect(erro).toBeInstanceOf(ClaudePonteInvalidaError);
      expect((erro as ClaudePonteInvalidaError).motivo).toBe("chave_ausente");
      expect((erro as Error).message).not.toContain("duas palavras");
    },
  );

  it("a chave é aparada nas pontas e a mensagem de erro nunca traz a chave", () => {
    const v = { ...PONTE_LIGADA, CLAUDE_PONTE_API_KEY: `  ${CHAVE_DA_PONTE}  ` };
    expect(ponteDaOrganizacao(v, ORG_NA_LISTA)?.apiKey).toBe(CHAVE_DA_PONTE);
    const erro = erroDe(() =>
      ponteDaOrganizacao({ ...v, CLAUDE_PONTE_BASE_URL: "x://" }, ORG_NA_LISTA),
    );
    expect((erro as Error).message).not.toContain(CHAVE_DA_PONTE);
  });
});

describe("lerEnderecoDaPonte", () => {
  it.each([
    [PONTE],
    [`${PONTE}/`],
    [`${PONTE}/v1`],
    [`${PONTE}/v1/`],
    [`  ${PONTE}  `],
    ["HTTP://Claude-Ponte:8080"],
  ])("aceita %j e devolve a raiz + /v1", (bruto) => {
    expect(lerEnderecoDaPonte(bruto)).toEqual({ origem: PONTE, baseURL: `${PONTE}/v1` });
  });

  it("https com a porta padrão perde a porta", () => {
    expect(lerEnderecoDaPonte("https://ponte.exemplo.com:443/v1").origem).toBe(
      "https://ponte.exemplo.com",
    );
  });
});

describe("fetchContidoDaPonte e opcoesDaPonte — a chamada só fala com a origem e não segue redirect", () => {
  it("destino de outra origem lança sem chamar o fetch", async () => {
    const interno = vi.fn();
    const f = fetchContidoDaPonte(PONTE, interno as unknown as typeof fetch);
    await expect(f("https://api.anthropic.com/v1/messages")).rejects.toThrow(
      "claude_ponte_destino_fora_da_origem",
    );
    await expect(f("não é url")).rejects.toThrow("claude_ponte_destino_invalido");
    expect(interno).not.toHaveBeenCalled();
  });

  it("3xx vira recusa, e o fetch interno é chamado com redirect manual", async () => {
    const interno = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://x.example" } }),
    );
    const f = fetchContidoDaPonte(PONTE, interno as unknown as typeof fetch);
    await expect(f(`${PONTE}/v1/messages`)).rejects.toThrow("claude_ponte_redirect_bloqueado");
    expect(interno).toHaveBeenCalledTimes(1);
    expect((interno.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: "manual" });
  });

  it("resposta comum passa intacta", async () => {
    const interno = vi.fn(async () => new Response("ok", { status: 200 }));
    const f = fetchContidoDaPonte(PONTE, interno as unknown as typeof fetch);
    expect((await f(new URL(`${PONTE}/v1/models`))).status).toBe(200);
  });

  it("opcoesDaPonte REVALIDA o endereço que recebe (a fábrica não confia em quem chama)", () => {
    for (const ruim of [undefined, COM_CREDENCIAL, `${PONTE}/v2`, "ftp://claude-ponte"]) {
      expect(erroDe(() => opcoesDaPonte(CHAVE_DA_PONTE, ruim))).toBeInstanceOf(
        ClaudePonteInvalidaError,
      );
    }
    const o = opcoesDaPonte(CHAVE_DA_PONTE, `${PONTE}/v1`);
    expect(o.baseURL).toBe(`${PONTE}/v1`);
    expect(o.apiKey).toBe(CHAVE_DA_PONTE);
  });

  it("aceita a contenção do chamador (a allowlist do motor) no lugar da padrão", () => {
    const contido = vi.fn(
      (_origem: string) => (async () => new Response("{}")) as unknown as typeof fetch,
    );
    opcoesDaPonte(CHAVE_DA_PONTE, PONTE, contido);
    expect(contido).toHaveBeenCalledWith(PONTE);
  });
});

// ─── A configuração que sai do .env ─────────────────────────────────────────

describe("llmEdgeConfigFromEnv — a ponte só existe quando a lista existe", () => {
  it("sem as variáveis, nenhum campo `ponte` (o produto é o de hoje)", () => {
    const cfg = llmEdgeConfigFromEnv({ ANTHROPIC_API_KEY: CHAVE_DA_INSTALACAO });
    expect("ponte" in cfg).toBe(false);
    expect(cfg.anthropicApiKey).toBe(CHAVE_DA_INSTALACAO);
  });

  it("endereço e chave sem lista = ninguém: também não há campo `ponte`", () => {
    const cfg = llmEdgeConfigFromEnv({
      CLAUDE_PONTE_BASE_URL: PONTE,
      CLAUDE_PONTE_API_KEY: CHAVE_DA_PONTE,
      CLAUDE_PONTE_ORGS: "",
    });
    expect("ponte" in cfg).toBe(false);
  });

  it("com a lista, as três variáveis seguem CRUAS para o resolvedor validar", () => {
    const cfg = llmEdgeConfigFromEnv({ ...PONTE_LIGADA });
    expect(cfg.ponte).toEqual(PONTE_LIGADA);
  });

  it("a chave da ponte NÃO vira `anthropicApiKey`", () => {
    const cfg = llmEdgeConfigFromEnv({ ...PONTE_LIGADA });
    expect(cfg.anthropicApiKey).toBeUndefined();
  });
});

// ─── A escada de credenciais ────────────────────────────────────────────────

/** Pool falso: 1ª query devolve settings->'llm', 2ª devolve as credenciais BYOK da organização. */
function poolFake(settingsLlm: unknown, credenciais: unknown[]) {
  let n = 0;
  return {
    query: async () => {
      n += 1;
      return n === 1 ? { rows: [{ llm: settingsLlm }] } : { rows: credenciais };
    },
  } as never;
}

const SETTINGS_ANTHROPIC = { provider: "anthropic", default_model: "claude-haiku-4-5" };
const SEM_BYOK: unknown[] = [];
const COM_BYOK = [{ id: "cred-1", api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" }];

describe("resolveOrgLlmConfig — o degrau da ponte", () => {
  const cfgComPonte: LlmEdgeConfig = { anthropicApiKey: CHAVE_DA_INSTALACAO, ponte: PONTE_LIGADA };

  it("⭐ org da lista, sem credencial própria: chave e endereço da PONTE; a chave da instalação não participa", async () => {
    const out = await resolveOrgLlmConfig(
      poolFake(SETTINGS_ANTHROPIC, SEM_BYOK),
      cfgComPonte,
      ORG_NA_LISTA,
    );
    expect(out.provider).toBe("anthropic");
    expect(out.apiKey).toBe(CHAVE_DA_PONTE);
    expect(out.origemDaChave).toBe("chave_da_instalacao");
    expect(out.ponte).toEqual({ baseURL: `${PONTE}/v1`, origem: PONTE });
  });

  it("⭐ E10: org da lista COM credencial própria validada: a chave dela vence e não há ponte", async () => {
    const out = await resolveOrgLlmConfig(
      poolFake(SETTINGS_ANTHROPIC, COM_BYOK),
      cfgComPonte,
      ORG_NA_LISTA,
    );
    expect(out.apiKey).toBe(CHAVE_DA_ORG);
    expect(out.origemDaChave).toBe("credencial_da_organizacao");
    expect("ponte" in out).toBe(false);
  });

  it("org fora da lista, com chave da instalação: o comportamento de sempre, sem ponte", async () => {
    const out = await resolveOrgLlmConfig(
      poolFake(SETTINGS_ANTHROPIC, SEM_BYOK),
      cfgComPonte,
      OUTRA_ORG,
    );
    expect(out.apiKey).toBe(CHAVE_DA_INSTALACAO);
    expect(out.origemDaChave).toBe("chave_da_instalacao");
    expect("ponte" in out).toBe(false);
  });

  it("⭐ org fora da lista, sem chave da instalação: LlmNotConfiguredError (a ponte não vaza para quem não está na lista)", async () => {
    await expect(
      resolveOrgLlmConfig(
        poolFake(SETTINGS_ANTHROPIC, SEM_BYOK),
        { ponte: PONTE_LIGADA },
        OUTRA_ORG,
      ),
    ).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });

  it("sem `cfg.ponte`: a escada é a de antes (chave da instalação)", async () => {
    const out = await resolveOrgLlmConfig(
      poolFake(SETTINGS_ANTHROPIC, SEM_BYOK),
      { anthropicApiKey: CHAVE_DA_INSTALACAO },
      ORG_NA_LISTA,
    );
    expect(out.apiKey).toBe(CHAVE_DA_INSTALACAO);
    expect("ponte" in out).toBe(false);
  });

  it("⭐ variáveis inválidas para org da lista: lança, e NÃO cai na chave da instalação", async () => {
    const ruim: LlmEdgeConfig = {
      anthropicApiKey: CHAVE_DA_INSTALACAO,
      ponte: { ...PONTE_LIGADA, CLAUDE_PONTE_BASE_URL: COM_CREDENCIAL },
    };
    const erro = await resolveOrgLlmConfig(
      poolFake(SETTINGS_ANTHROPIC, SEM_BYOK),
      ruim,
      ORG_NA_LISTA,
    ).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ClaudePonteInvalidaError);
    expect((erro as Error).message).not.toContain(CHAVE_DA_INSTALACAO);
    expect((erro as Error).message).not.toContain("valor-sintetico");
  });

  it("variáveis inválidas, mas credencial própria presente: a org segue funcionando (a ponte nem é avaliada)", async () => {
    const ruim: LlmEdgeConfig = {
      anthropicApiKey: CHAVE_DA_INSTALACAO,
      ponte: { ...PONTE_LIGADA, CLAUDE_PONTE_BASE_URL: "lixo" },
    };
    const out = await resolveOrgLlmConfig(
      poolFake(SETTINGS_ANTHROPIC, COM_BYOK),
      ruim,
      ORG_NA_LISTA,
    );
    expect(out.apiKey).toBe(CHAVE_DA_ORG);
  });

  it("`*`: a org sem credencial vai pela ponte e a com credencial própria continua nela", async () => {
    const todas: LlmEdgeConfig = { ponte: { ...PONTE_LIGADA, CLAUDE_PONTE_ORGS: "*" } };
    const semCredencial = await resolveOrgLlmConfig(
      poolFake(SETTINGS_ANTHROPIC, SEM_BYOK),
      todas,
      OUTRA_ORG,
    );
    expect(semCredencial.apiKey).toBe(CHAVE_DA_PONTE);
    const comCredencial = await resolveOrgLlmConfig(
      poolFake(SETTINGS_ANTHROPIC, COM_BYOK),
      todas,
      OUTRA_ORG,
    );
    expect(comCredencial.apiKey).toBe(CHAVE_DA_ORG);
    expect("ponte" in comCredencial).toBe(false);
  });

  it("provedor que não é a Anthropic não é tocado pela ponte (openai segue com a própria chave)", async () => {
    const out = await resolveOrgLlmConfig(
      poolFake({ provider: "openai", default_model: "gpt-5.6-luna" }, SEM_BYOK),
      { openaiApiKey: "chave-openai-sintetica", ponte: PONTE_LIGADA },
      ORG_NA_LISTA,
    );
    expect(out.provider).toBe("openai");
    expect(out.apiKey).toBe("chave-openai-sintetica");
    expect("ponte" in out).toBe(false);
  });
});

// ─── O seam inteiro: qual fábrica fala, com qual chave e qual endereço ──────

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

/** Pool que responde às consultas do seam; `credenciais` é o que a organização tem cadastrado. */
function poolDoTurno(credenciais: unknown[], settings: unknown = SETTINGS_ANTHROPIC) {
  const inserts: Array<{ params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) return { rows: [{ llm: settings }] };
    if (sql.includes("from ai_purpose_bindings")) return { rows: [] };
    if (sql.includes("from ai_provider_credentials")) return { rows: credenciais };
    if (sql.includes("insert into llm_calls")) {
      inserts.push({ params });
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, inserts };
}

interface ChamadaDeFabrica {
  fabrica: string | symbol;
  apiKey: string;
  modelId: string;
  baseUrl: string | undefined;
}

/** Registry espião: devolve um modelo dublê e anota quem foi chamado e com o quê. */
function registryEspiao() {
  const chamadas: ChamadaDeFabrica[] = [];
  const fabrica =
    (nome: string | symbol) =>
    (apiKey: string, modelId: string, baseUrl?: string): LanguageModel => {
      chamadas.push({ fabrica: nome, apiKey, modelId, baseUrl });
      return new MockLanguageModelV3({
        modelId,
        doGenerate: {
          content: [{ type: "text", text: "oi" }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: {
            inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        },
      });
    };
  const registry = {
    anthropic: fabrica("anthropic"),
    [FABRICA_DA_PONTE]: fabrica(FABRICA_DA_PONTE),
  } as unknown as ProviderRegistry;
  return { chamadas, registry };
}

async function turno(
  cfg: LlmEdgeConfig,
  org: string,
  credenciais: unknown[],
  registry: ProviderRegistry,
) {
  const { pool, inserts } = poolDoTurno(credenciais);
  const resultado = await runModelCall(
    pool,
    { cacheTtl: "1h", ...cfg },
    { tenantId: org, purpose: "agent_preview", messages: [{ role: "user", content: "oi" }] },
    { registry },
  );
  return { resultado, inserts };
}

describe("runModelCall — a fábrica da ponte só fala por quem a ponte atende", () => {
  const cfg: LlmEdgeConfig = { anthropicApiKey: CHAVE_DA_INSTALACAO, ponte: PONTE_LIGADA };

  it("⭐ org da lista sem credencial própria: fábrica DA PONTE, com a chave da ponte e o endereço validado", async () => {
    const { chamadas, registry } = registryEspiao();
    const { resultado, inserts } = await turno(cfg, ORG_NA_LISTA, SEM_BYOK, registry);
    expect(chamadas).toEqual([
      {
        fabrica: FABRICA_DA_PONTE,
        apiKey: CHAVE_DA_PONTE,
        modelId: "claude-haiku-4-5",
        baseUrl: `${PONTE}/v1`,
      },
    ]);
    // O provedor registrado em `llm_calls` continua sendo o da Anthropic (a ponte é só o destino).
    expect(resultado.provider).toBe("anthropic");
    expect(inserts).toHaveLength(1);
  });

  it("⭐ E10 no seam: org da lista COM credencial própria: fábrica `anthropic`, chave dela, SEM endereço — a ponte nem é chamada", async () => {
    const { chamadas, registry } = registryEspiao();
    await turno(cfg, ORG_NA_LISTA, COM_BYOK, registry);
    expect(chamadas).toEqual([
      {
        fabrica: "anthropic",
        apiKey: CHAVE_DA_ORG,
        modelId: "claude-haiku-4-5",
        baseUrl: undefined,
      },
    ]);
  });

  it("org fora da lista: fábrica `anthropic` com a chave da instalação, sem endereço", async () => {
    const { chamadas, registry } = registryEspiao();
    await turno(cfg, OUTRA_ORG, SEM_BYOK, registry);
    expect(chamadas).toEqual([
      {
        fabrica: "anthropic",
        apiKey: CHAVE_DA_INSTALACAO,
        modelId: "claude-haiku-4-5",
        baseUrl: undefined,
      },
    ]);
  });

  it("sem as variáveis: exatamente o de hoje (chave da instalação, fábrica `anthropic`)", async () => {
    const { chamadas, registry } = registryEspiao();
    await turno({ anthropicApiKey: CHAVE_DA_INSTALACAO }, ORG_NA_LISTA, SEM_BYOK, registry);
    expect(chamadas.map((c) => [c.fabrica, c.apiKey, c.baseUrl])).toEqual([
      ["anthropic", CHAVE_DA_INSTALACAO, undefined],
    ]);
  });

  it("⭐ variáveis inválidas para a org da lista: a chamada é recusada ANTES de qualquer fábrica, com a classe própria", async () => {
    const { chamadas, registry } = registryEspiao();
    const ruim: LlmEdgeConfig = {
      anthropicApiKey: CHAVE_DA_INSTALACAO,
      ponte: { ...PONTE_LIGADA, CLAUDE_PONTE_BASE_URL: `${PONTE}/v2` },
    };
    const erro = await turno(ruim, ORG_NA_LISTA, SEM_BYOK, registry).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ClaudePonteInvalidaError);
    expect(chamadas).toHaveLength(0);
  });

  it("o registry de teste (`createFakeRegistry`) também conhece a fábrica da ponte", () => {
    expect(createFakeRegistry()[FABRICA_DA_PONTE]).toBeTypeOf("function");
  });
});

describe("a fábrica da ponte não é um provedor (chave `symbol`)", () => {
  it("⭐ nenhuma chave de TEXTO do registry é a ponte: a lista da tela e o registry seguem a mesma lista", () => {
    for (const registry of [createDefaultRegistry(), createFakeRegistry()]) {
      expect(Object.keys(registry).some((id) => id.includes("ponte"))).toBe(false);
      expect(Object.getOwnPropertySymbols(registry)).toContain(FABRICA_DA_PONTE);
    }
  });

  it("⭐ um provedor com o nome da ponte, gravado no banco, não alcança a fábrica", async () => {
    // `provider` é texto livre no banco; quem administra uma organização poderia escrever qualquer nome.
    const { chamadas, registry } = registryEspiao();
    const { pool } = poolDoTurno(COM_BYOK, {
      provider: "anthropic-ponte",
      default_model: "claude-haiku-4-5",
    });
    const erro = await runModelCall(
      pool,
      { anthropicApiKey: CHAVE_DA_INSTALACAO, ponte: PONTE_LIGADA, cacheTtl: "1h" },
      {
        tenantId: ORG_NA_LISTA,
        purpose: "agent_preview",
        messages: [{ role: "user", content: "oi" }],
      },
      { registry },
    ).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmProviderUnknownError);
    expect(chamadas).toHaveLength(0);
  });
});

describe("normalizarErro — o erro da configuração da ponte tem código próprio", () => {
  it("claude_ponte_invalida, sem status HTTP e sem repetir o valor", () => {
    const n = normalizarErro(erroDe(() => lerEnderecoDaPonte(COM_CREDENCIAL)));
    expect(n.error_code).toBe("claude_ponte_invalida");
    expect(n.http_status).toBeNull();
    expect(n.error_message).not.toContain("valor-sintetico");
  });
});

// ─── O SDK REAL: o que de fato sai pela rede (interceptada) ─────────────────

interface Chamada {
  url: string;
  host: string;
  chave: string | null;
  redirect: RequestRedirect | undefined;
}

describe("com o SDK real e o fetch interceptado", () => {
  let fetchOriginal: typeof globalThis.fetch;
  let chamadas: Chamada[];
  let responder: () => Response;

  beforeEach(() => {
    chamadas = [];
    responder = () =>
      new Response(JSON.stringify(MENSAGEM_OK), {
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
      });
      return responder();
    }) as typeof globalThis.fetch;
    vi.stubEnv("ANTHROPIC_BASE_URL", undefined);
  });

  afterEach(() => {
    globalThis.fetch = fetchOriginal;
    vi.unstubAllEnvs();
  });

  const hosts = () => [...new Set(chamadas.map((c) => c.host))];

  it("⭐ a fábrica da ponte chama `<ponte>/v1/messages` com a chave da ponte, sem redirect, e só essa origem", async () => {
    const modelo = createDefaultRegistry()[FABRICA_DA_PONTE]!(
      CHAVE_DA_PONTE,
      "claude-haiku-4-5",
      `${PONTE}/v1`,
    );
    await generateText({ model: modelo, prompt: "oi", maxRetries: 0 });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toMatchObject({
      url: `${PONTE}/v1/messages`,
      chave: CHAVE_DA_PONTE,
      redirect: "manual",
    });
    expect(hosts()).toEqual(["claude-ponte:8080"]);
  });

  it("a fábrica da ponte sem endereço (ou com endereço ruim) lança antes de qualquer byte", () => {
    const fabrica = createDefaultRegistry()[FABRICA_DA_PONTE]!;
    expect(erroDe(() => fabrica(CHAVE_DA_PONTE, "claude-haiku-4-5"))).toBeInstanceOf(
      ClaudePonteInvalidaError,
    );
    expect(
      erroDe(() => fabrica(CHAVE_DA_PONTE, "claude-haiku-4-5", COM_CREDENCIAL)),
    ).toBeInstanceOf(ClaudePonteInvalidaError);
    expect(chamadas).toHaveLength(0);
  });

  it("⭐ a fábrica `anthropic` vai SEMPRE a api.anthropic.com, mesmo com `CLAUDE_PONTE_*` e `ANTHROPIC_BASE_URL` no ambiente", async () => {
    vi.stubEnv("CLAUDE_PONTE_BASE_URL", PONTE);
    vi.stubEnv("CLAUDE_PONTE_API_KEY", CHAVE_DA_PONTE);
    vi.stubEnv("CLAUDE_PONTE_ORGS", ORG_NA_LISTA);
    vi.stubEnv("ANTHROPIC_BASE_URL", PONTE);
    // O terceiro argumento (um endereço) também é ignorado: a fábrica não tem para onde apontá-lo.
    const modelo = createDefaultRegistry().anthropic!(
      CHAVE_DA_ORG,
      "claude-haiku-4-5",
      `${PONTE}/v1`,
    );
    await generateText({ model: modelo, prompt: "oi", maxRetries: 0 });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toMatchObject({
      url: "https://api.anthropic.com/v1/messages",
      chave: CHAVE_DA_ORG,
    });
    expect(hosts()).toEqual(["api.anthropic.com"]);
  });

  it("a fábrica `anthropic` tolera `ANTHROPIC_BASE_URL` vazia (o que o template do .env gera)", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "");
    const modelo = createDefaultRegistry().anthropic!(CHAVE_DA_ORG, "claude-haiku-4-5");
    await generateText({ model: modelo, prompt: "oi", maxRetries: 0 });
    expect(hosts()).toEqual(["api.anthropic.com"]);
  });

  it("⭐ o seam inteiro, org SEM credencial própria: só a ponte é tocada, com a chave da ponte (E2)", async () => {
    const { pool, inserts } = poolDoTurno(SEM_BYOK);
    const resultado = await runModelCall(
      pool,
      { anthropicApiKey: CHAVE_DA_INSTALACAO, ponte: PONTE_LIGADA, cacheTtl: "1h" },
      {
        tenantId: ORG_NA_LISTA,
        purpose: "agent_preview",
        messages: [{ role: "user", content: "oi" }],
      },
      { registry: createDefaultRegistry() },
    );
    expect(hosts()).toEqual(["claude-ponte:8080"]);
    expect(chamadas.every((c) => c.chave === CHAVE_DA_PONTE)).toBe(true);
    expect(chamadas.map((c) => c.url)).toEqual([`${PONTE}/v1/messages`]);
    expect(resultado.provider).toBe("anthropic");
    expect(inserts).toHaveLength(1);
  });

  it("⭐ E10 de ponta a ponta: org COM credencial própria na lista: só a api.anthropic.com é tocada, com a chave dela", async () => {
    const { pool } = poolDoTurno(COM_BYOK);
    await runModelCall(
      pool,
      { anthropicApiKey: CHAVE_DA_INSTALACAO, ponte: PONTE_LIGADA, cacheTtl: "1h" },
      {
        tenantId: ORG_NA_LISTA,
        purpose: "agent_preview",
        messages: [{ role: "user", content: "oi" }],
      },
      { registry: createDefaultRegistry() },
    );
    expect(hosts()).toEqual(["api.anthropic.com"]);
    expect(chamadas.every((c) => c.chave === CHAVE_DA_ORG)).toBe(true);
    // E a ponte não viu chamada nenhuma:
    expect(chamadas.some((c) => c.host === "claude-ponte:8080")).toBe(false);
  });

  it("org fora da lista com a chave da instalação: api.anthropic.com, chave da instalação, a ponte intocada", async () => {
    const { pool } = poolDoTurno(SEM_BYOK);
    await runModelCall(
      pool,
      { anthropicApiKey: CHAVE_DA_INSTALACAO, ponte: PONTE_LIGADA, cacheTtl: "1h" },
      {
        tenantId: OUTRA_ORG,
        purpose: "agent_preview",
        messages: [{ role: "user", content: "oi" }],
      },
      { registry: createDefaultRegistry() },
    );
    expect(hosts()).toEqual(["api.anthropic.com"]);
    expect(chamadas.every((c) => c.chave === CHAVE_DA_INSTALACAO)).toBe(true);
  });

  it("⭐ 3xx da ponte não é seguido: nenhum segundo pedido sai, e a chave não viaja para o Location", async () => {
    responder = () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://api.anthropic.com/v1/messages" },
      });
    const { pool } = poolDoTurno(SEM_BYOK);
    const erro = await runModelCall(
      pool,
      { ponte: PONTE_LIGADA, cacheTtl: "1h" },
      {
        tenantId: ORG_NA_LISTA,
        purpose: "agent_preview",
        messages: [{ role: "user", content: "oi" }],
      },
      { registry: createDefaultRegistry() },
    ).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(Error);
    expect(hosts()).toEqual(["claude-ponte:8080"]);
    expect(chamadas.length).toBeGreaterThan(0);
    expect(chamadas.some((c) => c.host === "api.anthropic.com")).toBe(false);
  });
});
