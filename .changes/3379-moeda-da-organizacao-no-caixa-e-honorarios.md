---
impacto: exige_acao
secao: corrigido
titulo: Conta, recorrência, lançamento manual e parcela de honorários gravam na moeda da organização
---

Numa organização configurada em outra moeda (dólar, por exemplo), quatro lugares ainda gravavam em real: a conta criada no catálogo do financeiro, a recorrência, o lançamento manual e a parcela de honorários. Na parcela, o valor certo aparecia com o rótulo `R$`. Ao pagar a parcela, o dinheiro entrava no caixa em real.

Agora os quatro nascem na moeda da organização, que o servidor lê do cadastro dela. A parcela de honorários guarda a própria moeda, e o pagamento leva essa moeda para o caixa. A tabela de parcelas mostra a moeda de cada parcela, como o extrato do caixa já fazia com os lançamentos. O que já estava gravado não muda: parcelas antigas continuam em real. Organização em real não vê diferença.

A atualização acrescenta a coluna de moeda às parcelas de honorários quando o módulo está instalado. Ela não faz nada se o módulo não estiver.

## Requer atenção

A API do catálogo do financeiro (`POST` e `PATCH` em `/api/v1/financeiro/catalogo/contas`) deixa de ler o campo `currency` do corpo. Uma integração que criava conta em moeda diferente da organização passa a ter a conta na moeda da organização, sem erro, porque o campo é ignorado. Também não dá mais para trocar a moeda de uma conta existente por essa rota. Se a sua integração dependia disso, ajuste antes de atualizar.

As respostas de lançamentos e de parcelas de honorários passam a trazer o campo `currency`.

Contribuição de @webtecnica (#3459).
