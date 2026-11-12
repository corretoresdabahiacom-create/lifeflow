import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ApiProvider } from "./app/ApiProvider";
import { Layout } from "./app/Layout";
import { ProfileProvider } from "./app/ProfileProvider";
import { ThemeProvider } from "./app/ThemeProvider";
import { AuthProvider } from "./auth/AuthProvider";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { DashboardPage } from "./pages/DashboardPage";
import { AgendaLayout } from "./pages/agenda/AgendaLayout";
import { CalendarPage } from "./pages/agenda/CalendarPage";
import { NotificationsPage } from "./pages/agenda/NotificationsPage";
import { TasksPage } from "./pages/agenda/TasksPage";
import { AccountsPage } from "./pages/finance/AccountsPage";
import { FinanceLayout } from "./pages/finance/FinanceLayout";
import { PayablesPage } from "./pages/finance/PayablesPage";
import { ReportsPage } from "./pages/finance/ReportsPage";
import { TransactionsPage } from "./pages/finance/TransactionsPage";
import { LoadingState } from "./components/States";
import { LoginPage } from "./pages/LoginPage";
import { AssistantPage } from "./pages/assistant/AssistantPage";
import { BillingPage } from "./pages/billing/BillingPage";
import { SettingsPage } from "./pages/SettingsPage";

const AdminPage = lazy(() => import("./pages/admin/AdminPage"));

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
              <Route path="financas" element={<FinanceLayout />}>
                <Route index element={<TransactionsPage />} />
                <Route path="contas" element={<AccountsPage />} />
                <Route path="pagar-receber" element={<PayablesPage />} />
                <Route path="relatorios" element={<ReportsPage />} />
              </Route>
              <Route path="agenda" element={<AgendaLayout />}>
                <Route index element={<CalendarPage />} />
                <Route path="tarefas" element={<TasksPage />} />
                <Route path="notificacoes" element={<NotificationsPage />} />
              </Route>
              <Route path="assistente" element={<AssistantPage />} />
              <Route path="assinatura" element={<BillingPage />} />
              <Route
                path="admin"
                element={
                  <Suspense fallback={<LoadingState />}>
                    <AdminPage />
                  </Suspense>
                }
              />
              <Route path="ajustes" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
