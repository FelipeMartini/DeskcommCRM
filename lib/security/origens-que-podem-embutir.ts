/**
 * QUEM PODE PÔR ESTE CRM DENTRO DE UM QUADRO (`iframe`) — e só quem está na lista.
 *
 * Toda resposta do CRM leva `X-Frame-Options: DENY` (gravado em build, `next.config.ts`), então nenhum
 * site consegue embuti-lo: é a cerca contra clique-sequestro (clickjacking). Um operador que usa o CRM
 * dentro de outro sistema SEU (o ProjetoSocial, aqui) pode abrir uma exceção por variável de ambiente,
 * em RUNTIME — a imagem é única, então header de build não serve:
 *
 *   EMBED_FRAME_ANCESTORS=https://social.exemplo.com.br
 *
 * O `proxy.ts` põe então `Content-Security-Policy: frame-ancestors <origens>` na resposta. O navegador
 * dá precedência ao `frame-ancestors` sobre o `X-Frame-Options` (CSP nível 3), e o `DENY` segue valendo
 * para toda origem que NÃO está na lista.
 *
 * ─── A regra é estreita de propósito, e erro de digitação FECHA em vez de abrir ──────────────────────
 *
 * Só entra um pedaço que seja uma ORIGEM `https` exata: host com ponto, sem porta, sem caminho, sem
 * barra no fim, sem usuário, sem curinga. O que não casa é DESCARTADO por inteiro (nunca "consertado"):
 * `*`, `https://*.exemplo.com.br`, `http://…`, `https://exemplo.com.br/app`, `localhost`, IP e
 * `'self'` não abrem nada. Vazio ou tudo inválido = lista vazia = nenhuma exceção = `DENY` como antes.
 * No máximo 3 origens: a lista existe para um sistema, não para uma frota. O `'self'` nunca entra (o
 * próprio CRM também não se embute: o `DENY` de hoje já barra isso).
 *
 * Vigiado por `tests/unit/embed-so-para-o-social.test.ts`.
 */
const LIMITE_DE_ORIGENS = 3;

/** `https://` + um ou mais rótulos de host + TLD alfabético. Sem porta, caminho, usuário ou curinga. */
const ORIGEM_HTTPS = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Lê o valor bruto da variável e devolve só as origens válidas (minúsculas, sem repetição). */
export function origensQuePodemEmbutir(bruto: string | null | undefined): string[] {
  if (!bruto) return [];
  const aceitas: string[] = [];
  for (const pedaco of bruto.split(/[\s,]+/)) {
    const origem = pedaco.toLowerCase();
    if (!ORIGEM_HTTPS.test(origem)) continue;
    if (!aceitas.includes(origem)) aceitas.push(origem);
  }
  return aceitas.slice(0, LIMITE_DE_ORIGENS);
}

/** O valor do cabeçalho `Content-Security-Policy`, ou `null` quando não há exceção a abrir. */
export function cabecalhoQuadroPermitido(origens: readonly string[]): string | null {
  return origens.length === 0 ? null : `frame-ancestors ${origens.join(" ")}`;
}
