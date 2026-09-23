// Owned here: reload vocabulary is part of the extension manifest contract.
// types.ts re-exports it for the rest of the app.
export type ReloadReason = "plugins" | "skills" | "mcp" | "config" | "agents" | "commands";

export type SofiaExtensionSourceFormat =
  | "sofia-builtin"
  | "sofia-extension-manifest"
  | "claude-plugin"
  | "opencode-plugin"
  | "mcp-directory"
  | "manual";

export type SofiaExtensionSource = {
  format: SofiaExtensionSourceFormat;
  trusted: boolean;
  origin?: "builtin" | "den" | "workspace" | "local";
  reference?: string;
};

export type SofiaExtensionResourceType =
  | "skill"
  | "agent"
  | "command"
  | "tool"
  | "mcp"
  | "opencode-plugin"
  | "provider"
  | "hook"
  | "context"
  | "secret"
  | "file"
  | "local-service"
  | "native-binary";

export type SofiaExtensionResource = {
  type: SofiaExtensionResourceType;
  id: string;
  label?: string;
  description?: string;
  path?: string;
  command?: string[];
  envKey?: string;
  packageName?: string;
  providerId?: string;
  mcpServerName?: string;
  localCommandRef?: "sofia.computerUseMcp" | "sofia.uiMcp";
  required?: boolean;
};

export type SofiaExtensionContributionType =
  | "settings-panel"
  | "setup-instructions"
  | "composer-prompt"
  | "session-side-panel"
  | "session-rail-item"
  | "control-actions"
  | "server-route"
  | "native-capability"
  | "test-action";

export type SofiaExtensionContribution = {
  type: SofiaExtensionContributionType;
  ref?: string;
  label?: string;
  description?: string;
  prompt?: string;
  location?: "settings-detail" | "composer" | "session-right-pane" | "session-rail" | "server" | "native";
};

export type SofiaExtensionSetup = {
  instructions?: string;
  primaryCta?: string;
  secondaryCta?: string;
  requiredEnv?: string[];
  testActionRef?: string;
};

export type SofiaExtensionLifecycle = {
  reload?: ReloadReason[];
  detection?: string[];
};

// ---------------------------------------------------------------------------
// Enablement — declarative conditions for extension "active" state
// ---------------------------------------------------------------------------

export type EnablementConditionType =
  | "mcp-connected"
  | "plugin-loaded"
  | "provider-connected"
  | "env-set"
  | "permission-granted"
  | "toggle-enabled";

export type EnablementCondition = {
  type: EnablementConditionType;
  /** What to check — MCP server name, plugin id, env key, etc. */
  ref: string;
  /** Human-readable label shown in the UI. */
  label: string;
};

/** Result of evaluating a single enablement condition at runtime. */
export type EnablementResult = {
  condition: EnablementCondition;
  met: boolean;
};

export type SofiaExtensionManifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  preview?: boolean;
  source: SofiaExtensionSource;
  icon?: {
    src?: string;
    simpleIconSlug?: string;
  };
  composer?: {
    prompt: string;
  };
  setup?: SofiaExtensionSetup;
  resources: SofiaExtensionResource[];
  contributions?: SofiaExtensionContribution[];
  lifecycle?: SofiaExtensionLifecycle;
  /** Declarative conditions that must ALL be true for the extension to be "active". */
  enablement?: EnablementCondition[];
  defaultEnabled?: boolean;
  defaultHidden?: boolean;
  platform?: Array<"darwin" | "linux" | "windows" | "web">;
};

export type SofiaExtensionPlatform = NonNullable<SofiaExtensionManifest["platform"]>[number];

export function extensionContribution(
  manifest: SofiaExtensionManifest | undefined,
  type: SofiaExtensionContributionType,
): SofiaExtensionContribution | undefined {
  return manifest?.contributions?.find((contribution) => contribution.type === type);
}

export function extensionResource(
  manifest: SofiaExtensionManifest | undefined,
  type: SofiaExtensionResourceType,
): SofiaExtensionResource | undefined {
  return manifest?.resources.find((resource) => resource.type === type);
}

export function isTrustedBuiltInExtension(manifest: SofiaExtensionManifest | undefined): boolean {
  return manifest?.source.origin === "builtin" && manifest.source.trusted;
}

export const BUILT_IN_SOFIA_EXTENSION_MANIFESTS: SofiaExtensionManifest[] = [
  {
    schemaVersion: 1,
    id: "sofia-browser",
    name: "Sofia App Browser",
    description: "Automate the built-in browser panel that stays visible inside Sofia App.",
    source: { format: "sofia-builtin", origin: "builtin", trusted: true },
    icon: { src: "/sofia-mark.svg" },
    composer: { prompt: "Use the Sofia App Browser extension to " },
    setup: {
      instructions: "Sofia App Browser is ready by default in desktop workspaces.",
    },
    resources: [
      {
        type: "mcp",
        id: "chrome-devtools",
        packageName: "chrome-devtools",
        required: true,
      },
    ],
    contributions: [
      { type: "settings-panel", ref: "sofia.browser.settings", location: "settings-detail" },
      { type: "session-side-panel", ref: "sofia.browser.panel", location: "session-right-pane" },
      { type: "composer-prompt", prompt: "Use the Sofia App Browser extension to ", location: "composer" },
    ],
    enablement: [
      { type: "toggle-enabled", ref: "sofia-browser", label: "Enabled" },
    ],
    lifecycle: { reload: ["plugins", "agents"], detection: ["mcp:chrome-devtools"] },
    defaultEnabled: true,
    platform: ["darwin", "linux", "windows"],
  },
  {
    schemaVersion: 1,
    id: "computer-use",
    name: "Computer Use",
    description: "Mac only: control Mac apps through semantic accessibility refs, screenshots, background-safe clicks, keyboard input, and strict mode.",
    preview: true,
    source: { format: "sofia-builtin", origin: "builtin", trusted: true },
    icon: { src: "/sofia-mark.svg" },
    composer: { prompt: "Use Computer Use to " },
    setup: {
      instructions: "Computer Use is Mac only. It runs as a local MCP server backed by the macOS accessibility runtime. Grant Accessibility and Screen Recording permissions when macOS asks, then connect the MCP server in this workspace.",
      primaryCta: "Connect Computer Use MCP",
      secondaryCta: "Check macOS permissions",
      testActionRef: "sofia.computerUse.healthCheck",
    },
    resources: [
      {
        type: "mcp",
        id: "computer-use-mcp",
        label: "Computer Use MCP",
        mcpServerName: "computer-use",
        command: ["npx", "-y", "@sofia/handsfree", "mcp"],
        localCommandRef: "sofia.computerUseMcp",
        required: true,
      },
      {
        type: "native-binary",
        id: "computer-use-native",
        label: "macOS accessibility runtime",
        packageName: "@sofia/handsfree",
        required: true,
      },
    ],
    contributions: [
      { type: "setup-instructions", ref: "sofia.computerUse.setup", location: "settings-detail" },
      { type: "native-capability", ref: "sofia.computerUse.axPermissions", label: "Accessibility and Screen Recording" },
      { type: "test-action", ref: "sofia.computerUse.healthCheck", label: "Verify Computer Use MCP" },
      { type: "composer-prompt", prompt: "Use Computer Use to ", location: "composer" },
    ],
    enablement: [
      { type: "mcp-connected", ref: "computer-use", label: "MCP server connected" },
      { type: "permission-granted", ref: "accessibility", label: "Accessibility permission" },
      { type: "permission-granted", ref: "screenRecording", label: "Screen Recording permission" },
    ],
    lifecycle: { reload: ["mcp"], detection: ["mcp:computer-use"] },
    platform: ["darwin"],
  },
  {
    schemaVersion: 1,
    id: "sofia-voice",
    name: "Voice Mode",
    description: "Talk to Sofia App through a Realtime voice panel that drives the same semantic UI controls as Sofia App UI MCP.",
    preview: true,
    source: { format: "sofia-builtin", origin: "builtin", trusted: true },
    icon: { src: "/sofia-mark.svg" },
    composer: { prompt: "Use Voice Mode to " },
    setup: {
      instructions: "Voice Mode uses OpenAI Realtime. Save an OpenAI API key in Sofia App env vars, then open the session rail panel and speak or send a typed voice command.",
      primaryCta: "Save OpenAI key",
      secondaryCta: "Test Realtime",
      requiredEnv: ["OPENAI_REALTIME_API_KEY", "OPENAI_API_KEY"],
      testActionRef: "sofia.voice.testRealtime",
    },
    resources: [
      { type: "secret", id: "openai-realtime-api-key", envKey: "OPENAI_REALTIME_API_KEY", required: false },
      { type: "secret", id: "openai-api-key", envKey: "OPENAI_API_KEY", required: true },
      { type: "local-service", id: "sofia-voice-realtime-session", label: "Realtime client-secret minting", required: true },
    ],
    contributions: [
      { type: "settings-panel", ref: "sofia.voice.settings", location: "settings-detail" },
      { type: "session-side-panel", ref: "sofia.voice.panel", location: "session-right-pane" },
      { type: "session-rail-item", ref: "sofia.voice.rail", label: "Voice Mode", location: "session-rail" },
      { type: "server-route", ref: "POST /voice/realtime/session", location: "server" },
      { type: "control-actions", ref: "sofia.voice.controlActions" },
      { type: "test-action", ref: "sofia.voice.testRealtime", label: "Test Realtime" },
      { type: "composer-prompt", prompt: "Use Voice Mode to ", location: "composer" },
    ],
    enablement: [
      { type: "toggle-enabled", ref: "sofia-voice", label: "Enabled" },
      { type: "env-set", ref: "OPENAI_API_KEY", label: "OpenAI API key" },
    ],
    lifecycle: { reload: ["config"], detection: ["env:OPENAI_REALTIME_API_KEY", "env:OPENAI_API_KEY"] },
  },
  {
    schemaVersion: 1,
    id: "ollama",
    name: "Ollama",
    description: "Local model provider at http://localhost:11434.",
    source: { format: "sofia-builtin", origin: "builtin", trusted: true },
    icon: { src: "/ext-ollama.svg" },
    composer: { prompt: "Use the Ollama extension to " },
    setup: {
      instructions: "Run Ollama locally, choose or pull a model, then add it as a Sofia provider.",
      primaryCta: "Add Ollama model",
      secondaryCta: "Pull model",
    },
    resources: [
      { type: "local-service", id: "ollama-api", label: "Ollama API", description: "http://localhost:11434", required: true },
      { type: "provider", id: "ollama", providerId: "ollama", packageName: "@ai-sdk/openai-compatible", required: true },
    ],
    contributions: [
      { type: "settings-panel", ref: "sofia.ollama.settings", location: "settings-detail" },
      { type: "test-action", ref: "sofia.ollama.listModels", label: "Check local models" },
      { type: "composer-prompt", prompt: "Use the Ollama extension to ", location: "composer" },
    ],
    enablement: [
      { type: "provider-connected", ref: "ollama", label: "Ollama provider" },
    ],
    lifecycle: { reload: ["config"], detection: ["provider:ollama"] },
  },
];
