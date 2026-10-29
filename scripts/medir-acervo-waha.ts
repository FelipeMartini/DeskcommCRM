#!/usr/bin/env -S tsx
/**
 * MEDIÇÃO do acervo do WhatsApp (#3377).
 *
 * Contra um WAHA vivo (motor NOWEB com "Guardar o histórico" ligado), mede:
 *   - memória do processo/contêiner do WAHA;
 *   - tamanho do diretório do store (disco);
 *   - número de sessões (números pareados);
 *   - número de mensagens guardadas;
 *   - crescimento por 1000 mensagens (bytes de store / mensagens * 1000).
 *
 * Sem WAHA disponível, o script NÃO falha: mede só o diretório do store
 * (contagens e soma de tamanho) e deixa os campos de WAHA/memória em null.
 * Isso permite testar a parte de disco com uma fixture pequena, sem rede.
 *
 * Uso:
 *   WAHA_API_BASE_URL=http://waha:3000 WAHA_API_KEY=... WAHA_STORE_DIR=/app/.sessions \
 *     tsx scripts/medir-acervo-waha.ts [--json]
 *
 *   # só medir um diretório (fixture):
 *   tsx scripts/medir-acervo-waha.ts /caminho/do/store --json
 *
 * Saída: um único objeto JSON em stdout. Resumo humano em stderr.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

interface Opcoes {
  storeDir: string;
  wahaUrl: string;
  apiKey: string;
  container: string;
  pid: string;
  maxChats: number;
  maxMsgsPorChat: number;
  medirWaha: boolean;
}

interface MedidaDiretorio {
  diretorio: string;
  arquivos: number;
  bytes: number;
  totalBytes: number;
  totalSize: number;
  count: number;
  fileCount: number;
}

interface MedidaMemoria {
  rssBytes: number | null;
  container: { memUsage: string; memLimit: string } | null;
  processo: { pid: number; rssBytes: number } | null;
}

interface MedidaWaha {
  vivo: boolean;
  versao: string | null;
  sessoes: number;
  sessions: number;
  mensagens: number;
  messages: number;
  porSessao: Array<{ nome: string; status: string; chats: number; mensagens: number }>;
}

function parseArgs(argv: string[]): Opcoes {
  const opts: Opcoes = {
    storeDir: process.env.WAHA_STORE_DIR || process.env.STORE_DIR || "/app/.sessions",
    wahaUrl: (process.env.WAHA_API_BASE_URL || process.env.WAHA_URL || "").replace(/\/+$/, ""),
    apiKey: process.env.WAHA_API_KEY || process.env.API_KEY || "",
    container: process.env.WAHA_CONTAINER || "waha",
    pid: process.env.WAHA_PID || "",
    maxChats: Number(process.env.MAX_CHATS || 10000),
    maxMsgsPorChat: Number(process.env.MAX_MSGS_POR_CHAT || 100000),
    medirWaha: true,
  };
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--store-dir" || a === "--store") { opts.storeDir = argv[++i] ?? opts.storeDir; continue; }
    if (a === "--waha-url" || a === "--url") { opts.wahaUrl = (argv[++i] ?? "").replace(/\/+$/, ""); continue; }
    if (a === "--api-key" || a === "--key") { opts.apiKey = argv[++i] ?? opts.apiKey; continue; }
    if (a === "--container") { opts.container = argv[++i] ?? opts.container; continue; }
    if (a === "--pid") { opts.pid = argv[++i] ?? opts.pid; continue; }
    if (a === "--max-chats") { opts.maxChats = Number(argv[++i] ?? opts.maxChats); continue; }
    if (a === "--max-msgs" || a === "--max-msgs-por-chat") { opts.maxMsgsPorChat = Number(argv[++i] ?? opts.maxMsgsPorChat); continue; }
    if (a === "--no-waha" || a === "--sem-waha") { opts.medirWaha = false; continue; }
    if (a === "--json") continue;
    if (a.startsWith("--")) continue;
    pos.push(a);
  }
  if (pos.length > 0) opts.storeDir = pos[0] ?? opts.storeDir;
  if (!opts.wahaUrl) opts.medirWaha = false;
  return opts;
}

export function medirDiretorio(dir: string): MedidaDiretorio {
  let arquivos = 0;
  let bytes = 0;
  const alvo = path.resolve(dir);
  if (fs.existsSync(alvo)) {
    const pilha: string[] = [alvo];
    while (pilha.length > 0) {
      const atual = pilha.pop() as string;
      let entradas: fs.Dirent[] = [];
      try { entradas = fs.readdirSync(atual, { withFileTypes: true }); } catch { continue; }
      for (const e of entradas) {
        const cheio = path.join(atual, e.name);
        if (e.isDirectory()) {
          pilha.push(cheio);
        } else if (e.isFile()) {
          arquivos += 1;
          try { bytes += fs.statSync(cheio).size; } catch { /* ignora arquivo ilegível */ }
        }
      }
    }
  }
  return {
    diretorio: alvo,
    arquivos,
    bytes,
    totalBytes: bytes,
    totalSize: bytes,
    count: arquivos,
    fileCount: arquivos,
  };
}

function lerProcRss(pid: string): { pid: number; rssBytes: number } | null {
  if (!pid) return null;
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    const statm = fs.readFileSync(`/proc/${n}/statm`, "utf8").trim().split(/\s+/);
    const pages = Number(statm[1] ?? 0);
    const pageSize = 4096;
    return { pid: n, rssBytes: pages * pageSize };
  } catch {
    return null;
  }
}

function medirContainer(nome: string): { memUsage: string; memLimit: string } | null {
  try {
    const out = execFileSync("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", nome], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // formato "123MiB / 1.2GiB"
    const partes = out.split("/").map((s) => s.trim());
    return { memUsage: partes[0] || out, memLimit: partes[1] || "" };
  } catch {
    return null;
  }
}

function medirMemoria(opts: Opcoes): MedidaMemoria {
  const processo = lerProcRss(opts.pid);
  // Só reporta memória quando alguém disse de quem é (pid do WAHA ou contêiner).
  // Medir a memória do próprio script seria mentir sobre o WAHA.
  const rssBytes: number | null = processo ? processo.rssBytes : null;
  const container = medirContainer(opts.container);
  // se o docker stats respondeu, prefere ele para rssBytes (memória real do contêiner)
  if (container && container.memUsage) {
    // mantém rssBytes do /proc quando existir; o container só complementa
  }
  return { rssBytes, container, processo };
}

function comoObjeto(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function comoLista(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function comoTexto(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function extrairVersao(v: unknown): string | null {
  if (typeof v === "string") return v;
  const obj = comoObjeto(v);
  if (!obj) return null;
  const direta = comoTexto(obj.version);
  if (direta) return direta;
  const aninhada = comoTexto(comoObjeto(obj.waha)?.version);
  return aninhada || null;
}

function extrairChatId(c: unknown): string {
  const obj = comoObjeto(c);
  if (!obj) return "";
  const direto = comoTexto(obj.id);
  if (direto) return direto;
  const id = comoObjeto(obj.id);
  if (!id) return "";
  return comoTexto(id._serialized) || comoTexto(id.id);
}

async function fetchJson(url: string, apiKey: string): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers["X-Api-Key"] = apiKey;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function medirWaha(opts: Opcoes): Promise<MedidaWaha> {
  const base = opts.wahaUrl;
  let vivo = false;
  let versao: string | null = null;
  let sessoes = 0;
  let mensagens = 0;
  const porSessao: MedidaWaha["porSessao"] = [];
  if (!opts.medirWaha || !base) {
    return { vivo: false, versao: null, sessoes: 0, sessions: 0, mensagens: 0, messages: 0, porSessao };
  }
  try {
    const v = await fetchJson(`${base}/api/server/version`, opts.apiKey);
    vivo = true;
    versao = extrairVersao(v);
  } catch {
    vivo = false;
  }
  let lista: unknown[] = [];
  try {
    const r = await fetchJson(`${base}/api/sessions`, opts.apiKey);
    lista = Array.isArray(r) ? r : comoLista(comoObjeto(r)?.data);
  } catch {
    lista = [];
  }
  sessoes = lista.length;
  for (const s of lista) {
    const sessao = comoObjeto(s);
    const nome = comoTexto(sessao?.name) || comoTexto(sessao?.session);
    if (!nome) continue;
    let chats: unknown[] = [];
    try {
      let offset = 0;
      const limit = 100;
      while (chats.length < opts.maxChats) {
        const lote = await fetchJson(
          `${base}/api/${encodeURIComponent(nome)}/chats?limit=${limit}&offset=${offset}`,
          opts.apiKey,
        );
        const arr = Array.isArray(lote) ? lote : comoLista(comoObjeto(lote)?.data);
        if (arr.length === 0) break;
        chats = chats.concat(arr);
        if (arr.length < limit) break;
        offset += arr.length;
      }
    } catch {
      chats = [];
    }
    chats = chats.slice(0, opts.maxChats);
    let sessionMsgs = 0;
    for (const c of chats) {
      const chatId = extrairChatId(c);
      if (!chatId) continue;
      try {
        let offset = 0;
        const limit = 100;
        let guard = 0;
        while (guard < opts.maxMsgsPorChat) {
          const lote = await fetchJson(
            `${base}/api/${encodeURIComponent(nome)}/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}&offset=${offset}&downloadMedia=false`,
            opts.apiKey,
          );
          const arr = Array.isArray(lote) ? lote : comoLista(comoObjeto(lote)?.data);
          if (arr.length === 0) break;
          sessionMsgs += arr.length;
          if (arr.length < limit) break;
          offset += arr.length;
          guard += arr.length;
          if (guard >= opts.maxMsgsPorChat) break;
        }
      } catch {
        // ignora chat inacessível
      }
    }
    mensagens += sessionMsgs;
    porSessao.push({ nome, status: comoTexto(sessao?.status), chats: chats.length, mensagens: sessionMsgs });
  }
  return {
    vivo,
    versao,
    sessoes,
    sessions: sessoes,
    mensagens,
    messages: mensagens,
    porSessao,
  };
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const store = medirDiretorio(opts.storeDir);
  const memoria = medirMemoria(opts);
  const waha = await medirWaha(opts);

  const bytesPor1000 = waha.mensagens > 0
    ? Math.round((store.bytes / waha.mensagens) * 1000)
    : null;
  const memoriaPor1000 = (waha.mensagens > 0 && memoria.rssBytes !== null)
    ? Math.round((memoria.rssBytes / waha.mensagens) * 1000)
    : null;

  const resultado = {
    medidoEm: new Date().toISOString(),
    waha: {
      url: opts.wahaUrl || null,
      vivo: waha.vivo,
      versao: waha.versao,
    },
    memoria: {
      rssBytes: memoria.rssBytes,
      memoriaPor1000MensagensBytes: memoriaPor1000,
      container: memoria.container,
      processo: memoria.processo,
    },
    store: {
      diretorio: store.diretorio,
      arquivos: store.arquivos,
      bytes: store.bytes,
      totalBytes: store.bytes,
      totalSize: store.bytes,
      count: store.arquivos,
      fileCount: store.arquivos,
    },
    diretorio: {
      arquivos: store.arquivos,
      bytes: store.bytes,
    },
    sessoes: waha.sessoes,
    sessions: waha.sessoes,
    mensagens: waha.mensagens,
    messages: waha.mensagens,
    porSessao: waha.porSessao,
    crescimentoPor1000Mensagens: {
      mensagens: 1000,
      bytes: bytesPor1000,
      bytesPor1000,
      bytesPor1000Mensagens: bytesPor1000,
      memoriaBytes: memoriaPor1000,
    },
  };

  process.stdout.write(JSON.stringify(resultado, null, 2) + "\n");

  const resumo = [
    `store: ${store.arquivos} arquivo(s), ${store.bytes} bytes`,
    `waha: ${waha.vivo ? "vivo" : "indisponível"} · ${waha.sessoes} sessão(ões) · ${waha.mensagens} mensagem(ns)`,
    memoria.rssBytes !== null ? `memória: ${memoria.rssBytes} bytes (rss)` : "memória: n/d",
    bytesPor1000 !== null ? `crescimento: ${bytesPor1000} bytes/1000 mensagens` : "crescimento: n/d (sem mensagens)",
  ].join(" | ");
  process.stderr.write(resumo + "\n");
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((erro) => {
      process.stderr.write(`${erro instanceof Error ? erro.message : String(erro)}\n`);
      process.exit(1);
    });
}

export { parseArgs, main };
