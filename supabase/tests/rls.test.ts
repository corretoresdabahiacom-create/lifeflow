import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, resetDatabase, withRole, type Role } from "../harness";
import { A, B, T0, seedUsers } from "./helpers";

/**
 * Portam os testes das antigas Security Rules do Firestore (137) para a RLS, os CHECKs e os gatilhos do Postgres.
 * Aqui o acesso é DIRETO nas tabelas (como um cliente falando com o PostgREST), sem passar pelas funções lf_*.
 */

let db: PGlite;
beforeAll(async () => {
  db = await createDatabase();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDatabase(db);
  await seedUsers(db);
});

interface Result {
  ok: boolean;
  rows: Array<Record<string, unknown>>;
  code?: string;
  count: number;
}

async function as(who: string | "service" | "anon", sql: string, params: unknown[] = []): Promise<Result> {
  const role: Role = who === "service" ? "service_role" : who === "anon" ? "anon" : "authenticated";
  const claims = who === "service" || who === "anon" ? {} : { sub: who };
  try {
    const res = await withRole(db, role, claims, (tx) => tx.query<Record<string, unknown>>(sql, params));
    return { ok: true, rows: res.rows, count: res.affectedRows ?? res.rows.length };
  } catch (error) {
    return { ok: false, rows: [], count: 0, code: (error as { code?: string }).code };
  }
}

/** Escreve como o dono e exige sucesso (preparação de cenário). */
async function seed(sql: string, params: unknown[] = []): Promise<void> {
  const r = await as(A, sql, params);
  if (!r.ok) throw new Error(`seed falhou (${r.code}): ${sql}`);
}

const RLS_DENIED = "42501";
const CHECK = "23514";
const DENIED_BY_TRIGGER = "PT403";
const FK = "23503";

const ACCOUNT = `insert into accounts (user_id, id, name, type, initial_balance_cents, balance_cents, archived, created_at, updated_at, request_hash)
  values ($1, $2, 'Conta', 'checking', 1000, 1000, false, '${T0}', '${T0}', 'h')`;
const TX = `insert into transactions (user_id, id, account_id, type, amount_cents, signed_cents, date, description, status, created_at, updated_at, request_hash)
  values ($1, $2, $3, $4, $5, $6, '2026-11-09', 'Mercado', 'posted', '${T0}', '${T0}', 'h')`;

describe("isolamento e acesso anônimo", () => {
  it("anônimo não lê nem escreve nada; o dono não vê dados alheios", async () => {
    await seed(ACCOUNT, [A, "a1"]);
    expect((await as("anon", "select * from accounts")).ok).toBe(false);
    expect((await as("anon", ACCOUNT, [A, "a2"])).ok).toBe(false);
    expect((await as(B, "select * from accounts")).rows).toHaveLength(0);
    expect((await as(A, "select * from accounts")).rows).toHaveLength(1);
  });

  it("usuário não grava com o user_id de outro, nem muda o dono de uma linha", async () => {
    expect((await as(B, ACCOUNT, [A, "x"])).code).toBe(RLS_DENIED);
    await seed(ACCOUNT, [A, "a1"]);
    expect((await as(B, "update accounts set name = 'Hack' where id = 'a1'")).count).toBe(0);
    expect((await as(A, "update accounts set user_id = $1 where id = 'a1'", [B])).code).toBe(RLS_DENIED);
  });

  it("webhook_events, admin_logs e escrita em planos/assinaturas/cobranças são inacessíveis ao cliente", async () => {
    await as("service", "insert into webhook_events (id, status) values ('w1', 'received')");
    await as("service", "insert into admin_logs (id, action) values ('l1', 'x')");
    await as("service", "insert into plans (id, name) values ('pro', 'Pro')");
    await as("service", "insert into subscriptions (user_id, plan_id, status) values ($1, 'pro', 'active')", [A]);
    await as("service", "insert into billing_payments (user_id, id, amount_cents, status) values ($1, 'p1', 1490, 'approved')", [A]);
    expect((await as(A, "select * from webhook_events")).ok).toBe(false);
    expect((await as(A, "select * from admin_logs")).ok).toBe(false);
    expect((await as(A, "select * from plans")).rows).toHaveLength(1);
    expect((await as(A, "select * from subscriptions")).rows).toHaveLength(1);
    expect((await as(B, "select * from subscriptions")).rows).toHaveLength(0);
    expect((await as(A, "select * from billing_payments")).rows).toHaveLength(1);
    expect((await as(A, "update subscriptions set plan_id = 'premium_ai'")).ok).toBe(false);
    expect((await as(A, "insert into subscriptions (user_id, plan_id) values ($1, 'premium_ai')", [B])).ok).toBe(false);
    expect((await as(A, "insert into plans (id, name) values ('free', 'x')")).ok).toBe(false);
    expect((await as(A, "insert into billing_payments (user_id, id) values ($1, 'p2')", [A])).ok).toBe(false);
    expect((await as("anon", "select * from plans")).ok).toBe(false);
  });

  it("o cliente não executa a exclusão de conta nem as funções internas de escrita do backend", async () => {
    expect((await as(A, "select public.lf_erase_user($1)", [A])).ok).toBe(false);
    expect((await as("anon", "select public.lf_commit('[]'::jsonb)")).ok).toBe(false);
  });
});

describe("perfil e preferências", () => {
  const PROFILE = `insert into profiles (user_id, display_name, locale, timezone, currency, created_at, updated_at)
    values ($1, $2, $3, 'America/Sao_Paulo', $4, '${T0}', '${T0}')`;

  it("cria o próprio perfil válido; rejeita locale/moeda/nome inválidos e perfil de outro", async () => {
    expect((await as(A, PROFILE, [A, "Ana", "pt-BR", "BRL"])).ok).toBe(true);
    expect((await as(B, PROFILE, [B, "Bia", "pt_BR", "BRL"])).code).toBe(CHECK);
    expect((await as(B, PROFILE, [B, "Bia", "pt-BR", "brl"])).code).toBe(CHECK);
    expect((await as(B, PROFILE, [B, "", "pt-BR", "BRL"])).code).toBe(CHECK);
    expect((await as(B, PROFILE, [A, "Ana", "pt-BR", "BRL"])).code).toBe(RLS_DENIED);
    expect((await as(A, "delete from profiles")).ok).toBe(false);
  });

  it("created_at do perfil é imutável; o nome pode mudar", async () => {
    await as(A, PROFILE, [A, "Ana", "pt-BR", "BRL"]);
    expect((await as(A, "update profiles set display_name = 'Ana Maria'")).ok).toBe(true);
    expect((await as(A, "update profiles set created_at = '2027-01-01T00:00:00.000Z'")).code).toBe(DENIED_BY_TRIGGER);
  });

  it("preferências: documento `app` e `ai` com formas distintas e limites", async () => {
    const app = `insert into preferences (user_id, id, theme, confirm_creations, quiet_hours_start, quiet_hours_end, updated_at)
      values ($1, 'app', $2, true, $3, '07:00', '${T0}')`;
    expect((await as(A, app, [A, "dark", "22:00"])).ok).toBe(true);
    expect((await as(A, app.replace("'app'", "'app2'"), [A, "dark", "22:00"])).ok).toBe(false);
    expect((await as(B, app, [B, "neon", "22:00"])).code).toBe(CHECK);
    expect((await as(B, app, [B, "dark", "25:00"])).code).toBe(CHECK);
    const ai = (n: number) => as(A, `insert into preferences (user_id, id, auto_actions_per_day, auto_value_limit_cents, confirm_above_cents, updated_at)
      values ($1, 'ai', $2, 5000, 20000, '${T0}')`, [A, n]);
    expect((await ai(5)).ok).toBe(true);
    await as(A, "delete from preferences where id = 'ai'");
    expect((await ai(101)).code).toBe(CHECK);
    // Um documento `app` com campos de `ai` não é aceito.
    expect((await as(A, `insert into preferences (user_id, id, theme, confirm_creations, quiet_hours_start, quiet_hours_end, auto_actions_per_day, updated_at)
      values ($1, 'ai', 'dark', true, '22:00', '07:00', 3, '${T0}')`, [A])).code).toBe(CHECK);
    expect((await as(A, "delete from preferences where id = 'app'")).ok).toBe(true);
  });

  it("consentimento de áudio: só a chave `audio`; sem exclusão", async () => {
    const consent = (k: string) => as(A, `insert into consents (user_id, id, granted, updated_at) values ($1, $2, true, '${T0}')`, [A, k]);
    expect((await consent("audio")).ok).toBe(true);
    expect((await consent("video")).code).toBe(CHECK);
    expect((await as(A, "delete from consents")).ok).toBe(false);
    expect((await as(A, "update consents set granted = false")).ok).toBe(true);
  });
});

describe("financeiro", () => {
  it("conta: nasce com saldo = inicial e ativa; campos imutáveis; sem exclusão", async () => {
    expect((await as(A, ACCOUNT, [A, "a1"])).ok).toBe(true);
    const bad = (extra: string) => as(A, ACCOUNT.replace("1000, 1000, false", extra), [A, "z"]);
    expect((await bad("1000, 900, false")).code).toBe(RLS_DENIED);
    expect((await bad("1000, 1000, true")).code).toBe(RLS_DENIED);
    expect((await bad("100000000001, 100000000001, false")).code).toBe(CHECK);
    expect((await as(A, "update accounts set name = 'Nova', balance_cents = 400, archived = true where id = 'a1'")).ok).toBe(true);
    for (const col of ["type = 'cash'", "initial_balance_cents = 5", "created_at = '2027-01-01T00:00:00.000Z'", "request_hash = 'x'"]) {
      expect((await as(A, `update accounts set ${col} where id = 'a1'`)).code).toBe(DENIED_BY_TRIGGER);
    }
    expect((await as(A, "delete from accounts")).code).toBe(RLS_DENIED);
  });

  it("lançamento: conta precisa existir, sinal coerente, valor positivo e só nasce efetivado", async () => {
    expect((await as(A, TX, [A, "t1", "nao-existe", "income", 500, 500])).code).toBe(FK);
    await seed(ACCOUNT, [A, "a1"]);
    expect((await as(A, TX, [A, "t1", "a1", "income", 500, 500])).ok).toBe(true);
    expect((await as(A, TX, [A, "t2", "a1", "expense", 500, -500])).ok).toBe(true);
    expect((await as(A, TX, [A, "t3", "a1", "income", 500, -500])).code).toBe(CHECK);
    expect((await as(A, TX, [A, "t4", "a1", "expense", 500, 500])).code).toBe(CHECK);
    expect((await as(A, TX, [A, "t5", "a1", "income", 0, 0])).code).toBe(CHECK);
    expect((await as(A, TX, [A, "t6", "a1", "income", -5, -5])).code).toBe(CHECK);
    expect((await as(A, TX.replace("'posted'", "'voided'"), [A, "t7", "a1", "income", 5, 5])).code).toBe(RLS_DENIED);
    expect((await as(B, TX, [B, "t8", "a1", "income", 5, 5])).code).toBe(FK); // conta de outro usuário não vale
  });

  it("lançamento: só estorno ou metadados; valor/conta/data/tipo imutáveis; estornado não muda; sem exclusão", async () => {
    await seed(ACCOUNT, [A, "a1"]);
    await seed(TX, [A, "t1", "a1", "income", 500, 500]);
    for (const col of ["amount_cents = 1000, signed_cents = 1000", "account_id = 'a2'", "date = '2026-12-01'", "type = 'expense'", "transfer_id = 'x'", "payable_id = 'x'"]) {
      expect((await as(A, `update transactions set ${col} where id = 't1'`)).ok).toBe(false);
    }
    expect((await as(A, "update transactions set description = 'Novo', notes = 'n', category_id = 'c1', updated_at = $1 where id = 't1'", [T0])).ok).toBe(true);
    expect((await as(A, "update transactions set status = 'voided' where id = 't1'")).code).toBe(DENIED_BY_TRIGGER); // sem voided_at
    expect((await as(A, "update transactions set status = 'voided', voided_at = $1, description = 'x' where id = 't1'", [T0])).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(A, "update transactions set status = 'voided', voided_at = $1, updated_at = $1 where id = 't1'", [T0])).ok).toBe(true);
    expect((await as(A, "update transactions set description = 'depois' where id = 't1'")).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(A, "update transactions set status = 'posted', voided_at = null where id = 't1'")).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(A, "delete from transactions")).code).toBe("42501");
  });

  it("transferência: contas distintas e existentes; só estorno", async () => {
    await seed(ACCOUNT, [A, "a1"]);
    await seed(ACCOUNT, [A, "a2"]);
    const tr = (from: string, to: string, id = "tr1") => as(A, `insert into transfers (user_id, id, from_account_id, to_account_id, amount_cents, date, status, out_transaction_id, in_transaction_id, created_at, updated_at, request_hash)
      values ($1, $2, $3, $4, 100, '2026-11-09', 'posted', 'o1', 'i1', '${T0}', '${T0}', 'h')`, [A, id, from, to]);
    expect((await tr("a1", "a1")).code).toBe(CHECK);
    expect((await tr("a1", "fantasma")).code).toBe(FK);
    expect((await tr("a1", "a2")).ok).toBe(true);
    expect((await as(A, "update transfers set amount_cents = 1 where id = 'tr1'")).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(A, "update transfers set status = 'voided', voided_at = $1, updated_at = $1 where id = 'tr1'", [T0])).ok).toBe(true);
    expect((await as(A, "update transfers set status = 'posted', voided_at = null where id = 'tr1'")).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(A, "delete from transfers")).code).toBe("42501");
  });

  const PAYABLE = (status: string, paid: string) => `insert into payables (user_id, id, kind, description, amount_cents, due_date, status, pay_count, ${paid ? "paid_date, paid_amount_cents, transaction_id," : ""} created_at, updated_at, request_hash)
    values ($1, $2, 'payable', 'Luz', 9000, '2026-11-20', '${status}', $3, ${paid ? "'2026-11-20', 9000, 't1'," : ""} '${T0}', '${T0}', 'h')`;

  it("conta a pagar: nasce aberta com 0 pagamentos; paga exige data, valor e lançamento; campos imutáveis", async () => {
    expect((await as(A, PAYABLE("open", ""), [A, "p1", 0])).ok).toBe(true);
    expect((await as(A, PAYABLE("open", ""), [A, "p2", 1])).code).toBe(RLS_DENIED);
    expect((await as(A, PAYABLE("paid", "x"), [A, "p3", 0])).code).toBe(RLS_DENIED); // nasce aberta
    expect((await as(A, "update payables set status = 'paid' where id = 'p1'")).code).toBe(CHECK); // paga sem dados
    expect((await as(A, "update payables set status = 'paid', paid_date = '2026-11-20', paid_amount_cents = 9000, transaction_id = 't1', pay_count = 1 where id = 'p1'")).ok).toBe(true);
    expect((await as(A, "update payables set status = 'open' where id = 'p1'")).code).toBe(CHECK); // aberta com restos de pagamento
    expect((await as(A, "update payables set kind = 'receivable' where id = 'p1'")).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(A, "update payables set recurring_id = 'r1' where id = 'p1'")).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(A, "delete from payables")).code).toBe("42501");
  });

  it("recorrência: nasce sem materialização; kind/frequência/início imutáveis", async () => {
    const rec = (lm: string) => as(A, `insert into recurring (user_id, id, kind, description, amount_cents, frequency, start_date, active, last_materialized_through, created_at, updated_at, request_hash)
      values ($1, 'r1', 'payable', 'Aluguel', 100000, 'monthly', '2026-11-05', true, ${lm}, '${T0}', '${T0}', 'h')`, [A]);
    expect((await rec("'2026-11-05'")).code).toBe(RLS_DENIED);
    expect((await rec("null")).ok).toBe(true);
    expect((await as(A, "update recurring set last_materialized_through = '2026-11-05', active = false where id = 'r1'")).ok).toBe(true);
    for (const col of ["frequency = 'weekly'", "start_date = '2026-12-01'", "kind = 'receivable'"]) {
      expect((await as(A, `update recurring set ${col} where id = 'r1'`)).code).toBe(DENIED_BY_TRIGGER);
    }
  });
});

describe("agenda e tarefas", () => {
  const EVENT = (over = "") => `insert into events (user_id, id, title, kind, start_date, duration_min, time_zone, created_at, updated_at, request_hash ${over ? "," + over.split("=")[0] : ""})
    values ($1, $2, 'Dentista', 'medical', '2026-11-10', 60, 'America/Sao_Paulo', '${T0}', '${T0}', 'h' ${over ? "," + over.split("=")[1] : ""})`;

  it("evento: validações de formato; nasce sem despesa vinculada; pode ser excluído", async () => {
    expect((await as(A, EVENT(), [A, "e1"])).ok).toBe(true);
    expect((await as(A, EVENT("link='javascript:alert(1)'"), [A, "e2"])).code).toBe(CHECK);
    expect((await as(A, EVENT("link='https://meet.example/x'"), [A, "e3"])).ok).toBe(true);
    expect((await as(A, EVENT("reminders='10,abc'"), [A, "e4"])).code).toBe(CHECK);
    expect((await as(A, EVENT("rec_weekdays='1,9'"), [A, "e5"])).code).toBe(CHECK);
    expect((await as(A, EVENT("expense_transaction_id='t1'"), [A, "e6"])).code).toBe(RLS_DENIED);
    expect((await as(A, EVENT("duration_min=0").replace("60,", "60,"), [A, "e7"])).ok).toBe(false);
    expect((await as(A, "update events set title = 'Novo', expense_transaction_id = 't1' where id = 'e1'")).ok).toBe(true);
    expect((await as(A, "update events set created_at = '2027-01-01T00:00:00.000Z' where id = 'e1'")).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(B, "delete from events")).count).toBe(0);
    expect((await as(A, "delete from events where id = 'e1'")).count).toBe(1);
  });

  it("exceção de ocorrência: série/data original imutáveis; pode excluir", async () => {
    await as(A, `insert into event_exceptions (user_id, id, series_id, original_date, canceled, created_at, updated_at) values ($1, 'x1', 's1', '2026-11-10', true, '${T0}', '${T0}')`, [A]);
    expect((await as(A, "update event_exceptions set series_id = 's2' where id = 'x1'")).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(A, "update event_exceptions set original_date = '2026-11-11' where id = 'x1'")).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(A, "delete from event_exceptions where id = 'x1'")).count).toBe(1);
  });

  const TASK = (cols: string, vals: string) => `insert into tasks (user_id, id, title, priority, status, created_at, updated_at, request_hash ${cols})
    values ($1, $2, 'Pagar IPTU', 'high', 'pending', '${T0}', '${T0}', 'h' ${vals})`;

  it("tarefa: horário e lembrete exigem data; concluída exige completed_at coerente; excluível", async () => {
    expect((await as(A, TASK("", ""), [A, "k1"])).ok).toBe(true);
    expect((await as(A, TASK(", due_time", ", '09:00'"), [A, "k2"])).code).toBe(CHECK);
    expect((await as(A, TASK(", reminder_minutes", ", 30"), [A, "k3"])).code).toBe(CHECK);
    expect((await as(A, TASK(", due_date, due_time, reminder_minutes", ", '2026-11-12', '09:00', 30"), [A, "k4"])).ok).toBe(true);
    expect((await as(A, TASK(", completed_at", `, '${T0}'`), [A, "k5"])).code).toBe(RLS_DENIED);
    expect((await as(A, "update tasks set status = 'completed', completed_at = $1 where id = 'k1'", [T0])).ok).toBe(true);
    expect((await as(A, "update tasks set completed_at = $1 where id = 'k4'", [T0])).code).toBe(CHECK);
    expect((await as(A, "update tasks set request_hash = 'z' where id = 'k1'")).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(A, "delete from tasks where id = 'k1'")).count).toBe(1);
  });

  it("lembrete avulso: só título/horário mudam; notificação só avança e nunca é apagada", async () => {
    await seed(`insert into reminders (user_id, id, title, remind_at, created_at, request_hash) values ($1, 'r1', 'Ligar', '2026-11-12T10:00:00.000Z', '${T0}', 'h')`, [A]);
    expect((await as(A, "update reminders set title = 'Ligar já', remind_at = '2026-11-12T11:00:00.000Z' where id = 'r1'")).ok).toBe(true);
    expect((await as(A, "update reminders set created_at = '2027-01-01T00:00:00.000Z' where id = 'r1'")).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(A, "insert into reminders (user_id, id, title, remind_at, created_at, request_hash) values ($1, 'r2', 'x', 'amanhã', $2, 'h')", [A, T0])).code).toBe(CHECK);
    expect((await as(A, "delete from reminders where id = 'r1'")).count).toBe(1);

    const notif = (read: boolean) => `insert into notifications (user_id, id, type, title, body, source_type, source_id, occurrence_key, trigger_at, silent, read, dismissed, created_at)
      values ($1, $2, 'task_reminder', 'Tarefa', '', 'task', 'k1', 'k1:1', '${T0}', false, ${read}, false, '${T0}')`;
    expect((await as(A, notif(true), [A, "n0"])).code).toBe(RLS_DENIED);
    expect((await as(A, notif(false), [A, "n1"])).ok).toBe(true);
    expect((await as(A, "update notifications set read = true, read_at = $1 where id = 'n1'", [T0])).ok).toBe(true);
    expect((await as(A, "update notifications set read = false where id = 'n1'")).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(A, "update notifications set title = 'outro' where id = 'n1'")).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(A, "update notifications set dismissed = true where id = 'n1'")).ok).toBe(true);
    expect((await as(A, "delete from notifications")).code).toBe("42501");
  });
});

describe("assistente de IA", () => {
  it("conversa: só avança updated_at; mensagens imutáveis e excluíveis; mensagem exige conversa do próprio usuário", async () => {
    const conv = `insert into ai_conversations (user_id, id, title, created_at, updated_at) values ($1, 'c1', 'Oi', '${T0}', '${T0}')`;
    expect((await as(A, conv, [A])).ok).toBe(true);
    expect((await as(A, "update ai_conversations set updated_at = '2026-11-10T00:00:00.000Z' where id = 'c1'")).ok).toBe(true);
    expect((await as(A, "update ai_conversations set title = 'Outro' where id = 'c1'")).code).toBe(DENIED_BY_TRIGGER);
    const msg = (uid: string, content = "olá", role = "user") => as(uid, `insert into ai_messages (user_id, id, conversation_id, role, content, created_at) values ($1, 'm1', 'c1', $2, $3, '${T0}')`, [uid, role, content]);
    expect((await msg(B)).code).toBe(FK);
    expect((await msg(A, "olá", "system")).code).toBe(CHECK);
    expect((await msg(A, "x".repeat(4001))).code).toBe(CHECK);
    expect((await msg(A)).ok).toBe(true);
    expect((await as(A, "update ai_messages set content = 'editado'")).count).toBe(0); // sem política de UPDATE: nenhuma linha alcançada
    expect((await as(A, "select content from ai_messages")).rows[0]?.content).toBe("olá");
    expect((await as(A, "delete from ai_messages")).count).toBe(1);
    await msg(A);
    expect((await as(A, "delete from ai_conversations")).count).toBe(1);
    expect((await as(A, "select * from ai_messages")).rows).toHaveLength(0); // cascata
  });

  const ACTION = (status = "pending") => `insert into ai_actions (user_id, id, conversation_id, message_id, tool, kind, financial, args_json, args_hash, summary, reinforced, status, expires_at, created_at, updated_at)
    values ($1, 'ac1', 'c1', 'm1', 'create_transaction', 'create', true, '{}', '${"a".repeat(64)}', 'Criar', false, '${status}', '${T0}', '${T0}', '${T0}')`;

  it("ação: nasce pendente; transições válidas; parâmetros imutáveis; estados finais não mudam", async () => {
    expect((await as(A, ACTION("done"), [A])).code).toBe(RLS_DENIED);
    expect((await as(A, ACTION(), [A])).ok).toBe(true);
    expect((await as(A, "update ai_actions set args_json = '{\"x\":1}' where id = 'ac1'")).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(A, "update ai_actions set tool = 'delete_all' where id = 'ac1'")).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(A, "update ai_actions set status = 'executing' where id = 'ac1'")).ok).toBe(true);
    expect((await as(A, "update ai_actions set status = 'pending' where id = 'ac1'")).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(A, "update ai_actions set status = 'expired' where id = 'ac1'")).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(A, "update ai_actions set status = 'done', result_note = 'ok' where id = 'ac1'")).ok).toBe(true);
    expect((await as(A, "update ai_actions set status = 'failed' where id = 'ac1'")).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(A, "delete from ai_actions")).code).toBe("42501");
  });

  it("trilha de auditoria: só inclusão", async () => {
    const log = `insert into ai_logs (user_id, id, event, detail, created_at) values ($1, 'l1', $2, '', '${T0}')`;
    expect((await as(A, log, [A, "executed"])).ok).toBe(true);
    expect((await as(B, log.replace("'l1'", "'l2'"), [A, "executed"])).code).toBe(RLS_DENIED);
    expect((await as(A, log.replace("'l1'", "'l3'"), [A, "inventado"])).code).toBe(CHECK);
    expect((await as(A, "update ai_logs set detail = 'adulterado'")).count).toBe(0);
    expect((await as(A, "select detail from ai_logs")).rows[0]?.detail).toBe("");
    expect((await as(A, "delete from ai_logs")).ok).toBe(false);
  });

  it("contadores só crescem; sem exclusão; id no formato AAAA-MM / AAAA-MM-DD", async () => {
    expect((await as(A, `insert into ai_usage (user_id, id, messages, updated_at) values ($1, '2026-11', 3, '${T0}')`, [A])).ok).toBe(true);
    expect((await as(A, `insert into ai_usage (user_id, id, messages, updated_at) values ($1, 'novembro', 3, '${T0}')`, [A])).code).toBe(CHECK);
    expect((await as(A, "update ai_usage set messages = messages + 1 where id = '2026-11'")).ok).toBe(true);
    expect((await as(A, "update ai_usage set messages = 0 where id = '2026-11'")).code).toBe(DENIED_BY_TRIGGER);
    expect([CHECK, DENIED_BY_TRIGGER]).toContain((await as(A, "update ai_usage set messages = -1 where id = '2026-11'")).code);
    expect((await as(A, "delete from ai_usage")).code).toBe("42501");
    expect((await as(A, `insert into ai_daily (user_id, id, auto_actions, updated_at) values ($1, '2026-11-09', 2, '${T0}')`, [A])).ok).toBe(true);
    expect((await as(A, "update ai_daily set auto_actions = 1")).code).toBe(DENIED_BY_TRIGGER);
    expect((await as(A, `insert into ai_daily (user_id, id, updated_at) values ($1, '2026-11', '${T0}')`, [A])).code).toBe(CHECK);
  });
});

describe("privilégios", () => {
  it("o backend (service_role) lê e escreve tudo; cliente comum não toca nas tabelas internas", async () => {
    expect((await as("service", "insert into webhook_events (id, status) values ('w1', 'received')")).ok).toBe(true);
    expect((await as("service", `insert into accounts (user_id, id, name, type, initial_balance_cents, balance_cents, archived, created_at, updated_at, request_hash)
      values ($1, 'a1', 'C', 'cash', 0, 0, false, '${T0}', '${T0}', 'h')`, [A])).ok).toBe(true);
    expect((await as("service", "select * from accounts")).rows).toHaveLength(1);
    expect((await as("anon", "select * from webhook_events")).ok).toBe(false);
  });
});
