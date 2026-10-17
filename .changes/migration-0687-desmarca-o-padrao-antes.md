---
impacto: nada_mudou
secao: corrigido
titulo: A atualização do banco que define o Haiku 5.5 como modelo padrão deixa de quebrar no meio
---

A migration 0687 (Claude Haiku 5.5 como modelo padrão da Anthropic) marcava o novo padrão antes de desmarcar o anterior. Como o banco só aceita **um** modelo padrão por provedor, quem já tinha outro modelo da Anthropic como padrão (o caso de toda instalação que passou pela geração anterior) via a atualização parar no meio com erro de unicidade, e a janela precisava de um comando extra escrito à mão na frente. Agora a migration desmarca o padrão anterior primeiro e marca o novo depois; reaplicar com o Haiku 5.5 já padrão não muda nada.

O mesmo conserto entrou no `baseline.sql` (o que o kit de instalação e o `update.sh` aplicam), que até aqui não trazia a 0687: instalação nova e atualização passam a terminar com o Haiku 5.5 como único padrão da Anthropic, e as organizações que ainda usavam o Sonnet 4.6 ou o Haiku 4.5 como modelo padrão passam ao Haiku 5.5, como a migration já fazia. Quem aplicou a 0687 por outro caminho (com o comando extra) já está nesse estado e não precisa fazer nada.
