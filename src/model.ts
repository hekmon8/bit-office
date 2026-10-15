export const activities = ["working", "meeting", "discussing", "resting", "fishing", "offline"] as const;
export type Activity = typeof activities[number];
export type TaskStatus = "queued" | "dispatched" | "waiting_local_directory" | "running" | "completed" | "failed" | "cancelled";
export interface Task { id: string; title: string; status: TaskStatus; blocked?: boolean; delegatedFrom?: string; handoffNote?: string; updatedAt?: string; handoffAt?: string; }
/**
 * One fitted room on the single floor plan. `zone` groups rooms into an area
 * (personal / company); `columns` overrides the per-kind desk grid so a wide
 * company room can host more members without overlapping their footprints.
 */
export interface Room { id:string; name:string; kind:Activity; topic:string; capacity:number; x:number; y:number; w:number; h:number; zone:string; columns?:number; }
/**
 * One persistent Agent record. `parentId` links a delegated child (a DSH
 * subagent) to the session that spawned it; `retiredAt` marks a soft-retired
 * record that keeps its history but no longer occupies a room slot.
 */
export interface Agent { id:string; name:string; color:string; activity:Activity; roomId:string; zone:string; online:boolean; tasks:Task[]; lastSeenAt:string|null; parentId?:string|null; depth?:number; retiredAt?:string|null; retireReason?:string; }
/** A named area of the floor plan; `originY` is the layout band the zone occupies. */
export interface Zone { id:string; name:string; description:string; originY:number; }
export interface Office {mode:"demo";source:"synthetic";observedAt:string;agents:Agent[];rooms:Room[];zones:Zone[];events:{at:string;message:string}[];}
export const labels:Record<Activity,string>={working:"工作中",meeting:"开会",discussing:"讨论",resting:"休息",fishing:"摸鱼",offline:"离线"};
/** Zone a record belongs to when the caller names neither a zone nor a room. */
export const defaultZoneId="home";
/** Zone the DSH company fleet lives in. */
export const officeZoneId="office";
export function executionState(tasks:Task[], complete:boolean, fresh:boolean) {
 const running=tasks.filter(t=>t.status==="running").length;
 const waiting=tasks.filter(t=>["queued","dispatched","waiting_local_directory"].includes(t.status)).length;
 return {running,waiting,blocked:tasks.filter(t=>t.blocked && !["completed","failed","cancelled"].includes(t.status)).length,
  label:running?"运行":waiting?"等待":complete&&fresh?"空闲":"未知"};
}
/** Areas are data, not rendering switchboards: the floor stacks them top to bottom. */
export function defaultZones():Zone[]{
 return [
  {id:defaultZoneId,name:"个人区",description:"个人与演示记录",originY:30},
  {id:officeZoneId,name:"公司区",description:"DSH 会话与子 agent 的工作区",originY:900}
 ];
}
export function homeRooms():Room[]{
 return [
  {id:"meeting-a",name:"会议室 A",kind:"meeting",topic:"Q4 路线图评审",capacity:8,x:30,y:30,w:310,h:260,zone:defaultZoneId},
  {id:"discussion",name:"讨论室 1",kind:"discussing",topic:"缓存失效方案",capacity:6,x:360,y:30,w:300,h:260,zone:defaultZoneId},
  {id:"meeting-b",name:"会议室 B",kind:"meeting",topic:"空闲",capacity:8,x:680,y:30,w:290,h:260,zone:defaultZoneId},
  {id:"desks",name:"开放工位",kind:"working",topic:"固定工位 · 16 席",capacity:16,x:30,y:385,w:430,h:290,zone:defaultZoneId},
  {id:"kitchen",name:"茶水间",kind:"resting",topic:"咖啡与片刻休息",capacity:4,x:480,y:385,w:205,h:290,zone:defaultZoneId},
  {id:"pond",name:"摸鱼区",kind:"fishing",topic:"小池塘 · 演示动作",capacity:4,x:705,y:385,w:240,h:290,zone:defaultZoneId},
  {id:"nest",name:"充电窝",kind:"offline",topic:"离线宠物的窝",capacity:4,x:990,y:385,w:230,h:290,zone:defaultZoneId}
 ];
}
/** The company area: one room per activity kind so any reported activity has a destination. */
export function officeRooms():Room[]{
 return [
  {id:"office-desks",name:"工位区",kind:"working",topic:"DSH 会话",capacity:16,columns:4,x:30,y:900,w:560,h:400,zone:officeZoneId},
  {id:"office-discussion",name:"协作讨论室",kind:"discussing",topic:"子 agent 协作",capacity:10,columns:2,x:610,y:900,w:300,h:400,zone:officeZoneId},
  {id:"office-meeting",name:"评审会议室",kind:"meeting",topic:"评审与对齐",capacity:8,columns:4,x:930,y:900,w:290,h:400,zone:officeZoneId},
  {id:"office-kitchen",name:"茶歇间",kind:"resting",topic:"等待下一步指令",capacity:6,columns:3,x:30,y:1330,w:240,h:340,zone:officeZoneId},
  {id:"office-pond",name:"窗边摸鱼区",kind:"fishing",topic:"空闲但不离线",capacity:4,columns:2,x:290,y:1330,w:240,h:340,zone:officeZoneId},
  {id:"office-nest",name:"充电窝",kind:"offline",topic:"会话已结束",capacity:20,columns:5,x:550,y:1330,w:360,h:340,zone:officeZoneId},
  {id:"office-lab",name:"实验区",kind:"working",topic:"长任务与实验",capacity:8,columns:4,x:930,y:1330,w:290,h:340,zone:officeZoneId}
 ];
}
/** Every configured room; the store reconciles its snapshot against this catalog. */
export function defaultRooms():Room[]{return [...homeRooms(),...officeRooms()];}
export function demoOffice(now=new Date()):Office{
 const at=(minutes:number)=>new Date(now.getTime()-minutes*60000).toISOString();
 const rooms=homeRooms();
 const members:[string,string,Activity,string][]=[
  ["Nova","#afa0f4","meeting","meeting-a"],["Orion","#e7b774","meeting","meeting-a"],["Sage","#98cda8","meeting","meeting-a"],
  ["Echo","#ed97b9","discussing","discussion"],["Kite","#83cce3","discussing","discussion"],
  ["Atlas","#8daff4","working","desks"],["Mira","#f0c785","working","desks"],["Juno","#d9bd83","resting","kitchen"],
  ["Pixel","#8ecbaf","fishing","pond"],["Volt","#e49b84","fishing","pond"],["Rook","#8891a4","offline","nest"],["Lumen","#aca4bc","offline","nest"]];
 const agents:Agent[]=members.map(([name,color,activity,roomId])=>({id:name.toLowerCase(),name,color,activity,roomId,zone:defaultZoneId,online:activity!=="offline",lastSeenAt:at(activity==="offline"?35:1),
  tasks:name==="Atlas"?[{id:"demo-task-api",title:"整理只读 API",status:"running",updatedAt:at(2)}]:name==="Mira"?[{id:"demo-task-ui",title:"复核手机房间列表",status:"running",updatedAt:at(2)},{id:"demo-task-qa",title:"等待桌面验收",status:"queued",blocked:true,delegatedFrom:"demo-task-api",handoffNote:"接收 Atlas 的示例接口说明后进行验收",updatedAt:at(3),handoffAt:at(3)}]:[]}));
 return {mode:"demo",source:"synthetic",observedAt:now.toISOString(),agents,rooms,zones:defaultZones(),events:[
  {at:at(3),message:"Nova 预订了会议室 A：Q4 路线图评审，邀请 Orion、Sage"},
  {at:at(8),message:"Echo 预订了讨论室 1：缓存失效方案，邀请 Kite"},
  {at:at(13),message:"Juno → 休息 · 茶水间"},{at:at(15),message:"Volt → 摸鱼区 · 演示动作"}]};
}
export function validateOffice(value:unknown):value is Office{
 if(!value||typeof value!=="object")return false;
 const v=value as Office;
 return v.mode==="demo"&&v.source==="synthetic"&&Array.isArray(v.agents)&&v.agents.length<=500&&Array.isArray(v.rooms)&&v.rooms.length<=64
  &&Array.isArray(v.zones)&&v.zones.length>0&&v.zones.every(z=>typeof z.id==="string"&&typeof z.name==="string")
  &&v.rooms.every(r=>v.zones.some(z=>z.id===r.zone))
  &&v.agents.every(a=>typeof a.id==="string"&&typeof a.name==="string"&&/^#[0-9a-f]{6}$/i.test(a.color)&&activities.includes(a.activity)&&v.rooms.some(r=>r.id===a.roomId&&r.zone===a.zone))
  &&v.rooms.every(r=>typeof r.name==="string"&&[r.x,r.y,r.w,r.h,r.capacity].every(Number.isFinite)&&r.w>0&&r.h>0);
}

/** Stable capacity-bounded slots; occupants never use a single unbounded row. */
export function roomColumns(room:Room):number{
 return room.columns ?? (room.kind==="working"?4:room.kind==="meeting"?4:2);
}
export function roomSlot(room:Room,index:number):{x:number;y:number}{
 const columns=roomColumns(room);
 const rows=Math.ceil(room.capacity/columns);
 const col=index%columns,row=Math.floor(index/columns);
 return {x:room.x+40+(room.w-80)*(col+.5)/columns,
  y:room.y+76+(room.h-132)*(row+.5)/rows};
}
/** Browser-only synthetic action. Return false without mutation when the zone has no free room. */
export function assignActivity(office:Office,agent:Agent,activity:Activity,now=new Date()):boolean{
 const rooms=office.rooms.filter(r=>r.kind===activity&&r.zone===agent.zone);
 const destination=rooms.find(r=>r.id===agent.roomId)||rooms.find(r=>office.agents.filter(a=>a.roomId===r.id&&!a.retiredAt).length<r.capacity);
 if(!destination)return false;
 agent.activity=activity;agent.online=activity!=="offline";agent.roomId=destination.id;agent.zone=destination.zone;
 agent.lastSeenAt=now.toISOString();return true;
}
