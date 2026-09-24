import { readFileSync } from "node:fs";

export function resolveSofiaRelease(metadata = {}) {
  const repository = metadata.repository;
  if (!repository) return { repository: null, stable: "", alpha: "", page: "" };
  if (typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repository)
    || /^(RuutChatCSM\/sofia|openai\/codex)$/i.test(repository)) {
    throw new Error("Configure a Sofia-owned owner/repository before enabling releases.");
  }
  const base = `https://github.com/${repository}/releases`;
  return { repository, stable: `${base}/latest/download`, alpha: `${base}/download/alpha-macos-latest`, page: `${base}/latest` };
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const SOFIA_RELEASE = resolveSofiaRelease(pkg.sofiaRelease);
