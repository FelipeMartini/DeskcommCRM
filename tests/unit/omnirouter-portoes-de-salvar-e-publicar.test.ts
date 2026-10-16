/**
 * O OMNIROUTER E OS PORTÕES DE SALVAR E PUBLICAR AGENTE.
 *
 * O vão que este arquivo fecha: a tela de agente e a rota de versões só aceitavam "a chave desta
 * instalação" para o `anthropic` se existisse `ANTHROPIC_API_KEY` no `.env`. Uma instalação que atende
 * pelo OmniRouter não tem essa variável — de propósito, é o desenho —, então a pessoa não conseguia
 * SALVAR nem PUBLICAR o agente que o motor sabe atender. O motor funcionava; a porta de entrada dizia
 * "esta instalação não tem chave de anthropic".
 *
 * Este arquivo é o sucessor do que existia para a antiga ponte. O que se prova (cada item com o caso
 * que PEGA e o que PASSA):
 *
 *   1. `omniRouterAtendeAOrganizacao` é pergunta de existência: nunca lança, nunca devolve a chave, e
 *      configuração malformada vale `false` (a recusa de antes), não "sim";
 *   2. `lerAmbiente(fonte, anthropicViaOmniRouter)` conta o `anthropic` quando o OmniRouter atende a
 *      organização e só ele; sem isso a leitura é a de sempre (regressão zero);
 *   3. `publishAgentVersion` deixa passar `credential_id: null` quando o OmniRouter atende a organização
 *      e continua recusando (`credential_missing`) quando não atende — inclusive para a organização que
 *      RECUSOU, mesmo com a oferta geral ligada;
 *   4. a rota de versões e as duas páginas do formulário PASSAM a resposta do OmniRouter para
 *      `lerAmbiente` (sem ela, o conserto some em silêncio — e nenhum teste de comportamento notaria,
 *      porque o `lerAmbiente()` sem o segundo argumento continua válido).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ valorDaInstalacao: vi.fn() }));
vi.mock("@/lib/ai/runtime/agent", () => ({ chaveDePlataforma: vi.fn(() => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: mocks.valorDaInstalacao }));

import { publishAgentVersion } from "@/lib/ai/agents/publish";
import { omniRouterAtendeAOrganizacao } from "@/lib/ai/omnirouter";
import { lerAmbiente } from "@/lib/instalacao/ambiente";

const ORG = "11111111-1111-4111-8111-111111111111";
const OMNI = "http://omnirouter:20128";
const CHAVE_SINTETICA = "chave-sintetica-do-omnirouter";

const POSTO = { OMNIROUTER_BASE_URL: OMNI, OMNIROUTER_API_KEY: CHAVE_SINTETICA };

/** O que a tela de Credenciais (ou o `.env`) devolve; o que não está aqui vale "ausente". */
function instalacaoCom(valores: Record<string, string>) {
  mocks.valorDaInstalacao.mockImplementation(async (chave: string) => ({
    valor: valores[chave] ?? null,
    fonte: chave in valores ? "banco" : "ausente",
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  instalacaoCom({});
});

describe("omniRouterAtendeAOrganizacao — a pergunta de existência", () => {
  it("atende a organização ESCOLHIDA quando endereço e chave estão em ordem", () => {
    expect(omniRouterAtendeAOrganizacao(POSTO, true)).toBe(true);
  });

  it("não atende quem não foi escolhida, nem sem variáveis", () => {
    expect(omniRouterAtendeAOrganizacao(POSTO, undefined)).toBe(false);
    expect(omniRouterAtendeAOrganizacao(undefined, true)).toBe(false);
    expect(omniRouterAtendeAOrganizacao({}, true)).toBe(false);
  });

  it("⭐ a oferta geral atende quem não escolheu, mas NUNCA quem recusou", () => {
    const todas = { ...POSTO, OMNIROUTER_PARA_TODAS: "true" };
    expect(omniRouterAtendeAOrganizacao(todas, undefined)).toBe(true);
    expect(omniRouterAtendeAOrganizacao(todas, true)).toBe(true);
    expect(omniRouterAtendeAOrganizacao(todas, false)).toBe(false);
  });

  it.each([
    ["endereço que não é URL", { OMNIROUTER_BASE_URL: "omnirouter" }],
    ["endereço com credencial", { OMNIROUTER_BASE_URL: "http://u:s@omnirouter:20128" }],
    ["endereço com consulta", { OMNIROUTER_BASE_URL: `${OMNI}/v1?x=1` }],
    ["endereço com protocolo estranho", { OMNIROUTER_BASE_URL: "ftp://omnirouter" }],
    ["chave ausente", { OMNIROUTER_API_KEY: "" }],
    ["chave com espaço", { OMNIROUTER_API_KEY: "duas palavras" }],
  ])("configuração malformada (%s) vale `false` e NUNCA lança", (_nome, quebra) => {
    const quebrada = { ...POSTO, ...quebra };
    expect(() => omniRouterAtendeAOrganizacao(quebrada, true)).not.toThrow();
    expect(omniRouterAtendeAOrganizacao(quebrada, true)).toBe(false);
  });
});

describe("lerAmbiente(fonte, anthropicViaOmniRouter) — a chave da instalação conta o OmniRouter", () => {
  it("o anthropic passa a existir quando o OmniRouter atende, sem ANTHROPIC_API_KEY", () => {
    expect(lerAmbiente({}).chavesDeProvedor.anthropic).toBe(false);
    expect(lerAmbiente({}, true).chavesDeProvedor.anthropic).toBe(true);
  });

  it("só o anthropic muda: nenhum outro provedor ganha chave pelo OmniRouter", () => {
    const sem = lerAmbiente({});
    const com = lerAmbiente({}, true);
    for (const [id, tem] of Object.entries(com.chavesDeProvedor)) {
      if (id === "anthropic") continue;
      expect(tem, id).toBe(sem.chavesDeProvedor[id]);
      expect(tem, id).toBe(false);
    }
    expect(com.gateway).toBe(sem.gateway);
    expect(com.email).toBe(sem.email);
    expect(com.transporteDeWhatsapp).toEqual(sem.transporteDeWhatsapp);
  });

  it("sem o segundo argumento ou com `false`, a leitura é a de sempre (regressão zero)", () => {
    expect(lerAmbiente({ ...POSTO }).chavesDeProvedor.anthropic).toBe(false);
    expect(lerAmbiente({ ...POSTO }, false).chavesDeProvedor.anthropic).toBe(false);
    const vazio = lerAmbiente({}, false);
    expect(Object.values(vazio.chavesDeProvedor).some(Boolean)).toBe(false);
  });

  it("a chave do .env continua valendo, com ou sem OmniRouter", () => {
    const comChave = { ANTHROPIC_API_KEY: "sk-ant-sintetica", OPENAI_API_KEY: "sk-proj-sintetica" };
    expect(lerAmbiente(comChave).chavesDeProvedor.anthropic).toBe(true);
    expect(lerAmbiente(comChave, true).chavesDeProvedor.anthropic).toBe(true);
    expect(lerAmbiente(comChave, false).chavesDeProvedor.anthropic).toBe(true);
    expect(lerAmbiente(comChave, true).chavesDeProvedor.openai).toBe(true);
  });
});

/**
 * Um `admin` mínimo: lê a versão e as configurações da organização (a escolha do OmniRouter mora em
 * `organizations.settings.omnirouter`) e responde ao RPC com o que o teste mandar.
 */
function adminDaVersao(
  version: Record<string, unknown>,
  rpcDeErro: string,
  omnirouterDaOrganizacao?: Record<string, unknown>,
) {
  const rpc = vi.fn(async () => ({ data: null, error: { message: rpcDeErro } }));
  const admin = {
    from: (tabela: string) => {
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) builder[m] = () => builder;
      builder.maybeSingle = async () =>
        tabela === "organizations"
          ? {
              data: {
                settings: {
                  llm: { provider: "anthropic" },
                  ...(omnirouterDaOrganizacao ? { omnirouter: omnirouterDaOrganizacao } : {}),
                },
              },
              error: null,
            }
          : { data: version, error: null };
      return builder;
    },
    rpc,
  };
  return { admin: admin as unknown as Parameters<typeof publishAgentVersion>[0], rpc };
}

describe("publishAgentVersion — credential_id nulo precisa de uma chave de instalação", () => {
  const params = { orgId: ORG, agentId: "agente-1", versionId: "versao-1" };
  const versao = { provider: "anthropic", credential_id: null, handoff_legal_enabled: true };

  it("recusa (credential_missing) quando nem o .env nem o OmniRouter têm chave para a organização", async () => {
    const { admin, rpc } = adminDaVersao(versao, "nao-deveria-chegar");
    const r = await publishAgentVersion(admin, params);
    expect(r).toEqual({ ok: false, code: "credential_missing", message: "credential_missing" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("recusa quando o OmniRouter está configurado, mas a organização NÃO foi escolhida", async () => {
    instalacaoCom(POSTO);
    const { admin, rpc } = adminDaVersao(versao, "nao-deveria-chegar");
    const r = await publishAgentVersion(admin, params);
    expect(r).toMatchObject({ ok: false, code: "credential_missing" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("⭐ deixa passar (chega ao RPC) quando o OmniRouter atende a organização escolhida", async () => {
    instalacaoCom(POSTO);
    const { admin, rpc } = adminDaVersao(versao, "parou-no-rpc", { habilitado: true });
    const r = await publishAgentVersion(admin, params);
    // O RPC devolve erro de propósito: o que importa aqui é que o portão deixou chegar nele.
    expect(r).toMatchObject({ ok: false, code: "internal_error", message: "parou-no-rpc" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("⭐ a oferta geral deixa passar quem não escolheu", async () => {
    instalacaoCom({ ...POSTO, OMNIROUTER_PARA_TODAS: "true" });
    const { admin, rpc } = adminDaVersao(versao, "parou-no-rpc");
    const r = await publishAgentVersion(admin, params);
    expect(r).toMatchObject({ code: "internal_error", message: "parou-no-rpc" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("⭐ recusa quando a organização RECUSOU o OmniRouter, mesmo com a oferta geral ligada", async () => {
    instalacaoCom({ ...POSTO, OMNIROUTER_PARA_TODAS: "true" });
    const { admin, rpc } = adminDaVersao(versao, "nao-deveria-chegar", { habilitado: false });
    const r = await publishAgentVersion(admin, params);
    expect(r).toMatchObject({ ok: false, code: "credential_missing" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("o OmniRouter só vale para o anthropic: uma versão openai sem chave continua barrada", async () => {
    instalacaoCom(POSTO);
    const { admin, rpc } = adminDaVersao({ ...versao, provider: "openai" }, "nao-deveria-chegar", {
      habilitado: true,
    });
    expect(await publishAgentVersion(admin, params)).toMatchObject({ code: "credential_missing" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("configuração do OmniRouter malformada não vira chave: a recusa de antes continua", async () => {
    instalacaoCom({ OMNIROUTER_BASE_URL: "nao-e-url", OMNIROUTER_API_KEY: CHAVE_SINTETICA });
    const { admin, rpc } = adminDaVersao(versao, "nao-deveria-chegar", { habilitado: true });
    expect(await publishAgentVersion(admin, params)).toMatchObject({ code: "credential_missing" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("versão com credencial própria nunca consulta a instalação", async () => {
    const { admin, rpc } = adminDaVersao(
      { ...versao, credential_id: "credencial-1" },
      "parou-no-rpc",
    );
    const r = await publishAgentVersion(admin, params);
    expect(r).toMatchObject({ code: "internal_error", message: "parou-no-rpc" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(mocks.valorDaInstalacao).not.toHaveBeenCalled();
  });
});

describe("quem pergunta 'a instalação tem chave?' passa a resposta do OmniRouter", () => {
  const ler = (relativo: string) => readFileSync(join(process.cwd(), relativo), "utf8");

  it("a rota de versões confere a chave com a organização do chamador", () => {
    const fonte = ler("app/api/v1/ai/agents/[id]/versions/route.ts");
    expect(fonte).toMatch(
      /lerAmbiente\(\s*process\.env,\s*await omniRouterServeAOrganizacao\(admin,\s*v\.provider,\s*organizationId\)/,
    );
    expect(fonte).not.toMatch(/lerAmbiente\(\)\.chavesDeProvedor/);
  });

  it.each(["app/app/ai/agents/[id]/page.tsx", "app/app/ai/agents/new/page.tsx"])(
    "%s monta a lista de provedores da instalação para a organização ativa",
    (arquivo) => {
      const fonte = ler(arquivo);
      expect(fonte).toMatch(/lerAmbiente\(process\.env,\s*anthropicViaOmniRouter\)/);
      expect(fonte).toMatch(
        /omniRouterServeAOrganizacao\(createAdminClient\(\),\s*"anthropic",\s*activeOrg\.orgId\)/,
      );
      expect(fonte).not.toMatch(/lerAmbiente\(\)/);
    },
  );

  it("a tela de Credenciais usa a mesma resposta para o retrato e para o aviso da organização", () => {
    const fonte = ler("app/app/ai/credentials/page.tsx");
    expect(fonte).toMatch(/omniRouterServeAOrganizacao\(supabase,\s*"anthropic",\s*activeOrg\.orgId\)/);
    expect(fonte).toMatch(/lerAmbiente\(process\.env,\s*omniRouterAtende\)/);
    expect(fonte).toMatch(/<CartaoDoOmniRouter\b/);
  });
});
