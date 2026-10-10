---
impacto: capacidade_nova
secao: adicionado
titulo: O comando pessoal no celular e o contato novo que já nasce pessoal tiram a vida pessoal da operação, e as campanhas por palavra ganham editor em Configurações › Atendimento
---

Quem liga o próprio WhatsApp ao CRM entrega à operação toda conversa do aparelho, e marcar contato por contato pela ficha não acompanha o ritmo em que elas chegam. Dois gestos novos resolvem, os dois **desligados até alguém ligar** em Configurações › Atendimento › Contatos pessoais (gerente ou acima). **`#pessoal`**: escrito sozinho na mensagem, no chat do contato e no WhatsApp do número conectado, marca o contato como pessoal com os mesmos efeitos de marcar pela ficha (sai do funil, dos follow-ups, das campanhas e da IA), e o comando some do chat do cliente. **Contato novo já nasce pessoal**: quem aparece pela primeira vez é marcado, a não ser que a primeira mensagem case a frase de uma campanha por palavra. Os dois valem para todos os números de WhatsApp da organização; quem tem um número dedicado ao negócio na mesma organização deve manter o segundo desligado.

A mesma tela ganha o **editor das campanhas por palavra** (`organizations.settings.campanhas_whatsapp`, que até aqui só se escrevia por SQL): nome, a frase, se a mensagem a contém ou começa com ela, o número onde vale e a ordem (vale a primeira que casar). Administradores editam; gerentes veem. A frase precisa ter ao menos 3 caracteres depois de tirar acento e espaço repetido, e um número de outra organização é recusado. Cada mudança nos interruptores e na lista deixa uma linha de auditoria (`settings.personal_contacts_updated`, `settings.campaign_keywords_updated`; a lista registra só ids e contagens, nunca a frase).

Por baixo, os efeitos de marcar um contato como pessoal passaram a viver num módulo só (`lib/contacts/pessoal.ts`), usado pela ficha, pelo comando e pelo nascimento do contato; a ficha se comporta como antes. Nada muda para quem não liga os interruptores, não há migration e nada precisa ser feito ao atualizar.
