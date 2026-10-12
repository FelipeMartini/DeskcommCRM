import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/PUT /api/v1/ai/ponte — o interruptor da claude-ponte, por organização (ordem do dono, 11/10/2026).
 *
 * O que se trava aqui:
 *  * GET é manager+, PUT é admin; a organização vem da sessão, nunca do corpo (`.strict()`);
 *  * o PADRÃO É LIGADA: sem a chave no jsonb, ou com valor torto, a resposta é `ativa: true`;
 *  * instalação que não oferece a ponte a esta organização: GET diz `disponivel: false` (e `ativa: true`,
 *    nunca o que sobrou no jsonb) e PUT é 409 sem gravar nada;
 *  * a escolha é GRAVADA em `organizations.settings.llm.ponte_ativa`, em MERGE — `settings` e `llm` são
 *    jsonb compartilhados (marca, MFA, provedor, modelo);
 *  * pedir o valor que já vale não grava nem audita; zero linhas gravadas é 500, nunca "salvo".
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const USER_ID = "11111111-1111-4111-8111-111111111111";

let settingsNoBanco: Record<string, unknown> | null;
let updates: Array<{ valores: Record<string, unknown>; filtros: Array<[string, unknown]> }>;
let linhasGravadas: number;

function ligarPonteParaEstaOrganizacao(orgs = ORG_ID): void {
  vi.stubEnv("CLAUDE_PONTE_BASE_URL", "http://claude-ponte:8080");
  vi.stubEnv("CLAUDE_PONTE_API_KEY", "chave-sintetica-da-ponte");
  vi.stubEnv("CLAUDE_PONTE_ORGS", orgs);
}

function pedido(corpo: unknown): Request {
  return new Request("http://x/api/v1/ai/ponte", {
    method: "PUT",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

async function put(corpo: unknown): Promise<Response> {
  const { PUT } = await import("./route");
  return PUT(pedido(corpo) as never);
}

async function get(): Promise<Response> {
  const { GET } = await import("./route");
  return GET();
}

/** Um leitor de `organizations` que devolve o `settings` do teste. */
function leitor() {
  const q = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({
      data: settingsNoBanco === null ? null : { settings: settingsNoBanco },
      error: null,
    }),
  };
  return { from: () => q };
}

beforeEach(() => {
  vi.clearAllMocks();
  settingsNoBanco = {
    branding: { name: "Clínica X" },
    llm: { provider: "anthropic", default_model: "claude-haiku-4-5" },
  };
  updates = [];
  linhasGravadas = 1;
  ligarPonteParaEstaOrganizacao();

  vi.mocked(requireSupportWrite).mockResolvedValue(null as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_ID, role: "admin" },
  } as never);
  vi.mocked(createClient).mockResolvedValue(leitor() as never);
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => {
      if (tabela !== "organizations") throw new Error(`tabela não dublada: ${tabela}`);
      const base = leitor().from();
      return {
        ...base,
        update: (valores: Record<string, unknown>) => {
          const filtros: Array<[string, unknown]> = [];
          updates.push({ valores, filtros });
          const u = {
            eq: (c: string, v: unknown) => (filtros.push([c, v]), u),
            select: () => u,
            maybeSingle: async () => ({
              data: linhasGravadas ? { id: ORG_ID } : null,
              error: null,
            }),
          };
          return u;
        },
      };
    },
  } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/v1/ai/ponte", () => {
  it("pede manager+ e recusa quem não é", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    expect((await get()).status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith(
      "manager",
      expect.objectContaining({ resource: "ai_ponte" }),
    );
  });

  it("⭐ sem a chave no jsonb o PADRÃO É LIGADA", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toEqual({ disponivel: true, ativa: true });
  });

  it("`false` no jsonb: desligada", async () => {
    settingsNoBanco = { llm: { ponte_ativa: false } };
    const corpo = (await (await get()).json()) as { data: unknown };
    expect(corpo.data).toEqual({ disponivel: true, ativa: false });
  });

  it.each([["false"], [0], [null], [[false]]])(
    "valor torto %j no jsonb vale ligada (preferência, não cerca)",
    async (torto) => {
      settingsNoBanco = { llm: { ponte_ativa: torto } };
      const corpo = (await (await get()).json()) as { data: { ativa: boolean } };
      expect(corpo.data.ativa).toBe(true);
    },
  );

  it("⭐ instalação que não atende esta organização: `disponivel: false` e `ativa: true`, sem ler o banco", async () => {
    ligarPonteParaEstaOrganizacao(OUTRA_ORG);
    settingsNoBanco = { llm: { ponte_ativa: false } };
    const corpo = (await (await get()).json()) as { data: unknown };
    expect(corpo.data).toEqual({ disponivel: false, ativa: true });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("instalação sem as variáveis: `disponivel: false`", async () => {
    vi.stubEnv("CLAUDE_PONTE_BASE_URL", "");
    vi.stubEnv("CLAUDE_PONTE_API_KEY", "");
    vi.stubEnv("CLAUDE_PONTE_ORGS", "");
    const corpo = (await (await get()).json()) as { data: unknown };
    expect(corpo.data).toEqual({ disponivel: false, ativa: true });
  });
});

describe("PUT /api/v1/ai/ponte", () => {
  it("exige admin e recusa quem não é", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    expect((await put({ ativa: false })).status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith(
      "admin",
      expect.objectContaining({ resource: "ai_ponte" }),
    );
    expect(updates).toHaveLength(0);
  });

  it("modo suporte somente-leitura barra antes de qualquer efeito", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValueOnce(
      new Response(null, { status: 403 }) as never,
    );
    expect((await put({ ativa: false })).status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it.each([
    [{}],
    [{ ativa: "false" }],
    [{ ativa: 0 }],
    [{ ativa: false, organization_id: "outra" }],
    [{ ativa: false, extra: 1 }],
  ])("corpo fora do contrato %j: 422 e nada grava (strict)", async (corpo) => {
    expect((await put(corpo)).status).toBe(422);
    expect(updates).toHaveLength(0);
  });

  it("JSON inválido: 400", async () => {
    const { PUT } = await import("./route");
    const r = await PUT(
      new Request("http://x/api/v1/ai/ponte", { method: "PUT", body: "{" }) as never,
    );
    expect(r.status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it("⭐ desligar: GRAVA em `settings.llm.ponte_ativa`, em merge, na organização da sessão, e audita", async () => {
    const r = await put({ ativa: false });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toEqual({ ativa: false, mudou: true });

    expect(updates).toHaveLength(1);
    expect(updates[0]!.filtros).toEqual([["id", ORG_ID]]);
    expect(updates[0]!.valores).toEqual({
      settings: {
        branding: { name: "Clínica X" },
        llm: { provider: "anthropic", default_model: "claude-haiku-4-5", ponte_ativa: false },
      },
    });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.claude_bridge_toggled",
        organizationId: ORG_ID,
        actorUserId: USER_ID,
        metadata: { ativa: false },
      }),
    );
  });

  it("religar quando está desligada: grava `true`, preservando o resto do `llm`", async () => {
    settingsNoBanco = { llm: { provider: "anthropic", ponte_ativa: false, params: { a: 1 } } };
    const r = await put({ ativa: true });
    expect(r.status).toBe(200);
    expect(updates[0]!.valores).toEqual({
      settings: { llm: { provider: "anthropic", ponte_ativa: true, params: { a: 1 } } },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai.claude_bridge_toggled", metadata: { ativa: true } }),
    );
  });

  it("organização sem `llm` nem `settings` úteis: cria o `llm` só com o interruptor", async () => {
    settingsNoBanco = {};
    expect((await put({ ativa: false })).status).toBe(200);
    expect(updates[0]!.valores).toEqual({ settings: { llm: { ponte_ativa: false } } });
  });

  it("pedir o valor que já vale (padrão ligada) não grava nem audita", async () => {
    const r = await put({ ativa: true });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: { mudou: boolean } }).data.mudou).toBe(false);
    expect(updates).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("desligar o que já está desligado também não grava nem audita", async () => {
    settingsNoBanco = { llm: { ponte_ativa: false } };
    const r = await put({ ativa: false });
    expect(((await r.json()) as { data: { mudou: boolean } }).data.mudou).toBe(false);
    expect(updates).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("⭐ instalação que não atende a organização: 409 e nada é gravado", async () => {
    ligarPonteParaEstaOrganizacao(OUTRA_ORG);
    const r = await put({ ativa: false });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("ponte_indisponivel");
    expect(updates).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("⭐ zero linhas gravadas é 500, nunca 'salvo' (e não audita)", async () => {
    linhasGravadas = 0;
    const r = await put({ ativa: false });
    expect(r.status).toBe(500);
    expect(audit).not.toHaveBeenCalled();
  });

  it("organização que a leitura não achou: 500 e nenhum `settings` em branco é gravado", async () => {
    settingsNoBanco = null;
    const r = await put({ ativa: false });
    expect(r.status).toBe(500);
    expect(updates).toHaveLength(0);
  });
});
