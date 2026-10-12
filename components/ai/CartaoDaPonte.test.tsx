/**
 * O card do interruptor da claude-ponte (`components/ai/CartaoDaPonte.tsx`).
 *
 * O que se trava: o estado que o servidor leu aparece; o administrador liga e desliga (e a chamada vai
 * com o valor novo); o gerente só vê (interruptor travado, com o motivo); o estado só muda na tela
 * DEPOIS de o servidor confirmar — uma gravação que falhou deixa o interruptor onde estava.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  put: vi.fn(),
  refresh: vi.fn(),
  sucesso: vi.fn(),
  erroApi: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/api/client", () => ({ apiClient: { put: mocks.put } }));
vi.mock("sonner", () => ({ toast: { success: mocks.sucesso, error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: mocks.erroApi }));

import { CartaoDaPonte } from "./CartaoDaPonte";

const usuario = () => userEvent.setup({ delay: null });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.put.mockResolvedValue({ data: { ativa: false, mudou: true } });
});

describe("CartaoDaPonte", () => {
  it("⭐ ligada (o padrão): mostra 'Ligada' com o interruptor marcado e sem aviso", () => {
    render(<CartaoDaPonte ativa podeEditar />);
    expect(screen.getByTestId("cartao-da-ponte-estado").textContent).toBe("Ligada");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("cartao-da-ponte-aviso")).toBeNull();
  });

  it("desligada: mostra 'Desligada' e o aviso do que acontece sem a assinatura", () => {
    render(<CartaoDaPonte ativa={false} podeEditar />);
    expect(screen.getByTestId("cartao-da-ponte-estado").textContent).toBe("Desligada");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("cartao-da-ponte-aviso").textContent).toContain("ficam sem IA");
  });

  it("⭐ o administrador desliga: chama PUT com `ativa: false`, atualiza a tela e recarrega a página", async () => {
    const user = usuario();
    render(<CartaoDaPonte ativa podeEditar />);
    await user.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(screen.getByTestId("cartao-da-ponte-estado").textContent).toBe("Desligada"),
    );
    expect(mocks.put).toHaveBeenCalledWith("/api/v1/ai/ponte", { ativa: false });
    expect(mocks.sucesso).toHaveBeenCalledWith("Assinatura de IA desligada.");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("cartao-da-ponte-aviso")).toBeTruthy();
  });

  it("o administrador religa: chama PUT com `ativa: true` e some o aviso", async () => {
    const user = usuario();
    mocks.put.mockResolvedValue({ data: { ativa: true, mudou: true } });
    render(<CartaoDaPonte ativa={false} podeEditar />);
    await user.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(screen.getByTestId("cartao-da-ponte-estado").textContent).toBe("Ligada"),
    );
    expect(mocks.put).toHaveBeenCalledWith("/api/v1/ai/ponte", { ativa: true });
    expect(mocks.sucesso).toHaveBeenCalledWith("Assinatura de IA ligada.");
    expect(screen.queryByTestId("cartao-da-ponte-aviso")).toBeNull();
  });

  it("⭐ gravação que falha NÃO muda o interruptor: mostra o erro e não recarrega", async () => {
    const user = usuario();
    mocks.put.mockRejectedValue(new Error("falhou"));
    render(<CartaoDaPonte ativa podeEditar />);
    await user.click(screen.getByRole("switch"));
    await waitFor(() => expect(mocks.erroApi).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("cartao-da-ponte-estado").textContent).toBe("Ligada");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.sucesso).not.toHaveBeenCalled();
  });

  it("⭐ o gerente só vê: interruptor travado, sem chamada, com o motivo na tela", async () => {
    const user = usuario();
    render(<CartaoDaPonte ativa podeEditar={false} />);
    const interruptor = screen.getByRole("switch");
    expect((interruptor as HTMLButtonElement).disabled).toBe(true);
    await user.click(interruptor);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(screen.getByText("Só administradores mudam isto.")).toBeTruthy();
  });

  it("o administrador não vê o aviso de 'só administradores'", () => {
    render(<CartaoDaPonte ativa podeEditar />);
    expect(screen.queryByText("Só administradores mudam isto.")).toBeNull();
  });
});
