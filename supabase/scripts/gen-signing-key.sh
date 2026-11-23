#!/usr/bin/env bash
# Gera a chave de assinatura ES256 (JWK) do GoTrue LOCAL em supabase/signing_keys.json (não versionado).
# Formato: array JSON de JWKs, o mesmo que `supabase gen signing-key --append` produz. Só para a pilha local de testes.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f supabase/signing_keys.json ] && exit 0
node -e '
const { generateKeyPairSync, randomUUID } = require("node:crypto");
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = { ...privateKey.export({ format: "jwk" }), kid: randomUUID(), use: "sig", key_ops: ["sign", "verify"], alg: "ES256" };
require("node:fs").writeFileSync("supabase/signing_keys.json", JSON.stringify([jwk]) + "\n", { mode: 0o600 });
'
