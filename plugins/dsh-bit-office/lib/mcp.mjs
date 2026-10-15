/**
 * dsh-bit-office — bit-office MCP 客户端（Streamable HTTP）
 *
 * 只依赖 Node 标准库的 fetch（Node >= 20 内置）与手写的 SSE/JSON 解析。
 * 协议（实测契约）：
 *   1) POST initialize            → 记下响应头 Mcp-Session-Id（若有）
 *   2) POST notifications/initialized （无 id 的通知）
 *   3) POST tools/call            → 解析结果
 * 每个请求都带 `Accept: application/json, text/event-stream` 与
 * `Authorization: Bearer <token>`；响应可能是 SSE（`event: message` + `data: {...}`）
 * 或纯 JSON。
 *
 * 设计约束：**任何失败都以异常或 {ok:false} 形式返回，绝不 console.error 到
 * 宿主会话**；上层（sync.mjs）统一捕获写日志。
 */

/** 基础 MCP 协议错误。 */
export class McpError extends Error {
  constructor(message, { code = '', kind = 'mcp', detail = '' } = {}) {
    super(message)
    this.name = 'McpError'
    this.code = code
    this.kind = kind
    this.detail = detail
  }
}

/** 工具在服务端不存在（旧部署尚未上线该工具）。 */
export class ToolUnavailableError extends McpError {
  constructor(tool, detail = '') {
    super(`tool unavailable: ${tool}`, { kind: 'tool-unavailable', detail })
    this.name = 'ToolUnavailableError'
    this.tool = tool
  }
}

/** 参数被服务端拒绝（通常是新增字段尚未部署）。fields 是可识别的字段名。 */
export class InvalidParamsError extends McpError {
  constructor(tool, detail = '', fields = []) {
    super(`invalid params for ${tool}: ${detail}`, { kind: 'invalid-params', detail })
    this.name = 'InvalidParamsError'
    this.tool = tool
    this.fields = fields
  }
}

/** 乐观锁冲突：需重读 revision 后重试。 */
export class RevisionConflictError extends McpError {
  constructor(detail = '') {
    super('revision_conflict', { kind: 'revision-conflict', code: 'revision_conflict', detail })
    this.name = 'RevisionConflictError'
  }
}

/** 记录已存在：直接改走 update 路径。 */
export class AgentExistsError extends McpError {
  constructor(detail = '') {
    super('agent_exists', { kind: 'agent-exists', code: 'agent_exists', detail })
    this.name = 'AgentExistsError'
  }
}

/** 网络/HTTP 层失败。 */
export class McpTransportError extends McpError {
  constructor(detail = '') {
    super('mcp transport failed', { kind: 'transport', detail })
    this.name = 'McpTransportError'
  }
}

/* ------------------------------------------------------------- 响应解析 */

/**
 * SSE 解析：返回按事件顺序排列的 JSON-RPC 消息数组。
 * 兼容 CRLF、多行 `data:`、`event:`/`id:`/`retry:`/注释行与心跳。
 * @param {string} text
 * @returns {Array<Record<string, unknown>>}
 */
export function parseSseMessages(text) {
  const out = []
  let dataLines = []
  let eventName = ''
  const flush = () => {
    if (!dataLines.length) {
      eventName = ''
      return
    }
    const payload = dataLines.join('\n')
    dataLines = []
    const name = eventName
    eventName = ''
    // 只处理承载 JSON-RPC 的事件；ping / 心跳直接忽略。
    if (name && name !== 'message' && name !== 'endpoint') return
    try {
      out.push(JSON.parse(payload))
    } catch {
      /* 非 JSON 事件（服务端自定义心跳）→ 丢弃 */
    }
  }
  for (const rawLine of String(text).split(/\r?\n/)) {
    if (rawLine === '') {
      flush()
      continue
    }
    if (rawLine.startsWith(':')) continue
    const idx = rawLine.indexOf(':')
    const field = idx === -1 ? rawLine : rawLine.slice(0, idx)
    let value = idx === -1 ? '' : rawLine.slice(idx + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') dataLines.push(value)
    else if (field === 'event') eventName = value
    // id/retry 与 JSON-RPC id 无关，忽略
  }
  flush()
  return out
}

/**
 * 解析一次响应体（SSE 或纯 JSON 都可），返回 JSON-RPC 消息数组。
 * @param {string} text 响应体
 * @param {string} [contentType]
 */
export function parseMcpBody(text, contentType = '') {
  const body = String(text ?? '')
  if (!body.trim()) return []
  const ct = String(contentType || '').toLowerCase()
  const looksSse = ct.includes('text/event-stream')
    || /^\s*(event|data):/m.test(body)
  if (looksSse) {
    const msgs = parseSseMessages(body)
    if (msgs.length) return msgs
  }
  try {
    const one = JSON.parse(body)
    return Array.isArray(one) ? one : [one]
  } catch {
    // JSON 失败时再兜一次 SSE（有些网关 content-type 标错）
    return parseSseMessages(body)
  }
}

/** 从消息数组里挑出与请求 id 匹配的那条（否则第一条带 result/error 的）。 */
export function pickResponse(messages, id) {
  if (!Array.isArray(messages) || !messages.length) return null
  const byId = messages.find((m) => m && (m.id === id || String(m.id) === String(id)))
  if (byId) return byId
  return messages.find((m) => m && (m.result !== undefined || m.error !== undefined)) || null
}

/* --------------------------------------------------------- 错误归一化 */

// 只有「工具本身不存在」的措辞才算 ToolUnavailable。
// 注意：不能把裸 'not found' 当线索——业务错误 `agent_not_found`（记录不存在）
// 会把工具误判成缺失，从此不再尝试调用（曾被本仓库自证测试抓到的真 bug）。
const UNKNOWN_TOOL_HINTS = [
  'unknown tool', 'no such tool', 'tool not found', 'tool_not_found',
  'method not found', 'unsupported tool', 'not implemented',
]

/** 判断一段报错文本是否在说「这个工具不存在」。 */
export function looksLikeUnknownTool(detail, toolName = '') {
  const s = String(detail || '').toLowerCase()
  if (UNKNOWN_TOOL_HINTS.some((h) => s.includes(h))) return true
  // `xxx not found` / `not found: xxx`（xxx 是本次调用的工具名）
  const t = String(toolName || '').toLowerCase()
  if (t && s.includes(t) && /not found|not_found|unknown/.test(s)) return true
  return false
}

/** 服务端把业务错误码放在参数里（data.code / content 文本里的 {error:...}）。 */
function errorCodeFrom(error, resultText) {
  const candidates = []
  const d = error && typeof error === 'object' ? error.data : undefined
  if (d && typeof d === 'object') {
    if (d.code !== undefined) candidates.push(d.code)
    if (d.error !== undefined) candidates.push(typeof d.error === 'string' ? d.error : d.error?.code)
  }
  if (error && typeof error.message === 'string') candidates.push(error.message)
  if (resultText) {
    const m = String(resultText).match(/"?(?:error|code)"?\s*[:=]\s*"?([a-z_]+)"?/i)
    if (m) candidates.push(m[1])
  }
  for (const c of candidates) {
    const s = String(c || '').trim()
    if (!s) continue
    if (/revision_conflict|revision-conflict/i.test(s)) return 'revision_conflict'
    if (/agent_exists|agent-exists|already exists/i.test(s)) return 'agent_exists'
    if (/room_full|invalid_room|agent_limit|depth_limit|parent_not_found|agent_not_found|unauthorized|invalid_token/i.test(s)) {
      const mm = s.match(/room_full|invalid_room|agent_limit|depth_limit|parent_not_found|agent_not_found|unauthorized|invalid_token/i)
      return mm[0].toLowerCase()
    }
  }
  return ''
}

/** 从工具结果里抽出文本（content blocks）。 */
export function resultText(result) {
  try {
    const blocks = result && Array.isArray(result.content) ? result.content : []
    return blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n').trim()
  } catch {
    return ''
  }
}

/** 尝试把文本解析成对象（服务端常把业务 payload 当 JSON 文本塞进 content）。 */
export function tryJson(text) {
  try {
    return JSON.parse(String(text))
  } catch {
    return undefined
  }
}

/** 从报错文本里猜出被拒的字段名（用于降级重试）。 */
export function invalidFields(detail, known = []) {
  const s = String(detail || '')
  const found = new Set()
  for (const f of known) if (f && s.includes(f)) found.add(f)
  // 形如 `unknown field "zone_id"` / `extra inputs are not permitted: parent_id`
  for (const m of s.matchAll(/["'`]([a-z_]{2,32})["'`]/g)) {
    if (known.includes(m[1])) found.add(m[1])
  }
  return [...found]
}

/* ------------------------------------------------------------ 客户端 */

/**
 * 一个 bit-office MCP 会话（initialize 一次，之后复用到同一条 Mcp-Session-Id）。
 * 不做自动重连：失败就抛，由上层决定是否重建。
 */
export class McpClient {
  /**
   * @param {object} opts
   * @param {string} opts.url MCP 端点
   * @param {string} opts.token Bearer token
   * @param {number} [opts.timeoutMs]
   * @param {(msg: string) => void} [opts.log] 日志（默认丢弃；上层传入自己的 logger）
   * @param {typeof fetch} [opts.fetchImpl] 便于单测注入
   */
  constructor({ url, token, timeoutMs = 15000, log, fetchImpl } = {}) {
    this.url = url
    this.token = token
    this.timeoutMs = timeoutMs
    this.log = typeof log === 'function' ? log : () => {}
    this.fetchImpl = fetchImpl || globalThis.fetch
    this.sessionId = ''
    this.nextId = 1
    this.initialized = false
    this.serverInfo = null
    this.protocolVersion = '2025-06-18'
    /** tools/list 拿到的工具名集合；为空集合表示「未知，按需尝试」。 */
    this.knownTools = null
    /** 已知在服务端缺失的工具，避免反复重试。 */
    this.missingTools = new Set()
    /** 一次性标记：确认服务端不认识 zone_id / parent_id 这类新字段。 */
    this.supportsZone = true
    this.supportsParent = true
  }

  headers(extra = {}) {
    const h = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...extra,
    }
    if (this.token) h.authorization = `Bearer ${this.token}`
    if (this.sessionId) h['mcp-session-id'] = this.sessionId
    return h
  }

  /** 发一条 JSON-RPC 消息；body 为 undefined 时按通知发（无 id、无响应等待）。 */
  async rpc(method, params, { notification = false } = {}) {
    const id = notification ? undefined : this.nextId++
    const payload = notification
      ? { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }
      : { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null
    let res
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        ...(controller ? { signal: controller.signal } : {}),
      })
    } catch (err) {
      throw new McpTransportError(err instanceof Error ? err.message : String(err))
    } finally {
      if (timer) clearTimeout(timer)
    }
    // 记下会话 id（服务端在 initialize 响应头下发）
    try {
      const sid = res.headers && typeof res.headers.get === 'function' ? res.headers.get('mcp-session-id') : ''
      if (sid) this.sessionId = sid
    } catch { /* 忽略头读取异常 */ }
    let text = ''
    try {
      text = await res.text()
    } catch (err) {
      throw new McpTransportError(`read body failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (notification) return null
    if (!res.ok) {
      throw new McpError(`http ${res.status}`, { kind: 'http', code: String(res.status), detail: text.slice(0, 400) })
    }
    const messages = parseMcpBody(text, res.headers && res.headers.get ? res.headers.get('content-type') : '')
    const msg = pickResponse(messages, id)
    if (!msg) throw new McpError('empty mcp response', { kind: 'protocol', detail: text.slice(0, 400) })
    if (msg.error) {
      const detail = typeof msg.error === 'object' ? (msg.error.message || JSON.stringify(msg.error)) : String(msg.error)
      const code = msg.error && typeof msg.error === 'object' ? msg.error.code : undefined
      throw new McpError(`mcp error ${code ?? ''}: ${detail}`, { kind: 'rpc', code: String(code ?? ''), detail })
    }
    return msg.result
  }

  /** initialize + notifications/initialized（幂等）。 */
  async initialize() {
    if (this.initialized) return this.serverInfo
    const result = await this.rpc('initialize', {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: 'dsh-bit-office', version: '0.1.0' },
    })
    this.serverInfo = result && typeof result === 'object' ? result : {}
    if (this.serverInfo.protocolVersion) this.protocolVersion = String(this.serverInfo.protocolVersion)
    this.initialized = true
    try {
      await this.rpc('notifications/initialized', undefined, { notification: true })
    } catch (err) {
      // 通知失败不影响后续 tools/call（有些实现不要求）
      this.log(`notifications/initialized failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return this.serverInfo
  }

  /** 刷新工具清单（失败不抛，保持 knownTools 为 null = 未知）。 */
  async refreshTools() {
    try {
      const result = await this.rpc('tools/list', {})
      const list = result && Array.isArray(result.tools) ? result.tools : []
      this.knownTools = new Set(list.map((t) => String(t && t.name)).filter(Boolean))
      for (const name of [...this.missingTools]) if (this.knownTools.has(name)) this.missingTools.delete(name)
      return this.knownTools
    } catch (err) {
      this.log(`tools/list failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  hasTool(name) {
    if (this.missingTools.has(name)) return false
    if (this.knownTools) return this.knownTools.has(name)
    return true // 未知 → 乐观尝试，失败时再降级
  }

  /**
   * 调一个工具，返回解析后的 payload。
   * 约定：服务端把结构化结果放在 content[0].text 的 JSON 里；纯文本则原样返回字符串。
   * @returns {Promise<any>}
   */
  async callTool(name, args = {}) {
    if (!this.hasTool(name)) throw new ToolUnavailableError(name, 'known missing')
    let result
    try {
      result = await this.rpc('tools/call', { name, arguments: args })
    } catch (err) {
      const e = err instanceof McpError ? err : new McpError(String(err))
      const detail = `${e.message} ${e.detail || ''}`
      const code = errorCodeFrom(err, '')
      if (code === 'revision_conflict') throw new RevisionConflictError(detail)
      if (code === 'agent_exists') throw new AgentExistsError(detail)
      const lower = detail.toLowerCase()
      // -32601 method not found / unknown tool → 工具不存在
      if (e.code === '-32601' || looksLikeUnknownTool(detail, name)) {
        this.missingTools.add(name)
        throw new ToolUnavailableError(name, detail)
      }
      // -32602 invalid params → 可能是新字段被拒（部署落后）
      if (e.code === '-32602' || /invalid (params|arguments)|unexpected|unknown field|extra inputs|validation/i.test(lower)) {
        throw new InvalidParamsError(name, detail, invalidFields(detail, Object.keys(args)))
      }
      throw e.code ? new McpError(`${e.message}`, { kind: e.kind, code: e.code, detail: e.detail }) : e
    }
    const text = resultText(result)
    const parsed = tryJson(text)
    const payload = parsed !== undefined ? parsed : (text || null)
    const code = errorCodeFrom(null, text)
    if (code === 'revision_conflict') throw new RevisionConflictError(text)
    if (code === 'agent_exists') throw new AgentExistsError(text)
    if (result && result.isError) {
      const detail = text || 'tool returned isError'
      const lower = detail.toLowerCase()
      if (looksLikeUnknownTool(detail, name)) {
        this.missingTools.add(name)
        throw new ToolUnavailableError(name, detail)
      }
      if (code) throw new McpError(`error ${code}`, { kind: 'business', code, detail })
      if (/invalid (params|arguments)|unexpected|unknown field|extra inputs|validation/i.test(lower)) {
        throw new InvalidParamsError(name, detail, invalidFields(detail, Object.keys(args)))
      }
      throw new McpError(detail, { kind: 'business', detail })
    }
    return payload
  }
}
