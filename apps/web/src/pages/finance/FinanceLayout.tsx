import { NavLink, Outlet } from "react-router-dom";

const TABS = [
  { to: "/financas", label: "Lançamentos", end: true },
  { to: "/financas/contas", label: "Contas e categorias", end: false },
  { to: "/financas/pagar-receber", label: "A pagar e receber", end: false },
  { to: "/financas/relatorios", label: "Relatórios", end: false },
];

export function FinanceLayout() {
  return (
    <>
      <h1>Finanças</h1>
      <nav className="tabs" aria-label="Seções de finanças">
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.end} className={({ isActive }) => (isActive ? "tab tab--active" : "tab")}>
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}
