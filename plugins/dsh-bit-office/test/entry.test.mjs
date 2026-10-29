/**
 * 自证测试：Cordis entry（lib/index.mjs）——用假 ctx 挂载整条插件
 *
 * 覆盖：inject 名单、工具注册、systemPrompt 短约定、路由注册与返回体、
 * 四类生命周期事件的接线（session/subagent）、服务缺失时的降级、卸载清理。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { apply, mergeOffice, PROMPT_TEXT, inject } from '../lib/index.mjs'
import { startMockOffice } from './mock-mcp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function drain(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) await sleep(6)
}

/** 最小 cordis ctx 替身。 */
function fakeCtx(services = {}, { throwOnGet = [] } = {}) {
  const handlers = new Map()
  const disposers = []
  const promptSections = []
  const registeredTools = []
  const routes = []
  const ctx = {
    handlers,
    disposers,
    promptSections,
    registeredTools,
    routes,
    get(name) {
      if (throwOnGet.includes(name)) throw new Error(`cannot get property without inject: ${name}`)
      return services[name]
    },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return () => { if (typeof dispose === 'function') dispose() }
    },
    /** 触发某个事件的所有监听器。 */
    emit(name, ...args) {
      for (const fn of handlers.get(name) || []) fn(...args)
    },
  }
  return ctx
}

/** 组装一份带 tools/systemPrompt/webServer/sessions/sessionTitle 的服务表。 */
function servicesFor(ctx, { sessions = new Map(), titles = new Map() } = {}) {
  const tools = { register: (def) => { ctx.registeredTools.push(def); return () => {} } }
  const systemPrompt = { section: (s) => { ctx.promptSections.push(s); return () => {} } }
  const webServer = { register: (route) => { ctx.routes.push(route); return () => {} } }
  const sessionsSvc = {
    get: (id) => sessions.get(id),
    list: () => [...sessions.values()],
  }
  const sessionTitleSvc = {
    get: (session) => (session && titles.has(session.id) ? { title: titles.get(session.id) } : undefined),
  }
  return { tools, systemPrompt, webServer, sessions: sessionsSvc, sessionTitle: sessionTitleSvc }
}

const ENV_KEYS = ['BIT_OFFICE_MCP_URL', 'BIT_OFFICE_MCP_TOKEN', 'BIT_OFFICE_ZONE', 'BIT_OFFICE_RETENTION_MS', 'BIT_OFFICE_ZONE', 'BIT_OFFICE_LOG']

describe('Cordis entry —— 挂载、能力面与降级', () => {
  /** @type {Awaited<ReturnType<typeof startMockOffice>>} */
  let mock
  const savedEnv = {}

  before(async () => {
    mock = await startMockOffice()
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
    process.env.BIT_OFFICE_MCP_URL = mock.url
    process.env.BIT_OFFICE_MCP_TOKEN = 'test-token'
    process.env.BIT_OFFICE_RETENTION_MS = '300'
  })
  after(async () => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    await mock.close()
  })

  it('inject 名单与核对过的服务名一致（严格注入）', () => {
    assert.deepEqual(inject, ['webServer', 'tools', 'systemPrompt', 'sessions', 'sessionTitle'])
  })

  it('注册两个模型工具，且形状是可被 ctx.tools.register 接受的 JSON-Schema', async (t) => {
    const sessions = new Map()
    const ctx = fakeCtx()
    const services = servicesFor(ctx, { sessions, titles: new Map() })
    ctx.get = ((orig) => (name) => (name in services ? services[name] : orig(name)))(ctx.get)
    t.after(() => { try { applyResult() } catch { /* noop */ } })
    const applyResult = apply(ctx)
    await drain(2)
    const names = ctx.registeredTools.map((d) => d.name)
    assert.deepEqual(names, ['bit_office_report', 'bit_office_state'])
    const report = ctx.registeredTools[0]
    assert.equal(report.parameters.type, 'object')
    assert.equal(report.parameters.additionalProperties, false)
    assert.deepEqual(Object.keys(report.parameters.properties), ['activity', 'task_id', 'task_title', 'status', 'blocked', 'note'])
    assert.deepEqual(report.parameters.properties.activity.enum, ['working', 'meeting', 'discussing', 'resting', 'fishing', 'offline'])
    assert.deepEqual(report.output.schema, { type: 'string' })
    // render 必须返回 content block 数组（外层再包 {content:[…]} 会报错）
    assert.deepEqual(report.output.render({}, 'hi'), [{ type: 'text', text: 'hi' }])
    assert.equal(typeof report.execute, 'function')
  })

  it('systemPrompt 注入 3~5 行短约定（不塞长 SOP）', async () => {
    const ctx = fakeCtx()
    const services = servicesFor(ctx)
    ctx.get = ((orig) => (name) => (name in services ? services[name] : orig(name)))(ctx.get)
    const dispose = apply(ctx)
    await drain(2)
    assert.equal(ctx.promptSections.length, 1)
    const section = ctx.promptSections[0]
    assert.equal(section.name, 'dsh-bit-office')
    assert.equal(typeof section.order, 'number')
    const lines = section.text.split('\n')
    assert.ok(lines.length >= 3 && lines.length <= 5, `应为 3~5 行，实际 ${lines.length}`)
    assert.ok(section.text.length < 400, `每请求都进上下文，必须短（实际 ${section.text.length} 字）`)
    assert.match(section.text, /bit_office_report/)
    assert.match(section.text, /bit_office_state/)
    assert.equal(PROMPT_TEXT, section.text)
    dispose()
  })

  it('注册同源只读路由 /api/dsh-bit-office/state，并返回合并后的办公室状态', async () => {
    const sessions = new Map()
    const titles = new Map()
    const ctx = fakeCtx()
    const services = servicesFor(ctx, { sessions, titles })
    ctx.get = ((orig) => (name) => (name in services ? services[name] : orig(name)))(ctx.get)
    const dispose = apply(ctx)
    await drain(2)
    assert.equal(ctx.routes.length, 1)
    const route = ctx.routes[0]
    assert.equal(route.kind, 'exact')
    assert.equal(route.path, '/api/dsh-bit-office/state')

    // 先制造一条真实记录
    sessions.set('session-ui', { id: 'session-ui', header: { cwd: '/home/x/ALL_CODE' } })
    titles.set('session-ui', '挂在办公室标签页的会话')
    ctx.emit('session/created', sessions.get('session-ui'))
    await drain()

    let captured = null
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k] = v },
      end(body) { captured = JSON.parse(body) },
    }
    await route.handler({ url: '/api/dsh-bit-office/state?session=session-ui', method: 'GET' }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(captured.session, 'session-ui')
    assert.equal(captured.stale, false)
    assert.equal(captured.local.stats.sessions >= 1, true)
    const ids = captured.office.agents.map((a) => a.id)
    assert.ok(ids.includes('session-ui'), `路由返回的 agents 应含本会话，实际 ${ids.join(',')}`)
    const me = captured.office.agents.find((a) => a.id === 'session-ui')
    assert.equal(me.name, '挂在办公室标签页的会话')
    assert.ok(captured.office.zones.some((z) => z.id === 'office'))
    assert.ok(captured.stats.agents >= 1)
    dispose()
  })

  it('路由在远端不可用时也返回 200 + stale（标签页显示降级态而不是白屏）', async () => {
    const ctx = fakeCtx()
    const services = servicesFor(ctx)
    ctx.get = ((orig) => (name) => (name in services ? services[name] : orig(name)))(ctx.get)
    const dispose = apply(ctx)
    await drain(2)
    const route = ctx.routes[0]
    // 指向不存在的端口：让 initialize/写操作全失败
    process.env.BIT_OFFICE_MCP_URL = 'http://127.0.0.1:1/mcp'
    const ctx2 = fakeCtx()
    const services2 = servicesFor(ctx2)
    ctx2.get = ((orig) => (name) => (name in services2 ? services2[name] : orig(name)))(ctx2.get)
    const dispose2 = apply(ctx2)
    await drain(2)
    let captured = null
    await ctx2.routes[0].handler({ url: '/api/dsh-bit-office/state', method: 'GET' }, {
      statusCode: 0, headers: {}, setHeader() {}, end(b) { captured = JSON.parse(b) },
    })
    assert.equal(captured.stale, true)
    assert.ok(captured.error.length > 0)
    process.env.BIT_OFFICE_MCP_URL = mock.url
    dispose()
    dispose2()
  })

  it('session/created → 自动建记录（zone=office，标题来自 sessionTitle）', async () => {
    const sessions = new Map()
    const titles = new Map()
    const ctx = fakeCtx()
    const services = servicesFor(ctx, { sessions, titles })
    ctx.get = ((orig) => (name) => (name in services ? services[name] : orig(name)))(ctx.get)
    const dispose = apply(ctx)
    await drain(2)
    const session = { id: 'session-evt-1', header: { cwd: '/home/x/proj' } }
    sessions.set(session.id, session)
    titles.set(session.id, '事件驱动的会话')
    ctx.emit('session/created', session)
    await drain()
    const agent = mock.agents.get('session-evt-1')
    assert.ok(agent, 'session/created 应触发自动登记')
    assert.equal(agent.name, '事件驱动的会话')
    assert.equal(agent.zone, 'office')
    assert.equal(agent.activity, 'working')
    dispose()
  })

  it('session/created（无标题）→ 名称回退到「目录名 · 会话 id 后 6 位」', async () => {
    const sessions = new Map()
    const ctx = fakeCtx()
    const services = servicesFor(ctx, { sessions, titles: new Map() })
    ctx.get = ((orig) => (name) => (name in services ? services[name] : orig(name)))(ctx.get)
    const dispose = apply(ctx)
    await drain(2)
    const session = { id: 'session-evt-2', header: { cwd: '/home/x/projDir' } }
    sessions.set(session.id, session)
    ctx.emit('session/created', session)
    await drain()
    assert.equal(mock.agents.get('session-evt-2').name, `projDir · ${'session-evt-2'.slice(-6)}`)
    dispose()
  })

  it('subagent/start → parent_id = 父会话 agent_id（用 sessions 的 header.parentSession）', async () => {
    const sessions = new Map()
    const ctx = fakeCtx()
    const services = servicesFor(ctx, { sessions, titles: new Map() })
    ctx.get = ((orig) => (name) => (name in services ? services[name] : orig(name)))(ctx.get)
    const dispose = apply(ctx)
    await drain(2)
    const parent = { id: 'session-parent-1', header: { cwd: '/p' } }
    const child = { id: 'session-child-1', header: { cwd: '/p', parentSession: 'session-parent-1' } }
    sessions.set(parent.id, parent)
    sessions.set(child.id, child)
    ctx.emit('subagent/start', { runId: 'r1', provider: 'subagent', id: child.id, local: true }, { session: parent })
    await drain()
    const agent = mock.agents.get('session-child-1')
    assert.equal(agent.parentId, 'session-parent-1')
    assert.equal(agent.activity, 'discussing')
    dispose()
  })

  it('subagent/end → offline + 终态 task，保留期后退休（BIT_OFFICE_RETENTION_MS=300）', async () => {
    const sessions = new Map()
    const ctx = fakeCtx()
    const services = servicesFor(ctx, { sessions, titles: new Map() })
    ctx.get = ((orig) => (name) => (name in services ? services[name] : orig(name)))(ctx.get)
    const dispose = apply(ctx)
    await drain(2)
    const child = { id: 'session-child-2', header: { cwd: '/p', parentSession: 'session-parent-x' } }
    sessions.set(child.id, child)
    ctx.emit('subagent/start', { runId: 'r2', provider: 'subagent', id: child.id }, null)
    await drain()
    ctx.emit('subagent/end', { runId: 'r2', provider: 'subagent', id: child.id, stopReason: 'completed' })
    await drain()
    const agent = mock.agents.get('session-child-2')
    assert.equal(agent.activity, 'offline')
    assert.equal(agent.tasks[0].status, 'completed')
    assert.match(agent.tasks[0].title, /subagent · completed/)
    assert.equal(agent.retiredAt, undefined, '保留期内不退休')
    await sleep(500)
    await drain()
    assert.ok(mock.agents.get('session-child-2').retiredAt, '超过保留期（300ms）后应软退休')
    dispose()
  })

  it('session/disposed → cascade 软退休（连带子记录）', async () => {
    const sessions = new Map()
    const ctx = fakeCtx()
    const services = servicesFor(ctx, { sessions, titles: new Map() })
    ctx.get = ((orig) => (name) => (name in services ? services[name] : orig(name)))(ctx.get)
    const dispose = apply(ctx)
    await drain(2)
    const parent = { id: 'session-parent-9', header: { cwd: '/p' } }
    const child = { id: 'session-child-9', header: { cwd: '/p', parentSession: 'session-parent-9' } }
    sessions.set(parent.id, parent)
    sessions.set(child.id, child)
    ctx.emit('session/created', parent)
    ctx.emit('subagent/start', { runId: 'r9', provider: 'subagent', id: child.id }, { session: parent })
    await drain()
    sessions.delete(parent.id)
    ctx.emit('session/disposed', parent)
    await drain()
    const agent = mock.agents.get('session-parent-9')
    assert.ok(agent.retiredAt)
    assert.equal(agent.retireReason, 'DSH session disposed')
    assert.ok(mock.agents.get('session-child-9').retiredAt, 'cascade=true 连带退休')
    dispose()
  })

  it('事件处理里抛出也不冒泡（session 为空 / 形状不符）', async () => {
    const ctx = fakeCtx()
    const services = servicesFor(ctx)
    ctx.get = ((orig) => (name) => (name in services ? services[name] : orig(name)))(ctx.get)
    const dispose = apply(ctx)
    await drain(2)
    assert.doesNotThrow(() => ctx.emit('session/created', null))
    assert.doesNotThrow(() => ctx.emit('session/created', {}))
    assert.doesNotThrow(() => ctx.emit('session/disposed', undefined))
    assert.doesNotThrow(() => ctx.emit('subagent/start', null))
    assert.doesNotThrow(() => ctx.emit('subagent/end', {}))
    dispose()
  })

  it('服务缺失（webServer/tools/systemPrompt 都 undefined）→ 仍能挂载与卸载', async () => {
    const ctx = fakeCtx({}) // ctx.get 全返回 undefined
    const logs = []
    const origLog = console.log
    console.log = (m) => logs.push(String(m))
    let dispose
    try {
      assert.doesNotThrow(() => { dispose = apply(ctx) })
      await drain(2)
      assert.equal(ctx.registeredTools.length, 0)
      assert.equal(ctx.promptSections.length, 0)
      assert.equal(ctx.routes.length, 0)
      assert.ok(logs.some((l) => l.includes('webServer 服务不可用')))
      assert.ok(logs.some((l) => l.includes('tools 服务不可用')))
      assert.ok(logs.some((l) => l.includes('systemPrompt 服务不可用')))
    } finally {
      console.log = origLog
    }
    assert.doesNotThrow(() => dispose())
  })

  it('ctx.get 直接抛（严格注入未声明）→ webServer 分支不炸掉插件', async () => {
    const ctx = fakeCtx({}, { throwOnGet: ['webServer'] })
    const services = servicesFor(ctx)
    ctx.get = ((orig) => (name) => (name in services && name !== 'webServer' ? services[name] : orig(name)))(ctx.get)
    let dispose
    assert.doesNotThrow(() => { dispose = apply(ctx) })
    await drain(2)
    // webServer 抛异常被 effect 的 try/catch 收拾，其它能力面照常注册
    assert.equal(ctx.registeredTools.length, 2)
    assert.doesNotThrow(() => dispose())
  })

  it('卸载：工具/路由/prompt 的 disposer 都被调用，且定时器被清（可重复调用）', async () => {
    const ctx = fakeCtx()
    const calls = []
    const services = {
      tools: { register: () => () => calls.push('tools') },
      systemPrompt: { section: () => () => calls.push('prompt') },
      webServer: { register: () => () => calls.push('route') },
    }
    ctx.get = ((orig) => (name) => (name in services ? services[name] : orig(name)))(ctx.get)
    const dispose = apply(ctx)
    await drain(2)
    dispose()
    assert.deepEqual([...new Set(calls)].sort(), ['prompt', 'route', 'tools'])
    assert.doesNotThrow(() => dispose())
  })

  it('mergeOffice：远端的记录优先，本地在途记录标记 pending，本地父子关系回填', () => {
    const merged = mergeOffice(
      { agents: [{ id: 'a', name: '远端名', activity: 'working', zone: 'office' }], rooms: [{ id: 'r' }], zones: [{ id: 'office' }], retiredCount: 2 },
      [
        { id: 'a', name: '本地新名', zoneId: 'office', parentId: '' },
        { id: 'b', name: '在途记录', kind: 'subagent', parentId: 'a', zoneId: 'office', retiredAt: null },
        { id: 'c', name: '已退休本地', zoneId: 'office', retiredAt: 123 },
      ],
    )
    assert.equal(merged.mode, 'live')
    assert.equal(merged.retiredCount, 2)
    const a = merged.agents.find((x) => x.id === 'a')
    assert.equal(a.name, '本地新名', '本地更新的名字（标题后生成）应覆盖远端旧名')
    const b = merged.agents.find((x) => x.id === 'b')
    assert.equal(b.pending, true)
    assert.equal(b.activity, 'discussing')
    const c = merged.agents.find((x) => x.id === 'c')
    assert.equal(c.retired, true)
    assert.equal(c.online, false)
    // 远端不可用时也要有可渲染结构
    const offline = mergeOffice(null, [{ id: 'x', name: 'X', kind: 'session', zoneId: 'office', parentId: '' }])
    assert.equal(offline.mode, 'local')
    assert.equal(offline.agents.length, 1)
    assert.deepEqual(offline.rooms, [])
  })
})
