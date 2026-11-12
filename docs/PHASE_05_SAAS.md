# FASE 5 — SaaS (planos, limites, assinaturas, pagamentos, webhooks, painel administrativo, métricas)

**Status:** implementada, **aguardando aprovação**. A Fase 6 não foi iniciada.
**Ambiente de pagamento:** só um provedor **simulado** nos testes. O adaptador do Mercado Pago foi escrito a partir
da documentação e testado com respostas simuladas e HMAC real; **nunca falou com o Mercado Pago de verdade**.

## Artefatos

| Item | Onde | Situação |
|---|---|---|
| Planos Free/Pro/Premium AI configuráveis (preço, mensagens, voz, relatórios, teste grátis, ativo) | `packages/shared/src/billing.ts`, `plans/{id}`, `GET /v1/billing/plans`, `PUT /v1/admin/plans/{id}` | Implementado e testado |
| Plano efetivo por assinatura (período pago, carência de 3 dias, cancelamento, troca agendada) | `workers/api/src/billing/store.ts` (`effectivePlan`) | Implementado e testado |
| Limites de uso por plano (mensagens e voz) vindos do banco | `getEntitlements` → `ai/*` | Implementado e testado (substitui `AI_DEFAULT_PLAN`) |
| Assinatura: checkout, troca, cancelamento, sincronização, histórico | `billing/routes.ts`, `/v1/billing/*` | Implementado e testado (provedor simulado) |
| Webhook assinado, idempotente | `billing/webhook.ts`, `billing/service.ts`, `POST /webhooks/mercadopago` | Implementado e testado |
| Adaptador Mercado Pago (assinaturas "preapproval") | `billing/mercadopago.ts` | Implementado; **só com respostas simuladas** |
| Caminho privilegiado restrito (conta de serviço) | `workers/api/src/system.ts` | Implementado e testado |
| Painel administrativo (indicadores, planos, assinaturas, consumo, logs, integrações) | `workers/api/src/admin/routes.ts`, `/v1/admin/*`, `apps/web/src/pages/admin/` | Implementado e testado |
| Telas do usuário: planos, assinatura, pagamentos, uso | `apps/web/src/pages/billing/BillingPage.tsx` (`/assinatura`) | Implementado e testado (componente, sem navegador real) |
| Regras do Firestore (`plans`, `subscriptions`, `billingPayments`) e índices de grupo | `firebase/firestore.rules`, `firestore.indexes.json` | Escritas; testes de regras só rodam na CI |

## Como funciona

1. **Checkout** (`POST /v1/billing/checkout`, `Idempotency-Key` obrigatória): cria a assinatura no provedor com o
   `uid` como referência e grava `subscriptions/{uid}` como `pending`. Pendente **não libera plano**. Repetir a mesma
   chave devolve o mesmo link; uma assinatura pendente antiga é cancelada no provedor. Quem já tem plano válido recebe
   `409 subscription_exists`. Teste gratuito só para quem nunca assinou.
2. **Webhook** (`POST /webhooks/mercadopago`, sem login): valida a assinatura HMAC-SHA256 (`401 invalid_signature`
   se falhar, sem consultar o provedor), **consulta o provedor** para obter o estado real (o corpo nunca é
   confiado), aplica o estado e registra `webhookEvents/{hash}`. Falha transitória → `503` para o provedor repetir.
3. **Idempotência:** evento duplicado → `duplicate`; pagamentos têm id determinístico (um registro por cobrança);
   o estado é uma função pura do que o provedor informa, então repetir não muda o resultado.
4. **Plano efetivo:** ativo → plano contratado (ou o menor agendado após o fim do período); inadimplente → plano
   até `graceUntil` (3 dias), depois Free; cancelado → plano até o fim do período pago, depois Free.
5. **Troca de plano:** upgrade vale na hora (limites maiores) e o novo preço vai ao provedor para a próxima cobrança;
   downgrade fica agendado (`pendingPlanId`) até a próxima renovação aprovada.
6. **Limites:** o assistente lê o plano efetivo e a configuração do plano no banco; ao estourar → `429`.
7. **Painel:** exige a claim `admin` no token verificado (`403 admin_required`); toda chamada é gravada em
   `adminLogs` (se a gravação falhar, a escrita é negada). O administrador **não vê conteúdo financeiro** dos
   clientes: o caminho privilegiado só alcança `plans`, `subscriptions`, `webhookEvents`, `adminLogs`,
   `users/{uid}/billingPayments` e **agregados** de `aiUsage`/`aiLogs` (lista fechada em `system.ts`).

## Testes

| O quê | Arquivo | Resultado local |
|---|---|---|
| Criação de assinatura, webhook válido/inválido, idempotência, mudança de plano, cancelamento, limites, carência, isolamento, painel admin, não acesso ao conteúdo dos clientes (36 testes) | `workers/api/test/billing.suite.ts` via `billing.fake.test.ts` | **Aprovado** (Firestore falso em memória) |
| Mesma suíte contra o emulador real com as regras reais | `billing.integration.test.ts` | **Não executado localmente** (emulador só na CI) |
| Adaptador Mercado Pago (formato dos pedidos, mapeamento de status/erros, HMAC válido/inválido/adulterado) | `mercadopago.test.ts` | Aprovado (12) |
| Token da conta de serviço (JWT RS256 real contra endpoint simulado), cache, erros | `system.test.ts` | Aprovado (4) |
| Esquemas e padrões de plano | `packages/shared/src/billing.test.ts` | Aprovado (3) |
| Telas `/assinatura` e `/admin` (componentes, API simulada) | `BillingPage.test.tsx`, `AdminPage.test.tsx` | Aprovado (13) |
| Regras do Firestore de planos/assinatura/pagamentos/logs | `firebase/tests/billing.rules.test.ts` | **Não executado localmente** (CI) |

Totais locais: `pnpm test` = shared 100 + web 82 + api 239 = **421**; `pnpm lint`, `pnpm typecheck` e `pnpm build` ok.
Resultado da CI: ver registro no fim deste arquivo.

## Checklist da fase

| Item | Situação |
|---|---|
| Criar assinatura em ambiente de teste | Feito com provedor **simulado** (sem Mercado Pago real) |
| Processar webhook | Feito (simulado e com HMAC real no adaptador) |
| Confirmar alteração do plano | Feito (`webhook → plano efetivo → limites`) |
| Testar limite do plano | Feito (Free 30 mensagens; Pro 300; limite editado pelo admin) |
| Confirmar bloqueio do excedente | Feito (`429 ai_limit_reached` / `ai_voice_limit_reached`) |
| Fluxo real no navegador com Mercado Pago de teste | **Não executado** |

## Como ligar de verdade

1. Projeto Firebase real, conta de serviço com acesso ao Firestore → `wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON`.
2. Mercado Pago: `MERCADOPAGO_ACCESS_TOKEN` e `MERCADOPAGO_WEBHOOK_SECRET` (secrets); `WEB_BASE_URL`,
   `API_PUBLIC_URL`, `PAYMENT_PROVIDER=mercadopago` (vars). Cadastrar `API_PUBLIC_URL/webhooks/mercadopago` com os
   tópicos `subscription_preapproval` e `subscription_authorized_payment`.
3. Implantar `firestore.rules` e `firestore.indexes.json`.
4. Definir a claim de administrador num usuário (Admin SDK `setCustomUserClaims(uid, { admin: true })` ou o console);
   o usuário precisa renovar o token. **Passo manual, não automatizado e não testado.**

## Limites e pendências (honestos)

- **Mercado Pago nunca foi chamado de verdade.** O formato do manifesto do webhook e dos pedidos vem da documentação
  e não foi confirmado numa conta real; o parâmetro `free_trial` no pedido de criação **não foi verificado** (se o
  provedor o ignorar, não há teste gratuito).
- **Índices de grupo de coleção** (`aiUsage.updatedAt`, `aiLogs.event/createdAt`) foram declarados, mas não validados em
  projeto real; sem eles o painel de consumo/erros falha no Firestore de verdade.
- **Upgrade libera os limites maiores antes de o provedor cobrar a diferença** (o novo valor só vale na próxima
  cobrança). Decisão consciente (D-009); pode ser trocada por cobrança proporcional.
- **Cota sob concorrência** pode passar um pouco do limite (herdado da Fase 4).
- **Nível de relatório (`reports`) é exposto, mas não bloqueia nada.** "Relatórios inteligentes" não foram feitos.
- **Web Push, e-mail e métricas de notificações não existem** (painel informa "indisponível").
- **Painel admin é uma rota do mesmo app web**, não um app separado.
- **Custo de IA no painel é estimativa** (preços de `COSTS.md`), não a fatura.
- Leitura de assinaturas no painel limitada a 1000 (o painel avisa quando truncado).
- **Regras e emulador só foram executados na CI**; navegador real não foi usado; `main` continua sem proteção.
