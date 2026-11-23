# AUDITORIA DE LANÇAMENTO (Fase 6)

> **Histórico:** este documento descreve o estado em Firebase/Firestore. Em 2026-11-23 o banco e o login migraram para o Supabase (ver `DECISIONS.md` D-011).

Auditoria feita sobre o código da branch `develop` (revisão de código, buscas automatizadas, `pnpm audit` e suítes de
teste). **Não foi uma auditoria externa nem um teste de invasão**; não substitui revisão jurídica (LGPD) nem pentest.

## Método

1. Leitura do código de autenticação, rotas, caminho privilegiado, regras do Firestore e cabeçalhos do front.
2. Buscas no Git por segredos (chaves privadas, `sk-`, `AIza…`, tokens do Mercado Pago) e por sinks de XSS
   (`dangerouslySetInnerHTML`, `innerHTML`, `eval`): **nenhuma ocorrência** fora de dados de teste.
3. `pnpm audit` (dependências de produção e de desenvolvimento).
4. Novas suítes de segurança, isolamento e recuperação (ver `PHASE_06_LAUNCH.md`).

## Achados

| # | Gravidade | Achado | Situação |
|---|---|---|---|
| A1 | Alta | Dependências de produção com vulnerabilidades conhecidas (`zod` <4.6.6, `react-router` <7.18, `@grpc/grpc-js` <1.13.6 via Firebase SDK) | **Corrigido**: zod 4, react-router 7, override do grpc-js; testes e build verdes |
| A2 | Baixa | `pnpm audit --prod` ainda lista 1 aviso moderado do pacote `firebase` (`<10.9.0`, GHSA-3wf4-68gx-mph8) mesmo com o SDK em 11.10 e sem caminho de dependência listado | **Aberto / provável falso positivo**: reavaliar quando o aviso for revisado |
| A3 | Média | Dependências de **desenvolvimento** (vite/undici/tar/sharp/ws/basic-ftp via wrangler e firebase-tools) com avisos altos/críticos | **Aceito**: rodam só em desenvolvimento/CI, não vão ao Worker nem ao navegador; reavaliar a cada atualização do `wrangler`/`firebase-tools` |
| A4 | Média | **Não há limitação de taxa no Worker** (só quotas de IA por plano) | **Aberto**: configurar regra de rate limiting no Cloudflare antes do lançamento (ver `RUNBOOK.md`, "Proteção de borda") |
| A5 | Média | Exclusão de conta e exportação não existiam (LGPD) | **Corrigido** (`/v1/account/export`, `/v1/account/delete`; D-010) |
| A6 | Média | Regras impedem o cliente de apagar perfil/auditoria/consentimentos; sem caminho de exclusão a conta nunca seria apagada | **Corrigido** com `UserErasure` (preso ao uid do solicitante, lista de caminhos testada) |
| A7 | Média | Consultas de grupo do painel admin usavam filtro de desigualdade sem ordenar pelo mesmo campo (falha no Firestore real) | **Corrigido** na Fase 5 (CI); o Firestore falso agora aplica a mesma regra |
| A8 | Média | Não havia teste de recuperação nem rotina de backup | **Parcial**: mecanismo export/import testado no emulador (CI); backup gerenciado de produção **escrito, não executado** (`BACKUP_RECOVERY.md`) |
| A9 | Baixa | `/readyz` ausente: não dá para saber se o ambiente está configurado para produção | **Corrigido** (`/readyz`: 200 só com configuração de produção completa; público só devolve o veredito) |
| A10 | Baixa | CSP do front aponta para `https://*.workers.dev` | **Aberto (passo de deploy)**: trocar pela URL real da API em `apps/web/public/_headers` |
| A11 | Média | A conta de serviço ignora as Security Rules | **Risco aceito e mitigado**: `SystemDb` (lista fechada) e `UserErasure` (preso ao uid) cobertos por testes; ver `SECURITY.md` |
| A12 | Baixa | Logs de webhook (`webhookEvents`) guardam ids do provedor após a exclusão da conta | **Aceito**: sem dados pessoais diretos; trilha operacional/fiscal. Decisão de retenção é do operador |
| A13 | Média | Cota de IA e saldos sob concorrência podem ultrapassar um pouco o limite | **Aceito** (herdado das Fases 4/5, documentado) |
| A14 | Info | Segredos: nenhum no Git; `.env`/`.dev.vars` ignorados; segredos só como secrets do Worker | Conferido |
| A15 | Info | Regras do Firestore: `match /{document=**}` nega tudo; coleções novas precisam de regra explícita | Conferido |

## O que isto NÃO garante

- Nada foi testado contra Firebase, Mercado Pago, DeepSeek ou Groq **reais**.
- Não houve teste em navegador/dispositivos reais, nem auditoria de acessibilidade, nem teste de carga.
- Não há revisão jurídica da conformidade com a LGPD.
