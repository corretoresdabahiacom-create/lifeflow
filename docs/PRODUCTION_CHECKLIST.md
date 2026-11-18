# CHECKLIST DE PRODUÇÃO

Legenda: ✅ verificado por teste automatizado (ambiente de teste) · 🔶 escrito/testado só com simulações · ⬜ **não verificado — fazer em staging**.

## Fluxos funcionais (checklist do MASTER_PROMPT)

| Item | Automatizado | Em staging real (Firebase/Mercado Pago/IA) |
|---|---|---|
| Cadastro | 🔶 componentes e `AuthProvider` com mocks | ⬜ |
| Login | 🔶 idem; token validado no Worker ✅ | ⬜ |
| Operações financeiras | ✅ 35 testes de API no Firestore falso e no emulador real + regras | ⬜ |
| Agenda | ✅ 47 testes de API (falso + emulador) + regras | ⬜ |
| IA | 🔶 modelo simulado; prompt injection ✅ | ⬜ (DeepSeek/Groq reais nunca chamados) |
| Assinaturas | 🔶 provedor simulado + HMAC real | ⬜ (Mercado Pago real nunca chamado) |
| PWA | 🔶 manifest/service worker/offline presentes; build ✅ | ⬜ instalar no Android/iOS, testar offline |
| Mobile | ⬜ | ⬜ testar em celulares reais |
| Exportação | ✅ CSV e JSON completo | ⬜ |
| Exclusão de conta | ✅ API (falso + emulador) e tela | ⬜ incluindo `deleteUser` real do Firebase Auth |
| Restauração de backup | ✅ mecanismo no emulador (CI) | ⬜ backup gerenciado + ensaio em staging |

## Testes obrigatórios da Fase 6

Build, lint, typecheck, unitários, integração, segurança, isolamento e recuperação: resultados reais em `PHASE_06_LAUNCH.md`.

## Go / No-go (todos devem estar marcados)

- [ ] Projetos Firebase de staging e produção criados; regras e índices publicados
- [ ] Todos os secrets definidos; `GET /readyz` = 200 em staging e em produção
- [ ] CSP atualizada com a URL real da API; domínio autorizado no Firebase Auth
- [ ] Regras de rate limiting do Cloudflare ativas (achado A4)
- [ ] Webhook do Mercado Pago cadastrado; **uma assinatura de teste real** concluída (checkout → webhook → plano → cancelamento)
- [ ] Índices de grupo (`aiUsage`, `aiLogs`) confirmados no painel `/admin` (visão geral sem erro)
- [ ] Claim `admin` concedida só a quem deve
- [ ] Backup diário ligado **e ensaio de restauração em staging concluído** (RTO/RPO registrados)
- [ ] Monitor de uptime e alertas ativos (`RUNBOOK.md`)
- [ ] Proteção de branch `main` ativada no GitHub (ainda desligada) e ambiente `production` com aprovação
- [ ] Teste manual em Android e iOS (instalação do PWA, offline, formulários)
- [ ] Revisão jurídica: política de privacidade (dados enviados à IA, retenção, backups), termos de uso, LGPD
- [ ] Decisão sobre retenção de dados fiscais de cobrança (D-010)
- [ ] Preços/limites dos planos conferidos no painel `/admin`
