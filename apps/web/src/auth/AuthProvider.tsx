import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from "firebase/auth";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { getFirebaseAuth, isFirebaseConfigured } from "../lib/firebase";
import { AuthContext, type AuthContextValue, type SessionUser } from "./context";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState<boolean>(isFirebaseConfigured);

  useEffect(() => {
    const auth = getFirebaseAuth();
    if (!auth) return;
    return onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser ? { uid: firebaseUser.uid, email: firebaseUser.email } : null);
      setLoading(false);
      if (!firebaseUser) {
        setIsAdmin(false);
        return;
      }
      firebaseUser
        .getIdTokenResult()
        .then((result) => setIsAdmin(result.claims["admin"] === true))
        .catch(() => setIsAdmin(false));
    });
  }, []);

  const requireAuth = useCallback(() => {
    const auth = getFirebaseAuth();
    if (!auth) throw new Error("Firebase não configurado");
    return auth;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAdmin,
      loading,
      configured: isFirebaseConfigured,
      async signIn(email, password) {
        await signInWithEmailAndPassword(requireAuth(), email, password);
      },
      async signUp(email, password) {
        await createUserWithEmailAndPassword(requireAuth(), email, password);
      },
      async signOut() {
        // Encerra a sessão no SDK; sem sessão não existe token para enviar ao Worker.
        await firebaseSignOut(requireAuth());
      },
      async getIdToken(forceRefresh) {
        const current = requireAuth().currentUser;
        if (!current) throw new Error("Sem sessão ativa");
        return current.getIdToken(forceRefresh);
      },
    }),
    [user, isAdmin, loading, requireAuth],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
