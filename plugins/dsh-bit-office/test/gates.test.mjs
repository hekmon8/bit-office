/**
 * 门禁自证：每条门禁都要用**非法样例**证明它真的会拒绝
 * （只跑「全绿」的门禁等于没门禁）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SEED_MODULES,
  violationsForClientBundle,
  violationsForDocLinks,
  violationsForImports,
  violationsForInject,
  violationsForPackage,
  violationsForPatch,
  violationsForSecrets,
} from '../scripts/gates.mjs'

const VALID_PKG = {
  name: 'dsh-bit-office',
  main: './lib/index.mjs',
  exports: { './client': './lib/client.js' },
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
  dependencies: {},
  peerDependencies: {},
}
const VALID_PATCH = "- insert:\n    - id: dsh-bit-office\n      name: 'dsh-bit-office'\n"
const VALID_ENTRY = "export const name = 'dsh-bit-office'\nexport const inject = ['webServer', 'tools']\n"

describe('门禁自证', () => {
  it('包契约：真实包通过，改坏任一项都会被拒', () => {
    assert.deepEqual(violationsForPackage(VALID_PKG), [])
    assert.ok(violationsForPackage({ ...VALID_PKG, name: 'x' }).length)
    assert.ok(violationsForPackage({ ...VALID_PKG, main: './index.js' }).length)
    assert.ok(violationsForPackage({ ...VALID_PKG, dsh: { client: { platform: 'web' } } }).length)
    assert.ok(violationsForPackage({ ...VALID_PKG, dsh: { bundle: { patch: './x.yml' }, client: { platform: 'web' } } }).length)
    assert.ok(violationsForPackage({ ...VALID_PKG, dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'tui' } } }).length)
    assert.ok(violationsForPackage({ ...VALID_PKG, exports: {} }).length)
    // 宿主包依赖必须被拒（link: 安装下解析不到）
    const withDep = violationsForPackage({ ...VALID_PKG, dependencies: { '@deepseek-ai/dsh-tools': '0.0.1-rc.1' } })
    assert.equal(withDep.length, 1)
    assert.match(withDep[0], /profile 闭包注入/)
    assert.ok(violationsForPackage({ ...VALID_PKG, dependencies: { cordis: '^4' } }).length)
  })

  it('patch 层：缺 insert / id / name 都会被拒', () => {
    assert.deepEqual(violationsForPatch(VALID_PATCH), [])
    assert.ok(violationsForPatch('# 只有注释').length)
    assert.ok(violationsForPatch("- insert:\n    - id: other\n      name: 'other'\n").length)
    assert.ok(violationsForPatch("- insert:\n    - id: dsh-bit-office\n").length)
  })

  it('client bundle：新鲜度、包装、槽注册、种子模块四条都会拒绝', () => {
    const good = 'window.__ModuleLoader__.load({ id: \'dsh-bit-office\', factory: () => {} });\n// name: \'conversation.view\''
    assert.deepEqual(violationsForClientBundle(good, good), [])
    assert.ok(violationsForClientBundle(`${good} `, good).length, '新鲜度不一致应被拒')
    assert.ok(violationsForClientBundle("// name: 'conversation.view'", "// name: 'conversation.view'").length, '缺 __ModuleLoader__ 包装应被拒')
    assert.ok(violationsForClientBundle('window.__ModuleLoader__.load({});', 'window.__ModuleLoader__.load({});').length, '缺 conversation.view 应被拒')
    const badImport = "import react from 'react'\nwindow.__ModuleLoader__.load({});\n// name: 'conversation.view'"
    assert.ok(violationsForClientBundle(badImport, badImport).some((p) => p.includes('import')), '产物里有 import 应被拒')
    const badExport = 'export const x = 1\nwindow.__ModuleLoader__.load({});\n// name: \'conversation.view\''
    assert.ok(violationsForClientBundle(badExport, badExport).some((p) => p.includes('export')), '产物里有 export 应被拒')
    const badRequire = "window.__ModuleLoader__.load({});\nrequire('left-pad')\n// name: 'conversation.view'"
    assert.ok(violationsForClientBundle(badRequire, badRequire).some((p) => p.includes('非种子模块')), '非种子模块 require 应被拒')
    assert.ok(SEED_MODULES.has('react'))
  })

  it('inject 覆盖：漏声明 / 多声明都被拒', () => {
    assert.deepEqual(violationsForInject([{ file: 'lib/index.mjs', text: "ctx.get('webServer')\nctx.get('tools')" }], VALID_ENTRY), [])
    const missing = violationsForInject([{ file: 'lib/index.mjs', text: "ctx.get('webServer')\nctx.get('sessions')" }], VALID_ENTRY)
    assert.ok(missing.some((p) => p.includes("ctx.get('sessions')")))
    const extra = violationsForInject([{ file: 'lib/index.mjs', text: "ctx.get('webServer')" }], VALID_ENTRY)
    assert.ok(extra.some((p) => p.includes('未使用')))
    assert.ok(violationsForInject([], "export const name = 'x'").length, '找不到 inject 声明应被拒')
  })

  it('禁止依赖：MCP SDK / 跨仓 / 宿主包都会被拒', () => {
    assert.deepEqual(violationsForImports([{ file: 'lib/index.mjs', text: "import fs from 'node:fs'\nimport { x } from './mcp.mjs'" }]), [])
    assert.ok(violationsForImports([{ file: 'lib/a.mjs', text: "import { Client } from '@modelcontextprotocol/sdk/client/index.js'" }]).length)
    assert.ok(violationsForImports([{ file: 'lib/a.mjs', text: "import { model } from '../bit-office/src/model'" }]).length)
    assert.ok(violationsForImports([{ file: 'lib/a.mjs', text: "import { defineTool } from '@deepseek-ai/dsh-tools'" }]).length)
    // src/ 下的纯函数模块不受宿主包限制影响（但仍受前两条约束）
    assert.deepEqual(violationsForImports([{ file: 'src/floorplan.mjs', text: "const x = 1" }]), [])
  })

  it('密钥门禁：64 位十六进制串会被拒，短串与占位不会', () => {
    assert.deepEqual(violationsForSecrets([{ file: 'README.md', text: 'token=<your-token-here>' }]), [])
    assert.deepEqual(violationsForSecrets([{ file: 'README.md', text: 'sha 0123456789abcdef (16位)' }]), [])
    const leak = violationsForSecrets([{ file: 'lib/a.mjs', text: `const t = '${'a'.repeat(64)}'` }])
    assert.equal(leak.length, 1)
  })
})

describe('门禁自证 —— 文档链接', () => {
  it('本地存在的路径通过，不存在的相对链接/图片被拒；外链与锚点跳过', () => {
    const exists = (rel) => rel === 'docs/preview/floorplan.png' || rel === 'LICENSE'
    const ok = '![图](docs/preview/floorplan.png)\n[许可](LICENSE)\n[外链](https://example.com/a.png)\n[锚点](#section)\n[绝对](/api/x)'
    assert.deepEqual(violationsForDocLinks(ok, exists), [])
    const bad = violationsForDocLinks('![缺失](docs/nope.png)\n[也没](src/gone.mjs)', exists)
    assert.equal(bad.length, 2)
    assert.match(bad[0], /docs\/nope\.png/)
  })

  it('带 anchor/query 的链接只看路径部分', () => {
    const exists = (rel) => rel === 'README.md'
    assert.deepEqual(violationsForDocLinks('[a](README.md#install)', exists), [])
    assert.equal(violationsForDocLinks('[a](README.md?x=1)', exists).length, 0)
    assert.equal(violationsForDocLinks('[a](other.md#x)', exists).length, 1)
  })
})
