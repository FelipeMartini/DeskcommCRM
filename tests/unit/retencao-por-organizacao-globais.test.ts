import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { prazoSemEfeito, prazosGlobaisDosTipos } from "@/lib/retencao/prazos-da-organizacao";

/**
 * O TETO QUE A TELA MOSTRA É O QUE O CRON APLICA — migration 0693, etapa 3.
 *
 * A organização só encurta, então o prazo global é o teto dela, e a tela
 * (`prazosGlobaisDosTipos`) mostra esse número e avisa "sem efeito" quando o que
 * foi digitado não o alcança. Se a tela e o cron lessem variáveis diferentes, o
 * aviso mentiria: o admin acharia que mantém o dado por mais tempo, ou que
 * encurtou, e nenhuma das duas seria verdade. Por isso há duas conferências: o
 * comportamento (o mesmo `interpretarRetencao`) e a FONTE (cada variável citada
 * aqui é a que o cron e a captação de fato leem).
 */

const RAIZ = join(__dirname, "..", "..");
const CRON = readFileSync(
  join(RAIZ, "app", "api", "v1", "cron", "data-retention", "route.ts"),
  "utf8",
);
const CAPTACAO = readFileSync(join(RAIZ, "lib", "webhooks", "retencao-da-captacao.ts"), "utf8");

describe("prazosGlobaisDosTipos — o prazo da instalação, interpretado como o cron interpreta", () => {
  it("sem nada configurado: os padrões de cada tipo", () => {
    expect(prazosGlobaisDosTipos({})).toEqual({
      captacao: 365,
      conversa_do_caso: 365,
      prospeccao: 365,
      espelho_da_agenda: 90,
    });
  });

  it("o que a instalação gravou vale; lixo vira o padrão; abaixo do piso vira o piso", () => {
    expect(
      prazosGlobaisDosTipos({
        LEAD_CAPTURE_RETENTION_DAYS: "200",
        CASE_CHAT_RETENTION_DAYS: "noventa",
        PROSPECCAO_RETENTION_DAYS: "10", // piso 90
        CALENDAR_MIRROR_RETENTION_DAYS: "  30 ",
      }),
    ).toEqual({
      captacao: 200,
      conversa_do_caso: 365,
      prospeccao: 90,
      espelho_da_agenda: 30,
    });
  });

  it("zero e negativo não são prazo: voltam ao padrão", () => {
    expect(
      prazosGlobaisDosTipos({ LEAD_CAPTURE_RETENTION_DAYS: "0", CASE_CHAT_RETENTION_DAYS: "-5" }),
    ).toMatchObject({ captacao: 365, conversa_do_caso: 365 });
  });

  it("acima do teto de 100 anos cai no teto, não derruba a tela", () => {
    expect(prazosGlobaisDosTipos({ LEAD_CAPTURE_RETENTION_DAYS: "999999" }).captacao).toBe(36500);
  });
});

describe("a fonte de cada variável global é a que o cron lê", () => {
  it.each([
    ["CASE_CHAT_RETENTION_DAYS", CRON],
    ["PROSPECCAO_RETENTION_DAYS", CRON],
    ["CALENDAR_MIRROR_RETENTION_DAYS", CRON],
    ["LEAD_CAPTURE_RETENTION_DAYS", CAPTACAO],
  ])("%s", (variavel, fonte) => {
    expect(fonte).toContain(`chave: "${variavel}"`);
  });
});

describe("prazoSemEfeito — o aviso 'a organização só encurta'", () => {
  it("igual ou maior que o global não tem efeito; menor tem", () => {
    expect(prazoSemEfeito(365, 365)).toBe(true);
    expect(prazoSemEfeito(500, 365)).toBe(true);
    expect(prazoSemEfeito(364, 365)).toBe(false);
  });
});
