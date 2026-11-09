import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/context";
import { MIN_PASSWORD_LENGTH, authErrorMessage } from "../auth/errors";
import { LoadingState } from "../components/States";

type Mode = "signin" | "signup";

export function LoginPage() {
  const { user, loading, configured, signIn, signUp } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) return <LoadingState label="Carregando…" fullPage />;
  if (user) return <Navigate to="/" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (mode === "signup" && password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use uma senha com pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`);
      return;
    }
    setBusy(true);
    try {
      if (mode === "signin") await signIn(email.trim(), password);
      else await signUp(email.trim(), password);
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="card auth-card">
        <h1 className="brand">LifeFlow AI</h1>
        <p className="muted">Finanças, agenda e tarefas em um só lugar.</p>

        {!configured ? (
          <div className="state state--error" role="alert">
            <strong>Firebase não configurado</strong>
            <span>Defina as variáveis VITE_FIREBASE_* (veja docs/ENVIRONMENT.md).</span>
          </div>
        ) : null}

        <div className="tabs" role="tablist" aria-label="Acesso">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "signin"}
            className={mode === "signin" ? "tab tab--active" : "tab"}
            onClick={() => setMode("signin")}
          >
            Entrar
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "signup"}
            className={mode === "signup" ? "tab tab--active" : "tab"}
            onClick={() => setMode("signup")}
          >
            Criar conta
          </button>
        </div>

        <form onSubmit={(e) => void onSubmit(e)} className="form" noValidate>
          <label className="field">
            <span>E-mail</span>
            <input
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Senha</span>
            <input
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="btn btn--primary" disabled={busy || !configured}>
            {busy ? "Aguarde…" : mode === "signin" ? "Entrar" : "Criar conta"}
          </button>
        </form>
      </div>
    </div>
  );
}
