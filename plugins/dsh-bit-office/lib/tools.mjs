/**
 * dsh-bit-office — 模型工具定义
 *
 * 注意（环境事实，见 decisions/implemented/001）：`dsh plugin --profile web add`
 * 用 `link:` 把插件装成依赖，realpath 落在 profile 之外，因此**不能 import
 * `@deepseek-ai/dsh-tools`**（否则 `ERR_MODULE_NOT_FOUND` 让宿主启动失败）。
 * 这里自实现一个 `defineTool` 等价物：产出 `ctx.tools.register` 直接接受的
 * 纯 JSON-Schema 定义（字段名与官方一致），只依赖本仓库代码。
 *
 * exec 是工具执行信封（携带 agent/session 上下文），execute(args, exec) 收到它。
 */
import { normalizeState } from '../src/floorplan.mjs'

/** 会话 id 形态：`session-<uuid>`（或其它 uuid/短横线 id）。 */
export const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/

export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value.trim()) && /-/.test(value.trim())
}

/**
 * 从工具 exec 信封里防御式提取调用方会话 id。
 * exec 的形状随宿主版本变化，所以只在 agent/session 相关字段里找 id 形态的
 * 字符串；任何异常静默退化为「无归属」。
 */
export function sessionIdFromExec(exec) {
  try {
    let found = ''
    const seen = new Set()
    const visit = (o, depth) => {
      if (found || !o || typeof o !== 'object' || depth > 3 || seen.has(o)) return
      seen.add(o)
      for (const [k, v] of Object.entries(o)) {
        if (found) return
        if (typeof v === 'string' && isSessionId(v) && /session|agent|caller|parent|id/i.test(k)) {
          found = v.trim()
          return
        }
        if (v && typeof v === 'object' && /agent|session|caller|parent|ctx|ident/i.test(k)) visit(v, depth + 1)
      }
    }
    visit(exec && typeof exec === 'object' ? (exec.agent || exec) : undefined, 0)
    return found
  } catch {
    return ''
  }
}

/**
 * 官方 `defineTool` 的等价物（纯 JSON-Schema 形态）。
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} spec.description
 * @param {Record<string, object>} spec.parameters JSON-Schema properties（官方旧签名）
 * @param {string[]} [spec.required]
 * @param {(args: any, exec: any) => Promise<any>} spec.execute
 */
export function defineTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: spec.parameters || {},
      ...(Array.isArray(spec.required) && spec.required.length ? { required: spec.required } : {}),
    },
    output: {
      schema: { type: 'string' },
      // render 必须返回 content block 数组本身（外层再包 {content:[…]} 会报
      // "content is not iterable"）。
      render: (_args, value) => [{
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2),
      }],
    },
    // 声明的 output schema 是 string，execute 必须返回字符串。
    execute: async (args, exec) => {
      const out = await spec.execute(args || {}, exec)
      return typeof out === 'string' ? out : JSON.stringify(out ?? null, null, 2)
    },
  }
}

/** 把工具返回值统一成 JSON 字符串（给模型看）。 */
export function asText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

/** bit-office 的 activity 白名单（与 model.ts 一致）。 */
const ACTIVITIES = ['working', 'meeting', 'discussing', 'resting', 'fishing', 'offline']
const TASK_STATUSES = ['queued', 'dispatched', 'waiting_local_directory', 'running', 'completed', 'failed', 'cancelled']

/**
 * 构造本插件注册的两个工具。
 * @param {object} deps
 * @param {import('./sync.mjs').OfficeSync} deps.sync
 * @param {(sessionId: string) => {title?: string, cwd?: string}} deps.sessionInfo 由 entry 提供（读 sessionTitle/sessions）
 * @param {(msg: string) => void} [deps.log]
 */
export function makeOfficeTools({ sync, sessionInfo, log }) {
  const logger = typeof log === 'function' ? log : () => {}

  const report = defineTool({
    name: 'bit_office_report',
    description: '把当前会话在 bit-office 办公室里的记录上报一条有意义的状态/任务'
      + '（会话与 subagent 由插件自动登记，本工具只用于**主动**补充任务信息）。'
      + '调用后办公室平面图（会话标题栏「办公室」标签页）会立刻反映。'
      + 'activity 取值：working|meeting|discussing|resting|fishing|offline。',
    parameters: {
      activity: { type: 'string', enum: ACTIVITIES, description: '可选：把本会话置为某活动状态（工作中/开会/讨论/休息/摸鱼/离线）' },
      task_id: { type: 'string', description: '可选：任务 id（缺省用 note/title 生成一个稳定 id）' },
      task_title: { type: 'string', description: '可选：任务标题（如「核对 dsh-bit-office 自证测试」）' },
      status: { type: 'string', enum: TASK_STATUSES, description: '可选：任务状态，缺省 running' },
      blocked: { type: 'boolean', description: '可选：该任务是否被阻塞（平面图上会显「!」）' },
      note: { type: 'string', description: '可选：一句话说明（缺省任务标题；无任务时作为任务标题）' },
    },
    required: [],
    execute: async (args, exec) => {
      const sessionId = sessionIdFromExec(exec)
      if (!sessionId) {
        return asText({ ok: false, error: '无法从工具执行信封解析当前会话 id；请改用 bit_office_state 查看办公室' })
      }
      const info = sessionInfo ? sessionInfo(sessionId) : {}
      const title = String(args.task_title || args.note || '').trim()
      const status = TASK_STATUSES.includes(String(args.status)) ? String(args.status) : 'running'
      const taskId = String(args.task_id || '').trim()
        || `task-${sessionId.slice(-6)}-${slug(title) || 'report'}`
      const tasks = args.task_title || args.note || args.task_id
        ? [{
            id: taskId,
            title: (title || '状态上报').slice(0, 240),
            status,
            ...(args.blocked === true ? { blocked: true } : {}),
          }]
        : undefined
      const activity = ACTIVITIES.includes(String(args.activity)) ? String(args.activity) : undefined
      const out = await sync.reportSelf({
        sessionId,
        title: info.title,
        cwd: info.cwd,
        activity,
        tasks,
        // blocked 只有配合 tasks 才有意义；单独传 blocked 时补一条任务
        force: true,
      })
      logger(`bit_office_report(${sessionId}) → ${JSON.stringify(out)}`)
      return asText(out)
    },
  })

  const state = defineTool({
    name: 'bit_office_state',
    description: '读取 bit-office 办公室的当前状态（agent 记录、房间占用、zone 分区、'
      + '已退休计数）；用于 agent 自查「我现在在哪、同事在干什么」。'
      + '返回精简 JSON（不含完整任务正文），失败时返回 stale+error 而不是抛错。',
    parameters: {
      include_retired: { type: 'boolean', description: '可选：是否包含已退休记录（缺省 false）' },
    },
    required: [],
    execute: async (args) => {
      const includeRetired = args.include_retired === true
      const local = sync.localSnapshot()
      const remote = await sync.readState({ includeRetired })
      const normalized = normalizeOffice(remote.payload)
      return asText({
        ok: !remote.stale,
        stale: Boolean(remote.stale),
        ...(remote.error ? { error: remote.error } : {}),
        fetchedAt: remote.fetchedAt,
        retiredCount: normalized.retiredCount,
        zones: normalized.zones,
        rooms: normalized.rooms,
        agents: normalized.agents.map((a) => ({
          id: a.id,
          name: a.name,
          activity: a.activity,
          online: a.online,
          zone: a.zone,
          roomId: a.roomId,
          parentId: a.parentId,
          retired: a.retired,
          tasks: a.tasks.length,
        })),
        local: { tracked: local.stats.tracked, sessions: local.stats.sessions, subagents: local.stats.subagents, writes: local.stats.writes, failures: local.stats.failures, skipped: local.stats.skipped, retired: local.stats.retired },
      })
    },
  })

  return [report, state]
}

/** 生成可读 slug（任务 id 用）。 */
export function slug(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
}

/** 精简办公室状态（工具输出与 route 共用；复用 floorplan 的健壮解析）。 */
export function normalizeOffice(payload) {
  const src = normalizeState(payload)
  return {
    agents: src.agents.map((a) => ({
      id: String(a?.id ?? a?.agent_id ?? ''),
      name: String(a?.name ?? ''),
      activity: String(a?.activity ?? 'offline'),
      online: a?.online !== false,
      zone: String(a?.zone ?? a?.zone_id ?? ''),
      roomId: String(a?.roomId ?? a?.room_id ?? ''),
      parentId: String(a?.parentId ?? a?.parent_id ?? ''),
      retired: Boolean(a?.retiredAt || a?.retired_at || a?.retired === true),
      tasks: Array.isArray(a?.tasks) ? a.tasks : [],
    })),
    rooms: src.rooms.map((r) => ({
      id: String(r?.id ?? r?.room_id ?? ''),
      name: String(r?.name ?? ''),
      kind: String(r?.kind ?? ''),
      zone: String(r?.zone ?? ''),
      capacity: Number(r?.capacity) || 0,
    })),
    zones: src.zones.map((z) => ({
      id: String(z?.id ?? ''),
      name: String(z?.name ?? ''),
      originY: Number(z?.originY ?? z?.origin_y) || 0,
    })),
    retiredCount: src.retiredCount,
  }
}
