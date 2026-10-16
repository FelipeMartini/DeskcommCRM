---
impacto: exige_acao
secao: alterado
titulo: O OmniRouter vira a rota de IA configurável da instalação, com a escolha feita por organização
---

A IA de texto agora pode passar por um **OmniRouter** que a própria instalação configura, sem tocar em arquivo: o administrador da plataforma grava o endereço, a chave e a oferta geral em Admin › Configuração › Credenciais (o `.env` continua valendo como piso, e o que a tela grava vence). O endereço é conferido na hora de salvar — sem `usuário:senha@`, sem `?` nem `#` — e a chave não pode ter espaço; a mensagem de recusa nunca repete o que foi digitado, e a auditoria guarda só o fato e os últimos 4 caracteres.

**Quem o OmniRouter atende é escolha de cada organização**, no cartão dela (Admin › Organizações › Inteligência Artificial & OmniRouter), com três caminhos: herdar a conexão da instalação (nenhuma chave é copiada: trocar a chave em Credenciais vale para todas, sem republicar nada), usar uma chave individual (guardada cifrada, como credencial própria) ou recusar (vale também contra a oferta geral `OMNIROUTER_PARA_TODAS`). Sem escolha, vale a oferta geral. Uma chave própria da organização continua valendo antes de qualquer outra; o OmniRouter vem logo depois dela e antes da chave da Anthropic da instalação, e só serve o provedor `anthropic`. A configuração torta de uma organização atendida falha com o motivo (`omnirouter_invalido:<motivo>`, visível em Execuções) em vez de cair em silêncio numa chave que ela nunca escolheu.

Vale para o app e para o worker (o motor do agente e a descrição de foto leem a mesma configuração da instalação, com o `.env` como piso). Os portões de salvar e publicar agente passam a perguntar ao OmniRouter se ele serve aquela organização, então um agente em `anthropic` não é mais recusado só por a instalação não ter a chave da Anthropic. A organização atendida vê um cartão informativo nas Credenciais e no agente; ele não tem botão — quem liga e desliga é o administrador da plataforma.

**Substitui a "claude-ponte"**: a conexão direta à ponte do Claude, as variáveis `CLAUDE_PONTE_*`, a fila de espera própria e o interruptor por organização foram removidos por inteiro. A classificação de erro por tipo (cota, saldo, modelo, rede) segue valendo mesmo quando o SDK embrulha a falha numa nova tentativa. Sem migration: a escolha mora em `organizations.settings.omnirouter`.

## Requer atenção

Vale para quem usava a "claude-ponte" (as variáveis `CLAUDE_PONTE_*` no `.env`). Faça **antes** de atualizar:

- grave o endereço e a chave do OmniRouter em Admin › Configuração › Credenciais;
- marque cada organização que a ponte atendia, em Admin › Organizações › Inteligência Artificial & OmniRouter (ou ligue a oferta geral, `OMNIROUTER_PARA_TODAS=true`).

Sem isso, depois da atualização a organização cai na chave da Anthropic da instalação, e, sem chave nenhuma, o agente fica calado até alguém cadastrar uma. Quem nunca usou a ponte não precisa fazer nada.
