import { z } from "zod";
import { activities, executionState } from "./model";

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
 capacity: z.number().int().min(1).max(100),
 x: z.number().min(0).max(10000), y: z.number().min(0).max(10000),
 w: z.number().min(100).max(10000), h: z.number().min(100).max(10000)
});
const agent = z.object({
 id, name: z.string().min(1).max(160), color: z.string().regex(/^#[0-9a-f]{6}$/i),
 activity: z.enum(activities), roomId: id, online: z.boolean(), lastSeenAt: time.nullable(),
 tasks: z.array(taskSchema).max(200), tasksComplete: z.boolean().default(false),
 revision: z.number().int().positive().optional(), updatedAt: time.optional(), tasksObservedAt: time.optional()
});
export const officeSnapshotSchema = z.object({
 mode: z.enum(["demo", "live"]), source: z.enum(["synthetic", "mcp", "managed"]), observedAt: time,
 agents: z.array(agent).max(100), rooms: z.array(room).max(40),
 events: z.array(z.object({ at: time, message: z.string().max(1000) })).max(100)
}).superRefine((office, ctx) => {
 const issue = () => ctx.addIssue({ code: "custom", message: "Inconsistent office snapshot" });
 if ((office.mode === "demo") !== (office.source === "synthetic")) issue();
 const unique = (values: string[]) => new Set(values).size === values.length;
 if (!unique(office.rooms.map(r => r.id)) || !unique(office.agents.map(a => a.id)) || !unique(office.agents.flatMap(a => a.tasks.map(t => t.id)))) issue();
 for (const a of office.agents) {
  if (!office.rooms.some(r => r.id === a.roomId)) issue();
 }
 for (const r of office.rooms) if (office.agents.filter(a => a.roomId === r.id).length > r.capacity) issue();
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
  agents: office.agents.map(a => {
   const reportAge = a.tasksObservedAt ? now.getTime() - Date.parse(a.tasksObservedAt) : Infinity;
   const tasksFresh = office.source === "managed" ? reportAge >= 0 && reportAge <= 120000 : fresh;
   const execution = executionState(a.tasks, a.tasksComplete, tasksFresh);
   if (office.source === "managed" && !tasksFresh) execution.label = "未知";
   return { ...a, ...(office.source === "managed" ? { tasksFresh } : {}), execution };
  })
 };
}
