/**
 * O CARTÃO "Retenção de dados pessoais" de Configurações › Empresa (migration 0695).
 *
 * O que se prova, com o componente real montado no DOM: o teto (prazo da
 * instalação) aparece ao lado de cada campo; o número que não alcança o teto
 * ganha o aviso "sem efeito" — porque a empresa só encurta —; o que está abaixo
 * do mínimo é recusado na tela, antes de qualquer chamada; o salvar manda o
 * ESTADO DESEJADO inteiro (campo vazio = voltar à instalação) e só diz "salvo"
 * depois de o servidor confirmar; cada erro do servidor vira a frase certa.
 *
 * Limite declarado: isto NÃO prova a página inteira (que lê o banco e a
 * instalação) nem a gravação — essa é do invariante contra Postgres de verdade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  atualizar: vi.fn(),
  sucesso: vi.fn(),
  erro: vi.fn(),
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("sonner", () => ({ toast: { success: mocks.sucesso, error: mocks.erro } }));
vi.mock("@/app/actions/settings/updateRetencaoDaOrganizacao", () => ({
  updateRetencaoDaOrganizacao: mocks.atualizar,
}));

import { RetencaoDaOrganizacaoForm } from "@/app/app/settings/tenant/_retencao";

const GLOBAIS = { captacao: 365, conversa_do_caso: 365, prospeccao: 365, espelho_da_agenda: 90 };

function montar(initial = {}) {
  return render(<RetencaoDaOrganizacaoForm initial={initial} globais={GLOBAIS} />);
}

const campo = (tipo: string) => screen.getByTestId(`retencao-${tipo}`) as HTMLInputElement;
const salvar = () => screen.getByRole("button", { name: "Salvar prazos" }) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.atualizar.mockResolvedValue({ ok: true, prazos: {} });
});
afterEach(cleanup);

describe("RetencaoDaOrganizacaoForm — o que a tela mostra", () => {
  it("mostra os quatro campos, com o prazo da instalação como sugestão e o mínimo na ajuda", () => {
    montar();
    for (const [tipo, global] of Object.entries(GLOBAIS)) {
      expect(campo(tipo).value).toBe("");
      expect(campo(tipo).placeholder).toBe(String(global));
    }
    expect(screen.getAllByText(/Prazo da instalação: 365 dias\. Mínimo: 30 dias\./)).toHaveLength(
      1,
    );
    expect(screen.getByText(/Prazo da instalação: 90 dias\. Mínimo: 7 dias\./)).toBeTruthy();
  });

  it("mostra o que a empresa já escolheu, e o salvar nasce desligado (nada mudou)", () => {
    montar({ captacao: 40, espelho_da_agenda: 10 });
    expect(campo("captacao").value).toBe("40");
    expect(campo("espelho_da_agenda").value).toBe("10");
    expect(campo("prospeccao").value).toBe("");
    expect(salvar().disabled).toBe(true);
  });

  it("número igual ou maior que a instalação ganha o aviso 'sem efeito'; menor, não", async () => {
    const u = userEvent.setup();
    montar();
    await u.type(campo("captacao"), "365");
    expect(screen.getByTestId("retencao-captacao-sem-efeito")).toBeTruthy();

    await u.clear(campo("captacao"));
    await u.type(campo("captacao"), "200");
    expect(screen.queryByTestId("retencao-captacao-sem-efeito")).toBeNull();
  });
});

describe("RetencaoDaOrganizacaoForm — o que a tela recusa antes de chamar o servidor", () => {
  it("abaixo do mínimo mostra o erro do campo e o salvar não chama a action", async () => {
    const u = userEvent.setup();
    montar();
    await u.type(campo("prospeccao"), "10");

    expect(screen.getByTestId("retencao-prospeccao-erro").textContent).toBe(
      "O mínimo é de 90 dias.",
    );
    await u.click(salvar());
    expect(mocks.atualizar).not.toHaveBeenCalled();
    expect(mocks.erro).toHaveBeenCalledWith(
      "Algum prazo está fora do permitido. Confira os campos em vermelho.",
    );
  });

  it("texto e decimal não são prazo", async () => {
    const u = userEvent.setup();
    montar();
    await u.type(campo("captacao"), "abc");
    expect(screen.getByTestId("retencao-captacao-erro").textContent).toBe(
      "Use um número inteiro de dias.",
    );
    await u.clear(campo("captacao"));
    await u.type(campo("captacao"), "60.5");
    expect(screen.getByTestId("retencao-captacao-erro").textContent).toBe(
      "Use um número inteiro de dias.",
    );
  });
});

describe("RetencaoDaOrganizacaoForm — salvar", () => {
  it("manda o estado desejado INTEIRO (vazio = null) e só então diz que salvou", async () => {
    const u = userEvent.setup();
    mocks.atualizar.mockResolvedValue({
      ok: true,
      prazos: { captacao: 60, espelho_da_agenda: 14 },
    });
    montar({ conversa_do_caso: 120 });

    await u.type(campo("captacao"), "60");
    await u.type(campo("espelho_da_agenda"), "14");
    await u.clear(campo("conversa_do_caso"));
    await u.click(salvar());

    await waitFor(() => expect(mocks.sucesso).toHaveBeenCalledWith("Prazos de retenção salvos."));
    expect(mocks.atualizar).toHaveBeenCalledWith({
      captacao: 60,
      conversa_do_caso: null,
      prospeccao: null,
      espelho_da_agenda: 14,
    });
    // depois de salvo, o botão desliga de novo (o salvo virou a referência)
    await waitFor(() => expect(salvar().disabled).toBe(true));
  });

  it("'Seguir a instalação em todos' limpa os quatro campos e habilita o salvar", async () => {
    const u = userEvent.setup();
    montar({ captacao: 40, prospeccao: 95 });
    await u.click(screen.getByTestId("retencao-seguir-instalacao"));
    for (const tipo of Object.keys(GLOBAIS)) expect(campo(tipo).value).toBe("");
    expect(salvar().disabled).toBe(false);
  });

  it.each([
    ["forbidden_role", "Só quem administra a empresa pode mudar a retenção."],
    ["forbidden_tenant", "Só quem administra a empresa pode mudar a retenção."],
    ["mfa_required", "Confirme o segundo fator de autenticação para continuar."],
    ["validation_failed", "Algum prazo está fora do permitido. Confira os campos em vermelho."],
    ["nao_gravou", "Não consegui salvar. Tente novamente."],
    ["db_error", "Não consegui salvar. Tente novamente."],
  ])("erro %s vira a frase certa, sem dizer 'salvo'", async (erro, frase) => {
    const u = userEvent.setup();
    mocks.atualizar.mockResolvedValue({ ok: false, error: erro });
    montar();
    await u.type(campo("captacao"), "60");
    await u.click(salvar());

    await waitFor(() => expect(mocks.erro).toHaveBeenCalledWith(frase));
    expect(mocks.sucesso).not.toHaveBeenCalled();
    // o que foi digitado continua na tela: quem errou não perde o trabalho
    expect(campo("captacao").value).toBe("60");
  });
});
