import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { resolveImageBlobReferences, sofiaHomeForRollout } from "./rollout-image-blobs.js";

test("blob references resolve to the stored data URL and missing ones stay", async () => {
  const home = await mkdtemp(join(tmpdir(), "sofia-blobs-"));
  try {
    const dataUrl = `data:image/png;base64,${"A".repeat(20_000)}`;
    const hash = createHash("sha256").update(dataUrl).digest("hex");
    await mkdir(join(home, "blobs", "sha256", hash.slice(0, 2)), { recursive: true });
    await writeFile(join(home, "blobs", "sha256", hash.slice(0, 2), hash), dataUrl);
    const missing = `sofia-blob:sha256:${"0".repeat(64)}`;
    const items = [{ turnId: "t", item: { type: "userMessage", content: [{ type: "image", url: `sofia-blob:sha256:${hash}` }, { type: "image", url: missing }, { type: "text", text: "hi" }] } }];
    await resolveImageBlobReferences(items, home);
    expect(items[0].item.content).toEqual([{ type: "image", url: dataUrl }, { type: "image", url: missing }, { type: "text", text: "hi" }]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a rollout's Sofia home is the parent of its sessions directory", () => {
  expect(sofiaHomeForRollout("/u/.sofia/sessions/2026/11/25/rollout-x.jsonl")).toBe("/u/.sofia");
  expect(sofiaHomeForRollout("/u/.sofia/archived_sessions/rollout-x.jsonl")).toBe("/u/.sofia");
  expect(sofiaHomeForRollout("/tmp/rollout-x.jsonl")).toBeNull();
});
