import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { demoOffice } from "../src/model";
import { adaptOffice } from "../src/office-adapter";
import { authorizeLive, readUpstreamConfig, readUpstreamOffice, type UpstreamEnv } from "../src/upstream-mcp";
import worker, { type Env } from "../src/worker";

const readerToken = "test-reader-token-0123456789abcdef0123456789";
const upstreamToken = "test-upstream-token-0123456789abcdef";
const config = (extra: UpstreamEnv = {}): UpstreamEnv => ({
 UPSTREAM_MCP_URL: "https://upstream.example/mcp", UPSTREAM_MCP_AUTH: "bearer",
 UPSTREAM_MCP_TOKEN: upstreamToken, LIVE_READ_TOKEN: readerToken, ...extra
});
const env = (extra: UpstreamEnv = {}) => ({ ...config(extra), ASSETS: { fetch: async () => new Response("asset") } }) as Env;
const ctx = { waitUntil: () => {} } as never;
const request = (path = "/api/live/state", token = readerToken, method = "GET") => new Request("https://bit.example" + path, { method, headers: { Authorization: `Bearer ${token}` } });
function upstream(options: { value?: unknown; structured?: boolean; readOnly?: boolean; name?: string; isError?: boolean; session?: boolean } = {}) {
 const handler = createMcpHandler(() => {
  const server = new McpServer({ name: "test-upstream", version: "1.0.0" });
  server.registerTool(options.name ?? "get_office_state", {
   inputSchema: {}, annotations: { readOnlyHint: options.readOnly ?? true }
  }, async () => {
   const value = options.value ?? demoOffice();
   return { content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(options.structured ? { structuredContent: value as Record<string, unknown> } : {}), isError: options.isError };
  });
  return server;
 });
 const calls: Request[] = [];
 const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init); calls.push(req.clone());
  if (options.session && req.method === "GET") return new Response(null, { status: 405 });
  if (options.session && req.method === "DELETE") return new Response(null, { status: 204 });
  const response = await handler.fetch(req);
  if (options.session) {
   const copy = new Response(response.body, response);
   copy.headers.set("mcp-session-id", "fixture-session"); return copy;
  }
  return response;
 });
 vi.stubGlobal("fetch", fetcher);
 return { calls, fetcher };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("server-only connection configuration", () => {
 it.each([
  ["none", undefined, null], ["bearer", upstreamToken, `Bearer ${upstreamToken}`], ["api_key", upstreamToken, null]
 ] as const)("builds %s authentication without exposing it in public metadata", (auth, token, authorization) => {
  const c = readUpstreamConfig(config({ UPSTREAM_MCP_AUTH: auth, UPSTREAM_MCP_TOKEN: token }));
  expect(c.requestHeaders.get("Authorization")).toBe(authorization);
  expect(c.requestHeaders.get("X-API-Key")).toBe(auth === "api_key" ? token : null);
 });
 it.each(["http://upstream.example/mcp", "https://127.0.0.1/mcp", "https://[::1]/mcp", "https://localhost/mcp", "https://service.local/mcp", "https://upstream.example:8443/mcp", "https://user:password@upstream.example/mcp", "https://upstream.example/mcp?token=secret", "https://upstream.example/mcp#secret"])("rejects unsafe target %s before a network request", async url => {
  const net = vi.fn(); vi.stubGlobal("fetch", net);
  await expect(readUpstreamOffice(config({ UPSTREAM_MCP_URL: url }))).rejects.toMatchObject({ code: "invalid_configuration" });
  expect(net).not.toHaveBeenCalled();
 });
 it.each([
  { UPSTREAM_MCP_AUTH: "oauth" }, { UPSTREAM_MCP_AUTH: undefined }, { UPSTREAM_MCP_TOKEN: undefined },
  { UPSTREAM_MCP_TOKEN: "a\r\nb" }, { LIVE_READ_TOKEN: upstreamToken },
  { UPSTREAM_MCP_AUTH: "none" }, { UPSTREAM_MCP_STATE_TOOL: "bad tool" },
  { UPSTREAM_MCP_AUTH: "api_key", UPSTREAM_MCP_API_KEY_HEADER: "Cookie" },
  { UPSTREAM_MCP_AUTH: "api_key", UPSTREAM_MCP_API_KEY_HEADER: "X-Forwarded-Host" }
 ])("rejects incomplete or ambiguous credentials", extra => expect(() => readUpstreamConfig(config(extra))).toThrow("invalid_configuration"));
 it("rejects a tool name containing either server credential", () => {
  expect(() => readUpstreamConfig(config({ UPSTREAM_MCP_STATE_TOOL: upstreamToken }))).toThrow("invalid_configuration");
  expect(() => readUpstreamConfig(config({ UPSTREAM_MCP_STATE_TOOL: readerToken }))).toThrow("invalid_configuration");
 });
 it("allows a server-configured API-key header", () => {
  expect(readUpstreamConfig(config({ UPSTREAM_MCP_AUTH: "api_key", UPSTREAM_MCP_API_KEY_HEADER: "X-Service-Key" })).requestHeaders.get("X-Service-Key")).toBe(upstreamToken);
 });
 it("requires independent inbound credentials", async () => {
  expect(await authorizeLive(request(), config())).toBe(true);
  expect(await authorizeLive(request(undefined, upstreamToken), config())).toBe(false);
  expect(await authorizeLive(new Request("https://bit.example/api/live/state"), config())).toBe(false);
 });
});

describe("office data adapter", () => {
 const now = new Date("2026-10-10T12:00:00Z");
 const live = () => ({ ...demoOffice(now), mode: "live", source: "mcp" });
 it("strips unknown fields and preserves synthetic provenance", () => {
  const data = { ...demoOffice(now), token: "unknown-secret", agents: demoOffice(now).agents.map(a => ({ ...a, credential: "private" })) };
  const result = adaptOffice(data, now);
  expect(result.mode).toBe("demo"); expect(result.source).toBe("synthetic");
  expect(JSON.stringify(result)).not.toContain("unknown-secret"); expect(JSON.stringify(result)).not.toContain("private");
 });
 it("uses only explicit task-completeness evidence for idle", () => {
  const data = live(), result = adaptOffice(data, now);
  expect(result.agents.find(a => a.id === "nova")?.execution.label).toBe("未知");
  expect(result.agents.find(a => a.id === "atlas")?.execution.running).toBe(1);
  expect(result.agents.find(a => a.id === "mira")?.execution).toMatchObject({ running: 1, waiting: 1, blocked: 1 });
  const complete = { ...data, agents: data.agents.map(a => ({ ...a, tasksComplete: true, lastSeenAt: null })) };
  expect(adaptOffice(complete, now).agents[0].execution.label).toBe("空闲");
 });
 it("preserves source observation and task times separately from the read time", () => {
  const value = { ...live(), observedAt: "2026-10-10T11:57:00Z", agents: live().agents.map(a => ({ ...a, tasksComplete: true })) };
  const result = adaptOffice(value, now);
  expect(result.observedAt).toBe(value.observedAt); expect(result.lastSuccessfulReadAt).toBe(now.toISOString());
  expect(result.snapshotFresh).toBe(false); expect(result.agents[0].execution.label).toBe("未知");
  expect(result.agents[0].lastSeenAt).toBe(value.agents[0].lastSeenAt);
 });
 it.each([
  (d: ReturnType<typeof live>) => { d.source = "synthetic"; },
  (d: ReturnType<typeof live>) => { d.agents[0].id = 'unsafe"id'; },
  (d: ReturnType<typeof live>) => { d.agents[0].roomId = "missing"; },
  (d: ReturnType<typeof live>) => { d.agents[0].color = "red;"; },
  (d: ReturnType<typeof live>) => { d.agents[1].id = d.agents[0].id; },
  (d: ReturnType<typeof live>) => { d.rooms[0].capacity = 1; },
  (d: ReturnType<typeof live>) => { d.observedAt = "not a date"; }
 ])("rejects malformed or contradictory snapshots", mutate => { const d = live(); mutate(d); expect(() => adaptOffice(d, now)).toThrow(); });
});

describe("official HTTP MCP client and protected adapter API", () => {
 it.each([false, true])("reads %s structured content through MCP initialization and discovery", async structured => {
  const { calls } = upstream({ structured, session: true });
  const snapshot = await readUpstreamOffice(config());
  expect(snapshot.source).toBe("synthetic"); expect(snapshot.agents).toHaveLength(12);
  const methods = await Promise.all(calls.filter(r => r.method === "POST").map(async r => (await r.json() as { method: string }).method));
  expect(methods).toContain("initialize"); expect(methods).toContain("notifications/initialized"); expect(methods).toContain("tools/list"); expect(methods).toContain("tools/call");
  expect(calls.every(r => r.headers.get("Authorization") === `Bearer ${upstreamToken}`)).toBe(true);
  expect(calls.some(r => r.method === "DELETE")).toBe(true);
  expect(calls.filter(r => r.method === "POST").slice(1).every(r => r.headers.get("mcp-session-id") === "fixture-session")).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain(upstreamToken); expect(JSON.stringify(snapshot)).not.toContain(readerToken);
 });
 it.each(["none", "api_key"])("connects with %s authentication", async auth => {
  const { calls } = upstream();
  await readUpstreamOffice(config({ UPSTREAM_MCP_AUTH: auth, UPSTREAM_MCP_TOKEN: auth === "none" ? undefined : upstreamToken }));
  expect(calls.every(r => !r.headers.has("Authorization"))).toBe(true);
  expect(calls.every(r => r.headers.get("X-API-Key") === (auth === "api_key" ? upstreamToken : null))).toBe(true);
 });
 it("reads only the operator-selected tool", async () => {
  const { calls } = upstream({ name: "office_snapshot" });
  await readUpstreamOffice(config({ UPSTREAM_MCP_STATE_TOOL: "office_snapshot" }));
  const messages = await Promise.all(calls.filter(r => r.method === "POST").map(r => r.json() as Promise<{ method: string; params: { name?: string } }>));
  expect(messages.find(m => m.method === "tools/call")?.params.name).toBe("office_snapshot");
 });
 it.each([{ readOnly: false }, { name: "unrelated_write_tool" }])("refuses write or unrelated tools", async options => {
  const { calls } = upstream(options);
  await expect(readUpstreamOffice(config())).rejects.toMatchObject({ code: "unsupported_tool" });
  const messages = await Promise.all(calls.filter(r => r.method === "POST").map(r => r.json() as Promise<{ method: string }>));
  expect(messages.some(m => m.method === "tools/call")).toBe(false);
 });
 it("protects live reads before dialing upstream, including a caller-supplied target", async () => {
  const { fetcher } = upstream();
  const unauthorized = await worker.fetch(request("/api/live/state?url=https://evil.example", upstreamToken), env(), ctx);
  expect(unauthorized.status).toBe(401); expect(fetcher).not.toHaveBeenCalled();
  expect(unauthorized.headers.get("WWW-Authenticate")).toContain("Bearer");
  const response = await worker.fetch(request(), env(), ctx);
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect((await response.json() as { source: string }).source).toBe("synthetic");
 });
 it("redacts connection configuration and rejects mutations", async () => {
  const { fetcher } = upstream();
  const response = await worker.fetch(request("/api/live/connection"), env(), ctx);
  const body = await response.text();
  expect(response.status).toBe(200); expect(body).toContain('"connectionVerified":false');
  expect(body).not.toContain(upstreamToken); expect(body).not.toContain("upstream.example");
  expect((await worker.fetch(request(undefined, readerToken, "POST"), env(), ctx)).status).toBe(405);
  expect((await worker.fetch(request("/api/live/unknown"), env(), ctx)).status).toBe(404);
  expect(fetcher).not.toHaveBeenCalled();
 });
 it("keeps the public demo separate even when credentials are configured", async () => {
  const { fetcher } = upstream();
  const response = await worker.fetch(new Request("https://bit.example/api/demo/state"), env(), ctx);
  expect((await response.json() as { source: string }).source).toBe("synthetic"); expect(fetcher).not.toHaveBeenCalled();
 });
 it.each([401, 403, 500, 302])("redacts upstream HTTP %s and never follows redirects", async status => {
  const net = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
   expect(init?.redirect).toBe("manual");
   return new Response(upstreamToken, { status, headers: status === 302 ? { Location: "https://evil.example/collect" } : {} });
  }); vi.stubGlobal("fetch", net);
  const response = await worker.fetch(request(), env(), ctx);
  expect(response.status).toBe(502); expect(await response.text()).not.toContain(upstreamToken);
  expect(net.mock.calls.every(([url]) => String(url) === "https://upstream.example/mcp")).toBe(true);
 });
 it.each([{ value: { token: upstreamToken } }, { isError: true }, { value: { ...demoOffice(), events: [{ at: new Date().toISOString(), message: upstreamToken }] } }])("does not leak invalid or credential-echoing tool data", async options => {
  upstream(options); const response = await worker.fetch(request(), env(), ctx);
  expect(response.status).toBe(502); expect(await response.text()).not.toContain(upstreamToken);
 });
 it.each(["application/json", "text/event-stream"])("cancels oversized incremental %s responses", async contentType => {
  const cancel = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
   pull(controller) { controller.enqueue(new TextEncoder().encode(" ".repeat(65536))); }, cancel
  }), { headers: { "Content-Type": contentType } })));
  await expect(readUpstreamOffice(config())).rejects.toMatchObject({ status: 502, code: "response_too_large" });
  expect(cancel).toHaveBeenCalled();
 });
 it.each(['test-upstream-token-quote"0123456789', 'test-upstream-token-backslash\\0123456789'])("rejects JSON-escaped credential echoes", async token => {
  upstream({ value: { ...demoOffice(), events: [{ at: new Date().toISOString(), message: "Echo " + token }] } });
  const response = await worker.fetch(request(), env({ UPSTREAM_MCP_TOKEN: token }), ctx);
  expect(response.status).toBe(502); expect(await response.text()).not.toContain("Echo");
 });
 it("rejects credential reflection through connection metadata", async () => {
  const response = await worker.fetch(request("/api/live/connection"), env({ UPSTREAM_MCP_STATE_TOOL: upstreamToken }), ctx);
  expect(response.status).toBe(503); expect(await response.text()).not.toContain(upstreamToken);
 });
 it("discovers a read-only tool on a later page", async () => {
  const { fetcher } = upstream(); const original = fetcher.getMockImplementation()!;
  const cursors: unknown[] = [];
  fetcher.mockImplementation(async (input, init) => {
   if (init?.method === "POST") {
    const message = JSON.parse(String(init.body));
    if (message.method === "tools/list") {
     cursors.push(message.params?.cursor);
     return Response.json({ jsonrpc: "2.0", id: message.id, result: message.params?.cursor === "next"
      ? { tools: [{ name: "get_office_state", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] }
      : { tools: [], nextCursor: "next" } });
    }
   }
   return original(input, init);
  });
  await readUpstreamOffice(config()); expect(cursors).toEqual([undefined, "next"]);
 });
 it("bounds a repeating tool cursor without calling an unrelated tool", async () => {
  const { fetcher } = upstream(); const original = fetcher.getMockImplementation()!;
  let listings = 0, toolCalls = 0;
  fetcher.mockImplementation(async (input, init) => {
   if (init?.method === "POST") {
    const message = JSON.parse(String(init.body));
    if (message.method === "tools/call") toolCalls++;
    if (message.method === "tools/list") { listings++; return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [], nextCursor: "same" } }); }
   }
   return original(input, init);
  });
  await expect(readUpstreamOffice(config())).rejects.toMatchObject({ code: "unsupported_tool" });
  expect(listings).toBe(2); expect(toolCalls).toBe(0);
 });
 it("isolates credentials and source connections across successive requests", async () => {
  const { calls } = upstream();
  await readUpstreamOffice(config()); const boundary = calls.length;
  await readUpstreamOffice(config({ UPSTREAM_MCP_TOKEN: "test-rotated-upstream-token-0123456789" }));
  expect(calls.slice(0, boundary).every(r => r.headers.get("Authorization") === `Bearer ${upstreamToken}`)).toBe(true);
  expect(calls.slice(boundary).every(r => r.headers.get("Authorization") === "Bearer test-rotated-upstream-token-0123456789")).toBe(true);
 });
 it.each(["tool", "body", "cleanup"])("bounds stalled %s after session creation and aborts background SSE", async phase => {
  vi.useFakeTimers();
  const { fetcher } = upstream({ session: true }); const original = fetcher.getMockImplementation()!;
  let backgroundAborted = false, cleanupAttempted = false;
  const stalled = (signal?: AbortSignal | null) => new Promise<Response>((_resolve, reject) => {
   if (signal?.aborted) { reject(new Error("aborted")); return; }
   signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  fetcher.mockImplementation(async (input, init) => {
   if (init?.method === "GET") {
    init.signal?.addEventListener("abort", () => { backgroundAborted = true; }, { once: true });
    return stalled(init.signal);
   }
   if (init?.method === "DELETE") {
    cleanupAttempted = true;
    if (phase === "cleanup") return stalled(init.signal);
   }
   if (init?.method === "POST" && JSON.parse(String(init.body)).method === "tools/call" && phase !== "cleanup") {
    if (phase === "tool") return stalled(init.signal);
    return new Response(new ReadableStream({ start(controller) {
     init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
    } }), { headers: { "Content-Type": "application/json" } });
   }
   return original(input, init);
  });
  // AbortSignal.timeout uses native timers, so make its cleanup signal follow the fake clock too.
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
   const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal;
  });
  const result = readUpstreamOffice(config()).catch(error => error);
  await vi.advanceTimersByTimeAsync(12000);
  const value = await result;
  if (phase === "cleanup") expect(value.source).toBe("synthetic");
  else expect(value).toMatchObject({ code: "upstream_timeout", status: 504 });
  expect(cleanupAttempted).toBe(true); expect(backgroundAborted).toBe(true);
  timeout.mockRestore();
 });
 it("times out a stalled MCP initialization without leaking the URL or Token", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
   if (init?.signal?.aborted) { reject(new Error(upstreamToken)); return; }
   init?.signal?.addEventListener("abort", () => reject(new Error(upstreamToken)), { once: true });
  })));
  const result = readUpstreamOffice(config()).catch(error => error);
  await vi.advanceTimersByTimeAsync(10001);
  const error = await result; expect(error).toMatchObject({ status: 504, code: "upstream_timeout" });
  expect(error.message).not.toContain(upstreamToken);
 });
});
