#!/usr/bin/env node
/**
 * 生成 docs/preview/floorplan.svg —— 用**同一份纯函数渲染器**画一张示意图，
 * 供 README 展示与人工视觉自查（不需要浏览器）。
 *
 *   node scripts/make-preview.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderFloorplan } from '../src/floorplan.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/** 演示数据：形状与真实 get_office_state 响应一致（含 zones/rooms/agents/retiredCount）。 */
export const DEMO_STATE = {
  observedAt: '2026-10-14T12:00:00.000Z',
  retiredCount: 3,
  zones: [
    { id: 'home', name: '个人区', description: '个人与演示记录', originY: 30 },
    { id: 'office', name: '公司区', description: 'DSH 会话与子 agent 的工作区', originY: 900 },
  ],
  rooms: [
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
  ],
  agents: [
    { id: 'session-a11b0e17-3747-445b-9203-d0512539f8eb', name: 'ALL_CODE · 539f8eb', color: '#8daff4', activity: 'working', roomId: 'office-desks', zone: 'office', online: true, tasks: [{ id: 't1', title: '写 dsh-bit-office 插件', status: 'running' }] },
    { id: 'session-2f0c9a11-1111-2222-3333-444455556666', name: 'QR模型修复 · 2465152', color: '#8fbf9f', activity: 'working', roomId: 'office-desks', zone: 'office', online: true, tasks: [] },
    { id: 'session-7d3e1b22-aaaa-bbbb-cccc-ddddeeeeffff', name: '门禁虚机回归', color: '#e7b774', activity: 'working', roomId: 'office-desks', zone: 'office', online: true, tasks: [] },
    { id: 'session-child-001', name: '子 agent subagent · ild001', color: '#c9a2e0', activity: 'discussing', roomId: 'office-discussion', zone: 'office', online: true, parentId: 'session-a11b0e17-3747-445b-9203-d0512539f8eb', tasks: [{ id: 't2', title: '并行跑自证测试', status: 'running' }] },
    { id: 'session-child-002', name: '子 agent subagent-fork · ild002', color: '#c9a2e0', activity: 'discussing', roomId: 'office-discussion', zone: 'office', online: true, parentId: 'session-a11b0e17-3747-445b-9203-d0512539f8eb', tasks: [{ id: 't3', title: '写 README', status: 'running', blocked: true }] },
    { id: 'session-9a8b7c6d-5555-6666-7777-888899990000', name: '评审整改 · dsh-gerrit', color: '#e0938a', activity: 'meeting', roomId: 'office-meeting', zone: 'office', online: true, tasks: [] },
    { id: 'session-b1c2d3e4-9999-0000-1111-222233334444', name: '摸鱼中的会话', color: '#8fd0d8', activity: 'fishing', roomId: 'office-pond', zone: 'office', online: true, tasks: [] },
    { id: 'session-deadbeef-0000-1111-2222-333344445555', name: '已结束的旧会话', color: '#9aa3b2', activity: 'offline', roomId: 'office-nest', zone: 'office', online: false, retiredAt: '2026-10-14T11:00:00.000Z', tasks: [{ id: 't4', title: 'subagent · completed', status: 'completed' }] },
    { id: 'agent-home-demo', name: '个人演示记录', color: '#f0c674', activity: 'resting', roomId: 'home-kitchen', zone: 'home', online: true, tasks: [] },
  ],
}

export function previewSvg() {
  return renderFloorplan(DEMO_STATE, {
    highlightId: 'session-a11b0e17-3747-445b-9203-d0512539f8eb',
    idPrefix: 'bo-preview',
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const out = path.join(root, 'docs', 'preview', 'floorplan.svg')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  // 图外底色（viewBox 比地板矩形大一圈）：用真实 <rect> 而不是 CSS background，
  // 否则 Inkscape/ImageMagick 导出 PNG 时背景是透明的。
  const svg = `${previewSvg().replace(
    /(<svg[^>]*>)/,
    '$1<rect x="0" y="0" width="1260" height="1724" fill="#171c21"/>',
  )}\n`
  fs.writeFileSync(out, svg, 'utf8')
  console.log(`wrote ${path.relative(root, out)} (${svg.length} bytes)`)
}
