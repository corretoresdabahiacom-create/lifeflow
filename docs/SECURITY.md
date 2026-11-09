# SECURITY

> Estado: requisitos planejados. Nada implementado ainda (Fase 0).

## Requisitos (MASTER_PROMPT Parte L)

JWT validado no Worker, RLS por tabela (políticas específicas para SELECT/INSERT/UPDATE/DELETE,
sem políticas genéricas permissivas), validação de entrada, rate limiting, proteção XSS/CSRF/SQLi,
secrets apenas em ambiente, auditoria, gestão de sessão, proteção de endpoints administrativos,
proteção contra prompt injection, sem dados financeiros em prompts sem necessidade.

## Regras de repositório

- Nenhuma credencial real no Git; `.env*` ignorados, exceto `.env.example`.
- Operações privilegiadas somente via função SQL restrita (permissões mínimas, `search_path`
  fixo, validação de identidade/contexto, auditoria). Sem bypass genérico da RLS.

## Testes de isolamento exigidos na Fase 1

Usuário A não lê/altera/exclui dados de B; sem token ou JWT inválido não há acesso;
troca manual de `user_id` não permite apropriação.

## Conformidade

Não afirmar conformidade com a LGPD sem revisão jurídica e operacional.
