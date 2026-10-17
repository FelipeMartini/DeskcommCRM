/**
 * O OMNIROUTER DA INSTALAÇÃO — o ÚNICO caminho de IA de texto além das chaves, configurável pelo painel.
 *
 * Ordem do dono (16/10/2026): "o claude ponte direto não vamos mais ter, pode remover tudo disso, vai
 * ficar só o omnirouter configurável" e "vamos fazer a opção MISTO". Este arquivo é o sucessor dos testes
 * da claude-ponte e prova, do contrato do modelo misto:
 *
 *   1. SEM endereço e chave, o produto é o de hoje (regressão zero): nada é lido, a chave da instalação
 *      segue valendo;
 *   2. quem o OmniRouter atende é ESCOLHA da organização (`settings.omnirouter.habilitado`) ou, sem
 *      escolha, a OFERTA GERAL da instalação (`OMNIROUTER_PARA_TODAS`); o `false` da organização vence a
 *      oferta geral, e o `true` vale mesmo sem ela;
 *   3. a credencial PRÓPRIA da organização (ativa e validada) SEMPRE vence e vai ao provedor dela com a
 *      chave dela — o OmniRouter nem vê a chamada (E10);
 *   4. o endereço e a chave vêm do BANCO (o que o admin gravou em Credenciais), com o `.env` como piso —
 *      e apagar os dois pela tela desliga o OmniRouter para todos;
 *   5. a chave do OmniRouter nunca chega a outro provedor e a chave de um provedor nunca chega a ele:
 *      são DUAS fábricas, e nenhuma aceita as duas;
 *   6. variável malformada para quem a usaria recusa antes de qualquer byte, sem o valor na mensagem, e
 *      nunca cai na chave da instalação; para quem NÃO a usaria, nem é avaliada;
 *   7. a chamada não segue redirect e só fala com a origem validada.
 *
 * Técnica: pool fingido (responde por SQL) + registry espião e, no fim, o SDK REAL com
 * `globalThis.fetch` interceptado. Nenhuma rede, nenhuma chave real: valores sintéticos.
 */
import { MockLanguageModelV3 } from "ai/test";
import { APICallError, generateText, RetryError, type LanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: () => Buffer.from(""),
  decryptKey: () => "chave-propria-da-org-sintetica",
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));

import {
  FABRICA_DO_OMNIROUTER,
  OmniRouterInvalidoError,
  escolhaDoOmniRouterNasConfiguracoes,
  fetchContidoDoOmniRouter,
  lerEnderecoDoOmniRouter,
  omniRouterAtendeAOrganizacao,
  omniRouterDaOrganizacao,
  omniRouterEscolhido,
  opcoesDoOmniRouter,
  variaveisDoOmniRouter,
  type VariaveisDoOmniRouter,
} from "@/lib/ai/omnirouter";
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

const OMNI = "http://omnirouter:20128";
const CHAVE_DO_OMNI = "chave-do-omnirouter-sintetica";
const CHAVE_DA_INSTALACAO = "chave-anthropic-da-instalacao-sintetica";
const CHAVE_DA_ORG = "chave-propria-da-org-sintetica";
const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "22222222-2222-4222-8222-222222222222";
/** Montado em partes: é valor de teste, não segredo. */
const COM_CREDENCIAL = ["http://", "usuario", ":", "valor-sintetico", "@omnirouter:20128"].join("");

/** Endereço e chave postos, SEM oferta geral: só atende quem foi escolhido. */
const OMNI_POSTO: VariaveisDoOmniRouter = {
  OMNIROUTER_BASE_URL: OMNI,
  OMNIROUTER_API_KEY: CHAVE_DO_OMNI,
};
/** Com a oferta geral ligada: atende quem não foi escolhido nem recusado. */
const OMNI_PARA_TODAS: VariaveisDoOmniRouter = { ...OMNI_POSTO, OMNIROUTER_PARA_TODAS: "true" };

function erroDe(montar: () => unknown): unknown {
  try {
    montar();
    return null;
  } catch (erro) {
    return erro;
  }
}

// ─── O módulo: quem o OmniRouter atende e o que ele exige ───────────────────

describe("escolhaDoOmniRouterNasConfiguracoes — só o booleano vale", () => {
  it.each([
    ["true", { habilitado: true }, true],
    ["false", { habilitado: false }, false],
    ["ausente", {}, undefined],
    ["null", null, undefined],
    ["undefined", undefined, undefined],
    ["texto 'true'", { habilitado: "true" }, undefined],
    ["número 1", { habilitado: 1 }, undefined],
    ["lista", [true], undefined],
    ["texto solto", "true", undefined],
  ])("%s", (_nome, entrada, esperado) => {
    expect(escolhaDoOmniRouterNasConfiguracoes(entrada)).toBe(esperado);
  });
});

describe("omniRouterEscolhido — a escolha da organização vence a oferta geral nos dois sentidos", () => {
  it("sem escolha, decide a oferta geral", () => {
    expect(omniRouterEscolhido(undefined, OMNI_PARA_TODAS)).toBe(true);
    expect(omniRouterEscolhido(undefined, OMNI_POSTO)).toBe(false);
    expect(omniRouterEscolhido(undefined, undefined)).toBe(false);
  });

  it("⭐ `false` recusa mesmo com a oferta geral; `true` atende mesmo sem ela", () => {
    expect(omniRouterEscolhido(false, OMNI_PARA_TODAS)).toBe(false);
    expect(omniRouterEscolhido(true, OMNI_POSTO)).toBe(true);
    expect(omniRouterEscolhido(true, undefined)).toBe(true);
  });

  it.each([
    ["true", true],
    ["TRUE", true],
    ["  true  ", true],
    ["1", false],
    ["sim", false],
    ["yes", false],
    ["", false],
    [undefined, false],
  ])("a oferta geral %j vale %s (só a palavra `true`, em qualquer caixa)", (bruto, vale) => {
    expect(omniRouterEscolhido(undefined, { OMNIROUTER_PARA_TODAS: bruto })).toBe(vale);
  });
});

describe("omniRouterDaOrganizacao — quem é atendido", () => {
  it.each([
    ["sem variáveis", undefined, true],
    ["objeto vazio", {}, true],
    ["só espaços", { OMNIROUTER_BASE_URL: "  ", OMNIROUTER_API_KEY: " " }, true],
  ])("%s: o OmniRouter não existe (null) nem para a organização escolhida", (_n, v, escolha) => {
    expect(omniRouterDaOrganizacao(v, escolha)).toBeNull();
  });

  it("organização NÃO escolhida e sem oferta geral: null, com endereço e chave postos", () => {
    expect(omniRouterDaOrganizacao(OMNI_POSTO, undefined)).toBeNull();
  });

  it("a organização escolhida recebe a chave do OmniRouter, a origem e o baseURL com /v1", () => {
    expect(omniRouterDaOrganizacao(OMNI_POSTO, true)).toEqual({
      apiKey: CHAVE_DO_OMNI,
      origem: OMNI,
      baseURL: `${OMNI}/v1`,
    });
  });

  it("a oferta geral atende quem não escolheu; o `false` dela recusa", () => {
    expect(omniRouterDaOrganizacao(OMNI_PARA_TODAS, undefined)?.apiKey).toBe(CHAVE_DO_OMNI);
    expect(omniRouterDaOrganizacao(OMNI_PARA_TODAS, false)).toBeNull();
  });

  it("⭐ organização NÃO atendida: nada do OmniRouter é avaliado (endereço torto e chave ausente não derrubam)", () => {
    const quebrada: VariaveisDoOmniRouter = {
      OMNIROUTER_BASE_URL: "isto não é url",
      OMNIROUTER_API_KEY: "",
      OMNIROUTER_PARA_TODAS: "true",
    };
    expect(omniRouterDaOrganizacao(quebrada, false)).toBeNull();
    // e para quem SERIA atendida a MESMA configuração recusa:
    expect(erroDe(() => omniRouterDaOrganizacao(quebrada, true))).toBeInstanceOf(
      OmniRouterInvalidoError,
    );
    expect(erroDe(() => omniRouterDaOrganizacao(quebrada, undefined))).toBeInstanceOf(
      OmniRouterInvalidoError,
    );
  });
});

describe("omniRouterDaOrganizacao — o que o OmniRouter exige de quem o usa", () => {
  it.each([
    ["omnirouter:20128 (sem esquema)", "omnirouter:20128", "esquema"],
    ["ftp", "ftp://omnirouter", "esquema"],
    ["file", "file:///etc/passwd", "esquema"],
    ["texto solto", "isto não é url", "nao_e_url"],
    ["só a chave posta (sem endereço)", undefined, "nao_e_url"],
    ["só espaços", "   ", "nao_e_url"],
    ["credencial embutida", COM_CREDENCIAL, "credenciais_na_url"],
    ["com consulta", `${OMNI}/v1?parametro=1`, "consulta_ou_fragmento"],
    ["com fragmento", `${OMNI}/v1#x`, "consulta_ou_fragmento"],
  ])("endereço inválido (%s) recusa com o motivo certo", (_nome, bruto, motivo) => {
    const erro = erroDe(() =>
      omniRouterDaOrganizacao({ ...OMNI_POSTO, OMNIROUTER_BASE_URL: bruto }, true),
    );
    expect(erro).toBeInstanceOf(OmniRouterInvalidoError);
    expect((erro as OmniRouterInvalidoError).motivo).toBe(motivo);
    // O valor NÃO é repetido: URL com credencial embutida não vai parar em log.
    expect((erro as Error).message).not.toContain("valor-sintetico");
    expect((erro as Error).message).not.toContain("parametro=1");
  });

  it.each([
    ["ausente", undefined],
    ["vazia", ""],
    ["só espaços", "   "],
    ["com espaço no meio", "duas palavras"],
  ])("chave %s (com o endereço posto) recusa com chave_ausente — e não cai na chave da instalação", (_nome, chave) => {
    const erro = erroDe(() =>
      omniRouterDaOrganizacao({ ...OMNI_POSTO, OMNIROUTER_API_KEY: chave }, true),
    );
    expect(erro).toBeInstanceOf(OmniRouterInvalidoError);
    expect((erro as OmniRouterInvalidoError).motivo).toBe("chave_ausente");
    expect((erro as Error).message).not.toContain("duas palavras");
  });

  it("a chave é aparada nas pontas e a mensagem de erro nunca traz a chave", () => {
    const v = { ...OMNI_POSTO, OMNIROUTER_API_KEY: `  ${CHAVE_DO_OMNI}  ` };
    expect(omniRouterDaOrganizacao(v, true)?.apiKey).toBe(CHAVE_DO_OMNI);
    const erro = erroDe(() =>
      omniRouterDaOrganizacao({ ...v, OMNIROUTER_BASE_URL: "x://" }, true),
    );
    expect((erro as Error).message).not.toContain(CHAVE_DO_OMNI);
  });
});

describe("lerEnderecoDoOmniRouter", () => {
  it.each([[OMNI], [`${OMNI}/`], [`${OMNI}/v1`], [`${OMNI}/v1/`], [`  ${OMNI}  `], ["HTTP://Omnirouter:20128"]])(
    "aceita %j e devolve a raiz + /v1",
    (bruto) => {
      expect(lerEnderecoDoOmniRouter(bruto)).toEqual({ origem: OMNI, baseURL: `${OMNI}/v1` });
    },
  );

  it("um caminho completo informado é respeitado (o OmniRouter pode viver fora da raiz)", () => {
    expect(lerEnderecoDoOmniRouter(`${OMNI}/api/v1`)).toEqual({
      origem: OMNI,
      baseURL: `${OMNI}/api/v1`,
    });
  });

  it("https com a porta padrão perde a porta", () => {
    expect(lerEnderecoDoOmniRouter("https://omni.exemplo.com:443/v1").origem).toBe(
      "https://omni.exemplo.com",
    );
  });
});

describe("omniRouterAtendeAOrganizacao — a pergunta de existência nunca lança", () => {
  it("responde sim/não conforme a escolha e a oferta geral", () => {
    expect(omniRouterAtendeAOrganizacao(OMNI_POSTO, true)).toBe(true);
    expect(omniRouterAtendeAOrganizacao(OMNI_POSTO, undefined)).toBe(false);
    expect(omniRouterAtendeAOrganizacao(OMNI_PARA_TODAS, undefined)).toBe(true);
    expect(omniRouterAtendeAOrganizacao(OMNI_PARA_TODAS, false)).toBe(false);
    expect(omniRouterAtendeAOrganizacao(undefined, true)).toBe(false);
  });

  it.each([
    ["endereço que não é URL", { OMNIROUTER_BASE_URL: "omnirouter" }],
    ["endereço com credencial", { OMNIROUTER_BASE_URL: COM_CREDENCIAL }],
    ["chave ausente", { OMNIROUTER_API_KEY: "" }],
    ["chave com espaço", { OMNIROUTER_API_KEY: "duas palavras" }],
  ])("variável malformada (%s) vale `false` e NUNCA lança", (_nome, quebra) => {
    const v = { ...OMNI_POSTO, ...quebra };
    expect(() => omniRouterAtendeAOrganizacao(v, true)).not.toThrow();
    expect(omniRouterAtendeAOrganizacao(v, true)).toBe(false);
  });
});

describe("fetchContidoDoOmniRouter e opcoesDoOmniRouter — só a origem, sem redirect", () => {
  it("destino de outra origem lança sem chamar o fetch", async () => {
    const interno = vi.fn();
    const f = fetchContidoDoOmniRouter(OMNI, interno as unknown as typeof fetch);
    await expect(f("https://api.anthropic.com/v1/messages")).rejects.toThrow(
      "omnirouter_destino_fora_da_origem",
    );
    await expect(f("não é url")).rejects.toThrow("omnirouter_destino_invalido");
    expect(interno).not.toHaveBeenCalled();
  });

  it("3xx vira recusa, e o fetch interno é chamado com redirect manual", async () => {
    const interno = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://x.example" } }),
    );
    const f = fetchContidoDoOmniRouter(OMNI, interno as unknown as typeof fetch);
    await expect(f(`${OMNI}/v1/chat/completions`)).rejects.toThrow("omnirouter_redirect_bloqueado");
    expect(interno).toHaveBeenCalledTimes(1);
    expect((interno.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: "manual" });
  });

  it("resposta comum passa intacta", async () => {
    const interno = vi.fn(async () => new Response("ok", { status: 200 }));
    const f = fetchContidoDoOmniRouter(OMNI, interno as unknown as typeof fetch);
    expect((await f(new URL(`${OMNI}/v1/models`))).status).toBe(200);
  });

  it("opcoesDoOmniRouter REVALIDA o endereço que recebe (a fábrica não confia em quem chama)", () => {
    for (const ruim of [undefined, COM_CREDENCIAL, "ftp://omnirouter", `${OMNI}/v1?x=1`]) {
      expect(erroDe(() => opcoesDoOmniRouter(CHAVE_DO_OMNI, ruim))).toBeInstanceOf(
        OmniRouterInvalidoError,
      );
    }
    const o = opcoesDoOmniRouter(CHAVE_DO_OMNI, `${OMNI}/v1`);
    expect(o.baseURL).toBe(`${OMNI}/v1`);
    expect(o.apiKey).toBe(CHAVE_DO_OMNI);
  });

  it("aceita a contenção do chamador (a allowlist do motor) no lugar da padrão, e ainda bloqueia redirect", async () => {
    const interno = vi.fn(async () => new Response(null, { status: 301 }));
    const contido = vi.fn((_origem: string) => interno as unknown as typeof fetch);
    const o = opcoesDoOmniRouter(CHAVE_DO_OMNI, OMNI, contido);
    expect(contido).toHaveBeenCalledWith(OMNI);
    await expect(o.fetch(`${OMNI}/v1/chat/completions`)).rejects.toThrow(
      "omnirouter_redirect_bloqueado",
    );
  });
});

// ─── A configuração que sai do .env ─────────────────────────────────────────

describe("variaveisDoOmniRouter e llmEdgeConfigFromEnv — o piso do .env", () => {
  it("extrai SÓ as três variáveis", () => {
    expect(
      variaveisDoOmniRouter({
        OMNIROUTER_BASE_URL: OMNI,
        OMNIROUTER_API_KEY: CHAVE_DO_OMNI,
        OMNIROUTER_PARA_TODAS: "true",
        ANTHROPIC_API_KEY: CHAVE_DA_INSTALACAO,
      } as never),
    ).toEqual({
      OMNIROUTER_BASE_URL: OMNI,
      OMNIROUTER_API_KEY: CHAVE_DO_OMNI,
      OMNIROUTER_PARA_TODAS: "true",
    });
  });

  it("sem as variáveis, nenhum campo `omnirouter` (o produto é o de hoje)", () => {
    const cfg = llmEdgeConfigFromEnv({ ANTHROPIC_API_KEY: CHAVE_DA_INSTALACAO });
    expect("omnirouter" in cfg).toBe(false);
    expect(cfg.anthropicApiKey).toBe(CHAVE_DA_INSTALACAO);
  });

  it("variáveis vazias ou só espaços também não criam o campo", () => {
    const cfg = llmEdgeConfigFromEnv({
      OMNIROUTER_BASE_URL: "",
      OMNIROUTER_API_KEY: "",
      OMNIROUTER_PARA_TODAS: "",
    });
    expect("omnirouter" in cfg).toBe(false);
  });

  it("com alguma variável posta, as três seguem CRUAS para o resolvedor validar", () => {
    const cfg = llmEdgeConfigFromEnv({ ...OMNI_PARA_TODAS });
    expect(cfg.omnirouter).toEqual(OMNI_PARA_TODAS);
  });

  it("a chave do OmniRouter NÃO vira `anthropicApiKey`", () => {
    const cfg = llmEdgeConfigFromEnv({ ...OMNI_PARA_TODAS });
    expect(cfg.anthropicApiKey).toBeUndefined();
  });
});

// ─── A escada de credenciais ────────────────────────────────────────────────

interface Rascunho {
  /** `organizations.settings->'llm'`. */
  llm: unknown;
  /** `organizations.settings->'omnirouter'`: a escolha da organização. */
  omnirouter?: unknown;
  /** As credenciais BYOK ativas e validadas da organização. */
  credenciais: unknown[];
  /** As linhas de `platform_config` (o que o admin gravou em Credenciais). */
  config?: Array<Record<string, unknown>>;
  /** Simula o banco fora do ar só para `platform_config`. */
  configFalha?: boolean;
}

/** Pool que responde POR SQL (a ordem das consultas não importa) e anota o que foi perguntado. */
function poolFake(r: Rascunho) {
  const consultas: string[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    // Guarda também as chaves pedidas ao painel: a chave do PROVEDOR da instalação passou a morar lá,
    // então "consultou `platform_config`" já não diz se foi a config do OmniRouter que se foi buscar.
    consultas.push(`${sql} /* chaves: ${JSON.stringify(params?.[0] ?? null)} */`);
    if (sql.includes("settings->'llm'")) return { rows: [{ llm: r.llm, omnirouter: r.omnirouter }] };
    if (sql.includes("from platform_config")) {
      if (r.configFalha) throw new Error("relation platform_config does not exist");
      return { rows: r.config ?? [] };
    }
    if (sql.includes("from ai_provider_credentials")) return { rows: r.credenciais };
    return { rows: [] };
  });
  return { pool: { query } as never, consultas };
}

/** Foi buscar a config do OMNIROUTER (endereço, chave, oferta geral) no painel? A chave do provedor não conta. */
const consultouAConfigDaInstalacao = (consultas: string[]) =>
  consultas.some((sql) => sql.includes("from platform_config") && sql.includes("OMNIROUTER_"));

/** Uma linha de `platform_config` já em claro (knob não secreto: o que importa aqui é a precedência). */
function linhaDaConfig(chave: string, valor: string | null): Record<string, unknown> {
  return {
    chave,
    valor,
    ciphertext: null,
    iv: null,
    tag: null,
    eh_segredo: false,
    semeado_do_env: false,
  };
}

const SETTINGS_ANTHROPIC = { provider: "anthropic", default_model: "claude-haiku-4-5" };
const SEM_BYOK: unknown[] = [];
const COM_BYOK = [{ id: "cred-1", api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" }];
const ESCOLHIDA = { habilitado: true };
const RECUSADA = { habilitado: false };

describe("resolveOrgLlmConfig — o degrau do OmniRouter", () => {
  const cfgComOmni: LlmEdgeConfig = { anthropicApiKey: CHAVE_DA_INSTALACAO, omnirouter: OMNI_POSTO };

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("⭐ organização escolhida, sem credencial própria: chave e endereço do OMNIROUTER; a chave da instalação não participa", async () => {
    const { pool } = poolFake({ llm: SETTINGS_ANTHROPIC, omnirouter: ESCOLHIDA, credenciais: SEM_BYOK });
    const out = await resolveOrgLlmConfig(pool, cfgComOmni, ORG);
    expect(out.provider).toBe("anthropic");
    expect(out.apiKey).toBe(CHAVE_DO_OMNI);
    expect(out.origemDaChave).toBe("chave_da_instalacao");
    expect(out.omnirouter).toEqual({ baseURL: `${OMNI}/v1`, origem: OMNI });
  });

  it("organização sem escolha e sem oferta geral: o comportamento de sempre (chave da instalação), sem consultar nada a mais", async () => {
    const { pool } = poolFake({ llm: SETTINGS_ANTHROPIC, credenciais: SEM_BYOK });
    const out = await resolveOrgLlmConfig(pool, { anthropicApiKey: CHAVE_DA_INSTALACAO }, OUTRA_ORG);
    expect(out.apiKey).toBe(CHAVE_DA_INSTALACAO);
    expect("omnirouter" in out).toBe(false);
  });

  it("a oferta geral do piso atende a organização que não escolheu", async () => {
    const { pool } = poolFake({ llm: SETTINGS_ANTHROPIC, credenciais: SEM_BYOK });
    const out = await resolveOrgLlmConfig(
      pool,
      { anthropicApiKey: CHAVE_DA_INSTALACAO, omnirouter: OMNI_PARA_TODAS },
      OUTRA_ORG,
    );
    expect(out.apiKey).toBe(CHAVE_DO_OMNI);
    expect(out.omnirouter?.baseURL).toBe(`${OMNI}/v1`);
  });

  it("⭐ organização que RECUSOU o OmniRouter, mesmo com a oferta geral: chave da instalação, e o banco nem é consultado", async () => {
    const { pool, consultas } = poolFake({
      llm: SETTINGS_ANTHROPIC,
      omnirouter: RECUSADA,
      credenciais: SEM_BYOK,
    });
    const out = await resolveOrgLlmConfig(
      pool,
      { anthropicApiKey: CHAVE_DA_INSTALACAO, omnirouter: OMNI_PARA_TODAS },
      ORG,
    );
    expect(out.apiKey).toBe(CHAVE_DA_INSTALACAO);
    expect("omnirouter" in out).toBe(false);
    expect(consultouAConfigDaInstalacao(consultas)).toBe(false);
  });

  it("⭐ E10: organização escolhida COM credencial própria validada: a chave dela vence, sem OmniRouter e sem consultar a instalação", async () => {
    const { pool, consultas } = poolFake({
      llm: SETTINGS_ANTHROPIC,
      omnirouter: ESCOLHIDA,
      credenciais: COM_BYOK,
    });
    const out = await resolveOrgLlmConfig(pool, cfgComOmni, ORG);
    expect(out.apiKey).toBe(CHAVE_DA_ORG);
    expect(out.origemDaChave).toBe("credencial_da_organizacao");
    expect("omnirouter" in out).toBe(false);
    expect(consultouAConfigDaInstalacao(consultas)).toBe(false);
  });

  it("⭐ o BANCO vence o `.env`: o endereço e a chave gravados em Credenciais são os usados", async () => {
    const { pool } = poolFake({
      llm: SETTINGS_ANTHROPIC,
      omnirouter: ESCOLHIDA,
      credenciais: SEM_BYOK,
      config: [
        linhaDaConfig("OMNIROUTER_BASE_URL", "https://omni-do-painel.exemplo.com"),
        linhaDaConfig("OMNIROUTER_API_KEY", "chave-do-painel-sintetica"),
      ],
    });
    const out = await resolveOrgLlmConfig(pool, cfgComOmni, ORG);
    expect(out.apiKey).toBe("chave-do-painel-sintetica");
    expect(out.omnirouter).toEqual({
      baseURL: "https://omni-do-painel.exemplo.com/v1",
      origem: "https://omni-do-painel.exemplo.com",
    });
  });

  it("a configuração pode vir SÓ do banco: sem `.env` nenhum, a organização escolhida é atendida", async () => {
    const { pool } = poolFake({
      llm: SETTINGS_ANTHROPIC,
      omnirouter: ESCOLHIDA,
      credenciais: SEM_BYOK,
      config: [
        linhaDaConfig("OMNIROUTER_BASE_URL", OMNI),
        linhaDaConfig("OMNIROUTER_API_KEY", CHAVE_DO_OMNI),
      ],
    });
    const out = await resolveOrgLlmConfig(pool, {}, ORG);
    expect(out.apiKey).toBe(CHAVE_DO_OMNI);
  });

  it("⭐ apagar o endereço E a chave pela tela desliga o OmniRouter, mesmo com o `.env` posto", async () => {
    const { pool } = poolFake({
      llm: SETTINGS_ANTHROPIC,
      omnirouter: ESCOLHIDA,
      credenciais: SEM_BYOK,
      config: [linhaDaConfig("OMNIROUTER_BASE_URL", null), linhaDaConfig("OMNIROUTER_API_KEY", null)],
    });
    const out = await resolveOrgLlmConfig(pool, cfgComOmni, ORG);
    expect(out.apiKey).toBe(CHAVE_DA_INSTALACAO);
    expect("omnirouter" in out).toBe(false);
  });

  it("banco fora do ar (ou tabela ausente): o piso do `.env` responde e o turno não cai", async () => {
    const { pool } = poolFake({
      llm: SETTINGS_ANTHROPIC,
      omnirouter: ESCOLHIDA,
      credenciais: SEM_BYOK,
      configFalha: true,
    });
    const out = await resolveOrgLlmConfig(pool, cfgComOmni, ORG);
    expect(out.apiKey).toBe(CHAVE_DO_OMNI);
  });

  it("organização escolhida e instalação SEM nada configurado: cai na chave da instalação (regressão zero)", async () => {
    const { pool } = poolFake({ llm: SETTINGS_ANTHROPIC, omnirouter: ESCOLHIDA, credenciais: SEM_BYOK });
    const out = await resolveOrgLlmConfig(pool, { anthropicApiKey: CHAVE_DA_INSTALACAO }, ORG);
    expect(out.apiKey).toBe(CHAVE_DA_INSTALACAO);
    expect("omnirouter" in out).toBe(false);
  });

  it("organização escolhida, sem OmniRouter e sem chave da instalação: LlmNotConfiguredError", async () => {
    const { pool } = poolFake({ llm: SETTINGS_ANTHROPIC, omnirouter: ESCOLHIDA, credenciais: SEM_BYOK });
    await expect(resolveOrgLlmConfig(pool, {}, ORG)).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });

  it("⭐ configuração torta para organização atendida: lança, e NÃO cai na chave da instalação", async () => {
    const ruim: LlmEdgeConfig = {
      anthropicApiKey: CHAVE_DA_INSTALACAO,
      omnirouter: { ...OMNI_POSTO, OMNIROUTER_BASE_URL: COM_CREDENCIAL },
    };
    const { pool } = poolFake({ llm: SETTINGS_ANTHROPIC, omnirouter: ESCOLHIDA, credenciais: SEM_BYOK });
    const erro = await resolveOrgLlmConfig(pool, ruim, ORG).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(OmniRouterInvalidoError);
    expect((erro as Error).message).not.toContain(CHAVE_DA_INSTALACAO);
    expect((erro as Error).message).not.toContain(CHAVE_DO_OMNI);
    expect((erro as Error).message).not.toContain("valor-sintetico");
  });

  it("configuração torta, mas credencial própria presente: a organização segue funcionando (nem é avaliada)", async () => {
    const ruim: LlmEdgeConfig = {
      anthropicApiKey: CHAVE_DA_INSTALACAO,
      omnirouter: { ...OMNI_POSTO, OMNIROUTER_BASE_URL: "lixo" },
    };
    const { pool } = poolFake({ llm: SETTINGS_ANTHROPIC, omnirouter: ESCOLHIDA, credenciais: COM_BYOK });
    const out = await resolveOrgLlmConfig(pool, ruim, ORG);
    expect(out.apiKey).toBe(CHAVE_DA_ORG);
  });

  it("configuração torta, mas a organização NÃO é atendida (recusou): quem não usa não leva erro de configuração", async () => {
    const ruim: LlmEdgeConfig = {
      anthropicApiKey: CHAVE_DA_INSTALACAO,
      omnirouter: { ...OMNI_PARA_TODAS, OMNIROUTER_BASE_URL: COM_CREDENCIAL },
    };
    const { pool } = poolFake({ llm: SETTINGS_ANTHROPIC, omnirouter: RECUSADA, credenciais: SEM_BYOK });
    const out = await resolveOrgLlmConfig(pool, ruim, ORG);
    expect(out.apiKey).toBe(CHAVE_DA_INSTALACAO);
  });

  it("configuração torta e organização sem escolha nem oferta geral: cai na chave da instalação, sem erro", async () => {
    const ruim: LlmEdgeConfig = {
      anthropicApiKey: CHAVE_DA_INSTALACAO,
      omnirouter: { ...OMNI_POSTO, OMNIROUTER_BASE_URL: "lixo" },
    };
    const { pool } = poolFake({ llm: SETTINGS_ANTHROPIC, credenciais: SEM_BYOK });
    const out = await resolveOrgLlmConfig(pool, ruim, ORG);
    expect(out.apiKey).toBe(CHAVE_DA_INSTALACAO);
  });

  it("provedor que não é a Anthropic não é tocado pelo OmniRouter (openai segue com a própria chave)", async () => {
    const { pool, consultas } = poolFake({
      llm: { provider: "openai", default_model: "gpt-5.6-luna" },
      omnirouter: ESCOLHIDA,
      credenciais: SEM_BYOK,
    });
    const out = await resolveOrgLlmConfig(
      pool,
      { openaiApiKey: "chave-openai-sintetica", omnirouter: OMNI_PARA_TODAS },
      ORG,
    );
    expect(out.provider).toBe("openai");
    expect(out.apiKey).toBe("chave-openai-sintetica");
    expect("omnirouter" in out).toBe(false);
    expect(consultouAConfigDaInstalacao(consultas)).toBe(false);
  });

  it("a ponte antiga não existe mais: `settings.llm.ponte_ativa` é ignorado", async () => {
    const { pool } = poolFake({
      llm: { ...SETTINGS_ANTHROPIC, ponte_ativa: false },
      omnirouter: ESCOLHIDA,
      credenciais: SEM_BYOK,
    });
    const out = await resolveOrgLlmConfig(pool, cfgComOmni, ORG);
    expect(out.apiKey).toBe(CHAVE_DO_OMNI);
  });
});

// ─── O seam inteiro: qual fábrica fala, com qual chave e qual endereço ──────

const COMPLETION_OK = {
  id: "chatcmpl-teste",
  object: "chat.completion",
  created: 1,
  model: "claude-haiku-4-5",
  choices: [{ index: 0, message: { role: "assistant", content: "oi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
};

/** A resposta da Anthropic direta (API de mensagens), para os casos em que o OmniRouter NÃO entra. */
const MENSAGEM_DA_ANTHROPIC = {
  id: "msg_teste",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5",
  content: [{ type: "text", text: "oi" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 1 },
};

/**
 * Pool que responde às consultas do seam; `credenciais` é o que a organização tem cadastrado.
 * `omnirouter` é a ESCOLHA gravada em `settings.omnirouter`: passe `null` para "nunca escolheu" (um
 * `undefined` ativaria o valor padrão do parâmetro).
 */
function poolDoTurno(
  credenciais: unknown[],
  omnirouter: unknown = ESCOLHIDA,
  settings: unknown = SETTINGS_ANTHROPIC,
) {
  const inserts: Array<{ params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) return { rows: [{ llm: settings, omnirouter }] };
    if (sql.includes("from platform_config")) return { rows: [] };
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
    [FABRICA_DO_OMNIROUTER]: fabrica(FABRICA_DO_OMNIROUTER),
  } as unknown as ProviderRegistry;
  return { chamadas, registry };
}

async function turno(
  cfg: LlmEdgeConfig,
  org: string,
  pool: ReturnType<typeof poolDoTurno>,
  registry: ProviderRegistry,
) {
  const resultado = await runModelCall(
    pool.pool,
    { cacheTtl: "1h", ...cfg },
    { tenantId: org, purpose: "agent_preview", messages: [{ role: "user", content: "oi" }] },
    { registry },
  );
  return { resultado, inserts: pool.inserts };
}

describe("runModelCall — a fábrica do OmniRouter só fala por quem ele atende", () => {
  const cfg: LlmEdgeConfig = { anthropicApiKey: CHAVE_DA_INSTALACAO, omnirouter: OMNI_POSTO };

  it("⭐ organização escolhida sem credencial própria: fábrica DO OMNIROUTER, com a chave dele e o endereço validado", async () => {
    const { chamadas, registry } = registryEspiao();
    const { resultado, inserts } = await turno(cfg, ORG, poolDoTurno(SEM_BYOK), registry);
    expect(chamadas).toEqual([
      {
        fabrica: FABRICA_DO_OMNIROUTER,
        apiKey: CHAVE_DO_OMNI,
        modelId: "claude-haiku-4-5",
        baseUrl: `${OMNI}/v1`,
      },
    ]);
    // O provedor registrado em `llm_calls` continua sendo o da Anthropic (o OmniRouter é só o destino).
    expect(resultado.provider).toBe("anthropic");
    expect(inserts).toHaveLength(1);
  });

  it("⭐ E10 no seam: organização escolhida COM credencial própria: fábrica `anthropic`, chave dela, SEM endereço", async () => {
    const { chamadas, registry } = registryEspiao();
    await turno(cfg, ORG, poolDoTurno(COM_BYOK), registry);
    expect(chamadas).toEqual([
      { fabrica: "anthropic", apiKey: CHAVE_DA_ORG, modelId: "claude-haiku-4-5", baseUrl: undefined },
    ]);
  });

  it("organização não escolhida: fábrica `anthropic` com a chave da instalação, sem endereço", async () => {
    const { chamadas, registry } = registryEspiao();
    // `null` (e não `undefined`): `undefined` ativaria o valor padrão do parâmetro (a organização escolhida).
    await turno(cfg, OUTRA_ORG, poolDoTurno(SEM_BYOK, null), registry);
    expect(chamadas).toEqual([
      {
        fabrica: "anthropic",
        apiKey: CHAVE_DA_INSTALACAO,
        modelId: "claude-haiku-4-5",
        baseUrl: undefined,
      },
    ]);
  });

  it("sem OmniRouter configurado: exatamente o de hoje (chave da instalação, fábrica `anthropic`)", async () => {
    const { chamadas, registry } = registryEspiao();
    await turno({ anthropicApiKey: CHAVE_DA_INSTALACAO }, ORG, poolDoTurno(SEM_BYOK), registry);
    expect(chamadas.map((c) => [c.fabrica, c.apiKey, c.baseUrl])).toEqual([
      ["anthropic", CHAVE_DA_INSTALACAO, undefined],
    ]);
  });

  it("⭐ configuração torta para a organização atendida: a chamada é recusada ANTES de qualquer fábrica, com a classe própria", async () => {
    const { chamadas, registry } = registryEspiao();
    const ruim: LlmEdgeConfig = {
      anthropicApiKey: CHAVE_DA_INSTALACAO,
      omnirouter: { ...OMNI_POSTO, OMNIROUTER_BASE_URL: `${OMNI}/v1?x=1` },
    };
    const erro = await turno(ruim, ORG, poolDoTurno(SEM_BYOK), registry).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(OmniRouterInvalidoError);
    expect(chamadas).toHaveLength(0);
  });

  it("o registry de teste (`createFakeRegistry`) também conhece a fábrica do OmniRouter", () => {
    expect(createFakeRegistry()[FABRICA_DO_OMNIROUTER]).toBeTypeOf("function");
  });
});

describe("a fábrica do OmniRouter não é um provedor (chave `symbol`)", () => {
  it("⭐ nenhuma chave de TEXTO do registry é o OmniRouter: a lista da tela e o registry seguem a mesma lista", () => {
    for (const registry of [createDefaultRegistry(), createFakeRegistry()]) {
      expect(Object.keys(registry).some((id) => id.toLowerCase().includes("omnirouter"))).toBe(false);
      expect(Object.getOwnPropertySymbols(registry)).toContain(FABRICA_DO_OMNIROUTER);
    }
  });

  it("⭐ um provedor com o nome do OmniRouter, gravado no banco, não alcança a fábrica", async () => {
    // `provider` é texto livre no banco; quem administra uma organização poderia escrever qualquer nome.
    const { chamadas, registry } = registryEspiao();
    const pool = poolDoTurno(COM_BYOK, ESCOLHIDA, {
      provider: "omnirouter",
      default_model: "claude-haiku-4-5",
    });
    const erro = await runModelCall(
      pool.pool,
      { anthropicApiKey: CHAVE_DA_INSTALACAO, omnirouter: OMNI_POSTO, cacheTtl: "1h" },
      { tenantId: ORG, purpose: "agent_preview", messages: [{ role: "user", content: "oi" }] },
      { registry },
    ).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmProviderUnknownError);
    expect(chamadas).toHaveLength(0);
  });
});

describe("normalizarErro — o erro da configuração do OmniRouter tem código próprio", () => {
  it("omnirouter_invalido, sem status HTTP e sem repetir o valor", () => {
    const n = normalizarErro(erroDe(() => lerEnderecoDoOmniRouter(COM_CREDENCIAL)));
    expect(n.error_code).toBe("omnirouter_invalido");
    expect(n.http_status).toBeNull();
    expect(n.error_message).not.toContain("valor-sintetico");
  });

  const chamadaFalha = (statusCode: number, message: string) =>
    new APICallError({
      message,
      url: `${OMNI}/v1/chat/completions`,
      requestBodyValues: {},
      statusCode,
      isRetryable: true,
    });
  const aposAsTentativas = (ultimo: unknown) =>
    new RetryError({
      message: "Failed after 3 attempts. Last error: tentativas esgotadas",
      reason: "maxRetriesExceeded",
      errors: [ultimo, ultimo, ultimo],
    });

  it.each([
    [529, "provedor_indisponivel"],
    [503, "provedor_indisponivel"],
    [429, "limite_ou_saldo"],
    [401, "credencial_recusada"],
  ])(
    "⭐ o status %i que o SDK esconde dentro do RetryError chega à classificação (%s)",
    (statusCode, codigo) => {
      // O SDK repete 429/5xx e, esgotadas as tentativas, lança um RetryError SEM `statusCode`:
      // o `APICallError` está em `lastError`. Antes, tudo isto virava `erro_desconhecido`.
      const n = normalizarErro(aposAsTentativas(chamadaFalha(statusCode, "sem pista no texto")));
      expect(n.error_code).toBe(codigo);
      expect(n.http_status).toBe(statusCode);
    },
  );

  it("o status vem do ÚLTIMO erro, e a `cause` também é seguida", () => {
    const n = normalizarErro(
      new RetryError({
        message: "Failed after 2 attempts",
        reason: "maxRetriesExceeded",
        errors: [chamadaFalha(429, "a"), chamadaFalha(529, "b")],
      }),
    );
    expect(n.http_status).toBe(529);
    const embrulho = new Error("embrulho", { cause: chamadaFalha(503, "interno") });
    expect(normalizarErro(embrulho).http_status).toBe(503);
  });

  it("erro com ciclo na cadeia não trava e não inventa status", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(normalizarErro(a).http_status).toBeNull();
  });
});

// ─── O SDK REAL: o que de fato sai pela rede (interceptada) ─────────────────

interface Chamada {
  url: string;
  host: string;
  autorizacao: string | null;
  redirect: RequestRedirect | undefined;
}

describe("com o SDK real e o fetch interceptado", () => {
  let fetchOriginal: typeof globalThis.fetch;
  let chamadas: Chamada[];
  let responder: () => Response;

  beforeEach(() => {
    chamadas = [];
    // Cada destino responde no formato da sua própria API: o OmniRouter fala chat/completions (OpenAI) e
    // a Anthropic direta fala mensagens. Responder um formato ao outro não prova nada além do erro de parse.
    responder = () =>
      new Response(JSON.stringify(chamadas.at(-1)?.host === "api.anthropic.com" ? MENSAGEM_DA_ANTHROPIC : COMPLETION_OK), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    fetchOriginal = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      chamadas.push({
        url,
        host: new URL(url).host,
        autorizacao: new Headers(init?.headers).get("authorization"),
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

  it("⭐ a fábrica do OmniRouter chama `<omnirouter>/v1/chat/completions` com a chave dele, sem redirect, e só essa origem", async () => {
    const modelo = createDefaultRegistry()[FABRICA_DO_OMNIROUTER]!(
      CHAVE_DO_OMNI,
      "claude-haiku-4-5",
      `${OMNI}/v1`,
    );
    await generateText({ model: modelo, prompt: "oi", maxRetries: 0 });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toMatchObject({
      url: `${OMNI}/v1/chat/completions`,
      autorizacao: `Bearer ${CHAVE_DO_OMNI}`,
      redirect: "manual",
    });
    expect(hosts()).toEqual(["omnirouter:20128"]);
  });

  it("a fábrica do OmniRouter sem endereço (ou com endereço ruim) lança antes de qualquer byte", () => {
    const fabrica = createDefaultRegistry()[FABRICA_DO_OMNIROUTER]!;
    expect(erroDe(() => fabrica(CHAVE_DO_OMNI, "claude-haiku-4-5"))).toBeInstanceOf(
      OmniRouterInvalidoError,
    );
    expect(erroDe(() => fabrica(CHAVE_DO_OMNI, "claude-haiku-4-5", COM_CREDENCIAL))).toBeInstanceOf(
      OmniRouterInvalidoError,
    );
    expect(chamadas).toHaveLength(0);
  });

  it("⭐ a fábrica `anthropic` vai SEMPRE a api.anthropic.com, mesmo com `OMNIROUTER_*` e `ANTHROPIC_BASE_URL` no ambiente", async () => {
    vi.stubEnv("OMNIROUTER_BASE_URL", OMNI);
    vi.stubEnv("OMNIROUTER_API_KEY", CHAVE_DO_OMNI);
    vi.stubEnv("OMNIROUTER_PARA_TODAS", "true");
    vi.stubEnv("ANTHROPIC_BASE_URL", OMNI);
    // O terceiro argumento (um endereço) também é ignorado: a fábrica não tem para onde apontá-lo.
    const modelo = createDefaultRegistry().anthropic!(CHAVE_DA_ORG, "claude-haiku-4-5", `${OMNI}/v1`);
    await generateText({ model: modelo, prompt: "oi", maxRetries: 0 });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toMatchObject({ url: "https://api.anthropic.com/v1/messages" });
    expect(hosts()).toEqual(["api.anthropic.com"]);
  });

  it("⭐ o seam inteiro, organização escolhida SEM credencial própria: só o OmniRouter é tocado, com a chave dele", async () => {
    const pool = poolDoTurno(SEM_BYOK);
    const resultado = await runModelCall(
      pool.pool,
      { anthropicApiKey: CHAVE_DA_INSTALACAO, omnirouter: OMNI_POSTO, cacheTtl: "1h" },
      { tenantId: ORG, purpose: "agent_preview", messages: [{ role: "user", content: "oi" }] },
      { registry: createDefaultRegistry() },
    );
    expect(hosts()).toEqual(["omnirouter:20128"]);
    expect(chamadas.every((c) => c.autorizacao === `Bearer ${CHAVE_DO_OMNI}`)).toBe(true);
    expect(chamadas.map((c) => c.url)).toEqual([`${OMNI}/v1/chat/completions`]);
    expect(resultado.provider).toBe("anthropic");
    expect(pool.inserts).toHaveLength(1);
  });

  it("⭐ E10 de ponta a ponta: organização COM credencial própria: o OmniRouter não vê chamada nenhuma", async () => {
    const pool = poolDoTurno(COM_BYOK);
    await runModelCall(
      pool.pool,
      { anthropicApiKey: CHAVE_DA_INSTALACAO, omnirouter: OMNI_POSTO, cacheTtl: "1h" },
      { tenantId: ORG, purpose: "agent_preview", messages: [{ role: "user", content: "oi" }] },
      { registry: createDefaultRegistry() },
    );
    expect(hosts()).toEqual(["api.anthropic.com"]);
    expect(chamadas.some((c) => c.host === "omnirouter:20128")).toBe(false);
  });

  it("organização não escolhida, com a chave da instalação: api.anthropic.com, o OmniRouter intocado", async () => {
    const pool = poolDoTurno(SEM_BYOK, null);
    await runModelCall(
      pool.pool,
      { anthropicApiKey: CHAVE_DA_INSTALACAO, omnirouter: OMNI_POSTO, cacheTtl: "1h" },
      { tenantId: OUTRA_ORG, purpose: "agent_preview", messages: [{ role: "user", content: "oi" }] },
      { registry: createDefaultRegistry() },
    );
    expect(hosts()).toEqual(["api.anthropic.com"]);
    expect(chamadas.some((c) => c.host === "omnirouter:20128")).toBe(false);
  });

  it("⭐ 3xx do OmniRouter não é seguido: nenhum segundo pedido sai, e a chave não viaja para o Location", async () => {
    responder = () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://api.anthropic.com/v1/messages" },
      });
    const pool = poolDoTurno(SEM_BYOK);
    const erro = await runModelCall(
      pool.pool,
      { omnirouter: OMNI_POSTO, cacheTtl: "1h" },
      { tenantId: ORG, purpose: "agent_preview", messages: [{ role: "user", content: "oi" }] },
      { registry: createDefaultRegistry() },
    ).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(Error);
    expect(hosts()).toEqual(["omnirouter:20128"]);
    expect(chamadas.length).toBeGreaterThan(0);
    expect(chamadas.some((c) => c.host === "api.anthropic.com")).toBe(false);
  });
});
