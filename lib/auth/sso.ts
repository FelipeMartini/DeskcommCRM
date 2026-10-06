import { createHmac, timingSafeEqual } from "node:crypto";

export interface PayloadSSO {
  email: string;
  name?: string;
  espaco_id?: string;
  espaco_nome?: string;
  role?: "admin" | "agent" | "viewer";
  iat: number;
  exp: number;
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  return Buffer.from(base64, "base64").toString("utf-8");
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Valida um token JWT assinado com HMAC-SHA256 (HS256) compartilhado entre o ProjetoSocial e o Deskcomm.
 * Retorna o payload decodificado se válido e dentro do prazo de expiração, ou null se inválido.
 */
export function validarTokenSSO(token: string, secret: string): PayloadSSO | null {
  if (!token || !secret) return null;

  const partes = token.split(".");
  if (partes.length !== 3) return null;

  const [headerB64, payloadB64, assinaturaB64] = partes;

  try {
    // 1. Validar cabeçalho
    const headerStr = base64UrlDecode(headerB64);
    const header = JSON.parse(headerStr);
    if (header.alg !== "HS256") return null;

    // 2. Conferir assinatura usando timingSafeEqual
    const esperado = createHmac("sha256", secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest();
    const assinaturaRecebida = Buffer.from(
      assinaturaB64.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    );

    if (esperado.length !== assinaturaRecebida.length) return null;
    if (!timingSafeEqual(esperado, assinaturaRecebida)) return null;

    // 3. Validar payload e expiração
    const payloadStr = base64UrlDecode(payloadB64);
    const payload = JSON.parse(payloadStr) as PayloadSSO;

    if (!payload.email || typeof payload.email !== "string") return null;

    const agoraSegundos = Math.floor(Date.now() / 1000);
    // Tolerância de 30 segundos para eventual divergência de relógio entre servidores
    if (payload.exp && payload.exp < agoraSegundos - 30) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
