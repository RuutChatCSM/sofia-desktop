# Computer Use audit — 2026-09-28

The latest Sofia session bypassed Computer Use using osascript and screencapture. A subsequent live agent test with OpenRouter Space Bunny Alpha called the actual check_permissions, list_apps, snapshot, set_value, snapshot tools. Its isolated native fixture accepted AXValue and a distinct fresh snapshot verified the value; no fallback or shell tools were used. The live evidence spec checks these recorded tool responses, not the assistant's summary.

## Changes

- Native MCP failures now set isError while retaining recovery details.
- Skill instructions explicitly prohibit shell substitutes for unavailable Computer Use and distinguish saved snapshot paging from fresh verification.
- Connecting Computer Use or successfully checking permissions enables Electron's Chromium accessibility bridge. Enablement is conditional because Electron documents a performance cost. It does not grant OS permissions.

## macOS completion

- `snapshot(crop: {x,y,width,height}, image_width: 256..2048)` captures a clipped region in absolute screen points. Coordinate metadata maps that image back to its origin. Encoding uses an explicit pixel bitmap, avoiding implicit Retina doubling. JPEG quality is now 0.7.
- `click(button: "right")` sends a real context-menu click, bypassing AXPress/AXFocus. Double clicks also bypass single-press AX actions.
- `press_key(milliseconds: 0..5000)` holds the combo for a bounded duration, then releases it.
- Foreground/background text dispatch preserves UTF-16 surrogate pairs and emits both key-down and key-up events. A failed field-focus operation cannot send select-all/retype to another field.
- `snapshot(wait_for: label, wait_milliseconds: 0..5000)` polls AX state without input. Missing controls time out explicitly; mutations are never replayed to wake the tree.
- Missing snapshots after reconnect return `requiredNextAction: snapshot`. Guidance preserves the original PID/window and prohibits relaunching an application merely to restore observations.
- Actions reject moved/resized/replaced windows and coordinate clicks outside the observed target window. Fresh observations rebuild refs.
- Initial snapshot pages contain eight elements; default subsequent pages contain ten, reducing tool-output truncation. Full tree queries remain available.
- The release helper has been rebuilt into the dev bundle, including MCP `isError` reporting. New helper processes load the changes; an already-running helper retains its old executable until reconnection.

### Verification limits

- Negative monitor origins and Retina crop transformations are exercised with synthetic native coordinate fixtures. Actual multiple-display arrangements were not available for hardware integration testing.
- Live native fixtures verify Unicode text, balanced key events, held-key timing, context-menu events, and cropped capture through the connected Sofia agent. The final action/recovery run passed, including rejection of an old helper snapshot and re-observation of the same fixture without relaunching it.
- Windows/Linux drivers are outside this macOS scope.
- OS grants remain user-controlled. This dev helper is ad-hoc signed; signed production packaging is required for stable permission identity across rebuilds.

## Sources

- Electron native accessibility activation and performance caveat: https://github.com/electron/electron/blob/main/docs/tutorial/accessibility.md and installed Electron 43.2.0 API definitions.
- MCP error contract: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/errors.md
- Screenshot scaling, zoom, and action surface: https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- Coordinate/Retina mapping: https://platform.claude.com/docs/en/build-with-claude/vision-coordinates

## Other implementations inspected

- Cua (https://github.com/trycua/cua) provides drivers, MCP/SDK surfaces, and cross-OS testing infrastructure. Its hybrid observation model combines pixels with accessibility/structured state. Useful reference for crop/zoom, lifecycle, and platform-specific drivers; adopting it would require a deliberate runtime integration, not an agent shell fallback.
- Terminator (https://github.com/mediar-ai/terminator) documents semantic selectors, background desktop actions, element captures, and monitor management. Its README currently describes Windows-only support, so it is a possible Windows reference rather than a replacement for this macOS helper.

The macOS changes above implement the identified input, crop, readiness, and recovery work. Cross-platform drivers and physical multi-display certification remain separate work.

## Validation

- Live macOS regression uses an isolated Electron window and Sofia's existing trusted Computer Use process. Chromium accessibility starts disabled; connecting enables it; the native MCP snapshot and saved-snapshot queries expose a named button and text field. No click, text entry, shell substitution, or interaction with user documents occurs in this regression.
- Desktop bridge coverage check passed (54 renderer methods).
- Desktop typecheck is not clean: cdp-broker-discovery.test.mjs lines 40 and 51 omit appIdentifier and pid required by the current inferred function signature. Those files are outside this accessibility change; no clean-control verdict was established.
- Restart the dev app to load the Electron integration change. Successful permission verification/connection enables accessibility in the updated process.

## Completion evidence (local macOS lane)

Daytona CLI is unavailable; native macOS fixture tests ran locally.

- `pnpm --dir evals test:pr specs/computer-use-snapshot-boundaries.test.ts`: 1 passed, 0 failed/skipped; executes 7 native Swift tests including delayed readiness, timeout, Unicode, Retina image encoding and negative-origin crop mapping.
- `pnpm --dir evals test:pr specs/computer-use-tool-contract.test.ts`: 3 passed, 0 failed/skipped; covers direct registration, actionable errors and the bundled release tool schema.
- `SOFIA_EVAL_E2E_TESTS=1 SOFIA_LIVE_DESKTOP_TESTS=1 SOFIA_LIVE_DESKTOP_PROFILE=<dev-profile> SOFIA_LIVE_DESKTOP_URL=<live-url> SOFIA_LIVE_WORKSPACE_ID=<workspace> pnpm --dir evals test:e2e specs/computer-use-macos-actions.e2e.test.ts`: 1 passed, 0 failed/skipped, 152 seconds. Two connected Space Bunny sessions verify events, crops and recovery against one isolated fixture. Fixture processes are cleaned up after the run.
- Server build/typecheck, Electron bridge check, helper signature verification and `git diff --check` passed.

A test authoring failure (`homedir` import) was repaired before the final passing action/recovery run. A display-scale Swift dictionary key type error was repaired before the final release build. These are not classified as pre-existing.

- Final Electron AX/capture regression: 1 passed, 0 failed/skipped, 40 seconds after the shadow/display-scale update.
