import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";

/**
 * CONTATO PESSOAL — os efeitos do MARCAR, num só lugar (spec 21, fatia 1).
 *
 * ## Por que isto saiu da rota
 *
 * Marcar um contato como pessoal começou como o clique de um gerente na tela
 * (`app/api/v1/contacts/[id]/personal/route.ts`). Depois ganhou um segundo gesto,
 * o comando `#pessoal` digitado no celular do dono (`lib/escalacao/comando-de-canal.ts`),
 * e um terceiro, o contato que já NASCE pessoal (`lib/contacts/pessoal-automatico.ts`). Os
 * três precisam dos MESMOS oito efeitos, na MESMA ordem: duas encarnações da mesma
 * regra divergem na primeira vez que alguém mexe numa só (foi assim com o silêncio
 * do atendimento manual, ver `lib/escalacao/atendimento-manual.ts`).
 *
 * ## Quem decide se pode
 *
 * Este módulo NÃO autoriza ninguém: quem chama já decidiu. A rota exige o papel
 * `manager`; o comando do celular só existe no caminho `fromMe` (a mensagem saiu do
 * aparelho do dono, assinada pelo webhook) e só vale com o interruptor da
 * organização ligado. Aqui só se executa, e a PROVA (auditoria + timeline) leva a
 * origem do gesto.
 *
 * ## Ordem dos efeitos do marcar (fixa)
 *
 * 1) `update contacts is_personal=true`; 2) cancela follow-ups (parada total, como
 * o bloqueio); 3) cancela retornos avulsos; 4) saída de campanha com status/motivo
 * próprios (nunca `opted_out`); 5) prospecção vira pulada com motivo próprio; 6)
 * fecha conversas + tira do atendente; 7) remove os trechos já ingeridos no RAG
 * (#2394); 8) auditoria + timeline. Sem negócio aberto, a timeline é pulada em
 * silêncio e a auditoria continua valendo como prova (D6).
 */

export interface EfeitosDoMarcar {
  followups_cancelados: number;
  retornos_cancelados: number;
  campanha_saidas: number;
  prospeccao_pulada: number;
  conversas_fechadas: number;
  /** Trechos já ingeridos no RAG removidos pelo marcar (#2394). */
  trechos_de_rag_removidos: number;
}

export const SEM_EFEITO: EfeitosDoMarcar = {
  followups_cancelados: 0,
  retornos_cancelados: 0,
  campanha_saidas: 0,
  prospeccao_pulada: 0,
  conversas_fechadas: 0,
  trechos_de_rag_removidos: 0,
};

/**
 * O negócio aberto do contato, para ancorar a timeline.
 *
 * `crm_lead_activities.lead_id` é NOT NULL: sem negócio aberto não há linha
 * possível — e aí não há nem tentativa (D6), só auditoria. Quando o alvo é
 * ambíguo, NÃO adivinha: o mesmo `resolveActiveLeadForContact` que o motor usa.
 */
export async function negocioAbertoDoContato(
  admin: SupabaseClient,
  orgId: string,
  contactId: string,
): Promise<string | null> {
  const { data: candidatos } = await admin
    .from("crm_leads")
    .select("id, organization_id, pipeline_id, status, last_activity_at, created_at")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId);
  const { data: padrao } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .limit(1)
    .maybeSingle();
  const rota = resolveActiveLeadForContact((candidatos ?? []) as LeadCandidate[], {
    defaultPipelineId: (padrao as { id: string } | null)?.id ?? null,
  });
  return rota.routed ? rota.leadId : null;
}

/**
 * A linha na timeline — falha BAIXO, mas falha CONTADA.
 *
 * A mutação (marcar/desmarcar) já aconteceu quando chegamos aqui: bloquear a
 * operação porque a timeline caiu deixaria o contato refém do registro. Mas a
 * perda vira `event_log` via `registraFalhaDeAtividade` — nunca silêncio.
 * Sem negócio aberto, nem tenta (D6): a auditoria é a prova.
 */
export async function registraNaTimeline(
  admin: SupabaseClient,
  entrada: {
    orgId: string;
    contactId: string;
    leadId: string;
    tipo: "contact_marked_personal" | "contact_unmarked_personal";
    motivo: string;
    ator: Actor;
    requestId: string;
    origem: string;
  },
): Promise<void> {
  const atividade = await emitLeadActivity(admin, {
    organizationId: entrada.orgId,
    leadId: entrada.leadId,
    contactId: entrada.contactId,
    type: entrada.tipo,
    sourceModule: "crm",
    sourceId: entrada.leadId,
    actor: entrada.ator,
    reason: entrada.motivo,
    payload: { origem: entrada.origem },
  });
  if (!atividade.ok) {
    await registraFalhaDeAtividade(admin, {
      organizationId: entrada.orgId,
      leadId: entrada.leadId,
      tipo: entrada.tipo,
      origem: entrada.origem,
      erro: atividade.error,
      requestId: entrada.requestId,
    });
  }
}

export interface EntradaDoMarcar {
  orgId: string;
  contactId: string;
  /**
   * Quem fez o gesto. Pessoa na tela → `{ type: "user", id }`; comando do celular
   * → `{ type: "webhook_source", id: <sessão do canal> }` (o produto agiu, a mando
   * do aparelho do dono).
   */
  ator: Actor;
  /** `contacts/[id]/personal.POST`, `comando_celular`… — vai para a auditoria e a timeline. */
  origem: string;
  /** O que a auditoria grava em `metadata.origem` (`tela_do_contato`, `comando_celular`…). */
  origemDaAuditoria: string;
  /** Frase da timeline, sem dado pessoal. */
  motivoDaTimeline: string;
  requestId: string;
}

export type ContatoDoMarcar = { id: string; display_name: string | null; is_personal: boolean };

export type ResultadoDoMarcar =
  | { ok: true; contact: ContatoDoMarcar; effects: EfeitosDoMarcar; eraPessoal: boolean }
  | { ok: false; erro: "nao_encontrado" | "interno" };

function atorUserId(ator: Actor): string | null {
  return ator.type === "user" ? ator.id : null;
}

/**
 * Marca o contato como pessoal e aplica os oito efeitos. Idempotente na PROVA, não
 * nos efeitos: quem já era pessoal não gera nova auditoria nem nova linha de
 * timeline (recontar a história a cada gesto duplicaria a prova sem fato novo) —
 * mas os efeitos SEMPRE rodam, porque são condicionais e viram no-op quando já
 * aplicados. Sem isso, uma falha no meio deixaria a prova pela metade para sempre:
 * a retentativa bateria no "já é pessoal" e nunca completaria o que faltou.
 *
 * Admin client bypassa RLS: o filtro por organização é PROGRAMÁTICO e obrigatório
 * (CLAUDE.md, anti-pattern 10) — `orgId` vem de fonte confiável do chamador.
 */
export async function marcarContatoComoPessoal(
  admin: SupabaseClient,
  entrada: EntradaDoMarcar,
): Promise<ResultadoDoMarcar> {
  const { orgId, contactId: id, requestId } = entrada;
  const userId = atorUserId(entrada.ator);

  const { data: contato, error: leituraErro } = await admin
    .from("contacts")
    .select("id, display_name, is_personal")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (leituraErro) return { ok: false, erro: "interno" };
  if (!contato) return { ok: false, erro: "nao_encontrado" };

  const eraPessoal = (contato as { is_personal?: boolean }).is_personal === true;

  let marcado = contato as ContatoDoMarcar;
  if (!eraPessoal) {
    const { data, error: updateErro } = await admin
      .from("contacts")
      .update({ is_personal: true })
      .eq("organization_id", orgId)
      .eq("id", id)
      .select("id, display_name, is_personal")
      .maybeSingle();
    if (updateErro || !data) return { ok: false, erro: "interno" };
    marcado = data as ContatoDoMarcar;
  }

  const efeitos: EfeitosDoMarcar = { ...SEM_EFEITO };
  const agora = new Date().toISOString();

  // O negócio aberto é resolvido ANTES dos efeitos: a auditoria dos retornos
  // avulsos carrega o `lead_id` (mesmo contrato da rota de cancel de promessa)
  // e a timeline o usa como âncora. Resolver não escreve nada.
  const leadId = await negocioAbertoDoContato(admin, orgId, id);

  // 2) Follow-ups: parada total, como o bloqueio — vivos + dormente + coletando
  // (os mesmos de `STATUS_ALCANCADOS_PELO_OPT_OUT`, `lib/followup/reactivity.ts`).
  // `outcome` reaproveita `opted_out` porque o CHECK da coluna é fechado
  // (`converted|replied|exhausted|opted_out|handoff`); o que distingue pessoal
  // de STOP é o `cancel_reason` próprio (`pessoal`), nunca o outcome.
  const { data: inscricoes } = await admin
    .from("followup_enrollments")
    .select("id, status, current_node_id")
    .eq("organization_id", orgId)
    .eq("contact_id", id)
    .in("status", ["active", "waiting_reply", "paused_handoff", "dormente", "coletando"]);
  for (const e of (inscricoes ?? []) as Array<{
    id: string;
    status: string;
    current_node_id: string;
  }>) {
    const { error: cancelaErro } = await admin
      .from("followup_enrollments")
      .update({
        status: "cancelled",
        outcome: "opted_out",
        cancel_reason: "pessoal",
        next_eval_at: null,
        claimed_until: null,
        completed_at: agora,
        updated_at: agora,
      })
      .eq("organization_id", orgId)
      .eq("id", e.id);
    if (cancelaErro) return { ok: false, erro: "interno" };
    await admin.from("followup_enrollment_events").insert({
      organization_id: orgId,
      enrollment_id: e.id,
      node_id: e.current_node_id,
      event_type: "cancelled_personal",
      payload: { reason: "pessoal", via: "contato_pessoal" },
    });
    await audit({
      action: "followup_enrollment.cancelled",
      actorUserId: userId,
      organizationId: orgId,
      resourceType: "followup_enrollment",
      resourceId: e.id,
      requestId,
      metadata: { previous_status: e.status, cancel_reason: "pessoal", via: "contato_pessoal" },
    });
    efeitos.followups_cancelados += 1;
  }

  // 3) Retornos avulsos (`cron_jobs`, promessas): cancela o pendente para não
  // deixar lixo que dispararia depois. Mesma trava do cancel manual
  // (`enabled = true` + `cancelled_at is null` no WHERE).
  const { data: retornos } = await admin
    .from("cron_jobs")
    .select("id")
    .eq("organization_id", orgId)
    .eq("contact_id", id)
    .eq("kind", "at")
    .eq("job_kind", "followup_turn")
    .eq("enabled", true)
    .is("cancelled_at", null);
  for (const r of (retornos ?? []) as Array<{ id: string }>) {
    const { data: marcados, error: retornoErro } = await admin
      .from("cron_jobs")
      .update({
        enabled: false,
        cancelled_at: agora,
        cancel_reason: "Contato marcado como pessoal",
        updated_at: agora,
      })
      .eq("organization_id", orgId)
      .eq("id", r.id)
      .eq("enabled", true)
      .select("id");
    if (retornoErro) return { ok: false, erro: "interno" };
    if ((marcados ?? []).length === 0) continue; // perdeu a corrida: o cron disparou entre a leitura e a escrita.
    await audit({
      action: "followup.cancelled",
      actorUserId: userId,
      organizationId: orgId,
      resourceType: "cron_job",
      resourceId: r.id,
      requestId,
      metadata: {
        actor_type: entrada.ator.type,
        via: "contato_pessoal",
        contact_id: id,
        lead_id: leadId,
      },
    });
    efeitos.retornos_cancelados += 1;
  }

  // 4) Saída de campanha com status/motivo PRÓPRIOS (D7): `personal` +
  // `contato_pessoal`, nunca `opted_out` — a taxa "pediu para parar" não mexe.
  // Marca a saída sem remover a linha, como o pedido de saída faz (mesmo
  // conjunto de status de `fecharPorOptOut`, `lib/campanhas/resposta.ts`).
  // `opted_out_at` NÃO é carimbado de propósito: aquela coluna é métrica de
  // STOP, e pessoal não é STOP.
  const { data: saidas, error: campanhaErro } = await admin
    .from("campaign_recipients")
    .update({
      status: "personal",
      eligibility_status: "excluded",
      exclusion_reason: "contato_pessoal",
    })
    .eq("organization_id", orgId)
    .eq("contact_id", id)
    .in("status", ["pending", "queued", "sent", "delivered", "read", "replied"])
    .select("id");
  if (campanhaErro) return { ok: false, erro: "interno" };
  efeitos.campanha_saidas = (saidas ?? []).length;

  // 5) Prospecção vira pulada com motivo PRÓPRIO: `skipped` por outra razão não
  // volta pela remarcação do operador (`lib/prospecting/store.ts`), então o
  // motivo importa — `contato_pessoal` nunca ressuscita pela caixa de seleção.
  const { data: pulados, error: prospeccaoErro } = await admin
    .from("prospecting_candidates")
    .update({ status: "skipped", error: "contato_pessoal", updated_at: agora })
    .eq("organization_id", orgId)
    .eq("contact_id", id)
    .in("status", ["new", "queued"])
    .select("id");
  if (prospeccaoErro) return { ok: false, erro: "interno" };
  efeitos.prospeccao_pulada = (pulados ?? []).length;

  // 6) Para cada conversa aberta: solta do atendente E fecha. A ordem é
  // `release` antes de `close` porque `fn_conversation_assign` com destino
  // nulo volta o status para `open` — fechar antes seria desfeito na linha
  // seguinte. `p_enforce_expected=false` porque quem marca não é
  // necessariamente o dono da conversa.
  const { data: abertas } = await admin
    .from("conversations")
    .select("id, status, assigned_to_user_id")
    .eq("organization_id", orgId)
    .eq("contact_id", id)
    .in("status", ["open", "pending", "claimed", "ai_handling"]);
  for (const conv of (abertas ?? []) as Array<{ id: string; assigned_to_user_id: string | null }>) {
    const { data: solta, error: soltaErro } = await admin.rpc("fn_conversation_assign", {
      p_organization_id: orgId,
      p_conversation_id: conv.id,
      p_to_user_id: null as unknown as string,
      p_reason: "release",
      p_enforce_expected: false,
    });
    if (soltaErro) return { ok: false, erro: "interno" };
    if (!solta || (solta as unknown[]).length === 0) continue; // a conversa sumiu entre a leitura e a escrita.
    const { error: fechaErro } = await admin.rpc("fn_service_status", {
      p_org: orgId,
      p_conversation: conv.id,
      p_status: "closed",
    });
    if (fechaErro) return { ok: false, erro: "interno" };
    await audit({
      action: "conversation.released",
      actorUserId: userId,
      organizationId: orgId,
      resourceType: "conversation",
      resourceId: conv.id,
      requestId,
      metadata: { via: "contato_pessoal" },
    });
    await audit({
      action: "conversation.closed",
      actorUserId: userId,
      organizationId: orgId,
      resourceType: "conversation",
      resourceId: conv.id,
      requestId,
      metadata: { via: "contato_pessoal" },
    });
    efeitos.conversas_fechadas += 1;
  }

  // 7) RAG (spec 21, etapa 9 + issue #2394): zerar `usable_for_rag` só impede
  // ingestões FUTURAS destas conversas (o lote novo também exclui pessoal na
  // leitura). Os trechos JÁ ingeridos continuam em `ai_chunks` e alcançáveis
  // pelo retriever — `retrieve_top_k_chunks` não lê `usable_for_rag`. A função
  // remove os que saíram das conversas DESTE contato e devolve a contagem; a
  // mesma forma da #1957 na LGPD. Desmarcar não reingere (D8): a conversa volta
  // ao acervo quando alguém a marcar de novo como útil para o RAG.
  const { error: ragErro } = await admin
    .from("conversations")
    .update({ usable_for_rag: false })
    .eq("organization_id", orgId)
    .eq("contact_id", id);
  if (ragErro) return { ok: false, erro: "interno" };

  const { data: trechosRemovidos, error: trechosErro } = await admin.rpc(
    "fn_contato_pessoal_remove_trechos_do_rag",
    { p_org: orgId, p_contact: id },
  );
  if (trechosErro) return { ok: false, erro: "interno" };
  efeitos.trechos_de_rag_removidos = (trechosRemovidos as number | null) ?? 0;

  if (eraPessoal) return { ok: true, contact: marcado, effects: efeitos, eraPessoal };

  // 8) Espelha o registro do desbloqueio (`unblock/route.ts`): mesmo
  // `resourceType`, mesmo `contact_id` no metadata. O telefone NÃO entra —
  // auditoria não é lugar de dado pessoal, e o `contact_id` já identifica.
  // Os contadores de efeitos entram para a prova dizer O QUE foi desarmado.
  await audit({
    action: "contact.marked_personal",
    actorUserId: userId,
    organizationId: orgId,
    resourceType: "contact",
    resourceId: id,
    requestId,
    metadata: { contact_id: id, origem: entrada.origemDaAuditoria, ...efeitos },
  });

  if (leadId) {
    await registraNaTimeline(admin, {
      orgId,
      contactId: id,
      leadId,
      tipo: "contact_marked_personal",
      motivo: entrada.motivoDaTimeline,
      ator: entrada.ator,
      requestId,
      origem: entrada.origem,
    });
  }
  // Sem negócio aberto: só auditoria (D6). A conversa some do inbox pela
  // leitura filtrada (fatia 2); o histórico continua no banco.

  return { ok: true, contact: marcado, effects: efeitos, eraPessoal };
}
