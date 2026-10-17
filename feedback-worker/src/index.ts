import { handleRequest } from "./handler";
import type { Env } from "./env";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
