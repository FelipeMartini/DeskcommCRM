/**
 * CONFIGURAR o agente por Bearer `dsk_…`, sem navegador — o PACOTE inteiro: conhecimento,
 * memória, funil (etapas, mapeamento do agente, vocabulário) e follow-ups.
 *
 * Estas dezesseis portas só respondiam a sessão de cookie e recusavam um token de servidor
 * com 401 antes do handler. Passam a chamar `lib/api/auth-dual.ts` (a doutrina do CRM:
 * "converter as rotas que cada integração precisar", #2052), com a MESMA régua das rotas de
 * configuração do agente que já existiam (`configuracao-do-agente-por-token-aceita-e-recusa`).
 *
 * O que não pode regredir, para CADA porta:
 *
 *  1. Bearer com o escopo PRÓPRIO (`config:read` para ler, `config:write` para escrever) E
 *     papel admin no token é ACEITO: a sessão nem é consultada.
 *  2. RECUSA: escopo que não é o da porta (`mcp:*`, ou o da outra direção) → 403; escopo certo
 *     com papel abaixo do mínimo do token (`tokenRole: "admin"`) → 403; token inválido → 401.
 *     Nos 403 o banco NÃO é tocado.
 *  3. Sem `Authorization`, o caminho é a SESSÃO de sempre: `requireRole` manda.
 *  4. A organização sai da LINHA DO TOKEN (o client do token é o admin e a RLS não vale), e
 *     toda consulta a filtra à mão — nunca do path nem do corpo.
 *  5. O teto de escrita por token vale em toda porta (429), e a autoria da escrita feita por
 *     token vai no audit (`actorApiTokenId`), não numa coluna de usuário.
 *
 * As entradas em `lib/auth/public-paths.ts` (sem elas o `proxy.ts` devolve 401 antes do
 * handler) são cobertas em `lib/auth/public-paths.test.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { McpAuthError, validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ sessao: true })) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/mcp/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/auth")>()),
  validateBearerToken: vi.fn(),
}));

const ORG_DO_TOKEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FUNIL = "33333333-3333-4333-8333-333333333333";
const ETAPA = "44444444-4444-4444-8444-444444444444";
const FLUXO = "55555555-5555-4555-8555-555555555555";

// ---------------------------------------------------------------------------
// Dublê do banco: qualquer cadeia do supabase-js, registrando filtros e escritas.
// ---------------------------------------------------------------------------

interface Escrita {
  tabela: string;
  tipo: "insert" | "update" | "upsert" | "delete";
  patch: unknown;
}

const filtros: Array<[string, unknown]> = [];
const escritas: Escrita[] = [];
let linhaLida: Record<string, unknown> | null = null;
let linhaInserida: Record<string, unknown> | null = null;

function cadeia(tabela: string): unknown {
  const p: Record<string | symbol, unknown> = {};
  const proxy: unknown = new Proxy(p, {
    get(_alvo, prop) {
      if (typeof prop === "symbol") return undefined;
      if (prop === "then") {
        return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null, count: 0 }).then(res, rej);
      }
      if (prop === "maybeSingle") return async () => ({ data: linhaLida, error: null });
      if (prop === "single") return async () => ({ data: linhaInserida, error: null });
      if (prop === "eq") {
        return (coluna: string, valor: unknown) => {
          filtros.push([coluna, valor]);
          return proxy;
        };
      }
      if (prop === "insert" || prop === "update" || prop === "upsert") {
        return (patch: unknown) => {
          escritas.push({ tabela, tipo: prop, patch });
          return proxy;
        };
      }
      if (prop === "delete") {
        return () => {
          escritas.push({ tabela, tipo: "delete", patch: null });
          return proxy;
        };
      }
      return () => proxy;
    },
  });
  return proxy;
}

function bancoDeTeste() {
  return { from: (tabela: string) => cadeia(tabela), rpc: () => cadeia("rpc") };
}

// ---------------------------------------------------------------------------
// As dezesseis portas.
// ---------------------------------------------------------------------------

type Handler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

interface Porta {
  nome: string;
  carregar: () => Promise<Record<string, unknown>>;
  metodo: "GET" | "POST" | "PATCH" | "PUT";
  caminho: string;
  params: Record<string, string>;
  escopo: "config:read" | "config:write";
  /** Corpo que passa da auth e é recusado por validação — nunca grava nada. */
  corpo?: unknown;
}

const PORTAS: Porta[] = [
  {
    nome: "memória (GET)",
    carregar: () => import("@/app/api/v1/ai/memory/route"),
    metodo: "GET",
    caminho: "/api/v1/ai/memory",
    params: {},
    escopo: "config:read",
  },
  {
    nome: "memória (POST)",
    carregar: () => import("@/app/api/v1/ai/memory/route"),
    metodo: "POST",
    caminho: "/api/v1/ai/memory",
    params: {},
    escopo: "config:write",
    corpo: {},
  },
  {
    nome: "entradas da memória (POST)",
    carregar: () => import("@/app/api/v1/ai/memory/entries/route"),
    metodo: "POST",
    caminho: "/api/v1/ai/memory/entries",
    params: {},
    escopo: "config:write",
    corpo: {},
  },
  {
    nome: "fontes de conhecimento (GET)",
    carregar: () => import("@/app/api/v1/ai/knowledge/sources/route"),
    metodo: "GET",
    caminho: "/api/v1/ai/knowledge/sources",
    params: {},
    escopo: "config:read",
  },
  {
    nome: "fontes de conhecimento (POST)",
    carregar: () => import("@/app/api/v1/ai/knowledge/sources/route"),
    metodo: "POST",
    caminho: "/api/v1/ai/knowledge/sources",
    params: {},
    escopo: "config:write",
    corpo: {},
  },
  {
    nome: "busca no conhecimento (POST)",
    carregar: () => import("@/app/api/v1/ai/knowledge/busca/route"),
    metodo: "POST",
    caminho: "/api/v1/ai/knowledge/busca",
    params: {},
    escopo: "config:read",
    corpo: {},
  },
  {
    nome: "funis (GET)",
    carregar: () => import("@/app/api/v1/pipelines/route"),
    metodo: "GET",
    caminho: "/api/v1/pipelines",
    params: {},
    escopo: "config:read",
  },
  {
    nome: "funil (PATCH)",
    carregar: () => import("@/app/api/v1/pipelines/[id]/route"),
    metodo: "PATCH",
    caminho: `/api/v1/pipelines/${FUNIL}`,
    params: { id: FUNIL },
    escopo: "config:write",
    corpo: {},
  },
  {
    nome: "configuração do funil (PATCH)",
    carregar: () => import("@/app/api/v1/pipelines/[id]/config/route"),
    metodo: "PATCH",
    caminho: `/api/v1/pipelines/${FUNIL}/config`,
    params: { id: FUNIL },
    escopo: "config:write",
    corpo: {},
  },
  {
    nome: "etapas do funil (GET)",
    carregar: () => import("@/app/api/v1/pipelines/[id]/stages/route"),
    metodo: "GET",
    caminho: `/api/v1/pipelines/${FUNIL}/stages`,
    params: { id: FUNIL },
    escopo: "config:read",
  },
  {
    nome: "etapa do funil (PATCH)",
    carregar: () => import("@/app/api/v1/pipelines/[id]/stages/[stageId]/route"),
    metodo: "PATCH",
    caminho: `/api/v1/pipelines/${FUNIL}/stages/${ETAPA}`,
    params: { id: FUNIL, stageId: ETAPA },
    escopo: "config:write",
    corpo: {},
  },
  {
    nome: "mapeamento do agente no funil (GET)",
    carregar: () => import("@/app/api/v1/pipelines/[id]/agent-mapping/route"),
    metodo: "GET",
    caminho: `/api/v1/pipelines/${FUNIL}/agent-mapping`,
    params: { id: FUNIL },
    escopo: "config:read",
  },
  {
    nome: "mapeamento do agente no funil (PUT)",
    carregar: () => import("@/app/api/v1/pipelines/[id]/agent-mapping/route"),
    metodo: "PUT",
    caminho: `/api/v1/pipelines/${FUNIL}/agent-mapping`,
    params: { id: FUNIL },
    escopo: "config:write",
    corpo: {},
  },
  {
    nome: "fluxo de follow-up (GET)",
    carregar: () => import("@/app/api/v1/ai/followup-flows/[id]/route"),
    metodo: "GET",
    caminho: `/api/v1/ai/followup-flows/${FLUXO}`,
    params: { id: FLUXO },
    escopo: "config:read",
  },
  {
    nome: "fluxo de follow-up (PATCH)",
    carregar: () => import("@/app/api/v1/ai/followup-flows/[id]/route"),
    metodo: "PATCH",
    caminho: `/api/v1/ai/followup-flows/${FLUXO}`,
    params: { id: FLUXO },
    escopo: "config:write",
    corpo: {},
  },
  {
    nome: "publicar fluxo de follow-up (POST)",
    carregar: () => import("@/app/api/v1/ai/followup-flows/[id]/publish/route"),
    metodo: "POST",
    caminho: `/api/v1/ai/followup-flows/${FLUXO}/publish`,
    params: { id: FLUXO },
    escopo: "config:write",
    corpo: {},
  },
];

const ESCRITA = PORTAS.filter((p) => p.escopo === "config:write");

async function chamar(
  porta: Porta,
  opcoes: { bearer?: boolean; corpo?: unknown } = {},
): Promise<Response> {
  const modulo = await porta.carregar();
  const handler = modulo[porta.metodo] as Handler;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opcoes.bearer !== false) headers.authorization = "Bearer dsk_abc_def";
  const corpo = opcoes.corpo ?? porta.corpo;
  const req = new NextRequest(`http://localhost${porta.caminho}`, {
    method: porta.metodo,
    headers,
    body: corpo === undefined || porta.metodo === "GET" ? undefined : JSON.stringify(corpo),
  });
  return handler(req, { params: Promise.resolve(porta.params) });
}

function token(escopos: string[], papel: string): void {
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: ORG_DO_TOKEN,
    scopes: escopos,
    role: papel,
    actor: { type: "api_token", id: "tok-1", role: papel },
    apiTokenId: "tok-1",
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  filtros.length = 0;
  escritas.length = 0;
  linhaLida = null;
  linhaInserida = null;
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: false,
    response: new Response(JSON.stringify({ error: { code: "unauthenticated" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  } as never);
  token(["config:read", "config:write"], "admin");
  vi.mocked(createAdminClient).mockReturnValue(bancoDeTeste() as never);
});

// ---------------------------------------------------------------------------

describe("aceita o token com o escopo próprio e papel admin", () => {
  it.each(PORTAS)("$nome", async (porta) => {
    token([porta.escopo], "admin");

    const res = await chamar(porta);

    // Passou pela auth e chegou ao handler: 404/422/200 conforme a porta. 401/403/429 aqui
    // seriam a porta fechada (ou o teto disparando sem motivo).
    expect([401, 403, 429]).not.toContain(res.status);
    expect(validateBearerToken).toHaveBeenCalledWith("Bearer dsk_abc_def");
    // Com Bearer a sessão não é consultada.
    expect(requireRole).not.toHaveBeenCalled();
  });
});

describe("recusa o que não é o escopo e o papel da porta", () => {
  it.each(PORTAS)("$nome: mcp:read/mcp:write não vale (403, banco intocado)", async (porta) => {
    token(["mcp:read", "mcp:write"], "admin");

    const res = await chamar(porta);

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden_role");
    // O client admin só nasce depois de a auth aceitar: 403 não pode ter tocado em dado.
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(escritas).toEqual([]);
  });

  it.each(PORTAS)("$nome: escopo da OUTRA direção não vale (403)", async (porta) => {
    token([porta.escopo === "config:read" ? "config:write" : "config:read"], "admin");
    expect((await chamar(porta)).status).toBe(403);
    expect(escritas).toEqual([]);
  });

  it.each(PORTAS)("$nome: escopo certo mas papel manager no token (403)", async (porta) => {
    // `tokenRole: "admin"`: configuração do agente não é poder de gerente para quem entra por
    // token, mesmo onde a sessão de gerente passa pela mesma porta.
    token([porta.escopo], "manager");
    expect((await chamar(porta)).status).toBe(403);
    expect(escritas).toEqual([]);
  });

  it.each(PORTAS)("$nome: token inválido (401)", async (porta) => {
    vi.mocked(validateBearerToken).mockRejectedValue(
      new McpAuthError(-32001, 401, "Invalid token."),
    );
    expect((await chamar(porta)).status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe("sem Authorization, a sessão de sempre", () => {
  it.each(PORTAS)("$nome: requireRole decide (401 sem sessão)", async (porta) => {
    const res = await chamar(porta, { bearer: false });

    expect(res.status).toBe(401);
    expect(requireRole).toHaveBeenCalledTimes(1);
    expect(validateBearerToken).not.toHaveBeenCalled();
  });
});

describe("o teto de escrita por token vale em toda porta", () => {
  it.each(PORTAS)("$nome: contador estourado → 429 antes de gravar", async (porta) => {
    token([porta.escopo], "admin");
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);

    const res = await chamar(porta);

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(escritas).toEqual([]);
  });

  it("pela SESSÃO não há teto: o contador nem é consultado", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "u-1", idioma: "pt-BR", organizations: [] },
      org: { orgId: ORG_DO_TOKEN, name: "Org", role: "admin" },
    } as never);
    const porta = PORTAS.find((p) => p.nome === "configuração do funil (PATCH)")!;

    await chamar(porta, { bearer: false });

    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("a organização sai da linha do token, nunca do path nem do corpo", () => {
  const LEITURAS = PORTAS.filter((p) => p.metodo === "GET");

  it.each(LEITURAS)("$nome: toda consulta filtra a org do token", async (porta) => {
    token([porta.escopo], "admin");

    const res = await chamar(porta);

    expect([401, 403, 429]).not.toContain(res.status);
    const daOrg = filtros.filter(([coluna]) => coluna === "organization_id");
    expect(daOrg.length).toBeGreaterThan(0);
    // Nenhum filtro de organização com outro valor.
    expect(daOrg.every(([, valor]) => valor === ORG_DO_TOKEN)).toBe(true);
  });

  it("PATCH do funil por id de OUTRA organização é 404, igual a um inexistente", async () => {
    // O banco não acha o funil porque o filtro de organização o esconde.
    linhaLida = null;
    const porta = PORTAS.find((p) => p.nome === "configuração do funil (PATCH)")!;

    const res = await chamar(porta, { corpo: { vocabulary: { lead: "Cliente" } } });

    expect(res.status).toBe(404);
    expect(filtros).toContainEqual(["id", FUNIL]);
    expect(filtros).toContainEqual(["organization_id", ORG_DO_TOKEN]);
    expect(escritas).toEqual([]);
  });

  it("organization_id no CORPO é recusado, não obedecido", async () => {
    const porta = PORTAS.find((p) => p.nome === "configuração do funil (PATCH)")!;

    const res = await chamar(porta, {
      corpo: { vocabulary: { lead: "Cliente" }, organization_id: OUTRA_ORG },
    });

    expect(res.status).toBe(422);
    expect(escritas).toEqual([]);
    expect(filtros.some(([, valor]) => valor === OUTRA_ORG)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("PATCH /api/v1/pipelines/[id]/config — a escrita por token", () => {
  const porta = PORTAS.find((p) => p.nome === "configuração do funil (PATCH)")!;

  it("mescla sobre o que o funil já tem, filtra a org e audita o TOKEN (não um usuário)", async () => {
    linhaLida = { vocabulary: { lead: "Contato" }, settings: { won_reasons: ["Indicação"] } };

    const res = await chamar(porta, {
      corpo: { vocabulary: { won: "Instalado" }, lost_reasons: ["Sem carro compatível"] },
    });

    expect(res.status).toBe(200);
    const gravacao = escritas.find((e) => e.tabela === "crm_pipelines" && e.tipo === "update");
    expect(gravacao?.patch).toEqual({
      vocabulary: { lead: "Contato", won: "Instalado" },
      settings: { won_reasons: ["Indicação"], lost_reasons: ["Sem carro compatível"] },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pipeline.config_updated",
        organizationId: ORG_DO_TOKEN,
        resourceId: FUNIL,
        actorApiTokenId: "tok-1",
        actorUserId: null,
      }),
    );
  });

  it("chave desconhecida é recusada em vez de ignorada (o 200 que não grava é o pior desfecho)", async () => {
    const res = await chamar(porta, { corpo: { lost_reason: ["digitado errado"] } });

    expect(res.status).toBe(422);
    expect(escritas).toEqual([]);
  });

  it("corpo vazio é recusado", async () => {
    const res = await chamar(porta, { corpo: {} });

    expect(res.status).toBe(422);
    expect(escritas).toEqual([]);
  });

  it("id que não é UUID → 400, sem tocar no banco", async () => {
    const res = await chamar(
      { ...porta, params: { id: "nao-e-uuid" } },
      { corpo: { vocabulary: { lead: "x" } } },
    );

    expect(res.status).toBe(400);
    expect(filtros).toEqual([]);
  });
});

describe("POST /api/v1/ai/memory — a autoria por token", () => {
  it("created_by fica nulo (o token não é pessoa) e o audit guarda o id do token", async () => {
    linhaLida = { version_number: 3 };
    linhaInserida = { id: "ver-4", version_number: 4 };
    const porta = PORTAS.find((p) => p.nome === "memória (POST)")!;

    const res = await chamar(porta, { corpo: { content: "as regras da casa" } });

    expect(res.status).toBe(200);
    const versao = escritas.find((e) => e.tabela === "org_memory_versions" && e.tipo === "insert");
    expect(versao?.patch).toMatchObject({
      organization_id: ORG_DO_TOKEN,
      version_number: 4,
      created_by: null,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.org_memory_published",
        organizationId: ORG_DO_TOKEN,
        actorApiTokenId: "tok-1",
      }),
    );
  });
});

describe("cobertura da tabela de portas", () => {
  it("toda porta de escrita tem corpo de teste (senão o teste de aceite grava de verdade)", () => {
    for (const porta of ESCRITA) {
      expect(porta.corpo, porta.nome).toBeDefined();
    }
  });
});
