# ChatGPT → Sofia reconstruction checklist

Last updated: 2026-10-10 (Africa/Lagos). Overall status: **Incomplete**.

## How to resume

Use this document as the working checklist. Check a box only when its acceptance criteria have observable eval evidence. “Implemented” does not mean verified ChatGPT parity. Record evidence and remaining limitations after each change; preserve existing unrelated work.

Repository: `/Users/mona/Dev/tools/sofia-app`.
Reference evidence: `/Users/mona/Dev/tools/reference/chatgpt-rea-2026-10-09`.

## Session and composer — partial, not certified complete

Source inspection confirms Sofia has per-session drafts, queue/steer, IME protection, mentions/skill insertion, attachment handling, and transcript media changes. These are implementation observations, not a fresh runtime verdict. Current busy-submit mapping is Enter queues / Cmd or Ctrl+Enter steers; recovered ChatGPT behavior also depends on user preferences.

- [x] Audit transcript scrolling: follow within 24px of bottom, release on user scroll, explicit return to bottom, preserve position on history prepend/content growth/resize (Electron verified).
- [ ] Verify session switching and draft restoration, including rich content, attachments, model choice, interrupted sends and asynchronous identity changes.
- [ ] Verify idle/busy/disabled/preparing/queued/steering/error composer states and actual keyboard interactions, including IME and suggestion-menu guards.
- [ ] Decide and implement preference-dependent queue/steer inversion and Enter/multiline shortcut behavior; default behavior already exists.
- [ ] Compare attachment capture/upload/pending/failure/removal behavior; verify send gates and retention after errors.
- [ ] Compare large-paste handling against recovered conditional 5,000-character attachment behavior.
- [ ] Verify file/skill/app mention selection, removal, serialization and stale-account/session protection.
- [ ] Verify annotation image/region/comment stays one object and asynchronous capture cannot overwrite newer draft text.
- [ ] Verify transcript image expansion and workspace image/audio/video/PDF previews, including unavailable media and cleanup. Implementations exist in the current working tree.
- [ ] Compare working/thinking/tool summaries, disclosure, completion and retry/reconnect states.
- [ ] Audit rename/archive/pin undo, read state, fork and creation routing; recovered source coverage itself is partial.
- [ ] Complete visual matching of transcript width, typography, spacing, attachment thumbnails, composer height/radius/actions and right-panel layout at several window sizes.
- [ ] Run focused session/composer evals and link their evidence before declaring this section complete.

Existing eval entry points include `composer-queued-follow-ups-sequential.e2e.test.ts`, `composer-references.e2e.test.ts`, `attachment-upload-loading-state.e2e.test.ts`, `session-loading-idle.e2e.test.ts` and `sofia-session-contract.test.ts` under `evals/specs`. Their existence alone is not a pass.

## Message/thread blocks, thinking and tool use — exact behavior still to verify

These are explicit parts of the requested reconstruction, not just visual styling. Compare recovered client contracts and permitted screenshots with Sofia's rendered behavior. Preserve structured events and identities through transport, storage, reconciliation and rendering. Do not infer unrecovered behavior or expose hidden reasoning; thinking presentation should use only summaries/content supplied for display.

### Message and thread structure

- [ ] Map user, assistant, steering, system/status, tool-call and tool-result events to their correct visible blocks and order.
- [ ] Verify turn/message/block identity across streaming updates, optimistic sends, acknowledgements, retries and reconnects: no duplicate, missing or reordered blocks.
- [ ] Verify incremental text/Markdown rendering, including code fences, tables, links, citations, file references and mixed media; finalization must preserve content and selection.
- [ ] Compare grouping and spacing of consecutive assistant commentary, tool activity and final answers within one turn.
- [ ] Verify thread history pagination, stable scroll targets, search expansion and collapsed-turn restoration.
- [ ] Compare edits, regeneration, forks and selected conversation branches where supported; retain explicit gaps where reference behavior or Sofia support is unavailable.
- [ ] Verify cancellation/failure/interruption boundaries and partially completed blocks without falsely marking a turn successful.
- [ ] Verify copy, expand/collapse, retry and other message actions, including their availability during streaming and after completion.

### Thinking and work summaries

- [ ] Compare initial working/thinking indicators, displayed summaries and transitions into tool activity or answer text.
- [ ] Compare default collapsed state, disclosure controls, elapsed-time labels and the completed “Worked for…” presentation.
- [ ] Verify disclosure remains stable as content grows and does not reset on unrelated updates or session switches.
- [ ] Verify empty, unavailable, interrupted and failed thinking states without inventing or revealing hidden reasoning.
- [ ] Verify accessibility labels, keyboard interaction, reduced motion and screen-reader announcements.

### Tool-use blocks

- [ ] Map actual tool names and arguments to readable activity labels and icons for commands, file edits, browser actions, native computer use, integrations and searches.
- [ ] Compare compact grouped tool summaries versus expanded individual calls, including consecutive and concurrent calls.
- [ ] Verify queued/running/waiting-for-approval/succeeded/failed/cancelled states from real lifecycle events.
- [ ] Keep each result attached to the correct call; handle delayed/out-of-order results and reconnect replay without duplicates.
- [ ] Compare input/output disclosure, long-output truncation/expansion, structured results, errors and links to generated artifacts.
- [ ] Verify permission/approval and human-takeover UI reflects the actual execution gate and resumes only when authorized.
- [ ] Verify browser/computer previews follow the owning call/run, persist or disappear at the correct transition, and do not leak across threads.
- [ ] Compare changed-file counts/diffs, background-process presentation, context-compaction notices and final turn summaries where supported.
- [ ] Run focused observable evals for block ordering, concurrent tools, reconnect reconciliation, cancellation and disclosure state before marking this section complete.

## Computer use and live preview

- [x] Helper identity changed to `ruut.sofia.computer-use`; Settings/server resolve the same signed helper.
- [x] Scoped preview lifecycle, hide/restore, sizing/placement and stale-media cleanup implemented and covered by fixture evals.
- [x] Completion app icon/check/mini badge/expiry implemented and covered by fixture evals.
- [ ] Verify current rebuilt helper Accessibility and Screen Recording status. Last recorded native proof was blocked by Accessibility denial; user has since demonstrated computer use, so recheck rather than assume it remains denied.
- [ ] Finish signed-helper native input proof: `computer-native-parity.e2e.test.ts`.
- [ ] Verify real native preview capture and cursor appearance after the latest rebuild. Blue circular aura and glow removed from source; release helper rebuilt, live appearance not yet verified.
- [ ] Verify actual user-visible preview controls and native takeover/interruption end to end.
- [ ] Resolve multi-run attribution if supporting concurrent native computer sessions; current preview relies on a single-active-run gate.

Native proof command:

```sh
SOFIA_EVAL_E2E_TESTS=1 SOFIA_NATIVE_COMPUTER_PROOF=1 pnpm --dir evals exec vitest run --config vitest.config.ts --project e2e specs/computer-native-parity.e2e.test.ts
```

## Browser use

- [x] Shared reconstructed cursor runtime and app-owned transparent host; no cursor injected into production page DOM.
- [x] Arrival acknowledgement, duplicate sequence handling, scope enforcement, completed-run revocation and disconnect cleanup.
- [x] Takeover blocks input/evaluation; resume restores control; reattachment cannot silently resume.
- [x] Observed indices reject replaced nodes; trusted action and observation evals passed.
- [x] Empty HTTP error responses surface an error; refresh retains it; navigation to a working page recovers. Production Electron fixture eval passed 2026-10-10.
- [ ] Physically exercise Take control/Resume agent toolbar buttons (existing production proof uses IPC).
- [ ] Finish live visual comparison of cursor motion and browser/peek transitions.
- [ ] Resolve Tailora access using the full working Safari URL. `api.tailora.com` failed local DNS; `https://api.usetailora.com/` returned an empty HTTP 404. Authentication cause is unverified.

Latest browser proof: [local evidence](../evals/results/test-runs/2026-10-10T09-11-05-609Z-production-browser-cursor-stays-outside-page-content-and-human-takeover-blocks-a/index.html).

## Skills and prompts

- [x] Runtime skill install/removal follows enabled tools; namespaces pinned; computer/browser routing, fresh observations, takeover and verification instructions adapted and tested.
- [ ] Inventory the recovered bundled prompt documents and classify each as adopted, unnecessary, unsupported or unresolved.
- [ ] Verify model behavior with actual Sofia tools across representative computer/browser tasks; generated skill text tests alone do not prove model compliance.
- [ ] Finish composer prompt UI comparison: skill picker, starters, attachments, dictation and app context.

## Evidence and limits

- [Integration implementation and proof](../../reference/chatgpt-rea-2026-10-09/SOFIA-COMPUTER-BROWSER-INTEGRATION.md)
- [Recovered session/composer contracts](../../reference/chatgpt-rea-2026-10-09/session-prompts/SESSION-PROMPT-SPEC.md)
- [Recovered UX index](../../reference/chatgpt-rea-2026-10-09/UX-RECONSTRUCTION.md)

Full hidden server/model prompts and original source are not recovered. Live ChatGPT tool access was denied; do not bypass that restriction with another driver. User-provided screenshots and permitted static artifacts remain the reference. Exact pixel or full behavioral equivalence is not established.

## Implementation pass: session/block contracts (2026-10-10)

Verified installed reference still matches version `26.1007.21159`, ASAR SHA-256 `97b8e5fddfced82d782c5f3f3e7c5aba7940b8cb1068dd214ffa3d71687d9fdb`.

- [x] Large-paste helper reproduces recovered 4,999/5,000 text/Markdown boundary, names/MIME/bytes and applicable gates (local contract eval).
- [x] Reconciliation uses engine part IDs/tool-call IDs rather than array positions; replay preserves intervening live blocks and completed tool results (three local evals).
- [x] Unknown work timing renders Activity; explicit cancelled outcome renders You stopped; failed outcome does not claim successful work. Completion updates only the owning turn (four local evals).
- [x] Transcript display serialization retains one pasted file and typed prose without expanding the file body into raw message text (local eval).
- [x] Native rich-clipboard paste duplication regression: trusted text/plain + HTML paste produces one attachment, preserves existing prose and inserts no raw body. Real Electron eval passed after fixing capture propagation and Lexical fallback.
- [ ] Full thinking/tool disclosure, concurrency, history and visual equivalence still require the unchecked acceptance criteria above.

[Trace and changes](../../reference/chatgpt-rea-2026-10-09/session-prompts/SOFIA-SESSION-BLOCK-IMPLEMENTATION.md).

## Session display correction: 2026-10-10

- [x] User attachment renders once with its original filename; duplicate UUID Files strip removed from user messages. Actual Electron session-renderer eval passed.
- [x] Traced shipped mGc/_Gc duration formatter and LW working threshold; work headers now use floored seconds, narrow units, zero-unit trimming, and Working / Working for transitions. Local work-state evals passed.
- [ ] Full locale-message parity, pause/loading lifecycle mapping, exact disclosure behavior and visual certification remain open. Overall 100% parity is not established.

## Actual-session work disclosure audit

Inspected the saved Sofia session `01a12270-04d4-7812-b113-3359aaf1101f`, including the pasted-text turns at 2026-10-10 16:32 and 16:33 Africa/Lagos. Each contained UserMessage and AgentMessage completion events, with no tool-call or reasoning items. The first prompt already contained “testing pasted text”; its response did not prove a file read.

Removed the unavailable-details fallback. Timing-only turns now render a non-interactive summary; recorded activity retains an expandable work block. Do not infer tool use or thinking from elapsed time alone. Real session inspection, not the earlier synthetic fixture, establishes these observations.

## Outputs and Sources implementation pass

- [x] Trace shipped summary/source components, verify artifact identity and member hashes; recover floating width 300, compact source limit 3 and separate full Sources pane.
- [x] Add session-scoped source/output projection with safe URL handling, deduplication, original filenames, integration identity and Web search marker.
- [x] Build wide-layout top-right summary and narrow-layout rail access; wire creation drafting, attachment picker, file/image preview and browser opening.
- [x] Keep read/input sources out of generated outputs and change hints; use server-verified file targets and workspace-relative API paths.
- [x] Pass local classification/lifecycle/layout contracts and actual Electron summary interactions; typecheck and build.
- [x] Wire recorded Task/Codex receiver states, truthful Subagents counts and parent-scoped overview tab.
- [ ] Match native Subagent avatars and child transcript navigation.
- [ ] Complete terminal actions, native create/connection menus, section persistence and exact portal/visual transitions.
- [ ] Verify cloud/remote formats, symbol source locations and native preview placement parity.

[Implementation and evidence](../../reference/chatgpt-rea-2026-10-09/outputs-sources/SOFIA-OUTPUTS-SOURCES.md).

## Next work
## Outputs and Sources implementation pass

- [x] Trace shipped summary/source components, verify artifact identity and member hashes; recover floating width 300, compact source limit 3 and separate full Sources pane.
- [x] Add session-scoped source/output projection with safe URL handling, deduplication, original filenames, integration identity and Web search marker.
- [x] Build wide-layout top-right summary and narrow-layout rail access; wire creation drafting, attachment picker, file/image preview and browser opening.
- [x] Keep read/input sources out of generated outputs and change hints; use server-verified file targets and workspace-relative API paths.
- [x] Pass local classification/lifecycle/layout contracts and actual Electron summary interactions; typecheck and build.
- [x] Wire recorded Task/Codex receiver states, truthful Subagents counts and parent-scoped overview tab.
- [ ] Match native Subagent avatars and child transcript navigation.
- [ ] Complete terminal actions, native create/connection menus, section persistence and exact portal/visual transitions.
- [ ] Verify cloud/remote formats, symbol source locations and native preview placement parity.

[Implementation and evidence](../../reference/chatgpt-rea-2026-10-09/outputs-sources/SOFIA-OUTPUTS-SOURCES.md).

## Next work

1. Finish the focused session/composer and message/thinking/tool-block audit; produce a concrete gap list from source plus runtime evals.
2. Recheck current native permission state and run the isolated native fixture proof if granted.
3. Verify latest cursor and preview visually in Sofia, then finish toolbar interaction proof.
4. Update this checklist and evidence after each completed item.

### Outputs/Sources visual correction (October 10)

- [x] Scope neutral secondary source/header/icon colors, 13px system font, elevated card surface and tighter section spacing to the summary widget.
- Evidence: shipped summary header `text-sm text-secondary`, Electron `--text-sm:13px`, surface token `surface-elevated-secondary`; concrete dark palette matched against the user’s 18:51 screenshot because native app injects platform color variables.
- Exact platform font weight, Subagents state and full visual parity remain unverified.

### Source opening and composer correction (October 10, 19:11)

- [x] Remove the composer backdrop gradient.
- [x] Open inline and verified local image Sources in reusable docked tabs with fit/zoom/download; local files retain external opening.
- [x] Verify text, Markdown, CSV, image and URL Source routes in Electron. Unsupported verified files have an explicit unavailable preview with download/open actions.
- [x] Use real Task/Codex receiver status for Subagents, deduplicate updates and open a parent-scoped Subagents tab with recorded details.
- [ ] Native image editing/markup toolbar, full document/slide rendering, app-provider source routing and child-thread navigation.

Evidence: `outputs-sources/use-local-conversation-sources-fc9ee60ab4e3.js` and native `jT/KT` image/file opening callbacks; native Subagents opener traced in `outputs-sources/SUBAGENTS.md`. No live ChatGPT runtime was controlled.

Local verification: 14 contract tests + Electron E2E Passed; app typecheck/UI build Passed. [Latest test evidence](/Users/mona/Dev/tools/sofia-app/evals/results/test-runs/2026-10-10T18-13-04-456Z-session-outputs-and-sources-separate-inputs-reveal-all-references-and-open-gener/index.html).

### Subagents cache crash correction

- [x] Handle existing in-memory resource caches created before `subagents` was added. The merge boundary accepts the missing field, preserving recorded canonical agents and avoiding `.map()` on undefined.
- [x] Regression assertions cover absent legacy state both with and without canonical agent data. No session data is cleared.

### Recovery, scrolling and summary visibility (October 10)

- [x] Recover durable Codex items on initial stream readiness and reconnect, coalesce reads with one trailing refresh, and reject cancelled results.
- [x] Preserve longer streamed content and terminal item state during replay; restore recorded interrupted/replaced outcomes from bounded rollout history.
- [x] Preserve visible message anchors through history prepend, content growth, resize, session switching and reload; cancel delayed jumps on navigation.
- [x] Respect editable controls and ignore zoom/horizontal wheel gestures; retain the 24px follow threshold.
- [x] Replace the transcript's broad native scrollbar track with a 6px rounded thumb on a transparent track. This is requested Sofia styling.
- [x] Add a persistent Outputs/Sources hide/show header control without removing Sources or preview tabs.
- [x] Verify actual SSE socket-drop recovery in isolated Electron using production client/retry/recovery/store; full React-hook/engine-restart proof remains pending.
- [ ] Verify generic-provider recovery, remote ownership and delta sequence deduplication.
- [ ] Match native virtualized pagination, scoped summary reset keys and narrow-width popover transitions.

Verification: 18 focused recovery/scroll/transcript tests, scrolling Electron E2E and Outputs/Sources Electron E2E passed; UI build passed. Static evidence and implementation boundaries: [scrolling](../../reference/chatgpt-rea-2026-10-09/session-recovery-scroll/SOFIA-SCROLL.md), [recovery](../../reference/chatgpt-rea-2026-10-09/session-recovery/SOFIA-RECOVERY.md), [summary visibility](../../reference/chatgpt-rea-2026-10-09/outputs-sources/SUMMARY-VISIBILITY.md).

### Four follow-up improvements (October 11)

- [x] Cap Outputs at three items and open all generated files in a separate Outputs tab; Sources retains its separate three-item presentation. Outputs cap is a Sofia adaptation, not a recovered native constant.
- [x] Open recorded direct-child Codex conversations from the parent Subagents panel, with current status, Back, refresh, loading/error/empty states and stale-response cancellation.
- [x] Validate recorded parent-child membership server-side before reading history; browsing never resumes a child.
- [x] Pass actual Electron Outputs/list/file interactions and child navigation/error/Back UI proof with deterministic child HTTP responses.
- [x] Pass isolated Electron recovery after two actual SSE socket drops, retaining partial content and restoring missed durable items/interruption without duplicate item IDs.
- [ ] Complete live spawned-child streaming, full descendant navigation, persisted child selection and native rich child transcript blocks.
- [ ] Verify whole-hook recovery UI, engine-process restart, network-interface loss and remote ownership.

Evidence: [compact Outputs and child integration](../../reference/chatgpt-rea-2026-10-09/outputs-sources/COMPACT-OUTPUTS.md), [subagents](../../reference/chatgpt-rea-2026-10-09/outputs-sources/SUBAGENTS.md), [composer semantics](../../reference/chatgpt-rea-2026-10-09/composer-queue-steer/EVIDENCE.md), [transport recovery](../../reference/chatgpt-rea-2026-10-09/session-recovery/SOFIA-RECOVERY.md).

- [x] Add persisted Queue/Steer preference with Steer default, visible busy-composer actions, preference-based Enter and opposite Cmd/Ctrl+Shift+Enter. Shift+Enter retains newline.
- [x] Prevent double queued promotion and clear steering pending state after accepted or failed submission.
- [x] Pass composer Electron delivery assertions: selected Steer via Enter/button, queued drafts unsent while busy, opposite shortcut, exact-once promotion and remaining draft dispatch on idle. Backend acceptance is mocked; no inference is used.
- [ ] Native Interrupt preference, durable queued drafts and real backend turn-completion/FIFO integration. Legacy generic-engine FIFO test targets an unavailable `/engine/session` endpoint and fails setup HTTP404; the current Codex submission-path E2E is separate proof.

Final verification for this pass: 33 focused tests passed, plus three local Electron E2Es (Outputs/Sources and child UI, actual SSE drops, composer dispatch). App/server typechecks and UI build passed; `git diff --check` passed. Native visual placement, full child streaming and whole-hook/process-loss recovery are not certified.

### Imported and native session fidelity (October 11)

- [x] Read imported desktop names from Codex session_index and merge SQLite metadata into existing placeholder sessions; honor explicit names.
- [x] Adopt useful native Codex first-request titles when engine naming is unavailable, persist through engine rename RPC, and protect concurrent manual renames. Existing native Ruut title-agent path is retained without extra inference.
- [x] Preserve imported commentary/final phases, reasoning summaries, image inputs and named call/output identity. Enrich materialized history from recorded rollout phase/clocks.
- [x] Omit unknown historical clocks rather than display fabricated duration.
- [x] Improve the shared native/imported work disclosure divider and spacing.
- [x] Pass Electron native UIMessage work disclosure proof and imported rollout → production adapter/cache → shared UI proof, including header/sidebar title, image, commentary, 10s recorded duration and no generic function row.

Verification: 23 focused tests, two local Electron tests, app/server typechecks and UI build Passed. The user's actual source was inspected read-only: a subsequent full parser read preserved 1485 items, 116 commentary records and 23 image inputs; all items retained recorded clocks, with zero generic `function` calls. These counts are diagnostic observations; test assertions provide the runtime verdict.

Remaining: exact virtualized timeline/date separators, rich child transcript/live child streaming, full native image editing, unmatched historical metadata and ongoing title-index watching. Restart Sofia to refresh imported title names. This pass does not certify 100% visual/behavioral parity.

Evidence: [title cause and naming](../../reference/chatgpt-rea-2026-10-09/session-titles/SOFIA-TITLES.md), [imported fidelity](../../reference/chatgpt-rea-2026-10-09/imported-transcript/FIDELITY.md).

### Scrollbar idle visibility (October 11)

- [x] Hide the transcript thumb after 1.2 seconds without scrolling; reveal during scrolling or hover within 10px of the right edge. Track remains transparent and 6px width remains stable.
- [x] Cancel visibility timers/listeners on session change or disposal.
- [x] Actual Electron scroll test Passed: active thumb, idle transparent thumb, edge-hover visibility, leaving edge hides again, and existing anchor/follow/restoration assertions retained.

### Image paste and actual-root work parity correction (October 11)

- [x] Decode HEIC/HEIF using macOS codecs into PNG before preview/model input; preserve original display name and use supported encoded MIME/filename. Unsupported platforms reject with export guidance.
- [x] Display a 154×118 image card above prose and update async preview metadata without rebuilding text/selection.
- [x] Image-first paste creates an editable line below the card; actual Electron typing without refocus survives async decoding.
- [x] Recover the root rollout as canonical narrative instead of incomplete/child-contaminated materialized messages; idle previously restored historical pollution is pruned.
- [x] Prefer full recorded turn boundaries for shared timing; native observed turns retain start before their first assistant item. No missing clock is replaced with a fabricated completed interval.
- [x] Retain chronological commentary/reasoning/tool order and render collaboration milestones; known read/search command actions use their real categories.
- [x] Hide desktop transport envelope only in shared user presentation, preserving actual request, image names and original model history.
- [x] Refresh imported title names on list/open/read without requiring a manager restart for subsequent index changes; manual names remain protected.

Verification: 31 focused tests Passed; actual Electron HEIC paste, scrollbar idle/edge-hover, shared native work disclosure/collaboration, and imported root presentation tests Passed. App/server typechecks and UI build Passed; diff check clean. Imported E2E includes 23m51 full boundaries, original image name, clean request prose, exact sidebar/header title and expanded commentary.

Exact remaining timing difference: actual root `do all those` records task_started00:31:44.526Z and task_complete00:55:35.562Z =23m51.036s; ChatGPT screenshot23m48s. The native display boundary is not yet established; do not substitute a guessed three-second correction. Native avatar styles, precise collaboration narrative, richer unmatched materialized items and virtualized/date navigation remain incomplete.

Restart the desktop app once to load new HEIC IPC/preload and server code. Evidence: [HEIC/composer](../../reference/chatgpt-rea-2026-10-09/outputs-sources/HEIC-COMPOSER.md), [canonical root](../../reference/chatgpt-rea-2026-10-09/imported-transcript/FIDELITY.md), [title refresh](../../reference/chatgpt-rea-2026-10-09/session-titles/SOFIA-TITLES.md).

### Session-list identity and subagent ownership (October 11)

Actual running Sofia selected `codex-01a12875-f316-7ee2-b357-6942e35b4280`, the Imported transcript fidelity worker. Its inherited context and worker finals explained the apparent split root and short timings. This was an identity/listing issue; the worker is a legitimate child thread, not a duplicate root turn. Read-only DB inspection confirms 18 direct workers of `01a121a8-ad19-7791-bd8e-f57c03e13cc1` (Install the rea skill).

- [x] Match shipped ChatGPT sidebar exclusion of subagent-source records; preserve independent user forks and archived filtering.
- [x] Keep known child parent metadata and child history accessible without resume; allow persisted exact ancestry when collaboration materialization is absent.
- [x] Page engine thread history rather than silently stop after first 100 entries.
- [x] Exclude parent-linked children from frontend sidebar projection and migrate old child URLs to their parent via retained/API parent metadata.
- [x] Project recorded child membership/nickname into the parent's Subagents overview; idle stays status unknown and canonical lifecycle evidence wins.
- [x] Audit actual generated workspace flag `multi_agent_v2=true` and bundled binary feature support. Engine owns spawning/limits/lifecycle; model chooses invocation; Sofia owns configuration and presentation.
- [ ] Prove real-provider spawn/lifecycle reliability and native precise subagent avatar/prompt-policy parity. No inference or live ChatGPT execution was performed for this audit.

Evidence: [parentage/listing](../../reference/chatgpt-rea-2026-10-09/session-list-parentage/PARENTAGE.md), [shipped list and actual engine audit](../../reference/chatgpt-rea-2026-10-09/session-list/SUBAGENT-ENGINE-AUDIT.md). Original source threads were neither merged, deleted nor archived.

### Attachment transport markup (October 11)

- [x] Remove recognized empty image transport tags from the displayed request when their paths match the desktop attachment envelope. Preserve thumbnails, original history, and unrelated literal image tags. Shared presentation applies to imported and native user messages.
- [x] Local parser regression proof: four tests passed in `user-message-display.test.ts`; app typecheck passed. This pass verifies display normalization, not a new live screenshot comparison.

### Working agent summary and rich activity (October 11)

- [x] Read explicit child start/completion records; latest start remains Working until a recorded terminal event. Missing evidence is not fabricated.
- [x] Compact summary shows working avatars/count left and settled Done count right. Failed/stopped details remain available in the overview.
- [x] Refresh parent child metadata every three seconds while visible, discovering external workers without resuming them; working child conversations also refresh.
- [x] Original stable SVG avatars appear in summary, compact Active/Done lists, child headers and named collaboration transcript milestones.
- [x] Shared child transcript renderer preserves commentary, work disclosure and read-only actions. Imported nested actions distinguish reads, edits, web searches and commands; recorded compaction renders a marker.

Verification: latest 25 focused tests, app/server typechecks, UI build and diff check passed. Extended Electron subagent overview/child refresh proof passed (29.70s). New parent metadata polling and collaboration avatar rendering have contract/type verification; no fresh live application screenshot comparison was performed. Full desktop restart loads the server changes. Exact native timing boundary, real-provider lifecycle reliability and full visual parity remain unverified.

### Actual screenshot corrections (October 11, 09:36–09:42)

- [x] Resolve spawn `task_name` result paths to recorded thread identity; display named stable avatars and group adjacent starts without crossing commentary.
- [x] Done counts explicit completed workers only (actual root: 19 completed, 3 failed). Failures remain separate in the overview.
- [x] Restore canonical order even during running history refresh; preserve the live tail. Full rollout clocks survive a bounded outcome tail: recorded work is 6h1m39.794s, not first-commentary-based 6h1m14s. ChatGPT's 6h1m38s exact boundary remains unestablished.
- [x] Never promote explicit progress commentary to a final answer. One final card aggregates the logical turn's edits across intervening user follow-ups.
- [x] Preserve recorded patch counts/path/content for immutable cards and hover previews. Tool-derived counts are not represented as a repository baseline and do not enable historical Undo.
- [x] Sources projects user attachments newest first, plus explicit external/provider references, without internal file reads. Skill reads narrate loading a tool; command polling avoids the raw `stdin · Write` label.

Verification: local lane 36 focused tests; interrupted-turn Electron presentation test Passed (17.59s), asserting one final card, recorded counts/paths, attachment/title/timing and expanded narrative. App/server typechecks, UI build, diff check Passed. The exact native timing boundary and a fresh screenshot of the user's running app remain unverified. Full quit/restart required for embedded server updates.

### Shipped diff card implementation (October 11)

- [x] Traced actual local turn renderer → `sites-end-resource` turn-diff export → diff-preview tooltip/content and patch-stat helpers from integrity-verified installed ASAR members.
- [x] Read tools cannot create edit hints even when supplied stale artifact paths.
- [x] Preview follows shipped layout: 800ms hover, top placement, path/count header, bounded scroll, highlighted unified rows, transport marker removal. Workspace-relative display paths retain exact original targets.
- [x] Local contract tests Passed (16); Electron hover/presentation Passed (25.79s), asserting patch content and absence of transport end markers; app typecheck and UI build Passed. Static findings: `reference/chatgpt-rea-2026-10-09/change-card/IMPLEMENTATION.md` in the parent workspace.

### Lifecycle and activity follow-through (October 11)

- Root rollout `event_msg.item_completed` contains `SubAgentActivity` started/completed records. Import these as canonical collaboration calls, replacing matching raw calls; preserve thread identity, agent path and chronology. Reconciliation retains these durable lifecycle facts.
- Preserve collaboration namespaces and resolve relative target names against recorded agent paths. Parent milestones use the same avatars as the agent panel.
- Hidden reasoning packets no longer split consecutive action summaries. Visible reasoning and commentary remain chronological boundaries. Summary icon precedence: skill, edit, read, search, command, web.
- Outputs excludes modification tools and source/configuration files; change cards collect their evidence independently. Activity row spacing reduced.
- Recorded stream_error/reconnecting/retrying events render with a network icon. The actual saved root rollout has no reconnect events corresponding to the supplied screenshots, so those historical network rows cannot be reconstructed from this source; no inferred network events are inserted.
- Local proof: 25 focused runtime tests passed, app/server typechecks passed; Electron imported-session proof passed with grouped named starts, completion, stable avatars, recorded reconnect marker and retained change card/hover preview.
