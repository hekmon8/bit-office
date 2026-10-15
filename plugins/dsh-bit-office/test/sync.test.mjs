/**
 * 自证测试 ⑤⑦：退休/保留期调度、节流、per-agent 串行，以及
 * 「任何失败只写日志、绝不抛出/阻塞会话」。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { McpClient } from '../lib/mcp.mjs'
import { OfficeApi } from '../lib/office.mjs'
import { OfficeSync } from '../lib/sync.mjs'
import { startMockOffice } from './mock-mcp.mjs'

/** 可手动推进的假时钟 + 定时器（用于验证 retentionMs 调度）。 */
function fakeClock(start = 1_700_000_000_000) {
  let now = start
  let seq = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout: (fn, delay) => {
      seq += 1
      const id = { id: seq, at: now + Math.max(0, Number(delay) || 0), fn }
      timers.set(seq, id)
      return id
    },
    clearTimeout: (t) => {
      if (t && t.id) timers.delete(t.id)
    },
    /** 推进时间并触发到期定时器。 */
    async advance(ms) {
      now += ms
      for (const t of [...timers.values()].sort((a, b) => a.at - b.at)) {
        if (t.at <= now) {
          timers.delete(t.id)
          t.fn()
        }
      }
      await drain()
    },
    pending: () => timers.size,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 等所有 fire-and-forget 的写操作真正落地。
 * 注意不能只用 setImmediate 空转：那不会推进真实时间，本地 HTTP 往返永远完不成
 * （本仓库自证测试第一版就是这么假绿的）。这里用真实短睡 + 队列静默双条件。
 */
async function drain(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await sleep(6)
}

async function harness(knobs = {}, syncOpts = {}) {
  const mock = await startMockOffice(knobs)
  const client = new McpClient({ url: mock.url, token: 't', timeoutMs: 5000 })
  await client.initialize()
  await client.refreshTools()
  const api = new OfficeApi({ client, log: () => {} })
  const clock = fakeClock()
  const logs = []
  const sync = new OfficeSync({
    api,
    config: { zoneId: 'office', throttleMs: 60000, retentionMs: 15 * 60 * 1000, cacheMs: 0 },
    log: (m) => logs.push(m),
    now: clock.now,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    resolveParentSession: syncOpts.resolveParentSession || (() => ''),
    nameResolver: syncOpts.nameResolver || (() => ({})),
  })
  return {
    mock, client, api, sync, clock, logs,
    agent: (id) => mock.agents.get(id),
    close: () => {
      sync.dispose()
      return mock.close()
    },
  }
}

describe('OfficeSync —— 自动登记 / 节流 / 保留期 / 失败隔离', () => {
  it('session → 记录：zone=office、activity=working、online+heartbeat 立刻上报', async (t) => {
    const h = await harness()
    t.after(() => h.close())
    h.sync.registerSession({
      sessionId: 'session-p', title: '写 dsh-bit-office 插件', cwd: '/home/x/ALL_CODE',
    })
    await drain()
    const agent = h.agent('session-p')
    assert.ok(agent, '记录应已创建')
    assert.equal(agent.name, '写 dsh-bit-office 插件')
    assert.equal(agent.zone, 'office')
    assert.equal(agent.activity, 'working')
    assert.equal(agent.online, true)
    await h.close()
  })

  it('名称回退：无标题时用「目录名 · 会话 id 后 6 位」', async (t) => {
    const h = await harness()
    t.after(() => h.close())
    h.sync.registerSession({ sessionId: 'session-q123456', title: '', cwd: '/home/x/proj' })
    await drain()
    assert.equal(h.agent('session-q123456').name, 'proj · 123456')
    await h.close()
  })

  it('subagent/start：parent_id = 父会话 agent_id，activity=discussing', async (t) => {
    const h = await harness({}, {
      resolveParentSession: (childId) => (childId === 'session-child' ? 'session-parent' : ''),
    })
    h.sync.registerSession({ sessionId: 'session-parent', title: '父会话' })
    await drain()
    h.sync.startSubagent({ id: 'session-child', runId: 'run-1', provider: 'subagent' }, null)
    await drain()
    const child = h.agent('session-child')
    assert.equal(child.parentId, 'session-parent')
    assert.equal(child.activity, 'discussing')
    assert.match(child.name, /^子 agent subagent/)
    await h.close()
  })

  it('父会话解析不到：只建不带 parent 的记录并记日志', async (t) => {
    const h = await harness({}, { resolveParentSession: () => '' })
    t.after(() => h.close())
    h.sync.startSubagent({ id: 'session-orphan', runId: 'r', provider: 'subagent' }, null)
    await drain()
    assert.equal(h.agent('session-orphan').parentId, undefined)
    assert.ok(h.logs.some((l) => l.includes('父会话不可解析')))
    await h.close()
  })

  it('subagent/end：offline + 一条终态 task（含 provider/stopReason），保留期后才退休', async (t) => {
    const h = await harness({}, { resolveParentSession: () => 'session-parent' })
    t.after(() => h.close())
    h.sync.startSubagent({ id: 'session-child', runId: 'run-9', provider: 'subagent', stopReason: 'completed' }, null)
    await drain()
    h.sync.endSubagent({ id: 'session-child', runId: 'run-9', provider: 'subagent', stopReason: 'completed' })
    await drain()
    const child = h.agent('session-child')
    assert.equal(child.activity, 'offline')
    assert.equal(child.online, false)
    assert.equal(child.tasks[0].id, 'task-run-9')
    assert.equal(child.tasks[0].status, 'completed')
    assert.match(child.tasks[0].title, /subagent · completed/)
    assert.equal(child.retiredAt, undefined, '保留期内不得退休')
    assert.equal(h.clock.pending(), 1, '应挂着一个保留期定时器')

    // 提前 1ms 不触发
    await h.clock.advance(15 * 60 * 1000 - 1)
    await drain()
    assert.equal(h.agent('session-child').retiredAt, undefined)
    // 到点触发 retire_agent
    await h.clock.advance(1)
    await drain()
    assert.ok(h.agent('session-child').retiredAt, '保留期到期后应软退休')
    assert.match(h.agent('session-child').retireReason, /retention elapsed/)
    assert.equal(h.clock.pending(), 0)
    await h.close()
  })

  it('失败的 subagent（stopReason=error）→ task.status=failed', async (t) => {
    const h = await harness()
    t.after(() => h.close())
    h.sync.startSubagent({ id: 'session-bad', runId: 'r2', provider: 'subagent' }, null)
    await drain()
    h.sync.endSubagent({ id: 'session-bad', runId: 'r2', provider: 'subagent', stopReason: 'error' })
    await drain()
    assert.equal(h.agent('session-bad').tasks[0].status, 'failed')
    await h.close()
  })

  it('session/disposed：cascade 退休，且连带退休子记录', async (t) => {
    const h = await harness({}, { resolveParentSession: () => 'session-parent' })
    t.after(() => h.close())
    h.sync.registerSession({ sessionId: 'session-parent', title: '父' })
    h.sync.startSubagent({ id: 'session-child', runId: 'r', provider: 'subagent' }, null)
    await drain()
    h.sync.disposeSession('session-parent')
    await drain()
    assert.ok(h.agent('session-parent').retiredAt)
    assert.ok(h.agent('session-child').retiredAt, 'cascade=true 应连带退休子记录')
    assert.equal(h.agent('session-parent').retireReason, 'DSH session disposed')
    await h.close()
  })

  it('节流：同一 agent 60 秒内第二次上报被跳过（stats.skipped 递增）', async (t) => {
    const h = await harness()
    t.after(() => h.close())
    h.sync.registerSession({ sessionId: 'session-t', title: 'T' })
    await drain()
    const before = h.mock.ctl.calls.filter((c) => c.name === 'update_agent_status').length
    assert.equal(await h.sync.report('session-t', { activity: 'meeting' }), false, '刚上报过 → 被节流')
    assert.equal(h.sync.stats.skipped, 1)
    h.clock.advance(0)
    await h.clock.advance(60001)
    assert.equal(await h.sync.report('session-t', { activity: 'resting' }), true, '超 60s 后放行')
    await drain()
    const after = h.mock.ctl.calls.filter((c) => c.name === 'update_agent_status').length
    assert.equal(after, before + 1)
    assert.equal(h.agent('session-t').activity, 'resting')
    await h.close()
  })

  it('force=true 绕过节流（终态上报用）', async (t) => {
    const h = await harness()
    t.after(() => h.close())
    h.sync.registerSession({ sessionId: 'session-t2', title: 'T2' })
    await drain()
    assert.equal(await h.sync.report('session-t2', { activity: 'offline' }, { force: true }), true)
    await drain()
    assert.equal(h.agent('session-t2').activity, 'offline')
    await h.close()
  })

  it('per-agent 串行：并发写同一 agent 不会产生 revision_conflict 失败', async (t) => {
    const h = await harness()
    t.after(() => h.close())
    h.sync.registerSession({ sessionId: 'session-s', title: 'S' })
    await drain()
    const results = await Promise.all([
      h.sync.report('session-s', { activity: 'meeting' }, { force: true }),
      h.sync.report('session-s', { activity: 'discussing' }, { force: true }),
      h.sync.report('session-s', { activity: 'fishing' }, { force: true }),
    ])
    assert.deepEqual(results, [true, true, true])
    assert.equal(h.sync.stats.failures, 0, '串行队列应消除乐观锁冲突')
    assert.equal(h.agent('session-s').activity, 'fishing')
    await h.close()
  })

  it('远端不可达：registerSession 不抛，只记日志（会话不受影响）', async (t) => {
    const logs = []
    const api = {
      ensureAgent: async () => { throw new Error('network down') },
      updateStatus: async () => { throw new Error('network down') },
      retireAgent: async () => { throw new Error('network down') },
      getState: async () => { throw new Error('network down') },
    }
    const sync = new OfficeSync({ api, config: { zoneId: 'office' }, log: (m) => logs.push(m) })
    assert.doesNotThrow(() => sync.registerSession({ sessionId: 'session-x', title: 'X' }))
    assert.doesNotThrow(() => sync.startSubagent({ id: 'session-y', provider: 'subagent' }))
    assert.doesNotThrow(() => sync.endSubagent({ id: 'session-y', stopReason: 'error' }))
    assert.doesNotThrow(() => sync.disposeSession('session-x'))
    await drain()
    assert.ok(sync.stats.failures >= 3, `失败应被计入且不抛出，实际=${sync.stats.failures}`)
    assert.ok(logs.some((l) => l.includes('network down')))
    const state = await sync.readState({})
    assert.equal(state.stale, true)
    assert.match(state.error, /network down/)
    sync.dispose()
  })

  it('api 同步抛异常（非 Promise）也不会把异常带回事件回调', async (t) => {
    const sync = new OfficeSync({
      api: {
        ensureAgent: () => { throw new Error('sync boom') },
        updateStatus: () => { throw new Error('sync boom') },
        retireAgent: () => { throw new Error('sync boom') },
        getState: () => { throw new Error('sync boom') },
      },
      config: {},
      log: () => {},
    })
    assert.doesNotThrow(() => sync.registerSession({ sessionId: 'session-z', title: 'Z' }))
    await drain()
    assert.ok(sync.stats.failures >= 1)
    sync.dispose()
  })

  it('readState 带本地缓存（cacheMs）并对失败保留旧值 + stale 标记', async (t) => {
    const h = await harness()
    t.after(() => h.close())
    h.sync.config.cacheMs = 10000
    h.sync.registerSession({ sessionId: 'session-c1', title: 'C1' })
    await drain()
    const first = await h.sync.readState({})
    assert.equal(first.stale, false)
    const second = await h.sync.readState({})
    assert.equal(second.cached, true)
    // 让后端失效：关掉 mock 后读 → 保留旧值并标 stale
    await h.mock.close()
    h.sync.stateCache.at = 0
    const third = await h.sync.readState({})
    assert.equal(third.stale, true)
    assert.equal(third.payload.agents.length > 0, true, '应保留上一次成功的值')
    h.sync.dispose()
  })

  it('reconcileNames：标题后生成时校正名称（每条最多每 60s 一次）', async (t) => {
    let title = ''
    const h = await harness({}, { nameResolver: () => ({ title, cwd: '/a/b' }) })
    t.after(() => h.close())
    h.sync.registerSession({ sessionId: 'session-r', title: '', cwd: '/a/b' })
    await drain()
    assert.equal(h.agent('session-r').name, `b · ${'session-r'.slice(-6)}`)
    title = '真正的标题'
    assert.equal(h.sync.reconcileNames(), 1)
    await drain()
    assert.equal(h.agent('session-r').name, '真正的标题')
    assert.equal(h.sync.reconcileNames(), 0, '60s 内不重复校正')
    await h.close()
  })
})

describe('OfficeSync —— enabled=false 只做本地账本', () => {
  it('不发出任何远端请求，标签页仍能拿到本机会话', async (t) => {
    const logs = []
    const api = {
      ensureAgent: async () => { throw new Error('不应被调用') },
      updateStatus: async () => { throw new Error('不应被调用') },
      retireAgent: async () => { throw new Error('不应被调用') },
      getState: async () => { throw new Error('不应被调用') },
    }
    const sync = new OfficeSync({ api, config: { enabled: false, zoneId: 'office' }, log: (m) => logs.push(m) })
    t.after(() => sync.dispose())
    sync.registerSession({ sessionId: 'session-off', title: '关掉同步的会话' })
    await drain()
    assert.equal(sync.stats.writes, 0, '不应有任何远端写')
    assert.equal(sync.stats.failures, 0, '压根不该走到 api（走到就会失败）')
    assert.ok(sync.stats.skipped >= 1)
    const local = sync.localSnapshot()
    assert.equal(local.records.length, 1)
    assert.equal(local.records[0].name, '关掉同步的会话')
    const state = await sync.readState({})
    assert.equal(state.disabled, true)
    assert.equal(state.payload, null)
    assert.equal(state.stale, false, '主动关闭不是故障，不该标 stale')
  })
})
