import {describe,it,expect} from "vitest";
import worker from "../src/worker";
const env={ASSETS:{fetch:async()=>new Response("asset")}} as never;
const ctx={waitUntil:()=>{}} as never;
const fetch=(path:string,options:RequestInit={})=>worker.fetch(new Request("https://bit.test"+path,options),env,ctx);
async function rpc(method:string,params:unknown={}){const r=await fetch("/mcp",{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})});const s=await r.text();return {status:r.status,body:s.startsWith("event:")||s.startsWith("data:")?JSON.parse(s.split("\n").find(l=>l.startsWith("data:"))!.slice(5)):JSON.parse(s)};}
describe("public read-only Worker",()=>{
 it("serves only synthetic data",async()=>{const r=await fetch("/api/demo/state");expect((await r.json() as any).source).toBe("synthetic");});
 it("fails closed for live data and rejects writes",async()=>{expect((await fetch("/api/live/state")).status).toBe(503);expect((await fetch("/api/demo/state",{method:"POST"})).status).toBe(405);expect((await fetch("/api/agents",{method:"POST"})).status).toBe(404);});
 it("rejects foreign origin",async()=>expect((await fetch("/mcp",{method:"POST",headers:{Origin:"https://evil.test"}})).status).toBe(403));
 it("caps actual body size even without content-length",async()=>expect((await fetch("/mcp",{method:"POST",headers:{"Content-Type":"application/json"},body:" ".repeat(65537)})).status).toBe(413));
 it("initializes with official MCP transport",async()=>{const r=await rpc("initialize",{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"test",version:"1"}});expect(r.status).toBe(200);expect(r.body.result.serverInfo.name).toBe("bit-office-demo");});
 it("advertises five read-only tools only",async()=>{const r=await rpc("tools/list");expect(r.body.result.tools).toHaveLength(5);expect(r.body.result.tools.every((t:any)=>t.annotations.readOnlyHint)).toBe(true);});
 it("reads a synthetic handoff",async()=>{const r=await rpc("tools/call",{name:"get_task_handoff",arguments:{task_id:"demo-task-qa"}});expect(JSON.parse(r.body.result.content[0].text).hasHandoff).toBe(true);});
 it("cannot invoke a write tool",async()=>{const r=await rpc("tools/call",{name:"create_agent",arguments:{}});expect(r.body.result?.isError||r.body.error).toBeTruthy();});
});
