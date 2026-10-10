/**
 * `#pessoal` PELO CELULAR E CONTATO QUE NASCE PESSOAL — a fiação na ingestão.
 *
 * O dono digita `#pessoal` no chat do contato (o celular dele é o número do
 * bot) e o contato sai da operação. Os efeitos em si estão medidos em
 * `lib/contacts/pessoal.test.ts` e a decisão de quando aplicar em
 * `lib/contacts/pessoal-automatico.test.ts`; aqui se prova o que SÓ a ingestão
 * decide:
 *
 *   1. o cliente NUNCA dispara o comando (só a mensagem `fromMe`);
 *   2. o eco de um envio nosso NUNCA é lido como comando nem como "nasce pessoal";
 *   3. marcou → o comando é revogado do chat do cliente, o contato não ganha card
 *      e a pausa do automático não é a consequência;
 *   4. falhou ou desligado → o comando fica visível e o caminho é o de qualquer
 *      fala do operador (a pausa e o card de sempre);
 *   5. TODA mensagem — inclusive o próprio comando — continua sendo GRAVADA.
 *
 * Prova pelo `dispatchWahaEvent` real (admin client mockado), como o irmão
 * `waha-comando-on-off.test.ts`. Quem decide é `pessoal-automatico`, mockado
 * aqui para que cada desfecho seja uma escolha do caso, não um efeito colateral
 * do dublê de banco.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-teste",
  AI_GATEWAY_API_KEY: "",
  AI_GATEWAY_BASE_URL: "",
  OPENROUTER_API_KEY: "",
  OPENROUTER_BASE_URL: "",
  OPENAI_API_KEY: "",
};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => {}),
  isServiceRoleConfigured: () => false,
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/channels/health", () => ({ sincronizarSaudeDaConexao: vi.fn(async () => {}) }));
const deleteMessage = vi.fn(async () => {});
vi.mock("@/lib/waha/client", () => ({ getWahaClient: () => ({ deleteMessage }) }));
vi.mock("@/lib/contacts/pessoal-automatico", () => ({
  aplicarComandoPessoal: vi.fn(),
  aplicarNascePessoal: vi.fn(),
}));

import { audit } from "@/lib/audit";
import { aplicarComandoPessoal, aplicarNascePessoal } from "@/lib/contacts/pessoal-automatico";
import { dispatchWahaEvent } from "@/lib/waha/ingest";

const comandoPessoal = vi.mocked(aplicarComandoPessoal);
const nascePessoal = vi.mocked(aplicarNascePessoal);

const ORG = "org-1";
const SESSION = {
  id: "sess-1",
  organization_id: ORG,
  waha_session_name: "default",
  is_warmup_complete: true,
  warmup_started_at: null,
};

interface Captura {
  conversationUpdates: Array<Record<string, unknown>>;
  insertedMessages: Array<Record<string, unknown>>;
  rpcs: Array<{ fn: string; args: unknown }>;
}

function makeAdmin(cap: Captura, opts: { ecoEmVoo?: boolean } = {}) {
  const table = (name: string) => {
    let mode: "select" | "insert" | "update" = "select";
    let colunas = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: (c?: string) => {
        colunas = c ?? "";
        return chain;
      },
      insert: (linha: Record<string, unknown>) => {
        mode = "insert";
        if (name === "messages") cap.insertedMessages.push(linha);
        return chain;
      },
      update: (p: Record<string, unknown>) => {
        mode = "update";
        if (name === "conversations") cap.conversationUpdates.push(p);
        return chain;
      },
      eq: () => chain,
      neq: () => chain,
      in: () => chain,
      is: () => chain,
      gte: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => {
        if (name === "messages" && mode === "insert")
          return Promise.resolve({ data: { id: "msg-nova" }, error: null });
        if (name === "conversations" && mode === "update")
          return Promise.resolve({ data: { id: "conv-1" }, error: null });
        if (name === "conversations" && mode === "select") {
          return Promise.resolve({
            data: { bot_silenced_until: null, channel_session_id: null, active_ai_agent_id: null },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then: (r: (v: unknown) => unknown) =>
        Promise.resolve(
          // `ehEcoDeEnvioNosso` lê uma LISTA de envios nossos em voo (id, body, type).
          name === "messages" && colunas === "id, body, type" && opts.ecoEmVoo
            ? { data: [{ id: "nossa-em-voo", body: "#pessoal", type: "text" }], error: null }
            : { data: null, error: null },
        ).then(r),
    };
    return chain;
  };
  return {
    from: (n: string) => table(n),
    rpc: (fn: string, args?: unknown) => {
      cap.rpcs.push({ fn, args });
      if (fn === "fn_upsert_wa_contact") return Promise.resolve({ data: "contact-1", error: null });
      if (fn === "fn_upsert_wa_conversation")
        return Promise.resolve({ data: "conv-1", error: null });
      return Promise.resolve({ data: null, error: null });
    },
  } as never;
}

const fala = (body: string, fromMe = true) => ({
  event: "message.any",
  payload: {
    id: `${fromMe}_5511999999999@c.us_${body.replace(/\W/g, "")}${Date.now()}`,
    fromMe,
    ...(fromMe ? { to: "5511999999999@c.us" } : { from: "5511999999999@c.us" }),
    body,
    type: "text",
    timestamp: Math.floor(Date.now() / 1000),
  },
});

const nova = (): Captura => ({ conversationUpdates: [], insertedMessages: [], rpcs: [] });
const pausouIA = (cap: Captura) =>
  cap.conversationUpdates.some((u) => u.bot_silenced_until !== undefined);
const nasceuCard = (cap: Captura) => cap.rpcs.some((r) => r.fn === "fn_nascer_lead_da_conversa");

beforeEach(() => {
  vi.clearAllMocks();
  comandoPessoal.mockResolvedValue("desligado");
  nascePessoal.mockResolvedValue("desligado");
});

describe("`#pessoal` digitado no celular do dono", () => {
  it("marcou → revoga o comando do chat do cliente, não deixa nascer card e grava a mensagem", async () => {
    comandoPessoal.mockResolvedValue("marcado");
    const cap = nova();

    await dispatchWahaEvent(makeAdmin(cap), SESSION, fala("#pessoal"), "req-1");

    expect(comandoPessoal).toHaveBeenCalledTimes(1);
    expect(comandoPessoal.mock.calls[0]![1]).toEqual({
      orgId: ORG,
      contactId: "contact-1",
      channelSessionId: "sess-1",
      requestId: "req-1",
    });
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(nasceuCard(cap)).toBe(false);
    // O comando é fala do operador, e fala do operador SEMPRE é gravada.
    expect(cap.insertedMessages).toHaveLength(1);
    // Marcou: a regra de nascer pessoal nem precisa ser perguntada.
    expect(nascePessoal).not.toHaveBeenCalled();
  });

  it("a auditoria da mensagem diz qual comando valeu", async () => {
    comandoPessoal.mockResolvedValue("marcado");
    await dispatchWahaEvent(makeAdmin(nova()), SESSION, fala("#pessoal"), "req-1");

    const envio = vi
      .mocked(audit)
      .mock.calls.map((c) => c[0])
      .find((a) => a.action === "message.sent");
    expect(envio?.metadata).toMatchObject({ control_command: "pessoal", from_user_phone: true });
  });

  it.each([["desligado"], ["falhou"]] as const)(
    "%s → o comando FICA no chat (único sinal de que não valeu) e segue o caminho de qualquer fala do operador",
    async (desfecho) => {
      comandoPessoal.mockResolvedValue(desfecho);
      const cap = nova();

      await dispatchWahaEvent(makeAdmin(cap), SESSION, fala("#pessoal"), "req-1");

      expect(deleteMessage).not.toHaveBeenCalled();
      expect(pausouIA(cap)).toBe(true);
      expect(cap.insertedMessages).toHaveLength(1);
      const envio = vi
        .mocked(audit)
        .mock.calls.map((c) => c[0])
        .find((a) => a.action === "message.sent");
      expect(envio?.metadata).not.toHaveProperty("control_command");
    },
  );

  it("só a mensagem INTEIRA é comando: `esse contato é #pessoal` nem pergunta ao módulo", async () => {
    await dispatchWahaEvent(makeAdmin(nova()), SESSION, fala("esse contato é #pessoal"), "req-1");
    expect(comandoPessoal).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("o cliente NUNCA dispara comando: `#pessoal` recebido não chega ao módulo", async () => {
    await dispatchWahaEvent(makeAdmin(nova()), SESSION, fala("#pessoal", false), "req-1");
    expect(comandoPessoal).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    // A mensagem do CLIENTE passa pela pós-entrada, que pergunta se o contato
    // novo nasce pessoal — sempre como `inbound`, nunca pela porta do operador.
    for (const chamada of nascePessoal.mock.calls) expect(chamada[1].direcao).toBe("inbound");
  });

  it("o eco de um envio NOSSO com o mesmo texto não é comando, nem nasce pessoal", async () => {
    const cap = nova();
    await dispatchWahaEvent(makeAdmin(cap, { ecoEmVoo: true }), SESSION, fala("#pessoal"), "req-1");
    expect(comandoPessoal).not.toHaveBeenCalled();
    expect(nascePessoal).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(cap.insertedMessages).toHaveLength(1);
  });
});

describe("contato que o operador procurou primeiro (nasce pessoal)", () => {
  it("fala comum do operador → pergunta ao módulo como `outbound` e sem texto de campanha", async () => {
    await dispatchWahaEvent(makeAdmin(nova()), SESSION, fala("oi, tudo bem?"), "req-1");

    expect(nascePessoal).toHaveBeenCalledTimes(1);
    expect(nascePessoal.mock.calls[0]![1]).toMatchObject({
      orgId: ORG,
      contactId: "contact-1",
      channelSessionId: "sess-1",
      direcao: "outbound",
      texto: null,
    });
  });

  it("nasceu pessoal → não ganha card, e o comando não é revogado (não havia comando)", async () => {
    nascePessoal.mockResolvedValue("marcado");
    const cap = nova();

    await dispatchWahaEvent(makeAdmin(cap), SESSION, fala("oi, tudo bem?"), "req-1");

    expect(nasceuCard(cap)).toBe(false);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(cap.insertedMessages).toHaveLength(1);
  });

  it.each([["desligado"], ["nao_e_novo"], ["falhou"], ["fora_do_escopo"], ["campanha"]] as const)(
    "%s → a fala do operador segue como sempre (pausa a IA)",
    async (desfecho) => {
      nascePessoal.mockResolvedValue(desfecho);
      const cap = nova();

      await dispatchWahaEvent(makeAdmin(cap), SESSION, fala("oi, tudo bem?"), "req-1");

      expect(pausouIA(cap)).toBe(true);
    },
  );
});
