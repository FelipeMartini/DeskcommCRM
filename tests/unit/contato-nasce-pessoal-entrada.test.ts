import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EntradaDeMensagem } from "@/lib/channels/pos-entrada";

/**
 * O CONTATO QUE NASCE PESSOAL, NA PÓS-ENTRADA (`contatos_pessoais.novos_nascem_pessoais`).
 *
 * Quem decide SE o contato nasce pessoal é `aplicarNascePessoal` (medido em
 * `lib/contacts/pessoal-automatico.test.ts`). O que só a pós-entrada decide é
 * ONDE na sequência isso acontece, e a ordem é a regra:
 *
 *   1. depois do opt-out — o STOP de quem nasce pessoal ainda bloqueia;
 *   2. antes da checagem de pessoal — a marca recém-gravada já é enxergada e o
 *      resto (negócio, campanha, follow-up, IA) é pulado NA MESMA mensagem.
 *
 * Sem o item 2 o contato nasceria pessoal e a primeira mensagem dele ainda
 * abriria card e acordaria a IA: a marca só valeria da segunda em diante.
 *
 * ─── SABOTAGEM (prova no CI; linha para reverter: `lib/channels/pos-entrada.ts`) ─
 * - Chamar `aplicarNascePessoal` DEPOIS de `ehContatoPessoal`: "a primeira
 *   mensagem já não gera nada" cai.
 * - Chamar ANTES de `aplicarOptOut`: "o STOP vem antes" cai.
 * - Tirar a chamada: "pergunta uma vez por mensagem" cai.
 */

const audit = vi.fn(async () => {});
const garantirLeadDaConversa = vi.fn(async () => ({ criado: true, leadId: "lead-1" }) as never);
const acelerarFollowupDoInbound = vi.fn(async () => {});
const drenarEventosDoInbound = vi.fn(async () => {});
const aplicarNascePessoal = vi.fn();

vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...(a as [])) }));
vi.mock("@/lib/leads/encerramento", () => ({
  encerraDemanda: vi.fn(async () => ({ lead: {}, jaEstava: false })),
}));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  garantirLeadDaConversa: (...a: unknown[]) => garantirLeadDaConversa(...(a as [])),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({
  acelerarFollowupDoInbound: (...a: unknown[]) => acelerarFollowupDoInbound(...(a as [])),
  drenarEventosDoInbound: (...a: unknown[]) => drenarEventosDoInbound(...(a as [])),
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehContatoDoNumeroInterno: vi.fn(async () => false),
}));
vi.mock("@/lib/contacts/pessoal-automatico", () => ({
  aplicarNascePessoal: (...a: unknown[]) => aplicarNascePessoal(...a),
}));

let contatoPessoal = false;
let atualizacoesDeContato: Array<Record<string, unknown>> = [];
let rpcChamadas: Array<{ nome: string; args: Record<string, unknown> }> = [];

interface Elo {
  eq(coluna: string, valor: unknown): Elo;
  order(coluna: string, opcoes?: unknown): Elo;
  limit(n: number): Elo;
  is(coluna: string, valor: unknown): Elo;
  not(coluna: string, op: string, valor: unknown): Elo;
  gte(coluna: string, valor: unknown): Elo;
  maybeSingle(): Promise<{ data: unknown; error: null }>;
  then(resolve: (v: { data: unknown[]; error: null }) => void): Promise<void>;
}

function elo(tabela: string): Elo {
  const q: Elo = {
    eq: () => q,
    order: () => q,
    limit: () => q,
    is: () => q,
    not: () => q,
    gte: () => q,
    async maybeSingle() {
      if (tabela === "contacts") return { data: { is_personal: contatoPessoal }, error: null };
      if (tabela === "channel_sessions") return { data: { metadata: {} }, error: null };
      return { data: null, error: null };
    },
    then(resolve) {
      return Promise.resolve({ data: [], error: null }).then(resolve);
    },
  };
  return q;
}

const admin = {
  from(tabela: string) {
    return {
      update(payload: Record<string, unknown>) {
        if (tabela === "contacts") atualizacoesDeContato.push(payload);
        return elo(tabela);
      },
      select: () => elo(tabela),
    };
  },
  async rpc(nome: string, args: Record<string, unknown>) {
    rpcChamadas.push({ nome, args });
    return { error: null };
  },
} as never;

const ENTRADA: EntradaDeMensagem = {
  organizationId: "org-1",
  contactId: "contato-1",
  conversationId: "conversa-1",
  messageId: "msg-1",
  channelSessionId: "sessao-1",
  texto: "oi, tudo bem?",
  nomeDoContato: "Cliente",
  requestId: "req-1",
  origem: "canal_de_teste",
};

async function rodar(over: Partial<EntradaDeMensagem> = {}) {
  const { aplicarEfeitosPosEntrada } = await import("@/lib/channels/pos-entrada");
  await aplicarEfeitosPosEntrada(admin, { ...ENTRADA, ...over });
}

const despachos = () =>
  rpcChamadas.filter((c) => c.args.p_event_type === "ai_agent.dispatch_requested");

beforeEach(() => {
  contatoPessoal = false;
  atualizacoesDeContato = [];
  rpcChamadas = [];
  audit.mockClear();
  garantirLeadDaConversa.mockClear();
  acelerarFollowupDoInbound.mockClear();
  drenarEventosDoInbound.mockClear();
  aplicarNascePessoal.mockReset();
  aplicarNascePessoal.mockResolvedValue("desligado");
});

describe("pós-entrada · o contato que nasce pessoal", () => {
  it("pergunta UMA vez por mensagem, com a entrada do canal e a direção `inbound`", async () => {
    await rodar({ canal: "whatsapp" });

    expect(aplicarNascePessoal).toHaveBeenCalledTimes(1);
    expect(aplicarNascePessoal.mock.calls[0]![1]).toEqual({
      orgId: "org-1",
      contactId: "contato-1",
      channelSessionId: "sessao-1",
      direcao: "inbound",
      texto: "oi, tudo bem?",
      canal: "whatsapp",
      requestId: "req-1",
      origem: "canal_de_teste",
    });
  });

  it("sem requestId na entrada, a pergunta leva um id próprio (nunca vazio)", async () => {
    await rodar({ requestId: undefined });
    const { requestId } = aplicarNascePessoal.mock.calls[0]![1] as { requestId: string };
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a primeira mensagem já não gera nada: a marca gravada na pergunta é enxergada logo em seguida", async () => {
    aplicarNascePessoal.mockImplementation(async () => {
      contatoPessoal = true; // o efeito real: `contacts.is_personal = true`
      return "marcado";
    });

    await rodar();

    expect(
      garantirLeadDaConversa,
      "o negócio não nasce da mensagem que fez o contato nascer pessoal",
    ).not.toHaveBeenCalled();
    expect(acelerarFollowupDoInbound).not.toHaveBeenCalled();
    expect(drenarEventosDoInbound).not.toHaveBeenCalled();
    expect(despachos(), "nenhum turno de IA é enfileirado").toHaveLength(0);
  });

  it("o STOP vem antes: quem nasce pessoal e pede para parar fica bloqueado", async () => {
    let bloqueadoQuandoPerguntou: boolean | null = null;
    aplicarNascePessoal.mockImplementation(async () => {
      bloqueadoQuandoPerguntou = atualizacoesDeContato.some((u) => u.is_blocked === true);
      contatoPessoal = true;
      return "marcado";
    });

    await rodar({ texto: "quero PARAR de receber" });

    expect(bloqueadoQuandoPerguntou, "o opt-out tem de estar gravado ANTES da pergunta").toBe(true);
    expect(atualizacoesDeContato).toContainEqual(
      expect.objectContaining({ is_blocked: true, blocked_reason: "stop_keyword" }),
    );
  });

  it.each([["desligado"], ["campanha"], ["nao_e_novo"], ["fora_do_escopo"], ["falhou"]] as const)(
    "%s → a mensagem segue gerando tudo como antes",
    async (desfecho) => {
      aplicarNascePessoal.mockResolvedValue(desfecho);

      await rodar();

      expect(garantirLeadDaConversa).toHaveBeenCalledTimes(1);
      expect(acelerarFollowupDoInbound).toHaveBeenCalledTimes(1);
      expect(drenarEventosDoInbound).toHaveBeenCalledTimes(1);
      expect(despachos()).toHaveLength(1);
    },
  );

  it("o número interno de avisos nem chega à pergunta (o corte dele vem primeiro)", async () => {
    const { ehContatoDoNumeroInterno } = await import("@/lib/escalacao/numero-interno-de-aviso");
    vi.mocked(ehContatoDoNumeroInterno).mockResolvedValueOnce(true);

    await rodar();

    expect(aplicarNascePessoal).not.toHaveBeenCalled();
  });
});
