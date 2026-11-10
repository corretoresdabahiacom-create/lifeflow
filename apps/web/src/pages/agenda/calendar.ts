import { addDays, addMonthsClamped, monthBounds, type Occurrence } from "@lifeflow/shared";

export type CalendarView = "day" | "week" | "month" | "list";

export const VIEW_LABELS: Record<CalendarView, string> = {
  day: "Dia",
  week: "Semana",
  month: "Mês",
  list: "Lista",
};

const weekday = (date: string): number => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/** Domingo da semana da data (a semana começa no domingo, como no Brasil). */
export const weekStart = (date: string): string => addDays(date, -weekday(date));

/** Período a carregar para a visão. O mês inclui os dias das semanas parciais nas pontas da grade. */
export function rangeFor(view: CalendarView, cursor: string): { from: string; to: string } {
  switch (view) {
    case "day":
      return { from: cursor, to: cursor };
    case "week": {
      const from = weekStart(cursor);
      return { from, to: addDays(from, 6) };
    }
    case "month": {
      const { from, to } = monthBounds(cursor);
      return { from: weekStart(from), to: addDays(weekStart(to), 6) };
    }
    case "list":
      return { from: cursor, to: addDays(cursor, 59) };
  }
}

export function shiftCursor(view: CalendarView, cursor: string, direction: 1 | -1): string {
  switch (view) {
    case "day":
      return addDays(cursor, direction);
    case "week":
      return addDays(cursor, 7 * direction);
    case "month":
      return addMonthsClamped(monthBounds(cursor).from, direction);
    case "list":
      return addDays(cursor, 30 * direction);
  }
}

/** Semanas (7 datas cada) da grade do mês. */
export function monthWeeks(cursor: string): string[][] {
  const { from, to } = rangeFor("month", cursor);
  const weeks: string[][] = [];
  for (let start = from; start <= to; start = addDays(start, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(start, i)));
  }
  return weeks;
}

export function groupByDate(occurrences: readonly Occurrence[]): Map<string, Occurrence[]> {
  const groups = new Map<string, Occurrence[]>();
  for (const occurrence of occurrences) {
    const list = groups.get(occurrence.startDate) ?? [];
    list.push(occurrence);
    groups.set(occurrence.startDate, list);
  }
  return groups;
}

const dateFromText = (date: string): Date => new Date(`${date}T12:00:00`);

export const dayLabel = (date: string): string =>
  dateFromText(date).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });

export function titleFor(view: CalendarView, cursor: string): string {
  if (view === "month") return dateFromText(cursor).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  if (view === "day") return dayLabel(cursor);
  const { from, to } = rangeFor(view, cursor);
  const short = (d: string) => dateFromText(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
  return `${short(from)} – ${short(to)}`;
}
