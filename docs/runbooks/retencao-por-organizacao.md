# Retenção por organização: como funciona, como operar e como desfazer

A migration 0693 deixa cada empresa **encurtar** o prazo em que guarda o dado pessoal de terceiros. São cinco funções novas no banco (nenhuma tabela, nenhuma coluna), um passo novo no cron `data-retention` e um cartão em Configurações › Empresa.

## O que é por empresa e o que continua global

| Tipo (chave em `organizations.settings.retencao`) | O que apaga                                                            | Mínimo | Variável global (teto)           |
| ------------------------------------------------- | ---------------------------------------------------------------------- | ------ | -------------------------------- |
| `captacao_dias`                                   | captação de leads (formulário, anúncio, webhook)                       | 30     | `LEAD_CAPTURE_RETENTION_DAYS`    |
| `conversa_do_caso_dias`                           | mensagens da conversa de cada caso do agente de IA                     | 90     | `CASE_CHAT_RETENTION_DAYS`       |
| `prospeccao_dias`                                 | candidatos de prospecção (fila, envio em andamento e suprimidos ficam) | 90     | `PROSPECCAO_RETENTION_DAYS`      |
| `espelho_da_agenda_dias`                          | cópia dos eventos da agenda externa, contada do fim do evento          | 7      | `CALENDAR_MIRROR_RETENTION_DAYS` |

Auditoria, fila de jobs, telemetria, logs de webhook e afins **seguem globais**: prazo por empresa nesses deixaria uma empresa apagar o próprio rastro. A mídia já era por empresa (`media_retention_days`) e não mudou.

## A regra, em três linhas

1. A empresa só **encurta**. A poda global roda primeiro, para todas; a passada por empresa apaga além dela. Vale o menor dos dois.
2. O mínimo mora **dentro do SQL** (`fn_piso_de_retencao_por_organizacao`). Valor abaixo do mínimo é recusado na gravação e, se estiver guardado à mão, é elevado ao mínimo na leitura. Valor torto (texto, negativo, decimal, mais de 5 dígitos) é ignorado e vale o global.
3. Quem não escolheu nada não percebe diferença.

## Operação

- Pela tela: Configurações › Empresa › "Retenção de dados pessoais" (só administrador da empresa ou da plataforma). Campo em branco segue a instalação; "Seguir a instalação em todos" limpa os quatro.
- Pelo banco (só para diagnóstico; a tela é o caminho): `select * from public.fn_organizacoes_com_prazo_proprio();` lista os pares (empresa, tipo) com prazo próprio e o prazo já com o mínimo aplicado.
- O que o cron fez: `retention.organization_sweep` na trilha da própria empresa, uma linha por tipo que apagou (`metadata`: `tipo`, `prazo_proprio_dias`, `apagadas`, `lotes`, `tem_resto`). O resumo global `retention.sweep_run` só sai quando houve efeito ou falha. Um par que falha deixa a rodada em 500, com a falha nomeada, e as outras empresas apagam normalmente.
- Quem mudou o prazo: `org.retention_updated`, com os números gravados.

## Reversão

- **Pela tela:** "Seguir a instalação em todos" e salvar. O cartão volta a mostrar a instalação e a próxima rodada do cron não apaga mais nada por empresa.
- **Pelo código:** voltar a imagem anterior. A migration é aditiva (só funções): pode ficar no banco sem efeito, porque sem o passo novo no cron nenhuma função é chamada.
- **O que não volta:** o dado que o cron já apagou. Apagar é o efeito pedido; quem escolhe um prazo curto escolhe isso, e por isso o cartão mostra o mínimo e o aviso de "sem efeito".

## Como foi provado

- `tests/invariants/retencao-por-organizacao.test.ts` roda as cinco funções contra um Postgres 15 de verdade com o `baseline.sql` aplicado (26 casos: a empresa só encurta, a poda de uma não encosta nas outras, as guardas da prospecção, quem pode gravar, privilégios).
- `tests/unit/retencao-por-organizacao*.test.ts` e `app/actions/settings/updateRetencaoDaOrganizacao.test.ts` cobrem a regra pura, o laço do cron, o espelho entre a tabela de mínimos do SQL e a do TypeScript, e a ordem dos portões da gravação.

## Checklist de integração

- Entrada: cartão em Configurações › Empresa, por Server Action (`updateRetencaoDaOrganizacao`), com a empresa tirada da sessão.
- Saída: `organizations.settings.retencao` → `fn_organizacoes_com_prazo_proprio` → cron `data-retention` → `fn_expurgar_por_organizacao`.
- Registro: `org.retention_updated` (quem mudou) e `retention.organization_sweep` (o que apagou).
- Acesso/configuração: o cartão fica na página que já existe; nenhum menu novo.
- Retorno: erros da gravação aparecem na tela com o campo e o mínimo; "salvo" só depois de o banco confirmar 1 linha.
- Continuidade IA/humano: não se aplica, o prazo só governa quanto tempo o dado fica guardado.
- Próximo passo: nada fica pendente; a próxima rodada do cron aplica o prazo novo.
