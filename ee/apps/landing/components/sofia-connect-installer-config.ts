export const MCP_SERVER_URL = "https://sofia-api.ruut.chat/mcp/agent";
export const CODEX_CONNECTIONS_DEEPLINK = "codex://settings/connections";
export const CHATGPT_SETTINGS_URL = "https://chatgpt.com/#settings/Connectors";
export type SofiaConnectClientId =
  | "cursor"
  | "codex"
  | "chatgpt-desktop"
  | "claude-code"
  | "engine"
  | "vs-code"
  | "any-client";
export type SofiaConnectSupportStatus = "Verified" | "Setup only";
export type SofiaConnectClientSupport = {
  status: SofiaConnectSupportStatus;
  explanation: string;
};

export const CURSOR_SNIPPET = `${MCP_SERVER_URL}`;

export const CLAUDE_CODE_COMMAND = `claude mcp add --transport http sofia ${MCP_SERVER_URL}`;
export const CODEX_COMMAND = `codex mcp add sofia --url ${MCP_SERVER_URL}`;
export const CODEX_LOGIN_COMMAND = `codex mcp login sofia`;
export const CODEX_RECONNECT_COMMAND = `codex mcp logout sofia
codex mcp login sofia`;

export const SOFIA_ENGINE_SNIPPET = `{
  "mcp": {
    "sofia": {
      "type": "remote",
      "enabled": true,
      "url": "${MCP_SERVER_URL}",
      "oauth": {}
    }
  }
}`;

export const VS_CODE_COMMAND = `code --add-mcp '{"name":"sofia","type":"http","url":"${MCP_SERVER_URL}"}'`;
export const ANY_CLIENT_COMMAND = `${MCP_SERVER_URL}`;
export const SOFIA_ENGINE_AUTH_COMMAND = `engine mcp auth sofia`;
export const SOFIA_ENGINE_RECONNECT_COMMAND = `engine mcp logout sofia
engine mcp auth sofia`;

export const CONNECT_CLIENT_SUPPORT: Record<SofiaConnectClientId, SofiaConnectClientSupport> = {
  "cursor": {
    status: "Setup only",
    explanation: "Setup guide only: paste the server URL into Cursor and start OAuth. Cursor Desktop's cursor://anysphere.cursor-mcp/oauth/callback callback is accepted through an exact allowlist with PKCE S256 enforced. Native proof is not complete."
  },
  "codex": {
    status: "Setup only",
    explanation: "Setup guide only: add Sofia, run codex mcp login sofia, and reconnect with logout then login. Native proof must be rerun on this exact branch."
  },
  "chatgpt-desktop": {
    status: "Setup only",
    explanation: "Setup guide only: paste the URL in ChatGPT Settings > MCP servers and start OAuth there. Native proof is not complete."
  },
  "claude-code": {
    status: "Setup only",
    explanation: "Setup guide only: add the server, then use /mcp in Claude Code to run the client auth flow. Native proof is not complete."
  },
  "engine": {
    status: "Verified",
    explanation: "Verified with Sofia native remote MCP OAuth flow."
  },
  "vs-code": {
    status: "Setup only",
    explanation: "Setup guide only: add the server with the VS Code CLI, then start OAuth from VS Code's MCP server prompt. Native proof is not complete."
  },
  "any-client": {
    status: "Setup only",
    explanation: "Setup guide only: use clients that support remote Streamable HTTP MCP servers and OAuth. Native proof depends on the client."
  }
};

export const CONNECT_CLIENTS: SofiaConnectClientId[] = [
  "cursor",
  "codex",
  "chatgpt-desktop",
  "claude-code",
  "engine",
  "vs-code",
  "any-client"
];
