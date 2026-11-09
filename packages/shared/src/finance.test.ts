import { describe, expect, it } from "vitest";
import {
  AccountCreateSchema,
  PayablePaySchema,
  RecurringCreateSchema,
  TransactionCreateSchema,
  TransferCreateSchema,
  addDays,
  addMonthsClamped,
  centsToDecimal,
  formatCents,
  isValidDate,
  monthBounds,
  occurrenceDates,
  parseMoneyToCents,
  signedAmount,
  todayInTimeZone,
} from "./index";

describe("parseMoneyToCents", () => {
  it.each([
    ["1.234,56", 123456],
    ["1234,56", 123456],
    ["1234.56", 123456],
    ["12,5", 1250],
    ["12.5", 1250],
    ["R$ 10", 1000],
    ["R$10,99", 1099],
    ["1.234", 123400],
    ["1.234.567,89", 123456789],
    ["0,05", 5],
    ["-5,00", -500],
    ["-R$ 5,00", -500],
    ["  42  ", 4200],
  ])("converte %s em %i centavos", (input, expected) => {
    expect(parseMoneyToCents(input)).toBe(expected);
  });

  it.each(["", "abc", "1,2,3", "1.2.3", "12,345", "1..2", "--5", "1e3", "10,", ",50", "R$", "9999999999999"])(
    "rejeita entrada inválida: %j",
    (input) => {
      expect(parseMoneyToCents(input)).toBeNull();
    },
  );

  it("não sofre erro de ponto flutuante (0,1 + 0,2)", () => {
    expect((parseMoneyToCents("0,10") ?? 0) + (parseMoneyToCents("0,20") ?? 0)).toBe(30);
  });
});

describe("formatação", () => {
  it("formata em reais (pt-BR)", () => {
    expect(formatCents(123456).replace(/\s/g, " ")).toBe("R$ 1.234,56");
  });
  it("centsToDecimal usa ponto e preserva sinal", () => {
    expect(centsToDecimal(123456)).toBe("1234.56");
    expect(centsToDecimal(-5)).toBe("-0.05");
    expect(centsToDecimal(0)).toBe("0.00");
  });
});

describe("datas", () => {
  it("valida calendário real", () => {
    expect(isValidDate("2026-02-28")).toBe(true);
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2026-02-30")).toBe(false);
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("2026-1-1")).toBe(false);
    expect(isValidDate("1800-01-01")).toBe(false);
  });
  it("addDays atravessa mês e ano", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("addMonthsClamped limita ao fim do mês e não desliza", () => {
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsClamped("2026-01-31", 2)).toBe("2026-03-31");
    expect(addMonthsClamped("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonthsClamped("2026-11-15", 14)).toBe("2028-01-15");
  });
  it("monthBounds", () => {
    expect(monthBounds("2026-02-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });
  it("todayInTimeZone respeita o fuso", () => {
    const instant = new Date("2026-11-10T01:30:00Z");
    expect(todayInTimeZone(instant, "America/Sao_Paulo")).toBe("2026-11-09");
    expect(todayInTimeZone(instant, "UTC")).toBe("2026-11-10");
    expect(todayInTimeZone(instant, "Fuso/Invalido")).toBe("2026-11-10");
  });
});

describe("occurrenceDates", () => {
  it("mensal, com dia 31 sem deslizar", () => {
    const dates = occurrenceDates(
      { frequency: "monthly", startDate: "2026-01-31", endDate: null },
      { after: null, through: "2026-05-31", limit: 10 },
    );
    expect(dates).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
  });
  it("semanal", () => {
    expect(
      occurrenceDates({ frequency: "weekly", startDate: "2026-11-02", endDate: null }, { after: null, through: "2026-11-24", limit: 10 }),
    ).toEqual(["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"]);
  });
  it("anual com 29/fev", () => {
    expect(
      occurrenceDates({ frequency: "yearly", startDate: "2024-02-29", endDate: null }, { after: null, through: "2028-12-31", limit: 10 }),
    ).toEqual(["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"]);
  });
  it("respeita after (exclusivo), endDate e limit", () => {
    const rule = { frequency: "monthly" as const, startDate: "2026-01-10", endDate: "2026-04-10" };
    expect(occurrenceDates(rule, { after: "2026-02-10", through: "2027-01-01", limit: 10 })).toEqual(["2026-03-10", "2026-04-10"]);
    expect(occurrenceDates(rule, { after: null, through: "2027-01-01", limit: 2 })).toEqual(["2026-01-10", "2026-02-10"]);
  });
  it("nada quando through é anterior ao início", () => {
    expect(
      occurrenceDates({ frequency: "monthly", startDate: "2026-06-01", endDate: null }, { after: null, through: "2026-05-01", limit: 5 }),
    ).toEqual([]);
  });
});

describe("schemas financeiros", () => {
  const tx = { accountId: "acc1", type: "expense", amountCents: 1000, date: "2026-11-09", description: "Mercado" };

  it("aceita lançamento válido e aplica padrões", () => {
    const parsed = TransactionCreateSchema.parse(tx);
    expect(parsed.categoryId).toBeNull();
    expect(parsed.allowDuplicate).toBe(false);
  });
  it.each([
    ["valor decimal", { ...tx, amountCents: 12.5 }],
    ["valor zero", { ...tx, amountCents: 0 }],
    ["valor negativo", { ...tx, amountCents: -1 }],
    ["valor em texto", { ...tx, amountCents: "10" }],
    ["valor acima do limite", { ...tx, amountCents: 1e12 }],
    ["data inexistente", { ...tx, date: "2026-02-30" }],
    ["tipo de transferência no endpoint de lançamento", { ...tx, type: "transfer_out" }],
    ["uid no corpo", { ...tx, uid: "outro" }],
    ["saldo no corpo", { ...tx, balanceCents: 5 }],
    ["id com barra", { ...tx, accountId: "a/b" }],
    ["id com ..", { ...tx, categoryId: ".." }],
    ["descrição vazia", { ...tx, description: "   " }],
  ])("rejeita %s", (_label, body) => {
    expect(TransactionCreateSchema.safeParse(body).success).toBe(false);
  });

  it("transferência exige contas diferentes", () => {
    const base = { fromAccountId: "a", toAccountId: "b", amountCents: 100, date: "2026-11-09" };
    expect(TransferCreateSchema.safeParse(base).success).toBe(true);
    expect(TransferCreateSchema.safeParse({ ...base, toAccountId: "a" }).success).toBe(false);
  });
  it("conta aceita saldo inicial negativo e padrão zero", () => {
    expect(AccountCreateSchema.parse({ name: "Cartão", type: "credit_card" }).initialBalanceCents).toBe(0);
    expect(AccountCreateSchema.parse({ name: "Cartão", type: "credit_card", initialBalanceCents: -500 }).initialBalanceCents).toBe(-500);
    expect(AccountCreateSchema.safeParse({ name: "X", type: "outro" }).success).toBe(false);
  });
  it("baixa não aceita campos extras", () => {
    expect(PayablePaySchema.safeParse({ accountId: "a" }).success).toBe(true);
    expect(PayablePaySchema.safeParse({ accountId: "a", status: "paid" }).success).toBe(false);
  });
  it("recorrência: fim não pode preceder o início", () => {
    const rule = { kind: "payable", description: "Aluguel", amountCents: 100000, frequency: "monthly", startDate: "2026-11-05" };
    expect(RecurringCreateSchema.safeParse(rule).success).toBe(true);
    expect(RecurringCreateSchema.safeParse({ ...rule, endDate: "2026-10-01" }).success).toBe(false);
  });
  it("signedAmount", () => {
    expect(signedAmount("income", 50)).toBe(50);
    expect(signedAmount("transfer_in", 50)).toBe(50);
    expect(signedAmount("expense", 50)).toBe(-50);
    expect(signedAmount("transfer_out", 50)).toBe(-50);
  });
});
