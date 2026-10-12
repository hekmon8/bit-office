import type { ExecutionContext } from "@cloudflare/workers-types";
import { mcpHandler } from "./mcp";
import { demoOffice } from "./model";
import { authorizeManaged, managedMcpHandler, type ManagedEnv } from "./managed-mcp";
import { handleOAuthRequest, type OAuthEnv } from "./oauth";
import { instanceMode, instanceJson } from "./instance";
import { privateViewer } from "./viewer";
export { OfficeStore } from "./office-store";
import { AdapterError, authorizeLive, readUpstreamConfig, readUpstreamOffice } from "./upstream-mcp";
export interface Env extends ManagedEnv, OAuthEnv {ASSETS:{fetch(request:Request):Promise<Response>};INSTANCE_MODE?:string;}
const headers={"X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","X-Frame-Options":"DENY","Cache-Control":"no-store"};
function json(data:unknown,status=200){return Response.json(data,{status,headers});}
export default {
 async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
  const mode=instanceMode(env.INSTANCE_MODE),url=new URL(request.url);
  if(!mode)return instanceJson({error:"invalid_instance_configuration"},503);
  if(url.pathname==="/api/instance"){
   if(request.headers.get("Origin")&&request.headers.get("Origin")!==url.origin)return instanceJson({error:"invalid_origin"},403);
   return request.method==="GET"?instanceJson(mode==="private"?{mode:"private",oauthConfigured:!!env.OAUTH_KV&&!!env.OAUTH_ISSUER}:{mode:"demo"}):instanceJson({error:"method_not_allowed"},405);
  }
  if(mode==="demo"){
   if(url.pathname.startsWith("/api/live")||url.pathname.startsWith("/api/viewer/")||url.pathname.startsWith("/viewer/")||url.pathname.startsWith("/oauth/")||url.pathname.startsWith("/.well-known/oauth-")||url.pathname==="/mcp/oauth")return instanceJson({error:"not_available_in_demo"},404);
   if(url.pathname==="/mcp"&&request.headers.has("Authorization"))return instanceJson({error:"demo_does_not_accept_private_credentials"},401);
   return handleRequest(request,{ASSETS:env.ASSETS,INSTANCE_MODE:"demo"},ctx);
  }
  if(mode==="private"){
   if(url.pathname==="/api/demo/state")return instanceJson({error:"not_available_in_private"},404);
   const viewer=await privateViewer(request,env);if(viewer)return viewer;
  }
  return await handleOAuthRequest(request, env, ctx, req => handleRequest(req, env, ctx, true))
   ?? handleRequest(request, env, ctx);
 }
};
async function handleRequest(request:Request,env:Env,ctx:ExecutionContext,oauthAuthenticated=false):Promise<Response>{
  const url=new URL(request.url);
  const origin=request.headers.get("Origin");
  if(origin&&origin!==url.origin)return json({error:"Origin not allowed"},403);
  if(url.pathname==="/health")return request.method==="GET"?json({status:"ok",mode:env.INSTANCE_MODE==="private"?"private":"demo",realDataEnabled:false,version:"0.1.0"}):json({error:"Method not allowed"},405);
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
   if(env.INSTANCE_MODE==="private"&&!oauthAuthenticated&&!request.headers.has("Authorization"))return new Response(JSON.stringify({error:"unauthorized"}),{status:401,headers:{...headers,"Content-Type":"application/json","WWW-Authenticate":`Bearer resource_metadata="${env.OAUTH_ISSUER}/.well-known/oauth-protected-resource/mcp/oauth"`}});
   let handler=mcpHandler;
   if(oauthAuthenticated || request.headers.has("Authorization")){
    try {
     if(!oauthAuthenticated && !await authorizeManaged(request,env))return new Response(JSON.stringify({error:"unauthorized"}),{status:401,headers:{...headers,"Content-Type":"application/json","WWW-Authenticate":'Bearer realm="bit-office-managed"'}});
     handler=managedMcpHandler(env, request.headers.get("Authorization")?.replace(/^Bearer /i, ""), oauthAuthenticated, env.INSTANCE_MODE==="private");
    } catch(error){return json({error:error instanceof AdapterError?error.code:"not_configured"},503);}
   }
   if(!["POST","GET","DELETE"].includes(request.method))return json({error:"Method not allowed"},405);
   if(request.method==="POST"){
    if(!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json"))return json({error:"JSON required"},415);
    const reader=request.body?.getReader();
    const parts:Uint8Array[]=[];let size=0;
    if(reader){while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();return json({error:"Request too large"},413);}parts.push(value);}}
    const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
    request=new Request(request,{body:bytes});
   }
   const response=await handler.fetch(request);
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
  if(env.INSTANCE_MODE==="private"){response.headers.set("Referrer-Policy","same-origin");response.headers.set("Cache-Control","no-store");response.headers.set("Vary","Cookie");}
  return response;
}
