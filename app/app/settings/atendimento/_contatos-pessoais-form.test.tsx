import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";

import { ContatosPessoaisForm } from "./_contatos-pessoais-form";

/**
 * OS DOIS INTERRUPTORES TÊM SUPERFÍCIE (invariante "toda configuração tem porta").
 *
 * Provado aqui: nascem como a configuração diz (desligados por padrão), o Salvar só
 * destrava quando algo mudou, o PATCH leva os DOIS campos (o servidor mescla, e
 * mandar só o que mudou deixaria a tela sem saber o estado final), e a falha do
 * servidor não finge que gravou.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({ apiClient: { patch: vi.fn() } }));

const patch = vi.mocked(apiClient.patch);
const DESLIGADOS = { comando_pelo_celular: false, novos_nascem_pessoais: false };

beforeEach(() => {
  vi.clearAllMocks();
  patch.mockResolvedValue({ data: { comando_pelo_celular: true, novos_nascem_pessoais: false } });
});

describe("Contatos pessoais — os interruptores da organização", () => {
  it("nasce como a configuração diz, com o Salvar travado", () => {
    render(
      <ContatosPessoaisForm
        initial={{ comando_pelo_celular: true, novos_nascem_pessoais: false }}
      />,
    );
    expect(screen.getByTestId("pessoal-comando_pelo_celular")).toBeChecked();
    expect(screen.getByTestId("pessoal-novos_nascem_pessoais")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Salvar contatos pessoais" })).toBeDisabled();
  });

  it("ligar um destrava o Salvar, e o PATCH leva os dois campos", async () => {
    render(<ContatosPessoaisForm initial={DESLIGADOS} />);

    fireEvent.click(screen.getByTestId("pessoal-comando_pelo_celular"));
    expect(screen.getByText("Há mudanças não salvas.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Salvar contatos pessoais" }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith("/api/v1/settings/contatos-pessoais", {
      comando_pelo_celular: true,
      novos_nascem_pessoais: false,
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Contatos pessoais salvos."));
    // Gravou: o aviso some e o botão volta a travar.
    await waitFor(() =>
      expect(screen.queryByText("Há mudanças não salvas.")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Salvar contatos pessoais" })).toBeDisabled(),
    );
  });

  it("ligar e desligar de volta não é mudança", () => {
    render(<ContatosPessoaisForm initial={DESLIGADOS} />);
    fireEvent.click(screen.getByTestId("pessoal-novos_nascem_pessoais"));
    fireEvent.click(screen.getByTestId("pessoal-novos_nascem_pessoais"));
    expect(screen.getByRole("button", { name: "Salvar contatos pessoais" })).toBeDisabled();
  });

  it("mostra o que o servidor gravou, não o que a tela pediu", async () => {
    patch.mockResolvedValue({ data: { comando_pelo_celular: false, novos_nascem_pessoais: true } });
    render(<ContatosPessoaisForm initial={DESLIGADOS} />);

    fireEvent.click(screen.getByTestId("pessoal-comando_pelo_celular"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar contatos pessoais" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(screen.getByTestId("pessoal-comando_pelo_celular")).not.toBeChecked();
    expect(screen.getByTestId("pessoal-novos_nascem_pessoais")).toBeChecked();
  });

  it("falha do servidor → avisa, não diz que salvou e mantém o Salvar liberado", async () => {
    patch.mockRejectedValue(new Error("Não consegui salvar."));
    render(<ContatosPessoaisForm initial={DESLIGADOS} />);

    fireEvent.click(screen.getByTestId("pessoal-comando_pelo_celular"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar contatos pessoais" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Não consegui salvar."));
    expect(toast.success).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Salvar contatos pessoais" })).toBeEnabled(),
    );
  });
});
