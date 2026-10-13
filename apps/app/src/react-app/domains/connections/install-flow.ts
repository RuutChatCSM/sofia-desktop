/**
 * Typed install planning for the Connections add flow.
 *
 * A user can paste very different things into "Add MCP server": a remote URL, a
 * local MCP command, a skill package (`npx skills add owner/repo`), or a plugin
 * bundle. Only the first two are MCP servers, but every one of them was being
 * written to config as `mcp_servers.<name>` — which is how a skill installer
 * ended up registered as an MCP server that exposes zero tools.
 *
 * This module classifies the candidate before anything is written, and maps the
 * scope to the config layer the engine actually reads: `global` is the user
 * config under `~/.sofia`, `project` is the trusted-repository layer under
 * `<repo>/.sofia`.
 */

export type InstallKind = "mcp-remote" | "mcp-local" | "skill" | "plugin" | "unknown";

export type InstallScope = "global" | "project";

export type InstallCandidate = {
  name: string;
  type?: "remote" | "local";
  url?: string;
  command?: string[];
};

export type InstallClassification = {
  kind: InstallKind;
  /** The package, repository, or manifest we recognized, when we can name it. */
  reference: string | null;
  /** Whether this belongs on the MCP connect path at all. */
  mcp: boolean;
  /** Why it was classified this way. Developer-facing; used for diagnostics. */
  reason: string;
};

export type InstallTargets = {
  scope: InstallScope;
  /** Config file that records the entry for this scope. */
  configPath: string;
  /** Directory skills materialize into for this scope. */
  skillsDir: string;
  /** Directory plugin bundles materialize into for this scope. */
  pluginsDir: string;
};

export type InstallIssue =
  | "name_required"
  | "mcp_url_required"
  | "mcp_command_required"
  | "mcp_command_must_start_with_executable"
  | "not_an_mcp_server";

export type InstallPlan = {
  classification: InstallClassification;
  scope: InstallScope;
  targets: InstallTargets;
  issues: InstallIssue[];
  warnings: string[];
};

const RUNNERS = new Set(["npx", "bunx", "pnpm", "yarn", "npm", "bun", "dlx", "exec", "skills"]);

const SKILL_SUBCOMMANDS = new Set(["add", "a", "use"]);

const PLUGIN_MANIFEST_HINTS = [
  ".sofia-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
];

/**
 * Local MCP servers are still only proven by a handshake. A command that starts
 * and exits (an installer, a one-shot CLI) will register cleanly and expose no
 * tools, so the plan says so instead of implying the entry works.
 */
export const LOCAL_MCP_UNVERIFIED_WARNING =
  "Sofia cannot confirm this command speaks MCP until it connects. A command that starts and exits, such as a package installer, will expose no tools.";

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function commandBasename(token: string): string {
  const segments = token.split(/[\\/]/);
  return segments[segments.length - 1] || token;
}

/** `skills@latest` -> `skills`, `@scope/pkg@1` -> `@scope/pkg`, `@scope/pkg` -> `@scope/pkg`. */
function packageSpecName(token: string): string {
  const at = token.lastIndexOf("@");
  return at > 0 ? token.slice(0, at) : token;
}

function stripEnvAssignments(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index])) index += 1;
  return tokens.slice(index);
}

function skipFlags(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length && tokens[index].startsWith("-")) index += 1;
  return tokens.slice(index);
}

/**
 * Recognize the `skills` CLI in any of its invocation shapes:
 * `skills add x`, `npx skills add x`, `npx -y skills@latest add x`,
 * `pnpm dlx skills add x`, `npm exec -- skills add x`.
 */
function detectSkillPackage(tokens: string[]): { reference: string | null } | null {
  const args = stripEnvAssignments(tokens);
  const head = args[0];
  if (!head) return null;

  const runner = packageSpecName(commandBasename(head));
  if (!RUNNERS.has(runner)) return null;

  let command = args.slice(1);

  if (runner === "pnpm" || runner === "yarn" || runner === "npm" || runner === "bun") {
    const verb = skipFlags(command)[0];
    if (verb !== "dlx" && verb !== "exec") return null;
    const verbIndex = command.findIndex((token) => token === verb);
    command = command.slice(verbIndex + 1);
  }

  command = skipFlags(command);

  if (runner !== "skills") {
    const pkg = command[0];
    if (!pkg || packageSpecName(commandBasename(pkg)) !== "skills") return null;
    command = skipFlags(command.slice(1));
  }

  const subcommand = command[0];
  if (!subcommand || !SKILL_SUBCOMMANDS.has(subcommand)) return null;

  const reference = command.slice(1).find((token) => !token.startsWith("-")) ?? null;
  return { reference };
}

export function classifyInstallCandidate(candidate: InstallCandidate): InstallClassification {
  const tokens = (candidate.command ?? []).map((token) => token.trim()).filter(Boolean);
  const url = candidate.url?.trim() ?? "";
  const haystack = [candidate.name, url, ...tokens].join(" ").toLowerCase();

  const manifestHint = PLUGIN_MANIFEST_HINTS.find((hint) => haystack.includes(hint));
  if (manifestHint) {
    return {
      kind: "plugin",
      reference: manifestHint,
      mcp: false,
      reason: `References a plugin manifest (${manifestHint}).`,
    };
  }

  const skill = detectSkillPackage(tokens);
  if (skill) {
    return {
      kind: "skill",
      reference: skill.reference,
      mcp: false,
      reason: "Runs the skills CLI, which installs skill packages instead of starting an MCP server.",
    };
  }

  if (candidate.type === "remote" || (url.length > 0 && tokens.length === 0)) {
    return { kind: "mcp-remote", reference: url || null, mcp: true, reason: "Remote MCP endpoint." };
  }

  if (candidate.type === "local" || tokens.length > 0) {
    return { kind: "mcp-local", reference: tokens[0] ?? null, mcp: true, reason: "Local MCP server command." };
  }

  return { kind: "unknown", reference: null, mcp: false, reason: "No URL or command was provided." };
}

export function installTargets(scope: InstallScope): InstallTargets {
  const root = scope === "global" ? "~/.sofia" : ".sofia";
  return {
    scope,
    configPath: `${root}/config.toml`,
    skillsDir: `${root}/skills`,
    pluginsDir: `${root}/plugins`,
  };
}

export function planInstall(candidate: InstallCandidate, scope: InstallScope = "global"): InstallPlan {
  const classification = classifyInstallCandidate(candidate);
  const targets = installTargets(scope);
  const issues: InstallIssue[] = [];
  const warnings: string[] = [];

  if (!candidate.name.trim()) issues.push("name_required");

  switch (classification.kind) {
    case "mcp-remote":
      if (!candidate.url?.trim()) issues.push("mcp_url_required");
      break;
    case "mcp-local": {
      const command = (candidate.command ?? []).filter((token) => token.trim().length > 0);
      if (command.length === 0) issues.push("mcp_command_required");
      else if (command[0].startsWith("-")) issues.push("mcp_command_must_start_with_executable");
      warnings.push(LOCAL_MCP_UNVERIFIED_WARNING);
      break;
    }
    default:
      issues.push("not_an_mcp_server");
  }

  return { classification, scope, targets, issues, warnings };
}

/** True when the candidate can be written through the MCP connect path. */
export function isMcpInstall(plan: InstallPlan): boolean {
  return plan.classification.mcp && !plan.issues.includes("not_an_mcp_server");
}
