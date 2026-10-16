---
impacto: capacidade_nova
secao: adicionado
titulo: Fonte de webhook pode atualizar o card quando a integração reenvia o mesmo cadastro com dado novo
---

Em Webhooks, cada fonte ganhou a opção "Atualizar o card quando o envio repete o mesmo cadastro". Com ela ligada, um envio com o mesmo `external_id` de um card já criado por essa fonte atualiza o card em vez de ser ignorado: os campos novos entram, o nome do card acompanha o nome enviado (no Respondi, só os campos), e o campo reservado `stage` move o card para a etapa pedida. Em "Leads recebidos", esse envio aparece como "Card atualizado". A opção nasce desligada e só liga em fonte com segredo de assinatura configurado. Ela não alcança card criado por outra fonte, card sem origem registrada nem card de contato anonimizado. Com a opção desligada, nada muda: o envio repetido continua sendo reenvio. Nada a fazer na atualização.

Contribuição de @webtecnica (#2811), a partir da issue #2316 de @aleflores35.
