import type { Preferences, PreferencesInput, Profile, ProfileInput } from "@lifeflow/shared";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Devolve o ID token vigente. `forceRefresh` pede ao SDK que renove a sessão. */
  getToken: (forceRefresh: boolean) => Promise<string>;
  fetchImpl?: typeof fetch;
}

export type StoredPreferences = Preferences & { stored: boolean };

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      // Na segunda tentativa a renovação da sessão é feita pelo SDK do Firebase (o Worker não renova).
      const token = await options.getToken(attempt > 0);
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      if (init.body !== undefined) headers.set("Content-Type", "application/json");

      const response = await doFetch(`${options.baseUrl}${path}`, { ...init, headers });
      if (response.status === 401 && attempt === 0) continue;

      if (!response.ok) {
        let code = "http_error";
        let message = `Falha na requisição (${response.status})`;
        let requestId: string | undefined;
        try {
          const body = (await response.json()) as { error?: { code?: string; message?: string; requestId?: string } };
          code = body.error?.code ?? code;
          message = body.error?.message ?? message;
          requestId = body.error?.requestId;
        } catch {
          /* corpo não é JSON */
        }
        throw new ApiError(response.status, code, message, requestId);
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
  }

  const put = (body: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(body) });

  return {
    me: () => request<{ uid: string; email?: string }>("/v1/me"),
    async getProfile(): Promise<Profile | null> {
      try {
        return await request<Profile>("/v1/profile");
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    putProfile: (input: ProfileInput) => request<Profile>("/v1/profile", put(input)),
    getPreferences: () => request<StoredPreferences>("/v1/preferences"),
    putPreferences: (input: PreferencesInput) => request<StoredPreferences>("/v1/preferences", put(input)),
    deletePreferences: () => request<void>("/v1/preferences", { method: "DELETE" }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
