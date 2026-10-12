/**
 * O INTERRUPTOR DA CLAUDE-PONTE, POR ORGANIZAÇÃO (`lib/ai/claude-ponte-ativa.ts`).
 *
 * Ordem do dono (11/10/2026): "tem que ter como ativar e desativar pelo sistema, mas o padrão deve ser
 * tudo ativado e funcionando pela ponte". Três coisas se provam aqui, cada uma com o caso que PEGA e o
 * que PASSA:
 *
 *   1. a leitura: o PADRÃO É LIGADA e só o booleano `false` desliga — ausente, `true`, texto, número,
 *      `null`, lista, objeto e lixo valem ligada; erro do banco, linha ausente e exceção também (uma
 *      falha de leitura não pode desligar a IA de uma empresa em silêncio);
 *   2. `ponteServeAOrganizacao`: a instalação precisa oferecer a ponte (e a organização estar na lista)
 *      **e** a organização não ter desligado; a parte do `.env` vai primeiro e quem a instalação não
 *      atende nem gasta uma ida ao banco;
 *   3. a varredura: todo lugar do produto que pergunta "a instalação tem chave de IA?" passa o
 *      interruptor. Sem esta cerca, uma porta nova de salvar/publicar nasce ignorando a escolha da
 *      organização — e nenhum teste de comportamento notaria, porque a pergunta sem o interruptor
 *      continua válida.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ponteLigadaDaOrganizacao,
  ponteLigadaNasConfiguracoes,
  ponteServeAOrganizacao,
  type LeitorDeOrganizacao,
} from "@/lib/ai/claude-ponte-ativa";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "22222222-2222-4222-8222-222222222222";
const LIGADA = {
  CLAUDE_PONTE_BASE_URL: "http://claude-ponte:8080",
  CLAUDE_PONTE_API_KEY: "chave-sintetica-da-ponte",
  CLAUDE_PONTE_ORGS: ORG,
};

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("ponteLigadaNasConfiguracoes — o padrão é ligada", () => {
  it("⭐ só o booleano `false` desliga", () => {
    expect(ponteLigadaNasConfiguracoes({ ponte_ativa: false })).toBe(false);
  });

  it.each([
    ["ausente", {}],
    ["`true`", { ponte_ativa: true }],
    ['texto `"false"`', { ponte_ativa: "false" }],
    ["texto vazio", { ponte_ativa: "" }],
    ["número `0`", { ponte_ativa: 0 }],
    ["`null`", { ponte_ativa: null }],
    ["`undefined`", { ponte_ativa: undefined }],
    ["lista", { ponte_ativa: [false] }],
    ["objeto", { ponte_ativa: { ativa: false } }],
  ])("valor %s vale LIGADA", (_nome, llm) => {
    expect(ponteLigadaNasConfiguracoes(llm)).toBe(true);
  });

  it.each([
    ["`undefined`", undefined],
    ["`null`", null],
    ["texto", "ponte_ativa: false"],
    ["número", 0],
    ["lista", [{ ponte_ativa: false }]],
  ])("`llm` que não é objeto (%s) vale LIGADA", (_nome, llm) => {
    expect(ponteLigadaNasConfiguracoes(llm)).toBe(true);
  });
});

describe("ponteLigadaDaOrganizacao — lê o banco e falha para o lado do padrão", () => {
  it("⭐ `ponte_ativa: false` em `settings.llm` desliga", async () => {
    const { db, from } = leitor({
      data: { settings: { llm: { ponte_ativa: false } } },
      error: null,
    });
    expect(await ponteLigadaDaOrganizacao(db, ORG)).toBe(false);
    expect(from).toHaveBeenCalledWith("organizations");
  });

  it.each([
    ["sem a chave", { settings: { llm: { provider: "anthropic" } } }],
    ["`true`", { settings: { llm: { ponte_ativa: true } } }],
    ["sem `llm`", { settings: { branding: { name: "X" } } }],
    ["`settings` nulo", { settings: null }],
    ["`settings` lista", { settings: [] }],
    ["`settings` texto", { settings: "x" }],
    ["valor torto", { settings: { llm: { ponte_ativa: "false" } } }],
  ])("%s: ligada", async (_nome, data) => {
    const { db } = leitor({ data, error: null });
    expect(await ponteLigadaDaOrganizacao(db, ORG)).toBe(true);
  });

  it("⭐ erro de leitura, organização sem linha e exceção valem LIGADA (a falha não desliga a IA de ninguém)", async () => {
    expect(
      await ponteLigadaDaOrganizacao(leitor({ data: null, error: { message: "x" } }).db, ORG),
    ).toBe(true);
    expect(await ponteLigadaDaOrganizacao(leitor({ data: null, error: null }).db, ORG)).toBe(true);
    expect(await ponteLigadaDaOrganizacao(leitor("lancar").db, ORG)).toBe(true);
    // Mesmo com o valor desligado junto de um erro: o erro manda, e a resposta é o padrão.
    expect(
      await ponteLigadaDaOrganizacao(
        leitor({ data: { settings: { llm: { ponte_ativa: false } } }, error: { message: "x" } }).db,
        ORG,
      ),
    ).toBe(true);
  });
});

describe("ponteServeAOrganizacao — a instalação oferece E a organização não desligou", () => {
  const desligada = { data: { settings: { llm: { ponte_ativa: false } } }, error: null };
  const ligada = { data: { settings: { llm: {} } }, error: null };

  it("⭐ oferecida e ligada: serve", async () => {
    expect(await ponteServeAOrganizacao(leitor(ligada).db, "anthropic", ORG, LIGADA)).toBe(true);
  });

  it("⭐ oferecida e DESLIGADA na tela: não serve", async () => {
    expect(await ponteServeAOrganizacao(leitor(desligada).db, "anthropic", ORG, LIGADA)).toBe(
      false,
    );
  });

  it("organização fora da lista, outro provedor ou sem variáveis: não serve e nem consulta o banco", async () => {
    for (const [provedor, org, fonte] of [
      ["anthropic", OUTRA_ORG, LIGADA],
      ["openai", ORG, LIGADA],
      ["anthropic", ORG, {}],
      ["anthropic", ORG, { ...LIGADA, CLAUDE_PONTE_BASE_URL: "nao-e-url" }],
    ] as const) {
      const { db, from } = leitor(ligada);
      expect(await ponteServeAOrganizacao(db, provedor, org, fonte), `${provedor}/${org}`).toBe(
        false,
      );
      expect(from).not.toHaveBeenCalled();
    }
  });

  it("banco fora do ar com a ponte oferecida: serve (o padrão), nunca derruba o portão", async () => {
    expect(await ponteServeAOrganizacao(leitor("lancar").db, "anthropic", ORG, LIGADA)).toBe(true);
  });
});

// ─── A varredura: quem pergunta "a instalação tem chave?" passa o interruptor ──

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

describe("a varredura — nenhuma porta nasce ignorando o interruptor", () => {
  it("a varredura enxerga o código (um glob vazio aprovaria tudo)", () => {
    expect(FONTES.length).toBeGreaterThan(500);
    expect(FONTES.some((f) => f.rel === "lib/ai/claude-ponte-ativa.ts")).toBe(true);
  });

  // Quem pode perguntar só pela EXISTÊNCIA da ponte (sem o interruptor), e por quê. A lista só encolhe:
  // arquivo novo que precise perguntar pela chave usa `ponteServeAOrganizacao`.
  const PERGUNTA_SO_A_EXISTENCIA: Record<string, string> = {
    "lib/instalacao/ambiente.ts": "é onde `ponteCobreOProvedor` e `lerAmbiente` moram",
    "lib/ai/claude-ponte-ativa.ts": "`ponteServeAOrganizacao` junta a existência com o interruptor",
    "app/api/v1/ai/ponte/route.ts":
      "é a rota do próprio interruptor: precisa saber se a ponte existe",
    "app/app/ai/credentials/page.tsx":
      "decide se o card do interruptor aparece (existe?) e lê o estado",
  };

  it("⭐ só os arquivos autorizados chamam `ponteCobreOProvedor` direto", () => {
    const chamam = FONTES.filter((f) => /(?<![\w.])ponteCobreOProvedor\(/.test(f.texto)).map(
      (f) => f.rel,
    );
    expect(chamam.filter((rel) => !(rel in PERGUNTA_SO_A_EXISTENCIA))).toEqual([]);
    // E a lista não carrega arquivo que deixou de chamar (a exceção velha esconde a regra).
    for (const rel of Object.keys(PERGUNTA_SO_A_EXISTENCIA)) {
      expect(chamam, `${rel} está na lista mas não chama mais`).toContain(rel);
    }
  });

  it("⭐ toda chamada de `lerAmbiente` com organização passa também o interruptor (3º argumento)", () => {
    const semInterruptor: string[] = [];
    for (const f of FONTES) {
      if (f.rel === "lib/instalacao/ambiente.ts") continue;
      for (const args of argumentosDasChamadas(f.texto, "lerAmbiente")) {
        if (args.length === 2) semInterruptor.push(`${f.rel}: lerAmbiente(${args.join(", ")})`);
      }
    }
    expect(semInterruptor).toEqual([]);
  });

  it("os portões de salvar e publicar agente usam `ponteServeAOrganizacao` / `ponteLigadaDaOrganizacao`", () => {
    const usa = (rel: string, nome: string) =>
      FONTES.find((f) => f.rel === rel)?.texto.includes(`${nome}(`) ?? false;
    expect(usa("lib/ai/agents/publish.ts", "ponteServeAOrganizacao")).toBe(true);
    expect(usa("lib/ai/agents/first-publication.ts", "ponteServeAOrganizacao")).toBe(true);
    expect(usa("app/api/v1/ai/agents/[id]/versions/route.ts", "ponteLigadaDaOrganizacao")).toBe(
      true,
    );
    expect(usa("app/app/ai/agents/[id]/page.tsx", "ponteLigadaDaOrganizacao")).toBe(true);
    expect(usa("app/app/ai/agents/new/page.tsx", "ponteLigadaNasConfiguracoes")).toBe(true);
  });

  it("o auxiliar de varredura conta argumentos de verdade (controle do próprio teste)", () => {
    expect(argumentosDasChamadas("x = lerAmbiente(a, b)", "lerAmbiente")).toEqual([["a", "b"]]);
    expect(argumentosDasChamadas("lerAmbiente(f(a, b), c, d)", "lerAmbiente")[0]).toHaveLength(3);
    expect(argumentosDasChamadas("x.lerAmbiente(a, b)", "lerAmbiente")).toEqual([]);
    expect(argumentosDasChamadas("lerAmbiente()", "lerAmbiente")).toEqual([[]]);
  });
});
