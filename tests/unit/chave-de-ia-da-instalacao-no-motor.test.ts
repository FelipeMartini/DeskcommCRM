/**
 * A CHAVE DE IA DA INSTALAÇÃO NO MOTOR: o PAINEL VENCE, O `.env` É O PISO.
 *
 * `resolveOrgLlmConfig` tinha três degraus que liam `cfg.anthropicApiKey`, `cfg.openaiApiKey` e
 * `cfg.openrouterApiKey` — o `.env` montado no boot do worker. Para o administrador da plataforma poder
 * gravar essas chaves em Admin › Configuração › Credenciais sem editar arquivo nem reiniciar, o degrau
 * passou a ler `platform_config` a cada chamada (`valoresDaInstalacaoNoMotor`), e o que `cfg` carrega
 * virou o piso. Sem estes casos, a tela diria "salvo" e o worker — onde a IA gasta — seguiria na chave
 * velha do arquivo.
 *
 * O que se prova, por provedor:
 *   - a chave gravada na tela vence a do `.env`;
 *   - sem linha, o `.env` responde (quem nunca abriu a tela não percebe diferença);
 *   - segredo é aberto do envelope;
 *   - a credencial própria da organização continua vencendo as duas;
 *   - banco fora do ar não derruba o turno: o piso responde;
 *   - provedor sem chave de instalação não vai ao banco à toa, e sem nada a falha é a de sempre.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aes = vi.hoisted(() => ({ decrypt: vi.fn() }));
vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: (v: unknown) => Buffer.from(String(v)),
  decryptKey: aes.decrypt,
}));

import {
  LlmNotConfiguredError,
  resolveOrgLlmConfig,
  type LlmEdgeConfig,
} from "@/lib/agent-engine/edge/llm/credentials";

interface LinhaDoPainel {
  chave: string;
  valor: string | null;
  ciphertext: unknown;
  iv: unknown;
  tag: unknown;
  eh_segredo: boolean;
  semeado_do_env: boolean;
}

function linha(chave: string, extra: Partial<LinhaDoPainel> = {}): LinhaDoPainel {
  return {
    chave,
    valor: null,
    ciphertext: null,
    iv: null,
    tag: null,
    eh_segredo: false,
    semeado_do_env: false,
    ...extra,
  };
}

/** Pool falso que responde cada consulta pelo que ela diz ser, sem depender da ordem. */
function pool(opcoes: {
  settingsLlm?: unknown;
  byok?: unknown[];
  painel?: LinhaDoPainel[] | "lancar";
}) {
  const painelConsultas: string[][] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("from platform_config")) {
      const pedidas = (params?.[0] ?? []) as string[];
      painelConsultas.push(pedidas);
      if (opcoes.painel === "lancar") throw new Error("relation platform_config does not exist");
      return { rows: (opcoes.painel ?? []).filter((l) => pedidas.includes(l.chave)) };
    }
    if (sql.includes("ai_provider_credentials")) return { rows: opcoes.byok ?? [] };
    return { rows: [{ llm: opcoes.settingsLlm ?? {} }] };
  });
  return { db: { query } as never, query, painelConsultas };
}

beforeEach(() => {
  aes.decrypt.mockReset();
  aes.decrypt.mockReturnValue("segredo-aberto-sintetico");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const PISO: LlmEdgeConfig = {
  anthropicApiKey: "sk-ant-do-env",
  openaiApiKey: "sk-proj-do-env",
  openrouterApiKey: "sk-or-do-env",
};

const PROVEDORES = [
  ["anthropic", "ANTHROPIC_API_KEY", "sk-ant-do-env"],
  ["openai", "OPENAI_API_KEY", "sk-proj-do-env"],
  ["openrouter", "OPENROUTER_API_KEY", "sk-or-do-env"],
] as const;

describe("a chave da instalação vem do painel; o `.env` é o piso", () => {
  it.each(PROVEDORES)("⭐ %s: a chave gravada na tela VENCE a do .env", async (provider, nome) => {
    const { db } = pool({
      settingsLlm: { provider },
      painel: [linha(nome, { valor: "chave-gravada-na-tela" })],
    });
    const out = await resolveOrgLlmConfig(db, PISO, "org-1");
    expect(out.apiKey).toBe("chave-gravada-na-tela");
    expect(out.origemDaChave).toBe("chave_da_instalacao");
  });

  it.each(PROVEDORES)("%s: sem linha no painel, o .env responde", async (provider, _nome, doEnv) => {
    const { db } = pool({ settingsLlm: { provider }, painel: [] });
    const out = await resolveOrgLlmConfig(db, PISO, "org-1");
    expect(out.apiKey).toBe(doEnv);
    expect(out.origemDaChave).toBe("chave_da_instalacao");
  });

  it.each(PROVEDORES)("%s: o segredo do painel é aberto do envelope cifrado", async (provider, nome) => {
    aes.decrypt.mockReturnValue("chave-aberta-do-envelope");
    const { db } = pool({
      settingsLlm: { provider },
      painel: [linha(nome, { eh_segredo: true, ciphertext: "c", iv: "i", tag: "t" })],
    });
    const out = await resolveOrgLlmConfig(db, PISO, "org-1");
    expect(out.apiKey).toBe("chave-aberta-do-envelope");
  });

  it.each(PROVEDORES)("%s: banco fora do ar → o .env responde e o turno não cai", async (provider, _nome, doEnv) => {
    const { db } = pool({ settingsLlm: { provider }, painel: "lancar" });
    const out = await resolveOrgLlmConfig(db, PISO, "org-1");
    expect(out.apiKey).toBe(doEnv);
  });

  it.each(PROVEDORES)("%s: a credencial PRÓPRIA da organização vence a do painel", async (provider, nome) => {
    aes.decrypt.mockReturnValue("chave-propria-da-org");
    const { db, painelConsultas } = pool({
      settingsLlm: { provider },
      byok: [{ api_key_encrypted: "x", api_key_iv: "y", api_key_tag: "z" }],
      painel: [linha(nome, { valor: "chave-gravada-na-tela" })],
    });
    const out = await resolveOrgLlmConfig(db, PISO, "org-1");
    expect(out.apiKey).toBe("chave-propria-da-org");
    expect(out.origemDaChave).toBe("credencial_da_organizacao");
    // Quem tem credencial própria nem chega ao degrau da instalação.
    expect(painelConsultas).toEqual([]);
  });

  it("⭐ cada provedor lê SÓ a própria chave: a do painel de um não serve a outro", async () => {
    const { db } = pool({
      settingsLlm: { provider: "openai" },
      painel: [linha("ANTHROPIC_API_KEY", { valor: "sk-ant-so-do-painel" })],
    });
    const out = await resolveOrgLlmConfig(db, { openaiApiKey: "sk-proj-do-env" }, "org-1");
    expect(out.provider).toBe("openai");
    expect(out.apiKey).toBe("sk-proj-do-env");
  });

  it("a organização que escolheu OpenAI com chave só no painel (sem .env) é atendida", async () => {
    const { db } = pool({
      settingsLlm: { provider: "openai" },
      painel: [linha("OPENAI_API_KEY", { valor: "sk-proj-so-no-painel" })],
    });
    const out = await resolveOrgLlmConfig(db, {}, "org-1");
    expect(out.apiKey).toBe("sk-proj-so-no-painel");
  });
});

describe("sem chave nenhuma, a falha é a de sempre", () => {
  it.each(PROVEDORES)("%s: sem painel e sem .env → LlmNotConfiguredError", async (provider) => {
    const { db } = pool({ settingsLlm: { provider }, painel: [] });
    await expect(resolveOrgLlmConfig(db, {}, "org-1")).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });

  it("chave só de espaços no painel não conta como chave", async () => {
    const { db } = pool({
      settingsLlm: { provider: "openai" },
      painel: [linha("OPENAI_API_KEY", { valor: "   " })],
    });
    await expect(resolveOrgLlmConfig(db, PISO, "org-1")).rejects.toBeInstanceOf(LlmNotConfiguredError);
  });

  it.each(["custom", "deepseek", "google"])(
    "%s não tem chave de instalação: falha sem ir ao painel procurá-la",
    async (provider) => {
      const { db, painelConsultas } = pool({ settingsLlm: { provider }, painel: [] });
      await expect(resolveOrgLlmConfig(db, PISO, "org-1")).rejects.toBeInstanceOf(LlmNotConfiguredError);
      // Nenhuma consulta pediu uma chave de provedor ao painel.
      const chavesDeIa = painelConsultas.flat().filter((c) => c.endsWith("_API_KEY") && !c.startsWith("OMNIROUTER"));
      expect(chavesDeIa).toEqual([]);
    },
  );

  it("o degrau da instalação pede ao painel UMA chave só, a do provedor", async () => {
    const { db, painelConsultas } = pool({ settingsLlm: { provider: "openai" }, painel: [] });
    await resolveOrgLlmConfig(db, PISO, "org-1");
    expect(painelConsultas).toEqual([["OPENAI_API_KEY"]]);
  });
});
