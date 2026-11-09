# DEPLOYMENT

> Estado: planejado. Nenhum deploy configurado (Fase 0).

## Plano (MASTER_PROMPT Parte K)

- GitHub Actions: instalação, lint, typecheck, testes, build, verificação de migrations, deploy controlado.
- Ambientes: desenvolvimento, staging, produção.
- Sem deploy automático em produção com testes críticos falhando.
- Backup e restauração do PostgreSQL documentados e testados antes de serem considerados válidos
  (não presumir backup automático suficiente no plano gratuito).
