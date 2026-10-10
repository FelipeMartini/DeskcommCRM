import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";

import { marcarContatoComoPessoal, type EntradaDoMarcar } from "./pessoal";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn() }));
vi.mock("@/lib/leads/activity-write-failure", () => ({ registraFalhaDeAtividade: vi.fn() }));

/**
 * O MÓDULO QUE OS TRÊS GESTOS COMPARTILHAM.
 *
 * Os efeitos um a um estão medidos por `app/api/v1/contacts/[id]/personal/
 * route-efeitos.test.ts` (a rota é a primeira consumidora). Aqui ficam as
 * garantias que só existem porque o ator deixou de ser sempre uma pessoa: o
 * comando do celular e o "nasce pessoal" agem como `webhook_source`.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CANAL = "33333333-3333-4333-8333-333333333333";
const NEGOCIO = "44444444-4444-4444-8444-444444444444";

/** Um negócio ABERTO do contato, no formato que `resolveActiveLeadForContact` lê. */
const NEGOCIO_ABERTO = {
  id: NEGOCIO,
  organization_id: ORG,
  pipeline_id: "55555555-5555-4555-8555-555555555555",
  status: "open",
  last_activity_at: null,
  created_at: "2026-10-01T00:00:00Z",
};

interface Estado {
  contato: { id: string; display_name: string | null; is_personal: boolean } | null;
  leituraComErro: boolean;
  negocios: Array<Record<string, unknown>>;
  atualizacoes: Array<Record<string, unknown>>;
  rpcs: string[];
}

function banco(estado: Estado) {
  const from = (tabela: string) => {
    let op: "select" | "update" = "select";
    let patch: Record<string, unknown> = {};
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "limit", "order", "insert"]) q[m] = () => q;
    q.update = (p: Record<string, unknown>) => {
      op = "update";
      patch = p;
      if (tabela === "contacts") estado.atualizacoes.push(p);
      return q;
    };
    const resposta = () => {
      if (tabela === "contacts") {
        if (estado.leituraComErro && op === "select")
          return { data: null, error: { message: "falhou" } };
        if (op === "update")
          return { data: estado.contato ? { ...estado.contato, ...patch } : null, error: null };
        return { data: estado.contato, error: null };
      }
      if (tabela === "crm_leads") return { data: estado.negocios, error: null };
      if (tabela === "crm_pipelines") return { data: null, error: null };
      return { data: [], error: null };
    };
    q.maybeSingle = async () => resposta();
    q.then = (res: (v: unknown) => unknown) => Promise.resolve(resposta()).then(res);
    return q;
  };
  const rpc = async (funcao: string) => {
    estado.rpcs.push(funcao);
    return { data: funcao === "fn_contato_pessoal_remove_trechos_do_rag" ? 0 : [], error: null };
  };
  return { from, rpc } as never;
}

function entrada(sobre: Partial<EntradaDoMarcar> = {}): EntradaDoMarcar {
  return {
    orgId: ORG,
    contactId: CONTATO,
    ator: { type: "webhook_source", id: CANAL },
    origem: "entrada.comando_pessoal",
    origemDaAuditoria: "comando_celular",
    motivoDaTimeline: "Contato marcado como pessoal pelo comando #pessoal",
    requestId: "req-1",
    ...sobre,
  };
}

let estado: Estado;
beforeEach(() => {
  vi.mocked(audit).mockReset();
  vi.mocked(emitLeadActivity).mockReset();
  vi.mocked(emitLeadActivity).mockResolvedValue({ ok: true } as never);
  estado = {
    contato: { id: CONTATO, display_name: "Maria", is_personal: false },
    leituraComErro: false,
    negocios: [],
    atualizacoes: [],
    rpcs: [],
  };
});

describe("marcarContatoComoPessoal — quando o ator não é uma pessoa", () => {
  it("marca, e a auditoria sai SEM usuário e com a origem do gesto", async () => {
    const r = await marcarContatoComoPessoal(banco(estado), entrada());

    expect(r).toMatchObject({
      ok: true,
      eraPessoal: false,
      contact: { id: CONTATO, is_personal: true },
    });
    expect(estado.atualizacoes).toEqual([{ is_personal: true }]);
    const marcacao = vi
      .mocked(audit)
      .mock.calls.map((c) => c[0])
      .find((a) => a.action === "contact.marked_personal");
    expect(marcacao).toMatchObject({
      actorUserId: null,
      organizationId: ORG,
      resourceType: "contact",
      resourceId: CONTATO,
      metadata: { contact_id: CONTATO, origem: "comando_celular" },
    });
  });

  it("com negócio aberto, a timeline leva o ator do webhook e a origem recebida", async () => {
    estado.negocios = [NEGOCIO_ABERTO];
    await marcarContatoComoPessoal(banco(estado), entrada());

    expect(emitLeadActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(emitLeadActivity).mock.calls[0]![1]).toMatchObject({
      organizationId: ORG,
      leadId: NEGOCIO,
      contactId: CONTATO,
      type: "contact_marked_personal",
      actor: { type: "webhook_source", id: CANAL },
      reason: "Contato marcado como pessoal pelo comando #pessoal",
      payload: { origem: "entrada.comando_pessoal" },
    });
  });

  it("sem negócio aberto não há timeline: a auditoria é a prova (D6)", async () => {
    await marcarContatoComoPessoal(banco(estado), entrada());
    expect(emitLeadActivity).not.toHaveBeenCalled();
    expect(vi.mocked(audit)).toHaveBeenCalled();
  });

  it("roda o apagamento dos trechos do RAG (a única remoção do marcar)", async () => {
    await marcarContatoComoPessoal(banco(estado), entrada());
    expect(estado.rpcs).toContain("fn_contato_pessoal_remove_trechos_do_rag");
  });

  it("quem já era pessoal: os efeitos rodam, mas não há segunda auditoria nem segunda timeline", async () => {
    estado.contato = { id: CONTATO, display_name: "Maria", is_personal: true };
    estado.negocios = [NEGOCIO_ABERTO];

    const r = await marcarContatoComoPessoal(banco(estado), entrada());

    expect(r).toMatchObject({ ok: true, eraPessoal: true });
    expect(estado.atualizacoes).toEqual([]);
    expect(estado.rpcs).toContain("fn_contato_pessoal_remove_trechos_do_rag");
    expect(vi.mocked(audit).mock.calls.some((c) => c[0].action === "contact.marked_personal")).toBe(
      false,
    );
    expect(emitLeadActivity).not.toHaveBeenCalled();
  });

  it("a timeline que cai não desfaz o marcar: a perda é contada, o resultado segue ok", async () => {
    estado.negocios = [NEGOCIO_ABERTO];
    vi.mocked(emitLeadActivity).mockResolvedValue({ ok: false, error: "caiu" } as never);
    const { registraFalhaDeAtividade } = await import("@/lib/leads/activity-write-failure");

    const r = await marcarContatoComoPessoal(banco(estado), entrada());

    expect(r.ok).toBe(true);
    expect(registraFalhaDeAtividade).toHaveBeenCalledTimes(1);
  });

  it("contato de outra organização (ou inexistente) → `nao_encontrado`, sem efeito nenhum", async () => {
    estado.contato = null;
    const r = await marcarContatoComoPessoal(banco(estado), entrada());
    expect(r).toEqual({ ok: false, erro: "nao_encontrado" });
    expect(estado.atualizacoes).toEqual([]);
    expect(estado.rpcs).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("leitura do contato falha → `interno`, sem efeito nenhum", async () => {
    estado.leituraComErro = true;
    const r = await marcarContatoComoPessoal(banco(estado), entrada());
    expect(r).toEqual({ ok: false, erro: "interno" });
    expect(estado.atualizacoes).toEqual([]);
  });
});

describe("marcarContatoComoPessoal — quando o ator é uma pessoa (a tela)", () => {
  it("a auditoria leva o id do usuário", async () => {
    await marcarContatoComoPessoal(
      banco(estado),
      entrada({ ator: { type: "user", id: "usuario-1" }, origemDaAuditoria: "tela_do_contato" }),
    );
    const marcacao = vi
      .mocked(audit)
      .mock.calls.map((c) => c[0])
      .find((a) => a.action === "contact.marked_personal");
    expect(marcacao).toMatchObject({
      actorUserId: "usuario-1",
      metadata: { origem: "tela_do_contato" },
    });
  });
});
