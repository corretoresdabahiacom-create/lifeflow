# API

Worker em `workers/api`. Rotas autenticadas exigem `Authorization: Bearer <ID token do Firebase>`.
Token ausente, inválido ou expirado → `401` com `WWW-Authenticate: Bearer error="invalid_token"`;
o SDK do frontend renova a sessão e o cliente repete a requisição uma vez.

Todas as respostas têm `X-Request-Id`, `Cache-Control: private, no-store` e `X-Content-Type-Options: nosniff`.
Erros: `{ "error": { "code", "message", "requestId" } }`.

| Método e rota | Descrição | Corpo |
|---|---|---|
| `GET /healthz` | Saúde (sem autenticação) | — |
| `GET /v1/me` | `uid` e e-mail do token | — |
| `GET /v1/profile` | Perfil; `404` se ainda não existe | — |
| `PUT /v1/profile` | Cria ou atualiza o perfil | `displayName`, `locale`, `timezone`, `currency` |
| `GET /v1/preferences` | Preferências ou padrões (`stored: false`) | — |
| `PUT /v1/preferences` | Salva preferências | `theme`, `confirmCreations`, `quietHoursStart`, `quietHoursEnd` |
| `DELETE /v1/preferences` | Remove as preferências (`204`) | — |

Regras gerais:

- Corpos são validados por schemas `strict` (`packages/shared`): campos desconhecidos, incluindo `uid`,
  retornam `400`. Limite de 16 KB (`413`).
- O `uid` nunca é aceito do cliente; os caminhos do Firestore são `users/{uid do token}`.
- Códigos: `400` validação, `401` autenticação, `403` regras do banco, `404`, `405`, `413`,
  `429` limite do banco, `502`/`504` falha do banco.
- CORS: somente a origem em `ALLOWED_ORIGIN`.
