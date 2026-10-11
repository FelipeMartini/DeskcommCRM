/**
 * ACESSO DIRETO AO CRM MOSTRA A BARRA LATERAL — MESMO COM O COOKIE ANTIGO.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * A rota de SSO gravava o cookie `deskcomm_embedded=1` por 7 dias sempre que o
 * ProjetoSocial abria o CRM embutido, e a casca (`AppShell`) o lia para esconder
 * a barra lateral. O cookie é do domínio do CRM: depois de UM uso embutido, todo
 * acesso direto pelo endereço (outra aba, favorito, digitando a URL) abria sem
 * barra lateral até o cookie vencer. O dono relatou em 11/10/2026.
 *
 * ─── O que se prova ─────────────────────────────────────────────────────────
 *
 * A casca de verdade, montada com o cookie antigo no navegador:
 *   1. acesso direto (sem quadro, sem parâmetro) → a barra lateral EXISTE;
 *   2. `?embedded=true` → a barra lateral some (o modo embutido continua vivo);
 *   3. dentro de um quadro → a barra lateral some, mesmo sem parâmetro;
 *   4. sair do parâmetro (navegação interna fora do quadro) devolve a barra.
 *
 * ─── O que NÃO se prova ─────────────────────────────────────────────────────
 *
 * O jsdom não tem quadro de verdade: o caso 3 simula `paginaEstaEmQuadro`. A
 * medida no navegador (iframe real dentro do ProjetoSocial) é da doutrina de QA
 * Visual do repositório, não deste arquivo.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ambiente = vi.hoisted(() => ({
  parametro: null as string | null,
  emQuadro: false,
}));

vi.mock("next/navigation", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("next/navigation")),
  useSearchParams: () => ({
    get: (chave: string) => (chave === "embedded" ? ambiente.parametro : null),
  }),
}));
vi.mock("@/lib/ui/modo-embutido", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("@/lib/ui/modo-embutido")),
  paginaEstaEmQuadro: () => ambiente.emQuadro,
}));

// As peças da casca que NÃO são o assunto ficam de fora, como em
// `rodape-ocupado-durante-a-chamada.test.tsx`; a barra lateral é o marcador.
vi.mock("@/components/shell/Sidebar", () => ({
  Sidebar: () => <aside data-testid="barra-lateral" />,
}));
vi.mock("@/components/shell/TopBar", () => ({ TopBar: () => null }));
vi.mock("@/components/shell/BarraDeProgressoNavegacao", () => ({
  BarraDeProgressoNavegacao: () => null,
}));
vi.mock("@/components/shell/BarraInferior", () => ({ BarraInferior: () => null }));
vi.mock("@/hooks/atendimento/useSinalDePresenca", () => ({ useSinalDePresenca: () => {} }));
vi.mock("@/hooks/notifications/useInboundMessageAlerts", () => ({
  useInboundMessageAlerts: () => {},
}));
vi.mock("@/hooks/notifications/useCrmAlerts", () => ({ useCrmAlerts: () => {} }));
vi.mock("@/hooks/calls/useInboundCallAlerts", () => ({ useInboundCallAlerts: () => {} }));
vi.mock("@/lib/notifications/notify_open", () => ({ useNotifyOpenFromServiceWorker: () => {} }));

import { AppShell } from "@/app/app/_components/AppShell";
import { ProvedorDaOcupacaoDoRodape } from "@/lib/ui/rodape-ocupado";

const COOKIE_ANTIGO = "deskcomm_embedded=1; path=/";

function casca() {
  return (
    <ProvedorDaOcupacaoDoRodape>
      <AppShell sidebarCollapsed={false} podeAtender={false}>
        <p>o miolo da tela</p>
      </AppShell>
    </ProvedorDaOcupacaoDoRodape>
  );
}

describe("AppShell — barra lateral no acesso direto", () => {
  beforeEach(() => {
    ambiente.parametro = null;
    ambiente.emQuadro = false;
    // O navegador do dono guardava este cookie por 7 dias depois de um uso embutido.
    document.cookie = COOKIE_ANTIGO;
  });
  afterEach(() => {
    document.cookie = "deskcomm_embedded=; path=/; max-age=0";
  });

  it("o cookie antigo está de fato no navegador do teste (senão o caso 1 não prova nada)", () => {
    expect(document.cookie).toContain("deskcomm_embedded=1");
  });

  it("acesso direto, com o cookie antigo presente: a barra lateral aparece", () => {
    render(casca());
    expect(screen.getByTestId("barra-lateral")).toBeTruthy();
    expect(screen.getByText("o miolo da tela")).toBeTruthy();
  });

  it("`?embedded=true`: a barra lateral some", () => {
    ambiente.parametro = "true";
    render(casca());
    expect(screen.queryByTestId("barra-lateral")).toBeNull();
    expect(screen.getByText("o miolo da tela")).toBeTruthy();
  });

  it("dentro de um quadro, sem parâmetro: a barra lateral some", () => {
    ambiente.emQuadro = true;
    render(casca());
    expect(screen.queryByTestId("barra-lateral")).toBeNull();
  });

  it("fora do quadro, quando o parâmetro some da URL, a barra lateral volta", () => {
    ambiente.parametro = "true";
    const tela = render(casca());
    expect(screen.queryByTestId("barra-lateral")).toBeNull();

    ambiente.parametro = null;
    tela.rerender(casca());
    // `useSearchParams` devolve outro objeto a cada navegação; o mock devolve um
    // novo a cada chamada, o que reexecuta o efeito como a navegação real faz.
    expect(screen.getByTestId("barra-lateral")).toBeTruthy();
  });
});
