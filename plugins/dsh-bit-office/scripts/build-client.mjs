#!/usr/bin/env node
/**
 * dsh-bit-office — client bundle 构建器
 *
 * 把 src/floorplan.mjs（无依赖纯函数渲染器）内联进 src/client.template.js，
 * 产出 **入库的构建产物** lib/client.js。这样：
 *   - git 源安装（不跑构建）直接可用（真一行安装）；
 *   - Node 单测 import src/floorplan.mjs，浏览器用内联的同一份代码——语义一致。
 *
 * 用法：
 *   node scripts/build-client.mjs           # 写出 lib/client.js
 *   node scripts/build-client.mjs --check    # 只校验新鲜度（CI/门禁用），不一致退出 1
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const templatePath = path.join(root, 'src', 'client.template.js')
const floorplanPath = path.join(root, 'src', 'floorplan.mjs')
const outPath = path.join(root, 'lib', 'client.js')
const PLACEHOLDER = '/* __FLOORPLAN_INLINE__ */'

/** 把 ESM 源码变成可内联的普通脚本：去掉 `export ` 前缀（`export default` 不支持）。 */
export function inlineSource(source) {
  if (/^\s*export\s+default/m.test(source)) {
    throw new Error('floorplan.mjs 不能使用 export default（内联只支持具名导出）')
  }
  return source
    .split('\n')
    .map((line) => line.replace(/^(\s*)export\s+/, '$1'))
    .join('\n')
    .replace(/\s+$/, '')
}

export function buildClient({ template, floorplan, indent = '    ' }) {
  if (!template.includes(PLACEHOLDER)) {
    throw new Error(`client.template.js 缺少占位符 ${PLACEHOLDER}`)
  }
  const inlined = inlineSource(floorplan)
    .split('\n')
    .map((line) => (line ? indent + line : line))
    .join('\n')
  return `${template.replace(PLACEHOLDER, inlined.trimStart())}\n`
}

function main() {
  const checkOnly = process.argv.includes('--check')
  const template = fs.readFileSync(templatePath, 'utf8')
  const floorplan = fs.readFileSync(floorplanPath, 'utf8')
  const next = buildClient({ template, floorplan })

  // 结构门禁：产物必须仍是合法的 __ModuleLoader__ bundle
  if (!next.includes('window.__ModuleLoader__.load(')) throw new Error('产物缺少 __ModuleLoader__.load 包装')
  if (!next.includes("exports.name = 'dsh-bit-office'")) throw new Error('产物缺少插件 name')
  if (next.includes('export ')) throw new Error('产物里仍有未处理的 `export ` 关键字')
  if (!next.includes('function renderFloorplan')) throw new Error('产物里没有内联进 renderFloorplan')
  if (!next.includes('conversation.view')) throw new Error('产物里没有注册 conversation.view 槽')

  if (checkOnly) {
    const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : ''
    if (current !== next) {
      console.error('lib/client.js 与源码不一致 → 运行 `node scripts/build-client.mjs` 重新生成')
      process.exit(1)
    }
    console.log('lib/client.js 是最新的')
    return
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, next, 'utf8')
  console.log(`wrote ${path.relative(root, outPath)} (${next.length} bytes)`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main()
}
