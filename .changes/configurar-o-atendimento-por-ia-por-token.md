---
impacto: capacidade_nova
secao: adicionado
titulo: Quem configura o CRM por código (token de servidor) monta o atendimento por IA inteiro sem abrir o navegador
---

Dezesseis portas da API que só respondiam à sessão do navegador passam a aceitar também um token de servidor (`Authorization: Bearer dsk_…`): o **conhecimento** (listar e cadastrar fontes, buscar), a **memória geral** da organização (ler, publicar uma versão, acrescentar uma entrada), o **funil** (listar funis, renomear, ler e editar etapas, mapear o agente a cada etapa) e os **fluxos de follow-up** (ler, editar, publicar). Há também uma rota nova, `PATCH /api/v1/pipelines/{id}/config`, que grava o vocabulário, os campos personalizados e os motivos de perda e de ganho de um funil — a mesma escrita da tela Configurações › Funis, que passou a usar a mesma função.

O token precisa do escopo próprio `config:read` (para ler) ou `config:write` (para escrever) **e** do papel administrador: os tokens que já existem, com `mcp:read` e `mcp:write`, não ganham nada nesta atualização e seguem recebendo 403 nessas portas. A escrita por token respeita o teto de 30 por minuto por token e 600 por organização, filtra a organização pela linha do próprio token (nunca pelo caminho nem pelo corpo) e registra no histórico de auditoria o token que agiu, e não uma pessoa. A rota de configuração do funil recusa chave desconhecida no corpo em vez de ignorá-la. Criar e apagar funil, criar e arquivar etapa e apagar fluxo seguem só pela tela. Sem migration; nada precisa ser feito ao atualizar.
