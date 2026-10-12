import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  bindings: [] as Array<Record<string, unknown>>,
  credentials: [] as Array<Record<string, unknown>>,
  organizations: [] as Array<Record<string, unknown>>,
  versions: [] as Array<Record<string, unknown>>,
  /** Tabelas cuja leitura devolve `error` — o supabase-js não lança. */
  falhas: new Set<string>(),
  env: {
    AI_GATEWAY_API_KEY: "",
    AI_GATEWAY_BASE_URL: "",
    OPENAI_API_KEY: "",
    OPENROUTER_API_KEY: "",
    OPENROUTER_BASE_URL: "",
  },
}));

vi.mock("@/lib/env", () => ({ env: state.env }));
vi.mock("@/lib/ai/gateway", () => ({ OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1" }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));
// A chamada de rede do AI SDK é a única parte dublada do caminho da pergunta:
// resolvedor, `embedText` e `buscarConhecimento` rodam de verdade no cenário
// da família gravada, lá embaixo.
vi.mock("ai", () => ({
  embed: async () => ({ embedding: Array.from({ length: 1536 }, () => 0.01), usage: { tokens: 1 } }),
}));
vi.mock("@/lib/crypto/aes_gcm", () => ({
  byteaToBuffer: (v: unknown) => v,
  decryptKey: ({ ciphertext }: { ciphertext: unknown }) => ciphertext,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const rows =
        {
          ai_purpose_bindings: state.bindings,
          organizations: state.organizations,
          ai_knowledge_versions: state.versions,
        }[table] ?? state.credentials;
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      const achadas = () => rows.filter((row) => filters.every((f) => f(row)));
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          filters.push((row: Record<string, unknown>) => row[column] === value);
          return query;
        },
        not: (column: string, _operator: string, value: unknown) => {
          filters.push((row: Record<string, unknown>) => row[column] !== value);
          return query;
        },
        order: () => query,
        limit: () => query,
        then: (ok: (v: { data: unknown; error: unknown }) => void) =>
          ok(state.falhas.has(table) ? { data: null, error: { message: "falha" } } : { data: achadas(), error: null }),
        maybeSingle: async () =>
          state.falhas.has(table)
            ? { data: null, error: { message: "connection reset" } }
            : { data: achadas()[0] ?? null, error: null },
      };
      return query;
    },
  }),
}));

import { embedText } from "@/lib/ai/embed";
import {
  FamiliaDaBaseIlegivelError,
  ehBuscaPorTexto,
  limiarDoModelo,
  modeloDeEmbedding,
  resolverChaveDeEmbedding,
  temChaveDeEmbedding,
} from "@/lib/ai/embeddings/chave";
import { buscarConhecimento } from "@/lib/ai/knowledge/busca";

function credential(overrides: Record<string, unknown>) {
  return {
    id: "cred-1",
    organization_id: "org-1",
    provider: "openrouter",
    label: "Chave de conhecimento",
    api_key_encrypted: "chave-ficticia-openrouter",
    api_key_iv: "iv",
    api_key_tag: "tag",
    is_active: true,
    validated_at: "2026-09-28T00:00:00Z",
    created_at: "2026-09-28T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  state.bindings = [];
  state.credentials = [];
  state.organizations = [];
  state.versions = [];
  state.falhas = new Set();
  state.env.AI_GATEWAY_API_KEY = "";
  state.env.OPENAI_API_KEY = "";
  state.env.OPENROUTER_API_KEY = "";
});

describe("resolverChaveDeEmbedding", () => {
  it("credencial OpenRouter validada serve à indexação e à consulta da própria organização", async () => {
    state.credentials = [
      credential({ organization_id: "outra-org", api_key_encrypted: "chave-alheia" }),
      credential({}),
    ];

    const indexar = await resolverChaveDeEmbedding("org-1", "embedding_indexar");
    const consultar = await resolverChaveDeEmbedding("org-1", "embedding_consultar");

    for (const chave of [indexar, consultar]) {
      expect(chave).toMatchObject({
        apiKey: "chave-ficticia-openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        provedor: "openrouter",
        origem: "credencial_da_organizacao",
      });
    }
    expect(await resolverChaveDeEmbedding("outra-org")).toMatchObject({ apiKey: "chave-alheia" });
  });

  it("preserva a precedência da credencial OpenAI existente", async () => {
    state.credentials = [
      credential({}),
      credential({ id: "cred-openai", provider: "openai", api_key_encrypted: "chave-ficticia-openai" }),
    ];

    expect(await resolverChaveDeEmbedding("org-1")).toMatchObject({
      apiKey: "chave-ficticia-openai",
      baseUrl: null,
      provedor: "openai",
    });
  });

  it("não usa credencial OpenRouter inativa ou ainda não validada", async () => {
    state.credentials = [
      credential({ is_active: false }),
      credential({ id: "cred-2", validated_at: null }),
    ];

    // Sem NENHUMA chave utilizável e sem família gravada, a base não fica parada: a busca por
    // palavras (migration 0647) atende, sem chave e sem custo.
    expect(await resolverChaveDeEmbedding("org-1")).toMatchObject({
      apiKey: null,
      baseUrl: null,
      provedor: "texto",
      origem: "busca_por_palavras",
    });
  });

  it("aceita a chave OpenRouter da instalação quando não há credencial da organização", async () => {
    state.env.OPENROUTER_API_KEY = "chave-ficticia-instalacao";

    expect(await resolverChaveDeEmbedding("org-1")).toMatchObject({
      apiKey: "chave-ficticia-instalacao",
      baseUrl: "https://openrouter.ai/api/v1",
      provedor: "openrouter",
      origem: "chave_da_instalacao",
    });
  });

  // A chave OpenRouter da organização costuma estar ali para a CONVERSA. Se ela
  // passasse na frente da OpenAI ou do gateway da instalação, a atualização
  // trocaria em silêncio o fornecedor de quem já indexava.
  it("OPENAI_API_KEY da instalação vence a credencial OpenRouter da organização", async () => {
    state.env.OPENAI_API_KEY = "chave-ficticia-env-openai";
    state.credentials = [credential({})];

    expect(await resolverChaveDeEmbedding("org-1")).toMatchObject({
      apiKey: "chave-ficticia-env-openai",
      provedor: "openai",
      origem: "chave_da_instalacao",
    });
  });

  it("o gateway da instalação vence a credencial OpenRouter da organização", async () => {
    state.env.AI_GATEWAY_API_KEY = "gateway-ficticio";
    state.credentials = [credential({})];

    expect(await resolverChaveDeEmbedding("org-1")).toMatchObject({
      provedor: "gateway",
      origem: "gateway_da_instalacao",
    });
  });

  it("a credencial OpenRouter da organização vence a OPENROUTER_API_KEY da instalação", async () => {
    state.env.OPENROUTER_API_KEY = "chave-ficticia-instalacao";
    state.credentials = [credential({})];

    expect(await resolverChaveDeEmbedding("org-1")).toMatchObject({
      apiKey: "chave-ficticia-openrouter",
      origem: "credencial_da_organizacao",
    });
  });

  it("binding explícito de OpenRouter usa a própria credencial e o modelo permanece fixo", async () => {
    state.bindings = [
      {
        organization_id: "org-1",
        purpose: "embedding_indexar",
        is_enabled: true,
        credential_id: "cred-1",
        model_id: "openai/text-embedding-3-small",
        base_url: null,
      },
    ];
    state.credentials = [credential({})];

    expect(await resolverChaveDeEmbedding("org-1")).toMatchObject({
      provedor: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      origem: "binding_do_ponto",
    });
  });

  // #1130 (@vgamkt): cada empresa escolhe OpenAI ou Google para a base.
  it("binding explícito para uma credencial do Google: provedor google, sem base_url", async () => {
    state.bindings = [
      {
        organization_id: "org-1",
        purpose: "embedding_consultar",
        is_enabled: true,
        credential_id: "cred-google",
        model_id: "google/gemini-embedding-001",
        base_url: null,
      },
    ];
    state.env.OPENAI_API_KEY = "chave-ficticia-env-openai";
    state.credentials = [
      credential({ id: "cred-google", provider: "google", api_key_encrypted: "chave-ficticia-google" }),
    ];

    const chave = await resolverChaveDeEmbedding("org-1", "embedding_consultar");
    expect(chave).toMatchObject({
      apiKey: "chave-ficticia-google",
      provedor: "google",
      baseUrl: null,
      origem: "binding_do_ponto",
      avisos: [],
    });
    expect(modeloDeEmbedding(chave!.provedor)).toBe("google/gemini-embedding-001");
    // Perguntar por OUTRA família ignora o binding do Google: é o que a tela
    // pergunta antes de oferecer "Trocar para a OpenAI".
    expect(
      await resolverChaveDeEmbedding("org-1", "embedding_consultar", { familia: "openai" }),
    ).toMatchObject({ provedor: "openai", origem: "chave_da_instalacao" });
  });

  it("credencial do Google sem escolha só vale quando não há NENHUMA via OpenAI", async () => {
    state.credentials = [
      credential({ id: "cred-google", provider: "google", api_key_encrypted: "chave-ficticia-google" }),
    ];
    expect(await resolverChaveDeEmbedding("org-1")).toMatchObject({
      provedor: "google",
      origem: "credencial_da_organizacao",
    });

    // Quem já indexava pela OpenRouter não troca de fornecedor numa atualização.
    state.credentials.push(credential({}));
    expect(await resolverChaveDeEmbedding("org-1")).toMatchObject({ provedor: "openrouter" });
  });
});

/**
 * A família do modelo da base é uma ESCOLHA, não a credencial que aparece
 * primeiro na escada (revisão do #1864).
 *
 * O defeito: uma organização só com a chave do Google indexava com
 * `gemini-embedding-001` pelo degrau 7. Quando alguém cadastrava uma chave da
 * OpenAI — para a conversa, por exemplo —, o degrau 2 passava a valer, a
 * PERGUNTA saía com `text-embedding-3-small`, `fn_buscar_trechos_das_fontes`
 * filtrava pelo modelo e a busca devolvia ZERO trechos, sem erro e sem nada na
 * fila. O cenário abaixo é exatamente esse, do resolvedor até a RPC.
 */
describe("a família da base não muda porque uma credencial apareceu ou sumiu", () => {
  const google = () =>
    credential({ id: "cred-google", provider: "google", api_key_encrypted: "chave-ficticia-google" });
  const openai = () =>
    credential({
      id: "cred-openai",
      provider: "openai",
      api_key_encrypted: "chave-ficticia-openai",
      created_at: "2026-09-28T10:00:00Z",
    });

  /** O que o indexador deixa gravado ao ativar a versão de uma fonte. */
  function indexou(modelo: string) {
    state.versions = [
      {
        organization_id: "org-1",
        is_active: true,
        embedding_model: modelo,
        activated_at: "2026-09-28T09:00:00Z",
      },
    ];
  }

  /** `fn_buscar_trechos_das_fontes` recusa trecho de versão calculada com outro modelo. */
  function bancoComUmTrecho(modeloDoTrecho: string) {
    return {
      rpc: async (_fn: string, args: { p_embedding_model: string }) => ({
        data:
          args.p_embedding_model === modeloDoTrecho
            ? [
                {
                  chunk_id: "chunk-1",
                  knowledge_source_id: "fonte-1",
                  source_name: "Tabela de preços",
                  content: "A consulta custa R$ 200.",
                  similarity: 0.9,
                },
              ]
            : [],
        error: null,
      }),
    };
  }

  it("indexou com o Google, cadastrou a OpenAI depois: a busca continua achando o material", async () => {
    state.credentials = [google()];
    const chaveDaIndexacao = await resolverChaveDeEmbedding("org-1", "embedding_indexar");
    expect(chaveDaIndexacao).toMatchObject({ provedor: "google" });
    const modeloDoIndice = modeloDeEmbedding(chaveDaIndexacao!.provedor);
    indexou(modeloDoIndice);

    state.credentials.push(openai());

    const resultado = await buscarConhecimento(bancoComUmTrecho(modeloDoIndice) as never, {
      organizationId: "org-1",
      knowledgeSourceIds: ["fonte-1"],
      pergunta: "quanto custa a consulta?",
      topK: 5,
      limiar: 0.4,
    });
    expect(resultado.trechos.map((t) => t.chunk_id)).toEqual(["chunk-1"]);
    // E a próxima indexação também segue no Google: senão o pulo incremental
    // falharia e a base inteira seria refeita com a outra família, calada.
    expect(await resolverChaveDeEmbedding("org-1", "embedding_indexar")).toMatchObject({
      provedor: "google",
    });
  });

  it("a escolha gravada vence o índice e a escada", async () => {
    state.credentials = [google(), openai()];
    indexou(modeloDeEmbedding("openai"));
    state.organizations = [{ id: "org-1", settings: { base_de_conhecimento: { familia: "google" } } }];

    for (const ponto of ["embedding_indexar", "embedding_consultar"] as const) {
      expect(await resolverChaveDeEmbedding("org-1", ponto)).toMatchObject({ provedor: "google" });
    }
    const { model } = await embedText("oi", { organizationId: "org-1", ponto: "embedding_consultar" });
    expect(model).toBe("google/gemini-embedding-001");
  });

  it("a chave da família sumiu: não há chave — nunca a outra família em silêncio", async () => {
    state.credentials = [openai()];
    state.env.OPENAI_API_KEY = "chave-ficticia-env-openai";
    state.organizations = [{ id: "org-1", settings: { base_de_conhecimento: { familia: "google" } } }];

    expect(await resolverChaveDeEmbedding("org-1", "embedding_consultar")).toBeNull();
    // A mesma organização, perguntando pela família OpenAI, tem chave: é o que
    // a tela usa para oferecer a troca explícita.
    expect(
      await resolverChaveDeEmbedding("org-1", "embedding_indexar", { familia: "openai" }),
    ).toMatchObject({ provedor: "openai" });
  });

  it("indexou com a OpenAI e a chave OpenAI foi removida: o Google cadastrado não assume", async () => {
    state.credentials = [google()];
    indexou(modeloDeEmbedding("openai"));

    expect(await resolverChaveDeEmbedding("org-1", "embedding_indexar")).toBeNull();
  });

  it("binding do painel para uma chave de outra família é ignorado, com aviso", async () => {
    state.credentials = [google(), openai()];
    state.bindings = [
      {
        organization_id: "org-1",
        purpose: "embedding_indexar",
        is_enabled: true,
        credential_id: "cred-google",
        model_id: "google/gemini-embedding-001",
        base_url: null,
      },
    ];
    indexou(modeloDeEmbedding("openai"));

    const chave = await resolverChaveDeEmbedding("org-1", "embedding_indexar");
    expect(chave).toMatchObject({ provedor: "openai", origem: "credencial_da_organizacao" });
    expect(chave!.avisos).toHaveLength(1);
  });

  /**
   * Leitura que falha NÃO é "sem família" (terceira revisão do #1864). Nos dois
   * casos a escada inteira devolveria a credencial OpenAI (degrau 2) — e uma
   * passada do indexador com ela ativaria uma versão da outra família.
   */
  it("a leitura de `organizations` falhou: nenhuma chave sai, nem a da outra família", async () => {
    // Escolheu o Google e a base ainda não foi indexada: só a escolha diz a família.
    state.credentials = [google(), openai()];
    state.organizations = [{ id: "org-1", settings: { base_de_conhecimento: { familia: "google" } } }];
    state.falhas.add("organizations");

    for (const ponto of ["embedding_indexar", "embedding_consultar"] as const) {
      await expect(resolverChaveDeEmbedding("org-1", ponto)).rejects.toBeInstanceOf(
        FamiliaDaBaseIlegivelError,
      );
    }
    await expect(
      embedText("oi", { organizationId: "org-1", ponto: "embedding_consultar" }),
    ).rejects.toBeInstanceOf(FamiliaDaBaseIlegivelError);
  });

  it("a leitura de `ai_knowledge_versions` falhou: nenhuma chave sai, nem a da outra família", async () => {
    state.credentials = [google(), openai()];
    indexou(modeloDeEmbedding("google"));
    state.falhas.add("ai_knowledge_versions");

    await expect(resolverChaveDeEmbedding("org-1", "embedding_indexar")).rejects.toBeInstanceOf(
      FamiliaDaBaseIlegivelError,
    );
    // Controle: com a leitura de pé, a mesma organização segue no Google.
    state.falhas.clear();
    expect(await resolverChaveDeEmbedding("org-1", "embedding_indexar")).toMatchObject({
      provedor: "google",
    });
  });

  it("a resposta informativa do cadastro não quebra quando a família não pôde ser lida", async () => {
    state.credentials = [google()];
    state.falhas.add("organizations");

    expect(await temChaveDeEmbedding("org-1")).toBe(true);
  });
});

/**
 * A terceira família (migration 0647): a base preparada por PALAVRAS, no próprio Postgres.
 * Não usa chave, não custa e não depende do crédito de nenhum provedor — é o que mantém o
 * agente consultando o material quando a organização só tem a assinatura de texto (a
 * claude-ponte), que não gera embedding.
 */
describe("a base preparada por palavras (família texto)", () => {
  const MARCADOR = "texto/postgres-fts";
  const google = () =>
    credential({ id: "cred-google", provider: "google", api_key_encrypted: "chave-ficticia-google" });
  const openai = () =>
    credential({
      id: "cred-openai",
      provider: "openai",
      api_key_encrypted: "chave-ficticia-openai",
      created_at: "2026-09-28T10:00:00Z",
    });

  function bancoQueRegistra(devolve: Array<Record<string, unknown>>) {
    const chamadas: Array<{ fn: string; args: Record<string, unknown> }> = [];
    return {
      chamadas,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        chamadas.push({ fn, args });
        return { data: devolve, error: null };
      },
    };
  }

  it("o marcador é o nome do modelo gravado na versão do índice", () => {
    expect(modeloDeEmbedding("texto")).toBe(MARCADOR);
    expect(ehBuscaPorTexto(MARCADOR)).toBe(true);
    expect(ehBuscaPorTexto("google/gemini-embedding-001")).toBe(false);
    expect(ehBuscaPorTexto("openai/text-embedding-3-small")).toBe(false);
  });

  it("a escolha gravada vence as chaves: com Google e OpenAI cadastrados, continua por palavras", async () => {
    state.credentials = [google(), openai()];
    state.env.OPENAI_API_KEY = "chave-ficticia-env-openai";
    state.organizations = [{ id: "org-1", settings: { base_de_conhecimento: { familia: "texto" } } }];

    for (const ponto of ["embedding_indexar", "embedding_consultar"] as const) {
      expect(await resolverChaveDeEmbedding("org-1", ponto)).toMatchObject({
        provedor: "texto",
        apiKey: null,
        origem: "busca_por_palavras",
      });
    }
  });

  it("indexou por palavras e depois cadastrou uma chave: a família não muda sozinha", async () => {
    state.versions = [
      {
        organization_id: "org-1",
        is_active: true,
        embedding_model: MARCADOR,
        activated_at: "2026-09-28T09:00:00Z",
      },
    ];
    state.credentials = [google(), openai()];

    expect(await resolverChaveDeEmbedding("org-1", "embedding_indexar")).toMatchObject({
      provedor: "texto",
    });
  });

  it("sem nada gravado, a chave de um provedor vem ANTES das palavras (ninguém é rebaixado)", async () => {
    state.credentials = [google()];
    expect(await resolverChaveDeEmbedding("org-1")).toMatchObject({ provedor: "google" });
  });

  it("a família gravada como openai que perdeu a chave NÃO cai nas palavras em silêncio", async () => {
    state.organizations = [{ id: "org-1", settings: { base_de_conhecimento: { familia: "openai" } } }];
    expect(await resolverChaveDeEmbedding("org-1", "embedding_consultar")).toBeNull();
    // Mas a tela pode perguntar pelas palavras: é a saída explícita que ela oferece.
    expect(
      await resolverChaveDeEmbedding("org-1", "embedding_indexar", { familia: "texto" }),
    ).toMatchObject({ provedor: "texto" });
  });

  it("indexar por palavras não chama provedor nenhum: vetor zero e o marcador, sem rede", async () => {
    state.organizations = [{ id: "org-1", settings: { base_de_conhecimento: { familia: "texto" } } }];
    const r = await embedText("quanto custa a consulta?", {
      organizationId: "org-1",
      ponto: "embedding_indexar",
    });
    expect(r.model).toBe(MARCADOR);
    expect(r.promptTokens).toBe(0);
    expect(r.embedding).toHaveLength(1536);
    expect(r.embedding.every((v) => v === 0)).toBe(true);
  });

  it("a pergunta vai como TEXTO para a função por palavras, e o limiar efetivo é o das palavras", async () => {
    state.organizations = [{ id: "org-1", settings: { base_de_conhecimento: { familia: "texto" } } }];
    const banco = bancoQueRegistra([
      {
        chunk_id: "chunk-1",
        knowledge_source_id: "fonte-1",
        source_name: "Perguntas e respostas",
        content: "A tela do ar não aparece no app.",
        // Nota de cobertura de termos: 0.3 reprovaria com o limiar 0.4 do cosseno.
        similarity: 0.3,
      },
      {
        chunk_id: "chunk-2",
        knowledge_source_id: "fonte-1",
        source_name: "Perguntas e respostas",
        content: "Outro assunto, só uma palavra em comum.",
        similarity: 0.1,
      },
    ]);

    const resultado = await buscarConhecimento(banco as never, {
      organizationId: "org-1",
      knowledgeSourceIds: ["fonte-1"],
      pergunta: "o ar condicionado liga pelo app?",
      topK: 5,
      limiar: 0.4,
    });

    expect(banco.chamadas).toHaveLength(1);
    expect(banco.chamadas[0]!.fn).toBe("fn_buscar_trechos_por_texto");
    expect(banco.chamadas[0]!.args).toMatchObject({
      p_organization_id: "org-1",
      p_source_ids: ["fonte-1"],
      p_query: "o ar condicionado liga pelo app?",
      p_embedding_model: MARCADOR,
    });
    // Nunca o vetor: a função vetorial não existe para esta família.
    expect(banco.chamadas[0]!.args).not.toHaveProperty("p_embedding");
    expect(resultado.trechos.map((t) => t.chunk_id)).toEqual(["chunk-1"]);
    // O melhor candidato aparece mesmo reprovado — a tela de diagnóstico continua útil.
    expect(resultado.melhorSimilaridade).toBeCloseTo(0.3, 5);
  });

  it("o limiar efetivo das palavras nunca SOBE acima do pedido: limiar menor que o teto vale", () => {
    expect(limiarDoModelo(MARCADOR, 0.4)).toBe(0.25);
    expect(limiarDoModelo(MARCADOR, 0.1)).toBe(0.1);
    expect(limiarDoModelo("google/gemini-embedding-001", 0.4)).toBe(0.4);
  });
});
