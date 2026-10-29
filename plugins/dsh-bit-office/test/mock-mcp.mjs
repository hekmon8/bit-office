/**
 * dsh-bit-office — 本地 mock MCP 服务（自证测试用，不进产物）
 *
 * 用 node:http 实现 bit-office 的 Streamable HTTP 形状：
 *   - initialize（响应头带 Mcp-Session-Id）
 *   - notifications/initialized（202，无 body）
 *   - tools/list
 *   - tools/call（get_office_state / get_agent_state / list_rooms / get_task_handoff /
 *     get_connection_info / create_agent / update_agent / update_agent_status /
 *     retire_agent）
 * 并把「部署可能落后于插件」的所有坏情况做成可注入开关：
 *   - transport: 'sse' | 'json'（两种响应都要能解析）
 *   - omitTools: 让某些工具报「未知工具」
 *   - rejectFields: 让 zone_id/parent_id 被当成非法参数拒绝（旧契约）
 *   - conflictTimes: 同一 agent 的前 N 次写操作回 revision_conflict
 *   - agentExistsOnce: create_agent 第一次回 agent_exists（竞态）
 *   - httpFailTimes: 前 N 个请求直接 500（网络层失败）
 */
import http from 'node:http'

const DEFAULT_ZONES = [
  { id: 'home', name: '个人区', description: '个人与演示记录', originY: 30 },
  { id: 'office', name: '公司区', description: 'DSH 会话与子 agent 的工作区', originY: 900 },
]

const DEFAULT_ROOMS = [
  { id: 'office-desks', name: '公司工位', kind: 'working', capacity: 4, x: 30, y: 900, w: 560, h: 400, zone: 'office' },
  { id: 'office-discussion', name: '公司讨论室', kind: 'discussing', capacity: 2, x: 610, y: 900, w: 300, h: 400, zone: 'office' },
  { id: 'office-nest', name: '公司充电窝', kind: 'offline', capacity: 2, x: 930, y: 900, w: 290, h: 400, zone: 'office' },
]

const ALL_TOOLS = [
  'get_office_state', 'get_agent_state', 'list_rooms', 'get_task_handoff', 'get_connection_info',
  'create_agent', 'update_agent', 'update_agent_status', 'retire_agent',
]

/** JSON-RPC 成功结果（内容统一塞一段 JSON 文本，和真实服务端一致）。 */
function textResult(payload) {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] }
}

function errorResult(code, message, extra = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: code, message, ...extra }) }],
    isError: true,
  }
}

/**
 * 启动 mock 服务。
 * @param {object} [knobs]
 * @returns {Promise<{url:string, port:number, close:()=>Promise<void>, ctl:object}>}
 */
export async function startMockOffice(knobs = {}) {
  const ctl = {
    transport: 'sse',
    omitTools: [],
    rejectFields: [],
    conflictTimes: 0,
    agentExistsOnce: false,
    httpFailTimes: 0,
    requireSessionHeaderAfterInit: true,
    requests: [],
    calls: [],
    ...knobs,
  }
  /** agent_id → 记录 */
  const agents = new Map()
  let sessionSeq = 0
  let nextRevision = 1

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let message = null
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch { /* 非法 JSON → 下面按 400 处理 */ }
      ctl.requests.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        message,
      })
      const isNotification = Boolean(message) && message.id === undefined
      if (!message) {
        res.statusCode = 400
        res.end('bad json')
        return
      }
      if (ctl.httpFailTimes > 0) {
        ctl.httpFailTimes -= 1
        res.statusCode = 500
        res.end('mock failure')
        return
      }
      if (isNotification) {
        res.statusCode = 202
        res.end('')
        return
      }
      let result
      let rpcError = null
      try {
        ;({ result, rpcError } = dispatch(message, ctl, agents, () => {
          const rev = nextRevision
          nextRevision += 1
          return rev
        }))
      } catch (err) {
        rpcError = { code: -32603, message: err instanceof Error ? err.message : String(err) }
      }
      const body = rpcError
        ? { jsonrpc: '2.0', id: message.id, error: rpcError }
        : { jsonrpc: '2.0', id: message.id, result: result ?? {} }
      const headers = { 'content-type': 'application/json' }
      if (message.method === 'initialize') {
        sessionSeq += 1
        headers['mcp-session-id'] = `mock-session-${sessionSeq}`
      }
      if (ctl.transport === 'sse') {
        headers['content-type'] = 'text/event-stream'
        res.writeHead(200, headers)
        // 真实服务端形状：event: message + 一行 data；偶发一条注释心跳
        res.end(`: ping\n\nevent: message\ndata: ${JSON.stringify(body)}\n\n`)
      } else {
        res.writeHead(200, headers)
        res.end(JSON.stringify(body))
      }
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    ctl,
    agents,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** 一次 tools/call 的分发（模拟新契约语义 + 可注入故障）。 */
function dispatch(message, ctl, agents, nextRev) {
  if (message.method === 'initialize') {
    return { result: { protocolVersion: '2025-06-18', serverInfo: { name: 'mock-bit-office' }, capabilities: { tools: {} } } }
  }
  if (message.method === 'tools/list') {
    return { result: { tools: ALL_TOOLS.filter((t) => !ctl.omitTools.includes(t)).map((t) => ({ name: t })) } }
  }
  if (message.method !== 'tools/call') return { rpcError: { code: -32601, message: `method not found: ${message.method}` } }

  const name = message.params?.name
  const args = message.params?.arguments || {}
  ctl.calls.push({ name, args })
  if (ctl.omitTools.includes(name)) {
    return { rpcError: { code: -32601, message: `unknown tool: ${name}` } }
  }
  for (const field of ctl.rejectFields) {
    if (field in args) {
      return {
        rpcError: {
          code: -32602,
          message: `Invalid params: unexpected field "${field}" for tool ${name}`,
          data: { code: -32602, field },
        },
      }
    }
  }

  switch (name) {
    case 'get_connection_info':
      return { result: textResult({ ok: true, transport: 'mock' }) }
    case 'list_rooms':
      return { result: textResult({ rooms: DEFAULT_ROOMS, zones: DEFAULT_ZONES }) }
    case 'get_task_handoff':
      return { result: textResult({ taskId: args.task_id || '', handoff: null }) }
    case 'get_office_state': {
      const includeRetired = args.include_retired !== false
      const all = [...agents.values()]
      const visible = includeRetired ? all : all.filter((a) => !a.retiredAt)
      return {
        result: textResult({
          agents: visible,
          rooms: DEFAULT_ROOMS,
          zones: DEFAULT_ZONES,
          retiredCount: all.filter((a) => a.retiredAt).length,
        }),
      }
    }
    case 'get_agent_state': {
      const agent = agents.get(args.agent_id)
      if (!agent) return { result: errorResult('agent_not_found', `no agent ${args.agent_id}`) }
      return { result: textResult({ agent, revision: agent.revision }) }
    }
    case 'create_agent': {
      if (ctl.agentExistsOnce) {
        ctl.agentExistsOnce = false
        if (agents.has(args.agent_id)) return { result: errorResult('agent_exists', 'record exists') }
      }
      if (agents.has(args.agent_id)) return { result: errorResult('agent_exists', 'record exists') }
      const zone = args.zone_id || 'home'
      const room = DEFAULT_ROOMS.find((r) => r.zone === zone && r.kind === (args.activity || 'working'))?.id
        || DEFAULT_ROOMS.find((r) => r.zone === zone)?.id
        || DEFAULT_ROOMS[0].id
      const agent = {
        id: args.agent_id,
        name: args.name,
        color: args.color || '#8daff4',
        activity: args.activity || 'offline',
        roomId: room,
        zone,
        online: (args.activity || 'offline') !== 'offline',
        tasks: [],
        lastSeenAt: new Date().toISOString(),
        ...(args.parent_id ? { parentId: args.parent_id, depth: 1 } : {}),
        revision: nextRev(),
      }
      agents.set(agent.id, agent)
      return { result: textResult({ ok: true, agent }) }
    }
    case 'update_agent': {
      const agent = agents.get(args.agent_id)
      if (!agent) return { result: errorResult('agent_not_found', 'missing') }
      if (ctl.conflictTimes > 0) {
        ctl.conflictTimes -= 1
        return { result: errorResult('revision_conflict', `expected ${args.expected_revision}, current ${agent.revision}`) }
      }
      if (args.expected_revision !== agent.revision) {
        return { result: errorResult('revision_conflict', `expected ${args.expected_revision}, current ${agent.revision}`) }
      }
      if (args.name !== undefined) agent.name = args.name
      if (args.color !== undefined) agent.color = args.color
      agent.revision = nextRev()
      return { result: textResult({ ok: true, revision: agent.revision }) }
    }
    case 'update_agent_status': {
      const agent = agents.get(args.agent_id)
      if (!agent) return { result: errorResult('agent_not_found', 'missing') }
      if (ctl.conflictTimes > 0) {
        ctl.conflictTimes -= 1
        return { result: errorResult('revision_conflict', `expected ${args.expected_revision}, current ${agent.revision}`) }
      }
      if (args.expected_revision !== agent.revision) {
        return { result: errorResult('revision_conflict', `expected ${args.expected_revision}, current ${agent.revision}`) }
      }
      for (const key of ['activity', 'zone_id', 'parent_id', 'online', 'heartbeat', 'tasks', 'tasks_complete']) {
        if (args[key] === undefined) continue
        if (key === 'zone_id') { agent.zone = args[key]; continue }
        if (key === 'parent_id') { agent.parentId = args[key]; continue }
        if (key === 'tasks') { agent.tasks = args[key]; continue }
        if (key === 'tasks_complete') { continue }
        agent[key] = args[key]
      }
      if (agent.activity === 'offline') agent.online = false
      agent.lastSeenAt = new Date().toISOString()
      agent.revision = nextRev()
      return { result: textResult({ ok: true, revision: agent.revision }) }
    }
    case 'retire_agent': {
      const agent = agents.get(args.agent_id)
      if (!agent) return { result: errorResult('agent_not_found', 'missing') }
      if (args.expected_revision !== agent.revision) {
        return { result: errorResult('revision_conflict', 'revision mismatch') }
      }
      agent.retiredAt = new Date().toISOString()
      agent.retireReason = args.reason || ''
      agent.revision = nextRev()
      if (args.cascade) {
        for (const child of agents.values()) {
          if (child.parentId === agent.id && !child.retiredAt) child.retiredAt = new Date().toISOString()
        }
      }
      return { result: textResult({ ok: true }) }
    }
    default:
      return { rpcError: { code: -32601, message: `unknown tool: ${name}` } }
  }
}
