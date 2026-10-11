// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cabecalhoQuadroPermitido,
  origensQuePodemEmbutir,
} from "@/lib/security/origens-que-podem-embutir";

/**
 * O CRM SÓ SE DEIXA EMBUTIR POR QUEM O OPERADOR NOMEOU, E ERRO DE DIGITAÇÃO FECHA.
 *
 * `X-Frame-Options: DENY` é gravado em build e vale para toda resposta. A exceção é de RUNTIME
 * (`EMBED_FRAME_ANCESTORS`) e lida pelo `proxy.ts`: pega só origem `https` exata; tudo o mais é
 * descartado por inteiro. Estes casos prendem os dois lados: o que passa (a origem do Social) e o
 * que NÃO passa (curinga, `http`, caminho, porta, IP, `'self'`, injeção de outra diretiva).
 */
const SOCIAL = "https://social.poa.metodoatuarial.com.br";

const ambiente = vi.hoisted(() => ({
  NEXT_PUBLIC_SUPABASE_URL: "https://supabase.exemplo",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-de-teste",
  EMBED_FRAME_ANCESTORS: "",
}));
vi.mock("@/lib/env", () => ({ env: ambiente }));

describe("origensQuePodemEmbutir", () => {
  it("aceita a origem exata do Social", () => {
    expect(origensQuePodemEmbutir(SOCIAL)).toEqual([SOCIAL]);
  });

  it("vazio, ausente e espaço não abrem nada", () => {
    expect(origensQuePodemEmbutir("")).toEqual([]);
    expect(origensQuePodemEmbutir("   ")).toEqual([]);
    expect(origensQuePodemEmbutir(undefined)).toEqual([]);
    expect(origensQuePodemEmbutir(null)).toEqual([]);
  });

  it.each([
    ["curinga solto", "*"],
    ["curinga de subdomínio", "https://*.metodoatuarial.com.br"],
    ["curinga no meio", "https://social.*.com.br"],
    ["http", "http://social.poa.metodoatuarial.com.br"],
    ["esquema que não é https", "data:"],
    ["com caminho", "https://social.poa.metodoatuarial.com.br/protegido"],
    ["com barra no fim", "https://social.poa.metodoatuarial.com.br/"],
    ["com porta", "https://social.poa.metodoatuarial.com.br:8443"],
    ["com usuário", "https://quem@social.poa.metodoatuarial.com.br"],
    ["com consulta", "https://social.poa.metodoatuarial.com.br?x=1"],
    ["host sem ponto", "https://localhost"],
    ["só o esquema", "https://"],
    ["IP", "https://10.1.1.4"],
    ["sem esquema", "social.poa.metodoatuarial.com.br"],
    ["self", "'self'"],
    ["none", "'none'"],
    ["ponto e vírgula grudado", "https://social.poa.metodoatuarial.com.br;"],
    ["TLD numérico", "https://social.poa.metodoatuarial.123"],
    ["rótulo começando em hífen", "https://-social.metodoatuarial.com.br"],
  ])("descarta %s", (_nome, valor) => {
    expect(origensQuePodemEmbutir(valor)).toEqual([]);
  });

  it("não deixa uma diretiva a mais passar pela variável", () => {
    // Quem escreve a variável com outra diretiva não consegue abrir nada: nenhum pedaço é origem.
    expect(
      origensQuePodemEmbutir(
        "https://evil.exemplo.com; frame-ancestors * ; script-src 'unsafe-inline'",
      ),
    ).toEqual([]);
    expect(origensQuePodemEmbutir(`${SOCIAL}\r\nX-Evil: 1`)).toEqual([SOCIAL]);
  });

  it("um pedaço ruim não derruba o bom, e o bom não vira curinga", () => {
    expect(origensQuePodemEmbutir(`*, ${SOCIAL}, http://outro.exemplo.com`)).toEqual([SOCIAL]);
  });

  it("põe em minúsculas, tira repetição e aceita vírgula ou espaço", () => {
    expect(
      origensQuePodemEmbutir(
        "HTTPS://Social.Poa.MetodoAtuarial.com.br ,https://a.exemplo.com.br  " + SOCIAL,
      ),
    ).toEqual([SOCIAL, "https://a.exemplo.com.br"]);
  });

  it("no máximo três origens", () => {
    const quatro = ["a", "b", "c", "d"].map((x) => `https://${x}.exemplo.com.br`).join(",");
    expect(origensQuePodemEmbutir(quatro)).toHaveLength(3);
  });
});

describe("cabecalhoQuadroPermitido", () => {
  it("sem origem não há cabeçalho", () => {
    expect(cabecalhoQuadroPermitido([])).toBeNull();
  });

  it("só frame-ancestors, só a origem pedida, sem 'self'", () => {
    expect(cabecalhoQuadroPermitido([SOCIAL])).toBe(`frame-ancestors ${SOCIAL}`);
  });
});

describe("proxy.ts", () => {
  beforeEach(() => {
    ambiente.EMBED_FRAME_ANCESTORS = "";
    vi.resetModules();
  });

  async function cspDe(url: string): Promise<string | null> {
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    const resposta = await proxy(new NextRequest(url));
    return resposta.headers.get("content-security-policy");
  }

  it("sem a variável não põe CSP nenhum: o DENY de sempre vale para todos", async () => {
    expect(await cspDe("https://crm.exemplo/login")).toBeNull();
  });

  it("com a origem do Social, libera só ela, em página pública e em tela", async () => {
    ambiente.EMBED_FRAME_ANCESTORS = SOCIAL;
    expect(await cspDe("https://crm.exemplo/login")).toBe(`frame-ancestors ${SOCIAL}`);
  });

  it("com valor perigoso na variável, não abre nada", async () => {
    ambiente.EMBED_FRAME_ANCESTORS = "*";
    expect(await cspDe("https://crm.exemplo/login")).toBeNull();
    ambiente.EMBED_FRAME_ANCESTORS = "https://*.metodoatuarial.com.br";
    expect(await cspDe("https://crm.exemplo/login")).toBeNull();
  });
});

describe("o DENY de build continua gravado", () => {
  it("next.config.ts segue mandando X-Frame-Options: DENY em toda resposta", () => {
    const fonte = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
    expect(fonte).toMatch(/key:\s*"X-Frame-Options",\s*value:\s*"DENY"/);
  });
});
