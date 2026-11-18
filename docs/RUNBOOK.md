# RUNBOOK DE OPERAÇÃO

> Este runbook descreve a operação planejada. **Nada aqui foi executado em produção** (ainda não existe).

## Componentes

| Componente | Onde | Observação |
|---|---|---|
| App web (PWA) | Cloudflare Pages | `apps/web/dist`; cabeçalhos em `public/_headers` |
| API | Cloudflare Worker `lifeflow-api` | `workers/api` |
| Banco e login | Firebase (Firestore + Auth) | regras/índices em `firebase/` |
| Pagamentos | Mercado Pago | webhook em `${API_PUBLIC_URL}/webhooks/mercadopago` |
| IA | DeepSeek (`deepseek-flash`) e Groq | secrets do Worker |

## Primeiro deploy (nesta ordem)

1. Criar os projetos **staging** e **produção** no Firebase; ativar Auth por e-mail/senha; criar o app web.
2. Conta de serviço do Worker (papel mínimo `roles/datastore.user`) → `wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON`.
3. Demais secrets: `wrangler secret put DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`.
4. Variáveis do GitHub (por ambiente): `FIREBASE_PROJECT_ID`, `WEB_BASE_URL`, `API_PUBLIC_URL`, `PAGES_PROJECT`,
   `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_APP_ID`. Secrets: `CLOUDFLARE_API_TOKEN`,
   `CLOUDFLARE_ACCOUNT_ID`, `FIREBASE_DEPLOY_SA_JSON`. Proteger o ambiente `production` com aprovação obrigatória.
5. Trocar `https://*.workers.dev` pela URL real da API em `apps/web/public/_headers` (CSP `connect-src`).
6. Adicionar a origem do app aos domínios autorizados do Firebase Auth.
7. Mercado Pago: cadastrar a URL do webhook (tópicos `subscription_preapproval` e `subscription_authorized_payment`) e
   copiar a "assinatura secreta" para `MERCADOPAGO_WEBHOOK_SECRET`.
8. Rodar o workflow **Deploy → staging**. Ele publica regras/índices, Worker e Pages e roda `scripts/smoke.sh`.
9. Conceder a claim de administrador a UM usuário (Admin SDK `setCustomUserClaims(uid, { admin: true })`); ele precisa
   sair e entrar de novo. **Passo manual, não testado.**
10. Fazer o **ensaio de restauração** (`BACKUP_RECOVERY.md`) e o checklist manual (`PRODUCTION_CHECKLIST.md`) em staging.
11. Só então: Deploy → production (a partir de `main`, com aprovação).

## Deploy rotineiro e rollback

- Deploy: workflow **Deploy** (manual). Ele reexecuta lint, typecheck, testes, regras e integração antes de publicar.
- **Rollback do Worker:** `wrangler rollback` (versão anterior) ou redeploy do commit anterior.
- **Rollback do app web:** no painel do Cloudflare Pages, promover o deployment anterior.
- **Rollback de regras do Firestore:** redeploy das regras do commit anterior (`firebase deploy --only firestore:rules`).
  Regras e Worker são acoplados: se o Worker novo depende de uma regra nova, volte os dois.
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
3. Alerta no Firebase/Google Cloud: orçamento e uso de leituras/escritas do Firestore (custo).
4. Alerta de **backup ausente** (nenhuma exportação em 26 h).
5. Revisar semanalmente no painel: webhooks `failed`, cobranças recusadas, erros de provedor de IA.
- Sem Sentry/APM: o erro interno devolve `requestId`; busque-o nos logs.

## Proteção de borda (obrigatória antes do lançamento — achado A4)

O Worker **não** limita a taxa de requisições. Configurar no Cloudflare (WAF → Rate limiting rules):

- `/v1/*`: 120 requisições/min por IP (resposta 429).
- `/v1/ai/*`: 30 requisições/min por IP.
- `/webhooks/mercadopago`: 60 requisições/min por IP (o Mercado Pago repete só em falha).
- Login: o próprio Firebase Auth tem proteção contra abuso; ative o reCAPTCHA/Enforcement de e-mail no console.

## Incidentes frequentes

| Sintoma | Ação |
|---|---|
| Usuários pagaram e continuam no Free | Painel `/admin` → logs de webhooks; usuário pode usar "Atualizar" em `/assinatura` (sync). Conferir `MERCADOPAGO_WEBHOOK_SECRET` e a URL cadastrada. |
| `/readyz` = 503 | Ver o log `not_ready` (lista o que falta) e completar a configuração. |
| Painel de consumo/erros dá 502 | Provável índice de grupo ausente: `firebase deploy --only firestore:indexes` e aguardar a construção. |
| IA indisponível | Painel `/admin` → integrações; conferir secret e cota do provedor. A IA devolve erro claro e não consome cota. |
| Webhook 401 em massa | Segredo do webhook trocado/errado. **Não** desligar a verificação. |
| Pedido de exclusão de conta que falhou | Pedir para o usuário repetir (a rota é idempotente). Se o login ficou órfão, não há dados; remover no console do Firebase Auth. |

## Rotação de segredos

`wrangler secret put <NOME>` para cada segredo; redeploy não é necessário. Rotacionar a chave da conta de serviço:
criar nova chave, atualizar `GOOGLE_SERVICE_ACCOUNT_JSON`, apagar a antiga. Mercado Pago: gerar novo token/segredo no painel
e atualizar os dois secrets juntos.
