// Computer-use helper integration: locating the bundled ComputerUse.app,
// permission checks (spawn --check for a fresh TCC read), running-app
// listing for @App mentions, and opening the permission-setup GUI.
// Extracted from main.mjs; consumed only by the desktop IPC registry.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, desktopCapturer, shell } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COMPUTER_USE_HELPER_APP_NAME = "Sofia Computer Use.app";
const COMPUTER_USE_HELPER_EXECUTABLE = "ComputerUse";

function computerUseHelperExecutablePath() {
  const appPath = computerUseHelperAppPath();
  const explicitBinary = process.env.SOFIA_COMPUTER_USE_BINARY?.trim();
  const candidates = [
    explicitBinary,
    appPath ? path.join(appPath, "Contents", "MacOS", COMPUTER_USE_HELPER_EXECUTABLE) : null,
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function computerUseHelperAppPath() {
  const explicitApp = process.env.SOFIA_COMPUTER_USE_APP?.trim();
  const candidates = [
    explicitApp,
    process.resourcesPath ? path.join(process.resourcesPath, "helpers", COMPUTER_USE_HELPER_APP_NAME) : null,
    path.resolve(__dirname, "..", "resources", "helpers", COMPUTER_USE_HELPER_APP_NAME),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function getComputerUseMcpCommand() {
  // Enable Chromium's native AX bridge when the user connects Computer Use.
  // A renderer can otherwise remain invisible to macOS assistive clients.
  app.setAccessibilitySupportEnabled(true);
  const helperExecutable = computerUseHelperExecutablePath();
  if (helperExecutable) return [helperExecutable, "mcp"];

  if (app.isPackaged) {
    throw new Error("Sofia Computer Use is missing from this Sofia build.");
  }

  if (process.env.SOFIA_DEV_MODE === "1") {
    return ["node", path.resolve(__dirname, "../../..", "packages/handsfree/bin/sofia-handsfree-computer-use.mjs"), "mcp"];
  }
  return ["npx", "-y", "@sofia/handsfree", "mcp"];
}

// ---------------------------------------------------------------------------
// Permission checks — spawn the binary with --check, read stdout, done.
// Fresh process = fresh TCC read = always accurate. No HTTP server needed.
// ---------------------------------------------------------------------------

function resolveComputerUseExecutable() {
  // 1. Explicit env override.
  const explicit = process.env.SOFIA_COMPUTER_USE_BINARY?.trim();
  if (explicit && existsSync(explicit)) return explicit;

  // 2. .app bundle (packaged builds + pnpm dev).
  const appPath = computerUseHelperAppPath();
  if (appPath) {
    const bin = path.join(appPath, "Contents", "MacOS", COMPUTER_USE_HELPER_EXECUTABLE);
    if (existsSync(bin)) return bin;
  }

  // 3. Dev fallback — raw Swift build output.
  if (!app.isPackaged) {
    const swiftPkg = path.resolve(__dirname, "../../..", "packages/handsfree/native/HandsFree");
    const devCandidates = [
      path.join(swiftPkg, ".build", "release", "HandsFreeComputerUse"),
      path.join(swiftPkg, ".build", "arm64-apple-macosx", "release", "HandsFreeComputerUse"),
      path.join(swiftPkg, ".build", "debug", "HandsFreeComputerUse"),
      path.join(swiftPkg, ".build", "arm64-apple-macosx", "debug", "HandsFreeComputerUse"),
    ];
    for (const c of devCandidates) {
      if (existsSync(c)) return c;
    }
  }

  return null;
}

async function checkComputerUsePermissions() {
  // Spawn binary --check → read JSON from stdout → exit. Always fresh.
  const bin = resolveComputerUseExecutable();
  if (!bin) {
    return { ok: false, accessibility: false, screenRecording: false, error: "Helper binary not found. Run pnpm dev to build it." };
  }
  const permissions = await spawnCheckPermissions(bin);
  if (permissions.ok) app.setAccessibilitySupportEnabled(true);
  return permissions;
}

function spawnCheckPermissions(bin) {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(bin, ["--check"], { stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => resolve({ ok: false, accessibility: false, screenRecording: false, error: "Failed to run permission check." }));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({
          ok: parsed?.ok === true,
          accessibility: parsed?.accessibility === true,
          screenRecording: parsed?.screenRecording === true,
        });
      } catch {
        resolve({ ok: false, accessibility: false, screenRecording: false, error: "Permission check returned invalid output." });
      }
    });
  });
}

async function listRunningApps() {
  // Spawn binary --list-apps → read JSON from stdout → exit. Needs no TCC
  // permissions, so this works before Computer Use setup is complete.
  if (process.platform !== "darwin") return { ok: false, apps: [] };
  const bin = resolveComputerUseExecutable();
  if (!bin) return { ok: false, apps: [] };
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(bin, ["--list-apps"], { stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => resolve({ ok: false, apps: [] }));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(stdout.trim());
        const apps = Array.isArray(parsed?.apps) ? parsed.apps.filter((name) => typeof name === "string" && name.trim()) : [];
        resolve({ ok: parsed?.ok === true, apps });
      } catch {
        resolve({ ok: false, apps: [] });
      }
    });
  });
}

async function openComputerUseSetupApp() {
  // Open the GUI. Use the .app bundle if available so macOS shows it as
  // a real app with its own dock icon and permission identity.
  const appPath = computerUseHelperAppPath();
  if (appPath) {
    const result = await shell.openPath(appPath);
    if (result) console.error("[ComputerUse] shell.openPath error:", result);
    return;
  }

  // Fallback: spawn the raw binary (opens the same GUI).
  const bin = resolveComputerUseExecutable();
  if (!bin) throw new Error("Helper binary not found. Run pnpm dev to build it.");
  const child = spawn(bin, [], { detached: true, stdio: "ignore" });
  child.unref();
}

const COMPUTER_PEEK_MAX_AGE_MS = 10 * 60_000;

async function readComputerUsePreview() {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return null;
  try {
    const file = path.join(os.tmpdir(), `sofia-computer-peek-${process.getuid()}.json`);
    const raw = await readFile(file, "utf8");
    if (raw.length > 8_000_000) return null;
    const preview = JSON.parse(raw);
    if (!Number.isInteger(preview.pid) || preview.pid <= 0 ||
        !Number.isInteger(preview.helperPid) || preview.helperPid <= 0 ||
        !Number.isInteger(preview.windowNumber) || preview.windowNumber < 0 ||
        typeof preview.app !== "string" || typeof preview.image !== "string" ||
        typeof preview.capturedAt !== "number" || preview.mimeType !== "image/jpeg" ||
        !Number.isFinite(preview.capturedAt) || preview.capturedAt * 1000 > Date.now() + 5_000 ||
        typeof preview.presentationId !== "string" || !preview.presentationId ||
        !Number.isSafeInteger(preview.revision) || preview.revision < 1 ||
        !Number.isSafeInteger(preview.imageWidth) || preview.imageWidth < 1 ||
        !Number.isSafeInteger(preview.imageHeight) || preview.imageHeight < 1 ||
        Date.now() - preview.capturedAt * 1000 > COMPUTER_PEEK_MAX_AGE_MS) return null;
    process.kill(preview.pid, 0);
    process.kill(preview.helperPid, 0);
    return {
      helperPid: preview.helperPid,
      presentationId: preview.presentationId,
      revision: preview.revision,
      imageWidth: preview.imageWidth,
      imageHeight: preview.imageHeight,
      app: preview.app,
      pid: preview.pid,
      windowNumber: preview.windowNumber,
      windowTitle: typeof preview.windowTitle === "string" ? preview.windowTitle : "",
      capturedAt: preview.capturedAt,
      imageUrl: `data:image/jpeg;base64,${preview.image}`,
      applicationIconUrl: typeof preview.applicationIcon === "string" && preview.applicationIcon.length < 1_000_000 ? `data:image/png;base64,${preview.applicationIcon}` : undefined,
    };
  } catch {
    return null;
  }
}

async function computerUseCaptureSource(preview) {
  if (!preview?.windowNumber) return null;
  const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } });
  return sources.find((source) => source.id.startsWith(`window:${preview.windowNumber}:`)) ?? null;
}

async function openComputerUsePreview(preview) {
  const binary = resolveComputerUseExecutable();
  if (!preview || !binary) return false;
  return new Promise((resolve) => {
    const child = spawn(binary, ["--activate-pid", String(preview.pid)], { stdio: "ignore", timeout: 5_000 });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export {
  resolveComputerUseExecutable,
  checkComputerUsePermissions,
  getComputerUseMcpCommand,
  listRunningApps,
  openComputerUseSetupApp,
  openComputerUsePreview,
  readComputerUsePreview,
  computerUseCaptureSource,
};
