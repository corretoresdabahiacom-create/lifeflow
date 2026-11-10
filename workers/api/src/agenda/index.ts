import { notFound, type Ctx } from "../finance/common";
import { eventsRoute } from "./events";
import { notificationsRoute, remindersRoute } from "./notifications";
import { taskCategoriesRoute, tasksRoute } from "./tasks";

type Route = (ctx: Ctx, id: string | undefined, action: string | undefined) => Promise<Response>;

const ROUTES: Record<string, Route> = {
  events: eventsRoute,
  tasks: tasksRoute,
  "task-categories": taskCategoriesRoute,
  reminders: remindersRoute,
  notifications: notificationsRoute,
};

/** Rotas da agenda (`/v1/<recurso>[/<id>[/<ação>]]`). Devolve `null` quando a rota não é da agenda. */
export async function handleAgenda(ctx: Ctx): Promise<Response | null> {
  const segments = ctx.url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "v1") return null;
  const route = Object.hasOwn(ROUTES, segments[1] ?? "") ? ROUTES[segments[1] as string] : undefined;
  if (!route) return null;
  if (segments.length > 4) throw notFound("Rota");
  return route(ctx, segments[2], segments[3]);
}
