import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FamiliaDaBaseIlegivelError,
  familiaDaBase,
  resolverChaveDeEmbedding,
} from "@/lib/ai/embeddings/chave";
import { montarEstadoDaChave } from "@/lib/ai/embeddings/estado";

/**
 * O estado da chave da base, como a tela o recebe: quem prepara a base e para onde dá para trocar AGORA.
 * A família OmniRouter só aparece como troca quando o resolvedor, restrito a ela, devolve uma rota — ou
 * seja, quando a instalação o configurou e a organização é atendida por ele.
 */

vi.mock("@/lib/ai/embeddings/chave", async () => {
  const real = await vi.importActual<Record<string, unknown>>("@/lib/ai/embeddings/chave");
  return { ...real, familiaDaBase: vi.fn(), resolverChaveDeEmbedding: vi.fn() };
});

type Familia = "openai" | "google" | "omnirouter" | "texto";

/** Quais famílias têm chave/rota utilizável; sem família pedida, vale a primeira (a escada). */
function chavesDisponiveis(...familias: Familia[]) {
  vi.mocked(resolverChaveDeEmbedding).mockImplementation((async (
    _org: string,
    _ponto: string,
    opcoes?: { familia?: Familia | null },
  ) => {
    const f = opcoes?.familia;
    const escolhida = f ?? familias[0];
    if (!escolhida || !familias.includes(escolhida)) return null;
    return {
      apiKey: escolhida === "texto" ? null : "chave-ficticia",
      baseUrl: null,
      provedor: escolhida,
      viaGateway: false,
      origem: escolhida === "omnirouter" ? "omnirouter_da_instalacao" : "credencial_da_organizacao",
      rotulo: null,
      avisos: [],
    };
  }) as never);
}

const supabase = {
  from: () => {
    const q = {
      select: () => q,
      eq: () => q,
      in: () => q,
      order: async () => ({ data: [], error: null }),
    };
    return q;
  },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(familiaDaBase).mockResolvedValue({ familia: "openai", origem: "indice" });
  chavesDisponiveis("openai", "google");
});

describe("montarEstadoDaChave — o OmniRouter como destino de troca", () => {
  it("só oferece o OmniRouter quando ele atende a organização", async () => {
    chavesDisponiveis("openai", "google");
    expect((await montarEstadoDaChave(supabase, "org-1")).trocas_possiveis).not.toContain(
      "omnirouter",
    );

    chavesDisponiveis("openai", "google", "omnirouter");
    const estado = await montarEstadoDaChave(supabase, "org-1");
    expect(estado.trocas_possiveis).toEqual(["google", "omnirouter", "texto"]);
  });

  it("base no OmniRouter: ele é o provedor, não é oferecido como troca, e as palavras seguem como saída", async () => {
    vi.mocked(familiaDaBase).mockResolvedValue({ familia: "omnirouter", origem: "escolha" });
    chavesDisponiveis("openai", "omnirouter");

    const estado = await montarEstadoDaChave(supabase, "org-1");
    expect(estado.provedor).toBe("omnirouter");
    expect(estado.pode_indexar).toBe(true);
    expect(estado.explicacao).toContain("OmniRouter");
    expect(estado.trocas_possiveis).toEqual(["openai", "texto"]);
    // A troca "openai ↔ google" de um clique não se aplica ao OmniRouter.
    expect(estado.pode_trocar_para).toBeNull();
  });

  it("o OmniRouter deixou de atender: a família fica sem chave e a tela vê isso, sem cair em outra", async () => {
    vi.mocked(familiaDaBase).mockResolvedValue({ familia: "omnirouter", origem: "escolha" });
    chavesDisponiveis("openai", "google");

    const estado = await montarEstadoDaChave(supabase, "org-1");
    expect(estado.pode_indexar).toBe(false);
    expect(estado.provedor).toBe("omnirouter");
    expect(estado.familia_sem_chave).toBe("omnirouter");
    expect(estado.trocas_possiveis).toEqual(["openai", "google", "texto"]);
  });

  it("família ilegível: nenhuma troca é oferecida (nem a do OmniRouter)", async () => {
    vi.mocked(familiaDaBase).mockRejectedValue(
      new FamiliaDaBaseIlegivelError("org-1", "banco fora"),
    );
    chavesDisponiveis("openai", "google", "omnirouter");

    const estado = await montarEstadoDaChave(supabase, "org-1");
    expect(estado.provedor).toBeNull();
    expect(estado.trocas_possiveis).toEqual([]);
  });
});
