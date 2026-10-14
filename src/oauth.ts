import type { ExecutionContext, KVNamespace } from "@cloudflare/workers-types";
import { OAuthProvider, AuthorizationError, CimdFetchError, type OAuthHelpers,
 type ConsentDescription, type OAuthResourceAuth } from "@cloudflare/workers-oauth-provider";
import { authorizeManaged, type ManagedEnv } from "./managed-mcp";

export interface OAuthEnv { OAUTH_KV?: KVNamespace; OAUTH_ISSUER?: string; }
type Env = OAuthEnv & ManagedEnv;
const scope = "office:manage";
const securityHeaders = {
 "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
 "X-Frame-Options": "DENY",
 "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
};
const errorResponse = (error: string, status: number) => Response.json({ error }, { status, headers: securityHeaders });
function tokenChallenge(issuer: string, error: string, status: number) {
 const response = errorResponse(error, status);
 response.headers.set("WWW-Authenticate", `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp/oauth", scope="${scope}", error="${error}"`);
 return response;
}
const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

async function fingerprint(token: string): Promise<string> {
 return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))))
  .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function consentPage(details: ConsentDescription, handle: string): string {
 return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权 Agents</title><style>body{font:16px system-ui;max-width:560px;margin:64px auto;padding:24px;line-height:1.6}input{box-sizing:border-box;width:100%;padding:12px}button{padding:10px 24px;margin:16px 12px 0 0}small{display:block;color:#555}</style>
<h1>授权 ${escape(details.clientName)} 访问 Agents</h1>
<p>${details.clientDomain ? `客户端域名：<strong>${escape(details.clientDomain)}</strong>` : "客户端名称由应用自行填写，请核对回调地址。"}</p>
<p>回调地址：<strong>${escape(details.redirectHost)}</strong></p>
${details.redirectIsLoopback ? "<p>授权将交给本机应用，请确认这是你刚发起的连接。</p>" : ""}
<p>允许读取、创建 Agent 记录，以及更新名称、状态和任务。这不会启动 Agent 进程。</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="handle" value="${escape(handle)}">
<label for="token">管理 Token</label><input id="token" name="token" type="password" autocomplete="off" maxlength="4096">
<small>使用服务端配置的 OFFICE_MCP_TOKEN。仅发送至本站验证，不会交给客户端或保存在浏览器中。</small>
<button name="decision" value="approve">授权连接</button><button name="decision" value="deny" formnovalidate>取消</button></form></html>`;
}

async function authorizationPage(request: Request, env: Env & { OAUTH_PROVIDER: OAuthHelpers }): Promise<Response> {
 const oauth = env.OAUTH_PROVIDER;
 try {
  if (request.method === "GET") {
   const parsed = await oauth.parseAuthRequest(request);
   if (parsed.codeChallengeMethod !== "S256" || !parsed.codeChallenge) return errorResponse("invalid_request", 400);
   if (parsed.scope.some(s => s !== scope && s !== "offline_access")) return errorResponse("invalid_scope", 400);
   const details = await oauth.describeConsent(parsed);
   const consent = await oauth.beginConsent(parsed);
   Object.entries(securityHeaders).forEach(([k, v]) => consent.headers.set(k, v));
   // no-referrer makes Chromium send Origin: null on form POSTs. Preserve same-origin CSRF checks
   // while still withholding the authorization URL when redirecting to an external client.
   consent.headers.set("Referrer-Policy", "same-origin");
   // Chromium applies form-action to 302 redirects too. Only allow the validated callback origin.
   consent.headers.set("Content-Security-Policy", securityHeaders["Content-Security-Policy"].replace("form-action 'self'", `form-action 'self' ${new URL(parsed.redirectUri).origin}`));
   consent.headers.set("Content-Type", "text/html; charset=utf-8");
   return new Response(consentPage(details, consent.handle), { headers: consent.headers });
  }
  if (request.method !== "POST") return errorResponse("method_not_allowed", 405);
  // The cookie-bound library handle protects CSRF; enforce same-origin form submission too.
  if (request.headers.get("Origin") !== env.OAUTH_ISSUER) return errorResponse("invalid_origin", 403);
  if (!request.headers.get("Content-Type")?.startsWith("application/x-www-form-urlencoded")) return errorResponse("invalid_request", 415);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  if (reader) while (true) {
   const { done, value } = await reader.read(); if (done) break;
   size += value.byteLength;
   if (size > 8192) { await reader.cancel(); return errorResponse("request_too_large", 413); }
   chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const body = new TextDecoder().decode(bytes);
  const form = new URLSearchParams(body);
  const handle = form.get("handle") ?? "";
  if (form.get("decision") === "deny") {
   const denied = await oauth.denyConsent(request, handle);
   return new Response(null, { status: 302, headers: denied.headers });
  }
  if (form.get("decision") !== "approve") return errorResponse("invalid_request", 400);
  const credential = form.get("token") ?? "";
  if (credential.length > 4096 || !await authorizeManaged(new Request(request.url, { headers: { Authorization: `Bearer ${credential}` } }), env)) {
   return errorResponse("unauthorized", 401);
  }
  const approved = await oauth.approveConsent(request, handle, { scope: [scope] });
  const { redirectTo } = await oauth.completeAuthorization({ request: approved.request,
   userId: "office-operator", metadata: {}, scope: [scope], props: { credentialFingerprint: await fingerprint(env.OFFICE_MCP_TOKEN!) } });
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
 } catch (error) {
  // The pinned SDK reports HTTP fetch failures separately from invalid metadata.
  // Treat upstream refusal/rate limits/outages as dependency failures, never as consent.
  if (error instanceof CimdFetchError && /^Failed to fetch client metadata: HTTP (403|429|5\d\d)$/.test(error.detail)) {
   return Response.json({ error: "client_metadata_unavailable", error_description: "授权服务暂时无法获取客户端信息，请联系服务管理员。" }, { status: 503, headers: securityHeaders });
  }
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) return errorResponse("invalid_authorization_request", 400);
  return errorResponse("authorization_unavailable", 503);
 }
}

/** Only this server-owned OAuth handler can enter the authenticated MCP path. */
export async function handleOAuthRequest(request: Request, env: Env, ctx: ExecutionContext,
 managed: (request: Request) => Promise<Response>): Promise<Response | null> {
 const url = new URL(request.url);
 const isMcp = url.pathname === "/mcp/oauth";
 const isOAuth = url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/.well-known/oauth-") || url.pathname === "/mcp/oauth";
 if (!isOAuth) return null;
 if (!env.OAUTH_KV || !env.OAUTH_ISSUER) return errorResponse("oauth_not_configured", 503);
 // A canonical configured origin binds every grant and token to this environment.
 let issuer: URL;
 try { issuer = new URL(env.OAUTH_ISSUER); } catch { return errorResponse("invalid_configuration", 503); }
 if (issuer.origin !== env.OAUTH_ISSUER || url.origin !== issuer.origin || !(issuer.protocol === "https:" || (issuer.protocol === "http:" && ["localhost", "127.0.0.1"].includes(issuer.hostname)))) return errorResponse("invalid_configuration", 503);
 const asMcp = (req: Request) => { const target = new URL(req.url); target.pathname = "/mcp"; return new Request(target, req); };
 if (isMcp && request.headers.has("Authorization")) {
  try {
   if (await authorizeManaged(request, env)) return managed(asMcp(request));
  } catch { return errorResponse("not_configured", 503); }
 }
 const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp/oauth", authorizeEndpoint: "/oauth/authorize", tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register", clientIdMetadataDocumentEnabled: true,
  resourceMetadata: { resource: `${issuer.origin}/mcp/oauth`, authorization_servers: [issuer.origin], resource_name: "Agents", bearer_methods_supported: ["header"] },
  scopesSupported: [scope, "offline_access"], requiredScopes: [scope], accessTokenTTL: 3600, refreshTokenTTL: 2592000,
  apiHandler: { async fetch(req: Request, bindings: Env, context: ExecutionContext) {
   const verified = context as unknown as { auth: OAuthResourceAuth; props: { credentialFingerprint?: string } };
   if (!verified.auth.scope.includes(scope)) return tokenChallenge(issuer.origin, "insufficient_scope", 403);
   if (!bindings.OFFICE_MCP_TOKEN || !bindings.OFFICE || verified.props.credentialFingerprint !== await fingerprint(bindings.OFFICE_MCP_TOKEN)) return tokenChallenge(issuer.origin, "invalid_token", 401);
   return managed(asMcp(req));
  } },
  defaultHandler: { fetch(req: Request, bindings: Env) {
   return new URL(req.url).pathname === "/oauth/authorize"
    ? authorizationPage(req, bindings as Env & { OAUTH_PROVIDER: OAuthHelpers }) : errorResponse("not_found", 404);
  } }
 });
 if (url.pathname === "/.well-known/oauth-protected-resource") {
  url.pathname += "/mcp/oauth"; request = new Request(url, request);
 }
 try { return await provider.fetch(request, { ...env }, ctx); }
 catch { return errorResponse("authorization_unavailable", 503); }
}
