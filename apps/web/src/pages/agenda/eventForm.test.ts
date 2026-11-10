import type { CalendarEvent } from "@lifeflow/shared";
import { describe, expect, it } from "vitest";
import { buildChanges, buildCreateInput, emptyState, stateFromEvent } from "./eventForm";

const base = () => ({ ...emptyState("2026-11-10", "America/Sao_Paulo"), title: "Dentista" });

describe("formulário de evento", () => {
  it("monta o evento simples e converte o custo em centavos inteiros", () => {
    const r = buildCreateInput({ ...base(), cost: "1.234,50", reminders: [60, 10], location: " Clínica " });
    expect(r).toMatchObject({
      ok: true,
      value: {
        title: "Dentista",
        startDate: "2026-11-10",
        startTime: "09:00",
        durationMin: 60,
        estimatedCostCents: 123450,
        reminders: [10, 60],
        location: "Clínica",
        contact: null,
        recurrence: null,
        timeZone: "America/Sao_Paulo",
      },
    });
  });
  it("dia inteiro não envia horário e usa um dia de duração", () => {
    const r = buildCreateInput({ ...base(), allDay: true });
    expect(r).toMatchObject({ ok: true, value: { startTime: null, durationMin: 1440 } });
  });
  it("recorrência: semanal, personalizada, com data final e com contagem", () => {
    expect(buildCreateInput({ ...base(), repeat: "weekly", weekdays: [3, 1] })).toMatchObject({
      ok: true,
      value: { recurrence: { frequency: "weekly", interval: 1, weekdays: [1, 3], until: null, count: null } },
    });
    expect(buildCreateInput({ ...base(), repeat: "daily", interval: "2", endMode: "count", count: "5" })).toMatchObject({
      ok: true,
      value: { recurrence: { frequency: "daily", interval: 2, weekdays: [], count: 5 } },
    });
    expect(buildCreateInput({ ...base(), repeat: "monthly", endMode: "until", until: "2027-01-10" })).toMatchObject({
      ok: true,
      value: { recurrence: { until: "2027-01-10" } },
    });
  });
  it("rejeita entradas inválidas com mensagem clara", () => {
    const err = (over: object) => {
      const r = buildCreateInput({ ...base(), ...over });
      return r.ok ? null : r.error;
    };
    expect(err({ title: "  " })).toMatch(/título/i);
    expect(err({ duration: "0" })).toMatch(/duração/i);
    expect(err({ cost: "abc" })).toMatch(/custo/i);
    expect(err({ link: "javascript:alert(1)" })).toMatch(/link/i);
    expect(err({ repeat: "custom" })).toMatch(/dia da semana/i);
    expect(err({ repeat: "daily", interval: "0" })).toMatch(/intervalo/i);
    expect(err({ repeat: "daily", endMode: "until", until: "2026-01-01" })).toMatch(/anterior/i);
    expect(err({ repeat: "daily", endMode: "count", count: "0" })).toMatch(/quantidade/i);
  });
  it("em 'uma ocorrência' não envia fuso nem recorrência; nos outros escopos envia", () => {
    const state = { ...base(), repeat: "weekly" as const };
    const one = buildChanges(state, "one");
    expect(one.ok && "recurrence" in one.value).toBe(false);
    expect(one.ok && "timeZone" in one.value).toBe(false);
    const all = buildChanges(state, "all");
    expect(all).toMatchObject({ ok: true, value: { timeZone: "America/Sao_Paulo", recurrence: { frequency: "weekly" } } });
  });
  it("preenche o formulário a partir de uma série (ida e volta)", () => {
    const event: CalendarEvent = {
      id: "e1", uid: "u", title: "Aula", kind: "family", description: null, startDate: "2026-11-10", startTime: "18:30",
      durationMin: 90, timeZone: "Europe/Lisbon", location: "Sala 2", contact: null, link: null, notes: null,
      estimatedCostCents: 5005, reminders: [30], expenseTransactionId: null, createdAt: "", updatedAt: "",
      recurrence: { frequency: "custom", interval: 2, weekdays: [1, 3], until: null, count: 8 },
    };
    const state = stateFromEvent(event);
    expect(state).toMatchObject({ time: "18:30", duration: "90", cost: "50,05", repeat: "custom", interval: "2", endMode: "count", count: "8", weekdays: [1, 3] });
    const back = buildCreateInput(state);
    expect(back).toMatchObject({ ok: true, value: { estimatedCostCents: 5005, recurrence: { frequency: "custom", interval: 2, weekdays: [1, 3], count: 8 } } });
  });
});
