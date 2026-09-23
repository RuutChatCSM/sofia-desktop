// Codex access mode: the single knob (the composer toggle) that drives BOTH of
// codex's separate config knobs — `sandbox_mode` (can it write) and the approval
// policy (does it ask). Mirrors the ChatGPT input-container "Full access" toggle.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type CodexAccessMode = "ask" | "approve" | "full";

export const CODEX_ACCESS_MODES: CodexAccessMode[] = ["ask", "approve", "full"];

function accessFile(codexHome?: string): string {
  return join(codexHome || process.env.OPENWORK_CODEX_HOME?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), ".sofia"), ".access-mode");
}

/** Read the persisted access mode. Defaults to "ask" (safe). */
export function readCodexAccessMode(codexHome?: string): CodexAccessMode {
  try {
    const raw = readFileSync(accessFile(codexHome), "utf8").trim();
    if (CODEX_ACCESS_MODES.includes(raw as CodexAccessMode)) return raw as CodexAccessMode;
  } catch {
    // absent or invalid → default
  }
  return "ask";
}

/** Persist the access mode so the next codex config generation uses it. */
export function writeCodexAccessMode(mode: CodexAccessMode, codexHome?: string): void {
    const file = accessFile(codexHome);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `${mode}\n`, "utf8");
}

/** Map access mode -> codex `sandbox_mode`. */
export function sandboxModeFor(mode: CodexAccessMode): "workspace-write" | "danger-full-access" | "read-only" {
  if (mode === "full") return "danger-full-access";
  if (mode === "approve" || mode === "ask") return "workspace-write";
  return "read-only";
}

export function codexTurnPermissions(mode: CodexAccessMode) {
  return {
    approvalPolicy: mode === "full" ? "never" : "on-request",
    sandboxPolicy: mode === "full"
      ? { type: "dangerFullAccess" }
      : { type: "workspaceWrite", networkAccess: true },
  };
}

/** Map access mode -> MCP `default_tools_approval_mode`. */
export function mcpApprovalModeFor(mode: CodexAccessMode): "prompt" | "auto" | "approve" {
  if (mode === "full") return "approve";
  if (mode === "approve") return "auto";
  return "prompt";
}
