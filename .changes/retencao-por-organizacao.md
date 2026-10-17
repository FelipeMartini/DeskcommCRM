---
impacto: capacidade_nova
secao: adicionado
titulo: Cada empresa pode encurtar o prazo em que guarda o dado pessoal de terceiros (leads, conversas, prospecção e agenda)
---

Até aqui o prazo de retenção do dado pessoal era um só para a instalação inteira. Agora cada empresa pode **encurtá-lo** para os quatro tipos que são dado pessoal de terceiros: **captação de leads**, **conversa do caso**, **prospecção** e **espelho da agenda**. Em Configurações › Empresa, o novo cartão "Retenção de dados pessoais" mostra, ao lado de cada campo, o prazo da instalação e o mínimo; campo em branco segue a instalação. A mídia já tinha o prazo dela e não muda.

**A empresa só encurta.** O prazo da instalação continua valendo para todas (a poda global roda antes), e a passada nova do cron apaga além do menor dos dois. Um número igual ou maior que o da instalação é aceito, mas a tela avisa que não terá efeito. Os mínimos ficam fixos dentro do banco: captação 30 dias, conversa do caso 90, prospecção 90 e espelho da agenda 7; abaixo disso a gravação é recusada (e um valor torto guardado à mão no banco é ignorado, nunca elevado a apagador de rastro recente). Auditoria, fila, telemetria e registros de webhook seguem iguais para todas as empresas: a trilha de uma empresa não pode ser apagada por ela mesma.

Quem grava é administrador da empresa (ou da plataforma), com o segundo fator em dia, e cada mudança entra na trilha como `org.retention_updated`. Cada empresa que teve dado apagado pela passada própria ganha uma linha `retention.organization_sweep` na trilha dela. A prospecção mantém as três guardas de sempre: o que está na fila, em envio ou marcado como suprimido nunca é apagado. A poda de uma empresa não encosta nas outras, e uma empresa que falha deixa a rodada em 500 com a falha nomeada sem impedir as demais.

Exige a migration 0695 (cinco funções novas, sem tabela nem coluna); o `update.sh` aplica pelo baseline. Quem não escolher prazo nenhum não percebe diferença: o comportamento de hoje é o mesmo.
