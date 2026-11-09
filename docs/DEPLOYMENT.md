# DEPLOYMENT

> Estado (Fase 1): nenhum deploy realizado. Esta página descreve o plano e o que já existe.

## O que existe

- CI (`.github/workflows/ci.yml`): job `verify` (install, lint, typecheck, test, build) e job
  `firestore-rules` (emulador). Roda em `develop`, `main` e pull requests. Não faz deploy.
- Build do frontend em `apps/web/dist` (Cloudflare Pages) e do Worker via `wrangler`.

## Plano

- Ambientes: desenvolvimento, staging e produção, cada um com seu projeto Firebase.
- Sem deploy automático em produção com testes críticos falhando.
- Branches: `develop` para trabalho, `main` protegida (ativar a proteção no GitHub).

## Antes do primeiro deploy

1. Criar o projeto Firebase, habilitar Auth por e-mail/senha e criar o app web.
2. Publicar as regras: `firebase deploy --only firestore:rules,firestore:indexes` (a partir de `firebase/`).
3. Worker: ajustar `FIREBASE_PROJECT_ID` e `ALLOWED_ORIGIN` em `workers/api/wrangler.toml`; `wrangler deploy`.
4. Pages: definir as variáveis `VITE_*` (ver `ENVIRONMENT.md`) e o comando de build `pnpm --filter @lifeflow/web build`.
5. Em `apps/web/public/_headers`, trocar `https://*.workers.dev` pela URL real do Worker na CSP.
6. Adicionar a origem do Pages aos domínios autorizados do Firebase Auth.

## Backup e recuperação

Ainda não implementado. Firestore não tem backup automático garantido no plano gratuito; será
documentado e testado (exportação periódica, restauração e teste de restauração) antes do lançamento
(Fase 6). Backup só é válido depois de restauração testada.
