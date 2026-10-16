import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CartaoDoOmniRouter } from "./CartaoDoOmniRouter";

/**
 * O aviso de que a IA da organização vem do OmniRouter da instalação.
 *
 * Só informa: não tem botão, campo nem chave. O que o cartão afirma é verdade só quando
 * `omniRouterServeAOrganizacao` diz que sim — quem o desenha (as páginas de credenciais e de agentes)
 * é que decide quando mostrá-lo; aqui se confere o que ele diz e que fala a língua da pessoa.
 */
describe("CartaoDoOmniRouter", () => {
  it("em português (o padrão): o título, o aviso e que só o administrador da plataforma decide", () => {
    const html = renderToStaticMarkup(<CartaoDoOmniRouter />);
    expect(html).toContain('data-testid="cartao-do-omnirouter"');
    expect(html).toContain("IA da instalação (OmniRouter)");
    expect(html).toContain("Esta instalação oferece IA de texto a esta organização pelo OmniRouter");
    expect(html).toContain("Só o administrador da plataforma liga ou desliga o OmniRouter");
    expect(html).toContain("Uma chave própria, se existir, continua valendo antes dela");
  });

  it("⭐ é só um aviso: sem campo, botão ou formulário (nem para digitar chave)", () => {
    const html = renderToStaticMarkup(<CartaoDoOmniRouter />);
    expect(html).not.toMatch(/<(input|button|textarea|select|form)\b/i);
  });

  it("em espanhol: título e aviso traduzidos, sem sobrar o texto em português", () => {
    const html = renderToStaticMarkup(<CartaoDoOmniRouter idioma="es" />);
    expect(html).toContain("IA de la instalación (OmniRouter)");
    expect(html).toContain("Esta instalación ofrece IA de texto a esta organización mediante el OmniRouter");
    expect(html).not.toContain("Esta instalação oferece");
  });
});
