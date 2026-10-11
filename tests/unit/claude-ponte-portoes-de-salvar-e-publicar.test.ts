/**
 * A CLAUDE-PONTE E OS PORTÕES DE SALVAR E PUBLICAR AGENTE.
 *
 * O vão que este arquivo fecha: a tela de agente e a rota de versões só aceitavam "a chave desta
 * instalação" para o `anthropic` se existisse `ANTHROPIC_API_KEY` no `.env`. Uma instalação que
 * atende pela claude-ponte (`CLAUDE_PONTE_*`) não tem essa variável — de propósito, é o desenho —,
 * então a pessoa não conseguia SALVAR nem PUBLICAR o agente que o motor sabe atender. O motor
 * funcionava; a porta de entrada dizia "esta instalação não tem chave de anthropic".
 *
 * O que se prova (cada item com o caso que PEGA e o que PASSA):
 *
 *   1. `ponteAtendeAOrganizacao` é pergunta de existência: nunca lança, nunca devolve a chave, e
 *      variável malformada vale `false` (a recusa de antes), não "sim";
 *   2. `lerAmbiente(fonte, organização)` conta o `anthropic` quando a ponte atende ESSA
 *      organização; sem a organização, ou fora da lista, ou sem as variáveis, a leitura é a de
 *      sempre (regressão zero) e só o `anthropic` é tocado;
 *   3. `publishAgentVersion` deixa passar `credential_id: null` quando a ponte atende a
 *      organização e continua recusando (`credential_missing`) quando não atende;
 *   4. a rota de versões e as duas páginas do formulário PASSAM a organização (sem ela, o
 *      conserto some em silêncio — e nenhum teste de comportamento notaria, porque o
 *      `lerAmbiente()` sem argumento continua válido).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/runtime/agent", () => ({ chaveDePlataforma: vi.fn(() => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { ponteAtendeAOrganizacao } from "@/lib/ai/claude-ponte";
import { publishAgentVersion } from "@/lib/ai/agents/publish";
import { lerAmbiente, ponteCobreOProvedor } from "@/lib/instalacao/ambiente";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "22222222-2222-4222-8222-222222222222";
const PONTE = "http://claude-ponte:8080";
const CHAVE_SINTETICA = "chave-sintetica-da-ponte";

const LIGADA = {
  CLAUDE_PONTE_BASE_URL: PONTE,
  CLAUDE_PONTE_API_KEY: CHAVE_SINTETICA,
  CLAUDE_PONTE_ORGS: ORG,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ponteAtendeAOrganizacao — a pergunta de existência", () => {
  it("atende a organização da lista quando as três variáveis estão em ordem", () => {
    expect(ponteAtendeAOrganizacao(LIGADA, ORG)).toBe(true);
    expect(ponteAtendeAOrganizacao(LIGADA, ORG.toUpperCase())).toBe(true);
  });

  it("não atende quem está fora da lista, nem lista vazia, nem sem variáveis", () => {
    expect(ponteAtendeAOrganizacao(LIGADA, OUTRA_ORG)).toBe(false);
    expect(ponteAtendeAOrganizacao({ ...LIGADA, CLAUDE_PONTE_ORGS: "" }, ORG)).toBe(false);
    expect(ponteAtendeAOrganizacao(undefined, ORG)).toBe(false);
    expect(ponteAtendeAOrganizacao({}, ORG)).toBe(false);
  });

  it("`*` atende toda organização, e só com as variáveis em ordem", () => {
    const todas = { ...LIGADA, CLAUDE_PONTE_ORGS: "*" };
    expect(ponteAtendeAOrganizacao(todas, ORG)).toBe(true);
    expect(ponteAtendeAOrganizacao(todas, OUTRA_ORG)).toBe(true);
    expect(ponteAtendeAOrganizacao({ ...todas, CLAUDE_PONTE_API_KEY: "" }, OUTRA_ORG)).toBe(false);
  });

  it.each([
    ["endereço que não é URL", { CLAUDE_PONTE_BASE_URL: "claude-ponte" }],
    ["endereço com credencial", { CLAUDE_PONTE_BASE_URL: "http://u:s@claude-ponte:8080" }],
    ["endereço com caminho", { CLAUDE_PONTE_BASE_URL: `${PONTE}/outra/coisa` }],
    ["chave ausente", { CLAUDE_PONTE_API_KEY: "" }],
    ["chave com espaço", { CLAUDE_PONTE_API_KEY: "duas palavras" }],
    ["lista com typo", { CLAUDE_PONTE_ORGS: "isto-nao-e-um-uuid" }],
    ["`*` misturado a um id", { CLAUDE_PONTE_ORGS: `*,${ORG}` }],
  ])("variável malformada (%s) vale `false` e NUNCA lança", (_nome, quebra) => {
    expect(() => ponteAtendeAOrganizacao({ ...LIGADA, ...quebra }, ORG)).not.toThrow();
    expect(ponteAtendeAOrganizacao({ ...LIGADA, ...quebra }, ORG)).toBe(false);
  });
});

describe("ponteCobreOProvedor — só o anthropic tem ponte", () => {
  it("cobre o anthropic da organização atendida", () => {
    expect(ponteCobreOProvedor("anthropic", ORG, LIGADA)).toBe(true);
  });

  it.each(["openai", "openrouter", "google", "custom", "provedor-que-nao-existe", ""])(
    "não cobre %s, mesmo com a organização na lista",
    (provedor) => {
      expect(ponteCobreOProvedor(provedor, ORG, LIGADA)).toBe(false);
    },
  );

  it("não cobre a organização fora da lista", () => {
    expect(ponteCobreOProvedor("anthropic", OUTRA_ORG, LIGADA)).toBe(false);
  });
});

describe("lerAmbiente(fonte, organização) — a chave da instalação conta a ponte", () => {
  it("o anthropic passa a existir para a organização atendida, sem ANTHROPIC_API_KEY", () => {
    const sem = lerAmbiente(LIGADA);
    const com = lerAmbiente(LIGADA, ORG);
    expect(sem.chavesDeProvedor.anthropic).toBe(false);
    expect(com.chavesDeProvedor.anthropic).toBe(true);
  });

  it("só o anthropic muda: nenhum outro provedor ganha chave pela ponte", () => {
    const sem = lerAmbiente(LIGADA);
    const com = lerAmbiente(LIGADA, ORG);
    for (const [id, tem] of Object.entries(com.chavesDeProvedor)) {
      if (id === "anthropic") continue;
      expect(tem, id).toBe(sem.chavesDeProvedor[id]);
      expect(tem, id).toBe(false);
    }
    expect(com.gateway).toBe(sem.gateway);
    expect(com.email).toBe(sem.email);
    expect(com.transporteDeWhatsapp).toEqual(sem.transporteDeWhatsapp);
  });

  it("organização fora da lista, lista vazia ou sem variáveis: a leitura é a de sempre", () => {
    expect(lerAmbiente(LIGADA, OUTRA_ORG).chavesDeProvedor.anthropic).toBe(false);
    expect(lerAmbiente({ ...LIGADA, CLAUDE_PONTE_ORGS: "" }, ORG).chavesDeProvedor.anthropic).toBe(
      false,
    );
    const vazio = lerAmbiente({}, ORG);
    expect(Object.values(vazio.chavesDeProvedor).some(Boolean)).toBe(false);
  });

  it("variável da ponte quebrada NÃO vira chave: a recusa de antes continua", () => {
    const quebrada = { ...LIGADA, CLAUDE_PONTE_BASE_URL: "nao-e-url" };
    expect(lerAmbiente(quebrada, ORG).chavesDeProvedor.anthropic).toBe(false);
  });

  it("a chave do .env continua valendo, com ou sem ponte e com ou sem organização", () => {
    const comChave = { ANTHROPIC_API_KEY: "sk-ant-sintetica", OPENAI_API_KEY: "sk-proj-sintetica" };
    expect(lerAmbiente(comChave).chavesDeProvedor.anthropic).toBe(true);
    expect(lerAmbiente(comChave, ORG).chavesDeProvedor.anthropic).toBe(true);
    expect(lerAmbiente({ ...comChave, ...LIGADA }, OUTRA_ORG).chavesDeProvedor.anthropic).toBe(
      true,
    );
    expect(lerAmbiente(comChave, ORG).chavesDeProvedor.openai).toBe(true);
  });

  it("a leitura sem organização ignora a ponte (quem não passa a organização não ganha nada)", () => {
    expect(lerAmbiente(LIGADA).chavesDeProvedor.anthropic).toBe(false);
  });
});

/** Um `admin` mínimo: lê a versão e responde ao RPC com o que o teste mandar. */
function adminDaVersao(version: Record<string, unknown>, rpcDeErro: string) {
  const rpc = vi.fn(async () => ({ data: null, error: { message: rpcDeErro } }));
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) builder[m] = () => builder;
  builder.maybeSingle = async () => ({ data: version, error: null });
  const admin = { from: () => builder, rpc };
  return { admin: admin as unknown as Parameters<typeof publishAgentVersion>[0], rpc };
}

describe("publishAgentVersion — credential_id nulo precisa de uma chave de instalação", () => {
  const params = { orgId: ORG, agentId: "agente-1", versionId: "versao-1" };
  const versao = { provider: "anthropic", credential_id: null, handoff_legal_enabled: true };

  it("recusa (credential_missing) quando nem o .env nem a ponte têm chave para a organização", async () => {
    const { admin, rpc } = adminDaVersao(versao, "nao-deveria-chegar");
    const r = await publishAgentVersion(admin, params);
    expect(r).toEqual({ ok: false, code: "credential_missing", message: "credential_missing" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("recusa quando a ponte atende OUTRA organização", async () => {
    vi.stubEnv("CLAUDE_PONTE_BASE_URL", PONTE);
    vi.stubEnv("CLAUDE_PONTE_API_KEY", CHAVE_SINTETICA);
    vi.stubEnv("CLAUDE_PONTE_ORGS", OUTRA_ORG);
    const { admin, rpc } = adminDaVersao(versao, "nao-deveria-chegar");
    const r = await publishAgentVersion(admin, params);
    expect(r).toMatchObject({ ok: false, code: "credential_missing" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("deixa passar (chega ao RPC) quando a ponte atende a organização", async () => {
    vi.stubEnv("CLAUDE_PONTE_BASE_URL", PONTE);
    vi.stubEnv("CLAUDE_PONTE_API_KEY", CHAVE_SINTETICA);
    vi.stubEnv("CLAUDE_PONTE_ORGS", ORG);
    const { admin, rpc } = adminDaVersao(versao, "parou-no-rpc");
    const r = await publishAgentVersion(admin, params);
    // O RPC devolve erro de propósito: o que importa aqui é que o portão deixou chegar nele.
    expect(r).toMatchObject({ ok: false, code: "internal_error", message: "parou-no-rpc" });
    expect(rpc).toHaveBeenCalledTimes(1);
    // E a ponte só vale para o anthropic: uma versão openai sem chave continua barrada.
    const { admin: admin2, rpc: rpc2 } = adminDaVersao(
      { ...versao, provider: "openai" },
      "nao-deveria-chegar",
    );
    expect(await publishAgentVersion(admin2, params)).toMatchObject({ code: "credential_missing" });
    expect(rpc2).not.toHaveBeenCalled();
  });

  it("versão com credencial própria nunca consulta a instalação", async () => {
    const { admin, rpc } = adminDaVersao(
      { ...versao, credential_id: "credencial-1" },
      "parou-no-rpc",
    );
    const r = await publishAgentVersion(admin, params);
    expect(r).toMatchObject({ code: "internal_error", message: "parou-no-rpc" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe("quem pergunta 'a instalação tem chave?' passa a organização", () => {
  const ler = (relativo: string) => readFileSync(join(process.cwd(), relativo), "utf8");

  it("a rota de versões confere a chave com a organização do chamador", () => {
    const fonte = ler("app/api/v1/ai/agents/[id]/versions/route.ts");
    expect(fonte).toMatch(/lerAmbiente\(process\.env,\s*organizationId\)\.chavesDeProvedor/);
    expect(fonte).not.toMatch(/lerAmbiente\(\)\.chavesDeProvedor/);
  });

  it.each(["app/app/ai/agents/[id]/page.tsx", "app/app/ai/agents/new/page.tsx"])(
    "%s monta a lista de provedores da instalação para a organização ativa",
    (arquivo) => {
      const fonte = ler(arquivo);
      expect(fonte).toMatch(/lerAmbiente\(process\.env,\s*organizationId\)/);
      expect(fonte).toMatch(/provedoresDaInstalacao\(activeOrg\.orgId\)/);
      expect(fonte).not.toMatch(/lerAmbiente\(\)/);
    },
  );
});
