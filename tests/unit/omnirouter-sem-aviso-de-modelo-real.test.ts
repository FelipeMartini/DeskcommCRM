/**
 * O AVISO "MODELO REAL" DO OMNIROUTER NÃO CHEGA AO CLIENTE.
 *
 * Em 16/10/2026 a ProjetoMylab mediu que o OmniRouter escreve `> 🤖 **[Modelo Real: <modelo> (<rota>)]**` no
 * INÍCIO do texto das respostas de `/v1/chat/completions` (a forma `/v1/messages` vem limpa). O CRM fala
 * Chat Completions com o OmniRouter (`createOpenAI(...).chat()`), e o texto do agente vira mensagem de
 * WhatsApp: sem filtro, o cliente leria o nome do modelo e da rota. Este arquivo prova, em ordem:
 *
 *   1. o filtro puro tira o aviso do começo (com ou sem emoji, com LF ou CRLF), é idempotente e não toca
 *      texto sem o aviso nem a menção a "Modelo Real" no meio de uma frase;
 *   2. o `fetch` contido reescreve só o `content` das `choices`: o restante do corpo (id, uso, motivo de
 *      parada) e o status ficam como vieram, e os cabeçalhos de tamanho/codificação saem;
 *   3. o que o filtro não conhece passa INTACTO: erro HTTP, fluxo de eventos, corpo que não é JSON, JSON sem
 *      `choices`, mensagem sem texto (chamada de ferramenta);
 *   4. de ponta a ponta: o SDK real (`generateText`) entrega o texto sem o aviso.
 *
 * Nenhuma rede, nenhuma chave real: valores sintéticos.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";

import {
  fetchContidoDoOmniRouter,
  opcoesDoOmniRouter,
  tirarAvisoDoModeloReal,
} from "@/lib/ai/omnirouter";

const OMNI = "https://omnirouter.example.com";
const AVISO = "> 🤖 **[Modelo Real: claude-haiku-5-5 (Ponte Assinatura)]**";

function respostaDoOmni(content: string | null, extra: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "claude-haiku-5-5",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    ...extra,
  };
}

function json(corpo: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(corpo), {
    status: 200,
    ...init,
    headers: {
      "content-type": "application/json",
      "content-length": "999",
      ...(init.headers as object),
    },
  });
}

function chamar(res: Response) {
  const interno = async () => res;
  return fetchContidoDoOmniRouter(OMNI, interno as unknown as typeof fetch)(
    `${OMNI}/v1/chat/completions`,
    {
      method: "POST",
      body: "{}",
    },
  );
}

describe("tirarAvisoDoModeloReal — o filtro puro", () => {
  it("tira o aviso e as quebras que o seguem", () => {
    expect(tirarAvisoDoModeloReal(`${AVISO}\n\nOlá! Posso ajudar?`)).toBe("Olá! Posso ajudar?");
    expect(tirarAvisoDoModeloReal(`${AVISO}\r\n\r\nOlá!`)).toBe("Olá!");
    expect(tirarAvisoDoModeloReal(`${AVISO} Olá!`)).toBe("Olá!");
  });

  it("aceita o aviso sem o emoji e com espaços antes", () => {
    expect(tirarAvisoDoModeloReal("> **[Modelo Real: outro (rota x)]**\n\nOi")).toBe("Oi");
    expect(tirarAvisoDoModeloReal(`  \n${AVISO}\nOi`)).toBe("Oi");
  });

  it("é idempotente", () => {
    const uma = tirarAvisoDoModeloReal(`${AVISO}\n\nOlá!`);
    expect(tirarAvisoDoModeloReal(uma)).toBe(uma);
  });

  it("não mexe em texto sem o aviso, nem na menção a 'Modelo Real' no meio de uma frase", () => {
    for (const texto of [
      "Olá! Posso ajudar?",
      "",
      "Nosso Modelo Real de atendimento é este.",
      `Olá!\n\n${AVISO}\n\nde novo no meio`,
      "> Citação normal de um cliente\n\nOk",
    ]) {
      expect(tirarAvisoDoModeloReal(texto)).toBe(texto);
    }
  });

  it("um texto que é só o aviso vira vazio (o agente decide o que fazer com resposta vazia)", () => {
    expect(tirarAvisoDoModeloReal(AVISO)).toBe("");
  });
});

describe("fetchContidoDoOmniRouter — o corpo JSON sai sem o aviso", () => {
  it("reescreve só o content; id, uso, motivo de parada e status ficam como vieram", async () => {
    const res = await chamar(json(respostaDoOmni(`${AVISO}\n\nOlá! Posso ajudar?`)));
    expect(res.status).toBe(200);
    const corpo = await res.json();
    expect(corpo.choices[0].message.content).toBe("Olá! Posso ajudar?");
    expect(corpo.choices[0].finish_reason).toBe("stop");
    expect(corpo.id).toBe("chatcmpl-1");
    expect(corpo.usage).toEqual({ prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 });
  });

  it("os cabeçalhos de tamanho e de codificação antigos saem; o tipo fica", async () => {
    const res = await chamar(
      json(respostaDoOmni(`${AVISO}\n\nOi`), { headers: { "content-encoding": "gzip" } }),
    );
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("limpa cada escolha que tem o aviso e deixa as outras", async () => {
    const corpo = respostaDoOmni(null);
    corpo.choices = [
      { index: 0, message: { role: "assistant", content: `${AVISO}\n\nA` }, finish_reason: "stop" },
      { index: 1, message: { role: "assistant", content: "B" }, finish_reason: "stop" },
    ];
    const lido = await (await chamar(json(corpo))).json();
    expect(lido.choices.map((c: { message: { content: string } }) => c.message.content)).toEqual([
      "A",
      "B",
    ]);
  });

  it("resposta sem o aviso volta intacta (mesmo objeto, mesmos cabeçalhos)", async () => {
    const original = json(respostaDoOmni("Olá!"));
    const res = await chamar(original);
    expect(res).toBe(original);
    expect(res.headers.get("content-length")).toBe("999");
    expect((await res.json()).choices[0].message.content).toBe("Olá!");
  });
});

describe("fetchContidoDoOmniRouter — o que o filtro não conhece passa intacto", () => {
  it("erro HTTP: nem é lido", async () => {
    const original = json({ error: { message: `${AVISO} falhou` } }, { status: 500 });
    expect(await chamar(original)).toBe(original);
  });

  it("fluxo de eventos (streaming): passa direto", async () => {
    const original = new Response(`data: {"choices":[{"delta":{"content":"${AVISO}"}}]}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    expect(await chamar(original)).toBe(original);
  });

  it("corpo que não é JSON, JSON quebrado e JSON sem choices passam", async () => {
    const texto = new Response("olá", { status: 200, headers: { "content-type": "text/plain" } });
    expect(await chamar(texto)).toBe(texto);
    const quebrado = new Response("{nao é json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    expect(await chamar(quebrado)).toBe(quebrado);
    const semEscolhas = json({ data: [] });
    expect(await chamar(semEscolhas)).toBe(semEscolhas);
  });

  it("mensagem sem texto (chamada de ferramenta) passa", async () => {
    const original = json(respostaDoOmni(null));
    expect(await chamar(original)).toBe(original);
  });

  it("um interno que devolve um objeto qualquer (dublê) não derruba a chamada", async () => {
    const dubles = { status: 200 } as unknown as Response;
    expect(await chamar(dubles)).toBe(dubles);
  });
});

describe("de ponta a ponta — o SDK real entrega o texto sem o aviso", () => {
  it("generateText sobre opcoesDoOmniRouter devolve a resposta limpa", async () => {
    const original = globalThis.fetch;
    let alvo = "";
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      alvo =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return json(respostaDoOmni(`${AVISO}\n\nOlá! Posso ajudar?`));
    }) as typeof fetch;
    try {
      const opcoes = opcoesDoOmniRouter("chave-sintetica", `${OMNI}/v1`);
      const modelo = createOpenAI(opcoes).chat("claude-haiku-5-5");
      const { text } = await generateText({ model: modelo, prompt: "oi", maxRetries: 0 });
      expect(alvo).toBe(`${OMNI}/v1/chat/completions`);
      expect(text).toBe("Olá! Posso ajudar?");
    } finally {
      globalThis.fetch = original;
    }
  });
});
