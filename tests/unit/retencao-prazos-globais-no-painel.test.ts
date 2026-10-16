import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/v1/cron/data-retention/route";
import { CATALOGO_DA_INSTALACAO, acharChave } from "@/lib/instalacao/catalogo";
import { recusaDoValor } from "@/lib/instalacao/validar-valor";
import {
  RETENCAO_TELEMETRIA_DE_IA_DIAS_PADRAO,
  RETENCAO_TETO_DIAS,
} from "@/lib/retencao/politica";
import { prazosDaInstalacao } from "@/lib/retencao/prazos-da-instalacao";
import {
  PRAZOS_GLOBAIS,
  acharPrazoGlobal,
  explicacaoDoPrazo,
  recusaDoPrazo,
} from "@/lib/retencao/prazos-globais";

/**
 * OS PRAZOS GLOBAIS DE RETENÇÃO MORAM NO PAINEL (ordem do dono, 16/10/2026: modelo misto).
 *
 * Os 15 prazos viviam só no `.env`. Agora são chaves do catálogo da instalação (Admin › Configuração,
 * grupo "Retenção de dados") e o cron lê pelo resolvedor. O que este arquivo impede:
 *
 *   1. a tela oferecer um prazo que o cron não lê (campo decorativo): o cron é chamado de verdade, com o
 *      `.env` dizendo uma coisa e o resolvedor outra, e o prazo que a poda recebe tem de ser o do resolvedor;
 *   2. a tela prometer um padrão ou um mínimo diferente do que o código aplica: o texto sai das constantes
 *      de `politica.ts`, e o teste confere que sai;
 *   3. um valor torto ficar gravado atrás de um "salvo": a conferência recusa antes, em português, e nunca
 *      repete o que foi digitado.
 *
 * O que NÃO mede: o piso das funções SQL (banco real, `tests/invariants/`) e o resolvedor em si (banco
 * vence `.env`), que tem os próprios testes em `lib/instalacao/`.
 */

// O `.env` diz 999; o resolvedor (a tela) diz 500. Se o cron voltar a ler o `.env`, o 999 aparece.
vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_CRON_SECRET: "segredo",
    INTERNAL_SECRET: "",
    AI_TELEMETRY_RETENTION_DAYS: "999",
  },
}));
const auditou = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...args: unknown[]) => auditou(...args) }));

/** O que a tela gravou, por chave; o que não está aqui o resolvedor devolve como ausente. */
let daTela: Record<string, string> = {};
vi.mock("@/lib/instalacao/config", () => ({
  valorDaInstalacao: async (chave: string) => ({
    valor: daTela[chave] ?? null,
    fonte: chave in daTela ? "banco" : "ausente",
  }),
}));

/** Os prazos que cada função de poda recebeu na rodada. */
let diasPorFuncao: Record<string, number[]> = {};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (nome: string, args: { p_retencao_dias?: number }) => {
      if (typeof args?.p_retencao_dias === "number") {
        (diasPorFuncao[nome] ??= []).push(args.p_retencao_dias);
      }
      return { data: 0, error: null };
    },
    from: () => {
      const q: Record<string, unknown> = {
        eq: () => q,
        in: () => q,
        limit: () => q,
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
      };
      const apagando: Record<string, unknown> = {
        lt: () => apagando,
        select: () => apagando,
        order: () => apagando,
        limit: () => apagando,
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
      };
      return { select: () => q, update: () => q, delete: () => apagando };
    },
  }),
}));

beforeEach(() => {
  daTela = {};
  diasPorFuncao = {};
  auditou.mockClear();
});

describe("o catálogo oferece exatamente os prazos que o código aplica", () => {
  it("são 15 prazos, sem chave repetida", () => {
    expect(PRAZOS_GLOBAIS).toHaveLength(15);
    expect(new Set(PRAZOS_GLOBAIS.map((p) => p.chave)).size).toBe(15);
  });

  it.each(PRAZOS_GLOBAIS.map((p) => [p.chave, p] as const))(
    "%s: editável, no grupo da retenção, como número, com o padrão e o mínimo do código no texto",
    (chave, prazo) => {
      const doCatalogo = acharChave(chave);
      expect(doCatalogo).toBeDefined();
      expect(doCatalogo).toMatchObject({
        grupo: "retencao",
        natureza: "numero",
        controle: "edita",
      });
      expect(doCatalogo?.telaDona).toBeUndefined();
      expect(doCatalogo?.explicacao).toBe(explicacaoDoPrazo(prazo));
      expect(doCatalogo?.explicacao).toContain(`${prazo.padrao} dias`);
      expect(doCatalogo?.explicacao).toContain(prazo.piso === 1 ? "1 dia" : `${prazo.piso} dias`);
    },
  );

  it("o padrão nunca fica abaixo do mínimo (a tela não promete o que o piso derrubaria)", () => {
    for (const p of PRAZOS_GLOBAIS) {
      expect(p.padrao, p.chave).toBeGreaterThanOrEqual(p.piso);
      expect(p.piso, p.chave).toBeGreaterThanOrEqual(1);
    }
  });

  it("só estes 15 estão no grupo da retenção", () => {
    const doGrupo = CATALOGO_DA_INSTALACAO.filter((c) => c.grupo === "retencao").map((c) => c.chave);
    expect([...doGrupo].sort()).toEqual(PRAZOS_GLOBAIS.map((p) => p.chave).sort());
  });
});

describe("prazosDaInstalacao devolve o texto cru de cada chave", () => {
  it("lê as 15 chaves e devolve exatamente elas", async () => {
    const lidos = await prazosDaInstalacao();
    expect(Object.keys(lidos).sort()).toEqual(PRAZOS_GLOBAIS.map((p) => p.chave).sort());
  });

  it("ausente vira undefined (assume o padrão do código, sem aviso)", async () => {
    const lidos = await prazosDaInstalacao();
    expect(Object.values(lidos).every((v) => v === undefined)).toBe(true);
  });

  it("o que a tela gravou chega cru, inclusive lixo (quem interpreta é interpretarRetencao)", async () => {
    daTela = { AUDIT_LOG_RETENTION_DAYS: "730", PASSAGEM_RETENTION_DAYS: "90dias" };
    const lidos = await prazosDaInstalacao();
    expect(lidos.AUDIT_LOG_RETENTION_DAYS).toBe("730");
    expect(lidos.PASSAGEM_RETENTION_DAYS).toBe("90dias");
  });
});

describe("o cron de poda lê o prazo da tela, não do .env", () => {
  const req = () => ({ headers: new Headers({ authorization: "Bearer segredo" }) }) as never;

  it("o resolvedor diz 500 e o .env diz 999: a poda recebe 500", async () => {
    daTela = { AI_TELEMETRY_RETENTION_DAYS: "500" };
    const resposta = await GET(req());
    expect(resposta.status).toBe(200);
    expect(diasPorFuncao["fn_expurgar_telemetria_de_ia_vencida"]).toEqual([500]);
  });

  it("sem nada na tela nem no .env, a poda recebe o padrão do código (e não o 999 do mock do .env)", async () => {
    const resposta = await GET(req());
    expect(resposta.status).toBe(200);
    expect(diasPorFuncao["fn_expurgar_telemetria_de_ia_vencida"]).toEqual([
      RETENCAO_TELEMETRIA_DE_IA_DIAS_PADRAO,
    ]);
  });

  it("valor torto gravado por outro caminho não derruba a rodada: o piso do código assume", async () => {
    daTela = { AI_TELEMETRY_RETENTION_DAYS: "1" };
    const resposta = await GET(req());
    expect(resposta.status).toBe(200);
    const [dias] = diasPorFuncao["fn_expurgar_telemetria_de_ia_vencida"] ?? [];
    expect(dias).toBe(acharPrazoGlobal("AI_TELEMETRY_RETENTION_DAYS")?.piso);
  });
});

describe("a conferência do prazo antes de gravar", () => {
  const prazo = PRAZOS_GLOBAIS[0]!;

  it("aceita o mínimo, o padrão e o teto", () => {
    expect(recusaDoPrazo(prazo.chave, String(prazo.piso))).toBeNull();
    expect(recusaDoPrazo(prazo.chave, String(prazo.padrao))).toBeNull();
    expect(recusaDoPrazo(prazo.chave, String(RETENCAO_TETO_DIAS))).toBeNull();
    expect(recusaDoPrazo(prazo.chave, `  ${prazo.padrao}  `)).toBeNull();
  });

  it.each(["abc", "90dias", "1,5", "1.5", "-30", "+30", "1e3", "", "  ", "0x10"])(
    "recusa %j (não é só um número inteiro de dias)",
    (digitado) => {
      expect(recusaDoPrazo(prazo.chave, digitado)).toMatch(/só o número de dias/);
    },
  );

  it("recusa abaixo do mínimo, dizendo o mínimo", () => {
    const abaixo = String(prazo.piso - 1);
    expect(recusaDoPrazo(prazo.chave, abaixo)).toContain(`${prazo.piso}`);
    expect(recusaDoPrazo(prazo.chave, abaixo)).toMatch(/mínimo/);
  });

  it("recusa acima do teto, dizendo o teto", () => {
    const acima = String(RETENCAO_TETO_DIAS + 1);
    expect(recusaDoPrazo(prazo.chave, acima)).toContain(String(RETENCAO_TETO_DIAS));
  });

  it("recusa número que não cabe num inteiro seguro", () => {
    expect(recusaDoPrazo(prazo.chave, "9".repeat(30))).not.toBeNull();
  });

  it("nunca repete o que foi digitado", () => {
    for (const digitado of ["segredo-colado-por-engano", "-7", String(RETENCAO_TETO_DIAS + 5)]) {
      expect(recusaDoPrazo(prazo.chave, digitado) ?? "").not.toContain(digitado);
    }
  });

  it("chave que não é prazo passa direto (as outras chaves não mudam)", () => {
    expect(recusaDoPrazo("SUPPORT_EMAIL", "abc")).toBeNull();
  });

  it("a porta da tela (recusaDoValor) chama a conferência do prazo", () => {
    expect(recusaDoValor(prazo.chave, "abc")).not.toBeNull();
    expect(recusaDoValor(prazo.chave, String(prazo.padrao))).toBeNull();
    expect(recusaDoValor("SUPPORT_EMAIL", "abc")).toBeNull();
  });
});
