/**
 * CONTATO PESSOAL SEM ABRIR O CRM — o comando `#pessoal` e o contato que já nasce
 * pessoal.
 *
 * Os dois gestos têm a mesma consequência do clique na tela: os oito efeitos de
 * `marcarContatoComoPessoal` (`lib/contacts/pessoal.ts`). Este arquivo só decide
 * QUANDO aplicar; o que acontece com o contato é de lá. Os interruptores que
 * autorizam cada gesto estão em `lib/contacts/configuracao-pessoal.ts` e nascem
 * desligados.
 *
 * ## Quem é o ator
 *
 * Nenhum dos dois gestos tem usuário do CRM por trás: o `#pessoal` é digitado no
 * aparelho do dono (a mensagem chega assinada pelo webhook do canal) e o
 * "nasce pessoal" é regra. O ator é, nos dois casos,
 * `{ type: "webhook_source", id: <sessão do canal> }` — o mesmo que o `#on` do
 * celular usa —, e a auditoria carrega `origem` para dizer qual dos gestos foi.
 *
 * ## Nunca lança
 *
 * Os dois são chamados dentro da ingestão de uma mensagem que JÁ está gravada.
 * Uma exceção aqui viraria 500 para o provedor e tempestade de reentregas, então
 * toda falha vira log e um desfecho `"falhou"`: o chamador segue o caminho de
 * quem não tem o recurso (a mensagem do operador pausa a IA; a do cliente passa
 * pelos efeitos normais). É o lado seguro — contato não escondido por engano.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { casarCampanha, lerCampanhas } from "@/lib/ai/elegibilidade/campanha";
import { logger } from "@/lib/logger";

import { lerConfigPessoal } from "./configuracao-pessoal";
import { marcarContatoComoPessoal } from "./pessoal";

export type DesfechoDoComandoPessoal = "marcado" | "desligado" | "falhou";

async function lerSettingsDaOrganizacao(admin: SupabaseClient, orgId: string): Promise<unknown> {
  const { data, error } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { settings?: unknown } | null)?.settings ?? null;
}

function detalheDoErro(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 160) : "desconhecido";
}

/**
 * O operador digitou `#pessoal` no chat deste contato. Marca, se a organização
 * ligou `comando_pelo_celular`.
 *
 * - `"marcado"` — os oito efeitos rodaram: o chamador esconde o comando do chat
 *   do cliente, não pausa a IA (o contato saiu da operação) e não faz nascer
 *   negócio;
 * - `"desligado"` — o recurso está desligado: `#pessoal` é texto comum e segue o
 *   caminho de qualquer outra fala do operador;
 * - `"falhou"` — a leitura ou a marcação falhou: o chamador segue como texto
 *   comum e deixa o comando VISÍVEL no chat, que é o único sinal de que o
 *   operador precisa repetir (ou marcar pela tela).
 */
export async function aplicarComandoPessoal(
  admin: SupabaseClient,
  entrada: { orgId: string; contactId: string; channelSessionId: string; requestId: string },
): Promise<DesfechoDoComandoPessoal> {
  try {
    const config = lerConfigPessoal(await lerSettingsDaOrganizacao(admin, entrada.orgId));
    if (!config.comando_pelo_celular) return "desligado";

    const resultado = await marcarContatoComoPessoal(admin, {
      orgId: entrada.orgId,
      contactId: entrada.contactId,
      ator: { type: "webhook_source", id: entrada.channelSessionId },
      origem: "waha.ingest.comando_pessoal",
      origemDaAuditoria: "comando_celular",
      motivoDaTimeline: "Contato marcado como pessoal pelo comando #pessoal digitado no celular",
      requestId: entrada.requestId,
    });
    if (!resultado.ok) {
      logger.warn("[pessoal-automatico] #pessoal não marcou o contato", {
        organization_id: entrada.orgId,
        contact_id: entrada.contactId,
        erro: resultado.erro,
      });
      return "falhou";
    }
    return "marcado";
  } catch (err) {
    logger.warn("[pessoal-automatico] #pessoal falhou — a mensagem segue como texto comum", {
      organization_id: entrada.orgId,
      contact_id: entrada.contactId,
      detail: detalheDoErro(err),
    });
    return "falhou";
  }
}

export type DesfechoDoNascePessoal =
  "marcado" | "desligado" | "campanha" | "nao_e_novo" | "fora_do_escopo" | "falhou";

export interface EntradaDoNascePessoal {
  orgId: string;
  contactId: string;
  channelSessionId: string;
  /** Quem falou primeiro: o cliente (`inbound`) ou o operador pelo celular (`outbound`). */
  direcao: "inbound" | "outbound";
  /**
   * O texto da primeira mensagem, só para casar a campanha. Só o do CLIENTE
   * vale: a fala do operador nunca é uma palavra de campanha.
   */
  texto: string | null;
  /** `conversations.channel`; ausente quer dizer WhatsApp. */
  canal?: string;
  requestId: string;
  /** Rótulo para auditoria e log (de onde a mensagem entrou). */
  origem: string;
}

/**
 * O contato acabou de aparecer: nasce pessoal, se a organização ligou
 * `novos_nascem_pessoais` e a primeira mensagem não casa nenhuma campanha.
 *
 * ## O que é "novo"
 *
 * Contato SEM mensagem anterior, SEM negócio e que a IA nunca foi autorizada a
 * atender. A definição é de propósito estreita: o cliente importado por planilha,
 * o lead que já tem card e o contato que uma campanha já autorizou são do negócio,
 * e nenhum deles pode sumir da operação porque mandou a primeira mensagem DEPOIS
 * de o interruptor ser ligado. Quem chega aqui já com a mensagem gravada
 * (`pos-entrada`, `waha.ingest`) tem exatamente uma linha em `messages`.
 *
 * ## A exceção da campanha
 *
 * Primeira mensagem do cliente que casa uma campanha de
 * `organizations.settings.campanhas_whatsapp` → o contato nasce NORMAL. É assim
 * que a inversão do padrão fecha: tudo que chega ao número é da vida, menos o
 * que se anuncia pela palavra combinada. A campanha vale para a decisão de
 * nascer, não depende do gate do canal (`ai_gate`): o gate decide se a IA
 * responde, e aqui a pergunta é só se o contato é da operação.
 *
 * ## O que fica de fora
 *
 * Canal que não é WhatsApp (o direct do Instagram é do negócio por definição) e
 * contato que é um grupo (nunca entra em funil, lista, campanha ou IA, então a
 * marca não teria o que esconder).
 */
export async function aplicarNascePessoal(
  admin: SupabaseClient,
  entrada: EntradaDoNascePessoal,
): Promise<DesfechoDoNascePessoal> {
  if (entrada.canal !== undefined && entrada.canal !== "whatsapp") return "fora_do_escopo";

  try {
    const settings = await lerSettingsDaOrganizacao(admin, entrada.orgId);
    if (!lerConfigPessoal(settings).novos_nascem_pessoais) return "desligado";

    const { data: contato, error: contatoErro } = await admin
      .from("contacts")
      .select("is_personal, kind, ai_authorized_at")
      .eq("organization_id", entrada.orgId)
      .eq("id", entrada.contactId)
      .maybeSingle();
    if (contatoErro) throw new Error(contatoErro.message);
    const linha = contato as {
      is_personal?: boolean;
      kind?: string;
      ai_authorized_at?: string | null;
    } | null;
    if (!linha) return "nao_e_novo";
    if (linha.kind === "whatsapp_group") return "fora_do_escopo";
    if (linha.is_personal === true || linha.ai_authorized_at != null) return "nao_e_novo";

    const { data: mensagens, error: mensagensErro } = await admin
      .from("messages")
      .select("id")
      .eq("organization_id", entrada.orgId)
      .eq("contact_id", entrada.contactId)
      .limit(2);
    if (mensagensErro) throw new Error(mensagensErro.message);
    if ((mensagens ?? []).length > 1) return "nao_e_novo";

    const { data: negocios, error: negociosErro } = await admin
      .from("crm_leads")
      .select("id")
      .eq("organization_id", entrada.orgId)
      .eq("contact_id", entrada.contactId)
      .limit(1);
    if (negociosErro) throw new Error(negociosErro.message);
    if ((negocios ?? []).length > 0) return "nao_e_novo";

    if (entrada.direcao === "inbound") {
      const campanha = casarCampanha(
        entrada.texto,
        lerCampanhas(settings),
        entrada.channelSessionId,
      );
      if (campanha !== null) {
        logger.info(
          "[pessoal-automatico] contato novo NÃO nasce pessoal: a mensagem casa uma campanha",
          {
            organization_id: entrada.orgId,
            contact_id: entrada.contactId,
            campanha: campanha.id,
          },
        );
        return "campanha";
      }
    }

    const resultado = await marcarContatoComoPessoal(admin, {
      orgId: entrada.orgId,
      contactId: entrada.contactId,
      ator: { type: "webhook_source", id: entrada.channelSessionId },
      origem: `${entrada.origem}.nasce_pessoal`,
      origemDaAuditoria: "novo_contato_pessoal",
      motivoDaTimeline: "Contato novo marcado como pessoal pela configuração da organização",
      requestId: entrada.requestId,
    });
    if (!resultado.ok) {
      logger.warn("[pessoal-automatico] contato novo não foi marcado como pessoal", {
        organization_id: entrada.orgId,
        contact_id: entrada.contactId,
        erro: resultado.erro,
      });
      return "falhou";
    }
    return "marcado";
  } catch (err) {
    // Fail-open para o NEGÓCIO: na dúvida o contato segue como contato normal.
    // Esconder cliente por engano é pior que deixar uma conversa pessoal visível
    // — o operador desfaz o segundo pelo `#pessoal` ou pela tela.
    logger.warn("[pessoal-automatico] nasce-pessoal falhou — o contato segue como normal", {
      organization_id: entrada.orgId,
      contact_id: entrada.contactId,
      detail: detalheDoErro(err),
    });
    return "falhou";
  }
}
