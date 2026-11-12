import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/context";
import { CalendarIcon, HomeIcon, SettingsIcon, SparkIcon, WalletIcon } from "../components/icons";
import { ErrorState, LoadingState } from "../components/States";
import { useInstallPrompt, useUpdateAvailable } from "../pwa/hooks";
import { useProfile } from "./ProfileProvider";

const NAV = [
  { to: "/", label: "Início", icon: <HomeIcon />, end: true },
  { to: "/financas", label: "Finanças", icon: <WalletIcon />, end: false },
  { to: "/agenda", label: "Agenda", icon: <CalendarIcon />, end: false },
  { to: "/assistente", label: "Assistente", icon: <SparkIcon />, end: false },
  { to: "/assinatura", label: "Assinatura", icon: <WalletIcon />, end: false },
  { to: "/ajustes", label: "Ajustes", icon: <SettingsIcon />, end: false },
];

function NavItems() {
  const { isAdmin } = useAuth();
  const items = isAdmin ? [...NAV, { to: "/admin", label: "Admin", icon: <SettingsIcon />, end: false }] : NAV;
  return (
    <>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => (isActive ? "nav-link nav-link--active" : "nav-link")}
        >
          {item.icon}
          <span>{item.label}</span>
        </NavLink>
      ))}
    </>
  );
}

export function Layout() {
  const { user, signOut } = useAuth();
  const { status, error, reload } = useProfile();
  const { canInstall, install } = useInstallPrompt();
  const { updateAvailable, update } = useUpdateAvailable();

  return (
    <div className="shell">
      <a className="skip-link" href="#conteudo">
        Ir para o conteúdo
      </a>

      <aside className="sidebar" aria-label="Menu principal">
        <div className="brand">LifeFlow AI</div>
        <nav className="sidebar__nav">
          <NavItems />
        </nav>
        <div className="sidebar__footer">
          <span className="muted" title={user?.email ?? ""}>
            {user?.email}
          </span>
          <button type="button" className="btn btn--ghost" onClick={() => void signOut()}>
            Sair
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <span className="brand brand--mobile">LifeFlow AI</span>
          <div className="topbar__actions">
            {canInstall ? (
              <button type="button" className="btn btn--ghost" onClick={() => void install()}>
                Instalar app
              </button>
            ) : null}
            <button type="button" className="btn btn--ghost topbar__logout" onClick={() => void signOut()}>
              Sair
            </button>
          </div>
        </header>

        {updateAvailable ? (
          <div className="banner" role="status">
            <span>Nova versão disponível.</span>
            <button type="button" className="btn" onClick={update}>
              Atualizar
            </button>
          </div>
        ) : null}

        <main id="conteudo" className="content" tabIndex={-1}>
          {status === "loading" ? <LoadingState label="Preparando sua conta…" /> : null}
          {status === "error" ? <ErrorState message={error ?? "Erro desconhecido"} onRetry={reload} /> : null}
          {status === "ready" ? <Outlet /> : null}
        </main>
      </div>

      <nav className="bottom-nav" aria-label="Navegação principal">
        <NavItems />
      </nav>
    </div>
  );
}
