---
impacto: nada_mudou
secao: corrigido
titulo: Mensagem que chega junto da passagem para humano não derruba mais a trava do contato
---

Quando uma mensagem chegava no mesmo instante em que o contato era passado para humano (ou pedia para sair da lista), o banco podia derrubar uma das duas operações por travamento mútuo — e, se a derrubada fosse a passagem para humano, a trava não era gravada e o agente podia seguir respondendo. Agora as duas seguem a mesma ordem: uma espera a outra e as duas terminam. A atualização aplica a mudança de banco sozinha.

Contribuição de @webtecnica (#2969), a partir da issue #2884.
