import type { ExecutionContext } from "@cloudflare/workers-types";
import { mcpHandler } from "./mcp";
import { demoOffice } from "./model";
import { AdapterError, authorizeLive, readUpstreamConfig, readUpstreamOffice, type UpstreamEnv } from "./upstream-mcp";
export interface Env extends UpstreamEnv {ASSETS:{fetch(request:Request):Promise<Response>};}
const headers={"X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","X-Frame-Options":"DENY","Cache-Control":"no-store"};
function json(data:unknown,status=200){return Response.json(data,{status,headers});}
export default {
 async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
  const url=new URL(request.url);
  const origin=request.headers.get("Origin");
  if(origin&&origin!==url.origin)return json({error:"Origin not allowed"},403);
  if(url.pathname==="/health")return request.method==="GET"?json({status:"ok",mode:"demo",realDataEnabled:false,version:"0.1.0"}):json({error:"Method not allowed"},405);
  if(url.pathname.startsWith("/api/live")){
   try {
    if(!await authorizeLive(request,env))return new Response(JSON.stringify({error:"unauthorized"}),{status:401,headers:{...headers,"Content-Type":"application/json","WWW-Authenticate":'Bearer realm="bit-office-live"'}});
    if(request.method!=="GET")return json({error:"Read-only endpoint"},405);
    if(url.pathname==="/api/live/state")return json(await readUpstreamOffice(env));
    if(url.pathname==="/api/live/connection"){
     const config=readUpstreamConfig(env);
     return json({configured:true,transport:"streamable_http",authType:config.authType,stateTool:config.tool,readOnly:true,connectionVerified:false});
    }
    return json({error:"Unknown live endpoint"},404);
   } catch(error){
    if(error instanceof AdapterError)return json({error:error.code},error.status);
    return json({error:"upstream_unavailable"},502);
   }
  }
  if(url.pathname==="/api/demo/state")return request.method==="GET"?json(demoOffice()):json({error:"Read-only endpoint"},405);
  if(url.pathname.startsWith("/api/"))return json({error:"Unknown endpoint; public server has no write API"},404);
  if(url.pathname==="/mcp"){
   if(!["POST","GET","DELETE"].includes(request.method))return json({error:"Method not allowed"},405);
   if(request.method==="POST"){
    if(!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json"))return json({error:"JSON required"},415);
    const reader=request.body?.getReader();
    const parts:Uint8Array[]=[];let size=0;
    if(reader){while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();return json({error:"Request too large"},413);}parts.push(value);}}
    const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
    request=new Request(request,{body:bytes});
   }
   const response=await mcpHandler.fetch(request);
   const copy=new Response(response.body,response);
   Object.entries(headers).forEach(([k,v])=>copy.headers.set(k,v));
   return copy;
  }
  const asset=await env.ASSETS.fetch(request);
  const response=new Response(asset.body,asset);
  response.headers.set("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  response.headers.set("X-Content-Type-Options","nosniff");
  response.headers.set("Referrer-Policy","no-referrer");
  response.headers.set("X-Frame-Options","DENY");
  return response;
 }
};
