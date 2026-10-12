import worker, { type Env } from "./worker";
import type { ExecutionContext } from "@cloudflare/workers-types";
/** Strict public deployment: discard even accidentally supplied private bindings. */
export default { fetch(request: Request, env: Env, ctx: ExecutionContext) {
 return worker.fetch(request, { ASSETS: env.ASSETS, INSTANCE_MODE: "demo" }, ctx);
} };
