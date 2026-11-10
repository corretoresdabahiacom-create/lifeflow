import type { AppNotification, CalendarEvent, Occurrence, Task } from "@lifeflow/shared";
import { beforeAll, describe, expect, it } from "vitest";
import type { Client, World } from "./finance.suite";
import { makeSigner, type Clock, type Signer } from "./helpers";

/**
 * Suíte da agenda (Fase 3). Mesmo código contra o Firestore falso (`pnpm test`) e contra o
 * emulador real com as Security Rules reais (`pnpm test:integration`, na CI).
 * Relógio dos testes: 2026-11-09 12:00 UTC = 09:00 em São Paulo (segunda-feira).
 */

export type AgendaWorld = World & { clock: Clock };

const START = new Date("2026-11-09T12:00:00.000Z");

interface ListReply {
  occurrences: Occurrence[];
  conflictCount: number;
}
interface ConflictReply {
  hasConflicts: boolean;
  conflicts: Array<{ startDate: string; with: Array<{ eventId: string; title: string }> }>;
}

export function defineAgendaSuite(
  title: string,
  makeWorld: (signer: Signer) => AgendaWorld | Promise<AgendaWorld>,
  options: { fake: boolean },
): void {
  describe(title, () => {
    let signer: Signer;
    beforeAll(async () => {
      signer = await makeSigner("k1");
    });
    const world = async () => {
      const w = await makeWorld(signer);
      w.clock.now = START;
      return w;
    };

    const eventBody = (over: Record<string, unknown> = {}) => ({
      title: "Reunião",
      startDate: "2026-11-10",
      startTime: "10:00",
      durationMin: 60,
      ...over,
    });
    const newEvent = async (c: Client, over: Record<string, unknown> = {}) => {
      const r = await c.post("/v1/events", eventBody(over));
      expect(r.status, r.text).toBe(201);
      return r.body as unknown as CalendarEvent & { conflicts: unknown[] };
    };
    const occurrences = async (c: Client, from: string, to: string, extra = "") =>
      (await c.get(`/v1/events?from=${from}&to=${to}${extra}`)).body as unknown as ListReply;
    const titlesByDate = (list: ListReply) => list.occurrences.map((o) => `${o.startDate} ${o.startTime} ${o.title}`);
    const del = (c: Client, path: string) => c.send("DELETE", path);
    const code = (r: { body: Record<string, unknown> }) => (r.body["error"] as { code: string } | undefined)?.code;
    const generate = async (c: Client) => {
      const r = await c.post("/v1/notifications/generate", {}, null);
      expect(r.status, r.text).toBe(200);
      return r.body as unknown as { created: number; notifications: AppNotification[] };
    };
    const inbox = async (c: Client) =>
      (await c.get("/v1/notifications")).body as unknown as { notifications: AppNotification[]; unreadCount: number };

    // ------------------------------------------------------------ eventos: criar, editar, excluir
    it("cria evento com todos os campos e lê de volta (fuso padrão do perfil)", async () => {
      const { A } = await world();
      const created = await newEvent(A, {
        title: "Consulta",
        kind: "medical",
        description: "Retorno",
        location: "Clínica Central",
        contact: "Dra. Lúcia",
        link: "https://exemplo.com/consulta",
        notes: "Levar exames",
        estimatedCostCents: 25_000,
        reminders: [60, 1440],
      });
      expect(created).toMatchObject({
        kind: "medical",
        timeZone: "America/Sao_Paulo",
        estimatedCostCents: 25_000,
        reminders: [60, 1440],
        recurrence: null,
        expenseTransactionId: null,
      });
      const read = await A.get(`/v1/events/${created.id}`);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ title: "Consulta", contact: "Dra. Lúcia", link: "https://exemplo.com/consulta" });
      expect(read.body).not.toHaveProperty("requestHash");
    });

    it("valida a entrada: campo desconhecido, fuso, horário e link inválidos", async () => {
      const { A } = await world();
      for (const bad of [
        { uid: "outro" },
        { timeZone: "Marte/Olimpo" },
        { startTime: "25:00" },
        { link: "javascript:alert(1)" },
        { startDate: "2026-02-30" },
        { recurrence: { frequency: "custom" } },
      ]) {
        const r = await A.post("/v1/events", eventBody(bad));
        expect(r.status, JSON.stringify(bad)).toBe(400);
      }
    });

    it("idempotência: a mesma chave não cria dois eventos; conteúdo diferente é rejeitado", async () => {
      const { A } = await world();
      const first = await A.post("/v1/events", eventBody(), "evt-key-0001");
      const again = await A.post("/v1/events", eventBody(), "evt-key-0001");
      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect(again.headers.get("Idempotent-Replay")).toBe("true");
      expect(again.body["id"]).toBe(first.body["id"]);
      expect((await occurrences(A, "2026-11-10", "2026-11-10")).occurrences).toHaveLength(1);
      const reuse = await A.post("/v1/events", eventBody({ title: "Outro" }), "evt-key-0001");
      expect(reuse.status).toBe(422);
      expect(code(reuse)).toBe("idempotency_key_reuse");
      expect((await A.post("/v1/events", eventBody(), null)).status).toBe(400);
    });

    it("edita um evento simples", async () => {
      const { A } = await world();
      const e = await newEvent(A);
      const r = await A.patch(`/v1/events/${e.id}`, { changes: { title: "Reunião de equipe", startTime: "14:30", location: null } });
      expect(r.status, r.text).toBe(200);
      const list = await occurrences(A, "2026-11-10", "2026-11-10");
      expect(titlesByDate(list)).toEqual(["2026-11-10 14:30 Reunião de equipe"]);
      expect((await A.patch(`/v1/events/${e.id}`, { changes: {} })).status).toBe(400);
      expect((await A.patch(`/v1/events/${e.id}`, { changes: { uid: "x" } })).status).toBe(400);
    });

    it("evento de dia inteiro: sem horário, duração de um dia", async () => {
      const { A } = await world();
      const e = await newEvent(A, { title: "Feriado", startTime: null, kind: "other" });
      expect(e.durationMin).toBe(1440);
      const [o] = (await occurrences(A, "2026-11-10", "2026-11-10")).occurrences;
      expect(o).toMatchObject({ allDay: true, startTime: null });
    });

    it("exclui um evento; depois ele não existe mais", async () => {
      const { A } = await world();
      const e = await newEvent(A);
      const gone = await del(A, `/v1/events/${e.id}`);
      expect(gone.status).toBe(200);
      expect((await A.get(`/v1/events/${e.id}`)).status).toBe(404);
      expect((await occurrences(A, "2026-11-01", "2026-11-30")).occurrences).toHaveLength(0);
      expect((await del(A, `/v1/events/${e.id}`)).status).toBe(404);
    });

    it("visões dia, semana, mês e lista vêm da mesma consulta por período", async () => {
      const { A } = await world();
      await newEvent(A, { title: "Segunda", startDate: "2026-11-09" });
      await newEvent(A, { title: "Quarta", startDate: "2026-11-11", kind: "family" });
      await newEvent(A, { title: "Fim do mês", startDate: "2026-11-30" });
      await newEvent(A, { title: "Dezembro", startDate: "2026-12-02" });
      expect((await occurrences(A, "2026-11-09", "2026-11-09")).occurrences).toHaveLength(1);
      expect((await occurrences(A, "2026-11-09", "2026-11-15")).occurrences).toHaveLength(2);
      expect((await occurrences(A, "2026-11-01", "2026-11-30")).occurrences).toHaveLength(3);
      expect((await occurrences(A, "2026-11-01", "2026-12-31")).occurrences).toHaveLength(4);
      expect((await occurrences(A, "2026-11-01", "2026-11-30", "&kind=family")).occurrences.map((o) => o.title)).toEqual(["Quarta"]);
      expect((await A.get("/v1/events?from=2026-11-30&to=2026-11-01")).status).toBe(400);
      expect((await A.get("/v1/events?from=2026-01-01&to=2027-12-31")).status).toBe(400);
      expect((await A.get("/v1/events?kind=invalido")).status).toBe(400);
    });

    // ------------------------------------------------------------ conflitos
    it("checklist: eventos sobrepostos geram alerta, mas não são impedidos", async () => {
      const { A } = await world();
      const first = await newEvent(A, { title: "Dentista", startTime: "10:00", durationMin: 60 });
      expect(first.conflicts).toEqual([]);

      const second = await A.post("/v1/events", eventBody({ title: "Reunião", startTime: "10:30", durationMin: 60 }));
      expect(second.status).toBe(201); // não bloqueia
      const alert = second.body["conflicts"] as Array<{ with: Array<{ title: string }> }>;
      expect(alert).toHaveLength(1);
      expect(alert[0]?.with.map((w) => w.title)).toEqual(["Dentista"]);

      const list = await occurrences(A, "2026-11-10", "2026-11-10");
      expect(list.conflictCount).toBe(2);
      expect(list.occurrences.every((o) => o.conflictsWith.length === 1)).toBe(true);
      expect((await occurrences(A, "2026-11-10", "2026-11-10", "&conflicts=true")).occurrences).toHaveLength(2);
    });

    it("encostar (fim = início) e dia inteiro não são conflito", async () => {
      const { A } = await world();
      await newEvent(A, { title: "A", startTime: "10:00", durationMin: 60 });
      const touching = await newEvent(A, { title: "B", startTime: "11:00", durationMin: 30 });
      const allDay = await newEvent(A, { title: "Dia inteiro", startTime: null });
      expect(touching.conflicts).toEqual([]);
      expect(allDay.conflicts).toEqual([]);
      expect((await occurrences(A, "2026-11-10", "2026-11-10")).conflictCount).toBe(0);
    });

    it("check-conflicts avisa antes de criar e ignora o próprio evento ao editar", async () => {
      const { A } = await world();
      const existing = await newEvent(A, { title: "Almoço", startTime: "12:00", durationMin: 90 });
      const probe = { startDate: "2026-11-10", startTime: "12:30", durationMin: 30 };
      const r = await A.post("/v1/events/check-conflicts", probe, null);
      expect(r.status).toBe(200);
      const body = r.body as unknown as ConflictReply;
      expect(body.hasConflicts).toBe(true);
      expect(body.conflicts[0]?.with[0]?.title).toBe("Almoço");
      const own = await A.post("/v1/events/check-conflicts", { ...probe, excludeEventId: existing.id }, null);
      expect((own.body as unknown as ConflictReply).hasConflicts).toBe(false);
      const none = await A.post("/v1/events/check-conflicts", { ...probe, startTime: "15:00" }, null);
      expect((none.body as unknown as ConflictReply).hasConflicts).toBe(false);
      expect((await A.post("/v1/events/check-conflicts", { startDate: "2026-11-10" }, null)).status).toBe(400);
    });

    it("conflitos de uma série recorrente aparecem nas datas em que ocorrem", async () => {
      const { A } = await world();
      await newEvent(A, { title: "Aula", startDate: "2026-11-10", startTime: "10:00", recurrence: { frequency: "weekly" } });
      const r = await A.post("/v1/events/check-conflicts", { startDate: "2026-11-17", startTime: "10:15", durationMin: 30 }, null);
      expect((r.body as unknown as ConflictReply).conflicts.map((c) => c.startDate)).toEqual(["2026-11-17"]);
    });

    // ------------------------------------------------------------ fuso horário
    it("fuso horário: o mesmo horário de parede em fusos diferentes não conflita; o mesmo instante conflita", async () => {
      const { A } = await world();
      await newEvent(A, { title: "SP 10h", startTime: "10:00", timeZone: "America/Sao_Paulo" });
      const ny = await newEvent(A, { title: "NY 10h", startTime: "10:00", timeZone: "America/New_York" });
      expect(ny.conflicts).toEqual([]);
      const sameInstant = await newEvent(A, { title: "NY 08h", startTime: "08:00", timeZone: "America/New_York" });
      expect(sameInstant.conflicts).toHaveLength(1); // 08:00 em Nova York (UTC-5) = 10:00 em São Paulo (UTC-3)... em novembro: UTC-5 vs UTC-3
    });

    it("fuso horário: instantes UTC corretos e horário local mantido ao cruzar o horário de verão", async () => {
      const { A } = await world();
      await newEvent(A, {
        title: "Semanal NY",
        startDate: "2027-03-02",
        startTime: "09:00",
        timeZone: "America/New_York",
        recurrence: { frequency: "weekly" },
      });
      const list = await occurrences(A, "2027-03-02", "2027-03-16");
      // A mudança para o horário de verão nos EUA foi em 14/03/2027.
      expect(list.occurrences.map((o) => o.startUtc)).toEqual([
        "2027-03-02T14:00:00.000Z",
        "2027-03-09T14:00:00.000Z",
        "2027-03-16T13:00:00.000Z",
      ]);
      expect(list.occurrences.every((o) => o.startTime === "09:00")).toBe(true);
    });

    it("usa o fuso do perfil quando o evento não informa um", async () => {
      const { A } = await world();
      await A.send("PUT", "/v1/profile", { displayName: "Ana", locale: "pt-BR", timezone: "Asia/Tokyo", currency: "BRL" });
      const e = await newEvent(A);
      expect(e.timeZone).toBe("Asia/Tokyo");
      const [o] = (await occurrences(A, "2026-11-10", "2026-11-10")).occurrences;
      expect(o?.startUtc).toBe("2026-11-10T01:00:00.000Z");
    });

    // ------------------------------------------------------------ recorrência
    it("recorrências diária, semanal, mensal, anual e personalizada", async () => {
      const { A } = await world();
      await newEvent(A, { title: "Diária", startDate: "2026-11-10", recurrence: { frequency: "daily", interval: 2, count: 3 } });
      await newEvent(A, { title: "Semanal", startDate: "2026-11-10", recurrence: { frequency: "weekly", until: "2026-11-24" } });
      await newEvent(A, { title: "Mensal", startDate: "2026-01-31", recurrence: { frequency: "monthly" } });
      await newEvent(A, { title: "Anual", startDate: "2024-02-29", recurrence: { frequency: "yearly" } });
      await newEvent(A, {
        title: "Custom",
        startDate: "2026-11-10",
        recurrence: { frequency: "custom", interval: 2, weekdays: [1, 3] },
      });
      const nov = await occurrences(A, "2026-11-01", "2026-11-30");
      const by = (t: string) => nov.occurrences.filter((o) => o.title === t).map((o) => o.startDate);
      expect(by("Diária")).toEqual(["2026-11-10", "2026-11-12", "2026-11-14"]);
      expect(by("Semanal")).toEqual(["2026-11-10", "2026-11-17", "2026-11-24"]);
      expect(by("Mensal")).toEqual(["2026-11-30"]); // 31/jan → 30/nov (último dia do mês)
      expect(by("Anual")).toEqual([]);
      expect(by("Custom")).toEqual(["2026-11-11", "2026-11-23", "2026-11-25"]);
      const feb = await occurrences(A, "2027-02-01", "2027-02-28");
      expect(feb.occurrences.filter((o) => o.title === "Mensal").map((o) => o.startDate)).toEqual(["2027-02-28"]);
      expect(feb.occurrences.filter((o) => o.title === "Anual").map((o) => o.startDate)).toEqual(["2027-02-28"]);
    });

    it("checklist: edita apenas UMA ocorrência e as demais permanecem corretas", async () => {
      const { A } = await world();
      const series = await newEvent(A, { title: "Aula", startDate: "2026-11-10", startTime: "10:00", recurrence: { frequency: "weekly" } });
      const patch = await A.patch(`/v1/events/${series.id}`, {
        scope: "one",
        occurrenceDate: "2026-11-17",
        changes: { title: "Aula especial", startTime: "15:00", location: "Auditório" },
      });
      expect(patch.status, patch.text).toBe(200);
      expect((patch.body["occurrence"] as Occurrence).modified).toBe(true);

      const list = await occurrences(A, "2026-11-01", "2026-12-06");
      expect(titlesByDate(list)).toEqual([
        "2026-11-10 10:00 Aula",
        "2026-11-17 15:00 Aula especial",
        "2026-11-24 10:00 Aula",
        "2026-12-01 10:00 Aula",
      ]);
      expect(list.occurrences.map((o) => o.location)).toEqual([null, "Auditório", null, null]);
      // A série em si não mudou.
      expect((await A.get(`/v1/events/${series.id}`)).body).toMatchObject({ title: "Aula", startTime: "10:00" });
      // Editar a mesma ocorrência de novo acumula sobre a exceção.
      await A.patch(`/v1/events/${series.id}`, { scope: "one", occurrenceDate: "2026-11-17", changes: { durationMin: 30 } });
      const again = (await occurrences(A, "2026-11-17", "2026-11-17")).occurrences[0];
      expect(again).toMatchObject({ title: "Aula especial", startTime: "15:00", durationMin: 30 });
    });

    it("mover uma ocorrência de dia e exigir uma data de ocorrência válida", async () => {
      const { A } = await world();
      const series = await newEvent(A, { title: "Yoga", startDate: "2026-11-10", recurrence: { frequency: "weekly" } });
      await A.patch(`/v1/events/${series.id}`, { scope: "one", occurrenceDate: "2026-11-17", changes: { startDate: "2026-11-19" } });
      const list = await occurrences(A, "2026-11-10", "2026-11-24");
      expect(list.occurrences.map((o) => o.startDate)).toEqual(["2026-11-10", "2026-11-19", "2026-11-24"]);

      const missing = await A.patch(`/v1/events/${series.id}`, { scope: "one", changes: { title: "x" } });
      expect(missing.status).toBe(400);
      expect(code(missing)).toBe("occurrence_required");
      const invalid = await A.patch(`/v1/events/${series.id}`, { scope: "one", occurrenceDate: "2026-11-18", changes: { title: "x" } });
      expect(invalid.status).toBe(422);
      expect(code(invalid)).toBe("invalid_occurrence");
      const forbidden = await A.patch(`/v1/events/${series.id}`, {
        scope: "one",
        occurrenceDate: "2026-11-17",
        changes: { recurrence: null },
      });
      expect(forbidden.status).toBe(422);
    });

    it("exclui apenas uma ocorrência; as outras continuam", async () => {
      const { A } = await world();
      const series = await newEvent(A, { title: "Pilates", startDate: "2026-11-10", recurrence: { frequency: "weekly" } });
      const r = await del(A, `/v1/events/${series.id}?scope=one&occurrenceDate=2026-11-17`);
      expect(r.status, r.text).toBe(200);
      expect((await occurrences(A, "2026-11-10", "2026-12-01")).occurrences.map((o) => o.startDate)).toEqual([
        "2026-11-10",
        "2026-11-24",
        "2026-12-01",
      ]);
      // Repetir a exclusão da mesma ocorrência é inofensivo.
      expect((await del(A, `/v1/events/${series.id}?scope=one&occurrenceDate=2026-11-17`)).status).toBe(200);
      expect((await del(A, `/v1/events/${series.id}?scope=one`)).status).toBe(400);
    });

    it("esta e as próximas: divide a série; o passado fica intacto", async () => {
      const { A } = await world();
      const series = await newEvent(A, { title: "Curso", startDate: "2026-11-10", startTime: "19:00", recurrence: { frequency: "weekly" } });
      // Uma ocorrência já editada, depois da divisão, acompanha a parte nova.
      await A.patch(`/v1/events/${series.id}`, { scope: "one", occurrenceDate: "2026-12-01", changes: { location: "Sala 2" } });
      const r = await A.patch(`/v1/events/${series.id}`, {
        scope: "following",
        occurrenceDate: "2026-11-24",
        changes: { startTime: "20:00", title: "Curso (noite)" },
      });
      expect(r.status, r.text).toBe(200);
      const created = r.body["event"] as CalendarEvent;
      expect(created.startDate).toBe("2026-11-24");
      expect(created.id).not.toBe(series.id);

      const list = await occurrences(A, "2026-11-01", "2026-12-08");
      expect(list.occurrences.map((o) => `${o.startDate} ${o.startTime} ${o.title} ${o.location ?? "-"}`)).toEqual([
        "2026-11-10 19:00 Curso -",
        "2026-11-17 19:00 Curso -",
        "2026-11-24 20:00 Curso (noite) -",
        "2026-12-01 20:00 Curso (noite) Sala 2",
        "2026-12-08 20:00 Curso (noite) -",
      ]);
      // Nenhuma ocorrência duplicada no ponto de corte.
      expect(new Set(list.occurrences.map((o) => o.startDate)).size).toBe(list.occurrences.length);
      expect((await A.get(`/v1/events/${series.id}`)).body["recurrence"]).toMatchObject({ until: "2026-11-23" });
    });

    it("esta e as próximas em série com contagem: o total de ocorrências é preservado", async () => {
      const { A } = await world();
      const series = await newEvent(A, { title: "Sessão", startDate: "2026-11-10", recurrence: { frequency: "weekly", count: 5 } });
      await A.patch(`/v1/events/${series.id}`, { scope: "following", occurrenceDate: "2026-11-24", changes: { startTime: "11:00" } });
      const list = await occurrences(A, "2026-11-01", "2027-03-01");
      expect(list.occurrences.map((o) => `${o.startDate} ${o.startTime}`)).toEqual([
        "2026-11-10 10:00",
        "2026-11-17 10:00",
        "2026-11-24 11:00",
        "2026-12-01 11:00",
        "2026-12-08 11:00",
      ]);
    });

    it("toda a série: a mudança vale para todas, e a data inicial pode ser movida", async () => {
      const { A } = await world();
      const series = await newEvent(A, { title: "Treino", startDate: "2026-11-10", recurrence: { frequency: "weekly" } });
      await A.patch(`/v1/events/${series.id}`, { scope: "one", occurrenceDate: "2026-11-17", changes: { location: "Praia" } });
      await A.patch(`/v1/events/${series.id}`, { scope: "all", changes: { title: "Treino funcional", durationMin: 45 } });
      let list = await occurrences(A, "2026-11-10", "2026-11-24");
      expect(list.occurrences.map((o) => [o.title, o.durationMin, o.location])).toEqual([
        ["Treino funcional", 45, null],
        ["Treino funcional", 45, "Praia"], // a exceção mantém só o que sobrescreveu
        ["Treino funcional", 45, null],
      ]);
      // Mudar o calendário (data inicial) descarta as exceções presas às datas antigas.
      await A.patch(`/v1/events/${series.id}`, { scope: "all", changes: { startDate: "2026-11-11" } });
      list = await occurrences(A, "2026-11-10", "2026-11-24");
      expect(list.occurrences.map((o) => [o.startDate, o.location])).toEqual([
        ["2026-11-11", null],
        ["2026-11-18", null],
      ]);
    });

    it("exclui esta e as próximas, e depois a série inteira", async () => {
      const { A } = await world();
      const series = await newEvent(A, { title: "Terapia", startDate: "2026-11-10", recurrence: { frequency: "weekly" } });
      expect((await del(A, `/v1/events/${series.id}?scope=following&occurrenceDate=2026-11-24`)).status).toBe(200);
      expect((await occurrences(A, "2026-11-01", "2027-01-31")).occurrences.map((o) => o.startDate)).toEqual(["2026-11-10", "2026-11-17"]);
      expect((await del(A, `/v1/events/${series.id}?scope=all`)).status).toBe(200);
      expect((await A.get(`/v1/events/${series.id}`)).status).toBe(404);
      expect((await occurrences(A, "2026-11-01", "2027-01-31")).occurrences).toHaveLength(0);
    });

    it("excluir a série apaga também as exceções (não reaparecem se o id for reaproveitado)", async () => {
      const { A } = await world();
      const series = await newEvent(A, { title: "Pagamento", startDate: "2026-11-10", recurrence: { frequency: "weekly" } });
      await A.patch(`/v1/events/${series.id}`, { scope: "one", occurrenceDate: "2026-11-17", changes: { title: "Mudou" } });
      await del(A, `/v1/events/${series.id}?scope=all`);
      expect((await occurrences(A, "2026-11-01", "2026-12-31")).occurrences).toHaveLength(0);
    });

    // ------------------------------------------------------------ agenda × finanças (D6)
    it("custo previsto NÃO vira despesa sozinho; só a ação explícita gera a despesa vinculada", async () => {
      const { A } = await world();
      const account = (await A.post("/v1/accounts", { name: "Conta", type: "checking", initialBalanceCents: 100_000 })).body as { id: string };
      const e = await newEvent(A, { title: "Show", startDate: "2026-11-09", estimatedCostCents: 15_000 });
      let balance = ((await A.get("/v1/accounts")).body as { totalBalanceCents: number }).totalBalanceCents;
      expect(balance).toBe(100_000); // criar o evento não mexe no saldo
      expect(((await A.get("/v1/transactions?from=2026-11-01&to=2026-11-30")).body as { items: unknown[] }).items).toHaveLength(0);

      const r = await A.post(`/v1/events/${e.id}/expense`, { accountId: account.id }, "exp-key-0001");
      expect(r.status, r.text).toBe(201);
      expect(r.body).toMatchObject({ type: "expense", amountCents: 15_000, description: "Show", status: "posted" });
      balance = ((await A.get("/v1/accounts")).body as { totalBalanceCents: number }).totalBalanceCents;
      expect(balance).toBe(85_000);
      expect((await A.get(`/v1/events/${e.id}`)).body["expenseTransactionId"]).toBe(r.body["id"]);

      // Repetição com a mesma chave: sem segunda despesa.
      const again = await A.post(`/v1/events/${e.id}/expense`, { accountId: account.id }, "exp-key-0001");
      expect(again.status).toBe(200);
      expect(again.headers.get("Idempotent-Replay")).toBe("true");
      // Outra chave: o evento já tem despesa vinculada.
      const other = await A.post(`/v1/events/${e.id}/expense`, { accountId: account.id }, "exp-key-0002");
      expect(other.status).toBe(409);
      expect(code(other)).toBe("expense_already_linked");
      expect(((await A.get("/v1/transactions?from=2026-11-01&to=2026-11-30")).body as { items: unknown[] }).items).toHaveLength(1);
      expect(((await A.get("/v1/accounts")).body as { totalBalanceCents: number }).totalBalanceCents).toBe(85_000);
      expect(((await A.get("/v1/reconcile")).body as { ok: boolean }).ok).toBe(true);
    });

    it("despesa do evento: valor informado, ocorrência de série e erros", async () => {
      const { A } = await world();
      const account = (await A.post("/v1/accounts", { name: "Conta", type: "checking", initialBalanceCents: 50_000 })).body as { id: string };
      const noCost = await newEvent(A, { title: "Passeio", startDate: "2026-11-09" });
      expect((await A.post(`/v1/events/${noCost.id}/expense`, { accountId: account.id }, "exp-key-0010")).status).toBe(422);
      const ok = await A.post(`/v1/events/${noCost.id}/expense`, { accountId: account.id, amountCents: 3000, date: "2026-11-09" }, "exp-key-0011");
      expect(ok.status).toBe(201);

      const series = await newEvent(A, { title: "Aula", startDate: "2026-11-10", estimatedCostCents: 5000, recurrence: { frequency: "weekly" } });
      expect((await A.post(`/v1/events/${series.id}/expense`, { accountId: account.id }, "exp-key-0012")).status).toBe(400);
      const one = await A.post(`/v1/events/${series.id}/expense`, { accountId: account.id, occurrenceDate: "2026-11-17" }, "exp-key-0013");
      expect(one.status).toBe(201);
      const twice = await A.post(`/v1/events/${series.id}/expense`, { accountId: account.id, occurrenceDate: "2026-11-17" }, "exp-key-0014");
      expect(twice.status).toBe(409);
      // Outra ocorrência da mesma série ainda pode gerar a sua despesa.
      expect((await A.post(`/v1/events/${series.id}/expense`, { accountId: account.id, occurrenceDate: "2026-11-24" }, "exp-key-0015")).status).toBe(201);
      expect((await A.post(`/v1/events/${series.id}/expense`, { accountId: "nao-existe", occurrenceDate: "2026-12-01" }, "exp-key-0016")).status).toBe(404);
      expect(((await A.get("/v1/reconcile")).body as { ok: boolean }).ok).toBe(true);
    });

    // ------------------------------------------------------------ tarefas
    const newTask = async (c: Client, over: Record<string, unknown> = {}) => {
      const r = await c.post("/v1/tasks", { title: "Pagar IPTU", ...over });
      expect(r.status, r.text).toBe(201);
      return r.body as unknown as Task;
    };

    it("tarefas: cria, edita, conclui (idempotente), reabre e exclui", async () => {
      const { A } = await world();
      const task = await newTask(A, { priority: "high", dueDate: "2026-11-12", dueTime: "09:00", description: "Boleto" });
      expect(task).toMatchObject({ status: "pending", priority: "high", completedAt: null, overdue: false });
      const edited = await A.patch(`/v1/tasks/${task.id}`, { title: "Pagar IPTU 2026", status: "in_progress", priority: "urgent" });
      expect(edited.body).toMatchObject({ title: "Pagar IPTU 2026", status: "in_progress", priority: "urgent" });

      const done = await A.post(`/v1/tasks/${task.id}/complete`, {}, null);
      expect(done.body).toMatchObject({ status: "completed" });
      const completedAt = done.body["completedAt"];
      expect(typeof completedAt).toBe("string");
      const doneAgain = await A.post(`/v1/tasks/${task.id}/complete`, {}, null);
      expect(doneAgain.body["completedAt"]).toBe(completedAt); // não regravou

      const reopened = await A.patch(`/v1/tasks/${task.id}`, { status: "pending" });
      expect(reopened.body).toMatchObject({ status: "pending", completedAt: null });
      expect((await del(A, `/v1/tasks/${task.id}`)).status).toBe(200);
      expect((await A.get(`/v1/tasks/${task.id}`)).status).toBe(404);
    });

    it("tarefas: validação (hora e lembrete exigem prazo, campos desconhecidos, prioridade)", async () => {
      const { A } = await world();
      for (const bad of [
        { dueTime: "10:00" },
        { reminderMinutes: 10 },
        { priority: "critica" },
        { status: "completed" },
        { uid: "x" },
        { title: "" },
      ]) {
        expect((await A.post("/v1/tasks", { title: "x", ...bad })).status, JSON.stringify(bad)).toBe(400);
      }
      const task = await newTask(A);
      expect((await A.patch(`/v1/tasks/${task.id}`, { dueTime: "10:00" })).status).toBe(422);
    });

    it("tarefas: idempotência na criação", async () => {
      const { A } = await world();
      const a = await A.post("/v1/tasks", { title: "Ligar para o banco" }, "task-key-0001");
      const b = await A.post("/v1/tasks", { title: "Ligar para o banco" }, "task-key-0001");
      expect(b.status).toBe(200);
      expect(b.body["id"]).toBe(a.body["id"]);
      expect(((await A.get("/v1/tasks")).body as { total: number }).total).toBe(1);
      expect((await A.post("/v1/tasks", { title: "Outra" }, "task-key-0001")).status).toBe(422);
    });

    it("tarefas: atrasadas, filtros e ordenação", async () => {
      const { A } = await world(); // hoje = 2026-11-09, 09:00 em São Paulo
      await newTask(A, { title: "Ontem", dueDate: "2026-11-08", priority: "low" });
      await newTask(A, { title: "Hoje 08h", dueDate: "2026-11-09", dueTime: "08:00", priority: "urgent" });
      await newTask(A, { title: "Hoje sem hora", dueDate: "2026-11-09" });
      await newTask(A, { title: "Amanhã", dueDate: "2026-11-10", priority: "high" });
      await newTask(A, { title: "Sem prazo" });
      const done = await newTask(A, { title: "Feita", dueDate: "2026-11-01" });
      await A.post(`/v1/tasks/${done.id}/complete`, {}, null);

      const all = (await A.get("/v1/tasks")).body as unknown as { tasks: Task[]; total: number; overdueCount: number };
      expect(all.tasks.map((t) => t.title)).toEqual(["Ontem", "Hoje 08h", "Hoje sem hora", "Amanhã", "Sem prazo"]);
      expect(all.overdueCount).toBe(2);
      const overdue = (await A.get("/v1/tasks?overdue=true")).body as unknown as { tasks: Task[] };
      expect(overdue.tasks.map((t) => t.title)).toEqual(["Ontem", "Hoje 08h"]);
      expect(overdue.tasks.every((t) => t.overdue)).toBe(true);
      expect(((await A.get("/v1/tasks?priority=high")).body as unknown as { tasks: Task[] }).tasks.map((t) => t.title)).toEqual(["Amanhã"]);
      expect(((await A.get("/v1/tasks?status=completed")).body as unknown as { tasks: Task[] }).tasks.map((t) => t.title)).toEqual(["Feita"]);
      expect(((await A.get("/v1/tasks?includeDone=true")).body as unknown as { total: number }).total).toBe(6);
      expect(((await A.get("/v1/tasks?from=2026-11-10&to=2026-11-10")).body as unknown as { tasks: Task[] }).tasks.map((t) => t.title)).toEqual(["Amanhã"]);
      expect((await A.get("/v1/tasks?status=xyz")).status).toBe(400);
    });

    it("categorias de tarefa: cria, usa, arquiva e impede uso de categoria inexistente/arquivada", async () => {
      const { A } = await world();
      const category = (await A.post("/v1/task-categories", { name: "Casa" })).body as { id: string };
      const dup = await A.post("/v1/task-categories", { name: "Casa" }, "cat-key-0001");
      const dupAgain = await A.post("/v1/task-categories", { name: "Casa" }, "cat-key-0001");
      expect(dupAgain.body["id"]).toBe(dup.body["id"]);
      const task = await newTask(A, { categoryId: category.id });
      expect(task.categoryId).toBe(category.id);
      expect(((await A.get(`/v1/tasks?categoryId=${category.id}`)).body as unknown as { total: number }).total).toBe(1);
      expect((await A.post("/v1/tasks", { title: "x", categoryId: "nao-existe" })).status).toBe(404);
      await A.patch(`/v1/task-categories/${category.id}`, { archived: true });
      expect((await A.post("/v1/tasks", { title: "x", categoryId: category.id })).status).toBe(422);
      const listed = (await A.get("/v1/task-categories")).body as { categories: Array<{ id: string }> };
      expect(listed.categories.map((c) => c.id)).not.toContain(category.id);
    });

    // ------------------------------------------------------------ lembretes e notificações
    it("lembrete de evento: dispara no horário certo e NÃO duplica ao repetir a geração", async () => {
      const { A, clock } = await world();
      // 15:00 em São Paulo = 18:00 UTC; lembrete 30 min antes = 17:30 UTC.
      await newEvent(A, { title: "Consulta", startDate: "2026-11-09", startTime: "15:00", reminders: [30] });
      expect((await generate(A)).created).toBe(0); // ainda são 12:00 UTC

      clock.now = new Date("2026-11-09T17:35:00.000Z");
      const first = await generate(A);
      expect(first.created).toBe(1);
      expect(first.notifications[0]).toMatchObject({ type: "event_reminder", title: "Consulta", read: false, silent: false });

      expect((await generate(A)).created).toBe(0);
      expect((await generate(A)).created).toBe(0);
      expect((await inbox(A)).notifications).toHaveLength(1);
    });

    it("lembrete de evento: gerações simultâneas continuam sem duplicar", async () => {
      const { A, clock } = await world();
      await newEvent(A, { title: "Consulta", startDate: "2026-11-09", startTime: "15:00", reminders: [30, 5] });
      clock.now = new Date("2026-11-09T17:58:00.000Z");
      const replies = await Promise.all(Array.from({ length: 6 }, () => A.post("/v1/notifications/generate", {}, null)));
      expect(replies.every((r) => r.status === 200)).toBe(true);
      await generate(A); // completa o que a corrida deixou para depois, se for o caso
      const { notifications } = await inbox(A);
      expect(notifications).toHaveLength(2);
      expect(new Set(notifications.map((n) => n.id)).size).toBe(2);
    });

    it("lembrete de evento recorrente: um por ocorrência; ocorrência cancelada não notifica", async () => {
      const { A, clock } = await world();
      const series = await newEvent(A, {
        title: "Academia",
        startDate: "2026-11-09",
        startTime: "18:00",
        reminders: [60],
        recurrence: { frequency: "daily" },
      });
      await del(A, `/v1/events/${series.id}?scope=one&occurrenceDate=2026-11-10`);
      // 18:00 SP = 21:00 UTC; lembrete 60 min antes = 20:00 UTC. Às 20:30 UTC de 11/11 só o dia 11 está "no ar":
      // o dia 09 já terminou, o dia 10 foi cancelado e o dia 12 ainda não chegou na hora do lembrete.
      clock.now = new Date("2026-11-11T20:30:00.000Z");
      const r = await generate(A);
      expect(r.notifications.map((n) => n.occurrenceKey).sort()).toEqual(["2026-11-11@2026-11-11T18:00#60"]);
      expect((await generate(A)).created).toBe(0);
    });

    it("horário silencioso marca a notificação como silenciosa (padrão 22:00–07:00)", async () => {
      const { A, clock } = await world();
      // 06:30 em São Paulo = 09:30 UTC: dentro do horário silencioso. 12:00 locais = 15:00 UTC: fora.
      await newEvent(A, { title: "Voo", startDate: "2026-11-10", startTime: "06:30", reminders: [0] });
      await newEvent(A, { title: "Almoço", startDate: "2026-11-10", startTime: "12:00", reminders: [0] });
      clock.now = new Date("2026-11-10T09:45:00.000Z");
      const early = await generate(A);
      expect(early.notifications.map((n) => [n.title, n.silent])).toEqual([["Voo", true]]);
      clock.now = new Date("2026-11-10T15:30:00.000Z");
      const later = await generate(A);
      expect(later.notifications.map((n) => [n.title, n.silent])).toEqual([["Almoço", false]]);
    });

    it("respeita as preferências de horário silencioso do usuário", async () => {
      const { A, clock } = await world();
      await A.send("PUT", "/v1/preferences", { theme: "dark", confirmCreations: true, quietHoursStart: "11:00", quietHoursEnd: "13:00" });
      await newEvent(A, { title: "Almoço", startDate: "2026-11-10", startTime: "12:00", reminders: [0] });
      clock.now = new Date("2026-11-10T15:30:00.000Z"); // 12:30 locais, ainda dentro da janela do evento
      expect((await generate(A)).notifications[0]?.silent).toBe(true);
    });

    it("lembrete de tarefa e aviso de atraso: cada um uma única vez", async () => {
      const { A, clock } = await world();
      await newTask(A, { title: "Entregar relatório", dueDate: "2026-11-10", dueTime: "10:00", reminderMinutes: 60 });
      // Lembrete às 09:00 locais = 12:00 UTC.
      clock.now = new Date("2026-11-10T12:30:00.000Z");
      let r = await generate(A);
      expect(r.notifications.map((n) => n.type)).toEqual(["task_reminder"]);
      expect((await generate(A)).created).toBe(0);
      // Prazo (10:00 locais = 13:00 UTC) vencido.
      clock.now = new Date("2026-11-10T14:00:00.000Z");
      r = await generate(A);
      expect(r.notifications.map((n) => n.type)).toEqual(["task_overdue"]);
      clock.now = new Date("2026-11-10T20:00:00.000Z");
      expect((await generate(A)).created).toBe(0);
      expect((await inbox(A)).notifications).toHaveLength(2);
    });

    it("tarefa concluída ou cancelada não notifica", async () => {
      const { A, clock } = await world();
      const done = await newTask(A, { title: "Feita", dueDate: "2026-11-08" });
      await A.post(`/v1/tasks/${done.id}/complete`, {}, null);
      const canceled = await newTask(A, { title: "Cancelada", dueDate: "2026-11-08" });
      await A.patch(`/v1/tasks/${canceled.id}`, { status: "canceled" });
      clock.now = new Date("2026-11-09T15:00:00.000Z");
      expect((await generate(A)).created).toBe(0);
    });

    it("vencimento financeiro gera aviso de agenda SEM criar ou alterar nenhuma operação financeira", async () => {
      const { A } = await world();
      const account = (await A.post("/v1/accounts", { name: "Conta", type: "checking", initialBalanceCents: 100_000 })).body as { id: string };
      const payable = (await A.post("/v1/payables", { kind: "payable", description: "Conta de luz", amountCents: 18_990, dueDate: "2026-11-11", accountId: account.id })).body as { id: string };
      const paid = await A.post("/v1/payables", { kind: "payable", description: "Já paga", amountCents: 1000, dueDate: "2026-11-11" });
      await A.post(`/v1/payables/${paid.body["id"]}/pay`, { accountId: account.id }, "pay-key-0001");
      const before = JSON.stringify((await A.get("/v1/transactions?from=2026-11-01&to=2026-11-30")).body);

      const r = await generate(A);
      expect(r.notifications).toHaveLength(1);
      const [n] = r.notifications;
      expect(n).toMatchObject({ type: "payable_due", sourceType: "payable", sourceId: payable.id, title: "Conta de luz" });
      expect(n?.body).not.toMatch(/189|18\.990|R\$/); // sem valores financeiros no texto
      expect((await generate(A)).created).toBe(0);

      expect(JSON.stringify((await A.get("/v1/transactions?from=2026-11-01&to=2026-11-30")).body)).toBe(before);
      expect((await A.get(`/v1/payables/${payable.id}`)).body["status"]).toBe("open");
      expect(((await A.get("/v1/reconcile")).body as { ok: boolean }).ok).toBe(true);
    });

    it("lembretes avulsos: criar (idempotente), disparar uma vez e excluir", async () => {
      const { A, clock } = await world();
      const body = { title: "Ligar para a vovó", remindAt: "2026-11-09T15:00:00Z" };
      const a = await A.post("/v1/reminders", body, "rem-key-0001");
      const b = await A.post("/v1/reminders", body, "rem-key-0001");
      expect(a.status).toBe(201);
      expect(b.status).toBe(200);
      expect(b.body["id"]).toBe(a.body["id"]);
      expect(((await A.get("/v1/reminders")).body as { reminders: unknown[] }).reminders).toHaveLength(1);
      expect((await A.post("/v1/reminders", { title: "x", remindAt: "amanhã" })).status).toBe(400);
      expect((await generate(A)).created).toBe(0);
      clock.now = new Date("2026-11-09T15:01:00.000Z");
      expect((await generate(A)).notifications[0]).toMatchObject({ type: "reminder", title: "Ligar para a vovó" });
      expect((await generate(A)).created).toBe(0);
      expect((await del(A, `/v1/reminders/${a.body["id"]}`)).status).toBe(200);
      expect(((await A.get("/v1/reminders")).body as { reminders: unknown[] }).reminders).toHaveLength(0);
    });

    it("alterar o horário do evento gera lembrete novo; o antigo não se repete", async () => {
      const { A, clock } = await world();
      const e = await newEvent(A, { title: "Dentista", startDate: "2026-11-10", startTime: "10:00", reminders: [60] });
      clock.now = new Date("2026-11-10T12:30:00.000Z"); // 09:30 locais: lembrete das 09:00 já passou
      expect((await generate(A)).created).toBe(1);
      await A.patch(`/v1/events/${e.id}`, { changes: { startTime: "16:00" } });
      expect((await generate(A)).created).toBe(0); // novo lembrete só às 15:00 locais
      clock.now = new Date("2026-11-10T18:30:00.000Z"); // 15:30 locais
      expect((await generate(A)).created).toBe(1);
      expect((await inbox(A)).notifications).toHaveLength(2);
    });

    it("central de notificações: ler, ler todas, dispensar (e não voltar a gerar)", async () => {
      const { A, clock } = await world();
      for (const [i, time] of ["13:00", "14:00", "15:00"].entries()) {
        await newEvent(A, { title: `Evento ${i}`, startDate: "2026-11-09", startTime: time, reminders: [0] });
      }
      clock.now = new Date("2026-11-09T17:30:00.000Z"); // 14:30 locais: 13:00 e 14:00 já passaram; 15:00 ainda não
      await newEvent(A, { title: "Tarde", startDate: "2026-11-09", startTime: "16:00", reminders: [120] });
      const r = await generate(A);
      expect(r.created).toBe(2); // 13:00 já terminou; 14:00 está em curso; 15:00 ainda não; "Tarde" (lembrete às 14:00 locais) sim
      const list = await inbox(A);
      expect(list.unreadCount).toBe(list.notifications.length);

      const first = list.notifications[0] as AppNotification;
      const read = await A.post(`/v1/notifications/${first.id}/read`, {}, null);
      expect(read.body).toMatchObject({ read: true });
      const readAt = read.body["readAt"];
      expect((await A.post(`/v1/notifications/${first.id}/read`, {}, null)).body["readAt"]).toBe(readAt);
      expect((await inbox(A)).unreadCount).toBe(list.notifications.length - 1);

      const all = await A.post("/v1/notifications/read-all", {}, null);
      expect(all.status).toBe(200);
      expect((await inbox(A)).unreadCount).toBe(0);
      expect(((await A.get("/v1/notifications?unread=true")).body as { notifications: unknown[] }).notifications).toHaveLength(0);

      const target = list.notifications[1] as AppNotification;
      expect((await A.post(`/v1/notifications/${target.id}/dismiss`, {}, null)).status).toBe(200);
      expect((await inbox(A)).notifications.map((n) => n.id)).not.toContain(target.id);
      expect((await generate(A)).created).toBe(0); // dispensada não renasce
      expect((await A.post("/v1/notifications/inexistente/read", {}, null)).status).toBe(404);
    });

    // ------------------------------------------------------------ isolamento entre usuários
    it("isolamento: um usuário não vê, edita, exclui nem recebe notificação de outro", async () => {
      const { A, B, clock } = await world();
      const e = await newEvent(A, { title: "Segredo", startDate: "2026-11-10", reminders: [0], recurrence: { frequency: "weekly" } });
      const t = await newTask(A, { title: "Privada", dueDate: "2026-11-08" });
      const rem = (await A.post("/v1/reminders", { title: "Meu", remindAt: "2026-11-09T11:00:00Z" })).body as { id: string };
      const cat = (await A.post("/v1/task-categories", { name: "Minha" })).body as { id: string };
      await generate(A);

      expect((await B.get(`/v1/events/${e.id}`)).status).toBe(404);
      expect((await B.patch(`/v1/events/${e.id}`, { changes: { title: "hack" } })).status).toBe(404);
      expect((await del(B, `/v1/events/${e.id}`)).status).toBe(404);
      expect((await B.post(`/v1/events/${e.id}/expense`, { accountId: "x" }, "iso-key-0001")).status).toBe(404);
      expect((await occurrences(B, "2026-11-01", "2026-12-31")).occurrences).toHaveLength(0);
      expect((await B.get(`/v1/tasks/${t.id}`)).status).toBe(404);
      expect((await B.patch(`/v1/tasks/${t.id}`, { title: "hack" })).status).toBe(404);
      expect((await B.post(`/v1/tasks/${t.id}/complete`, {}, null)).status).toBe(404);
      expect((await del(B, `/v1/tasks/${t.id}`)).status).toBe(404);
      expect(((await B.get("/v1/tasks")).body as { total: number }).total).toBe(0);
      expect((await del(B, `/v1/reminders/${rem.id}`)).status).toBe(404);
      expect((await B.patch(`/v1/task-categories/${cat.id}`, { name: "hack" })).status).toBe(404);
      expect((await B.post("/v1/tasks", { title: "x", categoryId: cat.id })).status).toBe(404);
      clock.now = new Date("2026-11-10T20:00:00.000Z");
      expect((await generate(B)).created).toBe(0);
      expect((await inbox(B)).notifications).toHaveLength(0);
      const mine = (await inbox(A)).notifications;
      expect((await B.post(`/v1/notifications/${mine[0]?.id}/read`, {}, null)).status).toBe(404);
      // O dono continua com tudo intacto.
      expect((await A.get(`/v1/events/${e.id}`)).body["title"]).toBe("Segredo");
    });

    it("a mesma Idempotency-Key em usuários diferentes não colide", async () => {
      const { A, B } = await world();
      const a = await A.post("/v1/events", eventBody({ title: "Do A" }), "shared-key-0001");
      const b = await B.post("/v1/events", eventBody({ title: "Do B" }), "shared-key-0001");
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect((await occurrences(A, "2026-11-10", "2026-11-10")).occurrences.map((o) => o.title)).toEqual(["Do A"]);
      expect((await occurrences(B, "2026-11-10", "2026-11-10")).occurrences.map((o) => o.title)).toEqual(["Do B"]);
    });

    it("rotas e métodos inválidos", async () => {
      const { A } = await world();
      expect((await A.send("PUT", "/v1/events", {})).status).toBe(405);
      expect((await A.get("/v1/events/../x")).status).toBeGreaterThanOrEqual(400);
      expect((await A.get("/v1/events/x/y/z/w")).status).toBe(404);
      expect((await A.get("/v1/notifications/generate")).status).toBe(405);
      expect((await A.get("/v1/tasks/ab cd")).status).toBe(404);
    });

    if (options.fake) {
      it("[falso] dividir a série (esta e as próximas) é UM único commit atômico", async () => {
        const w = await world();
        const series = await newEvent(w.A, { title: "Curso", startDate: "2026-11-10", recurrence: { frequency: "weekly" } });
        await w.A.patch(`/v1/events/${series.id}`, { scope: "one", occurrenceDate: "2026-12-01", changes: { location: "Sala" } });
        const before = w.fake?.calls.filter((c) => c.url.endsWith(":commit")).length ?? 0;
        const r = await w.A.patch(`/v1/events/${series.id}`, { scope: "following", occurrenceDate: "2026-11-24", changes: { title: "Novo" } });
        expect(r.status).toBe(200);
        const after = w.fake?.calls.filter((c) => c.url.endsWith(":commit")).length ?? 0;
        expect(after - before).toBe(1);
      });

      it("[falso] falha no commit da divisão não deixa a série pela metade", async () => {
        const w = await world();
        const series = await newEvent(w.A, { title: "Curso", startDate: "2026-11-10", recurrence: { frequency: "weekly" } });
        w.fake?.failCommit(500);
        const r = await w.A.patch(`/v1/events/${series.id}`, { scope: "following", occurrenceDate: "2026-11-24", changes: { title: "Novo" } });
        expect(r.status).toBeGreaterThanOrEqual(500);
        const list = await occurrences(w.A, "2026-11-01", "2026-12-08");
        expect(list.occurrences.map((o) => `${o.startDate} ${o.title}`)).toEqual([
          "2026-11-10 Curso",
          "2026-11-17 Curso",
          "2026-11-24 Curso",
          "2026-12-01 Curso",
          "2026-12-08 Curso",
        ]);
      });

      it("[falso] gerar notificações não faz mais que ~10 chamadas ao banco (limite de subrequisições)", async () => {
        const w = await world();
        await newEvent(w.A, { title: "E", startDate: "2026-11-09", startTime: "15:00", reminders: [30] });
        await newTask(w.A, { title: "T", dueDate: "2026-11-08" });
        w.clock.now = new Date("2026-11-09T18:00:00.000Z");
        const before = w.fake?.calls.length ?? 0;
        await generate(w.A);
        expect((w.fake?.calls.length ?? 0) - before).toBeLessThanOrEqual(12);
      });
    }
  });
}
