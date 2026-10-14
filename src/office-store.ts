import type { DurableObjectState } from "@cloudflare/workers-types";
import { z } from "zod";
import { activities, defaultRooms, defaultZoneId, defaultZones } from "./model";
import { officeSnapshotSchema, taskSchema, type OfficeSnapshot } from "./office-adapter";
import { viewerStore } from "./viewer-store";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const name = z.string().trim().min(1).max(160);
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
export const createAgentSchema = z.strictObject({
 agent_id: id, name, color: color.default("#8daff4"),
 activity: z.enum(activities).default("offline"), room_id: id.optional(), zone_id: id.optional(),
 parent_id: id.optional()
});
export const updateAgentSchema = z.strictObject({
 agent_id: id, expected_revision: z.number().int().positive(),
 name: name.optional(), color: color.optional()
}).refine(v => v.name !== undefined || v.color !== undefined);
export const updateStatusSchema = z.strictObject({
 agent_id: id, expected_revision: z.number().int().positive(),
 activity: z.enum(activities).optional(), room_id: id.optional(), zone_id: id.optional(), online: z.boolean().optional(),
 heartbeat: z.boolean().optional(), tasks: z.array(taskSchema.strict()).max(50).optional(), tasks_complete: z.boolean().optional()
}).refine(v => [v.activity, v.room_id, v.zone_id, v.online, v.tasks, v.tasks_complete].some(x => x !== undefined) || v.heartbeat === true);
/**
 * Soft retirement: the record keeps its history (and stays readable through
 * `get_agent_state`) but releases its room slot and stops counting toward the
 * active-agent limit. `cascade` (default true) retires delegated children too,
 * because a child cannot outlive the session that owns it.
 */
export const retireAgentSchema = z.strictObject({
 agent_id: id, expected_revision: z.number().int().positive(),
 reason: z.string().trim().min(1).max(200).optional(), cascade: z.boolean().optional()
});
const commandSchema = z.discriminatedUnion("operation", [
 z.strictObject({ operation: z.literal("create_agent"), input: createAgentSchema }),
 z.strictObject({ operation: z.literal("update_agent"), input: updateAgentSchema }),
 z.strictObject({ operation: z.literal("update_agent_status"), input: updateStatusSchema }),
 z.strictObject({ operation: z.literal("retire_agent"), input: retireAgentSchema })
]);
export class OfficeError extends Error {
 constructor(readonly code: string, readonly status = 409) { super(code); }
}
/** Operational limits: environment overrides, always clamped to a sane range. */
export interface OfficeLimits { OFFICE_MAX_AGENTS?: string; OFFICE_MAX_RECORDS?: string; OFFICE_MAX_DEPTH?: string; }
function limit(raw: string | undefined, fallback: number, min: number, max: number): number {
 const parsed = Number(raw);
 return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
function initialOffice(now: string): OfficeSnapshot {
 return { mode: "live", source: "managed", observedAt: now, agents: [],
  rooms: defaultRooms().map(r => ({ ...r, topic: "" })), zones: defaultZones(), events: [] };
}
/**
 * Bring a stored snapshot up to the current code-owned catalog: rooms follow
 * the catalog (positions, capacity, zone) while their operator-editable topic
 * is preserved, and every record re-derives its zone from the room it sits in.
 * Idempotent: a reconciled snapshot reconciles to itself.
 */
export function reconcileOffice(office: OfficeSnapshot, now = new Date().toISOString()): OfficeSnapshot {
 const rooms = defaultRooms().map(r => ({ ...r, topic: office.rooms.find(x => x.id === r.id)?.topic ?? r.topic }));
 const agents = office.agents.map(a => {
  const room = rooms.find(r => r.id === a.roomId) ?? rooms.find(r => r.kind === "offline" && r.zone === a.zone) ?? rooms.find(r => r.kind === "offline")!;
  return { ...a, roomId: room.id, zone: room.zone };
 });
 for (let pass = 0; pass < 8; pass++) {
  let changed = false;
  for (const a of agents) {
   const parent = a.parentId ? agents.find(p => p.id === a.parentId) : undefined;
   const depth = parent ? (parent.depth ?? 0) + 1 : undefined;
   if (depth !== undefined && a.depth !== depth) { a.depth = depth; changed = true; }
  }
  if (!changed) break;
 }
 return { ...office, agents, rooms, zones: defaultZones() };
}
/** The whole mutation, version precondition and capacity check share one SQLite transaction. */
export class OfficeStore {
 private readonly limits: { agents: number; records: number; depth: number };
 constructor(private readonly state: DurableObjectState, env: OfficeLimits = {}) {
  this.limits = {
   agents: limit(env.OFFICE_MAX_AGENTS, 300, 1, 500),
   records: limit(env.OFFICE_MAX_RECORDS, 400, 1, 500),
   depth: limit(env.OFFICE_MAX_DEPTH, 3, 1, 8)
  };
 }
 async fetch(request: Request): Promise<Response> {
  try {
   const url = new URL(request.url), path = url.pathname;
   if (path === "/viewer-session") return await viewerStore(request, this.state);
   if (path === "/state" && request.method === "GET") {
    const now = new Date().toISOString();
    const stored = this.state.storage.kv.get<OfficeSnapshot>("office");
    const reconciled = reconcileOffice(stored ?? initialOffice(now), now);
    const parsed = officeSnapshotSchema.safeParse(reconciled);
    if (!parsed.success) return Response.json({ error: "invalid_snapshot" }, { status: 503 });
    if (!stored || JSON.stringify(stored) !== JSON.stringify(parsed.data)) this.state.storage.kv.put("office", parsed.data);
    const agents = parsed.data.agents;
    const includeRetired = url.searchParams.get("include_retired") === "1";
    return Response.json({ ...parsed.data, agents: includeRetired ? agents : agents.filter(a => !a.retiredAt),
     retiredCount: agents.filter(a => a.retiredAt).length, observedAt: now });
   }
   if (path !== "/command" || request.method !== "POST") return Response.json({ error: "not_found" }, { status: 404 });
   const command = commandSchema.safeParse(await request.json());
   if (!command.success) return Response.json({ error: "invalid_input" }, { status: 400 });
   const now = new Date().toISOString();
   const agent = this.state.storage.transactionSync(() => {
    const stored = this.state.storage.kv.get<OfficeSnapshot>("office");
    const office = reconcileOffice(stored ?? initialOffice(now), now);
    const { operation, input } = command.data;
    let agent = office.agents.find(a => a.id === input.agent_id);
    if (operation === "create_agent") {
     if (agent) throw new OfficeError("agent_exists");
     if (office.agents.filter(a => !a.retiredAt).length >= this.limits.agents) throw new OfficeError("agent_limit");
     const parent = input.parent_id ? office.agents.find(a => a.id === input.parent_id) : undefined;
     if (input.parent_id && !parent) throw new OfficeError("parent_not_found", 404);
     if (parent?.retiredAt) throw new OfficeError("parent_retired");
     const depth = parent ? (parent.depth ?? 0) + 1 : 0;
     if (parent && depth > this.limits.depth) throw new OfficeError("depth_limit", 400);
     const room = this.destination(office, input.activity, input.room_id, undefined, input.zone_id ?? parent?.zone ?? defaultZoneId);
     agent = { id: input.agent_id, name: input.name, color: input.color, activity: input.activity,
      roomId: room.id, zone: room.zone, online: false, lastSeenAt: null, tasks: [], tasksComplete: false,
      depth, ...(parent ? { parentId: parent.id } : {}), revision: 1, updatedAt: now };
     office.agents.push(agent);
    } else {
     if (!agent) throw new OfficeError("agent_not_found", 404);
     if (input.expected_revision !== agent.revision) throw new OfficeError("revision_conflict");
     if (agent.retiredAt) throw new OfficeError("agent_retired");
     if (operation === "update_agent") {
      if (input.name !== undefined) agent.name = input.name;
      if (input.color !== undefined) agent.color = input.color;
     } else if (operation === "retire_agent") {
      const cascade = input.cascade !== false;
      const targets = cascade ? office.agents.filter(a => a.id === agent!.id || this.isDescendant(office, a, agent!.id)) : [agent];
      let retiredRoot: (typeof office.agents)[number] | undefined;
      for (const target of targets) {
       target.retiredAt = now; target.activity = "offline"; target.online = false;
       if (input.reason !== undefined) target.retireReason = input.reason;
       target.revision = (target.revision ?? 0) + 1; target.updatedAt = now;
       if (target.id === input.agent_id) retiredRoot = { ...target };
      }
      this.prune(office);
      // The record budget can evict the just-retired record itself; the reply still describes it.
      agent = office.agents.find(a => a.id === input.agent_id) ?? retiredRoot!;
     } else {
      const activity = input.activity ?? agent.activity;
      const zoneId = input.zone_id ?? (input.room_id ? office.rooms.find(r => r.id === input.room_id)?.zone : undefined) ?? agent.zone;
      const room = this.destination(office, activity, input.room_id ?? (activity === agent.activity && zoneId === agent.zone ? agent.roomId : undefined), agent.id, zoneId);
      if (activity === "offline" && input.online === true) throw new OfficeError("invalid_status", 400);
      if (input.heartbeat === true && (input.online === false || activity === "offline")) throw new OfficeError("invalid_status", 400);
      agent.activity = activity; agent.roomId = room.id; agent.zone = room.zone;
      if (activity === "offline") agent.online = false;
      else if (input.online !== undefined) agent.online = input.online;
      if (input.heartbeat === true) { agent.lastSeenAt = now; agent.online = true; }
      if (input.tasks !== undefined) {
       agent.tasks = input.tasks.map(t => ({ ...t, updatedAt: t.updatedAt ?? now }));
       agent.tasksComplete = input.tasks_complete ?? false; agent.tasksObservedAt = now;
      } else if (input.tasks_complete !== undefined) { agent.tasksComplete = input.tasks_complete; agent.tasksObservedAt = now; }
     }
     if (operation !== "retire_agent") { agent.revision = (agent.revision ?? 0) + 1; agent.updatedAt = now; }
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
 /** Active records only: a retired record no longer holds the slot it used to occupy. */
 private destination(office: OfficeSnapshot, activity: typeof activities[number], roomId?: string, agentId?: string, zoneId?: string) {
  const zone = zoneId ?? (roomId ? office.rooms.find(r => r.id === roomId)?.zone : undefined) ?? defaultZoneId;
  const rooms = office.rooms.filter(r => r.zone === zone && r.kind === activity && (!roomId || r.id === roomId));
  if (!rooms.length) throw new OfficeError("invalid_room", 400);
  const room = rooms.find(r => office.agents.filter(a => a.id !== agentId && !a.retiredAt && a.roomId === r.id).length < r.capacity);
  if (!room) throw new OfficeError("room_full");
  return room;
 }
 /** Direct and transitive lineage, so retiring a session retires what it spawned. */
 private isDescendant(office: OfficeSnapshot, candidate: { id: string; parentId?: string | null }, rootId: string): boolean {
  let current = candidate.parentId ?? null;
  for (let hop = 0; current && hop < 9; hop++) {
   if (current === rootId) return true;
   current = office.agents.find(a => a.id === current)?.parentId ?? null;
  }
  return false;
 }
 /** Keep the record budget bounded by dropping the oldest retired leaves first. */
 private prune(office: OfficeSnapshot) {
  const removable = () => office.agents
   .filter(a => a.retiredAt && !office.agents.some(c => c.parentId === a.id && !c.retiredAt))
   .sort((a, b) => Date.parse(a.retiredAt!) - Date.parse(b.retiredAt!));
  while (office.agents.length > this.limits.records) {
   const victim = removable()[0];
   if (!victim) throw new OfficeError("agent_limit");
   office.agents.splice(office.agents.indexOf(victim), 1);
  }
 }
}
