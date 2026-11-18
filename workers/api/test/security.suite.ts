import { beforeAll, describe, expect, it, vi } from "vitest";
import { say } from "./ai.suite";
import type { BillingWorld } from "./billing.suite";
import type { Reply } from "./finance.suite";
import { env, makeSigner, signToken, type Signer } from "./helpers";

/**
 * Fase 6 — testes de SEGURANÇA e ISOLAMENTO entre usuários, em todos os módulos.
 * Mesma suíte no Firestore falso e no emulador real (regras reais).
 */

const code = (r: Reply) => (r.body["error"] as { code: string } | undefined)?.code;

export function defineSecuritySuite(
  title: string,
  makeWorld: (signer: Signer, options: { noEmailForA?: boolean }) => BillingWorld | Promise<BillingWorld>,
): void {
  describe(title, () => {
    let signer: Signer;
    beforeAll(async () => {
      signer = await makeSigner("k1");
    });
    const world = async () => {
      const w = await makeWorld(signer, {});
      w.clock.now = new Date("2026-11-09T12:00:00.000Z");
      return w;
    };

    /** Dados de A em todos os módulos; devolve os ids para B tentar alcançar. */
    const populate = async (w: BillingWorld) => {
      const A = w.A;
      await A.put("/v1/profile", { displayName: "Ana", locale: "pt-BR", timezone: "America/Sao_Paulo", currency: "BRL" });
      const account = (await A.post("/v1/accounts", { name: "Conta secreta da Ana", type: "checking", initialBalanceCents: 500_000 })).body as { id: string };
      const tx = (await A.post("/v1/transactions", { accountId: account.id, type: "expense", amountCents: 4200, date: "2026-11-09", description: "Segredo da Ana" })).body as { id: string };
      const payable = (await A.post("/v1/payables", { kind: "payable", description: "Boleto da Ana", amountCents: 9000, dueDate: "2026-11-20" })).body as { id: string };
      const event = (await A.post("/v1/events", { title: "Consulta da Ana", startDate: "2026-11-10", startTime: "10:00", durationMin: 30 })).body as { id: string };
      const task = (await A.post("/v1/tasks", { title: "Tarefa da Ana" })).body as { id: string };
      w.llm.script.push(say("resposta"));
      await A.post("/v1/ai/chat", { message: "pergunta da Ana" });
      const conversationId = ((await A.get("/v1/ai/conversations")).body["conversations"] as Array<{ id: string }>)[0]!.id;
      return { account: account.id, tx: tx.id, payable: payable.id, event: event.id, task: task.id, conversationId };
    };

    // ------------------------------------------------------------ autenticação em TODAS as rotas
    it("toda rota /v1 exige token: sem Authorization ou com token inválido → 401 (nenhuma rota esquecida)", async () => {
      const w = await world();
      const routes: Array<[string, string]> = [
        ["GET", "/v1/me"], ["GET", "/v1/profile"], ["GET", "/v1/preferences"],
        ["GET", "/v1/accounts"], ["GET", "/v1/categories"], ["GET", "/v1/transactions"], ["GET", "/v1/transfers"],
        ["GET", "/v1/payables"], ["GET", "/v1/recurring"], ["GET", "/v1/overview"], ["GET", "/v1/reports/summary"],
        ["GET", "/v1/reconcile"], ["GET", "/v1/export/transactions"],
        ["GET", "/v1/events"], ["GET", "/v1/tasks"], ["GET", "/v1/task-categories"], ["GET", "/v1/notifications"], ["GET", "/v1/reminders"],
        ["POST", "/v1/ai/chat"], ["GET", "/v1/ai/conversations"], ["GET", "/v1/ai/actions"], ["GET", "/v1/ai/history"],
        ["GET", "/v1/ai/usage"], ["GET", "/v1/ai/settings"], ["GET", "/v1/ai/consent"], ["POST", "/v1/ai/transcribe"],
        ["GET", "/v1/billing/plans"], ["GET", "/v1/billing/subscription"], ["GET", "/v1/billing/history"],
        ["POST", "/v1/billing/checkout"], ["POST", "/v1/billing/change"], ["POST", "/v1/billing/cancel"], ["POST", "/v1/billing/sync"],
        ["GET", "/v1/account/export"], ["POST", "/v1/account/delete"],
        ["GET", "/v1/admin/overview"], ["GET", "/v1/admin/plans"], ["GET", "/v1/admin/subscriptions"], ["GET", "/v1/admin/usage"],
        ["GET", "/v1/admin/logs"], ["GET", "/v1/admin/integrations"],
      ];
      const forged = await signToken(await makeSigner("outra-chave"), { uid: "intruso" });
      for (const [method, path] of routes) {
        const none = await w.app(path, { method });
        expect(none.status, `${method} ${path} sem token`).toBe(401);
        const bad = await w.app(path, { method, headers: { Authorization: "Bearer lixo.lixo.lixo" } });
        expect(bad.status, `${method} ${path} token inválido`).toBe(401);
        const wrongKey = await w.app(path, { method }, forged);
        expect(wrongKey.status, `${method} ${path} chave errada`).toBe(401);
      }
    });

    it("tokens inválidos: expirado, audiência/emissor errados, sem sub, esquema errado → 401", async () => {
      const w = await world();
      const now = Math.floor(Date.now() / 1000);
      const bad = [
        await signToken(signer, { uid: "u", expiresAt: now - 60, issuedAt: now - 3600 }),
        await signToken(signer, { uid: "u", audience: "outro-projeto" }),
        await signToken(signer, { uid: "u", issuer: "https://evil.example/" }),
        await signToken(signer, {}),
        await signToken(signer, { uid: "u", kid: "desconhecida" }),
      ];
      for (const token of bad) expect((await w.app("/v1/me", {}, token)).status).toBe(401);
      const good = await signToken(signer, { uid: "u1" });
      expect((await w.app("/v1/me", { headers: { Authorization: `Basic ${good}` } })).status).toBe(401);
      expect((await w.app("/v1/me", {}, good)).status).toBe(200);
    });

    it("o uid vem só do token: cabeçalhos/consulta/corpo com outro uid não mudam quem é o usuário", async () => {
      const w = await world();
      const r = await w.A.send("GET", `/v1/me?uid=${w.uidB}`, undefined, { "X-User-Id": w.uidB, "X-Uid": w.uidB });
      expect(r.body["uid"]).toBe(w.uidA);
      const created = await w.A.post("/v1/accounts", { name: "Minha", type: "checking", initialBalanceCents: 0, uid: w.uidB });
      expect(created.status).toBe(400); // schema estrito: campo desconhecido é recusado
    });

    // ------------------------------------------------------------ cabeçalhos e CORS
    it("respostas trazem cabeçalhos de segurança e identificador de requisição; nunca são cacheáveis", async () => {
      const w = await world();
      for (const [path, token] of [["/healthz", undefined], ["/v1/me", w.A], ["/v1/rota-inexistente", w.A]] as const) {
        const r = token ? await token.get(path) : { headers: (await w.app(path)).headers };
        expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(r.headers.get("Cache-Control")).toBe("private, no-store");
        expect(r.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
      }
    });

    it("CORS: só a origem configurada é aceita; origem alheia não recebe permissão; preflight não vaza dados", async () => {
      const w = await world();
      const allowed = await w.app("/v1/me", { headers: { Origin: env.ALLOWED_ORIGIN } });
      expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(env.ALLOWED_ORIGIN);
      const evil = await w.app("/v1/me", { headers: { Origin: "https://evil.example" } });
      expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();
      const pre = await w.app("/v1/transactions", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" } });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(await pre.text()).toBe("");
    });

    // ------------------------------------------------------------ entradas maliciosas
    it("ids malformados ou de travessia de caminho nunca chegam ao banco (400/404, jamais 500)", async () => {
      const w = await world();
      const ids = ["..", "..%2F..%2Fusers%2Foutro", "a%2Fb", "%00", "x".repeat(300), "a b", "<script>", "'; DROP", "users/outro/accounts/x"];
      const prefixes = ["/v1/accounts", "/v1/transactions", "/v1/payables", "/v1/events", "/v1/tasks", "/v1/ai/conversations", "/v1/transfers", "/v1/recurring"];
      for (const prefix of prefixes) {
        for (const id of ids) {
          for (const method of ["GET", "DELETE"]) {
            const r = await w.A.send(method, `${prefix}/${id}`);
            expect([400, 404, 405], `${method} ${prefix}/${id} → ${r.status}`).toContain(r.status);
          }
        }
      }
    });

    it("corpo malformado, tipo errado, grande demais ou com campos extras é recusado sem erro 500", async () => {
      const w = await world();
      const post = async (body: BodyInit, extra: Record<string, string> = {}) => {
        const token = await signToken(signer, { uid: w.uidA });
        return w.app("/v1/accounts", { method: "POST", body, headers: { "Content-Type": "application/json", "Idempotency-Key": `k-${crypto.randomUUID()}`, ...extra } }, token);
      };
      expect((await post("{não é json")).status).toBe(400);
      expect((await post("null")).status).toBe(400);
      expect((await post("[]")).status).toBe(400);
      expect((await post(JSON.stringify({ name: 123, type: "checking", initialBalanceCents: 0 }))).status).toBe(400);
      expect((await post(JSON.stringify({ name: "x", type: "checking", initialBalanceCents: 1.5 }))).status).toBe(400);
      expect((await post(JSON.stringify({ name: "x", type: "checking", initialBalanceCents: 0, balanceCents: 999 }))).status).toBe(400);
      expect((await post(JSON.stringify({ name: "x".repeat(200_000), type: "checking", initialBalanceCents: 0 }))).status).toBeGreaterThanOrEqual(400);
      const big = await post("x".repeat(2_000_000), { "Content-Length": "2000000" });
      expect([400, 413]).toContain(big.status);
    });

    it("injeção de campos protegidos: cliente não define saldo, status, origem, plano nem identificador", async () => {
      const w = await world();
      const acc = (await w.A.post("/v1/accounts", { name: "Conta", type: "checking", initialBalanceCents: 1000 })).body as { id: string; balanceCents: number };
      expect(acc.balanceCents).toBe(1000);
      expect((await w.A.patch(`/v1/accounts/${acc.id}`, { balanceCents: 99_999_999 })).status).toBe(400);
      const bad = await w.A.post("/v1/transactions", { accountId: acc.id, type: "expense", amountCents: 100, date: "2026-11-09", description: "x", status: "voided", origin: "ai", aiActionId: "x", signedCents: 5 });
      expect(bad.status).toBe(400);
      const balance = ((await w.A.get("/v1/accounts")).body["items"] ?? (await w.A.get("/v1/accounts")).body["accounts"]) as Array<{ balanceCents: number }>;
      expect(balance[0]!.balanceCents).toBe(1000);
      expect((await w.A.post("/v1/billing/change", { planId: "premium_ai", status: "active" }, null)).status).toBe(400);
    });

    // ------------------------------------------------------------ vazamento em logs e erros
    it("logs não contêm token, descrições, mensagens de chat nem valores — só metadados da requisição", async () => {
      const w = await world();
      const lines: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
      try {
        const token = await signToken(signer, { uid: w.uidA });
        const acc = (await w.A.post("/v1/accounts", { name: "NomeSecretoDaConta", type: "checking", initialBalanceCents: 0 })).body as { id: string };
        await w.A.post("/v1/transactions", { accountId: acc.id, type: "expense", amountCents: 7777, date: "2026-11-09", description: "DescricaoSecreta" });
        w.llm.script.push(say("RespostaSecreta"));
        await w.A.post("/v1/ai/chat", { message: "MensagemSecreta" });
        await w.A.get("/v1/me");
        await w.app("/v1/me", { headers: { Authorization: "Bearer token.invalido.x" } });
        const all = lines.join("\n");
        expect(all.length).toBeGreaterThan(0);
        for (const secret of ["NomeSecretoDaConta", "DescricaoSecreta", "MensagemSecreta", "RespostaSecreta", "7777", token, "Bearer", "token.invalido.x"]) {
          expect(all, secret).not.toContain(secret);
        }
      } finally {
        spy.mockRestore();
      }
    });

    it("erro interno não vaza detalhes: resposta genérica com requestId, sem stack nem mensagens do banco", async () => {
      const w = await world();
      if (w.fake) {
        w.fake.failNext(500, 500);
        const r = await w.A.get("/v1/accounts");
        expect(r.status).toBeGreaterThanOrEqual(500);
        expect(r.text).not.toMatch(/at .*\.ts|stack|firestore\.googleapis|Error:/i);
        expect((r.body["error"] as { requestId: string }).requestId).toBeTruthy();
      }
    });

    // ------------------------------------------------------------ isolamento entre usuários, TODOS os módulos
    it("ISOLAMENTO: B não lê, altera, apaga nem confirma nada de A em nenhum módulo", async () => {
      const w = await world();
      const ids = await populate(w);
      const B = w.B;
      const probes: Array<[string, string]> = [
        ["accounts", ids.account], ["transactions", ids.tx], ["payables", ids.payable], ["events", ids.event], ["tasks", ids.task],
      ];
      for (const [module, id] of probes) {
        expect((await B.get(`/v1/${module}/${id}`)).status, `GET ${module}`).toBe(404);
        expect((await B.patch(`/v1/${module}/${id}`, { description: "invadido", title: "invadido", name: "invadido" })).status, `PATCH ${module}`).toBeGreaterThanOrEqual(400);
        expect((await B.del(`/v1/${module}/${id}`)).status, `DELETE ${module}`).toBeGreaterThanOrEqual(400);
      }
      expect((await B.get(`/v1/ai/conversations/${ids.conversationId}`)).status).toBe(404);
      expect((await B.del(`/v1/ai/conversations/${ids.conversationId}`)).status).toBe(404);
      expect((await B.post(`/v1/ai/actions/${ids.conversationId}/confirm`, {})).status).toBeGreaterThanOrEqual(400);
      expect((await B.post(`/v1/payables/${ids.payable}/pay`, { accountId: ids.account, date: "2026-11-09" })).status).toBeGreaterThanOrEqual(400);

      // Listas, painel, relatórios, exportação, histórico e agenda de B não trazem nada de A.
      const everything = await Promise.all(
        ["/v1/accounts", "/v1/transactions", "/v1/payables", "/v1/overview", "/v1/reports/summary", "/v1/export/transactions?from=2026-11-01&to=2026-11-30",
          "/v1/events?from=2026-11-01&to=2026-11-30", "/v1/tasks", "/v1/notifications", "/v1/ai/conversations", "/v1/ai/history", "/v1/ai/actions",
          "/v1/billing/history", "/v1/account/export"].map((path) => B.get(path)),
      );
      for (const r of everything) {
        expect(r.status).toBeLessThan(500);
        for (const secret of ["Ana", "Segredo", "Boleto", "Consulta", "pergunta", w.uidA, "500000", ids.account]) {
          expect(r.text, secret).not.toContain(secret);
        }
      }
      // E os dados de A seguem intactos.
      expect((await w.A.get(`/v1/accounts/${ids.account}`)).status).toBe(200);
      expect((await w.A.get(`/v1/transactions/${ids.tx}`)).status).toBe(200);
      expect((await w.A.get(`/v1/events/${ids.event}`)).status).toBe(200);
    });

    it("ISOLAMENTO: B não consegue criar lançamento, pagamento ou transferência usando a conta de A", async () => {
      const w = await world();
      const ids = await populate(w);
      const mine = (await w.B.post("/v1/accounts", { name: "Minha", type: "checking", initialBalanceCents: 1000 })).body as { id: string };
      const attempts = [
        await w.B.post("/v1/transactions", { accountId: ids.account, type: "income", amountCents: 100, date: "2026-11-09", description: "plantado" }),
        await w.B.post("/v1/transfers", { fromAccountId: mine.id, toAccountId: ids.account, amountCents: 100, date: "2026-11-09" }),
        await w.B.post("/v1/transfers", { fromAccountId: ids.account, toAccountId: mine.id, amountCents: 100, date: "2026-11-09" }),
      ];
      for (const r of attempts) expect(r.status).toBeGreaterThanOrEqual(400);
      const a = (await w.A.get(`/v1/accounts/${ids.account}`)).body as { balanceCents: number };
      expect(a.balanceCents).toBe(500_000 - 4200); // saldo de A inalterado
      expect(((await w.B.get(`/v1/accounts/${mine.id}`)).body as { balanceCents: number }).balanceCents).toBe(1000);
    });

    it("ISOLAMENTO: a IA de B nunca recebe nem expõe dados de A", async () => {
      const w = await world();
      await populate(w);
      w.llm.script.push(say("ok"));
      await w.B.post("/v1/ai/chat", { message: "oi" });
      const sent = JSON.stringify(w.llm.requests.at(-1));
      for (const secret of ["Ana", "Segredo", "Boleto", "Consulta", "pergunta da Ana", w.uidA]) expect(sent, secret).not.toContain(secret);
      const conversations = (await w.B.get("/v1/ai/conversations")).body["conversations"] as unknown[];
      expect(conversations).toHaveLength(1);
    });

    it("ISOLAMENTO: assinatura e pagamentos de A são invisíveis a B e B não consegue cancelá-los", async () => {
      const w = await world();
      expect((await w.A.post("/v1/billing/checkout", { planId: "pro" })).status).toBe(201);
      expect((await w.B.get("/v1/billing/subscription")).body["subscription"]).toMatchObject({ status: "none" });
      expect((await w.B.post("/v1/billing/cancel", {}, null)).status).toBe(404);
      expect((await w.A.get("/v1/billing/subscription")).body["subscription"]).toMatchObject({ status: "pending" });
    });

    it("usuário comum não alcança o painel administrativo nem pela claim forjada no corpo/consulta", async () => {
      const w = await world();
      for (const path of ["/v1/admin/overview", "/v1/admin/plans", "/v1/admin/subscriptions", "/v1/admin/usage", "/v1/admin/logs", "/v1/admin/integrations"]) {
        expect(code(await w.A.get(`${path}?admin=true`)), path).toBe("admin_required");
      }
      const unsignedAdmin = await w.app("/v1/admin/overview", {}, await signToken(await makeSigner("outra"), { uid: "x", admin: true }));
      expect(unsignedAdmin.status).toBe(401);
    });
  });
}
