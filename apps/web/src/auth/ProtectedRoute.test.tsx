import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ProtectedRoute } from "./ProtectedRoute";
import { AuthContext, type AuthContextValue } from "./context";

const base: AuthContextValue = {
  user: null,
  loading: false,
  configured: true,
  signIn: async () => undefined,
  signUp: async () => undefined,
  signOut: async () => undefined,
  getIdToken: async () => "token",
};

function renderAt(value: Partial<AuthContextValue>) {
  return render(
    <AuthContext.Provider value={{ ...base, ...value }}>
      <MemoryRouter initialEntries={["/privado"]}>
        <Routes>
          <Route path="/login" element={<p>Tela de login</p>} />
          <Route
            path="/privado"
            element={
              <ProtectedRoute>
                <p>Conteúdo privado</p>
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("ProtectedRoute", () => {
  it("sem sessão (ex.: após logout) redireciona ao login e não mostra o conteúdo", () => {
    renderAt({ user: null });
    expect(screen.getByText("Tela de login")).toBeInTheDocument();
    expect(screen.queryByText("Conteúdo privado")).not.toBeInTheDocument();
  });

  it("com sessão mostra o conteúdo", () => {
    renderAt({ user: { uid: "userA", email: "a@example.com" } });
    expect(screen.getByText("Conteúdo privado")).toBeInTheDocument();
  });

  it("enquanto restaura a sessão mostra carregamento, sem conteúdo nem redirecionamento", () => {
    renderAt({ loading: true });
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText("Conteúdo privado")).not.toBeInTheDocument();
    expect(screen.queryByText("Tela de login")).not.toBeInTheDocument();
  });
});
