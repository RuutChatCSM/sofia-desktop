import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { createAndSelectWorkspace, evalIn, go, waitFor } from "@sofia/behaviors";
import { allocateFreePort } from "@sofia/cdp";
import { desktop, localHost } from "@sofia/hosts";
import { needs, test } from "@sofia/testkit";

const e2eTestsEnabled = process.env.SOFIA_EVAL_E2E_TESTS === "1";
const onMac = process.platform === "darwin";
const enabled = e2eTestsEnabled && onMac;
const title = enabled
  ? "the macOS updater keeps an Alpha selection through a stale check and relaunch"
  : e2eTestsEnabled
    ? `updater channel selection skipped — needs: run on macOS (Alpha is unavailable on ${process.platform})`
    : "updater channel selection skipped — needs: set SOFIA_EVAL_E2E_TESTS=1";

type UpdaterSnapshot = {
  checks: string[];
  setChannels: string[];
  nativeChannel: string | null;
  preferenceChannel: string | null;
  pickerText: string;
  pageText: string;
};

function updaterSnapshot(value: unknown, label: string): UpdaterSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned no updater snapshot: ${JSON.stringify(value)}`);
  }
  const snapshot = value as Record<string, unknown>;
  if (
    !Array.isArray(snapshot.checks) ||
    !snapshot.checks.every((entry) => typeof entry === "string") ||
    !Array.isArray(snapshot.setChannels) ||
    !snapshot.setChannels.every((entry) => typeof entry === "string") ||
    !(snapshot.nativeChannel === null || typeof snapshot.nativeChannel === "string") ||
    !(snapshot.preferenceChannel === null || typeof snapshot.preferenceChannel === "string") ||
    typeof snapshot.pickerText !== "string" ||
    typeof snapshot.pageText !== "string"
  ) {
    throw new Error(`${label} returned an unexpected updater snapshot: ${JSON.stringify(value)}`);
  }
  return snapshot as UpdaterSnapshot;
}

async function installControlledUpdaterBridge(
  app: Parameters<typeof evalIn>[0],
  options: { delayStable: boolean },
): Promise<void> {
  const installed = await evalIn(app, `(() => {
    const nativeUpdater = window.__SOFIA_ELECTRON__?.updater;
    if (!nativeUpdater?.getChannel || !nativeUpdater.setChannel) return false;
    const state = {
      checks: [],
      setChannels: [],
      stableStarted: false,
      stableResolved: false,
      finishStable: null,
    };
    window.__sofiaUpdaterEvalState = state;
    window.__sofiaApplyDesktopConfig?.({ allowAlphaUpdates: true });
    window.__sofiaSetDesktopConfigRefreshResult?.({ allowAlphaUpdates: true });
    window.__sofiaUpdaterEvalBridge = {
      getChannel: () => nativeUpdater.getChannel(),
      setChannel: async (channel) => {
        state.setChannels.push(channel);
        return nativeUpdater.setChannel(channel);
      },
      check: async (channel) => {
        state.checks.push(channel);
        if (${JSON.stringify(options.delayStable)} && channel === "stable") {
          state.stableStarted = true;
          return new Promise((resolve) => {
            state.finishStable = () => {
              state.stableResolved = true;
              resolve({
                available: true,
                channel: "stable",
                currentVersion: "0.18.0",
                latestVersion: "9.9.9",
              });
            };
          });
        }
        return {
          available: false,
          channel,
          currentVersion: "0.18.0",
          latestVersion: channel === "alpha" ? "0.18.0-alpha.1" : "0.18.0",
        };
      },
      download: async () => ({ ok: false, reason: "unused by this updater-channel proof" }),
      installAndRestart: async () => ({ ok: false, reason: "unused by this updater-channel proof" }),
      onDownloadProgress: () => () => {},
    };
    return true;
  })()`);
  expect(installed).toBe(true);
}

async function openUpdates(app: Parameters<typeof evalIn>[0], workspaceId: string): Promise<void> {
  await go(app, `/workspace/${workspaceId}/settings/updates`);
  await waitFor(
    app,
    `window.location.hash.includes("/settings/updates")
      && Boolean(document.querySelector('[aria-label="Release channel"]'))`,
    { timeoutMs: 60_000, label: "public macOS Updates page with release channel picker" },
  );
}

async function selectAlpha(app: Parameters<typeof evalIn>[0]): Promise<void> {
  const triggerPoint = await evalIn(app, `(() => {
    const trigger = document.querySelector('[aria-label="Release channel"]');
    if (!(trigger instanceof HTMLElement)) return null;
    const rect = trigger.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (
    !triggerPoint ||
    typeof triggerPoint !== "object" ||
    !("x" in triggerPoint) ||
    !("y" in triggerPoint) ||
    typeof triggerPoint.x !== "number" ||
    typeof triggerPoint.y !== "number"
  ) {
    throw new Error(`Could not resolve the release channel trigger: ${JSON.stringify(triggerPoint)}`);
  }
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...triggerPoint });
  await app.client.send("Input.dispatchMouseEvent", { type: "mousePressed", ...triggerPoint, button: "left", clickCount: 1 });
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...triggerPoint, button: "left", clickCount: 1 });
  await waitFor(
    app,
    `[...document.querySelectorAll('[data-slot="select-item"]')]
      .some((item) => item.textContent?.trim() === "Alpha")`,
    { timeoutMs: 15_000, label: "Alpha release channel option" },
  );
  const optionPoint = await evalIn(app, `(() => {
    const option = [...document.querySelectorAll('[data-slot="select-item"]')]
      .find((item) => item.textContent?.trim() === "Alpha");
    if (!(option instanceof HTMLElement)) return null;
    const rect = option.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (
    !optionPoint ||
    typeof optionPoint !== "object" ||
    !("x" in optionPoint) ||
    !("y" in optionPoint) ||
    typeof optionPoint.x !== "number" ||
    typeof optionPoint.y !== "number"
  ) {
    throw new Error(`Could not resolve the Alpha release channel option: ${JSON.stringify(optionPoint)}`);
  }
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...optionPoint });
  await app.client.send("Input.dispatchMouseEvent", { type: "mousePressed", ...optionPoint, button: "left", clickCount: 1 });
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...optionPoint, button: "left", clickCount: 1 });
}

async function readUpdaterSnapshot(app: Parameters<typeof evalIn>[0], label: string): Promise<UpdaterSnapshot> {
  const value = await evalIn(app, `(async () => {
    const state = window.__sofiaUpdaterEvalState;
    const nativeState = await window.__SOFIA_ELECTRON__?.updater?.getChannel?.();
    let preferences = null;
    try {
      preferences = JSON.parse(localStorage.getItem("sofia.preferences") || "null");
    } catch {}
    return {
      checks: Array.isArray(state?.checks) ? [...state.checks] : [],
      setChannels: Array.isArray(state?.setChannels) ? [...state.setChannels] : [],
      nativeChannel: typeof nativeState?.channel === "string" ? nativeState.channel : null,
      preferenceChannel: typeof preferences?.releaseChannel === "string" ? preferences.releaseChannel : null,
      pickerText: document.querySelector('[aria-label="Release channel"]')?.textContent?.trim() ?? "",
      pageText: document.body.innerText,
    };
  })()`, { awaitPromise: true, timeoutMs: 15_000 });
  return updaterSnapshot(value, label);
}

async function quitDesktopGracefully(app: Parameters<typeof evalIn>[0]): Promise<void> {
  // Ask Chromium to close at the browser level rather than terminating the
  // host process. This gives the shared profile a clean storage shutdown.
  await app.client.send("Browser.close").catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/CDP websocket (?:failed|closed)/i.test(message)) throw error;
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${app.handle.cdpUrl.replace(/\/$/, "")}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Electron did not exit after the browser-level close request.");
}

test.skipIf(!enabled)(title, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"] });

  // Alpha is deliberately macOS-only. Daytona Electron surfaces are Linux, so
  // this journey uses the local Mac host instead of producing a vacuous remote
  // pass in a platform where the picker cannot exist.
  const profileDir = await mkdtemp(join(tmpdir(), "sofia-updater-channel-eval-"));
  const workspacePath = join(profileDir, "workspace");
  // Local storage is scoped to the dev-server origin. Pin both launches to the
  // same Vite port so this is a genuine relaunch of one renderer origin, just
  // like a packaged desktop, rather than two unrelated development origins.
  const desktopEnv = { PORT: String(await allocateFreePort()) };
  await using host = localHost();
  let workspaceId = "";

  try {
    const firstApp = await desktop({ name: "updater-channel-selection", host, profileDir, env: desktopEnv });
    try {
      ({ workspaceId } = await createAndSelectWorkspace(firstApp, { path: workspacePath }));
      await installControlledUpdaterBridge(firstApp, { delayStable: true });
      await openUpdates(firstApp, workspaceId);
      await waitFor(firstApp, `window.__sofiaUpdaterEvalState?.stableStarted === true`, {
        timeoutMs: 30_000,
        label: "initial Stable update check in flight",
      });

      await selectAlpha(firstApp);
      await waitFor(firstApp, `(() => {
        const state = window.__sofiaUpdaterEvalState;
        let preferences = null;
        try { preferences = JSON.parse(localStorage.getItem("sofia.preferences") || "null"); } catch {}
        return state?.checks?.includes("alpha")
          && state?.setChannels?.includes("alpha")
          && preferences?.releaseChannel === "alpha"
          && document.querySelector('[aria-label="Release channel"]')?.textContent?.includes("Alpha");
      })()`, { timeoutMs: 30_000, label: "Alpha selected and checked" });

      const finishedStable = await evalIn(firstApp, `(() => {
        const finish = window.__sofiaUpdaterEvalState?.finishStable;
        if (typeof finish !== "function") return false;
        finish();
        return true;
      })()`);
      expect(finishedStable).toBe(true);
      await evalIn(firstApp, `new Promise((resolve) => setTimeout(resolve, 300))`, {
        awaitPromise: true,
        timeoutMs: 2_000,
      });

      const afterRace = await readUpdaterSnapshot(firstApp, "post-race updater state");
      expect(afterRace.checks[0]).toBe("stable");
      expect(afterRace.checks).toContain("alpha");
      expect(afterRace.checks.at(-1)).toBe("alpha");
      expect(afterRace.setChannels).toContain("alpha");
      expect(afterRace.nativeChannel).toBe("alpha");
      expect(afterRace.preferenceChannel).toBe("alpha");
      expect(afterRace.pickerText).toContain("Alpha");
      expect(afterRace.pageText).toContain("You're up to date");
      expect(afterRace.pageText).not.toContain("9.9.9");
      evidence.recordAssertionEvidence(
        "A stale Stable response cannot overwrite a newer Alpha choice",
        `The controlled renderer observed checks ${JSON.stringify(afterRace.checks)}; after the delayed Stable result reported v9.9.9, the picker, local preference, and native Electron channel all remained Alpha and the page did not render v9.9.9.`,
        true,
      );
      await quitDesktopGracefully(firstApp);
    } finally {
      await firstApp.stop();
    }

    const relaunchedApp = await desktop({ name: "updater-channel-selection", host, profileDir, env: desktopEnv });
    try {
      await go(relaunchedApp, "/session");
      await installControlledUpdaterBridge(relaunchedApp, { delayStable: false });
      await openUpdates(relaunchedApp, workspaceId);
      await waitFor(relaunchedApp, `window.__sofiaUpdaterEvalState?.checks?.includes("alpha")`, {
        timeoutMs: 30_000,
        label: "Alpha check after relaunch",
      });

      const afterRelaunch = await readUpdaterSnapshot(relaunchedApp, "relaunched updater state");
      expect(afterRelaunch.checks).toContain("alpha");
      expect(afterRelaunch.checks).not.toContain("stable");
      expect(afterRelaunch.nativeChannel).toBe("alpha");
      expect(afterRelaunch.preferenceChannel).toBe("alpha");
      expect(afterRelaunch.pickerText).toContain("Alpha");
      evidence.recordAssertionEvidence(
        "The selected updater channel survives a desktop relaunch",
        `The relaunched app reused the same profile, issued an Alpha check, and exposed Alpha in the picker, local preference, and actual Electron updater channel: ${JSON.stringify(afterRelaunch)}.`,
        true,
      );
    } finally {
      await relaunchedApp.stop();
    }
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }
});
