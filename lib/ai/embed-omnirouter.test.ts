/**
 * `embedText` pela família OMNIROUTER, de ponta a ponta até a rede.
 *
 * Aqui o `ai` NÃO é dublado: o que se mede é o pedido que sairia pela rede (URL, cabeçalho, corpo) e o
 * vetor que volta, com `fetch` global substituído. O resolvedor de chave é dublado (a resposta real
 * depende de banco e `.env.local`).
 *
 * O que se trava:
 *  * o pedido vai SÓ ao endereço do OmniRouter da instalação, com a chave dele e o modelo que o
 *    roteador conhece (`gemini/gemini-embedding-001`) — o marcador `omnirouter/…` é só o nome do mapa;
 *  * nenhum parâmetro de tamanho vai no pedido (o roteador o repassa errado: 400);
 *  * a resposta de 3072 dimensões vira 1536, normalizada; qualquer outro tamanho é recusado;
 *  * um 3xx do roteador não é seguido (a chave não vai para onde ninguém autorizou).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let chaveMock: () => unknown;
vi.mock("@/lib/ai/embeddings/chave", async () => {
  const real = await vi.importActual<Record<string, unknown>>("@/lib/ai/embeddings/chave");
  return { ...real, resolverChaveDeEmbedding: async () => chaveMock() };
});

import { embedText } from "@/lib/ai/embed";

const BASE = "https://omnirouter.example.com/v1";

interface Pedido {
  url: string;
  authorization: string | null;
  corpo: Record<string, unknown>;
  redirect: RequestRedirect | undefined;
}

let pedidos: Pedido[];
let resposta: () => Response;

function respostaDeEmbedding(tamanho: number): Response {
  const vetor = Array.from({ length: tamanho }, (_, i) => Math.sin(i + 1) + 0.25);
  return new Response(
    JSON.stringify({
      object: "list",
      model: "gemini/gemini-embedding-001",
      data: [{ object: "embedding", index: 0, embedding: vetor }],
      usage: { prompt_tokens: 9, total_tokens: 9 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  pedidos = [];
  resposta = () => respostaDeEmbedding(3072);
  chaveMock = () => ({
    apiKey: "chave-ficticia-omnirouter",
    baseUrl: BASE,
    provedor: "omnirouter",
    viaGateway: false,
    origem: "omnirouter_da_instalacao",
    rotulo: null,
    avisos: [],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      pedidos.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        corpo: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        redirect: init?.redirect,
      });
      return resposta();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("embedText pela família omnirouter", () => {
  it("pede ao OmniRouter da instalação, com a chave dele e o modelo do roteador", async () => {
    await embedText("quanto custa a consulta?", {
      organizationId: "org-1",
      ponto: "embedding_consultar",
    });

    expect(pedidos).toHaveLength(1);
    const p = pedidos[0]!;
    expect(p.url).toBe(`${BASE}/embeddings`);
    expect(p.authorization).toBe("Bearer chave-ficticia-omnirouter");
    expect(p.corpo.model).toBe("gemini/gemini-embedding-001");
    expect(JSON.stringify(p.corpo.input)).toContain("quanto custa a consulta?");
    // O roteador repassa o tamanho no lugar errado (400 do Google): o pedido não leva parâmetro nenhum.
    expect(p.corpo).not.toHaveProperty("dimensions");
    expect(JSON.stringify(p.corpo)).not.toContain("outputDimensionality");
    // E nunca segue redirect: a chave não vai para outro host.
    expect(p.redirect).toBe("manual");
  });

  it("3072 dimensões voltam como 1536 normalizadas, e o modelo gravado é o marcador próprio", async () => {
    const r = await embedText("oi", { organizationId: "org-1", ponto: "embedding_indexar" });

    expect(r.embedding).toHaveLength(1536);
    const norma = Math.sqrt(r.embedding.reduce((s, x) => s + x * x, 0));
    expect(norma).toBeCloseTo(1, 8);
    expect(r.model).toBe("omnirouter/gemini-embedding-001");
    expect(r.promptTokens).toBe(9);
  });

  it("já com 1536 dimensões: passa como veio (sem renormalizar)", async () => {
    resposta = () => respostaDeEmbedding(1536);
    const r = await embedText("oi", { organizationId: "org-1" });
    expect(r.embedding).toHaveLength(1536);
    expect(r.embedding[0]).toBeCloseTo(Math.sin(1) + 0.25, 6);
  });

  it("outro tamanho é recusado em vez de cortado às cegas", async () => {
    resposta = () => respostaDeEmbedding(768);
    await expect(embedText("oi", { organizationId: "org-1" })).rejects.toThrow(/768 dimensões/);
  });

  it("o OmniRouter respondendo redirecionamento: a chamada falha, sem seguir", async () => {
    resposta = () =>
      new Response(null, { status: 302, headers: { location: "https://outro.example.com/" } });
    await expect(embedText("oi", { organizationId: "org-1" })).rejects.toBeTruthy();
    expect(pedidos).toHaveLength(1);
  });

  it("endereço torto na chave resolvida: recusa antes de qualquer byte sair", async () => {
    chaveMock = () => ({
      apiKey: "chave-ficticia-omnirouter",
      baseUrl: "https://usuario:senha@omnirouter.example.com/v1",
      provedor: "omnirouter",
      viaGateway: false,
      origem: "omnirouter_da_instalacao",
      rotulo: null,
      avisos: [],
    });
    await expect(embedText("oi", { organizationId: "org-1" })).rejects.toBeTruthy();
    expect(pedidos).toHaveLength(0);
  });
});
