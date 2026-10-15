/**
 * dsh-bit-office — Cordis entry（Node half）
 *
 * 一条 Cordis 插件做四件事：
 *   ① 自动同步：监听 session/created|disposed、subagent/start|end，把每个会话与
 *      每个 subagent 登记成 bit-office 办公室里的持久 Agent 记录（不依赖模型自觉
 *      调用工具）；
 *   ② 模型工具：bit_office_report（主动上报任务/状态）、bit_office_state（自查）；
 *   ③ 同源只读路由：GET /api/dsh-bit-office/state 给 client half 轮询平面图数据；
 *   ④ systemPrompt 短约定（3~5 行，避免每请求都塞长 SOP）。
 *
 * 纪律：所有远端写操作 fire-and-forget，任何失败只写插件日志——绝不让会话出错
 * 或阻塞（见 lib/sync.mjs）。卸载时清理事件、工具、路由与定时器。
 */
import { describeConfig, loadConfig } from './config.mjs'
import { McpClient } from './mcp.mjs'
import { OfficeApi } from './office.mjs'
import { OfficeSync } from './sync.mjs'
import { makeOfficeTools } from './tools.mjs'
import { layoutFloorplan, normalizeState } from '../src/floorplan.mjs'

export const name = 'dsh-bit-office'

/**
 * 严格注入：`ctx.get(...)` 用到的服务必须出现在这里。
 * 名字都用 dsh 包源码里的 `super(ctx, "<name>")` 核对过：
 *   webServer   → @deepseek-ai/dsh-host-webserver
 *   tools       → @deepseek-ai/dsh-tools
 *   systemPrompt→ @deepseek-ai/dsh-system-prompt
 *   sessions    → @deepseek-ai/dsh-session
 *   sessionTitle→ @deepseek-ai/dsh-session-title
 */
export const inject = ['webServer', 'tools', 'systemPrompt', 'sessions', 'sessionTitle']

/** systemPrompt 注入文本：刻意压到 5 行以内（每个请求都会进上下文）。 */
export const PROMPT_TEXT = [
  '本会话已被 dsh-bit-office 自动登记进 bit-office 办公室（agent_id = 本会话 id，公司区）。',
  '· 登记与状态同步由插件自动完成（会话=工作中、subagent=讨论中），**不需要**你手动维护；',
  '· 想主动上报任务或活动时调用 `bit_office_report{activity?,task_id?,task_title?,status?,blocked?,note?}`；',
  '· 想查看办公室现状（谁在哪、房间占用、已退休数）调用 `bit_office_state{}`；',
  '· 平面图在会话标题栏「办公室」标签页；不要直接 curl 远端 MCP。',
].join('\n')

const ROUTE_PATH = '/api/dsh-bit-office/state'

export function apply(ctx) {
  const config = loadConfig()
  const log = (msg) => {
    try {
      console.log(`[dsh-bit-office] ${msg}`)
    } catch { /* 日志失败不影响主流程 */ }
  }

  const client = new McpClient({ url: config.url, token: config.token, timeoutMs: config.timeoutMs, log })

  /* --------------------------------------------------- 本会话信息解析 */

  /** 会话对象（sessions 服务是唯一权威来源；取不到就 null）。 */
  const sessionOf = (sessionId) => {
    try {
      const svc = ctx.get('sessions')
      return svc && typeof svc.get === 'function' ? svc.get(sessionId) : undefined
    } catch {
      return undefined
    }
  }

  /** 会话标题（sessionTitle 服务的快照；取不到回退空串 → 由 mapping 走目录名回退）。 */
  const titleOf = (session) => {
    try {
      const svc = ctx.get('sessionTitle')
      if (!svc || typeof svc.get !== 'function' || !session) return ''
      const snapshot = svc.get(session)
      return snapshot && typeof snapshot.title === 'string' ? snapshot.title : ''
    } catch {
      return ''
    }
  }

  /** 工具/事件共用的会话信息读取。 */
  const sessionInfo = (sessionId) => {
    const session = sessionOf(sessionId)
    return {
      title: titleOf(session),
      cwd: session && session.header ? session.header.cwd : undefined,
      parentSession: session && session.header ? session.header.parentSession : undefined,
    }
  }

  /** 子会话的父会话 id：子会话的 header.parentSession，取不到时退到事件第二参数（Agent）。 */
  const resolveParentSession = (childId, parentAgent) => {
    const info = sessionInfo(childId)
    if (info.parentSession) return String(info.parentSession)
    try {
      const sid = parentAgent && parentAgent.session && parentAgent.session.id
      if (sid) return String(sid)
    } catch { /* Agent 形状不符 → 放弃 */ }
    return ''
  }

  const api = new OfficeApi({ client, log })
  const sync = new OfficeSync({
    api,
    config,
    log,
    resolveParentSession,
    nameResolver: sessionInfo,
  })

  /* ------------------------------------------------------------- 启动 */

  // fire-and-forget 初始化：握手 + 工具清单（失败只记日志，后续调用自行重试）
  const boot = (async () => {
    try {
      await client.initialize()
      const tools = await client.refreshTools()
      log(`connected: ${describeConfig(config).url} zone=${config.zoneId}`
        + ` tools=${tools ? [...tools].length : 'unknown'}`
        + ` token=${describeConfig(config).token}`)
      if (tools && !tools.has('retire_agent')) {
        log('注意：服务端暂无 retire_agent（新契约未部署）→ 退休将降级为 offline 上报')
      }
    } catch (err) {
      log(`initialize failed: ${err instanceof Error ? err.message : String(err)}（插件继续运行，写操作会各自重试）`)
    }
    // 把已存在的会话补登记（插件晚于会话创建时加载的场景）
    try {
      const svc = ctx.get('sessions')
      const list = svc && typeof svc.list === 'function' ? svc.list() : []
      for (const session of list) {
        if (!session || !session.id) continue
        const header = session.header || {}
        if (header.parentSession) sync.startSubagent({ id: session.id, provider: '' }, null)
        else sync.registerSession({ sessionId: session.id, title: titleOf(session), cwd: header.cwd })
      }
      if (list.length) log(`re-enrolled ${list.length} pre-existing session(s)`)
    } catch (err) {
      log(`enroll existing sessions failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()

  /* --------------------------------------------------- 生命周期事件 */

  // session/created：新会话 → 记录（若是子会话则按 subagent 处理，等 subagent/start 补 provider）
  ctx.on('session/created', (session) => {
    try {
      if (!session || !session.id) return
      const header = session.header || {}
      if (header.parentSession) {
        sync.startSubagent({ id: session.id, provider: '' }, null)
      } else {
        sync.registerSession({ sessionId: session.id, title: titleOf(session), cwd: header.cwd })
      }
    } catch (err) {
      log(`session/created handling failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // session/disposed：会话结束 → 软退休（cascade 连带退休子记录）
  ctx.on('session/disposed', (session) => {
    try {
      if (!session || !session.id) return
      sync.disposeSession(session.id)
    } catch (err) {
      log(`session/disposed handling failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // subagent/start：子 agent 上工（activity=discussing，parent_id=父会话 agent_id）
  ctx.on('subagent/start', (info, parentAgent) => {
    try {
      if (!info || !info.id) return
      sync.startSubagent(info, parentAgent)
    } catch (err) {
      log(`subagent/start handling failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // subagent/end：子 agent 收工 → offline + 终态 task，保留期后退休
  ctx.on('subagent/end', (info) => {
    try {
      if (!info || !info.id) return
      sync.endSubagent(info)
    } catch (err) {
      log(`subagent/end handling failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  /* --------------------------------------------------------- 模型工具 */

  const disposeTools = ctx.effect(() => {
    const disposers = []
    try {
      const tools = ctx.get('tools')
      if (tools && typeof tools.register === 'function') {
        for (const def of makeOfficeTools({ sync, sessionInfo, log })) {
          try {
            const d = tools.register(def)
            disposers.push(d)
            log(`tool registered: ${def.name}`)
          } catch (err) {
            log(`tool register failed (${def.name}): ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      } else {
        log('tools 服务不可用 → 跳过模型工具注册（自动同步与平面图不受影响）')
      }
    } catch (err) {
      log(`tools 注册异常: ${err instanceof Error ? err.message : String(err)}`)
    }
    return () => {
      for (const d of disposers) {
        try {
          if (typeof d === 'function') d()
        } catch { /* 已释放 */ }
      }
    }
  }, 'dsh-bit-office:tools')

  /* ------------------------------------------------------- systemPrompt */

  const disposePrompt = ctx.effect(() => {
    try {
      const sp = ctx.get('systemPrompt')
      if (sp && typeof sp.section === 'function') {
        const d = sp.section({ name: 'dsh-bit-office', order: 125, text: PROMPT_TEXT })
        return () => {
          try {
            if (typeof d === 'function') d()
          } catch { /* 已释放 */ }
        }
      }
      log('systemPrompt 服务不可用 → 跳过短约定注入')
    } catch (err) {
      log(`systemPrompt 注入失败: ${err instanceof Error ? err.message : String(err)}`)
    }
    return () => {}
  }, 'dsh-bit-office:prompt')

  /* -------------------------------------------------------- 只读路由 */

  const disposeRoute = ctx.effect(() => {
    // ctx.get 在严格注入未声明时是**抛错**而不是返回 undefined，所以整段都要兜住
    let webServer
    try {
      webServer = ctx.get('webServer')
    } catch (err) {
      log(`webServer 不可取（严格注入）: ${err instanceof Error ? err.message : String(err)} → 跳过状态路由`)
      return () => {}
    }
    if (!webServer || typeof webServer.register !== 'function') {
      log('webServer 服务不可用 → 跳过 /api/dsh-bit-office/state 路由（会话标题栏标签页会显示错误态）')
      return () => {}
    }
    const json = (res, status, body) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(body))
    }
    const dispose = webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        let sessionId = ''
        let includeRetired = true
        try {
          const u = new URL(req.url || ROUTE_PATH, 'http://localhost')
          sessionId = String(u.searchParams.get('session') || '')
          includeRetired = u.searchParams.get('include_retired') !== '0'
        } catch { /* 参数异常 → 用默认值 */ }
        try {
          // 标题可能在会话创建之后才生成：路由被轮询时顺带校正一次名称
          try {
            sync.reconcileNames()
          } catch { /* 名称校正失败不影响数据 */ }
          const remote = await sync.readState({ includeRetired })
          const local = sync.localSnapshot()
          const office = mergeOffice(remote.payload, local.records)
          const model = layoutFloorplan(office, { highlightId: sessionId })
          json(res, 200, {
            fetchedAt: remote.fetchedAt,
            stale: Boolean(remote.stale),
            error: remote.error || '',
            cached: Boolean(remote.cached),
            session: sessionId,
            office,
            local,
            stats: model.stats,
            config: { url: config.url, zoneId: config.zoneId, retentionMs: config.retentionMs, throttleMs: config.throttleMs },
          })
        } catch (err) {
          // 路由永远返回 200 + 可读错误，让标签页显示降级态而不是白屏
          json(res, 200, {
            fetchedAt: Date.now(),
            stale: true,
            error: err instanceof Error ? err.message : String(err),
            session: sessionId,
            office: mergeOffice(null, sync.localSnapshot().records),
            local: sync.localSnapshot(),
            stats: layoutFloorplan(null, { highlightId: sessionId }).stats,
            config: { url: config.url, zoneId: config.zoneId },
          })
        }
      },
    })
    log(`route ${ROUTE_PATH} registered → ${config.url}`)
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch { /* 已释放 */ }
    }
  }, 'dsh-bit-office:route')

  if (!config.enabled) {
    log('配置 enabled=false → 仅注册工具与标签页，不做任何远端同步')
  }

  return () => {
    try {
      disposeTools()
    } catch { /* noop */ }
    try {
      disposePrompt()
    } catch { /* noop */ }
    try {
      disposeRoute()
    } catch { /* noop */ }
    try {
      sync.dispose()
    } catch { /* noop */ }
    log('unloaded')
  }
}

/**
 * 把远端状态与本地账本合并成平面图输入。
 * - 远端记录优先；本地有更新名字（标题后生成）时用本地名字；
 * - 本地已知但远端还没有的记录（写操作在途）也画出来，标 `pending`；
 * - 远端不可用时，本地记录照样能画（房间走 floorplan 的默认目录兜底）。
 */
export function mergeOffice(payload, records = []) {
  const remote = normalizeState(payload)
  const byId = new Map()
  for (const agent of remote.agents) {
    const id = String(agent?.id ?? agent?.agent_id ?? '')
    if (!id) continue
    byId.set(id, { ...agent, id })
  }
  const localById = new Map((records || []).map((r) => [String(r.id), r]))
  for (const [id, rec] of localById) {
    const existing = byId.get(id)
    if (existing) {
      if (rec.name && rec.name !== existing.name) existing.name = rec.name
      continue
    }
    byId.set(id, {
      id,
      name: rec.name || id,
      activity: rec.retiredAt ? 'offline' : (rec.kind === 'subagent' ? 'discussing' : 'working'),
      online: !rec.retiredAt,
      zone: rec.zoneId || 'office',
      roomId: '',
      parentId: rec.parentId || '',
      tasks: [],
      pending: true,
      retired: Boolean(rec.retiredAt),
    })
  }
  // 本地已知的父子关系补到远端记录上（远端旧部署可能没有 parent_id）
  for (const [id, agent] of byId) {
    const rec = localById.get(id)
    if (rec && rec.parentId && !agent.parentId) agent.parentId = rec.parentId
  }
  return {
    mode: remote.agents.length ? 'live' : 'local',
    source: 'dsh-bit-office',
    observedAt: remote.observedAt || new Date().toISOString(),
    agents: [...byId.values()],
    rooms: remote.rooms,
    zones: remote.zones,
    retiredCount: remote.retiredCount,
  }
}
