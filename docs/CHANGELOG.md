# CHANGELOG

## [Não lançado]

### Fase 1 — Fundação (2026-11-09)
- Substituição do Supabase por Firebase (Firestore + Auth), D-004; modelo `deepseek-flash` registrado (D-005).
- Monorepo pnpm: `apps/web`, `workers/api`, `packages/shared`, `firebase`.
- Worker: validação de JWT do Firebase (RS256, `iss`, `aud`, `exp`, `sub`), cliente do Firestore por
  requisição com o token do usuário, rotas `/healthz`, `/v1/me`, `/v1/profile`, `/v1/preferences`.
- Firestore Security Rules por operação, negado por padrão, `uid` imutável.
- Frontend: login/cadastro/logout, rota protegida, layout responsivo, tema claro/escuro, PWA básica.
- Testes: 57 passando em `pnpm test`; 19 testes de regras aprovados no emulador (CI, run 42659605727);
  não executados na máquina de desenvolvimento por bloqueio de rede. Checklist manual pendente.
- CI no GitHub Actions (verify + firestore-rules).

### Fase 0 — Inspeção e inicialização (2026-11-09)
- Repositório encontrado vazio; relatório apresentado e inicialização autorizada.
- Esqueleto do monorepo e documentação permanente (Parte O). Nenhum código de aplicação.
