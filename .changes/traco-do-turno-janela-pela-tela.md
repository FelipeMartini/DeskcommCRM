---
impacto: nada_mudou
secao: corrigido
titulo: A leitura dos traços do turno passa a respeitar o prazo de telemetria de IA que a tela de Configuração grava
---

A rota `GET /api/v1/ai/turn-traces` lia o prazo de telemetria de IA direto do `.env`, então mudar o campo na tela de Configuração alterava o expurgo (cron) mas não a janela que a rota consulta. Agora ela lê o valor pelo mesmo caminho do expurgo: o que a tela gravou vence, e o `.env` segue como valor de partida. Quem nunca mexeu no campo vê o mesmo prazo de antes (400 dias, piso de 100). Sem migration; nada precisa ser feito ao atualizar.
