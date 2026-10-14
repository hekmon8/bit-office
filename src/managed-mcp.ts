import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { adaptOffice } from "./office-adapter";
import { createAgentSchema, updateAgentSchema, updateStatusSchema, retireAgentSchema, OfficeError } from "./office-store";
import { authorizeLive, AdapterError, type UpstreamEnv } from "./upstream-mcp";
export interface ManagedEnv extends UpstreamEnv { OFFICE?: DurableObjectNamespace; OFFICE_MCP_TOKEN?: string; }
export async function authorizeManaged(request: Request, env: ManagedEnv) {
 const token = env.OFFICE_MCP_TOKEN;
 if (!token || !env.OFFICE) throw new AdapterError("not_configured", 503);
 if ([env.LIVE_READ_TOKEN, env.UPSTREAM_MCP_TOKEN].includes(token)) throw new AdapterError("invalid_configuration", 503);
 return authorizeLive(request, { LIVE_READ_TOKEN: token });
}
/**
 * Server-owned instructions. They ride along with every client session, so they
 * carry the reporting convention (zone, id, delegation, retirement) instead of
 * leaving each caller to guess it — but they stay short: this text is injected
 * into the model context of every connected session.
 */
const instructions = "Authenticated persistent Agent records in one operator-managed office: a floor plan of zones (areas) and rooms. Records are client reports, never verified execution, and creating one never starts a process. Reporting convention for coding sessions: pass zone_id=\"office\", use the session id as agent_id, and register a delegated child with parent_id set to the agent that spawned it; read a record before writing because every write needs its current expected_revision, and retire the record (cascade) when the session ends so the slot is released.";
export function managedMcpHandler(env: ManagedEnv, requestCredential?: string, oauth = false, privateBrowser = false) {
 // A new handler is bound to this request's verified environment, never a shared credential cache.
 const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
 const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
 const authMeta = oauth ? { securitySchemes: [{ type: "oauth2", scopes: ["office:manage"] }] } : undefined;
 const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
 const call = async (path: string, operation?: string, input?: unknown) => {
  if (input !== undefined) {
   const data = JSON.stringify(input);
   if ([requestCredential, env.OFFICE_MCP_TOKEN, env.LIVE_READ_TOKEN, env.UPSTREAM_MCP_TOKEN].some(secret => secret && data.includes(JSON.stringify(secret).slice(1, -1)))) throw new OfficeError("invalid_input", 400);
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
 const snapshot = async (includeRetired = false) => {
  try { return adaptOffice(await call(includeRetired ? "/state?include_retired=1" : "/state")); }
  catch { throw new OfficeError("storage_unavailable", 503); }
 };
 const safeWrite = async (operation: string, input: unknown) => {
  try { return result(await call("/command", operation, input)); }
  catch (error) { return { ...result({ error: error instanceof OfficeError ? error.code : "storage_unavailable" }), isError: true }; }
 };
 return createMcpHandler(() => {
  const server = new McpServer({ name: "bit-office-managed", version: "0.2.0" }, { instructions });
  server.registerTool("get_office_state", { description: "Read persistent Agent records, zones, rooms, revisions and reported task state. Retired records are omitted unless include_retired is set.", inputSchema: { include_retired: z.boolean().optional() }, annotations: read, _meta: authMeta }, async ({ include_retired }) => result(await snapshot(include_retired === true)));
  server.registerTool("get_agent_state", { description: "Read one managed Agent (retired records included), with its zone, parent lineage and the revision required for updates.", inputSchema: { agent_id: z.string().min(1).max(64) }, annotations: read, _meta: authMeta }, async ({ agent_id }) => {
   const o = await snapshot(true), agent = o.agents.find(a => a.id === agent_id);
   return agent ? result({ mode: o.mode, source: o.source, observedAt: o.observedAt, agent, execution: agent.execution }) : { ...result({ error: "agent_not_found" }), isError: true };
  });
  server.registerTool("list_rooms", { description: "List configured zones, rooms, capacities and their active occupants. A room belongs to exactly one zone and hosts one activity kind.", inputSchema: {}, annotations: read, _meta: authMeta }, async () => {
   const o = await snapshot(); return result({ mode: o.mode, source: o.source, observedAt: o.observedAt, zones: o.zones, rooms: o.rooms.map(r => ({ ...r, members: o.agents.filter(a => a.roomId === r.id).map(a => ({ id: a.id, name: a.name, zone: a.zone, parentId: a.parentId ?? null })) })) });
  });
  server.registerTool("get_task_handoff", { description: "Read explicitly reported task handoffs, not inferred runtime behavior.", inputSchema: { task_id: z.string().min(1).max(64) }, annotations: read, _meta: authMeta }, async ({ task_id }) => {
   const o = await snapshot(true), task = o.agents.flatMap(a => a.tasks).find(t => t.id === task_id); return result({ mode: o.mode, source: o.source, task: task ?? null, hasHandoff: !!task?.delegatedFrom });
  });
  server.registerTool("get_connection_info", { description: "Explain authentication, persistence and the limits of reported Agent state.", inputSchema: {}, annotations: read, _meta: authMeta }, async () => result({ mode: "live", source: "managed", transport: "streamable_http", readOnly: false, persistence: "durable_object", stateAuthority: "client_reports", runtimeConnected: false, browserSource: privateBrowser ? "managed" : "synthetic", viewerReadOnly: privateBrowser, workspaceScope: "single_operator_office", zones: "named areas on one floor; rooms are assigned by (zone, activity)" }));
  server.registerTool("create_agent", { description: "Create a persistent Agent record with a caller-selected unique ID. zone_id defaults to the parent's zone or the personal zone; parent_id links a delegated child and is depth-limited. Duplicate IDs return agent_exists without overwriting.", inputSchema: createAgentSchema, annotations: write, _meta: authMeta }, input => safeWrite("create_agent", input));
  server.registerTool("update_agent", { description: "Update Agent name/color using expected_revision from a read. Returns revision_conflict if another writer updated it.", inputSchema: updateAgentSchema, annotations: write, _meta: authMeta }, input => safeWrite("update_agent", input));
  server.registerTool("update_agent_status", { description: "Report activity, zone, room, online state, heartbeat and optionally replace tasks. Activity is not execution. Unspecified fields are preserved; task replacement defaults to incomplete unless tasks_complete is given. Requires expected_revision.", inputSchema: updateStatusSchema, annotations: write, _meta: authMeta }, input => safeWrite("update_agent_status", input));
  server.registerTool("retire_agent", { description: "Soft-retire a record: it keeps its history and stays readable through get_agent_state, but releases its room slot and stops counting toward the active-agent limit. cascade (default true) retires delegated children too. Requires expected_revision.", inputSchema: retireAgentSchema, annotations: write, _meta: authMeta }, input => safeWrite("retire_agent", input));
  return server;
 });
}
