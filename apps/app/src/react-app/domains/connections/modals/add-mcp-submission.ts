import type { McpDirectoryInfo } from "@/app/constants";
import { t } from "@/i18n";
import type { McpConnectResult } from "../store";
import { planInstall, type InstallPlan, type InstallScope } from "../install-flow";

/**
 * Translate a plan's first blocking issue into user-facing copy. A candidate that
 * is not an MCP server is rejected here, before any config is written, because
 * writing it as `mcp_servers.<name>` produces an entry that connects, lists zero
 * tools, and looks healthy.
 */
export function installIssueMessage(plan: InstallPlan): string | null {
  const issue = plan.issues[0];
  if (!issue) return null;

  switch (issue) {
    case "name_required":
      return t("mcp.name_required");
    case "mcp_url_required":
    case "mcp_command_required":
      return t("mcp.url_or_command_required");
    case "mcp_command_must_start_with_executable":
      return t("mcp.command_must_start_with_executable");
    case "not_an_mcp_server": {
      const { kind, reference } = plan.classification;
      if (kind === "skill" && reference) return t("mcp.not_a_server_skill", { reference });
      if (kind === "plugin") return t("mcp.not_a_server_plugin");
      return t("mcp.not_a_server_unknown");
    }
    default:
      return t("mcp.connect_failed");
  }
}

export async function submitMcpEntry(
  onAdd: (entry: McpDirectoryInfo, scope: InstallScope) => Promise<McpConnectResult>,
  entry: McpDirectoryInfo,
  fallbackError: string,
  scope: InstallScope = "project",
): Promise<string | null> {
  const issue = installIssueMessage(planInstall(entry, scope));
  if (issue) return issue;

  try {
    const result = await onAdd(entry, scope);
    return result.ok ? null : result.error;
  } catch (error) {
    return error instanceof Error ? error.message : fallbackError;
  }
}
