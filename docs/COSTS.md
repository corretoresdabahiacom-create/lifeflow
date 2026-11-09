# COSTS

> Princípio: investimento inicial zero ou próximo de zero. Nenhuma gratuidade de fornecedor é
> prometida como permanente. Consumo ilimitado de APIs pagas por conta de usuário é proibido.

## Estado (Fase 1)

Nenhum serviço pago é usado. O desenvolvimento roda com testes locais e mocks; nenhuma API paga foi chamada.

## O que gera custo ou cota

| Serviço | Uso previsto | Observação |
|---|---|---|
| Cloudflare Pages / Workers | Frontend e API | Há plano gratuito com limites; confirmar nos preços oficiais antes do deploy |
| Firebase Auth | Login por e-mail/senha | Verificar cotas do plano atual; login por SMS é cobrado e **não** é usado |
| Firestore | Dados do usuário | Cobrança por leitura/escrita/armazenamento, com cota gratuita diária; a Fase 6 deve monitorar |
| LLM (DeepSeek) | Fase 4 | Pago por uso; só com autorização e limites por plano |
| Transcrição (Groq) | Fase 4 | Idem |
| E-mail (Resend) | Fases 3 e 5 | Verificar plano gratuito e limites |
| Pagamentos (Mercado Pago) | Fase 5 | Taxas por transação |

## Valores

Preços e cotas devem ser preenchidos aqui **a partir das páginas oficiais, com a data da consulta**,
quando cada integração for implementada. Não foram consultados na Fase 1 e portanto não são citados.

## Controles a implementar (Parte K4)

Métricas por usuário e por plano, limites de consumo, alertas e proteção contra abuso (Fases 4 a 6).
Para o Firestore: evitar listagens sem limite e consultas de varredura; paginação obrigatória.
