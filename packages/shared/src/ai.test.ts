import { describe, expect, it } from "vitest";
import {
  AI_TOOL_NAMES,
  AiChatRequestSchema,
  AiConfirmSchema,
  AiConsentSchema,
  AiSettingsSchema,
  DEFAULT_AI_SETTINGS,
  DEFAULT_PLAN_AI_LIMITS,
} from "./ai";

describe("schemas da IA", () => {
  it("mensagem: aparada, obrigatória, limitada e sem campos extras", () => {
    expect(AiChatRequestSchema.parse({ message: "  oi  " }).message).toBe("oi");
    expect(AiChatRequestSchema.safeParse({ message: "   " }).success).toBe(false);
    expect(AiChatRequestSchema.safeParse({ message: "x".repeat(2001) }).success).toBe(false);
    expect(AiChatRequestSchema.safeParse({ message: "oi", uid: "outro" }).success).toBe(false);
  });
  it("configurações: inteiros dentro dos limites; padrão é válido", () => {
    expect(AiSettingsSchema.safeParse(DEFAULT_AI_SETTINGS).success).toBe(true);
    expect(AiSettingsSchema.safeParse({ ...DEFAULT_AI_SETTINGS, autoActionsPerDay: 101 }).success).toBe(false);
    expect(AiSettingsSchema.safeParse({ ...DEFAULT_AI_SETTINGS, autoValueLimitCents: 1.5 }).success).toBe(false);
    expect(AiSettingsSchema.safeParse({ ...DEFAULT_AI_SETTINGS, confirmAboveCents: -1 }).success).toBe(false);
  });
  it("confirmação e consentimento não aceitam parâmetros extras", () => {
    expect(AiConfirmSchema.safeParse({}).success).toBe(true);
    expect(AiConfirmSchema.safeParse({ reinforced: true }).success).toBe(true);
    expect(AiConfirmSchema.safeParse({ amountCents: 1 }).success).toBe(false);
    expect(AiConsentSchema.safeParse({ audio: "sim" }).success).toBe(false);
  });
  it("planos: gratuito sem voz; limites crescem com o plano; ferramentas sem duplicatas", () => {
    expect(DEFAULT_PLAN_AI_LIMITS.free.voiceMinutesPerMonth).toBe(0);
    expect(DEFAULT_PLAN_AI_LIMITS.pro.aiMessagesPerMonth).toBeGreaterThan(DEFAULT_PLAN_AI_LIMITS.free.aiMessagesPerMonth);
    expect(DEFAULT_PLAN_AI_LIMITS.premium_ai.aiMessagesPerMonth).toBeGreaterThan(DEFAULT_PLAN_AI_LIMITS.pro.aiMessagesPerMonth);
    expect(new Set(AI_TOOL_NAMES).size).toBe(AI_TOOL_NAMES.length);
    expect(AI_TOOL_NAMES).toHaveLength(23);
  });
});
