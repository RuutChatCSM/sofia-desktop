/**
 * Electron quits the main process on an uncaught exception or an unhandled
 * rejection. Several host surfaces run inside WebContents event handlers — the
 * browser panel, the UI-control bridge — and those can throw for a
 * *recoverable* reason: a render frame disposed by a window reload, a built-in
 * browser tab destroyed mid-navigation. Killing the whole workspace for that is
 * far worse than reporting it, and each surface re-derives its state on the
 * next event anyway.
 *
 * This only turns "die" into "report": real faults still reach the log.
 */
const guardedTargets = new WeakSet();

/**
 * Install once-per-process error guards. Only `on` is needed, so tests can pass
 * a plain emitter in place of `process`.
 *
 * @param {{ on?: (event: string, listener: (value: unknown) => void) => unknown }} [target]
 */
export function installMainErrorGuards(target = process) {
  if (!target || typeof target.on !== "function" || guardedTargets.has(target)) return;
  guardedTargets.add(target);

  target.on("uncaughtException", (error) => {
    console.error("[sofia] uncaught exception in the main process", error);
  });
  target.on("unhandledRejection", (reason) => {
    console.error("[sofia] unhandled rejection in the main process", reason);
  });
}
