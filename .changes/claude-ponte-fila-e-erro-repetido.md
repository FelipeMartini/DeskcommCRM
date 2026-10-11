---
impacto: nada_mudou
secao: corrigido
titulo: Com a claude-ponte ligada, o agente espera a vez em vez de tomar 529, e a falha repetida do provedor deixa de aparecer como "erro desconhecido"
---

Só afeta quem liga a `claude-ponte` (`CLAUDE_PONTE_*`); sem as variáveis nada muda. O proxy atende uma chamada por vez, mas o worker conversa com vários clientes ao mesmo tempo: duas conversas simultâneas já bastavam para o proxy responder "ocupado" (529), gastando uma das tentativas do turno e recomeçando-o. Agora as chamadas dessa instalação para a ponte entram numa fila no próprio processo e saem uma de cada vez, na ordem de chegada; se a vaga não abrir em 2 minutos, a tentativa é refeita mais tarde pela fila do worker, com o código `provedor_indisponivel`. O cancelamento do turno também tira a chamada da fila.

Corrigido junto: quando o provedor respondia 429, 503 ou 529 e o SDK esgotava as tentativas, a tela de Execuções mostrava "erro desconhecido" sem status, porque o SDK embrulha o erro numa exceção de repetição. A classificação agora olha o erro de dentro e mostra o motivo certo (limite, indisponível ou credencial recusada) com o status HTTP. Sem migration; nada precisa ser feito ao atualizar.
