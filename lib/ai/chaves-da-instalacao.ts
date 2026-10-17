/**
 * AS CHAVES DE IA DA INSTALAÇÃO, LIDAS PELO APP — Anthropic, OpenAI e OpenRouter.
 *
 * São as chaves que a instalação inteira usa quando a organização não tem credencial própria
 * (`ai_provider_credentials`) e o OmniRouter não a atende: o degrau "chave da instalação" da escada de
 * `resolveOrgLlmConfig`. Até aqui moravam só no `.env`, e trocar uma exigia editar o arquivo no servidor e
 * reiniciar. Agora o administrador da plataforma as grava em Credenciais (`platform_config`, cifradas) e o
 * `.env` fica como PISO: o que a tela gravou vence, e o `.env` responde quando o banco não tem a chave.
 *
 * Cada chave é lida pelo resolvedor (`valorDaInstalacao`) com o nome por extenso: é o que mantém o painel
 * honesto (`tests/unit/painel-nao-promete-o-que-nao-cumpre.test.ts` reprova campo editável cujo leitor
 * ainda lê direto do ambiente). O motor do worker lê as mesmas fontes por outro caminho
 * (`lib/instalacao/config-sql.ts`), pela mesma regra.
 *
 * Nada aqui lança: banco fora ou linha ilegível valem "sem chave neste degrau", e quem chama segue para o
 * degrau de baixo ou para o motivo claro de "nenhuma chave configurada".
 */

import { valorDaInstalacao } from "@/lib/instalacao/config";

/** Os provedores cuja chave de instalação o painel guarda. */
export type ProvedorComChaveDaInstalacao = "anthropic" | "openai" | "openrouter";

export interface ChavesDeIaDaInstalacao {
  readonly anthropic: string | null;
  readonly openai: string | null;
  readonly openrouter: string | null;
}

/** Texto limpo ou `null`: chave vazia ou só de espaços não conta como chave. */
function chaveOuNula(valor: string | null | undefined): string | null {
  const limpo = (valor ?? "").trim();
  return limpo === "" ? null : limpo;
}

async function lerSemLancar(ler: () => Promise<{ valor: string | null }>): Promise<string | null> {
  try {
    return chaveOuNula((await ler()).valor);
  } catch {
    return null;
  }
}

/** As três chaves em vigor: o que a tela gravou, e senão o `.env`. */
export async function chavesDeIaDaInstalacao(): Promise<ChavesDeIaDaInstalacao> {
  const [anthropic, openai, openrouter] = await Promise.all([
    lerSemLancar(() => valorDaInstalacao("ANTHROPIC_API_KEY")),
    lerSemLancar(() => valorDaInstalacao("OPENAI_API_KEY")),
    lerSemLancar(() => valorDaInstalacao("OPENROUTER_API_KEY")),
  ]);
  return { anthropic, openai, openrouter };
}

/** A chave de UM provedor — `null` quando a instalação não tem. */
export async function chaveDeIaDaInstalacao(
  provedor: ProvedorComChaveDaInstalacao,
): Promise<string | null> {
  switch (provedor) {
    case "anthropic":
      return lerSemLancar(() => valorDaInstalacao("ANTHROPIC_API_KEY"));
    case "openai":
      return lerSemLancar(() => valorDaInstalacao("OPENAI_API_KEY"));
    case "openrouter":
      return lerSemLancar(() => valorDaInstalacao("OPENROUTER_API_KEY"));
  }
}

/** O `.env` (ou qualquer fonte parecida) visto por `lerAmbiente`: só nomes e textos. */
export type FonteComChavesDeIa = Readonly<Record<string, string | undefined>>;

/**
 * A fonte de ambiente que `lerAmbiente` lê ("a instalação tem chave de Anthropic/OpenAI/OpenRouter?")
 * com as três chaves de IA trocadas pelo que o PAINEL gravou.
 *
 * Só sobrescreve quando o banco tem uma linha para a chave (`fonte: "banco"`): ela vale mesmo vazia,
 * porque é alguém que esvaziou o campo de propósito e o motor também a lê assim. Sem linha, a fonte
 * recebida (o `.env`) segue valendo — é o piso. Banco fora não derruba a tela: devolve a fonte intacta.
 */
export async function ambienteComAsChavesDoPainel(
  base: FonteComChavesDeIa = process.env,
): Promise<FonteComChavesDeIa> {
  const saida: Record<string, string | undefined> = { ...base };
  const leituras: Array<[string, () => Promise<{ valor: string | null; fonte: string }>]> = [
    ["ANTHROPIC_API_KEY", () => valorDaInstalacao("ANTHROPIC_API_KEY")],
    ["OPENAI_API_KEY", () => valorDaInstalacao("OPENAI_API_KEY")],
    ["OPENROUTER_API_KEY", () => valorDaInstalacao("OPENROUTER_API_KEY")],
  ];
  await Promise.all(
    leituras.map(async ([nome, ler]) => {
      try {
        const lido = await ler();
        if (lido.fonte === "banco") saida[nome] = lido.valor ?? "";
      } catch {
        // Mantém o que a fonte recebida diz: o piso.
      }
    }),
  );
  return saida;
}
