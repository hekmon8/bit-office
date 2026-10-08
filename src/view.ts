/** Source freshness, independent of demo activity and Agent connectivity. */
export function readFreshness(lastRead:string|null,failed:boolean,now=Date.now()){
 if(failed)return {stale:false,label:"服务器读取失败 · 本地示例"};
 if(!lastRead)return {stale:false,label:"本地示例生成 · 未读取服务器"};
 const age=now-Date.parse(lastRead),stale=!Number.isFinite(age)||age>120000||age<0;
 return {stale,label:stale?"服务器读取已过期 · 旧快照":"服务器读取有效 · 合成示例"};
}
