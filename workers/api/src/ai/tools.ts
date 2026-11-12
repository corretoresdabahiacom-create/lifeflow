import {
  DateSchema,
  EVENT_KINDS,
  EventCreateSchema,
  EventPatchSchema,
  IdSchema,
  PayablePaySchema,
  ReminderCreateSchema,
  ReminderPatchSchema,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TaskCreateSchema,
  TaskPatchSchema,
  TimeSchema,
  TransactionCreateSchema,
  TransactionPatchSchema,
  formatCents,
  type AiToolName,
} from "@lifeflow/shared";
import { z, type ZodTypeAny } from "zod";
import { pathsFor, type Ctx } from "../finance/common";
import { hasProbableDuplicate } from "../finance/ledger";

/**
 * Registro das ferramentas da IA (E2). A IA não tem SQL nem acesso ao banco: cada ferramenta vira uma
 * chamada às MESMAS rotas que a interface usa, herdando validação estrita, idempotência, detecção de
 * duplicidade e atomicidade. O `uid` nunca é argumento: vem do token do usuário.
 */

export type ToolKind = "read" | "create" | "update" | "delete";

export interface InternalRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface PreparedAction {
  /** Resumo em português montado pelo backend a partir dos parâmetros congelados. */
  summary: string;
  /** Valor financeiro envolvido (centavos), para limites e confirmação reforçada. */
  amountCents: number | null;
  /** Se presente, a ação não deve nem ser proposta (ex.: duplicidade provável, item inexistente). */
  blockedReason?: string;
}

export interface ToolDef {
  name: AiToolName;
  description: string;
  parameters: Record<string, unknown>;
  kind: ToolKind;
  /** Mexe em dinheiro (lançamentos e baixas). */
  financial: boolean;
  /** Valida os argumentos (estrito). Lança `ZodError` quando inválidos. */
  parse(args: unknown): Record<string, unknown>;
  request(args: Record<string, unknown>): InternalRequest;
  prepare?(ctx: Ctx, args: Record<string, unknown>): Promise<PreparedAction>;
}

interface Definition<S extends ZodTypeAny> {
  name: AiToolName;
  description: string;
  parameters: Record<string, unknown>;
  kind: ToolKind;
  financial?: boolean;
  schema: S;
  request(args: z.infer<S>): InternalRequest;
  prepare?(ctx: Ctx, args: z.infer<S>): Promise<PreparedAction>;
}

function define<S extends ZodTypeAny>(def: Definition<S>): ToolDef {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    kind: def.kind,
    financial: def.financial ?? false,
    parse: (args) => def.schema.parse(args) as Record<string, unknown>,
    request: (args) => def.request(args as z.infer<S>),
    ...(def.prepare ? { prepare: (ctx, args) => def.prepare!(ctx, args as z.infer<S>) } : {}),
  };
}

// ---- JSON Schema enxuto para o modelo (a validação de verdade é feita pelo zod acima) ----
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const int = (description: string, extra: Record<string, unknown> = {}) => ({ type: "integer", description, ...extra });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const DATE = str("Data AAAA-MM-DD", { pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const TIME = str("Horário HH:MM (24 h)", { pattern: "^\\d{2}:\\d{2}$" });
const ID = str("Identificador obtido de uma ferramenta de consulta (nunca invente)");
const CENTS = int("Valor em CENTAVOS inteiros (R$ 12,50 = 1250)", { minimum: 1 });

const day = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const kindLabel = (type: unknown): string => (type === "income" ? "receita" : "despesa");

async function nameOf(ctx: Ctx, path: string): Promise<string | null> {
  const doc = await ctx.db.get(path);
  return typeof doc?.["name"] === "string" ? doc["name"] : null;
}

const readQuery = (entries: Record<string, string | number | boolean | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));

// ------------------------------------------------------------------ consultas

const EMPTY = z.object({}).strict();

const READ_TOOLS: ToolDef[] = [
  define({
    name: "get_accounts",
    description: "Lista as contas do usuário com o saldo atual de cada uma e o saldo total.",
    parameters: obj({}),
    kind: "read",
    schema: EMPTY,
    request: () => ({ method: "GET", path: "/v1/accounts" }),
  }),
  define({
    name: "get_balance",
    description: "Saldo atual: de uma conta (accountId) ou o total de todas as contas ativas.",
    parameters: obj({ accountId: ID }),
    kind: "read",
    schema: z.object({ accountId: IdSchema.optional() }).strict(),
    request: () => ({ method: "GET", path: "/v1/accounts" }),
  }),
  define({
    name: "list_transactions",
    description: "Lista lançamentos (receitas/despesas). Padrão: mês atual. Máximo 50 por consulta.",
    parameters: obj({
      from: DATE,
      to: DATE,
      accountId: ID,
      categoryId: ID,
      type: { type: "string", enum: ["income", "expense"] },
      limit: int("Quantidade (1 a 50)", { minimum: 1, maximum: 50 }),
    }),
    kind: "read",
    schema: z
      .object({
        from: DateSchema.optional(),
        to: DateSchema.optional(),
        accountId: IdSchema.optional(),
        categoryId: IdSchema.optional(),
        type: z.enum(["income", "expense"]).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
    request: (a) => ({ method: "GET", path: "/v1/transactions", query: readQuery({ ...a, status: "posted" }) }),
  }),
  define({
    name: "get_financial_summary",
    description: "Resumo financeiro do período (receitas, despesas, por categoria e por conta). Padrão: mês atual.",
    parameters: obj({ from: DATE, to: DATE }),
    kind: "read",
    schema: z.object({ from: DateSchema.optional(), to: DateSchema.optional() }).strict(),
    request: (a) => ({ method: "GET", path: "/v1/reports/summary", query: readQuery(a) }),
  }),
  define({
    name: "list_payments",
    description: "Lista contas a pagar e a receber (vencimentos), com status open, paid, canceled ou overdue.",
    parameters: obj({
      status: { type: "string", enum: ["open", "paid", "canceled", "overdue"] },
      kind: { type: "string", enum: ["payable", "receivable"] },
      from: DATE,
      to: DATE,
      limit: int("Quantidade (1 a 50)", { minimum: 1, maximum: 50 }),
    }),
    kind: "read",
    schema: z
      .object({
        status: z.enum(["open", "paid", "canceled", "overdue"]).optional(),
        kind: z.enum(["payable", "receivable"]).optional(),
        from: DateSchema.optional(),
        to: DateSchema.optional(),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
    request: (a) => ({ method: "GET", path: "/v1/payables", query: readQuery(a) }),
  }),
  define({
    name: "list_categories",
    description: "Lista as categorias de receita e despesa.",
    parameters: obj({}),
    kind: "read",
    schema: EMPTY,
    request: () => ({ method: "GET", path: "/v1/categories" }),
  }),
  define({
    name: "list_events",
    description: "Lista os compromissos da agenda no período (recorrências já expandidas). Padrão: próximos 30 dias.",
    parameters: obj({ from: DATE, to: DATE }),
    kind: "read",
    schema: z.object({ from: DateSchema.optional(), to: DateSchema.optional() }).strict(),
    request: (a) => ({ method: "GET", path: "/v1/events", query: readQuery(a) }),
  }),
  define({
    name: "check_schedule_conflicts",
    description: "Verifica se um horário se sobrepõe a compromissos existentes (só consulta; não cria nada).",
    parameters: obj({ startDate: DATE, startTime: TIME, durationMin: int("Duração em minutos", { minimum: 1 }) }, ["startDate", "startTime"]),
    kind: "read",
    schema: z
      .object({ startDate: DateSchema, startTime: TimeSchema, durationMin: z.number().int().min(1).max(1440).optional() })
      .strict(),
    request: (a) => ({ method: "POST", path: "/v1/events/check-conflicts", body: a }),
  }),
  define({
    name: "list_tasks",
    description: "Lista tarefas. Por padrão só as abertas; use overdue=true para as atrasadas.",
    parameters: obj({
      status: { type: "string", enum: [...TASK_STATUSES] },
      priority: { type: "string", enum: [...TASK_PRIORITIES] },
      overdue: { type: "boolean" },
      includeDone: { type: "boolean" },
      limit: int("Quantidade (1 a 50)", { minimum: 1, maximum: 50 }),
    }),
    kind: "read",
    schema: z
      .object({
        status: z.enum(TASK_STATUSES).optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        overdue: z.boolean().optional(),
        includeDone: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
    request: (a) => ({ method: "GET", path: "/v1/tasks", query: readQuery(a) }),
  }),
  define({
    name: "list_reminders",
    description: "Lista os lembretes avulsos do usuário.",
    parameters: obj({}),
    kind: "read",
    schema: EMPTY,
    request: () => ({ method: "GET", path: "/v1/reminders" }),
  }),
];

// ------------------------------------------------------------------ escritas

const TX_CREATE = TransactionCreateSchema.omit({ allowDuplicate: true });

const WRITE_TOOLS: ToolDef[] = [
  define({
    name: "create_transaction",
    description:
      "Registra uma receita ou despesa. Precisa de accountId (use get_accounts) e, se houver, categoryId (list_categories). " +
      "Nunca invente valores: pergunte ao usuário o que faltar.",
    parameters: obj(
      {
        accountId: ID,
        type: { type: "string", enum: ["income", "expense"] },
        amountCents: CENTS,
        date: DATE,
        categoryId: { ...ID, description: "Opcional; omita se não houver categoria adequada" },
        description: str("Descrição curta (até 140 caracteres)"),
        notes: str("Observação opcional"),
      },
      ["accountId", "type", "amountCents", "date", "description"],
    ),
    kind: "create",
    financial: true,
    schema: TX_CREATE,
    request: (a) => ({ method: "POST", path: "/v1/transactions", body: a }),
    prepare: async (ctx, a) => {
      const p = pathsFor(ctx.uid);
      const account = await nameOf(ctx, p.account(a.accountId));
      if (account === null) return { summary: "", amountCents: a.amountCents, blockedReason: "A conta informada não existe." };
      const category = a.categoryId ? await nameOf(ctx, p.category(a.categoryId)) : null;
      if (a.categoryId && category === null) {
        return { summary: "", amountCents: a.amountCents, blockedReason: "A categoria informada não existe." };
      }
      if (await hasProbableDuplicate(ctx, a, null)) {
        return {
          summary: "",
          amountCents: a.amountCents,
          blockedReason:
            "Já existe um lançamento igual nesta data (mesma conta, tipo, valor e descrição). Nada foi registrado. " +
            "Se for realmente outro lançamento, registre-o pela tela de Finanças confirmando a duplicidade.",
        };
      }
      return {
        summary:
          `Registrar ${kindLabel(a.type)} de ${formatCents(a.amountCents)} na conta “${account}” em ${day(a.date)}: ` +
          `“${a.description}”${category ? ` (categoria ${category})` : ""}`,
        amountCents: a.amountCents,
      };
    },
  }),
  define({
    name: "update_transaction",
    description:
      "Altera só os metadados de um lançamento (descrição, observação, categoria). Valor, conta, tipo e data não mudam: " +
      "nesse caso é preciso estornar e registrar de novo.",
    parameters: obj(
      { transactionId: ID, description: str("Nova descrição"), notes: str("Nova observação"), categoryId: ID },
      ["transactionId"],
    ),
    kind: "update",
    financial: false,
    schema: z
      .object({
        transactionId: IdSchema,
        description: TransactionPatchSchema.innerType().shape.description,
        notes: TransactionPatchSchema.innerType().shape.notes,
        categoryId: TransactionPatchSchema.innerType().shape.categoryId,
      })
      .strict()
      .refine((v) => Object.keys(v).length > 1, "Nada para alterar"),
    request: ({ transactionId, ...changes }) => ({ method: "PATCH", path: `/v1/transactions/${transactionId}`, body: changes }),
    prepare: async (ctx, a) => {
      const tx = await ctx.db.get(pathsFor(ctx.uid).transaction(a.transactionId));
      if (!tx) return { summary: "", amountCents: null, blockedReason: "O lançamento informado não existe." };
      const changes = [
        a.description !== undefined ? `descrição → “${a.description}”` : null,
        a.notes !== undefined ? "observação" : null,
        a.categoryId !== undefined ? "categoria" : null,
      ].filter(Boolean);
      return {
        summary: `Alterar o lançamento “${String(tx["description"])}” (${formatCents(Number(tx["amountCents"]))}, ${day(String(tx["date"]))}): ${changes.join(", ")}`,
        amountCents: null,
      };
    },
  }),
  define({
    name: "delete_transaction",
    description:
      "Exclui um lançamento por ESTORNO (o registro é mantido como estornado e o saldo é revertido). Sempre exige confirmação do usuário.",
    parameters: obj({ transactionId: ID }, ["transactionId"]),
    kind: "delete",
    financial: true,
    schema: z.object({ transactionId: IdSchema }).strict(),
    request: (a) => ({ method: "POST", path: `/v1/transactions/${a.transactionId}/void` }),
    prepare: async (ctx, a) => {
      const tx = await ctx.db.get(pathsFor(ctx.uid).transaction(a.transactionId));
      if (!tx) return { summary: "", amountCents: null, blockedReason: "O lançamento informado não existe." };
      if (tx["status"] === "voided") return { summary: "", amountCents: null, blockedReason: "Este lançamento já foi estornado." };
      const amount = Number(tx["amountCents"]);
      return {
        summary:
          `Estornar (excluir) o lançamento “${String(tx["description"])}” de ${formatCents(amount)} em ${day(String(tx["date"]))}. ` +
          "O saldo da conta será revertido.",
        amountCents: amount,
      };
    },
  }),
  define({
    name: "mark_payment_as_paid",
    description:
      "Dá baixa em uma conta a pagar/receber, gerando o lançamento na conta informada. Não faz pagamento bancário real.",
    parameters: obj(
      { payableId: ID, accountId: ID, date: DATE, amountCents: int("Valor efetivamente pago, se diferente do original", { minimum: 1 }) },
      ["payableId", "accountId"],
    ),
    kind: "update",
    financial: true,
    schema: PayablePaySchema.extend({ payableId: IdSchema }),
    request: ({ payableId, ...body }) => ({ method: "POST", path: `/v1/payables/${payableId}/pay`, body }),
    prepare: async (ctx, a) => {
      const p = pathsFor(ctx.uid);
      const payable = await ctx.db.get(p.payable(a.payableId));
      if (!payable) return { summary: "", amountCents: null, blockedReason: "A conta a pagar/receber informada não existe." };
      if (payable["status"] !== "open") return { summary: "", amountCents: null, blockedReason: "Esta conta não está em aberto." };
      const account = await nameOf(ctx, p.account(a.accountId));
      if (account === null) return { summary: "", amountCents: null, blockedReason: "A conta informada não existe." };
      const amount = a.amountCents ?? Number(payable["amountCents"]);
      return {
        summary: `Dar baixa em “${String(payable["description"])}” (vencimento ${day(String(payable["dueDate"]))}) com ${formatCents(amount)} na conta “${account}”`,
        amountCents: amount,
      };
    },
  }),
  define({
    name: "create_event",
    description: "Cria um compromisso na agenda. Conflitos de horário só geram aviso.",
    parameters: obj(
      {
        title: str("Título"),
        kind: { type: "string", enum: [...EVENT_KINDS] },
        startDate: DATE,
        startTime: { ...TIME, description: "Omita para evento de dia inteiro" },
        durationMin: int("Duração em minutos (padrão 60)", { minimum: 1 }),
        location: str("Local"),
        notes: str("Observações"),
        reminders: { type: "array", items: int("Minutos de antecedência"), maxItems: 5 },
        recurrence: obj(
          {
            frequency: { type: "string", enum: ["daily", "weekly", "monthly", "yearly", "custom"] },
            interval: int("A cada N", { minimum: 1 }),
            weekdays: { type: "array", items: int("0=domingo … 6=sábado") },
            until: DATE,
            count: int("Total de ocorrências", { minimum: 1 }),
          },
          ["frequency"],
        ),
      },
      ["title", "startDate"],
    ),
    kind: "create",
    schema: EventCreateSchema,
    request: (a) => ({ method: "POST", path: "/v1/events", body: a }),
    prepare: async (_ctx, a) => ({
      summary:
        `Criar o compromisso “${a.title}” em ${day(a.startDate)}` +
        `${a.startTime ? ` às ${a.startTime} (${a.durationMin} min)` : " (dia inteiro)"}` +
        `${a.recurrence ? `, repetindo (${a.recurrence.frequency})` : ""}`,
      amountCents: null,
    }),
  }),
  define({
    name: "update_event",
    description:
      "Altera um compromisso. Em séries recorrentes, scope=one altera só a ocorrência de occurrenceDate, following esta e as próximas, all a série toda.",
    parameters: obj(
      {
        eventId: ID,
        scope: { type: "string", enum: ["one", "following", "all"] },
        occurrenceDate: { ...DATE, description: "Data ORIGINAL da ocorrência (séries recorrentes)" },
        changes: obj({
          title: str("Título"),
          startDate: DATE,
          startTime: TIME,
          durationMin: int("Minutos", { minimum: 1 }),
          location: str("Local"),
          notes: str("Observações"),
        }),
      },
      ["eventId", "changes"],
    ),
    kind: "update",
    schema: EventPatchSchema.extend({ eventId: IdSchema }),
    request: ({ eventId, ...body }) => ({ method: "PATCH", path: `/v1/events/${eventId}`, body }),
    prepare: async (ctx, a) => {
      const event = await ctx.db.get(pathsFor(ctx.uid).event(a.eventId));
      if (!event) return { summary: "", amountCents: null, blockedReason: "O compromisso informado não existe." };
      const scope = { one: "somente esta ocorrência", following: "esta e as próximas", all: "toda a série" }[a.scope];
      return {
        summary: `Alterar o compromisso “${String(event["title"])}” (${scope}${a.occurrenceDate ? `, ocorrência de ${day(a.occurrenceDate)}` : ""}): ${Object.keys(a.changes).join(", ")}`,
        amountCents: null,
      };
    },
  }),
  define({
    name: "delete_event",
    description: "Exclui um compromisso (ou, em séries, uma ocorrência / esta e as próximas / a série toda).",
    parameters: obj(
      { eventId: ID, scope: { type: "string", enum: ["one", "following", "all"] }, occurrenceDate: DATE },
      ["eventId"],
    ),
    kind: "delete",
    schema: z
      .object({ eventId: IdSchema, scope: z.enum(["one", "following", "all"]).default("all"), occurrenceDate: DateSchema.optional() })
      .strict(),
    request: (a) => ({
      method: "DELETE",
      path: `/v1/events/${a.eventId}`,
      query: readQuery({ scope: a.scope, occurrenceDate: a.occurrenceDate }),
    }),
    prepare: async (ctx, a) => {
      const event = await ctx.db.get(pathsFor(ctx.uid).event(a.eventId));
      if (!event) return { summary: "", amountCents: null, blockedReason: "O compromisso informado não existe." };
      const scope = { one: "somente a ocorrência", following: "esta e as próximas", all: "o compromisso inteiro" }[a.scope];
      return {
        summary: `Excluir ${scope} de “${String(event["title"])}”${a.occurrenceDate ? ` (${day(a.occurrenceDate)})` : ""}`,
        amountCents: null,
      };
    },
  }),
  define({
    name: "create_task",
    description: "Cria uma tarefa. Lembrete e horário exigem prazo (dueDate).",
    parameters: obj(
      {
        title: str("Título"),
        description: str("Detalhes"),
        priority: { type: "string", enum: [...TASK_PRIORITIES] },
        dueDate: DATE,
        dueTime: TIME,
        reminderMinutes: int("Minutos de antecedência do lembrete", { minimum: 0 }),
      },
      ["title"],
    ),
    kind: "create",
    schema: TaskCreateSchema,
    request: (a) => ({ method: "POST", path: "/v1/tasks", body: a }),
    prepare: async (_ctx, a) => ({
      summary: `Criar a tarefa “${a.title}” (prioridade ${a.priority}${a.dueDate ? `, prazo ${day(a.dueDate)}${a.dueTime ? ` ${a.dueTime}` : ""}` : ""})`,
      amountCents: null,
    }),
  }),
  define({
    name: "update_task",
    description: "Altera uma tarefa. Os campos a mudar vão em `changes`.",
    parameters: obj(
      {
        taskId: ID,
        changes: obj({
          title: str("Título"),
          description: str("Detalhes"),
          priority: { type: "string", enum: [...TASK_PRIORITIES] },
          status: { type: "string", enum: [...TASK_STATUSES] },
          dueDate: DATE,
          dueTime: TIME,
        }),
      },
      ["taskId", "changes"],
    ),
    kind: "update",
    schema: z.object({ taskId: IdSchema, changes: TaskPatchSchema }).strict(),
    request: (a) => ({ method: "PATCH", path: `/v1/tasks/${a.taskId}`, body: a.changes }),
    prepare: async (ctx, a) => {
      const task = await ctx.db.get(pathsFor(ctx.uid).task(a.taskId));
      if (!task) return { summary: "", amountCents: null, blockedReason: "A tarefa informada não existe." };
      return { summary: `Alterar a tarefa “${String(task["title"])}”: ${Object.keys(a.changes).join(", ")}`, amountCents: null };
    },
  }),
  define({
    name: "complete_task",
    description: "Marca uma tarefa como concluída.",
    parameters: obj({ taskId: ID }, ["taskId"]),
    kind: "update",
    schema: z.object({ taskId: IdSchema }).strict(),
    request: (a) => ({ method: "POST", path: `/v1/tasks/${a.taskId}/complete` }),
    prepare: async (ctx, a) => {
      const task = await ctx.db.get(pathsFor(ctx.uid).task(a.taskId));
      if (!task) return { summary: "", amountCents: null, blockedReason: "A tarefa informada não existe." };
      return { summary: `Concluir a tarefa “${String(task["title"])}”`, amountCents: null };
    },
  }),
  define({
    name: "delete_task",
    description: "Exclui uma tarefa.",
    parameters: obj({ taskId: ID }, ["taskId"]),
    kind: "delete",
    schema: z.object({ taskId: IdSchema }).strict(),
    request: (a) => ({ method: "DELETE", path: `/v1/tasks/${a.taskId}` }),
    prepare: async (ctx, a) => {
      const task = await ctx.db.get(pathsFor(ctx.uid).task(a.taskId));
      if (!task) return { summary: "", amountCents: null, blockedReason: "A tarefa informada não existe." };
      return { summary: `Excluir a tarefa “${String(task["title"])}”`, amountCents: null };
    },
  }),
  define({
    name: "create_reminder",
    description: "Cria um lembrete avulso. remindAt é um instante UTC ISO 8601 terminando em Z (converta do horário local do usuário).",
    parameters: obj({ title: str("O que lembrar"), remindAt: str("Ex.: 2026-12-01T12:00:00Z") }, ["title", "remindAt"]),
    kind: "create",
    schema: ReminderCreateSchema,
    request: (a) => ({ method: "POST", path: "/v1/reminders", body: a }),
    prepare: async (_ctx, a) => ({
      summary: `Criar o lembrete “${a.title}” para ${a.remindAt.replace("T", " ").slice(0, 16)} (UTC)`,
      amountCents: null,
    }),
  }),
  define({
    name: "update_reminder",
    description: "Altera o texto ou o horário de um lembrete avulso.",
    parameters: obj(
      { reminderId: ID, changes: obj({ title: str("Novo texto"), remindAt: str("Novo instante UTC ISO 8601 (Z)") }) },
      ["reminderId", "changes"],
    ),
    kind: "update",
    schema: z.object({ reminderId: IdSchema, changes: ReminderPatchSchema }).strict(),
    request: (a) => ({ method: "PATCH", path: `/v1/reminders/${a.reminderId}`, body: a.changes }),
    prepare: async (ctx, a) => {
      const reminder = await ctx.db.get(pathsFor(ctx.uid).reminder(a.reminderId));
      if (!reminder) return { summary: "", amountCents: null, blockedReason: "O lembrete informado não existe." };
      return { summary: `Alterar o lembrete “${String(reminder["title"])}”: ${Object.keys(a.changes).join(", ")}`, amountCents: null };
    },
  }),
];

export const TOOLS: readonly ToolDef[] = [...READ_TOOLS, ...WRITE_TOOLS];
const BY_NAME = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]));

/** Só ferramentas do registro existem. Qualquer outro nome (inventado ou injetado) retorna `undefined`. */
export function findTool(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}
