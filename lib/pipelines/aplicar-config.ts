/**
 * Gravar a configuração de um funil (vocabulário, campos, motivos de perda e de
 * ganho, reabertura) — a escrita que a tela de funis e a rota
 * `PATCH /api/v1/pipelines/[id]/config` compartilham.
 *
 * Saiu de dentro da server action `updatePipelineConfig` quando quem configura o
 * CRM por código (Bearer `dsk_…`) passou a precisar da MESMA escrita: duas
 * mesclagens paralelas do mesmo `jsonb` divergiriam no primeiro campo novo, e a
 * tela passaria a apagar o que o código gravou (ou o contrário).
 *
 * ⚠️ O client pode ser o do usuário (RLS vale) OU o admin (RLS não vale — é o
 * caso do token). Por isso a consulta e o update filtram `organization_id` à mão,
 * a organização vem de fonte confiável (sessão ou linha do token) e funil de
 * outra organização é a MESMA resposta de funil inexistente: dizer "existe, mas
 * não é seu" já vaza a existência.
 *
 * A mesclagem é a de sempre: `vocabulary` mescla chave a chave sobre o que já
 * existe; as chaves de `settings` presentes no patch SUBSTITUEM a anterior
 * (lista inteira), e as ausentes ficam como estão.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  mensagemDasRegrasQuePerdemOCampo,
  regrasDeDataQuePerdemOCampo,
} from "@/lib/automation/campo-do-gatilho-de-data";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { PipelineConfigPatch } from "@/lib/schemas/settings";

export type ResultadoDaConfig = { ok: true } | { ok: false; error: string };

/** O que o audit grava: contagens e marcas, nunca o conteúdo dos rótulos. */
export function resumoDaConfig(patch: PipelineConfigPatch): Record<string, unknown> {
  return {
    vocabulary_changed: !!patch.vocabulary,
    fields_count: patch.fields?.length ?? null,
    lost_reasons_count: patch.lost_reasons?.length ?? null,
    won_reasons_count: patch.won_reasons?.length ?? null,
    won_reason_required: patch.won_reason_required ?? null,
    reabertura: patch.reabertura ?? null,
    entrada_do_inbox_ativa: patch.entrada_do_inbox?.ativa ?? null,
    // #2995: quantos cards o quadro deixa de mostrar é decisão de quem opera — a auditoria
    // registra o número (ou `0`, o desligamento).
    ocultar_encerrados_dias: patch.ocultar_encerrados_dias ?? null,
    // #3487: quantos atalhos o funil passa a oferecer. O CONTEÚDO não entra na auditoria de
    // propósito — o link montado carrega dado do cliente, e a auditoria é lida por quem administra,
    // não necessariamente por quem vê o contato.
    atalhos_count: patch.atalhos?.length ?? null,
  };
}

/** Mescla o patch sobre o vocabulário e as settings que o funil já tem. */
export function mesclarConfig(
  vocabularioAtual: Record<string, unknown> | null,
  settingsAtuais: Record<string, unknown> | null,
  patch: PipelineConfigPatch,
): { vocabulary: Record<string, unknown>; settings: Record<string, unknown> } {
  const vocabulary = patch.vocabulary
    ? { ...(vocabularioAtual ?? {}), ...patch.vocabulary }
    : (vocabularioAtual ?? {});

  const settings: Record<string, unknown> = { ...(settingsAtuais ?? {}) };
  if (patch.fields !== undefined) settings.fields = patch.fields;
  if (patch.lost_reasons !== undefined) settings.lost_reasons = patch.lost_reasons;
  if (patch.won_reasons !== undefined) settings.won_reasons = patch.won_reasons;
  if (patch.won_reason_required !== undefined) {
    settings.won_reason_required = patch.won_reason_required;
  }
  if (patch.comanda_no_ganho !== undefined) settings.comanda_no_ganho = patch.comanda_no_ganho;
  if (patch.reabertura !== undefined) settings.reabertura = patch.reabertura;
  if (patch.reabertura_campos !== undefined) settings.reabertura_campos = patch.reabertura_campos;
  // A entrada do Inbox (issue #3011): a ETAPA em que a conversa nova vira card neste funil. Grava o
  // bloco inteiro, e não campo a campo, porque `ativa` e `stage_id` são uma decisão só — desligar
  // sem perder a etapa escolhida é o que a tela precisa poder fazer.
  if (patch.entrada_do_inbox !== undefined) settings.entrada_do_inbox = patch.entrada_do_inbox;
  // #2995 — o recorte de encerrados antigos do quadro. `0` é um valor com significado
  // ("desliguei") e por isso a chave é gravada como veio: pular o zero deixaria o número antigo no
  // banco e o quadro seguiria escondendo card de quem acabou de desligar a opção.
  if (patch.ocultar_encerrados_dias !== undefined) {
    settings.ocultar_encerrados_dias = patch.ocultar_encerrados_dias;
  }
  // OS ATALHOS DO CARD (#3487). A chave é gravada como veio, inclusive a lista VAZIA: `[]` é o
  // "apaguei todos" que a tela precisa poder dizer, e pular o vazio deixaria os atalhos antigos no
  // banco — a pessoa removeria o botão, salvaria, e ele continuaria no card. Quem já barrou o
  // `javascript:` foi o schema; aqui não há segunda régua a divergir.
  if (patch.atalhos !== undefined) settings.atalhos = patch.atalhos;

  return { vocabulary, settings };
}

/**
 * `idioma` é o de quem salva: a recusa do gatilho por data (abaixo) é lida por uma pessoa.
 * Quem chama sem idioma (nenhum hoje) recebe o texto em português.
 */
export async function aplicarConfigDoFunil(
  supabase: SupabaseClient,
  orgId: string,
  pipelineId: string,
  patch: PipelineConfigPatch,
  opcoes: { idioma?: Idioma } = {},
): Promise<ResultadoDaConfig> {
  const { data: row, error: readErr } = await supabase
    .from("crm_pipelines")
    .select("vocabulary, settings")
    .eq("id", pipelineId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!row) return { ok: false, error: "not_found" };

  const proxima = mesclarConfig(
    (row.vocabulary as Record<string, unknown> | null) ?? null,
    (row.settings as Record<string, unknown> | null) ?? null,
    patch,
  );

  // Campo que passa a ser do Contato e que uma regra ativa do gatilho por data lê (#2791): a regra
  // seguiria ligada e pararia de disparar em silêncio. Vale nas duas portas (tela e rota).
  if (patch.fields !== undefined) {
    const perdem = await regrasDeDataQuePerdemOCampo(
      supabase,
      orgId,
      pipelineId,
      (row.settings as Record<string, unknown> | null) ?? {},
      proxima.settings,
    );
    if ("erro" in perdem) return { ok: false, error: perdem.erro };
    if (perdem.nomes.length > 0) {
      return {
        ok: false,
        error: mensagemDasRegrasQuePerdemOCampo(perdem.nomes, opcoes.idioma ?? "pt-BR"),
      };
    }
  }

  const { error } = await supabase
    .from("crm_pipelines")
    .update({ vocabulary: proxima.vocabulary, settings: proxima.settings })
    .eq("id", pipelineId)
    .eq("organization_id", orgId);
  if (error) return { ok: false, error: error.message };

  return { ok: true };
}
