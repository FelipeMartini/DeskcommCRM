/**
 * AS CHAVES DE IA DA INSTALAÇÃO, LIDAS PELO APP (`lib/ai/chaves-da-instalacao.ts`).
 *
 * Anthropic, OpenAI e OpenRouter passaram a ser gravadas em Admin › Configuração › Credenciais, com o
 * `.env` como piso. Este módulo é a única porta de leitura do APP para elas: o gateway de IA, a escada
 * de embeddings, a chave da voz, os portões de salvar e publicar agente e as telas que perguntam
 * "a instalação tem chave?" passam todos por aqui. Aqui se prova a regra que o motor do worker também
 * segue (`tests/unit/chave-de-ia-da-instalacao-no-motor.test.ts`):
 *
 *   - o que a tela gravou vence, e sem linha o `.env` responde;
 *   - chave vazia ou só de espaços não conta como chave;
 *   - a leitura NUNCA lança: banco fora vale "sem chave neste degrau" (ou, para o resumo do ambiente,
 *     o piso intacto);
 *   - `ambienteComAsChavesDoPainel` troca só as três chaves, só quando o banco tem linha, e não suja a
 *     fonte recebida.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const leitor = vi.hoisted(() => ({
  valorDaInstalacao: vi.fn(),
}));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: leitor.valorDaInstalacao }));

import {
  ambienteComAsChavesDoPainel,
  chaveDeIaDaInstalacao,
  chavesDeIaDaInstalacao,
} from "@/lib/ai/chaves-da-instalacao";
import { lerAmbiente } from "@/lib/instalacao/ambiente";

type Fonte = "banco" | "ambiente" | "ausente";

/** Define o que o resolvedor devolve para cada chave; o que não está na tabela é "ausente". */
function instalacaoComo(tabela: Record<string, { valor: string | null; fonte: Fonte }>) {
  leitor.valorDaInstalacao.mockImplementation(async (chave: string) => {
    return tabela[chave] ?? { valor: null, fonte: "ausente" as Fonte };
  });
}

beforeEach(() => {
  leitor.valorDaInstalacao.mockReset();
  instalacaoComo({});
});

describe("chavesDeIaDaInstalacao / chaveDeIaDaInstalacao", () => {
  it("⭐ devolve as três chaves em vigor, cada uma pelo seu nome", async () => {
    instalacaoComo({
      ANTHROPIC_API_KEY: { valor: "sk-ant-x", fonte: "banco" },
      OPENAI_API_KEY: { valor: "sk-proj-y", fonte: "ambiente" },
      OPENROUTER_API_KEY: { valor: "sk-or-z", fonte: "banco" },
    });
    expect(await chavesDeIaDaInstalacao()).toEqual({
      anthropic: "sk-ant-x",
      openai: "sk-proj-y",
      openrouter: "sk-or-z",
    });
    expect(await chaveDeIaDaInstalacao("anthropic")).toBe("sk-ant-x");
    expect(await chaveDeIaDaInstalacao("openai")).toBe("sk-proj-y");
    expect(await chaveDeIaDaInstalacao("openrouter")).toBe("sk-or-z");
  });

  it("chave ausente vale null, e espaço em volta é aparado", async () => {
    instalacaoComo({ OPENAI_API_KEY: { valor: "  sk-proj-y \n", fonte: "banco" } });
    expect(await chavesDeIaDaInstalacao()).toEqual({ anthropic: null, openai: "sk-proj-y", openrouter: null });
  });

  it("chave só de espaços não conta como chave", async () => {
    instalacaoComo({ ANTHROPIC_API_KEY: { valor: "   ", fonte: "banco" } });
    expect(await chaveDeIaDaInstalacao("anthropic")).toBeNull();
  });

  it("⭐ a leitura nunca lança: banco fora vale 'sem chave neste degrau'", async () => {
    leitor.valorDaInstalacao.mockRejectedValue(new Error("boom"));
    expect(await chavesDeIaDaInstalacao()).toEqual({ anthropic: null, openai: null, openrouter: null });
    expect(await chaveDeIaDaInstalacao("openrouter")).toBeNull();
  });
});

describe("ambienteComAsChavesDoPainel", () => {
  it("⭐ chave que só existe no painel passa a contar para o resumo do ambiente", async () => {
    instalacaoComo({ ANTHROPIC_API_KEY: { valor: "sk-ant-so-no-painel", fonte: "banco" } });
    const sem = lerAmbiente({});
    expect(sem.chavesDeProvedor.anthropic).toBe(false);

    const com = lerAmbiente(await ambienteComAsChavesDoPainel({}));
    expect(com.chavesDeProvedor.anthropic).toBe(true);
    expect(com.chavesDeProvedor.openai).toBe(false);
  });

  it("o painel vence o .env, e sem linha o .env segue valendo (é o piso)", async () => {
    instalacaoComo({
      ANTHROPIC_API_KEY: { valor: "sk-ant-do-painel", fonte: "banco" },
      OPENAI_API_KEY: { valor: "sk-proj-do-env", fonte: "ambiente" },
    });
    const saida = await ambienteComAsChavesDoPainel({
      ANTHROPIC_API_KEY: "sk-ant-do-env",
      OPENAI_API_KEY: "sk-proj-do-env",
      OPENROUTER_API_KEY: "sk-or-do-env",
    });
    expect(saida.ANTHROPIC_API_KEY).toBe("sk-ant-do-painel");
    expect(saida.OPENAI_API_KEY).toBe("sk-proj-do-env");
    // Sem nenhuma linha no banco: o resolvedor diz "ambiente"/"ausente" e a fonte recebida não muda.
    expect(saida.OPENROUTER_API_KEY).toBe("sk-or-do-env");
  });

  it("linha do banco sem valor vence o .env (é o que o motor também decide)", async () => {
    instalacaoComo({ OPENAI_API_KEY: { valor: null, fonte: "banco" } });
    const saida = await ambienteComAsChavesDoPainel({ OPENAI_API_KEY: "sk-proj-do-env" });
    expect(saida.OPENAI_API_KEY).toBe("");
    expect(lerAmbiente(saida).chavesDeProvedor.openai).toBe(false);
  });

  it("não suja a fonte recebida e não mexe nas outras variáveis", async () => {
    instalacaoComo({ ANTHROPIC_API_KEY: { valor: "sk-ant-do-painel", fonte: "banco" } });
    const base = { ANTHROPIC_API_KEY: "sk-ant-do-env", AI_GATEWAY_API_KEY: "gw", SMTP_HOST: "smtp.example.com" };
    const saida = await ambienteComAsChavesDoPainel(base);
    expect(base.ANTHROPIC_API_KEY).toBe("sk-ant-do-env");
    expect(saida.AI_GATEWAY_API_KEY).toBe("gw");
    expect(saida.SMTP_HOST).toBe("smtp.example.com");
  });

  it("⭐ banco fora não derruba a tela: devolve o piso intacto", async () => {
    leitor.valorDaInstalacao.mockRejectedValue(new Error("boom"));
    const saida = await ambienteComAsChavesDoPainel({ OPENAI_API_KEY: "sk-proj-do-env" });
    expect(saida.OPENAI_API_KEY).toBe("sk-proj-do-env");
  });
});
