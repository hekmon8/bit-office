# 002 · 会话/子 agent 影子记录靠事件自动同步，不靠模型调工具

- 分类：architecture
- 状态：implemented

## Problem

「每个 DSH 会话/子 agent 在办公室里都有一条实时记录」这件事，如果挂在模型调用工具上，
就永远不可靠：模型可能忘了调、可能被截断、子 agent 更是根本不知道有这个工具。
需求要求**不依赖模型调用工具**也能自动同步。

## Decision

Node half 监听宿主生命周期事件，做**单向、只增不减的镜像**：

- `session/created` → `create_agent`（`agent_id = session id`，`zone_id = office`，名字取 `sessionTitle`，
  取不到时回退「工作区目录名 · 会话 id 后 6 位」），随即 `update_agent_status{activity:'working',online:true,heartbeat:true}`。
- `session/disposed` → `retire_agent{cascade:true}`（新契约未部署时降级为 `offline + tasks_complete`）。
- `subagent/start` → 子记录 `parent_id = 父会话 agent_id`（父会话 id 从子会话 `header.parentSession` 反查），`activity='discussing'`。
- `subagent/end` → `offline` + 一条终态 task（标题含 provider/stopReason），延迟 `retentionMs`（默认 15 min）后 `retire_agent`。

写入侧三条硬纪律：

1. **fire-and-forget**：所有网络/协议失败只 `log()`，绝不 `throw` 回事件回调（session 不能因为办公室挂了而受影响）。
2. **per-agent 串行队列**：同一 agent 的写操作排队，配合乐观锁（读 revision → 写 → `revision_conflict` 就重读重试，最多 2 次）。
3. **节流**：同一 agent 状态上报最多 60s 一次；`bit_office_report`（模型显式上报）用 `force` 绕过。

## Alternatives considered

1. 只提供工具、靠 systemPrompt 叮嘱模型上报：不可靠（这就是被否掉的原始方案），且覆盖不到子 agent。
2. 定时轮询 `sessions.list()` 全量对账：延迟高、要一直跑；改为「事件驱动为主 + 只在 `ctx.get('sessionTitle')`
   拿不到标题时按 60s 间隔补一次 `reconcileNames()` 校正名字」。
3. 每个写操作开一个独立定时器重试：会在远端故障时堆积；改为失败只记日志、下一次事件自然重试。

## Consequences

- 记录里可能有「会话已经结束但保留期没到」的 agent，这是**有意为之**（`retiredCount` 可见），
  便于看到刚结束的子 agent 与其终态任务；`retentionMs` 可配。
- 事件回调必须容错：`test/entry.test.mjs` 用 `null`/`{}`/`undefined` 事件负载断言不抛；
  `test/sync.test.mjs` 用「远端不可达」「api 同步抛异常」两种注入证明只记日志。
