import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";

const api = {
  aiChat: vi.fn(),
  aiListConversations: vi.fn(),
  aiGetConversation: vi.fn(),
  aiDeleteConversation: vi.fn(),
  aiPendingActions: vi.fn(),
  aiConfirm: vi.fn(),
  aiReject: vi.fn(),
  aiHistory: vi.fn(),
  aiUsage: vi.fn(),
  aiGetSettings: vi.fn(),
  aiPutSettings: vi.fn(),
  aiGetConsent: vi.fn(),
  aiPutConsent: vi.fn(),
  aiTranscribe: vi.fn(),
};
vi.mock("../../app/ApiProvider", () => ({ useApi: () => api }));
vi.mock("../../app/ProfileProvider", () => ({
  useProfile: () => ({ profile: { currency: "BRL", locale: "pt-BR", displayName: "Ana", timezone: "America/Sao_Paulo" } }),
}));

import { AssistantPage } from "./AssistantPage";

const usage = { month: "2026-11", messages: 1, messagesLimit: 30, voiceSeconds: 0, voiceSecondsLimit: 0, plan: "free" };
const action = (over: Record<string, unknown> = {}) => ({
  id: "act1", tool: "create_transaction", summary: "Registrar despesa de R$ 50,00 em Carteira (Almoço)", status: "pending",
  reinforced: false, resultNote: null, expiresAt: "2026-11-09T12:15:00.000Z", createdAt: "2026-11-09T12:00:00.000Z", ...over,
});
const reply = (actions: unknown[] = [action()]) => ({
  conversationId: "c1",
  reply: { id: "m1a", role: "assistant", content: "Preparei o registro; aguarda sua confirmação.", createdAt: "2026-11-09T12:00:01.000Z" },
  actions,
  usage,
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.aiListConversations.mockResolvedValue({ conversations: [] });
  api.aiUsage.mockResolvedValue({ usage, autoToday: { autoActions: 0, autoValueCents: 0 } });
  api.aiPendingActions.mockResolvedValue({ actions: [] });
});
afterEach(cleanup);

async function sendMessage(text = "gastei 50 no almoço") {
  fireEvent.change(await screen.findByLabelText("Sua mensagem"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
}

describe("AssistantPage", () => {
  it("envia a mensagem com Idempotency-Key e mostra a ação proposta SEM executar nada", async () => {
    api.aiChat.mockResolvedValue(reply());
    render(<AssistantPage />);
    await sendMessage();
    expect(await screen.findByText(/Registrar despesa de R\$ 50,00/)).toBeTruthy();
    expect(api.aiChat).toHaveBeenCalledWith("gastei 50 no almoço", undefined, expect.stringMatching(/^web-/));
    expect(api.aiConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("Aguardando sua confirmação")).toBeTruthy();
    expect(screen.getByText(/1 de 30 mensagens/)).toBeTruthy();
  });

  it("reenvio após falha usa a MESMA chave (não gasta outra mensagem nem duplica ações)", async () => {
    api.aiChat.mockRejectedValueOnce(new ApiError(504, "ai_provider_timeout", "O assistente demorou para responder. Tente novamente."));
    api.aiChat.mockResolvedValueOnce(reply());
    render(<AssistantPage />);
    await sendMessage();
    expect(await screen.findByText(/demorou para responder/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(api.aiChat).toHaveBeenCalledTimes(2));
    expect(api.aiChat.mock.calls[0]?.[2]).toBe(api.aiChat.mock.calls[1]?.[2]);
  });

  it("confirma uma ação pendente (confirmação simples não envia 'reinforced')", async () => {
    api.aiChat.mockResolvedValue(reply());
    api.aiConfirm.mockResolvedValue({ action: action({ status: "done", resultNote: "Concluída." }) });
    render(<AssistantPage />);
    await sendMessage();
    fireEvent.click(await screen.findByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(api.aiConfirm).toHaveBeenCalledWith("act1", false));
    expect(await screen.findByText("Concluída")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
  });

  it("valor alto: exige marcar a conferência e envia confirmação reforçada", async () => {
    api.aiChat.mockResolvedValue(reply([action({ reinforced: true })]));
    api.aiConfirm.mockResolvedValue({ action: action({ status: "done", reinforced: true }) });
    render(<AssistantPage />);
    await sendMessage("comprei um notebook de 800");
    expect(await screen.findByText(/acima do seu limite de segurança/)).toBeTruthy();
    const button = screen.getByRole("button", { name: "Confirmar" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Conferi e quero confirmar"));
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(api.aiConfirm).toHaveBeenCalledWith("act1", true));
  });

  it("recusar chama a API de recusa e mostra o novo estado", async () => {
    api.aiChat.mockResolvedValue(reply());
    api.aiReject.mockResolvedValue({ action: action({ status: "rejected" }) });
    render(<AssistantPage />);
    await sendMessage();
    fireEvent.click(await screen.findByRole("button", { name: "Recusar" }));
    await waitFor(() => expect(api.aiReject).toHaveBeenCalledWith("act1"));
    expect(await screen.findByText("Recusada")).toBeTruthy();
  });

  it("mostra o erro do servidor ao confirmar (ex.: ação expirada) e mantém os botões", async () => {
    api.aiChat.mockResolvedValue(reply());
    api.aiConfirm.mockRejectedValue(new ApiError(410, "action_expired", "Esta ação expirou. Peça novamente."));
    render(<AssistantPage />);
    await sendMessage();
    fireEvent.click(await screen.findByRole("button", { name: "Confirmar" }));
    expect(await screen.findByText("Esta ação expirou. Peça novamente.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recusar" })).toBeTruthy();
  });

  it("ações pendentes de conversas anteriores aparecem ao abrir a tela", async () => {
    api.aiPendingActions.mockResolvedValue({ actions: [action({ summary: "Criar tarefa «Ligar para o contador»" })] });
    render(<AssistantPage />);
    expect(await screen.findByText(/Ligar para o contador/)).toBeTruthy();
  });

  it("abre uma conversa anterior e permite apagá-la", async () => {
    api.aiListConversations.mockResolvedValue({ conversations: [{ id: "c9", title: "Dentista", updatedAt: "2026-11-08T10:00:00.000Z" }] });
    api.aiGetConversation.mockResolvedValue({
      id: "c9",
      title: "Dentista",
      messages: [{ id: "a", role: "user", content: "marque dentista", createdAt: "" }],
      actions: [],
    });
    api.aiDeleteConversation.mockResolvedValue({ deleted: true });
    render(<AssistantPage />);
    const select = await screen.findByLabelText("Conversa");
    await screen.findByRole("option", { name: "Dentista" });
    fireEvent.change(select, { target: { value: "c9" } });
    expect(await screen.findByText("marque dentista")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apagar conversa" }));
    await waitFor(() => expect(api.aiDeleteConversation).toHaveBeenCalledWith("c9"));
  });

  it("o botão de voz não aparece quando o navegador não tem microfone/gravação", async () => {
    render(<AssistantPage />);
    await screen.findByLabelText("Sua mensagem");
    expect(screen.queryByRole("button", { name: /Falar/ })).toBeNull();
  });
});

describe("AssistantSettings", () => {
  const settings = { settings: { autoActionsPerDay: 20, autoValueLimitCents: 100000, confirmAboveCents: 50000 }, defaults: { autoActionsPerDay: 20, autoValueLimitCents: 100000, confirmAboveCents: 50000 } };
  beforeEach(() => {
    api.aiGetSettings.mockResolvedValue(settings);
    api.aiGetConsent.mockResolvedValue({ audio: false, updatedAt: null });
    api.aiHistory.mockResolvedValue({
      history: [{ id: "h1", event: "proposed", tool: "create_transaction", actionId: "act1", detail: "Registrar despesa", createdAt: "2026-11-09T12:00:00.000Z" }],
    });
  });

  async function openSettings() {
    render(<AssistantPage />);
    fireEvent.click(screen.getByRole("tab", { name: /Privacidade/ }));
  }

  it("mostra o histórico de ações da IA e o estado do consentimento", async () => {
    await openSettings();
    expect(await screen.findByText("Proposta criada")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /Permitir enviar áudio/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("concede e revoga o consentimento de áudio", async () => {
    api.aiPutConsent.mockResolvedValue({ audio: true, updatedAt: "" });
    await openSettings();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Permitir enviar áudio/ }));
    await waitFor(() => expect(api.aiPutConsent).toHaveBeenCalledWith(true));
  });

  it("salva os limites de automação", async () => {
    api.aiPutSettings.mockResolvedValue(settings);
    await openSettings();
    fireEvent.change(await screen.findByLabelText("Ações automáticas por dia"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar limites" }));
    await waitFor(() =>
      expect(api.aiPutSettings).toHaveBeenCalledWith({ autoActionsPerDay: 5, autoValueLimitCents: 100000, confirmAboveCents: 50000 }),
    );
    expect(await screen.findByText("Limites salvos.")).toBeTruthy();
  });
});
