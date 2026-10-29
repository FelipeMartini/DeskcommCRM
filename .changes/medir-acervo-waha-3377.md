---
impacto: nada_mudou
secao: adicionado
titulo: "Medição do acervo do WhatsApp: memória e disco com histórico grande"
---

Script `scripts/medir-acervo-waha.ts` mede, contra um WAHA vivo, a memória do
processo/contêiner, o tamanho do diretório do store, o número de sessões e de
mensagens guardadas, e o crescimento por 1000 mensagens. Doc curto em
`docs/medir-acervo-waha.md` traz a régua e o que ela significa para os
`mem_limit` do compose (768m app, 512m worker). Nenhuma medição real foi
inventada: sem WAHA disponível, a seção "medido" fica vazia e a instrução
exata de como rodar está no doc.

Crédito: @webtecnica.
