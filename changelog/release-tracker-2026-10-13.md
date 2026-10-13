# Release Changelog Tracker

## v0.1.9

#### Commit
`ee5a05c24`

#### Released at
`2026-10-13T00:00:00Z` (release preparation; publication pending)

#### Title
Engine questions, provider compatibility, and session recovery

#### Main changes
- Connect the existing question panel to engine requests and replies, retaining request and question IDs and routing questions to their session.
- Replay pending questions on reconnect, clear engine-resolved questions, mask secret answers, and keep nonblocking questions from pausing task status.
- Hide internal goal-judge context from the visible transcript.
- Bundle the updated engine with native Anthropic Messages support and prompt-cache usage accounting.
- Correct false cyber warnings for non-GPT model aliases and serialize historical custom-tool arguments as JSON strings when switching to Chat Completions providers.
- Accept Chat Completions input wrappers in apply_patch, including approval-hook input extraction.

#### Major improvements
True

#### Number of major improvements
2

#### Major bugs resolved
True

#### Number of major bugs resolved
4
