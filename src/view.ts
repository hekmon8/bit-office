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


/** A full-scene camera, with equal CSS-pixel scale on both axes. */
export function fitViewport(width:number,height:number,sceneWidth:number,sceneHeight:number){
 const aspect=Math.max(1,width)/Math.max(1,height);
 const cameraWidth=Math.max(sceneWidth,sceneHeight*aspect),cameraHeight=cameraWidth/aspect;
 return {width:cameraWidth,height:cameraHeight,scale:Math.max(1,width)/cameraWidth};
}
/** Center a smaller scene; bound a zoomed scene without exposing empty edges. */
export function constrainPan(offset:number,viewport:number,scene:number){
 return scene<=viewport?(viewport-scene)/2:Math.max(viewport-scene,Math.min(0,offset));
}


/** Conservative glyph budget for readable labels in very small overview rooms. */
export function compactRoomLabel(name:string,screenWidth:number){
 const chars=Array.from(name.replace(/\s+/g,"")),columns=Math.max(1,Math.floor((screenWidth-4)/10));
 return Array.from({length:Math.ceil(chars.length/columns)},(_,i)=>chars.slice(i*columns,(i+1)*columns).join(""));
}
