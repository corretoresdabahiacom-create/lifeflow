# FASE 1 — FUNDAÇÃO

**Status:** implementada; **aguardando aprovação do responsável**. Há itens obrigatórios **não
executados** (ver "Pendências para fechar a fase"). A Fase 2 não foi iniciada.

Adaptação aprovada: Supabase → Firebase (Firestore + Firebase Auth), ver `DECISIONS.md` D-004.
Onde o contrato diz "migrations" e "RLS", leia "regras e índices versionados" e "Security Rules".

## Artefatos

| Artefato | Onde | Estado |
|---|---|---|
| Frontend (React + TS + Vite) | `apps/web` | Implementado; build ok |
| Worker (Cloudflare) | `workers/api` | Implementado; testado com mocks; build (dry-run) ok |
| Configuração Firebase | `firebase/` (`firebase.json`, `.firebaserc` com `demo-lifeflow`) | Escrita; sem projeto real |
| "Migrations" iniciais | `firebase/firestore.rules`, `firestore.indexes.json` | Escritas |
| Políticas de segurança (RLS) | `firebase/firestore.rules` (get/list/create/update/delete separados) | Escritas; **não executadas** localmente |
| Autenticação | e-mail/senha pelo SDK; JWT validado no Worker | Código implementado; sem projeto Firebase real |
| Layout | menu lateral (desktop), navegação inferior (mobile), tema claro/escuro, estados de carregamento/erro/vazio | Implementado |
| PWA básica | `manifest.webmanifest`, `sw.js`, `offline.html`, ícones, instalação, aviso de atualização | Implementada; ver limites abaixo |
| Testes de autenticação e isolamento | `workers/api/test`, `firebase/tests`, `apps/web/src/**` | Ver resultados |
| Documentação inicial | `docs/` | Atualizada |

### Endpoints do Worker

`GET /healthz` (público) · `GET /v1/me` · `GET|PUT /v1/profile` · `GET|PUT|DELETE /v1/preferences`.
Nenhum endpoint recebe `uid`: a identidade vem somente do token validado.

## Resultados reais dos comandos obrigatórios

Executados em `develop`, Node 22.23.4, pnpm 9.15.0, com o código de saída capturado de cada comando:

| Comando | Código de saída | Resultado |
|---|---|---|
| `pnpm lint` | 0 | sem erros |
| `pnpm typecheck` | 0 | 4 pacotes sem erros (`firebase`, `shared`, `web`, `api`) |
| `pnpm test` | 0 | **57 testes passaram**: shared 6, web 17, api 34 |
| `pnpm build` | 0 | web: build Vite ok (JS 410 kB, 108 kB gzip); Worker: `wrangler deploy --dry-run` ok, 182,54 KiB (34,22 KiB gzip) |
| `pnpm test:rules` (RLS negativos) | **não executado** | ver abaixo |

### Isolamento e autenticação no Worker (com mocks)

Testados em `workers/api/test/app.test.ts` (Firestore simulado em memória; chaves RSA geradas no teste):

- sem token, cabeçalho malformado, texto aleatório como JWT → 401 e **o Firestore não é chamado**;
- assinatura de outra chave, token expirado, audiência errada, emissor errado, token sem `sub`,
  algoritmo HS256 e algoritmo `none` → 401;
- o token original do usuário é repassado ao Firestore; não existe credencial de serviço;
- usuário A com `?uid=userB`, `X-User-Id: userB` ou `uid` no corpo → o Worker só toca em
  `users/userA` (corpo com `uid` é rejeitado com 400 e nada é gravado);
- DELETE de preferências atinge só o documento do autenticado;
- 403/401 do Firestore são repassados; leitura repete 1 vez em falha transitória; **escrita não é
  repetida**; falha de rede vira 504 sem vazar detalhes;
- respostas com `Cache-Control: private, no-store`; CORS só para a origem configurada;
- logs não contêm token nem conteúdo do corpo.

Isto prova o comportamento do **Worker**. A prova de que o **Firestore** bloqueia o acesso cruzado
depende dos testes de regras abaixo.

### Testes de regras (o equivalente dos testes de RLS)

`firebase/tests/firestore.rules.test.ts` cobre: sem autenticação; A nos próprios dados; A contra
get/list/update/delete/create nos dados de B; troca manual de `uid`; campos desconhecidos e tipos
inválidos; exclusão do próprio perfil negada; coleções não declaradas negadas.

**Não foram executados neste ambiente.** O emulador do Firestore é um `.jar` baixado de
`storage.googleapis.com`, domínio bloqueado pela rede desta sessão (erro 403 do proxy). Os arquivos
passam em `typecheck` e `lint`, mas **isso não conta como teste executado**. A CI do GitHub
(`.github/workflows/ci.yml`, job `firestore-rules`) executa `pnpm test:rules` com o emulador; o
resultado da primeira execução deve ser registrado aqui.

Para rodar localmente (máquina com acesso à internet e Java 17+):

```
pnpm install
pnpm test:rules
```

### Verificação visual

Tela de login conferida em Chrome headless: mobile (390 px, tema claro) e desktop (1280 px, tema
escuro). **As telas autenticadas (painel, ajustes, navegação) não foram verificadas visualmente**,
porque exigem um projeto Firebase ou o emulador de Auth.

## Checklist manual — NÃO executado

Exige um projeto Firebase real (ou emuladores) e o Worker rodando; não havia ambiente disponível.

- [ ] Criar usuário A
- [ ] Criar usuário B
- [ ] Autenticar ambos
- [ ] Criar registros privados
- [ ] Tentar acessar os registros cruzados
- [ ] Confirmar bloqueio
- [ ] Confirmar que o logout impede o acesso

O que existe de evidência automatizada para o último item: `ProtectedRoute` redireciona ao login sem
sessão (teste de componente) e o Worker responde 401 sem token válido.

Roteiro para executar com emuladores (`demo-lifeflow`):

1. `pnpm --filter @lifeflow/firebase-rules emulators` (Auth 9099, Firestore 8080).
2. `workers/api/.dev.vars`: `FIRESTORE_BASE_URL=http://127.0.0.1:8080` e
   `JWKS_URL` apontando para um JWKS compatível com o emulador (o emulador de Auth assina tokens sem
   verificação; para o teste manual completo é necessário um projeto Firebase real).
3. `apps/web/.env.local` com `VITE_USE_EMULATORS=true` e `VITE_API_BASE_URL` do Worker.

> Observação honesta: o Worker valida a assinatura RS256 com as chaves do Google. Tokens do emulador de
> Auth **não** têm assinatura verificável, então o fluxo ponta a ponta de login → Worker exige um
> projeto Firebase real (plano gratuito). O isolamento pelas regras pode ser provado só com o emulador
> do Firestore (`pnpm test:rules`).

## Limites conhecidos da PWA

- Service worker só é registrado em produção; guarda apenas arquivos estáticos do mesmo domínio e
  ignora API, `Authorization` e outras origens (nenhum dado pessoal em cache).
- Push, central de notificações e sincronização offline **não** fazem parte da Fase 1 (Fase 3).
- Instalação e atualização foram implementadas, mas **não testadas em dispositivo real**.
- A CSP em `public/_headers` usa `https://*.workers.dev` como origem provisória da API; ajustar no deploy.

## Pendências para fechar a fase

1. Executar `pnpm test:rules` (local ou CI) e registrar o resultado.
2. Criar o projeto Firebase (ou dois: staging e produção) e executar o checklist manual.
3. Ativar a proteção da branch `main` no GitHub.
4. Decidir sobre o Firestore vs. Data Connect antes da Fase 2 (D-004).

## Fora do escopo da Fase 1 (não implementado)

Rate limiting, auditoria (`audit_logs`), painel admin, provedores (LLM, voz, e-mail, pagamentos, push),
financeiro, agenda, tarefas, IA, assinaturas.
