---
impacto: capacidade_nova
secao: adicionado
titulo: Os prazos de retenção de dados passam a ser editados em Admin › Configuração
---

Os 15 prazos de guarda do histórico (auditoria, passagens, telemetria da IA, leads captados, conversa do caso, prospecção, fila de tarefas e os demais) viviam só no `.env` do servidor: trocar um era editar arquivo e reiniciar. Agora aparecem no grupo **Retenção de dados** de Admin › Configuração, cada um com o que guarda, o padrão e o mínimo aceito, e a rotina diária de limpeza lê o que a tela gravou — o `.env` continua valendo como valor de partida, e "Voltar ao padrão" devolve a palavra a ele.

O valor é conferido **antes** de gravar: só o número de dias, sem letras nem vírgula, não abaixo do mínimo de cada prazo (o mesmo que o banco já impõe) e não acima de 36 500 dias. A mensagem de recusa nunca repete o que foi digitado. A auditoria registra quem trocou qual prazo **e para quantos dias** (um prazo não é segredo, e "quem encurtou a guarda da auditoria" é exatamente o que a trilha precisa responder).

Vale para todas as organizações da instalação. Quem não mexer em nada continua com o comportamento de antes: os padrões do código e do `.env` não mudaram. Sem migration. A retenção da mídia (por organização) e os dois prazos do arquivo bruto de webhooks (`WEBHOOK_LOG_*`) seguem como estavam.
