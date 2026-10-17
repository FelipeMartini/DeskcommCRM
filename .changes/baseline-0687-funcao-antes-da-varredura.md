---
impacto: nada_mudou
secao: corrigido
titulo: O arquivo de instalação e atualização aplica o Haiku 5.5 padrão na ordem que a varredura de segurança exige
---
Na atualização que traz o Haiku 5.5 como modelo padrão, a função que prepara as configurações de IA de uma organização nova passou a ficar antes da varredura de segurança do arquivo `baseline.sql`, como pede a regra do projeto: nenhuma função pode ser criada depois dessa varredura. Antes ela ficava depois, e o teste que vigia essa ordem reprovava. Para quem usa o CRM nada muda: o Haiku 5.5 continua sendo o padrão, e a organização nova continua nascendo com ele. Só mudou a ordem dos comandos no arquivo de instalação e atualização.
