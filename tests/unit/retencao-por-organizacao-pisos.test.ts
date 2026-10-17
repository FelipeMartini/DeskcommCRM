import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PISO_DO_PRAZO_DA_ORGANIZACAO,
  TIPOS_DE_PRAZO_DA_ORGANIZACAO,
} from "@/lib/retencao/prazos-da-organizacao";

/**
 * A TABELA DE PISOS DO SQL E A DO TYPESCRIPT NÃO PODEM DIVERGIR — migration 0695.
 *
 * O piso do prazo por organização mora DENTRO do SQL (`fn_piso_de_retencao_por_
 * organizacao`), porque só lá vale para qualquer chamador, inclusive um `psql`
 * na mão. O TypeScript repete os números (as constantes de `politica.ts`) para a
 * tela mostrar o mínimo e o validador recusar cedo. Duas tabelas de verdade
 * divergem em silêncio: a tela aceitaria 20 dias de captação e o banco
 * elevaria para 30 sem ninguém avisar — o admin acharia que apaga mais cedo do
 * que apaga.
 *
 * Também confere que a instalação NOVA (o apêndice do baseline) recebe EXATAMENTE
 * o que a EXISTENTE recebe (a migration), antes do bloco da varredura anon, e
 * que nenhuma das cinco funções fica ao alcance de anon/authenticated.
 */

const RAIZ = join(__dirname, "..", "..");
const PASTA = join(RAIZ, "supabase", "migrations");
const NOME = readdirSync(PASTA).find((f) => /_0695_retencao_por_organizacao\.sql$/.test(f));
const MIGRATION = NOME ? readFileSync(join(PASTA, NOME), "utf8") : "";
const BASELINE = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");

const FUNCOES = [
  "fn_piso_de_retencao_por_organizacao(text)",
  "fn_prazo_de_retencao_da_organizacao(uuid, text)",
  "fn_organizacoes_com_prazo_proprio()",
  "fn_expurgar_por_organizacao(text, uuid, int)",
  "fn_definir_retencao_da_organizacao(uuid, uuid, jsonb)",
];

/** O corpo `$$ … $$` da função pelo nome, tirando os comentários de linha. */
function corpoDa(sql: string, nome: string): string {
  const inicio = sql.indexOf(`function public.${nome}(`);
  expect(inicio, `função ${nome} não encontrada`).toBeGreaterThan(-1);
  const abre = sql.indexOf("$$", inicio);
  const fecha = sql.indexOf("$$", abre + 2);
  return sql
    .slice(abre + 2, fecha)
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
}

describe("0695 — a tabela de pisos do SQL é a do TypeScript", () => {
  it("achou a migration (o gate não nasce vazio)", () => {
    expect(NOME).toBeDefined();
    expect(MIGRATION.length).toBeGreaterThan(1000);
    expect(MIGRATION.split("\n")[0]).toMatch(/^-- manifest: /);
  });

  it("cada tipo tem o MESMO piso nas duas tabelas, e nenhum sobra de nenhum lado", () => {
    const corpo = corpoDa(MIGRATION, "fn_piso_de_retencao_por_organizacao");
    const noSql = new Map<string, number>();
    for (const m of corpo.matchAll(/when\s+'([a-z_]+)'\s+then\s+(\d+)/g)) {
      noSql.set(m[1] as string, Number(m[2]));
    }
    expect([...noSql.keys()].sort()).toEqual([...TIPOS_DE_PRAZO_DA_ORGANIZACAO].sort());
    for (const tipo of TIPOS_DE_PRAZO_DA_ORGANIZACAO) {
      expect(noSql.get(tipo), `piso de ${tipo}`).toBe(PISO_DO_PRAZO_DA_ORGANIZACAO[tipo]);
    }
  });

  it("a lista do SQL e o ramo de poda de cada tipo cobrem os mesmos tipos do TypeScript", () => {
    const lista = corpoDa(MIGRATION, "fn_organizacoes_com_prazo_proprio");
    const tiposDaLista = [...lista.matchAll(/\('([a-z_]+)'\)/g)].map((m) => m[1]).sort();
    expect(tiposDaLista).toEqual([...TIPOS_DE_PRAZO_DA_ORGANIZACAO].sort());

    const poda = corpoDa(MIGRATION, "fn_expurgar_por_organizacao");
    for (const tipo of TIPOS_DE_PRAZO_DA_ORGANIZACAO) {
      expect(poda, `ramo de poda de ${tipo}`).toContain(`p_tipo = '${tipo}'`);
    }
  });

  it("a gravação aceita exatamente as chaves `<tipo>_dias` e fecha o piso pela mesma tabela", () => {
    const corpo = corpoDa(MIGRATION, "fn_definir_retencao_da_organizacao");
    expect(corpo).toContain("fn_piso_de_retencao_por_organizacao(v_tipo)");
    expect(corpo).toContain("~ '_dias$'");
    expect(corpo).toContain("retencao_da_organizacao_abaixo_do_piso");
    expect(corpo).toContain("retencao_da_organizacao_sem_permissao");
  });
});

describe("0695 — a instalação nova recebe o que a existente recebe", () => {
  it("o apêndice do baseline carrega o corpo da migration (sem a linha de manifesto)", () => {
    const corpoDaMigration = MIGRATION.split("\n").slice(1).join("\n").trimEnd();
    expect(BASELINE).toContain(corpoDaMigration);
  });

  it("e fica ANTES do bloco da varredura anon (que é o último)", () => {
    const apendice = BASELINE.indexOf(
      "-- ---- Retenção por organização: as funções (migration 0695) ----",
    );
    const varredura = BASELINE.indexOf(
      "-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----",
    );
    expect(apendice).toBeGreaterThan(-1);
    expect(varredura).toBeGreaterThan(apendice);
    // e a migration não é criada de novo depois da varredura
    expect(BASELINE.indexOf("fn_expurgar_por_organizacao(", varredura)).toBe(-1);
  });

  it.each(FUNCOES)(
    "%s: revoga de public, anon e authenticated e concede só ao service_role",
    (assinatura) => {
      const [nome, args] = [
        assinatura.slice(0, assinatura.indexOf("(")),
        assinatura.slice(assinatura.indexOf("(")),
      ];
      const alvo = `function public.${nome}${args}`;
      for (const sql of [MIGRATION, BASELINE]) {
        expect(sql).toMatch(
          new RegExp(
            `revoke execute on ${alvo.replace(/[().]/g, "\\$&")}\\s+from public, anon, authenticated;`,
          ),
        );
        expect(sql).toMatch(
          new RegExp(`grant execute on ${alvo.replace(/[().]/g, "\\$&")} to service_role;`),
        );
      }
      // nenhum grant a anon/authenticated/public dessa função em lugar nenhum
      for (const papel of ["anon", "authenticated", "public"]) {
        expect(MIGRATION).not.toMatch(
          new RegExp(`grant execute on ${alvo.replace(/[().]/g, "\\$&")} to ${papel}`),
        );
      }
    },
  );
});
