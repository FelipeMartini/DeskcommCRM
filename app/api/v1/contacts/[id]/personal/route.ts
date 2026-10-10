import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { marcarContatoComoPessoal, negocioAbertoDoContato, registraNaTimeline } from "@/lib/contacts/pessoal";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * CONTATO PESSOAL — marcar e desmarcar (spec 21, fatia 1).
 *
 * ## Por que esta rota existe
 *
 * Quem usa o mesmo número para vender e para a vida entrega os dois mundos
 * para a mesma operação: a IA assume conversa que era de gente, o inbox
 * mistura trabalho com vida, e o funil ganha card que nunca foi oportunidade.
 * A marca `contacts.is_personal` (migration 0563) tira o contato da operação —
 * e é esta rota que a liga e desliga.
 *
 * ## Por que `manager`, e não `admin`
 *
 * Diferença medida e proposital contra o desbloqueio (`unblock/route.ts`
 * exige `admin`): desfazer descadastro reabre um canal que o cliente fechou
 * (direito do titular, LGPD). Pessoal é decisão operacional — esconder uma
 * conversa da operação — e gerente pode (spec decisão 1, D3 do plano).
 *
 * ## Por que SEM exceção para gerente no envio
 *
 * Gerente marca e desmarca, mas não envia para marcado — o veto de envio
 * (`sendMessageHandler`, fatia 2) recusa em todo papel, sem exceção.
 *
 * ## O que a rota NÃO faz
 *
 * Não apaga conversa, mensagem, negócio nem histórico: marcar esconde, tudo
 * continua no banco, e desmarcar relista (spec decisão 2). A ÚNICA remoção é a
 * dos trechos já ingeridos no RAG (#2394): ali o vetor é uma cópia operacional
 * do conteúdo, e a conversa original fica. Desmarcar NÃO reativa follow-up,
 * campanha nem prospecção (D8 — espelha o desbloqueio, que também não reativa o
 * que o bloqueio cancelou), e também não reingere o que saiu do acervo: a
 * conversa volta ao RAG quando alguém a marcar de novo como útil. Quem marcou e
 * quando fica só em auditoria + timeline, sem coluna extra no contato
 * (spec §3.6).
 *
 * ## Onde moram os efeitos do marcar
 *
 * Em `lib/contacts/pessoal.ts` (`marcarContatoComoPessoal`), porque o gesto
 * ganhou outras portas além desta rota — o comando `#pessoal` digitado no celular
 * do dono e o contato que já nasce pessoal. Os três precisam dos MESMOS oito
 * efeitos, na MESMA ordem, e duas cópias da regra divergem na primeira vez que
 * alguém mexe numa só. A ordem e o porquê de cada efeito estão no cabeçalho do
 * módulo. Aqui ficam só a autorização (`manager`), a guarda de suporte, a
 * validação do id e a tradução do resultado em resposta HTTP.
 */

export async function POST(_req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  // Só gerente e dono marcam (spec decisão 1). Atendente recebe 403 — é ele
  // quem NÃO pode esconder conversa da operação.
  const authz = await requireRole("manager", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  if (!z.uuid().safeParse(id).success) {
    return fail("validation_failed", t("Contato inválido."), 422, { requestId });
  }

  // Admin client bypassa RLS: o filtro por organização é PROGRAMÁTICO e
  // obrigatório (CLAUDE.md, anti-pattern 10) — o módulo o aplica em toda query,
  // com o `orgId` que vem do papel resolvido acima, nunca do corpo.
  const resultado = await marcarContatoComoPessoal(createAdminClient(), {
    orgId: authz.org.orgId,
    contactId: id,
    ator: { type: "user", id: authz.user.id },
    origem: "contacts/[id]/personal.POST",
    origemDaAuditoria: "tela_do_contato",
    motivoDaTimeline: "Contato marcado como pessoal pela equipe",
    requestId,
  });

  if (!resultado.ok) {
    if (resultado.erro === "nao_encontrado") {
      return fail("not_found", t("Contato não encontrado."), 404, { requestId });
    }
    return fail("internal_error", t("Não foi possível marcar o contato como pessoal."), 500, {
      requestId,
    });
  }

  return ok({ contact: resultado.contact, effects: resultado.effects }, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  if (!z.uuid().safeParse(id).success) {
    return fail("validation_failed", t("Contato inválido."), 422, { requestId });
  }

  const admin = createAdminClient();
  const { data: contato, error: leituraErro } = await admin
    .from("contacts")
    .select("id, display_name, is_personal")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (leituraErro) {
    return fail("internal_error", t("Não foi possível desmarcar o contato como pessoal."), 500, {
      requestId,
    });
  }
  if (!contato) return fail("not_found", t("Contato não encontrado."), 404, { requestId });

  // Idempotente na prova: quem já não era pessoal não gera nova auditoria.
  if ((contato as { is_personal?: boolean }).is_personal !== true) {
    return ok({ contact: contato }, { requestId });
  }

  const { data: desmarcado, error: updateErro } = await admin
    .from("contacts")
    .update({ is_personal: false })
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select("id, display_name, is_personal")
    .maybeSingle();
  if (updateErro || !desmarcado) {
    return fail("internal_error", t("Não foi possível desmarcar o contato como pessoal."), 500, {
      requestId,
    });
  }

  // NADA mais (D8): desmarcar NÃO reativa follow-up, campanha nem prospecção —
  // o que o marcar cancelou continua cancelado, e tudo volta a APARECER por
  // filtro (decisão 2 da spec). As mensagens nunca foram tocadas, então a
  // volta encontra o histórico inteiro.
  await audit({
    action: "contact.unmarked_personal",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "contact",
    resourceId: id,
    requestId,
    metadata: { contact_id: id, origem: "tela_do_contato" },
  });

  const leadId = await negocioAbertoDoContato(admin, authz.org.orgId, id);
  if (leadId) {
    await registraNaTimeline(admin, {
      orgId: authz.org.orgId,
      contactId: id,
      leadId,
      tipo: "contact_unmarked_personal",
      motivo: "Marca de pessoal retirada pela equipe",
      ator: { type: "user", id: authz.user.id },
      requestId,
      origem: "contacts/[id]/personal.DELETE",
    });
  }

  return ok({ contact: desmarcado }, { requestId });
}
