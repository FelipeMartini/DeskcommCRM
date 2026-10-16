---
impacto: nada_mudou
secao: corrigido
titulo: Com a claude-ponte ligada, a descrição das fotos que os clientes mandam passa pela ponte, e não vai mais direto para a Anthropic
---

Só afeta quem liga a `claude-ponte` (`CLAUDE_PONTE_*`); sem as variáveis nada muda. O worker que lê as mídias recebidas montava a configuração de IA à mão e esquecia a ponte: para uma organização atendida por ela, a descrição de uma foto caía na chave da instalação e a imagem seguia direto para `api.anthropic.com`, fora do proxy e do rastro dele. Agora o worker monta a configuração pela mesma função que o atendimento já usa e escolhe o provedor pela mesma regra do turno do agente: a organização atendida pela ponte descreve a foto pela ponte, com a chave dela, e a credencial **própria** da organização continua valendo antes de tudo.

Quem lê as fotos agora também falha fechado: com a variável da ponte inválida para uma organização da lista, a descrição é recusada antes de qualquer byte sair, em vez de cair no provedor padrão. O áudio não mudou nesta correção. Sem migration; nada precisa ser feito ao atualizar.
