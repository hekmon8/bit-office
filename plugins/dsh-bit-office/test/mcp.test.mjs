/**
 * 自证测试 ①：请求构造与 SSE/JSON 解析（含两种 transport、错误归一化）
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  AgentExistsError,
  InvalidParamsError,
  McpClient,
  McpError,
  RevisionConflictError,
  ToolUnavailableError,
  parseMcpBody,
  parseSseMessages,
  pickResponse,
  resultText,
  tryJson,
} from '../lib/mcp.mjs'
import { startMockOffice } from './mock-mcp.mjs'

describe('SSE / JSON 解析（纯函数）', () => {
  it('解析标准 SSE：event: message + data，忽略注释心跳', () => {
    const body = ': ping\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n'
    const messages = parseSseMessages(body)
    assert.equal(messages.length, 1)
    assert.deepEqual(messages[0].result, { ok: true })
  })

  it('多行 data 按 SSE 规范拼成一个 JSON', () => {
    const body = 'event: message\ndata: {"a":1,\ndata: "b":2}\n\n'
    const messages = parseSseMessages(body)
    assert.deepEqual(messages[0], { a: 1, b: 2 })
  })

  it('兼容 CRLF 与无 event 行的裸 data', () => {
    const body = 'data: {"id":7}\r\n\r\n'
    assert.deepEqual(parseSseMessages(body), [{ id: 7 }])
  })

  it('丢弃非 JSON 事件（服务端自定义心跳）而不抛', () => {
    const body = 'event: ping\ndata: not-json\n\nevent: message\ndata: {"ok":1}\n\n'
    assert.deepEqual(parseSseMessages(body), [{ ok: 1 }])
  })

  it('parseMcpBody：纯 JSON 与 SSE 都认，content-type 标错也能解析', () => {
    assert.deepEqual(parseMcpBody('{"jsonrpc":"2.0","id":1,"result":{}}'), [{ jsonrpc: '2.0', id: 1, result: {} }])
    assert.deepEqual(parseMcpBody('event: message\ndata: {"id":1}\n\n'), [{ id: 1 }])
    assert.deepEqual(parseMcpBody('data: {"id":2}\n\n', 'application/json'), [{ id: 2 }])
    assert.deepEqual(parseMcpBody(''), [])
  })

  it('pickResponse 按 id 匹配，退化时取第一条 result/error', () => {
    const msgs = [{ id: 1, result: { a: 1 } }, { id: 2, result: { b: 2 } }]
    assert.deepEqual(pickResponse(msgs, 2).result, { b: 2 })
    assert.deepEqual(pickResponse([{ method: 'x' }, { id: 9, result: { c: 3 } }], 4).result, { c: 3 })
    assert.equal(pickResponse([], 1), null)
  })

  it('resultText / tryJson 处理 content blocks', () => {
    assert.equal(resultText({ content: [{ type: 'text', text: '{"a":1}' }] }), '{"a":1}')
    assert.deepEqual(tryJson('{"a":1}'), { a: 1 })
    assert.equal(tryJson('nope'), undefined)
  })
})

for (const transport of ['sse', 'json']) {
  describe(`McpClient 端到端（transport=${transport}）`, () => {
    let mock
    let client
    before(async () => {
      mock = await startMockOffice({ transport })
      client = new McpClient({ url: mock.url, token: 'test-token', timeoutMs: 5000 })
    })
    after(async () => {
      await mock.close()
    })

    it('请求构造：Bearer 认证 + 同时接受 JSON 与 SSE', async () => {
      await client.initialize()
      const first = mock.ctl.requests[0]
      assert.equal(first.headers.authorization, 'Bearer test-token')
      assert.equal(first.headers.accept, 'application/json, text/event-stream')
      assert.equal(first.headers['content-type'], 'application/json')
      assert.equal(first.message.method, 'initialize')
      assert.equal(first.message.jsonrpc, '2.0')
      assert.deepEqual(first.message.params.clientInfo, { name: 'dsh-bit-office', version: '0.1.0' })
    })

    it('initialize 记下 Mcp-Session-Id，并紧接着发 notifications/initialized', async () => {
      const second = mock.ctl.requests[1]
      assert.deepEqual(second.message, { jsonrpc: '2.0', method: 'notifications/initialized' })
      assert.equal(second.message.id, undefined)
      assert.equal(client.sessionId, 'mock-session-1')
      assert.equal(second.headers['mcp-session-id'], 'mock-session-1')
    })

    it('tools/list + tools/call 返回结构化 payload', async () => {
      const tools = await client.refreshTools()
      assert.ok(tools.has('create_agent'))
      const state = await client.callTool('get_office_state', { include_retired: true })
      assert.ok(Array.isArray(state.agents))
      assert.ok(state.zones.some((z) => z.id === 'office'))
    })

    it('工具不存在 → ToolUnavailableError，且被记住不再重试', async () => {
      const m = await startMockOffice({ transport, omitTools: ['retire_agent'] })
      const c = new McpClient({ url: m.url, token: 't' })
      await c.initialize()
      await c.refreshTools()
      assert.equal(c.hasTool('retire_agent'), false)
      await assert.rejects(() => c.callTool('retire_agent', { agent_id: 'a', expected_revision: 1 }), ToolUnavailableError)
      await assert.rejects(() => c.callTool('retire_agent', {}), ToolUnavailableError)
      await m.close()
    })

    it('未部署的新字段 → InvalidParamsError（带被拒字段名）', async () => {
      const m = await startMockOffice({ transport, rejectFields: ['zone_id'] })
      const c = new McpClient({ url: m.url, token: 't' })
      await c.initialize()
      const err = await c.callTool('create_agent', { agent_id: 'x', name: 'x', zone_id: 'office' }).catch((e) => e)
      assert.ok(err instanceof InvalidParamsError)
      assert.deepEqual(err.fields, ['zone_id'])
      await m.close()
    })

    it('revision_conflict / agent_exists 归一成专用错误', async () => {
      const m = await startMockOffice({ transport, conflictTimes: 1 })
      const c = new McpClient({ url: m.url, token: 't' })
      await c.initialize()
      await c.callTool('create_agent', { agent_id: 'a1', name: 'a1' })
      const conflict = await c.callTool('update_agent_status', { agent_id: 'a1', expected_revision: 1, activity: 'meeting' }).catch((e) => e)
      assert.ok(conflict instanceof RevisionConflictError)
      const exists = await c.callTool('create_agent', { agent_id: 'a1', name: 'a1' }).catch((e) => e)
      assert.ok(exists instanceof AgentExistsError)
      await m.close()
    })

    it('HTTP 500 → McpError(kind=http)，不静默成功', async () => {
      const m = await startMockOffice({ transport, httpFailTimes: 1 })
      const c = new McpClient({ url: m.url, token: 't' })
      const err = await c.initialize().catch((e) => e)
      assert.ok(err instanceof McpError)
      assert.equal(err.kind, 'http')
      assert.equal(err.code, '500')
      await m.close()
    })

    it('连接不可达 → McpTransportError（kind=transport）', async () => {
      const c = new McpClient({ url: 'http://127.0.0.1:1/mcp', token: 't', timeoutMs: 1000 })
      const err = await c.initialize().catch((e) => e)
      assert.ok(err instanceof McpError)
      assert.equal(err.kind, 'transport')
    })
  })
}
