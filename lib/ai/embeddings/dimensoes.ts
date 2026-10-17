/**
 * O TAMANHO DO VETOR QUE O OMNIROUTER DEVOLVE, AJUSTADO À COLUNA.
 *
 * `ai_chunks.embedding` é `vector(1536)`. O Google devolve 3072 dimensões por padrão e aceita pedir
 * 1536 (`outputDimensionality`, `lib/ai/embed.ts`). Pelo OmniRouter isso NÃO funciona: medido em
 * 17/10/2026, `POST /v1/embeddings` com `dimensions: 1536` e o modelo `gemini/gemini-embedding-001`
 * dá 400 do Google ("Unknown name outputDimensionality"), porque o roteador põe o parâmetro no lugar
 * errado do pedido. Sem o parâmetro, vêm as 3072 dimensões.
 *
 * O `gemini-embedding-001` é treinado em camadas (Matryoshka): as primeiras N dimensões já são um
 * embedding de N dimensões, desde que se NORMALIZE o corte (é o que a documentação do Google manda para
 * qualquer tamanho diferente de 3072). Medido na mesma data com cinco perguntas e cinco respostas em
 * português, o corte a 1536 normalizado acertou 5 de 5, como as 3072, com o melhor trecho entre 0,75 e
 * 0,85 e o segundo colocado perto de 0,6.
 *
 * Só se corta o tamanho que se SABE ser deste modelo (3072). Qualquer outro tamanho que não seja o da
 * coluna é recusado por quem chama: um modelo diferente por trás do mesmo nome não se corta às cegas,
 * porque cortar um vetor que não é Matryoshka estraga a busca sem dar erro.
 */

/** O tamanho nativo do `gemini-embedding-001`, e o único que esta família sabe cortar. */
export const DIMENSOES_NATIVAS_DO_GEMINI = 3072;

/**
 * Devolve o vetor no tamanho da coluna quando for o caso conhecido (3072 → corte + norma 1); qualquer
 * outro tamanho volta INTACTO, para a asserção de dimensão de `embedText` recusar com a mensagem de
 * sempre. Nunca devolve vetor com valor não finito nem de norma zero: isso lança.
 */
export function ajustarVetorDoGemini(
  vetor: readonly number[],
  dimensoesDaColuna: number,
): number[] {
  if (vetor.length !== DIMENSOES_NATIVAS_DO_GEMINI || dimensoesDaColuna >= vetor.length) {
    return [...vetor];
  }
  const corte = vetor.slice(0, dimensoesDaColuna);
  let soma = 0;
  for (const x of corte) {
    if (!Number.isFinite(x)) throw new Error("embedding com valor que não é número");
    soma += x * x;
  }
  const norma = Math.sqrt(soma);
  if (!(norma > 0)) throw new Error("embedding de norma zero depois do corte");
  return corte.map((x) => x / norma);
}
