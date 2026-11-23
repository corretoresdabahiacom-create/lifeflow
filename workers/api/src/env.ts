export interface Env {
  /** URL do projeto Supabase (pública), ex.: https://abcd.supabase.co. Origem de `iss`, do JWKS e do PostgREST. */
  SUPABASE_URL: string;
  /** Chave publicável (`sb_publishable_…`, pública): vai em `apikey` junto do JWT do usuário. */
  SUPABASE_PUBLISHABLE_KEY: string;
  /** Única origem permitida no CORS. */
  ALLOWED_ORIGIN: string;
  /** Sobrescreve a URL das chaves públicas do Supabase Auth (testes). Padrão: `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`. */
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
  /** Provedor de pagamentos (padrão `mercadopago`). */
  PAYMENT_PROVIDER?: string;
  MERCADOPAGO_BASE_URL?: string;
  /** SECRET: token de acesso do Mercado Pago (`wrangler secret put MERCADOPAGO_ACCESS_TOKEN`). */
  MERCADOPAGO_ACCESS_TOKEN?: string;
  /** SECRET: "assinatura secreta" dos webhooks (painel do Mercado Pago > Webhooks). */
  MERCADOPAGO_WEBHOOK_SECRET?: string;
  /** URL pública do app web (retorno do checkout), ex.: https://app.exemplo.com */
  WEB_BASE_URL?: string;
  /** URL pública deste Worker (o provedor chama `${API_PUBLIC_URL}/webhooks/mercadopago`). */
  API_PUBLIC_URL?: string;
  /**
   * SECRET: chave secreta do Supabase (`sb_secret_…`; `wrangler secret put SUPABASE_SECRET_KEY`). Usada SOMENTE pelo
   * caminho privilegiado restrito (webhooks, assinaturas, painel administrativo, exclusão de conta). Nunca vai ao navegador.
   */
  SUPABASE_SECRET_KEY?: string;
}
