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

## Agenda (Fase 3)

- Regras para `events`, `eventExceptions`, `tasks`, `taskCategories`, `reminders`, `notifications` com validação de
  formato (tipo, horário, duração, fuso, link, lembretes, recorrência, custo), `uid` imutável, ids validados.
  Exclusão permitida só em eventos, exceções, tarefas e lembretes; notificações não são excluídas.
- Avisos de vencimento financeiro não contêm valores. Descrição de evento não é enviada em edições.
- 43 testes de regras e 44 de API no emulador real (CI) cobrem isolamento A×B, formato e imutabilidade.
- Limite conhecido: o cliente, com o próprio token, pode gravar nos próprios dados fora do Worker; as regras
  garantem formato e dono, não a consistência entre documentos (ex.: vínculo evento↔despesa).

## Testes de isolamento exigidos

Usuário A não lê/altera/exclui dados de B; sem token ou JWT inválido não há acesso;
troca manual de `uid` não permite apropriação. Resultados reais em `PHASE_01_FOUNDATION.md`.

## Conformidade

Não afirmar conformidade com a LGPD sem revisão jurídica e operacional.

## Assistente de IA (Fase 4)

- **Ameaça: prompt injection** (texto em títulos de eventos/lançamentos tentando comandar o modelo). Mitigação:
  saída de ferramenta marcada como DADOS, truncada e sem campos internos; o modelo nunca executa — só propõe; ações
  pendentes mostram um resumo montado pelo backend; estorno/baixa/edição/exclusão sempre exigem confirmação; após
  ler texto livre o turno não executa nada automaticamente. Testado com um modelo simulado que *obedece* a injeção.
- **Ferramentas:** lista fechada de 23; nome fora da lista, JSON quebrado, campo extra (`uid`, `allowDuplicate`) e
  ids de outro usuário são recusados e auditados.
- **Parâmetros congelados:** `argsHash` conferido na execução; o corpo de `confirm` não aceita parâmetros.
- **Segredos:** `DEEPSEEK_API_KEY` e `GROQ_API_KEY` só como secrets do Worker; mensagens de erro de provedor não
  vazam corpo nem credencial (testado).
- **Voz:** consentimento explícito e revogável; áudio repassado e descartado; limites de tamanho/duração/tipo.
- **Auditoria:** `aiLogs` é só de inclusão (regras). **Retenção:** apagar uma conversa remove o texto, mas `aiActions`
  (com os parâmetros e resumo) e `aiLogs` ficam, como trilha de auditoria; não há ainda rotina de exclusão/expiração
  (a decidir com a revisão de privacidade, Fase 6).
- **Dados enviados ao provedor de LLM:** o texto da conversa e os resultados das ferramentas consultadas (valores,
  descrições, títulos). Isso precisa constar na política de privacidade; **não** há revisão jurídica.
- **Limite conhecido:** o cliente tem o próprio token do Firestore, então um cliente malicioso poderia gravar
  diretamente os próprios documentos de IA dentro do que as regras permitem (afeta só o próprio usuário).
