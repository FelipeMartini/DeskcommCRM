---
impacto: capacidade_nova
secao: adicionado
titulo: Cada organização atendida pela claude-ponte pode ligar e desligar a assinatura de IA na tela de Credenciais; o padrão é ligada
---

Quem opera uma instalação com a claude-ponte (`CLAUDE_PONTE_*` no `.env`) ganha, em **IA › Credenciais**, um card "Assinatura de IA da instalação" com um interruptor, visível só para as organizações que a instalação atende. **O padrão é ligada**: nenhuma organização precisa marcar nada, e a que já usa a ponte continua usando. Só administradores mudam o interruptor; gerentes veem o estado. A escolha fica em `organizations.settings.llm.ponte_ativa` (só o valor booleano `false` desliga; ausente ou torto vale ligada) e é auditada como `ai.claude_bridge_toggled`.

Desligada, o motor deixa de usar a assinatura **para aquela organização**: ela cai na chave da instalação (`ANTHROPIC_API_KEY`), se houver, ou fica sem IA até religar — e a tela de agente, a rota de versões e a publicação dizem a verdade ("falta credencial") em vez de deixar publicar um agente que o motor recusaria a cada mensagem. A credencial **própria** da organização continua valendo antes da ponte em qualquer caso, e desligar não apaga nem toca credencial. A lista `CLAUDE_PONTE_ORGS` segue mandando sobre quem **pode** usar a ponte; o interruptor é a organização abrindo mão de uma oferta da instalação. Sem migration (o valor mora no `settings` que já existe); nada precisa ser feito ao atualizar.
