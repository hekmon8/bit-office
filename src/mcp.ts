import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { demoOffice, executionState } from "./model";
export const toolNames=["get_office_state","get_agent_state","list_rooms","get_task_handoff","get_connection_info"] as const;
function createServer(){
 const server=new McpServer({name:"bit-office-demo",version:"0.1.0"},{instructions:"Read-only public synthetic demo. No Multica account, real agents, private tasks or execution runtime is connected. Browser-local simulations are not this server snapshot."});
 const result=(value:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(value)}]});
 const meta={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
 server.registerTool("get_office_state",{description:"Read the synthetic demo office. Includes independent execution counts, connectivity and observation timestamps.",inputSchema:{},annotations:meta},async()=>{const o=demoOffice();return result({...o,agents:o.agents.map(a=>({...a,execution:executionState(a.tasks,true,true)}))});});
 server.registerTool("get_agent_state",{description:"Read one synthetic demo agent; online does not mean running.",inputSchema:{agent_id:z.string().min(1).max(64)},annotations:meta},async({agent_id})=>{const o=demoOffice();const a=o.agents.find(a=>a.id===agent_id);return a?result({mode:o.mode,source:o.source,observedAt:o.observedAt,agent:a,execution:executionState(a.tasks,true,true)}):{...result({error:"Demo agent not found"}),isError:true};});
 server.registerTool("list_rooms",{description:"List synthetic rooms and their example occupants; not evidence of real collaboration.",inputSchema:{},annotations:meta},async()=>{const o=demoOffice();return result({mode:o.mode,source:o.source,observedAt:o.observedAt,rooms:o.rooms.map(r=>({...r,members:o.agents.filter(a=>a.roomId===r.id).map(a=>({id:a.id,name:a.name}))}))});});
 server.registerTool("get_task_handoff",{description:"Read explicitly modelled synthetic task delegation. Retry parent IDs are not treated as handoffs.",inputSchema:{task_id:z.string().min(1).max(64)},annotations:meta},async({task_id})=>{const o=demoOffice();const task=o.agents.flatMap(a=>a.tasks).find(t=>t.id===task_id);return result({mode:o.mode,source:o.source,task:task??null,hasHandoff:!!task?.delegatedFrom});});
 server.registerTool("get_connection_info",{description:"Explain which data is demo and what has not been connected.",inputSchema:{},annotations:meta},async()=>result({mode:"demo",source:"synthetic",transport:"streamable_http",readOnly:true,realDataEnabled:false,multicaConnected:false,chatgptConnectionVerified:false,browserSimulation:"local only"}));
 return server;
}
export const mcpHandler=createMcpHandler(createServer);
