import { describe, expect, it } from "vitest";
import { groupByDate, monthWeeks, rangeFor, shiftCursor, weekStart } from "./calendar";

describe("calendário", () => {
  it("a semana começa no domingo", () => {
    expect(weekStart("2026-11-09")).toBe("2026-11-08"); // segunda → domingo anterior
    expect(weekStart("2026-11-08")).toBe("2026-11-08");
    expect(rangeFor("week", "2026-11-14")).toEqual({ from: "2026-11-08", to: "2026-11-14" });
  });
  it("o mês carrega a grade completa, com os dias das semanas parciais", () => {
    // Novembro de 2026 começa num domingo e termina numa segunda.
    expect(rangeFor("month", "2026-11-15")).toEqual({ from: "2026-11-01", to: "2026-12-05" });
    const weeks = monthWeeks("2026-11-15");
    expect(weeks).toHaveLength(5);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0]?.[0]).toBe("2026-11-01");
    expect(weeks[4]?.[6]).toBe("2026-12-05");
  });
  it("mês que cruza o ano e fevereiro bissexto", () => {
    expect(rangeFor("month", "2027-01-10")).toEqual({ from: "2026-12-27", to: "2027-02-06" });
    expect(monthWeeks("2028-02-10").flat()).toContain("2028-02-29");
  });
  it("navega por dia, semana, mês e lista", () => {
    expect(shiftCursor("day", "2026-11-09", 1)).toBe("2026-11-10");
    expect(shiftCursor("week", "2026-11-09", -1)).toBe("2026-11-02");
    expect(shiftCursor("month", "2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftCursor("month", "2026-01-15", -1)).toBe("2025-12-01");
    expect(shiftCursor("list", "2026-11-09", 1)).toBe("2026-12-09");
  });
  it("agrupa as ocorrências por data efetiva", () => {
    const groups = groupByDate([{ startDate: "2026-11-10" }, { startDate: "2026-11-10" }, { startDate: "2026-11-11" }] as never);
    expect([...groups.entries()].map(([d, l]) => [d, l.length])).toEqual([["2026-11-10", 2], ["2026-11-11", 1]]);
  });
});
