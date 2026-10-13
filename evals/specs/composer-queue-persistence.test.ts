import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { ComposerQueuePersistence, durableComposerQueue, recoverComposerQueue, type QueuedComposerShape } from "../../apps/app/src/react-app/domains/session/surface/composer-queue-persistence";

function queue(): QueuedComposerShape {
  return { session: [{ id: "draft", deliveryState: "ready", draft: { mode: "prompt", text: "Review file", parts: [{ type: "text", text: "Review file" }], attachments: [{ id: "file", name: "note.txt", mimeType: "text/plain", size: 4, kind: "file", file: new File(["note"], "note.txt", { type: "text/plain" }), previewUrl: "blob:expired-renderer" }] } }] };
}

test("queue recovery keeps attachment bytes and flags uncertain deliveries without resending", async () => {
  const shape = queue();
  const sending = shape.session[0];
  expect(sending).toBeDefined();
  if (!sending) throw new Error("fixture missing");
  sending.deliveryState = "sending";
  const stored = durableComposerQueue(shape);
  expect(stored.session[0]?.draft.attachments[0]?.previewUrl).toBeUndefined();
  expect(await stored.session[0]?.draft.attachments[0]?.file.text()).toBe("note");
  const recovered = recoverComposerQueue(stored);
  expect(recovered.session[0]?.deliveryState).toBe("outcome-unknown");
  expect(recovered.session[0]?.recovered).toBe(true);
  expect(recovered.session[0]?.draft.text).toBe("Review file");
  expect(recovered.session[0]?.draft.attachments[0]?.file.name).toBe("note.txt");
});

test("queue persistence serializes writes so an older sending snapshot cannot overwrite accepted removal", async () => {
  let stored: QueuedComposerShape = {};
  const writes: string[][] = [];
  const repository = new ComposerQueuePersistence({ load: async () => stored, save: async (shape) => { await Promise.resolve(); stored = shape; writes.push(Object.keys(shape)); } });
  const first = repository.save(queue());
  const second = repository.save({});
  await second;
  await first;
  expect(writes).toEqual([["session"], []]);
  expect(await repository.load()).toEqual({});
});

test("a persistence failure rejects the pre-dispatch flush, while a later explicit retry can persist again", async () => {
  let failing = true;
  const repository = new ComposerQueuePersistence({ load: async () => ({}), save: async () => { if (failing) throw new Error("quota"); } });
  await expect(repository.save(queue())).rejects.toThrow("quota");
  await expect(repository.flush()).rejects.toThrow("quota");
  failing = false;
  await repository.save(queue());
  await expect(repository.flush()).resolves.toBeUndefined();
});
