/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import { SessionTopRail } from "../src/react-app/domains/session/surface/session-top-rail";

describe("session top rail", () => {
  test("stays out of the layout when there is nothing session-level to say", () => {
    expect(renderToStaticMarkup(<SessionTopRail />)).toBe("");
    expect(renderToStaticMarkup(<SessionTopRail notice="   " />)).toBe("");
  });

  test("hosts session-level conditions", () => {
    const markup = renderToStaticMarkup(<SessionTopRail notice="This task is open elsewhere." />);

    expect(markup).toContain("data-session-top-rail");
    expect(markup).toContain("data-session-notice");
    expect(markup).toContain("This task is open elsewhere.");
  });

  test("queued instructions belong to the composer, not the rail", () => {
    // One queue surface: the composer-attached one.
    const surface = readFileSync(
      new URL("../src/react-app/domains/session/surface/session-surface.tsx", import.meta.url).pathname,
      "utf8",
    );
    const rail = readFileSync(
      new URL("../src/react-app/domains/session/surface/session-top-rail.tsx", import.meta.url).pathname,
      "utf8",
    );

    expect(surface).toContain("aboveComposer={");
    expect(surface).toContain("<QueuedMessagesPanel");
    expect(rail).not.toContain("QueuedMessagesPanel");
  });
});
