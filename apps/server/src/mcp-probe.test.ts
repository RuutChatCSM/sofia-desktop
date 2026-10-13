import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probeMcpServer } from "./mcp-probe.js";

const dir = mkdtempSync(join(tmpdir(), "mcp-probe-"));
const scriptPath = join(dir, "server.mjs");
const bannerPath = join(dir, "banner.mjs");

writeFileSync(scriptPath, `
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let index;
  while ((index = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, index);
    buf = buf.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }) + "\\n");
    } else if (message.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "make_video", description: "Make a video" }] } }) + "\\n");
    }
  }
});
`);

// The exact shape of the bug: a skill installer prints a banner and exits.
writeFileSync(bannerPath, `
console.log("skills");
console.log("Tip: use the --yes (-y) flags to install without prompts.");
console.error("Interactive prompt required but stdin is not a TTY. Nothing was installed.");
process.exit(0);
`);

const servers: Array<{ close: () => void }> = [];

afterAll(() => {
  for (const server of servers) server.close();
});

describe("probeMcpServer over stdio", () => {
  test("reports the tools a real MCP server exposes", async () => {
    const result = await probeMcpServer({ command: [process.execPath, scriptPath] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transport).toBe("stdio");
    expect(result.tools).toEqual([{ name: "make_video", description: "Make a video" }]);
  });

  test("fails a command that prints a banner and exits instead of handshaking", async () => {
    const result = await probeMcpServer({ command: [process.execPath, bannerPath], timeoutMs: 10_000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.transport).toBe("stdio");
    expect(result.error).toContain("exited");
  });

  test("fails when the executable does not exist", async () => {
    const result = await probeMcpServer({ command: ["sofia-definitely-not-a-real-binary-xyz"] });
    expect(result.ok).toBe(false);
  });

  test("requires a URL or a command", async () => {
    const result = await probeMcpServer({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("spawn");
  });
});

describe("probeMcpServer over HTTP", () => {
  test("completes initialize and tools/list", async () => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk.toString(); });
      request.on("end", () => {
        const message = JSON.parse(body) as { id?: number; method?: string };
        response.setHeader("content-type", "application/json");
        if (message.method === "initialize") {
          response.setHeader("mcp-session-id", "session-1");
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }));
          return;
        }
        if (message.method === "tools/list") {
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "render" }] } }));
          return;
        }
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, result: {} }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");

    const result = await probeMcpServer({ url: `http://127.0.0.1:${address.port}/mcp` });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transport).toBe("http");
    expect(result.tools).toEqual([{ name: "render" }]);
  });

  test("fails an endpoint that is not an MCP server", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ hello: "not mcp" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");

    const result = await probeMcpServer({ url: `http://127.0.0.1:${address.port}/mcp` });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("initialize");
  });
});
