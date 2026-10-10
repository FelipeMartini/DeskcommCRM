import { describe, expect, it, vi } from "vitest";

import {
  CONFIG_PESSOAL_PADRAO,
  configPessoalMudancaSchema,
  gravarConfigPessoal,
  lerConfigPessoal,
} from "./configuracao-pessoal";

const ORG = "11111111-1111-4111-8111-111111111111";

describe("lerConfigPessoal — padrão desligado, e só `true` liga", () => {
  it.each([
    [null],
    [undefined],
    [{}],
    ["texto"],
    [42],
    [[]],
    [{ contatos_pessoais: null }],
    [{ contatos_pessoais: [] }],
  ])("settings %j → tudo desligado", (settings) => {
    expect(lerConfigPessoal(settings)).toEqual(CONFIG_PESSOAL_PADRAO);
  });

  it.each([["true"], [1], ["sim"], [{}], [null]])("valor %j não liga (fail-closed)", (valor) => {
    expect(
      lerConfigPessoal({
        contatos_pessoais: { comando_pelo_celular: valor, novos_nascem_pessoais: valor },
      }),
    ).toEqual({ comando_pelo_celular: false, novos_nascem_pessoais: false });
  });

  it("`true` liga cada interruptor de forma independente", () => {
    expect(lerConfigPessoal({ contatos_pessoais: { comando_pelo_celular: true } })).toEqual({
      comando_pelo_celular: true,
      novos_nascem_pessoais: false,
    });
    expect(lerConfigPessoal({ contatos_pessoais: { novos_nascem_pessoais: true } })).toEqual({
      comando_pelo_celular: false,
      novos_nascem_pessoais: true,
    });
  });

  it("o padrão exportado não pode ser mutado por quem o importa", () => {
    expect(Object.isFrozen(CONFIG_PESSOAL_PADRAO)).toBe(true);
  });
});

describe("configPessoalMudancaSchema", () => {
  it("aceita um dos dois campos, ou os dois", () => {
    expect(configPessoalMudancaSchema.safeParse({ comando_pelo_celular: true }).success).toBe(true);
    expect(configPessoalMudancaSchema.safeParse({ novos_nascem_pessoais: false }).success).toBe(
      true,
    );
    expect(
      configPessoalMudancaSchema.safeParse({
        comando_pelo_celular: true,
        novos_nascem_pessoais: true,
      }).success,
    ).toBe(true);
  });

  it.each([
    [{}, "vazio"],
    [{ comando_pelo_celular: "true" }, "texto no lugar de booleano"],
    [{ comando_pelo_celular: true, extra: 1 }, "campo desconhecido (strict)"],
    [{ organization_id: ORG }, "tentativa de passar a organização pelo corpo"],
  ])("recusa %j (%s)", (corpo, _motivo) => {
    expect(configPessoalMudancaSchema.safeParse(corpo).success).toBe(false);
  });
});

/** Admin de mentira com UMA organização: guarda o que foi gravado e o filtro de id. */
function adminComOrganizacao(
  settings: unknown,
  opcoes: { leitura?: "erro" | "ausente"; escrita?: "erro" | "zero" } = {},
) {
  const gravacoes: Array<{ settings: Record<string, unknown> }> = [];
  const filtros: Array<[string, unknown]> = [];
  const from = vi.fn(() => {
    let modo: "select" | "update" = "select";
    let patch: { settings: Record<string, unknown> } | null = null;
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.update = (p: { settings: Record<string, unknown> }) => {
      modo = "update";
      patch = p;
      return q;
    };
    q.eq = (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return q;
    };
    q.maybeSingle = async () => {
      if (modo === "select") {
        if (opcoes.leitura === "erro") return { data: null, error: { message: "falhou" } };
        if (opcoes.leitura === "ausente") return { data: null, error: null };
        return { data: { settings }, error: null };
      }
      if (opcoes.escrita === "erro") return { data: null, error: { message: "recusado" } };
      if (opcoes.escrita === "zero") return { data: null, error: null };
      gravacoes.push(patch!);
      return { data: { settings: patch!.settings }, error: null };
    };
    return q;
  });
  return { db: { from } as never, gravacoes, filtros };
}

describe("gravarConfigPessoal — lê, mescla e grava", () => {
  it("liga um interruptor sem tocar nas outras chaves do settings", async () => {
    const settings = {
      branding: { cor: "#123456" },
      jev: { ligado: true },
      ai_dispatch_mode: "auto",
    };
    const { db, gravacoes } = adminComOrganizacao(settings);

    const r = await gravarConfigPessoal(db, ORG, { comando_pelo_celular: true });

    expect(r).toEqual({
      ok: true,
      alterado: true,
      config: { comando_pelo_celular: true, novos_nascem_pessoais: false },
    });
    expect(gravacoes).toHaveLength(1);
    expect(gravacoes[0]!.settings).toMatchObject({
      branding: { cor: "#123456" },
      jev: { ligado: true },
      ai_dispatch_mode: "auto",
      contatos_pessoais: { comando_pelo_celular: true, novos_nascem_pessoais: false },
    });
  });

  it("o campo que não veio fica como estava, e as chaves desconhecidas do bloco sobrevivem", async () => {
    const settings = {
      contatos_pessoais: { novos_nascem_pessoais: true, de_uma_versao_futura: "x" },
    };
    const { db, gravacoes } = adminComOrganizacao(settings);

    const r = await gravarConfigPessoal(db, ORG, { comando_pelo_celular: true });

    expect(r).toMatchObject({
      ok: true,
      config: { comando_pelo_celular: true, novos_nascem_pessoais: true },
    });
    expect(gravacoes[0]!.settings.contatos_pessoais).toEqual({
      novos_nascem_pessoais: true,
      de_uma_versao_futura: "x",
      comando_pelo_celular: true,
    });
  });

  it("pedir o estado que já vale não escreve nada", async () => {
    const { db, gravacoes } = adminComOrganizacao({
      contatos_pessoais: { comando_pelo_celular: true },
    });
    const r = await gravarConfigPessoal(db, ORG, { comando_pelo_celular: true });
    expect(r).toMatchObject({ ok: true, alterado: false });
    expect(gravacoes).toEqual([]);
  });

  it("desligar também grava", async () => {
    const { db, gravacoes } = adminComOrganizacao({
      contatos_pessoais: { novos_nascem_pessoais: true },
    });
    const r = await gravarConfigPessoal(db, ORG, { novos_nascem_pessoais: false });
    expect(r).toMatchObject({ ok: true, alterado: true, config: { novos_nascem_pessoais: false } });
    expect(gravacoes).toHaveLength(1);
  });

  it("toda consulta é presa à organização pelo id (a única cerca do service role)", async () => {
    const { db, filtros } = adminComOrganizacao({});
    await gravarConfigPessoal(db, ORG, { comando_pelo_celular: true });
    expect(filtros).toEqual([
      ["id", ORG],
      ["id", ORG],
    ]);
  });

  it("settings nulo vira objeto vazio, não erro", async () => {
    const { db, gravacoes } = adminComOrganizacao(null);
    const r = await gravarConfigPessoal(db, ORG, { novos_nascem_pessoais: true });
    expect(r).toMatchObject({ ok: true, alterado: true });
    expect(gravacoes[0]!.settings).toEqual({
      contatos_pessoais: { comando_pelo_celular: false, novos_nascem_pessoais: true },
    });
  });

  it.each([["erro"], ["ausente"]] as const)("leitura %s → `leitura_falhou`", async (leitura) => {
    const { db, gravacoes } = adminComOrganizacao({}, { leitura });
    await expect(gravarConfigPessoal(db, ORG, { comando_pelo_celular: true })).resolves.toEqual({
      ok: false,
      motivo: "leitura_falhou",
    });
    expect(gravacoes).toEqual([]);
  });

  it.each([["erro"], ["zero"]] as const)(
    "escrita %s → `escrita_recusada` (zero linha é sucesso no PostgREST e não pode passar por gravado)",
    async (escrita) => {
      const { db } = adminComOrganizacao({}, { escrita });
      await expect(gravarConfigPessoal(db, ORG, { comando_pelo_celular: true })).resolves.toEqual({
        ok: false,
        motivo: "escrita_recusada",
      });
    },
  );
});
