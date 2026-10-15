/**
 * dsh-bit-office — 平面图渲染器（无依赖纯函数模块）
 *
 * 输入：bit-office 的办公室状态 JSON（agents/rooms/zones/retiredCount）
 * 输出：SVG 字符串（可直接 innerHTML 到容器）
 *
 * 约束：
 *   - **零依赖、零 DOM、零 node: 模块**——同一份代码既能在 Node 里单测，
 *     也能被 client bundle 内联后直接在浏览器跑（构建脚本负责内联）。
 *   - 视觉对齐 bit-office 官方页面：深色地板 #252a2f、房间描边 #65676b、
 *     宠物 = 方块 + 眼睛；zone 分区带按 originY 自上而下堆叠。
 *   - 所有样式写成 SVG presentation attribute（不依赖宿主 CSS，避免被覆盖）。
 */

/** activity → 中文标签（与 bit-office 一致）。 */
export const ACTIVITY_LABELS = {
  working: '工作中',
  meeting: '开会',
  discussing: '讨论',
  resting: '休息',
  fishing: '摸鱼',
  offline: '离线',
}

export function activityLabel(activity) {
  return ACTIVITY_LABELS[activity] || ACTIVITY_LABELS.offline
}

/** 房间按 kind 的底色（与 bit-office 同色系）。 */
const ROOM_FILL = {
  meeting: '#2e2d37',
  discussing: '#31342e',
  fishing: '#263338',
  offline: '#282b34',
  resting: '#303333',
  working: '#303333',
}

/** 默认 zone（服务端未下发 zones 时的兜底，保证图不空）。 */
const DEFAULT_ZONES = [
  { id: 'home', name: '个人区', description: '个人与演示记录', originY: 30 },
  { id: 'office', name: '公司区', description: 'DSH 会话与子 agent 的工作区', originY: 900 },
]

/** 默认房间目录：每个 (zone, activity) 至少有一个房，保证任何上报都有落点。 */
const DEFAULT_ROOMS = [
  { id: 'office-desks', name: '公司工位', kind: 'working', capacity: 16, columns: 4, x: 30, y: 900, w: 560, h: 400, zone: 'office' },
  { id: 'office-discussion', name: '公司讨论室', kind: 'discussing', capacity: 10, columns: 2, x: 610, y: 900, w: 300, h: 400, zone: 'office' },
  { id: 'office-meeting', name: '公司会议室', kind: 'meeting', capacity: 8, columns: 4, x: 930, y: 900, w: 290, h: 400, zone: 'office' },
  { id: 'office-kitchen', name: '公司茶水间', kind: 'resting', capacity: 6, columns: 3, x: 30, y: 1330, w: 240, h: 340, zone: 'office' },
  { id: 'office-pond', name: '公司摸鱼区', kind: 'fishing', capacity: 4, columns: 2, x: 290, y: 1330, w: 240, h: 340, zone: 'office' },
  { id: 'office-nest', name: '公司充电窝', kind: 'offline', capacity: 20, columns: 5, x: 550, y: 1330, w: 360, h: 340, zone: 'office' },
  { id: 'home-desks', name: '个人工位', kind: 'working', capacity: 8, columns: 4, x: 30, y: 30, w: 430, h: 290, zone: 'home' },
  { id: 'home-kitchen', name: '茶水间', kind: 'resting', capacity: 4, columns: 2, x: 480, y: 30, w: 205, h: 290, zone: 'home' },
  { id: 'home-pond', name: '摸鱼区', kind: 'fishing', capacity: 4, columns: 2, x: 705, y: 30, w: 240, h: 290, zone: 'home' },
  { id: 'home-nest', name: '充电窝', kind: 'offline', capacity: 4, columns: 2, x: 965, y: 30, w: 230, h: 290, zone: 'home' },
]

/* ------------------------------------------------------------------ 工具 */

/** XML 文本转义（导出以便单测）。 */
export function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

function pickArray(...candidates) {
  for (const c of candidates) if (Array.isArray(c)) return c
  return []
}

/**
 * 把各种可能的 MCP/get_office_state 包法归一成 { agents, rooms, zones, retiredCount }。
 * 容忍：直接对象 / { office } / { state } / { data } / { result } 嵌套。
 */
export function normalizeState(input) {
  let node = input
  for (let i = 0; i < 4 && node && typeof node === 'object'; i += 1) {
    if (Array.isArray(node.agents) || Array.isArray(node.rooms) || Array.isArray(node.zones)) break
    const next = node.office ?? node.state ?? node.data ?? node.result ?? node.snapshot
    if (!next || typeof next !== 'object') break
    node = next
  }
  const src = node && typeof node === 'object' ? node : {}
  return {
    agents: pickArray(src.agents),
    rooms: pickArray(src.rooms),
    zones: pickArray(src.zones),
    retiredCount: isFiniteNumber(src.retiredCount) ? src.retiredCount : Number(src.retiredCount) || 0,
    observedAt: src.observedAt || src.observed_at || '',
  }
}

/** 记录是否已退休。 */
export function isRetired(agent) {
  if (!agent || typeof agent !== 'object') return false
  return Boolean(agent.retiredAt || agent.retired_at || agent.retired === true)
}

/** 记录所属 zone（新契约 zone 字段；旧记录按 room 反查）。 */
export function zoneOf(agent, rooms, fallback = 'office') {
  const direct = String(agent?.zone ?? agent?.zone_id ?? agent?.zoneId ?? '')
  if (direct) return direct
  const room = rooms.find((r) => r && r.id === agent?.roomId)
  if (room && room.zone) return room.zone
  return fallback
}

/** 记录所属 facility kind（由 room 反查；room 缺失时按 activity 推断）。 */
export function kindOf(agent, rooms) {
  const room = rooms.find((r) => r && r.id === agent?.roomId)
  if (room && room.kind) return room.kind
  const a = String(agent?.activity ?? 'offline')
  return ACTIVITY_LABELS[a] ? a : 'working'
}

/** 同 kind 的房间列数（沿用 bit-office 的格子口径）。 */
export function roomColumns(room) {
  if (isFiniteNumber(room?.columns) && room.columns > 0) return Math.floor(room.columns)
  const kind = room?.kind
  return kind === 'working' ? 4 : kind === 'meeting' ? 4 : 2
}

/** 第 index 个工位在房间内的坐标（与 bit-office 的 roomSlot 同构）。 */
export function roomSlot(room, index) {
  const columns = Math.max(1, roomColumns(room))
  const capacity = Math.max(1, Number(room.capacity) || columns)
  const rows = Math.max(1, Math.ceil(capacity / columns))
  const col = index % columns
  const row = Math.floor(index / columns)
  return {
    x: room.x + 40 + (room.w - 80) * (col + 0.5) / columns,
    y: room.y + 76 + (room.h - 132) * (row + 0.5) / rows,
  }
}

/** 房间几何是否可用（服务端旧部署可能不给 x/y/w/h）。 */
function hasGeometry(room) {
  return isFiniteNumber(room?.x) && isFiniteNumber(room?.y)
    && isFiniteNumber(room?.w) && isFiniteNumber(room?.h)
    && room.w > 0 && room.h > 0
}

/**
 * 布局：产出可直接渲染的模型。
 *
 * @param {object} input 状态 JSON（任意包法）
 * @param {object} [opts]
 * @param {string} [opts.highlightId] 需要高亮的 agent id（通常是当前会话）
 * @returns {{width:number,height:number,zones:Array,rooms:Array,pets:Array,links:Array,stats:object}}
 */
export function layoutFloorplan(input, opts = {}) {
  const state = normalizeState(input)
  // zone 表：服务端有就用，没有就兜底；同时保证 agent 引用的 zone 一定存在。
  const zoneMap = new Map()
  for (const z of DEFAULT_ZONES) zoneMap.set(z.id, { ...z })
  for (const z of state.zones) {
    if (!z || typeof z !== 'object') continue
    const id = String(z.id ?? z.zone_id ?? '')
    if (!id) continue
    zoneMap.set(id, {
      id,
      name: String(z.name ?? id),
      description: String(z.description ?? ''),
      originY: isFiniteNumber(z.originY) ? z.originY : (isFiniteNumber(z.origin_y) ? z.origin_y : 30),
    })
  }

  const rooms = state.rooms.filter((r) => r && typeof r === 'object').map((r) => ({
    ...r,
    id: String(r.id ?? r.room_id ?? ''),
    name: String(r.name ?? r.id ?? ''),
    kind: String(r.kind ?? r.activity ?? 'working'),
    capacity: Math.max(1, Number(r.capacity) || roomColumns(r)),
    zone: String(r.zone ?? zoneMap.keys().next().value),
  }))
  const usable = rooms.filter(hasGeometry)
  const catalog = usable.length ? usable : DEFAULT_ROOMS.map((r) => ({ ...r, capacity: Math.max(1, Number(r.capacity) || 4) }))
  if (!usable.length) {
    for (const r of catalog) {
      if (!zoneMap.has(r.zone)) zoneMap.set(r.zone, { id: r.zone, name: r.zone, description: '', originY: 30 })
    }
  }
  // 服务端下发的 zone 引用若在 catalog 中缺失，也补进 zone 表
  for (const r of catalog) {
    if (!zoneMap.has(r.zone)) {
      const ref = rooms.find((x) => x.id === r.id)
      const name = ref?.name ? String(ref.name) : r.zone
      zoneMap.set(r.zone, { id: r.zone, name, description: '', originY: Math.max(30, 900) })
    }
  }

  const agents = state.agents.filter((a) => a && typeof a === 'object' && String(a.id ?? a.agent_id ?? ''))
  const normalizedAgents = agents.map((a) => ({
    raw: a,
    id: String(a.id ?? a.agent_id),
    name: String(a.name ?? a.id ?? ''),
    color: /^#[0-9a-f]{6}$/i.test(String(a.color ?? '')) ? String(a.color) : '#8daff4',
    activity: String(a.activity ?? 'offline'),
    online: a.online !== false,
    roomId: String(a.roomId ?? a.room_id ?? ''),
    tasks: Array.isArray(a.tasks) ? a.tasks : [],
    parentId: String(a.parentId ?? a.parent_id ?? ''),
    retired: isRetired(a),
    lastSeenAt: a.lastSeenAt || a.last_seen_at || null,
  }))

  // 分配工位：优先按 roomId，roomId 无效时按 (zone, activity) 找房。
  const occupancy = new Map()
  const pets = []
  for (const agent of normalizedAgents) {
    const zone = zoneOf(agent.raw, catalog, 'office')
    const kind = kindOf(agent.raw, catalog)
    let room = catalog.find((r) => r.id === agent.roomId && r.zone === zone)
      || catalog.find((r) => r.id === agent.roomId)
      || catalog.find((r) => r.zone === zone && r.kind === kind)
      || catalog.find((r) => r.zone === zone && r.kind === 'working')
      || catalog.find((r) => r.zone === zone)
      || catalog[0]
    if (!room) continue
    const used = occupancy.get(room.id) || 0
    occupancy.set(room.id, used + 1)
    const slot = roomSlot(room, used % room.capacity)
    pets.push({
      id: agent.id,
      name: agent.name,
      color: agent.color,
      activity: agent.activity,
      activityLabel: activityLabel(agent.activity),
      online: agent.online,
      retired: agent.retired,
      kind,
      zone,
      roomId: room.id,
      parentId: agent.parentId,
      x: slot.x,
      y: slot.y,
      tasks: agent.tasks,
      running: agent.tasks.filter((t) => t && t.status === 'running').length,
      blocked: agent.tasks.filter((t) => t && t.blocked && !['completed', 'failed', 'cancelled'].includes(String(t.status))).length,
      highlight: Boolean(opts.highlightId) && agent.id === String(opts.highlightId),
    })
    // 退休记录不占位：从占用数里退回一个名额（视觉上仍画出，但标暗）
    if (agent.retired) occupancy.set(room.id, Math.max(0, used))
  }

  const byId = new Map(pets.map((p) => [p.id, p]))
  const links = []
  for (const pet of pets) {
    if (!pet.parentId) continue
    const parent = byId.get(pet.parentId)
    if (!parent) continue
    links.push({ from: { x: parent.x, y: parent.y }, to: { x: pet.x, y: pet.y }, childId: pet.id, parentId: parent.id, delegating: true })
  }

  const layoutRooms = catalog.map((r) => ({ ...r, occupants: pets.filter((p) => p.roomId === r.id) }))
  const width = Math.max(1260, ...layoutRooms.map((r) => r.x + r.w + 40), 1260)
  const maxRoomBottom = Math.max(720, ...layoutRooms.map((r) => r.y + r.h + 35))
  // zone 带自上而下堆叠：每个 zone 从其 originY 起覆盖自己的房间
  const zones = [...zoneMap.values()].sort((a, b) => a.originY - b.originY).map((z) => {
    const own = layoutRooms.filter((r) => r.zone === z.id)
    const top = own.length ? Math.min(...own.map((r) => r.y)) : z.originY
    const bottom = own.length ? Math.max(...own.map((r) => r.y + r.h)) : z.originY + 300
    return {
      id: z.id,
      name: z.name,
      description: z.description,
      originY: z.originY,
      y: top - 34,
      h: Math.max(60, bottom - top + 68),
    }
  })
  const height = Math.max(maxRoomBottom, ...zones.map((z) => z.y + z.h + 20))

  return {
    width,
    height,
    zones,
    rooms: layoutRooms,
    pets,
    links,
    stats: {
      agents: pets.length,
      active: pets.filter((p) => !p.retired).length,
      retired: state.retiredCount || pets.filter((p) => p.retired).length,
      zones: zones.length,
      rooms: layoutRooms.length,
      observedAt: state.observedAt,
    },
  }
}

/* ------------------------------------------------------------- SVG 渲染 */

/** 一个 agent 的「像素宠物」：方块身体 + 眼睛 + 状态点 + 活动小图标。 */
export function renderPet(pet) {
  const sleepy = pet.activity === 'offline' || pet.retired
  const opacity = pet.retired ? '.42' : sleepy ? '.6' : '1'
  const eye = sleepy ? 'M-8 -2h5M3 -2h5' : 'M-7 -4v4M6 -4v4'
  const badge = pet.activity === 'meeting' || pet.activity === 'discussing'
    ? '<path d="M14 -26h18v12H20l-4 5v-5h-2z" fill="#666b78"/><path d="M18 -21h10" stroke="#dadde3" stroke-width="2"/>'
    : ''
  const cup = pet.activity === 'resting' ? '<path d="M11 6h9v8h-9zM20 8h4v4h-4" fill="#d2af77"/>' : ''
  const rod = pet.activity === 'fishing' ? '<path d="M15 10l18 -29 17 17" stroke="#baac91" fill="none" stroke-width="2"/>' : ''
  const zzz = sleepy ? '<text x="20" y="-14" fill="#b5b0c8" font-size="15">z</text>' : ''
  const ring = pet.highlight
    ? '<rect x="-24" y="-24" width="48" height="48" rx="8" fill="none" stroke="#c5b3ee" stroke-width="2.5"/>'
    : ''
  const label = pet.highlight ? `${escapeXml(pet.name)}(本会话)` : escapeXml(pet.name)
  const taskMark = pet.blocked
    ? '<text x="-30" y="-16" fill="#e5b497" font-size="13">!</text>'
    : pet.running
      ? '<text x="-30" y="-16" fill="#88b9a0" font-size="12">▶</text>'
      : ''
  return `<g transform="translate(${round(pet.x)} ${round(pet.y)})" class="bo-pet${pet.highlight ? ' bo-pet-current' : ''}" data-agent="${escapeXml(pet.id)}" data-retired="${pet.retired ? '1' : '0'}">`
    + ring
    + taskMark
    + `<rect x="-14" y="-13" width="28" height="27" rx="4" fill="${pet.color}" opacity="${opacity}"/>`
    + `<path d="${eye}" stroke="#14171b" stroke-width="3" fill="none"/>`
    + badge + cup + rod + zzz
    + `<circle cx="13" cy="14" r="3" fill="${pet.online && !pet.retired ? '#88b9a0' : '#676d7a'}"/>`
    + `<text y="30" text-anchor="middle" fill="${pet.highlight ? '#e7e2f5' : '#d6d7de'}" font-size="11">${label}</text>`
    + `<title>${escapeXml(`${pet.name} · ${pet.activityLabel}${pet.retired ? ' · 已退休' : ''} · ${pet.zone}/${pet.roomId}`)}</title>`
    + '</g>'
}

function round(n) {
  return Math.round(Number(n) * 10) / 10
}

/**
 * 渲染整张平面图为 SVG 字符串。
 *
 * @param {object} input 状态 JSON
 * @param {object} [opts]
 * @param {string} [opts.highlightId] 高亮的 agent id（当前会话）
 * @param {boolean} [opts.showLinks=true] 是否画父子/委托连线
 * @param {string} [opts.idPrefix='bo'] SVG 内部 id 前缀（同页多张图不撞 id）
 */
export function renderFloorplan(input, opts = {}) {
  const model = layoutFloorplan(input, opts)
  const prefix = String(opts.idPrefix || 'bo')
  const showLinks = opts.showLinks !== false
  const { width, height } = model

  const zoneBands = model.zones.map((z) => `<g class="bo-zone" data-zone="${escapeXml(z.id)}">`
    + `<rect x="14" y="${round(z.y)}" width="${round(width - 28)}" height="${round(z.h)}" rx="10" fill="#ffffff" fill-opacity="0.022" stroke="#4b5158" stroke-width="1.5" stroke-dasharray="10 7"/>`
    + `<text x="28" y="${round(z.y + 21)}" fill="#808793" font-size="12" letter-spacing="3">${escapeXml(z.name)}</text>`
    + (z.description ? `<text x="132" y="${round(z.y + 21)}" fill="#5f6672" font-size="11">${escapeXml(z.description)}</text>` : '')
    + '</g>').join('\n')

  const roomShapes = model.rooms.map((r) => {
    const fill = ROOM_FILL[r.kind] || ROOM_FILL.working
    const count = `${r.occupants.filter((p) => !p.retired).length}/${r.capacity}`
    return `<g class="bo-room" data-room="${escapeXml(r.id)}" data-kind="${escapeXml(r.kind)}">`
      + `<rect x="${round(r.x)}" y="${round(r.y)}" width="${round(r.w)}" height="${round(r.h)}" rx="3" fill="${fill}" stroke="#65676b" stroke-width="5"/>`
      + `<path d="M${round(r.x + 30)} ${round(r.y + 5)}h${round(Math.min(r.w - 60, 120))}" stroke="#658591" stroke-width="4"/>`
      + `<text x="${round(r.x + 18)}" y="${round(r.y + 35)}" fill="#c3c6ce" font-size="14">${escapeXml(r.name)}</text>`
      + `<text x="${round(r.x + r.w - 18)}" y="${round(r.y + 35)}" text-anchor="end" fill="#949aab" font-size="11">${count}</text>`
      + `<path d="M${round(r.x + r.w / 2 - 24)} ${round(r.y + r.h)}h48" stroke="#252a2f" stroke-width="7"/>`
      + '</g>'
  }).join('\n')

  const linkShapes = showLinks && model.links.length
    ? `<g class="bo-links">${model.links.map((l) => `<line x1="${round(l.from.x)}" y1="${round(l.from.y)}" x2="${round(l.to.x)}" y2="${round(l.to.y)}" stroke="#7d8ba1" stroke-width="1.6" stroke-dasharray="5 5" opacity="0.75"/>`).join('')}</g>`
    : ''

  const pets = model.pets.map((p) => renderPet(p)).join('\n')

  return `<svg class="bo-floorplan" viewBox="0 0 ${round(width)} ${round(height)}" width="100%" role="img" aria-label="bit-office 办公室平面图" xmlns="http://www.w3.org/2000/svg">`
    + `<defs><pattern id="${escapeXml(prefix)}-tiles" width="22" height="22" patternUnits="userSpaceOnUse"><path d="M22 0H0V22" fill="none" stroke="#353a40" stroke-width="0.5"/></pattern></defs>`
    + `<rect x="8" y="8" width="${round(width - 16)}" height="${round(height - 25)}" rx="8" fill="#252a2f" stroke="#62676e" stroke-width="8"/>`
    + `<rect x="16" y="16" width="${round(width - 32)}" height="${round(height - 41)}" fill="url(#${escapeXml(prefix)}-tiles)" opacity="0.55"/>`
    + zoneBands
    + roomShapes
    + linkShapes
    + `<g class="bo-pets">${pets}</g>`
    + `</svg>`
}

/** 便于在无数据时给出可读空态（client 与远端都可用）。 */
export function emptyStateNote(model) {
  if (!model || !model.stats) return '办公室暂无数据'
  if (!model.stats.agents) return '办公室还没有登记任何 agent（本会话登记后会立即出现）'
  return ''
}
