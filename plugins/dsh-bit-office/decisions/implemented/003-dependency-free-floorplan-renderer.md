# 003 · 平面图渲染器是零依赖纯函数，构建期内联进 client bundle

- 分类：architecture
- 状态：implemented

## Problem

「办公室」标签页要把办公室状态画成平面图（分区 + 房间 + 每 agent 一个像素宠物 + 父子连线 + 当前会话高亮）。
这份绘图逻辑同时被三方需要：① 浏览器标签页；② Node 单元测试；③ README 预览图。
如果把绘图写在进行时组件里，就只能靠浏览器验证（慢、难断言）；如果依赖 bit-office 仓库的渲染代码，
就产生跨仓耦合（那个仓库是别的 agent 的工作区，不可改、也不该依赖）。

## Decision

`src/floorplan.mjs` 是**零依赖、无 DOM、浏览器安全**的纯函数模块：

- `normalizeState(input)` → 容忍 `{office|state|data|result|snapshot}` 各种包法；
- `layoutFloorplan(state, {highlightId})` → `{width, height, zones, rooms, pets, links, stats}`（几何计算）；
- `renderFloorplan(state, {highlightId, showLinks, idPrefix})` → SVG 字符串。

client half（`src/client.template.js`）不写绘图逻辑，只用占位注释 `/* __FLOORPLAN_INLINE__ */`；
构建脚本 `scripts/build-client.mjs` 把 `floorplan.mjs` 去掉 `export` 后**内联**进 bundle
（client bundle 是 `new Function` 求值的，不能有 import/export）。
于是：同一份代码既是 Node 可测的纯函数、又是浏览器里的渲染器、又是 README 预览图的绘制者。

视觉对齐 bit-office 的既有配色（地板 `#252a2f`、房间描边 `#65676b`、宠物 = 方块 + 眼睛），
但**不引用其代码**。`idPrefix` 参数用于同页多张图时隔离 `<pattern>` 等 SVG 内部 id。

## Alternatives considered

1. 在组件里画、靠浏览器截图验证：断言成本高，回归靠肉眼。
2. `import` bit-office 仓库的渲染代码：跨仓耦合 + 改不了别人的仓库 + 运行时拿不到那个包。
3. 让浏览器端 `fetch('/src/floorplan.mjs')` 动态 import：client bundle 不允许（非种子模块），且多一次请求。
4. 手写两份（一份 Node、一份浏览器）：必然漂移，门禁只能靠人盯。

## Consequences

- 绘图有 16 条纯函数测试（`test/floorplan.test.mjs`），覆盖分区/占用归集/兜底房间/退休可见/XML 转义/纯函数幂等。
- `lib/client.js` 是**生成物**：门禁 `scripts/gates.mjs` 的「client bundle 新鲜度」会在源码改了没重建时拒绝，
  `--check` 模式供 CI 用；产物不允许出现 `import`/`export`，`require` 只允许种子模块白名单。
- README 的预览图由 `node scripts/make-preview.mjs` 生成（`docs/preview/floorplan.svg` + `.png`），
  预览数据形状与真实 `get_office_state` 响应一致，所以预览图同时是「形状契约」的可视化。
