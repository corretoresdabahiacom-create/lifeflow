import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = {
  listTasks: vi.fn(),
  listTaskCategories: vi.fn(),
  createTask: vi.fn(),
  createTaskCategory: vi.fn(),
  completeTask: vi.fn(),
  patchTask: vi.fn(),
  deleteTask: vi.fn(),
  generateNotifications: vi.fn(),
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  dismissNotification: vi.fn(),
  readAllNotifications: vi.fn(),
  createReminder: vi.fn(),
};

vi.mock("../../app/ApiProvider", () => ({ useApi: () => api }));
vi.mock("../../app/ProfileProvider", () => ({
  useProfile: () => ({ profile: { currency: "BRL", locale: "pt-BR", displayName: "Ana", timezone: "America/Sao_Paulo" } }),
}));

import { NotificationsPage } from "./NotificationsPage";
import { TasksPage } from "./TasksPage";

const task = (over: Record<string, unknown> = {}) => ({
  id: "t1", uid: "u", title: "Pagar IPTU", description: null, priority: "high", categoryId: null, dueDate: "2026-11-01",
  dueTime: null, status: "pending", reminderMinutes: null, completedAt: null, createdAt: "", updatedAt: "", overdue: true, ...over,
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listTaskCategories.mockResolvedValue({ categories: [] });
});
afterEach(cleanup);

describe("TasksPage", () => {
  it("mostra tarefa atrasada com selo e conclui pelo botão", async () => {
    api.listTasks.mockResolvedValue({ tasks: [task()], total: 1, overdueCount: 1, truncated: false });
    api.completeTask.mockResolvedValue(task({ status: "completed", overdue: false }));
    render(<TasksPage />);
    expect(await screen.findByText("Atrasada")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Atrasadas \(1\)/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Concluir" }));
    await waitFor(() => expect(api.completeTask).toHaveBeenCalledWith("t1"));
  });

  it("o filtro 'Atrasadas' consulta a API com overdue=true", async () => {
    api.listTasks.mockResolvedValue({ tasks: [], total: 0, overdueCount: 0, truncated: false });
    render(<TasksPage />);
    await screen.findByText("Nenhuma tarefa aqui");
    fireEvent.click(screen.getByRole("button", { name: /^Atrasadas/ }));
    await waitFor(() => expect(api.listTasks).toHaveBeenLastCalledWith(expect.objectContaining({ overdue: "true" })));
  });

  it("cria tarefa enviando Idempotency-Key e exige prazo para o lembrete", async () => {
    api.listTasks.mockResolvedValue({ tasks: [], total: 0, overdueCount: 0, truncated: false });
    api.createTask.mockResolvedValue(task());
    render(<TasksPage />);
    await screen.findByText("Nenhuma tarefa aqui");
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Ligar" } });
    fireEvent.change(screen.getByLabelText("Lembrete"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar tarefa" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/prazo/i);
    expect(api.createTask).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Prazo"), { target: { value: "2026-11-20" } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar tarefa" }));
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(1));
    const [body, key] = api.createTask.mock.calls[0] as [Record<string, unknown>, string];
    expect(body).toMatchObject({ title: "Ligar", dueDate: "2026-11-20", reminderMinutes: 60 });
    expect(key).toMatch(/^web-/);
  });
});

describe("NotificationsPage", () => {
  const notification = (over: Record<string, unknown> = {}) => ({
    id: "n1", uid: "u", type: "event_reminder", title: "Consulta", body: "Começa em 30 min", sourceType: "event", sourceId: "e1",
    occurrenceKey: "k", triggerAt: "", silent: false, read: false, readAt: null, dismissed: false, createdAt: "", ...over,
  });

  it("gera ao abrir (idempotente no servidor), lista e marca como lida", async () => {
    api.generateNotifications.mockResolvedValue({ created: 1, hasMore: false });
    api.listNotifications.mockResolvedValue({ notifications: [notification(), notification({ id: "n2", title: "Dentista", read: true, silent: true })], unreadCount: 1 });
    api.markNotificationRead.mockResolvedValue(notification({ read: true }));
    render(<NotificationsPage />);
    expect(await screen.findByText("Consulta")).toBeTruthy();
    expect(api.generateNotifications).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Nova")).toBeTruthy();
    expect(screen.getByText("Horário silencioso")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Marcar como lida" }));
    await waitFor(() => expect(api.markNotificationRead).toHaveBeenCalledWith("n1"));
  });

  it("segue funcionando quando a geração falha", async () => {
    api.generateNotifications.mockRejectedValue(new Error("offline"));
    api.listNotifications.mockResolvedValue({ notifications: [], unreadCount: 0 });
    render(<NotificationsPage />);
    expect(await screen.findByText("Nenhuma notificação")).toBeTruthy();
  });

  it("lembrete avulso é enviado em UTC com Idempotency-Key", async () => {
    api.generateNotifications.mockResolvedValue({ created: 0, hasMore: false });
    api.listNotifications.mockResolvedValue({ notifications: [], unreadCount: 0 });
    api.createReminder.mockResolvedValue({ id: "r1" });
    render(<NotificationsPage />);
    await screen.findByText("Nenhuma notificação");
    fireEvent.change(screen.getByLabelText("O que lembrar"), { target: { value: "Ligar para a vovó" } });
    fireEvent.change(screen.getByLabelText("Quando"), { target: { value: "2026-11-20T10:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar lembrete" }));
    await waitFor(() => expect(api.createReminder).toHaveBeenCalledTimes(1));
    const [body, key] = api.createReminder.mock.calls[0] as [{ title: string; remindAt: string }, string];
    expect(body.title).toBe("Ligar para a vovó");
    expect(body.remindAt).toMatch(/^2026-11-20T\d{2}:\d{2}:00\.000Z$/);
    expect(key).toMatch(/^web-/);
  });
});
