import "./style.css";
import { demoOffice, labels, activities, executionState, type Agent, type Room, type Activity, validateOffice, roomSlot, assignActivity } from "./model";
import {readFreshness,layoutRoom,floorHeight} from "./view";
let office=demoOffice(),filter:Activity|""="",zoom=1,dx=0,dy=0,simulating=false,simTimer:ReturnType<typeof setInterval>|undefined;
let lastSuccessfulReadAt:string|null=null;
const $=<T extends Element=HTMLElement>(s:string)=>document.querySelector(s) as T;
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
function time(s:string){return new Date(s).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"});}
function bit(a:Agent,x:number,y:number,scale=1,interactive=true){const sleepy=a.activity==="offline";return `<g transform="translate(${x},${y}) scale(${scale})" class="${interactive?"pet-hit":"pet-art"}" ${interactive?`role="button" tabindex="0" data-agent="${a.id}" aria-label="${escape(a.name)}，${a.online?labels[a.activity]:"连接离线"}"`:""}><rect x="-24" y="-24" width="48" height="48" fill="transparent"/><g class="pet ${simulating&&!sleepy?"bounce":""}"><path d="M-13 -12v-8h7v6h12v-6h7v8h4v24h-4v5h-7v-5H-6v5h-7v-5h-4v-24z" fill="${a.color}" opacity="${sleepy?".48":"1"}"/><path d="${sleepy?"M-8 -2h5M3 -2h5":"M-7 -4v4M6 -4v4"}" stroke="#14171b" stroke-width="3"/>${a.activity==="meeting"||a.activity==="discussing"?'<path d="M15 -27h18v12H21l-4 5v-5h-2z" fill="#666b78"/><path d="M19 -22h10" stroke="#dadde3" stroke-width="2"/>':""}${sleepy?'<text x="20" y="-15" class="zzz">z</text>':""}${a.activity==="resting"?'<path d="M11 6h9v8h-9zM20 8h4v4h-4" fill="#d2af77"/>':""}${a.activity==="fishing"?'<path d="M15 10l18 -29 17 17" stroke="#baac91" fill="none" stroke-width="2"/>':""}</g><text y="36" class="pet-name">${escape(a.name)}</text><circle cx="21" cy="29" r="3" fill="${a.online?"#88b9a0":"#676d7a"}"/></g>`;}
function furniture(r:Room){
 const {x,y,w,h}=r;const c="#6d6159",edge="#363c45";
 if(r.kind==="meeting")return `<rect x="${x+w/2-74}" y="${y+90}" width="148" height="91" rx="5" fill="#51483f" stroke="#786a58"/><path d="M${x+45} ${y+15}h${w-90}" stroke="#777f94" stroke-width="6"/>${[0,1,2].map(i=>`<rect x="${x+w/2-64+i*51}" y="${y+77}" width="28" height="10" rx="2" fill="${edge}"/><rect x="${x+w/2-64+i*51}" y="${y+185}" width="28" height="10" rx="2" fill="${edge}"/>`).join("")}`;
 if(r.kind==="discussing")return `<circle cx="${x+w/2}" cy="${y+139}" r="56" fill="#595145" stroke="#8a785e"/><rect x="${x+w-85}" y="${y+54}" width="63" height="39" rx="3" fill="#514957"/><path d="M${x+w-76} ${y+64}h17m4 0h17m-38 11h17" stroke="#b3a290" stroke-width="6"/>`;
 if(r.kind==="working")return Array.from({length:16},(_,i)=>{const a=x+35+(i%4)*94,b=y+65+Math.floor(i/4)*48;return `<rect x="${a}" y="${b}" width="65" height="29" rx="2" fill="${c}" stroke="#89725b"/><rect x="${a+19}" y="${b+5}" width="29" height="16" rx="1" fill="#252c38"/><path d="M${a+22} ${b+22}h23" stroke="#a69d8c" stroke-width="2"/><rect x="${a+25}" y="${b+32}" width="21" height="9" rx="2" fill="${edge}"/>`;}).join("");
 if(r.kind==="resting")return `<rect x="${x+17}" y="${y+54}" width="${w-34}" height="43" rx="3" fill="#665b4a"/><rect x="${x+27}" y="${y+58}" width="30" height="25" fill="#353b40"/><circle cx="${x+78}" cy="${y+72}" r="10" fill="#889292"/><rect x="${x+w-60}" y="${y+110}" width="40" height="69" rx="4" fill="#5a6269"/><path d="M${x+w-60} ${y+136}h40" stroke="#303940"/><circle cx="${x+70}" cy="${y+206}" r="30" fill="#615b4d"/>`;
 if(r.kind==="fishing")return `<ellipse cx="${x+w/2}" cy="${y+h/2+7}" rx="67" ry="42" fill="#345e69" stroke="#638a86" stroke-width="8"/><path d="M${x+94} ${y+141}h25m-9 16h23" stroke="#78999e" stroke-width="2"/><rect x="${x+18}" y="${y+53}" width="88" height="28" rx="8" fill="#635b61"/><rect x="${x+w-55}" y="${y+50}" width="34" height="49" rx="4" fill="#454753"/>`;
 return [0,1].map(i=>`<rect x="${x+32+i*98}" y="${y+86}" width="65" height="136" rx="13" fill="#3b3e4d" stroke="#656475"/><rect x="${x+42+i*98}" y="${y+100}" width="45" height="28" rx="6" fill="#777080"/><rect x="${x+32+i*98}" y="${y+151}" width="65" height="71" rx="10" fill="#5c596c"/>`).join("");
}
function occupants(r:Room){return office.agents.filter(a=>a.roomId===r.id);}
function officeWidth(){return Math.max(1260,...office.rooms.map(r=>r.x+r.w+40));}
function desk(r:Room,index:number){
 const {x,y}=roomSlot(r,index),a=occupants(r)[index];
 return `<g class="desk-hit" role="button" tabindex="0" data-desk="${r.id}:${index}" aria-label="${a?escape(a.name)+' 的工位，查看任务':'空工位 '+(index+1)}"><rect x="${x-38}" y="${y-24}" width="76" height="64" rx="3" fill="transparent"/><rect x="${x-34}" y="${y+3}" width="68" height="28" rx="2" fill="#6d6159" stroke="#89725b"/><rect x="${x+7}" y="${y+6}" width="20" height="14" rx="1" fill="#252c38"/><path d="M${x+8} ${y+23}h18" stroke="#a69d8c" stroke-width="2"/><rect x="${x-12}" y="${y+34}" width="24" height="8" rx="2" fill="#363c45"/></g>`;
}
function mapSVG(){
 const width=officeWidth(),height=floorHeight(office.rooms),rooms=office.rooms.map(layoutRoom);
 return `<svg id="floor" viewBox="0 0 ${width} ${height}" aria-label="Bit 小屋 Agent 工作空间" xmlns="http://www.w3.org/2000/svg"><defs><pattern id="tiles" width="22" height="22" patternUnits="userSpaceOnUse"><path d="M22 0H0V22" fill="none" stroke="#353a40" stroke-width=".5"/></pattern></defs><g id="floor-content" transform="translate(${dx} ${dy}) scale(${zoom})"><rect x="8" y="8" width="${width-16}" height="${height-25}" rx="8" fill="#252a2f" stroke="#62676e" stroke-width="8"/><rect x="16" y="363" width="${width-32}" height="77" fill="url(#tiles)"/><path d="M80 405H${width-50}" stroke="#464b50" stroke-dasharray="8 9"/><text x="89" y="393" class="corridor-label">走廊</text><path d="M15 373v58m0 -4h52m-52 -52a52 52 0 0 1 52 52" fill="none" stroke="#858377" stroke-width="2"/><text x="28" y="414" class="tiny">入口</text>
 ${rooms.map(r=>`<g class="room-shape"><rect class="room-hit" role="button" tabindex="0" data-room="${r.id}" aria-label="${escape(r.name)}，${occupants(r).length}/${r.capacity}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="3" fill="${r.kind==="meeting"?"#2e2d37":r.kind==="discussing"?"#31342e":r.kind==="fishing"?"#263338":r.kind==="offline"?"#282b34":"#303333"}" stroke="#65676b" stroke-width="5"/><g class="room-decoration" aria-hidden="true"><path d="M${r.x+30} ${r.y+5}h${Math.min(r.w-60,120)}" stroke="#658591" stroke-width="4"/><text x="${r.x+18}" y="${r.y+35}" class="room-name">${escape(r.name)}</text><text x="${r.x+r.w-18}" y="${r.y+35}" text-anchor="end" class="room-count">${occupants(r).length}/${r.capacity}</text>${r.kind==="working"?"":furniture(r)}<path d="M${r.x+r.w/2-24} ${r.y<300?r.y+r.h:r.y}h48" stroke="#252a2f" stroke-width="7"/><path d="M${r.x+r.w/2-24} ${r.y<300?r.y+r.h:r.y}v${r.y<300?-40:40}m0 0a40 40 0 0 1 40 ${r.y<300?40:-40}" stroke="#9a9185" stroke-width="1.5" fill="none"/></g>${r.kind==="working"?Array.from({length:r.capacity},(_,i)=>desk(r,i)).join(""):""}</g>`).join("")}
 ${rooms.flatMap(r=>occupants(r).map((a,i)=>{const {x,y}=roomSlot(r,i);return filter&&a.activity!==filter?"":bit(a,x,y);})).join("")}
 <g class="expand-hit" role="button" tabindex="0" data-view="expand" aria-label="扩建示例会议室"><rect x="990" y="30" width="230" height="324" rx="3" fill="transparent" stroke="#484e58" stroke-dasharray="6 5"/><path d="M1085 192h40m-20-20v40" stroke="#555e6b" stroke-width="2"/></g></g></svg>`;
}

type View={kind:"rooms"|"settings"|"mcp"|"status"|"expand"}|{kind:"room"|"agent";id:string}|{kind:"desk";roomId:string;index:number};
type FocusKey={selector:string;index:number};
let views:View[]=[],returnFocus:FocusKey|null=null,viewFocus:FocusKey[]=[];
let localRevision=0,readFailed=false,snapshotSource:"builtin"|"server"="builtin";
let cameraWidth=1260,cameraHeight=720;
const icons:Record<string,string>={rooms:'<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',mcp:'<path d="m8 8-4 4 4 4m8-8 4 4-4 4m-3-11-2 22"/>',fit:'<path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4"/>',plus:'<path d="M12 5v14M5 12h14"/>',minus:'<path d="M5 12h14"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',back:'<path d="m14 5-7 7 7 7"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 10v7m0-10v1"/>',arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>'};
function icon(name:string){return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;}
function iconButton(id:string,name:string,label:string){return `<button id="${id}" class="icon-button" aria-label="${label}" title="${label}">${icon(name)}</button>`;}
function focusKey(el:Element|null):FocusKey|null{
 if(!el||el===document.body)return null;
 for(const attr of ["id","data-view","data-filter","data-room","data-agent","data-desk"]){const value=el.getAttribute(attr);if(value!==null){const selector=`[${attr}="${CSS.escape(value)}"]`;return {selector,index:Array.from(document.querySelectorAll(selector)).indexOf(el)};}}
 return null;
}
function restoreFocus(key:FocusKey|null){const target=key?document.querySelectorAll<HTMLElement>(key.selector)[key.index]:null;(target??$("#open-rooms")).focus({preventScroll:true});}
function freshness(){return readFreshness(lastSuccessfulReadAt,readFailed);}
function renderStatus(){
 const f=freshness(),running=office.agents.reduce((n,a)=>n+executionState(a.tasks,true,!f.stale).running,0),waiting=office.agents.reduce((n,a)=>n+executionState(a.tasks,true,!f.stale).waiting,0),blocked=office.agents.reduce((n,a)=>n+executionState(a.tasks,true,!f.stale).blocked,0);
 $("#office-status").innerHTML=`<i class="source-dot ${f.stale||readFailed?"warning":""}"></i><span><strong>合成示例 · ${readFailed?"离线":lastSuccessfulReadAt?(f.stale?"读取过期":time(lastSuccessfulReadAt)):"本地"}${filter?" · 筛选":""}</strong><span>${running} 运行 · ${waiting} 等待 · ${blocked} 阻塞</span></span><small>${readFailed?"离线 · 本地示例":lastSuccessfulReadAt?(f.stale?"读取已过期":"读取 "+time(lastSuccessfulReadAt)):"本地生成"}</small>`;
 $("#dialog-source").textContent="合成示例"+(readFailed?" · 服务器离线":f.stale?" · 读取过期":"");
 const view=views.at(-1);
 const field=(id:string,text:string)=>{const el=document.getElementById(id);if(el)el.textContent=text;};
 if(view?.kind==="agent"){const a=office.agents.find(a=>a.id===view.id);if(a)field("agent-execution-state",executionState(a.tasks,true,!f.stale).label+(f.stale?" · 旧快照":""));}
 field("read-time",lastSuccessfulReadAt?"最近成功服务器读取 "+time(lastSuccessfulReadAt):"尚无成功服务器读取");
 field("read-quality",f.label);
 field("page-source","当前页面来源："+(snapshotSource==="server"?"服务器合成快照":"本地内置示例")+(localRevision?" · 已在本页修改":""));
 $("#office-status").setAttribute("aria-label",`查看示例状态：${running} 运行、${waiting} 等待、${blocked} 阻塞。${f.label}`);
}
function mount(){
 $("#app").innerHTML=`<header class="app-header"><div class="brand"><span class="brand-bit" aria-hidden="true">▟</span><h1>Bit 小屋</h1></div><nav aria-label="办公室工具">${iconButton("open-rooms","rooms","房间与成员")}${iconButton("open-mcp","mcp","MCP 接入")}${iconButton("open-settings","settings","设置与说明")}</nav></header><main class="office-canvas" aria-label="Agent 工作空间"><div id="map-stage" tabindex="0" aria-label="工作空间：拖动平移，方向键平移，加减键缩放，Home 适配全图"></div><div class="canvas-bottom"><button id="office-status" class="status-pill" aria-haspopup="dialog"></button><div class="camera-tools" aria-label="视图控制">${iconButton("zoom-out","minus","缩小工作空间")}${iconButton("reset-view","fit","适配全图")}${iconButton("zoom-in","plus","放大工作空间")}</div></div><div id="pan-hint" aria-hidden="true">拖动查看房间</div></main><dialog id="detail" aria-labelledby="detail-title"><div class="dialog-head">${iconButton("back-detail","back","返回上一层")}<span id="dialog-source">BIT OFFICE / 合成示例</span>${iconButton("close-detail","close","关闭窗口，返回工作空间")}</div><div id="detail-content"></div></dialog><div id="toast" role="status"></div>`;
 $("#open-rooms").onclick=()=>openView({kind:"rooms"});$("#open-settings").onclick=()=>openView({kind:"settings"});$("#open-mcp").onclick=()=>openView({kind:"mcp"});$("#office-status").onclick=()=>openView({kind:"status"});
 $("#close-detail").onclick=closeViews;$("#back-detail").onclick=backView;
 const dialog=$<HTMLDialogElement>("#detail");dialog.addEventListener("cancel",e=>{e.preventDefault();closeViews();});
 dialog.addEventListener("click",e=>{const r=dialog.getBoundingClientRect();if(e.target===dialog&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))closeViews();});
 $("#zoom-in").onclick=()=>changeZoom(.2);$("#zoom-out").onclick=()=>changeZoom(-.2);$("#reset-view").onclick=()=>{zoom=1;dx=dy=0;resizeCamera();};
 bindCanvas();renderOffice();new ResizeObserver(()=>resizeCamera()).observe($("#map-stage"));
 setInterval(()=>renderStatus(),30000);
 window.addEventListener("focus",renderStatus);document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")renderStatus();});
}
function renderOffice(){
 const focused=focusKey(document.activeElement);$("#map-stage").innerHTML=mapSVG();resizeCamera();bindTargets($("#map-stage"));renderStatus();if(focused&&!$<HTMLDialogElement>("#detail").open)restoreFocus(focused);
}
function minimumZoom(){const s=$("#map-stage");return s.clientWidth<700||s.clientHeight<420?1:.6;}
function resizeCamera(){
 const stage=$("#map-stage"),mobile=stage.clientWidth<700||stage.clientHeight<420;
 zoom=Math.max(minimumZoom(),zoom);
 cameraHeight=mobile?Math.min(floorHeight(office.rooms),Math.max(1,stage.clientHeight)*1.05):floorHeight(office.rooms);
 cameraWidth=mobile?cameraHeight*stage.clientWidth/Math.max(stage.clientHeight,1):officeWidth();
 $("#floor").setAttribute("viewBox",`0 0 ${cameraWidth} ${cameraHeight}`);
 $("#reset-view").setAttribute("aria-label",mobile?"回到入口视图":"适配全图");$("#reset-view").title=mobile?"回到入口视图":"适配全图";$("#pan-hint").hidden=!mobile;updateTransform();
}
function updateTransform(){
 dx=Math.max(Math.min(0,cameraWidth-officeWidth()*zoom),Math.min(Math.max(0,cameraWidth-officeWidth()*zoom),dx));
 dy=Math.max(Math.min(0,cameraHeight-floorHeight(office.rooms)*zoom),Math.min(Math.max(0,cameraHeight-floorHeight(office.rooms)*zoom),dy));
 $("#floor-content").setAttribute("transform",`translate(${dx} ${dy}) scale(${zoom})`);
 $<HTMLButtonElement>("#zoom-in").disabled=zoom>=2.4;$<HTMLButtonElement>("#zoom-out").disabled=zoom<=minimumZoom();
}
function changeZoom(delta:number){
 const old=zoom;zoom=Math.max(minimumZoom(),Math.min(2.4,zoom+delta));dx=cameraWidth/2-(cameraWidth/2-dx)*zoom/old;dy=cameraHeight/2-(cameraHeight/2-dy)*zoom/old;updateTransform();
 $<HTMLButtonElement>("#zoom-in").disabled=zoom>=2.4;$<HTMLButtonElement>("#zoom-out").disabled=zoom<=minimumZoom();
}
function bindCanvas(){
 const stage=$("#map-stage");let start:{id:number;x:number;y:number;dx:number;dy:number;clientX:number;clientY:number}|null=null,dragged=false;
 const point=(x:number,y:number)=>{const matrix=$<SVGSVGElement>("#floor").getScreenCTM();return matrix?new DOMPoint(x,y).matrixTransform(matrix.inverse()):new DOMPoint(x,y);};
 stage.onpointerdown=e=>{if(start||e.button!==0)return;const p=point(e.clientX,e.clientY);start={id:e.pointerId,x:p.x,y:p.y,dx,dy,clientX:e.clientX,clientY:e.clientY};dragged=false;};
 stage.onpointermove=e=>{if(!start||e.pointerId!==start.id)return;if(e.pointerType==="mouse"&&e.buttons===0){start=null;return;}if(!dragged&&Math.hypot(e.clientX-start.clientX,e.clientY-start.clientY)<8)return;dragged=true;stage.setPointerCapture(e.pointerId);const p=point(e.clientX,e.clientY);dx=start.dx+p.x-start.x;dy=start.dy+p.y-start.y;updateTransform();};
 const release=(e:PointerEvent)=>{if(start?.id===e.pointerId)start=null;};
 window.addEventListener("pointerup",release);window.addEventListener("pointercancel",release);
 window.addEventListener("blur",()=>{start=null;dragged=false;});stage.onlostpointercapture=()=>{start=null;};
 stage.addEventListener("click",e=>{if(dragged){e.preventDefault();e.stopPropagation();dragged=false;}},true);
 stage.addEventListener("wheel",e=>{e.preventDefault();changeZoom(e.deltaY<0?.1:-.1);}, {passive:false});
 stage.onkeydown=e=>{if(e.target!==stage)return;const moves:Record<string,[number,number]>={ArrowLeft:[90,0],ArrowRight:[-90,0],ArrowUp:[0,90],ArrowDown:[0,-90]};if(moves[e.key]){e.preventDefault();dx+=moves[e.key][0];dy+=moves[e.key][1];updateTransform();}else if(e.key==="+"||e.key==="="){e.preventDefault();changeZoom(.2);}else if(e.key==="-"){e.preventDefault();changeZoom(-.2);}else if(e.key==="Home"){e.preventDefault();zoom=1;dx=dy=0;resizeCamera();}};
 stage.addEventListener("focusin",e=>{const el=e.target as SVGGraphicsElement;if(el===stage as unknown as SVGGraphicsElement||!el.closest("[data-room],[data-agent],[data-desk],[data-view]"))return;const r=el.getBoundingClientRect(),s=stage.getBoundingClientRect();if(r.left>=s.left&&r.right<=s.right&&r.top>=s.top&&r.bottom<=s.bottom)return;const b=el.getBBox();let x=b.x+b.width/2,y=b.y+b.height/2;if(el.hasAttribute("data-agent")){const matrix=el.getCTM(),root=$<SVGSVGElement>("#floor").getCTM();if(matrix&&root){const p=new DOMPoint(x,y).matrixTransform(matrix).matrixTransform(root.inverse());x=(p.x-dx)/zoom;y=(p.y-dy)/zoom;}}dx=cameraWidth/2-x*zoom;dy=cameraHeight/2-y*zoom;updateTransform();});
}
function bindTargets(root:Element){
 root.querySelectorAll<HTMLElement>("[data-room],[data-agent],[data-desk],[data-view]").forEach(el=>{const activate=()=>{if(el.dataset.view){openView({kind:"expand"});}else if(el.dataset.agent)openView({kind:"agent",id:el.dataset.agent});else if(el.dataset.desk){const [roomId,index]=el.dataset.desk.split(":");const r=office.rooms.find(r=>r.id===roomId)!;const a=occupants(r)[Number(index)];openView(a?{kind:"agent",id:a.id}:{kind:"desk",roomId,index:Number(index)});}else openView({kind:"room",id:el.dataset.room!});};el.onclick=e=>{e.stopPropagation();activate();};if(el.tagName.toLowerCase()!=="button")el.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();e.stopPropagation();activate();}};});
}
function openView(view:View){
 const dialog=$<HTMLDialogElement>("#detail");if(!dialog.open){returnFocus=focusKey(document.activeElement);views=[];viewFocus=[];}else{const f=focusKey(document.activeElement);if(f)viewFocus.push(f);}
 views.push(view);renderView();if(!dialog.open)dialog.showModal();$("#detail-title").focus({preventScroll:true});
}
function closeViews(){const focus=returnFocus;$<HTMLDialogElement>("#detail").close();views=[];viewFocus=[];renderOffice();restoreFocus(focus);}
function backView(){if(views.length<2){closeViews();return;}views.pop();const f=viewFocus.pop()??null;renderView();if(f)restoreFocus(f);else $("#detail-title").focus();}
function heading(text:string){return `<h2 id="detail-title" tabindex="-1">${escape(text)}</h2>`;}
function renderView(){
 const view=views.at(-1)!;const fresh=!freshness().stale;let content="";
 if(view.kind==="rooms")content=heading("房间与成员")+`<p class="muted">${office.rooms.length} 个房间 · ${office.agents.length} 位示例成员</p><div class="room-list">${office.rooms.map(roomRow).join("")}</div><button id="open-expand" class="secondary">＋ 扩建示例会议室</button>`;
 if(view.kind==="room"){
  const r=office.rooms.find(r=>r.id===view.id)!;content=heading(r.name)+`<p class="muted">${escape(r.topic)} · ${occupants(r).length}/${r.capacity}</p><div class="detail-agents">${occupants(r).map(a=>`<button data-agent="${a.id}"><i style="background:${a.color}"></i>${escape(a.name)}<span>${a.online?labels[a.activity]:"连接离线"}</span>${icon("arrow")}</button>`).join("")||'<p class="muted">这间房现在空闲。</p>'}</div><p class="muted">房间位置、讨论和活动均为示例，不表示真实任务协作。</p>${r.kind==="meeting"||r.kind==="discussing"?'<button id="finish-meeting" class="secondary">结束示例会议</button>':""}`;
 }
 if(view.kind==="agent"){
  const a=office.agents.find(a=>a.id===view.id)!,ex=executionState(a.tasks,true,fresh);content=`<div class="agent-title"><svg viewBox="-55 -55 110 110" aria-hidden="true" focusable="false">${bit(a,0,0,1.4,false)}</svg><div>${heading(a.name)}<p>${labels[a.activity]} · ${a.online?"连接在线":"连接离线"}</p></div></div><div class="facts"><span>任务状态 <b id="agent-execution-state">${ex.label}${fresh?"":" · 旧快照"}</b></span><span>运行 ${ex.running} · 等待 ${ex.waiting} · 阻塞 ${ex.blocked}</span><span>最后示例心跳 ${time(a.lastSeenAt)}</span></div><h3>任务与交接</h3>${a.tasks.map(t=>`<div class="task-detail"><strong>${escape(t.title)}</strong><span>${escape(t.status)}${t.blocked?" · 阻塞":""}</span>${t.updatedAt?`<span>最后示例任务事件 ${time(t.updatedAt)}</span>`:""}${t.delegatedFrom?`<p>来源任务：${escape(t.delegatedFrom)}</p><p>${escape(t.handoffNote??"")}</p>${t.handoffAt?`<p>示例交接时间 ${time(t.handoffAt)}</p>`:""}`:""}</div>`).join("")||'<p class="muted">没有活动任务示例。</p>'}<label class="field-label" for="demo-activity">切换本页演示动作</label><select id="demo-activity">${activities.map(s=>`<option value="${s}" ${a.activity===s?"selected":""}>${labels[s]}</option>`).join("")}</select><p class="muted">活动不改变任务执行状态，也不会调用真实 Agent。在线 ≠ 正在运行。</p>`;
 }
 if(view.kind==="desk"){const r=office.rooms.find(r=>r.id===view.roomId)!;content=heading("空工位 "+(view.index+1))+`<p class="muted">${escape(r.name)} · 暂无示例成员或任务。</p>`;}
 if(view.kind==="mcp")content=heading("MCP 接入")+`<p>公开端点仅提供合成示例。尚未连接 Multica，也未验证 ChatGPT 实际授权接入。</p><p class="field-label">Streamable HTTP 端点</p><code id="endpoint">${location.origin}/mcp</code><button id="copy-endpoint" class="secondary">复制端点</button><h3>可读取</h3><ul><li>办公室全局状态与房间</li><li>Agent 的任务、连接状态和时间</li><li>有明确记录的示例任务交接</li></ul><p class="muted">本页模拟不更改服务器快照。真实数据默认关闭。</p><a href="https://github.com/hekmon8/bit-office#chatgpt--mcp" target="_blank" rel="noreferrer">查看连接说明 ↗</a>`;
 if(view.kind==="settings")content=heading("设置与说明")+`<label class="setting-row"><span><strong>模拟活动</strong><small>仅本页 · 打开窗口时暂停</small></span><input id="simulation" type="checkbox" ${simulating?"checked":""}/></label><label class="field-label" for="activity-filter">筛选宠物活动</label><select id="activity-filter"><option value="">全部活动</option>${activities.map(s=>`<option value="${s}" ${filter===s?"selected":""}>${labels[s]}</option>`).join("")}</select><p class="muted">${filter?"当前筛选："+labels[filter]+"。部分宠物暂时隐藏；房间与工位信息仍保留。":"活动与连接、任务执行状态分别记录。"}</p><button id="reset-demo" class="secondary">重置本页示例</button><h3>关于 Bit 小屋</h3><p class="muted">Bit 是原创像素宠物。成员、任务和协作均为合成示例。拖动工作空间平移，滚轮或图标缩放；键盘聚焦空间后，用方向键平移、加减键缩放、Home 适配。手机可左右拖动，也可通过房间列表查看所有成员。</p><a href="https://github.com/hekmon8/bit-office" target="_blank" rel="noreferrer">查看开源代码 ↗</a>`;
 if(view.kind==="status")content=heading("示例状态")+`<div class="facts"><span>${office.agents.filter(a=>a.online).length} 在线 · ${office.agents.filter(a=>!a.online).length} 离线</span><span>在线 ≠ 正在运行</span><span id="read-time">${lastSuccessfulReadAt?"最近成功服务器读取 "+time(lastSuccessfulReadAt):"尚无成功服务器读取"}</span><span id="read-quality">${freshness().label}</span><span id="page-source">当前页面来源：${snapshotSource==="server"?"服务器合成快照":"本地内置示例"}${localRevision?" · 已在本页修改":""}</span></div><p class="muted">读取超过 2 分钟标为旧快照。本页活动模拟不会刷新服务器读取时间或更改 MCP 数据。</p><h3>示例动态</h3><div class="events">${office.events.slice(0,6).map(e=>`<div><time>${time(e.at)}</time><p>${escape(e.message)}</p></div>`).join("")}</div>`;
 if(view.kind==="expand")content=heading("扩建示例会议室")+`<p>在走廊末端增加一间 8 席会议室，仅影响本页示例。</p><p class="muted">当前 ${office.rooms.length}/20 间。扩建后可适配全图查看。</p><button id="confirm-expand" class="primary" ${office.rooms.length>=20?"disabled":""}>扩建一间</button>`;
 $("#detail-content").innerHTML=content;$("#back-detail").hidden=views.length<2;bindTargets($("#detail-content"));
 const on=(id:string,fn:()=>void)=>{const el=document.getElementById(id);if(el)el.onclick=fn;};
 on("open-expand",()=>openView({kind:"expand"}));on("confirm-expand",extendRoom);
 on("finish-meeting",()=>{if(view.kind!=="room")return;const r=office.rooms.find(r=>r.id===view.id)!,members=occupants(r).filter(a=>a.online),available=office.rooms.filter(room=>room.kind==="working").reduce((n,room)=>n+room.capacity-occupants(room).length,0);if(available<members.length){toast("工位已满，请先释放工位");return;}members.forEach(a=>assignActivity(office,a,"working"));localRevision++;r.topic="空闲";addEvent(r.name+" 示例会议结束");closeViews();});
 const activity=document.getElementById("demo-activity") as HTMLSelectElement|null;if(activity&&view.kind==="agent")activity.onchange=()=>{const a=office.agents.find(a=>a.id===view.id)!;if(moveAgent(a,activity.value as Activity))closeViews();else renderView();};
 const simulation=document.getElementById("simulation") as HTMLInputElement|null;if(simulation)simulation.onchange=()=>{simulating=simulation.checked;clearInterval(simTimer);if(simulating)simTimer=setInterval(()=>{if($<HTMLDialogElement>("#detail").open)return;const a=office.agents[Math.floor(Math.random()*office.agents.length)];moveAgent(a,activities[Math.floor(Math.random()*activities.length)]);renderOffice();},6000);};
 const activityFilter=document.getElementById("activity-filter") as HTMLSelectElement|null;if(activityFilter)activityFilter.onchange=()=>{filter=activityFilter.value as Activity|"";renderOffice();renderView();$("#activity-filter").focus();};
 on("reset-demo",()=>{office=demoOffice();snapshotSource="builtin";localRevision++;lastSuccessfulReadAt=null;filter="";zoom=1;dx=dy=0;closeViews();toast("本页示例已重置");});
 on("copy-endpoint",async()=>{try{await navigator.clipboard.writeText(location.origin+"/mcp");toast("端点已复制");}catch{toast("请选择端点文字复制");}});
}
function roomRow(r:Room){return `<button class="room-row" data-room="${r.id}"><span class="room-icon ${r.kind}" aria-hidden="true">▦</span><span class="room-row-text"><strong>${escape(r.name)}</strong><small>${occupants(r).map(a=>escape(a.name)).join("、")||"暂无成员"}</small></span><span class="capacity">${occupants(r).length}/${r.capacity}</span>${icon("arrow")}</button>`;}
let toastTimer:ReturnType<typeof setTimeout>|undefined;
function toast(message:string){clearTimeout(toastTimer);$("#toast").textContent=message;$("#toast").classList.add("visible");toastTimer=setTimeout(()=>$("#toast").classList.remove("visible"),2500);}
function addEvent(message:string){office.events.unshift({at:new Date().toISOString(),message});office.events=office.events.slice(0,20);}
function moveAgent(a:Agent,activity:Activity){if(!assignActivity(office,a,activity)){toast(labels[activity]+"房间已满");return false;}localRevision++;addEvent(a.name+" → "+labels[activity]+" · 仅本页模拟");return true;}
function extendRoom(){if(office.rooms.length>=20){toast("本演示最多 20 间房");return;}const i=office.rooms.length-7,x=1260+Math.floor(i/2)*300,y=i%2?385:30;office.rooms.push({id:"extra-"+i,name:"会议室 "+String.fromCharCode(67+i),kind:"meeting",topic:"空闲",capacity:8,x,y,w:280,h:260});localRevision++;addEvent("扩建了一间示例会议室");zoom=1;dx=dy=0;closeViews();dx=Math.min(0,cameraWidth-officeWidth());updateTransform();toast("示例会议室已扩建");}
mount();
const controller=new AbortController(),readTimeout=setTimeout(()=>controller.abort(),8000),initialRevision=localRevision;
fetch("/api/demo/state",{signal:controller.signal}).then(r=>{if(!r.ok)throw new Error("read failed");return r.json();}).then(data=>{if(!validateOffice(data))throw new Error("invalid demo state");lastSuccessfulReadAt=new Date().toISOString();if(localRevision===initialRevision){const focused=focusKey(document.activeElement);office=data;snapshotSource="server";renderOffice();if($<HTMLDialogElement>("#detail").open){renderView();restoreFocus(focused);}}renderStatus();}).catch(()=>{readFailed=true;renderStatus();toast("离线 · 使用本地合成示例");}).finally(()=>clearTimeout(readTimeout));
