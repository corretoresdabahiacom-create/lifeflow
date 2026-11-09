# ARCHITECTURE

> Estado: planejado. Nada implementado ainda (Fase 0).

## Visão geral

Frontend React/Vite (PWA) em Cloudflare Pages → Cloudflare Worker (API) → Supabase
(PostgreSQL + Auth + RLS). Contrato detalhado em `MASTER_PROMPT.md`, Parte A.

## Fluxo de autenticação (contrato A2)

1. Usuário autentica pelo Supabase Auth; o SDK no frontend mantém e renova a sessão.
2. Frontend envia o access token ao Worker no header `Authorization`.
3. Worker valida assinatura, emissor, audiência e expiração (JWKS do projeto).
4. Worker cria um cliente Supabase **por requisição** com publishable key + JWT do usuário.
5. RLS no PostgreSQL identifica o usuário por `auth.uid()`.
6. Nunca `service_role` em requisições de usuário; Worker não guarda refresh token;
   `user_id` do cliente nunca é prova de identidade.

## Provedores (adaptadores independentes)

Interfaces: `LLMProvider`, `SpeechToTextProvider`, `EmailProvider`, `PaymentProvider`,
`PushProvider`, em `packages/providers`. Nomes, endpoints e modelos não aparecem no código
de negócio.

## Status das integrações (contrato A4)

| Integração | Status |
|---|---|
| DeepSeek (LLM) | Não implementado |
| Groq (transcrição) | Não implementado |
| Mercado Pago | Não implementado |
| Resend (e-mail) | Não implementado |
| Web Push (VAPID) | Não implementado |
| Supabase | Não implementado |
| Cloudflare | Não implementado |
