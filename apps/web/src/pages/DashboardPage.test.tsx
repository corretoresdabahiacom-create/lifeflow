import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinanceOverview } from "../lib/api";

const bucket = (count: number, totalCents: number) => ({ count, totalCents });
const overview: FinanceOverview = {
  today: "2026-11-09",
  month: { from: "2026-11-01", to: "2026-11-30" },
  totalBalanceCents: 130000,
  accounts: [
    { id: "a1", name: "Corrente", type: "checking", balanceCents: 100000 },
    { id: "a2", name: "Poupança", type: "savings", balanceCents: 30000 },
  ],
  monthSummary: { incomeCents: 50000, expenseCents: 20000, netCents: 30000, truncated: false },
  payables: {
    overdueToPay: bucket(1, 5000),
    overdueToReceive: bucket(0, 0),
    next7ToPay: bucket(2, 9000),
    next7ToReceive: bucket(0, 0),
    next30ToPay: bucket(2, 9000),
    next30ToReceive: bucket(0, 0),
    truncated: false,
  },
};
const api = { overview: vi.fn() };

vi.mock("../app/ApiProvider", () => ({ useApi: () => api }));
vi.mock("../app/ProfileProvider", () => ({
  useProfile: () => ({ profile: { currency: "BRL", locale: "pt-BR", displayName: "Ana" } }),
}));

import { DashboardPage } from "./DashboardPage";

afterEach(() => {
  cleanup();
  api.overview.mockReset();
});

const norm = (text: string | null | undefined) => (text ?? "").replace(/\s/g, " ");

describe("DashboardPage", () => {
  it("mostra os números vindos da API", async () => {
    api.overview.mockResolvedValue(overview);
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("Olá, Ana")).toBeTruthy());
    await waitFor(() => expect(screen.getAllByText(/1\.300,00/).length).toBeGreaterThan(0));
    const text = norm(document.body.textContent);
    expect(text).toContain("R$ 1.300,00"); // saldo total
    expect(text).toContain("R$ 500,00"); // receitas do mês
    expect(text).toContain("R$ 200,00"); // despesas do mês
    expect(text).toContain("R$ 300,00"); // resultado
    expect(text).toContain("R$ 50,00"); // vencidas a pagar
    expect(text).toContain("2 contas");
  });

  it("sem contas, orienta a criar a primeira", async () => {
    api.overview.mockResolvedValue({ ...overview, totalBalanceCents: 0, accounts: [] });
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    expect(await screen.findByText("Nenhuma conta ainda")).toBeTruthy();
  });

  it("em falha da API, mostra erro com nova tentativa (sem inventar números)", async () => {
    api.overview.mockRejectedValue(new Error("falhou"));
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeTruthy();
    expect(norm(document.body.textContent)).not.toContain("R$ 1.300,00");
  });
});
