import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PEEK_SHIELD_DOCUMENT,
  peekPointerReport,
  peekShieldUrl,
} from "./browser-peek-shield.mjs";

describe("peek shield document", () => {
  it("is the transparent native layer over the live page", () => {
    const url = peekShieldUrl();
    assert.ok(url.startsWith("data:text/html;charset=utf-8,"));
    assert.ok(url.includes(encodeURIComponent("<!doctype html>")));
    assert.match(PEEK_SHIELD_DOCUMENT, /html, body \{[^}]*background: transparent/);
  });

  it("keeps its chrome for hover only", () => {
    // Resting state: the page and nothing else. No always-on title bar, which
    // is what made the card read as a miniature browser window.
    assert.match(PEEK_SHIELD_DOCUMENT, /\.chrome \{[^}]*opacity: 0/);
    assert.match(PEEK_SHIELD_DOCUMENT, /body\[data-hover\] \.chrome \{ opacity: 1; \}/);
    // Chrome goes quiet again on its own, so an idle card shows no controls.
    assert.match(PEEK_SHIELD_DOCUMENT, /setTimeout\(function \(\) \{ body\.removeAttribute\("data-hover"\); \}, 1200\)/);
    // And no giant centred call to action standing in for a real affordance.
    assert.doesNotMatch(PEEK_SHIELD_DOCUMENT, /Open Browser/);
    assert.match(PEEK_SHIELD_DOCUMENT, /cursor: grab/);
  });

  it("masks all four native corners with the app's surface colour", () => {
    for (const corner of ["tl", "tr", "bl", "br"]) {
      assert.match(PEEK_SHIELD_DOCUMENT, new RegExp(`\\.mask\\.${corner} \\{[^}]*background: var\\(--peek-frame\\)`));
    }
    // An inverse quarter disc per corner is what turns four square native
    // corners into one rounded card.
    assert.match(PEEK_SHIELD_DOCUMENT, /\.mask\.tl \{[^}]*border-bottom-right-radius: 100%/);
    assert.match(PEEK_SHIELD_DOCUMENT, /\.mask\.tr \{[^}]*border-bottom-left-radius: 100%/);
    assert.match(PEEK_SHIELD_DOCUMENT, /\.mask\.bl \{[^}]*border-top-right-radius: 100%/);
    assert.match(PEEK_SHIELD_DOCUMENT, /\.mask\.br \{[^}]*border-top-left-radius: 100%/);
    assert.match(PEEK_SHIELD_DOCUMENT, /box-shadow: inset 0 0 0 1px var\(--peek-ring\)/);
  });

  it("takes its radius and colours from the renderer, not from itself", () => {
    assert.match(PEEK_SHIELD_DOCUMENT, /root\.style\.setProperty\("--peek-radius", chrome\.radius \+ "px"\)/);
    assert.match(PEEK_SHIELD_DOCUMENT, /root\.style\.setProperty\("--peek-frame", chrome\.frameColor\)/);
    assert.match(PEEK_SHIELD_DOCUMENT, /root\.setAttribute\("data-theme", chrome\.dark \? "dark" : "light"\)/);
    // Geometry is presentation state: the shield never sizes itself.
    assert.doesNotMatch(PEEK_SHIELD_DOCUMENT, /webFrame|setZoomFactor|innerWidth =/);
  });

  it("reports pointer gestures and actions, and never touches the page", () => {
    // Capture is what keeps a drag alive once the pointer leaves the card.
    assert.match(PEEK_SHIELD_DOCUMENT, /setPointerCapture\(event\.pointerId\)/);
    assert.match(PEEK_SHIELD_DOCUMENT, /api && api\.pointer\(\{ phase: "down" \}\)/);
    assert.match(PEEK_SHIELD_DOCUMENT, /phase: "move",/);
    assert.match(PEEK_SHIELD_DOCUMENT, /api && api\.pointer\(\{ phase: "up" \}\)/);
    assert.match(PEEK_SHIELD_DOCUMENT, /api && api\.action\(target\.getAttribute\("data-action"\)\)/);
    // Controls must not start a drag of the whole card.
    assert.match(PEEK_SHIELD_DOCUMENT, /closest\("\[data-action\]"\)\) return;/);
    assert.match(PEEK_SHIELD_DOCUMENT, /data-action="expand"/);
    assert.match(PEEK_SHIELD_DOCUMENT, /data-action="hide"/);
  });

  it("shows agent status only while the agent holds the page", () => {
    assert.match(PEEK_SHIELD_DOCUMENT, /meta\.hidden = !chrome\.browsing/);
  });
});

describe("peek pointer reports", () => {
  it("normalizes the phase so a gesture is always down, move or up", () => {
    assert.equal(peekPointerReport({ phase: "down" }, 1).phase, "down");
    assert.equal(peekPointerReport({ phase: "up" }, 1).phase, "up");
    assert.equal(peekPointerReport({ phase: "move" }, 1).phase, "move");
    assert.equal(peekPointerReport({ phase: "nonsense" }, 1).phase, "move");
    assert.equal(peekPointerReport(undefined, 1).phase, "move");
  });

  it("converts device-independent pixels into renderer CSS pixels", () => {
    assert.deepEqual(peekPointerReport({ phase: "move", dx: 120, dy: -80 }, 1), {
      phase: "move",
      dx: 120,
      dy: -80,
    });
    // A zoomed window makes one renderer CSS pixel larger than one DIP.
    assert.deepEqual(peekPointerReport({ phase: "move", dx: 120, dy: -80 }, 1.25), {
      phase: "move",
      dx: 96,
      dy: -64,
    });
    // A nonsensical zoom must not turn a drag into a division by zero.
    assert.deepEqual(peekPointerReport({ phase: "move", dx: 10, dy: 10 }, 0), {
      phase: "move",
      dx: 10,
      dy: 10,
    });
  });
});
