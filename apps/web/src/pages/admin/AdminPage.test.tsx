import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = {
  adminOverview: vi.fn(),
  adminPlans: vi.fn(),
  adminPutPlan: vi.fn(),
  adminSubscriptions: vi.fn(),
  adminSubscription: vi.fn(),
  adminLogs: vi.fn(),
  adminIntegrations: vi.fn(),
};
let isAdmin = true;
vi.mock("../../app/ApiProvider", () => ({ useApi: () => api }));
vi.mock("../../app/ProfileProvider", () => ({ useProfile: () => ({ profile: { currency: "BRL", locale: "pt-BR" } }) }));
vi.mock("../../auth/context", () => ({ useAuth: () => ({ isAdmin }) }));

import AdminPage from "./AdminPage";

const overview = {
  generatedAt: "2026-11-09T12:00:00.000Z",
  users: { total: 12 },
  activity: { aiActiveUsersThisMonth: 4 },
  subscriptions: { byStatus: { active: 3 }, activeByPlan: { pro: 3 }, mrrCents: 4470, canceledLast30d: 1, truncated: false },
  ai: { activeUsers: 4, messages: 77, voiceSeconds: 0, inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.5, costNote: "Estimativa.", truncated: false },
  errors: { aiProviderErrorsThisMonth: 2, failedWebhooks: 1 },
  notifications: { available: false, note: "Notificações não implementadas" },
};
const plan = { id: "pro", name: "Pro", priceCents: 1490, currency: "BRL", aiMessagesPerMonth: 300, voiceMinutesPerMonth: 30, reports: "full", trialDays: 0, active: true, sortOrder: 1 };

beforeEach(() => {
  isAdmin = true;
  for (const fn of Object.values(api)) fn.mockReset();
  api.adminOverview.mockResolvedValue(overview);
  api.adminPlans.mockResolvedValue({ plans: [plan] });
});
afterEach(cleanup);

describe("AdminPage", () => {
  it("quem não é admin vê acesso restrito e nenhuma chamada administrativa é feita", () => {
    isAdmin = false;
    render(<AdminPage />);
    expect(screen.getByText("Acesso restrito")).toBeTruthy();
    expect(api.adminOverview).not.toHaveBeenCalled();
  });

  it("mostra os indicadores", async () => {
    render(<AdminPage />);
    expect(await screen.findByText("77")).toBeTruthy();
    expect(screen.getByText(/R\$\s*44,70/)).toBeTruthy();
    expect(screen.getByText(/Notificações não implementadas/)).toBeTruthy();
  });

  it("edita um plano e envia só os campos do contrato", async () => {
    api.adminPutPlan.mockResolvedValue({ plan });
    render(<AdminPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Planos e limites" }));
    fireEvent.change(await screen.findByLabelText("Mensagens de IA por mês"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(api.adminPutPlan).toHaveBeenCalledWith("pro", { name: "Pro", priceCents: 1490, aiMessagesPerMonth: 500, voiceMinutesPerMonth: 30, reports: "full", trialDays: 0, active: true }));
    expect(await screen.findByText("Plano salvo.")).toBeTruthy();
  });

  it("lista assinaturas e abre o detalhe", async () => {
    api.adminSubscriptions.mockResolvedValue({ subscriptions: [{ uid: "abcdef123456", planId: "pro", pendingPlanId: null, status: "active", priceCents: 1490, currentPeriodEnd: null, graceUntil: null, cancelAtPeriodEnd: false, createdAt: "", updatedAt: "" }] });
    api.adminSubscription.mockResolvedValue({ subscription: {}, payments: [{ id: "p", planId: "pro", amountCents: 1490, status: "approved", createdAt: "2026-11-09T12:00:00.000Z" }] });
    render(<AdminPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Assinaturas" }));
    fireEvent.click(await screen.findByRole("button", { name: "Detalhes" }));
    expect(await screen.findByText(/approved/)).toBeTruthy();
  });

  it("logs e integrações (só estado, nunca valores)", async () => {
    api.adminLogs.mockResolvedValue({ kind: "admin", logs: [{ id: "1", action: "plans.update" }] });
    api.adminIntegrations.mockResolvedValue({ integrations: [{ name: "LLM (DeepSeek)", configured: false }], note: "Chaves ficam no ambiente." });
    render(<AdminPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    expect(await screen.findByText(/plans.update/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Integrações" }));
    expect(await screen.findByText("não configurado")).toBeTruthy();
  });
});
