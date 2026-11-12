export interface Env {
  /** ID do projeto Firebase (público). Usado em `iss`, `aud` e no caminho do Firestore. */
  FIREBASE_PROJECT_ID: string;
  /** Única origem permitida no CORS. */
  ALLOWED_ORIGIN: string;
  /** Sobrescreve o endpoint do Firestore (emulador/testes). */
  FIRESTORE_BASE_URL?: string;
  /** Sobrescreve a URL das chaves públicas do Firebase Auth (testes). */
  JWKS_URL?: string;
  /** Provedor de LLM (padrão `deepseek`). Trocar não exige alterar módulos de negócio. */
  LLM_PROVIDER?: string;
  /** Modelo do LLM (padrão `deepseek-flash`, confirmado na documentação oficial em 2026-11-11). */
  LLM_MODEL?: string;
  LLM_BASE_URL?: string;
  /** SECRET (nunca no Git): `wrangler secret put DEEPSEEK_API_KEY`. */
  DEEPSEEK_API_KEY?: string;
  /** Provedor de transcrição (padrão `groq`, modelo `whisper-large-v3-turbo`). */
  STT_PROVIDER?: string;
  STT_MODEL?: string;
  STT_BASE_URL?: string;
  /** SECRET (nunca no Git): `wrangler secret put GROQ_API_KEY`. */
  GROQ_API_KEY?: string;
  /** Plano aplicado até a Fase 5 (assinaturas): `free` (padrão), `pro` ou `premium_ai`. */
  AI_DEFAULT_PLAN?: string;
}
