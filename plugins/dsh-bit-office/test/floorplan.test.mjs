/**
 * 自证测试 ⑥：房间/分区 → 平面图 SVG 纯函数（无 DOM、无依赖）
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  escapeXml,
  layoutFloorplan,
  normalizeState,
  renderFloorplan,
  roomSlot,
} from '../src/floorplan.mjs'

const OFFICE = {
  observedAt: '2026-10-14T12:00:00.000Z',
  zones: [
    { id: 'home', name: '个人区', description: '个人与演示记录', originY: 30 },
    { id: 'office', name: '公司区', description: 'DSH 会话与子 agent 的工作区', originY: 900 },
  ],
  rooms: [
    { id: 'office-desks', name: '公司工位', kind: 'working', capacity: 4, x: 30, y: 900, w: 560, h: 400, zone: 'office' },
    { id: 'office-discussion', name: '公司讨论室', kind: 'discussing', capacity: 2, x: 610, y: 900, w: 300, h: 400, zone: 'office' },
  ],
  agents: [
    { id: 'session-root-000001', name: '父会话', color: '#8daff4', activity: 'working', roomId: 'office-desks', zone: 'office', online: true, tasks: [] },
    { id: 'session-child-000002', name: '<子 agent & "危险">', color: '#e7b774', activity: 'discussing', roomId: 'office-discussion', zone: 'office', online: true, parentId: 'session-root-000001', tasks: [{ id: 't1', title: '干活', status: 'running' }] },
  ],
  retiredCount: 1,
}

describe('平面图纯函数 —— 布局', () => {
  it('normalizeState 容忍各种包法（直接 / office / state / data）', () => {
    assert.equal(normalizeState({ agents: [] }).agents.length, 0)
    assert.equal(normalizeState({ office: { agents: [1] } }).agents.length, 1)
    assert.equal(normalizeState({ state: { rooms: [1, 2] } }).rooms.length, 2)
    assert.equal(normalizeState({ data: { zones: [1] } }).zones.length, 1)
    assert.equal(normalizeState(null).agents.length, 0)
    assert.equal(normalizeState({ result: { retiredCount: 3 } }).retiredCount, 3)
  })

  it('zone / 房间 / 宠物都被布局出来，占用数按房间归集', () => {
    const model = layoutFloorplan(OFFICE, { highlightId: 'session-root-000001' })
    assert.equal(model.zones.length, 2)
    assert.deepEqual(model.zones.map((z) => z.name), ['个人区', '公司区'])
    assert.equal(model.rooms.length, 2)
    assert.equal(model.rooms.find((r) => r.id === 'office-desks').occupants.length, 1)
    assert.equal(model.pets.length, 2)
    assert.equal(model.stats.agents, 2)
    assert.equal(model.stats.retired, 1)
  })

  it('宠物按 roomSlot 落在房间里（坐标在房间矩形内）', () => {
    const model = layoutFloorplan(OFFICE)
    const room = model.rooms.find((r) => r.id === 'office-desks')
    const pet = model.pets.find((p) => p.roomId === 'office-desks')
    assert.ok(pet.x > room.x && pet.x < room.x + room.w)
    assert.ok(pet.y > room.y && pet.y < room.y + room.h)
    const slot = roomSlot(room, 0)
    assert.equal(pet.x, slot.x)
  })

  it('父子/委托关系产出连线（无 parent 则不画）', () => {
    const model = layoutFloorplan(OFFICE)
    assert.equal(model.links.length, 1)
    assert.equal(model.links[0].parentId, 'session-root-000001')
    assert.equal(model.links[0].childId, 'session-child-000002')
    const noParent = layoutFloorplan({ ...OFFICE, agents: [OFFICE.agents[0]] })
    assert.equal(noParent.links.length, 0)
  })

  it('当前会话高亮：只有匹配 highlightId 的宠物被标记', () => {
    const model = layoutFloorplan(OFFICE, { highlightId: 'session-child-000002' })
    assert.deepEqual(model.pets.map((p) => p.highlight), [false, true])
  })

  it('roomId 失效时按 (zone, activity) 兜底找房，绝不丢宠物', () => {
    const model = layoutFloorplan({
      ...OFFICE,
      agents: [{ id: 'a1', name: 'A', color: '#8daff4', activity: 'discussing', roomId: '不存在的房', zone: 'office' }],
    })
    assert.equal(model.pets.length, 1)
    assert.equal(model.pets[0].roomId, 'office-discussion')
  })

  it('服务端没给 rooms/几何 → 用内置目录兜底（图不为空）', () => {
    const model = layoutFloorplan({ agents: [{ id: 'a1', name: 'A', activity: 'working', zone: 'office' }] })
    assert.ok(model.rooms.length >= 4)
    assert.equal(model.pets.length, 1)
    assert.ok(model.rooms.some((r) => r.id.startsWith('office-')))
    // 有 rooms 但没有几何（旧部署）
    const noGeom = layoutFloorplan({ rooms: [{ id: 'x', name: 'X', zone: 'office', kind: 'working', capacity: 2 }], agents: [] })
    assert.ok(noGeom.rooms.every((r) => Number.isFinite(r.x)))
  })

  it('已退休记录仍画出但不占工位名额', () => {
    const model = layoutFloorplan({
      ...OFFICE,
      agents: [
        { id: 'a1', name: '活跃', activity: 'working', roomId: 'office-desks', zone: 'office' },
        { id: 'a2', name: '已退休', activity: 'offline', roomId: 'office-desks', zone: 'office', retiredAt: '2026-10-14T00:00:00Z' },
      ],
    })
    assert.equal(model.pets.length, 2)
    assert.equal(model.rooms.find((r) => r.id === 'office-desks').occupants.filter((p) => !p.retired).length, 1)
  })
})

describe('平面图纯函数 —— SVG 渲染', () => {
  it('包含深色地板 / 房间描边 / 房间名与占用数 / zone 带（视觉对齐 bit-office）', () => {
    const svg = renderFloorplan(OFFICE)
    assert.match(svg, /<svg /)
    assert.match(svg, /fill="#252a2f"/, '深色地板')
    assert.match(svg, /stroke="#65676b"/, '房间描边')
    assert.match(svg, /公司工位/)
    assert.match(svg, />1\/4</, '房间占用数 1/4')
    assert.match(svg, /公司区/)
    assert.match(svg, /个人区/)
    assert.match(svg, /class="bo-zone"/)
    assert.match(svg, /<title>/, '宠物带 title 便于悬停')
  })

  it('每个 agent 一个小方块宠物 + 眼睛；离线画 zzz', () => {
    const svg = renderFloorplan(OFFICE)
    assert.equal((svg.match(/data-agent="/g) || []).length, 2)
    assert.match(svg, /stroke="#14171b" stroke-width="3"/, '眼睛')
    const sleepy = renderFloorplan({
      ...OFFICE,
      agents: [{ id: 'a1', name: '睡', activity: 'offline', roomId: 'office-desks', zone: 'office' }],
    })
    assert.match(sleepy, />z</)
  })

  it('当前会话有高亮环与「本会话」标注', () => {
    const svg = renderFloorplan(OFFICE, { highlightId: 'session-root-000001' })
    assert.match(svg, /class="bo-pet bo-pet-current"/)
    assert.match(svg, /本会话/)
    assert.match(svg, /stroke="#c5b3ee"/)
  })

  it('父子/委托关系渲染成虚线并可用 showLinks=false 关闭', () => {
    assert.match(renderFloorplan(OFFICE), /class="bo-links"/)
    assert.doesNotMatch(renderFloorplan(OFFICE, { showLinks: false }), /class="bo-links"/)
  })

  it('所有动态文本都做 XML 转义（防注入 / 破图）', () => {
    const svg = renderFloorplan(OFFICE)
    assert.doesNotMatch(svg, /<子 agent/)
    assert.match(svg, /&lt;子 agent &amp; &quot;危险&quot;&gt;/)
    assert.equal(escapeXml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  })

  it('空状态：不抛异常、仍返回合法 SVG 与默认房间', () => {
    const svg = renderFloorplan(null)
    assert.match(svg, /<svg /)
    assert.match(svg, /公司工位/)
    assert.equal(layoutFloorplan(undefined).pets.length, 0)
    const weird = renderFloorplan({ agents: [null, 42, {}], rooms: 'nope', zones: 3 })
    assert.match(weird, /<svg /)
    assert.doesNotMatch(weird, /data-agent="/)
  })

  it('renderFloorplan 是纯函数：同一输入两次输出完全一致（可缓存/可对比）', () => {
    assert.equal(renderFloorplan(OFFICE), renderFloorplan(OFFICE))
  })

  it('idPrefix 隔离同页多张图的 SVG 内部 id', () => {
    assert.match(renderFloorplan(OFFICE, { idPrefix: 'tab' }), /id="tab-tiles"/)
    assert.match(renderFloorplan(OFFICE, { idPrefix: 'tab' }), /url\(#tab-tiles\)/)
  })
})
