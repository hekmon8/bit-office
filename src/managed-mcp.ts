import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { adaptOffice } from "./office-adapter";
import { createAgentSchema, updateAgentSchema, updateStatusSchema, OfficeError } from "./office-store";
import { authorizeLive, AdapterError, type UpstreamEnv } from "./upstream-mcp";
export interface ManagedEnv extends UpstreamEnv { OFFICE?: DurableObjectNamespace; OFFICE_MCP_TOKEN?: string; }
export async function authorizeManaged(request: Request, env: ManagedEnv) {
 const token = env.OFFICE_MCP_TOKEN;
 if (!token || !env.OFFICE) throw new AdapterError("not_configured", 503);
 if ([env.LIVE_READ_TOKEN, env.UPSTREAM_MCP_TOKEN].includes(token)) throw new AdapterError("invalid_configuration", 503);
 return authorizeLive(request, { LIVE_READ_TOKEN: token });
}
export function managedMcpHandler(env: ManagedEnv) {
 // A new handler is bound to this request's verified environment, never a shared credential cache.
 const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
 const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
 const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
 const call = async (path: string, operation?: string, input?: unknown) => {
  if (input !== undefined) {
   const data = JSON.stringify(input);
   if ([env.OFFICE_MCP_TOKEN, env.LIVE_READ_TOKEN, env.UPSTREAM_MCP_TOKEN].some(secret => secret && data.includes(JSON.stringify(secret).slice(1, -1)))) throw new OfficeError("invalid_input", 400);
  }
  const stub = env.OFFICE!.get(env.OFFICE!.idFromName("office"));
  let response: Awaited<ReturnType<typeof stub.fetch>>;
  try { response = await stub.fetch(`https://office.internal${path}`, operation ? {
   method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation, input })
  } : undefined); } catch { throw new OfficeError("storage_unavailable", 503); }
  let value: { error?: string };
  try { value = await response.json() as { error?: string }; } catch { throw new OfficeError("storage_unavailable", 503); }
  if (!response.ok) throw new OfficeError(value.error ?? "storage_unavailable", response.status);
  return value;
 };
 const snapshot = async () => {
  try { return adaptOffice(await call("/state")); }
  catch { throw new OfficeError("storage_unavailable", 503); }
 };
 const safeWrite = async (operation: string, input: unknown) => {
  try { return result(await call("/command", operation, input)); }
  catch (error) { return { ...result({ error: error instanceof OfficeError ? error.code : "storage_unavailable" }), isError: true }; }
 };
 return createMcpHandler(() => {
  const server = new McpServer({ name: "bit-office-managed", version: "0.1.0" }, {
   instructions: "Authenticated persistent Agent records in one operator-managed office. Status and tasks are client reports, not verified runtime execution. Creating a record never starts a process. Updates require the current agent revision; read again after a conflict. Public demo and upstream adapters are separate sources."
  });
  server.registerTool("get_office_state", { description: "Read persistent Agent records, rooms, revisions and reported task state.", inputSchema: {}, annotations: read }, async () => result(await snapshot()));
  server.registerTool("get_agent_state", { description: "Read one managed Agent, including the revision required for updates.", inputSchema: { agent_id: z.string().min(1).max(64) }, annotations: read }, async ({ agent_id }) => {
   const o = await snapshot(), agent = o.agents.find(a => a.id === agent_id);
   return agent ? result({ mode: o.mode, source: o.source, observedAt: o.observedAt, agent, execution: agent.execution }) : { ...result({ error: "agent_not_found" }), isError: true };
  });
  server.registerTool("list_rooms", { description: "List configured rooms, capacities and persistent occupants.", inputSchema: {}, annotations: read }, async () => {
   const o = await snapshot(); return result({ mode: o.mode, source: o.source, observedAt: o.observedAt, rooms: o.rooms.map(r => ({ ...r, members: o.agents.filter(a => a.roomId === r.id).map(a => ({ id: a.id, name: a.name })) })) });
  });
  server.registerTool("get_task_handoff", { description: "Read explicitly reported task handoffs, not inferred runtime behavior.", inputSchema: { task_id: z.string().min(1).max(64) }, annotations: read }, async ({ task_id }) => {
   const o = await snapshot(), task = o.agents.flatMap(a => a.tasks).find(t => t.id === task_id); return result({ mode: o.mode, source: o.source, task: task ?? null, hasHandoff: !!task?.delegatedFrom });
  });
  server.registerTool("get_connection_info", { description: "Explain authentication, persistence and the limits of reported Agent state.", inputSchema: {}, annotations: read }, async () => result({ mode: "live", source: "managed", transport: "streamable_http", readOnly: false, persistence: "durable_object", stateAuthority: "client_reports", runtimeConnected: false, browserSource: "synthetic", workspaceScope: "single_operator_office" }));
  server.registerTool("create_agent", { description: "Create a persistent Agent record with a caller-selected unique ID. Does not start an Agent runtime. Duplicate IDs return agent_exists without overwriting.", inputSchema: createAgentSchema, annotations: write }, input => safeWrite("create_agent", input));
  server.registerTool("update_agent", { description: "Update Agent name/color using expected_revision from a read. Returns revision_conflict if another writer updated it.", inputSchema: updateAgentSchema, annotations: write }, input => safeWrite("update_agent", input));
  server.registerTool("update_agent_status", { description: "Report activity, room, online state, heartbeat and optionally replace tasks. Activity is not execution. Unspecified fields are preserved; task replacement defaults to incomplete unless tasks_complete is given. Requires expected_revision.", inputSchema: updateStatusSchema, annotations: write }, input => safeWrite("update_agent_status", input));
  return server;
 });
}
