export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;

  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const unauthorized = (description: string, invalidToken = true): HttpError =>
  new HttpError(401, "unauthorized", description, {
    "WWW-Authenticate": invalidToken
      ? `Bearer error="invalid_token", error_description="${description.replace(/"/g, "'")}"`
      : "Bearer",
  });
