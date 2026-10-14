import { describe, it, expect } from "vitest";
import type { DurableObjectState } from "@cloudflare/workers-types";
import worker, { OfficeStore, type Env } from "../src/worker";
import { defaultRooms } from "../src/model";
const token = "managed-test-token-with-at-least-32-characters";
function setup(limits: { OFFICE_MAX_AGENTS?: string; OFFICE_MAX_RECORDS?: string; OFFICE_MAX_DEPTH?: string } = {}) {
 const data = new Map<string, unknown>();
 let failWrite = false;
 const storage = {
  kv: { get: (key: string) => structuredClone(data.get(key)), put: (key: string, value: unknown) => { if (failWrite) { failWrite = false; throw new Error("Injected storage failure"); } data.set(key, structuredClone(value)); } },
  transactionSync: <T>(fn: () => T): T => {
   const previous = structuredClone(data);
   try { return fn(); } catch (error) { data.clear(); for (const [k, v] of previous) data.set(k, v); throw error; }
  }
 };
 const makeStore = () => new OfficeStore({ storage } as unknown as DurableObjectState, limits);
 let store = makeStore(); let reads = 0;
 const env = { OFFICE_MCP_TOKEN: token, ASSETS: { fetch: async () => new Response("asset") }, OFFICE: {
  idFromName: () => "office", get: () => { reads++; return { fetch: (url: string, init?: RequestInit) => store.fetch(new Request(url, init)) }; }
 } } as unknown as Env;
 const rpc = async (method: string, params: unknown = {}, auth: string | null = token, overrides: Partial<Env> = {}) => {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (auth !== null) headers.Authorization = `Bearer ${auth}`;
  const response = await worker.fetch(new Request("https://bit.test/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), { ...env, ...overrides }, {} as never);
  const text = await response.text();
  const body = JSON.parse(text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find(l => l.startsWith("data:"))!.slice(5) : text);
  const payload = body.result?.content?.[0]?.text;
  return { status: response.status, body, value: payload?.startsWith("{") ? JSON.parse(payload) : undefined };
 };
 const call = (name: string, args: unknown, auth: string | null = token) => rpc("tools/call", { name, arguments: args }, auth);
 return { call, rpc, data, env, getReads: () => reads, failNextWrite: () => { failWrite = true; }, restart: () => { store = makeStore(); } };
}
describe("persistent authenticated Agent tools", () => {
 it("requires authentication before accessing storage, and never downgrades an invalid token to demo", async () => {
  const s = setup(); const invalid = await s.call("create_agent", { agent_id: "private", name: "Private" }, "wrong");
  expect(invalid.status).toBe(401); expect(s.getReads()).toBe(0); expect(s.data.size).toBe(0);
  expect((await s.rpc("tools/list", {}, token, { OFFICE_MCP_TOKEN: undefined })).status).toBe(503);
  expect((await s.rpc("tools/list", {}, token, { OFFICE: undefined })).status).toBe(503);
  expect((await s.rpc("tools/list", {}, token, { LIVE_READ_TOKEN: token })).status).toBe(503);
  expect((await s.rpc("tools/list", {}, token, { UPSTREAM_MCP_TOKEN: token })).status).toBe(503);
 });
 it("exposes 9 tools only to authenticated clients, with accurate write annotations", async () => {
  const s = setup();const managed = await s.rpc("tools/list");
  expect(managed.body.result.tools).toHaveLength(9);
  expect(managed.body.result.tools.filter((t: any) => !t.annotations.readOnlyHint).map((t: any) => t.name)).toEqual(["create_agent", "update_agent", "update_agent_status", "retire_agent"]);
  const publicTools = await s.rpc("tools/list", {}, null); expect(publicTools.body.result.tools).toHaveLength(5);
  expect(publicTools.body.result.tools.every((t: any) => t.annotations.readOnlyHint)).toBe(true);
 });
 it("creates durable records, reads them across object restarts and never exposes them publicly", async () => {
  const s = setup(); const created = await s.call("create_agent", { agent_id: "private", name: "Private" });
  expect(created.value.agent).toMatchObject({ id: "private", online: false, lastSeenAt: null, revision: 1, tasksComplete: false });
  expect(created.value.runtimeStarted).toBe(false); s.restart();
  const state = await s.call("get_office_state", {}); expect(state.value.source).toBe("managed"); expect(state.value.agents).toHaveLength(1);
  expect(state.value.agents[0].execution.label).toBe("未知"); expect(state.value.events).toHaveLength(1);
  expect((await s.call("get_agent_state", { agent_id: "private" }, null)).body.result.isError).toBe(true);
  const publicWrite = await s.call("create_agent", { agent_id: "public", name: "Public" }, null); expect(publicWrite.body.result?.isError || publicWrite.body.error).toBeTruthy();
  expect(s.data.get("office")).not.toHaveProperty("token");
 });
 it("rejects duplicate IDs without overwriting existing records", async () => {
  const s = setup(); await s.call("create_agent", { agent_id: "one", name: "First" });
  expect((await s.call("create_agent", { agent_id: "one", name: "Second" })).value.error).toBe("agent_exists");
  expect((await s.call("get_agent_state", { agent_id: "one" })).value.agent.name).toBe("First");
 });
 it("updates profile and status only at the expected revision, preserving unrelated fields", async () => {
  const s = setup(); await s.call("create_agent", { agent_id: "one", name: "First" });
  const profile = await s.call("update_agent", { agent_id: "one", expected_revision: 1, name: "Renamed" }); expect(profile.value.agent.revision).toBe(2);
  const result = await s.call("update_agent_status", { agent_id: "one", expected_revision: 2, activity: "working", heartbeat: true });
  expect(result.value.agent).toMatchObject({ name: "Renamed", activity: "working", roomId: "desks", online: true, revision: 3 }); expect(result.value.agent.lastSeenAt).not.toBeNull();
  expect((await s.call("get_agent_state", { agent_id: "one" })).value.execution.label).toBe("未知");
  expect((await s.call("update_agent_status", { agent_id: "one", expected_revision: 2, activity: "resting" })).value.error).toBe("revision_conflict");
 });
 it("does not fabricate heartbeats when only profile or activity changes", async () => {
  const s = setup(); await s.call("create_agent", { agent_id: "one", name: "First" });
  const status = await s.call("update_agent_status", { agent_id: "one", expected_revision: 1, activity: "working", online: true });
  expect(status.value.agent.lastSeenAt).toBeNull(); expect(status.value.agent.tasks).toEqual([]); expect(status.value.agent.tasksComplete).toBe(false);
 });
 it("accepts task reports without equating connectivity with running, and preserves task event times", async () => {
  const s = setup(); await s.call("create_agent", { agent_id: "one", name: "First" }); const at = "2026-01-01T00:00:00.000Z";
  const report = await s.call("update_agent_status", { agent_id: "one", expected_revision: 1, activity: "working", online: false, tasks: [{ id: "task", title: "Reported task", status: "running", updatedAt: at }], tasks_complete: true });
  expect(report.value.agent.online).toBe(false);expect(report.value.agent.tasks[0].updatedAt).toBe(at);
  expect((await s.call("get_agent_state", { agent_id: "one" })).value.execution).toMatchObject({ running: 1, label: "运行" });
  await s.call("update_agent_status", { agent_id: "one", expected_revision: 2, tasks: [] });
  expect((await s.call("get_agent_state", { agent_id: "one" })).value.execution.label).toBe("未知");
 });
 it("rejects empty, malformed and unsupported input without storage mutation", async () => {
  const s = setup();
  for (const args of [{ agent_id: "bad.id", name: "Bad" }, { agent_id: "one", name: " " }, { agent_id: "one", name: "First", token: "secret" }]) {
   const result = await s.call("create_agent", args); expect(result.body.result?.isError || result.body.error).toBeTruthy();
  }
  expect(s.data.size).toBe(0);
  await s.call("create_agent", { agent_id: "one", name: "First" });
  expect((await s.call("update_agent", { agent_id: "one", expected_revision: 1 })).body.result.isError).toBe(true);
  expect((await s.call("update_agent_status", { agent_id: "one", expected_revision: 1, heartbeat: false })).body.result.isError).toBe(true);
 });
 it("rejects server credential reflection before persisting any values", async () => {
  const s = setup(); const result = await s.call("create_agent", { agent_id: "one", name: token });
  expect(result.value.error).toBe("invalid_input"); expect(s.data.size).toBe(0);
 });
 it("enforces room capacity and compatible activity without partial mutation", async () => {
  const s = setup(); for (let i = 0; i < 4; i++) await s.call("create_agent", { agent_id: `a${i}`, name: `Agent ${i}` });
  expect((await s.call("create_agent", { agent_id: "overflow", name: "Overflow" })).value.error).toBe("room_full");
  const invalid = await s.call("update_agent_status", { agent_id: "a0", expected_revision: 1, activity: "working", room_id: "nest" }); expect(invalid.value.error).toBe("invalid_room");
  expect((await s.call("get_agent_state", { agent_id: "a0" })).value.agent.revision).toBe(1);
  await s.call("update_agent_status", { agent_id: "a0", expected_revision: 1, activity: "working" });
  expect((await s.call("create_agent", { agent_id: "overflow", name: "Overflow" })).body.result.isError).not.toBe(true);
  expect((await s.call("list_rooms", {})).value.rooms.find((r: any) => r.id === "nest").members).toHaveLength(4);
 });
 it("rejects contradictory offline and heartbeat reports without incrementing revision", async () => {
  const s = setup(); await s.call("create_agent", { agent_id: "one", name: "First" });
  for (const patch of [{ online: true }, { heartbeat: true }, { activity: "working", online: false, heartbeat: true }]) {
   expect((await s.call("update_agent_status", { agent_id: "one", expected_revision: 1, ...patch })).value.error).toBe("invalid_status");
  }
  expect((await s.call("get_agent_state", { agent_id: "one" })).value.agent.revision).toBe(1);
 });
 it("rejects duplicate tasks and invalid handoffs, preserving the previous state", async () => {
  const s = setup(); await s.call("create_agent", { agent_id: "one", name: "First" });
  const task = { id: "task", title: "Task", status: "queued" };
  expect((await s.call("update_agent_status", { agent_id: "one", expected_revision: 1, tasks: [task, task] })).value.error).toBe("invalid_snapshot");
  expect((await s.call("update_agent_status", { agent_id: "one", expected_revision: 1, tasks: [{ ...task, delegatedFrom: "missing" }] })).value.error).toBe("invalid_handoff");
  expect((await s.call("get_agent_state", { agent_id: "one" })).value.agent.tasks).toEqual([]);
 });
 it("reads explicitly reported handoffs and reports runtime limits truthfully", async () => {
  const s = setup(); await s.call("create_agent", { agent_id: "one", name: "First" });
  await s.call("update_agent_status", { agent_id: "one", expected_revision: 1, tasks: [{ id: "parent", title: "Parent", status: "completed" }, { id: "child", title: "Child", status: "queued", delegatedFrom: "parent" }] });
  expect((await s.call("get_task_handoff", { task_id: "child" })).value.hasHandoff).toBe(true);
  expect((await s.call("get_connection_info", {})).value).toMatchObject({ source: "managed", readOnly: false, stateAuthority: "client_reports", runtimeConnected: false });
 });
 it("does not refresh task-report time from profile changes or heartbeats, and marks old reports unknown", async () => {
  const s = setup(); await s.call("create_agent", { agent_id: "one", name: "First", activity: "working" });
  await s.call("update_agent_status", { agent_id: "one", expected_revision: 1, tasks: [{ id: "task", title: "Task", status: "running" }], tasks_complete: true });
  const stored = s.data.get("office") as any; stored.agents[0].tasksObservedAt = "2020-01-01T00:00:00.000Z"; s.data.set("office", stored);
  const heartbeat = await s.call("update_agent_status", { agent_id: "one", expected_revision: 2, heartbeat: true });
  expect(heartbeat.value.agent.tasksObservedAt).toBe("2020-01-01T00:00:00.000Z");
  const read = await s.call("get_agent_state", { agent_id: "one" });
  expect(read.value.agent.tasksFresh).toBe(false); expect(read.value.execution.label).toBe("未知"); expect(read.value.execution.running).toBe(1);
 });
 it("allows only one concurrent update at the same revision", async () => {
  const s = setup(); await s.call("create_agent", { agent_id: "one", name: "First" });
  const results = await Promise.all([s.call("update_agent", { agent_id: "one", expected_revision: 1, name: "A" }), s.call("update_agent", { agent_id: "one", expected_revision: 1, name: "B" })]);
  expect(results.filter(r => r.value.error === "revision_conflict")).toHaveLength(1);
  expect((await s.call("get_agent_state", { agent_id: "one" })).value.agent.revision).toBe(2);
 });
 it("uses the current token on every request instead of caching credentials", async () => {
  const s = setup();const rotated = "rotated-token-with-at-least-32-characters";
  expect((await s.rpc("tools/list", {}, token, { OFFICE_MCP_TOKEN: rotated })).status).toBe(401);
  expect((await s.rpc("tools/list", {}, rotated, { OFFICE_MCP_TOKEN: rotated })).body.result.tools).toHaveLength(9);
 });

 it("preserves the entire snapshot when durable persistence fails, and permits a later retry", async () => {
  const s = setup(); await s.call("create_agent", { agent_id: "one", name: "Original" });
  const before = structuredClone(s.data.get("office")); s.failNextWrite();
  const failed = await s.call("update_agent", { agent_id: "one", expected_revision: 1, name: "Lost update" });
  expect(failed.body.result.isError).toBe(true); expect(failed.value.error).toBe("storage_unavailable");
  expect(s.data.get("office")).toEqual(before);
  expect((await s.call("get_agent_state", { agent_id: "one" })).value.agent).toMatchObject({ name: "Original", revision: 1 });
  expect((await s.call("update_agent", { agent_id: "one", expected_revision: 1, name: "Retried" })).value.agent.revision).toBe(2);
 });

 it("keeps the company area separate from the personal area", async () => {
  const s = setup();
  const personal = await s.call("create_agent", { agent_id: "home-1", name: "Home" });
  expect(personal.value.agent).toMatchObject({ zone: "home", roomId: "nest" });
  const work = await s.call("create_agent", { agent_id: "work-1", name: "Work", zone_id: "office", activity: "working" });
  expect(work.value.agent).toMatchObject({ zone: "office", roomId: "office-desks" });
  for (let i = 0; i < 4; i++) await s.call("create_agent", { agent_id: `extra${i}`, name: `Extra ${i}` });
  expect((await s.call("create_agent", { agent_id: "overflow", name: "Overflow" })).value.error).toBe("room_full");
  expect((await s.call("create_agent", { agent_id: "work-2", name: "Work 2", zone_id: "office", activity: "working" })).body.result.isError).not.toBe(true);
  expect((await s.call("update_agent_status", { agent_id: "work-1", expected_revision: 1, zone_id: "home", room_id: "office-discussion" })).value.error).toBe("invalid_room");
  expect((await s.call("update_agent_status", { agent_id: "work-1", expected_revision: 1, zone_id: "home" })).value.agent).toMatchObject({ zone: "home", roomId: "desks" });
  const rooms = (await s.call("list_rooms", {})).value;
  expect(rooms.zones.map((z: any) => z.id)).toEqual(["home", "office"]);
  expect(rooms.rooms.find((r: any) => r.id === "office-desks").members.map((m: any) => m.id)).toEqual(["work-2"]);
  expect(rooms.rooms.find((r: any) => r.id === "desks").members.map((m: any) => m.id)).toEqual(["work-1"]);
 });

 it("links delegated children to their session and enforces the depth limit", async () => {
  const s = setup();
  await s.call("create_agent", { agent_id: "sess", name: "Session", zone_id: "office", activity: "working" });
  const child = await s.call("create_agent", { agent_id: "sub1", name: "Sub 1", parent_id: "sess", activity: "discussing" });
  expect(child.value.agent).toMatchObject({ parentId: "sess", depth: 1, zone: "office", roomId: "office-discussion" });
  await s.call("create_agent", { agent_id: "sub2", name: "Sub 2", parent_id: "sub1", activity: "discussing" });
  await s.call("create_agent", { agent_id: "sub3", name: "Sub 3", parent_id: "sub2", activity: "discussing" });
  expect((await s.call("create_agent", { agent_id: "sub4", name: "Sub 4", parent_id: "sub3", activity: "discussing" })).value.error).toBe("depth_limit");
  expect((await s.call("create_agent", { agent_id: "orphan", name: "Orphan", parent_id: "ghost" })).value.error).toBe("parent_not_found");
  const state = await s.call("get_office_state", {});
  expect(state.value.agents.map((a: any) => [a.id, a.depth])).toEqual([["sess", 0], ["sub1", 1], ["sub2", 2], ["sub3", 3]]);
  const discussion = (await s.call("list_rooms", {})).value.rooms.find((r: any) => r.id === "office-discussion");
  expect(discussion.members.map((m: any) => m.parentId)).toEqual(["sess", "sub1", "sub2"]);
 });

 it("soft-retires a session and the children it spawned, releasing their slots", async () => {
  const s = setup();
  await s.call("create_agent", { agent_id: "sess", name: "Session", zone_id: "office", activity: "meeting" });
  await s.call("create_agent", { agent_id: "sub1", name: "Sub 1", parent_id: "sess", activity: "discussing" });
  for (let i = 0; i < 7; i++) await s.call("create_agent", { agent_id: `m${i}`, name: `M${i}`, zone_id: "office", activity: "meeting" });
  expect((await s.call("create_agent", { agent_id: "m7", name: "M7", zone_id: "office", activity: "meeting" })).value.error).toBe("room_full");
  const retired = await s.call("retire_agent", { agent_id: "sess", expected_revision: 1, reason: "session disposed" });
  expect(retired.body.result.isError).not.toBe(true);
  const state = await s.call("get_office_state", {});
  expect(state.value.agents.some((a: any) => a.id === "sess" || a.id === "sub1")).toBe(false);
  expect(state.value.retiredCount).toBe(2);
  const kept = await s.call("get_office_state", { include_retired: true });
  expect(kept.value.agents.filter((a: any) => a.retiredAt).map((a: any) => a.id).sort()).toEqual(["sess", "sub1"]);
  expect(kept.value.agents.filter((a: any) => a.retiredAt).every((a: any) => a.activity === "offline" && a.online === false && a.retireReason === "session disposed")).toBe(true);
  expect((await s.call("get_agent_state", { agent_id: "sub1" })).value.agent.retiredAt).toBeTruthy();
  expect((await s.call("update_agent_status", { agent_id: "sess", expected_revision: 2, heartbeat: true })).value.error).toBe("agent_retired");
  expect((await s.call("create_agent", { agent_id: "m7", name: "M7", zone_id: "office", activity: "meeting" })).body.result.isError).not.toBe(true);
 });

 it("migrates a legacy snapshot that predates zones", async () => {
  const s = setup();
  const at = new Date().toISOString();
  s.data.set("office", { mode: "live", source: "managed", observedAt: at, events: [],
   rooms: [{ id: "nest", name: "充电窝", kind: "offline", topic: "", capacity: 4, x: 990, y: 385, w: 230, h: 290 }],
   agents: [{ id: "legacy", name: "Legacy", color: "#8daff4", activity: "offline", roomId: "nest", online: false, lastSeenAt: null, tasks: [], tasksComplete: false, revision: 1, updatedAt: at }] });
  const state = await s.call("get_office_state", {});
  expect(state.value.agents[0]).toMatchObject({ id: "legacy", zone: "home", roomId: "nest" });
  expect(state.value.rooms).toHaveLength(defaultRooms().length);
  expect(state.value.zones.map((z: any) => z.id)).toEqual(["home", "office"]);
  expect((s.data.get("office") as any).rooms.some((r: any) => r.zone === "office")).toBe(true);
 });

 it("honours the configured active-agent limit without blocking retirement", async () => {
  const s = setup({ OFFICE_MAX_AGENTS: "2" });
  await s.call("create_agent", { agent_id: "a1", name: "One", zone_id: "office", activity: "working" });
  await s.call("create_agent", { agent_id: "a2", name: "Two", zone_id: "office", activity: "working" });
  expect((await s.call("create_agent", { agent_id: "a3", name: "Three", zone_id: "office", activity: "working" })).value.error).toBe("agent_limit");
  await s.call("retire_agent", { agent_id: "a1", expected_revision: 1 });
  expect((await s.call("create_agent", { agent_id: "a3", name: "Three", zone_id: "office", activity: "working" })).body.result.isError).not.toBe(true);
 });

 it("drops the oldest retired records once the record budget is exceeded", async () => {
  const s = setup({ OFFICE_MAX_RECORDS: "2" });
  for (let i = 0; i < 3; i++) await s.call("create_agent", { agent_id: `r${i}`, name: `R${i}`, zone_id: "office", activity: "working" });
  for (let i = 0; i < 3; i++) await s.call("retire_agent", { agent_id: `r${i}`, expected_revision: 1 });
  const kept = await s.call("get_office_state", { include_retired: true });
  expect(kept.value.agents.map((a: any) => a.id)).toEqual(["r1", "r2"]);
 });

});
