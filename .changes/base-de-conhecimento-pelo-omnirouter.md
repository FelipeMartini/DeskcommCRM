---
impacto: capacidade_nova
secao: adicionado
titulo: A base de conhecimento pode ser preparada pelo OmniRouter da instalação, com o modelo de embedding do Google
---

Até aqui a base de conhecimento tinha três famílias: OpenAI, Google (com chave própria) e a busca por palavras. Quem só tinha o OmniRouter da instalação, que é uma conexão de texto, ficava na busca por palavras, que não entende sinônimo ("aplicativo" não acha "app"). Agora existe a quarta família, **OmniRouter**: o material é preparado e a pergunta é consultada pelo `gemini-embedding-001` (Google) **através do OmniRouter**, sem cadastrar chave de embedding na empresa e sem depender do crédito dela. Na tela de Conhecimento, o cartão "Quem prepara a base" ganha o botão "Trocar para o OmniRouter", que só aparece quando a instalação configurou o endereço e a chave dele (Admin › Credenciais) e a empresa é atendida por ele (escolha do administrador da plataforma no cartão da empresa, ou a oferta geral da instalação). O aviso antes da troca diz que a base é refeita e que o texto dos materiais, e depois o das perguntas dos clientes à base, passa a ser enviado ao OmniRouter e ao provedor que ele usa.

O roteador devolve o vetor com as 3072 dimensões nativas do modelo, e a coluna do banco tem 1536: o CRM corta nas primeiras 1536 e normaliza (o modelo é treinado em camadas, e a documentação do Google manda normalizar o corte; medido com cinco perguntas e cinco respostas em português, o corte acertou 5 de 5, como o vetor inteiro). Um vetor de qualquer outro tamanho é recusado, nunca cortado às cegas. O pedido ao roteador só vai ao endereço da instalação, com a chave dela, sem seguir redirecionamento.

O OmniRouter **não entra na escolha automática**: quem não escolheu família nenhuma continua caindo nas palavras quando não há chave, como hoje, e quem já tem OpenAI ou Google gravado continua exatamente nele. Se o OmniRouter deixar de atender a empresa depois de escolhido, a tela diz que ele não está disponível e quem resolve (o administrador da plataforma), e a base **não** cai em outra família calada. Trocar de família refaz a base no mesmo pedido, como já era.

Nenhuma mudança de banco, de variável de ambiente ou de rota nova (o `PUT /api/v1/ai/knowledge/provedor` passa a aceitar `omnirouter`). A coluna `embedding_model` das versões ganha o valor `omnirouter/gemini-embedding-001`, que não se confunde com `google/gemini-embedding-001`: são o mesmo modelo por caminhos diferentes, e o CRM os trata como bases distintas (uma pergunta nunca é comparada com trechos preparados pelo outro caminho).
