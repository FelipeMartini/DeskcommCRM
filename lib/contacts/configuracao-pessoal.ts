/**
 * CONFIGURAÇÃO DO CONTATO PESSOAL — os dois interruptores da organização.
 *
 * ## O problema que eles resolvem
 *
 * Quem liga o próprio WhatsApp ao CRM entrega para a operação TODA conversa do
 * aparelho: família, amigos, o dentista. Marcar contato por contato, pela tela
 * (`POST /api/v1/contacts/[id]/personal`), não acompanha o ritmo em que essas
 * conversas chegam. Dois gestos resolvem pelo celular, sem abrir o CRM:
 *
 * - `comando_pelo_celular` — o dono digita `#pessoal` no chat do contato e o
 *   contato sai da operação (`lib/contacts/pessoal-automatico.ts`);
 * - `novos_nascem_pessoais` — o contato que aparece pela primeira vez já nasce
 *   pessoal, EXCETO se a primeira mensagem casa uma campanha cadastrada
 *   (`organizations.settings.campanhas_whatsapp`). É a inversão do padrão: em vez
 *   de marcar o que é da vida, o que é do negócio se anuncia pela palavra.
 *
 * ## Padrão desligado, e só `true` liga
 *
 * Os dois nascem DESLIGADOS. Ligar muda quem a operação enxerga, então é decisão
 * de quem administra a organização, e a leitura é fail-closed: qualquer valor que
 * não seja o booleano `true` — ausente, texto "true", número 1, objeto — vale
 * desligado. Um `settings` malformado não pode esconder cliente.
 *
 * ## Onde mora
 *
 * `organizations.settings.contatos_pessoais`, no jsonb COMPARTILHADO com marca,
 * MFA, IA padrão e Jev. Por isso a gravação é de LER, MESCLAR e GRAVAR (a mesma
 * forma de `gravarConfigDoJev`, `lib/ai/decisao/config.ts`): gravar só
 * `{ contatos_pessoais }` apagaria o resto em silêncio. O service role passa por
 * cima da RLS, então o `.eq("id", orgId)` é a única cerca entre esta empresa e a
 * instalação inteira — o `orgId` vem do papel resolvido pela rota, nunca do corpo.
 *
 * ## O alcance: a organização, não o número
 *
 * Os interruptores valem para todo canal de WhatsApp da organização. Quem tem um
 * número pessoal E um número dedicado ao negócio na mesma organização deve manter
 * `novos_nascem_pessoais` desligado enquanto o dedicado estiver conectado, ou o
 * cliente novo dele nasceria pessoal. Escopo por canal é a evolução natural e
 * está registrada como sugestão, não como dívida: hoje a instalação tem um número
 * só.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { z } from "zod";

export interface ConfigPessoal {
  comando_pelo_celular: boolean;
  novos_nascem_pessoais: boolean;
}

export const CONFIG_PESSOAL_PADRAO: Readonly<ConfigPessoal> = Object.freeze({
  comando_pelo_celular: false,
  novos_nascem_pessoais: false,
});

/** O pedido de mudança: só o que veio muda, e nada além dos dois campos. */
export const configPessoalMudancaSchema = z
  .object({
    comando_pelo_celular: z.boolean().optional(),
    novos_nascem_pessoais: z.boolean().optional(),
  })
  .strict()
  .refine((c) => c.comando_pelo_celular !== undefined || c.novos_nascem_pessoais !== undefined, {
    message: "informe `comando_pelo_celular` ou `novos_nascem_pessoais`",
  });
export type MudancaDaConfigPessoal = z.infer<typeof configPessoalMudancaSchema>;

function comoObjeto(valor: unknown): Record<string, unknown> | null {
  return valor !== null && typeof valor === "object" && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

/**
 * Lê os interruptores do `organizations.settings` (jsonb cru). Nunca lança e só
 * `true` liga — ver o cabeçalho.
 */
export function lerConfigPessoal(settings: unknown): ConfigPessoal {
  const bloco = comoObjeto(comoObjeto(settings)?.contatos_pessoais);
  return {
    comando_pelo_celular: bloco?.comando_pelo_celular === true,
    novos_nascem_pessoais: bloco?.novos_nascem_pessoais === true,
  };
}

export type ResultadoDeGravarConfigPessoal =
  | { ok: true; config: ConfigPessoal; alterado: boolean }
  | { ok: false; motivo: "leitura_falhou" | "escrita_recusada" };

/**
 * Lê, mescla e grava. Auditar é de quem chama (a rota), que sabe quem pediu.
 *
 * Pedir o estado que já vale não escreve nada (`alterado: false`): sem escrita
 * não há auditoria, e a tela não precisa gravar para mostrar o que já está.
 */
export async function gravarConfigPessoal(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  mudanca: MudancaDaConfigPessoal,
): Promise<ResultadoDeGravarConfigPessoal> {
  const { data: org, error: leituraErro } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();
  if (leituraErro || !org) return { ok: false, motivo: "leitura_falhou" };

  const settingsAtuais = comoObjeto((org as { settings?: unknown }).settings) ?? {};
  const atual = lerConfigPessoal(settingsAtuais);
  const proxima: ConfigPessoal = {
    comando_pelo_celular: mudanca.comando_pelo_celular ?? atual.comando_pelo_celular,
    novos_nascem_pessoais: mudanca.novos_nascem_pessoais ?? atual.novos_nascem_pessoais,
  };
  if (
    proxima.comando_pelo_celular === atual.comando_pelo_celular &&
    proxima.novos_nascem_pessoais === atual.novos_nascem_pessoais
  ) {
    return { ok: true, config: atual, alterado: false };
  }

  // Chaves desconhecidas do bloco (de uma versão futura, ou de outra extensão)
  // sobrevivem: o bloco é mesclado, não substituído.
  const blocoAtual = comoObjeto(settingsAtuais.contatos_pessoais) ?? {};
  const { data: gravado, error: escritaErro } = await admin
    .from("organizations")
    .update({ settings: { ...settingsAtuais, contatos_pessoais: { ...blocoAtual, ...proxima } } })
    .eq("id", orgId)
    .select("settings")
    .maybeSingle();
  // Zero linhas volta como SUCESSO no PostgREST: sem esta conferência a tela
  // diria "ligado" para uma escrita que não aconteceu.
  if (escritaErro || !gravado) return { ok: false, motivo: "escrita_recusada" };

  return { ok: true, config: proxima, alterado: true };
}
