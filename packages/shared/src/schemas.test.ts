import { describe, expect, it } from "vitest";
import { PreferencesInputSchema, ProfileInputSchema } from "./schemas";

const validProfile = {
  displayName: "Ana",
  locale: "pt-BR",
  timezone: "America/Sao_Paulo",
  currency: "BRL",
};

describe("ProfileInputSchema", () => {
  it("aceita um perfil válido", () => {
    expect(ProfileInputSchema.safeParse(validProfile).success).toBe(true);
  });

  it("rejeita uid enviado pelo cliente", () => {
    expect(ProfileInputSchema.safeParse({ ...validProfile, uid: "outro" }).success).toBe(false);
  });

  it("rejeita moeda e locale inválidos", () => {
    expect(ProfileInputSchema.safeParse({ ...validProfile, currency: "real" }).success).toBe(false);
    expect(ProfileInputSchema.safeParse({ ...validProfile, locale: "portugues" }).success).toBe(false);
  });
});

describe("PreferencesInputSchema", () => {
  const valid = {
    theme: "dark",
    confirmCreations: false,
    quietHoursStart: "22:00",
    quietHoursEnd: "07:30",
  };

  it("aceita preferências válidas", () => {
    expect(PreferencesInputSchema.safeParse(valid).success).toBe(true);
  });

  it("rejeita horário e tema inválidos", () => {
    expect(PreferencesInputSchema.safeParse({ ...valid, quietHoursStart: "25:00" }).success).toBe(false);
    expect(PreferencesInputSchema.safeParse({ ...valid, theme: "neon" }).success).toBe(false);
  });

  it("rejeita campos desconhecidos", () => {
    expect(PreferencesInputSchema.safeParse({ ...valid, uid: "x" }).success).toBe(false);
  });
});
