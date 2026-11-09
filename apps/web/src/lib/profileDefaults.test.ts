import { ProfileInputSchema } from "@lifeflow/shared";
import { describe, expect, it } from "vitest";
import { defaultProfileFor, normalizeLocale } from "./profileDefaults";

describe("perfil padrão", () => {
  it("usa a parte local do e-mail como nome", () => {
    expect(defaultProfileFor("ana.silva@example.com", "pt-br", "America/Bahia").displayName).toBe("ana.silva");
  });

  it("sempre gera um perfil aceito pelo schema compartilhado", () => {
    for (const email of ["a@b.c", "", null, undefined, "x".repeat(200) + "@y.com"]) {
      const profile = defaultProfileFor(email, "en-us", undefined);
      expect(ProfileInputSchema.safeParse(profile).success).toBe(true);
    }
  });

  it("normaliza locale", () => {
    expect(normalizeLocale("pt-br")).toBe("pt-BR");
    expect(normalizeLocale("EN")).toBe("en");
    expect(normalizeLocale("zh-Hans-CN")).toBe("zh");
    expect(normalizeLocale("???")).toBe("pt-BR");
    expect(normalizeLocale(undefined)).toBe("pt-BR");
  });
});
