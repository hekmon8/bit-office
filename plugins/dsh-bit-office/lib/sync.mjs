/**
 * dsh-bit-office — 自动同步引擎（核心）
 *
 * 把 DSH 的每个 session / subagent 映射成办公室里的记录，**不依赖模型自觉
 * 调用工具**。全部写操作满足三条纪律：
 *   ① 每 60 秒最多上报一次同一 agent 的状态（节流）；
 *   ② 同一 agent 的写操作串行（per-agent 队列，避免乐观锁互相踩）；
 *   ③ 任何网络/协议失败只写日志——fire-and-forget，绝不让会话出错或阻塞。
 *
 * 时间与定时器可注入（now / setTimeoutImpl），便于单测用假时钟验证保留期调度。
 */
import { sessionName, subagentRecord, subagentTask, sessionRecord, toAgentId } from './mapping.mjs'

/** 默认本地记录账本的最大条目数（防长跑泄漏）。 */
const MAX_RECORDS = 4000

export class OfficeSync {
  /**
   * @param {object} opts
   * @param {import('./office.mjs').OfficeApi} opts.api
   * @param {object} opts.config
   * @param {(msg: string) => void} [opts.log]
   * @param {() => number} [opts.now]
   * @param {typeof setTimeout} [opts.setTimeoutImpl]
   * @param {typeof clearTimeout} [opts.clearTimeoutImpl]
   * @param {(childId: string, parentAgent?: unknown) => string} [opts.resolveParentSession]
   * @param {(sessionId: string) => {title?: string, cwd?: string}} [opts.nameResolver]
   */
  constructor({ api, config, log, now, setTimeoutImpl, clearTimeoutImpl, resolveParentSession, nameResolver } = {}) {
    this.api = api
    this.config = config || {}
    this.log = typeof log === 'function' ? log : () => {}
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.setTimeoutImpl = setTimeoutImpl || setTimeout
    this.clearTimeoutImpl = clearTimeoutImpl || clearTimeout
    this.resolveParentSession = typeof resolveParentSession === 'function' ? resolveParentSession : () => ''
    this.nameResolver = typeof nameResolver === 'function' ? nameResolver : () => ({})
    this.throttleMs = Number(this.config.throttleMs) || 60000
    this.retentionMs = Number(this.config.retentionMs) || 15 * 60 * 1000
    /** enabled=false：只做本地账本与标签页，不发任何远端请求（写与读都跳过）。 */
    this.enabled = this.config.enabled !== false

    /** agentId → 本地账本（route / 展示用；不是服务端状态）。 */
    this.records = new Map()
    /** agentId → 最近一次成功上报时间（节流）。 */
    this.lastReportAt = new Map()
    /** agentId → 串行队列尾（Promise）。 */
    this.queues = new Map()
    /** agentId → 保留期定时器。 */
    this.timers = new Map()
    /** 统计（/api 的 diag 用）。 */
    this.stats = { sessions: 0, subagents: 0, writes: 0, failures: 0, skipped: 0, retired: 0 }
    this.disposed = false
  }

  /* ------------------------------------------------------------ 基础设施 */

  record(agentId) {
    let r = this.records.get(agentId)
    if (!r) {
      r = {
        id: agentId,
        name: '',
        zoneId: this.config.zoneId || 'office',
        parentId: '',
        kind: 'session',
        sessionId: agentId,
        firstSeenAt: this.now(),
        lastSeenAt: this.now(),
        retiredAt: null,
        remote: 'unknown',
      }
      this.records.set(agentId, r)
      if (this.records.size > MAX_RECORDS) {
        // 简单 FIFO 淘汰：删掉最早的条目（只影响本地展示，不影响服务端记录）
        const oldest = [...this.records.values()].sort((a, b) => a.firstSeenAt - b.firstSeenAt)[0]
        if (oldest) this.records.delete(oldest.id)
      }
    }
    return r
  }

  /** 同一 agent 的写操作串行；返回的 Promise 会 resolve 成任务结果（失败为 null）。 */
  enqueue(agentId, task) {
    const key = String(agentId)
    if (!this.enabled) {
      this.stats.skipped += 1
      return Promise.resolve(null)
    }
    const prev = this.queues.get(key) || Promise.resolve()
    const next = prev.then(async () => {
      if (this.disposed) return null
      try {
        const out = await task()
        this.stats.writes += 1
        return out
      } catch (err) {
        this.stats.failures += 1
        this.log(`sync(${key}) failed: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    })
    this.queues.set(key, next.catch(() => null))
    return next
  }

  /** fire-and-forget 包装：任何异常都只落日志。 */
  fire(agentId, task) {
    try {
      void this.enqueue(agentId, task).catch(() => null)
    } catch (err) {
      this.log(`sync dispatch(${agentId}) failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /* --------------------------------------------------------------- 会话 */

  /**
   * 会话创建/首次看到：建记录并立刻上报「工作中」。
   * @param {{sessionId: string, title?: string, cwd?: string}} input
   */
  registerSession(input) {
    const mapped = sessionRecord({ ...input, zoneId: this.config.zoneId || 'office' })
    if (!mapped) {
      this.log(`registerSession skipped: invalid session id ${String(input && input.sessionId)}`)
      return
    }
    const rec = this.record(mapped.agentId)
    rec.name = mapped.name
    rec.kind = 'session'
    rec.sessionId = mapped.agentId
    rec.remote = 'pending'
    this.stats.sessions = this.records.size
    this.fire(mapped.agentId, async () => {
      const outcome = await this.api.ensureAgent({
        agentId: mapped.agentId,
        name: mapped.name,
        zoneId: mapped.zoneId,
        activity: mapped.activity,
      })
      rec.remote = outcome
      if (outcome === 'failed') {
        this.log(`registerSession(${mapped.agentId}) 未能写入办公室记录（后续重试由上层决定）`)
        return null
      }
      // 建好就立刻标「在岗工作中」——绕过节流（这是首次上报）
      await this.api.updateStatus(mapped.agentId, {
        activity: 'working',
        online: true,
        heartbeat: true,
        zone_id: mapped.zoneId,
      })
      this.lastReportAt.set(mapped.agentId, this.now())
      return outcome
    })
  }

  /** 会话标题变化（可选调用）：只在标题真的变了时更新名单。 */
  renameSession(sessionId, title, cwd) {
    const mapped = sessionRecord({ sessionId, title, cwd, zoneId: this.config.zoneId || 'office' })
    if (!mapped) return false
    const rec = this.record(mapped.agentId)
    if (rec.name === mapped.name) return false
    rec.name = mapped.name
    this.fire(mapped.agentId, async () => {
      await this.api.renameAgent(mapped.agentId, mapped.name)
      return 'renamed'
    })
    return true
  }

  /**
   * 批量校正会话名称（标题往往在会话创建之后才生成）。
   * 由 /api 路由的低频轮询驱动；每条记录最多每 minIntervalMs 校正一次。
   */
  reconcileNames({ minIntervalMs = 60000, force = false } = {}) {
    const now = this.now()
    let changed = 0
    for (const rec of this.records.values()) {
      if (rec.kind !== 'session') continue
      if (!force && now - (rec.nameCheckedAt || 0) < minIntervalMs) continue
      rec.nameCheckedAt = now
      let info = {}
      try {
        info = this.nameResolver(rec.sessionId) || {}
      } catch (err) {
        this.log(`nameResolver(${rec.sessionId}) failed: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      const next = sessionName({ sessionId: rec.sessionId, title: info.title, cwd: info.cwd })
      if (next && next !== rec.name) {
        this.renameSession(rec.sessionId, info.title, info.cwd)
        changed += 1
      }
    }
    return changed
  }

  /** 会话销毁 → 软退休（cascade 连带退休子记录）。 */
  disposeSession(sessionId) {
    const agentId = toAgentId(sessionId)
    if (!agentId) return
    const rec = this.records.get(agentId)
    if (rec) rec.retiredAt = this.now()
    this.clearTimer(agentId)
    this.fire(agentId, async () => {
      const ok = await this.api.retireAgent(agentId, { reason: 'DSH session disposed', cascade: true })
      if (ok) this.stats.retired += 1
      return ok
    })
  }

  /* ------------------------------------------------------------ subagent */

  /**
   * subagent 启动 → 建记录（parent_id = 父会话的 agent_id，activity=discussing）。
   * @param {{id?: string, runId?: string, provider?: string}} info SubagentRunInfo
   * @param {unknown} [parentAgent] 事件第二参数（Agent）
   */
  startSubagent(info, parentAgent) {
    const childId = String(info?.id ?? '')
    if (!childId) return
    const parentSessionId = this.resolveParentSession(childId, parentAgent)
    const mapped = subagentRecord({
      childId,
      parentSessionId,
      provider: info?.provider,
      zoneId: this.config.zoneId || 'office',
    })
    if (!mapped) return
    if (!mapped.parentId) {
      this.log(`subagent ${childId}: 父会话不可解析（sessions 里查不到 header.parentSession）→ 只建不带 parent 的记录`)
    }
    const rec = this.record(mapped.agentId)
    rec.kind = 'subagent'
    rec.name = mapped.name
    rec.parentId = mapped.parentId
    rec.sessionId = childId
    rec.remote = 'pending'
    this.stats.subagents = [...this.records.values()].filter((x) => x.kind === 'subagent').length
    this.clearTimer(mapped.agentId) // 复活的 run 取消待退休
    this.fire(mapped.agentId, async () => {
      const outcome = await this.api.ensureAgent({
        agentId: mapped.agentId,
        name: mapped.name,
        zoneId: mapped.zoneId,
        parentId: mapped.parentId || undefined,
        activity: mapped.activity,
      })
      rec.remote = outcome
      if (outcome === 'failed') return null
      await this.api.updateStatus(mapped.agentId, {
        activity: 'discussing',
        online: true,
        heartbeat: true,
        zone_id: mapped.zoneId,
      })
      this.lastReportAt.set(mapped.agentId, this.now())
      return outcome
    })
  }

  /**
   * subagent 结束 → 置 offline + 一条终态 task（标题含 provider/stopReason），
   * 再按 retentionMs（默认 15 分钟）延迟退休。
   * @param {{id?: string, runId?: string, provider?: string, stopReason?: string, lastAssistantMessage?: unknown}} info
   */
  endSubagent(info) {
    const childId = String(info?.id ?? '')
    if (!childId) return
    const agentId = toAgentId(childId)
    if (!agentId) return
    const task = subagentTask({
      provider: info?.provider,
      runId: info?.runId,
      stopReason: info?.stopReason,
      lastAssistantMessage: info?.lastAssistantMessage,
    })
    const rec = this.records.get(agentId)
    if (rec) rec.lastSeenAt = this.now()
    // 终态上报不受 60s 节流限制（否则最后状态可能永远写不进去）
    this.fire(agentId, async () => {
      const ok = await this.api.updateStatus(agentId, {
        activity: 'offline',
        online: false,
        heartbeat: false,
        tasks: [task],
        tasks_complete: task.status === 'completed',
      })
      if (ok) this.lastReportAt.set(agentId, this.now())
      return ok
    })
    this.scheduleRetire(agentId, String(info?.stopReason ?? ''))
  }

  /** 保留期后退休（可注入时钟单测）。 */
  scheduleRetire(agentId, reason = '') {
    this.clearTimer(agentId)
    const delay = Math.max(0, this.retentionMs)
    const timer = this.setTimeoutImpl(() => {
      this.timers.delete(agentId)
      const rec = this.records.get(agentId)
      if (rec) rec.retiredAt = this.now()
      this.fire(agentId, async () => {
        const ok = await this.api.retireAgent(agentId, {
          reason: reason ? `subagent ${reason} (retention elapsed)` : 'subagent retention elapsed',
          cascade: true,
        })
        if (ok) this.stats.retired += 1
        return ok
      })
    }, delay)
    if (timer && typeof timer.unref === 'function') timer.unref()
    this.timers.set(agentId, timer)
  }

  clearTimer(agentId) {
    const t = this.timers.get(agentId)
    if (t !== undefined) {
      try {
        this.clearTimeoutImpl(t)
      } catch { /* 已触发 */ }
      this.timers.delete(agentId)
    }
  }

  /* -------------------------------------------------------------- 上报 */

  /**
   * 状态上报（带节流）。force=true 绕过节流（终态上报用）。
   * @returns {Promise<boolean>} 是否真的发出了请求
   */
  report(agentId, patch = {}, { force = false } = {}) {
    const id = toAgentId(agentId)
    if (!id) return Promise.resolve(false)
    const last = this.lastReportAt.get(id) || 0
    if (!force && this.now() - last < this.throttleMs) {
      this.stats.skipped += 1
      return Promise.resolve(false)
    }
    this.lastReportAt.set(id, this.now()) // 先占位，避免并发穿透
    const rec = this.records.get(id)
    if (rec) rec.lastSeenAt = this.now()
    return this.enqueue(id, async () => {
      const ok = await this.api.updateStatus(id, {
        ...(this.config.zoneId ? { zone_id: this.config.zoneId } : {}),
        ...patch,
      })
      if (!ok) this.lastReportAt.set(id, last) // 失败则退回上次时间，下次还能重试
      return ok
    }).then((r) => r === true)
  }

  /* ------------------------------------------------------- 工具调用路径 */

  /**
   * `bit_office_report` 的实现：确保本会话记录存在，再按需上报状态/任务。
   * 显式调用绕过节流（是 agent 主动要求的上报），但仍走同一串行队列。
   * @returns {Promise<object>} 结构化结果（绝不抛）
   */
  reportSelf({ sessionId, title, cwd, activity, tasks, force = true } = {}) {
    const mapped = sessionRecord({ sessionId, title, cwd, zoneId: this.config.zoneId || 'office' })
    if (!mapped) return Promise.resolve({ ok: false, error: `invalid session id: ${String(sessionId)}` })
    const rec = this.record(mapped.agentId)
    rec.name = mapped.name
    rec.kind = rec.kind === 'subagent' ? 'subagent' : 'session'
    if (force) this.lastReportAt.delete(mapped.agentId)
    return this.enqueue(mapped.agentId, async () => {
      const outcome = await this.api.ensureAgent({
        agentId: mapped.agentId,
        name: mapped.name,
        zoneId: mapped.zoneId,
        activity: mapped.activity,
      })
      if (outcome === 'failed') return { ok: false, agentId: mapped.agentId, error: 'ensureAgent failed（详见插件日志）' }
      const patch = {
        ...(activity ? { activity, online: activity !== 'offline' } : {}),
        heartbeat: true,
        ...(Array.isArray(tasks) && tasks.length ? { tasks, tasks_complete: tasks.every((t) => t.status === 'completed' || t.status === 'failed') } : {}),
      }
      const ok = await this.api.updateStatus(mapped.agentId, {
        ...(this.config.zoneId ? { zone_id: this.config.zoneId } : {}),
        ...patch,
      })
      if (ok) this.lastReportAt.set(mapped.agentId, this.now())
      return {
        ok,
        agentId: mapped.agentId,
        name: mapped.name,
        zone: mapped.zoneId,
        ensured: outcome,
        ...(activity ? { activity } : {}),
        ...(Array.isArray(tasks) && tasks.length ? { task: tasks[0] } : {}),
      }
    })
  }

  /* ------------------------------------------------------- 远端状态读取 */

  /**
   * 读办公室状态（带 cacheMs 本地缓存；失败时返回旧值并标 stale）。
   */
  async readState({ includeRetired = true } = {}) {
    const now = this.now()
    const cacheMs = Number(this.config.cacheMs) || 5000
    if (!this.enabled) {
      // enabled=false：不碰远端，直接给本地账本（标签页仍显示「本机会话」视图）
      return { payload: null, fetchedAt: now, stale: false, error: '', cached: false, disabled: true }
    }
    if (this.stateCache && now - this.stateCache.at < cacheMs) {
      return { ...this.stateCache.value, cached: true }
    }
    try {
      const payload = await this.api.getState({ includeRetired })
      const value = { payload, fetchedAt: now, stale: false, error: '' }
      this.stateCache = { at: now, value }
      return value
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (this.stateCache) {
        return { ...this.stateCache.value, cached: true, stale: true, error: message }
      }
      return { payload: null, fetchedAt: now, stale: true, error: message, cached: false }
    }
  }

  /** 本地账本快照（route 用它把 sessionId/parent 关系透给前端）。 */
  localSnapshot() {
    return {
      records: [...this.records.values()],
      stats: { ...this.stats, tracked: this.records.size },
    }
  }

  /** 卸载：清所有定时器，并把在册会话标记为离线（尽力而为）。 */
  dispose() {
    this.disposed = true
    for (const id of [...this.timers.keys()]) this.clearTimer(id)
    this.queues.clear()
  }
}
