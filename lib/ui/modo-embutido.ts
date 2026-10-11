/**
 * A TELA ESTÁ EMBUTIDA NO PROJETOSOCIAL? (e por isso esconde a barra lateral)
 *
 * A resposta descreve ESTA aba, AGORA: ou a página está dentro de um quadro
 * (`iframe`), ou esta visita chegou com `?embedded=true`. Nada além disso.
 *
 * ─── O que NÃO entra (e por que) ────────────────────────────────────────────
 *
 * Um cookie de "já esteve embutido". A rota de SSO gravava um cookie de modo
 * embutido por 7 dias e o `AppShell` o lia: quem abrisse o CRM dentro do ProjetoSocial
 * uma vez passava a abri-lo SEM barra lateral em qualquer acesso direto ao
 * endereço, durante uma semana — o cookie é do domínio do CRM, e o navegador o
 * manda em toda aba, embutida ou não. A lembrança de uma visita não diz nada
 * sobre a visita de agora. O quadro, esse sim, diz: `window.self !== window.top`
 * é verdadeiro em todo documento embutido, em qualquer navegação interna, sem
 * precisar de parâmetro nem de cookie.
 *
 * Vigiado por `tests/unit/modo-embutido.test.ts` (a regra) e por
 * `tests/unit/appshell-barra-lateral-em-acesso-direto.test.tsx` (a casca de
 * verdade, com o cookie antigo presente).
 */
export interface SinaisDoModoEmbutido {
  /** `window.self !== window.top` — esta página vive dentro de um quadro. */
  emQuadro: boolean;
  /** O valor de `?embedded=` desta visita (`null`/ausente se não veio). */
  parametro: string | null | undefined;
}

export function estaEmbutido({ emQuadro, parametro }: SinaisDoModoEmbutido): boolean {
  return emQuadro || parametro === "true";
}

/** Lê o sinal do quadro no navegador; no servidor (sem `window`) nunca está em quadro. */
export function paginaEstaEmQuadro(): boolean {
  if (typeof window === "undefined") return false;
  // Acessar `window.top` é seguro entre origens: só a comparação de referência
  // é feita, nenhuma propriedade do outro documento é lida.
  return window.self !== window.top;
}
