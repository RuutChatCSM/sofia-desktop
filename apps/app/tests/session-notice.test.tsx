/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SessionNotice } from "../src/react-app/domains/session/chat/session-notice";
import { claimNoticeSurfacing, resetSurfacedNotices } from "../src/react-app/domains/session/chat/session-notice-state";
import { sessionNotice } from "../src/lib/session-warning";

const LONG_THREAD = "This conversation is getting long. Starting a new chat may help Sofia stay accurate.";

describe("the session notice speaks at two volumes", () => {
  test("a long-thread advisory is informational and carries one quiet action", () => {
    const notice = sessionNotice(LONG_THREAD, false)!;
    const markup = renderToStaticMarkup(<SessionNotice notice={notice} onStartNewChat={() => {}} />);

    expect(markup).toContain('data-notice-kind="info"');
    expect(markup).toContain("long conversation");
    expect(markup).toContain('data-notice-action="new-chat"');
    expect(markup).toContain("Start new chat");
    // The incident treatment — an amber accent stripe — is gone.
    expect(markup).not.toContain("border-l-2");
    expect(markup).not.toContain("amber-9");
    // No dismiss handler, no dismiss control: the caller owns that decision.
    expect(markup).not.toContain("data-notice-dismiss");
  });

  test("the advisory is dismissible when the caller offers it", () => {
    const notice = sessionNotice(LONG_THREAD, false)!;
    const markup = renderToStaticMarkup(
      <SessionNotice notice={notice} onDismiss={() => {}} onStartNewChat={() => {}} />,
    );

    expect(markup).toContain("data-notice-dismiss");
    expect(markup).toContain('aria-label="Dismiss"');
  });

  test("with no action wired, the advisory is still just a sentence", () => {
    const notice = sessionNotice(LONG_THREAD, false)!;
    const markup = renderToStaticMarkup(<SessionNotice notice={notice} />);

    expect(markup).toContain('data-notice-kind="info"');
    expect(markup).not.toContain("Start new chat");
  });

  test("a degraded state keeps the amber treatment", () => {
    const notice = sessionNotice("This task is open elsewhere. Close it there and retry.", false)!;
    const markup = renderToStaticMarkup(<SessionNotice notice={notice} />);

    expect(markup).toContain('data-notice-kind="warning"');
    expect(markup).toContain("open elsewhere");
    // Still a notice, not a bordered incident: no left warning stripe anywhere.
    expect(markup).not.toContain("border-l-2");
  });
});

describe("a notice is said once per conversation", () => {
  test("the second telling is not a new telling", () => {
    resetSurfacedNotices();
    const message = sessionNotice(LONG_THREAD, false)!.message;

    expect(claimNoticeSurfacing("s1", message)).toBeTrue();
    // The next compaction re-sends it; that must not re-announce it.
    expect(claimNoticeSurfacing("s1", message)).toBeFalse();
    expect(claimNoticeSurfacing("s1", message)).toBeFalse();
  });

  test("two conversations do not suppress each other", () => {
    resetSurfacedNotices();
    const message = sessionNotice(LONG_THREAD, false)!.message;

    expect(claimNoticeSurfacing("s1", message)).toBeTrue();
    expect(claimNoticeSurfacing("s2", message)).toBeTrue();
  });

  test("a different message is a different notice", () => {
    resetSurfacedNotices();
    expect(claimNoticeSurfacing("s1", "first")).toBeTrue();
    expect(claimNoticeSurfacing("s1", "second")).toBeTrue();
  });
});
