import { describe, it, expect, vi } from "vitest";
import worker, { OfficeStore, type Env } from "../src/worker";
vi.hoisted(() => { Object.assign(globalThis, { Cloudflare: { compatibilityFlags: { global_fetch_strictly_public: true } } }); });
const origin = "https://office.test";
const token = "test-office-token-with-at-least-32-characters";
const verifier = "oauth-test-verifier-with-43-characters-at-least-1234";
const redirect = "https://chatgpt.com/connector_platform/oauth/callback";
function setup(instanceMode?: "private") {
 const kv = new Map<string, { value: string; metadata?: unknown; expires?: number }>();
 const office = new Map<string, unknown>();
 const store = new OfficeStore({ storage: {
  kv: { get: (key: string) => structuredClone(office.get(key)), put: (key: string, value: unknown) => office.set(key, structuredClone(value)) },
  transactionSync: (fn: () => unknown) => fn()
 } } as never);
 const env = { INSTANCE_MODE: instanceMode, OFFICE_MCP_TOKEN: token, OAUTH_ISSUER: origin, ASSETS: { fetch: async () => new Response("asset") },
  OFFICE: { idFromName: () => "office", get: () => ({ fetch: (url: string, init?: RequestInit) => store.fetch(new Request(url, init)) }) },
  OAUTH_KV: {
   async get(key: string, options?: string | { type?: string }) {
    const entry = kv.get(key); if (!entry || (entry.expires && entry.expires < Date.now() / 1000)) return null;
    return (typeof options === "string" ? options : options?.type) === "json" ? JSON.parse(entry.value) : entry.value;
   },
   async put(key: string, value: string, options: { metadata?: unknown; expiration?: number; expirationTtl?: number } = {}) {
    kv.set(key, { value, metadata: options.metadata, expires: options.expiration ?? (options.expirationTtl ? Date.now() / 1000 + options.expirationTtl : undefined) });
   },
   async delete(key: string) { kv.delete(key); },
   async list(options: { prefix?: string } = {}) {
    return { keys: Array.from(kv).filter(([name]) => name.startsWith(options.prefix ?? "")).map(([name, entry]) => ({ name, metadata: entry.metadata })), list_complete: true, cursor: "" };
   }
  }
 } as unknown as Env;
 const fetch = (path: string, init?: RequestInit) => worker.fetch(new Request(origin + path, init), env, { waitUntil: () => {} } as never);
 const register = async (extra: Record<string, unknown> = {}) => {
  const response = await fetch("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" },
   body: JSON.stringify({ client_name: "Test MCP", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], ...extra }) });
  return { response, body: await response.json() as any };
 };
 const formPost = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) => fetch(path, { method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin, ...headers }, body: new URLSearchParams(body) });
 const rpc = async (credential?: string, name = "tools/list", params: unknown = {}, path = "/mcp/oauth") => {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
   body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: name, params }) });
  const raw = await response.text();
  const body = raw ? JSON.parse(raw.startsWith("event:") || raw.startsWith("data:") ? raw.split("\n").find(l => l.startsWith("data:"))!.slice(5) : raw) : {};
  return { response, body };
 };
 const begin = async (clientId: string, overrides: Record<string, string> = {}) => {
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", resource: origin + "/mcp/oauth", scope: "office:manage", state: "original-state", code_challenge: challenge, code_challenge_method: "S256", ...overrides });
  const response = await fetch("/oauth/authorize?" + params);
  const html = await response.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { response, html, handle, cookie };
 };
 const authorize = async () => {
  const client = (await register()).body;
  const page = await begin(client.client_id); expect(page.response.status).toBe(200);
  const approved = await formPost("/oauth/authorize", { handle: page.handle, token, decision: "approve" }, { Cookie: page.cookie });
  expect(approved.status).toBe(302);
  const callback = new URL(approved.headers.get("Location")!); expect(callback.searchParams.get("state")).toBe("original-state");
  const exchange = { grant_type: "authorization_code", client_id: client.client_id, redirect_uri: redirect, code: callback.searchParams.get("code")!, code_verifier: verifier, resource: origin + "/mcp/oauth" };
  const response = await formPost("/oauth/token", exchange); expect(response.status).toBe(200);
  return { client, page, exchange, tokens: await response.json() as any };
 };
 return { env, kv, office, fetch, rpc, register, begin, formPost, authorize };
}

describe("OAuth and fixed Bearer Token coexistence", () => {
 it("discovers OAuth with PKCE, CIMD and DCR while preserving anonymous demo and fixed-token access", async () => {
  const s = setup(); const challenge = await s.rpc(); expect(challenge.response.status).toBe(401);
  expect(challenge.response.headers.get("WWW-Authenticate")).toContain("/.well-known/oauth-protected-resource/mcp/oauth");
  const resource = await (await s.fetch("/.well-known/oauth-protected-resource")).json() as any;
  expect(resource.resource).toBe(origin + "/mcp/oauth"); expect(resource.authorization_servers).toEqual([origin]);
  const metadata = await (await s.fetch("/.well-known/oauth-authorization-server")).json() as any;
  expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
  expect(metadata.client_id_metadata_document_supported).toBe(true);
  expect(metadata.registration_endpoint).toBe(origin + "/oauth/register");
  expect((await s.rpc(undefined, "tools/list", {}, "/mcp")).body.result.tools).toHaveLength(5);
  expect((await s.rpc(token)).body.result.tools).toHaveLength(8);
  expect((await s.rpc(token, "tools/list", {}, "/mcp")).body.result.tools).toHaveLength(8);
  expect((await s.rpc("wrong")).response.status).toBe(401);
 });
 it("completes consent, code exchange, managed writes, refresh and revocation using the real library", async () => {
  const s = setup(); const auth = await s.authorize(); const access = auth.tokens.access_token;
  expect(access).not.toBe(token); expect(auth.tokens.expires_in).toBe(3600);
  expect((await s.rpc(access)).body.result.tools).toHaveLength(8);
  const created = await s.rpc(access, "tools/call", { name: "create_agent", arguments: { agent_id: "oauth-agent", name: "OAuth Agent" } });
  expect(JSON.parse(created.body.result.content[0].text).agent.id).toBe("oauth-agent");
  const updated = await s.rpc(token, "tools/call", { name: "update_agent_status", arguments: { agent_id: "oauth-agent", expected_revision: 1, activity: "working", heartbeat: true } }, "/mcp");
  expect(JSON.parse(updated.body.result.content[0].text).agent.revision).toBe(2);
  expect((await s.rpc(undefined, "tools/call", { name: "get_agent_state", arguments: { agent_id: "oauth-agent" } }, "/mcp")).body.result.isError).toBe(true);
  const refreshed = await s.formPost("/oauth/token", { grant_type: "refresh_token", client_id: auth.client.client_id, refresh_token: auth.tokens.refresh_token, resource: origin + "/mcp/oauth" });
  expect(refreshed.status).toBe(200); const next = await refreshed.json() as any;
  expect(next.refresh_token).not.toBe(auth.tokens.refresh_token); expect((await s.rpc(next.access_token)).response.status).toBe(200);
  expect((await s.formPost("/oauth/token", { token: next.refresh_token, client_id: auth.client.client_id })).status).toBe(200);
  expect((await s.rpc(next.access_token)).response.status).toBe(401);
  expect((await s.rpc(token)).response.status).toBe(200);
 });
 it("rejects wrong operator credentials and CSRF or replayed consent handles without granting access", async () => {
  const s = setup(); const client = (await s.register()).body; const p = await s.begin(client.client_id);
  const form = { handle: p.handle, token, decision: "approve" };
  expect((await s.formPost("/oauth/authorize", { ...form, token: "wrong" }, { Cookie: p.cookie })).status).toBe(401);
  expect((await s.formPost("/oauth/authorize", form, { Cookie: p.cookie, Origin: "https://evil.test" })).status).toBe(403);
  expect((await s.formPost("/oauth/authorize", form, { Cookie: p.cookie, Origin: "null" })).status).toBe(403);
  expect((await s.formPost("/oauth/authorize", form)).status).toBe(400);
  expect((await s.formPost("/oauth/authorize", form, { Cookie: p.cookie })).status).toBe(302);
  expect((await s.formPost("/oauth/authorize", form, { Cookie: p.cookie })).status).toBe(400);
  expect(JSON.stringify(Array.from(s.kv.values()))).not.toContain(token);
 });
 it("rejects unregistered redirects, non-S256 PKCE, wrong resources and unsupported scopes before consent", async () => {
  const s = setup(); const client = (await s.register()).body;
  const patches: Record<string, string>[] = [{ redirect_uri: "https://evil.test/callback" }, { code_challenge_method: "plain" }, { code_challenge: "" }, { resource: "https://other.test/mcp" }, { scope: "admin:all" }];
  for (const patch of patches) {
   const p = await s.begin(client.client_id, patch); expect(p.response.status).toBe(400); expect(p.response.headers.has("Location")).toBe(false); expect(p.handle).toBe("");
  }
 });
 it("rejects code reuse, mismatched PKCE and cross-resource tokens", async () => {
  const s = setup(); const auth = await s.authorize();
  expect((await s.formPost("/oauth/token", auth.exchange)).status).toBe(400);
  expect((await s.formPost("/oauth/token", { ...auth.exchange, code_verifier: "incorrect" })).status).toBe(400);
  expect((await s.formPost("/oauth/token", { grant_type: "refresh_token", client_id: auth.client.client_id, refresh_token: auth.tokens.refresh_token, resource: "https://other.test/mcp" })).status).toBe(400);
 });
 it("denies consent without a credential and returns the client's state and issuer", async () => {
  const s = setup(); const p = await s.begin((await s.register()).body.client_id);
  const denied = await s.formPost("/oauth/authorize", { handle: p.handle, decision: "deny" }, { Cookie: p.cookie });
  expect(denied.status).toBe(302); const callback = new URL(denied.headers.get("Location")!);
  expect(callback.searchParams.get("error")).toBe("access_denied"); expect(callback.searchParams.get("state")).toBe("original-state"); expect(callback.searchParams.get("iss")).toBe(origin);
 });
 it("rejects an incorrect PKCE verifier before issuing a token for a fresh code", async () => {
  const s = setup(); const client = (await s.register()).body; const page = await s.begin(client.client_id);
  const approved = await s.formPost("/oauth/authorize", { handle: page.handle, token, decision: "approve" }, { Cookie: page.cookie });
  const code = new URL(approved.headers.get("Location")!).searchParams.get("code")!;
  const failed = await s.formPost("/oauth/token", { grant_type: "authorization_code", client_id: client.client_id, redirect_uri: redirect, code, code_verifier: "wrong-verifier-with-43-characters-at-least-123456", resource: origin + "/mcp/oauth" });
  expect(failed.status).toBe(400); expect(await failed.json()).not.toHaveProperty("access_token");
 });
 it("enforces expiry and granted scopes on every MCP request", async () => {
  const s = setup(); const auth = await s.authorize();
  const record = Array.from(s.kv).find(([key]) => key.startsWith("token:"))!;
  const value = JSON.parse(record[1].value); value.scope = []; record[1].value = JSON.stringify(value);
  expect((await s.rpc(auth.tokens.access_token)).response.status).toBe(403);
  value.scope = ["office:manage"]; value.expiresAt = 1; record[1].value = JSON.stringify(value);
  expect((await s.rpc(auth.tokens.access_token)).response.status).toBe(401);
 });
 it("escapes self-asserted client metadata and never reflects the operator credential", async () => {
  const s = setup(); const p = await s.begin((await s.register({ client_name: '<script>alert("x")</script>' })).body.client_id);
  expect(p.html).not.toContain("<script>"); expect(p.html).toContain("&#60;script&#62;"); expect(p.html).not.toContain(token);
  expect(p.response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(p.response.headers.get("Content-Security-Policy")).toContain("form-action 'self' https://chatgpt.com");
  expect(p.response.headers.get("Referrer-Policy")).toBe("same-origin");
 });
 it("invalidates OAuth access on operator Token rotation and rejects credential persistence", async () => {
  const s = setup(); const auth = await s.authorize();
  const reflected = await s.rpc(auth.tokens.access_token, "tools/call", { name: "create_agent", arguments: { agent_id: "leak", name: auth.tokens.access_token } });
  expect(JSON.parse(reflected.body.result.content[0].text).error).toBe("invalid_input"); expect(s.office.size).toBe(0);
  s.env.OFFICE_MCP_TOKEN = "rotated-office-token-with-at-least-32-characters";
  expect((await s.rpc(auth.tokens.access_token)).response.status).toBe(401);
  expect((await s.rpc(token)).response.status).toBe(401);
  expect((await s.rpc(s.env.OFFICE_MCP_TOKEN)).response.status).toBe(200);
 });
 it("fails closed for missing or mismatched OAuth configuration and oversized form bodies", async () => {
  const s = setup();
  expect((await s.formPost("/oauth/authorize", { token: "x".repeat(9000) })).status).toBe(413);
  s.env.OAUTH_KV = undefined; expect((await s.rpc()).response.status).toBe(503);
  expect((await s.rpc(token, "tools/list", {}, "/mcp")).response.status).toBe(200);
  s.env.OAUTH_ISSUER = "https://other.test"; expect((await s.fetch("/.well-known/oauth-authorization-server")).status).toBe(503);
 });
 it("keeps fixed Bearer clients working on alternate hosts independently of OAuth configuration", async () => {
  const s = setup();
  for (const issuer of [origin, "https://wrong.test", undefined]) {
   s.env.OAUTH_ISSUER = issuer;
   const response = await worker.fetch(new Request("https://alternate.test/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }), s.env, {} as never);
   expect(response.status).toBe(200);
  }
 });
});


describe("private entrypoint keeps OAuth protocol separate from UI login",()=>{
 it("allows discovery/PKCE/refresh without a viewer cookie while keeping UI and anonymous MCP private",async()=>{
  const s=setup("private");expect(await (await s.fetch("/")).text()).toContain("私人办公室");expect((await s.fetch("/api/viewer/state")).status).toBe(401);
  const meta=await s.fetch("/.well-known/oauth-authorization-server");expect(meta.status).toBe(200);
  expect((await s.rpc(undefined,"tools/list",{},"/mcp")).response.status).toBe(401);
  const auth=await s.authorize();expect((await s.rpc(auth.tokens.access_token)).body.result.tools).toHaveLength(8);
  const refreshed=await s.formPost("/oauth/token",{grant_type:"refresh_token",client_id:auth.client.client_id,refresh_token:auth.tokens.refresh_token,resource:origin+"/mcp/oauth"});expect(refreshed.status).toBe(200);
  expect((await s.rpc(token,"tools/list",{},"/mcp")).body.result.tools).toHaveLength(8);
 });
});
