/**
 * A CONFERÊNCIA DO VALOR DE UMA CHAVE DA INSTALAÇÃO, ANTES DE GRAVAR.
 *
 * A ação de salvar (`app/actions/admin/salvarConfiguracaoDaInstalacao.ts`) só sabia recusar o campo
 * vazio. Para a maioria das chaves isso basta (um e-mail, um segredo opaco). Para as do OmniRouter não:
 * um endereço com `usuário:senha@`, um `?x=` ou um texto qualquer ficaria gravado, a tela diria "salvo,
 * já está valendo" e a primeira mensagem de um cliente é que descobriria o defeito (o motor recusa a
 * configuração torta e a organização atendida fica sem IA, de propósito — ver `lib/ai/omnirouter.ts`).
 * Aqui a recusa vem na hora, em português, no lugar certo.
 *
 * Puro: sem banco, sem `env`, sem log. Devolve o motivo da recusa (texto para a pessoa) ou `null`. NUNCA
 * repete o valor digitado na mensagem — pode ser um segredo, ou uma URL com senha dentro.
 */
import { OmniRouterInvalidoError, lerEnderecoDoOmniRouter } from "@/lib/ai/omnirouter";

const EXEMPLO_DO_ENDERECO = "https://omnirouter.example.com";

const MOTIVO_DO_ENDERECO: Record<string, string> = {
  nao_e_url: `O endereço do OmniRouter precisa ser uma URL completa, como ${EXEMPLO_DO_ENDERECO}.`,
  esquema: "O endereço do OmniRouter precisa começar com http:// ou https://.",
  credenciais_na_url:
    "O endereço do OmniRouter não pode ter usuário e senha dentro dele. A chave vai no campo próprio.",
  consulta_ou_fragmento:
    "O endereço do OmniRouter não pode ter ? nem # — só o endereço e, se for o caso, o caminho (como /v1).",
};

/**
 * `null` = pode gravar. Texto = o que a pessoa precisa corrigir. Chave sem regra própria passa direto:
 * o comportamento das outras chaves não muda.
 */
export function recusaDoValor(chave: string, valor: string): string | null {
  const limpo = valor.trim();
  switch (chave) {
    case "OMNIROUTER_BASE_URL": {
      try {
        lerEnderecoDoOmniRouter(limpo);
        return null;
      } catch (erro) {
        if (erro instanceof OmniRouterInvalidoError) {
          return MOTIVO_DO_ENDERECO[erro.motivo] ?? MOTIVO_DO_ENDERECO.nao_e_url!;
        }
        throw erro;
      }
    }
    case "OMNIROUTER_API_KEY":
      // Mesma regra do módulo: chave com espaço ou quebra de linha é lixo de colagem, e o cabeçalho
      // `Authorization` sairia quebrado — um 401 sem relação aparente com o campo.
      return /\s/.test(limpo)
        ? "A chave do OmniRouter não pode ter espaços nem quebras de linha. Cole só a chave."
        : null;
    case "OMNIROUTER_PARA_TODAS": {
      const v = limpo.toLowerCase();
      return v === "true" || v === "false"
        ? null
        : "Escreva true para oferecer o OmniRouter a todas as organizações, ou false para só as que você escolher.";
    }
    default:
      return null;
  }
}
