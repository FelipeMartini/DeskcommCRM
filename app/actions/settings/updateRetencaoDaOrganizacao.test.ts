/**
 * A gravação do prazo de retenção POR ORGANIZAÇÃO (migration 0695, etapa 3).
 *
 * O que se prova aqui: a ordem dos portões (entrada → sessão → papel → segundo
 * fator), que a organização vem da SESSÃO e nunca do argumento, que o banco só é
 * chamado com o que a regra de domínio aceitou, que cada código de erro do banco
 * vira o erro certo da tela, e que a troca entra na trilha com os números
 * gravados. A regra em si (piso, formato, atomicidade) é do SQL e tem o
 * invariante `tests/invariants/retencao-por-organizacao.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  mfaEmDivida: vi.fn(),
  rpc: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-request-id": "req-1", "user-agent": "teste" }),
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: mocks.loadAuthUser,
  resolveActiveOrg: mocks.resolveActiveOrg,
  mfaEmDivida: mocks.mfaEmDivida,
}));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));

import { updateRetencaoDaOrganizacao } from "./updateRetencaoDaOrganizacao";

const USER = {
  id: "00000000-0000-4000-8000-000000000001",
  support: null,
  is_platform_admin: false,
  platform_admin_scope: null,
};
const ORG_DA_SESSAO = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadAuthUser.mockResolvedValue(USER);
  mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG_DA_SESSAO, role: "admin" });
  mocks.mfaEmDivida.mockResolvedValue(false);
  mocks.rpc.mockResolvedValue({ data: 1, error: null });
});

describe("updateRetencaoDaOrganizacao — quem pode e em que ordem", () => {
  it("entrada inválida é recusada ANTES de ler a sessão, com o campo e o mínimo", async () => {
    const resultado = await updateRetencaoDaOrganizacao({ captacao: 10 });

    expect(resultado).toEqual({
      ok: false,
      error: "validation_failed",
      recusas: [{ tipo: "captacao", motivo: "abaixo_do_piso", piso: 30 }],
    });
    expect(mocks.loadAuthUser).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("tipo que não existe (um global, como auditoria) é recusado", async () => {
    const resultado = await updateRetencaoDaOrganizacao({ auditoria: 365 } as never);

    expect(resultado).toMatchObject({
      ok: false,
      error: "validation_failed",
      recusas: [{ tipo: "auditoria", motivo: "tipo_desconhecido" }],
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("sem sessão: unauthenticated", async () => {
    mocks.loadAuthUser.mockResolvedValue(null);
    expect(await updateRetencaoDaOrganizacao({ captacao: 60 })).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("sem organização ativa: forbidden_tenant", async () => {
    mocks.resolveActiveOrg.mockResolvedValue(null);
    expect(await updateRetencaoDaOrganizacao({ captacao: 60 })).toEqual({
      ok: false,
      error: "forbidden_tenant",
    });
  });

  it.each(["viewer", "agent", "manager"])(
    "%s não administra a empresa e nada é gravado",
    async (role) => {
      mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG_DA_SESSAO, role });

      expect(await updateRetencaoDaOrganizacao({ captacao: 60 })).toEqual({
        ok: false,
        error: "forbidden_role",
      });
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    },
  );

  it("admin com segundo fator em dívida: mfa_required, e só DEPOIS de passar pelo papel", async () => {
    mocks.mfaEmDivida.mockResolvedValue(true);
    expect(await updateRetencaoDaOrganizacao({ captacao: 60 })).toEqual({
      ok: false,
      error: "mfa_required",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();

    mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG_DA_SESSAO, role: "agent" });
    expect(await updateRetencaoDaOrganizacao({ captacao: 60 })).toEqual({
      ok: false,
      error: "forbidden_role",
    });
  });
});

describe("updateRetencaoDaOrganizacao — o que vai ao banco", () => {
  it("grava no org DA SESSÃO, só os tipos preenchidos, nos nomes <tipo>_dias", async () => {
    const resultado = await updateRetencaoDaOrganizacao({
      captacao: 60,
      conversa_do_caso: null,
      prospeccao: 120,
    });

    expect(resultado).toEqual({ ok: true, prazos: { captacao: 60, prospeccao: 120 } });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("fn_definir_retencao_da_organizacao", {
      p_org: ORG_DA_SESSAO,
      p_actor: USER.id,
      p_prazos: { captacao_dias: 60, prospeccao_dias: 120 },
    });
  });

  it("tudo vazio manda objeto vazio (o banco apaga a chave) e a trilha diz que voltou ao padrão", async () => {
    expect(await updateRetencaoDaOrganizacao({})).toEqual({ ok: true, prazos: {} });
    expect(mocks.rpc).toHaveBeenCalledWith("fn_definir_retencao_da_organizacao", {
      p_org: ORG_DA_SESSAO,
      p_actor: USER.id,
      p_prazos: {},
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { prazos: {}, voltou_ao_prazo_da_instalacao: true },
      }),
    );
  });

  it("a troca entra na trilha com os números gravados e a organização como recurso", async () => {
    await updateRetencaoDaOrganizacao({ espelho_da_agenda: 14 });

    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org.retention_updated",
        actorUserId: USER.id,
        organizationId: ORG_DA_SESSAO,
        resourceType: "organization",
        resourceId: ORG_DA_SESSAO,
        requestId: "req-1",
        metadata: { prazos: { espelho_da_agenda_dias: 14 }, voltou_ao_prazo_da_instalacao: false },
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/settings/tenant");
  });
});

describe("updateRetencaoDaOrganizacao — o que o banco responde", () => {
  it("42501 (papel velho no snapshot) vira forbidden_role e nada é auditado", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "x" } });
    expect(await updateRetencaoDaOrganizacao({ captacao: 60 })).toEqual({
      ok: false,
      error: "forbidden_role",
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("22023 (valor que o banco recusou) vira validation_failed", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "22023", message: "x" } });
    expect(await updateRetencaoDaOrganizacao({ captacao: 60 })).toEqual({
      ok: false,
      error: "validation_failed",
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("outro erro do banco vira db_error", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "x" } });
    expect(await updateRetencaoDaOrganizacao({ captacao: 60 })).toEqual({
      ok: false,
      error: "db_error",
    });
  });

  it("0 linhas gravadas (organização não casou) é nao_gravou — a tela não diz 'salvo'", async () => {
    mocks.rpc.mockResolvedValue({ data: 0, error: null });
    expect(await updateRetencaoDaOrganizacao({ captacao: 60 })).toEqual({
      ok: false,
      error: "nao_gravou",
    });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
