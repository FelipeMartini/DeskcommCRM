/**
 * O OMNIROUTER DA INSTALAÇÃO, LIDO PELO APP (`lib/ai/omnirouter-ativo.ts`).
 *
 * Sucessor do interruptor da claude-ponte (ordem do dono, 16/10/2026: "vai ficar só o omnirouter
 * configurável", modelo MISTO). Três coisas se provam aqui, cada uma com o caso que PEGA e o que PASSA:
 *
 *   1. a leitura da instalação: endereço, chave e oferta geral vêm da tela (banco) com o `.env` como
 *      piso — é `valorDaInstalacao` quem decide, e este módulo só repassa;
 *   2. `omniRouterServeAOrganizacao`: a instalação precisa ter OmniRouter configurado **e** a organização
 *      ter sido escolhida (ou a oferta geral valer); a parte da instalação vai primeiro, e quem a
 *      instalação não atende nem gasta uma ida ao banco da organização. A escolha ausente, torta ou com
 *      erro de leitura vale "sem escolha" (decide a oferta geral) — nunca lança;
 *   3. a varredura: todo lugar do produto que pergunta "a instalação tem chave de IA?" passa pela
 *      pergunta do OmniRouter. Sem esta cerca, uma porta nova de salvar/publicar nasce ignorando a
 *      escolha da organização — e nenhum teste de comportamento notaria.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const instalacao = vi.hoisted(() => ({ valorDaInstalacao: vi.fn() }));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: instalacao.valorDaInstalacao }));

import {
  escolhaDoOmniRouterDaOrganizacao,
  omniRouterConfigurado,
  omniRouterServeAOrganizacao,
  variaveisDoOmniRouterDaInstalacao,
  type LeitorDeOrganizacao,
} from "@/lib/ai/omnirouter-ativo";

const ORG = "11111111-1111-4111-8111-111111111111";
const OMNI = "http://omnirouter:20128";
const CHAVE = "chave-do-omnirouter-sintetica";

/** O que a instalação devolve por chave (banco ou `.env`); o que não está aqui vale "ausente". */
function instalacaoCom(valores: Record<string, string | null>) {
  instalacao.valorDaInstalacao.mockImplementation(async (chave: string) => ({
    valor: valores[chave] ?? null,
    fonte: chave in valores ? "banco" : "ausente",
  }));
}

/** Um leitor que devolve o que o teste mandar e conta quantas vezes foi consultado. */
function leitor(resposta: { data: unknown; error: unknown } | "lancar") {
  const from = vi.fn(() => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => {
        if (resposta === "lancar") throw new Error("banco fora do ar");
        return resposta;
      },
    };
    return q;
  });
  return { db: { from } as unknown as LeitorDeOrganizacao, from };
}

const escolhida = { data: { settings: { omnirouter: { habilitado: true } } }, error: null };
const recusada = { data: { settings: { omnirouter: { habilitado: false } } }, error: null };
const semEscolha = { data: { settings: {} }, error: null };

beforeEach(() => {
  instalacao.valorDaInstalacao.mockReset();
  instalacaoCom({});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("variaveisDoOmniRouterDaInstalacao — o que a tela gravou, e o `.env` por baixo", () => {
  it("lê as TRÊS chaves pelo resolvedor da instalação (e só elas)", async () => {
    instalacaoCom({
      OMNIROUTER_BASE_URL: OMNI,
      OMNIROUTER_API_KEY: CHAVE,
      OMNIROUTER_PARA_TODAS: "true",
    });
    expect(await variaveisDoOmniRouterDaInstalacao()).toEqual({
      OMNIROUTER_BASE_URL: OMNI,
      OMNIROUTER_API_KEY: CHAVE,
      OMNIROUTER_PARA_TODAS: "true",
    });
    expect(instalacao.valorDaInstalacao.mock.calls.map((c) => c[0]).sort()).toEqual([
      "OMNIROUTER_API_KEY",
      "OMNIROUTER_BASE_URL",
      "OMNIROUTER_PARA_TODAS",
    ]);
  });

  it("ausente em toda parte vale `undefined` (não `null`): o módulo puro trata os dois como vazio", async () => {
    expect(await variaveisDoOmniRouterDaInstalacao()).toEqual({
      OMNIROUTER_BASE_URL: undefined,
      OMNIROUTER_API_KEY: undefined,
      OMNIROUTER_PARA_TODAS: undefined,
    });
  });
});

describe("omniRouterConfigurado — a instalação tem endereço E chave que prestam?", () => {
  it("⭐ endereço e chave em ordem: configurado (a oferta geral não importa)", () => {
    expect(omniRouterConfigurado({ OMNIROUTER_BASE_URL: OMNI, OMNIROUTER_API_KEY: CHAVE })).toBe(true);
  });

  it.each([
    ["nada", {}],
    ["só o endereço", { OMNIROUTER_BASE_URL: OMNI }],
    ["só a chave", { OMNIROUTER_API_KEY: CHAVE }],
    ["endereço que não é URL", { OMNIROUTER_BASE_URL: "omnirouter", OMNIROUTER_API_KEY: CHAVE }],
    ["chave com espaço", { OMNIROUTER_BASE_URL: OMNI, OMNIROUTER_API_KEY: "duas palavras" }],
  ])("%s: não configurado — e NUNCA lança", (_nome, v) => {
    expect(() => omniRouterConfigurado(v)).not.toThrow();
    expect(omniRouterConfigurado(v)).toBe(false);
  });
});

describe("escolhaDoOmniRouterDaOrganizacao — falha para o lado de 'sem escolha'", () => {
  it("⭐ `habilitado: true` escolhe; `false` recusa; a leitura vai a `organizations`", async () => {
    const a = leitor(escolhida);
    expect(await escolhaDoOmniRouterDaOrganizacao(a.db, ORG)).toBe(true);
    expect(a.from).toHaveBeenCalledWith("organizations");
    expect(await escolhaDoOmniRouterDaOrganizacao(leitor(recusada).db, ORG)).toBe(false);
  });

  it.each([
    ["sem a chave", semEscolha],
    ["`settings` nulo", { data: { settings: null }, error: null }],
    ["`settings` lista", { data: { settings: [] }, error: null }],
    ["`settings` texto", { data: { settings: "x" }, error: null }],
    ["valor torto", { data: { settings: { omnirouter: { habilitado: "true" } } }, error: null }],
    ["organização sem linha", { data: null, error: null }],
    ["erro de leitura", { data: null, error: { message: "x" } }],
    [
      "erro junto de um valor 'true'",
      { data: { settings: { omnirouter: { habilitado: true } } }, error: { message: "x" } },
    ],
  ])("%s: sem escolha", async (_nome, resposta) => {
    expect(await escolhaDoOmniRouterDaOrganizacao(leitor(resposta).db, ORG)).toBeUndefined();
  });

  it("exceção do banco: sem escolha, nunca lança", async () => {
    expect(await escolhaDoOmniRouterDaOrganizacao(leitor("lancar").db, ORG)).toBeUndefined();
  });
});

describe("omniRouterServeAOrganizacao — a instalação oferece E a organização é atendida", () => {
  beforeEach(() => instalacaoCom({ OMNIROUTER_BASE_URL: OMNI, OMNIROUTER_API_KEY: CHAVE }));

  it("⭐ configurado e organização ESCOLHIDA: serve", async () => {
    expect(await omniRouterServeAOrganizacao(leitor(escolhida).db, "anthropic", ORG)).toBe(true);
  });

  it("⭐ configurado, organização SEM escolha e sem oferta geral: não serve", async () => {
    expect(await omniRouterServeAOrganizacao(leitor(semEscolha).db, "anthropic", ORG)).toBe(false);
  });

  it("⭐ oferta geral ligada na tela atende quem não escolheu; a recusa da organização vence", async () => {
    instalacaoCom({
      OMNIROUTER_BASE_URL: OMNI,
      OMNIROUTER_API_KEY: CHAVE,
      OMNIROUTER_PARA_TODAS: "true",
    });
    expect(await omniRouterServeAOrganizacao(leitor(semEscolha).db, "anthropic", ORG)).toBe(true);
    expect(await omniRouterServeAOrganizacao(leitor(recusada).db, "anthropic", ORG)).toBe(false);
  });

  it("outro provedor ou instalação sem OmniRouter: não serve e nem consulta o banco", async () => {
    const outro = leitor(escolhida);
    expect(await omniRouterServeAOrganizacao(outro.db, "openai", ORG)).toBe(false);
    expect(outro.from).not.toHaveBeenCalled();

    instalacaoCom({});
    const sem = leitor(escolhida);
    expect(await omniRouterServeAOrganizacao(sem.db, "anthropic", ORG)).toBe(false);
    expect(sem.from).not.toHaveBeenCalled();

    instalacaoCom({ OMNIROUTER_BASE_URL: "nao-e-url", OMNIROUTER_API_KEY: CHAVE });
    const torta = leitor(escolhida);
    expect(await omniRouterServeAOrganizacao(torta.db, "anthropic", ORG)).toBe(false);
    expect(torta.from).not.toHaveBeenCalled();
  });

  it("banco da organização fora do ar: sem escolha, decide a oferta geral (nunca lança)", async () => {
    expect(await omniRouterServeAOrganizacao(leitor("lancar").db, "anthropic", ORG)).toBe(false);
    instalacaoCom({
      OMNIROUTER_BASE_URL: OMNI,
      OMNIROUTER_API_KEY: CHAVE,
      OMNIROUTER_PARA_TODAS: "true",
    });
    expect(await omniRouterServeAOrganizacao(leitor("lancar").db, "anthropic", ORG)).toBe(true);
  });
});

// ─── A varredura: quem pergunta "a instalação tem chave?" passa pelo OmniRouter ──

const RAIZ = process.cwd();
const PASTAS = ["app", "lib", "components", "workers", "hooks"];

function arquivosDeCodigo(dir: string, saida: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    if (nome === "node_modules" || nome === ".next") continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) arquivosDeCodigo(caminho, saida);
    else if (/\.(ts|tsx)$/.test(nome) && !/\.(test|spec)\.(ts|tsx)$/.test(nome))
      saida.push(caminho);
  }
  return saida;
}

const FONTES = PASTAS.flatMap((p) => arquivosDeCodigo(join(RAIZ, p))).map((f) => ({
  rel: relative(RAIZ, f).replace(/\\/g, "/"),
  texto: readFileSync(f, "utf8"),
}));

/** O texto dos argumentos de cada chamada `nome(...)`, partidos nas vírgulas de nível 0. */
function argumentosDasChamadas(texto: string, nome: string): string[][] {
  const chamadas: string[][] = [];
  const re = new RegExp(`(?<![\\w.])${nome}\\(`, "g");
  for (let m = re.exec(texto); m; m = re.exec(texto)) {
    let i = m.index + m[0].length;
    let nivel = 1;
    let atual = "";
    const args: string[] = [];
    for (; i < texto.length && nivel > 0; i += 1) {
      const c = texto[i]!;
      if ("([{".includes(c)) nivel += 1;
      else if (")]}".includes(c)) nivel -= 1;
      if (nivel === 0) break;
      if (c === "," && nivel === 1) {
        args.push(atual.trim());
        atual = "";
      } else atual += c;
    }
    if (atual.trim() !== "") args.push(atual.trim());
    chamadas.push(args);
  }
  return chamadas;
}

describe("a varredura — nenhuma porta nasce ignorando o OmniRouter da organização", () => {
  it("a varredura enxerga o código (um glob vazio aprovaria tudo)", () => {
    expect(FONTES.length).toBeGreaterThan(500);
    expect(FONTES.some((f) => f.rel === "lib/ai/omnirouter-ativo.ts")).toBe(true);
  });

  it("⭐ a claude-ponte não existe mais: nenhum arquivo de código a importa ou a nomeia", () => {
    const restos = FONTES.filter((f) =>
      /claude-ponte|CLAUDE_PONTE|ponteCobreOProvedor|ponteAtendeAOrganizacao|ponte_ativa/.test(f.texto),
    ).map((f) => f.rel);
    expect(restos).toEqual([]);
  });

  // Quem chama `lerAmbiente` SEM dizer se o OmniRouter atende, e por quê. A lista só encolhe: arquivo
  // novo que precise perguntar pela chave usa `omniRouterServeAOrganizacao`.
  const PERGUNTA_SO_AS_CHAVES_DO_ENV: Record<string, string> = {
    "lib/instalacao/retrato.ts":
      "o retrato do onboarding mostra as chaves do `.env` do processo (injetáveis em teste)",
    "app/api/v1/ai/providers/route.ts":
      "a aproximação da transcrição é sobre chave EXISTENTE no `.env` (o OmniRouter só serve o texto)",
  };

  it("⭐ toda chamada de `lerAmbiente` com o ambiente real diz se o OmniRouter atende (2º argumento)", () => {
    const semOmni: string[] = [];
    for (const f of FONTES) {
      if (f.rel === "lib/instalacao/ambiente.ts") continue;
      if (f.rel in PERGUNTA_SO_AS_CHAVES_DO_ENV) continue;
      for (const args of argumentosDasChamadas(f.texto, "lerAmbiente")) {
        if (args.length < 2) semOmni.push(`${f.rel}: lerAmbiente(${args.join(", ")})`);
      }
    }
    expect(semOmni).toEqual([]);
  });

  it("a lista de exceções não carrega arquivo que deixou de chamar (a exceção velha esconde a regra)", () => {
    for (const rel of Object.keys(PERGUNTA_SO_AS_CHAVES_DO_ENV)) {
      const f = FONTES.find((x) => x.rel === rel);
      expect(f, `${rel} sumiu`).toBeDefined();
      expect(
        argumentosDasChamadas(f!.texto, "lerAmbiente").length,
        `${rel} está na lista mas não chama mais`,
      ).toBeGreaterThan(0);
    }
  });

  it("os portões de salvar e publicar agente usam `omniRouterServeAOrganizacao`", () => {
    const usa = (rel: string, nome: string) =>
      FONTES.find((f) => f.rel === rel)?.texto.includes(`${nome}(`) ?? false;
    expect(usa("lib/ai/agents/publish.ts", "omniRouterServeAOrganizacao")).toBe(true);
    expect(usa("lib/ai/agents/first-publication.ts", "omniRouterServeAOrganizacao")).toBe(true);
    expect(usa("app/api/v1/ai/agents/[id]/versions/route.ts", "omniRouterServeAOrganizacao")).toBe(
      true,
    );
    expect(usa("app/app/ai/agents/[id]/page.tsx", "omniRouterServeAOrganizacao")).toBe(true);
    expect(usa("app/app/ai/agents/new/page.tsx", "omniRouterServeAOrganizacao")).toBe(true);
  });

  it("o auxiliar de varredura conta argumentos de verdade (controle do próprio teste)", () => {
    expect(argumentosDasChamadas("x = lerAmbiente(a, b)", "lerAmbiente")).toEqual([["a", "b"]]);
    expect(argumentosDasChamadas("lerAmbiente(f(a, b), c, d)", "lerAmbiente")[0]).toHaveLength(3);
    expect(argumentosDasChamadas("x.lerAmbiente(a, b)", "lerAmbiente")).toEqual([]);
    expect(argumentosDasChamadas("lerAmbiente()", "lerAmbiente")).toEqual([[]]);
  });
});
