import { listCommands } from "./commands.js";
import type { CommandItem } from "./types.js";

export const SOFIA_COMMANDS: CommandItem[] = [
  { name: "plan", description: "Explore an approach before making changes", template: "Create a plan for the following request. Inspect relevant context, explain the approach and decisions, and do not implement changes yet.\n\n$ARGUMENTS", scope: "workspace" },
  { name: "review", description: "Review changes for bugs and missing coverage", template: "Review the current changes for correctness, regressions, and missing tests. Report actionable findings with file references.\n\n$ARGUMENTS", scope: "workspace" },
  { name: "explain", description: "Understand a file, feature, or decision", template: "Explain the following using the project files as evidence. Be clear and concrete.\n\n$ARGUMENTS", scope: "workspace" },
];

export async function listSofiaCommands(workspaceRoot: string): Promise<CommandItem[]> {
  const [global, local] = await Promise.all([listCommands(workspaceRoot, "global"), listCommands(workspaceRoot, "workspace")]);
  return [...new Map([...SOFIA_COMMANDS, ...global, ...local].map((command) => [command.name, command])).values()];
}

/** Expand a command as text. Templates are never evaluated as shell code. */
export async function resolveSofiaPrompt(workspaceRoot: string, text: string): Promise<string> {
  const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return text;
  const command = (await listSofiaCommands(workspaceRoot)).find((entry) => entry.name === match[1]);
  if (!command) return text;
  const args = match[2] ?? "";
  const words = args.split(/\s+/);
  const expanded = command.template.replace(/\$ARGUMENTS|\$(\d+)/g, (token, index: string | undefined) =>
    token === "$ARGUMENTS" ? args : words[Number(index) - 1] ?? "");
  return /\$ARGUMENTS|\$\d+/.test(command.template) || !args ? expanded : `${expanded}\n\n${args}`;
}
