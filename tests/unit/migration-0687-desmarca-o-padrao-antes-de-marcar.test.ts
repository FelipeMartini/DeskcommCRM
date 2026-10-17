/**
 * A 0687 DESMARCA O PADRÃO ANTERIOR DA ANTHROPIC ANTES DE MARCAR O NOVO — nos dois artefatos.
 *
 * O defeito: `ai_models_one_default_per_provider` é um índice UNIQUE parcial e IMEDIATO (um modelo
 * padrão por provedor). A 0687 marcava `claude-haiku-5-5` como padrão (no `insert … on conflict do
 * update`) e só DEPOIS desmarcava os outros. Com outro modelo da Anthropic ainda marcado, o primeiro
 * comando já violava a unicidade e a migration quebrava no meio. Na janela de 16/10/2026 isso foi
 * contornado à mão, com um prelúdio de uma linha na frente da migration; o conserto é a ordem certa
 * dentro dela, e o mesmo no `baseline.sql` (o kit self-host aplica SÓ o baseline).
 *
 * O que este arquivo cobra, sem subir banco (o banco de verdade é o `pnpm test:db`, que aplica o
 * baseline em install e em update):
 *   1. a migration desmarca o padrão ANTES do primeiro comando que o marca;
 *   2. o baseline contém a migration inteira, sem diferença (espelho exato);
 *   3. dentro do bloco do baseline a ordem é a mesma.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const MIGRATION = "supabase/migrations/20261016153244_0687_haiku_padrao_e_omnirouter.sql";
const MARCA_DO_BLOCO = "-- ---- Claude Haiku 5.5 padrão da Anthropic e das organizações (migration 0687) ----";

/** Só o que o Postgres executa: sem comentário de linha (o texto de cima cita os comandos). */
function semComentarios(sql: string): string {
  return sql
    .split("\n")
    .map((linha) => linha.replace(/--.*$/, ""))
    .join("\n");
}

/** Posição do primeiro comando que DESMARCA o padrão da Anthropic, e do que o MARCA. */
function posicoes(sql: string): { desmarca: number; marca: number } {
  const limpo = semComentarios(sql);
  const desmarca = limpo.search(
    /update\s+public\.ai_models\s+set\s+is_default_for_provider\s*=\s*false[\s\S]*?provider\s*=\s*'anthropic'/i,
  );
  const marca = limpo.search(/insert\s+into\s+public\.ai_models/i);
  return { desmarca, marca };
}

describe("a 0687 limpa o padrão anterior antes de marcar o Haiku 5.5", () => {
  const migration = readFileSync(join(RAIZ, MIGRATION), "utf8");
  const baseline = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");

  it("controle: os dois arquivos existem e a medição enxerga os dois comandos", () => {
    // Sem isto, um caminho errado ou uma expressão que não casa deixariam as asserções de ordem
    // verdes sobre `-1 < -1`: o gate morto, a forma mais silenciosa de passar sem medir nada.
    expect(existsSync(join(RAIZ, MIGRATION))).toBe(true);
    expect(baseline.length).toBeGreaterThan(1000);
    const { desmarca, marca } = posicoes(migration);
    expect(desmarca).toBeGreaterThanOrEqual(0);
    expect(marca).toBeGreaterThanOrEqual(0);
  });

  it("⭐ na migration, o padrão anterior é desmarcado ANTES de o Haiku 5.5 ser marcado", () => {
    const { desmarca, marca } = posicoes(migration);
    expect(desmarca).toBeLessThan(marca);
  });

  it("o comando que desmarca só mexe em linha que de fato é padrão (idempotente)", () => {
    // Com o Haiku 5.5 já padrão, nenhuma linha casa: reaplicar não muda nada.
    const limpo = semComentarios(migration);
    expect(limpo).toMatch(
      /update\s+public\.ai_models\s+set\s+is_default_for_provider\s*=\s*false\s+where\s+provider\s*=\s*'anthropic'\s+and\s+model_id\s*<>\s*'claude-haiku-5-5'\s+and\s+is_default_for_provider\s*;/i,
    );
  });

  it("⭐ o baseline contém a migration inteira, sem uma única diferença", () => {
    expect(baseline.includes(migration.trimEnd())).toBe(true);
  });

  it("⭐ no bloco do baseline a ordem é a mesma: desmarcar, depois marcar", () => {
    const inicio = baseline.indexOf(MARCA_DO_BLOCO);
    expect(inicio).toBeGreaterThanOrEqual(0);
    // O bloco vai até o `notify` final do arquivo.
    const fim = baseline.indexOf("\nnotify pgrst", inicio);
    expect(fim).toBeGreaterThan(inicio);
    const { desmarca, marca } = posicoes(baseline.slice(inicio, fim));
    expect(desmarca).toBeGreaterThanOrEqual(0);
    expect(marca).toBeGreaterThanOrEqual(0);
    expect(desmarca).toBeLessThan(marca);
  });

  it("a medição acusa a ordem antiga (controle de que o teste de ordem pega o defeito)", () => {
    const antiga = [
      "insert into public.ai_models (provider, model_id) values ('anthropic', 'claude-haiku-5-5')",
      "on conflict (provider, model_id) do update set is_default_for_provider = true;",
      "update public.ai_models set is_default_for_provider = false",
      "where provider = 'anthropic' and model_id <> 'claude-haiku-5-5';",
    ].join("\n");
    const { desmarca, marca } = posicoes(antiga);
    expect(desmarca).toBeGreaterThan(marca);
  });
});
