# Release Changelog Tracker

## v0.1.9

#### Commit
`ee5a05c24`

#### Released at
`2026-10-13`

#### Title
Sessions, composer, subagents, and provider compatibility

#### Full release notes

Sofia 0.1.9 for macOS Apple Silicon, signed and notarized.

This changelog covers the published `v0.1.8` tag through the desktop build commit `ee5a05c24`, including the bundled engine changes.

## Sessions and transcripts
- Preserve the user request, commentary, tool activity, and final answer in their correct order when a turn completes or history reloads.
- Reconcile live and recorded messages by identity to avoid duplicate user messages and duplicate tool results.
- Recover live history when reopening a session or reconnecting; retain history when a partial snapshot omits messages.
- Improve imported Codex, Claude, and Cursor session presentation, including titles, image attachments, recorded tool names, reasoning summaries, and timing.
- Continue imported Codex sessions through a local Sofia fork with the selected model/provider, preserving the source history.
- Render richer read/edit/command summaries, collaboration milestones, and recorded compaction events.
- Attach one change card to the logical turn's final answer, with recorded paths, counts, and diff previews; copying the answer excludes progress and thinking text.
- Keep source attachments separate from edited files and reduce unrelated files in the Sources panel.

## Composer and sidebar
- Add a searchable project selector above the composer on new-task and empty-session screens, preserving drafts and attachments when switching projects.
- Integrate the project strip with the composer and make Queue/Steer selection clearer, with a persistent follow-up preference and the alternate keyboard shortcut.
- Serialize queued follow-ups, handle fast turn completion, and persist queued drafts and attachment bytes.
- Keep failed or uncertain sends available for explicit retry instead of automatically resending them.
- Handle large pasted text as an attachment without duplicating its contents in the transcript; preserve drafts during IME input.
- Improve HEIC and large-image handling, image cards, attachment upload state, and image delivery to the engine.
- Show accepted new sessions immediately and prevent late sidebar snapshots from removing new sessions or overwriting newer metadata.

## Subagents and questions
- Discover native subagents and display descriptive names, stable avatars, working status, and recorded completion outcomes in the transcript and panel.
- Distinguish completed workers from failed or interrupted workers; refresh active child conversations and render their recorded activity.
- Add scoped delegation guidance with examples for independent investigation and review tasks.
- Connect the existing question panel to engine requests and replies with original request/question IDs and session routing.
- Replay pending questions on reconnect, clear engine-resolved questions, mask secret answers, and keep nonblocking questions from pausing task status.
- Hide internal goal-judge instructions from the visible transcript.

## Skills and memory
- Discover shared skill directories, including Codex skills, with configurable extra roots and Library inventory/detail support.
- Improve Library handoff between connections and display external skills without treating them as editable local installations.
- Add separate local-memory recall and generation controls, independent of Cloud sign-in, and preserve workspace memory configuration.
- Use the selected provider's configured model for local memory jobs; keep local-memory generation opt-in.

## Computer use and browser
- Add computer peek/preview controls, layout preferences, and preview lease handling.
- Improve browser cursor overlays, browser presentation, tab-state recovery, and automation access to browser tab handles.
- Update runtime computer/browser skills, media permissions, and desktop error handling.

## Providers and performance
- Select the native Anthropic Messages wire for Anthropic configurations unless an explicit wire setting overrides it; bundle prompt caching, signed-thinking replay, and cache usage accounting.
- Improve provider model metadata, context limits, catalog merging, and disconnected-provider presentation.
- Correct false cyber fallback warnings for non-GPT model aliases.
- Serialize historical custom-tool arguments as JSON strings for Chat Completions providers and accept their input wrapper in apply_patch, fixing DeepSeek continuation/tool compatibility.
- Bound rollout-history reading, retained transcript size, and hydration concurrency; coalesce overlapping reads to reduce memory pressure from large session histories.
- Improve Cloud MCP URL handling, organization-policy fetch resilience, and MCP connection submission/readiness checks.

## Developer assets
- Add UI/UX review documents and thinking-block design mockups; these are design deliverables, not a claim that every proposed visual change shipped.
- Expand regression and desktop coverage for session recovery, queues, imported history, subagents, skills, memory, browser controls, and bounded history reads.

## Release scope
- This release publishes macOS Apple Silicon DMG/ZIP installers and updater metadata.
- Local memory remains opt-in. Explicit Chat Completions Anthropic configurations are not automatically migrated.
