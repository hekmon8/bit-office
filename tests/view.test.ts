import {describe,it,expect} from "vitest";
import {readFreshness,layoutRoom} from "../src/view";
describe("source freshness stays separate from local demo activity",()=>{
 const now=Date.parse("2026-10-08T10:00:00Z");
 it("labels built-in fallback without claiming a successful server read",()=>{
  expect(readFreshness(null,false,now).label).toContain("未读取服务器");
  expect(readFreshness(null,true,now).label).toContain("服务器读取失败");
 });
 it("expires a previously successful snapshot after two minutes",()=>{
  expect(readFreshness("2026-10-08T09:58:00Z",false,now).stale).toBe(false);
  expect(readFreshness("2026-10-08T09:57:59Z",false,now).stale).toBe(true);
 });
 it("treats invalid and future read times as uncertain",()=>{
  expect(readFreshness("invalid",false,now).stale).toBe(true);
  expect(readFreshness("2026-10-08T10:01:00Z",false,now).stale).toBe(true);
 });
});

import {demoOffice,roomSlot} from "../src/model";
describe("display hit regions remain disjoint at full occupancy",()=>{
 it("separates adjacent pets and desks without changing server geometry",()=>{
  const office=demoOffice();
  for(const room of office.rooms){
   const before={...room},display=layoutRoom(room),slots=Array.from({length:room.capacity},(_,i)=>roomSlot(display,i));
   expect(room).toEqual(before);
   for(let a=0;a<slots.length;a++)for(let b=a+1;b<slots.length;b++){
    const dx=Math.abs(slots[a].x-slots[b].x),dy=Math.abs(slots[a].y-slots[b].y);
    expect(dx>=48||dy>=48).toBe(true);
    if(room.kind==="working")expect(dx>=76||dy>=64).toBe(true);
   }
  }
 });
});


import {fitViewport,constrainPan} from "../src/view";
describe("full-scene camera on mobile and resized viewports",()=>{
 it.each([[390,620],[393,700],[430,800],[844,250],[1440,868]])("fits all rooms at %i×%i",(width,height)=>{
  const c=fitViewport(width,height,1260,884);
  expect(c.width).toBeGreaterThanOrEqual(1260);
  expect(c.height).toBeGreaterThanOrEqual(884);
  expect(c.width/c.height).toBeCloseTo(width/height);
  expect(1260*c.scale).toBeLessThanOrEqual(width+.001);
  expect(884*c.scale).toBeLessThanOrEqual(height+.001);
 });
 it("centers the full map instead of restoring a clipped mobile entrance",()=>{
  const c=fitViewport(393,620,1260,884);
  expect(constrainPan(-200,c.width,1260)).toBe(0);
  expect(constrainPan(-73,c.height,884)).toBeCloseTo((c.height-884)/2);
 });
 it("bounds a panned zoomed map after orientation or height changes",()=>{
  expect(constrainPan(200,1260,2520)).toBe(0);
  expect(constrainPan(-5000,1260,2520)).toBe(-1260);
  expect(constrainPan(-350,1260,2520)).toBe(-350);
  for(const height of [620,700,800]){
   const c=fitViewport(393,height,1260,884),y=constrainPan(-5000,c.height,884*3);
   expect(y).toBeGreaterThanOrEqual(Math.min(0,c.height-884*3));
   expect(y).toBeLessThanOrEqual(Math.max(0,(c.height-884*3)/2));
  }
 });
});


import {compactRoomLabel} from "../src/view";
describe("maximum-expansion overview labels",()=>{
 it("wraps narrow room names instead of colliding with capacity",()=>{
  expect(compactRoomLabel("会议室 C",280*369/3380)).toEqual(["会议","室C"]);
  expect(compactRoomLabel("茶水间",205*369/3380)).toEqual(["茶","水","间"]);
  expect(compactRoomLabel("开放工位",430*369/3380)).toEqual(["开放工位"]);
 });
});
