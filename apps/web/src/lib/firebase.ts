import { initializeApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";

const env = import.meta.env;

export const useEmulators = env.VITE_USE_EMULATORS === "true";

/**
 * Valores do app web do Firebase são identificadores públicos (não segredos).
 * A segurança dos dados vem das Security Rules e da validação do token no Worker.
 */
const config = {
  apiKey: env.VITE_FIREBASE_API_KEY ?? (useEmulators ? "demo-key" : ""),
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: env.VITE_FIREBASE_PROJECT_ID ?? (useEmulators ? "demo-lifeflow" : ""),
  appId: env.VITE_FIREBASE_APP_ID ?? (useEmulators ? "demo-app" : ""),
};

export const isFirebaseConfigured = Boolean(config.apiKey && config.projectId && config.appId);

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

export function getFirebaseAuth(): Auth | null {
  if (!isFirebaseConfigured) return null;
  if (!auth) {
    app = initializeApp(config);
    auth = getAuth(app);
    if (useEmulators) connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  }
  return auth;
}

export const apiBaseUrl = (env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
