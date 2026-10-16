/**
 * O MOTOR LÊ A CONFIGURAÇÃO DA INSTALAÇÃO (`lib/instalacao/config-sql.ts`).
 *
 * O worker responde às mensagens e não passa pelo cliente do Supabase: sem este leitor, o endereço e a
 * chave que o administrador digitou em Credenciais ficariam no banco e o motor seguiria no `.env`, com a
 * tela dizendo "salvo". Aqui se prova que ele decide pela MESMA regra do app (`resolver`):
 *
 *   - linha no banco vence o `.env`, e uma linha esvaziada pela tela vence também (responde "sem valor");
 *   - sem linha, o `.env` do motor (o piso) responde;
 *   - segredo é aberto do envelope; envelope que não abre cai no piso, sem lançar e sem vazar o valor;
 *   - banco fora do ar ou tabela ausente nunca derruba o turno;
 *   - o resultado tem EXATAMENTE as chaves pedidas, numa única ida ao banco.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aes = vi.hoisted(() => ({ decrypt: vi.fn() }));
vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: (v: unknown) => Buffer.from(String(v)),
  decryptKey: aes.decrypt,
}));

import { valoresDaInstalacaoNoMotor } from "@/lib/instalacao/config-sql";

const CHAVES = ["OMNIROUTER_BASE_URL", "OMNIROUTER_API_KEY", "OMNIROUTER_PARA_TODAS"] as const;

function linha(chave: string, extra: Record<string, unknown> = {}) {
  return {
    chave,
    valor: null as string | null,
    ciphertext: null,
    iv: null,
    tag: null,
    eh_segredo: false,
    semeado_do_env: false,
    ...extra,
  };
}

function pool(resposta: unknown | "lancar") {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => {
    if (resposta === "lancar") throw new Error("relation platform_config does not exist");
    return resposta as { rows: unknown[] };
  });
  return { db: { query } as never, query };
}

beforeEach(() => {
  aes.decrypt.mockReset();
  aes.decrypt.mockReturnValue("segredo-aberto-sintetico");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("valoresDaInstalacaoNoMotor — banco primeiro, `.env` como piso", () => {
  it("⭐ uma única consulta para todas as chaves, e o resultado tem EXATAMENTE as chaves pedidas", async () => {
    const { db, query } = pool({ rows: [] });
    const saida = await valoresDaInstalacaoNoMotor(db, CHAVES, {});
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![1]).toEqual([[...CHAVES]]);
    expect(Object.keys(saida).sort()).toEqual([...CHAVES].sort());
    expect(Object.values(saida).every((v) => v === null)).toBe(true);
  });

  it("sem linha no banco, o `.env` do motor responde (e espaço em branco vale como vazio)", async () => {
    const { db } = pool({ rows: [] });
    const saida = await valoresDaInstalacaoNoMotor(db, CHAVES, {
      OMNIROUTER_BASE_URL: "http://omnirouter:20128",
      OMNIROUTER_API_KEY: "   ",
    });
    expect(saida).toEqual({
      OMNIROUTER_BASE_URL: "http://omnirouter:20128",
      OMNIROUTER_API_KEY: null,
      OMNIROUTER_PARA_TODAS: null,
    });
  });

  it("⭐ linha no banco VENCE o `.env`", async () => {
    const { db } = pool({
      rows: [linha("OMNIROUTER_BASE_URL", { valor: "https://omni-do-painel.exemplo.com" })],
    });
    const saida = await valoresDaInstalacaoNoMotor(db, CHAVES, {
      OMNIROUTER_BASE_URL: "http://omnirouter:20128",
    });
    expect(saida.OMNIROUTER_BASE_URL).toBe("https://omni-do-painel.exemplo.com");
  });

  it("⭐ linha esvaziada pela tela (valor nulo) vence o `.env` e responde 'sem valor'", async () => {
    const { db } = pool({ rows: [linha("OMNIROUTER_BASE_URL", { valor: null })] });
    const saida = await valoresDaInstalacaoNoMotor(db, CHAVES, {
      OMNIROUTER_BASE_URL: "http://omnirouter:20128",
    });
    expect(saida.OMNIROUTER_BASE_URL).toBeNull();
  });

  it("segredo: abre o envelope e devolve em claro", async () => {
    const { db } = pool({
      rows: [
        linha("OMNIROUTER_API_KEY", {
          eh_segredo: true,
          ciphertext: "c",
          iv: "i",
          tag: "t",
        }),
      ],
    });
    const saida = await valoresDaInstalacaoNoMotor(db, CHAVES, {});
    expect(saida.OMNIROUTER_API_KEY).toBe("segredo-aberto-sintetico");
    expect(aes.decrypt).toHaveBeenCalledTimes(1);
  });

  it("⭐ envelope que não abre: não lança, não vaza o valor no log e a linha responde 'sem valor'", async () => {
    aes.decrypt.mockImplementation(() => {
      throw new Error("Unsupported state or unable to authenticate data");
    });
    const { db } = pool({
      rows: [
        linha("OMNIROUTER_API_KEY", {
          eh_segredo: true,
          ciphertext: "valor-cifrado-sintetico",
          iv: "i",
          tag: "t",
        }),
      ],
    });
    const saida = await valoresDaInstalacaoNoMotor(db, CHAVES, {
      OMNIROUTER_API_KEY: "chave-do-env",
    });
    // A linha existe e vence o `.env` (é a escolha de quem gravou), mas sem valor legível.
    expect(saida.OMNIROUTER_API_KEY).toBeNull();
    const log = JSON.stringify((console.warn as ReturnType<typeof vi.fn>).mock.calls);
    expect(log).toContain("OMNIROUTER_API_KEY");
    expect(log).not.toContain("valor-cifrado-sintetico");
  });

  it("segredo sem envelope completo vale 'sem valor'", async () => {
    const { db } = pool({
      rows: [linha("OMNIROUTER_API_KEY", { eh_segredo: true, ciphertext: "c", iv: null, tag: "t" })],
    });
    const saida = await valoresDaInstalacaoNoMotor(db, CHAVES, {});
    expect(saida.OMNIROUTER_API_KEY).toBeNull();
    expect(aes.decrypt).not.toHaveBeenCalled();
  });
});

describe("valoresDaInstalacaoNoMotor — nunca derruba o turno", () => {
  it("⭐ banco fora do ar ou tabela ausente: o piso responde", async () => {
    const { db } = pool("lancar");
    const saida = await valoresDaInstalacaoNoMotor(db, CHAVES, {
      OMNIROUTER_BASE_URL: "http://omnirouter:20128",
    });
    expect(saida).toEqual({
      OMNIROUTER_BASE_URL: "http://omnirouter:20128",
      OMNIROUTER_API_KEY: null,
      OMNIROUTER_PARA_TODAS: null,
    });
    expect(console.warn).toHaveBeenCalled();
  });

  it.each([
    ["resposta sem `rows`", {}],
    ["`rows` que não é lista", { rows: "x" }],
    ["resposta nula", null],
    ["resposta indefinida", undefined],
  ])("duplo de teste malformado (%s) vale 'sem linhas'", async (_nome, resposta) => {
    const { db } = pool(resposta);
    const saida = await valoresDaInstalacaoNoMotor(db, CHAVES, { OMNIROUTER_PARA_TODAS: "true" });
    expect(saida.OMNIROUTER_PARA_TODAS).toBe("true");
  });

  it("lista de chaves vazia devolve objeto vazio", async () => {
    const { db } = pool({ rows: [] });
    expect(await valoresDaInstalacaoNoMotor(db, [], {})).toEqual({});
  });
});
