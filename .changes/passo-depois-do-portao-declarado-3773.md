---
impacto: nada_mudou
secao: alterado
titulo: "Passo novo abaixo do portão do piso ocioso deixa de nascer desligado sem ninguém ver"
---

O portão do piso ocioso é uma saída antecipada da rota inteira: o que está abaixo dele só roda quando o recurso tem trabalho. Quem acrescentasse um passo novo ali ganhava um passo que não rodava na instalação parada — o caso mais comum —, sem erro, sem log e sem teste vermelho.

Agora as cinco rotas que passam pelo portão declaram, no próprio arquivo, os passos que rodam depois dele, e uma cerca lê essas rotas e reprova quando a lista não bate com o código, apontando arquivo e linha. Quem acrescentar um passo abaixo do portão vê o vermelho e decide, com a informação na frente, se ele pode mesmo ser pulado.

Nada muda para quem já roda: a rota sai pelo portão com a mesma resposta e o mesmo status de antes, e as cinco rotas não foram tocadas em comportamento — só ganharam a declaração.

Crédito: @webtecnica.
