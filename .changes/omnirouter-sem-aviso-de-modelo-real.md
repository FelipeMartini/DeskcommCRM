---
impacto: nada_mudou
secao: corrigido
titulo: A resposta do OmniRouter não leva mais o aviso "Modelo Real" para a mensagem do cliente
---

O OmniRouter escreve `> 🤖 **[Modelo Real: <modelo> (<rota>)]**` no começo do texto das respostas de `/v1/chat/completions` (a forma `/v1/messages` vem limpa). O CRM fala Chat Completions com o OmniRouter, e o texto da resposta do agente vira mensagem de WhatsApp: sem filtro, o cliente leria o nome do modelo e da rota que atendeu. O cliente HTTP do OmniRouter agora tira esse aviso do começo do `content` de cada escolha, antes de a resposta chegar ao agente. O filtro só toca resposta JSON bem-sucedida com `choices[].message.content` em texto; erro HTTP, fluxo de eventos, corpo que não é JSON, resposta sem texto (chamada de ferramenta) e texto sem o aviso passam do jeito que vieram, e a menção a "Modelo Real" no meio de uma frase não é alterada. Os cabeçalhos de tamanho e de codificação da resposta reescrita saem, porque deixam de descrever o corpo. Nenhuma mudança de banco, de variável de ambiente ou de rota.
