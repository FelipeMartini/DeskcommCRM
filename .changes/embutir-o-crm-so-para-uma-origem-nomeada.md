---
impacto: nada_mudou
secao: adicionado
titulo: Quem usa o CRM dentro de outro sistema seu pode liberar o quadro só para esse sistema, por uma variável de ambiente
---

Nada muda sem a variável: toda resposta do CRM continua com `X-Frame-Options: DENY` e nenhum site consegue embuti-lo. Quem opera o CRM dentro de um sistema próprio (a tela embutida do ProjetoSocial, por exemplo) agora pode pôr `EMBED_FRAME_ANCESTORS=https://sistema.exemplo.com.br` no `.env`; o `proxy.ts` responde então com `Content-Security-Policy: frame-ancestors` só para essa origem, e o navegador dá a ela precedência sobre o `DENY`, que segue valendo para todas as outras. A leitura é estreita de propósito: só entra origem `https` exata, sem curinga, porta, caminho, IP ou `'self'` (até três), e o que não casa é descartado por inteiro, então um erro de digitação fecha em vez de abrir. Sem migration; nenhuma ação ao atualizar.
