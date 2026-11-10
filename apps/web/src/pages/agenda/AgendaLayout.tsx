import { useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useApi } from "../../app/ApiProvider";
import { useLoad } from "../../lib/useLoad";

/** Intervalo entre verificações de lembretes com a agenda aberta (cada uma lê o banco; ver COSTS.md). */
const CHECK_EVERY_MS = 5 * 60_000;

export function AgendaLayout() {
  const api = useApi();
  const location = useLocation();
  const unread = useLoad(() => api.listNotifications(true).then((r) => r.unreadCount), [location.pathname]);

  useEffect(() => {
    const timer = setInterval(() => {
      api
        .generateNotifications()
        .then(() => unread.reload())
        .catch(() => undefined);
    }, CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [api, unread.reload]);

  const count = unread.data ?? 0;
  const tabs = [
    { to: "/agenda", label: "Calendário", end: true },
    { to: "/agenda/tarefas", label: "Tarefas", end: false },
    { to: "/agenda/notificacoes", label: count > 0 ? `Notificações (${count})` : "Notificações", end: false },
  ];
  return (
    <>
      <h1>Agenda e tarefas</h1>
      <nav className="tabs" aria-label="Seções da agenda">
        {tabs.map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.end} className={({ isActive }) => (isActive ? "tab tab--active" : "tab")}>
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}
