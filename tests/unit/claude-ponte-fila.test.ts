/**
 * A fila da ponte (`lib/ai/claude-ponte-fila.ts`): uma chamada por vez, dentro do processo.
 *
 * O que se prova:
 *   1. uma por vez — a segunda só começa quando a primeira termina, na ordem de chegada;
 *   2. a vaga é solta no sucesso E no erro (uma chamada que falha não trava a fila);
 *   3. espera máxima — passado o prazo, `ClaudePonteOcupadaError`, e a chamada NÃO chega a sair;
 *   4. o `abortSignal` tira da fila e o turno cancelado não ocupa vaga;
 *   5. `comFilaDaPonte` espera a vez antes de chamar o `fetch` interno e repassa o sinal;
 *   6. a vaga que sobra depois de tudo isso volta a zero (nenhum vazamento).
 *
 * Tempo simulado (`vi.useFakeTimers`): nenhum teste espera relógio de verdade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ClaudePonteOcupadaError,
  comFilaDaPonte,
  criarFilaDaPonte,
  ESPERA_MAXIMA_PADRAO_MS,
} from "@/lib/ai/claude-ponte-fila";

/** Uma tarefa que só termina quando o teste manda. */
function tarefaManual<T = string>() {
  let terminar!: (v: T) => void;
  let falhar!: (e: unknown) => void;
  const promessa = new Promise<T>((res, rej) => {
    terminar = res;
    falhar = rej;
  });
  const iniciou = vi.fn();
  return { promessa, terminar, falhar, iniciou, rodar: () => (iniciou(), promessa) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("criarFilaDaPonte — uma chamada por vez", () => {
  it("a segunda só começa quando a primeira termina, e na ordem de chegada", async () => {
    const fila = criarFilaDaPonte();
    const a = tarefaManual();
    const b = tarefaManual();
    const c = tarefaManual();
    const pa = fila.executar(a.rodar);
    const pb = fila.executar(b.rodar);
    const pc = fila.executar(c.rodar);
    await vi.advanceTimersByTimeAsync(0);

    expect(a.iniciou).toHaveBeenCalledTimes(1);
    expect(b.iniciou).not.toHaveBeenCalled();
    expect(c.iniciou).not.toHaveBeenCalled();
    expect(fila.emUso()).toBe(1);
    expect(fila.esperando()).toBe(2);

    a.terminar("a");
    await expect(pa).resolves.toBe("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(b.iniciou).toHaveBeenCalledTimes(1);
    expect(c.iniciou).not.toHaveBeenCalled();

    b.terminar("b");
    await expect(pb).resolves.toBe("b");
    await vi.advanceTimersByTimeAsync(0);
    expect(c.iniciou).toHaveBeenCalledTimes(1);

    c.terminar("c");
    await expect(pc).resolves.toBe("c");
    expect(fila.emUso()).toBe(0);
    expect(fila.esperando()).toBe(0);
  });

  it("erro da chamada solta a vaga: a seguinte roda e o erro chega a quem o causou", async () => {
    const fila = criarFilaDaPonte();
    const a = tarefaManual();
    const b = tarefaManual();
    const pa = fila.executar(a.rodar);
    const pb = fila.executar(b.rodar);
    await vi.advanceTimersByTimeAsync(0);

    a.falhar(new Error("a quebrou"));
    await expect(pa).rejects.toThrow("a quebrou");
    await vi.advanceTimersByTimeAsync(0);
    expect(b.iniciou).toHaveBeenCalledTimes(1);

    b.terminar("b");
    await expect(pb).resolves.toBe("b");
    expect(fila.emUso()).toBe(0);
  });

  it("tarefa que lança de forma síncrona também solta a vaga", async () => {
    const fila = criarFilaDaPonte();
    await expect(
      fila.executar(() => {
        throw new Error("síncrono");
      }),
    ).rejects.toThrow("síncrono");
    expect(fila.emUso()).toBe(0);
    await expect(fila.executar(async () => "depois")).resolves.toBe("depois");
  });

  it("a concorrência configurada vale (duas vagas = duas ao mesmo tempo)", async () => {
    const fila = criarFilaDaPonte({ concorrencia: 2 });
    const t = [tarefaManual(), tarefaManual(), tarefaManual()];
    const ps = t.map((x) => fila.executar(x.rodar));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.map((x) => x.iniciou.mock.calls.length)).toEqual([1, 1, 0]);
    t[0]!.terminar("0");
    await ps[0];
    await vi.advanceTimersByTimeAsync(0);
    expect(t[2]!.iniciou).toHaveBeenCalledTimes(1);
    t[1]!.terminar("1");
    t[2]!.terminar("2");
    await Promise.all(ps);
    expect(fila.emUso()).toBe(0);
  });

  it("concorrência zero, negativa ou fracionária vira pelo menos uma", async () => {
    for (const concorrencia of [0, -3, 0.4]) {
      const fila = criarFilaDaPonte({ concorrencia });
      await expect(fila.executar(async () => "ok")).resolves.toBe("ok");
      expect(fila.emUso()).toBe(0);
    }
  });
});

describe("criarFilaDaPonte — espera máxima", () => {
  it("o padrão são dois minutos", () => {
    expect(ESPERA_MAXIMA_PADRAO_MS).toBe(120_000);
  });

  it("passado o prazo lança ClaudePonteOcupadaError e a chamada NUNCA sai", async () => {
    const fila = criarFilaDaPonte({ esperaMaximaMs: 1_000 });
    const a = tarefaManual();
    const b = tarefaManual();
    const pa = fila.executar(a.rodar);
    const pb = fila.executar(b.rodar);
    const falhaB = pb.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(999);
    expect(fila.esperando()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    const erro = await falhaB;
    expect(erro).toBeInstanceOf(ClaudePonteOcupadaError);
    expect((erro as ClaudePonteOcupadaError).esperouMs).toBe(1_000);
    expect(b.iniciou).not.toHaveBeenCalled();
    expect(fila.esperando()).toBe(0);
    // A vaga continua com quem já estava dentro; a desistência não a tomou nem a soltou.
    expect(fila.emUso()).toBe(1);

    a.terminar("a");
    await pa;
    expect(fila.emUso()).toBe(0);
  });

  it("quem entra antes do prazo não é derrubado pelo relógio dele", async () => {
    const fila = criarFilaDaPonte({ esperaMaximaMs: 1_000 });
    const a = tarefaManual();
    const b = tarefaManual();
    const pa = fila.executar(a.rodar);
    const pb = fila.executar(b.rodar);
    await vi.advanceTimersByTimeAsync(500);
    a.terminar("a");
    await pa;
    await vi.advanceTimersByTimeAsync(0);
    expect(b.iniciou).toHaveBeenCalledTimes(1);
    // Passa muito do prazo original de b: ele já está rodando e não pode ser desistido.
    await vi.advanceTimersByTimeAsync(10_000);
    b.terminar("b");
    await expect(pb).resolves.toBe("b");
  });

  it("a mensagem diz o que aconteceu, em segundos, e não carrega segredo", () => {
    const e = new ClaudePonteOcupadaError(120_000);
    expect(e.name).toBe("ClaudePonteOcupadaError");
    expect(e.message).toContain("claude_ponte_ocupada");
    expect(e.message).toContain("120 s");
  });
});

describe("criarFilaDaPonte — cancelamento", () => {
  it("sinal já abortado: rejeita sem entrar na fila e sem rodar", async () => {
    const fila = criarFilaDaPonte();
    const controle = new AbortController();
    controle.abort();
    const t = tarefaManual();
    await expect(fila.executar(t.rodar, controle.signal)).rejects.toBeDefined();
    expect(t.iniciou).not.toHaveBeenCalled();
    expect(fila.emUso()).toBe(0);
    expect(fila.esperando()).toBe(0);
  });

  it("abortar enquanto espera tira da fila e não ocupa a vaga de ninguém", async () => {
    const fila = criarFilaDaPonte();
    const a = tarefaManual();
    const b = tarefaManual();
    const c = tarefaManual();
    const controle = new AbortController();
    const pa = fila.executar(a.rodar);
    const pb = fila.executar(b.rodar, controle.signal);
    const pc = fila.executar(c.rodar);
    const falhaB = pb.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(fila.esperando()).toBe(2);

    controle.abort();
    await falhaB;
    expect(fila.esperando()).toBe(1);

    a.terminar("a");
    await pa;
    await vi.advanceTimersByTimeAsync(0);
    expect(b.iniciou).not.toHaveBeenCalled();
    expect(c.iniciou).toHaveBeenCalledTimes(1);
    c.terminar("c");
    await expect(pc).resolves.toBe("c");
    expect(fila.emUso()).toBe(0);
  });

  it("o motivo do aborto é o do sinal, quando for um Error", async () => {
    const fila = criarFilaDaPonte();
    const a = tarefaManual();
    const pa = fila.executar(a.rodar);
    const controle = new AbortController();
    const pb = fila.executar(async () => "nunca", controle.signal).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    const motivo = new Error("turno cancelado");
    controle.abort(motivo);
    expect(await pb).toBe(motivo);
    a.terminar("a");
    await pa;
  });
});

describe("comFilaDaPonte — o fetch espera a vez", () => {
  it("só chama o fetch interno quando a vaga chega, repassando entrada e opções", async () => {
    const fila = criarFilaDaPonte();
    const respostas: Array<(r: Response) => void> = [];
    const interno = vi.fn(
      (_i: Parameters<typeof fetch>[0], _n?: RequestInit) =>
        new Promise<Response>((res) => respostas.push(res)),
    );
    const f = comFilaDaPonte(interno as unknown as typeof fetch, fila);

    const p1 = f("http://claude-ponte:8080/v1/messages", { method: "POST" });
    const p2 = f("http://claude-ponte:8080/v1/messages", { method: "POST" });
    await vi.advanceTimersByTimeAsync(0);
    expect(interno).toHaveBeenCalledTimes(1);

    respostas[0]!(new Response("um", { status: 200 }));
    expect(await (await p1).text()).toBe("um");
    await vi.advanceTimersByTimeAsync(0);
    expect(interno).toHaveBeenCalledTimes(2);
    expect(interno.mock.calls[1]![1]).toMatchObject({ method: "POST" });

    respostas[1]!(new Response("dois", { status: 200 }));
    expect(await (await p2).text()).toBe("dois");
    expect(fila.emUso()).toBe(0);
  });

  it("um 529 da ponte devolve a resposta e libera a vaga (quem decide é o SDK)", async () => {
    const fila = criarFilaDaPonte();
    const interno = vi.fn(async () => new Response("ocupada", { status: 529 }));
    const f = comFilaDaPonte(interno as unknown as typeof fetch, fila);
    expect((await f("http://claude-ponte:8080/v1/messages")).status).toBe(529);
    expect(fila.emUso()).toBe(0);
  });

  it("o `signal` do init tira a chamada da fila", async () => {
    const fila = criarFilaDaPonte();
    const a = tarefaManual<Response>();
    const interno = vi.fn(() => a.promessa);
    const f = comFilaDaPonte(interno as unknown as typeof fetch, fila);
    const p1 = f("http://claude-ponte:8080/v1/messages");
    const controle = new AbortController();
    const p2 = f("http://claude-ponte:8080/v1/messages", { signal: controle.signal }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(0);
    controle.abort();
    await p2;
    expect(interno).toHaveBeenCalledTimes(1);
    a.terminar(new Response("ok"));
    await p1;
    expect(fila.emUso()).toBe(0);
  });
});
