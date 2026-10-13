import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { parseExecActions, commandActions } from "../../apps/server/src/codex-exec-actions";
import { parseRolloutItems } from "../../apps/server/src/codex-rollout-items";

test("imported orchestration preserves ordered read, patch and web calls without evaluating code", () => {
  const actions = parseExecActions(`text(await tools.exec_command({cmd:"cat README.md"}));
text(await tools.apply_patch("*** Begin Patch\\n*** Update File: app.ts\\n-old\\n+new\\n*** End Patch"));
text(await tools.web__run({search_query:[{q:'test'}]}));`);
  expect(actions.map(a=>a.tool)).toEqual(["exec_command","apply_patch","web__run"]);
  expect(actions[0].commandActions).toEqual([{type:"read",command:"cat README.md",path:"README.md"}]);
  expect(actions[1].arguments).toContain("\n*** Update File: app.ts\n");
  expect(actions[2].arguments).toEqual({search_query:[{q:"test"}]});
  expect(parseExecActions(`// tools.exec_command({cmd:'fake'})\nconst x="tools.exec_command({cmd:'fake'})"; tools.exec_command({cmd:getSecret()})`)).toEqual([{tool:"exec_command",arguments:{rawInput:"{cmd:getSecret()}"}}]);
  expect(parseExecActions("tools.exec_command({cmd:`cat ${secret}`})")[0].command).toBeUndefined();
});

test("rollout retains exec patch actions and compaction markers without exposing replacement history", () => {
  const rows = parseRolloutItems([
    {type:"turn_context",payload:{turn_id:"turn"}},
    {type:"response_item",payload:{type:"custom_tool_call",name:"exec",call_id:"patch",input:'tools.apply_patch("*** Begin Patch\\n*** End Patch")'}},
    {type:"response_item",payload:{type:"custom_tool_call",name:"exec",call_id:"read",input:'tools.exec_command({cmd:"head README.md"})'}},
    {type:"compacted",payload:{replacement_history:[{role:"system",text:"private prompt"}]}},
  ].map(row=>JSON.stringify(row)).join("\n"));
  expect(rows[0].item.type).toBe("dynamicToolCall");
  expect((rows[0].item.arguments as any).nestedCalls[0].tool).toBe("apply_patch");
  expect(rows[1].item).toMatchObject({type:"commandExecution",command:"head README.md",commandActions:[{type:"read"}]});
  expect(rows[2].item.type).toBe("contextCompaction");
  expect(JSON.stringify(rows)).not.toContain("private prompt");
});

 test("read/search action fields retain quoted paths and mixed commands stay generic", () => {
  expect(commandActions("head 'file name.md'; rg -n needle src")).toEqual([{type:"read",command:"head 'file name.md'",path:"file name.md"},{type:"search",command:"rg -n needle src",query:"needle",path:"src"}]);
  expect(commandActions("cat README; rm file")).toEqual([]);
  expect(commandActions("sed -i s/a/b/ file")).toEqual([]);
  expect(commandActions("cat README > file")).toEqual([]);
 });
