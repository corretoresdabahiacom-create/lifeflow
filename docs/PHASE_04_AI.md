# FASE 4 — ASSISTENTE DE IA

**Status:** implementada; **aguardando aprovação do responsável**. A Fase 5 não foi iniciada. A Fase 3 também
segue **aguardando aprovação** (o responsável disse que a aprovará depois).
Comandos obrigatórios e testes automatizados aprovados, inclusive no emulador real do Firestore com as regras reais (CI).
**Nenhuma chamada real ao DeepSeek ou à Groq foi feita** (não há chaves nem projeto Firebase real): os adaptadores
foram testados só com `fetch` simulado, e o fluxo do assistente com um modelo simulado que segue um roteiro.
O checklist manual no navegador **não foi executado**. Decisões: `DECISIONS.md` D-008.

## O que foi entregue

| Item do contrato | Onde | Estado |
|---|---|---|
| Chat com histórico de conversas (listar, abrir, continuar, apagar) | `workers/api/src/ai/engine.ts`, `routes.ts`; `apps/web/src/pages/assistant/AssistantPage.tsx` | Implementado e testado |
| Provider adapter (LLM e transcrição independentes de provedor) | `workers/api/src/ai/providers/` | Implementado; testado só com mocks |
| LLM DeepSeek `deepseek-flash` | `providers/deepseek.ts` | Implementado; **não** testado contra a API real |
| Transcrição Groq `whisper-large-v3-turbo` | `providers/groq.ts` | Implementado; **não** testado contra a API real |
| Tool calling: 23 ferramentas (contas, saldo, lançamentos, resumo, contas a pagar, categorias, eventos, conflitos, tarefas, lembretes) | `ai/tools.ts` | Implementado e testado |
| Confirmação antes de gravar; confirmação reforçada acima do limite do usuário | `ai/engine.ts`, `routes.ts`, `ActionCard.tsx` | Implementado e testado |
| Limites de automação do usuário (ações/dia, valor/dia, confirmação reforçada) | `AiSettingsSchema`, `PUT /v1/ai/settings`, `AssistantSettings.tsx` | Implementado e testado |
| Auditoria de ações da IA (trilha só de inclusão) e histórico na tela | coleção `aiLogs`, `GET /v1/ai/history` | Implementado e testado |
| Controle de consumo por plano (mensagens e minutos de voz) | `ai/store.ts`, `GET /v1/ai/usage` | Implementado e testado (a partir da Fase 5 o plano vem da assinatura do usuário) |
| Voz com consentimento explícito, sem guardar o áudio | `POST /v1/ai/transcribe`, `VoiceButton.tsx` | Implementado e testado com STT simulado |
| Origem "IA" nos lançamentos | campo `origin`/`aiActionId`, selo "IA" em `TransactionsPage.tsx` | Implementado e testado |
| Regras do Firestore das novas coleções | `firebase/firestore.rules`, `firebase/tests/ai.rules.test.ts` | Escritas; **só rodam na CI** |

## Como as garantias foram obtidas

- **A IA nunca grava direto.** O modelo só *propõe*: cada chamada de ferramenta de escrita vira um documento
  `aiActions` com os parâmetros **congelados** (`argsJson` + `argsHash`), um resumo montado **pelo backend** e
  validade de 15 min. Quem executa é `POST /v1/ai/actions/{id}/confirm`, que **não aceita parâmetros** (corpo só
  `{reinforced?}`); a execução reaproveita as mesmas rotas internas do app (mesmas validações, idempotência,
  duplicidade e atomicidade), com `Idempotency-Key = ai-<actionId>`.
- **Ferramenta não autorizada:** o nome precisa estar no registro de 23 ferramentas; qualquer outro é recusado e
  auditado (`unauthorized_tool`). Parâmetros passam por schema `strict` (`uid`, `allowDuplicate` e campos extras
  são recusados). Ids de outro usuário são tratados como inexistentes.
- **Prompt injection:** tudo o que uma ferramenta devolve (títulos de eventos, descrições, etc.) vai ao modelo
  marcado como **DADOS não confiáveis**, truncado (6000 caracteres) e sem campos internos. Mesmo que o modelo
  "obedeça" um texto malicioso, o pior caso é uma **ação pendente** que o usuário vê e pode recusar; nesse turno a
  execução automática é desligada (taint). Estorno, baixa, edição e exclusão **sempre** pedem confirmação.
- **Duplicidade:** a criação de lançamento reaproveita a checagem da Fase 2 já na proposta (bloqueia sem pedir
  confirmação) e de novo na execução; mensagem reenviada com a mesma `Idempotency-Key` devolve a mesma resposta,
  sem novo consumo e sem nova ação; confirmar duas vezes executa uma só.
- **Consumo:** contadores mensais e diários por incremento atômico; plano gratuito = 30 mensagens/mês e sem voz;
  Pro 300 mensagens e 30 min; Premium IA 1000 e 120 min. Falha do provedor **não** consome.
- **Voz:** consentimento em `users/{uid}/consents/audio`; sem ele o áudio nem é lido. Áudio ≤ 1,5 MB e ≤ 60 s,
  tipos permitidos; cobrança mínima de 10 s; o áudio é repassado ao provedor e descartado (nada é gravado).
- **Isolamento:** caminhos derivados do `uid` do token; regras por dono; ids validados.

## Resultados reais

Node 22, pnpm 9.15.0, executados nesta sessão.

| Comando | Resultado |
|---|---|
| `pnpm lint` | sem erros |
| `pnpm typecheck` | sem erros |
| `pnpm test` | **354 testes**: shared 97, web 70, api 187 (inclui 53 do assistente no Firestore falso e 10 dos adaptadores) |
| `pnpm build` | web ok; Worker `wrangler deploy --dry-run` ok |

**Emulador real e regras (somente na CI):** `pnpm test:rules` (inclui 18 testes novos de `ai.rules.test.ts`) e
`pnpm test:integration` (suíte do assistente no emulador real, menos 1 teste marcado como "somente falso").

### CI (emulador real)

Primeira execução (`43154788895`, commit `11aefc0`): job de lint/typecheck/test/build verde; **o job do emulador
falhou**: o teste novo de regras mostrou que o consentimento de áudio podia ser excluído (a regra estava `isOwner`,
a intenção era negar). Corrigi a regra para `false`. Execução seguinte (`43154951563`, `develop`): **ambos os jobs verdes**:

| Suíte | Resultado |
|---|---|
| `pnpm test:rules` | **131 testes** (113 anteriores + 18 de `ai.rules.test.ts`) |
| `pnpm test:integration` | **127 aprovados, 1 ignorado de propósito** (o teste "somente falso" de hash adulterado) = 75 anteriores + 53 do assistente |
| lint, typecheck, test, build | verdes (shared 97, web 70, api 187) |

### Mapa dos testes obrigatórios (`workers/api/test/ai.suite.ts`, salvo indicação)

| Teste obrigatório | Testes |
|---|---|
| Interpretação de comando | "checklist: pede para registrar uma despesa…"; agenda, tarefas, lembretes, saldo, consulta; "o prompt de sistema traz a data e o fuso…" |
| Ferramenta autorizada / não autorizada | "ferramenta NÃO autorizada (inventada pelo modelo)…"; "parâmetros fora do formato…"; "limite de rodadas…" |
| Duplicidade | "checklist: repetir a solicitação não cria lançamento duplicado"; "duplicidade com lançamento manual…"; "a mesma mensagem reenviada (mesma Idempotency-Key)…"; "confirmar duas vezes…" |
| Confirmação | pendente até confirmar; recusar; expirar (410); "a confirmação não aceita parâmetros"; hash adulterado (só falso); reforçada; estorno/baixa sempre confirmam; limites de automação (3) |
| Prompt injection | 3 testes "INJEÇÃO: …" (título de evento, taint da automação, descrição de lançamento) |
| Isolamento | "identificador de OUTRO usuário…"; "o usuário B não consegue confirmar…"; "isolamento: B não vê…"; consentimento por usuário; regras: `ai.rules.test.ts` |
| Falha do provedor | "falha do provedor: erro claro, nada é gravado nem cobrado…"; "mapeia os demais erros…"; "falha… no meio de um fluxo…"; adaptadores: `ai.providers.test.ts` (10) |
| Consumo / planos | "plano gratuito: 30 mensagens…" (renova no mês seguinte); Pro; voz: limite mensal |
| Voz | consentimento exigido, plano sem voz, transcreve e cobra 10 s mínimo, validações, falha não cobra, revogação |
| Front | `AssistantPage.test.tsx` (12), `api.test.ts` (confirmação sem parâmetros; áudio cru) |

## Checklist da fase

| Item | Estado |
|---|---|
| Solicitar registro de despesa | **Automatizado** ("checklist: pede para registrar uma despesa…") com modelo simulado |
| Conferir dados (resumo montado pelo backend) | **Automatizado** (valor, conta, descrição no resumo) e tela do cartão de confirmação testada |
| Confirmar | **Automatizado**: só grava após confirmar; origem "ai"; saldo atualizado |
| Verificar no banco | **Automatizado** no Firestore falso e (CI) no emulador real; **não** verificado em Firestore real |
| Repetir solicitação / prevenção de duplicidade | **Automatizado** ("checklist: repetir a solicitação…") |
| Fluxo com DeepSeek/Groq reais, no navegador | **Não executado** (sem chaves e sem projeto Firebase real) |

## Como ligar de verdade (quando houver chaves)

`wrangler secret put DEEPSEEK_API_KEY` e `GROQ_API_KEY`; opcionais `LLM_MODEL`, `STT_MODEL`
(ver `ENVIRONMENT.md`). Sem chaves o assistente responde `503 ai_not_configured` (mensagem clara na tela).

## Limites e pendências (honestos)

- **Adaptadores nunca falaram com as APIs reais.** Formato do pedido/resposta conferido na documentação oficial e
  em testes com `fetch` simulado; comportamento real (limites, erros, qualidade em português) não foi observado.
  O modelo `deepseek-flash` foi confirmado na documentação em 2026-11-11.
- **Qualidade do modelo não avaliada:** os testes usam um modelo simulado, então provam o backend e suas travas,
  não que o DeepSeek escolhe a ferramenta certa. Recomenda-se uma bateria de frases reais antes do lançamento.
- **Plano por usuário** passou a vir da assinatura na Fase 5 (`AI_DEFAULT_PLAN` foi removida); ver `PHASE_05_SAAS.md`.
- **Cota lê e depois incrementa:** sob requisições simultâneas pode haver pequeno excesso do limite mensal.
- **Queda entre executar e marcar a ação:** raro; para operações sem idempotência natural (estorno, baixa) a ação
  pode aparecer como "falhou" na repetição, mas o dado não é duplicado (as rotas internas são idempotentes/estado).
- **Apagar uma conversa remove o texto, mas mantém `aiActions` e `aiLogs`** (trilha de auditoria); ver `SECURITY.md`.
- **Regras do Firestore e emulador:** só validados na CI. Índices não validados em projeto real.
- **Sem Web Push nem agendador** (Fase 3), sem projeto Firebase real, `main` ainda sem proteção.
- Autoexecução com confirmação desligada vale para **criações** dentro dos limites; o usuário controla em Ajustes
  ("confirmar criações") e em Assistente → limites.
