/**
 * O OMNIROUTER E A PRIMEIRA PUBLICAÇÃO (o onboarding).
 *
 * `publishFirstVersion` recusava com `sem_chave` quando não havia credencial da organização nem
 * `ANTHROPIC_API_KEY` no `.env` — e o OmniRouter é justamente a instalação atender sem essa variável,
 * para a organização que o administrador escolheu (ou para todas, se a oferta geral estiver ligada).
 * Aqui se prova, com um banco fingido mínimo, os dois lados:
 *
 *   - OmniRouter atendendo a organização → a versão é criada com `credential_id: null` (a chave da
 *     instalação) e publicada;
 *   - organização NÃO escolhida, que RECUSOU, ou instalação sem OmniRouter → `sem_chave`, como sempre foi.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  channels: vi.fn(),
  publish: vi.fn(),
  valorDaInstalacao: vi.fn(),
}));
vi.mock("@/lib/channels/selectable", () => ({ listSelectableChannels: mocks.channels }));
vi.mock("@/lib/ai/agents/publish", () => ({ publishAgentVersion: mocks.publish }));
vi.mock("@/lib/ai/runtime/agent", () => ({ chaveDePlataforma: vi.fn(() => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: mocks.valorDaInstalacao }));

import { publishFirstVersion } from "@/lib/ai/agents/first-publication";

const ORG = "11111111-1111-4111-8111-111111111111";
const OMNI = "http://omnirouter:20128";
const CHAVE = "chave-sintetica-do-omnirouter";

/** O que a tela de Credenciais (ou o `.env`) devolve; o que não está aqui vale "ausente". */
function instalacaoCom(valores: Record<string, string>) {
  mocks.valorDaInstalacao.mockImplementation(async (chave: string) => ({
    valor: valores[chave] ?? null,
    fonte: chave in valores ? "banco" : "ausente",
  }));
}
const OMNI_POSTO = { OMNIROUTER_BASE_URL: OMNI, OMNIROUTER_API_KEY: CHAVE };

function banco(omnirouterDaOrganizacao?: Record<string, unknown>) {
  const inseridas: Array<Record<string, unknown>> = [];
  const admin = {
    from(tabela: string) {
      let inserido: Record<string, unknown> | undefined;
      const resultado = () => {
        switch (tabela) {
          case "organizations":
            return {
              data: {
                settings: {
                  llm: { provider: "anthropic" },
                  ...(omnirouterDaOrganizacao ? { omnirouter: omnirouterDaOrganizacao } : {}),
                },
              },
              error: null,
            };
          case "ai_provider_credentials":
            return { data: null, error: null };
          case "ai_models":
            return {
              data: [
                {
                  model_id: "claude-haiku-4-5",
                  supports_tools: true,
                  is_default_for_provider: true,
                  input_price_per_million_cents: 100,
                  output_price_per_million_cents: 500,
                },
              ],
              error: null,
            };
          case "crm_pipelines":
            return { data: { id: "funil-1" }, error: null };
          case "ai_agent_versions":
            if (inserido) {
              inseridas.push(structuredClone(inserido));
              return { data: { id: "versao-1" }, error: null };
            }
            return { data: [], error: null };
          case "ai_agents":
            return { data: { published_version_id: null }, error: null };
          default:
            throw new Error(`tabela inesperada: ${tabela}`);
        }
      };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "not", "limit", "order"]) b[m] = () => b;
      b.insert = (valores: Record<string, unknown>) => {
        inserido = valores;
        return b;
      };
      b.single = async () => resultado();
      b.maybeSingle = async () => resultado();
      b.then = (resolve: (v: ReturnType<typeof resultado>) => unknown) =>
        Promise.resolve(resultado()).then(resolve);
      return b;
    },
  };
  return { admin: admin as unknown as Parameters<typeof publishFirstVersion>[0], inseridas };
}

beforeEach(() => {
  mocks.channels.mockResolvedValue([{ id: "canal-1" }]);
  mocks.publish.mockResolvedValue({ ok: true });
  instalacaoCom({});
});

afterEach(() => {
  vi.clearAllMocks();
});

const agente = { id: "agente-1", published_version_id: null };

describe("publishFirstVersion — a chave da instalação inclui o OmniRouter", () => {
  it("sem credencial da organização, sem .env e sem OmniRouter: sem_chave (como sempre foi)", async () => {
    const { admin, inseridas } = banco();
    const r = await publishFirstVersion(admin, ORG, agente, "prompt", "usuario-1");
    expect(r).toMatchObject({ published: false, reason: "sem_chave", provider: "anthropic" });
    expect(inseridas).toHaveLength(0);
  });

  it("OmniRouter configurado, mas a organização NÃO foi escolhida: continua sem_chave", async () => {
    instalacaoCom(OMNI_POSTO);
    const { admin, inseridas } = banco();
    const r = await publishFirstVersion(admin, ORG, agente, "prompt", "usuario-1");
    expect(r).toMatchObject({ published: false, reason: "sem_chave" });
    expect(inseridas).toHaveLength(0);
  });

  it("⭐ OmniRouter atendendo a organização escolhida: cria a versão com a chave da instalação e publica", async () => {
    instalacaoCom(OMNI_POSTO);
    const { admin, inseridas } = banco({ habilitado: true });
    const r = await publishFirstVersion(admin, ORG, agente, "prompt", "usuario-1");
    expect(r).toEqual({ published: true });
    expect(inseridas).toHaveLength(1);
    expect(inseridas[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      credential_id: null,
    });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it("⭐ a oferta geral da instalação atende quem não escolheu", async () => {
    instalacaoCom({ ...OMNI_POSTO, OMNIROUTER_PARA_TODAS: "true" });
    const { admin, inseridas } = banco();
    const r = await publishFirstVersion(admin, ORG, agente, "prompt", "usuario-1");
    expect(r).toEqual({ published: true });
    expect(inseridas).toHaveLength(1);
  });

  it("⭐ oferta geral ligada, mas a organização RECUSOU: sem_chave, e nada é criado", async () => {
    instalacaoCom({ ...OMNI_POSTO, OMNIROUTER_PARA_TODAS: "true" });
    const { admin, inseridas } = banco({ habilitado: false });
    const r = await publishFirstVersion(admin, ORG, agente, "prompt", "usuario-1");
    expect(r).toMatchObject({ published: false, reason: "sem_chave", provider: "anthropic" });
    expect(inseridas).toHaveLength(0);
  });

  it("OmniRouter com endereço quebrado: sem_chave, e nada é criado", async () => {
    instalacaoCom({ OMNIROUTER_BASE_URL: "nao-e-url", OMNIROUTER_API_KEY: CHAVE });
    const { admin, inseridas } = banco({ habilitado: true });
    const r = await publishFirstVersion(admin, ORG, agente, "prompt", "usuario-1");
    expect(r).toMatchObject({ published: false, reason: "sem_chave" });
    expect(inseridas).toHaveLength(0);
  });

  it("OmniRouter sem a chave: sem_chave", async () => {
    instalacaoCom({ OMNIROUTER_BASE_URL: OMNI });
    const { admin, inseridas } = banco({ habilitado: true });
    const r = await publishFirstVersion(admin, ORG, agente, "prompt", "usuario-1");
    expect(r).toMatchObject({ published: false, reason: "sem_chave" });
    expect(inseridas).toHaveLength(0);
  });
});
