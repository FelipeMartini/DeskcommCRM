import { describe, expect, it, vi } from "vitest";

import { casarCampanha, type CampanhaWhatsapp } from "./campanha";
import {
  MAX_CAMPANHAS,
  campanhasEntradaSchema,
  canaisForaDaOrganizacao,
  contarDescartadas,
  gravarCampanhas,
} from "./campanha-gravacao";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const OUTRO_CANAL = "33333333-3333-4333-8333-333333333333";
/** Espaço comum, espaço inseparável (160) e tabulação: tudo o que `\s` colapsa. */
const ESPACOS_COMUNS_E_INSEPARAVEIS = [
  "   ",
  String.fromCharCode(160),
  String.fromCharCode(9),
  "   ",
].join("");

function campanha(sobre: Partial<CampanhaWhatsapp> = {}): CampanhaWhatsapp {
  return {
    id: "lancamento",
    label: "Lançamento",
    match: { tipo: "contains", valor: "quero saber mais sobre o lançamento" },
    ...sobre,
  };
}

describe("campanhasEntradaSchema", () => {
  it("aceita uma lista válida, vazia inclusive (apagar todas é um gesto legítimo)", () => {
    expect(campanhasEntradaSchema.safeParse({ campanhas: [campanha()] }).success).toBe(true);
    expect(campanhasEntradaSchema.safeParse({ campanhas: [] }).success).toBe(true);
  });

  it("devolve `agent_id` e `segmento` como vieram (a tela não os edita, mas não os apaga)", () => {
    const agente = "44444444-4444-4444-8444-444444444444";
    const r = campanhasEntradaSchema.safeParse({
      campanhas: [campanha({ agent_id: agente, segmento: "incorporadoras" })],
    });
    expect(r.success && r.data.campanhas[0]).toMatchObject({
      agent_id: agente,
      segmento: "incorporadoras",
    });
  });

  it.each([
    [{ campanhas: [campanha({ id: "a" }), campanha({ id: "a" })] }, "id repetido"],
    [
      { campanhas: [campanha({ match: { tipo: "contains", valor: "  a  " } })] },
      "frase que normaliza para 1 caractere",
    ],
    [
      {
        campanhas: [
          campanha({ match: { tipo: "contains", valor: ESPACOS_COMUNS_E_INSEPARAVEIS } }),
        ],
      },
      "frase só de espaços",
    ],
    [
      { campanhas: [campanha({ match: { tipo: "regex" as never, valor: "quero saber" } })] },
      "tipo que o motor não conhece (nada de regex)",
    ],
    [{ campanhas: [campanha({ id: "" })] }, "id vazio"],
    [{ campanhas: [campanha({ channel_session_id: "nao-e-uuid" })] }, "canal que não é uuid"],
    [
      { campanhas: Array.from({ length: MAX_CAMPANHAS + 1 }, (_, i) => campanha({ id: `c${i}` })) },
      "mais que o teto",
    ],
    [{ campanhas: [campanha()], organization_id: ORG }, "organização passada pelo corpo (strict)"],
    [{}, "sem a lista"],
  ])("recusa %# (%s)", (corpo, _motivo) => {
    expect(campanhasEntradaSchema.safeParse(corpo).success).toBe(false);
  });

  it("a frase cadastrada nunca casa uma mensagem que não a contém: o piso protege o `casarCampanha`", () => {
    // `"  abc  "` tem 3 caracteres normalizados e passa; `"  ab  "` não.
    const ok = campanhasEntradaSchema.safeParse({
      campanhas: [campanha({ match: { tipo: "contains", valor: "  abc  " } })],
    });
    expect(ok.success).toBe(true);
    expect(
      casarCampanha(
        "xxx abc yyy",
        [campanha({ match: { tipo: "contains", valor: "  abc  " } })],
        CANAL,
      ),
    ).not.toBeNull();
    expect(
      campanhasEntradaSchema.safeParse({
        campanhas: [campanha({ match: { tipo: "contains", valor: "  ab  " } })],
      }).success,
    ).toBe(false);
  });

  it("o acento não conta para o piso (`áé` normaliza para `ae`, 2 caracteres)", () => {
    expect(
      campanhasEntradaSchema.safeParse({
        campanhas: [campanha({ match: { tipo: "contains", valor: "  áé " } })],
      }).success,
    ).toBe(false);
  });
});

describe("contarDescartadas", () => {
  it("conta o que o motor ignora por malformado", () => {
    expect(contarDescartadas({ campanhas_whatsapp: [campanha(), { id: "sem-match" }, 42] })).toBe(
      2,
    );
  });

  it.each([
    [null],
    [{}],
    ["texto"],
    [{ campanhas_whatsapp: "não é lista" }],
    [{ campanhas_whatsapp: [] }],
  ])("settings %j → 0", (settings) => {
    expect(contarDescartadas(settings)).toBe(0);
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

describe("gravarCampanhas — lê, mescla e grava", () => {
  it("grava a lista sem tocar nas outras chaves do settings", async () => {
    const settings = {
      branding: { cor: "#123456" },
      contatos_pessoais: { comando_pelo_celular: true },
    };
    const { db, gravacoes } = adminComOrganizacao(settings);

    const r = await gravarCampanhas(db, ORG, [campanha()]);

    expect(r).toMatchObject({ ok: true, alterado: true, campanhas: [campanha()] });
    expect(gravacoes).toHaveLength(1);
    expect(gravacoes[0]!.settings).toEqual({ ...settings, campanhas_whatsapp: [campanha()] });
  });

  it("diz o que mudou: adicionada, removida e editada (por id)", async () => {
    const antes = [campanha({ id: "a" }), campanha({ id: "b" }), campanha({ id: "c" })];
    const { db } = adminComOrganizacao({ campanhas_whatsapp: antes });

    const r = await gravarCampanhas(db, ORG, [
      campanha({ id: "a" }),
      campanha({ id: "b", label: "Outro nome" }),
      campanha({ id: "d" }),
    ]);

    expect(r).toMatchObject({
      ok: true,
      alterado: true,
      diferenca: { adicionadas: ["d"], removidas: ["c"], editadas: ["b"] },
    });
  });

  it("pedir a lista que já vale não escreve nada", async () => {
    const { db, gravacoes } = adminComOrganizacao({ campanhas_whatsapp: [campanha()] });
    const r = await gravarCampanhas(db, ORG, [campanha()]);
    expect(r).toMatchObject({ ok: true, alterado: false });
    expect(gravacoes).toEqual([]);
  });

  it("trocar a ordem é mudança (a primeira que casa vence)", async () => {
    const a = campanha({ id: "a" });
    const b = campanha({ id: "b" });
    const { db, gravacoes } = adminComOrganizacao({ campanhas_whatsapp: [a, b] });
    const r = await gravarCampanhas(db, ORG, [b, a]);
    expect(r).toMatchObject({ ok: true, alterado: true });
    expect(gravacoes[0]!.settings.campanhas_whatsapp).toEqual([b, a]);
  });

  it("limpar item malformado do jsonb grava, mesmo que a lista válida seja a mesma", async () => {
    const { db, gravacoes } = adminComOrganizacao({
      campanhas_whatsapp: [campanha(), { id: "quebrada" }],
    });
    const r = await gravarCampanhas(db, ORG, [campanha()]);
    expect(r).toMatchObject({ ok: true, alterado: true });
    expect(gravacoes[0]!.settings.campanhas_whatsapp).toEqual([campanha()]);
  });

  it("apagar todas grava a lista vazia", async () => {
    const { db, gravacoes } = adminComOrganizacao({ campanhas_whatsapp: [campanha()] });
    const r = await gravarCampanhas(db, ORG, []);
    expect(r).toMatchObject({ ok: true, alterado: true, campanhas: [] });
    expect(gravacoes[0]!.settings.campanhas_whatsapp).toEqual([]);
  });

  it("toda consulta é presa à organização pelo id (a única cerca do service role)", async () => {
    const { db, filtros } = adminComOrganizacao({});
    await gravarCampanhas(db, ORG, [campanha()]);
    expect(filtros).toEqual([
      ["id", ORG],
      ["id", ORG],
    ]);
  });

  it("settings nulo vira objeto vazio, não erro", async () => {
    const { db, gravacoes } = adminComOrganizacao(null);
    const r = await gravarCampanhas(db, ORG, [campanha()]);
    expect(r).toMatchObject({ ok: true, alterado: true });
    expect(gravacoes[0]!.settings).toEqual({ campanhas_whatsapp: [campanha()] });
  });

  it.each([["erro"], ["ausente"]] as const)(
    "leitura %s → `leitura_falhou` e nada é gravado",
    async (leitura) => {
      const { db, gravacoes } = adminComOrganizacao({}, { leitura });
      await expect(gravarCampanhas(db, ORG, [campanha()])).resolves.toEqual({
        ok: false,
        motivo: "leitura_falhou",
      });
      expect(gravacoes).toEqual([]);
    },
  );

  it.each([["erro"], ["zero"]] as const)(
    "escrita %s → `escrita_recusada` (zero linha é sucesso no PostgREST e não pode passar por gravado)",
    async (escrita) => {
      const { db } = adminComOrganizacao({}, { escrita });
      await expect(gravarCampanhas(db, ORG, [campanha()])).resolves.toEqual({
        ok: false,
        motivo: "escrita_recusada",
      });
    },
  );
});

describe("canaisForaDaOrganizacao", () => {
  function adminDeCanais(daOrganizacao: string[], erro = false) {
    const filtros: Array<[string, unknown]> = [];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return q;
    };
    q.in = async (coluna: string, valores: string[]) => {
      filtros.push([coluna, valores]);
      return erro
        ? { data: null, error: { message: "falhou" } }
        : {
            data: valores.filter((v) => daOrganizacao.includes(v)).map((id) => ({ id })),
            error: null,
          };
    };
    return { db: { from: vi.fn(() => q) } as never, filtros };
  }

  it("sem campanha presa a canal nem consulta o banco", async () => {
    const { db } = adminDeCanais([]);
    await expect(canaisForaDaOrganizacao(db, ORG, [campanha()])).resolves.toEqual([]);
    expect((db as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled();
  });

  it("devolve só os ids que NÃO são da organização, sem repetir", async () => {
    const { db, filtros } = adminDeCanais([CANAL]);
    const r = await canaisForaDaOrganizacao(db, ORG, [
      campanha({ id: "a", channel_session_id: CANAL }),
      campanha({ id: "b", channel_session_id: OUTRO_CANAL }),
      campanha({ id: "c", channel_session_id: OUTRO_CANAL }),
    ]);
    expect(r).toEqual([OUTRO_CANAL]);
    expect(filtros).toContainEqual(["organization_id", ORG]);
  });

  it("leitura que falhou → `null` (quem chama recusa a gravação)", async () => {
    const { db } = adminDeCanais([], true);
    await expect(
      canaisForaDaOrganizacao(db, ORG, [campanha({ channel_session_id: CANAL })]),
    ).resolves.toBeNull();
  });
});
