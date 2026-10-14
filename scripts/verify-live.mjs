#!/usr/bin/env node
/**
 * 部署后自检：直接对线上 MCP 端点跑一遍新契约（区域 / 委托谱系 / 软退休）。
 *
 *   BIT_OFFICE_MCP_TOKEN=<token> node scripts/verify-live.mjs [url]
 *
 * 默认检查 https://agents.hekmon.com/mcp。脚本只使用带 `verify-` 前缀的临时记录，
 * 结束时把临时记录软退休（服务端没有删除工具，退休即释放工位与活跃配额）。
 * 退出码：全部通过 0，有失败 1。
 */
const url = process.argv[2] ?? process.env.BIT_OFFICE_MCP_URL ?? "https://agents.hekmon.com/mcp";
const token = process.env.BIT_OFFICE_MCP_TOKEN;
if (!token) {
 console.error("缺少 BIT_OFFICE_MCP_TOKEN 环境变量（管理令牌）。");
 process.exit(2);
}
const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` };
let sessionId;
let id = 0;
const parse = (text) => {
 const payload = text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find(line => line.startsWith("data:"))?.slice(5) : text;
 return JSON.parse(payload);
};
async function rpc(method, params) {
 const response = await fetch(url, { method: "POST", headers: { ...headers, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
  body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(20000) });
 sessionId ??= response.headers.get("mcp-session-id") ?? undefined;
 const body = parse(await response.text());
 if (body.error) throw new Error(`${method} → ${JSON.stringify(body.error)}`);
 return body.result;
}
async function call(name, args = {}) {
 const result = await rpc("tools/call", { name, arguments: args });
 const text = result.content?.[0]?.text ?? "{}";
 let value;
 try { value = JSON.parse(text); }
 // 旧版服务端对未知字段会回纯文本错误（部署尚未生效时就会走到这里）。
 catch { throw new Error(`${name} → 非 JSON 响应：${text.slice(0, 160)}`); }
 if (result.isError) throw new Error(`${name} → ${value.error ?? "isError"}`);
 return value;
}
const results = [];
function check(label, fn) { return (async () => { try { const detail = await fn(); results.push({ label, ok: true, detail }); } catch (error) { results.push({ label, ok: false, detail: error.message }); } })(); }
async function expect(condition, message) { if (!condition) throw new Error(message); }
const stamp = Date.now().toString(36).slice(-6);
const parent = `verify-parent-${stamp}`, child = `verify-child-${stamp}`;
const agent = (state, id) => state.agents.find(a => a.id === id);
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bit-office-verify", version: "1" } });
await fetch(url, { method: "POST", headers: { ...headers, ...(sessionId ? { "mcp-session-id": sessionId } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
const tools = (await rpc("tools/list", {})).tools.map(t => t.name);
await check("tools/list 暴露 9 个工具且包含 retire_agent", async () => {
 await expect(tools.length === 9, `工具数为 ${tools.length}：${tools.join(", ")}`);
 await expect(tools.includes("retire_agent"), "缺少 retire_agent");
 return tools.join(", ");
});
await check("get_office_state 返回区域，且房间带 zone", async () => {
 const state = await call("get_office_state", {});
 await expect(Array.isArray(state.zones) && state.zones.length >= 2, "响应没有 zones（部署可能还没生效）");
 await expect(state.rooms.every(r => typeof r.zone === "string"), "存在没有 zone 的房间");
 await expect(state.rooms.some(r => r.zone === "office") && state.rooms.some(r => r.zone === "home"), "区域房间集不完整");
 return `zones=${state.zones.map(z => z.id).join("/")}，rooms=${state.rooms.length}`;
});
await check("create_agent 支持 zone_id 与 parent_id（按 (zone,activity) 落位）", async () => {
 const parentAgent = await call("create_agent", { agent_id: parent, name: "部署自检 · 父会话", zone_id: "office", activity: "working" });
 await expect(parentAgent.agent.zone === "office", `父记录落在 ${parentAgent.agent.zone}`);
 await expect(parentAgent.agent.roomId === "office-desks", `父记录落在房间 ${parentAgent.agent.roomId}`);
 const childAgent = await call("create_agent", { agent_id: child, name: "部署自检 · 子 agent", parent_id: parent, activity: "discussing" });
 await expect(childAgent.agent.parentId === parent, "子记录没有 parentId");
 await expect(childAgent.agent.depth === 1, `子记录 depth=${childAgent.agent.depth}`);
 await expect(childAgent.agent.zone === "office" && childAgent.agent.roomId === "office-discussion", `子记录落在 ${childAgent.agent.zone}/${childAgent.agent.roomId}`);
 return `${parentAgent.agent.roomId} → ${childAgent.agent.roomId}（depth 1）`;
});
await check("update_agent_status 支持 zone_id（跨区拒绝）", async () => {
 const revision = (await call("get_agent_state", { agent_id: parent })).agent.revision;
 let rejected = "";
 try { await call("update_agent_status", { agent_id: parent, expected_revision: revision, zone_id: "home", room_id: "office-discussion" }); }
 catch (error) { rejected = error.message; }
 await expect(rejected.includes("invalid_room"), `跨区房间没有被拒绝：${rejected || "调用成功"}`);
 const moved = await call("update_agent_status", { agent_id: parent, expected_revision: revision, zone_id: "home" });
 await expect(moved.agent.zone === "home" && moved.agent.roomId === "desks", `区内改区失败：${moved.agent.zone}/${moved.agent.roomId}`);
 const back = await call("update_agent_status", { agent_id: parent, expected_revision: moved.agent.revision, zone_id: "office" });
 await expect(back.agent.roomId === "office-desks", `回到公司区失败：${back.agent.roomId}`);
 return "home/desks ↔ office/office-desks";
});
await check("retire_agent 软退休父记录并级联子记录", async () => {
 const revision = (await call("get_agent_state", { agent_id: parent })).agent.revision;
 await call("retire_agent", { agent_id: parent, expected_revision: revision, reason: "部署自检收尾" });
 const visible = await call("get_office_state", {});
 await expect(!agent(visible, parent) && !agent(visible, child), "退休记录仍在默认视图里");
 await expect(visible.retiredCount >= 2, `retiredCount=${visible.retiredCount}`);
 const all = await call("get_office_state", { include_retired: true });
 const retiredParent = agent(all, parent), retiredChild = agent(all, child);
 await expect(retiredParent?.retiredAt && retiredChild?.retiredAt, "include_retired 看不到退休记录");
 await expect(retiredParent.retireReason === "部署自检收尾", `退休原因丢失：${retiredParent.retireReason}`);
 await expect(retiredChild.activity === "offline" && retiredChild.online === false, "退休记录没有下线");
 let blocked = "";
 try { await call("update_agent_status", { agent_id: parent, expected_revision: retiredParent.revision, heartbeat: true }); }
 catch (error) { blocked = error.message; }
 await expect(blocked.includes("agent_retired"), `退休记录仍可写：${blocked || "调用成功"}`);
 return `retiredCount=${visible.retiredCount}，级联子记录已下线`;
});
await check("MCP instructions 带接入约定", async () => {
 const info = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bit-office-verify", version: "1" } });
 const text = info.instructions ?? "";
 await expect(text.includes("zone_id"), "instructions 未提到 zone_id");
 await expect(text.includes("parent_id"), "instructions 未提到 parent_id");
 await expect(text.includes("retire"), "instructions 未提到 retire");
 return text.slice(0, 120) + "…";
});
for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.label}\n      ${result.detail}`);
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过${failed ? "（部署可能还没生效）" : ""}`);
process.exit(failed ? 1 : 0);
