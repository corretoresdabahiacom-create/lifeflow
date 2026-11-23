# FASE 6 — LANÇAMENTO

> **Histórico:** este documento descreve o estado em Firebase/Firestore. Em 2026-11-23 o banco e o login migraram para o Supabase (ver `DECISIONS.md` D-011).

**Status:** implementada, **aguardando aprovação**. **O produto NÃO foi implantado** e nenhum serviço real
(Firebase, Cloudflare, Mercado Pago, DeepSeek, Groq) foi usado: não existem credenciais neste ambiente.
O que a fase entrega é a **preparação para o lançamento**: auditoria, lacunas fechadas, testes e runbooks.

## Artefatos

| Artefato do contrato | Entrega | Arquivos |
|---|---|---|
| Auditoria | Achados A1–A15 com gravidade e situação | `AUDIT_PHASE_06.md` |
| Testes | Segurança, isolamento, recuperação, conta, operação | `workers/api/test/{security,account}.suite.ts`, `ops.test.ts`, `firebase/scripts/recovery*` |
| Documentação | Runbook, backup/recuperação, checklist de produção, decisões | `RUNBOOK.md`, `BACKUP_RECOVERY.md`, `PRODUCTION_CHECKLIST.md`, `DECISIONS.md` (D-010) |
| Deploy | Workflow manual com aprovação + smoke test (**nunca executado**) | `.github/workflows/deploy.yml`, `scripts/smoke.sh` |
| Backup | Scripts e workflow diário (**nunca executados**); mecanismo testado no emulador | `scripts/*-firestore.sh`, `backup.yml`, `BACKUP_RECOVERY.md` |
| Monitoramento | Logs estruturados, `/healthz`, `/readyz`, painel admin; **alertas externos a configurar** | `RUNBOOK.md` |
| Checklist de produção | Go/no-go com o que ainda falta | `PRODUCTION_CHECKLIST.md` |

## Lacunas encontradas e fechadas nesta fase

- Exportação completa dos dados e **exclusão de conta** (LGPD): `GET /v1/account/export`, `POST /v1/account/delete`,
  tela em Ajustes (reautenticação + frase de confirmação + remoção do login). Decisões em D-010.
- Dependências de produção vulneráveis (zod, react-router, grpc-js) atualizadas.
- `/readyz` (prontidão para produção), sem expor detalhes publicamente.
- Backup/restauração e deploy sem nenhuma automação → scripts, workflows e teste de recuperação.

## Testes obrigatórios — mapa e resultados reais

| Teste | Onde | Resultado |
|---|---|---|
| Build | `pnpm build` (Vite + `wrangler deploy --dry-run`) | **Aprovado** (local e CI) |
| Lint | `pnpm lint` | **Aprovado** (local e CI) |
| Typecheck | `pnpm typecheck` | **Aprovado** (local e CI) |
| Unitários | `pnpm test` = shared 100 + web 89 + api 271 = **460** | **Aprovado** (local e CI) |
| Integração | `pnpm test:integration` (Worker contra o emulador real do Firestore, regras reais) | **Aprovado só na CI**: 188 aprovados, 2 ignorados (testes exclusivos do Firestore falso) |
| Regras do Firestore | `pnpm test:rules` | **Aprovado só na CI**: 137 |
| Segurança | `security.suite.ts` (token em todas as rotas, tokens inválidos, uid só do token, CORS, cabeçalhos, ids de travessia, corpos maliciosos, injeção de campos protegidos, logs sem dados sensíveis, erro genérico) + `ops.test.ts` | **Aprovado** (falso, local) e (emulador, CI) |
| Isolamento | `security.suite.ts` (B não lê/altera/apaga/confirma nada de A em contas, lançamentos, contas a pagar, eventos, tarefas, IA, assinatura; não usa conta de A; IA de B sem dados de A; admin) + `account.suite.ts` (exclusão de A não toca em B) | **Aprovado** (falso, local) e (emulador, CI) |
| Recuperação | `firebase/scripts/recovery-test.sh`: semeia 36 docs → exporta → emulador vazio (nada existe) → importa → confere cada documento e o digest | **Aprovado só na CI**: "restaurados 36 documentos, conteúdo idêntico" |
| Exclusão e exportação de conta | `account.suite.ts` (11 testes) e `SettingsAccount.test.tsx` (7) | **Aprovado** (falso e emulador / jsdom) |
| Worker real (workerd) | `wrangler dev --local`: `/healthz` 200, `/readyz` 503 sem configuração, `/v1/me` e `/v1/admin/overview` 401, `/v1/account/export` 401, CORS não aceita origem alheia, webhook sem segredo 503 | **Verificado manualmente** (log nesta fase) |

CI: execução `44359983746` em `develop` — **verde** (verificação + regras + integração + recuperação).

### Bugs encontrados e corrigidos durante a fase

1. Digest do teste de recuperação dependia da ordem dos campos (o Firestore devolve ordem alfabética) → serialização canônica.
2. (Fase 5, achado ao rodar na CI) filtro de desigualdade sem ordenação pelo mesmo campo — ver `AUDIT_PHASE_06.md` A7.

## Checklist da fase (MASTER_PROMPT)

| Item | Situação |
|---|---|
| Cadastro | Fluxo coberto por testes de componente com mocks; **teste manual com Firebase real: não feito** |
| Login | Idem; validação do token no Worker: testada |
| Operações financeiras | Testadas (API + regras, emulador real na CI); manual em navegador: **não feito** |
| Agenda | Idem |
| IA | Testada com modelo simulado; **DeepSeek/Groq reais nunca chamados** |
| Assinaturas | Testadas com provedor simulado e HMAC real; **Mercado Pago real nunca chamado** |
| PWA | Arquivos presentes e build ok; **instalação/offline em dispositivo real: não verificado** |
| Mobile | **Não verificado** em aparelhos |
| Exportação | CSV e JSON completo testados |
| Exclusão de conta | API e tela testadas; `deleteUser` real do Firebase Auth **não exercitado** |
| Restauração de backup | Mecanismo testado no emulador (CI); **backup gerenciado e ensaio em staging: pendentes** |

## Limites e pendências para o lançamento (honestos)

- **Bloqueios antes de produção** (ver `PRODUCTION_CHECKLIST.md`): rate limiting no Cloudflare (A4), CSP com a URL real,
  assinatura de teste real no Mercado Pago, índices de grupo no Firestore real, backup + ensaio de restauração,
  alertas/monitor de uptime, proteção da branch `main`, testes em celulares, revisão jurídica (LGPD).
- **Deploy, backup e restauração de produção** foram escritos mas **nunca executados**.
- Backup de logins do Firebase Auth não está automatizado.
- Retenção de dados fiscais de cobrança e prazo de retenção de backups: decisão do operador (D-010).
- 1 aviso de `pnpm audit` em produção (provável falso positivo) e avisos de ferramentas de desenvolvimento (A2/A3).
- Sem pentest, sem teste de carga, sem auditoria de acessibilidade.
