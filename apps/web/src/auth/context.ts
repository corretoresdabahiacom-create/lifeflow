import { createContext, useContext } from "react";

export interface SessionUser {
  uid: string;
  email: string | null;
}

export interface AuthContextValue {
  user: SessionUser | null;
  /** true enquanto o SDK ainda restaura a sessão. */
  loading: boolean;
  /** true quando o token traz a claim `admin` (só define o que o painel mostra; o servidor sempre confere de novo). */
  isAdmin: boolean;
  /** false quando as variáveis do Firebase não foram configuradas. */
  configured: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** ID token vigente; `forceRefresh` renova a sessão pelo SDK. */
  getIdToken: (forceRefresh: boolean) => Promise<string>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth precisa estar dentro de <AuthProvider>");
  return value;
}
