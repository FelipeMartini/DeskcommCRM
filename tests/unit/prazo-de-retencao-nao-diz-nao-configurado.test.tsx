import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * O PRAZO DE RETENÇÃO SEM VALOR GRAVADO NÃO É "NÃO CONFIGURADO" (16/10 → 17/10/2026).
 *
 * Os 15 prazos de Admin › Configuração valem o padrão do produto enquanto nada é gravado na tela nem
 * vem do `.env`: a poda roda e o piso do código cumpre. O rótulo, porém, dizia "Não configurado" em âmbar
 * — o mesmo que uma chave de e-mail sem valor, onde a frase é verdade (sem ela nada sai). Quem lê "não
 * configurado" conclui que a retenção não funciona, ou grava um número só para o aviso sumir.
 *
 * O catálogo agora diz quais chaves têm valor de fábrica (`padraoQuandoAusente`) e a tela escolhe o
 * rótulo por esse dado, não pelo grupo: chave nova com padrão herda a frase certa, e chave SEM padrão
 * continua dizendo a verdade.
 */
vi.mock("@/app/actions/admin/salvarConfiguracaoDaInstalacao", () => ({
  salvarConfiguracaoDaInstalacao: vi.fn(),
  voltarConfiguracaoAoPadrao: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CampoEditavel, Origem } from "@/components/admin/CampoDaInstalacao";
import { CATALOGO_DA_INSTALACAO } from "@/lib/instalacao/catalogo";
import type { EstadoParaTela } from "@/lib/instalacao/config";

const AUSENTE = {
  fonte: "ausente",
  configurado: false,
  valorVisivel: null,
  last4: null,
} as unknown as EstadoParaTela;

describe("rótulo de origem da configuração da instalação", () => {
  it("ausente SEM padrão continua dizendo 'Não configurado'", () => {
    render(<Origem fonte="ausente" idioma="pt-BR" />);
    expect(screen.getByText("Não configurado")).toBeTruthy();
  });

  it("ausente COM padrão diz que usa o padrão do produto, e não 'Não configurado'", () => {
    render(<Origem fonte="ausente" idioma="pt-BR" temPadrao />);
    expect(screen.getByText("Usando o padrão do produto")).toBeTruthy();
    expect(screen.queryByText("Não configurado")).toBeNull();
  });

  it("valor gravado na tela ou vindo do arquivo não muda por ter padrão", () => {
    const { rerender } = render(<Origem fonte="banco" idioma="pt-BR" temPadrao />);
    expect(screen.getByText("Definido aqui nesta tela")).toBeTruthy();
    rerender(<Origem fonte="ambiente" idioma="pt-BR" temPadrao />);
    expect(screen.getByText("Vem do arquivo de instalação do servidor")).toBeTruthy();
  });

  it("o texto existe em espanhol (não cai em português dentro da tela em espanhol)", () => {
    render(<Origem fonte="ausente" idioma="es" temPadrao />);
    expect(screen.getByText("Usando el valor predeterminado del producto")).toBeTruthy();
  });

  it("o campo de um prazo de retenção, sem nada gravado, mostra o padrão", () => {
    const prazo = CATALOGO_DA_INSTALACAO.find(
      (c) => c.grupo === "retencao" && c.controle === "edita",
    );
    expect(prazo).toBeDefined();
    render(<CampoEditavel linha={{ definicao: prazo!, estado: AUSENTE }} idioma="pt-BR" />);
    expect(screen.getByText("Usando o padrão do produto")).toBeTruthy();
    expect(screen.queryByText("Não configurado")).toBeNull();
  });

  it("o campo de uma chave sem padrão (serviço de e-mail), sem nada gravado, segue 'Não configurado'", () => {
    const semPadrao = CATALOGO_DA_INSTALACAO.find((c) => c.chave === "RESEND_API_KEY");
    expect(semPadrao).toBeDefined();
    render(<CampoEditavel linha={{ definicao: semPadrao!, estado: AUSENTE }} idioma="pt-BR" />);
    expect(screen.getByText("Não configurado")).toBeTruthy();
  });
});

describe("catálogo: quem declara padrão de fábrica", () => {
  const DE_RETENCAO = CATALOGO_DA_INSTALACAO.filter((c) => c.grupo === "retencao");

  it("todos os prazos de retenção declaram (o cron cumpre o padrão deles)", () => {
    expect(DE_RETENCAO.length).toBeGreaterThan(0);
    expect(DE_RETENCAO.filter((c) => c.padraoQuandoAusente !== true).map((c) => c.chave)).toEqual(
      [],
    );
  });

  it("nenhuma chave de outro grupo declara (a frase só vale onde o código cumpre um padrão)", () => {
    const de_fora = CATALOGO_DA_INSTALACAO.filter(
      (c) => c.grupo !== "retencao" && c.padraoQuandoAusente === true,
    );
    expect(de_fora.map((c) => c.chave)).toEqual([]);
  });
});
