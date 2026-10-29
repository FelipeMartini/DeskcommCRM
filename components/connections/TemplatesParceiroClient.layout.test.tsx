/**
 * O FORMULÁRIO DE MODELO NÃO PODE VOLTAR A PEDIR MAIS LARGURA DO QUE A TELA TEM.
 *
 * ## Por que jsdom, se jsdom não calcula layout
 *
 * Porque a pergunta aqui NÃO é geometria, é contrato de classe — e essa o jsdom
 * responde. Geometria de verdade (scrollWidth × clientWidth em 375px) é
 * `tests/e2e/modelos-cabem-em-375.spec.ts`, que precisa de browser; esta é a
 * catraca barata que roda no `verify` e diz QUAL classe sumiu, em segundos.
 *
 * ## O defeito que ela prende (#3702)
 *
 * O formulário nasce `grid ... lg:grid-cols-[1fr_20rem]`. Abaixo de `lg` o grid
 * fica com uma coluna implícita `auto`, que não encolhe abaixo do `min-content`
 * dos filhos — e os campos eram `flex-1` com `min-width: auto` (o `size` padrão
 * de um `<input>`, ~170px) ou largura fixa (`w-56` no idioma). Duas dessas na
 * mesma linha somavam mais que os 343px úteis de uma tela de 375px, e o `<main>`
 * passava a rolar de lado: o operador via os campos cortados na direita, sem
 * barra de rolagem para alcançá-los.
 *
 * Cada `it` abaixo é UMA das quatro coisas que fazem o formulário caber. Se
 * alguém apagar uma delas, o nome do caso diz o que voltou a quebrar.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { data: { templates: [] } }, isLoading: false }),
  useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn().mockResolvedValue({ data: { templates: [] } }), post: vi.fn() },
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "es-PY" }));

import { TemplatesParceiroClient } from "./TemplatesParceiroClient";

/** Abre o formulário de criar e devolve o elemento, já montado. */
async function abrirFormulario(): Promise<HTMLElement> {
  const { container } = render(<TemplatesParceiroClient />);
  await userEvent.click(screen.getByRole("button", { name: "Criar modelo" }));
  const form = container.querySelector<HTMLElement>("[data-formulario-do-modelo]");
  if (!form) throw new Error("o formulário de criar não abriu");
  return form;
}

function classes(el: Element | null): string[] {
  if (!el) throw new Error("elemento ausente — a estrutura do formulário mudou");
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

describe("formulário de modelo — a largura cabe em 375px", () => {
  it("abaixo de lg o grid tem UMA coluna de largura livre (não a coluna implícita `auto`)", async () => {
    const form = await abrirFormulario();
    // `grid-cols-1` é `repeat(1, minmax(0, 1fr))`: a coluna pode encolher. Sem
    // ele, a coluna implícita `auto` fica no `min-content` do filho mais largo e
    // empurra o container.
    expect(classes(form)).toContain("grid-cols-1");
    expect(classes(form)).toContain("lg:grid-cols-[1fr_20rem]");
  });

  it("os dois filhos do grid têm `min-w-0` — sem isso o item não encolhe", async () => {
    const form = await abrirFormulario();
    const filhos = Array.from(form.children);
    expect(filhos.length, "o grid do formulário tem dois filhos (campos e prévia)").toBe(2);
    for (const filho of filhos) {
      expect(classes(filho), `filho sem min-w-0: "${filho.textContent?.slice(0, 30)}"`).toContain(
        "min-w-0",
      );
    }
  });

  it("nenhum campo `flex-1` fica com `min-width: auto` (o `size` padrão do input)", async () => {
    const form = await abrirFormulario();
    const flexiveis = Array.from(form.querySelectorAll<HTMLElement>(".flex-1"));
    expect(flexiveis.length, "o formulário tem campos flexíveis").toBeGreaterThan(0);
    for (const campo of flexiveis) {
      expect(
        classes(campo),
        `campo flex-1 sem min-w-0: ${campo.tagName.toLowerCase()} "${campo.getAttribute("aria-label") ?? ""}"`,
      ).toContain("min-w-0");
    }
  });

  it("o seletor de idioma não tem largura fixa abaixo de `sm`", async () => {
    const form = await abrirFormulario();
    const idioma = form.querySelector<HTMLElement>('[aria-label="Idioma"]');
    const cls = classes(idioma);
    // `w-56` (224px) solto era metade do orçamento de 343px; a largura fixa só
    // pode existir daí para cima.
    expect(cls, "`w-56` sem prefixo volta a fixar 224px no celular").not.toContain("w-56");
    expect(cls).toContain("w-full");
    expect(cls).toContain("sm:w-56");
  });

  it("a prévia quebra palavra longa em vez de alargar o balão", async () => {
    const form = await abrirFormulario();
    // A prévia só existe depois de haver conteúdo — vazio, ela é um convite.
    await userEvent.type(form.querySelector<HTMLElement>('[aria-label="Conteúdo"]')!, "Hola {{1}}");
    const previa = form.querySelector<HTMLElement>("[data-previa-do-modelo]");
    expect(classes(previa)).toContain("max-w-full");
    expect(classes(form.querySelector("[data-previa-do-modelo] p.whitespace-pre-wrap"))).toContain(
      "break-words",
    );
  });
});
