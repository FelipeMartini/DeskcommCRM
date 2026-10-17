/**
 * Embedding do RAG — indexação e busca, o mesmo modelo dos dois lados.
 *
 * A chave vem de `lib/ai/embeddings/chave.ts`, que resolve pela organização:
 * binding do ponto → credencial OpenAI/OpenRouter da org → gateway da instalação
 * → chave da instalação (ou, na família que a organização escolheu, a busca por palavras ou o
 * OmniRouter da instalação). Até a 0181 este arquivo lia SÓ `process.env`, e o efeito era o
 * pior possível para quem instala: cadastrar a chave da OpenAI pela tela não
 * habilitava a base de conhecimento, enquanto duas telas do produto prometiam
 * que sim.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { embed } from "ai";

import {
  DIMENSOES_DO_EMBEDDING,
  MODELO_DE_EMBEDDING_DA_BUSCA_POR_TEXTO,
  MODELO_NO_OMNIROUTER,
  modeloDeEmbedding,
  resolverChaveDeEmbedding,
  type ChaveDeEmbedding,
  type PontoDeEmbedding,
} from "@/lib/ai/embeddings/chave";
import { ajustarVetorDoGemini } from "@/lib/ai/embeddings/dimensoes";
import { gatewayHeaders, type ModelId } from "@/lib/ai/gateway";
import { opcoesDoOmniRouter } from "@/lib/ai/omnirouter";
import { logger } from "@/lib/logger";
// O par (provedor, modelo): a mesma régua dos demais caminhos (issue #2377).
import { ParProvedorModeloInvalidoError, validarParProvedorModelo } from "@/lib/ai/par-provedor-modelo";

export interface EmbedOptions {
  organizationId: string;
  /**
   * Qual ponto de IA está chamando. Muda apenas de QUAL binding a chave sai —
   * o modelo é o mesmo por contrato, e divergir quebraria o recall em silêncio.
   */
  ponto?: PontoDeEmbedding;
  /**
   * Chave já resolvida. Existe para o indexador resolver UMA vez e embedar N
   * chunks: sem isto, indexar um documento de 200 trechos decifraria a
   * credencial 200 vezes.
   */
  chave?: ChaveDeEmbedding;
  model?: ModelId;
}

export interface EmbedResult {
  embedding: number[];
  promptTokens: number;
  model: string;
}

/** Falta de chave é um ESTADO do tenant, não um acidente: tipo próprio para quem
 *  chama poder mostrar a tela certa em vez de repetir um erro genérico. */
export class SemChaveDeEmbeddingError extends Error {
  readonly code = "embedding_sem_chave";
  constructor(readonly organizationId: string) {
    super(
      "Esta organização não tem chave de embedding para indexar nem consultar o material. " +
        "Cadastre uma chave OpenAI, OpenRouter ou Google em Credenciais, ou troque a base para " +
        "a busca por palavras, que não usa chave.",
    );
    this.name = "SemChaveDeEmbeddingError";
  }
}

export async function embedText(
  content: string,
  opts: EmbedOptions,
): Promise<EmbedResult> {
  const chave =
    opts.chave ?? (await resolverChaveDeEmbedding(opts.organizationId, opts.ponto));
  if (!chave) {
    throw new SemChaveDeEmbeddingError(opts.organizationId);
  }

  // A BUSCA POR PALAVRAS não calcula vetor nenhum: o trecho é gravado com vetor zero
  // (a coluna é NOT NULL) e a pergunta é respondida por `fn_buscar_trechos_por_texto`,
  // que recebe o TEXTO. Quem chama reconhece a família pelo `model` devolvido
  // (`ehBuscaPorTexto`) e troca de função; nenhuma rede é tocada aqui.
  if (chave.provedor === "texto") {
    return {
      embedding: new Array<number>(DIMENSOES_DO_EMBEDDING).fill(0),
      promptTokens: 0,
      model: MODELO_DE_EMBEDDING_DA_BUSCA_POR_TEXTO,
    };
  }

  const modelId = String(opts.model ?? modeloDeEmbedding(chave.provedor));

  // O PAR ANTES DE INDEXAR OU CONSULTAR (issue #2377) — caminho de LEITURA,
  // que era justamente um dos que falhavam sozinhos. `chave.provedor` é quem
  // recebe a requisição (`"gateway"` não é fabricante, então a régua é
  // conservadora lá e o roteamento continua sendo do próprio gateway). Recusar
  // aqui é melhor que embedar com o par errado: metade da base criada com um
  // vetor e a consulta feita com outro é recall quebrado em silêncio.
  const parDeEmbedding = validarParProvedorModelo(chave.provedor, modelId);
  if (!parDeEmbedding.valido) {
    logger.warn("ia: par provedor+modelo recusado antes da chamada", {
      organization_id: opts.organizationId,
      purpose: opts.ponto,
      provider: chave.provedor,
      model: modelId,
      origem_da_configuracao: opts.chave ? "chave_resolvida_antes" : "chave_da_organizacao",
      motivo: parDeEmbedding.motivo,
    });
    throw new ParProvedorModeloInvalidoError(chave.provedor, modelId, parDeEmbedding.motivo, opts.ponto);
  }

  // COM gateway: a string `openai/text-embedding-3-small` é roteada por ele, que
  // lê `AI_GATEWAY_API_KEY` do process.env. Headers vão junto p/ observabilidade
  // por tenant + ZDR.
  //
  // SEM gateway: precisa ser um provider EXPLÍCITO. Passar a string com
  // barra aqui não cai no OpenAI direto — no AI SDK, id com barra é resolvido
  // pelo gateway da Vercel mesmo sem chave, entrando no plano anônimo, cujo teto
  // devolve `GatewayRateLimitError`. OpenAI direto usa id sem prefixo; OpenRouter
  // recebe o slug completo que a API de embeddings dela exige.
  //
  // OMNIROUTER: fala a API da OpenAI, então é o mesmo provider explícito, mas pelas opções DELE
  // (`opcoesDoOmniRouter`: endereço revalidado, só a origem da instalação e sem seguir redirect —
  // a chave do roteador nunca vai a outro host). O modelo que o roteador conhece é
  // `MODELO_NO_OMNIROUTER`; `modelId` (o marcador `omnirouter/…`) é só o nome do mapa de vetores.
  const resolvido = chave.viaGateway
    ? modelId
    : chave.provedor === "omnirouter"
      ? createOpenAI(opcoesDoOmniRouter(chave.apiKey ?? "", chave.baseUrl ?? undefined)).textEmbeddingModel(
          MODELO_NO_OMNIROUTER,
        )
      : chave.provedor === "google"
        ? createGoogleGenerativeAI({ apiKey: chave.apiKey ?? "" }).embeddingModel(
            modelId.replace(/^google\//, ""),
          )
        : createOpenAI({
          apiKey: chave.apiKey ?? "",
          ...(chave.baseUrl ? { baseURL: chave.baseUrl } : {}),
        }).textEmbeddingModel(
          chave.provedor === "openrouter" ? modelId : modelId.replace(/^openai\//, ""),
        );

  const result = await embed({
    model: resolvido,
    value: content,
    headers: chave.viaGateway
      ? gatewayHeaders({ organizationId: opts.organizationId })
      : undefined,
    // O Gemini devolve 3072 dimensões por padrão; pedir 1536 é o que deixa a
    // coluna `vector(1536)` servir aos dois provedores sem migration. A busca é
    // por cosseno (`<=>`), então o vetor não normalizado dessa dimensão não
    // distorce a nota. O `taskType` é o par documento×pergunta do próprio Google.
    ...(chave.provedor === "google"
      ? {
          providerOptions: {
            google: {
              outputDimensionality: DIMENSOES_DO_EMBEDDING,
              taskType:
                opts.ponto === "embedding_consultar" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
            },
          },
        }
      : {}),
  });

  // O OmniRouter devolve as 3072 dimensões nativas do Gemini (não repassa o parâmetro de tamanho):
  // corta nas 1536 da coluna e normaliza. Qualquer outro tamanho segue intacto para a asserção abaixo.
  const vetor =
    chave.provedor === "omnirouter"
      ? ajustarVetorDoGemini(result.embedding, DIMENSOES_DO_EMBEDDING)
      : result.embedding;

  // Dimensão asserida a cada chamada: divergir de modelo quebra o recall em
  // SILÊNCIO (os vetores deixam de ser comparáveis), e uma chamada recusada é
  // infinitamente melhor que um acervo que responde errado com nota alta.
  if (vetor.length !== DIMENSOES_DO_EMBEDDING) {
    throw new Error(
      `embedding com ${vetor.length} dimensões, esperado ${DIMENSOES_DO_EMBEDDING} ` +
        `(pin de contrato ${modelId}) — recall quebraria em silêncio`,
    );
  }

  // EmbedResult.embedding is `number[]` for single-value embed.
  const promptTokens =
    (result.usage as { tokens?: number; promptTokens?: number } | undefined)?.tokens ??
    (result.usage as { tokens?: number; promptTokens?: number } | undefined)?.promptTokens ??
    0;

  return { embedding: vetor, promptTokens, model: modelId };
}
