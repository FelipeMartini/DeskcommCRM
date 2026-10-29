# Medição do acervo do WhatsApp (memória e disco) — issue #3377

## O que é

Quando uma conexão do WhatsApp tem "Guardar o histórico anterior à vinculação"
ligado (`noweb.store.enabled = true`, `fullSync = true`), o motor NOWEB do WAHA
guarda as conversas antigas do número dentro do contêiner do WAHA
(`/app/.sessions`). O CRM importa esse acervo em lotes (#3194). Ninguém sabia
quanto isso custa num servidor com histórico grande — este doc registra a
medição e o que ela significa para os limites do compose.

## Como medir

Rode contra um WAHA vivo (rede interna do compose ou VPS real):

```bash
WAHA_API_BASE_URL=http://waha:3000 \
WAHA_API_KEY="$WAHA_API_KEY" \
WAHA_STORE_DIR=/app/.sessions \
WAHA_CONTAINER=waha \
  tsx scripts/medir-acervo-waha.ts --json > /tmp/acervo-waha.json
cat /tmp/acervo-waha.json
```

Para medir um processo específico do WAHA em vez do contêiner, acrescente
`WAHA_PID=<pid>` (lê `/proc/<pid>/statm`). Para testar só o disco, aponte para
um diretório:

```bash
tsx scripts/medir-acervo-waha.ts /caminho/do/store --json
```

O script reporta: `memoria.rssBytes` (ou `memoria.container.memUsage`),
`store.arquivos`, `store.bytes`, `sessoes`, `mensagens` e
`crescimentoPor1000Mensagens.bytes` (= `store.bytes / mensagens * 1000`).

## Medido

Nenhuma medição real foi feita neste ambiente: não há contêiner do WAHA
disponível (nem em `http://localhost:3000`, nem via `docker ps`). Por honestidade,
a seção abaixo fica vazia — **não inventar número**. Preencha rodando o comando
acima numa VPS/instalação real e cole aqui o JSON resultante.

| Grandeza                            | Valor medido | Comando que produziu |
| ----------------------------------- | ------------ | -------------------- |
| Memória do processo/contêiner WAHA   | (vazio)      | `tsx scripts/medir-acervo-waha.ts --json` |
| Tamanho do diretório do store       | (vazio)      | idem |
| Número de sessões (números)         | (vazio)      | idem |
| Número de mensagens guardadas       | (vazio)      | idem |
| Crescimento por 1000 mensagens       | (vazio)      | idem |

## O que isso significa para os limites do compose

Os `mem_limit` do compose são (`docker-compose.prod.yml`):

- `app`: 768 MiB
- `worker`: 512 MiB
- `waha`: 1280 MiB

O acervo do histórico mora no contêiner do **WAHA** (disco em
`/app/.sessions` e memória do processo NOWEB), não nos contêineres `app` nem
`worker`. Portanto, a medição acima diz respeito principalmente ao teto de
1280 MiB do `waha`. O que **não** se deve concluir daqui:

- não libera o `app` (768 MiB) nem o `worker` (512 MiB) de nada: o importe do
  histórico em lotes (#3194) roda no `worker`, e lotes grandes podem pressionar
  os 512 MiB — é o `worker`, e não o `waha`, que precisa de folga quando o
  histórico é grande;
- o disco do store cresce com o histórico e não tem teto no compose (só o
  volume persistente); a coluna "crescimento por 1000 mensagens" é a régua para
  dimensionar o volume.

Quando a medição real for preenchida, comparar `memoria.rssBytes` com 1280 MiB
e `crescimentoPor1000Mensagens.bytes * (mensagens/1000)` com o espaço livre do
volume. Sem o número, mantém-se a decisão atual: histórico **desligado por
padrão** por conexão, e quem ligar assume o custo acima.
