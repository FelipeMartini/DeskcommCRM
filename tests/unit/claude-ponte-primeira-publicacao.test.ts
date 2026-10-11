/**
 * A CLAUDE-PONTE E A PRIMEIRA PUBLICAÇÃO (o onboarding).
 *
 * `publishFirstVersion` recusava com `sem_chave` quando não havia credencial da organização nem
 * `ANTHROPIC_API_KEY` no `.env` — e a claude-ponte é justamente a instalação atender sem essa
 * variável. Aqui se prova, com um banco fingido mínimo, os dois lados:
 *
 *   - ponte atendendo a organização → a versão é criada com `credential_id: null` (a chave da
 *     instalação) e publicada;
 *   - ponte atendendo OUTRA organização, ou sem variáveis → `sem_chave`, como sempre foi.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ channels: vi.fn(), publish: vi.fn() }));
vi.mock("@/lib/channels/selectable", () => ({ listSelectableChannels: mocks.channels }));
vi.mock("@/lib/ai/agents/publish", () => ({ publishAgentVersion: mocks.publish }));
vi.mock("@/lib/ai/runtime/agent", () => ({ chaveDePlataforma: vi.fn(() => null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { publishFirstVersion } from "@/lib/ai/agents/first-publication";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "22222222-2222-4222-8222-222222222222";
const PONTE = "http://claude-ponte:8080";

function banco() {
  const inseridas: Array<Record<string, unknown>> = [];
  const admin = {
    from(tabela: string) {
      let inserido: Record<string, unknown> | undefined;
      const resultado = () => {
        switch (tabela) {
          case "organizations":
            return { data: { settings: { llm: { provider: "anthropic" } } }, error: null };
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
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const agente = { id: "agente-1", published_version_id: null };

describe("publishFirstVersion — a chave da instalação inclui a claude-ponte", () => {
  it("sem credencial da organização, sem .env e sem ponte: sem_chave (como sempre foi)", async () => {
    const { admin, inseridas } = banco();
    const r = await publishFirstVersion(admin, ORG, agente, "prompt", "usuario-1");
    expect(r).toMatchObject({ published: false, reason: "sem_chave", provider: "anthropic" });
    expect(inseridas).toHaveLength(0);
  });

  it("ponte atendendo OUTRA organização: continua sem_chave", async () => {
    vi.stubEnv("CLAUDE_PONTE_BASE_URL", PONTE);
    vi.stubEnv("CLAUDE_PONTE_API_KEY", "chave-sintetica-da-ponte");
    vi.stubEnv("CLAUDE_PONTE_ORGS", OUTRA_ORG);
    const { admin, inseridas } = banco();
    const r = await publishFirstVersion(admin, ORG, agente, "prompt", "usuario-1");
    expect(r).toMatchObject({ published: false, reason: "sem_chave" });
    expect(inseridas).toHaveLength(0);
  });

  it("ponte atendendo a organização: cria a versão com a chave da instalação e publica", async () => {
    vi.stubEnv("CLAUDE_PONTE_BASE_URL", PONTE);
    vi.stubEnv("CLAUDE_PONTE_API_KEY", "chave-sintetica-da-ponte");
    vi.stubEnv("CLAUDE_PONTE_ORGS", ORG);
    const { admin, inseridas } = banco();
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

  it("ponte com variável quebrada: sem_chave, e nada é criado", async () => {
    vi.stubEnv("CLAUDE_PONTE_BASE_URL", "nao-e-url");
    vi.stubEnv("CLAUDE_PONTE_API_KEY", "chave-sintetica-da-ponte");
    vi.stubEnv("CLAUDE_PONTE_ORGS", ORG);
    const { admin, inseridas } = banco();
    const r = await publishFirstVersion(admin, ORG, agente, "prompt", "usuario-1");
    expect(r).toMatchObject({ published: false, reason: "sem_chave" });
    expect(inseridas).toHaveLength(0);
  });
});
