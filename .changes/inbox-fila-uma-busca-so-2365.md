---
impacto: nada_mudou
secao: corrigido
titulo: A lista do inbox carrega numa busca só — a Fila não pedia a mesma lista duas vezes
---

Ao abrir o inbox, a aba Fila pedia a mesma lista duas vezes e jogava a primeira resposta fora. Quando a resposta sobre o atendimento automático chegava depois da lista, a Fila aparecia primeiro sem as conversas que esperavam o robô, e elas só entravam cerca de um segundo depois. Agora a Fila só consulta depois de saber esse fato — sai UMA requisição, com o filtro definitivo — e as outras abas continuam consultando na hora, como antes. A espera aparece como esqueleto de carregamento, nunca como caixa de entrada vazia.

Você não precisa fazer nada.

Contribuição de @webtecnica, a partir do PR #2365 de @melgarafael.
