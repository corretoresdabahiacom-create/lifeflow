import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { getSupabase, isSupabaseConfigured } from "../lib/supabase";
import { AuthContext, type AuthContextValue, type SessionUser } from "./context";

function toUser(session: Session | null): SessionUser | null {
  return session ? { uid: session.user.id, email: session.user.email ?? null } : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState<boolean>(isSupabaseConfigured);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;
    // Dispara INITIAL_SESSION ao restaurar a sessão salva e depois a cada login/logout/renovação do token.
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(toUser(session));
      // Só define o que o painel mostra; o Worker sempre confere `app_metadata.admin` de novo no JWT.
      setIsAdmin(session?.user.app_metadata?.["admin"] === true);
      setLoading(false);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const requireAuth = useCallback(() => {
    const supabase = getSupabase();
    if (!supabase) throw new Error("Supabase não configurado");
    return supabase.auth;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAdmin,
      loading,
      configured: isSupabaseConfigured,
      async signIn(email, password) {
        const { error } = await requireAuth().signInWithPassword({ email, password });
        if (error) throw error;
      },
      async signUp(email, password) {
        const { data, error } = await requireAuth().signUp({ email, password });
        if (error) throw error;
        // Com confirmação de e-mail ligada o Supabase cria o usuário sem sessão: é preciso confirmar antes de entrar.
        if (!data.session) throw Object.assign(new Error("email_confirmation_required"), { code: "email_confirmation_required" });
      },
      async signOut() {
        // `local`: encerra só esta sessão do navegador (e funciona mesmo depois de a conta ter sido excluída).
        const { error } = await requireAuth().signOut({ scope: "local" });
        if (error) throw error;
      },
      async reauthenticate(password) {
        const auth = requireAuth();
        const { data } = await auth.getUser();
        const email = data.user?.email;
        if (!email) throw new Error("Sem sessão ativa");
        // Novo login com a senha: renova a sessão e o instante da autenticação (`amr`) que o Worker exige recente.
        const { error } = await auth.signInWithPassword({ email, password });
        if (error) throw error;
      },
      async getIdToken(forceRefresh) {
        const auth = requireAuth();
        if (forceRefresh) {
          const { data, error } = await auth.refreshSession();
          if (error || !data.session) throw new Error("Sem sessão ativa");
          return data.session.access_token;
        }
        const { data } = await auth.getSession();
        if (!data.session) throw new Error("Sem sessão ativa");
        return data.session.access_token;
      },
    }),
    [user, isAdmin, loading, requireAuth],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
