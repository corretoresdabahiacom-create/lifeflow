# RUNBOOK DE OPERAÇÃO

> Este runbook descreve a operação planejada. **Nada aqui foi executado em produção** (ainda não existe).

## Componentes

| Componente | Onde | Observação |
|---|---|---|
| App web (PWA) | Cloudflare Pages | `apps/web/dist`; cabeçalhos em `public/_headers` |
| API | Cloudflare Worker `lifeflow-api` | `workers/api` |
| Banco e login | Supabase (Postgres + Auth) | migrações em `supabase/migrations` |
| Pagamentos | Mercado Pago | webhook em `${API_PUBLIC_URL}/webhooks/mercadopago` |
| IA | DeepSeek (`deepseek-flash`) e Groq | secrets do Worker |

## Primeiro deploy (nesta ordem)

1. Criar os projetos **staging** e **produção** no Supabase; em Authentication: e-mail/senha com **confirmação de e-mail ligada**, URLs de redirecionamento do app, **chaves de assinatura assimétricas** (Settings → JWT Keys → ES256) e senha mínima 8.
2. Chave **secreta** do projeto (`sb_secret_…`) → `wrangler secret put SUPABASE_SECRET_KEY`. A chave publicável e a URL são públicas (variáveis).
3. Demais secrets: `wrangler secret put DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`.
4. Variáveis do GitHub (por ambiente): `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_PROJECT_REF`, `WEB_BASE_URL`, `API_PUBLIC_URL`, `PAGES_PROJECT`.
   Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`. Proteger o ambiente `production` com aprovação obrigatória.
5. Trocar `https://*.workers.dev` pela URL real da API em `apps/web/public/_headers` (CSP `connect-src`).
6. Conferir `Site URL` e as URLs de redirecionamento do Supabase Auth com a origem do app.
7. Mercado Pago: cadastrar a URL do webhook (tópicos `subscription_preapproval` e `subscription_authorized_payment`) e
   copiar a "assinatura secreta" para `MERCADOPAGO_WEBHOOK_SECRET`.
8. Rodar o workflow **Deploy → staging**. Ele aplica as migrações (`supabase db push`), publica o Worker e o Pages e roda `scripts/smoke.sh`.
9. Conceder o papel de administrador a UM usuário: `app_metadata` = `{ "admin": true }` (Dashboard → Authentication → Users, ou a API de administração com a chave secreta); ele precisa
   sair e entrar de novo para receber um JWT novo. **Passo manual, não testado.**
10. Fazer o **ensaio de restauração** (`BACKUP_RECOVERY.md`) e o checklist manual (`PRODUCTION_CHECKLIST.md`) em staging.
11. Só então: Deploy → production (a partir de `main`, com aprovação).

## Deploy rotineiro e rollback

- Deploy: workflow **Deploy** (manual). Ele reexecuta lint, typecheck, testes e a integração com o Supabase local antes de publicar.
- **Rollback do Worker:** `wrangler rollback` (versão anterior) ou redeploy do commit anterior.
- **Rollback do app web:** no painel do Cloudflare Pages, promover o deployment anterior.
- **Rollback do banco:** migrações publicadas são **só aditivas**; para desfazer, crie uma NOVA migração corretiva (não edite nem apague uma aplicada).
  Banco e Worker são acoplados (funções `lf_*`, RLS): se o Worker novo depende de uma migração nova, volte os dois ou mantenha a migração (compatível com o Worker antigo).
- Mudança de dados não tem rollback automático: use o backup (`BACKUP_RECOVERY.md`).

## Monitoramento e alertas

O que existe no código:

| Sinal | Onde ver |
|---|---|
| Uma linha JSON por requisição (`requestId`, método, caminho, status, duração, `uid`; **sem** token/corpo/valores) | Cloudflare → Workers → Logs (Workers Logs / `wrangler tail`) |
| `GET /healthz` (vivo) e `GET /readyz` (configuração de produção completa) | monitor de uptime externo |
| Erros do banco/provedores (`upstream_error`, `payment_provider_error`, `ai_provider_error`) | logs (nível `error`) |
| Webhooks com falha, assinaturas por status, MRR, consumo e erros de IA | painel `/admin` (visão geral e logs) |
| Evento `not_ready` | log `warn` com a lista de itens faltantes (sem valores) |

O que **precisa ser configurado** (não existe no repositório):

1. Monitor de uptime em `/healthz` (a cada 1 min) e `/readyz` (a cada 5 min) com aviso por e-mail/mensagem.
2. Alerta no Cloudflare: taxa de erros 5xx do Worker > 2% por 5 min.
3. Alerta no Supabase: uso de banco (CPU, conexões, armazenamento), egress e cobrança do plano.
4. Alerta de **backup ausente** (nenhuma exportação em 26 h).
5. Revisar semanalmente no painel: webhooks `failed`, cobranças recusadas, erros de provedor de IA.
- Sem Sentry/APM: o erro interno devolve `requestId`; busque-o nos logs.

## Proteção de borda (obrigatória antes do lançamento — achado A4)

O Worker **não** limita a taxa de requisições. Configurar no Cloudflare (WAF → Rate limiting rules):

- `/v1/*`: 120 requisições/min por IP (resposta 429).
- `/v1/ai/*`: 30 requisições/min por IP.
- `/webhooks/mercadopago`: 60 requisições/min por IP (o Mercado Pago repete só em falha).
- Login: o Supabase Auth limita tentativas por IP/e-mail; ligue o CAPTCHA (hCaptcha/Turnstile) em Authentication → Attack Protection.

## Incidentes frequentes

| Sintoma | Ação |
|---|---|
| Usuários pagaram e continuam no Free | Painel `/admin` → logs de webhooks; usuário pode usar "Atualizar" em `/assinatura` (sync). Conferir `MERCADOPAGO_WEBHOOK_SECRET` e a URL cadastrada. |
| `/readyz` = 503 | Ver o log `not_ready` (lista o que falta) e completar a configuração. |
| Painel de consumo/erros dá 502 | Provável migração não aplicada ou função `lf_*` ausente: confira `supabase migration list` e rode `supabase db push`. |
| IA indisponível | Painel `/admin` → integrações; conferir secret e cota do provedor. A IA devolve erro claro e não consome cota. |
| Webhook 401 em massa | Segredo do webhook trocado/errado. **Não** desligar a verificação. |
| Pedido de exclusão de conta que falhou | Pedir para o usuário repetir (a rota é idempotente). Como a exclusão apaga o usuário do Supabase Auth junto com os dados, não deve sobrar login órfão; se sobrar (falha no meio), remova-o em Authentication → Users. |

## Rotação de segredos

`wrangler secret put <NOME>` para cada segredo; redeploy não é necessário. Rotacionar a chave secreta (Settings → API Keys → criar nova `sb_secret_…`, atualizar e revogar a antiga):
criar nova chave, atualizar `GOOGLE_SERVICE_ACCOUNT_JSON`, apagar a antiga. Mercado Pago: gerar novo token/segredo no painel
e atualizar os dois secrets juntos.
