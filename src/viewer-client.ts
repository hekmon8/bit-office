import { adaptOffice } from "./office-adapter";
import { executionState, type Agent, type Office } from "./model";
export type ViewerAgent = Omit<Agent, "lastSeenAt"> & { lastSeenAt: string | null; tasksComplete?: boolean; tasksObservedAt?: string };
export type ViewerOffice = Omit<Office, "mode" | "source" | "agents"> & { mode: "demo" | "live"; source: "synthetic" | "managed"; agents: ViewerAgent[]; retiredCount?: number };
export function privateSnapshot(value: unknown): ViewerOffice {
 const snapshot = adaptOffice(value);
 if (snapshot.mode !== "live" || snapshot.source !== "managed") throw Error("invalid_private_snapshot");
 return { ...snapshot, mode: "live", source: "managed" };
}
export function displayedExecution(agent: ViewerAgent, privateMode: boolean, readFresh: boolean, now = Date.now()) {
 const age = agent.tasksObservedAt ? now - Date.parse(agent.tasksObservedAt) : Infinity;
 const fresh = readFresh && (!privateMode || Number.isFinite(age) && age >= 0 && age <= 120000);
 const execution = executionState(agent.tasks, privateMode ? agent.tasksComplete === true : true, fresh);
 if (privateMode && !fresh) execution.label = "未知";
 return execution;
}

/** Keep an already-open status dialog consistent with current read and report freshness. */
export function syncPrivateUnknownCount(target: Pick<HTMLElement,"textContent"> | null, agents: ViewerAgent[], readFresh: boolean, now = Date.now()) {
 if (target) target.textContent = `${agents.filter(a => displayedExecution(a,true,readFresh,now).label === "未知").length} 位成员任务状态未知`;
}
