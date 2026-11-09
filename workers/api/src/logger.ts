/**
 * Logs estruturados. Nunca registrar tokens, cabeçalhos de autorização, corpo de requisição
 * ou conteúdo de documentos. Somente metadados operacionais.
 */
export interface LogFields {
  requestId: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  uid?: string;
  errorCode?: string;
  [key: string]: string | number | boolean | undefined;
}

const FORBIDDEN_KEYS = new Set(["authorization", "token", "idtoken", "password", "body", "cookie"]);

export function log(level: "info" | "warn" | "error", message: string, fields: LogFields): void {
  const safe: Record<string, string | number | boolean | undefined> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!FORBIDDEN_KEYS.has(key.toLowerCase())) safe[key] = value;
  }
  console.log(JSON.stringify({ level, message, time: new Date().toISOString(), ...safe }));
}
