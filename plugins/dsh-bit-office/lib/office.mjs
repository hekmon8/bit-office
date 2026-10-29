/**
 * dsh-bit-office — bit-office 办公室 HTTP 语义层
 *
 * 在 McpClient（协议层）之上封装「记录」语义：
 *   - 乐观锁（expected_revision）读写：先 get_agent_state 拿 revision，写时带上；
 *     返回 revision_conflict 就重读再写（最多 2 次重试）。
 *   - agent_exists：记录已存在 → 直接改走 update 路径（不再报错）。
 *   - 降级容错：`retire_agent` / `zone_id` / `parent_id` 属于「即将部署」的新契约，
 *     若服务端还没上线（工具不存在 / 字段被拒），这里收敛成一次性提示并退到
 *     旧契约路径，绝不把异常抛给会话。
 */
import {
  AgentExistsError,
  InvalidParamsError,
  McpError,
  RevisionConflictError,
  ToolUnavailableError,
} from './mcp.mjs'

/** 新增（可能未部署）的字段名——被拒时优先按这些降级。 */
const NEW_FIELDS = ['zone_id', 'parent_id']
const MAX_RETRIES = 2

/** 从 get_agent_state 的结果里取 revision（容忍 {revision}/{agent:{revision}} 两种包法）。 */
export function revisionOf(payload) {
  if (!payload || typeof payload !== 'object') return undefined
  if (payload.revision !== undefined) return payload.revision
  if (payload.agent && typeof payload.agent === 'object' && payload.agent.revision !== undefined) {
    return payload.agent.revision
  }
  return undefined
}

/** 从 get_agent_state 的结果里取记录本体。 */
export function agentOf(payload) {
  if (!payload || typeof payload !== 'object') return null
  if (payload.agent && typeof payload.agent === 'object') return payload.agent
  if (payload.id || payload.agent_id) return payload
  return null
}

/** 判断记录是否已退休（新旧字段都认）。 */
export function isRetired(agent) {
  if (!agent || typeof agent !== 'object') return false
  return Boolean(agent.retiredAt || agent.retired_at || agent.retired === true)
}

/**
 * 从参数里剥掉服务端不认识的字段。
 * @returns {{args: object, dropped: string[]}|null} null = 无法再降级
 */
export function stripUnsupported(args, err, alreadyDropped = []) {
  const named = Array.isArray(err?.fields) ? err.fields.filter((f) => NEW_FIELDS.includes(f)) : []
  const target = named.length ? named : NEW_FIELDS
  const dropped = target.filter((f) => f in args && !alreadyDropped.includes(f))
  if (!dropped.length) return null
  const next = { ...args }
  for (const f of dropped) delete next[f]
  return { args: next, dropped }
}

export class OfficeApi {
  /**
   * @param {object} opts
   * @param {import('./mcp.mjs').McpClient} opts.client
   * @param {(msg: string) => void} [opts.log]
   * @param {number} [opts.retries]
   */
  constructor({ client, log, retries = MAX_RETRIES } = {}) {
    this.client = client
    this.log = typeof log === 'function' ? log : () => {}
    this.retries = retries
    /** 已记录过的降级提示，避免刷屏日志。 */
    this.warned = new Set()
  }

  warnOnce(key, msg) {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.log(msg)
  }

  /* ------------------------------------------------------------ 读 */

  /** 读一条记录；不存在/读取失败返回 null（不抛）。 */
  async readAgent(agentId) {
    try {
      const payload = await this.client.callTool('get_agent_state', { agent_id: agentId })
      return { payload, agent: agentOf(payload), revision: revisionOf(payload) }
    } catch (err) {
      if (err instanceof ToolUnavailableError) throw err
      this.log(`get_agent_state(${agentId}) failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /** 办公室整体状态。 */
  async getState({ includeRetired = true } = {}) {
    try {
      return await this.client.callTool('get_office_state', { include_retired: includeRetired })
    } catch (err) {
      if (err instanceof InvalidParamsError) {
        // include_retired 未部署 → 退到无参调用
        this.warnOnce('state-noinclude', 'get_office_state 不接受 include_retired（旧部署）→ 退回无参调用')
        return await this.client.callTool('get_office_state', {})
      }
      throw err
    }
  }

  async listRooms() {
    return await this.client.callTool('list_rooms', {})
  }

  /* ------------------------------------------------------------ 写（带乐观锁） */

  /**
   * 通用「读 revision → 写 → 冲突重读重试」循环。
   * @param {string} agentId
   * @param {(revision: unknown, attempt: number) => Promise<any>} fn
   */
  async withRevision(agentId, fn) {
    let lastErr = null
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const current = await this.readAgent(agentId)
      const revision = current?.revision
      if (revision === undefined) {
        // 记录不存在 → 交给调用方（fn 会看到 revision===undefined）
        return await fn(undefined, attempt)
      }
      try {
        return await fn(revision, attempt)
      } catch (err) {
        if (err instanceof RevisionConflictError) {
          lastErr = err
          this.log(`revision_conflict on ${agentId} (attempt ${attempt + 1}/${this.retries + 1}) → re-read`)
          continue
        }
        throw err
      }
    }
    throw lastErr || new McpError('revision retry exhausted', { kind: 'revision' })
  }

  /**
   * 确保一条记录存在（create → 冲突/已存在则 update）。
   * @param {object} input
   * @param {string} input.agentId
   * @param {string} input.name
   * @param {string} [input.zoneId]
   * @param {string} [input.parentId]
   * @param {string} [input.color]
   * @param {string} [input.activity]
   * @param {string} [input.roomId]
   * @returns {Promise<'created'|'updated'|'unchanged'|'failed'>}
   */
  async ensureAgent(input) {
    const { agentId, name, zoneId, parentId, color, activity, roomId } = input
    const current = await this.readAgent(agentId)
    const existing = current?.agent
    if (existing) {
      return await this.reconcileExisting(agentId, existing, current.revision, { name, zoneId, parentId })
    }
    // 不存在 → create（新字段被拒时降级重试）
    let args = { agent_id: agentId, name }
    if (color) args.color = color
    if (activity) args.activity = activity
    if (roomId) args.room_id = roomId
    if (zoneId && this.client.supportsZone) args.zone_id = zoneId
    if (parentId && this.client.supportsParent) args.parent_id = parentId
    const dropped = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.client.callTool('create_agent', args)
        return 'created'
      } catch (err) {
        if (err instanceof AgentExistsError) {
          // 竞态：别的路径刚建好 → 改走 update
          const again = await this.readAgent(agentId)
          if (again?.agent) return await this.reconcileExisting(agentId, again.agent, again.revision, { name, zoneId, parentId })
          return 'failed'
        }
        if (err instanceof InvalidParamsError) {
          const stripped = stripUnsupported(args, err, dropped)
          if (stripped) {
            for (const f of stripped.dropped) {
              dropped.push(f)
              if (f === 'zone_id') this.client.supportsZone = false
              if (f === 'parent_id') this.client.supportsParent = false
            }
            this.warnOnce(`drop:${stripped.dropped.join(',')}`,
              `create_agent 拒绝字段 ${stripped.dropped.join(',')}（旧部署）→ 降级创建 ${agentId}（zone/parent 信息仅保存在本地）`)
            args = stripped.args
            continue
          }
        }
        if (err instanceof ToolUnavailableError) throw err
        this.log(`create_agent(${agentId}) failed: ${err instanceof Error ? err.message : String(err)}`)
        return 'failed'
      }
    }
    return 'failed'
  }

  /** 记录已存在时的路径：按需补 name/zone/parent（字段被拒则只记日志）。 */
  async reconcileExisting(agentId, agent, revision, want = {}) {
    if (revision === undefined) return 'unchanged'
    const patches = []
    if (want.name && agent.name !== want.name) patches.push({ tool: 'update_agent', args: { agent_id: agentId, expected_revision: revision, name: want.name } })
    // parent/zone 的补齐走 update_agent_status（新契约里它接受 zone_id）
    if (want.parentId && !agent.parentId && !agent.parent_id && this.client.supportsParent) {
      patches.push({ tool: 'update_agent_status', args: { agent_id: agentId, expected_revision: revision, parent_id: want.parentId } })
    }
    if (want.zoneId && agent.zone !== want.zoneId && this.client.supportsZone) {
      patches.push({ tool: 'update_agent_status', args: { agent_id: agentId, expected_revision: revision, zone_id: want.zoneId } })
    }
    if (!patches.length) return 'unchanged'
    let changed = false
    for (const p of patches) {
      try {
        await this.client.callTool(p.tool, p.args)
        changed = true
      } catch (err) {
        if (err instanceof RevisionConflictError) return 'unchanged'
        if (err instanceof InvalidParamsError) {
          const stripped = stripUnsupported(p.args, err)
          if (stripped) {
            for (const f of stripped.dropped) {
              if (f === 'zone_id') this.client.supportsZone = false
              if (f === 'parent_id') this.client.supportsParent = false
            }
            try {
              await this.client.callTool(p.tool, stripped.args)
              changed = true
              continue
            } catch (err2) {
              this.log(`${p.tool} degrade failed: ${err2 instanceof Error ? err2.message : String(err2)}`)
              continue
            }
          }
        }
        this.log(`${p.tool}(${agentId}) failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return changed ? 'updated' : 'unchanged'
  }

  /**
   * 改名（自带乐观锁重试）。标题通常在会话创建之后才生成，由 sync 的低频校正调用。
   * @returns {Promise<boolean>}
   */
  async renameAgent(agentId, name) {
    if (!name) return false
    try {
      await this.withRevision(agentId, async (revision) => {
        if (revision === undefined) throw new McpError(`agent ${agentId} missing`, { kind: 'missing' })
        return await this.client.callTool('update_agent', { agent_id: agentId, expected_revision: revision, name })
      })
      return true
    } catch (err) {
      if (err instanceof McpError && err.kind === 'missing') return false
      this.log(`update_agent(${agentId}) rename failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /**
   * 写状态（activity/online/heartbeat/tasks/zone_id），自带乐观锁重试。
   * @returns {Promise<boolean>} 是否写成功
   */
  async updateStatus(agentId, patch = {}) {
    try {
      await this.withRevision(agentId, async (revision) => {
        if (revision === undefined) throw new McpError(`agent ${agentId} missing`, { kind: 'missing' })
        const args = { agent_id: agentId, expected_revision: revision, ...patch }
        if (patch.zone_id !== undefined && !this.client.supportsZone) delete args.zone_id
        return await this.client.callTool('update_agent_status', args)
      })
      return true
    } catch (err) {
      if (err instanceof McpError && err.kind === 'missing') return false
      if (err instanceof ToolUnavailableError) {
        this.warnOnce('status-unavailable', 'update_agent_status 在当前服务端不存在 → 跳过状态上报')
        return false
      }
      this.log(`update_agent_status(${agentId}) failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /**
   * 软退休一条记录。retire_agent 未部署时降级为「置 offline + 记一条终态说明」。
   * @returns {Promise<boolean>} 是否按预期退休
   */
  async retireAgent(agentId, { reason = '', cascade = true } = {}) {
    if (this.client.hasTool('retire_agent')) {
      try {
        await this.withRevision(agentId, async (revision) => {
          if (revision === undefined) throw new McpError(`agent ${agentId} missing`, { kind: 'missing' })
          return await this.client.callTool('retire_agent', {
            agent_id: agentId,
            expected_revision: revision,
            ...(reason ? { reason } : {}),
            ...(cascade ? { cascade: true } : {}),
          })
        })
        return true
      } catch (err) {
        if (err instanceof ToolUnavailableError) {
          this.warnOnce('retire-unavailable', 'retire_agent 未部署 → 降级为 offline 上报（记录继续保留在办公室，不释放工位）')
        } else if (err instanceof McpError && err.kind === 'missing') {
          return true // 记录本就不在，视作已退休
        } else {
          this.log(`retire_agent(${agentId}) failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } else {
      this.warnOnce('retire-unavailable', 'retire_agent 未部署 → 降级为 offline 上报（记录继续保留在办公室，不释放工位）')
    }
    // 降级：把 activity 置 offline，并留一条说明性任务
    return await this.updateStatus(agentId, {
      activity: 'offline',
      online: false,
      heartbeat: false,
      tasks: [{
        id: `retire-${Date.now()}`,
        title: `已结束（本地标记退休，服务端 retire_agent 未部署）${reason ? `：${reason}` : ''}`,
        status: 'completed',
      }],
      tasks_complete: true,
    })
  }
}
