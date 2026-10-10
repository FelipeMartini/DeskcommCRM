import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CampanhaWhatsapp } from "@/lib/ai/elegibilidade/campanha";
import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { GET, PUT } from "./route";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const USUARIO = "99999999-9999-4999-8999-999999999999";
const CANAL_DELA = "22222222-2222-4222-8222-222222222222";
const CANAL_DE_OUTRA = "33333333-3333-4333-8333-333333333333";
const FRASE = "quero saber mais sobre o lançamento do residencial";

function campanha(sobre: Partial<CampanhaWhatsapp> = {}): CampanhaWhatsapp {
  return {
    id: "lancamento",
    label: "Lançamento",
    match: { tipo: "contains", valor: FRASE },
    ...sobre,
  };
}

interface Estado {
  settings: Record<string, unknown> | null;
  canaisDela: string[];
  leitura?: "erro";
  escrita?: "erro" | "zero";
  gravacoes: Array<Record<string, unknown>>;
}
let estado: Estado;

function banco() {
  return {
    from: (tabela: string) => {
      let modo: "select" | "update" = "select";
      let patch: { settings: Record<string, unknown> } | null = null;
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.update = (p: { settings: Record<string, unknown> }) => {
        modo = "update";
        patch = p;
        return q;
      };
      q.eq = () => q;
      q.in = async (_coluna: string, ids: string[]) => ({
        data:
          tabela === "channel_sessions"
            ? ids.filter((id) => estado.canaisDela.includes(id)).map((id) => ({ id }))
            : [],
        error: null,
      });
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
  new NextRequest("http://localhost/api/v1/settings/campanhas-whatsapp", {
    method: "PUT",
    body: JSON.stringify(corpo),
  });

beforeEach(() => {
  vi.clearAllMocks();
  estado = { settings: {}, canaisDela: [CANAL_DELA], gravacoes: [] };
  vi.mocked(loadAuthUser).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USUARIO, idioma: "pt-BR" },
    org: { orgId: ORG, role: "admin" },
  } as unknown as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createAdminClient).mockImplementation(() => banco());
});

describe("settings/campanhas-whatsapp — quem pode", () => {
  it("exige admin para ler e para escrever, e não toca no banco se negado", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "Acesso negado.", 403),
    });
    expect((await GET()).status).toBe(403);
    expect((await PUT(pedido({ campanhas: [] }))).status).toBe(403);
    expect(requireRole).toHaveBeenNthCalledWith(
      1,
      "admin",
      expect.objectContaining({ allowPlatformAdmin: "leitura" }),
    );
    expect(requireRole).toHaveBeenNthCalledWith(
      2,
      "admin",
      expect.objectContaining({ allowPlatformAdmin: true }),
    );
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("suporte somente-leitura nega a escrita antes do papel, do banco e da auditoria", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({
      id: USUARIO,
      is_platform_admin: true,
      support: { organization_id: ORG, status: "active", access_mode: "support_readonly" },
    } as Awaited<ReturnType<typeof loadAuthUser>>);

    const resposta = await PUT(pedido({ campanhas: [campanha()] }));

    expect(resposta.status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("settings/campanhas-whatsapp — GET", () => {
  it("devolve a lista, quantas o motor descarta e os limites que a tela mostra", async () => {
    estado.settings = { campanhas_whatsapp: [campanha(), { id: "quebrada" }] };
    const { data } = await (await GET()).json();
    expect(data).toEqual({ campanhas: [campanha()], descartadas: 1, limite: 100, frase_minima: 3 });
  });

  it("sem lista → vazia", async () => {
    const { data } = await (await GET()).json();
    expect(data).toMatchObject({ campanhas: [], descartadas: 0 });
  });

  it("leitura que falha → 500", async () => {
    estado.leitura = "erro";
    expect((await GET()).status).toBe(500);
  });
});

describe("settings/campanhas-whatsapp — PUT", () => {
  it("grava a lista, preserva o resto do settings e audita só contagem e ids (nunca a frase)", async () => {
    estado.settings = {
      branding: { cor: "#123456" },
      contatos_pessoais: { comando_pelo_celular: true },
    };

    const resposta = await PUT(
      pedido({ campanhas: [campanha({ channel_session_id: CANAL_DELA })] }),
    );

    expect(resposta.status).toBe(200);
    expect(estado.gravacoes).toEqual([
      {
        branding: { cor: "#123456" },
        contatos_pessoais: { comando_pelo_celular: true },
        campanhas_whatsapp: [campanha({ channel_session_id: CANAL_DELA })],
      },
    ]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settings.campaign_keywords_updated",
        actorUserId: USUARIO,
        organizationId: ORG,
        resourceType: "organization",
        resourceId: ORG,
        metadata: { total: 1, adicionadas: ["lancamento"], removidas: [], editadas: [] },
      }),
    );
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain(FRASE);
  });

  it("a mesma lista de novo não grava nem audita", async () => {
    estado.settings = { campanhas_whatsapp: [campanha()] };
    expect((await PUT(pedido({ campanhas: [campanha()] }))).status).toBe(200);
    expect(estado.gravacoes).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("lista vazia apaga todas (e o audit diz quais saíram)", async () => {
    estado.settings = { campanhas_whatsapp: [campanha()] };
    expect((await PUT(pedido({ campanhas: [] }))).status).toBe(200);
    expect(estado.gravacoes[0]!.campanhas_whatsapp).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { total: 0, adicionadas: [], removidas: ["lancamento"], editadas: [] },
      }),
    );
  });

  it.each([
    [{ campanhas: [campanha({ id: "a" }), campanha({ id: "a" })] }, "id repetido"],
    [
      { campanhas: [campanha({ match: { tipo: "contains", valor: " a " } })] },
      "frase curta demais",
    ],
    [
      { campanhas: [campanha({ match: { tipo: "regex" as never, valor: FRASE } })] },
      "tipo desconhecido",
    ],
    [{ campanhas: [campanha()], organization_id: ORG }, "organização pelo corpo"],
    [{}, "sem a lista"],
    [null, "corpo que não é JSON"],
  ])("recusa %# (%s) sem gravar nem auditar", async (corpo, _motivo) => {
    const resposta = await PUT(pedido(corpo));
    expect(resposta.status).toBe(422);
    expect(estado.gravacoes).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("canal de outra organização → 422, sem gravar", async () => {
    const resposta = await PUT(
      pedido({ campanhas: [campanha({ channel_session_id: CANAL_DE_OUTRA })] }),
    );
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
    const resposta = await PUT(pedido({ campanhas: [campanha()] }));
    expect(resposta.status).toBe(500);
    expect(audit).not.toHaveBeenCalled();
  });
});
