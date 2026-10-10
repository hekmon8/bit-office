import { describe, it, expect } from "vitest";
import type { DurableObjectState } from "@cloudflare/workers-types";
import worker, { OfficeStore, type Env } from "../src/worker";
const token = "managed-test-token-with-at-least-32-characters";
function setup() {
 const data = new Map<string, unknown>();
 let failWrite = false;
 const storage = {
  kv: { get: (key: string) => structuredClone(data.get(key)), put: (key: string, value: unknown) => { if (failWrite) { failWrite = false; throw new Error("Injected storage failure"); } data.set(key, structuredClone(value)); } },
  transactionSync: <T>(fn: () => T): T => {
   const previous = structuredClone(data);
   try { return fn(); } catch (error) { data.clear(); for (const [k, v] of previous) data.set(k, v); throw error; }
  }
 };
 const makeStore = () => new OfficeStore({ storage } as unknown as DurableObjectState);
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
 it("exposes 8 tools only to authenticated clients, with accurate write annotations", async () => {
  const s = setup();const managed = await s.rpc("tools/list");
  expect(managed.body.result.tools).toHaveLength(8);
  expect(managed.body.result.tools.filter((t: any) => !t.annotations.readOnlyHint).map((t: any) => t.name)).toEqual(["create_agent", "update_agent", "update_agent_status"]);
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
  expect((await s.rpc("tools/list", {}, rotated, { OFFICE_MCP_TOKEN: rotated })).body.result.tools).toHaveLength(8);
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

});
