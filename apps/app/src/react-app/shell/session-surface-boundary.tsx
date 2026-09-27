"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";

type SessionSurfaceBoundaryProps = { children: React.ReactNode };
type SessionSurfaceBoundaryState = { error: Error | null };

/**
 * Keeps one surface from taking the app down with it.
 *
 * A throw out of `SessionPage` — a render error, or a state loop that trips
 * React's "Maximum update depth exceeded" while a split panel is mounting —
 * used to reach the root, so React unmounted the whole tree and the window went
 * blank. The leftover native browser view kept painting over that hole, which is
 * what made it look like the browser had crashed rather than the app.
 *
 * Containing it here leaves the shell (sidebar, other panes, and the browser's
 * own view) alive and offers the recovery that always works: remount the surface.
 */
export class SessionSurfaceBoundary extends React.Component<
  SessionSurfaceBoundaryProps,
  SessionSurfaceBoundaryState
> {
  state: SessionSurfaceBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): SessionSurfaceBoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown) {
    console.error("[session] the session surface failed to render", error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm font-medium text-dls-text">This view stopped responding</p>
        <p className="max-w-md text-[13px] leading-5 text-dls-secondary">
          {error.message || "The session surface hit an unexpected error."}
        </p>
        <Button variant="outline" size="sm" onClick={() => this.setState({ error: null })}>
          Reload view
        </Button>
      </div>
    );
  }
}
