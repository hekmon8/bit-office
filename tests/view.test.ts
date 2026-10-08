import {describe,it,expect} from "vitest";
import {readFreshness} from "../src/view";
describe("source freshness stays separate from local demo activity",()=>{
 const now=Date.parse("2026-10-08T10:00:00Z");
 it("labels built-in fallback without claiming a successful server read",()=>{
  expect(readFreshness(null,false,now).label).toContain("未读取服务器");
  expect(readFreshness(null,true,now).label).toContain("服务器读取失败");
 });
 it("expires a previously successful snapshot after two minutes",()=>{
  expect(readFreshness("2026-10-08T09:58:00Z",false,now).stale).toBe(false);
  expect(readFreshness("2026-10-08T09:57:59Z",false,now).stale).toBe(true);
 });
 it("treats invalid and future read times as uncertain",()=>{
  expect(readFreshness("invalid",false,now).stale).toBe(true);
  expect(readFreshness("2026-10-08T10:01:00Z",false,now).stale).toBe(true);
 });
});
