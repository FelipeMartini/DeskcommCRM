/**
 * QUANDO A TELA SE DIZ "EMBUTIDA" — a regra pura (`lib/ui/modo-embutido.ts`).
 *
 * O defeito que isto cerca: o CRM aberto DIRETO pelo endereço aparecia sem barra
 * lateral. A casca lia um cookie de 7 dias que a rota de SSO gravava ao entrar
 * embutida no ProjetoSocial, e tratava "esteve embutida alguma vez" como "está
 * embutida agora". A regra certa só enxerga a aba de agora: quadro ou parâmetro.
 *
 * A casca de verdade, com o cookie antigo presente, é provada em
 * `appshell-barra-lateral-em-acesso-direto.test.tsx`.
 */
import { describe, expect, it } from "vitest";

import { estaEmbutido, paginaEstaEmQuadro } from "@/lib/ui/modo-embutido";

describe("estaEmbutido", () => {
  it("acesso direto, sem quadro e sem parâmetro: NÃO está embutida (a barra lateral aparece)", () => {
    expect(estaEmbutido({ emQuadro: false, parametro: null })).toBe(false);
    expect(estaEmbutido({ emQuadro: false, parametro: undefined })).toBe(false);
  });

  it("dentro de um quadro está embutida, com ou sem parâmetro (navegação interna perde o `?embedded`)", () => {
    expect(estaEmbutido({ emQuadro: true, parametro: null })).toBe(true);
    expect(estaEmbutido({ emQuadro: true, parametro: "true" })).toBe(true);
  });

  it("`?embedded=true` embute esta visita", () => {
    expect(estaEmbutido({ emQuadro: false, parametro: "true" })).toBe(true);
  });

  it("só o valor exato `true` conta: `false`, `1`, vazio e variações de caixa não embutem", () => {
    for (const parametro of ["false", "1", "", "TRUE", "True", " true"]) {
      expect(
        estaEmbutido({ emQuadro: false, parametro }),
        `parametro=${JSON.stringify(parametro)}`,
      ).toBe(false);
    }
  });
});

describe("paginaEstaEmQuadro", () => {
  it("numa aba comum (o jsdom do teste não tem quadro) devolve false", () => {
    expect(window.self).toBe(window.top);
    expect(paginaEstaEmQuadro()).toBe(false);
  });
});
