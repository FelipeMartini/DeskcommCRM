---
impacto: nada_mudou
secao: corrigido
titulo: Quem entra no CRM pelo endereço direto volta a ver a barra lateral, mesmo depois de usá-lo embutido em outro sistema
---

Só afeta quem abre o CRM dentro de outro sistema (a tela embutida do ProjetoSocial). A entrada única (SSO) gravava um cookie de 7 dias para lembrar o modo embutido, e a casca o lia: depois de um uso embutido, qualquer acesso direto ao endereço do CRM, em outra aba, favorito ou digitando a URL, abria sem a barra lateral até o cookie vencer. Agora o modo embutido vale só para a aba de agora (a página dentro de um quadro, ou aberta com `?embedded=true`) e o cookie deixa de ser gravado e de ser lido; os que já estão nos navegadores são ignorados e vencem sozinhos. Sem migration; nada precisa ser feito ao atualizar.
