LIFEFlow AI — MASTER PROMPT V2.0

Siga rigorosamente as instruções.
Comece exclusivamente pela Fase 0.
Não avance para a Fase 1 sem minha aprovação expressa.
Quando finalizar suba para https://github.com/corretoresdabahiacom-create/lifeflow.git

Contrato mestre de produto, arquitetura e engenharia

Produto: LifeFlow AI
Categoria: SaaS de gestão financeira pessoal, agenda, tarefas e assistente inteligente.
Público inicial: Individual.
Modelo comercial: Freemium + assinaturas.
Objetivo: Produto internacionalizável, seguro, escalável e com custo operacional controlado.

⸻

PARTE A — CONTRATO ARQUITETURAL OBRIGATÓRIO

Estas decisões são definitivas para a implementação inicial. Não escolha outras tecnologias sem apresentar justificativa e solicitar autorização.

A1. Infraestrutura

Frontend: React + TypeScript + Vite.
Hospedagem frontend: Cloudflare Pages.
Backend: Cloudflare Workers.
Banco de dados: Supabase PostgreSQL.
Autenticação: Supabase Auth.
Autorização dos dados: PostgreSQL RLS.
Armazenamento de arquivos: Cloudflare R2, somente quando necessário.
PWA: Web App Manifest + Service Worker.
Gerenciador de pacotes: pnpm.

A2. Contrato Cloudflare ↔ Supabase

Implementar a seguinte arquitetura:

O usuário autentica pelo Supabase Auth.
O frontend utiliza o SDK oficial do Supabase para manter e renovar a sessão.
O frontend encaminha o access token ao Cloudflare Worker pelo header Authorization.
O Worker valida criptograficamente o JWT, incluindo assinatura, emissor, audiência e expiração, usando as chaves públicas/JWKS do projeto quando aplicável.
O Worker encaminha o token original para o Supabase, utilizando a publishable key do projeto e o JWT do usuário.
As operações SQL executadas através da API autenticada devem respeitar a RLS.
O PostgreSQL identifica o usuário por auth.uid().
O Worker nunca deve confiar em user_id informado pelo frontend como prova de identidade.

Criar cliente Supabase por requisição, com Authorization Bearer do usuário autenticado.

Não utilizar service_role nas requisições normais dos usuários.

Não armazenar refresh tokens no Worker.

O Worker não será responsável pela renovação da sessão do usuário.

Se o token expirar, retornar resposta de autenticação adequada e permitir que o SDK do frontend atualize a sessão.

Criar testes comprovando que:

Usuário A não consulta registros do usuário B.
Usuário A não altera registros do usuário B.
Usuário A não exclui registros do usuário B.
A ausência de token não permite acesso.
Um JWT inválido não permite acesso.
A alteração manual do user_id não permite apropriação de registros.

Operações administrativas e processos agendados não devem introduzir um caminho genérico de bypass da RLS. Quando uma operação privilegiada for indispensável, utilizar função SQL restrita, com permissões mínimas, validação explícita de identidade ou contexto de sistema, search_path fixo e auditoria.

A3. Provedores definidos

Implementações iniciais:

LLM: DeepSeek API, modelo deepseek-flash.
Transcrição: Groq API, whisper-large-v3-turbo.
Pagamentos: Mercado Pago.
E-mail: Resend.
Push: Web Push com VAPID.
Hospedagem: Cloudflare.
Banco e autenticação: Supabase.

Criar adaptadores independentes para todos os provedores.

Não espalhar nomes, endpoints e modelos de provedores pelo código de negócio.

Criar interfaces como:

LLMProvider.
SpeechToTextProvider.
EmailProvider.
PaymentProvider.
PushProvider.

Cada implementação deverá poder ser substituída sem reconstruir os módulos de negócio.

O provedor e modelo de IA deverão ser configuráveis por ambiente e, quando autorizado, pelo administrador.

Credenciais somente em secrets do ambiente.

Nenhuma credencial real poderá aparecer no Git.

Não chamar APIs pagas sem configuração explícita e autorização de utilização.

A4. Integrações externas

Distinguir obrigatoriamente:

Não implementado.
Código implementado e testado com mocks.
Integrado, aguardando credenciais reais.
Integrado e validado em ambiente real.

Uma integração com mock não poderá ser apresentada como integração de produção.

Toda integração deverá possuir:

Interface.
Implementação.
Validação de entrada.
Tratamento de erros.
Timeout.
Retry controlado quando seguro.
Idempotência quando aplicável.
Testes de contrato.
Documentação de variáveis ENV.
Instruções de ativação.

A5. Princípio financeiro do projeto

A prioridade é investimento inicial zero ou próximo de zero.

Utilizar serviços gratuitos quando tecnicamente viáveis.

Não criar dependência de infraestrutura paga para executar o núcleo do aplicativo.

Implementar controle de consumo e impedir cobranças inesperadas.

Não prometer gratuidade permanente de nenhum fornecedor.

⸻

PARTE B — IDENTIDADE DO PRODUTO

O LifeFlow AI será um aplicativo individual que reúne:

Controle financeiro pessoal.
Agenda.
Compromissos.
Tarefas.
Lembretes.
Assistente pessoal por IA.
Entrada e resposta por voz.
Relatórios.
Aplicativo PWA.
Assinaturas SaaS.

A experiência deve permitir que o usuário execute operações pela interface e por linguagem natural.

Exemplos:

“Registrei R$ 75 no supermercado.”

“Quais são meus compromissos de amanhã?”

“Marque dentista para sexta-feira às 15h.”

“Quais contas vencem nesta semana?”

“Organize minhas tarefas de hoje.”

“Quanto posso gastar até o final do mês?”

A IA deve ser capaz de consultar e executar operações reais, respeitando permissões e confirmações.

PARTE C — DESIGN E EXPERIÊNCIA

Criar produto visual premium.

Diretrizes:

Design moderno e minimalista.
Interface responsiva.
Tema claro e escuro.
Tipografia consistente.
Componentes reutilizáveis.
Acessibilidade.
Navegação intuitiva.
Feedback visual.
Estados de carregamento, erro, vazio e sucesso.

Mobile:

Navegação inferior.
Dashboard adaptado.
Acesso rápido à IA.
Registro rápido de despesas.
Criação rápida de compromissos.

Desktop:

Menu lateral.
Dashboard configurável.
Calendário completo.
Painel financeiro.
Assistente acessível.

O usuário poderá reorganizar os cartões do dashboard e personalizar suas preferências.

PARTE D — FUNCIONALIDADES

D1. Dashboard

Apresentar:

Saldo total.
Receitas do mês.
Despesas do mês.
Resultado mensal.
Contas a vencer.
Contas atrasadas.
Próximos compromissos.
Tarefas pendentes.
Gráficos financeiros.
Resumo da agenda.
Alertas inteligentes.

Todos os números devem vir do banco de dados.

Separar valores realizados de valores previstos.

D2. Gestão financeira básica

Contas:

Conta corrente.
Poupança.
Dinheiro.
Carteira digital.
Outras contas.

Receitas:

Salário.
Trabalho.
Serviços.
Rendimentos.
Outras receitas.

Despesas:

Alimentação.
Moradia.
Transporte.
Saúde.
Educação.
Lazer.
Compras.
Contas domésticas.
Assinaturas.
Outras despesas.

Operações:

Criar.
Consultar.
Editar.
Excluir com confirmação.
Filtrar.
Pesquisar.
Exportar.

Transferências:

Conta de origem.
Conta de destino.
Valor.
Data.
Histórico.
Estorno.

Transferências próprias não são receitas nem despesas.

Implementar consistência transacional.

D3. Contas a pagar e receber

Campos:

Descrição.
Valor.
Categoria.
Vencimento.
Conta.
Recorrência.
Status.

Status:

Pendente.
Pago.
Recebido.
Atrasado.
Cancelado.

A baixa financeira deverá ser atômica e idempotente.

Impedir lançamentos duplicados.

D4. Agenda

Criar:

Visualização diária.
Visualização semanal.
Visualização mensal.
Lista de eventos.

Eventos:

Pessoais.
Profissionais.
Médicos.
Familiares.
Reuniões.
Viagens.
Outros.

Campos:

Título.
Descrição.
Data.
Horário.
Duração.
Fuso horário.
Local.
Contato.
Link.
Observações.
Recorrência.
Lembretes.

Detectar conflitos de horários.

Não impedir automaticamente eventos sobrepostos.

Recorrências:

Diária.
Semanal.
Mensal.
Anual.
Personalizada.

Permitir editar:

Uma ocorrência.
Esta e as próximas.
Toda a série.

D5. Tarefas

Campos:

Título.
Descrição.
Prioridade.
Categoria.
Prazo.
Horário.
Status.
Lembrete.

Prioridades:

Baixa.
Média.
Alta.
Urgente.

Status:

Pendente.
Em andamento.
Concluída.
Cancelada.

Criar filtros e visualização de tarefas atrasadas.

D6. Integração entre agenda e finanças

Um vencimento financeiro poderá gerar lembrete de agenda sem duplicar a operação financeira.

Um evento poderá conter custo previsto.

O custo previsto não será registrado como despesa efetiva automaticamente.

Quando houver pagamento, permitir gerar uma despesa vinculada.

D7. Relatórios

Financeiros:

Receitas.
Despesas.
Categorias.
Evolução de saldo.
Comparações mensais.
Contas pendentes.

Produtividade:

Compromissos.
Tarefas concluídas.
Tarefas atrasadas.
Distribuição semanal.

Exportação CSV e calendário ICS.

⸻

PARTE E — INTELIGÊNCIA ARTIFICIAL

E1. Arquitetura

Criar:

Camada independente de provedor.
Chat.
Gerenciamento de contexto.
Tool calling.
Validação estruturada.
Limites por plano.
Auditoria.
Controle de custos.
Tratamento de erros.

A IA não possui acesso direto ao SQL.

Toda operação ocorre por ferramentas do backend.

E2. Ferramentas

Financeiro:

get_accounts
get_balance
create_transaction
update_transaction
delete_transaction
list_transactions
get_financial_summary
list_payments
mark_payment_as_paid
list_categories

Agenda:

create_event
update_event
delete_event
list_events
check_schedule_conflicts

Tarefas:

create_task
update_task
complete_task
delete_task
list_tasks

Lembretes:

create_reminder
update_reminder
list_reminders

E3. Confirmação

Consultas podem ser executadas diretamente.

Criações poderão seguir preferência configurável de confirmação.

Exclusões financeiras sempre exigem confirmação explícita.

Alterações relevantes devem apresentar resumo antes da execução.

Não executar pagamentos bancários ou transferências bancárias reais na primeira versão.

E4. Proteção financeira da IA

Implementar:

Idempotency keys.
Detecção de lançamentos potencialmente duplicados.
Limite de ações automáticas por período.
Limite de valor acumulado configurável.
Confirmação reforçada para valores superiores ao limite do usuário.
Histórico completo das ações.
Possibilidade de estorno ou reversão auditável.
Identificação da origem de cada lançamento.
Prevenção contra execução repetida após timeout.
Registro do resultado confirmado pelo backend.

Uma operação financeira só pode ser considerada concluída após confirmação do banco.

A IA não poderá modificar parâmetros de uma operação após a confirmação do usuário.

E5. Voz

Implementar:

Gravação.
Transcrição.
Interpretação.
Resposta textual.
Resposta em áudio opcional.

A transcrição deverá possuir limite de duração e tamanho.

Não manter gravações desnecessariamente.

Solicitar consentimento para processamento de áudio.

PARTE F — PWA E NOTIFICAÇÕES

Implementar:

Manifest.
Service Worker.
Ícones.
Instalação.
Atualizações.
Página offline.
Push.
Central de notificações.

Notificações:

Vencimentos.
Compromissos.
Tarefas.
Resumos.
Alertas relevantes.

Respeitar preferências e horários silenciosos.

Não armazenar dados financeiros sensíveis no cache.

Usar cache apenas para arquivos estáticos e informações explicitamente seguras.

Respostas autenticadas e pessoais devem utilizar políticas de cache privadas e não compartilhadas.

PARTE G — BANCO DE DADOS

Criar migrations versionadas.

Tabelas principais:

profiles
accounts
categories
transactions
transfers
recurring_transactions
financial_reminders
events
event_reminders
tasks
task_categories
ai_conversations
ai_messages
ai_action_logs
notifications
push_subscriptions
user_preferences
plans
subscriptions
payments
usage_records
audit_logs

Todas as tabelas pessoais deverão possuir isolamento por usuário.

Utilizar:

UUID.
Foreign keys.
Constraints.
Índices.
Timestamps.
Políticas RLS.
Validação de integridade.

As políticas devem ser específicas para SELECT, INSERT, UPDATE e DELETE.

Não utilizar políticas genéricas permissivas.

Não confiar em user_id enviado pelo cliente.

Criar testes negativos de isolamento.

PARTE H — PLANOS COMERCIAIS

Preços iniciais sugeridos:

Free: R$ 0.
Pro: R$ 14,90/mês.
Premium AI: R$ 29,90/mês.

Preços configuráveis.

Limites iniciais:

FREE:

Movimentações ilimitadas.
Agenda ilimitada.
Tarefas ilimitadas.
30 mensagens de IA por mês.
Sem transcrição por voz.
Relatórios básicos.

PRO:

Movimentações ilimitadas.
Agenda ilimitada.
Tarefas ilimitadas.
300 mensagens de IA por mês.
30 minutos de voz por mês.
Relatórios completos.

PREMIUM AI:

Movimentações ilimitadas.
Agenda ilimitada.
Tarefas ilimitadas.
1.000 mensagens de IA por mês.
120 minutos de voz por mês.
Relatórios inteligentes.

Todos os limites deverão estar armazenados em configuração comercial no banco.

Implementar controle efetivo no backend.

Não confiar em limites calculados apenas no frontend.

Criar:

Assinaturas.
Checkout.
Renovação.
Cancelamento.
Webhooks.
Histórico de cobrança.
Controle de inadimplência.
Períodos de teste quando suportados.

Não armazenar cartões.

PARTE I — ADMINISTRAÇÃO

Criar painel administrativo separado.

Indicadores:

Usuários.
Atividade.
Assinaturas.
Receita recorrente.
Cancelamentos.
Utilização da IA.
Custos.
Erros.
Notificações.

Permitir:

Configurar planos.
Configurar limites.
Consultar assinaturas.
Consultar consumo.
Gerenciar integrações.
Gerenciar configurações.
Consultar logs.

O administrador não possui acesso automático ao conteúdo financeiro dos clientes.

Implementar autorização administrativa no servidor e auditoria.

PARTE J — LGPD E PRIVACIDADE

Implementar:

Política de privacidade.
Termos de uso.
Consentimentos necessários.
Transparência no processamento por IA.
Minimização de dados.
Exportação.
Correção.
Exclusão de conta.
Gestão de sessões.
Registro de solicitações.
Retenção definida por categoria de dados.

Criar fluxo de exclusão de conta com:

Confirmação do usuário.
Revogação de sessões.
Cancelamento ou tratamento das assinaturas conforme regras aplicáveis.
Exclusão ou anonimização dos dados conforme obrigações legais.
Tratamento de backups e prazos de retenção.
Registro auditável da solicitação.

Não afirmar conformidade legal sem revisão jurídica e operacional.

PARTE K — OPERAÇÃO E OBSERVABILIDADE

K1. CI/CD

Utilizar GitHub Actions.

Criar pipelines para:

Instalação de dependências.
Lint.
Typecheck.
Testes.
Build.
Verificação de migrations.
Deploy controlado.

Separar ambientes:

Desenvolvimento.
Staging.
Produção.

Não fazer deploy automático em produção com testes críticos falhando.

K2. Observabilidade

Implementar:

Logs estruturados.
Identificadores de requisição.
Tratamento centralizado de erros.
Métricas de API.
Latência.
Falhas de integração.
Consumo de IA.

Utilizar recursos de observabilidade do Cloudflare e, opcionalmente, integração com Sentry ou alternativa compatível.

Nunca registrar tokens, senhas, conteúdo financeiro ou áudio em logs desnecessários.

K3. Backup e recuperação

Documentar:

Backup do PostgreSQL.
Exportação periódica.
Restauração.
Testes de restauração.
Retenção.
Responsabilidades.

Não presumir que o plano gratuito possui backup automático suficiente.

Não considerar um backup válido sem testar restauração.

K4. Controle de custos

Criar COSTS.md.

Monitorar:

Cloudflare.
Supabase.
LLM.
Transcrição.
E-mail.
Armazenamento.
Pagamentos.

Criar métricas por usuário e por plano.

Implementar limites de consumo, alertas e proteção contra abuso.

Nunca permitir consumo ilimitado de APIs pagas por conta de usuário.

PARTE L — SEGURANÇA

Implementar:

JWT.
RLS.
Autorização.
Validação.
Rate limiting.
Proteção XSS.
Proteção CSRF quando aplicável.
Proteção SQL injection.
Secrets.
Auditoria.
Gestão de sessão.
Proteção de endpoints administrativos.
Proteção contra prompt injection.

Não expor credenciais administrativas.

Não armazenar secrets no frontend.

Não usar dados financeiros em prompts sem necessidade.

PARTE M — DEFINIÇÃO DE PRONTO POR FASE

Nenhuma fase poderá ser considerada concluída somente por avaliação subjetiva do modelo.

FASE 1 — FUNDAÇÃO

Artefatos:

Frontend funcional.
Worker funcional.
Configuração Supabase.
Migrations iniciais.
Políticas RLS.
Autenticação.
Layout.
PWA básica.
Testes de autenticação e isolamento.
Documentação inicial.

Testes obrigatórios:

pnpm lint.
pnpm typecheck.
pnpm test.
pnpm build.
Testes de RLS negativos.

Checklist manual:

Criar usuário A.
Criar usuário B.
Autenticar ambos.
Criar registros privados.
Tentar acessar os registros cruzados.
Confirmar bloqueio.
Confirmar que o logout impede o acesso.

Não iniciar a Fase 2 sem aprovação.

FASE 2 — FINANCEIRO

Artefatos:

CRUD financeiro.
Contas.
Categorias.
Receitas.
Despesas.
Transferências.
Recorrências.
Relatórios.
Exportação.

Testes obrigatórios:

Consistência dos saldos.
Transferência atômica.
Idempotência.
Prevenção de duplicidade.
Baixa de contas.
Isolamento RLS.

Checklist:

Criar duas contas.
Registrar receita.
Registrar despesa.
Transferir dinheiro.
Verificar saldos.
Repetir requisição com mesma chave idempotente.
Confirmar ausência de duplicidade.

FASE 3 — AGENDA

Artefatos:

Calendário.
Eventos.
Tarefas.
Recorrências.
Lembretes.
Notificações.

Testes obrigatórios:

Criar evento.
Editar.
Excluir.
Recorrência.
Fuso horário.
Detecção de conflitos.
Idempotência dos lembretes.

Checklist:

Criar eventos sobrepostos.
Confirmar alerta.
Criar evento recorrente.
Editar apenas uma ocorrência.
Confirmar que as demais permanecem corretas.

FASE 4 — IA

Artefatos:

Chat.
Provider adapter.
Tool calling.
Contexto.
Voz.
Confirmações.
Auditoria.
Controle de consumo.

Testes obrigatórios:

Interpretação de comando.
Ferramenta autorizada.
Ferramenta não autorizada.
Duplicidade.
Confirmação.
Prompt injection.
Isolamento de dados.
Falha do provedor.

Checklist:

Solicitar registro de despesa.
Conferir os dados.
Confirmar.
Verificar registro no banco.
Repetir a solicitação.
Confirmar prevenção de duplicidade.

FASE 5 — SaaS

Artefatos:

Planos.
Limites.
Assinaturas.
Pagamentos.
Webhooks.
Painel administrativo.
Métricas.

Testes obrigatórios:

Criação de assinatura.
Webhook válido.
Webhook inválido.
Idempotência.
Mudança de plano.
Cancelamento.
Limites de utilização.

Checklist:

Criar assinatura em ambiente de teste.
Processar webhook.
Confirmar alteração do plano.
Testar limite do plano.
Confirmar bloqueio de utilização excedente.

FASE 6 — LANÇAMENTO

Artefatos:

Auditoria.
Testes.
Documentação.
Deploy.
Backup.
Monitoramento.
Checklist de produção.

Testes obrigatórios:

Build.
Lint.
Typecheck.
Testes unitários.
Testes de integração.
Testes de segurança.
Testes de isolamento.
Testes de recuperação.

Checklist:

Cadastro.
Login.
Operações financeiras.
Agenda.
IA.
Assinaturas.
PWA.
Mobile.
Exportação.
Exclusão de conta.
Restauração de backup.

Regra sobre testes

Os testes indicados como obrigatórios são critérios mínimos de aprovação.

Testes desejáveis devem ser identificados separadamente.

Não criar relatórios que afirmem testes executados quando apenas os arquivos de teste foram escritos.

Apresentar comandos e resultados reais.

⸻

PARTE N — REGRAS DE INSPEÇÃO E PROTEÇÃO DO REPOSITÓRIO

Antes de modificar qualquer projeto:

Inspecionar arquivos.
Inspecionar package.json.
Identificar framework.
Identificar dependências.
Inspecionar migrations.
Inspecionar configurações.
Identificar funcionalidades existentes.
Identificar riscos de sobrescrita.

Se o repositório estiver vazio:

Apresentar relatório.
Sugerir estrutura.
Aguardar autorização para inicializar.

Se a stack existente for incompatível:

Não substituir automaticamente.
Apresentar comparação.
Explicar o custo de migração.
Aguardar autorização.

Se a estrutura for compatível:

Reaproveitar.
Corrigir.
Evoluir incrementalmente.

Criar backup ou branch antes de modificações estruturais relevantes.

Não excluir dados ou migrations existentes sem autorização.

⸻

PARTE O — DOCUMENTAÇÃO PERMANENTE

Criar e manter:

MASTER_PROMPT.md
PHASE_01_FOUNDATION.md
PHASE_02_FINANCE.md
PHASE_03_AGENDA.md
PHASE_04_AI.md
PHASE_05_SAAS.md
PHASE_06_LAUNCH.md
ARCHITECTURE.md
SECURITY.md
DATABASE.md
DECISIONS.md
TESTING.md
DEPLOYMENT.md
ENVIRONMENT.md
API.md
COSTS.md
CHANGELOG.md

As decisões arquiteturais devem ser registradas em DECISIONS.md.

Não alterar decisões fundamentais sem documentar:

Problema.
Alternativas.
Justificativa.
Impacto.
Aprovação.

⸻

PARTE P — REGRAS DE EXECUÇÃO DO CLAUDE CODE

Este documento é o contrato permanente do produto.

Não executar todas as fases ao receber o MASTER_PROMPT.md.

Cada fase será iniciada exclusivamente pelo respectivo arquivo de execução.

O Claude Code deverá:

Ler o MASTER_PROMPT.md.
Ler o arquivo da fase solicitada.
Verificar as dependências das fases anteriores.
Inspecionar o código relacionado.
Implementar exclusivamente o escopo autorizado.
Executar os testes obrigatórios.
Corrigir os erros encontrados.
Atualizar a documentação.
Registrar o resultado.
Parar ao atingir os critérios de conclusão.

Não iniciar outra fase automaticamente.

Não declarar conclusão sem evidências.

Não esconder limitações.

Não inventar credenciais.

Não simular integrações reais.

O objetivo é construir um SaaS funcional, seguro, comercializável e sustentável, priorizando confiabilidade e baixo custo operacional.