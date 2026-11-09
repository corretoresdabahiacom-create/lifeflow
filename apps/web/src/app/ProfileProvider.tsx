import type { Profile, ProfileInput } from "@lifeflow/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "../auth/context";
import { ApiError } from "../lib/api";
import { apiBaseUrl } from "../lib/firebase";
import { defaultProfileFor } from "../lib/profileDefaults";
import { useApi } from "./ApiProvider";

type Status = "loading" | "ready" | "error";

interface ProfileContextValue {
  status: Status;
  profile: Profile | null;
  error: string | null;
  reload: () => void;
  save: (input: ProfileInput) => Promise<void>;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Acesso negado pelas regras de segurança.";
    if (error.status === 401) return "Sessão expirada. Entre novamente.";
    return error.requestId ? `${error.message} (ref. ${error.requestId})` : error.message;
  }
  return "Não foi possível conectar ao servidor.";
}

/** Carrega o perfil do usuário e, no primeiro acesso, cria um perfil padrão. */
export function ProfileProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const api = useApi();
  const [status, setStatus] = useState<Status>("loading");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const uid = user?.uid;
  const email = user?.email;

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    setStatus("loading");
    setError(null);

    if (!apiBaseUrl) {
      setStatus("error");
      setError("API não configurada (defina VITE_API_BASE_URL).");
      return;
    }

    (async () => {
      try {
        let current = await api.getProfile();
        if (!current) {
          const defaults = defaultProfileFor(
            email,
            navigator.language,
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          );
          current = await api.putProfile(defaults);
        }
        if (!cancelled) {
          setProfile(current);
          setStatus("ready");
        }
      } catch (e) {
        if (!cancelled) {
          setError(describeError(e));
          setStatus("error");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, uid, email, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const save = useCallback(
    async (input: ProfileInput) => {
      const saved = await api.putProfile(input);
      setProfile(saved);
    },
    [api],
  );

  const value = useMemo(() => ({ status, profile, error, reload, save }), [status, profile, error, reload, save]);
  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfile(): ProfileContextValue {
  const value = useContext(ProfileContext);
  if (!value) throw new Error("useProfile precisa estar dentro de <ProfileProvider>");
  return value;
}
