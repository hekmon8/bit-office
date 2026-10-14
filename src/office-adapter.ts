import { z } from "zod";
import { activities, defaultZones, executionState } from "./model";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const time = z.iso.datetime({ offset: true });
export const taskSchema = z.object({
 id, title: z.string().min(1).max(240),
 status: z.enum(["queued", "dispatched", "waiting_local_directory", "running", "completed", "failed", "cancelled"]),
 blocked: z.boolean().optional(), delegatedFrom: id.optional(), handoffNote: z.string().max(1000).optional(),
 updatedAt: time.optional(), handoffAt: time.optional()
});
const room = z.object({
 id, name: z.string().min(1).max(160), kind: z.enum(activities), topic: z.string().max(500),
 capacity: z.number().int().min(1).max(100), columns: z.number().int().min(1).max(12).optional(),
 x: z.number().min(0).max(10000), y: z.number().min(0).max(10000),
 w: z.number().min(100).max(10000), h: z.number().min(100).max(10000), zone: id
});
const zone = z.object({ id, name: z.string().min(1).max(80), description: z.string().max(240), originY: z.number().min(0).max(10000) });
const agent = z.object({
 id, name: z.string().min(1).max(160), color: z.string().regex(/^#[0-9a-f]{6}$/i),
 activity: z.enum(activities), roomId: id, zone: id, online: z.boolean(), lastSeenAt: time.nullable(),
 tasks: z.array(taskSchema).max(200), tasksComplete: z.boolean().default(false),
 parentId: id.nullish(), depth: z.number().int().min(0).max(8).optional(),
 retiredAt: time.nullish(), retireReason: z.string().max(200).optional(),
 revision: z.number().int().positive().optional(), updatedAt: time.optional(), tasksObservedAt: time.optional()
});
export const officeSnapshotSchema = z.object({
 mode: z.enum(["demo", "live"]), source: z.enum(["synthetic", "mcp", "managed"]), observedAt: time,
 agents: z.array(agent).max(500), rooms: z.array(room).max(64),
 zones: z.array(zone).min(1).max(24).default(defaultZones()),
 // Only meaningful for a filtered snapshot: the store reports how many records it withheld.
 retiredCount: z.number().int().min(0).optional(),
 events: z.array(z.object({ at: time, message: z.string().max(1000) })).max(100)
}).superRefine((office, ctx) => {
 const issue = () => ctx.addIssue({ code: "custom", message: "Inconsistent office snapshot" });
 if ((office.mode === "demo") !== (office.source === "synthetic")) issue();
 const unique = (values: string[]) => new Set(values).size === values.length;
 if (!unique(office.rooms.map(r => r.id)) || !unique(office.zones.map(z => z.id))) issue();
 if (!unique(office.agents.map(a => a.id)) || !unique(office.agents.flatMap(a => a.tasks.map(t => t.id)))) issue();
 const active = office.agents.filter(a => !a.retiredAt);
 for (const a of office.agents) {
  const home = office.rooms.find(r => r.id === a.roomId);
  // One room fixes both the location and the zone; a record may not claim another area.
  if (!home || home.zone !== a.zone) issue();
  if (a.parentId === a.id) issue();
  if (a.parentId && !office.agents.some(p => p.id === a.parentId)) issue();
  if (a.depth !== undefined && a.parentId) {
   const parent = office.agents.find(p => p.id === a.parentId);
   if (parent && a.depth !== (parent.depth ?? 0) + 1) issue();
  }
 }
 // Retired records keep their history but release their slot.
 for (const r of office.rooms) if (active.filter(a => a.roomId === r.id).length > r.capacity) issue();
});
export type OfficeSnapshot = z.infer<typeof officeSnapshotSchema>;

/** Project only known fields; transport and upstream secrets are never data fields. */
export function adaptOffice(value: unknown, now = new Date()) {
 const office = officeSnapshotSchema.parse(value);
 const age = now.getTime() - Date.parse(office.observedAt);
 const fresh = age >= 0 && age <= 120000;
 return {
  ...office,
  lastSuccessfulReadAt: now.toISOString(), snapshotFresh: fresh,
  retiredCount: office.retiredCount ?? office.agents.filter(a => a.retiredAt).length,
  agents: office.agents.map(a => {
   const reportAge = a.tasksObservedAt ? now.getTime() - Date.parse(a.tasksObservedAt) : Infinity;
   const tasksFresh = office.source === "managed" ? reportAge >= 0 && reportAge <= 120000 : fresh;
   const execution = executionState(a.tasks, a.tasksComplete, tasksFresh);
   if (office.source === "managed" && !tasksFresh) execution.label = "未知";
   return { ...a, ...(office.source === "managed" ? { tasksFresh } : {}), execution };
  })
 };
}
