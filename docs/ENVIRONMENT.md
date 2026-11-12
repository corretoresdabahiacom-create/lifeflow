# ENVIRONMENT

Credenciais somente em secrets do ambiente. Nenhuma credencial real no Git.
APIs pagas só com configuração explícita e autorização.

## Fase 1

| Variável | Onde | Uso | Segredo? |
|---|---|---|---|
| `FIREBASE_PROJECT_ID` | Worker (`wrangler.toml` vars) | Validação de `iss`/`aud` e caminho do Firestore | Não |
| `ALLOWED_ORIGIN` | Worker (vars) | Origem permitida no CORS | Não |
| `FIRESTORE_BASE_URL` | Worker (vars, opcional) | Sobrescreve o endpoint do Firestore (testes/emulador) | Não |
| `JWKS_URL` | Worker (vars, opcional) | Sobrescreve a URL das chaves públicas (testes) | Não |
| `VITE_FIREBASE_API_KEY` | Frontend (`.env.local`) | Identificador público do app web | Não (público) |
| `VITE_FIREBASE_AUTH_DOMAIN` | Frontend | Domínio de autenticação | Não |
| `VITE_FIREBASE_PROJECT_ID` | Frontend | Projeto Firebase | Não |
| `VITE_FIREBASE_APP_ID` | Frontend | Id do app web | Não |
| `VITE_API_BASE_URL` | Frontend | URL do Worker | Não |
| `VITE_USE_EMULATORS` | Frontend | `true` para usar emuladores locais | Não |

## Variáveis futuras (fase 5)

`EMAIL_*`, `PAYMENT_*`, `VAPID_*`:
secrets do Worker, definidos quando cada adaptador for implementado.

## Desenvolvimento local

Projeto de demonstração `demo-lifeflow` com emuladores do Firebase (sem credenciais reais).
Os passos estão em `PHASE_01_FOUNDATION.md`.

## Variáveis do assistente (Fase 4)

| Variável | Tipo | Padrão | Descrição |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | **secret** | — | Chave do LLM. Sem ela: `503 ai_not_configured` |
| `GROQ_API_KEY` | **secret** | — | Chave da transcrição |
| `LLM_PROVIDER` / `LLM_MODEL` / `LLM_BASE_URL` | var | `deepseek` / `deepseek-flash` / `https://api.deepseek.com` | Provedor do LLM |
| `STT_PROVIDER` / `STT_MODEL` / `STT_BASE_URL` | var | `groq` / `whisper-large-v3-turbo` / `https://api.groq.com/openai/v1` | Transcrição |
| `AI_DEFAULT_PLAN` | var | `free` | Plano aplicado a todos até a Fase 5 (`free`, `pro`, `premium_ai`) |

Definir secrets com `wrangler secret put NOME`; nunca no Git. As variáveis `LLM_API_KEY` e `STT_*` previstas antes
foram substituídas por estas.
