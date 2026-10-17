/**
 * A PASSADA POR ORGANIZAÇÃO do cron `data-retention` (migration 0693).
 *
 * As podas globais continuam exatamente como eram; esta roda DEPOIS delas e
 * apaga, para cada organização que definiu um prazo próprio, o dado pessoal
 * mais velho que esse prazo. Como a global já passou por todas, o que sobra é o
 * menor dos dois prazos: a organização só encurta (ver `prazos-da-organizacao`).
 *
 * ─── Por que um módulo próprio, e não mais um laço em `podarHistorico` ──────
 * O dreno das irmãs é por TABELA (`fn_x(p_retencao_dias, p_limite)`); este é por
 * PAR (organização, tipo) e a lista de pares vem do banco. Misturar os dois
 * formatos no mesmo `PodaDb` obrigaria a reescrever os fakes de todos os testes
 * da retenção sem ganho. Aqui a superfície é só duas chamadas.
 *
 * ─── Falha de um par não derruba os outros ──────────────────────────────────
 * Mesma doutrina do #2508: cada par falha sozinho e a falha entra NOMEADA em
 * `por_organizacao_falhas`. Uma organização com dado torto não pode impedir a
 * poda das demais.
 *
 * ─── Orçamento ──────────────────────────────────────────────────────────────
 * Cada par tem o teto de lotes das irmãs. Além dele há um teto da RODADA para as
 * chamadas que voltaram CHEIAS (as que provam backlog): chamada que volta
 * incompleta é barata e não conta, para uma instalação com muitas organizações
 * ainda visitar todas. Estourou o teto: o resto fica para a próxima rodada e
 * `por_organizacao_tem_resto` diz isso — nunca silêncio.
 */
import {
  TIPOS_DE_PRAZO_DA_ORGANIZACAO,
  type TipoDePrazoDaOrganizacao,
} from "@/lib/retencao/prazos-da-organizacao";

export interface PrazoDeOrganizacao {
  organization_id: string;
  tipo: TipoDePrazoDaOrganizacao;
  dias: number;
}

type RespostaDoBanco<T> = Promise<{ data: T | null; error: { message: string } | null }>;

/** Só a superfície que a passada usa — o teste injeta uma implementação. */
export interface PodaPorOrganizacaoDb {
  /** `fn_organizacoes_com_prazo_proprio()`. */
  listarPrazos(): RespostaDoBanco<unknown[]>;
  /** `fn_expurgar_por_organizacao(p_tipo, p_organizacao, p_limite)`. */
  expurgar(
    tipo: TipoDePrazoDaOrganizacao,
    organizacao: string,
    lote: number,
  ): RespostaDoBanco<number>;
}

export interface ApagadoPorOrganizacao {
  organization_id: string;
  tipo: TipoDePrazoDaOrganizacao;
  /** O prazo próprio que valia (já elevado ao piso pelo banco). */
  dias: number;
  apagadas: number;
  lotes: number;
  /** O teto de lotes do par foi atingido com a última chamada cheia. */
  tem_resto: boolean;
}

export interface ResultadoPorOrganizacao {
  /** Quantos pares (organização, tipo) com prazo próprio foram examinados. */
  por_organizacao_pares: number;
  por_organizacao_apagadas: number;
  por_organizacao_lotes: number;
  por_organizacao_tem_resto: boolean;
  /** Só os pares que apagaram algo: é o que vira uma linha de auditoria por organização. */
  por_organizacao: ApagadoPorOrganizacao[];
  /** Uma linha por falha, `"fn_x: motivo"`, nunca engolida. */
  por_organizacao_falhas: string[];
}

export interface OpcoesDaPassada {
  /** Linhas por chamada (o `TAMANHO_DO_LOTE` do cron). */
  tamanhoDoLote: number;
  /** Teto de chamadas por par (o `MAX_LOTES` do cron). */
  maxLotes: number;
  /** Teto de chamadas CHEIAS na rodada inteira. Padrão: 5× `maxLotes`. */
  maxLotesCheios?: number;
}

const TETO_DA_MENSAGEM = 300;

function resultadoVazio(): ResultadoPorOrganizacao {
  return {
    por_organizacao_pares: 0,
    por_organizacao_apagadas: 0,
    por_organizacao_lotes: 0,
    por_organizacao_tem_resto: false,
    por_organizacao: [],
    por_organizacao_falhas: [],
  };
}

function ehTipo(valor: unknown): valor is TipoDePrazoDaOrganizacao {
  return (
    typeof valor === "string" &&
    (TIPOS_DE_PRAZO_DA_ORGANIZACAO as readonly string[]).includes(valor)
  );
}

/** Uma linha de `fn_organizacoes_com_prazo_proprio()` que o banco não deveria devolver torta. */
function lerLinha(bruta: unknown): PrazoDeOrganizacao | null {
  if (typeof bruta !== "object" || bruta === null) return null;
  const { organization_id, tipo, dias } = bruta as Record<string, unknown>;
  if (typeof organization_id !== "string" || organization_id === "") return null;
  if (!ehTipo(tipo)) return null;
  if (typeof dias !== "number" || !Number.isInteger(dias)) return null;
  return { organization_id, tipo, dias };
}

function nomear(nome: string, detalhe: string): string {
  return `${nome}: ${detalhe}`.slice(0, TETO_DA_MENSAGEM);
}

export async function podarPorOrganizacao(
  db: PodaPorOrganizacaoDb,
  opcoes: OpcoesDaPassada,
): Promise<ResultadoPorOrganizacao> {
  const resultado = resultadoVazio();
  const maxCheios = opcoes.maxLotesCheios ?? opcoes.maxLotes * 5;

  let linhas: unknown[];
  try {
    const { data, error } = await db.listarPrazos();
    if (error) {
      resultado.por_organizacao_falhas.push(
        nomear("fn_organizacoes_com_prazo_proprio", error.message),
      );
      return resultado;
    }
    linhas = data ?? [];
  } catch (err) {
    resultado.por_organizacao_falhas.push(
      nomear("fn_organizacoes_com_prazo_proprio", err instanceof Error ? err.message : String(err)),
    );
    return resultado;
  }

  let cheios = 0;
  for (const bruta of linhas) {
    const par = lerLinha(bruta);
    if (par === null) {
      // Linha torta é dita, não pulada em silêncio: o banco devolveu algo que o
      // contrato não prevê (tipo novo sem código aqui, por exemplo).
      resultado.por_organizacao_falhas.push(
        nomear("fn_organizacoes_com_prazo_proprio", "linha fora do contrato"),
      );
      continue;
    }

    if (cheios >= maxCheios) {
      resultado.por_organizacao_tem_resto = true;
      break;
    }

    resultado.por_organizacao_pares += 1;
    let apagadas = 0;
    let lotes = 0;
    let temResto = false;
    try {
      for (let i = 0; i < opcoes.maxLotes; i += 1) {
        const { data, error } = await db.expurgar(
          par.tipo,
          par.organization_id,
          opcoes.tamanhoDoLote,
        );
        if (error) {
          resultado.por_organizacao_falhas.push(
            nomear(
              `fn_expurgar_por_organizacao(${par.tipo}@${par.organization_id})`,
              error.message,
            ),
          );
          break;
        }
        const n = data ?? 0;
        lotes += 1;
        apagadas += n;
        if (n < opcoes.tamanhoDoLote) break;
        cheios += 1;
        if (i === opcoes.maxLotes - 1) temResto = true;
      }
    } catch (err) {
      resultado.por_organizacao_falhas.push(
        nomear(
          `fn_expurgar_por_organizacao(${par.tipo}@${par.organization_id})`,
          err instanceof Error ? err.message : String(err),
        ),
      );
    }

    resultado.por_organizacao_lotes += lotes;
    resultado.por_organizacao_apagadas += apagadas;
    if (temResto) resultado.por_organizacao_tem_resto = true;
    if (apagadas > 0) {
      resultado.por_organizacao.push({
        organization_id: par.organization_id,
        tipo: par.tipo,
        dias: par.dias,
        apagadas,
        lotes,
        tem_resto: temResto,
      });
    }
  }

  return resultado;
}
