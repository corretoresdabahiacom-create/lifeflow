/**
 * Datas de calendário como texto `YYYY-MM-DD` (sem fuso). Todo cálculo usa UTC apenas como
 * calculadora de calendário, então não há deslocamento por horário de verão.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_YEAR = 1900;
const MAX_YEAR = 2200;

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parts(value: string): [number, number, number] {
  const match = DATE_RE.exec(value);
  if (!match) throw new Error(`Data inválida: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function format(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function isValidDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

export function addDays(value: string, days: number): string {
  const [year, month, day] = parts(value);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return format(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** Soma meses mantendo o dia original, limitado ao último dia do mês (31/jan + 1 mês = 28 ou 29/fev). */
export function addMonthsClamped(value: string, months: number): string {
  const [year, month, day] = parts(value);
  const total = year * 12 + (month - 1) + months;
  const newYear = Math.floor(total / 12);
  const newMonth = (total % 12) + 1;
  return format(newYear, newMonth, Math.min(day, daysInMonth(newYear, newMonth)));
}

export function monthBounds(value: string): { from: string; to: string } {
  const [year, month] = parts(value);
  return { from: format(year, month, 1), to: format(year, month, daysInMonth(year, month)) };
}

/** `YYYY-MM` de uma data. */
export function monthOf(value: string): string {
  return value.slice(0, 7);
}

/** Data de hoje no fuso informado (IANA). Fuso inválido cai para UTC. */
export function todayInTimeZone(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
