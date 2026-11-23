import { describe, expect, it } from "vitest";
import { authErrorMessage } from "./errors";

describe("authErrorMessage", () => {
  it("credencial inválida tem mensagem única (não revela se o e-mail existe)", () => {
    expect(authErrorMessage({ code: "invalid_credentials" })).toBe("E-mail ou senha incorretos.");
  });

  it("traduz códigos conhecidos e usa mensagem genérica para o resto", () => {
    expect(authErrorMessage({ code: "user_already_exists" })).toContain("já está cadastrado");
    expect(authErrorMessage({ code: "email_confirmation_required" })).toContain("confirmação");
    expect(authErrorMessage({ code: "algo_novo" })).toContain("Não foi possível");
    expect(authErrorMessage(new Error("interno com segredo"))).not.toContain("segredo");
    expect(authErrorMessage(null)).toContain("Não foi possível");
  });

  it("falha de rede e limite de tentativas têm mensagens próprias", () => {
    expect(authErrorMessage({ name: "AuthRetryableFetchError", status: 0 })).toContain("Sem conexão");
    expect(authErrorMessage({ status: 429 })).toContain("Muitas tentativas");
  });
});
