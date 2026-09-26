// The Peek shield: a transparent native layer sitting directly above the live
// page, covering exactly the same rectangle.
//
// The page is a native `WebContentsView`, which costs us three things the DOM
// normally provides: CSS cannot clip it, the DOM cannot paint above it, and a
// human click on it never reaches React. A second native view over the same
// rectangle is the one layer that can do all three, so the shield owns:
//
//   * pointer — the whole card is one click target (expand) and one drag
//     handle (reposition). Agent input is untouched: CDP injects into the
//     page's renderer and never goes through hit testing.
//   * chrome — title, agent status and controls appear on hover only, so a
//     resting preview reads as live content, not a miniature browser window.
//   * corners — four masks paint the app's surface colour over the square
//     native corners, the only way to round a native view.
//
// Geometry is not this document's business: it never resizes itself and never
// reacts to the page. It reports pointer deltas and the renderer decides what
// they mean, because presentation owns the card's position.
export const PEEK_SHIELD_CHROME_CHANNEL = "sofia:browser:peek-chrome";
export const PEEK_SHIELD_READY_CHANNEL = "sofia:browser:peek-shield:ready";
export const PEEK_SHIELD_POINTER_CHANNEL = "sofia:browser:peek-shield:pointer";
export const PEEK_SHIELD_ACTION_CHANNEL = "sofia:browser:peek-shield:action";

export const PEEK_SHIELD_DOCUMENT = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root {
    --peek-radius: 12px;
    --peek-frame: #f0f0f3;
    --peek-ring: rgba(15, 23, 42, 0.10);
  }
  :root[data-theme="dark"] {
    --peek-frame: #212225;
    --peek-ring: rgba(255, 255, 255, 0.10);
  }
  html, body {
    margin: 0; height: 100%; background: transparent; overflow: hidden;
    font: 500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    -webkit-user-select: none; user-select: none; cursor: grab;
  }
  body[data-pressing] { cursor: grabbing; }
  .ring {
    position: fixed; inset: 0; border-radius: var(--peek-radius);
    box-shadow: inset 0 0 0 1px var(--peek-ring);
  }
  .loading {
    position: fixed; top: 0; left: 0; height: 2px; width: 100%;
    background: rgb(59 130 246); opacity: 0; transition: opacity 140ms ease;
  }
  body[data-loading] .loading { opacity: 1; }
  .chrome {
    position: fixed; inset: 0; opacity: 0; transition: opacity 150ms ease;
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.24) 38px, rgba(0, 0, 0, 0) 64px);
  }
  body[data-hover] .chrome { opacity: 1; }
  .bar {
    display: flex; align-items: center; gap: 6px; height: 32px;
    padding: 0 8px 0 10px; color: rgba(255, 255, 255, 0.94);
  }
  .favicon { width: 13px; height: 13px; border-radius: 3px; flex: none; }
  .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { flex: none; display: flex; align-items: center; gap: 4px; font-size: 10px;
    color: rgba(255, 255, 255, 0.72); }
  .dot { width: 5px; height: 5px; border-radius: 999px; background: rgb(74 222 128); }
  .spacer { flex: 1 1 auto; }
  .actions { flex: none; display: flex; align-items: center; gap: 2px; }
  .btn {
    pointer-events: auto; display: flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px;
    background: transparent; color: inherit; cursor: pointer;
  }
  .btn:hover { background: rgba(255, 255, 255, 0.16); }
  .btn svg { width: 13px; height: 13px; }
  .masks { position: fixed; inset: 0; pointer-events: none; }
  .mask { position: absolute; width: var(--peek-radius); height: var(--peek-radius); background: var(--peek-frame); }
  .mask.tl { top: 0; left: 0; border-bottom-right-radius: 100%; }
  .mask.tr { top: 0; right: 0; border-bottom-left-radius: 100%; }
  .mask.bl { bottom: 0; left: 0; border-top-right-radius: 100%; }
  .mask.br { bottom: 0; right: 0; border-top-left-radius: 100%; }
</style></head>
<body>
  <div class="ring"></div>
  <div class="loading"></div>
  <div class="chrome">
    <div class="bar">
      <img class="favicon" alt="" hidden>
      <span class="title"></span>
      <span class="meta" hidden><span class="dot"></span><span class="status"></span></span>
      <span class="spacer"></span>
      <div class="actions">
        <button class="btn" type="button" data-action="expand" title="Expand browser" aria-label="Expand browser">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        </button>
        <button class="btn" type="button" data-action="hide" title="Hide browser preview" aria-label="Hide browser preview">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>
  </div>
  <div class="masks">
    <i class="mask tl"></i><i class="mask tr"></i><i class="mask bl"></i><i class="mask br"></i>
  </div>
  <script>
    (function () {
      var api = window.__SOFIA_PEEK_SHIELD__;
      var body = document.body;
      var root = document.documentElement;
      var favicon = document.querySelector(".favicon");
      var title = document.querySelector(".title");
      var meta = document.querySelector(".meta");
      var status = document.querySelector(".status");
      var idleTimer = null;
      var pressed = null;

      function applyChrome(chrome) {
        chrome = chrome || {};
        if (chrome.radius) root.style.setProperty("--peek-radius", chrome.radius + "px");
        if (chrome.frameColor) root.style.setProperty("--peek-frame", chrome.frameColor);
        root.setAttribute("data-theme", chrome.dark ? "dark" : "light");
        title.textContent = chrome.title || "";
        title.hidden = !chrome.title;
        if (chrome.favicon) {
          favicon.onerror = function () { favicon.hidden = true; };
          favicon.src = chrome.favicon;
          favicon.hidden = false;
        } else {
          favicon.hidden = true;
          favicon.removeAttribute("src");
        }
        status.textContent = chrome.tabCount > 1 ? chrome.tabCount + " tabs" : "Browsing";
        meta.hidden = !chrome.browsing;
        if (chrome.loading) body.setAttribute("data-loading", "");
        else body.removeAttribute("data-loading");
      }

      // Chrome is hover-only, and goes quiet again on its own: a preview the
      // user is not reaching for should show the page and nothing else.
      function showChrome(hold) {
        body.setAttribute("data-hover", "");
        if (idleTimer) clearTimeout(idleTimer);
        if (hold) return;
        idleTimer = setTimeout(function () { body.removeAttribute("data-hover"); }, 1200);
      }
      function hideChrome() {
        if (idleTimer) clearTimeout(idleTimer);
        if (!pressed) body.removeAttribute("data-hover");
      }

      body.addEventListener("pointermove", function (event) {
        if (!pressed) showChrome(false);
        if (!pressed) return;
        api && api.pointer({
          phase: "move",
          dx: event.screenX - pressed.x,
          dy: event.screenY - pressed.y,
        });
      });
      body.addEventListener("pointerleave", hideChrome);
      body.addEventListener("pointerdown", function (event) {
        if (event.button !== 0) return;
        if (event.target && event.target.closest && event.target.closest("[data-action]")) return;
        event.preventDefault();
        pressed = { pointerId: event.pointerId, x: event.screenX, y: event.screenY };
        body.setAttribute("data-pressing", "");
        showChrome(true);
        try { body.setPointerCapture(event.pointerId); } catch (error) { /* capture is best effort */ }
        api && api.pointer({ phase: "down" });
      });
      body.addEventListener("pointerup", function (event) {
        if (!pressed || event.pointerId !== pressed.pointerId) return;
        pressed = null;
        body.removeAttribute("data-pressing");
        showChrome(false);
        api && api.pointer({ phase: "up" });
      });
      body.addEventListener("click", function (event) {
        var target = event.target && event.target.closest ? event.target.closest("[data-action]") : null;
        if (target) api && api.action(target.getAttribute("data-action"));
      });
      api && api.onChrome(applyChrome);
      api && api.ready();
    })();
  </script>
</body></html>`;

/**
 * One pointer report from the shield, in the units the renderer works in.
 *
 * The shield reports device-independent pixels because that is what its own
 * document measures; a zoomed main window scales renderer CSS pixels, so the
 * conversion belongs here rather than in presentation policy.
 * @param {{ phase?: string, dx?: number, dy?: number }} payload
 * @param {number} zoom
 */
export function peekPointerReport(payload, zoom) {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const phase = payload?.phase === "down" || payload?.phase === "up" ? payload.phase : "move";
  return {
    phase,
    dx: Math.round(Number(payload?.dx ?? 0) / scale),
    dy: Math.round(Number(payload?.dy ?? 0) / scale),
  };
}

export function peekShieldUrl() {
  return `data:text/html;charset=utf-8,${encodeURIComponent(PEEK_SHIELD_DOCUMENT)}`;
}
