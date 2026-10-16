/**
 * A configuração da INSTALAÇÃO, lida pelo MOTOR (o `worker` e quem fala com `pg.Pool`).
 *
 * `lib/instalacao/config.ts` é o leitor do APP: fala com o banco pelo cliente do Supabase e com o
 * `.env` do processo do app. O motor é outro processo, com o seu próprio `.env` (o schema de
 * `lib/agent-engine/env.ts`) e o seu próprio acesso ao banco (`pg.Pool`). Sem um leitor para ele, o
 * valor que alguém digitou na tela de Credenciais ficaria no banco e o motor — que é onde a IA
 * responde — continuaria usando o do arquivo de instalação, com a tela dizendo "salvo". Este módulo é
 * esse leitor, e só ele.
 *
 * ═══ A MESMA regra do app, não uma parecida ═══
 *
 * Quem vence é decidido por `resolver` (`./config-resolve.ts`), o mesmo módulo puro que o app usa:
 * linha no banco vence o `.env`; sem linha o `.env` responde; linha esvaziada pela tela é uma escolha
 * válida e responde "sem valor". O que muda aqui é só COMO se lê (SQL em vez do cliente do Supabase) e
 * DE ONDE vem o piso (o `.env` do motor, recebido por parâmetro).
 *
 * ═══ Nada aqui lança ═══
 *
 * Banco fora do ar, tabela ausente (clone com schema atrasado) ou envelope que não abre: o piso
 * responde e o motivo vai para o log SEM o valor. A leitura de configuração nunca derruba uma chamada
 * de IA. A chave de cifra (`AI_CRED_AES_KEY`) é a mesma que as credenciais por organização já exigem.
 *
 * Sem memo, pelo motivo escrito em `config.ts`: o motor lê quando alguém vai USAR a chave, e trocar
 * pela tela vale na chamada seguinte, sem reiniciar nada.
 */
import type pg from "pg";

import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";

import { resolver, type EstadoDaLinha } from "./config-resolve";

/** O pedaço do `pg.Pool` que a leitura usa — o pool, um cliente ou um duplo de teste servem. */
export type LeitorSql = Pick<pg.Pool, "query">;

/** O `.env` do processo que lê, só com o que interessa. Vazio e ausente valem o mesmo. */
export type PisoDoAmbiente = Readonly<Record<string, string | undefined>>;

interface LinhaCrua {
  chave: string;
  valor: string | null;
  ciphertext: unknown;
  iv: unknown;
  tag: unknown;
  eh_segredo: boolean;
  semeado_do_env: boolean;
}

function aviso(o_que: string, chave: string | null, erro: unknown): void {
  // Nunca o valor: só a chave e o motivo. O `.env` do motor responde no lugar.
  console.warn(
    `[instalacao/config-sql] ${o_que}${chave !== null ? ` para "${chave}"` : ""} — usando o .env. ` +
      `${erro instanceof Error ? erro.message : String(erro)}`.slice(0, 300),
  );
}

/** Abre o envelope de um segredo. `null` — nunca lança — quando a cifra falta ou o envelope não abre. */
function abrirEnvelope(linha: LinhaCrua): string | null {
  if (linha.ciphertext == null || linha.iv == null || linha.tag == null) return null;
  try {
    return decryptKey({
      ciphertext: byteaToBuffer(linha.ciphertext),
      iv: byteaToBuffer(linha.iv),
      tag: byteaToBuffer(linha.tag),
    });
  } catch (erro) {
    aviso("o segredo guardado não abriu", linha.chave, erro);
    return null;
  }
}

function emClaro(linha: LinhaCrua): EstadoDaLinha {
  return {
    valor: linha.eh_segredo ? abrirEnvelope(linha) : linha.valor,
    semeadoDoEnv: linha.semeado_do_env,
  };
}

/**
 * O valor em vigor de cada chave pedida: banco primeiro, `piso` (o `.env` do motor) como rede.
 *
 * Uma única ida ao banco para todas as chaves. O resultado tem EXATAMENTE as chaves pedidas, `null`
 * onde não há valor em lugar nenhum.
 */
export async function valoresDaInstalacaoNoMotor(
  db: LeitorSql,
  chaves: readonly string[],
  piso: PisoDoAmbiente,
): Promise<Record<string, string | null>> {
  const doPiso = (chave: string): string | null => {
    const bruto = piso[chave];
    return typeof bruto === "string" ? bruto : null;
  };

  let linhas: LinhaCrua[] = [];
  try {
    const r = await db.query<LinhaCrua>(
      `select chave, valor, ciphertext, iv, tag, eh_segredo, semeado_do_env
         from platform_config
        where chave = any($1::text[])`,
      [chaves as string[]],
    );
    linhas = Array.isArray(r?.rows) ? r.rows : [];
  } catch (erro) {
    // `42P01` (imagem nova sobre schema velho) cai aqui também: degrada igual, sem derrubar o turno.
    aviso("a leitura do banco falhou", null, erro);
  }

  const porChave = new Map(linhas.map((l) => [l.chave, l] as const));
  const saida: Record<string, string | null> = {};
  for (const chave of chaves) {
    const linha = porChave.get(chave);
    saida[chave] = resolver(linha ? emClaro(linha) : null, doPiso(chave)).valor;
  }
  return saida;
}
