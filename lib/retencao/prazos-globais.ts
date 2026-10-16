/**
 * Os PRAZOS GLOBAIS de retenção que o administrador da plataforma edita em Admin › Configuração.
 *
 * ── Por que este arquivo existe ──────────────────────────────────────────────
 *
 * Os 15 prazos abaixo viviam só no `.env` do servidor: trocar um era editar arquivo e reiniciar, e o
 * administrador de uma instalação que ele mesmo não opera não alcançava nenhum. Agora cada um é uma chave
 * do catálogo da instalação (`lib/instalacao/catalogo.ts`, grupo `retencao`) e o cron lê pelo resolvedor
 * (`valorDaInstalacao`): o que a tela grava vence, e o `.env` é só o valor de partida.
 *
 * ── O que NÃO muda ───────────────────────────────────────────────────────────
 *
 * `interpretarRetencao` (`./politica.ts`) continua sendo a única porta de entrada do número: ele ainda eleva
 * ao piso, corta no teto e troca lixo pelo padrão. A tela recusa o valor fora da faixa ANTES de gravar
 * (ver `recusaDoPrazo`), mas se um valor torto chegasse ao banco por outro caminho, o piso do código e o
 * piso das funções SQL seguem valendo — a tela é uma conveniência, nunca a única guarda.
 *
 * ── O que fica de fora, e por quê ────────────────────────────────────────────
 *
 * - `WEBHOOK_LOG_BODY_RETENTION_DAYS` e `WEBHOOK_LOG_ROW_RETENTION_DAYS` chegam ao código já como NÚMERO,
 *   interpretados em `lib/env.ts` na carga; seguem só no `.env`.
 * - A retenção da MÍDIA é por organização (`organizations.media_retention_days`), não da instalação.
 *
 * Puro: só dados e uma função de conferência. Sem banco, sem `env`, sem log — o catálogo importa este
 * arquivo e o catálogo roda no cliente também.
 */
import {
  RETENCAO_AUDITORIA_DIAS_PADRAO,
  RETENCAO_AUDITORIA_DIAS_PISO,
  RETENCAO_AVISO_DE_CASO_DIAS_PADRAO,
  RETENCAO_AVISO_DE_CASO_DIAS_PISO,
  RETENCAO_CANDIDATOS_GOLDEN_DIAS_PADRAO,
  RETENCAO_CANDIDATOS_GOLDEN_DIAS_PISO,
  RETENCAO_CAPTACAO_DIAS_PADRAO,
  RETENCAO_CAPTACAO_DIAS_PISO,
  RETENCAO_CHECKPOINTS_DIAS_PADRAO,
  RETENCAO_CHECKPOINTS_DIAS_PISO,
  RETENCAO_CONVERSA_DO_CASO_DIAS_PADRAO,
  RETENCAO_CONVERSA_DO_CASO_DIAS_PISO,
  RETENCAO_COPIAS_ENVIADAS_DIAS_PADRAO,
  RETENCAO_COPIAS_ENVIADAS_DIAS_PISO,
  RETENCAO_ESPELHO_AGENDA_DIAS_PADRAO,
  RETENCAO_ESPELHO_AGENDA_DIAS_PISO,
  RETENCAO_FILA_DIAS_PADRAO,
  RETENCAO_FILA_DIAS_PISO,
  RETENCAO_OBSERVACOES_DO_JEV_DIAS_PADRAO,
  RETENCAO_OBSERVACOES_DO_JEV_DIAS_PISO,
  RETENCAO_PASSAGEM_DIAS_PADRAO,
  RETENCAO_PASSAGEM_DIAS_PISO,
  RETENCAO_PROSPECCAO_DIAS_PADRAO,
  RETENCAO_PROSPECCAO_DIAS_PISO,
  RETENCAO_RASCUNHO_DIAS_PADRAO,
  RETENCAO_RASCUNHO_DIAS_PISO,
  RETENCAO_RITMO_DE_ENVIO_DIAS_PADRAO,
  RETENCAO_RITMO_DE_ENVIO_DIAS_PISO,
  RETENCAO_TELEMETRIA_DE_IA_DIAS_PADRAO,
  RETENCAO_TELEMETRIA_DE_IA_DIAS_PISO,
  RETENCAO_TETO_DIAS,
} from "./politica";

export interface PrazoGlobal {
  /** O nome da variável de ambiente — é também a chave da linha em `platform_config`. */
  readonly chave: string;
  /** Para quem não programa. Curto. */
  readonly rotulo: string;
  /** O que fica guardado e para que serve guardar. Uma frase; os números entram por `explicacaoDoPrazo`. */
  readonly oQueE: string;
  readonly padrao: number;
  readonly piso: number;
}

export const PRAZOS_GLOBAIS: readonly PrazoGlobal[] = [
  {
    chave: "AUDIT_LOG_RETENTION_DAYS",
    rotulo: "Registro de auditoria (quem fez o quê)",
    oQueE:
      "O rastro de quem mudou o quê no sistema. É a evidência que responde a uma reclamação ou a um incidente, e por isso o prazo é longo e vale igual para todas as organizações.",
    padrao: RETENCAO_AUDITORIA_DIAS_PADRAO,
    piso: RETENCAO_AUDITORIA_DIAS_PISO,
  },
  {
    chave: "PASSAGEM_RETENTION_DAYS",
    rotulo: "Passagens do atendimento para uma pessoa",
    oQueE:
      "O registro de quando a conversa passou da IA para uma pessoa, quem assumiu e quanto tempo esperou. Passagem ainda aberta nunca é apagada.",
    padrao: RETENCAO_PASSAGEM_DIAS_PADRAO,
    piso: RETENCAO_PASSAGEM_DIAS_PISO,
  },
  {
    chave: "AI_TELEMETRY_RETENTION_DAYS",
    rotulo: "Telemetria da IA (chamadas, métricas e decisões)",
    oQueE: "O histórico técnico das chamadas de IA que alimenta as telas de uso e de evolução.",
    padrao: RETENCAO_TELEMETRIA_DE_IA_DIAS_PADRAO,
    piso: RETENCAO_TELEMETRIA_DE_IA_DIAS_PISO,
  },
  {
    chave: "LEAD_CAPTURE_RETENTION_DAYS",
    rotulo: "Leads captados (formulários e anúncios)",
    oQueE:
      "O histórico de quem preencheu um formulário ou respondeu a um anúncio e de onde veio. É dado pessoal do cliente final.",
    padrao: RETENCAO_CAPTACAO_DIAS_PADRAO,
    piso: RETENCAO_CAPTACAO_DIAS_PISO,
  },
  {
    chave: "CASE_CHAT_RETENTION_DAYS",
    rotulo: "Conversa da equipe com a IA sobre um caso",
    oQueE:
      "A deliberação da equipe com a IA sobre um caso. Depois do prazo, a decisão continua registrada nos eventos do caso.",
    padrao: RETENCAO_CONVERSA_DO_CASO_DIAS_PADRAO,
    piso: RETENCAO_CONVERSA_DO_CASO_DIAS_PISO,
  },
  {
    chave: "PROSPECCAO_RETENTION_DAYS",
    rotulo: "Candidatos da prospecção",
    oQueE:
      "Nome, telefone e endereço de quem foi encontrado pela prospecção, muitas vezes sem nunca ter falado com a empresa. Quem pediu para sair continua bloqueado depois do prazo.",
    padrao: RETENCAO_PROSPECCAO_DIAS_PADRAO,
    piso: RETENCAO_PROSPECCAO_DIAS_PISO,
  },
  {
    chave: "CASE_ALERT_RETENTION_DAYS",
    rotulo: "Registro dos avisos de caso",
    oQueE:
      "O registro de que o aviso de um caso saiu para o WhatsApp da equipe. Não guarda o texto do aviso, só um resumo criptográfico dele.",
    padrao: RETENCAO_AVISO_DE_CASO_DIAS_PADRAO,
    piso: RETENCAO_AVISO_DE_CASO_DIAS_PISO,
  },
  {
    chave: "LEAD_CHECKPOINT_RETENTION_DAYS",
    rotulo: "Resumos antigos de conversa de lead",
    oQueE:
      "Os resumos que a IA fez de uma conversa e que um resumo mais novo já substituiu. O resumo em vigor de cada atendimento nunca é apagado.",
    padrao: RETENCAO_CHECKPOINTS_DIAS_PADRAO,
    piso: RETENCAO_CHECKPOINTS_DIAS_PISO,
  },
  {
    chave: "JOB_QUEUE_RETENTION_DAYS",
    rotulo: "Fila de tarefas já concluídas",
    oQueE: "O histórico das tarefas de segundo plano que já terminaram.",
    padrao: RETENCAO_FILA_DIAS_PADRAO,
    piso: RETENCAO_FILA_DIAS_PISO,
  },
  {
    chave: "JEV_OBSERVACOES_RETENTION_DAYS",
    rotulo: "Observações do Jev",
    oQueE:
      "Os rótulos que o Jev e o mecanismo antigo deram à mesma tarefa, usados para medir se o Jev já pode decidir sozinho. Não guarda texto de cliente.",
    padrao: RETENCAO_OBSERVACOES_DO_JEV_DIAS_PADRAO,
    piso: RETENCAO_OBSERVACOES_DO_JEV_DIAS_PISO,
  },
  {
    chave: "CALENDAR_MIRROR_RETENTION_DAYS",
    rotulo: "Passado da agenda conectada",
    oQueE:
      "Quantos dias de compromissos já passados da agenda conectada ficam guardados aqui. Compromisso futuro nunca é apagado; o que sai se recompõe na próxima sincronização.",
    padrao: RETENCAO_ESPELHO_AGENDA_DIAS_PADRAO,
    piso: RETENCAO_ESPELHO_AGENDA_DIAS_PISO,
  },
  {
    chave: "GOLDEN_CANDIDATES_RETENTION_DAYS",
    rotulo: "Candidatos ao conjunto de referência da IA",
    oQueE:
      "Os casos que ficaram quase certos e esperam alguém decidir se entram no conjunto de referência. Não guarda texto de cliente.",
    padrao: RETENCAO_CANDIDATOS_GOLDEN_DIAS_PADRAO,
    piso: RETENCAO_CANDIDATOS_GOLDEN_DIAS_PISO,
  },
  {
    chave: "DRAFT_RETENTION_DAYS",
    rotulo: "Rascunhos sugeridos que já venceram",
    oQueE:
      "O texto que uma integração sugeriu e que ninguém enviou. O prazo conta a partir do vencimento do link, não da criação.",
    padrao: RETENCAO_RASCUNHO_DIAS_PADRAO,
    piso: RETENCAO_RASCUNHO_DIAS_PISO,
  },
  {
    chave: "OUTBOUND_COPIES_RETENTION_DAYS",
    rotulo: "Cópias das mensagens enviadas",
    oQueE:
      "O texto das últimas mensagens enviadas, que o sistema compara para não mandar o mesmo texto duas vezes. As mais recentes de cada número ficam sempre.",
    padrao: RETENCAO_COPIAS_ENVIADAS_DIAS_PADRAO,
    piso: RETENCAO_COPIAS_ENVIADAS_DIAS_PISO,
  },
  {
    chave: "PACING_LEDGER_RETENTION_DAYS",
    rotulo: "Ritmo de envio",
    oQueE:
      "O registro de quando cada número enviou por último, que mede o espaçamento do próximo envio. O último de cada número nunca é apagado, e nenhum leitor olha mais longe que isto.",
    padrao: RETENCAO_RITMO_DE_ENVIO_DIAS_PADRAO,
    piso: RETENCAO_RITMO_DE_ENVIO_DIAS_PISO,
  },
];

const PRAZO_POR_CHAVE: ReadonlyMap<string, PrazoGlobal> = new Map(PRAZOS_GLOBAIS.map((p) => [p.chave, p]));

export function acharPrazoGlobal(chave: string): PrazoGlobal | undefined {
  return PRAZO_POR_CHAVE.get(chave);
}

/**
 * O texto da tela: o que é + o padrão + o mínimo. Os números saem das constantes de `politica.ts` — a
 * mesma fonte do código que poda —, então a tela não pode prometer um padrão que o cron não usa.
 */
export function explicacaoDoPrazo(p: PrazoGlobal): string {
  const unidade = (n: number) => (n === 1 ? "1 dia" : `${n} dias`);
  return (
    `${p.oQueE} Sem valor definido, vale ${unidade(p.padrao)}. ` +
    `O mínimo aceito é ${unidade(p.piso)}; abaixo disso o sistema não grava.`
  );
}

/**
 * Confere o que a pessoa digitou ANTES de gravar. `null` = pode gravar; texto = o que corrigir.
 * Nunca repete o valor digitado na mensagem. Chave que não é prazo global passa direto.
 */
export function recusaDoPrazo(chave: string, valor: string): string | null {
  const prazo = acharPrazoGlobal(chave);
  if (!prazo) return null;
  const limpo = valor.trim();
  // `Number()` e não `parseInt`: "90dias" seria aceito como 90 em silêncio (mesma doutrina de
  // `interpretarRetencao`). `^\d+$` fecha também o sinal, o ponto e a notação científica.
  if (!/^\d+$/.test(limpo)) {
    return "Escreva só o número de dias, sem letras, sinais nem vírgula (por exemplo, 365).";
  }
  const dias = Number(limpo);
  if (!Number.isSafeInteger(dias) || dias < prazo.piso) {
    return `O prazo mínimo é ${prazo.piso === 1 ? "1 dia" : `${prazo.piso} dias`}. Escreva um número igual ou maior.`;
  }
  if (dias > RETENCAO_TETO_DIAS) {
    return `O prazo máximo é ${RETENCAO_TETO_DIAS} dias. Escreva um número igual ou menor.`;
  }
  return null;
}
