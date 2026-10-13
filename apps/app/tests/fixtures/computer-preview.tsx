import * as React from "react";
import { createRoot } from "react-dom/client";
import { ComputerPeek } from "../../src/react-app/domains/session/panel/computer-peek";
import "../../src/app/index.css";

// A rendered product component with an isolated native transport. This fixture
// captures only its own generated canvas, never a user's app or desktop.
const canvas = document.createElement("canvas");
canvas.width = 800; canvas.height = 600;
const context = canvas.getContext("2d");
if (!context) throw new Error("Fixture canvas unavailable");
context.fillStyle = "#4255a8"; context.fillRect(0, 0, 800, 600);
context.fillStyle = "white"; context.font = "32px sans-serif"; context.fillText("Sofia preview fixture", 32, 80);
const imageUrl = canvas.toDataURL("image/jpeg");
const calls: { command: string; args: unknown[] }[] = [];
let stopped = 0;
let streams = 0;
let fallbacks = 0;
let denyMedia = false;
let holdMedia = false;
let releaseMedia: () => void = () => {};
let currentTarget = 30;
let mounted = true;
let fixtureSession = "session-a";
const startedAt = Date.now() - 1_000;
const pageId = crypto.randomUUID();
Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
  streams++;
  if (denyMedia) throw new Error("Fixture capture permission denied");
  const stream = canvas.captureStream(5);
  for (const track of stream.getTracks()) {
    const stop = track.stop.bind(track);
    track.stop = () => { stopped++; stop(); };
  }
  if (holdMedia) await new Promise<void>((resolve) => { releaseMedia = resolve; });
  return stream;
} });
Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { value: async () => {
  fallbacks++;
  throw new Error("Unscoped window picker must never be used");
} });
Object.defineProperty(window, "__SOFIA_ELECTRON__", { value: {
  invokeDesktop: async (command: string, ...args: unknown[]) => {
    calls.push({ command, args });
    if (command === "beginComputerUsePreview" || command === "releaseComputerUsePreview" || command === "openComputerUsePreview") return true;
    if (command === "getComputerUseCaptureSource") return `window:${currentTarget}:0`;
    if (command === "getComputerUsePreview") return {
      helperPid: 10, pid: 20, windowNumber: currentTarget, presentationId: "fixture-native", revision: calls.length,
      capturedAt: Date.now() / 1_000, imageWidth: 800, imageHeight: 600, app: "Fixture", windowTitle: "Preview fixture", imageUrl, applicationIconUrl: imageUrl,
    };
    throw new Error(`Unexpected fixture IPC: ${command}`);
  },
} });
function Fixture() {
  const [session, setSession] = React.useState(fixtureSession);
  const [completedAt, setCompletedAt] = React.useState<number | null>(null);
  const [active, setActive] = React.useState(mounted);
  Object.assign(window, { previewFixture: {
    pageId,
    stats: () => ({ stopped, streams, fallbacks, calls }),
    deny: () => { denyMedia = true; },
    hold: () => { holdMedia = true; },
    release: () => { holdMedia = false; releaseMedia(); },
    switchSession: () => { fixtureSession = session === "session-a" ? "session-b" : "session-a"; setSession(fixtureSession); },
    complete: () => { setCompletedAt(Date.now()); setActive(false); },
    finish: () => { mounted = false; setActive(false); },
    start: () => { mounted = true; setCompletedAt(null); setActive(true); },
    changeTarget: () => { currentTarget++; },
  } });
  return <main style={{ position: "relative", width: 900, height: 600 }}>
    <div data-computer-preview-obstacle style={{ position: "absolute", right: 0, top: 0, width: 280, height: 240, background: "#ddd" }}>Composer obstacle</div>
    <ComputerPeek sessionId={session} runStartedAt={active || completedAt !== null ? startedAt : null} active={active} completedAt={completedAt} visible />
  </main>;
}
const root = document.getElementById("root");
if (!root) throw new Error("Fixture root missing");
createRoot(root).render(<Fixture />);
