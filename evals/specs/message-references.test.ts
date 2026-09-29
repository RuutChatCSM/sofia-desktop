import { expect } from "vitest";
import { test } from "@sofia/testkit";
import {
  createMessageReference, serializeMessageReference, parseMessageReference, messageReferences,
} from "../../apps/app/src/react-app/domains/session/surface/composer/message-reference";

test("references survive the text-only message transport without an editor mention map", async ({ evidence }) => {
  const folder = createMessageReference("sofia-cloud/", "tools");
  const file = createMessageReference('src/a ] "quoted" file.ts', "tools");
  const text = `${serializeMessageReference(folder)} review the provider ${serializeMessageReference(file)}`;
  const persisted = JSON.parse(JSON.stringify({ text }));
  expect(messageReferences(persisted.text, "tools")).toEqual([folder, file]);
  expect(messageReferences(persisted.text, "tools")[0].label).toBe("sofia-cloud");
  expect(parseMessageReference("[Folder: not valid JSON]")).toBeNull();
  const scoped = createMessageReference("sofia-cloud/", "tools", "/Users/mona/Dev/tools");
  expect(scoped.path).toBe("/Users/mona/Dev/tools/sofia-cloud/");
  expect(scoped.label).toBe("sofia-cloud");
  evidence.recordAssertionEvidence(
    "Selections remain recoverable after persistence, resend and transcript copying",
    "A folder stays one reference; quotes, spaces and brackets in a filename round-trip through the same codec used by the editor, sent transcript and draft builder.", true,
  );
});

test("multiple references keep their order and remain separate from prose", async ({ evidence }) => {
  const references = ["sofia-cloud/", "sofia-app/"].map((path) => createMessageReference(path, "tools"));
  const text = references.map(serializeMessageReference).join(" and ") + " compare models";
  expect(messageReferences(text, "tools")).toEqual(references);
  expect(text.replace(/\[(?:File|Folder|Repository): "(?:[^"\\]|\\.)*"\]/g, "")).toBe(" and  compare models");
  evidence.recordAssertionEvidence("References do not swallow the user's prose", "Two folder selections retain their order and leave the surrounding request intact.", true);
});
