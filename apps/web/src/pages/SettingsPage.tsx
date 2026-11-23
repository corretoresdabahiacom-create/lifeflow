import {
  DEFAULT_PREFERENCES,
  PreferencesInputSchema,
  ProfileInputSchema,
  THEMES,
  type PreferencesInput,
  type Theme,
} from "@lifeflow/shared";
import { useEffect, useState, type FormEvent } from "react";
import { useApi } from "../app/ApiProvider";
import { useAuth } from "../auth/context";
import { useProfile } from "../app/ProfileProvider";
import { useTheme } from "../app/ThemeProvider";
import { LoadingState } from "../components/States";
import { ApiError } from "../lib/api";

const THEME_LABELS: Record<Theme, string> = { system: "Automático", light: "Claro", dark: "Escuro" };

type Notice = { kind: "ok" | "error"; text: string } | null;

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : "Não foi possível salvar. Tente novamente.";
}

function ProfileForm() {
  const { profile, save } = useProfile();
  const [displayName, setDisplayName] = useState(profile?.displayName ?? "");
  const [locale, setLocale] = useState(profile?.locale ?? "pt-BR");
  const [timezone, setTimezone] = useState(profile?.timezone ?? "America/Sao_Paulo");
  const [currency, setCurrency] = useState(profile?.currency ?? "BRL");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    const parsed = ProfileInputSchema.safeParse({ displayName, locale, timezone, currency });
    if (!parsed.success) {
      setNotice({ kind: "error", text: "Confira os campos do perfil." });
      return;
    }
    setBusy(true);
    try {
      await save(parsed.data);
      setNotice({ kind: "ok", text: "Perfil salvo." });
    } catch (e) {
      setNotice({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={(e) => void onSubmit(e)} aria-labelledby="t-perfil">
      <h2 id="t-perfil">Perfil</h2>
      <label className="field">
        <span>Nome</span>
        <input value={displayName} maxLength={80} onChange={(e) => setDisplayName(e.target.value)} required />
      </label>
      <label className="field">
        <span>Idioma</span>
        <select value={locale} onChange={(e) => setLocale(e.target.value)}>
          <option value="pt-BR">Português (Brasil)</option>
          <option value="en-US">English (US)</option>
          <option value="es-ES">Español</option>
        </select>
      </label>
      <label className="field">
        <span>Fuso horário</span>
        <input value={timezone} maxLength={64} onChange={(e) => setTimezone(e.target.value)} required />
      </label>
      <label className="field">
        <span>Moeda</span>
        <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
          <option value="BRL">Real (BRL)</option>
          <option value="USD">Dólar (USD)</option>
          <option value="EUR">Euro (EUR)</option>
        </select>
      </label>
      {notice ? (
        <p className={notice.kind === "ok" ? "form-ok" : "form-error"} role={notice.kind === "ok" ? "status" : "alert"}>
          {notice.text}
        </p>
      ) : null}
      <button type="submit" className="btn btn--primary" disabled={busy}>
        {busy ? "Salvando…" : "Salvar perfil"}
      </button>
    </form>
  );
}

function PreferencesForm() {
  const api = useApi();
  const { theme, setTheme } = useTheme();
  const [loaded, setLoaded] = useState(false);
  const [prefs, setPrefs] = useState<PreferencesInput>({ ...DEFAULT_PREFERENCES, theme });
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getPreferences()
      .then((stored) => {
        if (cancelled) return;
        setPrefs({
          theme: stored.theme,
          confirmCreations: stored.confirmCreations,
          quietHoursStart: stored.quietHoursStart,
          quietHoursEnd: stored.quietHoursEnd,
        });
        if (stored.stored) setTheme(stored.theme);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setNotice({ kind: "error", text: errorText(e) });
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // Carrega uma única vez ao abrir a tela (setTheme não deve reexecutar a leitura).
  }, [api]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    const parsed = PreferencesInputSchema.safeParse(prefs);
    if (!parsed.success) {
      setNotice({ kind: "error", text: "Confira os horários informados." });
      return;
    }
    setBusy(true);
    try {
      await api.putPreferences(parsed.data);
      setTheme(parsed.data.theme);
      setNotice({ kind: "ok", text: "Preferências salvas." });
    } catch (e) {
      setNotice({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <LoadingState label="Carregando preferências…" />;

  return (
    <form className="card form" onSubmit={(e) => void onSubmit(e)} aria-labelledby="t-prefs">
      <h2 id="t-prefs">Preferências</h2>
      <fieldset className="field">
        <legend>Tema</legend>
        <div className="segmented">
          {THEMES.map((value) => (
            <label key={value} className={prefs.theme === value ? "segmented__item segmented__item--on" : "segmented__item"}>
              <input
                type="radio"
                name="theme"
                value={value}
                checked={prefs.theme === value}
                onChange={() => {
                  setPrefs({ ...prefs, theme: value });
                  setTheme(value);
                }}
              />
              {THEME_LABELS[value]}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="check">
        <input
          type="checkbox"
          checked={prefs.confirmCreations}
          onChange={(e) => setPrefs({ ...prefs, confirmCreations: e.target.checked })}
        />
        <span>Pedir confirmação antes de criar itens pelo assistente</span>
      </label>
      <div className="row">
        <label className="field">
          <span>Silêncio a partir de</span>
          <input
            type="time"
            value={prefs.quietHoursStart}
            onChange={(e) => setPrefs({ ...prefs, quietHoursStart: e.target.value })}
            required
          />
        </label>
        <label className="field">
          <span>Silêncio até</span>
          <input
            type="time"
            value={prefs.quietHoursEnd}
            onChange={(e) => setPrefs({ ...prefs, quietHoursEnd: e.target.value })}
            required
          />
        </label>
      </div>
      {notice ? (
        <p className={notice.kind === "ok" ? "form-ok" : "form-error"} role={notice.kind === "ok" ? "status" : "alert"}>
          {notice.text}
        </p>
      ) : null}
      <button type="submit" className="btn btn--primary" disabled={busy}>
        {busy ? "Salvando…" : "Salvar preferências"}
      </button>
    </form>
  );
}

export const DELETE_PHRASE = "EXCLUIR MINHA CONTA";

/** Meus dados (LGPD): exportação completa e exclusão definitiva da conta. */
export function AccountSection() {
  const api = useApi();
  const { reauthenticate, signOut } = useAuth();
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [phrase, setPhrase] = useState("");

  async function onExport() {
    setNotice(null);
    setBusy(true);
    try {
      const blob = await api.exportAccount();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `lifeflow-dados-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setNotice({ kind: "ok", text: "Arquivo gerado. Guarde-o em local seguro: contém seus dados financeiros." });
    } catch (e) {
      setNotice({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    if (phrase !== DELETE_PHRASE) {
      setNotice({ kind: "error", text: `Digite exatamente: ${DELETE_PHRASE}` });
      return;
    }
    setBusy(true);
    try {
      await reauthenticate(password);
    } catch {
      setNotice({ kind: "error", text: "Senha incorreta." });
      setBusy(false);
      return;
    }
    try {
      await api.deleteAccount();
    } catch (e) {
      setNotice({ kind: "error", text: errorText(e) });
      setBusy(false);
      return;
    }
    // O Worker já apagou os dados E o login (usuário do Supabase Auth); resta encerrar a sessão neste navegador.
    await signOut().catch(() => undefined);
  }

  return (
    <section className="card form" aria-labelledby="t-dados">
      <h2 id="t-dados">Meus dados</h2>
      <p>Baixe uma cópia de tudo o que o LIFEFlow guarda sobre você (lançamentos, agenda, conversas, assinatura).</p>
      <button type="button" className="btn" onClick={() => void onExport()} disabled={busy}>
        Exportar meus dados (JSON)
      </button>
      <h3>Excluir conta</h3>
      <p>
        Apaga <strong>definitivamente</strong> todos os seus dados e cancela a assinatura. Não há como desfazer. Exporte seus
        dados antes, se quiser guardá-los.
      </p>
      <form className="form" onSubmit={(e) => void onDelete(e)}>
        <label className="field">
          <span>Sua senha</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <label className="field">
          <span>Para confirmar, digite {DELETE_PHRASE}</span>
          <input value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" required />
        </label>
        <button type="submit" className="btn danger" disabled={busy}>
          Excluir minha conta
        </button>
      </form>
      {notice && (
        <p role={notice.kind === "error" ? "alert" : "status"} className={notice.kind === "error" ? "error" : "ok"}>
          {notice.text}
        </p>
      )}
    </section>
  );
}

export function SettingsPage() {
  return (
    <>
      <h1>Ajustes</h1>
      <div className="grid">
        <ProfileForm />
        <PreferencesForm />
        <AccountSection />
      </div>
    </>
  );
}
