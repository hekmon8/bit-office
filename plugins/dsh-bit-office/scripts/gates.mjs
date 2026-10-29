#!/usr/bin/env node
/**
 * dsh-bit-office — 门禁（机械检查 + 结构不变量）
 *
 * 设计：**判定逻辑是纯函数**（`violationsFor*`，输入是文本/对象），
 * 收集输入的部分（读盘）单独放在 runGates 里。这样每条门禁都能被
 * test/gates.test.mjs 用**非法样例**证明「真的会拒绝」。
 *
 * 用法：node scripts/gates.mjs
 *
 * 检查项：
 *   1. 包契约：dsh.bundle.patch / dsh.client / main / exports 齐全，
 *      且 dependencies 里**没有** @deepseek-ai/* 或 cordis（profile 闭包注入）。
 *   2. cordis.patch.yml 含 insert 行，id/name 与包名一致。
 *   3. client bundle：与源码一致（构建新鲜度）、用 __ModuleLoader__.load 包装、
 *      注册 conversation.view、只 require 种子模块、无 import/export 残留。
 *   4. Node half：inject 覆盖 lib/ 里所有 ctx.get('x') 用到的服务名（严格注入）。
 *   5. 不引入被禁依赖：@modelcontextprotocol/*、bit-office 仓库代码、宿主包。
 *   6. 无密钥入库：64 位十六进制 token 形状不出现在被提交文件里。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildClient } from './build-client.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/** 种子模块（client bundle 的 factory 只能 require 这些）。 */
export const SEED_MODULES = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/** token 形状：64 位十六进制。 */
export const TOKEN_SHAPE = /\b[0-9a-f]{64}\b/

/** 被提交文件里允许出现 `ctx.get` 的目录（Node half）。 */
const NODE_FILES = (files) => files.filter((f) => f.endsWith('.mjs'))

/* --------------------------------------------------------- 纯判定函数 */

export function violationsForPackage(pkg) {
  const problems = []
  if (!pkg || typeof pkg !== 'object') return ['package.json 无法解析']
  if (pkg.name !== 'dsh-bit-office') problems.push('package.json name 必须是 dsh-bit-office')
  if (pkg.main !== './lib/index.mjs') problems.push('main 必须指向 ./lib/index.mjs')
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') problems.push('dsh.bundle.patch 必须指向 ./cordis.patch.yml')
  if (pkg.dsh?.client?.platform !== 'web') problems.push('dsh.client.platform 必须是 web')
  if (pkg.exports?.['./client'] !== './lib/client.js') problems.push('exports["./client"] 必须指向 ./lib/client.js')
  for (const dep of Object.keys({ ...(pkg.dependencies || {}), ...(pkg.peerDependencies || {}) })) {
    if (dep.startsWith('@deepseek-ai/') || dep === 'cordis') {
      problems.push(`不能声明宿主包依赖（profile 闭包注入）: ${dep}`)
    }
  }
  return problems
}

export function violationsForPatch(text) {
  const problems = []
  const src = String(text || '')
  if (!/^- insert:/m.test(src)) problems.push('cordis.patch.yml 缺少 `- insert:` 行')
  if (!/id: dsh-bit-office/.test(src)) problems.push('cordis.patch.yml 缺少 id: dsh-bit-office')
  if (!/name: '?dsh-bit-office'?/.test(src)) problems.push('cordis.patch.yml 缺少 name: dsh-bit-office')
  return problems
}

export function violationsForClientBundle(current, regenerated) {
  const problems = []
  const text = String(current || '')
  if (text !== regenerated) problems.push('lib/client.js 与源码不一致（跑 node scripts/build-client.mjs）')
  if (!text.includes('window.__ModuleLoader__.load(')) problems.push('client bundle 必须用 __ModuleLoader__.load 包装')
  if (!text.includes("name: 'conversation.view'")) problems.push('client bundle 必须注册 conversation.view 槽')
  if (/^\s*import\s/m.test(text)) problems.push('client bundle 产物里不能有 import 语句')
  if (/\bexport\s/.test(text)) problems.push('client bundle 产物里不能有 export 语句')
  for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!SEED_MODULES.has(m[1])) problems.push(`client bundle require 了非种子模块: ${m[1]}`)
  }
  return problems
}

/** @param {{file: string, text: string}[]} filesNodeHalf */
export function violationsForInject(filesNodeHalf, entryText) {
  const problems = []
  const used = new Set()
  for (const { text } of filesNodeHalf) {
    for (const m of String(text).matchAll(/ctx\.get\(\s*['"]([^'"]+)['"]\s*\)/g)) used.add(m[1])
  }
  const match = String(entryText || '').match(/export const inject = \[([^\]]*)\]/)
  if (!match) return ['lib/index.mjs 里找不到 export const inject']
  const declared = new Set([...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]))
  for (const name of used) if (!declared.has(name)) problems.push(`ctx.get('${name}') 未在 inject 声明（严格注入会抛错）`)
  for (const name of declared) if (!used.has(name)) problems.push(`inject 声明了未使用的服务: ${name}（可删）`)
  return problems
}

/** @param {{file: string, text: string}[]} files */
export function violationsForImports(files) {
  const problems = []
  for (const { file, text } of files) {
    const src = String(text)
    if (/from\s+['"]@modelcontextprotocol\//.test(src)) problems.push(`${file} 引入了 @modelcontextprotocol/*（禁止）`)
    if (/from\s+['"][^'"]*bit-office\/src/.test(src)) problems.push(`${file} 引用了 bit-office 仓库代码（跨仓耦合，禁止）`)
    if (file.startsWith('lib/') && /(^|\n)\s*import[^\n]*from\s+['"]@deepseek-ai\//.test(src)) {
      problems.push(`${file} import 了 @deepseek-ai/*（link: 安装下解析不到，禁止）`)
    }
  }
  return problems
}

/**
 * README/文档里的相对链接与图片必须能在仓库里解析（md-links 门禁）。
 * @param {string} text 文档正文
 * @param {(rel: string) => boolean} exists 相对仓库根的路径是否存在
 * @returns {string[]} 问题列表
 */
export function violationsForDocLinks(text, exists) {
  const problems = []
  const src = String(text || '')
  for (const m of src.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1]
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/')) continue
    const clean = target.split('#')[0].split('?')[0]
    if (!clean) continue
    if (!exists(clean)) problems.push(`文档链接指向不存在的文件: ${target}`)
  }
  return problems
}

/** @param {{file: string, text: string}[]} files */
export function violationsForSecrets(files) {
  const problems = []
  for (const { file, text } of files) {
    if (TOKEN_SHAPE.test(String(text))) problems.push(`${file} 里出现 64 位十六进制串（疑似 token，禁止入库）`)
  }
  return problems
}

/* ------------------------------------------------------------- 读盘 */

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      walk(rel, out)
    } else out.push(rel)
  }
  return out
}

function collect() {
  const srcFiles = [...walk('lib'), ...walk('src'), ...walk('scripts')]
  return {
    pkg: read('package.json'),
    patch: read('cordis.patch.yml'),
    client: read('lib/client.js'),
    regenerated: buildClient({ template: read('src/client.template.js'), floorplan: read('src/floorplan.mjs') }),
    nodeFiles: NODE_FILES(walk('lib')).map((f) => ({ file: f, text: read(f) })),
    entry: read('lib/index.mjs'),
    allSources: srcFiles.map((f) => ({ file: f, text: read(f) })),
    secrets: ['package.json', 'cordis.patch.yml', 'README.md', 'lib/index.mjs', 'lib/config.mjs']
      .filter((f) => fs.existsSync(path.join(root, f)))
      .map((f) => ({ file: f, text: read(f) })),
    docs: [{ file: 'README.md', text: read('README.md') }],
    exists: (rel) => fs.existsSync(path.join(root, rel)),
  }
}

export function runGates(ctx = collect()) {
  const gates = [
    ['包契约（dsh.bundle / dsh.client / 无宿主依赖）', () => violationsForPackage(JSON.parse(ctx.pkg))],
    ['cordis.patch.yml insert 行', () => violationsForPatch(ctx.patch)],
    ['client bundle 新鲜度与 require 面', () => violationsForClientBundle(ctx.client, ctx.regenerated)],
    ['inject 覆盖所有 ctx.get 服务名', () => violationsForInject(ctx.nodeFiles, ctx.entry)],
    ['无禁止依赖（MCP SDK / 跨仓 / 宿主包）', () => violationsForImports(ctx.allSources)],
    ['无密钥入库', () => violationsForSecrets(ctx.secrets)],
    ['文档链接可解析（md-links）', () => ctx.docs.flatMap((d) => violationsForDocLinks(d.text, ctx.exists))],
  ]
  const failed = []
  for (const [label, fn] of gates) {
    const problems = fn()
    if (problems.length) {
      failed.push({ label, problems })
      console.error(`✖ ${label}`)
      for (const p of problems) console.error(`    - ${p}`)
    } else {
      console.log(`✔ ${label}`)
    }
  }
  return failed
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const failed = runGates()
  if (failed.length) {
    console.error(`\n门禁失败：${failed.length} 项`)
    process.exit(1)
  }
  console.log('\n全部门禁通过')
}
