/**
 * O que este teste protege: **o modelo de CHAT tem que virar um provider
 * explícito quando não há gateway.**
 *
 * `isAiGatewayConfigured()` já devolvia `true` com só `ANTHROPIC_API_KEY` — a
 * única chave que o `install.sh` exige. Mas quem executava passava o id como
 * STRING, e no AI SDK id com barra é resolvido pelo **gateway da Vercel mesmo
 * sem chave**, caindo no plano anônimo:
 *
 *     Unauthenticated. Configure AI_GATEWAY_API_KEY or use a provider module.
 *
 * Resultado observado numa instalação self-host real: o `ai-sentiment-worker`
 * falhava em loop, uma vez por mensagem recebida. Ou seja, a checagem dizia
 * "tem IA" e a execução dizia "não tem" — desalinhados.
 *
 * A asserção é sobre o TIPO do retorno, mesma lógica do `embed.test.ts`:
 * string = "deixa o gateway resolver"; objeto = "provider explícito". É a única
 * diferença observável sem rede.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));

// As chaves de IA da instalação passaram a vir do resolvedor do painel (`valorDaInstalacao`), com o `.env`
// como piso. Aqui o "painel" é o próprio `envMock`: a chave que o teste põe nele é a que o resolvedor devolve.
vi.mock("@/lib/instalacao/config", () => ({
  valorDaInstalacao: async (chave: string) => {
    const valor = envMock[chave];
    return valor === undefined
      ? { valor: null, fonte: "ausente" as const }
      : { valor, fonte: "ambiente" as const };
  },
}));

import { resolveLanguageModel } from "@/lib/ai/gateway";

beforeEach(() => {
  for (const k of Object.keys(envMock)) delete envMock[k];
});

describe("resolveLanguageModel", () => {
  it("com gateway da Vercel devolve a STRING (o gateway roteia e fatura)", async () => {
    envMock.AI_GATEWAY_API_KEY = "gw-key";
    expect(await resolveLanguageModel("anthropic/claude-haiku-4-5")).toBe(
      "anthropic/claude-haiku-4-5",
    );
  });

  it("só com ANTHROPIC_API_KEY devolve PROVIDER, não string — o bug do worker", async () => {
    envMock.ANTHROPIC_API_KEY = "sk-ant-xxx";
    const model = await resolveLanguageModel("anthropic/claude-haiku-4-5");
    expect(model).not.toBeNull();
    expect(typeof model).not.toBe("string");
  });

  it("com OPENROUTER_API_KEY devolve provider (ids da OpenRouter são provider/modelo)", async () => {
    envMock.OPENROUTER_API_KEY = "sk-or-xxx";
    const model = await resolveLanguageModel("anthropic/claude-haiku-4-5");
    expect(model).not.toBeNull();
    expect(typeof model).not.toBe("string");
  });

  it("gateway da Vercel tem precedência sobre OpenRouter", async () => {
    envMock.AI_GATEWAY_API_KEY = "gw-key";
    envMock.OPENROUTER_API_KEY = "sk-or-xxx";
    expect(typeof (await resolveLanguageModel("anthropic/claude-haiku-4-5"))).toBe("string");
  });

  it("id openai/* cai no provider OpenAI quando só há OPENAI_API_KEY", async () => {
    envMock.OPENAI_API_KEY = "sk-openai";
    const model = await resolveLanguageModel("openai/gpt-4o-mini");
    expect(model).not.toBeNull();
    expect(typeof model).not.toBe("string");
  });

  it("sem chave nenhuma devolve null, para o chamador PULAR com motivo claro", async () => {
    expect(await resolveLanguageModel("anthropic/claude-haiku-4-5")).toBeNull();
  });

  it("chave errada para o prefixo do id também é null (não inventa provider)", async () => {
    // Só OpenAI configurada, mas o id pede Anthropic: não dá para atender.
    envMock.OPENAI_API_KEY = "sk-openai";
    expect(await resolveLanguageModel("anthropic/claude-haiku-4-5")).toBeNull();
  });
});
