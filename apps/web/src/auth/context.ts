import { createContext, useContext } from "react";

export interface SessionUser {
  uid: string;
  email: string | null;
}

export interface AuthContextValue {
  user: SessionUser | null;
  /** true enquanto o SDK ainda restaura a sessão. */
  loading: boolean;
  /** true quando o token traz a `app_metadata.admin` (só define o que o painel mostra; o servidor sempre confere de novo). */
  isAdmin: boolean;
  /** false quando as variáveis do Supabase (VITE_SUPABASE_*) não foram configuradas. */
  configured: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Confirma a senha do usuário logado (login recente, exigido para excluir a conta). */
  reauthenticate: (password: string) => Promise<void>;
  /** JWT de acesso vigente (o SDK renova sozinho); `forceRefresh` força a renovação da sessão. */
  getIdToken: (forceRefresh: boolean) => Promise<string>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth precisa estar dentro de <AuthProvider>");
  return value;
}
