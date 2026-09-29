import { expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { needs, test } from "@sofia/testkit";
import { configuredCodexMcpServers, codexDirectToolNamespacesToml, codexRuntimeSkill } from "../../apps/server/src/codex-runtime-mcp.js";

test("explicitly connected Computer Use is registered and pinned without automatic opt-in", () => {
  const servers = configuredCodexMcpServers({ "computer-use": {
    type: "local", command: ["native-helper", "mcp"], enabled: true,
  } }, []);
  expect(servers).toHaveLength(1);
  expect(servers[0].command).toBe("native-helper");
  expect(codexDirectToolNamespacesToml(servers)).toContain("mcp__computer_use");
  expect(codexRuntimeSkill("computer-use")).toContain("Do not substitute osascript");
  expect(codexRuntimeSkill("computer-use")).toContain("it cannot verify a later action");
  expect(configuredCodexMcpServers({ "computer-use": {
    type: "local", command: ["native-helper", "mcp"], enabled: false,
  } }, [])[0].enabled).toBe(false);
});

test.skipIf(process.platform !== "darwin")("native Computer Use marks failed calls as MCP errors and keeps recovery details", async ({ evidence }) => {
  needs({ commands: ["swift"], placement: "local" });
  const packagePath = resolve(import.meta.dirname, "../../packages/handsfree/native/HandsFree");
  execFileSync("swift", ["build", "--package-path", packagePath], { timeout: 180_000 });
  const binPath = execFileSync("swift", ["build", "--package-path", packagePath, "--show-bin-path"], { encoding: "utf8" }).trim();
  const calls = [
    { id: 1, method: "initialize", params: {} },
    { id: 2, method: "tools/call", params: { name: "launch_app", arguments: {} } },
    { id: 3, method: "tools/call", params: { name: "not_a_tool", arguments: {} } },
    { id: 4, method: "tools/call", params: { name: "snapshot_elements", arguments: { snapshot_id: "missing" } } },
    { id: 5, method: "tools/call", params: { name: "set_strict_mode", arguments: { enabled: true } } },
  ];
  const output = execFileSync(resolve(binPath, "HandsFreeComputerUse"), ["mcp"], {
    input: calls.map((call) => JSON.stringify({ jsonrpc: "2.0", ...call })).join("\n") + "\n",
    encoding: "utf8", timeout: 15_000,
    env: { ...process.env, SOFIA_COMPUTER_USE_CURSOR_OVERLAY: "0" },
  });
  const responses = output.trim().split("\n").map((line) => JSON.parse(line));
  expect(responses).toHaveLength(5);
  for (const id of [2, 3, 4]) {
    const result = responses.find((response) => response.id === id).result;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).ok).toBe(false);
    if (id === 4) expect(JSON.parse(result.content[0].text).requiredNextAction).toBe("snapshot");
  }
  expect(responses.find((response) => response.id === 5).result.isError).toBe(false);
  evidence.recordAssertionEvidence("Computer Use failures are visible to MCP clients", "Invalid app arguments, unknown tools, and missing snapshots fail; setting strict mode succeeds. No desktop input is sent.", true);
}, 200_000);

test.skipIf(process.platform !== "darwin")("bundled macOS helper exposes crop, readiness, right-click, hold and reconnect recovery", () => {
  const binary = resolve(import.meta.dirname, "../../apps/desktop/resources/helpers/Sofia Computer Use.app/Contents/MacOS/ComputerUse");
  needs({ commands: ["node", "swift"], placement: "local" });
  if (!existsSync(binary)) {
    execFileSync("node", [resolve(import.meta.dirname, "../../apps/desktop/scripts/prepare-computer-use-helper.mjs"), "--force"], {timeout:180_000});
  }
  const calls = [
    { id: 1, method: "initialize", params: {} },
    { id: 2, method: "tools/list", params: {} },
    { id: 3, method: "tools/call", params: { name: "snapshot_elements", arguments: { snapshot_id: "old-session" } } },
  ];
  const output = execFileSync(binary, ["mcp"], { encoding: "utf8", timeout: 15_000,
    input: calls.map(call => JSON.stringify({ jsonrpc: "2.0", ...call })).join("\n") + "\n",
    env: { ...process.env, SOFIA_COMPUTER_USE_CURSOR_OVERLAY: "0" },
  });
  const responses = output.trim().split("\n").map(line => JSON.parse(line));
  const tools = responses.find(response => response.id === 2).result.tools;
  const snapshot = tools.find((tool: { name: string }) => tool.name === "snapshot");
  expect(snapshot.inputSchema.properties).toHaveProperty("crop");
  expect(snapshot.inputSchema.properties).toHaveProperty("wait_for");
  expect(tools.find((tool: { name: string }) => tool.name === "click").inputSchema.properties.button.enum).toContain("right");
  expect(tools.find((tool: { name: string }) => tool.name === "press_key").inputSchema.properties.milliseconds.maximum).toBe(5000);
  const failure = responses.find(response => response.id === 3).result;
  expect(failure.isError).toBe(true);
  expect(JSON.parse(failure.content[0].text).requiredNextAction).toBe("snapshot");
});
