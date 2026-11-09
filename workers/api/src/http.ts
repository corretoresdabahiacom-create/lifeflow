import type { ZodTypeAny, z } from "zod";
import { HttpError } from "./errors";

export const MAX_BODY_BYTES = 16 * 1024;

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

export function allow(method: string, methods: string[]): void {
  if (!methods.includes(method)) {
    throw new HttpError(405, "method_not_allowed", "Método não permitido", { Allow: methods.join(", ") });
  }
}

/** Lê o corpo JSON com limite de tamanho e valida com um schema estrito. */
export async function parseBody<S extends ZodTypeAny>(request: Request, schema: S): Promise<z.infer<S>> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Corpo da requisição muito grande");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new HttpError(413, "payload_too_large", "Corpo da requisição muito grande");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "JSON inválido");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    // Só os nomes dos campos (nunca os valores enviados) vão na resposta.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "(corpo)"))].slice(0, 6);
    throw new HttpError(
      400,
      "validation_error",
      `Dados inválidos (campos desconhecidos, como uid, são rejeitados): ${fields.join(", ")}`,
    );
  }
  return result.data;
}
