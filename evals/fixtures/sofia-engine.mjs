import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params: p = {} } = JSON.parse(line);
  if (!method || id === undefined) return;
  let result = {};
  switch (method) {
    case "initialize": result = { userAgent: "sofia-contract-fixture" }; break;
    case "thread/list": result = { data: [
      { id: "local", name: "Persisted title", preview: "old", cwd: process.cwd(), createdAt: 1700000000 },
      { id: "other", name: "Other workspace", cwd: "/another-workspace", createdAt: 1700000000 },
    ] }; break;
    case "thread/start": result = { thread: { id: "new" } }; break;
    case "thread/settings/update": break;
    case "thread/name/set":
      if (!p.name) return send({ id, error: { code: -32602, message: "name is required" } });
      break;
    case "turn/start": result = { turn: { id: "turn-active" } }; break;
    case "turn/interrupt":
      if (p.turnId !== "turn-active") return send({ id, error: { code: -32602, message: "turnId is required" } });
      send({ method: "turn/completed", params: { threadId: p.threadId, turn: { id: p.turnId, status: "interrupted" } } });
      break;
    case "thread/archive":
    case "thread/unarchive": break;
    case "thread/delete": return send({ id, error: { code: -32000, message: "delete rejected" } });
    case "thread/items/list": result = { data: [] }; break;
    default: return send({ id, error: { code: -32601, message: `unexpected method ${method}` } });
  }
  send({ id, result });
});
