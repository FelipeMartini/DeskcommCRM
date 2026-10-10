import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { GET, PATCH } from "./route";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const USUARIO = "99999999-9999-4999-8999-999999999999";

interface Estado {
  settings: Record<string, unknown> | null;
  leitura?: "erro";
  escrita?: "erro" | "zero";
  filtros: Array<[string, unknown]>;
  gravacoes: Array<Record<string, unknown>>;
}
let estado: Estado;

function banco() {
  return {
    from: () => {
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
        estado.filtros.push([coluna, valor]);
        return q;
      };
      q.maybeSingle = async () => {
        if (modo === "select") {
          if (estado.leitura === "erro") return { data: null, error: { message: "falhou" } };
          return { data: { settings: estado.settings }, error: null };
        }
        if (estado.escrita === "erro") return { data: null, error: { message: "recusado" } };
        if (estado.escrita === "zero") return { data: null, error: null };
        estado.gravacoes.push(patch!.settings);
        estado.settings = patch!.settings;
        return { data: { settings: patch!.settings }, error: null };
      };
      return q;
    },
  } as unknown as ReturnType<typeof createAdminClient>;
}

const pedido = (corpo: unknown = {}) =>
  new NextRequest("http://localhost/api/v1/settings/contatos-pessoais", {
    method: "PATCH",
    body: JSON.stringify(corpo),
  });

beforeEach(() => {
  vi.clearAllMocks();
  estado = { settings: {}, filtros: [], gravacoes: [] };
  vi.mocked(loadAuthUser).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USUARIO, idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createAdminClient).mockImplementation(() => banco());
});

describe("settings/contatos-pessoais — quem pode", () => {
  it("exige manager para ler e para escrever, e não toca no banco se negado", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "Acesso negado.", 403),
    });
    expect((await GET()).status).toBe(403);
    expect((await PATCH(pedido({ comando_pelo_celular: true }))).status).toBe(403);
    expect(vi.mocked(requireRole).mock.calls.map((c) => c[0])).toEqual(["manager", "manager"]);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("suporte somente-leitura nega a escrita antes do papel, do banco e da auditoria", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({
      id: USUARIO,
      is_platform_admin: true,
      support: { organization_id: ORG, status: "active", access_mode: "support_readonly" },
    } as Awaited<ReturnType<typeof loadAuthUser>>);

    const resposta = await PATCH(pedido({ comando_pelo_celular: true }));

    expect(resposta.status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("settings/contatos-pessoais — GET", () => {
  it("settings vazio → os dois desligados, preso à organização do papel", async () => {
    const resposta = await GET();
    expect((await resposta.json()).data).toEqual({
      comando_pelo_celular: false,
      novos_nascem_pessoais: false,
    });
    expect(estado.filtros).toEqual([["id", ORG]]);
  });

  it("devolve o que está ligado", async () => {
    estado.settings = { contatos_pessoais: { comando_pelo_celular: true } };
    expect((await (await GET()).json()).data).toEqual({
      comando_pelo_celular: true,
      novos_nascem_pessoais: false,
    });
  });

  it("leitura que falha → 500", async () => {
    estado.leitura = "erro";
    expect((await GET()).status).toBe(500);
  });
});

describe("settings/contatos-pessoais — PATCH", () => {
  it("liga um interruptor, preserva o resto do settings e audita com quem pediu", async () => {
    estado.settings = { branding: { cor: "#123456" } };

    const resposta = await PATCH(pedido({ comando_pelo_celular: true }));

    expect(resposta.status).toBe(200);
    expect((await resposta.json()).data).toEqual({
      comando_pelo_celular: true,
      novos_nascem_pessoais: false,
    });
    expect(estado.gravacoes).toEqual([
      {
        branding: { cor: "#123456" },
        contatos_pessoais: { comando_pelo_celular: true, novos_nascem_pessoais: false },
      },
    ]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settings.personal_contacts_updated",
        actorUserId: USUARIO,
        organizationId: ORG,
        resourceType: "organization",
        resourceId: ORG,
        metadata: {
          pedido: { comando_pelo_celular: true },
          depois: { comando_pelo_celular: true, novos_nascem_pessoais: false },
        },
      }),
    );
  });

  it("pedir o estado que já vale não grava nem audita", async () => {
    estado.settings = { contatos_pessoais: { novos_nascem_pessoais: true } };
    const resposta = await PATCH(pedido({ novos_nascem_pessoais: true }));
    expect(resposta.status).toBe(200);
    expect(estado.gravacoes).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    [{}, "vazio"],
    [{ comando_pelo_celular: "sim" }, "texto no lugar de booleano"],
    [{ comando_pelo_celular: true, organization_id: ORG }, "organização pelo corpo"],
    [null, "corpo que não é JSON"],
  ])("recusa %j (%s) sem gravar", async (corpo, _motivo) => {
    const resposta = await PATCH(pedido(corpo));
    expect(resposta.status).toBe(422);
    expect(estado.gravacoes).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    ["leitura", { leitura: "erro" as const }],
    ["escrita", { escrita: "erro" as const }],
    ["escrita sem linha afetada", { escrita: "zero" as const }],
  ])("%s que falha → 500 e nada é auditado", async (_nome, falha) => {
    Object.assign(estado, falha);
    const resposta = await PATCH(pedido({ comando_pelo_celular: true }));
    expect(resposta.status).toBe(500);
    expect(audit).not.toHaveBeenCalled();
  });
});
