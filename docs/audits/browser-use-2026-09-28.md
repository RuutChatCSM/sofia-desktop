# Browser use audit — 2026-09-28

Scope: `sofia-browser-repl.mjs`, browser runtime registration and generated skill,
CDP broker, Electron browser panel, and native browser test specifications.
This is a source audit plus bounded runtime verification, not a claim that every
advertised method works on every website. WordPress signup was not submitted.

## Findings and changes

| Area | Finding | Change / coverage |
| --- | --- | --- |
| Observation | The compact snapshot hid field values and validity, so agents could not inspect a failed submission. | Non-password values, validity, validation message, disabled/read-only and checked state now appear; explicit `inputValue(target)` added. Password values remain excluded. |
| Fill | The repaired implementation uses trusted `Input.insertText` and checks retention, but earlier traces can come from an older running MCP. | Native fixture checks trusted input events and retained value. This does not establish WordPress's server accepted an email. |
| Typing | `type()` changed DOM values with untrusted input/change events. | Uses Chromium text insertion; rejects an unfocused/noneditable field. |
| Checkbox | `check()` toggled state and then called `click()`, undoing the change. | Native click only when unchecked, verifies checked state; repeated check is idempotent. |
| Keyboard | `press()` dispatched synthetic KeyboardEvents, which don't implement native browser default actions such as submitting forms. | Uses native keyboard dispatch, including Enter/Tab/Escape key codes. |
| Pointer | Hover and double-click emitted synthetic DOM events. | Native mouse events. Click rejects disabled and covered targets. Full stability/auto-wait semantics remain a gap. |
| Motion latency | Both plugin and broker animated each mouse movement, multiplying the event path. | Broker alone owns native motion; plugin sends one destination. |
| Console | Console event collection existed without enabling the Runtime domain. | Runtime enabled on connection. |
| Session | Call-local handles vanish between calls; creating a replacement tab resets a form. | Existing get/attach by target ID, serialized URL/title, persistent global bindings and explicit recovery instructions; restart test preserves form and tab count. |
| Peek | Navigation only reasserted responsive emulation, skipping Peek's desktop page zoom after origin changes. | Reapply viewport in Peek on navigation; native test checks desktop layout width before/after cross-origin CDP navigation. |

## Remaining gaps from source inspection

These are not verified features and must not be represented as passing coverage:

- Snapshot numeric indices are reconstructed for each action; dynamic insertion can retarget an old index. Stable element identities and stale-reference errors are needed.
- Locators choose a first match rather than rejecting ambiguity. `getByRole()` lacks accessible-name filtering; `locator()` indices are selector-local rather than snapshot indices.
- Action resolution still queries only the main document. Shadow roots and iframe interaction contexts are missing. The session follow-up adds frame metadata to observations and frames.read() for live same-origin or inert sandboxed srcdoc inspection; opaque cross-origin frames still report a limitation.
- `waitFor()` supports visible/attached inconsistently and does not implement hidden/detached. Navigation readiness and SPA transitions need explicit outcome waits.
- `select()` still sets values and dispatches a synthetic change. Needs native semantics and option verification for controlled/multiple selects.
- AX actions resolve by display name rather than their backend DOM identity; duplicate names can target another element. AX type/scroll helpers do not correctly honor every ref.
- `visibility.get/set` return true without controlling or observing presentation.
- Clipboard helpers use deprecated execCommand and do not verify success; temporary focus is not restored.
- Dialog lookup reads historical events; accept/dismiss swallow errors. Current dialog state needs tracking and tests.
- Network telemetry lacks request IDs, methods, failed requests and response bodies; console/network queues need structured records for diagnosis.
- Page connections do not immediately reject pending calls on socket close or automatically reacquire a surviving target. Concurrent tool calls share one VM and can race.
- Keyboard modifier parsing supports one modifier, not arbitrary chords. Typing into password/date/file controls and IME behavior need dedicated cases.
- File upload/download, new-window popup ownership, permissions, authentication persistence, and multi-tab isolation require their own fixtures.
- CAPTCHA detection is heuristic. Changing user-agent/stealth flags is not evidence that a site will permit automation.
- Peek layout width is verified independently of native pointer mapping at reduced page zoom. A scaled Peek form interaction test remains necessary.

## Upstream comparison and recommendation

Primary sources reviewed:

- [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp): accessibility snapshots, tab management, form operations, optional diagnostics and connection to an existing CDP endpoint.
- [Playwright actionability](https://playwright.dev/docs/actionability): actions wait for visibility, stability, enabled/editable state and receiving pointer events. These semantics are a substantial gap in Sofia's custom implementation.
- [Chrome DevTools MCP tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md): input, page, network and console inspection useful for distinguishing UI input failure from a rejected or stalled request.
- [Vercel agent-browser session management](https://github.com/vercel-labs/agent-browser/blob/main/skill-data/core/references/session-management.md): persistent target bindings and strict tab pinning. It is a CLI option, not an MCP replacement by itself.
- [Browser Use](https://github.com/browser-use/browser-use): Python agent/browser stack and MCP integration. Its extra agent orchestration requires evaluation against Sofia's existing engine and visible browser ownership.

Keep Sofia's visible Electron browser, profile, cursor, Peek and tab ownership.
Evaluate replacing the custom action/locator implementation with a thin Playwright
adapter connected through Sofia's broker. Do not simply launch another browser
or install a second competing default tool surface. First benchmark against the
same native Electron fixtures, including cross-origin navigation, scaled Peek,
form controls, shadow DOM, iframes, popups and disconnect recovery. No replacement
MCP has been installed or benchmarked in this audit.

## Verification

The test is `evals/specs/browser-agent-session.e2e.test.ts`, using the actual
stdio Browser MCP against an isolated native Electron browser. Other targeted
specs cover registration/discovery and viewport/containment policy.
Final local verification (no Daytona CLI was available):

- `COREPACK_HOME=/Users/mona/.cache/node/corepack SOFIA_EVAL_E2E_TESTS=1 pnpm --dir evals test:e2e specs/browser-agent-session.e2e.test.ts` — exit 0, 1 passed, 0 failed, 0 skipped, 50.46 seconds.
- `pnpm --dir evals test:pr specs/capability-discovery.test.ts specs/browser-native-containment.test.ts specs/browser-responsive-surround.test.ts specs/browser-presentation-policy.test.ts` — initial run: 13 passed, 1 failed. The surround spec still calculated letterboxing from emulated screen position, although the implementation centers the native frame bounds. Corrected the witness to measure native frame edges while retaining the minimum margin assertion.
- `pnpm --dir evals test:pr specs/browser-responsive-surround.test.ts` — repaired witness rerun: 3 passed, 0 failed, 0 skipped. Combined final coverage across these four specs: 14 passing tests.
- `pnpm --dir apps/server build` — exit 0. Final runtime assets refreshed after the native Enter fix; Node syntax check passed.

Failures during iteration also exposed a missing native Enter character event and duplicated mouse animation. The final E2E includes those repaired paths. An isolated-profile Corepack download failure was avoided by using the host's existing Corepack cache, without changing the user's HOME or profile.
The overall exhaustive browser compatibility verdict remains **Incomplete**
while the gaps above are untested.


## Session follow-up: observation and error contract

The latest Ruut Mail → Convert session showed three repeated evaluate argument
errors, a lost call-local browser binding, missing observations, and a sandboxed
srcdoc email body that required manual HTML extraction. Follow-up changes:

- `see()` includes bounded readable text and frame metadata; supported options
  are validated rather than silently ignored. Password field values are excluded.
- `frames.read({index})` reads live same-origin content or parses sandboxed srcdoc
  inertly, returning text and resolved link URLs with a source marker.
- Invalid evaluate argument shapes return a string-based example. Page
  JavaScript exceptions reject the tool call instead of returning error text.
- Bare awaited observations and screenshots return their result when there
  was no explicit output. Explicitly printed observations are not duplicated.
- `tabs.list()` now returns plain metadata; use `tabs.get(id)` for a handle.
  Generated examples use persistent bindings and exact saved tab identity.

Verification: `COREPACK_HOME=/Users/mona/.cache/node/corepack SOFIA_EVAL_E2E_TESTS=1
pnpm --dir evals test:e2e specs/browser-observation-contract.e2e.test.ts` exited 0,
1 passed, 0 failed, 0 skipped in 28.68 seconds. It asserts iframe scripts were
not executed, opaque frame reads fail explicitly, observations contain no
password value, errors are truthful, image output is present, and reacquiring
a tab does not create a duplicate.
