import { describe, expect, it } from "vitest";

import {
  PISO_DO_PRAZO_DA_ORGANIZACAO,
  PRAZO_MAXIMO_EM_DIAS,
  TIPOS_DE_PRAZO_DA_ORGANIZACAO,
  chaveDoPrazo,
  lerPrazosDaOrganizacao,
  prazoSemEfeito,
  prazosParaGravar,
  validarPrazosDaOrganizacao,
} from "@/lib/retencao/prazos-da-organizacao";
import {
  podarPorOrganizacao,
  type PodaPorOrganizacaoDb,
} from "@/lib/retencao/poda-por-organizacao";

/**
 * O PRAZO DE RETENÇÃO POR ORGANIZAÇÃO — a regra pura e a passada do cron
 * (migration 0695; modelo MISTO, etapas 2 e 3).
 *
 * O que o banco apaga — e o que ele se recusa a apagar — é medido contra um
 * Postgres real; aqui a régua é a regra: o que vale do `settings`, o que a tela
 * pode gravar, e o laço de lotes da passada (para no lote incompleto, tem teto,
 * diz que sobrou, e uma organização torta não derruba as outras).
 */

const ORG_A = "a0000000-0000-0000-0000-00000000000a";
const ORG_B = "b0000000-0000-0000-0000-00000000000b";

describe("lerPrazosDaOrganizacao — o que o banco enxerga em settings.retencao", () => {
  it("lê um inteiro e o eleva ao piso (a mesma regra do SQL)", () => {
    const lidos = lerPrazosDaOrganizacao({
      retencao: {
        captacao_dias: 40,
        conversa_do_caso_dias: 100,
        prospeccao_dias: 20, // abaixo do piso (90) → elevado
        espelho_da_agenda_dias: 10,
      },
    });
    expect(lidos).toEqual({
      captacao: 40,
      conversa_do_caso: 100,
      prospeccao: PISO_DO_PRAZO_DA_ORGANIZACAO.prospeccao,
      espelho_da_agenda: 10,
    });
  });

  it("aceita texto de dígitos, como o SQL (`#>>` devolve texto)", () => {
    expect(lerPrazosDaOrganizacao({ retencao: { captacao_dias: "50" } })).toEqual({ captacao: 50 });
  });

  it("ignora o que não é inteiro de até 5 dígitos: vale o global", () => {
    const lidos = lerPrazosDaOrganizacao({
      retencao: {
        captacao_dias: "abc",
        conversa_do_caso_dias: -5,
        prospeccao_dias: 90.5,
        espelho_da_agenda_dias: 1_000_000,
      },
    });
    expect(lidos).toEqual({});
  });

  it("ignora chave de tipo global e entradas tortas, sem lançar", () => {
    expect(lerPrazosDaOrganizacao({ retencao: { auditoria_dias: 400 } })).toEqual({});
    expect(lerPrazosDaOrganizacao({ retencao: [1, 2] })).toEqual({});
    expect(lerPrazosDaOrganizacao({ retencao: "x" })).toEqual({});
    expect(lerPrazosDaOrganizacao({})).toEqual({});
    expect(lerPrazosDaOrganizacao(null)).toEqual({});
    expect(lerPrazosDaOrganizacao("settings")).toEqual({});
  });

  it("o teto de dígitos é 99999, igual ao SQL", () => {
    expect(PRAZO_MAXIMO_EM_DIAS).toBe(99_999);
    expect(lerPrazosDaOrganizacao({ retencao: { captacao_dias: 99_999 } })).toEqual({
      captacao: 99_999,
    });
    expect(lerPrazosDaOrganizacao({ retencao: { captacao_dias: 100_000 } })).toEqual({});
  });
});

describe("validarPrazosDaOrganizacao — o que a tela pode gravar", () => {
  it("aceita o estado desejado e herda o que vem vazio", () => {
    const r = validarPrazosDaOrganizacao({
      captacao: 60,
      conversa_do_caso: null,
      prospeccao: "",
      espelho_da_agenda: "14",
    });
    expect(r).toEqual({ ok: true, prazos: { captacao: 60, espelho_da_agenda: 14 } });
  });

  it("recusa abaixo do piso, dizendo qual é", () => {
    const r = validarPrazosDaOrganizacao({ captacao: 10 });
    expect(r).toEqual({
      ok: false,
      recusas: [
        { tipo: "captacao", motivo: "abaixo_do_piso", piso: PISO_DO_PRAZO_DA_ORGANIZACAO.captacao },
      ],
    });
  });

  it("o piso exato passa; um a menos não", () => {
    for (const tipo of TIPOS_DE_PRAZO_DA_ORGANIZACAO) {
      const piso = PISO_DO_PRAZO_DA_ORGANIZACAO[tipo];
      expect(validarPrazosDaOrganizacao({ [tipo]: piso }).ok).toBe(true);
      expect(validarPrazosDaOrganizacao({ [tipo]: piso - 1 }).ok).toBe(false);
    }
  });

  it("recusa tipo desconhecido, decimal, negativo, texto e valor enorme", () => {
    const motivos = (entrada: unknown) => {
      const r = validarPrazosDaOrganizacao(entrada);
      return r.ok ? [] : r.recusas.map((x) => x.motivo);
    };
    expect(motivos({ auditoria: 400 })).toEqual(["tipo_desconhecido"]);
    expect(motivos({ captacao: 60.5 })).toEqual(["nao_e_inteiro"]);
    expect(motivos({ captacao: -60 })).toEqual(["nao_e_inteiro"]);
    expect(motivos({ captacao: "sessenta" })).toEqual(["nao_e_inteiro"]);
    expect(motivos({ captacao: 100_000 })).toEqual(["acima_do_maximo"]);
    expect(motivos({ captacao: "100000" })).toEqual(["acima_do_maximo"]);
    expect(motivos([1, 2])).toEqual(["nao_e_inteiro"]);
    expect(motivos(null)).toEqual(["nao_e_inteiro"]);
  });

  it("junta todas as recusas, não só a primeira", () => {
    const r = validarPrazosDaOrganizacao({ captacao: 1, prospeccao: 1, auditoria: 9 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.recusas).toHaveLength(3);
  });

  it("valor acima do global NÃO é recusa: só não tem efeito", () => {
    expect(validarPrazosDaOrganizacao({ captacao: 500 }).ok).toBe(true);
    expect(prazoSemEfeito(500, 365)).toBe(true);
    expect(prazoSemEfeito(365, 365)).toBe(true);
    expect(prazoSemEfeito(364, 365)).toBe(false);
  });
});

describe("prazosParaGravar e chaveDoPrazo", () => {
  it("monta o objeto que a função do banco espera, na ordem dos tipos", () => {
    expect(prazosParaGravar({ prospeccao: 120, captacao: 40 })).toEqual({
      captacao_dias: 40,
      prospeccao_dias: 120,
    });
    expect(Object.keys(prazosParaGravar({ prospeccao: 120, captacao: 40 }))).toEqual([
      "captacao_dias",
      "prospeccao_dias",
    ]);
    expect(prazosParaGravar({})).toEqual({});
  });

  it("o que a tela grava, a leitura devolve igual (ida e volta)", () => {
    const v = validarPrazosDaOrganizacao({ captacao: 45, espelho_da_agenda: 9 });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(lerPrazosDaOrganizacao({ retencao: prazosParaGravar(v.prazos) })).toEqual(v.prazos);
    }
    for (const tipo of TIPOS_DE_PRAZO_DA_ORGANIZACAO)
      expect(chaveDoPrazo(tipo)).toBe(`${tipo}_dias`);
  });
});

/** Um banco de mentira que devolve, por par, uma sequência de lotes. */
function bancoDe(
  prazos: unknown[] | { erro: string },
  lotes: Record<string, Array<number | { erro: string } | "lanca">>,
): { db: PodaPorOrganizacaoDb; chamadas: string[] } {
  const chamadas: string[] = [];
  const restantes: Record<string, Array<number | { erro: string } | "lanca">> = {};
  for (const [k, v] of Object.entries(lotes)) restantes[k] = [...v];
  const db: PodaPorOrganizacaoDb = {
    async listarPrazos() {
      if (!Array.isArray(prazos)) return { data: null, error: { message: prazos.erro } };
      return { data: prazos, error: null };
    },
    async expurgar(tipo, organizacao, lote) {
      const chave = `${tipo}@${organizacao}`;
      chamadas.push(`${chave}:${lote}`);
      const proximo = restantes[chave]?.shift() ?? 0;
      if (proximo === "lanca") throw new Error("conexao caiu");
      if (typeof proximo === "object") return { data: null, error: { message: proximo.erro } };
      return { data: proximo, error: null };
    },
  };
  return { db, chamadas };
}

const OPCOES = { tamanhoDoLote: 1000, maxLotes: 3 };

describe("podarPorOrganizacao — o laço da passada", () => {
  it("sem nenhuma organização com prazo próprio, não chama a poda e não apaga nada", async () => {
    const { db, chamadas } = bancoDe([], {});
    const r = await podarPorOrganizacao(db, OPCOES);
    expect(chamadas).toEqual([]);
    expect(r).toEqual({
      por_organizacao_pares: 0,
      por_organizacao_apagadas: 0,
      por_organizacao_lotes: 0,
      por_organizacao_tem_resto: false,
      por_organizacao: [],
      por_organizacao_falhas: [],
    });
  });

  it("para no primeiro lote incompleto e só lista quem apagou algo", async () => {
    const { db, chamadas } = bancoDe(
      [
        { organization_id: ORG_A, tipo: "captacao", dias: 40 },
        { organization_id: ORG_A, tipo: "prospeccao", dias: 95 },
      ],
      { [`captacao@${ORG_A}`]: [1000, 7] },
    );
    const r = await podarPorOrganizacao(db, OPCOES);
    expect(chamadas).toEqual([
      `captacao@${ORG_A}:1000`,
      `captacao@${ORG_A}:1000`,
      `prospeccao@${ORG_A}:1000`,
    ]);
    expect(r.por_organizacao_pares).toBe(2);
    expect(r.por_organizacao_apagadas).toBe(1007);
    expect(r.por_organizacao_lotes).toBe(3);
    expect(r.por_organizacao_tem_resto).toBe(false);
    expect(r.por_organizacao).toEqual([
      {
        organization_id: ORG_A,
        tipo: "captacao",
        dias: 40,
        apagadas: 1007,
        lotes: 2,
        tem_resto: false,
      },
    ]);
    expect(r.por_organizacao_falhas).toEqual([]);
  });

  it("o teto de lotes do par fecha com a última chamada cheia e DIZ que sobrou", async () => {
    const { db, chamadas } = bancoDe(
      [{ organization_id: ORG_A, tipo: "conversa_do_caso", dias: 100 }],
      {
        [`conversa_do_caso@${ORG_A}`]: [1000, 1000, 1000, 1000],
      },
    );
    const r = await podarPorOrganizacao(db, OPCOES);
    expect(chamadas).toHaveLength(3);
    expect(r.por_organizacao_apagadas).toBe(3000);
    expect(r.por_organizacao_tem_resto).toBe(true);
    expect(r.por_organizacao[0]?.tem_resto).toBe(true);
  });

  it("um par que falha NÃO derruba os outros, e a falha vem nomeada", async () => {
    const { db } = bancoDe(
      [
        { organization_id: ORG_A, tipo: "captacao", dias: 40 },
        { organization_id: ORG_B, tipo: "captacao", dias: 40 },
      ],
      { [`captacao@${ORG_A}`]: [{ erro: "permission denied" }], [`captacao@${ORG_B}`]: [12] },
    );
    const r = await podarPorOrganizacao(db, OPCOES);
    expect(r.por_organizacao_falhas).toEqual([
      `fn_expurgar_por_organizacao(captacao@${ORG_A}): permission denied`,
    ]);
    expect(r.por_organizacao_apagadas).toBe(12);
    expect(r.por_organizacao.map((p) => p.organization_id)).toEqual([ORG_B]);
  });

  it("falha no meio do par guarda o parcial que já foi apagado", async () => {
    const { db } = bancoDe([{ organization_id: ORG_A, tipo: "captacao", dias: 40 }], {
      [`captacao@${ORG_A}`]: [1000, { erro: "timeout" }],
    });
    const r = await podarPorOrganizacao(db, OPCOES);
    expect(r.por_organizacao_apagadas).toBe(1000);
    expect(r.por_organizacao[0]?.apagadas).toBe(1000);
    expect(r.por_organizacao_falhas).toHaveLength(1);
  });

  it("exceção do cliente também vira falha nomeada, não derruba a rodada", async () => {
    const { db } = bancoDe(
      [
        { organization_id: ORG_A, tipo: "espelho_da_agenda", dias: 10 },
        { organization_id: ORG_B, tipo: "espelho_da_agenda", dias: 10 },
      ],
      { [`espelho_da_agenda@${ORG_A}`]: ["lanca"], [`espelho_da_agenda@${ORG_B}`]: [3] },
    );
    const r = await podarPorOrganizacao(db, OPCOES);
    expect(r.por_organizacao_falhas).toEqual([
      `fn_expurgar_por_organizacao(espelho_da_agenda@${ORG_A}): conexao caiu`,
    ]);
    expect(r.por_organizacao_apagadas).toBe(3);
  });

  it("erro ao listar os prazos é uma falha nomeada e a rodada segue sem pares", async () => {
    const { db, chamadas } = bancoDe({ erro: "function does not exist" }, {});
    const r = await podarPorOrganizacao(db, OPCOES);
    expect(chamadas).toEqual([]);
    expect(r.por_organizacao_falhas).toEqual([
      "fn_organizacoes_com_prazo_proprio: function does not exist",
    ]);
    expect(r.por_organizacao_pares).toBe(0);
  });

  it("linha fora do contrato é dita, não pulada em silêncio", async () => {
    const { db, chamadas } = bancoDe(
      [
        { organization_id: ORG_A, tipo: "auditoria", dias: 40 },
        { organization_id: "", tipo: "captacao", dias: 40 },
        { organization_id: ORG_A, tipo: "captacao", dias: 40.5 },
        null,
        { organization_id: ORG_B, tipo: "prospeccao", dias: 95 },
      ],
      {},
    );
    const r = await podarPorOrganizacao(db, OPCOES);
    expect(r.por_organizacao_falhas).toHaveLength(4);
    expect(r.por_organizacao_falhas.every((f) => f.includes("linha fora do contrato"))).toBe(true);
    // a linha boa seguiu
    expect(chamadas).toEqual([`prospeccao@${ORG_B}:1000`]);
    expect(r.por_organizacao_pares).toBe(1);
  });

  it("o teto de chamadas CHEIAS da rodada interrompe e diz que sobrou; as incompletas não contam", async () => {
    const pares = [
      { organization_id: ORG_A, tipo: "captacao", dias: 40 },
      { organization_id: ORG_A, tipo: "conversa_do_caso", dias: 100 },
      { organization_id: ORG_B, tipo: "captacao", dias: 40 },
    ];
    const { db, chamadas } = bancoDe(pares, {
      [`captacao@${ORG_A}`]: [1000, 1000, 5],
      [`conversa_do_caso@${ORG_A}`]: [1000, 4],
      [`captacao@${ORG_B}`]: [9],
    });
    const r = await podarPorOrganizacao(db, {
      tamanhoDoLote: 1000,
      maxLotes: 5,
      maxLotesCheios: 3,
    });
    // 2 cheias no primeiro par + 1 no segundo = 3 → o terceiro par não começa
    expect(chamadas).toHaveLength(5);
    expect(chamadas.some((c) => c.startsWith("captacao@" + ORG_B))).toBe(false);
    expect(r.por_organizacao_tem_resto).toBe(true);
    expect(r.por_organizacao_pares).toBe(2);
  });

  it("par com data nula conta como zero", async () => {
    const db: PodaPorOrganizacaoDb = {
      async listarPrazos() {
        return { data: [{ organization_id: ORG_A, tipo: "captacao", dias: 40 }], error: null };
      },
      async expurgar() {
        return { data: null, error: null };
      },
    };
    const r = await podarPorOrganizacao(db, OPCOES);
    expect(r.por_organizacao_apagadas).toBe(0);
    expect(r.por_organizacao).toEqual([]);
  });
});
