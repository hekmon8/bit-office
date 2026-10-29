/**
 * 自证测试 ②：乐观锁（读 revision → 写 → 冲突重读重试）、agent_exists 改走 update、
 * 新契约字段缺失时的降级（zone_id/parent_id / retire_agent）。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { McpClient } from '../lib/mcp.mjs'
import { OfficeApi, agentOf, isRetired, revisionOf, stripUnsupported } from '../lib/office.mjs'
import { startMockOffice } from './mock-mcp.mjs'

/** 起一套 mock + api（附带 agent() 便捷访问器，取 mock 里唯一/首条记录）。 */
async function harness(knobs = {}) {
  const mock = await startMockOffice(knobs)
  const client = new McpClient({ url: mock.url, token: 't', timeoutMs: 5000 })
  await client.initialize()
  await client.refreshTools()
  const api = new OfficeApi({ client, log: () => {} })
  return {
    mock,
    client,
    api,
    agent: () => [...mock.agents.values()][0],
    close: () => mock.close(),
  }
}

describe('OfficeApi —— 乐观锁与新契约容错', () => {
  it('revision_conflict：重读 revision 后重试（最多 2 次），最终成功', async (t) => {
    const h = await harness({ conflictTimes: 2 })
    t.after(() => h.close())
    await h.api.ensureAgent({ agentId: 'session-a', name: 'A', zoneId: 'office' })
    const readsBefore = h.mock.ctl.calls.filter((c) => c.name === 'get_agent_state').length
    const ok = await h.api.updateStatus('session-a', { activity: 'meeting' })
    const readsAfter = h.mock.ctl.calls.filter((c) => c.name === 'get_agent_state').length
    assert.equal(ok, true, '冲突两次后第 3 次应当成功')
    // 每次写前都重读：初始 ensure 读了 1 次，写路径又读了 3 次
    assert.equal(readsAfter - readsBefore, 3)
    assert.equal(h.agent().activity, 'meeting')
    await h.close()
  })

  it('冲突超过重试上限：返回 false（不抛给会话）', async (t) => {
    const h = await harness({ conflictTimes: 99 })
    t.after(() => h.close())
    await h.api.ensureAgent({ agentId: 'session-b', name: 'B' })
    const ok = await h.api.updateStatus('session-b', { activity: 'resting' })
    assert.equal(ok, false)
    await h.close()
  })

  it('create_agent 返回 agent_exists → 改走 update 路径（顺带改名）', async (t) => {
    const h = await harness({ agentExistsOnce: true })
    t.after(() => h.close())
    // 先让服务端「已经存在」这条记录（模拟另一个会话先建好）
    h.mock.agents.set('session-c', {
      id: 'session-c', name: '旧名', color: '#8daff4', activity: 'working', roomId: 'office-desks',
      zone: 'office', online: true, tasks: [], revision: 99,
    })
    const outcome = await h.api.ensureAgent({ agentId: 'session-c', name: '新名', zoneId: 'office' })
    assert.equal(outcome, 'updated')
    assert.equal(h.agent().name, '新名')
    await h.close()
  })

  it('新契约字段被旧部署拒绝 → 剥掉 zone_id/parent_id 后降级创建，并记住不支持', async (t) => {
    const h = await harness({ rejectFields: ['zone_id', 'parent_id'] })
    t.after(() => h.close())
    const outcome = await h.api.ensureAgent({
      agentId: 'session-d', name: 'D', zoneId: 'office', parentId: 'session-root',
    })
    assert.equal(outcome, 'created')
    assert.equal(h.client.supportsZone, false)
    assert.equal(h.client.supportsParent, false)
    assert.equal(h.mock.agents.get('session-d').zone, 'home', '降级后由服务端自行分配 zone')
    await h.close()
  })

  it('stripUnsupported 只在能剥到字段时返回，否则停手', () => {
    const err = { fields: ['zone_id'] }
    assert.deepEqual(stripUnsupported({ agent_id: 'a', zone_id: 'office', name: 'n' }, err).dropped, ['zone_id'])
    assert.equal(stripUnsupported({ agent_id: 'a', name: 'n' }, err), null)
    assert.equal(stripUnsupported({ agent_id: 'a', zone_id: 'office' }, err, ['zone_id']), null)
  })

  it('retire_agent 未部署 → 降级为 offline 上报（记录仍在，且不抛）', async (t) => {
    const h = await harness({ omitTools: ['retire_agent'] })
    t.after(() => h.close())
    await h.api.ensureAgent({ agentId: 'session-e', name: 'E' })
    const ok = await h.api.retireAgent('session-e', { reason: 'test', cascade: true })
    assert.equal(ok, true)
    const agent = h.agent()
    assert.equal(agent.activity, 'offline')
    assert.equal(isRetired(agent), false, '降级路径不产生 retiredAt（服务端还不支持退休）')
    assert.match(agent.tasks[0].title, /retire_agent 未部署/)
    await h.close()
  })

  it('retire_agent 已部署 → 真正软退休（记录保留、可查）', async (t) => {
    const h = await harness()
    t.after(() => h.close())
    await h.api.ensureAgent({ agentId: 'session-f', name: 'F' })
    assert.equal(await h.api.retireAgent('session-f', { reason: 'DSH session disposed', cascade: true }), true)
    assert.equal(isRetired(h.agent()), true)
    const state = await h.api.getState({ includeRetired: false })
    assert.equal(state.agents.some((a) => a.id === 'session-f'), false, '默认状态不含已退休')
    assert.equal(state.retiredCount, 1)
    await h.close()
  })

  it('get_agent_state 读不到记录 → readAgent 返回 null（不抛）', async (t) => {
    const h = await harness()
    t.after(() => h.close())
    assert.equal(await h.api.readAgent('nobody'), null)
    await h.close()
  })

  it('get_office_state 不接受 include_retired → 退回无参调用', async (t) => {
    const h = await harness({ rejectFields: ['include_retired'] })
    t.after(() => h.close())
    const state = await h.api.getState({ includeRetired: true })
    assert.ok(Array.isArray(state.agents))
    assert.ok(h.api.warned.has('state-noinclude'))
    await h.close()
  })

  it('revisionOf / agentOf 兼容两种包法', () => {
    assert.equal(revisionOf({ revision: 3 }), 3)
    assert.equal(revisionOf({ agent: { revision: 4 } }), 4)
    assert.equal(revisionOf({}), undefined)
    assert.deepEqual(agentOf({ agent: { id: 'x' } }), { id: 'x' })
    assert.deepEqual(agentOf({ id: 'y' }), { id: 'y' })
    assert.equal(agentOf({ payload: 1 }), null)
  })
})
