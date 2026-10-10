import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CampanhaWhatsapp } from "@/lib/ai/elegibilidade/campanha";
import { apiClient } from "@/lib/api/client";

import { CampanhasPorPalavraForm } from "./_campanhas-form";

/**
 * O EDITOR DA CAMPANHA POR PALAVRA (a dívida J20 do user-journey-map).
 *
 * Provado aqui: a lista aparece como está, o Salvar só destrava com mudança válida,
 * a frase curta demais trava (é o mesmo piso do servidor), a ordem é a que a pessoa
 * montou, o PUT leva a lista INTEIRA (com o que a tela não edita), e quem não é
 * admin vê a lista sem controle nenhum.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({ apiClient: { put: vi.fn() } }));

const put = vi.mocked(apiClient.put);
const CANAL = "22222222-2222-4222-8222-222222222222";
const AGENTE = "44444444-4444-4444-8444-444444444444";
const CANAIS = [{ id: CANAL, nome: "Número do negócio" }];

const LANCAMENTO: CampanhaWhatsapp = {
  id: "lancamento",
  label: "Lançamento",
  match: { tipo: "contains", valor: "quero saber mais sobre o lançamento" },
  agent_id: AGENTE,
  segmento: "incorporadoras",
};
const FEIRA: CampanhaWhatsapp = {
  id: "feira",
  match: { tipo: "starts_with", valor: "vim pela feira de negócios" },
};

function montar(sobre: Partial<Parameters<typeof CampanhasPorPalavraForm>[0]> = {}) {
  return render(
    <CampanhasPorPalavraForm
      initial={[LANCAMENTO, FEIRA]}
      canais={CANAIS}
      descartadas={0}
      podeEditar
      {...sobre}
    />,
  );
}
const salvar = () => screen.getByRole("button", { name: "Salvar campanhas" });

beforeEach(() => {
  vi.clearAllMocks();
  put.mockImplementation(async (_caminho, corpo) => ({ data: corpo }));
});

describe("Campanhas por palavra — a lista", () => {
  it("mostra cada campanha como está, com o Salvar travado", () => {
    montar();
    const lancamento = screen.getByTestId("campanha-lancamento");
    expect(within(lancamento).getByLabelText("Nome da campanha")).toHaveValue("Lançamento");
    expect(within(lancamento).getByLabelText("A mensagem")).toHaveValue("contains");
    expect(within(lancamento).getByLabelText("Frase da campanha")).toHaveValue(
      "quero saber mais sobre o lançamento",
    );
    expect(within(lancamento).getByLabelText("Vale em")).toHaveValue("");
    expect(within(screen.getByTestId("campanha-feira")).getByLabelText("A mensagem")).toHaveValue(
      "starts_with",
    );
    expect(salvar()).toBeDisabled();
  });

  it("sem campanha nenhuma diz isso, e o Salvar fica travado", () => {
    montar({ initial: [] });
    expect(screen.getByTestId("campanhas-vazio")).toBeInTheDocument();
    expect(salvar()).toBeDisabled();
  });

  it("frase específica não leva aviso; frase curta leva o aviso de que casa conversa comum", () => {
    montar({ initial: [LANCAMENTO, { id: "curta", match: { tipo: "contains", valor: "preço" } }] });
    expect(screen.queryByTestId("campanha-lancamento-aviso")).not.toBeInTheDocument();
    expect(screen.getByTestId("campanha-curta-aviso")).toHaveTextContent("Frase curta");
  });
});

describe("Campanhas por palavra — editar e salvar", () => {
  it("editar a frase destrava o Salvar e o PUT leva a lista inteira, com o que a tela não edita", async () => {
    montar();
    fireEvent.change(
      within(screen.getByTestId("campanha-feira")).getByLabelText("Frase da campanha"),
      {
        target: { value: "  vim pela feira do bairro  " },
      },
    );
    expect(salvar()).toBeEnabled();
    fireEvent.click(salvar());

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/api/v1/settings/campanhas-whatsapp", {
      campanhas: [
        LANCAMENTO,
        { id: "feira", match: { tipo: "starts_with", valor: "vim pela feira do bairro" } },
      ],
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Campanhas salvas."));
    // O toast sai de dentro da transição: o botão só volta de «Salvando…» um render depois.
    await waitFor(() => expect(salvar()).toBeDisabled());
  });

  it("nome em branco sai do corpo (o servidor não aceita rótulo vazio)", async () => {
    montar();
    fireEvent.change(
      within(screen.getByTestId("campanha-lancamento")).getByLabelText("Nome da campanha"),
      {
        target: { value: "   " },
      },
    );
    fireEvent.click(salvar());
    await waitFor(() => expect(put).toHaveBeenCalled());
    const enviada = (put.mock.calls[0]![1] as { campanhas: CampanhaWhatsapp[] }).campanhas[0]!;
    expect(enviada).not.toHaveProperty("label");
    expect(enviada).toMatchObject({ agent_id: AGENTE, segmento: "incorporadoras" });
  });

  it("escolher um número grava o canal; voltar a «Todos» tira a chave", async () => {
    montar();
    const select = within(screen.getByTestId("campanha-feira")).getByLabelText("Vale em");
    fireEvent.change(select, { target: { value: CANAL } });
    fireEvent.click(salvar());
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect((put.mock.calls[0]![1] as { campanhas: CampanhaWhatsapp[] }).campanhas[1]).toMatchObject(
      {
        channel_session_id: CANAL,
      },
    );

    fireEvent.change(within(screen.getByTestId("campanha-feira")).getByLabelText("Vale em"), {
      target: { value: "" },
    });
    await waitFor(() => expect(salvar()).toBeEnabled());
    fireEvent.click(salvar());
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(
      (put.mock.calls[1]![1] as { campanhas: CampanhaWhatsapp[] }).campanhas[1],
    ).not.toHaveProperty("channel_session_id");
  });

  it("frase curta demais trava o Salvar e mostra o motivo", () => {
    montar();
    fireEvent.change(
      within(screen.getByTestId("campanha-feira")).getByLabelText("Frase da campanha"),
      {
        target: { value: "  a  " },
      },
    );
    expect(screen.getByTestId("campanha-feira-erro")).toBeInTheDocument();
    expect(salvar()).toBeDisabled();
  });

  it("subir e descer mudam a ordem que vai ao servidor (a primeira que casa vence)", async () => {
    montar();
    fireEvent.click(
      within(screen.getByTestId("campanha-feira")).getByRole("button", { name: "Subir" }),
    );
    fireEvent.click(salvar());
    await waitFor(() => expect(put).toHaveBeenCalled());
    const ids = (put.mock.calls[0]![1] as { campanhas: CampanhaWhatsapp[] }).campanhas.map(
      (c) => c.id,
    );
    expect(ids).toEqual(["feira", "lancamento"]);
  });

  it("os extremos não têm para onde ir", () => {
    montar();
    expect(
      within(screen.getByTestId("campanha-lancamento")).getByRole("button", { name: "Subir" }),
    ).toBeDisabled();
    expect(
      within(screen.getByTestId("campanha-feira")).getByRole("button", { name: "Descer" }),
    ).toBeDisabled();
  });

  it("remover tira só aquela campanha", async () => {
    montar();
    fireEvent.click(
      within(screen.getByTestId("campanha-lancamento")).getByRole("button", { name: "Remover" }),
    );
    expect(screen.queryByTestId("campanha-lancamento")).not.toBeInTheDocument();
    fireEvent.click(salvar());
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(
      (put.mock.calls[0]![1] as { campanhas: CampanhaWhatsapp[] }).campanhas.map((c) => c.id),
    ).toEqual(["feira"]);
  });

  it("apagar a última campanha é salvável (lista vazia)", async () => {
    montar({ initial: [FEIRA] });
    fireEvent.click(screen.getByRole("button", { name: "Remover" }));
    fireEvent.click(salvar());
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith("/api/v1/settings/campanhas-whatsapp", { campanhas: [] }),
    );
  });

  it("adicionar cria uma campanha em branco que só salva depois de ter frase", async () => {
    montar({ initial: [] });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar campanha" }));

    expect(screen.queryByTestId("campanhas-vazio")).not.toBeInTheDocument();
    expect(salvar()).toBeDisabled();

    const nova = screen.getAllByLabelText("Frase da campanha")[0]!;
    fireEvent.change(nova, { target: { value: "quero conhecer o showroom" } });
    expect(salvar()).toBeEnabled();
    fireEvent.click(salvar());

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const enviada = (put.mock.calls[0]![1] as { campanhas: CampanhaWhatsapp[] }).campanhas;
    expect(enviada).toHaveLength(1);
    expect(enviada[0]).toMatchObject({
      match: { tipo: "contains", valor: "quero conhecer o showroom" },
    });
    expect(enviada[0]!.id).toMatch(/^camp-[0-9a-f]{8}$/);
  });

  it("falha do servidor → avisa, não diz que salvou e mantém o Salvar liberado", async () => {
    put.mockRejectedValue(new Error("Não consegui salvar."));
    montar();
    fireEvent.change(
      within(screen.getByTestId("campanha-feira")).getByLabelText("Frase da campanha"),
      {
        target: { value: "vim pela feira do bairro" },
      },
    );
    fireEvent.click(salvar());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Não consegui salvar."));
    expect(toast.success).not.toHaveBeenCalled();
    await waitFor(() => expect(salvar()).toBeEnabled());
  });
});

describe("Campanhas por palavra — itens que o sistema ignora", () => {
  it("avisa, libera o Salvar mesmo sem edição, e depois de salvar o aviso some", async () => {
    montar({ descartadas: 2 });
    expect(screen.getByTestId("campanhas-descartadas")).toBeInTheDocument();
    expect(salvar()).toBeEnabled();

    fireEvent.click(salvar());
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(screen.queryByTestId("campanhas-descartadas")).not.toBeInTheDocument();
    await waitFor(() => expect(salvar()).toBeDisabled());
  });
});

describe("Campanhas por palavra — quem não é admin", () => {
  it("vê a lista, com o aviso, sem campo editável, sem botão de adicionar e sem Salvar", () => {
    montar({ podeEditar: false });
    expect(screen.getByTestId("campanhas-so-leitura")).toBeInTheDocument();
    for (const campo of screen.getAllByLabelText("Frase da campanha")) expect(campo).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Adicionar campanha" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Salvar campanhas" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remover" })).not.toBeInTheDocument();
  });
});
