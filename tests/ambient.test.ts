import {describe,it,expect} from "vitest";
import {appearance,characterArt,actions,species} from "../src/ambient";

describe("local character appearance",()=>{
 it("keeps species stable while the ambient action rotates",()=>{
  const first=appearance("atlas","working",0);
  const frames=Array.from({length:48},(_,tick)=>appearance("atlas","working",tick));
  expect(new Set(frames.map(frame=>frame.species))).toEqual(new Set([first.species]));
  expect(new Set(frames.map(frame=>frame.action))).toEqual(new Set(["typing","drink","stretch","snack"]));
  expect(appearance("atlas","working",0)).toEqual(first);
 });
 it("gives offline characters a resting appearance and fishing its own routine",()=>{
  for(let tick=0;tick<30;tick++)expect(appearance("mira","offline",tick).action).toBe("rest");
  expect(Array.from({length:24},(_,tick)=>appearance("mira","fishing",tick).action)).toContain("fish");
 });
 it("produces distinct silhouettes and recognizable props for every preview",()=>{
  const silhouettes=Object.keys(species).map(kind=>characterArt({species:kind as keyof typeof species,action:"typing",phase:0},"#abcdef",false));
  expect(new Set(silhouettes).size).toBe(4);
  const looks=Object.keys(actions).map(action=>characterArt({species:"cat",action:action as keyof typeof actions,phase:0},"#abcdef",false));
  expect(new Set(looks).size).toBe(7);
  expect(looks.every(art=>art.includes("#abcdef")&&!art.includes("undefined"))).toBe(true);
 });
});
