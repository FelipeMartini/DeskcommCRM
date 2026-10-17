import { describe, expect, it } from "vitest";

import { DIMENSOES_NATIVAS_DO_GEMINI, ajustarVetorDoGemini } from "@/lib/ai/embeddings/dimensoes";

/**
 * O OmniRouter devolve as 3072 dimensões nativas do `gemini-embedding-001` e não repassa o pedido de
 * tamanho (medido em 17/10/2026: `dimensions: 1536` dá 400). A coluna é `vector(1536)`. O corte nas
 * primeiras 1536 dimensões, normalizado, é o que o Google manda fazer para qualquer tamanho menor.
 */

/** Vetor determinístico sem aleatoriedade (o teste não pode depender de sorte). */
function vetor(tamanho: number, semente: number): number[] {
  return Array.from({ length: tamanho }, (_, i) => Math.sin((i + 1) * semente) + 0.25);
}

function norma(v: readonly number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

function cosseno(a: readonly number[], b: readonly number[]): number {
  let p = 0;
  for (let i = 0; i < a.length; i++) p += a[i]! * b[i]!;
  return p / (norma(a) * norma(b));
}

describe("ajustarVetorDoGemini", () => {
  it("3072 → 1536: corta nas primeiras dimensões e deixa a norma em 1", () => {
    const v = vetor(DIMENSOES_NATIVAS_DO_GEMINI, 0.37);
    const r = ajustarVetorDoGemini(v, 1536);
    expect(r).toHaveLength(1536);
    expect(norma(r)).toBeCloseTo(1, 10);
    // É o corte das PRIMEIRAS dimensões, só dividido pela norma do corte.
    const nCorte = norma(v.slice(0, 1536));
    expect(r[0]).toBeCloseTo(v[0]! / nCorte, 12);
    expect(r[1535]).toBeCloseTo(v[1535]! / nCorte, 12);
  });

  it("preserva a ordem de semelhança: o mais parecido continua sendo o mais parecido", () => {
    const pergunta = vetor(3072, 0.11);
    // O "trecho certo" é a pergunta com um ruído pequeno; o errado é outro sinal.
    const certo = pergunta.map((x, i) => x + 0.05 * Math.cos(i));
    const errado = vetor(3072, 0.93);
    const antes = cosseno(pergunta, certo) - cosseno(pergunta, errado);
    const depois =
      cosseno(ajustarVetorDoGemini(pergunta, 1536), ajustarVetorDoGemini(certo, 1536)) -
      cosseno(ajustarVetorDoGemini(pergunta, 1536), ajustarVetorDoGemini(errado, 1536));
    expect(antes).toBeGreaterThan(0);
    expect(depois).toBeGreaterThan(0);
  });

  it("o vetor que já tem o tamanho da coluna passa intacto (e como CÓPIA)", () => {
    const v = vetor(1536, 0.5);
    const r = ajustarVetorDoGemini(v, 1536);
    expect(r).toEqual(v);
    expect(r).not.toBe(v);
  });

  it("outro tamanho não é cortado às cegas: volta intacto para a asserção de dimensão recusar", () => {
    for (const tamanho of [768, 1024, 2048, 4096]) {
      const v = vetor(tamanho, 0.5);
      expect(ajustarVetorDoGemini(v, 1536)).toEqual(v);
    }
  });

  it("não muta a entrada", () => {
    const v = vetor(3072, 0.21);
    const copia = [...v];
    ajustarVetorDoGemini(v, 1536);
    expect(v).toEqual(copia);
  });

  it("valor que não é número nas dimensões mantidas: lança, nunca grava NaN", () => {
    const v = vetor(3072, 0.3);
    v[10] = Number.NaN;
    expect(() => ajustarVetorDoGemini(v, 1536)).toThrow("embedding com valor que não é número");
    v[10] = Number.POSITIVE_INFINITY;
    expect(() => ajustarVetorDoGemini(v, 1536)).toThrow("embedding com valor que não é número");
  });

  it("valor ruim só na parte DESCARTADA não atrapalha: o que se descarta não entra na conta", () => {
    const v = vetor(3072, 0.3);
    v[2000] = Number.NaN;
    expect(ajustarVetorDoGemini(v, 1536)).toHaveLength(1536);
  });

  it("corte todo zero (norma zero): lança, em vez de dividir por zero", () => {
    const v = [...new Array<number>(1536).fill(0), ...vetor(1536, 0.4)];
    expect(() => ajustarVetorDoGemini(v, 1536)).toThrow("embedding de norma zero depois do corte");
  });
});
