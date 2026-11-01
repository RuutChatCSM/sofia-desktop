import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { eventually, needs, test } from "@sofia/testkit";
import { expect, onTestFinished } from "vitest";

const execute = promisify(execFile);
type Reply = { id: number; result?: { isError?: boolean; content: Array<{ type: string; text?: string }> } };
type CallResult = { isError: boolean; result: Record<string, unknown> };
type WindowInfo = { target_id: string; window_title: string; window_number: number };

test("Native target identity survives same titles, retitle, replacement and close", { timeout: 180_000 }, async ({ evidence }) => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"], placement: "local" });
  if (process.platform !== "darwin") throw new Error("needs: macOS Accessibility");
  const packagePath = resolve(import.meta.dirname, "../../packages/handsfree/native/HandsFree");
  await execute("swift", ["build", "--package-path", packagePath, "--product", "HandsFreeComputerUse"], { timeout: 120_000 });
  const binPath = (await execute("swift", ["build", "--package-path", packagePath, "--show-bin-path"], { timeout: 30_000 })).stdout.trim();
  const helper = join(binPath, "HandsFreeComputerUse");
  const permission = JSON.parse((await execute(helper, ["--check"], { timeout: 15_000 })).stdout);
  if (!permission.ok) throw new Error(`needs: grant Accessibility and Screen Recording to ${helper}`);

  const root = await mkdtemp(join(tmpdir(), "sofia-native-window-identity-"));
  const app = join(root, "Native Identity Fixture.app");
  const executable = join(app, "Contents", "MacOS", "NativeIdentityFixture");
  const ready = join(root, "ready.json");
  const commands = join(root, "commands.json");
  let fixtureOutput = "";
  onTestFinished(async () => {
    await mkdir(evidence.dir, { recursive: true });
    await writeFile(join(evidence.dir, "fixture-output.log"), fixtureOutput);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>NativeIdentityFixture</string><key>CFBundleIdentifier</key><string>local.sofia.native-identity-fixture</string><key>CFBundleName</key><string>Native Identity Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>14.0</string></dict></plist>`);
  await writeFile(commands, "{}");
  await writeFile(join(root, "fixture.swift"), `import AppKit\nimport Foundation\n\nfinal class FixtureView: NSView {\n    init(label: String) {\n        super.init(frame: NSRect(x: 0, y: 0, width: 420, height: 180))\n        let button = NSButton(title: label, target: nil, action: nil)\n        button.frame = NSRect(x: 20, y: 105, width: 180, height: 36)\n        addSubview(button)\n        let marker = NSTextField(labelWithString: label)\n        marker.frame = NSRect(x: 20, y: 45, width: 360, height: 24)\n        addSubview(marker)\n    }\n    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }\n}\n\nfinal class Controller: NSObject, NSApplicationDelegate {\n    let ready: String\n    let commands: String\n    var windows: [String: NSWindow] = [:]\n    var timer: Timer?\n    var nextY: CGFloat = 760\n    let keeper = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 1, height: 1), styleMask: [.borderless], backing: .buffered, defer: false)\n    init(ready: String, commands: String) { self.ready = ready; self.commands = commands }\n    func applicationDidFinishLaunching(_ notification: Notification) {\n        NSApp.setActivationPolicy(.regular)\n        keeper.isReleasedWhenClosed = false\n        make(label: "Increment C", title: "Native Identity Same")\n        make(label: "Increment D", title: "Native Identity Same")\n        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.poll() }\n        try? JSONSerialization.data(withJSONObject: ["pid": ProcessInfo.processInfo.processIdentifier]).write(to: URL(fileURLWithPath: ready))\n    }\n    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }\n    func make(label: String, title: String) {\n        let window = NSWindow(contentRect: NSRect(x: 260, y: nextY, width: 460, height: 220), styleMask: [.titled, .closable], backing: .buffered, defer: false)\n        nextY -= 240\n        window.title = title\n        window.contentView = FixtureView(label: label)\n        window.orderFront(nil)\n        windows[label] = window\n    }\n    func poll() {\n        guard let data = try? Data(contentsOf: URL(fileURLWithPath: commands)), let payload = try? JSONSerialization.jsonObject(with: data) as? [String: String], let action = payload["action"] else { return }\n        if action == "retitle", let label = payload["label"], let title = payload["title"] { windows[label]?.title = title }\n        if action == "create", let label = payload["label"], let title = payload["title"] { make(label: label, title: title) }\n        if action == "close", let label = payload["label"] { windows[label]?.close(); windows.removeValue(forKey: label) }\n        try? Data("{}".utf8).write(to: URL(fileURLWithPath: commands))\n    }\n}\n\nlet ready = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/native-identity-ready.json"\nlet commands = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "/tmp/native-identity-commands.json"\nlet controller = Controller(ready: ready, commands: commands)\nlet application = NSApplication.shared\napplication.delegate = controller\napplication.run()\n`);
  await execute("swiftc", [join(root, "fixture.swift"), "-o", executable, "-framework", "AppKit"], { timeout: 120_000 });
  const fixture = spawn(executable, [ready, commands], { stdio: ["ignore", "pipe", "pipe"] });
  fixture.stdout.on("data", chunk => { fixtureOutput += chunk; });
  fixture.stderr.on("data", chunk => { fixtureOutput += chunk; });
  onTestFinished(() => fixture.kill());
  const identity = await eventually(async () => {
    if (fixture.exitCode !== null) throw new Error(`Fixture exited ${fixture.exitCode}: ${fixtureOutput}`);
    return JSON.parse(await readFile(ready, "utf8")) as { pid: number };
  }, { within: 15_000 });

  const transport = spawn(helper, ["mcp"], { env: { ...process.env, SOFIA_COMPUTER_USE_CURSOR_OVERLAY: "0" }, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let nextId = 1;
  const pending = new Map<number, (reply: Reply) => void>();
  transport.stdout.on("data", chunk => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const reply = JSON.parse(buffer.slice(0, newline)) as Reply;
      buffer = buffer.slice(newline + 1);
      pending.get(reply.id)?.(reply);
      pending.delete(reply.id);
    }
  });
  onTestFinished(() => { transport.kill(); });
  const request = (method: string, params: Record<string, unknown>) => new Promise<Reply>((resolveReply, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`Native MCP ${method} timed out`)), 30_000);
    pending.set(id, reply => { clearTimeout(timer); resolveReply(reply); });
    transport.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await request("initialize", {});
  const call = async (name: string, args: Record<string, unknown>): Promise<CallResult> => {
    const reply = await request("tools/call", { name, arguments: args });
    const text = reply.result?.content.find(block => block.type === "text")?.text;
    if (!text) throw new Error(`Native tool ${name} returned no structured text`);
    return { isError: reply.result?.isError === true, result: JSON.parse(text) as Record<string, unknown> };
  };
  const list = await eventually(async () => {
    const result = await call("list_windows", { pid: identity.pid });
    if (result.isError || !Array.isArray(result.result.windows)) throw new Error(JSON.stringify(result));
    const windows = (result.result.windows as WindowInfo[]).filter(window => window.window_title === "Native Identity Same");
    if (windows.length !== 2) throw new Error(`Expected two same-title windows: ${JSON.stringify(result)}`);
    return windows;
  }, { within: 10_000 });
  expect(list[0].target_id).not.toBe(list[1].target_id);
  const snapshots = await Promise.all(list.map(target => call("snapshot", { target_id: target.target_id, wait_for: "Increment ", wait_milliseconds: 3000 })));
  const snapshotC = snapshots.find(snapshot => (snapshot.result.elements as Array<{ label: string }>).some(element => element.label === "Increment C"));
  const snapshotD = snapshots.find(snapshot => (snapshot.result.elements as Array<{ label: string }>).some(element => element.label === "Increment D"));
  expect(snapshotC).toBeDefined();
  expect(snapshotD).toBeDefined();
  const targetC = list.find(target => target.target_id === snapshotC?.result.target_id);
  const targetD = list.find(target => target.target_id === snapshotD?.result.target_id);
  expect(targetC).toBeDefined();
  expect(targetD).toBeDefined();

  await writeFile(commands, JSON.stringify({ action: "retitle", label: "Increment C", title: "Native Identity Renamed" }));
  const renamed = await eventually(async () => {
    const result = await call("list_windows", { pid: identity.pid });
    const target = (result.result.windows as WindowInfo[]).find(window => window.target_id === targetC?.target_id);
    if (target?.window_title !== "Native Identity Renamed") throw new Error(`Retitle not observed: ${JSON.stringify(result)}`);
    return target;
  }, { within: 5_000 });
  expect(renamed.target_id).toBe(targetC?.target_id);
  const renamedSnapshot = await call("snapshot", { target_id: targetC?.target_id, wait_for: "Increment C", wait_milliseconds: 3000 });
  expect(renamedSnapshot.result.windowTitle).toBe("Native Identity Renamed");

  await writeFile(commands, JSON.stringify({ action: "create", label: "Increment E", title: "Native Identity Same" }));
  const replacement = await eventually(async () => {
    const result = await call("list_windows", { pid: identity.pid });
    const target = (result.result.windows as WindowInfo[]).find(window => window.window_title === "Native Identity Same" && window.target_id !== targetD?.target_id);
    if (!target) throw new Error(`Replacement missing: ${JSON.stringify(result)}`);
    return target;
  }, { within: 5_000 });
  expect(replacement.target_id).not.toBe(targetD?.target_id);
  const replacementSnapshot = await call("snapshot", { target_id: replacement.target_id, wait_for: "Increment E", wait_milliseconds: 3000 });
  expect((replacementSnapshot.result.elements as Array<{ label: string }>).some(element => element.label === "Increment E")).toBe(true);

  const renamedButton = (renamedSnapshot.result.elements as Array<{ label: string; ref: string }>).find(element => element.label === "Increment C");
  expect(renamedButton).toBeDefined();
  const activated = await call("activate_app", { name: "Finder" });
  expect(activated.isError).toBe(false);
  await new Promise(resolveWait => setTimeout(resolveWait, 500));
  const intervention = await call("click", { snapshot_id: renamedSnapshot.result.snapshot_id, ref: renamedButton?.ref });
  expect(intervention.isError).toBe(true);
  expect(String(intervention.result.error)).toMatch(/stale|snapshot|focus/i);

  await writeFile(commands, JSON.stringify({ action: "close", label: "Increment D" }));
  const closed = await eventually(async () => {
    const result = await call("snapshot", { target_id: targetD?.target_id });
    if (!result.isError) throw new Error(`Closed target still resolves: ${JSON.stringify(result)}`);
    return result;
  }, { within: 5_000 });
  expect(String(closed.result.error)).toMatch(/Not running|not running|No usable window|unavailable/);

  await mkdir(evidence.dir, { recursive: true });
  await writeFile(join(evidence.dir, "window-identity.json"), JSON.stringify({ helper, permission, fixturePid: identity.pid, initial: list, renamed, replacement, snapshots: snapshots.map(snapshot => snapshot.result) }, null, 2));
  evidence.recordAssertionEvidence("Identical-title and retitle identity", "Two AppKit windows with the same title received distinct target ids; retitling one preserved target id and snapshot access.", true);
  evidence.recordAssertionEvidence("Replacement and close identity", "A replacement same-title window received a new target id, and closing the original target made only that target unavailable.", true);
  evidence.recordAssertionEvidence("Intervention invalidates snapshots", "Activating Finder after a target snapshot made the saved C snapshot reject further input rather than replaying a stale click.", true);
});
