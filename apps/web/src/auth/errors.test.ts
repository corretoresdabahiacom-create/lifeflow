import { describe, expect, it } from "vitest";
import { authErrorMessage } from "./errors";

describe("authErrorMessage", () => {
  it("não diferencia usuário inexistente de senha errada", () => {
    expect(authErrorMessage({ code: "auth/user-not-found" })).toBe(authErrorMessage({ code: "auth/wrong-password" }));
    expect(authErrorMessage({ code: "auth/invalid-credential" })).toBe(authErrorMessage({ code: "auth/wrong-password" }));
  });

  it("traduz códigos conhecidos e usa mensagem genérica para o resto", () => {
    expect(authErrorMessage({ code: "auth/email-already-in-use" })).toContain("já está cadastrado");
    expect(authErrorMessage({ code: "auth/algo-novo" })).toContain("Não foi possível");
    expect(authErrorMessage(new Error("interno com segredo"))).not.toContain("segredo");
    expect(authErrorMessage(null)).toContain("Não foi possível");
  });
});
