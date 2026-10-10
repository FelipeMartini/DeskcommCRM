import { describe, expect, it, vi } from "vitest";

import { agenteAceitaComandoDeCelular, ehComandoPessoal, lerComandoDeControle } from "./comando-de-canal";

describe("lerComandoDeControle — reconhece #on/#off, e SÓ a mensagem inteira", () => {
  it.each([
    ["#on", "on"],
    ["#off", "off"],
    ["  #on  ", "on"],
    ["  #off  ", "off"],
    ["#ON", "on"],
    ["#OFF", "off"],
    ["#On", "on"],
    ["#oFf", "off"],
  ])("%j → %s", (entrada, esperado) => {
    expect(lerComandoDeControle(entrada)).toBe(esperado);
  });

  it.each([
    ["oi", "mensagem comum"],
    ["vou dar um #off agora", "comando no MEIO da frase"],
    ["#on das 10h", "comando com texto ao redor"],
    ["##on", "prefixo dobrado"],
    ["/on", "barra — NÃO aceita (só #)"],
    ["/off", "barra — NÃO aceita (só #)"],
    ["on", "sem prefixo"],
    ["off", "sem prefixo"],
    ["#ligar", "sinônimo não aceito"],
    ["#desligar", "sinônimo não aceito"],
    ["", "vazio"],
    ["   ", "só espaços"],
  ])("%j → null (%s)", (entrada) => {
    expect(lerComandoDeControle(entrada)).toBeNull();
  });

  it("null/undefined → null (nunca lança)", () => {
    expect(lerComandoDeControle(null)).toBeNull();
    expect(lerComandoDeControle(undefined)).toBeNull();
  });
});

describe("ehComandoPessoal — reconhece #pessoal, e SÓ a mensagem inteira", () => {
  it.each([["#pessoal"], ["  #pessoal  "], ["#PESSOAL"], ["#Pessoal"], [String.fromCharCode(10) + "#pessoal" + String.fromCharCode(10)]])(
    "%j → comando",
    (entrada) => {
    expect(ehComandoPessoal(entrada)).toBe(true);
  });

  it.each([
    ["oi", "mensagem comum"],
    ["esse contato é #pessoal", "comando no MEIO da frase"],
    ["#pessoal sim", "comando com texto ao redor"],
    ["##pessoal", "prefixo dobrado"],
    ["/pessoal", "barra — NÃO aceita (só #)"],
    ["pessoal", "sem prefixo"],
    ["#pessoais", "variação não aceita"],
    ["#particular", "sinônimo não aceito"],
    ["#on", "outro comando"],
    ["#off", "outro comando"],
    ["", "vazio"],
    ["   ", "só espaços"],
  ])("%j → não é comando (%s)", (entrada) => {
    expect(ehComandoPessoal(entrada)).toBe(false);
  });

  it("null/undefined → false (nunca lança)", () => {
    expect(ehComandoPessoal(null)).toBe(false);
    expect(ehComandoPessoal(undefined)).toBe(false);
  });

  it("`#pessoal` não é lido como #on/#off (são tipos de comando diferentes)", () => {
    expect(lerComandoDeControle("#pessoal")).toBeNull();
    expect(ehComandoPessoal("#on")).toBe(false);
  });
});

/**
 * O gate de configuração (C-076): FAIL-CLOSED, e do agente DA CONVERSA. Só
 * `true` explícito liga; erro de leitura, conversa ausente, agente não resolvido
 * ou chave ausente ⇒ `false` (o comportamento de quem nunca ligou o recurso).
 */
function admin(over: {
  config?: unknown;
  conversa?: unknown;
  error?: unknown;
  agentes?: unknown[];
} = {}) {
  const agentes = over.agentes ?? [
    { id: "ag-1", config: over.config ?? {}, kind: "mcp_agent", is_active: true, paused_at: null, published_version_id: "v1", archived_at: null },
  ];
  const tabela = (nome: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "order", "limit"]) chain[m] = () => chain;
    chain.maybeSingle = () =>
      Promise.resolve({
        data: over.conversa === undefined ? { channel_session_id: null, active_ai_agent_id: null } : over.conversa,
        error: over.error ?? null,
      });
    chain.then = (r: (v: unknown) => unknown) =>
      Promise.resolve({ data: nome === "ai_agents" ? agentes : [], error: null }).then(r);
    return chain;
  };
  return { from: vi.fn(tabela) } as never;
}

describe("agenteAceitaComandoDeCelular — liga/desliga pela UI", () => {
  const ORG = "11111111-1111-4111-8111-111111111111";
  const CONV = "22222222-2222-4222-8222-222222222222";

  it("`true` explícito → aceita", async () => {
    await expect(
      agenteAceitaComandoDeCelular(admin({ config: { aceita_comandos_celular: true } }), ORG, CONV),
    ).resolves.toBe(true);
  });

  it("`false` → não aceita", async () => {
    await expect(
      agenteAceitaComandoDeCelular(admin({ config: { aceita_comandos_celular: false } }), ORG, CONV),
    ).resolves.toBe(false);
  });

  it("chave ausente → não aceita (default fechado)", async () => {
    await expect(agenteAceitaComandoDeCelular(admin({ config: {} }), ORG, CONV)).resolves.toBe(false);
  });

  it("sem conversa → não aceita", async () => {
    await expect(
      agenteAceitaComandoDeCelular(admin({ config: { aceita_comandos_celular: true }, conversa: null }), ORG, CONV),
    ).resolves.toBe(false);
  });

  it("dois agentes sem vínculo com a conversa → ninguém decide → não aceita", async () => {
    const ligado = { kind: "mcp_agent", is_active: true, paused_at: null, archived_at: null, config: { aceita_comandos_celular: true } };
    await expect(
      agenteAceitaComandoDeCelular(
        admin({ agentes: [{ id: "a", published_version_id: "va", ...ligado }, { id: "b", published_version_id: "vb", ...ligado }] }),
        ORG,
        CONV,
      ),
    ).resolves.toBe(false);
  });

  it("erro de leitura → não aceita (fail-closed)", async () => {
    await expect(
      agenteAceitaComandoDeCelular(
        admin({ config: { aceita_comandos_celular: true }, error: { message: "boom" } }),
        ORG,
        CONV,
      ),
    ).resolves.toBe(false);
  });
});
