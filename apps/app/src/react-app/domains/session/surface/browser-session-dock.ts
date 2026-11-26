/** @jsxImportSource react */
import * as React from "react";
import type { UIMessage } from "ai";

import type { BrowserSessionDockMode, BrowserSessionDockState, BrowserSessionDockTone } from "@/app/lib/desktop-types";
import { getResolvedThemeMode, subscribeToTheme } from "@/app/theme";
import { deriveTurnPresentation } from "@/components/chat/turn-presentation";
import { liveTurnStatusForTurn } from "@/components/chat/turn-status";
import { useLiveElapsed } from "@/components/chat/use-live-elapsed";
import { groupMessages, isMessageGroup, getMessagesText, type UIMessageWithIndex } from "@/components/chat/utils";
import { condenseWork } from "@/components/chat/work-condense";
import { resolveTurnTiming } from "@/components/chat/turn-timing";
import { collectLatestAssistantToolParts } from "@/lib/latest-assistant-tool-parts";
import type { ThreadStatus } from "@/lib/messages";
import { getActiveToolLabel } from "@/lib/tool-activity";
import type { AnyToolPart } from "@/lib/tool-aggregate";
import { liveActivityLabel, type Activity } from "@/react-app/domains/session/activity";
import { useCodexSessionStore } from "@/react-app/domains/session/codex-session-store";
import { getElectronBrowser } from "@/react-app/domains/session/panel/utils";
import { createDockStatePublisher } from "./browser-session-dock-state";
import { resolveSubmitAction } from "./composer/submit-action";
import type { FollowUpMode } from "./composer/follow-up-preference";

const EMPTY_ITEMS: UIMessageWithIndex[] = [];

function latestLiveTurn(messages: UIMessage[], status: ThreadStatus): { items: UIMessageWithIndex[]; interjections: UIMessageWithIndex[] } | null {
  const grouped = groupMessages(messages, status);
  for (let index = grouped.length - 1; index >= 0; index -= 1) {
    const candidate = grouped[index];
    if (isMessageGroup(candidate)) return { items: candidate.messages, interjections: candidate.interjections };
  }
  return null;
}

/** Live state for the dock, from the same pieces the transcript header uses. */
export function useLiveBrowserSessionDockState(input: {
  sessionId: string;
  messages: UIMessage[];
  status: ThreadStatus;
  streaming: boolean;
  activities: Activity[];
  followUpMode: FollowUpMode;
}): BrowserSessionDockState {
  const group = React.useMemo(
    () => latestLiveTurn(input.messages, input.status) ?? { items: EMPTY_ITEMS, interjections: EMPTY_ITEMS },
    [input.messages, input.status],
  );
  const presentation = React.useMemo(
    () => deriveTurnPresentation(group.items, true, group.interjections),
    [group],
  );
  const workItems = React.useMemo(() => condenseWork(presentation.work), [presentation]);
  const toolParts = React.useMemo(
    () => group.items.flatMap((item) => item.message.parts.filter((part): part is AnyToolPart => part.type === "dynamic-tool" || part.type.startsWith("tool-"))),
    [group.items],
  );
  const timing = React.useMemo(() => resolveTurnTiming(group.items.map((item) => item.message)), [group.items]);
  const elapsedMs = useLiveElapsed(timing.startedAt, input.streaming);
  const connected = useCodexSessionStore((state) => !input.sessionId.startsWith("codex-") || state.streaming);
  const toolLabel = React.useMemo(() => getActiveToolLabel(collectLatestAssistantToolParts(input.messages)), [input.messages]);
  const activityLabel = React.useMemo(
    () => input.streaming ? liveActivityLabel(input.activities, toolLabel) : null,
    [input.streaming, input.activities, toolLabel],
  );
  const commentaryTexts = React.useMemo(
    () => workItems.flatMap((entry) => entry.kind === "commentary" ? [getMessagesText([entry.item.message])] : []),
    [workItems],
  );
  const live = input.streaming && group.items.length > 0
    ? liveTurnStatusForTurn({
        workItems,
        proseCount: presentation.answerItems.length,
        toolParts,
        activityLabel,
        connected,
        elapsedMs,
        commentaryText: commentaryTexts.length ? commentaryTexts[commentaryTexts.length - 1] : null,
      })
    : null;
  const dark = React.useSyncExternalStore(subscribeToTheme, getResolvedThemeMode, getResolvedThemeMode) === "dark";
  const mode: BrowserSessionDockMode = resolveSubmitAction({
    busy: input.streaming,
    modifier: false,
    mode: input.followUpMode,
  });
  const tone: BrowserSessionDockTone = live?.tone ?? "working";
  return {
    title: live?.title ?? "Sofia",
    tone,
    meta: live?.meta ?? [],
    note: live?.note ?? "",
    running: input.streaming,
    mode,
    dark,
  };
}

/** Publish the focused session's live turn; the dock only shows it in full screen. */
export function useBrowserSessionDockPublisher(state: BrowserSessionDockState, active: boolean): void {
  const publisher = React.useMemo(
    () => createDockStatePublisher((next) => {
      const browser = getElectronBrowser();
      if (!browser?.setSessionDockState) return;
      void browser.setSessionDockState(next).catch(() => undefined);
    }),
    [],
  );
  React.useEffect(() => {
    if (!active) {
      publisher.stop();
      return;
    }
    publisher.publish(state);
  }, [active, publisher, state]);
  React.useEffect(() => () => publisher.stop(), [publisher]);
}

/** The dock's buttons reuse the session's existing send, queue and stop paths. */
export function useBrowserSessionDockActions(handlers: {
  submit: (text: string, mode: BrowserSessionDockMode) => void;
  stop: () => void;
}, active: boolean): void {
  const latest = React.useRef(handlers);
  latest.current = handlers;
  React.useEffect(() => {
    if (!active) return;
    const browser = getElectronBrowser();
    if (!browser) return;
    const offSubmit = browser.onBrowserSessionDockSubmit?.((payload) => latest.current.submit(payload.text, payload.mode));
    const offStop = browser.onBrowserSessionDockStop?.(() => latest.current.stop());
    return () => {
      offSubmit?.();
      offStop?.();
    };
  }, [active]);
}

/** Returning to the conversation belongs to the shell that owns presentation. */
export function useBrowserSessionDockBackToChat(handler: () => void): void {
  const latest = React.useRef(handler);
  latest.current = handler;
  React.useEffect(() => {
    const browser = getElectronBrowser();
    if (!browser) return;
    return browser.onBrowserSessionDockBackToChat?.(() => latest.current());
  }, []);
}
