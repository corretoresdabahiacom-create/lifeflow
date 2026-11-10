# DECISIONS

Registro de decisões arquiteturais. Alterações em decisões fundamentais exigem:
Problema, Alternativas, Justificativa, Impacto, Aprovação.

## D-001 — Stack inicial definida pelo contrato mestre

- **Data:** 2026-11-09
- **Decisão:** React + TypeScript + Vite (Cloudflare Pages), Cloudflare Workers, Supabase
  (PostgreSQL, Auth, RLS), Cloudflare R2 sob demanda, pnpm.
- **Origem:** MASTER_PROMPT Parte A (decisões definitivas).
- **Status:** **Parcialmente substituída por D-004** (banco e autenticação). Demais itens vigentes.

## D-002 — Estrutura de monorepo pnpm

- **Data:** 2026-11-09
- **Problema:** Organizar frontend, worker, painel admin, provedores e regras do banco.
- **Alternativas:** Repositórios separados; monorepo pnpm workspaces.
- **Justificativa:** Tipos e validações compartilhados, CI único, versionamento conjunto de
  regras de segurança e API.
- **Impacto:** Um único pipeline; pacotes `shared` e `providers` reutilizados por web, admin e worker.
- **Aprovação:** Autorizada pelo responsável em 2026-11-09 ("autorizo iniciar").

## D-003 — Fluxo de branches

- **Data:** 2026-11-09
- **Decisão:** `main` protegida; trabalho em `develop`.
- **Aprovação:** Confirmada pelo responsável em 2026-11-09.
- **Observação:** a proteção de `main` precisa ser ativada nas configurações do GitHub
  (branch protection); o repositório por si só não a impõe.

## D-004 — Supabase substituído por Firebase (Firestore + Firebase Auth)

- **Data:** 2026-11-09
- **Problema:** O responsável solicitou trocar o Supabase por Firebase. A decisão A1/A2 do
  contrato mestre exige justificativa e autorização para trocar tecnologias.
- **Alternativas:**
  1. **Firestore + Firebase Auth + Security Rules** (escolhida): plano gratuito (Spark) e sem
     servidor próprio de banco; autorização por regras declarativas.
  2. Firebase Data Connect (PostgreSQL gerenciado): mantém modelo relacional, mas depende de
     Cloud SQL, que é infraestrutura paga. Conflita com o princípio A5 (custo inicial ~zero).
  3. Manter Supabase: contrariaria a instrução do responsável.
- **Justificativa:** Firestore é a opção Firebase compatível com custo inicial próximo de zero
  e com o contrato A2 (token do usuário repassado ao banco, que aplica as regras).
  Cotas gratuitas podem mudar; nenhuma gratuidade é prometida como permanente.
- **Impacto (mapeamento do contrato):**
  - PostgreSQL → Firestore (NoSQL, documentos em `users/{uid}/...`). Não há JOINs nem
    constraints relacionais; integridade passa a ser garantida por Security Rules, validação
    no Worker (schemas compartilhados) e transações do Firestore.
  - **Migrations SQL → regras e índices versionados** (`firestore.rules`,
    `firestore.indexes.json`) mais schemas de validação em `packages/shared`.
    Mudanças de formato de dados exigirão scripts de migração de dados versionados.
  - **RLS → Firestore Security Rules**, com permissões separadas por operação
    (`get`, `list`, `create`, `update`, `delete`). `auth.uid()` → `request.auth.uid`.
  - **Supabase Auth → Firebase Auth.** O Worker valida o ID token (assinatura RS256 via JWKS do
    Google, `iss`, `aud`, `exp`) e o repassa ao Firestore REST, que aplica as regras.
    O Worker não usa conta de serviço nas requisições de usuário e não guarda refresh token.
  - A Fase 2 (financeiro) exige atenção: saldos e transferências precisam de transações
    Firestore (limite de operações por transação) e a idempotência será por IDs de documento
    determinísticos. Relatórios e agregações são mais limitados que em SQL.
  - Custo do Firestore é por leitura/escrita/armazenamento; a Fase 6 deve monitorar cotas.
  - Documentos afetados e atualizados: ARCHITECTURE, SECURITY, DATABASE, ENVIRONMENT, COSTS,
    TESTING, `.env.example`, README.
- **Aprovação:** Solicitada pelo responsável em 2026-11-09 ("substitua o supabase por firebase").
  A escolha do Firestore em vez do Data Connect foi minha; o responsável pode pedir a
  alternativa 2 antes da Fase 2.

## D-005 — Modelo LLM: deepseek-flash

- **Data:** 2026-11-09
- **Decisão:** Manter `deepseek-flash` como modelo inicial do `LLMProvider` (Fase 4),
  configurável por ambiente.
- **Origem:** Confirmação do responsável. O identificador não foi verificado por mim na
  documentação oficial da DeepSeek; será conferido com uma chamada autorizada na Fase 4.
  Nenhuma chamada paga sem autorização.

## D-006 — Modelo financeiro no Firestore (Fase 2)

- **Data:** 2026-11-09
- **Decisão:**
  1. **Dinheiro em centavos inteiros** (`amountCents`, `balanceCents`, `signedCents`). Decimais são
     rejeitados na API e nas regras. Teto de R$ 1 bilhão por valor.
  2. **Livro-razão imutável + saldo denormalizado.** `transactions` nunca é apagado: o estorno muda
     `status` de `posted` para `voided`. O saldo atual da conta (`balanceCents`) é atualizado por
     **incremento atômico no servidor** (`updateTransforms.increment`) no MESMO `documents:commit` do
     lançamento. Não há leitura-e-soma no Worker, então não existe condição de corrida de saldo.
  3. **Transferência = 1 commit** com 5 gravações: documento `transfers`, duas pernas em `transactions`
     (`transfer_out` e `transfer_in`) e os dois incrementos de saldo. Tudo ou nada.
  4. **Idempotência por id determinístico.** `Idempotency-Key` (obrigatória nas criações) gera o id do
     documento (`sha256(escopo:chave)`); a gravação usa `currentDocument.exists=false`. Repetição devolve o
     resultado original (200 + `Idempotent-Replay`); mesma chave com conteúdo diferente → 422;
     requisições simultâneas com a mesma chave geram um único efeito.
  5. **Baixa de conta a pagar/receber** = 1 commit: conta paga (pré-condição `updateTime` lido) + lançamento
     (id `pay_<conta>_<n>`, `exists=false`) + saldo. Segunda baixa → 409 `already_paid`. Estornar o
     lançamento da baixa reabre a conta.
  6. **Duplicidade provável** (mesma conta, tipo, valor, data e descrição, com chave diferente) → 409
     `possible_duplicate`; o usuário confirma com `allowDuplicate=true`.
  7. **Mapeamento do contrato (Parte G):** `financial_reminders` → `payables` (contas a pagar/receber, com
     vencimento e baixa); `recurring_transactions` → `recurring` (regras de recorrência).
  8. **Recorrência sem agendador.** A regra só gera contas quando o usuário pede
     (`POST /v1/recurring/materialize`). Ids determinísticos (`rec_<regra>_<data>`) impedem duplicidade.
     Máximo de 20 contas por chamada (limite de subrequisições do Worker; `hasMore` indica continuação).
     Agendamento automático fica para a Fase 3, junto com notificações.
  9. **Relatórios por agregação em memória** sobre consulta por período (até 5000 lançamentos; acima
     disso a resposta traz `truncated: true`). Sem índices compostos: consultas usam só índices de campo
     único (data) e os demais filtros são aplicados em memória.
  10. **Conciliação** (`GET /v1/reconcile`) compara o saldo guardado com `saldo inicial + lançamentos
      efetivados`, para detectar divergência.
- **Limite assumido (honesto):** como o Worker usa o token do usuário (sem conta de serviço, D-004), um
  cliente mal-intencionado poderia gravar direto no Firestore com o próprio token. As regras impedem
  acesso a dados de outros usuários, exigem formato e imutabilidade (valor, conta, tipo e data do
  lançamento não mudam; nada é apagado; saldo inicial = saldo na criação), mas **não provam** que o saldo
  bate com os lançamentos. Isso é detectável por `reconcile` e afeta apenas os dados do próprio usuário.
  Reforço possível: regras com `getAfter()` ou conta de serviço restrita, a decidir.
- **Premissa não verificada:** limite de subrequisições do Worker (assumido 50 por requisição no plano
  gratuito, de memória). Não consultei a documentação nesta sessão; conferir antes do deploy.
- **Alternativa não adotada:** transações do Firestore (leitura-modificação-escrita) com `beginTransaction`;
  descartada porque incrementos atômicos dispensam a leitura e reduzem contenção e custo.

## Pendências

- Ativar proteção da branch `main` no GitHub.
- Criar projetos Firebase de staging e produção (a Fase 1 usa apenas o emulador local e o
  projeto de demonstração `demo-lifeflow`, sem credenciais reais).
