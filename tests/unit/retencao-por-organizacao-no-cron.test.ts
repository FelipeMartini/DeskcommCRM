import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, MAX_LOTES, TAMANHO_DO_LOTE } from "@/app/api/v1/cron/data-retention/route";

vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_CRON_SECRET: "segredo",
    INTERNAL_SECRET: "",
    JOB_QUEUE_RETENTION_DAYS: "",
    AUDIT_LOG_RETENTION_DAYS: "",
  },
}));
const auditou = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...args: unknown[]) => auditou(...args) }));

type Resposta = { data: unknown; error: { message: string } | null };

/** As chamadas de `rpc` desta rodada, em ordem. */
let rpcs: Array<{ nome: string; args: Record<string, unknown> | undefined }> = [];
/** O que `fn_organizacoes_com_prazo_proprio` devolve. */
let prazos: Resposta = { data: [], error: null };
/** Por `tipo@organização`: a fila de lotes que `fn_expurgar_por_organizacao` devolve. */
let lotes: Record<string, Array<number | { erro: string }>> = {};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (nome: string, args?: Record<string, unknown>): Promise<Resposta> => {
      rpcs.push({ nome, args });
      if (nome === "fn_organizacoes_com_prazo_proprio") return prazos;
      if (nome === "fn_expurgar_por_organizacao") {
        const chave = `${String(args?.p_tipo)}@${String(args?.p_organizacao)}`;
        const proximo = lotes[chave]?.shift() ?? 0;
        if (typeof proximo === "object") return { data: null, error: { message: proximo.erro } };
        return { data: proximo, error: null };
      }
      // as podas globais: nada a apagar
      return { data: 0, error: null };
    },
    from: () => {
      const q: Record<string, unknown> = {
        eq: () => q,
        in: () => q,
        limit: () => q,
        order: () => q,
        lt: () => q,
        select: () => q,
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
      };
      return { select: () => q, update: () => q, delete: () => q };
    },
  }),
}));

const ORG_A = "a0000000-0000-0000-0000-00000000000a";
const ORG_B = "b0000000-0000-0000-0000-00000000000b";

function requisicao(): Parameters<typeof GET>[0] {
  return { headers: new Headers({ authorization: "Bearer segredo" }) } as never;
}

describe("o cron data-retention aplica o prazo POR ORGANIZAÇÃO (migration 0695)", () => {
  beforeEach(() => {
    auditou.mockClear();
    rpcs = [];
    prazos = { data: [], error: null };
    lotes = {};
  });

  it("sem organização com prazo próprio: pergunta uma vez, não poda por organização e não audita", async () => {
    const resposta = await GET(requisicao());
    expect(resposta.status).toBe(200);
    expect(rpcs.filter((r) => r.nome === "fn_organizacoes_com_prazo_proprio")).toHaveLength(1);
    expect(rpcs.filter((r) => r.nome === "fn_expurgar_por_organizacao")).toHaveLength(0);
    expect(auditou).not.toHaveBeenCalled();
  });

  it("roda DEPOIS das podas globais e manda os nomes de argumento que o banco declara", async () => {
    prazos = {
      data: [{ organization_id: ORG_A, tipo: "captacao", dias: 40 }],
      error: null,
    };
    lotes = { [`captacao@${ORG_A}`]: [0] };
    await GET(requisicao());

    const nomes = rpcs.map((r) => r.nome);
    const primeiraPorOrg = nomes.indexOf("fn_organizacoes_com_prazo_proprio");
    expect(primeiraPorOrg).toBeGreaterThan(nomes.indexOf("fn_expurgar_checkpoints_superados"));
    const poda = rpcs.find((r) => r.nome === "fn_expurgar_por_organizacao");
    // O PostgREST resolve por NOME de argumento: p_tipo, p_organizacao, p_limite.
    expect(poda?.args).toEqual({
      p_tipo: "captacao",
      p_organizacao: ORG_A,
      p_limite: TAMANHO_DO_LOTE,
    });
  });

  it("apagou: uma linha de auditoria NA organização, e a global só com o resumo", async () => {
    prazos = {
      data: [
        { organization_id: ORG_A, tipo: "captacao", dias: 40 },
        { organization_id: ORG_B, tipo: "espelho_da_agenda", dias: 10 },
      ],
      error: null,
    };
    lotes = { [`captacao@${ORG_A}`]: [12], [`espelho_da_agenda@${ORG_B}`]: [0] };
    const resposta = await GET(requisicao());

    expect(resposta.status).toBe(200);
    // Só a organização que apagou ganha linha; a global NÃO sai (as globais não apagaram nada).
    expect(auditou).toHaveBeenCalledTimes(1);
    expect(auditou.mock.calls[0]?.[0]).toMatchObject({
      action: "retention.organization_sweep",
      organizationId: ORG_A,
      bypassedRls: true,
      metadata: {
        tipo: "captacao",
        prazo_proprio_dias: 40,
        apagadas: 12,
        lotes: 1,
        tem_resto: false,
      },
    });
    const corpo = (await resposta.json()) as { data?: Record<string, unknown> } & Record<
      string,
      unknown
    >;
    const dados = (corpo.data ?? corpo) as Record<string, unknown>;
    expect(dados.por_organizacao_apagadas).toBe(12);
    expect(dados.por_organizacao_pares).toBe(2);
  });

  it("o teto de lotes por par vale também no cron, e diz que sobrou", async () => {
    prazos = { data: [{ organization_id: ORG_A, tipo: "prospeccao", dias: 95 }], error: null };
    lotes = {
      [`prospeccao@${ORG_A}`]: Array.from({ length: MAX_LOTES + 5 }, () => TAMANHO_DO_LOTE),
    };
    await GET(requisicao());
    expect(rpcs.filter((r) => r.nome === "fn_expurgar_por_organizacao")).toHaveLength(MAX_LOTES);
    expect(auditou.mock.calls[0]?.[0]).toMatchObject({
      action: "retention.organization_sweep",
      metadata: { apagadas: MAX_LOTES * TAMANHO_DO_LOTE, tem_resto: true },
    });
  });

  it("um par que falha deixa a rodada em 500 com a falha NOMEADA — e as outras organizações apagam", async () => {
    prazos = {
      data: [
        { organization_id: ORG_A, tipo: "captacao", dias: 40 },
        { organization_id: ORG_B, tipo: "captacao", dias: 40 },
      ],
      error: null,
    };
    lotes = { [`captacao@${ORG_A}`]: [{ erro: "permission denied" }], [`captacao@${ORG_B}`]: [3] };
    const resposta = await GET(requisicao());

    expect(resposta.status, "poda parcial precisa continuar sinalizando 500").toBe(500);
    const chamadas = auditou.mock.calls.map((c) => c[0] as Record<string, unknown>);
    // a global registra a falha (sem efeito global); a organização B registra o que apagou
    expect(chamadas.map((c) => c.action).sort()).toEqual([
      "retention.organization_sweep",
      "retention.sweep_run",
    ]);
    const global = chamadas.find((c) => c.action === "retention.sweep_run") as {
      metadata: Record<string, unknown>;
    };
    expect(global.metadata.falhou).toBe(true);
    expect(JSON.stringify(global.metadata.falhas)).toContain(`captacao@${ORG_A}`);
    const daOrg = chamadas.find((c) => c.action === "retention.organization_sweep") as {
      organizationId: string;
    };
    expect(daOrg.organizationId).toBe(ORG_B);
  });

  it("função ausente num clone (grant que não veio) é falha nomeada, não derruba o dia", async () => {
    prazos = {
      data: null,
      error: { message: "Could not find the function public.fn_organizacoes_com_prazo_proprio" },
    };
    const resposta = await GET(requisicao());
    expect(resposta.status).toBe(500);
    const global = auditou.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(global.action).toBe("retention.sweep_run");
    expect(JSON.stringify(global.metadata.falhas)).toContain("fn_organizacoes_com_prazo_proprio");
  });
});
