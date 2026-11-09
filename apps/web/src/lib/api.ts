import type {
  Account,
  AccountCreateInput,
  AccountPatchInput,
  Category,
  CategoryCreateInput,
  CategoryPatchInput,
  Payable,
  PayableCreateInput,
  PayablePatchInput,
  PayablePayInput,
  Preferences,
  PreferencesInput,
  Profile,
  ProfileInput,
  RecurringCreateInput,
  RecurringPatchInput,
  RecurringRule,
  Transaction,
  TransactionCreateInput,
  TransactionPatchInput,
  Transfer,
  TransferCreateInput,
} from "@lifeflow/shared";

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

export interface Bucket {
  count: number;
  totalCents: number;
}

export interface FinanceOverview {
  today: string;
  month: { from: string; to: string };
  totalBalanceCents: number;
  accounts: Array<{ id: string; name: string; type: string; balanceCents: number }>;
  monthSummary: { incomeCents: number; expenseCents: number; netCents: number; truncated: boolean };
  payables: {
    overdueToPay: Bucket;
    overdueToReceive: Bucket;
    next7ToPay: Bucket;
    next7ToReceive: Bucket;
    next30ToPay: Bucket;
    next30ToReceive: Bucket;
    truncated: boolean;
  };
}

export interface TransactionPage {
  from: string;
  to: string;
  items: Transaction[];
  nextCursor: string | null;
}

export interface PayablePage {
  today: string;
  items: Payable[];
  nextCursor: string | null;
}

export interface SummaryReport {
  from: string;
  to: string;
  totals: { incomeCents: number; expenseCents: number; netCents: number; transferVolumeCents: number };
  byCategory: Array<{ categoryId: string | null; name: string; kind: "income" | "expense"; totalCents: number; count: number }>;
  byAccount: Array<{ accountId: string; name: string; incomeCents: number; expenseCents: number; netCents: number }>;
  byMonth: Array<{ month: string; incomeCents: number; expenseCents: number; netCents: number }>;
  transactionCount: number;
  truncated: boolean;
}

export interface ReconcileReport {
  complete: boolean;
  ok: boolean;
  accounts: Array<{ accountId: string; name: string; storedCents: number; expectedCents: number; driftCents: number }>;
}

export interface MaterializeResult {
  created: number;
  through: string;
  hasMore: boolean;
}

type Query = Record<string, string | number | null | undefined>;

function withQuery(path: string, query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      // Na segunda tentativa a renovação da sessão é feita pelo SDK do Firebase (o Worker não renova).
      const token = await options.getToken(attempt > 0);
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      if (init.body !== undefined) headers.set("Content-Type", "application/json");

      const response = await doFetch(`${options.baseUrl}${path}`, { ...init, headers });
      if (response.status === 401 && attempt === 0) continue;
      return response;
    }
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await send(path, init);
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

  // Criações exigem Idempotency-Key. A MESMA chave deve ser reenviada em novas tentativas da mesma ação.
  const post = (body: unknown, key?: string): RequestInit => ({
    method: "POST",
    body: JSON.stringify(body),
    ...(key ? { headers: { "Idempotency-Key": key } } : {}),
  });
  const patch = (body: unknown): RequestInit => ({ method: "PATCH", body: JSON.stringify(body) });

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

    // ---- Financeiro (Fase 2) ----
    overview: () => request<FinanceOverview>("/v1/finance/overview"),
    listAccounts: (includeArchived = false) =>
      request<{ accounts: Account[]; totalBalanceCents: number }>(withQuery("/v1/accounts", { archived: includeArchived ? "true" : null })),
    createAccount: (input: AccountCreateInput, key: string) => request<Account>("/v1/accounts", post(input, key)),
    patchAccount: (id: string, input: AccountPatchInput) => request<Account>(`/v1/accounts/${id}`, patch(input)),
    listCategories: (includeArchived = false) =>
      request<{ categories: Category[] }>(withQuery("/v1/categories", { archived: includeArchived ? "true" : null })),
    createCategory: (input: CategoryCreateInput, key: string) => request<Category>("/v1/categories", post(input, key)),
    patchCategory: (id: string, input: CategoryPatchInput) => request<Category>(`/v1/categories/${id}`, patch(input)),
    listTransactions: (query: Query) => request<TransactionPage>(withQuery("/v1/transactions", query)),
    createTransaction: (input: Omit<TransactionCreateInput, "categoryId" | "notes" | "allowDuplicate"> &
      Partial<Pick<TransactionCreateInput, "categoryId" | "notes" | "allowDuplicate">>, key: string) =>
      request<Transaction>("/v1/transactions", post(input, key)),
    patchTransaction: (id: string, input: TransactionPatchInput) => request<Transaction>(`/v1/transactions/${id}`, patch(input)),
    voidTransaction: (id: string) => request<Transaction>(`/v1/transactions/${id}/void`, post({})),
    listTransfers: () => request<{ items: Transfer[] }>("/v1/transfers"),
    createTransfer: (input: Omit<TransferCreateInput, "description"> & { description?: string | null }, key: string) =>
      request<Transfer>("/v1/transfers", post(input, key)),
    voidTransfer: (id: string) => request<Transfer>(`/v1/transfers/${id}/void`, post({})),
    listPayables: (query: Query) => request<PayablePage>(withQuery("/v1/payables", query)),
    createPayable: (input: Omit<PayableCreateInput, "accountId" | "categoryId"> & Partial<Pick<PayableCreateInput, "accountId" | "categoryId">>, key: string) =>
      request<Payable>("/v1/payables", post(input, key)),
    patchPayable: (id: string, input: PayablePatchInput) => request<Payable>(`/v1/payables/${id}`, patch(input)),
    payPayable: (id: string, input: PayablePayInput, key: string) =>
      request<{ payable: Payable; transactionId: string }>(`/v1/payables/${id}/pay`, post(input, key)),
    cancelPayable: (id: string) => request<Payable>(`/v1/payables/${id}/cancel`, post({})),
    listRecurring: () => request<{ rules: RecurringRule[] }>("/v1/recurring"),
    createRecurring: (input: Omit<RecurringCreateInput, "endDate" | "accountId" | "categoryId"> &
      Partial<Pick<RecurringCreateInput, "endDate" | "accountId" | "categoryId">>, key: string) =>
      request<RecurringRule>("/v1/recurring", post(input, key)),
    patchRecurring: (id: string, input: RecurringPatchInput) => request<RecurringRule>(`/v1/recurring/${id}`, patch(input)),
    materialize: (through?: string) => request<MaterializeResult>("/v1/recurring/materialize", post(through ? { through } : {})),
    summary: (from: string, to: string) => request<SummaryReport>(withQuery("/v1/reports/summary", { from, to })),
    reconcile: () => request<ReconcileReport>("/v1/reconcile"),
    /** Baixa o CSV com o token no cabeçalho (nunca na URL). */
    async exportCsv(from: string, to: string): Promise<Blob> {
      const response = await send(withQuery("/v1/export/transactions", { from, to }));
      if (!response.ok) throw new ApiError(response.status, "export_failed", "Não foi possível exportar");
      return response.blob();
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
