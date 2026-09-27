// The agent cursor is *presentation state*, not a side effect of the input stack.
//
// A semantic browser action already knows where it acts — it resolved an element
// or was handed coordinates — so it tells this controller where the pointer
// should be. Whether the interaction is then performed with raw CDP Input,
// `Runtime.evaluate`, accessibility or plain JS is invisible to what the user
// should see: `hover`, `click`, `check`, `fill` and a coordinate click all move
// the same cursor, because the cursor reflects what Sofia is doing rather than
// which transport happened to do it.
//
// Non-spatial work (snapshot, DOM read, evaluate, scrolling, key presses) must
// not move the pointer at all, and a navigation must not teleport it anywhere:
// the document goes away, the cursor fades, and the next spatial action glides
// it into place.
//
// The overlay keeps the element id and the `window.__sofiaAgentCursor` API the
// desktop CDP broker's raw-Input fallback drives, so an external CDP client and
// this semantic path move one cursor instead of fighting over two.

/** Cursor artwork, lifted from the desktop broker so both paths look identical. */
const CURSOR_MOUSE_PATH = "m151 41.78c-3.03 0.99-7.53 2.97-10 4.4-2.47 1.43-6.86 5.13-9.75 8.21-2.89 3.09-6.45 8.2-7.91 11.36-1.46 3.16-3.09 8.45-3.62 11.75-0.74 4.55 0.74 41.29 6.12 152.5 3.9 80.58 7.49 150.77 7.98 156 0.61 6.49 1.69 11.24 3.4 15 1.37 3.02 4.48 7.69 6.89 10.36 2.91 3.22 6.9 6.09 11.84 8.5 6.92 3.38 8.08 3.64 16.5 3.6 6.85-0.02 10.39-0.56 14.55-2.2 3.03-1.19 7.71-4.09 10.41-6.46 2.7-2.36 16.95-20.28 31.67-39.8 14.72-19.52 29.39-38.09 32.59-41.25 3.21-3.16 8.53-7.55 11.83-9.75 3.3-2.2 9.15-5.32 13-6.92 3.85-1.6 10.49-3.62 14.75-4.5 6.43-1.31 15.89-1.58 55.5-1.59 39.26-0.01 48.73-0.28 53.25-1.51 3.02-0.82 7.52-2.72 10-4.2 2.48-1.49 6.19-4.41 8.25-6.49 2.06-2.09 4.81-5.93 6.11-8.54 1.3-2.61 2.94-7.23 3.64-10.25 0.77-3.31 1.02-7.79 0.64-11.25-0.35-3.16-1.52-8.11-2.59-11-1.07-2.89-3.88-7.46-6.25-10.16-2.36-2.71-54.25-46.16-115.3-96.57-61.05-50.41-114.6-94.56-119-98.1-4.4-3.54-10.93-7.75-14.5-9.34-5.25-2.34-8.23-2.97-15.5-3.25-6.72-0.26-10.39 0.1-14.5 1.45z";

export const BROWSER_CURSOR_ELEMENT_ID = "__sofia-agent-cursor";

/**
 * Injected into the document (and every new document) of a driven tab. Fixed and
 * pointer-transparent, so it never steals a click from the page.
 */
export const BROWSER_CURSOR_SCRIPT = `(() => {
  if (window.__sofiaAgentCursor) return;
  let el = null, mouse = null;
  const S = 30; // rendered cursor size (px)
  const ensure = () => {
    if (el && el.isConnected) return el;
    el = document.createElement("div");
    el.id = ${JSON.stringify(BROWSER_CURSOR_ELEMENT_ID)};
    el.setAttribute("aria-hidden", "true");
    const st = el.style;
    st.position = "fixed"; st.top = "0"; st.left = "0";
    st.width = S + "px"; st.height = S + "px";
    st.margin = "0"; st.padding = "0"; st.border = "0";
    st.zIndex = "2147483647"; st.pointerEvents = "none";
    st.transform = "translate(0px,0px)"; st.opacity = "0";
    st.transition = "transform 130ms cubic-bezier(.2,.7,.3,1), opacity 200ms ease-out";
    st.willChange = "transform, opacity";
    el.innerHTML =
      '<style>' +
      '@keyframes owAura{0%,100%{opacity:.55;transform:scale(1)}50%{opacity:1;transform:scale(1.12)}}' +
      '@keyframes owWob{0%,100%{transform:rotate(-3.5deg) translateX(-0.4px)}50%{transform:rotate(4deg) translateX(0.6px)}}' +
      '@keyframes owHue{0%{filter:blur(3px) hue-rotate(0deg)}100%{filter:blur(3px) hue-rotate(360deg)}}' +
      '</style>' +
      '<div style="position:absolute;inset:-10px;border-radius:50%;background:radial-gradient(circle, rgba(56,189,248,.42), rgba(168,85,247,.22) 52%, rgba(0,0,0,0) 72%);filter:blur(4px);animation:owAura 3.4s ease-in-out infinite, owHue 7s linear infinite"></div>' +
      '<svg id="__ow-mouse" viewBox="0 0 512 512" width="' + S + '" height="' + S + '" ' +
        'style="position:absolute;inset:0;animation:owWob 2.8s ease-in-out infinite;transform-origin:50% 50%;filter:drop-shadow(0 0 2px rgba(255,255,255,.7)) drop-shadow(0 0 7px rgba(56,189,248,.65))">' +
        '<path fill="rgba(255,255,255,.96)" stroke="rgba(10,12,20,.55)" stroke-width="16" stroke-linejoin="round" d="' + ${JSON.stringify(CURSOR_MOUSE_PATH)} + '"/>' +
      '</svg>';
    (document.documentElement || document).appendChild(el);
    mouse = el.querySelector("#__ow-mouse");
    return el;
  };
  let wobbleT = null;
  const place = (x, y) => {
    const e = ensure();
    e.style.opacity = "1";
    e.style.transform = "translate(" + (Math.round(x) - S / 2) + "px," + (Math.round(y) - S / 2) + "px)";
  };
  const burst = (x, y) => {
    const e = ensure();
    e.style.opacity = "1";
    e.style.transition = "transform 120ms cubic-bezier(.2,.6,.3,1), opacity 260ms ease-out";
    e.style.transform = "translate(" + (Math.round(x) - S / 2) + "px," + (Math.round(y) - S / 2) + "px) scale(0.7)";
    requestAnimationFrame(() => {
      e.style.transform = "translate(" + (Math.round(x) - S / 2) + "px," + (Math.round(y) - S / 2) + "px) scale(1.22)";
    });
    setTimeout(() => { if (el && el.isConnected) { el.style.transform = "translate(" + (Math.round(x) - S / 2) + "px," + (Math.round(y) - S / 2) + "px) scale(1)"; } }, 150);
  };
  window.__sofiaAgentCursor = {
    moveTo(x, y) {
      place(x, y);
      clearTimeout(wobbleT);
      if (mouse) { mouse.style.animation = "none"; void mouse.offsetWidth; mouse.style.animation = "owWob 0.8s ease-in-out 2"; }
      wobbleT = setTimeout(() => { if (mouse) mouse.style.animation = "owWob 2.8s ease-in-out infinite"; }, 1400);
    },
    flash(x, y) { burst(x, y); },
    fade() { if (el && el.isConnected) el.style.opacity = "0"; clearTimeout(wobbleT); },
    hide() { if (el && el.isConnected) el.style.opacity = "0"; clearTimeout(wobbleT); },
    present() {
      const cx = Math.round((window.innerWidth || 640) / 2);
      const cy = Math.round((window.innerHeight || 480) / 2);
      place(cx, cy);
      return cx + "," + cy;
    },
  };
})();`;

/** How far from the target a cursor that is off screen arrives from. */
export const BROWSER_CURSOR_APPROACH = { dx: -26, dy: -20 };
const APPROACH_SETTLE_MS = 40;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drives the overlay for one page connection.
 *
 * `send` is a CDP `send(method, params)` bound to that page. Every call is
 * best-effort: a cursor that cannot be drawn must never fail the browser action
 * that asked for it.
 */
export function createBrowserCursor({ send }) {
  let ready = null;
  let shown = false;

  const evaluate = (expression) =>
    Promise.resolve(send("Runtime.evaluate", { expression, returnByValue: true })).catch(() => undefined);

  async function ensureReady() {
    if (!ready) {
      ready = Promise.all([
        Promise.resolve(send("Page.addScriptToEvaluateOnNewDocument", { source: BROWSER_CURSOR_SCRIPT })).catch(() => undefined),
        evaluate(BROWSER_CURSOR_SCRIPT),
      ]).then(() => undefined);
    }
    return ready;
  }

  return {
    /** Whether the pointer is claiming a position on this document. */
    isShown: () => shown,

    /** Install the overlay and register it for every document this page loads. */
    async ready() {
      await ensureReady();
    },

    /**
     * Glide to (x, y). A cursor that is not on screen arrives from nearby rather
     * than appearing out of a position it never had.
     */
    async move(x, y) {
      await ensureReady();
      if (!shown) {
        shown = true;
        await evaluate(`window.__sofiaAgentCursor.moveTo(${Math.round(x + BROWSER_CURSOR_APPROACH.dx)}, ${Math.round(y + BROWSER_CURSOR_APPROACH.dy)})`);
        await sleep(APPROACH_SETTLE_MS);
      }
      await evaluate(`window.__sofiaAgentCursor.moveTo(${Math.round(x)}, ${Math.round(y)})`);
    },

    /** Glide to (x, y) and show the click burst. */
    async click(x, y) {
      await this.move(x, y);
      await evaluate(`window.__sofiaAgentCursor.flash(${Math.round(x)}, ${Math.round(y)})`);
    },

    /** Same, twice a beat apart, so a double click reads as one. */
    async doubleClick(x, y) {
      await this.move(x, y);
      await evaluate(`window.__sofiaAgentCursor.flash(${Math.round(x)}, ${Math.round(y)})`);
      await sleep(120);
      await evaluate(`window.__sofiaAgentCursor.flash(${Math.round(x)}, ${Math.round(y)})`);
    },

    /**
     * The document is leaving. Stop claiming a position instead of guessing a new
     * one: the next spatial action decides where the cursor appears.
     */
    async fade() {
      if (!shown) return;
      shown = false;
      await evaluate(
        "(() => { const c = window.__sofiaAgentCursor; if (!c) return; (c.fade || c.hide).call(c); })()",
      );
    },

    /** For a reconnected document whose overlay state we can no longer trust. */
    forget() {
      shown = false;
    },
  };
}
