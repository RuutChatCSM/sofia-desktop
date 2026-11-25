import { EventEmitter } from "node:events";
import { expect, vi } from "vitest";
import { test } from "@sofia/testkit";
import { installRendererRecovery } from "../../apps/desktop/electron/renderer-recovery.mjs";

function setup() {
  const contents = Object.assign(new EventEmitter(), { reload: vi.fn() });
  const window = { webContents: contents, isDestroyed: vi.fn(() => false) };
  const dialog = { showMessageBox: vi.fn(async () => ({ response: 0 })) };
  const log = { error: vi.fn() };
  installRendererRecovery(window, dialog, log);
  const crash = () => contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 5 });
  return { contents, window, dialog, log, crash };
}

test("renderer crash logs the cause and waits for the recovery choice before reloading", async () => {
  const state = setup();
  state.crash();
  expect(state.contents.reload).not.toHaveBeenCalled();
  expect(state.log.error).toHaveBeenCalledWith(expect.any(String), { reason: "crashed", exitCode: 5 });
  await vi.waitFor(() => expect(state.contents.reload).toHaveBeenCalledTimes(1));
});

test("renderer recovery ignores clean exits and respects dismissal", async () => {
  const state = setup();
  state.contents.emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });
  expect(state.dialog.showMessageBox).not.toHaveBeenCalled();
  state.dialog.showMessageBox.mockResolvedValue({ response: 1 });
  state.crash();
  await Promise.resolve();
  expect(state.dialog.showMessageBox).toHaveBeenCalledTimes(1);
  expect(state.contents.reload).not.toHaveBeenCalled();
});

test("duplicate crashes do not stack prompts or reload a closed window", async () => {
  const state = setup();
  state.crash();
  state.crash();
  state.window.isDestroyed.mockReturnValue(true);
  await Promise.resolve();
  expect(state.dialog.showMessageBox).toHaveBeenCalledTimes(1);
  expect(state.contents.reload).not.toHaveBeenCalled();
});

test("failed recovery is logged and permits a subsequent recovery", async () => {
  const state = setup();
  const error = new Error("window closed");
  state.dialog.showMessageBox.mockRejectedValue(error);
  state.crash();
  await vi.waitFor(() => expect(state.log.error).toHaveBeenCalledWith("[sofia] renderer recovery failed", error));
  state.dialog.showMessageBox.mockResolvedValue({ response: 0 });
  state.crash();
  await vi.waitFor(() => expect(state.contents.reload).toHaveBeenCalledTimes(1));
});
