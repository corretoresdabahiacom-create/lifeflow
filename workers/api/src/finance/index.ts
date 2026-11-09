import { notFound, type Ctx } from "./common";
import { accountsRoute, categoriesRoute } from "./accounts";
import { transactionsRoute, transfersRoute } from "./ledger";
import { payablesRoute, recurringRoute } from "./payables";
import { exportRoute, overviewRoute, reconcileRoute, reportsRoute } from "./reports";

type Route = (ctx: Ctx, id: string | undefined, action: string | undefined) => Promise<Response>;

const ROUTES: Record<string, Route> = {
  accounts: accountsRoute,
  categories: categoriesRoute,
  transactions: transactionsRoute,
  transfers: transfersRoute,
  payables: payablesRoute,
  recurring: recurringRoute,
  reports: reportsRoute,
  export: exportRoute,
  reconcile: reconcileRoute,
  finance: overviewRoute,
};

/**
 * Rotas do módulo financeiro (`/v1/<recurso>[/<id>[/<ação>]]`). Devolve `null` para rotas que
 * não são financeiras. O `uid` vem do token; nenhuma rota recebe `uid` do cliente.
 */
export async function handleFinance(ctx: Ctx): Promise<Response | null> {
  const segments = ctx.url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "v1") return null;
  const route = Object.hasOwn(ROUTES, segments[1] ?? "") ? ROUTES[segments[1] as string] : undefined;
  if (!route) return null;
  if (segments.length > 4) throw notFound("Rota");
  return route(ctx, segments[2], segments[3]);
}
