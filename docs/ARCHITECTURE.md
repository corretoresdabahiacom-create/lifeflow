# ARCHITECTURE

> Estado: migrado para Supabase na D-011 (2026-11-23). Fase 2: fundação e módulo financeiro implementados. Ver `PHASE_01_FOUNDATION.md` para evidências.

## Visão geral

Frontend React/Vite (PWA) em Cloudflare Pages → Cloudflare Worker (API) → Supabase (PostgreSQL via PostgREST).
Autenticação com Supabase Auth. Contrato em `MASTER_PROMPT.md`; decisão atual em `DECISIONS.md` D-011 (substitui D-004).

## Fluxo de autenticação (contrato A2, Supabase)

1. O usuário autentica pelo Supabase Auth; o `@supabase/supabase-js` no frontend mantém e renova a sessão (usado só para login).
2. O frontend envia o JWT de acesso ao Worker em `Authorization: Bearer <token>`.
3. O Worker valida o JWT: assinatura assimétrica (ES256/RS256, JWKS do projeto; HS256 é recusado), `iss` =
   `<SUPABASE_URL>/auth/v1`, `aud` = `authenticated`, `role` = `authenticated`, `exp`, `sub` UUID.
4. O Worker chama funções `lf_*` (RPC do PostgREST) **por requisição**, repassando o mesmo JWT do
   usuário. O Postgres aplica a RLS e os gatilhos.
5. As políticas identificam o usuário por `auth.uid()`; cada tabela tem `user_id`.
6. O Worker só usa a chave secreta (`service_role`) para a lista fechada de `SystemDb` (webhooks, planos, logs de admin) e `lf_erase_user`; nunca em requisições de dados do usuário, não guarda refresh token e
   nunca aceita `uid` do cliente como identidade: o `uid` vem somente do token validado.
7. Token expirado: o Worker responde `401` com `WWW-Authenticate: Bearer error="invalid_token"`
   e o SDK do frontend renova a sessão.

## Estrutura de dados (Fases 1 e 2)

```
users/{uid}                      perfil (displayName, locale, timezone, currency)
users/{uid}/preferences/{key}    preferências (documento "app")
users/{uid}/accounts/{id}        contas (saldo atual por incremento atômico)
users/{uid}/categories/{id}      categorias de receita/despesa
users/{uid}/transactions/{id}    livro-razão (imutável; estorno em vez de exclusão)
users/{uid}/transfers/{id}       transferências (1 commit: transferência + 2 pernas + 2 saldos)
users/{uid}/payables/{id}        contas a pagar/receber (baixa atômica)
users/{uid}/recurring/{id}       regras de recorrência (geração sob demanda)
```

Todas as coleções pessoais ficam sob `users/{uid}`; a regra de propriedade é por caminho.

## Componentes

| Componente | Caminho | Papel |
|---|---|---|
| Frontend | `apps/web` | UI, autenticação via SDK, PWA |
| Worker | `workers/api` | Validação de JWT, validação de entrada, acesso ao banco (RPC `lf_*`) |
| Shared | `packages/shared` | Schemas de validação e tipos |
| Banco | `supabase/` | Migrações (esquema, RLS, gatilhos, funções), `config.toml`, testes do banco |

## Status das integrações (contrato A4)

| Integração | Status |
|---|---|
| Supabase Auth (frontend) | Código implementado; sem projeto real configurado |
| Validação de JWT do Supabase no Worker | Código implementado e testado com mocks (chaves geradas nos testes) |
| Banco via PostgREST (Worker) | Testado contra Postgres real (PGlite) com PostgREST emulado; contra o PostgREST/GoTrue reais (`supabase start`): 186 testes aprovados na CI (CI run 45264674894); Supabase hospedado: não usado |
| RLS, gatilhos e funções `lf_*` | Migrações escritas; 44 testes (RLS, API) aprovados em Postgres local (PGlite) |
| Módulo financeiro (Worker + banco) | Implementado; suíte de API aprovada no PGlite e no Supabase local real (CI); hospedado: não usado |
| Módulo de agenda (Worker + banco) | Implementado; suíte de API aprovada no PGlite e no Supabase local real (CI); hospedado: não usado |
| Notificações da agenda | Geradas sob demanda pelo app aberto; sem agendador |
| DeepSeek (LLM) | Não implementado |
| Groq (transcrição) | Não implementado |
| Mercado Pago | Adaptador implementado (Fase 5); **nunca testado contra o serviço real** |
| Resend (e-mail) | Não implementado |
| Web Push (VAPID) | Não implementado |
| Cloudflare (deploy) | Não implementado (somente configuração local do Worker) |

## Assistente de IA (Fase 4)

```
Navegador ── POST /v1/ai/chat ──► Worker ── LLMProvider (DeepSeek) ◄─ tool calls
                                    │            │
                                    │            └─► ferramenta de leitura → dados (não confiáveis) → modelo
                                    │            └─► ferramenta de escrita → aiActions (pendente, congelada)
Navegador ── POST …/actions/{id}/confirm ─► Worker ─► rota interna (mesmas validações) ─► Supabase
Navegador ── POST /v1/ai/transcribe (áudio) ─► Worker ─► SpeechToTextProvider (Groq) ─► texto (áudio descartado)
```

Código: `workers/api/src/ai/` (`providers/`, `tools.ts`, `engine.ts`, `store.ts`, `routes.ts`); front:
`apps/web/src/pages/assistant/`. Integrações: DeepSeek e Groq implementadas, **não testadas contra as APIs reais**.

## SaaS (Fase 5)

```
Navegador ── /v1/billing/* (token do usuário; regras valem) ──► Worker ──► PaymentProvider (Mercado Pago)
Mercado Pago ── POST /webhooks/mercadopago (HMAC) ─► Worker ─► relê o estado no provedor ─► SystemDb (conta de serviço, lista fechada)
Admin (claim) ── /v1/admin/* ─► Worker ─► SystemDb: planos, assinaturas, logs, agregados de consumo (sem conteúdo dos clientes)
```

Código: `workers/api/src/billing/`, `admin/`, `system.ts`; front: `apps/web/src/pages/billing/`, `pages/admin/`.
