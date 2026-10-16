---
impacto: nada_mudou
secao: corrigido
titulo: Sem SMTP, o painel de atualização avisa quem administra, em vez de deixar a descoberta para quem reclama
---

Numa instalação de servidor único sem SMTP configurado, o único lugar que dizia isso era o log do `update.sh`: o painel de atualização (Configurações → Atualização do sistema) exibia o log e mais nada, e quem administrava a VPS só descobria o problema quando alguém reclamava de não receber a recuperação de senha. O painel passa a mostrar o aviso "Sem SMTP configurado" no topo, em todos os estados da tela — o que não sai e onde se configura (em /admin/email). O aviso lê o SMTP pelo caminho de leitura que já existe (o mesmo que a tela /admin/email usa) e com a régua do "esqueci a senha": host E remetente, banco que respondeu, e só no servidor único. Fora dele o login tem e-mail próprio, e a tela fica calada; com SMTP configurado nada muda e nenhum aviso aparece.

A tela final do instalador (`install-single-server.sh`) para de mandar rodar o `update.sh` sem motivo: passa a dizer que é ele que leva o SMTP do CRM ao serviço de login — a mesma correção que a saída do `update.sh` recebeu.

Contribuição de @webtecnica, a partir da issue #2755.
