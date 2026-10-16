/**
 * A conferência do valor antes de gravar uma chave da instalação (`validar-valor.ts`).
 *
 * Cada regra com o caso que PEGA e o que PASSA, e a promessa de que a mensagem nunca repete o valor
 * digitado (pode ser um segredo, ou uma URL com a senha dentro).
 */
import { describe, expect, it } from "vitest";

import { recusaDoValor } from "./validar-valor";

describe("OMNIROUTER_BASE_URL", () => {
  it.each([
    "http://omnirouter:20128",
    "https://omnirouter.example.com",
    "https://omnirouter.example.com/",
    "https://omnirouter.example.com/v1",
    "https://gateway.exemplo.com/api/v1",
    "  https://omnirouter.example.com  ",
  ])("aceita %j", (valor) => {
    expect(recusaDoValor("OMNIROUTER_BASE_URL", valor)).toBeNull();
  });

  it.each([
    ["omnirouter", /URL completa/],
    ["omnirouter:20128", /http:\/\/ ou https:\/\//],
    ["ftp://omnirouter.example.com", /http:\/\/ ou https:\/\//],
    ["https://usuario:segredo-sintetico@omnirouter.example.com", /usuário e senha/],
    ["https://omnirouter.example.com/v1?chave=x", /\? nem #/],
    ["https://omnirouter.example.com/v1#topo", /\? nem #/],
  ])("recusa %j com o motivo certo", (valor, motivo) => {
    const recusa = recusaDoValor("OMNIROUTER_BASE_URL", valor);
    expect(recusa).not.toBeNull();
    expect(recusa).toMatch(motivo);
  });

  it("⭐ a mensagem NUNCA repete o valor digitado (URL com senha dentro)", () => {
    const valor = "https://usuario:segredo-sintetico@omnirouter.example.com";
    const recusa = recusaDoValor("OMNIROUTER_BASE_URL", valor) ?? "";
    expect(recusa).not.toContain("segredo-sintetico");
    expect(recusa).not.toContain("usuario:");
  });
});

describe("OMNIROUTER_API_KEY", () => {
  it("aceita uma chave sem espaço", () => {
    expect(recusaDoValor("OMNIROUTER_API_KEY", "chave-sintetica-do-omnirouter")).toBeNull();
    expect(recusaDoValor("OMNIROUTER_API_KEY", "  chave-com-borda  ")).toBeNull();
  });

  it.each(["duas palavras", "linha1\nlinha2", "com\ttab"])("recusa %j (espaço ou quebra no meio)", (valor) => {
    expect(recusaDoValor("OMNIROUTER_API_KEY", valor)).toMatch(/espaços nem quebras de linha/);
  });

  it("⭐ a mensagem NUNCA repete a chave digitada", () => {
    const recusa = recusaDoValor("OMNIROUTER_API_KEY", "metade-um metade-dois") ?? "";
    expect(recusa).not.toContain("metade-um");
    expect(recusa).not.toContain("metade-dois");
  });
});

describe("OMNIROUTER_PARA_TODAS", () => {
  it.each(["true", "false", "TRUE", "False", "  true  "])("aceita %j", (valor) => {
    expect(recusaDoValor("OMNIROUTER_PARA_TODAS", valor)).toBeNull();
  });

  it.each(["sim", "1", "yes", "ligado", "verdadeiro"])("recusa %j (só true ou false)", (valor) => {
    expect(recusaDoValor("OMNIROUTER_PARA_TODAS", valor)).toMatch(/true.*false/);
  });
});

describe("as outras chaves", () => {
  it.each([
    ["SUPPORT_EMAIL", "ajuda@exemplo.com"],
    ["RESEND_API_KEY", "re_sintetica com espaço"],
    ["LGPD_DPO_EMAIL", "qualquer coisa"],
    ["CHAVE_QUE_NAO_EXISTE", "x"],
  ])("%s não tem regra própria: passa como antes", (chave, valor) => {
    expect(recusaDoValor(chave, valor)).toBeNull();
  });
});
