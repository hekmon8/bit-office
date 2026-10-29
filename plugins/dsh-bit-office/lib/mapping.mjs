/**
 * dsh-bit-office — 会话/subagent → 办公室记录字段的映射（纯函数）
 *
 * 与业务事件解耦，便于单测直接喂数据。不发起网络请求、不读全局状态。
 */

/** 服务端 agent_id 约束：^[a-zA-Z0-9_-]{1,64}$ */
export const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * 把任意 id 归一成服务端能接受的 agent_id。
 * 非法字符替换为 '-'，超长截断到 64（保持可读的前缀）。
 */
export function toAgentId(raw) {
  const s = String(raw ?? '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!s) return ''
  return s.length <= 64 ? s : s.slice(0, 64)
}

/** 目录名（不 import node:path，兼容 windows 分隔符，便于在浏览器/测试复用）。 */
export function baseName(p) {
  const s = String(p ?? '').trim().replace(/[\\/]+$/, '')
  if (!s) return ''
  const parts = s.split(/[\\/]+/)
  return parts[parts.length - 1] || ''
}

/** 会话 id 的后 6 位（短标识，用于名称回退与展示）。 */
export function shortId(id) {
  const s = String(id ?? '')
  return s.length <= 6 ? s : s.slice(-6)
}

/**
 * 会话的展示名。
 * 优先会话标题；取不到时回退「工作区目录名 · 会话 id 后 6 位」。
 */
export function sessionName({ title, sessionId, cwd } = {}) {
  const t = String(title ?? '').trim()
  if (t) return t.slice(0, 160)
  const dir = baseName(cwd)
  const short = shortId(sessionId)
  if (dir && short) return `${dir} · ${short}`
  if (dir) return dir
  if (short) return `会话 · ${short}`
  return '未命名会话'
}

/**
 * 由会话信息得到 create_agent 所需字段。
 * @returns {{agentId: string, name: string, zoneId: string, activity: string}|null}
 */
export function sessionRecord({ sessionId, title, cwd, zoneId = 'office' } = {}) {
  const agentId = toAgentId(sessionId)
  if (!agentId) return null
  return {
    agentId,
    name: sessionName({ title, sessionId, cwd }),
    zoneId,
    // 会话一登记就是「在岗工作中」
    activity: 'working',
  }
}

/**
 * 由 subagent 运行信息得到记录字段。
 * 子会话自己也可能有标题；没有就用「子会话 <provider> · 短id」。
 * @returns {{agentId: string, parentId: string, name: string, zoneId: string, activity: string}}
 */
export function subagentRecord({ childId, parentSessionId, provider, title, zoneId = 'office' } = {}) {
  const agentId = toAgentId(childId)
  if (!agentId) return null
  const parentId = toAgentId(parentSessionId)
  const named = String(title ?? '').trim()
  return {
    agentId,
    // 取不到父会话时只建不带 parent 的记录（由上层记日志）
    parentId: parentId || '',
    // 子会话有自己的标题就用标题；没有就用「子 agent <provider> · 短id」
    name: named ? named.slice(0, 160) : subagentFallbackName({ provider, childId }),
    zoneId,
    activity: 'discussing',
  }
}

/** 子会话没有标题时的兜底名（带 provider，便于看板识别）。 */
export function subagentFallbackName({ provider, childId } = {}) {
  const label = String(provider ?? '').trim() || 'subagent'
  return `子 agent ${label} · ${shortId(childId)}`
}

/** 从最后一次助手输出里抽一条短摘要（用于终态任务标题的补充信息）。 */
export function summarizeMessage(message) {
  try {
    const blocks = Array.isArray(message) ? message : []
    const text = blocks
      .map((b) => (b && typeof b.text === 'string' ? b.text : (typeof b === 'string' ? b : '')))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) return ''
    return text.length > 120 ? `${text.slice(0, 117)}…` : text
  } catch {
    return ''
  }
}

/**
 * subagent 结束 → 一条终态 task。
 * 标题含 provider / stopReason，便于在办公室卡片上看出「谁因为什么结束」。
 */
export function subagentTask({ provider, runId, stopReason, lastAssistantMessage } = {}) {
  const label = String(provider ?? '').trim() || 'subagent'
  const reason = String(stopReason ?? '').trim() || 'unknown'
  const ok = reason === 'completed' || reason === 'end_turn' || reason === 'stop' || reason === 'success'
  const summary = summarizeMessage(lastAssistantMessage)
  return {
    id: toAgentId(`task-${runId ?? ''}`) || `task-${Date.now()}`,
    title: `${label} · ${reason}${summary ? ` · ${summary}` : ''}`.slice(0, 240),
    status: ok ? 'completed' : 'failed',
  }
}

/** stopReason → task status（completed|failed）。 */
export function taskStatusOf(stopReason) {
  const reason = String(stopReason ?? '').trim()
  return reason === 'completed' || reason === 'end_turn' || reason === 'stop' || reason === 'success'
    ? 'completed'
    : 'failed'
}

/** 从 agent 记录里取父 id（新旧字段都认）。 */
export function parentIdOf(agent) {
  if (!agent || typeof agent !== 'object') return ''
  return String(agent.parentId ?? agent.parent_id ?? '') || ''
}

/** 从 agent 记录里取 zone（旧部署可能没有）。 */
export function zoneIdOf(agent, fallback = 'office') {
  if (!agent || typeof agent !== 'object') return fallback
  return String(agent.zone ?? agent.zone_id ?? agent.zoneId ?? '') || fallback
}

/** bit-office 的 activity 取值集合。 */
export const ACTIVITIES = ['working', 'meeting', 'discussing', 'resting', 'fishing', 'offline']

/** activity → task status（用于 bit_office_report 校验）。 */
export const TASK_STATUSES = ['queued', 'dispatched', 'waiting_local_directory', 'running', 'completed', 'failed', 'cancelled']
