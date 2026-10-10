---
impacto: capacidade_nova
secao: adicionado
titulo: A instalação pode apontar toda chamada à Anthropic para um endereço próprio (ANTHROPIC_BASE_URL), para um proxy compatível com a API de Mensagens
---

Quem opera o servidor ganha a variável **`ANTHROPIC_BASE_URL`**, no `.env` da instalação, para mandar a Anthropic para um proxy ou gateway compatível com a API de Mensagens (por exemplo `http://nome-do-conteiner:8080` ou `https://proxy.exemplo.com`). Vazia, nada muda: continua `https://api.anthropic.com`. Posta, vale para **toda** chamada à Anthropic desta instalação e de todas as organizações: o turno do agente, os workers de ponto, o ensaio do agente, a validação da chave, a prova de crédito e a contagem de tokens. Aceita a raiz ou a raiz com `/v1`; sem caminho, consulta nem `usuário:senha`.

O endereço é **escolhido por quem opera a instalação**, nunca por uma organização: `base_url` na credencial continua valendo só para o provedor personalizado, e uma credencial da Anthropic ignora o que houver nessa coluna (decisão 22-d). Variável malformada não cai no endereço padrão: o worker não sobe e cada chamada recusa antes de qualquer byte sair, para a chave pensada para o proxy não ir à Anthropic em silêncio. A chamada não segue redirect e só fala com a origem escolhida. Para ligar ou desligar, edite o `.env` e recrie `app` e `worker`. Sem migration; nada precisa ser feito ao atualizar.
