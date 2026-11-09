# API

> Estado: nenhum endpoint implementado (Fase 0).

A API é o Cloudflare Worker em `workers/api`. Todos os endpoints autenticados exigem
`Authorization: Bearer <access token do Supabase>`. Token ausente, inválido ou expirado
retorna resposta de autenticação adequada; a renovação da sessão é feita pelo SDK no frontend.
