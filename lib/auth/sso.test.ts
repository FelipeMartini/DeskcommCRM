import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { validarTokenSSO } from "./sso";

function gerarTokenTeste(payload: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const payloadB64 = Buffer.from(JSON.stringify(payload))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const assinatura = createHmac("sha256", secret)
    .update(`${header}.${payloadB64}`)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${header}.${payloadB64}.${assinatura}`;
}

describe("SSO Token Validator", () => {
  const SECRET = "segredo-de-teste-super-seguro-123";

  it("valida com sucesso um token legítimo não expirado", () => {
    const agora = Math.floor(Date.now() / 1000);
    const token = gerarTokenTeste(
      {
        email: "felipe@expandacentral.com.br",
        name: "Felipe Martini",
        espaco_id: "espaco-123",
        espaco_nome: "EXPanda Central",
        iat: agora,
        exp: agora + 300,
      },
      SECRET
    );

    const resultado = validarTokenSSO(token, SECRET);
    expect(resultado).not.toBeNull();
    expect(resultado?.email).toBe("felipe@expandacentral.com.br");
    expect(resultado?.name).toBe("Felipe Martini");
    expect(resultado?.espaco_nome).toBe("EXPanda Central");
  });

  it("recusa token com assinatura incorreta", () => {
    const agora = Math.floor(Date.now() / 1000);
    const token = gerarTokenTeste(
      {
        email: "invasor@teste.com",
        exp: agora + 300,
      },
      "segredo-errado"
    );

    const resultado = validarTokenSSO(token, SECRET);
    expect(resultado).toBeNull();
  });

  it("recusa token expirado", () => {
    const agora = Math.floor(Date.now() / 1000);
    const token = gerarTokenTeste(
      {
        email: "felipe@expandacentral.com.br",
        exp: agora - 100, // expirado há mais de 30s
      },
      SECRET
    );

    const resultado = validarTokenSSO(token, SECRET);
    expect(resultado).toBeNull();
  });

  it("recusa token com payload sem e-mail", () => {
    const agora = Math.floor(Date.now() / 1000);
    const token = gerarTokenTeste(
      {
        name: "Sem Email",
        exp: agora + 300,
      },
      SECRET
    );

    const resultado = validarTokenSSO(token, SECRET);
    expect(resultado).toBeNull();
  });
});
