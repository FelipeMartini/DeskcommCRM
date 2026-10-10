/**
 * O EDITOR DA CAMPANHA POR PALAVRA — a gravação de `organizations.settings.campanhas_whatsapp`.
 *
 * `campanha.ts` lê e casa; este arquivo escreve. A lista existia desde a elegibilidade
 * da IA (J20) e ninguém a podia editar sem `UPDATE` no Postgres: o próprio
 * `user-journey-map` a declarava como dívida. Quem a edita agora é a tela de
 * Configurações › Atendimento, pela rota `settings/campanhas-whatsapp`.
 *
 * ## O que a lista decide
 *
 * Uma mensagem que casa uma campanha torna o contato ELEGÍVEL à IA
 * (`ai_authorized_reason = campanha:<id>`) quando o canal está em "restrita por
 * origem" (`ai_gate = allowlist`), e, com `novos_nascem_pessoais` ligado, o impede
 * de nascer pessoal. Por isso a frase é cadastrada com cuidado: uma frase genérica
 * ("oi") autoriza a IA para qualquer um que a diga. A validação abaixo recusa a
 * frase que, depois de tirar acento e espaço, tem menos de três caracteres — é o
 * mesmo texto que `casarCampanha` compara, e `"  a "` casaria qualquer mensagem
 * com um "a".
 *
 * ## Substitui a lista inteira, e é por isso que ela volta inteira
 *
 * A tela envia a lista toda (o limite é 100, o mesmo de `parseCampanhas`). Um item
 * que o motor descartaria por malformado não volta na lista lida — e some na
 * próxima gravação, o que é o conserto, não a perda. `agent_id` é RESERVADO (não
 * roteia nada): a tela não o edita, mas o devolve como veio, para não apagar
 * configuração de quem a escreveu à mão.
 *
 * ## O jsonb é compartilhado
 *
 * Ler, mesclar e gravar (mesma forma de `gravarConfigPessoal` e `gravarConfigDoJev`):
 * gravar só `{ campanhas_whatsapp }` apagaria marca, MFA e o resto. O `.eq("id", orgId)`
 * é a única cerca do service role — o `orgId` vem do papel resolvido pela rota.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { createAdminClient } from "@/lib/supabase/admin";

import {
  campanhaWhatsappSchema,
  lerCampanhas,
  normalizarParaMatch,
  type CampanhaWhatsapp,
} from "./campanha";

/** O mesmo teto de `parseCampanhas`: além dele a lista seria cortada na leitura. */
export const MAX_CAMPANHAS = 100;

/** Mínimo de caracteres da frase DEPOIS de normalizada (o que o `casarCampanha` compara). */
export const MIN_FRASE_NORMALIZADA = 3;

export const campanhasEntradaSchema = z
  .object({ campanhas: z.array(campanhaWhatsappSchema).max(MAX_CAMPANHAS) })
  .strict()
  .superRefine((entrada, ctx) => {
    const vistos = new Set<string>();
    entrada.campanhas.forEach((campanha, indice) => {
      if (vistos.has(campanha.id)) {
        ctx.addIssue({ code: "custom", path: ["campanhas", indice, "id"], message: "id repetido" });
      }
      vistos.add(campanha.id);
      if (normalizarParaMatch(campanha.match.valor).length < MIN_FRASE_NORMALIZADA) {
        ctx.addIssue({
          code: "custom",
          path: ["campanhas", indice, "match", "valor"],
          message: "frase curta demais depois de tirar espaços e acentos",
        });
      }
    });
  });
export type EntradaDeCampanhas = z.infer<typeof campanhasEntradaSchema>;

function comoObjeto(valor: unknown): Record<string, unknown> | null {
  return valor !== null && typeof valor === "object" && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

/** Quantos itens do jsonb cru o motor descarta por malformados (para a tela avisar). */
export function contarDescartadas(settings: unknown): number {
  const cru = comoObjeto(settings)?.campanhas_whatsapp;
  if (!Array.isArray(cru)) return 0;
  return Math.max(0, Math.min(cru.length, MAX_CAMPANHAS) - lerCampanhas(settings).length);
}

/**
 * Os ids de canal da lista que NÃO são da organização. `null` = a leitura falhou
 * (quem chama recusa a gravação: não dá para afirmar que o canal é dela).
 */
export async function canaisForaDaOrganizacao(
  admin: SupabaseClient,
  orgId: string,
  campanhas: CampanhaWhatsapp[],
): Promise<string[] | null> {
  const pedidos = [
    ...new Set(campanhas.map((c) => c.channel_session_id).filter((id): id is string => !!id)),
  ];
  if (pedidos.length === 0) return [];
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", orgId)
    .in("id", pedidos);
  if (error) return null;
  const dela = new Set((data ?? []).map((linha) => String((linha as { id: unknown }).id)));
  return pedidos.filter((id) => !dela.has(id));
}

export interface DiferencaDeCampanhas {
  adicionadas: string[];
  removidas: string[];
  editadas: string[];
}

function diferenca(antes: CampanhaWhatsapp[], depois: CampanhaWhatsapp[]): DiferencaDeCampanhas {
  const antesPorId = new Map(antes.map((c) => [c.id, JSON.stringify(c)]));
  const depoisPorId = new Map(depois.map((c) => [c.id, JSON.stringify(c)]));
  return {
    adicionadas: depois.filter((c) => !antesPorId.has(c.id)).map((c) => c.id),
    removidas: antes.filter((c) => !depoisPorId.has(c.id)).map((c) => c.id),
    editadas: depois
      .filter((c) => antesPorId.has(c.id) && antesPorId.get(c.id) !== depoisPorId.get(c.id))
      .map((c) => c.id),
  };
}

export type ResultadoDeGravarCampanhas =
  | { ok: true; campanhas: CampanhaWhatsapp[]; alterado: boolean; diferenca: DiferencaDeCampanhas }
  | { ok: false; motivo: "leitura_falhou" | "escrita_recusada" };

/**
 * Lê, mescla e grava. Auditar é de quem chama (a rota), que sabe quem pediu.
 *
 * Pedir a lista que já vale não escreve nada (`alterado: false`). Item malformado
 * no jsonb conta como mudança: gravar a lista limpa é justamente o conserto.
 */
export async function gravarCampanhas(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  campanhas: CampanhaWhatsapp[],
): Promise<ResultadoDeGravarCampanhas> {
  const { data: org, error: leituraErro } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  if (leituraErro || !org) return { ok: false, motivo: "leitura_falhou" };

  const settingsAtuais = comoObjeto((org as { settings?: unknown }).settings) ?? {};
  const atuais = lerCampanhas(settingsAtuais);
  const diff = diferenca(atuais, campanhas);
  const mesmaOrdem = JSON.stringify(atuais) === JSON.stringify(campanhas);
  if (mesmaOrdem && contarDescartadas(settingsAtuais) === 0) {
    return { ok: true, campanhas: atuais, alterado: false, diferenca: diff };
  }

  const { data: gravado, error: escritaErro } = await admin
    .from("organizations")
    .update({ settings: { ...settingsAtuais, campanhas_whatsapp: campanhas } })
    .eq("id", orgId)
    .select("settings")
    .maybeSingle();
  // Zero linhas volta como SUCESSO no PostgREST: sem esta conferência a tela
  // diria "salvo" para uma escrita que não aconteceu.
  if (escritaErro || !gravado) return { ok: false, motivo: "escrita_recusada" };

  return { ok: true, campanhas, alterado: true, diferenca: diff };
}
