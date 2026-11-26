/** @jsxImportSource react */
import * as React from "react";

import type { BrowserSessionDockTarget } from "@/app/lib/desktop-types";
import { getElectronBrowser } from "@/react-app/domains/session/panel/utils";

/** Publish the focused session; the dock renders it in full screen. */
export function useBrowserSessionDockTarget(target: BrowserSessionDockTarget, active: boolean): void {
  const lastKey = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!active) {
      lastKey.current = null;
      return;
    }
    const key = `${target.workspaceId}\u001f${target.sessionId}\u001f${target.dark ? "dark" : "light"}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    const browser = getElectronBrowser();
    if (!browser?.setSessionDockTarget) return;
    void browser.setSessionDockTarget(target).catch(() => undefined);
  }, [active, target.workspaceId, target.sessionId, target.dark]);
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

/** "Open in sidebar" restores the browser beside the transcript. */
export function useBrowserSessionDockOpenSidebar(handler: () => void): void {
  const latest = React.useRef(handler);
  latest.current = handler;
  React.useEffect(() => {
    const browser = getElectronBrowser();
    if (!browser) return;
    return browser.onBrowserSessionDockOpenSidebar?.(() => latest.current());
  }, []);
}
