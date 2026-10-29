/**
 * 自证测试：模型工具（bit_office_report / bit_office_state）
 *
 * 工具是模型唯一直接接触的面，必须证明：信封解析、参数白名单、
 * 上报真的落到远端、无归属时不炸、只读工具在远端故障时降级为 stale。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { McpClient } from '../lib/mcp.mjs'
import { OfficeApi } from '../lib/office.mjs'
import { OfficeSync } from '../lib/sync.mjs'
import { isSessionId, makeOfficeTools, normalizeOffice, sessionIdFromExec, slug } from '../lib/tools.mjs'
import { startMockOffice } from './mock-mcp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function drain(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await sleep(6)
}

async function harness(knobs = {}) {
  const mock = await startMockOffice(knobs)
  const client = new McpClient({ url: mock.url, token: 't', timeoutMs: 5000 })
  await client.initialize()
  await client.refreshTools()
  const api = new OfficeApi({ client, log: () => {} })
  const logs = []
  const sync = new OfficeSync({
    api,
    config: { zoneId: 'office', throttleMs: 0, cacheMs: 0 },
    log: (m) => logs.push(m),
  })
  const tools = makeOfficeTools({
    sync,
    sessionInfo: (id) => ({ title: `标题-${id.slice(-4)}`, cwd: '/home/x/ALL_CODE' }),
    log: (m) => logs.push(m),
  })
  const [report, state] = tools
  return {
    mock, sync, logs, report, state,
    agent: (id) => mock.agents.get(id),
    close: () => { sync.dispose(); return mock.close() },
  }
}

describe('工具 —— 定义与信封解析', () => {
  it('defineTool 等价物的形状与官方一致（render 返回 content block 数组）', async () => {
    const h = await harness()
    try {
      for (const tool of [h.report, h.state]) {
        assert.equal(typeof tool.name, 'string')
        assert.ok(tool.description.length > 10)
        assert.equal(tool.parameters.type, 'object')
        assert.equal(tool.parameters.additionalProperties, false)
        assert.deepEqual(tool.output.schema, { type: 'string' })
        assert.deepEqual(tool.output.render({}, 'x'), [{ type: 'text', text: 'x' }])
        assert.deepEqual(tool.output.render({}, { a: 1 })[0].text, '{\n  "a": 1\n}')
      }
      // execute 声明的返回类型是 string，无论内部返回什么
      const out = await h.state.execute({}, {})
      assert.equal(typeof out, 'string')
    } finally {
      await h.close()
    }
  })

  it('sessionIdFromExec 能从多种信封形状里找到会话 id，找不到就空串', () => {
    assert.equal(sessionIdFromExec({ agent: { sessionId: 'session-aaa-111' } }), 'session-aaa-111')
    assert.equal(sessionIdFromExec({ sessionId: 'session-bbb-222' }), 'session-bbb-222')
    assert.equal(sessionIdFromExec({ agent: { session: { id: 'session-ccc-333' } } }), 'session-ccc-333')
    assert.equal(sessionIdFromExec({ caller: { agentId: 'session-ddd-444' } }), 'session-ddd-444')
    assert.equal(sessionIdFromExec(undefined), '')
    assert.equal(sessionIdFromExec({}), '')
    assert.equal(sessionIdFromExec({ agent: { name: '没有 id' } }), '')
    assert.equal(sessionIdFromExec({ note: 'session-eee-555' }), '', '非 agent/session 字段不认')
    // 自引用环不炸
    const cyclic = { agent: {} }
    cyclic.agent.self = cyclic
    assert.equal(sessionIdFromExec(cyclic), '')
    assert.equal(isSessionId('session-x-1'), true)
    assert.equal(isSessionId('nohyphen'), false)
    assert.equal(isSessionId(42), false)
  })

  it('slug 生成稳定可读的任务 id', () => {
    assert.equal(slug('核对 DSH 插件自证测试'), 'dsH'.toLowerCase().slice(0, 0) + 'dsh')
    assert.equal(slug('Hello World!!'), 'hello-world')
    assert.equal(slug(''), '')
    assert.ok(slug('x'.repeat(80)).length <= 24)
  })

  it('normalizeOffice 兼容 snake_case / retiredAt / 缺字段', () => {
    const out = normalizeOffice({
      agents: [{ agent_id: 'a', name: 'A', activity: 'working', zone_id: 'office', room_id: 'r', parent_id: 'p', retired_at: '2026-01-01', tasks: [1, 2] }],
      rooms: [{ room_id: 'r', name: 'R', kind: 'working', zone: 'office', capacity: 4 }],
      zones: [{ id: 'office', name: '公司区', origin_y: 900 }],
      retiredCount: 7,
    })
    assert.deepEqual(out.agents[0], {
      id: 'a', name: 'A', activity: 'working', online: true, zone: 'office',
      roomId: 'r', parentId: 'p', retired: true, tasks: [1, 2],
    })
    assert.equal(out.rooms[0].id, 'r')
    assert.equal(out.zones[0].originY, 900)
    assert.equal(out.retiredCount, 7)
    assert.deepEqual(normalizeOffice(null).agents, [])
  })
})

describe('工具 —— 执行', () => {
  it('bit_office_report：把任务写到远端并在办公室可见', async () => {
    const h = await harness()
    try {
      const out = JSON.parse(await h.report.execute(
        { activity: 'meeting', task_title: '和评审对齐', status: 'running', blocked: true },
        { agent: { sessionId: 'session-tool-1' } },
      ))
      assert.equal(out.ok, true)
      await drain()
      const agent = h.agent('session-tool-1')
      assert.ok(agent, '上报应创建/更新记录')
      assert.equal(agent.activity, 'meeting')
      assert.equal(agent.name, `标题-${'session-tool-1'.slice(-4)}`)
      assert.equal(agent.tasks.length, 1)
      assert.equal(agent.tasks[0].title, '和评审对齐')
      assert.equal(agent.tasks[0].blocked, true)
      assert.match(agent.tasks[0].id, new RegExp(`^task-${'session-tool-1'.slice(-6)}-`))
    } finally {
      await h.close()
    }
  })

  it('bit_office_report：非法 activity/status 被白名单挡掉，不写脏值', async () => {
    const h = await harness()
    try {
      await h.report.execute({ activity: 'HACK', task_title: 't', status: 'nope' }, { agent: { sessionId: 'session-tool-2' } })
      await drain()
      const agent = h.agent('session-tool-2')
      assert.equal(agent.activity, 'working', '非法 activity 应被忽略（保留自动登记时的 working）')
      assert.equal(agent.tasks[0].status, 'running', '非法 status 回退 running')
      await h.report.execute({ note: '只用 note' }, { agent: { sessionId: 'session-tool-2' } })
      await drain()
      assert.equal(h.agent('session-tool-2').tasks[0].title, '只用 note')
    } finally {
      await h.close()
    }
  })

  it('bit_office_report：解析不到会话 id → 返回 ok:false，不抛也不写', async () => {
    const h = await harness()
    try {
      const out = JSON.parse(await h.report.execute({ activity: 'resting' }, {}))
      assert.equal(out.ok, false)
      assert.match(out.error, /无法从工具执行信封解析/)
      await drain()
      assert.equal(h.mock.ctl.calls.filter((c) => c.name === 'update_agent_status').length, 0)
    } finally {
      await h.close()
    }
  })

  it('bit_office_state：返回分区/房间/agent 概览（任务只给数量）', async () => {
    const h = await harness()
    try {
      h.sync.registerSession({ sessionId: 'session-tool-3', title: '被查的会话' })
      await drain()
      const out = JSON.parse(await h.state.execute({ include_retired: true }, {}))
      assert.equal(out.ok, true)
      assert.ok(out.zones.some((z) => z.id === 'office'))
      assert.ok(out.rooms.length >= 1)
      const me = out.agents.find((a) => a.id === 'session-tool-3')
      assert.equal(me.name, '被查的会话')
      assert.equal(me.tasks, 0, '只给任务数量，不给正文')
      assert.equal(out.local.tracked >= 1, true)
      assert.equal(typeof out.fetchedAt, 'number')
    } finally {
      await h.close()
    }
  })

  it('bit_office_state：远端故障 → ok:false + stale:true + error，不抛', async () => {
    const h = await harness()
    try {
      h.sync.registerSession({ sessionId: 'session-tool-4', title: '本地会话' })
      await drain()
      await h.mock.close()
      h.sync.stateCache = null
      const out = JSON.parse(await h.state.execute({}, {}))
      assert.equal(out.ok, false)
      assert.equal(out.stale, true)
      assert.ok(out.error.length > 0)
      assert.equal(out.local.tracked, 1, '本地账本仍可用')
      h.sync.dispose()
    } catch (err) {
      h.sync.dispose()
      throw err
    }
  })
})
