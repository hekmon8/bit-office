/**
 * 自证测试 ③④：session → 记录字段映射（含名称回退）与 subagent → parentId 映射。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AGENT_ID_RE,
  baseName,
  parentIdOf,
  sessionName,
  sessionRecord,
  shortId,
  subagentFallbackName,
  subagentRecord,
  subagentTask,
  summarizeMessage,
  taskStatusOf,
  toAgentId,
  zoneIdOf,
} from '../lib/mapping.mjs'

describe('session → agent 记录字段映射', () => {
  it('agent_id 就是会话 id（形如 session-<uuid>，满足服务端 ^[a-zA-Z0-9_-]{1,64}$）', () => {
    const sid = 'session-a11b0e17-3747-445b-9203-d0512539f8eb'
    const rec = sessionRecord({ sessionId: sid, title: '写 dsh-bit-office 插件' , cwd: '/x/y' })
    assert.equal(rec.agentId, sid)
    assert.ok(AGENT_ID_RE.test(rec.agentId))
    assert.ok(rec.agentId.length <= 64)
    assert.equal(rec.zoneId, 'office')
    assert.equal(rec.activity, 'working')
  })

  it('名称优先用会话标题', () => {
    const rec = sessionRecord({ sessionId: 'session-1', title: '  修 Jenkins 看板  ', cwd: '/a/b' })
    assert.equal(rec.name, '修 Jenkins 看板')
  })

  it('名称回退：无标题时用「工作区目录名 · 会话 id 后 6 位」', () => {
    const sid = 'session-a11b0e17-3747-445b-9203-d0512539f8eb'
    const rec = sessionRecord({ sessionId: sid, title: '', cwd: '/home/dev/code/ALL_CODE' })
    assert.equal(rec.name, `ALL_CODE · ${sid.slice(-6)}`)
    assert.equal(sessionName({ sessionId: sid, cwd: 'C:\\work\\proj\\' }), `proj · ${sid.slice(-6)}`)
  })

  it('名称回退的次级兜底：既无标题也无目录', () => {
    assert.equal(sessionName({ sessionId: 'session-abcdef123456' }), '会话 · 123456')
    assert.equal(sessionName({}), '未命名会话')
    assert.equal(sessionName({ cwd: '/only/dir' }), 'dir')
  })

  it('非法/超长 id 会被归一成合法 agent_id', () => {
    assert.equal(toAgentId('abc/def ghi'), 'abc-def-ghi')
    assert.equal(toAgentId('  '), '')
    assert.equal(toAgentId('x'.repeat(80)).length, 64)
    assert.equal(sessionRecord({ sessionId: '' }), null)
  })

  it('baseName / shortId 工具函数', () => {
    assert.equal(baseName('/a/b/c/'), 'c')
    assert.equal(baseName('C:\\a\\b'), 'b')
    assert.equal(baseName(''), '')
    assert.equal(shortId('session-123456'), '123456')
    assert.equal(shortId('ab'), 'ab')
  })

  it('父 id / zone 取值兼容新旧字段名', () => {
    assert.equal(parentIdOf({ parentId: 'p1' }), 'p1')
    assert.equal(parentIdOf({ parent_id: 'p2' }), 'p2')
    assert.equal(parentIdOf({}), '')
    assert.equal(zoneIdOf({ zone: 'home' }), 'home')
    assert.equal(zoneIdOf({}, 'office'), 'office')
  })
})

describe('subagent → agent 记录字段映射', () => {
  it('agent_id = 子会话 id，parent_id = 父会话 agent_id，activity=discussing', () => {
    const rec = subagentRecord({
      childId: 'session-child-1111',
      parentSessionId: 'session-parent-2222',
      provider: 'subagent',
      zoneId: 'office',
    })
    assert.equal(rec.agentId, 'session-child-1111')
    assert.equal(rec.parentId, 'session-parent-2222')
    assert.equal(rec.activity, 'discussing')
    assert.equal(rec.zoneId, 'office')
  })

  it('父会话解析不到 → parentId 为空串（上层只建不带 parent 的记录并记日志）', () => {
    const rec = subagentRecord({ childId: 'session-child-1', parentSessionId: '', provider: 'subagent-fork-in-process' })
    assert.equal(rec.parentId, '')
    assert.ok(rec.name.includes('subagent-fork-in-process'))
  })

  it('子会话无标题 → 名称带 provider 与短 id（便于在平面图上认出来）', () => {
    const name = subagentFallbackName({ provider: 'subagent', childId: 'session-abcdef' })
    assert.equal(name, '子 agent subagent · abcdef')
  })

  it('subagent/end → 终态 task：标题含 provider 与 stopReason，状态由 stopReason 定', () => {
    const ok = subagentTask({ provider: 'subagent', runId: 'run-1', stopReason: 'completed' })
    assert.equal(ok.status, 'completed')
    assert.equal(ok.id, 'task-run-1')
    assert.match(ok.title, /^subagent · completed/)
    const failed = subagentTask({ provider: 'subagent-fork-in-process', runId: 'run-2', stopReason: 'error' })
    assert.equal(failed.status, 'failed')
    assert.equal(taskStatusOf('error'), 'failed')
    assert.equal(taskStatusOf('end_turn'), 'completed')
    assert.equal(taskStatusOf(undefined), 'failed')
  })

  it('终态 task 标题会带上最后一次助手输出的短摘要（并截断）', () => {
    const task = subagentTask({
      provider: 'subagent',
      runId: 'r',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'x'.repeat(300) }],
    })
    assert.ok(task.title.length <= 240)
    assert.ok(task.title.includes('…'))
    assert.equal(summarizeMessage([{ text: '  a\n b ' }]), 'a b')
    assert.equal(summarizeMessage(undefined), '')
  })
})
