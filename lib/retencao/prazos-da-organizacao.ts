/**
 * O prazo de retenção POR ORGANIZAÇÃO — regra PURA, sem banco e sem env
 * (modelo MISTO, etapas 2 e 3; migration 0693).
 *
 * ─── O que é por organização, e o que continua global ──────────────────────
 * Quatro tipos de dado PESSOAL de terceiros: a captação de lead, a conversa do
 * caso, a prospecção e o espelho da agenda. A empresa é a controladora desse
 * dado e o prazo certo depende do setor dela. Auditoria, fila, telemetria,
 * logs de webhook, passagem e afins seguem GLOBAIS (rastro e operação da
 * instalação): prazo por organização na auditoria deixaria uma empresa apagar
 * o próprio rastro. A mídia já é por organização (`media_retention_days`).
 *
 * ─── A organização só ENCURTA ───────────────────────────────────────────────
 * Nunca passa do prazo global (o teto) e nunca fica abaixo do piso fixo. O teto
 * é garantido pela ARQUITETURA, não por esta função: a poda global continua
 * rodando para todas as organizações e a por organização apaga ALÉM dela, então
 * o que vale é o menor dos dois. Este módulo confere o teto só para dizer isso
 * ao admin ANTES de gravar — o banco não depende dele.
 *
 * ─── Onde mora cada metade ──────────────────────────────────────────────────
 * O PISO mora dentro do SQL (`fn_piso_de_retencao_por_organizacao`), porque só
 * lá vale para qualquer chamador. Aqui ele aparece de novo, com as MESMAS
 * constantes de `politica.ts`, para a tela mostrar o mínimo e o validador
 * recusar cedo; `tests/unit/retencao-por-organizacao-pisos.test.ts` compara as
 * duas tabelas, para elas não divergirem em silêncio.
 */
import {
  RETENCAO_CAPTACAO_DIAS_PISO,
  RETENCAO_CONVERSA_DO_CASO_DIAS_PISO,
  RETENCAO_ESPELHO_AGENDA_DIAS_PISO,
  RETENCAO_PROSPECCAO_DIAS_PISO,
} from "@/lib/retencao/politica";

/** Os tipos que aceitam prazo próprio. A ORDEM é a da tela e a da lista do SQL. */
export const TIPOS_DE_PRAZO_DA_ORGANIZACAO = [
  "captacao",
  "conversa_do_caso",
  "prospeccao",
  "espelho_da_agenda",
] as const;

export type TipoDePrazoDaOrganizacao = (typeof TIPOS_DE_PRAZO_DA_ORGANIZACAO)[number];

/** O piso de cada tipo — as constantes de `politica.ts`, a mesma tabela do SQL. */
export const PISO_DO_PRAZO_DA_ORGANIZACAO: Readonly<Record<TipoDePrazoDaOrganizacao, number>> = {
  captacao: RETENCAO_CAPTACAO_DIAS_PISO,
  conversa_do_caso: RETENCAO_CONVERSA_DO_CASO_DIAS_PISO,
  prospeccao: RETENCAO_PROSPECCAO_DIAS_PISO,
  espelho_da_agenda: RETENCAO_ESPELHO_AGENDA_DIAS_PISO,
};

/** A chave dentro de `organizations.settings.retencao`. */
export function chaveDoPrazo(tipo: TipoDePrazoDaOrganizacao): `${TipoDePrazoDaOrganizacao}_dias` {
  return `${tipo}_dias`;
}

/** Até 5 dígitos, como o SQL (`^[0-9]{1,5}$`): mais que isso não é prazo, é lixo. */
export const PRAZO_MAXIMO_EM_DIAS = 99_999;

/** Os prazos próprios de uma organização: o tipo ausente herda o global. */
export type PrazosDaOrganizacao = Partial<Record<TipoDePrazoDaOrganizacao, number>>;

function ehTipo(valor: string): valor is TipoDePrazoDaOrganizacao {
  return (TIPOS_DE_PRAZO_DA_ORGANIZACAO as readonly string[]).includes(valor);
}

/**
 * O que o banco enxerga em `settings.retencao.<tipo>_dias`: um inteiro de até 5
 * dígitos (número ou texto de dígitos), elevado ao piso. Qualquer outra coisa —
 * decimal, negativo, texto, número enorme — é ignorada e vale o global. É a
 * MESMA regra de `fn_prazo_de_retencao_da_organizacao`, escrita de novo para a
 * tela mostrar o que de fato vale.
 */
function lerUmPrazo(bruto: unknown, tipo: TipoDePrazoDaOrganizacao): number | null {
  let numero: number;
  if (typeof bruto === "number") {
    if (!Number.isInteger(bruto)) return null;
    numero = bruto;
  } else if (typeof bruto === "string" && /^[0-9]{1,5}$/.test(bruto)) {
    numero = Number(bruto);
  } else {
    return null;
  }
  if (numero < 0 || numero > PRAZO_MAXIMO_EM_DIAS) return null;
  return Math.max(numero, PISO_DO_PRAZO_DA_ORGANIZACAO[tipo]);
}

/** Lê `organizations.settings` (jsonb livre) e devolve só os prazos que valem. */
export function lerPrazosDaOrganizacao(settings: unknown): PrazosDaOrganizacao {
  if (typeof settings !== "object" || settings === null) return {};
  const retencao = (settings as Record<string, unknown>).retencao;
  if (typeof retencao !== "object" || retencao === null || Array.isArray(retencao)) return {};
  const lidos: PrazosDaOrganizacao = {};
  for (const tipo of TIPOS_DE_PRAZO_DA_ORGANIZACAO) {
    const valor = lerUmPrazo((retencao as Record<string, unknown>)[chaveDoPrazo(tipo)], tipo);
    if (valor !== null) lidos[tipo] = valor;
  }
  return lidos;
}

export type MotivoDeRecusaDoPrazo =
  "tipo_desconhecido" | "nao_e_inteiro" | "abaixo_do_piso" | "acima_do_maximo";

export interface RecusaDoPrazo {
  tipo: string;
  motivo: MotivoDeRecusaDoPrazo;
  /** O mínimo (piso) do tipo, quando o motivo é `abaixo_do_piso`. */
  piso?: number;
}

export type ResultadoDaValidacao =
  { ok: true; prazos: PrazosDaOrganizacao } | { ok: false; recusas: RecusaDoPrazo[] };

/**
 * Confere o que o admin digitou. `entrada` é o ESTADO DESEJADO completo: tipo
 * ausente, `null` ou texto vazio = herdar o global. Um tipo que não existe, um
 * valor que não é inteiro, abaixo do piso ou acima do máximo é recusado com o
 * motivo — a tela traduz, e o banco repete as mesmas recusas por baixo.
 *
 * Valor ACIMA do prazo global não é recusa: é inofensivo (a poda global já
 * passou por lá) e a tela avisa que ele não terá efeito. Por isso a função não
 * recebe o global — quem quer avisar usa `prazoSemEfeito`.
 */
export function validarPrazosDaOrganizacao(entrada: unknown): ResultadoDaValidacao {
  if (typeof entrada !== "object" || entrada === null || Array.isArray(entrada)) {
    return { ok: false, recusas: [{ tipo: "(entrada)", motivo: "nao_e_inteiro" }] };
  }
  const recusas: RecusaDoPrazo[] = [];
  const prazos: PrazosDaOrganizacao = {};
  for (const [tipo, bruto] of Object.entries(entrada as Record<string, unknown>)) {
    if (!ehTipo(tipo)) {
      recusas.push({ tipo, motivo: "tipo_desconhecido" });
      continue;
    }
    if (bruto === null || bruto === undefined || bruto === "") continue;
    const numero = typeof bruto === "string" && /^[0-9]{1,6}$/.test(bruto) ? Number(bruto) : bruto;
    if (typeof numero !== "number" || !Number.isInteger(numero) || numero < 0) {
      recusas.push({ tipo, motivo: "nao_e_inteiro" });
      continue;
    }
    if (numero > PRAZO_MAXIMO_EM_DIAS) {
      recusas.push({ tipo, motivo: "acima_do_maximo" });
      continue;
    }
    const piso = PISO_DO_PRAZO_DA_ORGANIZACAO[tipo];
    if (numero < piso) {
      recusas.push({ tipo, motivo: "abaixo_do_piso", piso });
      continue;
    }
    prazos[tipo] = numero;
  }
  return recusas.length > 0 ? { ok: false, recusas } : { ok: true, prazos };
}

/**
 * O prazo da organização não terá efeito quando é igual ou maior que o global:
 * a poda global já apagou tudo o que ele alcançaria. A tela usa isto para dizer
 * "vale o global" em vez de deixar o admin achar que está protegendo dado por
 * mais tempo (a organização só encurta).
 */
export function prazoSemEfeito(prazoDaOrganizacao: number, prazoGlobal: number): boolean {
  return prazoDaOrganizacao >= prazoGlobal;
}

/** O objeto que `fn_definir_retencao_da_organizacao` espera (`<tipo>_dias`). */
export function prazosParaGravar(prazos: PrazosDaOrganizacao): Record<string, number> {
  const saida: Record<string, number> = {};
  for (const tipo of TIPOS_DE_PRAZO_DA_ORGANIZACAO) {
    const valor = prazos[tipo];
    if (valor !== undefined) saida[chaveDoPrazo(tipo)] = valor;
  }
  return saida;
}
