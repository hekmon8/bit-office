# 001 · bundle 插件不能 import 宿主包，工具定义本地实现

- 分类：architecture
- 状态：implemented
- 环境事实：是（DSH 0811 插件装载机制）

## Problem

按官方文档，Node half 的工具应当 `import { defineTool } from '@deepseek-ai/dsh-tools'`。
但 `dsh plugin --profile web add <本地路径>` 装的是 `link:`，插件真实路径在 profile 之外；
Node 的 ESM 解析从**插件文件所在目录**往上找 `node_modules`，永远不会走到 profile 的闭包目录，
于是运行期直接 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'`。
`@deepseek-ai/*` 与 `cordis` 都不能出现在 `dependencies` 里（由 profile 闭包注入），
所以「加依赖」也不是出路。

## Decision

`lib/tools.mjs` 里实现一个**本地 `defineTool` 等价物**：接收 `{name, description, parameters(JSON-Schema), output, execute}`，
返回 `ctx.tools.register()` 能接受的对象。`parameters` 用纯 JSON Schema 声明（与 defineTool 同构），
`output.render` 直接返回 `[{type:'text', text}]`（不是 `{content:[…]}`，外层会再包一层）。

同一原因，`lib/` 下所有模块**只用 Node 标准库**；MCP 协议自带 `lib/mcp.mjs`（fetch + SSE 解析），
不引 `@modelcontextprotocol/sdk`。

## Alternatives considered

1. `import { defineTool } from '@deepseek-ai/dsh-tools'` + 把包加进 `dependencies`：
   安装后仍然解析不到（不在插件目录下），且违反「宿主包不进 dependencies」的约束。
2. 让宿主把 `@deepseek-ai/*` 暴露到 `NODE_PATH` / import map：要改 profile 或 DSH 本体，超出插件边界。
3. 复制 dsh-tools 的实现：只能复制**形状**（JSON Schema + render），复制不了内部依赖（它自己 import 别的宿主包）。

## Consequences

- 工具定义形状与官方一致（name/description/parameters/output/execute），切换回官方 `defineTool` 只需改一行 import。
- 需要自己保证 `parameters` 合法：门禁 `scripts/gates.mjs` 禁止 `lib/` 出现 `@deepseek-ai/*` import；
  `test/entry.test.mjs` 断言两个工具的参数 schema 形状（enum/additionalProperties/required）。
- 教训已回灌到 skill：`references/gotchas.md` 的 gotcha 1e。
