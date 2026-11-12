import { describe, expect, it } from "vitest";
import { BILLING_GRACE_DAYS, ChangePlanRequestSchema, CheckoutRequestSchema, DEFAULT_PLANS, PlanConfigInputSchema } from "./billing";

describe("planos e cobrança (shared)", () => {
  it("padrões do contrato", () => {
    expect(Object.values(DEFAULT_PLANS).map((p) => [p.id, p.priceCents])).toEqual([["free", 0], ["pro", 1490], ["premium_ai", 2990]]);
    expect(BILLING_GRACE_DAYS).toBe(3);
  });
  it("checkout/troca só aceitam planos pagos e rejeitam campos extras", () => {
    for (const schema of [CheckoutRequestSchema, ChangePlanRequestSchema]) {
      expect(schema.safeParse({ planId: "pro" }).success).toBe(true);
      expect(schema.safeParse({ planId: "premium_ai" }).success).toBe(true);
      expect(schema.safeParse({ planId: "free" }).success).toBe(false);
      expect(schema.safeParse({ planId: "pro", uid: "x" }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
    }
  });
  it("edição de plano: limites e tipos", () => {
    const ok = { name: "Pro", priceCents: 1490, aiMessagesPerMonth: 300, voiceMinutesPerMonth: 30, reports: "full", trialDays: 0, active: true };
    expect(PlanConfigInputSchema.safeParse(ok).success).toBe(true);
    for (const bad of [{ priceCents: -1 }, { priceCents: 1.5 }, { aiMessagesPerMonth: -1 }, { trialDays: 91 }, { reports: "ultra" }, { name: "" }, { extra: 1 }]) {
      expect(PlanConfigInputSchema.safeParse({ ...ok, ...bad }).success).toBe(false);
    }
  });
});
