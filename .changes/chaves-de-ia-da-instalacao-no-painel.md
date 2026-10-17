---
impacto: nada_mudou
secao: adicionado
titulo: As chaves de IA da instalação (Anthropic, OpenAI e OpenRouter) passam a ser gravadas pelo painel
---

Em Admin › Configuração › Credenciais, o administrador da plataforma agora grava a **chave da Anthropic**, a **chave da OpenAI** e a **chave da OpenRouter** da instalação, sem editar o arquivo `.env` no servidor e sem reiniciar nada. São as chaves do degrau "chave da instalação": valem para a organização que não cadastrou uma credencial própria e que o OmniRouter não atende. Ficam guardadas cifradas, a auditoria registra só o fato e os últimos 4 caracteres, e a tela recusa chave com espaço ou quebra de linha antes de salvar (a mensagem nunca repete o que foi digitado).

**O que o painel grava vence; o `.env` continua valendo como piso.** Quem não mexe na tela não percebe diferença nenhuma: as instalações que têm as chaves no `.env` seguem funcionando como antes, e o valor do `.env` é só lido quando o banco não tem a chave. Depois de gravar pela tela, uma troca no `.env` não vale mais para aquela chave; para voltar a seguir o `.env`, use “Voltar ao padrão” no próprio campo.

A troca vale na conversa seguinte, no app e no worker, porque as duas pontas leem a mesma fonte a cada chamada: os agentes de texto, o preparo de material do acervo (embeddings), a descrição de foto e a transcrição de áudio, os pontos de IA do painel de provedores, as ligações de voz e os portões de salvar e publicar agente (que perguntam se a instalação tem chave para aquele provedor). O aviso "nenhuma chave de IA configurada no ambiente" do arranque agora lembra que a chave pode estar no painel.

Continuam só no arquivo `.env`: o gateway de IA (`AI_GATEWAY_*`) e as chaves de transcrição dedicada (`TRANSCRIPTION_*`). Sem migration.
