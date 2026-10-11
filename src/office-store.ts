import type { DurableObjectState } from "@cloudflare/workers-types";
import { z } from "zod";
import { activities, defaultRooms } from "./model";
import { officeSnapshotSchema, taskSchema, type OfficeSnapshot } from "./office-adapter";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const name = z.string().trim().min(1).max(160);
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
export const createAgentSchema = z.strictObject({
 agent_id: id, name, color: color.default("#8daff4"),
 activity: z.enum(activities).default("offline"), room_id: id.optional()
});
export const updateAgentSchema = z.strictObject({
 agent_id: id, expected_revision: z.number().int().positive(),
 name: name.optional(), color: color.optional()
}).refine(v => v.name !== undefined || v.color !== undefined);
export const updateStatusSchema = z.strictObject({
 agent_id: id, expected_revision: z.number().int().positive(),
 activity: z.enum(activities).optional(), room_id: id.optional(), online: z.boolean().optional(),
 heartbeat: z.boolean().optional(), tasks: z.array(taskSchema.strict()).max(50).optional(), tasks_complete: z.boolean().optional()
}).refine(v => [v.activity, v.room_id, v.online, v.tasks, v.tasks_complete].some(x => x !== undefined) || v.heartbeat === true);
const commandSchema = z.discriminatedUnion("operation", [
 z.strictObject({ operation: z.literal("create_agent"), input: createAgentSchema }),
 z.strictObject({ operation: z.literal("update_agent"), input: updateAgentSchema }),
 z.strictObject({ operation: z.literal("update_agent_status"), input: updateStatusSchema })
]);
export class OfficeError extends Error {
 constructor(readonly code: string, readonly status = 409) { super(code); }
}
function initialOffice(now: string): OfficeSnapshot {
 return { mode: "live", source: "managed", observedAt: now, agents: [],
  rooms: defaultRooms().map(r => ({ ...r, topic: "" })), events: [] };
}
/** The whole mutation, version precondition and capacity check share one SQLite transaction. */
export class OfficeStore {
 constructor(private readonly state: DurableObjectState) {}
 async fetch(request: Request): Promise<Response> {
  try {
   const path = new URL(request.url).pathname;
   if (path === "/state" && request.method === "GET") {
    const stored = this.state.storage.kv.get<OfficeSnapshot>("office");
    return Response.json({ ...(stored ?? initialOffice(new Date().toISOString())), observedAt: new Date().toISOString() });
   }
   if (path !== "/command" || request.method !== "POST") return Response.json({ error: "not_found" }, { status: 404 });
   const command = commandSchema.safeParse(await request.json());
   if (!command.success) return Response.json({ error: "invalid_input" }, { status: 400 });
   const now = new Date().toISOString();
   const agent = this.state.storage.transactionSync(() => {
    const office = this.state.storage.kv.get<OfficeSnapshot>("office") ?? initialOffice(now);
    const { operation, input } = command.data;
    let agent = office.agents.find(a => a.id === input.agent_id);
    if (operation === "create_agent") {
     if (agent) throw new OfficeError("agent_exists");
     if (office.agents.length >= 100) throw new OfficeError("agent_limit");
     const room = this.destination(office, input.activity, input.room_id);
     agent = { id: input.agent_id, name: input.name, color: input.color, activity: input.activity,
      roomId: room.id, online: false, lastSeenAt: null, tasks: [], tasksComplete: false, revision: 1, updatedAt: now };
     office.agents.push(agent);
    } else {
     if (!agent) throw new OfficeError("agent_not_found", 404);
     if (input.expected_revision !== agent.revision) throw new OfficeError("revision_conflict");
     if (operation === "update_agent") {
      if (input.name !== undefined) agent.name = input.name;
      if (input.color !== undefined) agent.color = input.color;
     } else {
      const activity = input.activity ?? agent.activity;
      const room = this.destination(office, activity, input.room_id ?? (activity === agent.activity ? agent.roomId : undefined), agent.id);
      if (activity === "offline" && input.online === true) throw new OfficeError("invalid_status", 400);
      if (input.heartbeat === true && (input.online === false || activity === "offline")) throw new OfficeError("invalid_status", 400);
      agent.activity = activity; agent.roomId = room.id;
      if (activity === "offline") agent.online = false;
      else if (input.online !== undefined) agent.online = input.online;
      if (input.heartbeat === true) { agent.lastSeenAt = now; agent.online = true; }
      if (input.tasks !== undefined) {
       agent.tasks = input.tasks.map(t => ({ ...t, updatedAt: t.updatedAt ?? now }));
       agent.tasksComplete = input.tasks_complete ?? false; agent.tasksObservedAt = now;
      } else if (input.tasks_complete !== undefined) { agent.tasksComplete = input.tasks_complete; agent.tasksObservedAt = now; }
     }
     agent.revision = (agent.revision ?? 0) + 1; agent.updatedAt = now;
    }
    const tasks = office.agents.flatMap(a => a.tasks);
    if (tasks.some(t => t.delegatedFrom && (t.delegatedFrom === t.id || !tasks.some(parent => parent.id === t.delegatedFrom)))) throw new OfficeError("invalid_handoff", 400);
    office.observedAt = now;
    office.events.unshift({ at: now, message: `${operation}: ${agent.name}` }); office.events = office.events.slice(0, 100);
    const parsed = officeSnapshotSchema.safeParse(office);
    if (!parsed.success) throw new OfficeError("invalid_snapshot", 400);
    if (new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > 900000) throw new OfficeError("office_size_limit");
    this.state.storage.kv.put("office", parsed.data);
    return agent;
   });
   return Response.json({ mode: "live", source: "managed", observedAt: now, agent, runtimeStarted: false });
  } catch (error) {
   if (error instanceof OfficeError) return Response.json({ error: error.code }, { status: error.status });
   return Response.json({ error: "storage_unavailable" }, { status: 503 });
  }
 }
 private destination(office: OfficeSnapshot, activity: typeof activities[number], roomId?: string, agentId?: string) {
  const rooms = office.rooms.filter(r => r.kind === activity && (!roomId || r.id === roomId));
  if (!rooms.length) throw new OfficeError("invalid_room", 400);
  const room = rooms.find(r => office.agents.filter(a => a.id !== agentId && a.roomId === r.id).length < r.capacity);
  if (!room) throw new OfficeError("room_full");
  return room;
 }
}
