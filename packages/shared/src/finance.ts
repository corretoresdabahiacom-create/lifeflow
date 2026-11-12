import { z } from "zod";
import { isValidDate } from "./dates";
import { MAX_CENTS } from "./money";
import { FREQUENCIES } from "./recurrence";

/**
 * Schemas e tipos do módulo financeiro (Fase 2). Todos os schemas de entrada são `strict`:
 * campos desconhecidos (incluindo `uid`, `balanceCents`, `status`) são rejeitados.
 * Valores monetários são centavos inteiros.
 */

export const ACCOUNT_TYPES = ["checking", "savings", "cash", "credit_card", "investment"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const CATEGORY_KINDS = ["income", "expense"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const TRANSACTION_TYPES = ["income", "expense", "transfer_out", "transfer_in"] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const PAYABLE_KINDS = ["payable", "receivable"] as const;
export type PayableKind = (typeof PAYABLE_KINDS)[number];

/** Identificador de documento: restrito para impedir manipulação de caminhos do banco. */
export const DOC_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export const IdSchema = z.string().regex(DOC_ID_RE, "Identificador inválido");

export const DateSchema = z
  .string()
  .refine(isValidDate, "Data inválida, use AAAA-MM-DD");

/** Valor positivo em centavos inteiros. Decimais (12.5) são rejeitados. */
export const PositiveCentsSchema = z
  .number({ invalid_type_error: "Valor deve ser um número" })
  .int("Valor deve ser inteiro em centavos")
  .positive("Valor deve ser maior que zero")
  .max(MAX_CENTS, "Valor acima do limite");

export const SignedCentsSchema = z
  .number({ invalid_type_error: "Valor deve ser um número" })
  .int("Valor deve ser inteiro em centavos")
  .min(-MAX_CENTS)
  .max(MAX_CENTS);

const name = z.string().trim().min(1, "Informe um nome").max(60);
const description = z.string().trim().min(1, "Informe uma descrição").max(140);
const notes = z.string().trim().max(500);

// ---- Contas ----
export const AccountCreateSchema = z
  .object({
    name,
    type: z.enum(ACCOUNT_TYPES),
    initialBalanceCents: SignedCentsSchema.default(0),
  })
  .strict();
export type AccountCreateInput = z.infer<typeof AccountCreateSchema>;

export const AccountPatchSchema = z
  .object({ name: name.optional(), archived: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nada para alterar");
export type AccountPatchInput = z.infer<typeof AccountPatchSchema>;

// ---- Categorias ----
export const CategoryCreateSchema = z.object({ name, kind: z.enum(CATEGORY_KINDS) }).strict();
export type CategoryCreateInput = z.infer<typeof CategoryCreateSchema>;

export const CategoryPatchSchema = z
  .object({ name: name.optional(), archived: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nada para alterar");
export type CategoryPatchInput = z.infer<typeof CategoryPatchSchema>;

// ---- Lançamentos (receitas e despesas) ----
export const TransactionCreateSchema = z
  .object({
    accountId: IdSchema,
    type: z.enum(["income", "expense"]),
    amountCents: PositiveCentsSchema,
    date: DateSchema,
    categoryId: IdSchema.nullable().default(null),
    description,
    notes: notes.nullable().default(null),
    /** Confirma que é um lançamento realmente repetido (ver detecção de duplicidade). */
    allowDuplicate: z.boolean().default(false),
  })
  .strict();
export type TransactionCreateInput = z.infer<typeof TransactionCreateSchema>;

/** Só metadados são editáveis. Valor, conta, tipo e data exigem estorno e novo lançamento. */
export const TransactionPatchSchema = z
  .object({
    description: description.optional(),
    notes: notes.nullable().optional(),
    categoryId: IdSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nada para alterar");
export type TransactionPatchInput = z.infer<typeof TransactionPatchSchema>;

// ---- Transferências ----
export const TransferCreateSchema = z
  .object({
    fromAccountId: IdSchema,
    toAccountId: IdSchema,
    amountCents: PositiveCentsSchema,
    date: DateSchema,
    description: description.nullable().default(null),
  })
  .strict()
  .refine((v) => v.fromAccountId !== v.toAccountId, {
    message: "Origem e destino devem ser contas diferentes",
    path: ["toAccountId"],
  });
export type TransferCreateInput = z.infer<typeof TransferCreateSchema>;

// ---- Contas a pagar / receber ----
export const PayableCreateSchema = z
  .object({
    kind: z.enum(PAYABLE_KINDS),
    description,
    amountCents: PositiveCentsSchema,
    dueDate: DateSchema,
    accountId: IdSchema.nullable().default(null),
    categoryId: IdSchema.nullable().default(null),
  })
  .strict();
export type PayableCreateInput = z.infer<typeof PayableCreateSchema>;

export const PayablePatchSchema = z
  .object({
    description: description.optional(),
    amountCents: PositiveCentsSchema.optional(),
    dueDate: DateSchema.optional(),
    accountId: IdSchema.nullable().optional(),
    categoryId: IdSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nada para alterar");
export type PayablePatchInput = z.infer<typeof PayablePatchSchema>;

/** Baixa: marca como paga/recebida e gera o lançamento na conta, de forma atômica. */
export const PayablePaySchema = z
  .object({
    accountId: IdSchema,
    date: DateSchema.optional(),
    /** Valor efetivamente pago (juros/desconto). Padrão: o valor da conta. */
    amountCents: PositiveCentsSchema.optional(),
  })
  .strict();
export type PayablePayInput = z.infer<typeof PayablePaySchema>;

// ---- Recorrências ----
export const RecurringCreateSchema = z
  .object({
    kind: z.enum(PAYABLE_KINDS),
    description,
    amountCents: PositiveCentsSchema,
    frequency: z.enum(FREQUENCIES),
    startDate: DateSchema,
    endDate: DateSchema.nullable().default(null),
    accountId: IdSchema.nullable().default(null),
    categoryId: IdSchema.nullable().default(null),
  })
  .strict()
  .refine((v) => v.endDate === null || v.endDate >= v.startDate, {
    message: "A data final não pode ser anterior à inicial",
    path: ["endDate"],
  });
export type RecurringCreateInput = z.infer<typeof RecurringCreateSchema>;

export const RecurringPatchSchema = z
  .object({
    active: z.boolean().optional(),
    description: description.optional(),
    amountCents: PositiveCentsSchema.optional(),
    endDate: DateSchema.nullable().optional(),
    accountId: IdSchema.nullable().optional(),
    categoryId: IdSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nada para alterar");
export type RecurringPatchInput = z.infer<typeof RecurringPatchSchema>;

export const MaterializeSchema = z.object({ through: DateSchema.optional() }).strict();
export type MaterializeInput = z.infer<typeof MaterializeSchema>;

// ---- Documentos (formato devolvido pela API) ----
export interface Account {
  id: string;
  uid: string;
  name: string;
  type: AccountType;
  initialBalanceCents: number;
  balanceCents: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: string;
  uid: string;
  name: string;
  kind: CategoryKind;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export type TransactionStatus = "posted" | "voided";

export interface Transaction {
  id: string;
  uid: string;
  accountId: string;
  type: TransactionType;
  /** Sempre positivo. */
  amountCents: number;
  /** Efeito no saldo: positivo (entrada) ou negativo (saída). */
  signedCents: number;
  date: string;
  categoryId: string | null;
  description: string;
  notes: string | null;
  status: TransactionStatus;
  transferId: string | null;
  payableId: string | null;
  createdAt: string;
  updatedAt: string;
  voidedAt: string | null;
  /** Quem criou o lançamento: `manual` (interface) ou `ai` (assistente, após confirmação). Gravado pelo servidor. */
  origin?: "manual" | "ai";
  aiActionId?: string | null;
}

export interface Transfer {
  id: string;
  uid: string;
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  date: string;
  description: string | null;
  status: TransactionStatus;
  outTransactionId: string;
  inTransactionId: string;
  createdAt: string;
  updatedAt: string;
  voidedAt: string | null;
}

export type PayableStatus = "open" | "paid" | "canceled";

export interface Payable {
  id: string;
  uid: string;
  kind: PayableKind;
  description: string;
  amountCents: number;
  dueDate: string;
  accountId: string | null;
  categoryId: string | null;
  status: PayableStatus;
  paidDate: string | null;
  paidAmountCents: number | null;
  transactionId: string | null;
  payCount: number;
  recurringId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Derivado no momento da leitura: aberta e vencida (vencimento antes de hoje). */
  overdue?: boolean;
}

export interface RecurringRule {
  id: string;
  uid: string;
  kind: PayableKind;
  description: string;
  amountCents: number;
  frequency: (typeof FREQUENCIES)[number];
  startDate: string;
  endDate: string | null;
  accountId: string | null;
  categoryId: string | null;
  active: boolean;
  /** Última data de ocorrência já gerada como conta a pagar/receber. */
  lastMaterializedThrough: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Efeito de um lançamento no saldo da conta. */
export function signedAmount(type: TransactionType, amountCents: number): number {
  return type === "income" || type === "transfer_in" ? amountCents : -amountCents;
}
