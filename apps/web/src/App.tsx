import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ApiProvider } from "./app/ApiProvider";
import { Layout } from "./app/Layout";
import { ProfileProvider } from "./app/ProfileProvider";
import { ThemeProvider } from "./app/ThemeProvider";
import { AuthProvider } from "./auth/AuthProvider";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { DashboardPage } from "./pages/DashboardPage";
import { LoginPage } from "./pages/LoginPage";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <ProtectedRoute>
                  <ApiProvider>
                    <ProfileProvider>
                      <Layout />
                    </ProfileProvider>
                  </ApiProvider>
                </ProtectedRoute>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="financas" element={<PlaceholderPage title="Finanças" phase="Fase 2" />} />
              <Route path="agenda" element={<PlaceholderPage title="Agenda e tarefas" phase="Fase 3" />} />
              <Route path="assistente" element={<PlaceholderPage title="Assistente" phase="Fase 4" />} />
              <Route path="ajustes" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
