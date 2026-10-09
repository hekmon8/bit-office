import { Client, StreamableHTTPClientTransport, type FetchLike } from "@modelcontextprotocol/client";
import { adaptOffice } from "./office-adapter";

export interface UpstreamEnv {
 UPSTREAM_MCP_URL?: string;
 UPSTREAM_MCP_AUTH?: string;
 UPSTREAM_MCP_TOKEN?: string;
 UPSTREAM_MCP_API_KEY_HEADER?: string;
 UPSTREAM_MCP_STATE_TOOL?: string;
 LIVE_READ_TOKEN?: string;
}
export type AdapterErrorCode = "not_configured" | "invalid_configuration" | "upstream_auth_failed" | "upstream_unavailable" | "upstream_timeout" | "response_too_large" | "unsupported_tool" | "invalid_snapshot";
export class AdapterError extends Error {
 constructor(readonly code: AdapterErrorCode, readonly status = 502) { super(code); }
}
const failConfig = (): never => { throw new AdapterError("invalid_configuration", 503); };
const validToken = (token: string | undefined): token is string => !!token && token.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(token);
export function readUpstreamConfig(env: UpstreamEnv) {
 if (!env.UPSTREAM_MCP_URL) throw new AdapterError("not_configured", 503);
 let url: URL;
 try { url = new URL(env.UPSTREAM_MCP_URL); } catch { return failConfig(); }
 // Only operator-configured public HTTPS endpoints; no request-controlled targets.
 const host = url.hostname.toLowerCase();
 if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443") ||
  !host.includes(".") || host.endsWith(".") || /^[\d.]+$/.test(host) || host.includes(":") ||
  /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)) return failConfig();
 const authType = env.UPSTREAM_MCP_AUTH;
 if (authType !== "none" && authType !== "bearer" && authType !== "api_key") return failConfig();
 const token = env.UPSTREAM_MCP_TOKEN;
 if (authType !== "none" && !validToken(token)) return failConfig();
 if (authType === "none" && token) return failConfig();
 if (!validToken(env.LIVE_READ_TOKEN) || env.LIVE_READ_TOKEN.length < 32 || env.LIVE_READ_TOKEN === token) return failConfig();
 const tool = env.UPSTREAM_MCP_STATE_TOOL ?? "get_office_state";
 if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(tool)) return failConfig();
 if ([token, env.LIVE_READ_TOKEN].some(secret => secret && tool.includes(secret))) return failConfig();
 const requestHeaders = new Headers();
 if (authType === "bearer") requestHeaders.set("Authorization", `Bearer ${token}`);
 if (authType === "api_key") {
  const header = env.UPSTREAM_MCP_API_KEY_HEADER ?? "X-API-Key";
  // Do not allow configuration to replace cookies, routing or transport headers.
  if (!/^x-[a-z0-9-]{1,64}$/i.test(header) || /^(x-forwarded-|x-real-|x-http-method|x-original-|x-rewrite-)/i.test(header)) return failConfig();
  requestHeaders.set(header, token!);
 }
 return { url, authType, tool, requestHeaders };
}
export async function authorizeLive(request: Request, env: UpstreamEnv) {
 const token = env.LIVE_READ_TOKEN;
 if (!validToken(token) || token.length < 32) throw new AdapterError("not_configured", 503);
 const supplied = request.headers.get("Authorization");
 if (!supplied || supplied.length > 4103) return false;
 const digest = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
 const [expected, actual] = await Promise.all([digest(`Bearer ${token}`), digest(supplied)]);
 const a = new Uint8Array(expected), b = new Uint8Array(actual);
 let difference = 0; for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
 return difference === 0;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const READ_TIMEOUT_MS = 10000;
const CLEANUP_TIMEOUT_MS = 1000;
/** Bounded, same-endpoint fetch: redirects never forward a credential. */
function guardedFetch(endpoint: URL, readController: AbortController): FetchLike {
 return async (input, init) => {
  // Session DELETE is best-effort cleanup with its own short deadline.
  const signal = init?.method === "DELETE" ? AbortSignal.timeout(CLEANUP_TIMEOUT_MS) : readController.signal;
  signal.throwIfAborted();
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (target.href !== endpoint.href) throw new AdapterError("upstream_unavailable");
  const response = await fetch(input, { ...init, redirect: "manual", signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
  if (response.status >= 300 && response.status < 400) {
   await response.body?.cancel(); throw new AdapterError("upstream_unavailable");
  }
  if (response.status === 401 || response.status === 403) {
   await response.body?.cancel(); throw new AdapterError("upstream_auth_failed");
  }
  const reader = response.body?.getReader();
  if (!reader) return response;
  let bytes = 0;
  const body = new ReadableStream<Uint8Array>({
   async pull(controller) {
    try {
     const part = await reader.read();
     if (part.done) { controller.close(); return; }
     bytes += part.value.byteLength;
     if (bytes > MAX_RESPONSE_BYTES) {
      const error = new AdapterError("response_too_large");
      // SSE parser errors alone do not reject a pending RPC; cancel the whole read.
      readController.abort(error);
      await reader.cancel(); controller.error(error); return;
     }
     controller.enqueue(part.value);
    } catch (error) { controller.error(error); }
   },
   cancel(reason) { return reader.cancel(reason); }
  });
  return new Response(body, response);
 };
}

/** One request owns one client/session. No credential or workspace caches. */
export async function readUpstreamOffice(env: UpstreamEnv) {
 const config = readUpstreamConfig(env);
 const controller = new AbortController();
 const deadline = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
 const signal = controller.signal;
 const client = new Client({ name: "bit-office-adapter", version: "0.1.0" }, { capabilities: {} });
 const transport = new StreamableHTTPClientTransport(config.url, {
  requestInit: { headers: config.requestHeaders, redirect: "manual" },
  fetch: guardedFetch(config.url, controller), onInsufficientScope: "throw",
  reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 }
 });
 try {
  await client.connect(transport, { signal, timeout: READ_TIMEOUT_MS });
  // Discover only the configured, explicitly read-only tool; never expose an arbitrary proxy.
  let cursor: string | undefined, selected = false;
  const seen = new Set<string>();
  for (let page = 0; page < 10; page++) {
   const list = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: READ_TIMEOUT_MS });
   const tool = list.tools.find(t => t.name === config.tool);
   if (tool) {
    if (tool.annotations?.readOnlyHint !== true) throw new AdapterError("unsupported_tool");
    selected = true; break;
   }
   cursor = list.nextCursor;
   if (!cursor || seen.has(cursor)) break;
   seen.add(cursor);
  }
  if (!selected) throw new AdapterError("unsupported_tool");
  const result = await client.callTool({ name: config.tool, arguments: {} }, { signal, timeout: READ_TIMEOUT_MS });
  if (result.isError) throw new AdapterError("upstream_unavailable");
  let value: unknown = result.structuredContent;
  if (value === undefined) {
   const text = result.content.filter(c => c.type === "text");
   if (text.length !== 1) throw new AdapterError("invalid_snapshot");
   try { value = JSON.parse(text[0].text); } catch { throw new AdapterError("invalid_snapshot"); }
  }
  let snapshot: ReturnType<typeof adaptOffice>;
  try { snapshot = adaptOffice(value); } catch { throw new AdapterError("invalid_snapshot"); }
  const serialized = JSON.stringify(snapshot);
  if ([env.UPSTREAM_MCP_TOKEN, env.LIVE_READ_TOKEN].some(secret => secret && serialized.includes(JSON.stringify(secret).slice(1, -1)))) throw new AdapterError("invalid_snapshot");
  return snapshot;
 } catch (error) {
  if (signal.aborted && signal.reason instanceof AdapterError) throw signal.reason;
  if (signal.aborted) throw new AdapterError("upstream_timeout", 504);
  if (error instanceof AdapterError) throw error;
  // Never propagate SDK/upstream messages, URLs, headers or tokens to a caller/log.
  throw new AdapterError("upstream_unavailable");
 } finally {
  // Best-effort remote release (at most one extra second), then close local streams.
  try { if (transport.sessionId) await transport.terminateSession(); } catch { /* Local closure still required. */ }
  await client.close().catch(() => {});
  clearTimeout(deadline);
 }
}
