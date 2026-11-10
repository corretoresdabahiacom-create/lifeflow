# COSTS

> Princípio: investimento inicial zero ou próximo de zero. Nenhuma gratuidade de fornecedor é
> prometida como permanente. Consumo ilimitado de APIs pagas por conta de usuário é proibido.

## Estado (Fase 2)

Nenhum serviço pago é usado. O desenvolvimento roda com testes locais, mocks e o emulador do Firestore
(na CI do GitHub); nenhuma API paga foi chamada.

### Consumo de leituras/escritas do Firestore por operação (estimativa pelo código, não medida)

| Operação | Leituras de documento | Escritas |
|---|---|---|
| Criar lançamento | 1 (idempotência) + 1 conta + 0–1 categoria + até 200 (checagem de duplicidade, só os do mesmo dia) | 2 (lançamento + conta) |
| Transferência | 1 + 2 contas | 5 |
| Baixa de conta | 1 perfil (fuso) + 1 conta a pagar + 1 conta | 3 |
| Listar lançamentos | até 2000 (varredura com filtro em memória; típico: os do período) | 0 |
| Relatório / exportação / conciliação | todos do período (até 5000), além de contas e categorias | 0 |
| Painel | lançamentos do mês + contas + contas a pagar até +30 dias | 0 |

Pontos de atenção: relatórios e conciliação leem muitos documentos (custo proporcional ao volume);
o painel os executa a cada abertura. A Fase 6 deve avaliar agregados pré-calculados e cache. As cotas
gratuitas do Firestore não foram consultadas nesta fase e não são citadas.

Limite do Worker: cada requisição faz poucas subchamadas ao Firestore (até ~15 nos casos comuns; a
geração de recorrências é limitada a 20 contas por chamada por isso). Assumi 50 subrequisições por
requisição no plano gratuito, de memória; **não verificado** (ver D-006).

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

## Agenda (Fase 3)

`POST /v1/notifications/generate` lê eventos, exceções, tarefas, contas a pagar e lembretes do usuário.
O frontend chama ao abrir a agenda e **a cada 5 minutos por aba aberta**: custo de leituras do Firestore e de
requisições do Worker proporcional a usuários com a agenda aberta. Mitigação já presente: janela limitada,
leituras com limite e idempotência (sem gravações repetidas). Não medido em ambiente real; preços do Firestore e do
Worker não consultados nesta fase. Web Push/agendador (futuro) trocaria essas leituras por execuções agendadas.
