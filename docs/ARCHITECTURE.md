# ARCHITECTURE

> Estado (Fase 2): fundação e módulo financeiro implementados. Ver `PHASE_01_FOUNDATION.md` para evidências.

## Visão geral

Frontend React/Vite (PWA) em Cloudflare Pages → Cloudflare Worker (API) → Firestore.
Autenticação com Firebase Auth. Contrato em `MASTER_PROMPT.md`, adaptado por `DECISIONS.md` D-004.

## Fluxo de autenticação (contrato A2, adaptado para Firebase)

1. O usuário autentica pelo Firebase Auth; o SDK no frontend mantém e renova a sessão.
2. O frontend envia o ID token ao Worker em `Authorization: Bearer <token>`.
3. O Worker valida o JWT: assinatura RS256 (JWKS do Google), `iss` =
   `https://securetoken.google.com/<projectId>`, `aud` = `<projectId>`, `exp`, `sub` não vazio.
4. O Worker chama a API REST do Firestore **por requisição**, repassando o mesmo token do
   usuário. O Firestore aplica as Security Rules.
5. As regras identificam o usuário por `request.auth.uid`.
6. O Worker nunca usa conta de serviço em requisições de usuário, não guarda refresh token e
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
| Worker | `workers/api` | Validação de JWT, validação de entrada, acesso ao Firestore |
| Shared | `packages/shared` | Schemas de validação e tipos |
| Regras | `firebase/` | `firestore.rules`, índices, testes de regras |

## Status das integrações (contrato A4)

| Integração | Status |
|---|---|
| Firebase Auth (frontend) | Código implementado; sem projeto real configurado |
| Validação de JWT Firebase no Worker | Código implementado e testado com mocks (chaves geradas nos testes) |
| Firestore REST via Worker | Código implementado e testado com mocks |
| Firestore Security Rules | Escritas; 113 testes de regras aprovados no emulador do Firestore (CI): 19 da Fase 1 + 51 financeiros + 43 da agenda |
| Módulo financeiro (Worker + Firestore) | Implementado; 31 testes de API aprovados contra o emulador real com as regras reais (CI) |
| Módulo de agenda (Worker + Firestore) | Implementado; 44 testes de API no emulador real com as regras reais (CI); 43 de regras |
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
Navegador ── POST …/actions/{id}/confirm ─► Worker ─► rota interna (mesmas validações) ─► Firestore
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
