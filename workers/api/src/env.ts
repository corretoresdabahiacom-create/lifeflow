export interface Env {
  /** ID do projeto Firebase (público). Usado em `iss`, `aud` e no caminho do Firestore. */
  FIREBASE_PROJECT_ID: string;
  /** Única origem permitida no CORS. */
  ALLOWED_ORIGIN: string;
  /** Sobrescreve o endpoint do Firestore (emulador/testes). */
  FIRESTORE_BASE_URL?: string;
  /** Sobrescreve a URL das chaves públicas do Firebase Auth (testes). */
  JWKS_URL?: string;
}
