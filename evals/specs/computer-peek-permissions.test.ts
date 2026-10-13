import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { installMediaPermissionHandlers } from "../../apps/desktop/electron/media-permissions.mjs";

test("computer Peek grants window capture only to Sofia's local main renderer while a target is selected", ({ evidence }) => {
  const mainWebContents = { id: 7 };
  const mainWindow = { webContents: mainWebContents };
  let check: (contents: { id: number }, permission: string, origin: string, details: { mediaType?: string }) => boolean = () => false;
  let captureActive = false;
  const session = {
    defaultSession: {
      setPermissionRequestHandler() {},
      setPermissionCheckHandler(handler: typeof check) { check = handler; },
    },
  };
  installMediaPermissionHandlers(session, () => mainWindow, () => captureActive);
  expect(check(mainWebContents, "display-capture", "http://localhost:5173", {})).toBe(false);
  captureActive = true;
  expect(check(mainWebContents, "display-capture", "http://localhost:5173", {})).toBe(true);
  expect(check(mainWebContents, "media", "http://localhost:5173", { mediaType: "video" })).toBe(true);
  expect(check({ id: 8 }, "display-capture", "http://localhost:5173", {})).toBe(false);
  expect(check(mainWebContents, "display-capture", "https://claude.ai", {})).toBe(false);
  evidence.recordAssertionEvidence("Native preview capture remains scoped", "Only Sofia's local main renderer receives video permission after a target window is selected; other web contents and remote origins remain denied.", true);
});
