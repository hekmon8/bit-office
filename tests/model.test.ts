import {describe,it,expect} from "vitest";
import {demoOffice,executionState,validateOffice} from "../src/model";
describe("independent execution projection",()=>{
 it("keeps running, waiting and blocked facts together",()=>expect(executionState([{id:"a",title:"A",status:"running",blocked:true},{id:"b",title:"B",status:"dispatched"},{id:"c",title:"C",status:"waiting_local_directory"}],true,true)).toEqual({running:1,waiting:2,blocked:1,label:"运行"}));
 it("does not infer idle from incomplete or stale data",()=>{expect(executionState([],false,true).label).toBe("未知");expect(executionState([],true,false).label).toBe("未知");});
 it("ignores terminal tasks",()=>expect(executionState([{id:"a",title:"A",status:"failed",blocked:true}],true,true)).toEqual({running:0,waiting:0,blocked:0,label:"空闲"}));
 it("demo validates and clones data",()=>{const a=demoOffice();expect(validateOffice(a)).toBe(true);a.agents[0].name="changed";expect(demoOffice().agents[0].name).toBe("Nova");});
 it("rejects unsafe persisted colors and broken room references",()=>{const o=demoOffice();o.agents[0].color="red;";expect(validateOffice(o)).toBe(false);o.agents[0].color="#123456";o.agents[0].roomId="missing";expect(validateOffice(o)).toBe(false);});
});
