import * as React from "react";
import { ArrowUpRight, Check, Eye, EyeOff, X } from "lucide-react";
import type { ComputerPreviewScope, ComputerUsePreview } from "@sofia/types/desktop-ipc";
import { computerPreviewSize, placeComputerPreview, type PreviewPoint } from "./computer-preview-layout";
import { useComputerPreviewPreferences } from "./computer-preview-preferences";

export function ComputerPeek({ sessionId, runStartedAt, visible, active = true, completedAt = null }: { sessionId: string | null; runStartedAt: number | null; visible: boolean; active?: boolean; completedAt?: number | null }) {
  if (!sessionId || runStartedAt === null || !visible) return null;
  return <RunComputerPeek key={`${sessionId}:${runStartedAt}`} sessionId={sessionId} runStartedAt={runStartedAt} active={active} completedAt={completedAt} />;
}

function RunComputerPeek({ sessionId, runStartedAt, active, completedAt }: { sessionId: string; runStartedAt: number; active: boolean; completedAt: number | null }) {
  const [scope] = React.useState<ComputerPreviewScope>(() => ({ sessionId, runStartedAt, leaseId: crypto.randomUUID() }));
  const preferences = useComputerPreviewPreferences();
  const hidden = preferences.alwaysHide || preferences.hiddenSessions[sessionId] === true;
  const [preview, setPreview] = React.useState<ComputerUsePreview | null>(null);
  const [completionStage, setCompletionStage] = React.useState("icon");
  const [expired, setExpired] = React.useState(false);
  const [live, setLive] = React.useState(false);
  const [position, setPosition] = React.useState<PreviewPoint | null>(null);
  const [dragged, setDragged] = React.useState<PreviewPoint | null>(null);
  const [hostSize, setHostSize] = React.useState<{ width: number; height: number } | null>(null);
  const completionCheckRef = React.useRef<HTMLDivElement>(null);
  const cardRef = React.useRef<HTMLDivElement>(null);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const dragRef = React.useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const maximum = hostSize ? Math.max(1, Math.min(preferences.maximumDimension, hostSize.width - 48, hostSize.height - 76)) : preferences.maximumDimension;
  const size = computerPreviewSize(preview?.imageWidth ?? 0, preview?.imageHeight ?? 0, maximum);

  React.useEffect(() => {
    if (hidden) { setPreview(null); return; }
    if (!active) return;
    const invoke = window.__SOFIA_ELECTRON__?.invokeDesktop;
    if (!invoke) return;
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const next = await invoke("getComputerUsePreview", scope);
        if (!cancelled) setPreview(next);
      } catch {
        if (!cancelled) setPreview(null);
      }
      if (!cancelled) timer = window.setTimeout(() => void refresh(), 1_000);
    };
    void invoke("beginComputerUsePreview", scope).then((accepted) => {
      if (accepted && !cancelled) void refresh();
    }).catch(() => { if (!cancelled) setPreview(null); });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      void invoke("releaseComputerUsePreview", scope).catch(() => {});
    };
  }, [hidden, scope, active]);

  const targetPresentation = preview?.presentationId;
  const targetHelper = preview?.helperPid;
  const targetPid = preview?.pid;
  const targetWindow = preview?.windowNumber;
  // The effect depends on the target, not each JPEG revision. Fresh frames do
  // not restart a healthy stream; target/run changes always stop its tracks.
  React.useEffect(() => {
    if (!preview || hidden || !active) return;
    const target = preview;
    let cancelled = false;
    let stream: MediaStream | null = null;
    const player = videoRef.current;
    setLive(false);
    const start = async () => {
      try {
        const sourceId = await window.__SOFIA_ELECTRON__?.invokeDesktop?.("getComputerUseCaptureSource", scope, target);
        if (!sourceId || cancelled) return;
        const video: MediaTrackConstraints & { mandatory: { chromeMediaSource: string; chromeMediaSourceId: string } } = {
          mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId },
        };
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        if (cancelled || !player) { stream.getTracks().forEach((track) => track.stop()); return; }
        player.srcObject = stream;
        stream.getVideoTracks().forEach((track) => track.addEventListener("ended", () => {
          if (!cancelled) setLive(false);
        }, { once: true }));
        await player.play();
        if (!cancelled) setLive(true);
      } catch {
        if (cancelled) return;
        stream?.getTracks().forEach((track) => track.stop());
        if (player) player.srcObject = null;
        if (!cancelled) setLive(false);
      }
    };
    void start();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
      if (player) player.srcObject = null;
      setLive(false);
    };
  }, [hidden, active, scope, targetPresentation, targetHelper, targetPid, targetWindow]);

  React.useLayoutEffect(() => {
    const card = cardRef.current;
    const host = card?.parentElement;
    if (!card || !host) return;
    let frame = 0;
    const layout = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      setHostSize((previous) => previous?.width === width && previous.height === height ? previous : { width, height });
      const hostRect = host.getBoundingClientRect();
      const obstacles = Array.from(host.querySelectorAll<HTMLElement>("[data-computer-preview-obstacle], [data-testid='browser-peek']"))
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.left - hostRect.left, y: rect.top - hostRect.top, width: rect.width, height: rect.height };
        });
      const next = placeComputerPreview({ width: size.width, height: size.height }, { width: host.clientWidth, height: host.clientHeight }, obstacles, dragged);
      setPosition((previous) => previous?.x === next.x && previous.y === next.y ? previous : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(layout); };
    const resize = new ResizeObserver(schedule);
    resize.observe(host);
    host.querySelectorAll("[data-computer-preview-obstacle]").forEach((element) => resize.observe(element));
    const mutations = new MutationObserver(schedule);
    mutations.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
    host.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    layout();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect(); mutations.disconnect();
      host.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [hidden, Boolean(preview), size.width, size.height, dragged]);

  React.useEffect(() => {
    setExpired(false);
    setCompletionStage("icon");
    if (completedAt === null) return;
    if (!preview?.applicationIconUrl) setCompletionStage("full");
    const elapsed = Date.now() - completedAt;
    const timers = [
      window.setTimeout(() => setCompletionStage("full"), Math.max(0, 1000 - elapsed)),
      window.setTimeout(() => { if (preview?.applicationIconUrl) setCompletionStage("mini"); }, Math.max(0, 2500 - elapsed)),
      window.setTimeout(() => setExpired(true), Math.max(0, 30000 - elapsed)),
    ];
    return () => timers.forEach(window.clearTimeout);
  }, [completedAt, preview?.applicationIconUrl]);
  React.useEffect(() => {
    const check = completionCheckRef.current;
    if (!check || completedAt === null || completionStage === "icon") return;
    // The native spring uses mass 1, stiffness 170, damping 18, velocity 0.
    const frequency = Math.sqrt(170 - 9 * 9);
    const frames = Array.from({ length: 61 }, (_, index) => {
      const time = index / 60;
      const progress = 1 - Math.exp(-9 * time) * (Math.cos(frequency * time) + 9 / frequency * Math.sin(frequency * time));
      return { transform: completionStage === "mini"
        ? `translate(calc(-50% + ${18 * progress}px), calc(-50% + ${18 * progress}px)) scale(${18 / 17.5 + (1 - 18 / 17.5) * progress})`
        : `translate(-50%, -50%) scale(${progress})` };
    });
    const animation = check.animate(frames, { duration: 1000, easing: "linear" });
    return () => animation.cancel();
  }, [completedAt, completionStage]);
  if (expired || (!active && completedAt === null)) return null;
  if (hidden) return <button type="button" data-testid="computer-peek-restore" aria-label="Show computer preview"
    className="absolute bottom-6 right-6 z-30 flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs shadow-sm"
    onClick={() => preferences.show(sessionId)}><Eye className="h-3.5 w-3.5" /> Show computer preview</button>;
  if (!preview) return null;
  const open = () => void window.__SOFIA_ELECTRON__?.invokeDesktop?.("openComputerUsePreview", scope, preview).catch(() => {});
  return (
    <div ref={cardRef} data-testid="computer-peek" data-preview-session={sessionId} data-preview-presentation={preview.presentationId} data-completion-stage={completedAt === null ? "active" : completionStage}
      className="group absolute z-30" style={{ left: position?.x ?? 24, top: position?.y ?? 24, width: size.width, height: size.height }}>
      <div className="relative h-full w-full cursor-grab overflow-hidden rounded-[4px] bg-black active:cursor-grabbing"
        style={{ boxShadow: "0 6px 10px rgba(0,0,0,0.16)" }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const rect = cardRef.current?.getBoundingClientRect();
          const host = cardRef.current?.parentElement?.getBoundingClientRect();
          if (!rect || !host) return;
          dragRef.current = { x: rect.left - host.left, y: rect.top - host.top, startX: event.clientX, startY: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag) return;
          setDragged({ x: drag.x + event.clientX - drag.startX, y: drag.y + event.clientY - drag.startY });
        }}
        onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}>
        <img src={preview.imageUrl} alt={`Computer use preview of ${preview.app}`} draggable={false} className="h-full w-full object-contain" />
        <video ref={videoRef} muted playsInline aria-label={`Live preview of ${preview.app}`}
          className={`pointer-events-none absolute inset-0 h-full w-full object-contain ${live ? "opacity-100" : "opacity-0"}`} />
      </div>
      {completedAt !== null && <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[4px]" aria-label="Computer use completed">
        <style>{"@keyframes sofia-completion-fade { from { opacity: 0 } to { opacity: 1 } }"}</style>
        <div className="absolute inset-0 bg-black/[0.17]" style={{ animation: "sofia-completion-fade 350ms ease-out" }} />
        {preview.applicationIconUrl && <img src={preview.applicationIconUrl} alt="" style={{ animation: "sofia-completion-fade 350ms ease-out" }} className="absolute left-1/2 top-1/2 h-[50px] w-[50px] -translate-x-1/2 -translate-y-1/2" />}
        <div className="absolute left-1/2 top-1/2 h-[50px] w-[50px] -translate-x-1/2 -translate-y-1/2 rounded-[10px] bg-black transition-opacity duration-250" style={{ opacity: completionStage === "full" && preview.applicationIconUrl ? 0.65 : 0 }} />
        {(completionStage !== "icon" || !preview.applicationIconUrl) && <div ref={completionCheckRef} className="absolute left-1/2 top-1/2 flex items-center justify-center" style={{
          width: completionStage === "mini" ? 17.5 : 18, height: completionStage === "mini" ? 17.5 : 18,
          transform: completionStage === "mini" ? "translate(calc(-50% + 18px), calc(-50% + 18px))" : "translate(-50%, -50%)",
          borderRadius: 8.75, background: completionStage === "mini" ? "rgb(0,230,45)" : "transparent",
          color: completionStage === "mini" ? "rgba(0,0,0,.5)" : "white",
          transition: "background 200ms, color 200ms",
          boxShadow: completionStage === "mini" ? "0 0 4px rgba(0,0,0,.8)" : "none",
        }}><Check strokeWidth={3} style={{ width: completionStage === "mini" ? 9 : 18, height: completionStage === "mini" ? 9 : 18 }} /></div>}
      </div>}
      <div className="absolute left-0 top-0 flex h-[34px] w-full items-start gap-1 p-2 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        style={{ background: "radial-gradient(ellipse at top left, rgba(90,90,90,.65), transparent 75%)", maskImage: "linear-gradient(black 60%, transparent)" }}
        aria-label="Computer preview controls">
        <button type="button" aria-label="Hide computer preview" title="Hide computer preview" className="flex h-[18px] w-[18px] items-center justify-center" onClick={() => preferences.hide(sessionId)}><X className="h-4 w-4" /></button>
        <button type="button" aria-label="Hide all computer previews" title="Hide all computer previews" className="flex h-[18px] w-[18px] items-center justify-center" onClick={preferences.hideAll}><EyeOff className="h-4 w-4" /></button>
        <button type="button" aria-label={`Open ${preview.app}`} title={preview.windowTitle || preview.app} className="ml-auto flex h-[18px] w-[18px] items-center justify-center" onClick={open}><ArrowUpRight className="h-4 w-4" /></button>
        <select aria-label="Computer preview size" value={preferences.maximumDimension} className="h-[18px] w-4 bg-transparent text-transparent" title="Computer preview size" onChange={(event) => preferences.setMaximumDimension(Number(event.target.value))}>
          <option className="text-black" value={200}>Small</option><option className="text-black" value={280}>Medium</option><option className="text-black" value={400}>Large</option>
        </select>
      </div>
    </div>
  );
}
