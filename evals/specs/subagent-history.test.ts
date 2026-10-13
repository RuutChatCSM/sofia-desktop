import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { projectSubagentHistory } from "../../apps/app/src/react-app/domains/session/panel/subagent-history";
import { CodexSessionManager, isRecordedSubagent } from "../../apps/server/src/codex-sessions";

test("child history is limited to actual recorded parent receivers", () => {
  const items = [{item:{type:"collabAgentToolCall",agentsStates:{child:{status:"running"}}}}];
  expect(isRecordedSubagent(items,"child")).toBe(true);
  expect(isRecordedSubagent(items,"unrelated")).toBe(false);
  expect(isRecordedSubagent([{item:{type:"agentMessage",agentsStates:{child:{}}}}],"child")).toBe(false);
  expect(isRecordedSubagent([{item:{type:"collabAgentToolCall",agentsStates:[]}}],"child")).toBe(false);
});

test("child history displays recorded messages and outputs without inventing thinking", () => {
  expect(projectSubagentHistory([
    {turnId:"t",item:{id:"u",type:"userMessage",content:[{type:"text",text:"Research files"}]}},
    {turnId:"t",item:{id:"r",type:"reasoning",encryptedContent:"hidden"}},
    {turnId:"t",item:{id:"c",type:"commandExecution",command:"rg title",aggregatedOutput:"found"}},
    {turnId:"t",item:{id:"a",type:"agentMessage",text:"Research complete"}},
  ])).toEqual([{id:"u",label:"User",text:"Research files"},{id:"c",label:"Ran command",text:"found"},{id:"a",label:"Assistant",text:"Research complete"}]);
});


test("opening a child reads its store only after parent validation and never resumes", async () => {
  const reads: string[] = [];
  const manager = {
    getSession() { return null; },
    engine: { resumeThread() { throw new Error("Browsing must not resume a child"); } },
    async getSessionItems(parent: string) {
      expect(parent).toBe("codex-parent");
      return [{item:{type:"collabAgentToolCall",agentsStates:{child:{status:"completed"}}}}];
    },
    async readThreadStoreItems(_engine: unknown, thread: string, limit: number) {
      reads.push(thread); expect(limit).toBe(2000);
      return [{turnId:"t",item:{type:"agentMessage",text:"Child result"}}];
    },
  };
  expect(await Reflect.apply(CodexSessionManager.prototype.getSubagentItems, manager, ["codex-parent","child"])).toEqual([{turnId:"t",item:{type:"agentMessage",text:"Child result"}}]);
  await expect(Reflect.apply(CodexSessionManager.prototype.getSubagentItems, manager, ["codex-parent","other"])).rejects.toThrow("not a recorded subagent");
  expect(reads).toEqual(["child"]);
});

test("rich child messages preserve tool calls, commentary and recorded reasoning while hiding injected context",async()=>{
  const {subagentHistoryMessages}=await import("../../apps/app/src/react-app/domains/session/panel/subagent-history");
  const messages=subagentHistoryMessages([
    {turnId:"t",item:{id:"env",type:"userMessage",content:[{type:"text",text:"<environment_context>private runtime</environment_context>"}]}},
    {turnId:"t",item:{id:"u",type:"userMessage",content:[{type:"text",text:"Research files"}]}},
    {turnId:"t",item:{id:"c",type:"agentMessage",phase:"commentary",text:"Checking files"}},
    {turnId:"t",item:{id:"r",type:"reasoning",summary:[{text:"Recorded summary"}],encryptedContent:"hidden"}},
    {turnId:"t",item:{id:"cmd",type:"commandExecution",command:"rg title",aggregatedOutput:"found",status:"completed"}},
    {turnId:"t",item:{id:"a",type:"agentMessage",phase:"final_answer",text:"Research complete"}},
  ],"child");
  expect(messages.map(message=>message.id)).toEqual(["u","c","r","cmd","a"]);
  expect(messages[1].metadata).toEqual({engine:{turnId:"t",phase:"commentary"}});
  expect(messages[2].parts).toEqual([{type:"reasoning",text:"Recorded summary",state:"done"}]);
  expect(messages[3].parts[0]).toMatchObject({type:"dynamic-tool",toolName:"bash",state:"output-available"});
  expect(JSON.stringify(messages)).not.toContain("private runtime");
  expect(JSON.stringify(messages)).not.toContain("encryptedContent");
});
