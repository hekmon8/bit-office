import type {Room} from "./model";

/** Source freshness, independent of demo activity and Agent connectivity. */
export function readFreshness(lastRead:string|null,failed:boolean,now=Date.now()){
 if(failed)return {stale:false,label:"服务器读取失败 · 本地示例"};
 if(!lastRead)return {stale:false,label:"本地示例生成 · 未读取服务器"};
 const age=now-Date.parse(lastRead),stale=!Number.isFinite(age)||age>120000||age<0;
 return {stale,label:stale?"服务器读取已过期 · 旧快照":"服务器读取有效 · 合成示例"};
}

/** Display geometry only; server room/occupancy data is never mutated. */
export function layoutRoom(room:Room):Room{
 return {...room,y:room.y>=385?room.y+64:room.y,h:Math.max(room.h,room.y>=385?400:324)};
}
export function floorHeight(rooms:Room[]){return Math.max(720,...rooms.map(room=>{const r=layoutRoom(room);return r.y+r.h+35;}));}
