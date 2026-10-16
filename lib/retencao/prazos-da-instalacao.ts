/**
 * Lê os PRAZOS GLOBAIS de retenção em vigor: o que a tela de Configuração gravou vence, e o `.env` é o valor
 * de partida (`valorDaInstalacao`, `lib/instalacao/config.ts`).
 *
 * Devolve o texto CRU de cada chave, e não um número: quem o interpreta é `interpretarRetencao`
 * (`./politica.ts`), que resolve lixo para o lado seguro E devolve a frase de aviso para o log. Coagir aqui
 * jogaria o aviso fora — a mesma razão pela qual `lib/env.ts` guarda estas chaves como `z.string()`.
 *
 * Nada aqui lança: `valorDaInstalacao` degrada para o `.env` quando o banco não responde, com aviso no log. Uma
 * poda que parasse porque a tela de configuração não pôde ser lida seria o inverso do que o cron existe para
 * fazer.
 *
 * ⚠️ Cada chave é lida por um `valorDaInstalacao("NOME")` com o nome LITERAL, de propósito: a sonda
 * `tests/unit/painel-nao-promete-o-que-nao-cumpre.test.ts` procura exatamente esse formato para provar que
 * todo campo que a tela oferece tem leitor. Montar o nome por variável deixaria a tela oferecendo campo que
 * parece funcionar e a sonda cega.
 */
import { valorDaInstalacao } from "@/lib/instalacao/config";

export interface PrazosDaInstalacao {
  JOB_QUEUE_RETENTION_DAYS?: string;
  AUDIT_LOG_RETENTION_DAYS?: string;
  CALENDAR_MIRROR_RETENTION_DAYS?: string;
  CASE_CHAT_RETENTION_DAYS?: string;
  PASSAGEM_RETENTION_DAYS?: string;
  CASE_ALERT_RETENTION_DAYS?: string;
  PROSPECCAO_RETENTION_DAYS?: string;
  JEV_OBSERVACOES_RETENTION_DAYS?: string;
  DRAFT_RETENTION_DAYS?: string;
  GOLDEN_CANDIDATES_RETENTION_DAYS?: string;
  AI_TELEMETRY_RETENTION_DAYS?: string;
  PACING_LEDGER_RETENTION_DAYS?: string;
  OUTBOUND_COPIES_RETENTION_DAYS?: string;
  LEAD_CHECKPOINT_RETENTION_DAYS?: string;
  LEAD_CAPTURE_RETENTION_DAYS?: string;
}

/** `null` (nem tela nem `.env` definiram) vira `undefined`: o padrão do código assume, sem aviso. */
function cru(leitura: { valor: string | null }): string | undefined {
  return leitura.valor ?? undefined;
}

export async function prazosDaInstalacao(): Promise<PrazosDaInstalacao> {
  const [
    fila,
    auditoria,
    espelho,
    conversaDoCaso,
    passagem,
    avisoDeCaso,
    prospeccao,
    observacoesDoJev,
    rascunho,
    candidatosDoGolden,
    telemetriaDeIa,
    ritmoDeEnvio,
    copiasEnviadas,
    checkpoints,
    captacao,
  ] = await Promise.all([
    valorDaInstalacao("JOB_QUEUE_RETENTION_DAYS"),
    valorDaInstalacao("AUDIT_LOG_RETENTION_DAYS"),
    valorDaInstalacao("CALENDAR_MIRROR_RETENTION_DAYS"),
    valorDaInstalacao("CASE_CHAT_RETENTION_DAYS"),
    valorDaInstalacao("PASSAGEM_RETENTION_DAYS"),
    valorDaInstalacao("CASE_ALERT_RETENTION_DAYS"),
    valorDaInstalacao("PROSPECCAO_RETENTION_DAYS"),
    valorDaInstalacao("JEV_OBSERVACOES_RETENTION_DAYS"),
    valorDaInstalacao("DRAFT_RETENTION_DAYS"),
    valorDaInstalacao("GOLDEN_CANDIDATES_RETENTION_DAYS"),
    valorDaInstalacao("AI_TELEMETRY_RETENTION_DAYS"),
    valorDaInstalacao("PACING_LEDGER_RETENTION_DAYS"),
    valorDaInstalacao("OUTBOUND_COPIES_RETENTION_DAYS"),
    valorDaInstalacao("LEAD_CHECKPOINT_RETENTION_DAYS"),
    valorDaInstalacao("LEAD_CAPTURE_RETENTION_DAYS"),
  ]);

  return {
    JOB_QUEUE_RETENTION_DAYS: cru(fila),
    AUDIT_LOG_RETENTION_DAYS: cru(auditoria),
    CALENDAR_MIRROR_RETENTION_DAYS: cru(espelho),
    CASE_CHAT_RETENTION_DAYS: cru(conversaDoCaso),
    PASSAGEM_RETENTION_DAYS: cru(passagem),
    CASE_ALERT_RETENTION_DAYS: cru(avisoDeCaso),
    PROSPECCAO_RETENTION_DAYS: cru(prospeccao),
    JEV_OBSERVACOES_RETENTION_DAYS: cru(observacoesDoJev),
    DRAFT_RETENTION_DAYS: cru(rascunho),
    GOLDEN_CANDIDATES_RETENTION_DAYS: cru(candidatosDoGolden),
    AI_TELEMETRY_RETENTION_DAYS: cru(telemetriaDeIa),
    PACING_LEDGER_RETENTION_DAYS: cru(ritmoDeEnvio),
    OUTBOUND_COPIES_RETENTION_DAYS: cru(copiasEnviadas),
    LEAD_CHECKPOINT_RETENTION_DAYS: cru(checkpoints),
    LEAD_CAPTURE_RETENTION_DAYS: cru(captacao),
  };
}
