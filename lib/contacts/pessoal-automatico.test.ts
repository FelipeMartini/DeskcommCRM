import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  aplicarComandoPessoal,
  aplicarNascePessoal,
  type EntradaDoNascePessoal,
} from "./pessoal-automatico";
import { marcarContatoComoPessoal } from "./pessoal";

vi.mock("./pessoal", () => ({ marcarContatoComoPessoal: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CANAL = "33333333-3333-4333-8333-333333333333";
const OUTRO_CANAL = "44444444-4444-4444-8444-444444444444";

const marcar = vi.mocked(marcarContatoComoPessoal);

interface Banco {
  settings?: unknown;
  /** `null` = a organização não existe; `"erro"` = a leitura falha. */
  organizacao?: "erro" | null;
  contato?: Record<string, unknown> | null;
  mensagens?: unknown[];
  negocios?: unknown[];
}

/** Admin de mentira: cada tabela responde o que o caso pediu e conta as consultas. */
function admin(banco: Banco = {}) {
  const consultas: string[] = [];
  const respostas: Record<string, () => { data: unknown; error: unknown }> = {
    organizations: () =>
      banco.organizacao === "erro"
        ? { data: null, error: { message: "falhou" } }
        : {
            data: banco.organizacao === null ? null : { settings: banco.settings ?? {} },
            error: null,
          },
    contacts: () => ({
      data:
        banco.contato === undefined
          ? { is_personal: false, kind: "contact", ai_authorized_at: null }
          : banco.contato,
      error: null,
    }),
    messages: () => ({ data: banco.mensagens ?? [{ id: "m1" }], error: null }),
    crm_leads: () => ({ data: banco.negocios ?? [], error: null }),
  };
  const from = vi.fn((tabela: string) => {
    consultas.push(tabela);
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "limit"]) q[m] = () => q;
    q.maybeSingle = async () => respostas[tabela]!();
    q.then = (res: (v: unknown) => unknown) => Promise.resolve(respostas[tabela]!()).then(res);
    return q;
  });
  return { db: { from } as never, consultas };
}

const campanhaDoExpanda = { id: "expanda", match: { tipo: "contains", valor: "guia expanda" } };

function entrada(sobre: Partial<EntradaDoNascePessoal> = {}): EntradaDoNascePessoal {
  return {
    orgId: ORG,
    contactId: CONTATO,
    channelSessionId: CANAL,
    direcao: "inbound",
    texto: "oi, tudo bem?",
    requestId: "req-1",
    origem: "waha.ingest",
    ...sobre,
  };
}

const LIGADO = { contatos_pessoais: { novos_nascem_pessoais: true } };

beforeEach(() => {
  marcar.mockReset();
  marcar.mockResolvedValue({
    ok: true,
    contact: { id: CONTATO, display_name: null, is_personal: true },
    effects: {
      followups_cancelados: 0,
      retornos_cancelados: 0,
      campanha_saidas: 0,
      prospeccao_pulada: 0,
      conversas_fechadas: 0,
      trechos_de_rag_removidos: 0,
    },
    eraPessoal: false,
  });
});

describe("aplicarComandoPessoal — o `#pessoal` do celular", () => {
  const dados = { orgId: ORG, contactId: CONTATO, channelSessionId: CANAL, requestId: "req-1" };

  it("interruptor desligado (o padrão) → não marca: o comando é texto comum", async () => {
    const { db } = admin({ settings: {} });
    await expect(aplicarComandoPessoal(db, dados)).resolves.toBe("desligado");
    expect(marcar).not.toHaveBeenCalled();
  });

  it.each([["true"], [1], [{}], [null]])(
    "só o booleano `true` liga — %j não liga (fail-closed)",
    async (valor) => {
      const { db } = admin({ settings: { contatos_pessoais: { comando_pelo_celular: valor } } });
      await expect(aplicarComandoPessoal(db, dados)).resolves.toBe("desligado");
      expect(marcar).not.toHaveBeenCalled();
    },
  );

  it("ligado → marca com o canal como ator e a origem do comando", async () => {
    const { db } = admin({ settings: { contatos_pessoais: { comando_pelo_celular: true } } });
    await expect(aplicarComandoPessoal(db, dados)).resolves.toBe("marcado");
    expect(marcar).toHaveBeenCalledTimes(1);
    expect(marcar.mock.calls[0]![1]).toMatchObject({
      orgId: ORG,
      contactId: CONTATO,
      ator: { type: "webhook_source", id: CANAL },
      origemDaAuditoria: "comando_celular",
      requestId: "req-1",
    });
  });

  it("marcar falha → `falhou` (o comando fica visível no chat do cliente)", async () => {
    marcar.mockResolvedValue({ ok: false, erro: "interno" });
    const { db } = admin({ settings: { contatos_pessoais: { comando_pelo_celular: true } } });
    await expect(aplicarComandoPessoal(db, dados)).resolves.toBe("falhou");
  });

  it("leitura do settings falha → `falhou`, nunca lança", async () => {
    const { db } = admin({ organizacao: "erro" });
    await expect(aplicarComandoPessoal(db, dados)).resolves.toBe("falhou");
    expect(marcar).not.toHaveBeenCalled();
  });

  it("o marcar lança → `falhou`, nunca lança", async () => {
    marcar.mockRejectedValue(new Error("banco caiu"));
    const { db } = admin({ settings: { contatos_pessoais: { comando_pelo_celular: true } } });
    await expect(aplicarComandoPessoal(db, dados)).resolves.toBe("falhou");
  });
});

describe("aplicarNascePessoal — o contato que acabou de aparecer", () => {
  it("interruptor desligado (o padrão) → não marca e só lê a organização", async () => {
    const { db, consultas } = admin({ settings: {} });
    await expect(aplicarNascePessoal(db, entrada())).resolves.toBe("desligado");
    expect(marcar).not.toHaveBeenCalled();
    expect(consultas).toEqual(["organizations"]);
  });

  it("ligado + contato novo + mensagem comum → nasce pessoal, com o canal como ator", async () => {
    const { db } = admin({ settings: LIGADO });
    await expect(aplicarNascePessoal(db, entrada())).resolves.toBe("marcado");
    expect(marcar.mock.calls[0]![1]).toMatchObject({
      orgId: ORG,
      contactId: CONTATO,
      ator: { type: "webhook_source", id: CANAL },
      origem: "waha.ingest.nasce_pessoal",
      origemDaAuditoria: "novo_contato_pessoal",
    });
  });

  it("a primeira mensagem casa uma campanha → nasce NORMAL (a exceção que inverte o padrão)", async () => {
    const { db } = admin({ settings: { ...LIGADO, campanhas_whatsapp: [campanhaDoExpanda] } });
    await expect(
      aplicarNascePessoal(db, entrada({ texto: "Quero o GUIA Expanda, por favor" })),
    ).resolves.toBe("campanha");
    expect(marcar).not.toHaveBeenCalled();
  });

  it("a campanha vale para a decisão de nascer mesmo com o canal aberto (não depende do ai_gate)", async () => {
    // O gate decide se a IA RESPONDE; aqui a pergunta é só se o contato é da operação.
    const { db, consultas } = admin({
      settings: { ...LIGADO, campanhas_whatsapp: [campanhaDoExpanda] },
    });
    await aplicarNascePessoal(db, entrada({ texto: "guia expanda" }));
    expect(consultas).not.toContain("channel_sessions");
  });

  it("campanha presa a OUTRO canal não livra o contato", async () => {
    const presa = { ...campanhaDoExpanda, channel_session_id: OUTRO_CANAL };
    const { db } = admin({ settings: { ...LIGADO, campanhas_whatsapp: [presa] } });
    await expect(aplicarNascePessoal(db, entrada({ texto: "guia expanda" }))).resolves.toBe(
      "marcado",
    );
  });

  it("a fala do OPERADOR nunca é palavra de campanha → o contato que ele procurou nasce pessoal", async () => {
    const { db } = admin({ settings: { ...LIGADO, campanhas_whatsapp: [campanhaDoExpanda] } });
    await expect(
      aplicarNascePessoal(db, entrada({ direcao: "outbound", texto: "guia expanda" })),
    ).resolves.toBe("marcado");
  });

  it.each([
    ["já era pessoal", { contato: { is_personal: true, kind: "contact", ai_authorized_at: null } }],
    [
      "a IA já foi autorizada a atendê-lo",
      {
        contato: { is_personal: false, kind: "contact", ai_authorized_at: "2026-10-01T00:00:00Z" },
      },
    ],
    ["o contato não existe mais", { contato: null }],
    ["já tem mensagem anterior", { mensagens: [{ id: "m0" }, { id: "m1" }] }],
    ["já tem negócio no funil", { negocios: [{ id: "n1" }] }],
  ] satisfies Array<[string, Banco]>)("NÃO é novo — %s", async (_nome, banco) => {
    const { db } = admin({ settings: LIGADO, ...banco });
    await expect(aplicarNascePessoal(db, entrada())).resolves.toBe("nao_e_novo");
    expect(marcar).not.toHaveBeenCalled();
  });

  it("grupo fica de fora (nunca entra em funil, lista, campanha ou IA)", async () => {
    const { db } = admin({
      settings: LIGADO,
      contato: { is_personal: false, kind: "whatsapp_group", ai_authorized_at: null },
    });
    await expect(aplicarNascePessoal(db, entrada())).resolves.toBe("fora_do_escopo");
    expect(marcar).not.toHaveBeenCalled();
  });

  it.each([["instagram"], ["facebook"]])(
    "canal %s fica de fora sem nem consultar o banco (o direct é do negócio)",
    async (canal) => {
      const { db, consultas } = admin({ settings: LIGADO });
      await expect(aplicarNascePessoal(db, entrada({ canal }))).resolves.toBe("fora_do_escopo");
      expect(consultas).toEqual([]);
    },
  );

  it("`whatsapp` explícito é o mesmo que ausente", async () => {
    const { db } = admin({ settings: LIGADO });
    await expect(aplicarNascePessoal(db, entrada({ canal: "whatsapp" }))).resolves.toBe("marcado");
  });

  it("marcar falha → `falhou`: o contato segue como normal", async () => {
    marcar.mockResolvedValue({ ok: false, erro: "interno" });
    const { db } = admin({ settings: LIGADO });
    await expect(aplicarNascePessoal(db, entrada())).resolves.toBe("falhou");
  });

  it("qualquer leitura que falhe → `falhou` sem marcar e sem lançar (fail-open para o negócio)", async () => {
    const { db } = admin({ organizacao: "erro" });
    await expect(aplicarNascePessoal(db, entrada())).resolves.toBe("falhou");
    expect(marcar).not.toHaveBeenCalled();
  });
});
