import { expect } from "vitest";
import { test } from "@sofia/testkit";
import type { UIMessage } from "ai";
import { deriveRecordedSubagents, deriveCodexSubagents, deriveSessionSubagents, mergeSessionSubagents, summarizeSessionSubagents } from "../../apps/app/src/react-app/domains/session/panel/session-subagents";

test("actual task state is replay deduplicated and failures never count as done", () => {
  const messages: UIMessage[] = [{ id: "one", role: "assistant", parts: [
    { type: "dynamic-tool", toolName: "task", toolCallId: "a", state: "input-available", input: { description: "Research", prompt: "Read", subagent_type: "research" } },
    { type: "dynamic-tool", toolName: "task", toolCallId: "b", state: "output-error", input: {}, errorText: "failed" },
  ] }, { id: "two", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "task", toolCallId: "a", state: "output-available", input: { description: "Research" }, output: "Result" }] }];
  const agents = deriveSessionSubagents(messages);
  expect(agents).toHaveLength(2);
  expect(summarizeSessionSubagents(agents)).toMatchObject({working: 0, done: 1, failed: 1});
  expect(agents[0].part?.state).toBe("output-available");
});

test("Codex canonical agent updates count receiver agents rather than tool calls", () => {
  const items = [{item:{type:"collabAgentToolCall",prompt:"Read sources",agentsStates:{a:{status:"running",message:null},b:{status:"running",message:null}}}},
    {item:{type:"collabAgentToolCall",agentsStates:{a:{status:"completed",message:"Research result"},b:{status:"errored",message:"failed"}}}}];
  const agents=deriveCodexSubagents(items);
  expect(agents).toHaveLength(2);
  expect(agents[0]).toMatchObject({id:"a",threadId:"a",title:"Read sources",status:"done",message:"Research result"});
  expect(summarizeSessionSubagents(agents)).toMatchObject({working:0,done:1,failed:1});
  expect(deriveCodexSubagents([{item:{type:"collabAgentToolCall",status:"completed"}}])).toEqual([]);
});

test("working receiver avatars take priority and compact summary caps at four", () => {
  const agents = deriveCodexSubagents([{item:{type:"collabAgentToolCall",agentsStates:{done:{status:"completed"},a:{status:"running"},b:{status:"running"},c:{status:"running"},d:{status:"pendingInit"},e:{status:"running"}}}}]);
  const summary = summarizeSessionSubagents(agents);
  expect(summary.working).toBe(5);
  expect(summary.done).toBe(1);
  expect(summary.avatars.map(agent=>agent.id)).toEqual(["a","b","c","d"]);
});

test("unknown and stopped lifecycle states stay distinct from failed", () => {
  const agents = deriveCodexSubagents([{item:{type:"collabAgentToolCall",agentsStates:{unknown:{status:"notFound"},future:{status:"newStatus"},stopped:{status:"shutdown"},interrupted:{status:"interrupted"}}}}]);
  expect(summarizeSessionSubagents(agents)).toMatchObject({working:0,done:0,failed:0,stopped:2,unknown:2});
});

test("both engine and Codex recorded agents appear in merged overview", () => {
  const taskAgents=deriveSessionSubagents([{id:"task",role:"assistant",parts:[{type:"dynamic-tool",toolName:"task",toolCallId:"task-run",state:"output-available",input:{description:"Read source"},output:"done"}]}]);
  const codexAgents=deriveCodexSubagents([{item:{type:"collabAgentToolCall",agentsStates:{child:{status:"running",message:"checking"}}}}]);
  expect(mergeSessionSubagents(taskAgents,codexAgents).map(agent=>agent.id)).toEqual(["task-run","child"]);
});

test("successful background launch does not fabricate agent completion", () => {
  const agents=deriveSessionSubagents([{id:"launch",role:"assistant",parts:[{type:"dynamic-tool",toolName:"task",toolCallId:"background",state:"output-available",input:{description:"Background research",background:true},output:"launched"}]}]);
  expect(agents[0].status).toBe("unknown");
});

test("pre-update session caches without a subagents field render safely", () => {
  const codexAgents=deriveCodexSubagents([{item:{type:"collabAgentToolCall",agentsStates:{child:{status:"running",message:"checking"}}}}]);
  expect(mergeSessionSubagents(undefined,[])).toEqual([]);
  expect(mergeSessionSubagents(undefined,codexAgents)).toEqual(codexAgents);
});


test("recorded idle children retain ancestry and unknown completion rather than fabricated success",async()=>{
  const {deriveRecordedSubagents}=await import("../../apps/app/src/react-app/domains/session/panel/session-subagents");
  expect(deriveRecordedSubagents([{threadId:"child",title:"New session",agentNickname:"Research worker",status:"idle"}])).toEqual([{id:"child",threadId:"child",title:"Research worker",status:"unknown"}]);
});

test("explicit child outcomes and task paths supply readable identities and completion",async()=>{
  const {deriveRecordedSubagents}=await import("../../apps/app/src/react-app/domains/session/panel/session-subagents");
  const agents=deriveRecordedSubagents([{threadId:"child",title:"New session",agentNickname:"Pascal",agentPath:"/root/session_list_parent_fix",status:"idle",agentStatus:"completed",agentUpdatedAt:"2026-10-11T02:00:00Z"}]);
  expect(agents[0]).toMatchObject({title:"Session list parent fix",status:"done",updatedAt:"2026-10-11T02:00:00Z"});
  expect(mergeSessionSubagents(agents,[{id:"child",threadId:"child",title:"Subagent",status:"working"}])[0]).toMatchObject({title:"Session list parent fix",status:"working",updatedAt:"2026-10-11T02:00:00Z"});
});

test("Sofia avatar pack has stable identity and a range of original marks",async()=>{
  const {agentAvatarIdentity,AgentAvatar}=await import("../../apps/app/src/react-app/domains/session/panel/agent-avatar");
  expect(agentAvatarIdentity("worker-a")).toEqual(agentAvatarIdentity("worker-a"));
  const identities=Array.from({length:100},(_,index)=>agentAvatarIdentity(`thread-${index}`));
  expect(new Set(identities.map(identity=>identity.shape)).size).toBe(6);
  expect(new Set(identities.map(identity=>identity.palette)).size).toBe(8);
  const element=AgentAvatar({id:"worker-a"});
  expect(element.type).toBe("svg");
  expect(element.props["data-agent-avatar"]).toBe("worker-a");
  expect(element.props["aria-hidden"]).toBe("true");
});

test("summary counts completed agents without relabelling failed attempts as Done", async () => {
  const { SessionSubagentsSection } = await import('../../apps/app/src/react-app/domains/session/panel/session-subagents-section');
  const agents = Array.from({length:22}, (_, index) => ({id:String(index),title:'Agent',status:index<19?'done' as const:'failed' as const}));
  const section=SessionSubagentsSection({agents,onOpen:()=>{}});
  const button=section?.props.children[1];
  expect(button.props.children[1].props.children).toBe('19 done');
  expect(summarizeSessionSubagents(agents).failed).toBe(3);
});

test("native started activity immediately counts working and keeps canonical name", () => {
  const live = deriveCodexSubagents([{ item: { type: "subAgentActivity", agentThreadId: "child", kind: "started", agentPath: "/root/frontend_architecture" } }]);
  expect(live).toMatchObject([{ title: "Frontend architecture", status: "working" }]);
  expect(summarizeSessionSubagents(live).working).toBe(1);
  const persisted = deriveRecordedSubagents([{ threadId: "child", title: "Frontend architecture", agentPath: "/root/frontend_arch", status: "idle" }]);
  expect(persisted[0].title).toBe("Frontend architecture");
  expect(mergeSessionSubagents(persisted, live)[0]).toMatchObject({ title: "Frontend architecture", status: "working" });
  expect(mergeSessionSubagents(live, persisted)[0].status).toBe("working");
});
test("spawn receivers count working before terminal agent state exists", () => {
  expect(deriveCodexSubagents([{ item: { type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["child"], title: "Server architecture" } }])[0]).toMatchObject({ title: "Server architecture", status: "working" });
});
