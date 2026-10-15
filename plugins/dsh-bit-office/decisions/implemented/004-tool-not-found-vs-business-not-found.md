# 004 · 业务错误 `agent_not_found` 曾被误判成「工具不存在」

- 分类：bug-fix
- 状态：implemented
- 发现方式：自证测试（不是线上）

## Problem

`McpClient.callTool` 用一个「工具不存在」线索表判断某个工具是否未部署，线索里包含了裸字符串 `not_found`：

```js
const NOT_FOUND_HINTS = ['not found', 'not_found', 'unknown tool', …]
```

而 bit-office 读单个 agent 时，记录不存在返回的是**业务错误** `{"error":"agent_not_found","message":"no agent session-a"}`。
它的文本里带了 `not_found` → 被当成「`get_agent_state` 这个工具不存在」→ 工具名被永久加进 `missingTools`，
之后**所有**读操作都直接抛 `ToolUnavailableError`，乐观锁整条链路（读 revision → 写 → 冲突重读）全部失效。
表现就是 `test/office.test.mjs` 里 6 条用例同时红，且错误信息指向工具缺失，与真实原因完全无关。

## Decision

把判断收紧成**只认「工具本身不存在」的措辞**，并导出为可测的纯函数：

```js
const UNKNOWN_TOOL_HINTS = ['unknown tool', 'no such tool', 'tool not found', 'tool_not_found',
  'method not found', 'unsupported tool', 'not implemented']
export function looksLikeUnknownTool(detail, toolName) { … 还接受「错误文本里出现本次调用的工具名 + not found/unknown」… }
```

同时把 `agent_not_found` 加进业务错误码识别表，让它走 `McpError{kind:'business', code:'agent_not_found'}`，
由 `OfficeApi.readAgent` 捕获后返回 `null`（而不是抛给会话）。

## Alternatives considered

1. 只看 JSON-RPC 错误码 `-32601`：真实的工具缺失也可能以 `isError:true` 的业务结果形式返回（mock 与真实网关都这么干），会漏判。
2. 保留 `not_found` 但排除 `agent_not_found`：打补丁式，下一个业务码（`parent_not_found`、`room_not_found`）又会踩同一个坑。

## Consequences

- 规则变成「必须带上 tool/unknown/method 语义，或文本里出现本次调用的工具名」，业务错误不再污染工具可用性判断。
- 回归护栏：`test/office.test.mjs` 的「`get_agent_state` 读不到记录 → `readAgent` 返回 null（不抛）」与
  冲突重试用例共同锁死该行为；`test/gates.test.mjs` 之外的 mock 也覆盖 `agent_not_found → isError` 形状。
- 教训（一般化）：**「不存在」这三个字在工具协议层与业务层含义完全不同**，用字符串线索做能力探测时，
  必须把线索限制在协议层措辞上。
