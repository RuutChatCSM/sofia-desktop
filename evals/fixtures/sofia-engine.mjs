import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const csv = (value) => (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
const logPath = process.env.SOFIA_FIXTURE_LOG;
const log = (method) => { if (logPath) appendFileSync(logPath, `${method}\n`); };
// `loaded` models threads this app-server has loaded (it holds their writer
// lock); `held` models another Sofia process holding them, which also rejects
// resume but does not show up in `thread/loaded/list`.
const loaded = new Set(csv(process.env.SOFIA_FIXTURE_LOADED));
const held = new Set(csv(process.env.SOFIA_FIXTURE_WRITER_HELD));
// Unified-exec background terminals this fixture pretends to own.
const backgroundTerminals = new Map();
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params: p = {} } = JSON.parse(line);
  if (!method || id === undefined) return;
  log(method);
  let result = {};
  switch (method) {
    case "initialize": result = { userAgent: "sofia-contract-fixture" }; break;
    case "thread/list": result = { data: [
      { id: "local", name: "Persisted title", preview: "old", cwd: process.cwd(), createdAt: 1700000000 },
      { id: "other", name: "Other workspace", cwd: "/another-workspace", createdAt: 1700000000 },
    ] }; break;
    case "thread/start": result = { thread: { id: "new" } }; break;
    case "thread/settings/update": break;
    case "thread/loaded/list": result = { data: [...loaded] }; break;
    case "thread/resume":
      if (held.has(p.threadId) || loaded.has(p.threadId))
        return send({ id, error: { code: -32600, message: `thread ${p.threadId} already has an active writer` } });
      loaded.add(p.threadId);
      break;
    case "thread/unsubscribe": loaded.delete(p.threadId); break;
    case "thread/name/set":
      if (!p.name) return send({ id, error: { code: -32602, message: "name is required" } });
      break;
    case "turn/start":
      send({ method: "turn/started", params: { threadId: p.threadId, turn: { id: "turn-active", status: "inProgress" } } });
      if (process.env.SOFIA_FIXTURE_BACKGROUND_TERMINAL === "1") {
        backgroundTerminals.set("1234", {
          itemId: "call-bg-1",
          processId: "1234",
          command: "pnpm dev",
          cwd: process.cwd(),
        });
        send({
          method: "item/started",
          params: {
            threadId: p.threadId,
            turnId: "turn-active",
            item: {
              type: "commandExecution",
              id: "call-bg-1",
              command: "pnpm dev",
              cwd: process.cwd(),
              processId: "1234",
              source: "unifiedExecStartup",
              status: "inProgress",
            },
          },
        });
      }
      if (
        process.env.SOFIA_FIXTURE_BACKGROUND_TERMINAL === "1" &&
        process.env.SOFIA_FIXTURE_BACKGROUND_TERMINAL_FAIL === "1"
      ) {
        // Model a dev server that dies on its own after starting.
        backgroundTerminals.delete("1234");
        send({
          method: "item/completed",
          params: {
            threadId: p.threadId,
            turnId: "turn-active",
            item: {
              type: "commandExecution",
              id: "call-bg-1",
              command: "pnpm dev",
              cwd: process.cwd(),
              processId: "1234",
              source: "unifiedExecStartup",
              status: "failed",
              exitCode: 1,
            },
          },
        });
      }
      if (process.env.SOFIA_FIXTURE_COMPLETE_BEFORE_START_REPLY === "1") {
        send({ method: "turn/completed", params: { threadId: p.threadId, turn: { id: "turn-active", status: "completed" } } });
      }
      result = { turn: { id: "turn-active" } };
      break;
    case "thread/backgroundTerminals/list":
      result = { data: [...backgroundTerminals.values()], nextCursor: null };
      break;
    case "thread/backgroundTerminals/terminate": {
      const terminal = backgroundTerminals.get(String(p.processId));
      if (terminal) {
        backgroundTerminals.delete(String(p.processId));
        send({
          method: "item/completed",
          params: {
            threadId: p.threadId,
            turnId: "turn-active",
            item: {
              type: "commandExecution",
              id: terminal.itemId,
              command: terminal.command,
              cwd: terminal.cwd,
              processId: terminal.processId,
              source: "unifiedExecStartup",
              status: "completed",
              exitCode: 0,
            },
          },
        });
      }
      result = { terminated: Boolean(terminal) };
      break;
    }
    case "thread/backgroundTerminals/clean": {
      for (const terminal of backgroundTerminals.values()) {
        send({
          method: "item/completed",
          params: {
            threadId: p.threadId,
            turnId: "turn-active",
            item: {
              type: "commandExecution",
              id: terminal.itemId,
              command: terminal.command,
              cwd: terminal.cwd,
              processId: terminal.processId,
              source: "unifiedExecStartup",
              status: "completed",
              exitCode: 0,
            },
          },
        });
      }
      backgroundTerminals.clear();
      result = {};
      break;
    }
    case "turn/steer":
      if (process.env.SOFIA_FIXTURE_REJECT_STEER === "1") return send({ id, error: { code: -32602, message: "active turn cannot be steered" } });
      if (process.env.SOFIA_FIXTURE_STALE_COMPLETION === "1") {
        send({ method: "turn/completed", params: { threadId: p.threadId, turn: { id: "older-turn", status: "completed" } } });
      } else {
        send({ method: "turn/completed", params: { threadId: p.threadId, turn: { id: "turn-active", status: "completed" } } });
      }
      result = { turnId: "turn-active" };
      break;
    case "turn/interrupt":
      if (p.turnId !== "turn-active") return send({ id, error: { code: -32602, message: "turnId is required" } });
      send({ method: "turn/completed", params: { threadId: p.threadId, turn: { id: p.turnId, status: "interrupted" } } });
      break;
    case "thread/archive":
    case "thread/unarchive": break;
    case "thread/delete": return send({ id, error: { code: -32000, message: "delete rejected" } });
    case "thread/items/list":
      result = process.env.SOFIA_FIXTURE_ITEMS === "1"
        ? { data: [
            { turnId: "t1", item: { id: "m1", type: "userMessage", content: [{ type: "text", text: "first" }] } },
            { turnId: "t2", item: { id: "m2", type: "userMessage", content: [{ type: "text", text: "second" }] } },
          ] }
        : { data: [] };
      break;
    case "thread/fork": {
      const expectedLastTurn = process.env.SOFIA_FIXTURE_EXPECT_FORK_LAST_TURN;
      if (expectedLastTurn && p.lastTurnId !== expectedLastTurn) {
        return send({ id, error: { code: -32602, message: `expected fork lastTurnId ${expectedLastTurn}, got ${p.lastTurnId}` } });
      }
      result = { thread: { id: "forked-1" } };
      break;
    }
    default: return send({ id, error: { code: -32601, message: `unexpected method ${method}` } });
  }
  send({ id, result });
});
