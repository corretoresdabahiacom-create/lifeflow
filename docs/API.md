# API

Worker em `workers/api`. Rotas autenticadas exigem `Authorization: Bearer <ID token do Firebase>`.
Token ausente, inválido ou expirado → `401` com `WWW-Authenticate: Bearer error="invalid_token"`;
o SDK do frontend renova a sessão e o cliente repete a requisição uma vez.

Todas as respostas têm `X-Request-Id`, `Cache-Control: private, no-store` e `X-Content-Type-Options: nosniff`.
Erros: `{ "error": { "code", "message", "requestId" } }`.

| Método e rota | Descrição | Corpo |
|---|---|---|
| `GET /healthz` | Saúde (sem autenticação) | — |
| `GET /v1/me` | `uid` e e-mail do token | — |
| `GET /v1/profile` | Perfil; `404` se ainda não existe | — |
| `PUT /v1/profile` | Cria ou atualiza o perfil | `displayName`, `locale`, `timezone`, `currency` |
| `GET /v1/preferences` | Preferências ou padrões (`stored: false`) | — |
| `PUT /v1/preferences` | Salva preferências | `theme`, `confirmCreations`, `quietHoursStart`, `quietHoursEnd` |
| `DELETE /v1/preferences` | Remove as preferências (`204`) | — |

## Financeiro (Fase 2)

Valores sempre em **centavos inteiros** (`amountCents`). Datas `AAAA-MM-DD`. Ids `^[A-Za-z0-9_-]{1,80}$`.
**Toda criação (`POST` que cria registro ou baixa) exige o cabeçalho `Idempotency-Key`** (8 a 128 caracteres:
letras, números, `_ - : .`). O cliente deve reenviar a MESMA chave ao repetir a mesma ação.

- Primeira execução: `201` (ou `200` na baixa). Repetição idêntica: `200` + `Idempotent-Replay: true`, sem novo efeito.
- Mesma chave com conteúdo diferente: `422 idempotency_key_reuse`. Sem chave: `400 idempotency_key_required`.

| Método e rota | Descrição |
|---|---|
| `GET /v1/accounts[?archived=true]` · `POST /v1/accounts` · `GET\|PATCH /v1/accounts/{id}` | Contas e saldos (`PATCH` só `name` e `archived`; saldo nunca é editável) |
| `GET /v1/categories` · `POST /v1/categories` · `PATCH /v1/categories/{id}` | Categorias (receita/despesa); sem exclusão, só arquivar |
| `GET /v1/transactions?from&to&accountId&categoryId&type&status&limit&cursor` | Lançamentos (padrão: mês atual; `limit` ≤ 200; `nextCursor` para continuar) |
| `POST /v1/transactions` | Receita ou despesa. `409 possible_duplicate` se já existe igual; reenviar com `allowDuplicate:true` confirma |
| `GET\|PATCH /v1/transactions/{id}` | `PATCH` só `description`, `notes`, `categoryId` |
| `POST /v1/transactions/{id}/void` | Estorno (reverte o saldo; idempotente; reabre a conta a pagar se era uma baixa) |
| `GET /v1/transfers` · `POST /v1/transfers` · `GET /v1/transfers/{id}` | Transferência atômica entre contas diferentes |
| `POST /v1/transfers/{id}/void` | Estorna a transferência e as duas pernas |
| `GET /v1/payables?status=open\|overdue\|paid\|canceled&kind&from&to&limit&cursor` · `POST /v1/payables` | Contas a pagar/receber (`overdue` derivado) |
| `GET\|PATCH /v1/payables/{id}` | Edição só enquanto `open` |
| `POST /v1/payables/{id}/pay` | Baixa atômica (`accountId`, `date?`, `amountCents?`). Já paga → `409 already_paid` |
| `POST /v1/payables/{id}/cancel` | Cancela conta em aberto |
| `GET /v1/recurring` · `POST /v1/recurring` · `PATCH /v1/recurring/{id}` | Regras de recorrência (`active`, `amountCents`, `endDate`…) |
| `POST /v1/recurring/materialize` | Gera contas das regras ativas até `through` (padrão hoje+60 dias; máx. +366). Até 20 por chamada (`hasMore`) |
| `GET /v1/reports/summary?from&to` | Totais, por categoria, por conta e por mês (`truncated` se >5000 lançamentos) |
| `GET /v1/export/transactions?from&to` | CSV (UTF-8 com BOM; neutraliza injeção de fórmula) |
| `GET /v1/reconcile` | Confere saldo guardado × lançamentos efetivados (somente leitura) |
| `GET /v1/finance/overview` | Painel: saldo total, resultado do mês, contas a vencer |

### Agenda (Fase 3)

| Rota | Descrição |
|---|---|
| `GET /v1/events?from&to` | Ocorrências do período (recorrências expandidas, exceções aplicadas, `conflictsWith`) |
| `POST /v1/events` | Cria evento (`Idempotency-Key` obrigatória); responde com `conflicts` |
| `POST /v1/events/check-conflicts` | Avisa conflitos antes de salvar (`excludeEventId` ao editar) |
| `GET\|PATCH\|DELETE /v1/events/{id}` | `PATCH {scope: one\|following\|all, occurrenceDate?, changes}`; `DELETE ?scope&occurrenceDate` |
| `POST /v1/events/{id}/expense` | Registra a despesa real do custo previsto (`accountId`, `occurrenceDate?`). Repetida → `409 expense_already_linked` |
| `GET\|POST /v1/tasks` · `GET\|PATCH\|DELETE /v1/tasks/{id}` | Filtros: `status`, `priority`, `categoryId`, `overdue`, `from`, `to`, `includeDone`, `limit` |
| `POST /v1/tasks/{id}/complete` | Conclusão idempotente |
| `GET\|POST /v1/task-categories` · `PATCH /v1/task-categories/{id}` | Categorias de tarefa (arquivar em vez de excluir) |
| `GET\|POST /v1/reminders` · `DELETE /v1/reminders/{id}` | Lembretes avulsos (`remindAt` em UTC, termina em `Z`) |
| `POST /v1/notifications/generate` | Gera notificações devidas; idempotente |
| `GET /v1/notifications` · `POST /v1/notifications/{id}/read` · `/dismiss` · `POST /v1/notifications/read-all` | Central de notificações |

Códigos adicionais da agenda: `422` `invalid_time_zone`, `invalid_occurrence`, `idempotency_key_reuse`;
`409` `expense_already_linked`.

Códigos adicionais: `404` (conta/categoria/registro inexistente ou de outro usuário — nunca `403` por
existência), `409` (`conflict`, `possible_duplicate`, `already_paid`, `not_open`, `part_of_transfer`,
`voided_immutable`), `422` (`account_archived`, `invalid_category`, `idempotency_key_reuse`, `through_too_far`).

Regras gerais:

- Corpos são validados por schemas `strict` (`packages/shared`): campos desconhecidos, incluindo `uid`,
  retornam `400`. Limite de 16 KB (`413`).
- O `uid` nunca é aceito do cliente; os caminhos do Firestore são `users/{uid do token}`.
- Códigos: `400` validação, `401` autenticação, `403` regras do banco, `404`, `405`, `413`,
  `429` limite do banco, `502`/`504` falha do banco.
- CORS: somente a origem em `ALLOWED_ORIGIN` (métodos GET, POST, PUT, PATCH, DELETE; cabeçalho `Idempotency-Key`).

## Assistente de IA (Fase 4)

Todas exigem autenticação. `POST /v1/ai/chat` exige `Idempotency-Key`.

| Método e rota | Descrição |
|---|---|
| `POST /v1/ai/chat` `{conversationId?, message}` | Envia uma mensagem. Devolve `{conversationId, reply, actions[], usage}`. Reenvio com a mesma chave devolve a mesma resposta; a mesma chave com outra mensagem → `422 idempotency_key_reuse` |
| `GET /v1/ai/conversations` · `GET/DELETE /v1/ai/conversations/{id}` | Lista, abre (mensagens e ações) e apaga o texto da conversa |
| `GET /v1/ai/actions` | Ações pendentes e não expiradas |
| `POST /v1/ai/actions/{id}/confirm` `{reinforced?}` | Executa a ação **congelada**. Sem parâmetros de ação. `422 reinforced_confirmation_required` se o valor passa do limite do usuário |
| `POST /v1/ai/actions/{id}/reject` | Recusa |
| `GET /v1/ai/history` | Trilha de auditoria (propostas, confirmações, bloqueios, falhas) |
| `GET /v1/ai/usage` | Consumo do mês e limites do plano |
| `GET/PUT /v1/ai/settings` | Limites de automação (`autoActionsPerDay`, `autoValueLimitCents`, `confirmAboveCents`) |
| `GET/PUT /v1/ai/consent` `{audio}` | Consentimento para enviar áudio à transcrição |
| `POST /v1/ai/transcribe` | Corpo = áudio cru; `Content-Type` do áudio; `X-Audio-Seconds` 1–60 obrigatório; ≤ 1,5 MB |
| `PATCH /v1/reminders/{id}` `{title?, remindAt?}` | Novo (usado por `update_reminder`) |

Códigos do assistente: `400` validação; `403` `audio_consent_required`, `voice_not_in_plan`; `404`; `409`
`action_not_pending`; `410` `action_expired`; `413` áudio grande; `415` tipo de áudio; `422` `empty_transcription`,
`reinforced_confirmation_required`, `idempotency_key_reuse`; `429` `ai_limit_reached`, `ai_voice_limit_reached`;
`502` `ai_provider_error`; `503` `ai_not_configured`, `ai_provider_busy`; `504` `ai_provider_timeout`.
CORS agora também permite o cabeçalho `X-Audio-Seconds`.

## Planos, assinatura e administração (Fase 5)

Cobrança (autenticado; erros `{ error: { code, message } }`):

| Rota | Descrição |
|---|---|
| `GET /v1/billing/plans` | Planos ativos (+ o contratado) e o plano efetivo |
| `GET /v1/billing/subscription` | Assinatura (visão do usuário) e limites do plano efetivo |
| `GET /v1/billing/history` | Pagamentos do usuário |
| `POST /v1/billing/checkout` | `{ planId: "pro" ou "premium_ai" }`, `Idempotency-Key` obrigatória → `201 { checkoutUrl }`; `409 subscription_exists`, `422 email_required`, `plan_unavailable`, `502 payment_provider_error`, `503 billing_not_configured` |
| `POST /v1/billing/change` | Troca de plano (upgrade já; downgrade na renovação); `no_active_subscription`, `same_plan` |
| `POST /v1/billing/cancel` | Cancela no provedor; mantém o plano até o fim do período pago |
| `POST /v1/billing/sync` | Relê o estado no provedor (útil se o webhook atrasou) |

Webhook (sem login): `POST /webhooks/mercadopago` — `401 invalid_signature`, `413` corpo grande, `200 {status: processed|duplicate|ignored}`, `503 webhook_retry`.

Administração (`/v1/admin/*`, exige claim `admin`; `403 admin_required` caso contrário; tudo auditado):
`GET overview`, `GET|PUT plans[/{id}]`, `GET subscriptions[?plan&status&limit]`, `GET subscriptions/{uid}`,
`GET usage[?month=AAAA-MM]`, `GET logs?kind=admin|webhooks`, `GET integrations`. Não existe rota de conteúdo financeiro.
