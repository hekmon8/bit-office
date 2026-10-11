export const activities = ["working", "meeting", "discussing", "resting", "fishing", "offline"] as const;
export type Activity = typeof activities[number];
export type TaskStatus = "queued" | "dispatched" | "waiting_local_directory" | "running" | "completed" | "failed" | "cancelled";
export interface Task { id: string; title: string; status: TaskStatus; blocked?: boolean; delegatedFrom?: string; handoffNote?: string; updatedAt?: string; handoffAt?: string; }
export interface Agent { id:string; name:string; color:string; activity:Activity; roomId:string; online:boolean; tasks:Task[]; lastSeenAt:string; }
export interface Room {id:string;name:string;kind:Activity;topic:string;capacity:number;x:number;y:number;w:number;h:number;}
export interface Office {mode:"demo";source:"synthetic";observedAt:string;agents:Agent[];rooms:Room[];events:{at:string;message:string}[];}
export const labels:Record<Activity,string>={working:"工作中",meeting:"开会",discussing:"讨论",resting:"休息",fishing:"摸鱼",offline:"离线"};
export function executionState(tasks:Task[], complete:boolean, fresh:boolean) {
 const running=tasks.filter(t=>t.status==="running").length;
 const waiting=tasks.filter(t=>["queued","dispatched","waiting_local_directory"].includes(t.status)).length;
 return {running,waiting,blocked:tasks.filter(t=>t.blocked && !["completed","failed","cancelled"].includes(t.status)).length,
  label:running?"运行":waiting?"等待":complete&&fresh?"空闲":"未知"};
}
export function defaultRooms():Room[]{
 return [
  {id:"meeting-a",name:"会议室 A",kind:"meeting",topic:"Q4 路线图评审",capacity:8,x:30,y:30,w:310,h:260},
  {id:"discussion",name:"讨论室 1",kind:"discussing",topic:"缓存失效方案",capacity:6,x:360,y:30,w:300,h:260},
  {id:"meeting-b",name:"会议室 B",kind:"meeting",topic:"空闲",capacity:8,x:680,y:30,w:290,h:260},
  {id:"desks",name:"开放工位",kind:"working",topic:"固定工位 · 16 席",capacity:16,x:30,y:385,w:430,h:290},
  {id:"kitchen",name:"茶水间",kind:"resting",topic:"咖啡与片刻休息",capacity:4,x:480,y:385,w:205,h:290},
  {id:"pond",name:"摸鱼区",kind:"fishing",topic:"小池塘 · 演示动作",capacity:4,x:705,y:385,w:240,h:290},
  {id:"nest",name:"充电窝",kind:"offline",topic:"离线宠物的窝",capacity:4,x:990,y:385,w:230,h:290}
 ];
}
export function demoOffice(now=new Date()):Office{
 const at=(minutes:number)=>new Date(now.getTime()-minutes*60000).toISOString();
 const rooms=defaultRooms();
 const members:[string,string,Activity,string][]=[
  ["Nova","#afa0f4","meeting","meeting-a"],["Orion","#e7b774","meeting","meeting-a"],["Sage","#98cda8","meeting","meeting-a"],
  ["Echo","#ed97b9","discussing","discussion"],["Kite","#83cce3","discussing","discussion"],
  ["Atlas","#8daff4","working","desks"],["Mira","#f0c785","working","desks"],["Juno","#d9bd83","resting","kitchen"],
  ["Pixel","#8ecbaf","fishing","pond"],["Volt","#e49b84","fishing","pond"],["Rook","#8891a4","offline","nest"],["Lumen","#aca4bc","offline","nest"]];
 const agents:Agent[]=members.map(([name,color,activity,roomId])=>({id:name.toLowerCase(),name,color,activity,roomId,online:activity!=="offline",lastSeenAt:at(activity==="offline"?35:1),
  tasks:name==="Atlas"?[{id:"demo-task-api",title:"整理只读 API",status:"running",updatedAt:at(2)}]:name==="Mira"?[{id:"demo-task-ui",title:"复核手机房间列表",status:"running",updatedAt:at(2)},{id:"demo-task-qa",title:"等待桌面验收",status:"queued",blocked:true,delegatedFrom:"demo-task-api",handoffNote:"接收 Atlas 的示例接口说明后进行验收",updatedAt:at(3),handoffAt:at(3)}]:[]}));
 return {mode:"demo",source:"synthetic",observedAt:now.toISOString(),agents,rooms,events:[
  {at:at(3),message:"Nova 预订了会议室 A：Q4 路线图评审，邀请 Orion、Sage"},
  {at:at(8),message:"Echo 预订了讨论室 1：缓存失效方案，邀请 Kite"},
  {at:at(13),message:"Juno → 休息 · 茶水间"},{at:at(15),message:"Volt → 摸鱼区 · 演示动作"}]};
}
export function validateOffice(value:unknown):value is Office{
 if(!value||typeof value!=="object")return false;
 const v=value as Office;
 return v.mode==="demo"&&v.source==="synthetic"&&Array.isArray(v.agents)&&v.agents.length<=100&&Array.isArray(v.rooms)&&v.rooms.length<=40
 &&v.agents.every(a=>typeof a.id==="string"&&typeof a.name==="string"&&/^#[0-9a-f]{6}$/i.test(a.color)&&activities.includes(a.activity)&&v.rooms.some(r=>r.id===a.roomId))
 &&v.rooms.every(r=>typeof r.name==="string"&&[r.x,r.y,r.w,r.h,r.capacity].every(Number.isFinite)&&r.w>0&&r.h>0);
}

/** Stable capacity-bounded slots; occupants never use a single unbounded row. */
export function roomSlot(room:Room,index:number):{x:number;y:number}{
 const columns=room.kind==="working"?4:room.kind==="meeting"?4:2;
 const rows=Math.ceil(room.capacity/columns);
 const col=index%columns,row=Math.floor(index/columns);
 return {x:room.x+40+(room.w-80)*(col+.5)/columns,
  y:room.y+76+(room.h-132)*(row+.5)/rows};
}
/** Browser-only synthetic action. Return false without mutation when all rooms are full. */
export function assignActivity(office:Office,agent:Agent,activity:Activity,now=new Date()):boolean{
 const rooms=office.rooms.filter(r=>r.kind===activity);
 const destination=rooms.find(r=>r.id===agent.roomId)||rooms.find(r=>office.agents.filter(a=>a.roomId===r.id).length<r.capacity);
 if(!destination)return false;
 agent.activity=activity;agent.online=activity!=="offline";agent.roomId=destination.id;
 agent.lastSeenAt=now.toISOString();return true;
}
