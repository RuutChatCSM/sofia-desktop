import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { parseRolloutItems, parseRolloutLines, TRANSCRIPT_RETAINED_CHARS } from "../../apps/server/src/codex-rollout-items";
import { readRolloutLines } from "../../apps/server/src/rollout-lines";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const record = (text: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ text }] } });

test("bounded rollout parsing preserves stable IDs, tool output and turn timing", () => {
  const lines = [JSON.stringify({ type: "event_msg", timestamp: "2026-10-12T01:00:00Z", payload: { type: "task_started", turn_id: "t" } }), ...Array.from({ length: 20 }, (_, i) => record(`message ${i}`)), JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "call", name: "read_file", arguments: '{}' } }), JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call", output: "read result" } }), JSON.stringify({ type: "event_msg", timestamp: "2026-10-12T01:00:10Z", payload: { type: "task_complete", turn_id: "t" } })];
  const bounded = parseRolloutLines(lines, 3);
  expect(bounded).toEqual(parseRolloutItems(lines.join("\n"), 100).slice(-3));
  expect(bounded.at(-1)?.item.result).toBe("read result");
  expect(bounded[0].item.turnCompletedAt).toBe(Date.parse("2026-10-12T01:00:10Z"));
});

test("retained transcript payload is bounded even below the item count limit", () => {
  function* lines() { for (let i = 0; i < 2000; i++) yield record(`${i}:` + "x".repeat(20_000)); }
  const items = parseRolloutLines(lines(), 2000);
  expect(items.length).toBeLessThan(2000);
  expect(JSON.stringify(items).length).toBeLessThan(TRANSCRIPT_RETAINED_CHARS + 100_000);
  expect(items.at(-1)?.item.text).toMatch(/^1999:/);
  expect(items.at(-1)?.item.id).toBe(":item:1999");
});

test("chunked rollout reader preserves UTF-8 across boundaries and an unterminated last line", () => {
  const root = mkdtempSync(join(tmpdir(), "sofia-rollout-lines-"));
  try {
    const path = join(root, "history.jsonl");
    const lines = ["x".repeat(256 * 1024 - 1) + "🌍", "last"];
    writeFileSync(path, lines.join("\n"));
    expect([...readRolloutLines(path)]).toEqual(lines);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("100 MB history parses under a 64 MB V8 heap", { timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "sofia-rollout-heap-"));
  try {
    const path = join(root, "history.jsonl");
    const line = record("x".repeat(20_000)) + "\n";
    writeFileSync(path, "");
    for (let i = 0; i < 5200; i++) appendFileSync(path, line);
    const parser = pathToFileURL(join(process.cwd(), "../apps/server/dist/codex-rollout-items.js")).href;
    const reader = pathToFileURL(join(process.cwd(), "../apps/server/dist/rollout-lines.js")).href;
    const source = `import {parseRolloutLines} from ${JSON.stringify(parser)}; import {readRolloutLines} from ${JSON.stringify(reader)}; const items=parseRolloutLines(readRolloutLines(${JSON.stringify(path)}),10); console.log(JSON.stringify({count:items.length,last:items.at(-1).item.id}));`;
    const result = execFileSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "-e", source], { encoding: "utf8", timeout: 45_000, maxBuffer: 1024 * 1024 });
    expect(JSON.parse(result)).toEqual({ count: 10, last: ":item:5199" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("overlapping session reads share one request and completed payloads are not cached", async () => {
  const { CodexSessionManager } = await import("../../apps/server/src/codex-sessions");
  const manager = new CodexSessionManager({ bin: "/unused-mocked-transport", cwd: "/tmp" });
  manager.start = async () => {};
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  Reflect.set(manager, "engine", { listThreadItems: async () => { reads++; await gate; return { items: [{ turnId: "t", item: { type: "agentMessage", id: "answer", text: "result" } }] }; } });
  Reflect.set(manager, "sessions", new Map([["session", { id: "session", threadId: "thread", title: "test", status: "idle" }]]));
  const first = manager.getSessionItems("session");
  const second = manager.getSessionItems("session");
  expect(second).toBe(first);
  release();
  expect(await first).toEqual([{ turnId: "t", item: { type: "agentMessage", id: "answer", text: "result" } }]);
  expect(reads).toBe(1);
  await manager.getSessionItems("session");
  expect(reads).toBe(2);
});

test("history hydration concurrency stays bounded and errors release a slot", async () => {
  const { HistoryReadScheduler } = await import("../../apps/server/src/history-read-scheduler");
  const scheduler = new HistoryReadScheduler(2);
  let active = 0;
  let peak = 0;
  let started = 0;
  const releases: Array<() => void> = [];
  const jobs = Array.from({ length: 4 }, (_, i) => scheduler.run(async () => {
    active++; started++; peak = Math.max(peak, active);
    await new Promise<void>(resolve => releases.push(resolve));
    active--;
    if (i === 0) throw new Error("test read failure");
    return i;
  }));
  const settled = Promise.allSettled(jobs);
  expect(started).toBe(2);
  releases.shift()!();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(started).toBe(3);
  while (releases.length) {
    releases.shift()!();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  expect((await settled).map(result => result.status)).toEqual(["rejected", "fulfilled", "fulfilled", "fulfilled"]);
  expect(peak).toBe(2);
  expect(await scheduler.run(async () => "next")).toBe("next");
});
