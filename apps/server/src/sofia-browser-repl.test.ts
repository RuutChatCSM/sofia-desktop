import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { afterEach, describe, expect, test } from "bun:test";

const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
});

function startRepl() {
  const child = spawn("node", [join(import.meta.dir, "sofia-browser-repl.mjs")], {
    env: { ...process.env, SOFIA_BROWSER_CDP_URL: "http://127.0.0.1:1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const lines = createInterface({ input: child.stdout });
  const replies = new Map<number, (value: any) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as { id?: number };
    if (message.id != null) replies.get(message.id)?.(message);
  });
  const request = (id: number, method: string, params?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 2_000);
      replies.set(id, (value) => {
        clearTimeout(timer);
        replies.delete(id);
        resolve(value);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return { request };
}

describe("sofia browser Node REPL", () => {
  test("keeps global bindings across tool calls", async () => {
    const repl = startRepl();
    await repl.request(1, "initialize");
    await repl.request(2, "tools/call", {
      name: "js",
      arguments: { code: "globalThis.counter = 41; return counter" },
    });
    const response = await repl.request(3, "tools/call", {
      name: "js",
      arguments: { code: "globalThis.counter += 1; return counter" },
    });
    expect(response.result.content).toEqual([{ type: "text", text: "42" }]);
  });

  test("returns screenshot-like values as MCP image content", async () => {
    const repl = startRepl();
    const response = await repl.request(1, "tools/call", {
      name: "js",
      arguments: { code: 'return { data: "YWJj", mimeType: "image/png" }' },
    });
    expect(response.result.content).toEqual([
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ]);
  });
});
