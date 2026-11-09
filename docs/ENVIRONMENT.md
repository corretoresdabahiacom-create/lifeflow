# ENVIRONMENT

> Estado: nomes de variáveis planejados. Ver `.env.example`.

Credenciais somente em secrets do ambiente (Cloudflare, GitHub Actions, Supabase).
Nenhuma credencial real no Git. APIs pagas só com configuração explícita e autorização.

| Variável | Uso | Onde fica |
|---|---|---|
| SUPABASE_URL | URL do projeto | Worker / frontend |
| SUPABASE_PUBLISHABLE_KEY | Chave pública do projeto | Worker / frontend |
| LLM_PROVIDER / LLM_MODEL / LLM_API_KEY | Provedor de IA | Secret do Worker |
| STT_PROVIDER / STT_MODEL / STT_API_KEY | Transcrição | Secret do Worker |
| EMAIL_PROVIDER / EMAIL_API_KEY | E-mail | Secret do Worker |
| PAYMENT_PROVIDER / PAYMENT_ACCESS_TOKEN / PAYMENT_WEBHOOK_SECRET | Pagamentos | Secret do Worker |
| VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT | Web Push | Secret do Worker |

Instruções de ativação por integração serão adicionadas quando cada adaptador for implementado.
