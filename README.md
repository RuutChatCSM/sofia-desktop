# Sofia

Sofia is a free, open-source desktop app made for sharing AI workflows. It is an open-source alternative to Claude Cowork and Codex for macOS, Windows, and Linux.

Add one Sofia MCP to Codex, Claude Code, Cursor, or another compatible agent and reuse the same skills, MCPs, and connected services across your tools, teammates, and machines. Create something once, share it with coworkers or friends, or keep it for yourself.

The desktop app is there when you want a dedicated workspace, but it is not required. You can use Sofia from the agent you already have. For larger organizations, the admin interface lets you publish capabilities, manage access, and configure shared or per-user connections.

[**Download Sofia**](https://sofia.ruut.chat/download)

<img width="1481" height="842" alt="Sofia desktop app" src="https://github.com/user-attachments/assets/66a8dd9b-5260-488c-957d-e54331e78c1c" />

## Install with your AI agent

Already use an AI agent? Copy this prompt and paste it into Claude Code, Cursor, Codex, ChatGPT, or any agent that can run commands on your computer.

```text
Install Sofia on my computer, set up my first workspace, and open it ready to use. Follow the steps in https://sofia.ruut.chat/start.md?v=hero
```

1. Installs Sofia
2. Creates your workspace
3. Opens it ready to run

## Use Sofia from any agent

The Sofia MCP brings your assigned skills, plugins, MCP connections, Google Workspace, and Microsoft 365 capabilities into any compatible agent.

It exposes two tools: `search_capabilities` finds what you can use, and `execute_capability` runs it. After adding the MCP, your client opens a browser so you can sign in and choose your Sofia organization.

### Codex

```bash
codex mcp add sofia --url https://sofia-api.ruut.chat/mcp/agent
```

### Claude Code

```bash
claude mcp add --transport http sofia https://sofia-api.ruut.chat/mcp/agent
```

### OpenCode

Add this to `opencode.json`:

```json
{
  "mcp": {
    "sofia": {
      "type": "remote",
      "enabled": true,
      "url": "https://sofia-api.ruut.chat/mcp/agent",
      "oauth": {}
    }
  }
}
```

### Any MCP client

Use this remote MCP server URL:

```text
https://sofia-api.ruut.chat/mcp/agent
```

## Sofia Den

Sofia Den is the control plane for managing Sofia across a team or organization.

- Provision inference at scale and control which members and teams can use each model provider.
- Invite teammates, create teams, and manage access from one place.
- Set desktop policies, restrict local model access, and control which app versions your organization can use.
- Publish skills and plugins through marketplaces, then assign them to the organization, a team, or specific people.
- Import Anthropic-compatible plugins and make their supported skills and remote MCPs available through the Sofia MCP.

<img width="1546" height="915" alt="Sofia Den organization control plane" src="https://github.com/user-attachments/assets/033dbbfe-5661-4f7c-869c-46278406d6cc" />

## Documentation

[Read the Sofia docs.](https://sofia.ruut.chat/docs)

## Local development

For one checkout, keep using `pnpm dev`; with no extra environment variables it reuses the existing shared dev profile.

To run multiple git worktrees at once, use:

```bash
pnpm dev:worktree
```

That sets `SOFIA_DEV_PROFILE=auto`, derives a stable profile name from the worktree path, lets Electron choose a free CDP port, and asks Vite for a free dev-server port. You can also choose a named profile, for example `SOFIA_DEV_PROFILE=my-feature SOFIA_ELECTRON_REMOTE_DEBUG_PORT=0 PORT=0 pnpm dev`.

Dev mode opts into `use-mock-keychain` by default (override with `SOFIA_ELECTRON_USE_MOCK_KEYCHAIN=0`). A brand-new profile has no stored credentials, so on macOS the real keychain prompts as soon as Chromium persists an authenticated cookie, and that modal blocks Electron's main loop until it is dismissed. Set `SOFIA_ELECTRON_USE_MOCK_KEYCHAIN=0` if you specifically want the system keychain in an isolated profile.

Dev startup prints a banner like `[sofia] dev profile=... cdp=http://127.0.0.1:9223`; use it to find the profile directory and pass the CDP URL to local tooling.

If a second instance cannot get the profile lock it now says so and exits, instead of lingering with an open CDP port and no window.

### Headless web (no Electron)

To run the Sofia UI in a browser against a local `sofia-server` (no desktop shell):

```bash
pnpm dev:headless-web
```

This is an isolated launcher:

- Writes `tmp/headless-server.json` and never reads `~/.config/sofia/server.json`
- Authorizes the chosen workspace root automatically, and merges (never rewrites) that config on relaunch, so workspaces you add through the UI survive `--replace`
- Starts Vite + `sofia-server` with a stable owner bearer forced into the UI. Crash-restarts reuse that bearer so open tabs keep working; `--replace` mints fresh tokens (pass `--keep-tokens` to preserve them). The privileged host token stays on the server process and is never inlined into the Vite bundle.
- Proxies Den Cloud calls same-origin: Vite serves `/api/den` (forwarded to the Den control plane) and the app pins its Den API there via `VITE_DEN_API_BASE_URL`, so Cloud calls are never CORS-blocked and stale `localStorage` base URLs are cleared on load
- Publishes agent-facing URLs/tokens at `tmp/dev-headless-web.json` (owner-only, `0600`), and allows browser calls to the local server only from the web app's own origins — not every site you visit
- Uses stable ports by default (web `5178`, server `8778`; falls back to free ports when taken, override with `SOFIA_WEB_PORT` / `SOFIA_PORT`)
- Is single-instance per worktree: re-running it reuses a healthy instance and prints its URL; stale instances are cleaned up automatically; `--replace` forces a restart
- Detaches the servers from the launching terminal, so they survive the terminal closing
- Supports `--detach` to run the whole stack independent of the invoking shell (recommended for agents): it starts detached, waits for health, prints the URLs, and exits

Open the printed Web URL. Cloud sign-in in headless web uses the **copy/paste** handoff (hosted Den cannot redirect session grants back to `http://127.0.0.1`):

1. Account → Sign in (opens Den; the paste field opens in Settings)
2. Sign in on Den
3. Copy the Sofia link / one-time code Den shows
4. Paste it under **Paste sign-in code** → Finish sign-in

Point Den at a local stack with `SOFIA_DEV_DEN_PROXY_TARGET=http://127.0.0.1:3005` while `pnpm dev:web-local` is running. Set `SOFIA_DEV_HEADLESS_WEB_DEN_PROXY=0` to disable the Den wiring.
