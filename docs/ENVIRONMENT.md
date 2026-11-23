# ENVIRONMENT

Credenciais somente em secrets do ambiente. Nenhuma credencial real no Git.
APIs pagas só com configuração explícita e autorização.

## Banco e login (Supabase, D-011)

| Variável | Onde | Uso | Segredo? |
|---|---|---|---|
| `SUPABASE_URL` | Worker (`wrangler.toml` vars) | Origem do PostgREST, de `iss` (`/auth/v1`) e da JWKS | Não |
| `SUPABASE_PUBLISHABLE_KEY` | Worker (vars) | Chave publicável: vai em `apikey` junto do JWT do usuário | Não (pública) |
| `SUPABASE_SECRET_KEY` | Worker (**secret**) | Chave `sb_secret_…` do caminho privilegiado restrito (webhook, painel, exclusão de conta). Ausente → `503 billing_not_configured` | **Sim** |
| `JWKS_URL` | Worker (vars, opcional) | Sobrescreve a URL das chaves públicas (só testes; em produção a `/readyz` reprova) | Não |
| `ALLOWED_ORIGIN` | Worker (vars) | Origem permitida no CORS | Não |
| `VITE_SUPABASE_URL` | Frontend (`.env.local`) | URL do projeto | Não (pública) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Frontend | Chave publicável | Não (pública) |
| `VITE_API_BASE_URL` | Frontend | URL do Worker | Não |

A chave **secreta** nunca vai ao navegador nem ao Git. O projeto Supabase precisa ter **chaves de assinatura assimétricas** (ES256/RS256) habilitadas:
o Worker recusa JWT simétrico (HS256) de propósito.

Administrador do painel: `app_metadata.admin = true` no usuário (Dashboard → Authentication → Users → editar `app_metadata`, ou API de administração).
O usuário comum não consegue alterar `app_metadata`.

## Desenvolvimento local

`supabase start` (Docker + Supabase CLI) sobe Postgres, GoTrue e PostgREST com as migrações de `supabase/migrations`. `supabase status -o env`
mostra URL e chaves; ponha-as em `workers/api/.dev.vars` e `apps/web/.env.local`. Os testes `pnpm test` **não** precisam de Docker (usam PGlite).

## Variáveis do assistente (Fase 4)

| Variável | Tipo | Padrão | Descrição |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | **secret** | — | Chave do LLM. Sem ela: `503 ai_not_configured` |
| `GROQ_API_KEY` | **secret** | — | Chave da transcrição |
| `LLM_PROVIDER` / `LLM_MODEL` / `LLM_BASE_URL` | var | `deepseek` / `deepseek-flash` / `https://api.deepseek.com` | Provedor do LLM |
| `STT_PROVIDER` / `STT_MODEL` / `STT_BASE_URL` | var | `groq` / `whisper-large-v3-turbo` / `https://api.groq.com/openai/v1` | Transcrição |

## Variáveis de SaaS (Fase 5)

| Variável | Tipo | Descrição |
|---|---|---|
| `MERCADOPAGO_ACCESS_TOKEN` | **secret** | Token do Mercado Pago. Ausente → `503 billing_not_configured` |
| `MERCADOPAGO_WEBHOOK_SECRET` | **secret** | Segredo da assinatura do webhook. Ausente → webhooks recusados |
| `PAYMENT_PROVIDER` | var | `mercadopago` (único implementado) |
| `MERCADOPAGO_BASE_URL` | var, opcional | Padrão `https://api.mercadopago.com` (testes) |
| `WEB_BASE_URL` | var | URL do app (retorno do checkout: `/assinatura?retorno=1`) |
| `API_PUBLIC_URL` | var | URL pública do Worker (notificação: `/webhooks/mercadopago`) |

## Variáveis do deploy (`.github/workflows/deploy.yml`)

Por ambiente do GitHub (`staging`, `production`):

| Nome | Tipo | Uso |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_PROJECT_REF`, `WEB_BASE_URL`, `API_PUBLIC_URL`, `PAGES_PROJECT` | variável | Worker (`--var`), build do app web e `supabase link` |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | secret | `wrangler deploy` / `pages deploy` |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` | secret | `supabase link` + `supabase db push` |
| `SUPABASE_DB_URL`, `BACKUP_PASSPHRASE` (secrets), `BACKUP_ENABLED` (variável) | backup diário | `backup.yml` |

Secrets do **Worker** (nunca no GitHub nem no Git): `SUPABASE_SECRET_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY`,
`MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET` (`wrangler secret put`). `GET /readyz` confere se estão presentes.
