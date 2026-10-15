/**
 * dsh-bit-office — 配置加载（纯函数，无副作用可测）
 *
 * 优先级：环境变量 > ~/.dsh/dsh-bit-office.json > 默认值。
 * 只读本地文件与 env；不发起任何网络请求。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_URL = 'https://agents.hekmon.com/mcp'
/** 公司区 zone id（bit-office 新契约：公司区="office"，个人区="home"）。 */
export const OFFICE_ZONE = 'office'
export const HOME_ZONE = 'home'

/** 把 "-"/"" 归一成 undefined，避免把空串当有效配置。 */
function str(v) {
  if (v === undefined || v === null) return undefined
  const s = String(v).trim()
  return s ? s : undefined
}

function num(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * 合并一份配置对象（不做 IO，便于单测直接喂对象）。
 * @param {{env?: Record<string,string|undefined>, file?: Record<string,unknown>}} input
 */
export function mergeConfig(input = {}) {
  const env = input.env || {}
  const file = input.file || {}
  const enabledRaw = env.BIT_OFFICE_DISABLED !== undefined ? false : file.enabled
  return {
    // 网络与凭据
    url: str(env.BIT_OFFICE_MCP_URL) || str(file.url) || DEFAULT_URL,
    // token 只从环境变量或本地配置文件取；绝不写进仓库、绝不打印。
    token: str(env.BIT_OFFICE_MCP_TOKEN) || str(file.token) || '',
    timeoutMs: num(env.BIT_OFFICE_TIMEOUT_MS, num(file.timeoutMs, 15000)),
    // 行为
    enabled: enabledRaw === false ? false : true,
    zoneId: str(env.BIT_OFFICE_ZONE) || str(file.zoneId) || OFFICE_ZONE,
    // 同一 agent 的状态上报最快间隔（默认 60s，与需求一致）
    throttleMs: num(env.BIT_OFFICE_THROTTLE_MS, num(file.throttleMs, 60000)),
    // subagent 终态后延迟退休（默认 15 分钟）
    retentionMs: num(env.BIT_OFFICE_RETENTION_MS, num(file.retentionMs, 15 * 60 * 1000)),
    // /api/... 状态读取的本地缓存（避免 client 轮询打爆远端 MCP）
    cacheMs: num(env.BIT_OFFICE_CACHE_MS, num(file.cacheMs, 5000)),
    // 会话记录用哪一区（公司区）
    logLevel: str(env.BIT_OFFICE_LOG) || str(file.logLevel) || 'info',
  }
}

/** 读取 ~/.dsh/dsh-bit-office.json（不存在/非法都当空对象）。 */
export function loadConfigFile(home = os.homedir()) {
  try {
    const file = path.join(home, '.dsh', 'dsh-bit-office.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

/** 进程级配置（Node half 启动时调一次）。 */
export function loadConfig(env = process.env) {
  return mergeConfig({ env, file: loadConfigFile() })
}

/** 打印配置时用的安全摘要：绝不回显 token 全文。 */
export function describeConfig(config) {
  const t = String(config.token || '')
  return {
    url: config.url,
    token: t ? `${t.slice(0, 4)}…${t.slice(-3)}(${t.length})` : '(未配置)',
    zoneId: config.zoneId,
    throttleMs: config.throttleMs,
    retentionMs: config.retentionMs,
    timeoutMs: config.timeoutMs,
  }
}
