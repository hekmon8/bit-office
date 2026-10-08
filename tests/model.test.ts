import {describe,it,expect} from "vitest";
import {demoOffice,executionState,validateOffice,roomSlot,assignActivity} from "../src/model";
describe("independent execution projection",()=>{
 it("keeps running, waiting and blocked facts together",()=>expect(executionState([{id:"a",title:"A",status:"running",blocked:true},{id:"b",title:"B",status:"dispatched"},{id:"c",title:"C",status:"waiting_local_directory"}],true,true)).toEqual({running:1,waiting:2,blocked:1,label:"运行"}));
 it("does not infer idle from incomplete or stale data",()=>{expect(executionState([],false,true).label).toBe("未知");expect(executionState([],true,false).label).toBe("未知");});
 it("ignores terminal tasks",()=>expect(executionState([{id:"a",title:"A",status:"failed",blocked:true}],true,true)).toEqual({running:0,waiting:0,blocked:0,label:"空闲"}));
 it("demo validates and clones data",()=>{const a=demoOffice();expect(validateOffice(a)).toBe(true);a.agents[0].name="changed";expect(demoOffice().agents[0].name).toBe("Nova");});
 it("rejects unsafe persisted colors and broken room references",()=>{const o=demoOffice();o.agents[0].color="red;";expect(validateOffice(o)).toBe(false);o.agents[0].color="#123456";o.agents[0].roomId="missing";expect(validateOffice(o)).toBe(false);});
});

describe("room occupancy and placement",()=>{
 it("keeps every capacity slot and pet footprint within its room",()=>{
  for(const r of demoOffice().rooms)for(let i=0;i<r.capacity;i++){
   const p=roomSlot(r,i);expect(p.x-20).toBeGreaterThan(r.x);expect(p.x+50).toBeLessThan(r.x+r.w);
   expect(p.y-30).toBeGreaterThan(r.y+40);expect(p.y+40).toBeLessThan(r.y+r.h);
  }
 });
 it("uses another meeting room when the first is full",()=>{
  const o=demoOffice(),first=o.rooms.find(r=>r.id==="meeting-a")!;first.capacity=3;
  expect(assignActivity(o,o.agents.find(a=>a.id==="atlas")!,"meeting")).toBe(true);
  expect(o.agents.find(a=>a.id==="atlas")!.roomId).toBe("meeting-b");
 });
 it("refuses a full destination without changing activity or tasks",()=>{
  const o=demoOffice();o.rooms.find(r=>r.id==="pond")!.capacity=2;
  const a=o.agents.find(a=>a.id==="mira")!,before=JSON.stringify(a);
  expect(assignActivity(o,a,"fishing")).toBe(false);expect(JSON.stringify(a)).toBe(before);
 });
 it("can end the initial meeting without overflowing desks",()=>{
  const o=demoOffice();for(const a of o.agents.filter(a=>a.roomId==="meeting-a"))expect(assignActivity(o,a,"working")).toBe(true);
  const r=o.rooms.find(r=>r.id==="desks")!,members=o.agents.filter(a=>a.roomId===r.id);
  expect(members).toHaveLength(5);expect(roomSlot(r,4).y).toBeGreaterThan(roomSlot(r,0).y);
 });
});
