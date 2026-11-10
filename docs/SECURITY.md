# SECURITY

## Requisitos (MASTER_PROMPT Parte L)

JWT validado no Worker, autorização por regras do banco, validação de entrada, rate limiting,
proteção XSS/CSRF/injeção, secrets apenas em ambiente, auditoria, gestão de sessão, proteção
de endpoints administrativos, proteção contra prompt injection, sem dados financeiros em
prompts sem necessidade.

## Estado (Fases 1 e 2)

| Controle | Estado |
|---|---|
| Validação criptográfica de JWT no Worker (assinatura, iss, aud, exp, sub) | Implementado e testado com mocks |
| Segurança de dados por Security Rules (equivalente à RLS) | Implementado; 19 testes negativos aprovados no emulador (CI, run 42659605727) |
| `uid` vem só do token; `uid` do cliente nunca é identidade | Implementado e testado |
| Sem conta de serviço em requisições de usuário | Implementado (Worker não possui credencial de serviço) |
| Sem refresh token no Worker | Implementado |
| CORS restrito à origem configurada | Implementado |
| Logs estruturados sem token/corpo | Implementado |
| Cache: nada de resposta autenticada no service worker | Implementado (cache só de arquivos estáticos) |
| Isolamento dos dados financeiros (contas, lançamentos, transferências, contas a pagar, recorrências) | Implementado; 51 testes de regras e 31 testes de API aprovados no emulador (CI) |
| Idempotência e prevenção de duplicidade em operações financeiras | Implementado e testado (inclui requisições simultâneas) |
| Ids de documento controlados (`^[A-Za-z0-9_-]{1,80}$`) contra manipulação de caminho | Implementado (API, regras e rotas) |
| Exportação CSV sem injeção de fórmulas; token só em cabeçalho | Implementado e testado |
| Livro-razão sem exclusão (estorno em vez de delete) | Implementado nas regras |
| Garantia de que saldo = lançamentos contra cliente mal-intencionado | **Parcial**: regras não provam; há conciliação (`/v1/reconcile`); ver D-006 |
| Rate limiting | **Pendente** (fases seguintes) |
| Auditoria (`audit_logs`) | **Pendente** (fases seguintes) |
| Endpoints administrativos | **Pendente** (Fase 5) |
| Proteção contra prompt injection | **Pendente** (Fase 4) |

## Regras de repositório

- Nenhuma credencial real no Git; `.env*` ignorados, exceto `.env.example`.
- A chave web do Firebase (apiKey) e o `projectId` são identificadores públicos de cliente,
  não segredos; a segurança vem das Security Rules. Ainda assim não há valores reais no Git.
- Operações privilegiadas, quando necessárias, serão restritas e auditadas. Não existe
  caminho genérico de bypass das regras.

## Testes de isolamento exigidos

Usuário A não lê/altera/exclui dados de B; sem token ou JWT inválido não há acesso;
troca manual de `uid` não permite apropriação. Resultados reais em `PHASE_01_FOUNDATION.md`.

## Conformidade

Não afirmar conformidade com a LGPD sem revisão jurídica e operacional.
