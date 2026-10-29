/**
 * 自证测试：client bundle（会话标题栏「办公室」标签页）
 *
 * 用**最小 React 运行时 + 假 DOM**直接跑入库产物 lib/client.js——
 * 不开浏览器也能断言：槽注册形状（name/id/order/label）、请求 URL、轮询间隔、
 * 页面不可见时暂停、渲染出的 SVG、错误态、卸载清理。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'lib', 'client.js')

/* --------------------------------------------------------- 最小 React 运行时 */

function sameDeps(a, b) {
  if (!a || !b || a.length !== b.length) return false
  return a.every((v, i) => Object.is(v, b[i]))
}

function createMiniReact() {
  let slots = []
  let cursor = 0
  let pending = []
  let dirty = false
  const cleanups = []

  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props || {}), children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) },
  })
  const useState = (init) => {
    const i = cursor
    cursor += 1
    if (!(i in slots)) slots[i] = { value: typeof init === 'function' ? init() : init }
    const slot = slots[i]
    return [slot.value, (v) => {
      const next = typeof v === 'function' ? v(slot.value) : v
      if (!Object.is(next, slot.value)) {
        slot.value = next
        dirty = true // 与 React 一致：状态变化触发重渲染
      }
    }]
  }
  const useRef = (init) => {
    const i = cursor
    cursor += 1
    if (!(i in slots)) slots[i] = { current: init }
    return slots[i]
  }
  const useCallback = (fn, deps) => {
    const i = cursor
    cursor += 1
    const prev = slots[i]
    if (prev && sameDeps(prev.deps, deps)) return prev.fn
    slots[i] = { fn, deps }
    return fn
  }
  const useEffect = (fn, deps) => {
    const i = cursor
    cursor += 1
    const prev = slots[i]
    if (prev && sameDeps(prev.deps, deps)) {
      slots[i] = { fn, deps }
      return
    }
    slots[i] = { fn, deps }
    pending.push(fn)
  }

  return {
    react: { createElement, useState, useRef, useCallback, useEffect },
    /**
     * 渲染（含执行本次登记的 effects），并在 setState 后自动重渲染——
     * 否则测试只能看到「加载中」那一帧（第一版就是这么假绿的）。
     */
    async render(Component, props = {}) {
      let tree
      for (let pass = 0; pass < 20; pass += 1) {
        cursor = 0
        pending = []
        dirty = false
        tree = Component(props)
        for (const fn of pending) {
          const cleanup = fn()
          if (typeof cleanup === 'function') cleanups.push(cleanup)
        }
        await flush()
        if (!dirty) break
      }
      return tree
    },
    /** 卸载：执行所有 effect 的清理函数。 */
    async unmount() {
      for (const fn of cleanups.splice(0)) fn()
      await flush()
    },
    slots: () => slots,
  }
}

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r))
}

/* ------------------------------------------------------------------ 假环境 */

function createEnv({ fetchImpl } = {}) {
  const registrations = []
  const docListeners = new Map()
  const intervals = new Map()
  let intervalSeq = 0
  const headChildren = []

  const document = {
    hidden: false,
    head: { appendChild: (n) => headChildren.push(n) },
    createElement: (tag) => {
      const node = {
        tagName: tag, attributes: {}, style: {}, textContent: '', children: [],
        setAttribute(k, v) { node.attributes[k] = v },
        remove() { const i = headChildren.indexOf(node); if (i >= 0) headChildren.splice(i, 1) },
      }
      return node
    },
    addEventListener: (name, fn) => docListeners.set(name, fn),
    removeEventListener: (name) => docListeners.delete(name),
  }
  const window = {
    __ModuleLoader__: { load: (opts) => registrations.push(opts) },
    setInterval: (fn, ms) => {
      intervalSeq += 1
      intervals.set(intervalSeq, { fn, ms })
      return intervalSeq
    },
    clearInterval: (id) => intervals.delete(id),
  }
  const fetchCalls = []
  const fetch = async (url, init) => {
    fetchCalls.push({ url, init })
    return fetchImpl ? fetchImpl(url, init) : {
      json: async () => ({
        fetchedAt: Date.now(), stale: false, error: '', session: 'session-abc',
        office: {
          zones: [{ id: 'office', name: '公司区', description: 'DSH 会话', originY: 900 }],
          rooms: [{ id: 'office-desks', name: '公司工位', kind: 'working', capacity: 4, x: 30, y: 900, w: 560, h: 400, zone: 'office' }],
          agents: [{ id: 'session-abc', name: '本会话', color: '#8daff4', activity: 'working', roomId: 'office-desks', zone: 'office', online: true }],
          retiredCount: 0,
        },
        stats: {},
      }),
    }
  }
  return { document, window, fetch, fetchCalls, registrations, intervals, docListeners, headChildren }
}

/** 加载 lib/client.js 并触发 __ModuleLoader__.load。 */
function loadBundle(env) {
  const src = fs.readFileSync(bundlePath, 'utf8')
  const require = (id) => {
    if (id === 'react') return env.mini.react
    throw new Error(`client bundle 只允许 require 种子模块，收到: ${id}`)
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'require', 'fetch', 'console', src)
  run(env.window, env.document, require, env.fetch, { log: () => {}, error: () => {} })
}

/** 收集渲染树里的纯文本。 */
function texts(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out)
    return out
  }
  if (node.props) texts(node.props.children, out)
  return out
}

async function boot({ fetchImpl } = {}) {
  const env = createEnv({ fetchImpl })
  env.mini = createMiniReact()
  globalThis.window = env.window
  globalThis.document = env.document
  try {
    loadBundle(env)
  } finally {
    delete globalThis.window
    delete globalThis.document
  }
  assert.equal(env.registrations.length, 1, `应注册为一个 client bundle：${env.registrations.length}`)
  const mod = env.registrations[0].factory((id) => {
    if (id === 'react') return env.mini.react
    throw new Error(`种子模块未提供: ${id}`)
  })
  env.module = mod
  return env
}

/** 假 ctx：只实现 slots.inject/register（条目都写进调用方给的数组）。 */
function fakeCtx(entries) {
  return {
    entries,
    slots: {
      inject: (_name, cb) => {
        cb()
        return () => { entries.length = 0 }
      },
      register: (options, component) => {
        const entry = { options, component }
        entries.push(entry)
        return () => {
          const i = entries.indexOf(entry)
          if (i >= 0) entries.splice(i, 1)
        }
      },
    },
  }
}

describe('client bundle —— 会话标题栏「办公室」标签页', () => {
  it('bundle 身份与 module 形状：__ModuleLoader__.load + name/inject/apply', async () => {
    const env = await boot()
    assert.equal(env.window.__ModuleLoader__ ? true : true, true)
    assert.equal(env.registrations[0].id, 'dsh-bit-office')
    assert.equal(env.module.name, 'dsh-bit-office')
    assert.deepEqual(env.module.inject, ['slots'])
    assert.equal(typeof env.module.apply, 'function')
  })

  it('注册 conversation.view 槽：id=office、order=25、label 返回字符串「办公室」', async () => {
    const env = await boot()
    const entries = []
    const ctx = fakeCtx(entries)
    env.module.apply(ctx)
    assert.equal(entries.length, 1)
    const { options, component } = entries[0]
    assert.equal(options.name, 'conversation.view')
    assert.equal(options.id, 'office')
    assert.equal(options.order, 25)
    assert.equal(typeof options.label, 'function', 'label 必须是函数（官方 tab 同款）')
    assert.equal(options.label(), '办公室')
    assert.equal(typeof component, 'function')
  })

  it('视图从同源路由取数：GET /api/dsh-bit-office/state?session=<sid>，10 秒轮询', async () => {
    const env = await boot()
    const entries = []
    env.module.apply(fakeCtx(entries))
    const view = entries[0].component
    const tree = await env.mini.render(view, { sessionId: 'session-abc' })
    assert.equal(env.fetchCalls.length, 1)
    assert.equal(env.fetchCalls[0].url, '/api/dsh-bit-office/state?session=session-abc')
    assert.equal(env.fetchCalls[0].init.headers.accept, 'application/json')
    const intervals = [...env.intervals.values()]
    assert.equal(intervals.length, 1)
    assert.equal(intervals[0].ms, 10000)
    await env.mini.unmount()
  })

  it('渲染出平面图 SVG 与统计信息，并对当前会话打高亮', async () => {
    const env = await boot()
    const entries = []
    env.module.apply(fakeCtx(entries))
    const tree = await env.mini.render(entries[0].component, { sessionId: 'session-abc' })
    const all = texts(tree).join(' | ')
    assert.match(all, /办公室/)
    assert.match(all, /1 在位/)
    assert.match(all, /本会话：工作中/)
    const svgHost = findNode(tree, (n) => n.props && n.props.dangerouslySetInnerHTML)
    assert.ok(svgHost, '应把纯函数产出的 SVG 注入容器')
    const html = svgHost.props.dangerouslySetInnerHTML.__html
    assert.match(html, /<svg class="bo-floorplan"/)
    assert.match(html, /fill="#252a2f"/, '深色地板')
    assert.match(html, /bo-pet-current/, '当前会话高亮')
    assert.match(html, /公司工位/)
    await env.mini.unmount()
  })

  it('页面不可见时暂停轮询，切回可见立刻补一次', async () => {
    const env = await boot()
    const entries = []
    env.module.apply(fakeCtx(entries))
    await env.mini.render(entries[0].component, { sessionId: 'session-abc' })
    assert.equal(env.fetchCalls.length, 1)
    const [, tick] = [...env.intervals.entries()][0]
    env.document.hidden = true
    tick.fn()
    await flush()
    assert.equal(env.fetchCalls.length, 1, '不可见时不应发请求')
    env.document.hidden = false
    tick.fn()
    await flush()
    assert.equal(env.fetchCalls.length, 2, '恢复可见后应立刻补一次')
    const onVisibility = env.docListeners.get('visibilitychange')
    assert.equal(typeof onVisibility, 'function')
    onVisibility()
    await flush()
    assert.equal(env.fetchCalls.length, 3)
    await env.mini.unmount()
  })

  it('卸载清理：移除定时器、visibilitychange 监听与注入的 <style>', async () => {
    const env = await boot()
    const entries = []
    const dispose = env.module.apply(fakeCtx(entries))
    assert.equal(env.headChildren.length, 1, '应插入一份 <style>')
    await env.mini.render(entries[0].component, { sessionId: 'session-abc' })
    dispose()
    await env.mini.unmount()
    assert.equal(env.intervals.size, 0, '定时器必须清掉')
    assert.equal(env.docListeners.has('visibilitychange'), false, '事件监听必须摘掉')
    assert.equal(env.headChildren.length, 0, '<style> 必须移除')
    assert.equal(entries.length, 0, '槽条目应注销')
  })

  it('远端不可用：展示错误文案而不是白屏（且不抛）', async () => {
    const env = await boot({
      fetchImpl: async () => ({
        json: async () => ({ fetchedAt: 1, stale: true, error: 'ECONNREFUSED', office: { agents: [], rooms: [], zones: [] } }),
      }),
    })
    const entries = []
    env.module.apply(fakeCtx(entries))
    const tree = await env.mini.render(entries[0].component, { sessionId: 'session-abc' })
    const all = texts(tree).join(' | ')
    assert.match(all, /远端读取失败/)
    assert.match(all, /办公室/)
    await env.mini.unmount()
  })

  it('fetch 直接抛异常：不冒泡出组件（只显示错误）', async () => {
    const env = await boot({ fetchImpl: async () => { throw new Error('boom') } })
    const entries = []
    env.module.apply(fakeCtx(entries))
    const tree = await env.mini.render(entries[0].component, { sessionId: 'session-abc' })
    const all = texts(tree).join(' | ')
    assert.match(all, /boom/)
    await env.mini.unmount()
  })

  it('无 sessionId 时不带查询参数（也能渲染）', async () => {
    const env = await boot()
    const entries = []
    env.module.apply(fakeCtx(entries))
    await env.mini.render(entries[0].component, {})
    assert.equal(env.fetchCalls[0].url, '/api/dsh-bit-office/state')
    await env.mini.unmount()
  })
})

function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate)
      if (hit) return hit
    }
    return null
  }
  if (predicate(node)) return node
  return findNode(node.props ? node.props.children : null, predicate)
}
