# ARCHITECTURE

> Estado (Fase 1): fundação implementada. Ver `PHASE_01_FOUNDATION.md` para evidências.

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

## Estrutura de dados (Fase 1)

```
users/{uid}                      perfil (displayName, locale, timezone, currency)
users/{uid}/preferences/{key}    preferências (documento "app")
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
| Firestore Security Rules | Escritas; 19 testes aprovados no emulador do Firestore (CI) |
| DeepSeek (LLM) | Não implementado |
| Groq (transcrição) | Não implementado |
| Mercado Pago | Não implementado |
| Resend (e-mail) | Não implementado |
| Web Push (VAPID) | Não implementado |
| Cloudflare (deploy) | Não implementado (somente configuração local do Worker) |
