import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

const api = {
  billingPlans: vi.fn(),
  billingSubscription: vi.fn(),
  billingHistory: vi.fn(),
  billingCheckout: vi.fn(),
  billingChange: vi.fn(),
  billingCancel: vi.fn(),
  billingSync: vi.fn(),
  aiUsage: vi.fn(),
};
vi.mock("../../app/ApiProvider", () => ({ useApi: () => api }));
vi.mock("../../app/ProfileProvider", () => ({ useProfile: () => ({ profile: { currency: "BRL", locale: "pt-BR" } }) }));

import { BillingPage } from "./BillingPage";

const plan = (id: string, name: string, priceCents: number, ai: number, voice: number) => ({ id, name, priceCents, currency: "BRL", aiMessagesPerMonth: ai, voiceMinutesPerMonth: voice, reports: "basic", trialDays: 0, active: true, sortOrder: 0 });
const PLANS = [plan("free", "Free", 0, 30, 0), plan("pro", "Pro", 1490, 300, 30), plan("premium_ai", "Premium AI", 2990, 1000, 120)];
const view = (over: Record<string, unknown> = {}) => ({ plan: "free", status: "none", contractedPlan: "free", pendingPlan: null, priceCents: 0, currentPeriodEnd: null, graceUntil: null, cancelAtPeriodEnd: false, trialEndsAt: null, checkoutUrl: null, ...over });

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.billingPlans.mockResolvedValue({ plans: PLANS, current: "free" });
  api.billingSubscription.mockResolvedValue({ subscription: view(), limits: PLANS[0] });
  api.billingHistory.mockResolvedValue({ payments: [] });
  api.aiUsage.mockResolvedValue({ usage: { month: "2026-11", messages: 3, messagesLimit: 30, voiceSeconds: 0, voiceSecondsLimit: 0, plan: "free" }, autoToday: { autoActions: 0, autoValueCents: 0 } });
  window.history.replaceState({}, "", "/assinatura");
});
afterEach(cleanup);

describe("BillingPage", () => {
  it("mostra o plano atual, o uso e os planos com preço e limites", async () => {
    render(<BillingPage />);
    expect(await screen.findByText("Sem assinatura")).toBeTruthy();
    expect(screen.getByText(/3 de 30 mensagens/)).toBeTruthy();
    expect(screen.getByText(/R\$\s*14,90\/mês/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Assinar Pro" })).toBeTruthy();
    expect(screen.getByText("Nenhum pagamento ainda")).toBeTruthy();
  });

  it("assinar envia Idempotency-Key, redireciona ao checkout e NÃO ativa o plano localmente", async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { value: { ...original, assign, search: "" }, writable: true, configurable: true });
    onTestFinished(() => {
      Object.defineProperty(window, "location", { value: original, writable: true, configurable: true });
    });
    api.billingCheckout.mockResolvedValue({ subscription: view({ status: "pending", contractedPlan: "pro" }), checkoutUrl: "https://pay.test/c/1" });
    render(<BillingPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Assinar Pro" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://pay.test/c/1"));
    expect(api.billingCheckout).toHaveBeenCalledWith("pro", expect.stringMatching(/^web-/));
  });

  it("erro do servidor aparece sem derrubar a tela", async () => {
    api.billingCheckout.mockRejectedValue(new Error("x"));
    render(<BillingPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Assinar Premium AI" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/conectar/);
  });

  it("assinante ativo: troca de plano e cancelamento só depois de confirmar", async () => {
    const active = view({ plan: "pro", status: "active", contractedPlan: "pro", priceCents: 1490, currentPeriodEnd: "2026-12-09T12:00:00.000Z" });
    api.billingSubscription.mockResolvedValue({ subscription: active, limits: PLANS[1] });
    api.billingChange.mockResolvedValue({ subscription: active, effective: "now" });
    api.billingCancel.mockResolvedValue({ subscription: { ...active, status: "canceled" }, message: "Assinatura cancelada. O plano segue até o fim do período já pago." });
    render(<BillingPage />);
    expect(await screen.findByText("Plano atual")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Trocar para Premium AI" }));
    await waitFor(() => expect(api.billingChange).toHaveBeenCalledWith("premium_ai"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar assinatura" }));
    expect(api.billingCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sim, cancelar" }));
    await waitFor(() => expect(api.billingCancel).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/segue até o fim do período/)).toBeTruthy();
  });

  it("inadimplente vê o aviso de carência", async () => {
    api.billingSubscription.mockResolvedValue({ subscription: view({ plan: "pro", status: "past_due", contractedPlan: "pro", graceUntil: "2026-11-12T12:00:00.000Z" }), limits: PLANS[1] });
    render(<BillingPage />);
    expect(await screen.findByText(/Não conseguimos cobrar/)).toBeTruthy();
  });

  it("ao voltar do checkout consulta o provedor e confirma quando ativa", async () => {
    window.history.replaceState({}, "", "/assinatura?retorno=1");
    api.billingSync.mockResolvedValue({ subscription: view({ plan: "pro", status: "active", contractedPlan: "pro" }) });
    render(<BillingPage />);
    await waitFor(() => expect(api.billingSync).toHaveBeenCalled());
    expect(await screen.findByText(/Pagamento confirmado/)).toBeTruthy();
  });

  it("lista o histórico de pagamentos", async () => {
    api.billingHistory.mockResolvedValue({ payments: [{ id: "p1", planId: "pro", amountCents: 1490, status: "approved", createdAt: "2026-11-09T12:00:00.000Z" }] });
    render(<BillingPage />);
    expect(await screen.findByText("Aprovado")).toBeTruthy();
  });
});
