#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) { console.log("sofia 0.1.0"); process.exit(0); }
const home = process.env.SOFIA_HOME;
const loaded = new Set();
let next = 0;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  appendFileSync(join(home, "requests.jsonl"), JSON.stringify({ method, params }) + "\n");
  const fail = (message) => send({ id, error: { code: -32600, message } });
  let result = {};
  switch (method) {
    case "initialize":
      result = { userAgent: params.clientInfo.name, sofiaHome: home };
      break;
    case "thread/list":
      result = { data: ["saved", "legacy", "bad-provider", "reject-turn"].map((id) => ({
        id, name: id, cwd: process.cwd(), createdAt: 1700000000,
        ...(id === "legacy" ? { rolloutPath: join(home, "legacy.jsonl") } : {}),
      })) };
      break;
    case "thread/start": {
      const config = readFileSync(join(home, "config.toml"), "utf8");
      if (params.modelProvider && !config.includes(`[model_providers.${params.modelProvider}]`)) {
        return fail(`failed to load configuration: Model provider \`${params.modelProvider}\` not found`);
      }
      const threadId = `new-${++next}`;
      loaded.add(threadId);
      result = { thread: { id: threadId } };
      break;
    }
    case "thread/resume":
      if (params.threadId === "legacy" && params.path !== join(home, "legacy.jsonl")) return fail("no rollout found for thread id legacy");
      if (params.threadId === "bad-provider") return fail("failed to load configuration: Model provider `missing` not found");
      // New threads have no rollout until their first turn. They must not be resumed.
      if (params.threadId.startsWith("new-")) return fail("no rollout found for thread id " + params.threadId);
      loaded.add(params.threadId);
      break;
    case "thread/settings/update":
    case "turn/start":
      if (!loaded.has(params.threadId)) return fail("thread not found: " + params.threadId);
      if (params.threadId === "reject-turn") return fail("turn rejected by provider");
      result = { turn: { id: "active" } };
      break;
    case "thread/name/set": break;
    case "thread/items/list": result = { data: [] }; break;
    default: return fail(`unexpected method ${method}`);
  }
  send({ id, result });
});
