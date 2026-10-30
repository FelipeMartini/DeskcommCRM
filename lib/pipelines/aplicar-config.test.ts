/**
 * `aplicarConfigDoFunil` / `mesclarConfig` — a escrita da configuração de UM funil que a tela
 * (`updatePipelineConfig`) e a rota `PATCH /api/v1/pipelines/[id]/config` (Bearer) compartilham.
 *
 * O que não pode regredir:
 *
 *  1. A mesclagem é a de sempre: `vocabulary` mescla chave a chave sobre o que existe; as
 *     chaves de `settings` PRESENTES no patch substituem a anterior (lista inteira) e as
 *     ausentes ficam como estão.
 *  2. A consulta e o update filtram `organization_id` à mão — o client do token é o admin, a RLS
 *     não vale. Funil de outra organização é `not_found`, igual a um inexistente.
 *  3. Erro do banco volta como `{ ok: false }` (a rota decide o status), e nada é gravado se a
 *     leitura falhou ou o funil não é da organização.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { aplicarConfigDoFunil, mesclarConfig, resumoDaConfig } from "./aplicar-config";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const FUNIL = "22222222-2222-4222-8222-222222222222";

describe("mesclarConfig", () => {
  it("vocabulary mescla chave a chave e preserva o que o patch não cita", () => {
    const r = mesclarConfig(
      { lead: "Contato", won: "Fechado" },
      {},
      { vocabulary: { lead: "Cliente" } },
    );
    expect(r.vocabulary).toEqual({ lead: "Cliente", won: "Fechado" });
  });

  it("settings: a chave do patch SUBSTITUI a lista inteira, a ausente fica como está", () => {
    const r = mesclarConfig(
      null,
      { lost_reasons: ["Preço", "Prazo"], won_reasons: ["Indicação"], extra: 1 },
      { lost_reasons: ["Sem interesse"] },
    );
    expect(r.settings).toEqual({
      lost_reasons: ["Sem interesse"],
      won_reasons: ["Indicação"],
      extra: 1,
    });
  });

  it("lista vazia no patch LIMPA a lista (vazio não é ausente)", () => {
    const r = mesclarConfig(null, { lost_reasons: ["Preço"] }, { lost_reasons: [] });
    expect(r.settings.lost_reasons).toEqual([]);
  });

  it("patch sem nada deixa vocabulário e settings como estavam; nulos viram objetos", () => {
    expect(mesclarConfig({ lead: "x" }, { a: 1 }, {})).toEqual({
      vocabulary: { lead: "x" },
      settings: { a: 1 },
    });
    expect(mesclarConfig(null, null, {})).toEqual({ vocabulary: {}, settings: {} });
  });

  it("cobre os sete campos de settings do patch", () => {
    const r = mesclarConfig(null, null, {
      fields: [],
      lost_reasons: ["a"],
      won_reasons: ["b"],
      won_reason_required: true,
      comanda_no_ganho: true,
      reabertura: "livre",
      reabertura_campos: [],
    } as never);
    expect(Object.keys(r.settings).sort()).toEqual(
      [
        "comanda_no_ganho",
        "fields",
        "lost_reasons",
        "reabertura",
        "reabertura_campos",
        "won_reason_required",
        "won_reasons",
      ].sort(),
    );
  });

  it("grava a entrada do Inbox como bloco e o recorte de encerrados, inclusive o zero", () => {
    const entrada = { ativa: true, stage_id: "11111111-1111-4111-8111-111111111111" };
    const r = mesclarConfig(null, { ocultar_encerrados_dias: 45 }, {
      entrada_do_inbox: entrada,
      ocultar_encerrados_dias: 0,
    } as never);
    expect(r.settings.entrada_do_inbox).toEqual(entrada);
    expect(r.settings.ocultar_encerrados_dias).toBe(0);
  });

  it("grava os atalhos do card como vieram, inclusive a lista vazia (#3487)", () => {
    const atalhos = [{ rotulo: "Ficha", icone: "link", url: "https://exemplo.test/{{contato.id}}" }];
    const com = mesclarConfig(null, null, { atalhos } as never);
    expect(com.settings.atalhos).toEqual(atalhos);
    // `[]` é o "apaguei todos": tem de substituir os atalhos antigos, não ser pulado.
    const vazio = mesclarConfig(null, { atalhos }, { atalhos: [] } as never);
    expect(vazio.settings.atalhos).toEqual([]);
    // Ausente no patch: o que o funil já tem fica como está.
    const ausente = mesclarConfig(null, { atalhos }, {} as never);
    expect(ausente.settings.atalhos).toEqual(atalhos);
  });
});

describe("resumoDaConfig", () => {
  it("audita só quantos atalhos o funil oferece, nunca o conteúdo do link (#3487)", () => {
    const r = resumoDaConfig({
      atalhos: [{ rotulo: "Ficha", icone: "link", url: "https://dado-do-cliente.test/{{contato.telefone}}" }],
    } as never);
    expect(r).toMatchObject({ atalhos_count: 1 });
    expect(JSON.stringify(r)).not.toContain("dado-do-cliente");
    expect(resumoDaConfig({} as never)).toMatchObject({ atalhos_count: null });
  });

  it("audita se a entrada do Inbox está ativa e o recorte de encerrados, sem a etapa", () => {
    const r = resumoDaConfig({
      entrada_do_inbox: { ativa: false, stage_id: "etapa-secreta" },
      ocultar_encerrados_dias: 0,
    } as never);
    expect(r).toMatchObject({ entrada_do_inbox_ativa: false, ocultar_encerrados_dias: 0 });
    expect(JSON.stringify(r)).not.toContain("etapa-secreta");
  });

  it("grava contagens e marcas, nunca o conteúdo dos rótulos", () => {
    const r = resumoDaConfig({
      vocabulary: { lead: "Segredo do cliente" },
      lost_reasons: ["a", "b"],
    });
    expect(r).toMatchObject({
      vocabulary_changed: true,
      lost_reasons_count: 2,
      fields_count: null,
    });
    expect(JSON.stringify(r)).not.toContain("Segredo do cliente");
  });
});

/** Dublê do client: registra leituras e escritas e devolve o que o teste mandar. */
function bancoDeFunis(opts: {
  linha?: Record<string, unknown> | null;
  erroDeLeitura?: string;
  erroDeEscrita?: string;
}) {
  const filtros: Array<[string, unknown]> = [];
  const escritas: Array<{ patch: unknown; filtros: Array<[string, unknown]> }> = [];
  const client = {
    from(tabela: string) {
      expect(tabela).toBe("crm_pipelines");
      const meus: Array<[string, unknown]> = [];
      let patch: unknown = null;
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.update = (p: unknown) => {
        patch = p;
        return b;
      };
      b.eq = (c: string, v: unknown) => {
        meus.push([c, v]);
        filtros.push([c, v]);
        return b;
      };
      b.maybeSingle = async () => ({
        data: opts.erroDeLeitura ? null : (opts.linha ?? null),
        error: opts.erroDeLeitura ? { message: opts.erroDeLeitura } : null,
      });
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        escritas.push({ patch, filtros: meus });
        return Promise.resolve({
          error: opts.erroDeEscrita ? { message: opts.erroDeEscrita } : null,
        }).then(res, rej);
      };
      return b;
    },
  };
  return { client: client as unknown as SupabaseClient, filtros, escritas };
}

describe("aplicarConfigDoFunil", () => {
  it("lê e grava filtrando funil E organização, com a mesclagem aplicada", async () => {
    const db = bancoDeFunis({
      linha: { vocabulary: { lead: "Contato" }, settings: { fields: [] } },
    });
    const r = await aplicarConfigDoFunil(db.client, ORG, FUNIL, {
      vocabulary: { won: "Instalado" },
      lost_reasons: ["Sem carro compatível"],
    });
    expect(r).toEqual({ ok: true });
    expect(db.filtros).toContainEqual(["id", FUNIL]);
    expect(db.filtros).toContainEqual(["organization_id", ORG]);
    // a escrita (update) também filtra a organização, não só a leitura
    expect(db.escritas).toHaveLength(1);
    expect(db.escritas[0]!.filtros).toEqual([
      ["id", FUNIL],
      ["organization_id", ORG],
    ]);
    expect(db.escritas[0]!.patch).toEqual({
      vocabulary: { lead: "Contato", won: "Instalado" },
      settings: { fields: [], lost_reasons: ["Sem carro compatível"] },
    });
  });

  it("funil que o filtro de organização não acha → not_found, e NADA é gravado", async () => {
    // o banco devolve vazio porque a linha é de OUTRA organização (o filtro a esconde)
    const db = bancoDeFunis({ linha: null });
    const r = await aplicarConfigDoFunil(db.client, OUTRA_ORG, FUNIL, {
      vocabulary: { lead: "x" },
    });
    expect(r).toEqual({ ok: false, error: "not_found" });
    expect(db.escritas).toEqual([]);
    expect(db.filtros).toContainEqual(["organization_id", OUTRA_ORG]);
  });

  it("erro de leitura volta com a mensagem do banco e nada é gravado", async () => {
    const db = bancoDeFunis({ erroDeLeitura: "boom na leitura" });
    const r = await aplicarConfigDoFunil(db.client, ORG, FUNIL, { vocabulary: { lead: "x" } });
    expect(r).toEqual({ ok: false, error: "boom na leitura" });
    expect(db.escritas).toEqual([]);
  });

  it("erro de escrita volta com a mensagem do banco", async () => {
    const db = bancoDeFunis({
      linha: { vocabulary: {}, settings: {} },
      erroDeEscrita: "boom ao gravar",
    });
    const r = await aplicarConfigDoFunil(db.client, ORG, FUNIL, { vocabulary: { lead: "x" } });
    expect(r).toEqual({ ok: false, error: "boom ao gravar" });
  });
});
