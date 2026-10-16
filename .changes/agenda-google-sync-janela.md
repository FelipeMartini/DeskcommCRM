---
impacto: nada_mudou
secao: corrigido
titulo: Sincronização da agenda do Google conclui páginas grandes sem lotar o cache
---
A sincronização da agenda do Google agora retoma páginas pendentes a cada minuto,
aplica cada página em lote e mantém no cache somente eventos dentro da janela de
cobertura. Isso evita que séries recorrentes com ocorrências distantes atrasem a
leitura dos próximos dias e permite que esses eventos bloqueiem horários no CRM.
O aviso de cobertura considera apenas os horários futuros do período visível,
sem alertar por dias passados que a sincronização não precisa cobrir.
