import { createHandler } from "./app";
import type { Env } from "./env";

const handle = createHandler();

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
};
