import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = { exportAccount: vi.fn(), deleteAccount: vi.fn() };
const auth = { reauthenticate: vi.fn(), deleteAuthUser: vi.fn(), signOut: vi.fn() };
vi.mock("../app/ApiProvider", () => ({ useApi: () => api }));
vi.mock("../auth/context", () => ({ useAuth: () => auth }));
vi.mock("../app/ProfileProvider", () => ({ useProfile: () => ({ profile: null, save: vi.fn() }) }));
vi.mock("../app/ThemeProvider", () => ({ useTheme: () => ({ theme: "system", setTheme: vi.fn() }) }));

import { AccountSection, DELETE_PHRASE } from "./SettingsPage";

beforeEach(() => {
  for (const fn of [...Object.values(api), ...Object.values(auth)]) fn.mockReset();
  auth.reauthenticate.mockResolvedValue(undefined);
  auth.deleteAuthUser.mockResolvedValue(undefined);
  auth.signOut.mockResolvedValue(undefined);
  api.deleteAccount.mockResolvedValue({ deleted: true, documents: 12 });
});
afterEach(cleanup);

function fill(password: string, phrase: string) {
  fireEvent.change(screen.getByLabelText("Sua senha"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(new RegExp(`digite ${DELETE_PHRASE}`)), { target: { value: phrase } });
  fireEvent.click(screen.getByRole("button", { name: "Excluir minha conta" }));
}

describe("AccountSection (exportar e excluir conta)", () => {
  it("exporta os dados chamando a API e gerando um download", async () => {
    api.exportAccount.mockResolvedValue(new Blob(["{}"]));
    URL.createObjectURL = vi.fn(() => "blob:x");
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    URL.revokeObjectURL = vi.fn();
    render(<AccountSection />);
    fireEvent.click(screen.getByRole("button", { name: /Exportar meus dados/ }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Arquivo gerado"));
    expect(api.exportAccount).toHaveBeenCalledTimes(1);
  });

  it("mostra o erro quando a exportação falha", async () => {
    api.exportAccount.mockRejectedValue(new Error("falha"));
    render(<AccountSection />);
    fireEvent.click(screen.getByRole("button", { name: /Exportar meus dados/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  });

  it("não exclui sem a frase exata de confirmação", async () => {
    render(<AccountSection />);
    fill("segredo123", "excluir");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(DELETE_PHRASE));
    expect(auth.reauthenticate).not.toHaveBeenCalled();
    expect(api.deleteAccount).not.toHaveBeenCalled();
  });

  it("senha incorreta: nada é apagado", async () => {
    auth.reauthenticate.mockRejectedValue(new Error("auth/wrong-password"));
    render(<AccountSection />);
    fill("errada", DELETE_PHRASE);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Senha incorreta"));
    expect(api.deleteAccount).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("fluxo completo: reautentica, apaga no servidor, remove o login e encerra a sessão (nesta ordem)", async () => {
    const order: string[] = [];
    auth.reauthenticate.mockImplementation(async () => void order.push("reauth"));
    api.deleteAccount.mockImplementation(async () => void order.push("api"));
    auth.deleteAuthUser.mockImplementation(async () => void order.push("deleteUser"));
    auth.signOut.mockImplementation(async () => void order.push("signOut"));
    render(<AccountSection />);
    fill("segredo123", DELETE_PHRASE);
    await waitFor(() => expect(order).toEqual(["reauth", "api", "deleteUser", "signOut"]));
    expect(auth.reauthenticate).toHaveBeenCalledWith("segredo123");
  });

  it("falha do servidor: não remove o login nem sai (os dados continuam existindo)", async () => {
    api.deleteAccount.mockRejectedValue(new Error("502"));
    render(<AccountSection />);
    fill("segredo123", DELETE_PHRASE);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(auth.deleteAuthUser).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("se remover o login falhar depois de apagar os dados, ainda encerra a sessão", async () => {
    auth.deleteAuthUser.mockRejectedValue(new Error("requires-recent-login"));
    render(<AccountSection />);
    fill("segredo123", DELETE_PHRASE);
    await waitFor(() => expect(auth.signOut).toHaveBeenCalled());
  });
});
