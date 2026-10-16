/**
 * As chaves da cobrança do revendedor têm escritora própria (spec §7a, §10): a
 * Conexão confere a chave com o provedor, registra o webhook e recusa trocar o
 * provedor de quem tem assinatura viva. As ações genéricas só olham `controle`
 * — sem esta recusa, trocariam a chave Stripe sem nada disso.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ gravar: vi.fn(), voltar: vi.fn(), audit: vi.fn() }));

// A ação passa por `escritaDeAdminOuRecusa` (cerca admin-escrita-exige-scope-full, regra D:
// arquivo "use server" não chama `requirePlatformAdminEscrita` direto).
vi.mock("@/lib/auth/escritaDeAdminOuRecusa", () => ({
  escritaDeAdminOuRecusa: async () => ({ ok: true, ctx: { user: { id: "dono" } } }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/instalacao/config", () => ({
  gravarPelaTela: deps.gravar,
  voltarAoAmbiente: deps.voltar,
  estadoParaTela: async (chave: string) => ({
    chave, fonte: "banco", configurado: true, last4: null, ehSegredo: false, valorVisivel: null,
  }),
}));

import { CATALOGO_DA_INSTALACAO } from "@/lib/instalacao/catalogo";

import { salvarConfiguracaoDaInstalacao, voltarConfiguracaoAoPadrao } from "./salvarConfiguracaoDaInstalacao";

const DA_COBRANCA = CATALOGO_DA_INSTALACAO.filter((c) => c.telaDona === "cobranca").map((c) => c.chave);

beforeEach(() => {
  vi.clearAllMocks();
  deps.gravar.mockResolvedValue({ ok: true });
  deps.voltar.mockResolvedValue({ ok: true });
});

describe("as chaves da cobrança só se escrevem pela tela de Cobrança", () => {
  it("controle: a sonda enxerga as seis chaves da cobrança (Stripe e Asaas)", () => {
    expect(DA_COBRANCA).toHaveLength(6);
  });

  it.each(DA_COBRANCA)("salvar %s pela ação genérica é recusado sem gravar nem auditar", async (chave) => {
    const r = await salvarConfiguracaoDaInstalacao(chave, "valor-qualquer-1234");
    expect(r).toEqual({ ok: false, erro: "Esta configuração não pode ser alterada por aqui." });
    expect(deps.gravar).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it.each(DA_COBRANCA)("voltar %s ao padrão pela ação genérica é recusado sem apagar", async (chave) => {
    const r = await voltarConfiguracaoAoPadrao(chave);
    expect(r).toEqual({ ok: false, erro: "Esta configuração não pode ser alterada por aqui." });
    expect(deps.voltar).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("controle: uma chave de outra tela continua gravando", async () => {
    const r = await salvarConfiguracaoDaInstalacao("SUPPORT_EMAIL", "ajuda@exemplo.com");
    expect(r.ok).toBe(true);
    expect(deps.gravar).toHaveBeenCalledWith("SUPPORT_EMAIL", "ajuda@exemplo.com", expect.objectContaining({ ehSegredo: false }));
  });
});

/**
 * O OmniRouter é editável pela tela de Credenciais (ordem do dono, 16/10/2026): o endereço e a chave
 * da instalação. A ação confere o valor ANTES de gravar, e a auditoria leva o fato, nunca o valor.
 */
describe("as chaves do OmniRouter: gravam o que presta e recusam o que não presta", () => {
  const CHAVE_SINTETICA = "chave-sintetica-do-omnirouter-9876";

  it("o catálogo as oferece como editáveis, na tela de Credenciais, no grupo de IA", () => {
    for (const chave of ["OMNIROUTER_BASE_URL", "OMNIROUTER_API_KEY", "OMNIROUTER_PARA_TODAS"]) {
      const c = CATALOGO_DA_INSTALACAO.find((x) => x.chave === chave);
      expect(c, chave).toBeDefined();
      expect(c).toMatchObject({ controle: "edita", grupo: "ia" });
      expect(c!.telaDona ?? "credenciais").toBe("credenciais");
    }
    expect(CATALOGO_DA_INSTALACAO.find((x) => x.chave === "OMNIROUTER_API_KEY")!.natureza).toBe("segredo");
  });

  it("endereço válido: grava como texto", async () => {
    const r = await salvarConfiguracaoDaInstalacao("OMNIROUTER_BASE_URL", "  https://omnirouter.example.com  ");
    expect(r.ok).toBe(true);
    expect(deps.gravar).toHaveBeenCalledWith(
      "OMNIROUTER_BASE_URL",
      "https://omnirouter.example.com",
      expect.objectContaining({ ehSegredo: false }),
    );
  });

  it("⭐ chave: grava como SEGREDO, e a auditoria leva só o fato e os últimos 4 — nunca o valor", async () => {
    const r = await salvarConfiguracaoDaInstalacao("OMNIROUTER_API_KEY", CHAVE_SINTETICA);
    expect(r.ok).toBe(true);
    expect(deps.gravar).toHaveBeenCalledWith(
      "OMNIROUTER_API_KEY",
      CHAVE_SINTETICA,
      expect.objectContaining({ ehSegredo: true }),
    );
    expect(deps.audit).toHaveBeenCalledTimes(1);
    const registro = JSON.stringify(deps.audit.mock.calls[0]![0]);
    expect(registro).toContain("OMNIROUTER_API_KEY");
    expect(registro).toContain("9876");
    expect(registro).not.toContain(CHAVE_SINTETICA);
  });

  it.each([
    ["OMNIROUTER_BASE_URL", "omnirouter"],
    ["OMNIROUTER_BASE_URL", "https://usuario:segredo-sintetico@omnirouter.example.com"],
    ["OMNIROUTER_BASE_URL", "https://omnirouter.example.com/v1?x=1"],
    ["OMNIROUTER_API_KEY", "duas palavras"],
    ["OMNIROUTER_PARA_TODAS", "talvez"],
  ])("⭐ %s com valor torto (%j): recusa SEM gravar nem auditar, e sem repetir o valor", async (chave, valor) => {
    const r = await salvarConfiguracaoDaInstalacao(chave, valor);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.erro.length).toBeGreaterThan(10);
      expect(r.erro).not.toContain("segredo-sintetico");
      expect(r.erro).not.toContain("duas palavras");
    }
    expect(deps.gravar).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("voltar ao padrão apaga a linha (o `.env` volta a responder) e audita só o nome", async () => {
    const r = await voltarConfiguracaoAoPadrao("OMNIROUTER_BASE_URL");
    expect(r.ok).toBe(true);
    expect(deps.voltar).toHaveBeenCalledWith("OMNIROUTER_BASE_URL");
    expect(deps.audit).toHaveBeenCalledTimes(1);
  });
});
