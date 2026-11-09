import { describe, expect, it } from "vitest";
import { loadStoredTheme, resolveTheme, storeTheme } from "./theme";

describe("tema", () => {
  it("resolve 'system' conforme a preferência do sistema", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("lê tema salvo e ignora valores inválidos", () => {
    expect(loadStoredTheme({ getItem: () => "dark" })).toBe("dark");
    expect(loadStoredTheme({ getItem: () => "neon" })).toBe("system");
    expect(loadStoredTheme({ getItem: () => null })).toBe("system");
    expect(loadStoredTheme(null)).toBe("system");
  });

  it("tolera armazenamento que lança exceção", () => {
    const broken = {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
    };
    expect(loadStoredTheme(broken)).toBe("system");
    expect(() => storeTheme(broken, "dark")).not.toThrow();
  });
});
