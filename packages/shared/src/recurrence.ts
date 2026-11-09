import { addDays, addMonthsClamped } from "./dates";

export const FREQUENCIES = ["weekly", "monthly", "yearly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

const MAX_ITERATIONS = 20_000;

export function nthOccurrence(startDate: string, frequency: Frequency, n: number): string {
  switch (frequency) {
    case "weekly":
      return addDays(startDate, 7 * n);
    case "monthly":
      return addMonthsClamped(startDate, n);
    case "yearly":
      return addMonthsClamped(startDate, 12 * n);
  }
}

export interface OccurrenceRule {
  frequency: Frequency;
  startDate: string;
  endDate: string | null;
}

/**
 * Datas de ocorrência de uma regra, em ordem crescente, estritamente DEPOIS de `after` (se houver),
 * até `through` (inclusive) e até `endDate` da regra. Cada data é calculada a partir da data inicial
 * (não da anterior), então 31/jan → 28/fev → 31/mar não "desliza" para o dia 28.
 */
export function occurrenceDates(
  rule: OccurrenceRule,
  options: { after: string | null; through: string; limit: number },
): string[] {
  const upper = rule.endDate !== null && rule.endDate < options.through ? rule.endDate : options.through;
  const dates: string[] = [];
  for (let n = 0; n < MAX_ITERATIONS && dates.length < options.limit; n++) {
    const date = nthOccurrence(rule.startDate, rule.frequency, n);
    if (date > upper) break;
    if (options.after !== null && date <= options.after) continue;
    dates.push(date);
  }
  return dates;
}
