import { describe, it, expect, vi, afterEach } from "vitest";
import privateConfig from "../wrangler.jsonc?raw";
import demoConfig from "../wrangler.demo.jsonc?raw";
import worker, { OfficeStore, type Env } from "../src/worker";
import demo from "../src/demo-worker";
import privateWorker from "../src/private-worker";
import { privateSnapshot, displayedExecution, syncPrivateUnknownCount } from "../src/viewer-client";
import { demoOffice } from "../src/model";
vi.hoisted(() => { Object.assign(globalThis, { Cloudflare: { compatibilityFlags: { global_fetch_strictly_public: true } } }); });
const origin = "https://private.test", token = "unit-test-private-office-credential-32-plus-chars";
function setup(host = origin, credential = token) {
 const data = new Map<string, unknown>();
 const store = new OfficeStore({ storage: { kv: {
  get: (key: string) => structuredClone(data.get(key)), put: (key: string, value: unknown) => data.set(key, structuredClone(value))
 }, transactionSync: <T>(fn: () => T) => { const before = structuredClone(data); try { return fn(); } catch (e) { data.clear(); before.forEach((v,k) => data.set(k,v)); throw e; } } } } as never);
 const officeFetch = vi.fn((url: string, init?: RequestInit) => store.fetch(new Request(url, init)));
 const env = { OFFICE_MCP_TOKEN: credential, OAUTH_ISSUER: host,
  ASSETS: { fetch: vi.fn(async () => new Response("<h1>APP</h1>")) },
  OFFICE: { idFromName: () => "office", get: () => ({ fetch: officeFetch }) }
 } as unknown as Env;
 const request = (path: string, init: RequestInit = {}) => new Request(host + path, init);
 const fetch = (path: string, init: RequestInit = {}) => privateWorker.fetch(request(path, init), env, { waitUntil() {} } as never);
 const login = (value = credential, cookie = "") => fetch("/viewer/login", { method: "POST", headers: { Origin: host, "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams({ credential: value }) });
 const rpc = async (headers: Record<string,string> = {}, method = "tools/list", params: unknown = {}) => {
  const r = await fetch("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({jsonrpc:"2.0",id:1,method,params}) });
  const text = await r.text();return { response:r, body:JSON.parse(text.startsWith("event:")||text.startsWith("data:")?text.split("\n").find(l=>l.startsWith("data:"))!.slice(5):text) };
 };
 return { env, data, officeFetch, fetch, request, login, rpc, store };
}
const cookie = (r: Response) => r.headers.get("Set-Cookie")!.split(";")[0];
afterEach(() => vi.useRealTimers());
describe("deployable instance selection",()=>{
 const config = (name: string) => JSON.parse(name==="wrangler.jsonc"?privateConfig:demoConfig);
 const entries: Record<string,typeof worker> = {"src/worker.ts":worker,"src/private-worker.ts":privateWorker,"src/demo-worker.ts":demo};
 it("the configured personal entry reads managed records only after login and denies reads after logout",async()=>{
  const c=config("wrangler.jsonc"),s=setup();expect(c.main).toBe("src/private-worker.ts");
  const selected=entries[c.main];const fetch=(path:string,init:RequestInit={})=>selected.fetch(s.request(path,init),s.env,{} as never);
  expect(await (await fetch("/api/instance")).json()).toEqual({mode:"private",oauthConfigured:false});
  expect(await (await fetch("/")).text()).toContain("私人办公室");expect((await fetch("/api/viewer/state")).status).toBe(401);
  await s.rpc({Authorization:`Bearer ${token}`},"tools/call",{name:"create_agent",arguments:{agent_id:"configured-agent",name:"Configured fixture"}});
  const logged=await fetch("/viewer/login",{method:"POST",headers:{Origin:origin,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({credential:token})});expect(logged.status).toBe(303);
  const cki=cookie(logged),state=await (await fetch("/api/viewer/state",{headers:{Cookie:cki}})).json() as any;
  expect(state.source).toBe("managed");expect(state.agents.map((a:any)=>a.id)).toEqual(["configured-agent"]);expect((await fetch("/api/demo/state")).status).toBe(404);
  expect((await fetch("/api/viewer/logout",{method:"POST",headers:{Origin:origin,Cookie:cki}})).status).toBe(303);
  expect((await fetch("/api/viewer/state",{headers:{Cookie:cki}})).status).toBe(401);
 });
 it("retains production identity, Office class, OAuth binding and migration history while staging stays isolated",()=>{
  const c=config("wrangler.jsonc");expect(c.name).toBe("bit-office");expect(c.routes).toEqual([{pattern:"agents.hekmon.com",custom_domain:true}]);
  expect(c.durable_objects.bindings).toEqual([{name:"OFFICE",class_name:"OfficeStore"}]);expect(c.migrations).toEqual([{tag:"v1-office-store",new_sqlite_classes:["OfficeStore"]}]);
  expect(c.kv_namespaces).toEqual([{binding:"OAUTH_KV",id:"a06b3f77caaf466bb9ebc1df789b3037"}]);expect(c.env.staging.routes).toEqual([]);expect(c.env.staging.name).toBe("bit-office-staging");expect(c.env.staging.kv_namespaces[0].id).not.toBe(c.kv_namespaces[0].id);
 });
 it("the configured public demo stays synthetic and read-only even when private bindings are passed",async()=>{
  const c=config("wrangler.demo.jsonc"),s=setup();expect(c.main).toBe("src/demo-worker.ts");expect(c.name).toBe("bit-office-demo");expect(c.routes).toEqual([]);
  for(const key of ["durable_objects","kv_namespaces","migrations","vars","env"])expect(c[key]).toBeUndefined();
  const selected=entries[c.main];expect((await (await selected.fetch(s.request("/api/demo/state"),s.env,{} as never)).json() as any).source).toBe("synthetic");
  const r=await selected.fetch(s.request("/mcp",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"create_agent",arguments:{agent_id:"must-not-exist",name:"Rejected"}}})}),s.env,{} as never);
  const text=await r.text(),body=JSON.parse(text.startsWith("event:")?text.split("\n").find(l=>l.startsWith("data:"))!.slice(5):text);
  expect(body.error.code).toBe(-32602);expect(s.officeFetch).not.toHaveBeenCalled();expect(s.data.has("office")).toBe(false);
 });
});
describe("strict instance boundary",()=>{
 it.each(["/api/live/state","/api/viewer/state","/viewer/login","/mcp/oauth","/oauth/register","/.well-known/oauth-authorization-server"])("demo never enters private %s",async path=>{
  const s=setup();const r=await demo.fetch(s.request(path,{headers:{Authorization:`Bearer ${token}`}}),s.env,{} as never);
  expect(r.status).toBe(404);expect(s.officeFetch).not.toHaveBeenCalled();
 });
 it("demo strips accidentally bound management credentials, storage and role overrides",async()=>{
  const s=setup();const r=await demo.fetch(s.request("/mcp",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:{}})}),{...s.env,INSTANCE_MODE:"private"},{} as never);
  const text=await r.text();const body=JSON.parse(text.startsWith("event:")?text.split("\n").find(l=>l.startsWith("data:"))!.slice(5):text);
  expect(body.result.tools).toHaveLength(5);expect(body.result.tools.every((t:any)=>t.annotations.readOnlyHint)).toBe(true);expect(s.officeFetch).not.toHaveBeenCalled();
  expect((await demo.fetch(s.request("/mcp",{headers:{Authorization:`Bearer ${token}`}}),s.env,{} as never)).status).toBe(401);
 });
 it("private never serves demo, cannot be changed by URL or client role, and requires MCP credentials",async()=>{
  const s=setup();expect((await s.fetch("/api/demo/state?mode=demo")).status).toBe(404);
  expect((await privateWorker.fetch(s.request("/api/instance?mode=demo"),{...s.env,INSTANCE_MODE:"demo"},{} as never)).status).toBe(200);
  expect(await (await s.fetch("/api/instance")).json()).toEqual({mode:"private",oauthConfigured:false});
  expect((await s.rpc()).response.status).toBe(401);
 });
 it("keeps the original PR6 entrypoint compatible while unknown modes fail closed",async()=>{
  const s=setup();expect((await worker.fetch(s.request("/api/demo/state"),s.env,{} as never)).status).toBe(200);
  expect((await worker.fetch(s.request("/api/demo/state"),{...s.env,INSTANCE_MODE:"typo"},{} as never)).status).toBe(503);
 });
});
describe("private read-only viewer sessions",()=>{
 it("gates root and alternate document routes without exposing records",async()=>{
  const s=setup();for(const path of ["/","/index.html","/rooms"]){const r=await s.fetch(path);const html=await r.text();expect(html).toContain("私人办公室");expect(html).not.toContain("<h1>APP</h1>");expect(r.headers.get("Cache-Control")).toBe("no-store");expect(r.headers.get("Referrer-Policy")).toBe("same-origin");}
  expect((await s.fetch("/api/viewer/state")).status).toBe(401);expect(s.env.ASSETS.fetch).not.toHaveBeenCalled();
 });
 it("creates a persistent secure cookie while storing neither credential nor raw session",async()=>{
  const s=setup(),r=await s.login();expect(r.status).toBe(303);expect(r.headers.get("Location")).toBe("/");const c=r.headers.get("Set-Cookie")!;
  for(const flag of ["__Host-bit-office-viewer=","HttpOnly","Secure","SameSite=Lax","Path=/","Max-Age=2592000"])expect(c).toContain(flag);
  expect(JSON.stringify(Array.from(s.data.values()))).not.toContain(token);expect(JSON.stringify(Array.from(s.data.values()))).not.toContain(cookie(r).split("=")[1]);
  const page=await s.fetch("/",{headers:{Cookie:cookie(r)}});expect(await page.text()).toContain("APP");expect(page.headers.get("Cache-Control")).toBe("no-store");
 });
 it("keeps a login beyond thirty minutes and across days, then expires at thirty days",async()=>{
  vi.useFakeTimers();const start=Date.now(),s=setup(),c=cookie(await s.login());
  for(const elapsed of [31*60*1000,24*60*60*1000,30*24*60*60*1000-1]){
   vi.setSystemTime(start+elapsed);
   expect((await s.fetch("/api/viewer/state",{headers:{Cookie:c}})).status).toBe(200);
  }
  vi.setSystemTime(start+30*24*60*60*1000);
  expect((await s.fetch("/api/viewer/state",{headers:{Cookie:c}})).status).toBe(401);
 });
 it("reads only projected managed records with nullable heartbeat and unknown task completeness",async()=>{
  const s=setup();await s.rpc({Authorization:`Bearer ${token}`} ,"tools/call",{name:"create_agent",arguments:{agent_id:"private-agent",name:"Private Agent"}});
  const r=await s.login(),response=await s.fetch("/api/viewer/state",{headers:{Cookie:cookie(r)}}),body=await response.json() as any;
  expect(body.source).toBe("managed");expect(body.stateAuthority).toBe("client_reports");expect(body.runtimeConnected).toBe(false);expect(body.agents).toHaveLength(1);expect(body.agents[0].lastSeenAt).toBeNull();expect(body.agents[0].execution.label).toBe("未知");expect(JSON.stringify(body)).not.toContain(token);expect(JSON.stringify(body)).not.toContain("viewer:sessions");
 });
 it("does not turn a viewer cookie into a management credential or write API",async()=>{
  const s=setup(),c=cookie(await s.login());expect((await s.rpc({Cookie:c})).response.status).toBe(401);
  expect((await s.rpc({Authorization:`Bearer ${c.split("=")[1]}`})).response.status).toBe(401);
  expect((await s.fetch("/api/viewer/state",{method:"POST",headers:{Cookie:c}})).status).toBe(405);expect(s.data.has("office")).toBe(false);
 });
 it("uses a fixed-token challenge when the private instance has no OAuth binding",async()=>{
  const s=setup(),r=await s.fetch("/mcp");expect(r.status).toBe(401);expect(r.headers.get("WWW-Authenticate")).toBe('Bearer realm="bit-office-managed"');
 });
 it("keeps OAuth discovery reachable independently of viewer login",async()=>{
  const s=setup();expect((await s.fetch("/.well-known/oauth-authorization-server")).status).toBe(503);expect((await s.fetch("/mcp/oauth")).status).toBe(503);
  expect((await s.rpc({Authorization:`Bearer ${token}`})).body.result.tools).toHaveLength(8);
 });
 it("rejects wrong credentials, absent/foreign Origin and oversized or ambiguous forms",async()=>{
  const s=setup();expect((await s.login("wrong")).status).toBe(401);
  for(const headers of [{},{Origin:"https://evil.test"}] as Record<string,string>[])expect((await s.fetch("/viewer/login",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",...headers},body:new URLSearchParams({credential:token})})).status).toBe(403);
  expect((await s.fetch("/viewer/login",{method:"POST",headers:{Origin:origin,"Content-Type":"application/x-www-form-urlencoded"},body:"credential="+"x".repeat(65537)})).status).toBe(400);
  expect((await s.fetch("/viewer/login",{method:"POST",headers:{Origin:origin,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams([["credential",token],["credential",token]])})).status).toBe(400);
  expect(s.data.has("viewer:sessions")).toBe(false);
 });
 it("rate limits repeated login attempts without unbounded per-IP state",async()=>{
  const s=setup();for(let i=0;i<10;i++)expect((await s.login("wrong")).status).toBe(401);expect((await s.login()).status).toBe(429);
 });
 it("revokes immediately, clears the browser cookie, and rejects replay",async()=>{
  const s=setup(),c=cookie(await s.login());const r=await s.fetch("/api/viewer/logout",{method:"POST",headers:{Origin:origin,Cookie:c}});
  expect(r.status).toBe(303);expect(r.headers.get("Set-Cookie")).toContain("Max-Age=0");expect((await s.fetch("/api/viewer/state",{headers:{Cookie:c}})).status).toBe(401);
 });
 it("rejects cross-instance cookies, duplicates, management-secret rotation and expired sessions",async()=>{
  const s=setup(),c=cookie(await s.login()),other=setup("https://other.test");expect((await other.fetch("/api/viewer/state",{headers:{Cookie:c}})).status).toBe(401);
  const sharedRequest=new Request("https://other.test/api/viewer/state",{headers:{Cookie:c}});expect((await privateWorker.fetch(sharedRequest,{...s.env,OAUTH_ISSUER:"https://other.test"},{} as never)).status).toBe(401);
  expect((await s.fetch("/api/viewer/state",{headers:{Cookie:c+"; "+c}})).status).toBe(401);
  const request=s.request("/api/viewer/state",{headers:{Cookie:c}});expect((await privateWorker.fetch(request,{...s.env,OFFICE_MCP_TOKEN:"unit-test-rotated-credential-32-characters"},{} as never)).status).toBe(401);
  vi.useFakeTimers();vi.setSystemTime(Date.now()+30*24*60*60*1000);expect((await s.fetch("/api/viewer/state",{headers:{Cookie:c}})).status).toBe(401);
 });
 it("does not permit logout via GET or foreign origins; never returns private fallback on storage failure",async()=>{
  const s=setup(),c=cookie(await s.login());expect((await s.fetch("/api/viewer/logout",{headers:{Cookie:c}})).status).toBe(405);
  expect((await s.fetch("/api/viewer/logout",{method:"POST",headers:{Origin:"https://evil.test",Cookie:c}})).status).toBe(403);
  s.officeFetch.mockRejectedValueOnce(Error("sensitive storage details"));const r=await s.fetch("/api/viewer/state",{headers:{Cookie:c}});expect(r.status).toBe(503);expect(await r.text()).not.toContain("sensitive");
 });
 it("replaces a previously signed-in session on a new login",async()=>{
  const s=setup(),old=cookie(await s.login()),next=cookie(await s.login(token,old));expect(old).not.toBe(next);expect((await s.fetch("/api/viewer/state",{headers:{Cookie:old}})).status).toBe(401);expect((await s.fetch("/api/viewer/state",{headers:{Cookie:next}})).status).toBe(200);
 });
});
describe("private viewer data semantics",()=>{
 it("rejects synthetic fallback and strips unprojected fields",()=>{
  expect(()=>privateSnapshot(demoOffice())).toThrow("invalid_private_snapshot");const o=demoOffice();const agents=o.agents.map(a=>({...a,tasksComplete:false,privateSecret:"not-a-real-secret"}));const snapshot=privateSnapshot({...o,mode:"live",source:"managed",agents});expect(JSON.stringify(snapshot)).not.toContain("privateSecret");
 });
 it("keeps incomplete, stale, future and failed reads unknown instead of claiming idle or current execution",()=>{
  const a={...demoOffice().agents.find(a=>a.id==="mira")!,tasksComplete:false,tasksObservedAt:new Date().toISOString()};expect(displayedExecution(a,true,true).running).toBe(1);
  for(const stamp of [undefined,"invalid",new Date(Date.now()-120001).toISOString(),new Date(Date.now()+60000).toISOString()])expect(displayedExecution({...a,tasksObservedAt:stamp},true,true).label).toBe("未知");
  expect(displayedExecution(a,true,false).label).toBe("未知");expect(displayedExecution({...a,tasks:[]},true,true).label).toBe("未知");expect(displayedExecution({...a,tasks:[],tasksComplete:true},true,true).label).toBe("空闲");
 });
});

describe("private status dialog freshness",()=>{
 it("updates an open dialog counter after failed refresh, task-report expiry and recovery",()=>{
  const now=Date.now(),a={...demoOffice().agents[0],tasks:[],tasksComplete:true,tasksObservedAt:new Date(now).toISOString()};
  const counter={textContent:"old"};
  syncPrivateUnknownCount(counter,[a],true,now);expect(counter.textContent).toBe("0 位成员任务状态未知");
  syncPrivateUnknownCount(counter,[a],false,now);expect(counter.textContent).toBe("1 位成员任务状态未知");
  syncPrivateUnknownCount(counter,[a],true,now+120001);expect(counter.textContent).toBe("1 位成员任务状态未知");
  syncPrivateUnknownCount(counter,[{...a,tasksObservedAt:new Date(now+120001).toISOString()}],true,now+120001);expect(counter.textContent).toBe("0 位成员任务状态未知");
 });
});
