import type {
  Account,
  AiActionView,
  AiChatReply,
  AiMessageView,
  AiSettings,
  AiUsageView,
  AppNotification,
  CalendarEvent,
  EventChanges,
  EventCreateInput,
  EventExpenseInput,
  EventScope,
  Occurrence,
  ReminderCreateInput,
  Task,
  TaskCreateInput,
  TaskPatchInput,
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

export interface ConflictItem {
  startDate: string;
  startUtc: string;
  endUtc: string;
  with: Array<{ key: string; eventId: string; title: string; startUtc: string; endUtc: string }>;
}

export interface OccurrencesReply {
  from: string;
  to: string;
  occurrences: Occurrence[];
  conflictCount: number;
}

export type EventInput = Partial<EventCreateInput> & Pick<EventCreateInput, "title" | "startDate">;

export interface TaskListReply {
  tasks: Task[];
  total: number;
  overdueCount: number;
  truncated: boolean;
}

export interface TaskCategory {
  id: string;
  name: string;
  archived: boolean;
}

export interface NotificationsReply {
  notifications: AppNotification[];
  unreadCount: number;
}

export interface StandaloneReminder {
  id: string;
  title: string;
  remindAt: string;
}

export interface AiConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface AiConversationDetail {
  id: string;
  title: string;
  messages: AiMessageView[];
  actions: AiActionView[];
}

export interface AiHistoryItem {
  id: string;
  event: string;
  tool: string | null;
  actionId: string | null;
  detail: string;
  createdAt: string;
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
      if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

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

    // ---- Agenda (Fase 3) ----
    listEvents: (from: string, to: string, kind?: string) =>
      request<OccurrencesReply>(withQuery("/v1/events", { from, to, kind: kind ?? null })),
    getEvent: (id: string) => request<CalendarEvent>(`/v1/events/${id}`),
    createEvent: (input: EventInput, key: string) =>
      request<CalendarEvent & { conflicts: ConflictItem[] }>("/v1/events", post(input, key)),
    patchEvent: (id: string, input: { scope: EventScope; occurrenceDate?: string; changes: EventChanges }) =>
      request<{ conflicts: ConflictItem[] }>(`/v1/events/${id}`, patch(input)),
    deleteEvent: (id: string, scope: EventScope, occurrenceDate?: string) =>
      request<{ deleted: boolean }>(withQuery(`/v1/events/${id}`, { scope, occurrenceDate: occurrenceDate ?? null }), { method: "DELETE" }),
    checkConflicts: (input: {
      startDate: string;
      startTime: string;
      durationMin: number;
      timeZone?: string;
      excludeEventId?: string;
      recurrence?: EventCreateInput["recurrence"];
    }) => request<{ hasConflicts: boolean; conflicts: ConflictItem[] }>("/v1/events/check-conflicts", post(input)),
    createEventExpense: (id: string, input: Partial<EventExpenseInput> & Pick<EventExpenseInput, "accountId">, key: string) =>
      request<Transaction>(`/v1/events/${id}/expense`, post(input, key)),

    listTasks: (query: Query) => request<TaskListReply>(withQuery("/v1/tasks", query)),
    createTask: (input: Partial<TaskCreateInput> & Pick<TaskCreateInput, "title">, key: string) =>
      request<Task>("/v1/tasks", post(input, key)),
    patchTask: (id: string, input: TaskPatchInput) => request<Task>(`/v1/tasks/${id}`, patch(input)),
    completeTask: (id: string) => request<Task>(`/v1/tasks/${id}/complete`, post({})),
    deleteTask: (id: string) => request<{ deleted: boolean }>(`/v1/tasks/${id}`, { method: "DELETE" }),
    listTaskCategories: () => request<{ categories: TaskCategory[] }>("/v1/task-categories"),
    createTaskCategory: (name: string, key: string) => request<TaskCategory>("/v1/task-categories", post({ name }, key)),

    listNotifications: (unreadOnly = false) =>
      request<NotificationsReply>(withQuery("/v1/notifications", { unread: unreadOnly ? "true" : null })),
    generateNotifications: () => request<{ created: number; hasMore: boolean }>("/v1/notifications/generate", post({})),
    markNotificationRead: (id: string) => request<AppNotification>(`/v1/notifications/${id}/read`, post({})),
    dismissNotification: (id: string) => request<AppNotification>(`/v1/notifications/${id}/dismiss`, post({})),
    readAllNotifications: () => request<{ updated: number; hasMore: boolean }>("/v1/notifications/read-all", post({})),
    createReminder: (input: ReminderCreateInput, key: string) => request<StandaloneReminder>("/v1/reminders", post(input, key)),

    // ---- Assistente de IA (Fase 4) ----
    aiChat: (message: string, conversationId: string | undefined, key: string) =>
      request<AiChatReply>("/v1/ai/chat", post({ message, ...(conversationId ? { conversationId } : {}) }, key)),
    aiListConversations: () => request<{ conversations: AiConversationSummary[] }>("/v1/ai/conversations"),
    aiGetConversation: (id: string) => request<AiConversationDetail>(`/v1/ai/conversations/${id}`),
    aiDeleteConversation: (id: string) => request<{ deleted: boolean }>(`/v1/ai/conversations/${id}`, { method: "DELETE" }),
    aiPendingActions: () => request<{ actions: AiActionView[] }>("/v1/ai/actions"),
    /** O corpo só diz se a confirmação é reforçada: os parâmetros da ação ficam congelados no servidor. */
    aiConfirm: (id: string, reinforced: boolean) =>
      request<{ action: AiActionView }>(`/v1/ai/actions/${id}/confirm`, post(reinforced ? { reinforced: true } : {})),
    aiReject: (id: string) => request<{ action: AiActionView }>(`/v1/ai/actions/${id}/reject`, post({})),
    aiHistory: () => request<{ history: AiHistoryItem[] }>("/v1/ai/history"),
    aiUsage: () => request<{ usage: AiUsageView; autoToday: { autoActions: number; autoValueCents: number } }>("/v1/ai/usage"),
    aiGetSettings: () => request<{ settings: AiSettings; defaults: AiSettings }>("/v1/ai/settings"),
    aiPutSettings: (input: AiSettings) => request<{ settings: AiSettings; defaults: AiSettings }>("/v1/ai/settings", put(input)),
    aiGetConsent: () => request<{ audio: boolean; updatedAt: string | null }>("/v1/ai/consent"),
    aiPutConsent: (audio: boolean) => request<{ audio: boolean; updatedAt: string }>("/v1/ai/consent", put({ audio })),
    /** Áudio cru no corpo; a duração vai no cabeçalho. O áudio não é guardado em lugar nenhum. */
    aiTranscribe: (audio: Blob, seconds: number) =>
      request<{ text: string; billedSeconds: number }>("/v1/ai/transcribe", {
        method: "POST",
        body: audio,
        headers: { "Content-Type": audio.type || "audio/webm", "X-Audio-Seconds": String(Math.max(1, Math.ceil(seconds))) },
      }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
