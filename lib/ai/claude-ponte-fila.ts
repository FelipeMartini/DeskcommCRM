/**
 * A FILA DA PONTE — uma chamada por vez, DENTRO do processo.
 *
 * A `claude-ponte` atende UMA chamada por vez: a segunda espera até 20 s e, se a primeira não
 * terminou, volta `529` (ver `lib/ai/claude-ponte.ts`). O worker do CRM, por outro lado, aceita até
 * `QUEUE_MAX_CONCURRENCY` turnos simultâneos (8 por padrão), e um turno é de 5 a 8 chamadas de ~5 s.
 * Dois clientes escrevendo ao mesmo tempo bastam para um 529, e o 529 gasta uma tentativa do job
 * (5 no total) — o turno recomeça do primeiro passo e gasta cota de novo.
 *
 * Esta fila existe para a chamada esperar AQUI, no processo, e chegar à ponte sozinha:
 *
 *   - granularidade: a requisição HTTP, não o turno. Quem segura a vaga é o `fetch` da fábrica da
 *     ponte (`opcoesDaPonte`), então uma ferramenta que roda no meio do turno NÃO prende a vaga, e
 *     uma ferramenta que também chame o modelo não trava esperando por si mesma;
 *   - a vaga é solta quando os cabeçalhos da resposta chegam (a ponte não faz streaming para o
 *     CRM: o corpo vem junto);
 *   - FIFO: quem chegou primeiro, passa primeiro;
 *   - espera MÁXIMA (`ESPERA_MAXIMA_PADRAO_MS`): passado o prazo, lança `ClaudePonteOcupadaError`,
 *     que o SDK NÃO repete (é um erro comum, não de rede) e que `normalizarErro` rotula como
 *     `provedor_indisponivel` (529). O job é reagendado pela fila do worker, e o turno não fica
 *     preso além do `QUEUE_VISIBILITY_TIMEOUT_MS`;
 *   - o `abortSignal` da chamada também tira da fila (o turno cancelado não ocupa vaga).
 *
 * O que ela NÃO faz: não enxerga outro processo. O app (o botão "Executar teste") e o worker são
 * processos diferentes e podem colidir; a fila da própria ponte (20 s) continua sendo a rede de
 * segurança para esse caso raro. Também não é variável de ambiente: as três do `.env` são o
 * contrato da ponte e uma quarta mudaria o que a Mylab precisa operar.
 *
 * Sem DOM, sem banco, sem logger e sem `@/lib/env`, como o módulo irmão.
 */

/** Quantas chamadas simultâneas a ponte aguenta. Uma: é o que ela documenta. */
export const CONCORRENCIA_PADRAO = 1;

/**
 * Quanto uma chamada espera pela vaga antes de desistir. Dois minutos cobrem uns 10 turnos na
 * frente; mais do que isso o cliente já esperou demais e o job é reagendado.
 */
export const ESPERA_MAXIMA_PADRAO_MS = 120_000;

/** A vaga não liberou a tempo. Não é erro da ponte nem da chave: a ponte desta instalação está cheia. */
export class ClaudePonteOcupadaError extends Error {
  override readonly name = "ClaudePonteOcupadaError";
  readonly esperouMs: number;
  constructor(esperouMs: number) {
    super(
      `claude_ponte_ocupada: a fila da ponte nesta instalação não liberou em ` +
        `${Math.round(esperouMs / 1000)} s; a tentativa será refeita mais tarde`,
    );
    this.esperouMs = esperouMs;
  }
}

export interface OpcoesDaFila {
  concorrencia?: number;
  esperaMaximaMs?: number;
}

export interface FilaDaPonte {
  /** Roda `tarefa` quando houver vaga; solta a vaga ao terminar, com erro ou sem. */
  executar<T>(tarefa: () => Promise<T>, sinal?: AbortSignal | null): Promise<T>;
  /** Vagas em uso agora. */
  emUso(): number;
  /** Chamadas esperando por vaga agora. */
  esperando(): number;
}

interface Espera {
  entrar: () => void;
  desistir: () => void;
}

function erroDeAborto(sinal: AbortSignal): Error {
  const motivo: unknown = sinal.reason;
  if (motivo instanceof Error) return motivo;
  return new DOMException("This operation was aborted", "AbortError");
}

export function criarFilaDaPonte(opcoes: OpcoesDaFila = {}): FilaDaPonte {
  const concorrencia = Math.max(1, Math.floor(opcoes.concorrencia ?? CONCORRENCIA_PADRAO));
  const esperaMaximaMs = Math.max(0, opcoes.esperaMaximaMs ?? ESPERA_MAXIMA_PADRAO_MS);
  let emUso = 0;
  const fila: Espera[] = [];

  function adquirir(sinal: AbortSignal | null | undefined): Promise<void> {
    if (sinal?.aborted) return Promise.reject(erroDeAborto(sinal));
    if (emUso < concorrencia) {
      emUso += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const tirarDaFila = () => {
        const i = fila.indexOf(espera);
        if (i >= 0) fila.splice(i, 1);
      };
      const aoAbortar = () => {
        clearTimeout(relogio);
        tirarDaFila();
        reject(erroDeAborto(sinal as AbortSignal));
      };
      const espera: Espera = {
        // A vaga PASSA de quem terminou para quem espera: `emUso` não muda.
        entrar: () => {
          clearTimeout(relogio);
          sinal?.removeEventListener("abort", aoAbortar);
          resolve();
        },
        desistir: () => {
          tirarDaFila();
          sinal?.removeEventListener("abort", aoAbortar);
          reject(new ClaudePonteOcupadaError(esperaMaximaMs));
        },
      };
      const relogio = setTimeout(() => espera.desistir(), esperaMaximaMs);
      // Não segura o processo vivo só por causa de uma espera.
      (relogio as { unref?: () => void }).unref?.();
      sinal?.addEventListener("abort", aoAbortar, { once: true });
      fila.push(espera);
    });
  }

  function liberar(): void {
    const proxima = fila.shift();
    if (proxima !== undefined) proxima.entrar();
    else emUso -= 1;
  }

  return {
    async executar<T>(tarefa: () => Promise<T>, sinal?: AbortSignal | null): Promise<T> {
      await adquirir(sinal);
      try {
        return await tarefa();
      } finally {
        liberar();
      }
    },
    emUso: () => emUso,
    esperando: () => fila.length,
  };
}

const CHAVE_DA_FILA = Symbol.for("claude-ponte.fila");

/**
 * A fila do PROCESSO. `Symbol.for` no `globalThis` pelo mesmo motivo de `FABRICA_DA_PONTE`: duas
 * cópias do módulo no mesmo processo (bundles diferentes do Next) têm de concordar sobre a vaga.
 */
export const filaDaPonte: FilaDaPonte = (() => {
  const global = globalThis as unknown as Record<symbol, FilaDaPonte | undefined>;
  const existente = global[CHAVE_DA_FILA];
  if (existente !== undefined) return existente;
  const nova = criarFilaDaPonte();
  global[CHAVE_DA_FILA] = nova;
  return nova;
})();

/**
 * O `fetch` que espera a vez antes de falar com a ponte. A contenção (host, redirect) fica DENTRO:
 * a fila só decide QUANDO, nunca PARA ONDE.
 */
export function comFilaDaPonte(
  interno: typeof fetch,
  fila: FilaDaPonte = filaDaPonte,
): typeof fetch {
  return (input, init) => fila.executar(() => interno(input, init), init?.signal ?? null);
}
