import { customFieldSchema, type CustomFieldDef } from "@/lib/schemas/settings";

/** Lê `pipelines.settings.fields` sem explodir se o jsonb estiver velho ou vazio. */
export function camposDoFunil(settings: Record<string, unknown> | null | undefined): CustomFieldDef[] {
  if (!settings) return [];
  const raw = settings.fields;
  if (!Array.isArray(raw)) return [];
  const out: CustomFieldDef[] = [];
  for (const item of raw) {
    const parsed = customFieldSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** A que pertence o campo (issue #2791): ao negócio ou ao contato. */
export type EscopoDoCampo = "negocio" | "contato";

/**
 * O escopo do campo, com a ausência valendo `negocio`.
 *
 * A chave é opcional no `settings` de propósito: toda definição que já existe
 * não a tem, e a leitura dela é `negocio` — sem isto, funil antigo mudaria de
 * comportamento no dia em que a propriedade nasceu.
 */
export function escopoDoCampo(campo: Pick<CustomFieldDef, "escopo">): EscopoDoCampo {
  return campo.escopo === "contato" ? "contato" : "negocio";
}

/** Os campos de UM escopo, na ordem em que o funil os declara. */
export function camposPorEscopo(
  campos: CustomFieldDef[],
  escopo: EscopoDoCampo,
): CustomFieldDef[] {
  return campos.filter((campo) => escopoDoCampo(campo) === escopo);
}

/**
 * O embed `crm_pipelines(settings)` do PostgREST vem objeto (FK to-one) ou,
 * se a relação vacilar, array. Os dois caem aqui — lixo vira `null`.
 */
export function settingsDoEmbed(embed: unknown): Record<string, unknown> | null {
  const alvo = Array.isArray(embed) ? embed[0] : embed;
  if (!alvo || typeof alvo !== "object") return null;
  const settings = (alvo as { settings?: unknown }).settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  return settings as Record<string, unknown>;
}

