/**
 * GET/PUT /api/v1/admin/tenants/[id]/ai — a ESCOLHA do OmniRouter por organização (modelo misto,
 * ordem do dono, 16/10/2026).
 *
 * O que é da INSTALAÇÃO (endereço, chave padrão, oferta geral) vem de `valorDaInstalacao`; o que é da
 * ORGANIZAÇÃO (herdar, chave individual, recusar) vai em `organizations.settings`. A guarda de escrita
 * roda DE VERDADE (mesmo molde de `route-patch.test.ts`): o teste substitui só o que ela consulta.
 *
 * Os dados são sintéticos; a chave de teste nunca pode aparecer em resposta, em auditoria nem em
 * `settings` — ela só vai ao cofre (`guardarCredencial`).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ATOR = "aaaaaaaa-0000-4000-8000-000000000001";
const TENANT = "bbbbbbbb-0000-4000-8000-000000000001";
const OMNI = "https://omnirouter.example.com";
const OMNI_NORMALIZADO = "https://omnirouter.example.com/v1";
const CHAVE_DA_INSTALACAO = "chave-sintetica-da-instalacao-1111";
const CHAVE_INDIVIDUAL = "chave-sintetica-individual-2222";

type Operacao = {
  tabela: string;
  tipo: "select" | "update";
  valores?: Record<string, unknown>;
  filtros: Array<[string, unknown]>;
};

const h = vi.hoisted(() => ({
  linhaDoAdmin: null as Record<string, unknown> | null,
  mfaEmDivida: vi.fn(async () => false),
  apoioNegado: null as Response | null,
  requireSupportWrite: vi.fn(),
  audit: vi.fn(),
  guardar: vi.fn(),
  rotacionar: vi.fn(),
  valorDaInstalacao: vi.fn(),
  org: null as { settings: Record<string, unknown> | null } | null,
  cred: null as Record<string, unknown> | null,
  credExistente: null as { id: string } | null,
  erroNoUpdateDaOrg: null as { message: string } | null,
  operacoes: [] as Operacao[],
}));

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect:${destino}`);
  },
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.requireSupportWrite }));
// `requirePlatformAdminEscrita` mede a dívida de MFA pela régua ESTRITA; os dois nomes
// respondem pelo mesmo interruptor para que o caso "tem fator e está em aal1" valha.
vi.mock("@/lib/auth/server", () => ({
  mfaEmDivida: h.mfaEmDivida,
  mfaEmDividaEstrita: h.mfaEmDivida,
}));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/ai/credenciais/guardar", () => ({
  guardarCredencial: h.guardar,
  rotacionarCredencial: h.rotacionar,
}));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: h.valorDaInstalacao }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: ATOR } } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2" } }) },
    },
    from: () => {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.is = () => c;
      c.maybeSingle = async () => ({ data: h.linhaDoAdmin, error: null });
      return c;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const op: Operacao = { tabela, tipo: "select", filtros: [] };
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.update = (valores: Record<string, unknown>) => {
        op.tipo = "update";
        op.valores = valores;
        return c;
      };
      c.eq = (coluna: string, valor: unknown) => {
        op.filtros.push([coluna, valor]);
        return c;
      };
      c.maybeSingle = async () => {
        h.operacoes.push(op);
        if (tabela === "organizations") return { data: h.org, error: null };
        // A rota consulta `ai_provider_credentials` em dois lugares: o GET (`is_active`) e a busca da
        // credencial existente depois de `label_em_uso` (filtra por `label`).
        const buscaPeloRotulo = op.filtros.some(([coluna]) => coluna === "label");
        return { data: buscaPeloRotulo ? h.credExistente : h.cred, error: null };
      };
      c.then = (resolve: (v: unknown) => unknown) => {
        h.operacoes.push(op);
        const erro = tabela === "organizations" ? h.erroNoUpdateDaOrg : null;
        return Promise.resolve({ error: erro }).then(resolve);
      };
      return c;
    },
  }),
}));

import { GET, PUT } from "./route";

const ctx = { params: Promise.resolve({ id: TENANT }) };
const adminDaPlataforma = (scope: string) => ({
  user_id: ATOR,
  scope,
  mfa_required: false,
  revoked_at: null,
});

function instalacaoCom(valores: Record<string, string>) {
  h.valorDaInstalacao.mockImplementation(async (chave: string) => ({
    valor: valores[chave] ?? null,
    fonte: chave in valores ? "banco" : "ausente",
  }));
}
const INSTALACAO_COMPLETA = { OMNIROUTER_BASE_URL: OMNI, OMNIROUTER_API_KEY: CHAVE_DA_INSTALACAO };
const SO_O_ENDERECO = { OMNIROUTER_BASE_URL: OMNI };

const pedidoPut = (body: unknown) =>
  new NextRequest(`http://localhost/api/v1/admin/tenants/${TENANT}/ai`, {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
const pedidoGet = () => new NextRequest(`http://localhost/api/v1/admin/tenants/${TENANT}/ai`);

const escritas = (tabela: string) =>
  h.operacoes.filter((o) => o.tipo === "update" && o.tabela === tabela);
const settingsGravados = () => escritas("organizations")[0]?.valores?.settings as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  h.linhaDoAdmin = adminDaPlataforma("full");
  h.mfaEmDivida.mockResolvedValue(false);
  h.requireSupportWrite.mockResolvedValue(null);
  h.guardar.mockResolvedValue({ ok: true, id: "cred-1", last4: "2222" });
  h.rotacionar.mockResolvedValue({ ok: true, id: "cred-existente", last4: "2222", trocouChave: true });
  h.org = { settings: {} };
  h.cred = null;
  h.credExistente = null;
  h.erroNoUpdateDaOrg = null;
  h.operacoes = [];
  instalacaoCom(INSTALACAO_COMPLETA);
});

describe("PUT — quem pode escrever e o que chega", () => {
  it("o apoio (suporte) sem permissão de escrita: devolve a recusa dele e não toca em nada", async () => {
    h.requireSupportWrite.mockResolvedValue(new Response("negado", { status: 403 }));
    const res = await PUT(pedidoPut({ habilitado: true }), ctx);
    expect(res.status).toBe(403);
    expect(h.requireSupportWrite).toHaveBeenCalledWith(TENANT);
    expect(h.operacoes).toEqual([]);
    expect(h.guardar).not.toHaveBeenCalled();
  });

  it("support_readonly: 403 forbidden_scope, nada gravado", async () => {
    h.linhaDoAdmin = adminDaPlataforma("support_readonly");
    const res = await PUT(pedidoPut({ habilitado: true }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_scope");
    expect(h.operacoes).toEqual([]);
  });

  it("quem tem fator e está em aal1: 403 mfa_required, nada gravado", async () => {
    h.mfaEmDivida.mockResolvedValue(true);
    const res = await PUT(pedidoPut({ habilitado: true }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("mfa_required");
    expect(h.operacoes).toEqual([]);
  });

  it("quem não é administrador da plataforma: 403, nada gravado", async () => {
    h.linhaDoAdmin = null;
    const res = await PUT(pedidoPut({ habilitado: true }), ctx);
    expect(res.status).toBe(403);
    expect(h.operacoes).toEqual([]);
  });

  it("JSON inválido: 400", async () => {
    const res = await PUT(pedidoPut("{não é json"), ctx);
    expect(res.status).toBe(400);
    expect(h.operacoes).toEqual([]);
  });

  it.each([{}, { habilitado: "sim" }, { habilitado: 1 }])("corpo %j: 422, nada gravado", async (corpo) => {
    const res = await PUT(pedidoPut(corpo), ctx);
    expect(res.status).toBe(422);
    expect(h.operacoes).toEqual([]);
  });

  it("organização que não existe: 404, nada gravado", async () => {
    h.org = null;
    const res = await PUT(pedidoPut({ habilitado: true }), ctx);
    expect(res.status).toBe(404);
    expect(escritas("organizations")).toEqual([]);
    expect(h.guardar).not.toHaveBeenCalled();
  });
});

describe("PUT habilitado — a instalação precisa ter o que a organização vai usar", () => {
  it("⭐ sem endereço na instalação: recusa e diz onde configurar, sem gravar nada", async () => {
    instalacaoCom({});
    const res = await PUT(pedidoPut({ habilitado: true }), ctx);
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/Credenciais/);
    expect(escritas("organizations")).toEqual([]);
    expect(escritas("ai_provider_credentials")).toEqual([]);
    expect(h.guardar).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("endereço torto na instalação (usuário e senha na URL): recusa como se não existisse", async () => {
    instalacaoCom({ OMNIROUTER_BASE_URL: "https://usuario:segredo@omnirouter.example.com", OMNIROUTER_API_KEY: CHAVE_DA_INSTALACAO });
    const res = await PUT(pedidoPut({ habilitado: true }), ctx);
    expect(res.status).toBe(422);
    expect(escritas("organizations")).toEqual([]);
  });

  it("⭐ endereço mas sem chave da instalação e sem chave individual: recusa (ficaria habilitada sem IA)", async () => {
    instalacaoCom(SO_O_ENDERECO);
    const res = await PUT(pedidoPut({ habilitado: true }), ctx);
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/chave do OmniRouter/);
    expect(escritas("organizations")).toEqual([]);
  });

  it("⭐ modelo de outra família herdando a conexão da instalação (anthropic): recusa antes de gravar", async () => {
    const res = await PUT(pedidoPut({ habilitado: true, model: "gpt-5" }), ctx);
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/Modelo recusado/);
    expect(escritas("organizations")).toEqual([]);
  });
});

describe("PUT habilitado, SEM chave: a organização herda a conexão da instalação", () => {
  it("⭐ nenhuma chave é copiada: guarda só a escolha, o provedor anthropic e o modelo", async () => {
    const res = await PUT(pedidoPut({ habilitado: true }), ctx);
    expect(res.status).toBe(200);
    expect(h.guardar).not.toHaveBeenCalled();
    expect(h.rotacionar).not.toHaveBeenCalled();

    const s = settingsGravados();
    expect(s.omnirouter).toMatchObject({ habilitado: true, chave_individual: false });
    expect(s.llm).toMatchObject({ provider: "anthropic", default_model: "claude-haiku-5-5" });
    expect(JSON.stringify(s)).not.toContain(CHAVE_DA_INSTALACAO);
  });

  it("a cópia que uma versão antiga desta rota deixou sai de uso (só a de rótulo OmniRouter Corporativo)", async () => {
    await PUT(pedidoPut({ habilitado: true }), ctx);
    const [desativa] = escritas("ai_provider_credentials");
    expect(desativa?.valores).toEqual({ is_active: false });
    expect(desativa?.filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", TENANT],
        ["provider", "custom"],
        ["label", "OmniRouter Corporativo"],
      ]),
    );
  });

  it("preserva o resto das configurações da organização (outras chaves e o resto de `llm`)", async () => {
    h.org = { settings: { tema: "escuro", llm: { provider: "openai", default_model: "gpt-5", temperature: 0.2 } } };
    await PUT(pedidoPut({ habilitado: true, model: "claude-sonnet-5" }), ctx);
    const s = settingsGravados();
    expect(s.tema).toBe("escuro");
    expect(s.llm).toEqual({ provider: "anthropic", default_model: "claude-sonnet-5", temperature: 0.2 });
  });

  it("audita o fato (habilitado, modelo, se é chave individual) e nunca uma chave", async () => {
    const res = await PUT(pedidoPut({ habilitado: true }), ctx);
    expect(h.audit).toHaveBeenCalledTimes(1);
    const registro = h.audit.mock.calls[0]![0];
    expect(registro).toMatchObject({
      action: "platform_admin.tenant_omnirouter_configured",
      actorUserId: ATOR,
      organizationId: TENANT,
      metadata: { habilitado: true, model: "claude-haiku-5-5", chave_individual: false },
    });
    expect(JSON.stringify(registro)).not.toContain(CHAVE_DA_INSTALACAO);
    expect(JSON.stringify(await res.json())).not.toContain(CHAVE_DA_INSTALACAO);
  });
});

describe("PUT habilitado, COM chave individual: a organização usa a própria chave", () => {
  it("⭐ guarda no cofre como credencial `custom`, apontada para o endereço da instalação", async () => {
    const res = await PUT(pedidoPut({ habilitado: true, apiKey: CHAVE_INDIVIDUAL }), ctx);
    expect(res.status).toBe(200);
    expect(h.guardar).toHaveBeenCalledTimes(1);
    expect(h.guardar.mock.calls[0]![0]).toMatchObject({
      orgId: TENANT,
      userId: ATOR,
      provider: "custom",
      label: "OmniRouter Corporativo",
      apiKey: CHAVE_INDIVIDUAL,
      baseUrl: OMNI_NORMALIZADO,
    });
  });

  it("⭐ a chave individual nunca vai a `settings`, à auditoria nem à resposta", async () => {
    const res = await PUT(pedidoPut({ habilitado: true, apiKey: CHAVE_INDIVIDUAL }), ctx);
    const s = settingsGravados();
    expect(s.omnirouter).toMatchObject({ habilitado: true, chave_individual: true });
    expect(s.llm).toMatchObject({ provider: "custom" });
    expect(JSON.stringify(s)).not.toContain(CHAVE_INDIVIDUAL);
    expect(JSON.stringify(h.audit.mock.calls[0]![0])).not.toContain(CHAVE_INDIVIDUAL);
    expect(h.audit.mock.calls[0]![0].metadata).toMatchObject({ chave_individual: true });
    expect(JSON.stringify(await res.json())).not.toContain(CHAVE_INDIVIDUAL);
  });

  it("a chave individual dispensa a da instalação: só o endereço basta", async () => {
    instalacaoCom(SO_O_ENDERECO);
    const res = await PUT(pedidoPut({ habilitado: true, apiKey: CHAVE_INDIVIDUAL }), ctx);
    expect(res.status).toBe(200);
    expect(h.guardar).toHaveBeenCalledTimes(1);
  });

  it("não desativa a credencial que acabou de guardar", async () => {
    await PUT(pedidoPut({ habilitado: true, apiKey: CHAVE_INDIVIDUAL }), ctx);
    expect(escritas("ai_provider_credentials")).toEqual([]);
  });

  it("com chave individual, o modelo pode ser de qualquer família (provedor `custom` é agregador)", async () => {
    const res = await PUT(pedidoPut({ habilitado: true, apiKey: CHAVE_INDIVIDUAL, model: "gpt-5" }), ctx);
    expect(res.status).toBe(200);
    expect(settingsGravados().llm).toMatchObject({ provider: "custom", default_model: "gpt-5" });
  });

  it("rótulo já em uso: a MESMA credencial recebe a chave nova, volta a ficar ativa e aponta para o endereço de hoje", async () => {
    h.guardar.mockResolvedValue({ ok: false, motivo: "label_em_uso" });
    h.credExistente = { id: "cred-existente" };
    const res = await PUT(pedidoPut({ habilitado: true, apiKey: CHAVE_INDIVIDUAL }), ctx);
    expect(res.status).toBe(200);
    expect(h.rotacionar).toHaveBeenCalledTimes(1);
    expect(h.rotacionar.mock.calls[0]![0]).toMatchObject({
      orgId: TENANT,
      credentialId: "cred-existente",
      provider: "custom",
      apiKey: CHAVE_INDIVIDUAL,
    });
    const [reativa] = escritas("ai_provider_credentials");
    expect(reativa?.valores).toEqual({ is_active: true, base_url: OMNI_NORMALIZADO });
    expect(reativa?.filtros).toEqual(expect.arrayContaining([["id", "cred-existente"], ["organization_id", TENANT]]));
  });

  it("rótulo em uso mas a credencial sumiu: 500 e a organização NÃO é alterada", async () => {
    h.guardar.mockResolvedValue({ ok: false, motivo: "label_em_uso" });
    h.credExistente = null;
    const res = await PUT(pedidoPut({ habilitado: true, apiKey: CHAVE_INDIVIDUAL }), ctx);
    expect(res.status).toBe(500);
    expect(escritas("organizations")).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("falha ao rotacionar: 500 e a organização NÃO é alterada", async () => {
    h.guardar.mockResolvedValue({ ok: false, motivo: "label_em_uso" });
    h.credExistente = { id: "cred-existente" };
    h.rotacionar.mockResolvedValue({ ok: false, motivo: "banco" });
    const res = await PUT(pedidoPut({ habilitado: true, apiKey: CHAVE_INDIVIDUAL }), ctx);
    expect(res.status).toBe(500);
    expect(escritas("organizations")).toEqual([]);
  });

  it.each(["cifragem", "banco"] as const)("falha ao guardar (%s): 500 e a organização NÃO é alterada", async (motivo) => {
    h.guardar.mockResolvedValue({ ok: false, motivo });
    const res = await PUT(pedidoPut({ habilitado: true, apiKey: CHAVE_INDIVIDUAL }), ctx);
    expect(res.status).toBe(500);
    expect(escritas("organizations")).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("PUT habilitado, chave em branco, em organização que JÁ tem chave individual", () => {
  beforeEach(() => {
    h.org = {
      settings: {
        omnirouter: { habilitado: true, chave_individual: true },
        llm: { provider: "custom", default_model: "claude-haiku-5-5" },
      },
    };
  });

  it("⭐ mantém a chave dela (não troca em silêncio pela da instalação) e só muda o modelo", async () => {
    const res = await PUT(pedidoPut({ habilitado: true, model: "claude-sonnet-5" }), ctx);
    expect(res.status).toBe(200);
    expect(h.guardar).not.toHaveBeenCalled();
    expect(escritas("ai_provider_credentials")).toEqual([]);
    const s = settingsGravados();
    expect(s.omnirouter).toMatchObject({ habilitado: true, chave_individual: true });
    expect(s.llm).toMatchObject({ provider: "custom", default_model: "claude-sonnet-5" });
  });

  it("⭐ funciona mesmo que a instalação ainda não tenha chave padrão (a organização não depende dela)", async () => {
    instalacaoCom(SO_O_ENDERECO);
    const res = await PUT(pedidoPut({ habilitado: true }), ctx);
    expect(res.status).toBe(200);
    expect(settingsGravados().omnirouter).toMatchObject({ habilitado: true, chave_individual: true });
  });
});

describe("PUT recusando: `habilitado: false`", () => {
  it("grava a recusa (vale também contra a oferta geral), desativa só a credencial desta rota e não mexe em `llm`", async () => {
    h.org = {
      settings: {
        omnirouter: { habilitado: true, chave_individual: true },
        llm: { provider: "custom", default_model: "claude-haiku-5-5" },
      },
    };
    const res = await PUT(pedidoPut({ habilitado: false }), ctx);
    expect(res.status).toBe(200);

    const s = settingsGravados();
    expect(s.omnirouter).toMatchObject({ habilitado: false, chave_individual: false });
    expect(s.llm).toEqual({ provider: "custom", default_model: "claude-haiku-5-5" });

    const [desativa] = escritas("ai_provider_credentials");
    expect(desativa?.valores).toEqual({ is_active: false });
    expect(desativa?.filtros).toEqual(expect.arrayContaining([["label", "OmniRouter Corporativo"], ["provider", "custom"]]));
    expect(h.guardar).not.toHaveBeenCalled();
  });

  it("recusar não depende de a instalação estar configurada", async () => {
    instalacaoCom({});
    const res = await PUT(pedidoPut({ habilitado: false }), ctx);
    expect(res.status).toBe(200);
    expect(settingsGravados().omnirouter).toMatchObject({ habilitado: false });
  });

  it("ignora a chave que vier junto (não guarda nada)", async () => {
    await PUT(pedidoPut({ habilitado: false, apiKey: CHAVE_INDIVIDUAL }), ctx);
    expect(h.guardar).not.toHaveBeenCalled();
    expect(JSON.stringify(settingsGravados())).not.toContain(CHAVE_INDIVIDUAL);
  });

  it("falha ao gravar a organização: 500 e sem auditoria", async () => {
    h.erroNoUpdateDaOrg = { message: "falha-sintetica" };
    const res = await PUT(pedidoPut({ habilitado: false }), ctx);
    expect(res.status).toBe(500);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("GET — o que a tela mostra", () => {
  it("quem não é administrador da plataforma: 403", async () => {
    h.linhaDoAdmin = null;
    const res = await GET(pedidoGet(), ctx);
    expect(res.status).toBe(403);
  });

  it("organização que não existe: 404", async () => {
    h.org = null;
    const res = await GET(pedidoGet(), ctx);
    expect(res.status).toBe(404);
  });

  it("instalação sem OmniRouter: nada configurado, nada atendido, endereço vazio", async () => {
    instalacaoCom({});
    const corpo = (await (await GET(pedidoGet(), ctx)).json()).data;
    expect(corpo).toMatchObject({
      habilitado: false,
      escolha: null,
      atendida: false,
      instalacao_configurada: false,
      oferta_geral: false,
      omnirouter_base_url: "",
      credencial_configurada: false,
      credencial_detalhes: null,
    });
  });

  it("organização escolhida e instalação configurada: atendida, com o endereço normalizado", async () => {
    h.org = { settings: { omnirouter: { habilitado: true }, llm: { provider: "anthropic", default_model: "claude-haiku-5-5" } } };
    const corpo = (await (await GET(pedidoGet(), ctx)).json()).data;
    expect(corpo).toMatchObject({
      habilitado: true,
      escolha: true,
      atendida: true,
      instalacao_configurada: true,
      omnirouter_base_url: OMNI_NORMALIZADO,
      provedor_atual: "anthropic",
      modelo_atual: "claude-haiku-5-5",
    });
  });

  it("⭐ sem escolha, a oferta geral decide (e a tela distingue 'sem escolha' de 'recusada')", async () => {
    instalacaoCom({ ...INSTALACAO_COMPLETA, OMNIROUTER_PARA_TODAS: "true" });
    const semEscolha = (await (await GET(pedidoGet(), ctx)).json()).data;
    expect(semEscolha).toMatchObject({ habilitado: false, escolha: null, oferta_geral: true, atendida: true });

    h.org = { settings: { omnirouter: { habilitado: false } } };
    const recusada = (await (await GET(pedidoGet(), ctx)).json()).data;
    expect(recusada).toMatchObject({ habilitado: false, escolha: false, oferta_geral: true, atendida: false });
  });

  it("organização escolhida mas a instalação sem chave: não é atendida (a tela avisa)", async () => {
    instalacaoCom(SO_O_ENDERECO);
    h.org = { settings: { omnirouter: { habilitado: true } } };
    const corpo = (await (await GET(pedidoGet(), ctx)).json()).data;
    expect(corpo).toMatchObject({ habilitado: true, instalacao_configurada: false, atendida: false });
  });

  it("⭐ nunca devolve a chave (da instalação nem a individual); a credencial vem só com os metadados", async () => {
    h.org = { settings: { omnirouter: { habilitado: true, chave_individual: true } } };
    h.cred = {
      id: "cred-1",
      label: "OmniRouter Corporativo",
      provider: "custom",
      base_url: OMNI_NORMALIZADO,
      is_active: true,
      created_at: "2026-10-16T12:00:00Z",
      validated_at: null,
    };
    const res = await GET(pedidoGet(), ctx);
    const texto = JSON.stringify(await res.json());
    expect(texto).not.toContain(CHAVE_DA_INSTALACAO);
    expect(texto).not.toContain(CHAVE_INDIVIDUAL);
    const corpo = JSON.parse(texto).data;
    expect(corpo.credencial_configurada).toBe(true);
    expect(corpo.credencial_detalhes).toEqual({
      id: "cred-1",
      label: "OmniRouter Corporativo",
      base_url: OMNI_NORMALIZADO,
      validada: false,
    });
  });
});
