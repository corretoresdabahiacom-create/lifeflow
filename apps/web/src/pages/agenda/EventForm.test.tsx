import type { CalendarEvent, Occurrence } from "@lifeflow/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = {
  createEvent: vi.fn(),
  patchEvent: vi.fn(),
  checkConflicts: vi.fn(),
};

vi.mock("../../app/ApiProvider", () => ({ useApi: () => api }));
vi.mock("../../app/ProfileProvider", () => ({
  useProfile: () => ({ profile: { currency: "BRL", locale: "pt-BR", displayName: "Ana", timezone: "America/Sao_Paulo" } }),
}));

import { EventForm } from "./EventForm";

const series: CalendarEvent = {
  id: "e1", uid: "u", title: "Aula", kind: "personal", description: null, startDate: "2026-11-10", startTime: "10:00",
  durationMin: 60, timeZone: "America/Sao_Paulo", location: null, contact: null, link: null, notes: null,
  estimatedCostCents: null, reminders: [], expenseTransactionId: null, createdAt: "", updatedAt: "",
  recurrence: { frequency: "weekly", interval: 1, weekdays: [], until: null, count: null },
};
const occurrence = { originalDate: "2026-11-17", startDate: "2026-11-17", startTime: "10:00", durationMin: 60, title: "Aula",
  kind: "personal", location: null, contact: null, link: null, notes: null, estimatedCostCents: null, reminders: [] } as unknown as Occurrence;

beforeEach(() => {
  api.createEvent.mockReset();
  api.patchEvent.mockReset();
  api.checkConflicts.mockReset().mockResolvedValue({ hasConflicts: false, conflicts: [] });
});
afterEach(cleanup);

const save = () => fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
const fillTitle = (title = "Dentista") => fireEvent.change(screen.getByLabelText("Título"), { target: { value: title } });

describe("EventForm", () => {
  it("avisa do conflito de horário, mas NÃO impede de salvar", async () => {
    api.checkConflicts.mockResolvedValue({
      hasConflicts: true,
      conflicts: [{ startDate: "2026-11-10", startUtc: "", endUtc: "", with: [{ key: "x@1", eventId: "x", title: "Reunião do time", startUtc: "", endUtc: "" }] }],
    });
    api.createEvent.mockResolvedValue({ id: "n1", conflicts: [] });
    const done = vi.fn();
    render(<EventForm defaultDate="2026-11-10" onDone={done} onCancel={() => undefined} />);
    const warning = await screen.findByText(/se sobrepõe a “Reunião do time”/, undefined, { timeout: 3000 });
    expect(warning).toBeTruthy();
    fillTitle();
    save();
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(done).toHaveBeenCalled());
  });

  it("envia Idempotency-Key; após erro de rede reenvia a MESMA chave; após sucesso a próxima é nova", async () => {
    api.createEvent.mockRejectedValueOnce(new TypeError("rede")).mockResolvedValueOnce({ conflicts: [] }).mockResolvedValueOnce({ conflicts: [] });
    const { rerender } = render(<EventForm defaultDate="2026-11-10" onDone={() => undefined} onCancel={() => undefined} />);
    fillTitle();
    save();
    await screen.findByRole("alert");
    save();
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledTimes(2));
    const keys = api.createEvent.mock.calls.map((c) => c[1] as string);
    expect(keys[0]).toMatch(/^web-/);
    expect(keys[1]).toBe(keys[0]);
    rerender(<EventForm defaultDate="2026-11-10" onDone={() => undefined} onCancel={() => undefined} />);
    save();
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledTimes(3));
    expect(api.createEvent.mock.calls[2]?.[1]).not.toBe(keys[0]);
  });

  it("não envia título vazio", () => {
    render(<EventForm defaultDate="2026-11-10" onDone={() => undefined} onCancel={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "" } });
    save();
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it("série: padrão é editar só a ocorrência (sem fuso nem recorrência)", async () => {
    api.patchEvent.mockResolvedValue({ conflicts: [] });
    render(<EventForm event={series} occurrence={occurrence} defaultDate="2026-11-17" onDone={() => undefined} onCancel={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Aula especial" } });
    save();
    await waitFor(() => expect(api.patchEvent).toHaveBeenCalledTimes(1));
    const [id, body] = api.patchEvent.mock.calls[0] as [string, { scope: string; occurrenceDate: string; changes: Record<string, unknown> }];
    expect(id).toBe("e1");
    expect(body.scope).toBe("one");
    expect(body.occurrenceDate).toBe("2026-11-17");
    expect(body.changes).toMatchObject({ title: "Aula especial" });
    expect(body.changes).not.toHaveProperty("recurrence");
    expect(body.changes).not.toHaveProperty("timeZone");
  });

  it("série: 'Esta e as próximas' usa a data da ocorrência escolhida", async () => {
    api.patchEvent.mockResolvedValue({ conflicts: [] });
    render(<EventForm event={series} occurrence={occurrence} defaultDate="2026-11-17" onDone={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(screen.getByLabelText("Esta e as próximas"));
    fireEvent.change(screen.getByLabelText("Horário"), { target: { value: "11:00" } });
    save();
    await waitFor(() => expect(api.patchEvent).toHaveBeenCalled());
    const body = api.patchEvent.mock.calls[0]?.[1] as { scope: string; occurrenceDate: string; changes: Record<string, unknown> };
    expect(body).toMatchObject({ scope: "following", occurrenceDate: "2026-11-17", changes: { startTime: "11:00", recurrence: { frequency: "weekly" } } });
  });

  it("série: 'Toda a série' mantém a data inicial da série quando a data não foi alterada", async () => {
    api.patchEvent.mockResolvedValue({ conflicts: [] });
    render(<EventForm event={series} occurrence={occurrence} defaultDate="2026-11-17" onDone={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(screen.getByLabelText("Toda a série"));
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Aula nova" } });
    save();
    await waitFor(() => expect(api.patchEvent).toHaveBeenCalled());
    const body = api.patchEvent.mock.calls[0]?.[1] as { scope: string; changes: Record<string, unknown> };
    expect(body.scope).toBe("all");
    expect(body.changes["startDate"]).toBe("2026-11-10"); // e não 2026-11-17
  });

  it("mostra o erro do servidor sem fechar o formulário", async () => {
    api.createEvent.mockRejectedValue(new Error("falhou"));
    const done = vi.fn();
    render(<EventForm defaultDate="2026-11-10" onDone={done} onCancel={() => undefined} />);
    fillTitle();
    save();
    expect((await screen.findByRole("alert")).textContent).toMatch(/conectar/i);
    expect(done).not.toHaveBeenCalled();
  });
});
