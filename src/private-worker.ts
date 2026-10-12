import worker, { type Env } from "./worker";
import type { ExecutionContext } from "@cloudflare/workers-types";
export { OfficeStore } from "./worker";
/** The role is server-owned and cannot be selected by a request or browser. */
export default { fetch(request: Request, env: Env, ctx: ExecutionContext) {
 return worker.fetch(request, { ...env, INSTANCE_MODE: "private" }, ctx);
} };
