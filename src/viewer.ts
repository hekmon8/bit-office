import { authorizeManaged, type ManagedEnv } from "./managed-mcp";
import type { OAuthEnv } from "./oauth";
import { adaptOffice } from "./office-adapter";
import { instanceHeaders, instanceJson } from "./instance";
import { viewerSessionSeconds } from "./viewer-store";
type ViewerEnv = ManagedEnv & OAuthEnv;
const cookieName = "__Host-bit-office-viewer";
const csp = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
async function digest(value: string) {
 return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");
}
function credentialConfig(env: ViewerEnv) {
 const token = env.OFFICE_MCP_TOKEN;
 if (!env.OFFICE || !token || token.length < 32 || token.length > 4096 || /\s/.test(token) || [env.LIVE_READ_TOKEN, env.UPSTREAM_MCP_TOKEN].includes(token)) throw Error("not_configured");
 const issuer = new URL(env.OAUTH_ISSUER ?? "");
 if (issuer.origin !== env.OAUTH_ISSUER || !(issuer.protocol === "https:" || issuer.protocol === "http:" && ["localhost", "127.0.0.1"].includes(issuer.hostname))) throw Error("not_configured");
 return { issuer: issuer.origin, token };
}
function cookie(request: Request) {
 const values = (request.headers.get("Cookie") ?? "").split(";").map(x => x.trim()).filter(x => x.startsWith(cookieName + "="));
 const value = values.length === 1 ? values[0].slice(cookieName.length + 1) : "";
 return /^[a-f0-9]{64}$/.test(value) ? value : null;
}
function sessionCookie(value: string, seconds = viewerSessionSeconds) {
 return `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
}
async function call(env: ViewerEnv, input: unknown) {
 const stub = env.OFFICE!.get(env.OFFICE!.idFromName("office"));
 const response = await stub.fetch("https://office.internal/viewer-session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
 return response;
}
function loginPage(message = "", status = 200) {
 // Messages are fixed server-owned strings. Never echo a credential or submitted value.
 return new Response(`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Bit 小屋 · 私人登录</title><style>html{color-scheme:dark;background:#101317;color:#d8dce4;font:16px -apple-system,BlinkMacSystemFont,sans-serif}body{margin:0;min-height:100dvh;display:grid;place-items:center}.card{width:min(340px,calc(100vw - 48px));padding:24px;border:1px solid #424b57;border-radius:16px;background:#1d232b}h1{font-size:22px}p{font-size:13px;color:#a6b1be;line-height:1.7}label{display:block;margin:24px 0 10px}input,button{box-sizing:border-box;width:100%;min-height:48px;font:inherit;border-radius:8px;padding:10px}input{background:#151d27;border:1px solid #495565;color:inherit}button{margin-top:16px;border:0;background:#ac9acb;color:#18141e}.error{color:#e5b497}</style><main class="card"><h1>Bit 小屋 · 私人办公室</h1><p>登录后查看私有成员与任务上报。此页面不展示公开演示数据。</p>${message ? `<p role="alert" class="error">${message}</p>` : ""}<form method="post" action="/viewer/login" autocomplete="off"><label for="credential">办公室访问凭据</label><input id="credential" name="credential" type="password" required maxlength="4096" autocomplete="off"><button type="submit">登录查看</button></form><p>仅发送至本站验证。不会保存在应用浏览器存储，也不会交给 MCP 客户端。</p></main></html>`, { status, headers: { ...instanceHeaders, "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "same-origin", "Content-Security-Policy": csp, Vary: "Cookie" } });
}
async function form(request: Request) {
 if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
 const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
 if (reader) for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 65536) { await reader.cancel(); return null; } chunks.push(value); }
 const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
 return new URLSearchParams(new TextDecoder().decode(bytes));
}
/** Only UI/document requests are gated here; OAuth/MCP protocol endpoints remain reachable. */
export async function privateViewer(request: Request, env: ViewerEnv): Promise<Response | null> {
 const url = new URL(request.url), path = url.pathname;
 const protocol = path.startsWith("/api/") || path.startsWith("/oauth/") || path.startsWith("/.well-known/oauth-") || path === "/mcp" || path === "/mcp/oauth" || path === "/health";
 const uiDocument = !protocol && !path.startsWith("/assets/") && path !== "/favicon.ico" && path !== "/viewer/login";
 if (!uiDocument && path !== "/viewer/login" && !path.startsWith("/api/viewer/")) return null;
 try {
  const config = credentialConfig(env);
  if (url.origin !== config.issuer) return instanceJson({ error: "invalid_configuration" }, 503);
  const origin = request.headers.get("Origin");
  if (origin && origin !== config.issuer) return instanceJson({ error: "invalid_origin" }, 403);
  const fingerprint = await digest(config.issuer + "\0" + config.token);
  const value = cookie(request), session = value ? await digest(value) : null;
  if (path === "/viewer/login") {
   if (request.method === "GET") return loginPage();
   if (request.method !== "POST") return instanceJson({ error: "method_not_allowed" }, 405);
   if (origin !== config.issuer || url.search) return instanceJson({ error: "invalid_origin" }, 403);
   const input = await form(request);
   if (!input || input.getAll("credential").length !== 1 || Array.from(input.keys()).some(k => k !== "credential")) return instanceJson({ error: "invalid_input" }, 400);
   const limit = await call(env, { operation: "attempt", bucket: await digest(fingerprint + "\0" + (request.headers.get("CF-Connecting-IP") ?? "local")) });
   if (!limit.ok) return loginPage("登录请求过多，请稍后重试。", limit.status);
   const credential = input.get("credential")!;
   if (!await authorizeManaged(new Request(request.url, { headers: { Authorization: `Bearer ${credential}` } }), env)) return loginPage("访问凭据不正确。", 401);
   const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
   const created = await call(env, { operation: "create", session: await digest(nonce), fingerprint, ...(session ? { replace: session } : {}) });
   if (!created.ok) return loginPage("暂时无法建立登录会话，请稍后重试。", created.status);
   return new Response(null, { status: 303, headers: { ...instanceHeaders, Location: "/", "Set-Cookie": sessionCookie(nonce) } });
  }
  if (path === "/api/viewer/logout") {
   if (request.method !== "POST") return instanceJson({ error: "method_not_allowed" }, 405);
   if (origin !== config.issuer) return instanceJson({ error: "invalid_origin" }, 403);
   if (session) { const revoked = await call(env, { operation: "revoke", session }); if (!revoked.ok) throw Error("storage_unavailable"); }
   return new Response(null, { status: 303, headers: { ...instanceHeaders, Location: "/viewer/login", "Set-Cookie": sessionCookie("", 0) } });
  }
  let authorized = false;
  if (session) { const checked = await call(env, { operation: "check", session, fingerprint }); if (!checked.ok) throw Error("storage_unavailable"); authorized = (await checked.json() as { authorized?: boolean }).authorized === true; }
  if (!authorized) return uiDocument ? loginPage() : instanceJson({ error: "unauthorized" }, 401);
  if (uiDocument) return ["GET","HEAD"].includes(request.method)?null:instanceJson({error:"method_not_allowed"},405);
  if (path !== "/api/viewer/state") return instanceJson({ error: "not_found" }, 404);
  if (request.method !== "GET") return instanceJson({ error: "read_only" }, 405);
  const stub = env.OFFICE!.get(env.OFFICE!.idFromName("office"));
  const response = await stub.fetch("https://office.internal/state"); if (!response.ok) throw Error("storage_unavailable");
  const snapshot = adaptOffice(await response.json());
  if (snapshot.mode !== "live" || snapshot.source !== "managed") throw Error("invalid_snapshot");
  return instanceJson({ ...snapshot, stateAuthority: "client_reports", runtimeConnected: false });
 } catch { return instanceJson({ error: "viewer_unavailable" }, 503); }
}
