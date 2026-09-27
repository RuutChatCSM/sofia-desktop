import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readTurnDeltaForRoot, snapshotWorkspaceTrees, type RepositoryBaseline, type RepositoryTurnDelta } from "./git-changes.js";

export type TurnChangeRecord = {
  sessionId: string;
  turnId: string;
  startedAt: number;
  finalizedAt: number;
  snapshot: { revision: null; files: []; repositories: RepositoryTurnDelta[] };
  unavailable?: string;
};

type Baseline = { root: string; startedAt: number; repositories: RepositoryBaseline[] };

/** Captured before the engine can write; frozen before the next prompt can start. */
export class TurnChangeTracker {
  private baselines = new Map<string, Baseline>();
  private records = new Map<string, Map<string, TurnChangeRecord>>();

  constructor(private directory: string | null) {}

  async beginTurn(sessionId: string, root: string): Promise<void> {
    const startedAt = Date.now();
    // Do not leave an earlier baseline available if this capture fails.
    this.baselines.delete(sessionId);
    try {
      this.baselines.set(sessionId, { root, startedAt, repositories: await snapshotWorkspaceTrees(root) });
    } catch (error) {
      console.warn("[changes] baseline unavailable", sessionId, error);
    }
  }

  async finalizeTurn(sessionId: string, turnId: string): Promise<TurnChangeRecord> {
    const existing = this.records.get(sessionId)?.get(turnId);
    if (existing) return existing;
    const baseline = this.baselines.get(sessionId);
    this.baselines.delete(sessionId);
    const record: TurnChangeRecord = {
      sessionId, turnId, startedAt: baseline?.startedAt ?? Date.now(), finalizedAt: Date.now(),
      snapshot: { revision: null, files: [], repositories: [] },
    };
    try {
      if (!baseline?.repositories.length) record.unavailable = "No repository baseline was captured.";
      else {
        const delta = await readTurnDeltaForRoot(baseline.root, baseline.repositories, { includeHunks: true, includePatch: true });
        record.snapshot.repositories = delta.repositories;
      }
    } catch (error) {
      record.unavailable = error instanceof Error ? error.message : "Could not read turn changes.";
    }
    const records = this.records.get(sessionId) ?? new Map<string, TurnChangeRecord>();
    records.set(turnId, record);
    this.records.set(sessionId, records);
    if (this.directory) {
      try {
        const directory = join(this.directory, this.key(sessionId));
        await mkdir(directory, { recursive: true });
        const path = join(directory, `${this.key(turnId)}.json`);
        await writeFile(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      } catch (error) {
        console.warn("[changes] could not persist turn changes", sessionId, turnId, error);
      }
    }
    return record;
  }

  async list(sessionId: string): Promise<TurnChangeRecord[]> {
    const records = this.records.get(sessionId) ?? new Map<string, TurnChangeRecord>();
    if (this.directory) {
      const directory = join(this.directory, this.key(sessionId));
      for (const file of await readdir(directory).catch(() => [])) {
        if (!file.endsWith(".json")) continue;
        try {
          const value = JSON.parse(await readFile(join(directory, file), "utf8"));
          if (value.sessionId === sessionId && typeof value.turnId === "string" && Array.isArray(value.snapshot?.repositories)) {
            if (!records.has(value.turnId)) records.set(value.turnId, value);
          }
        } catch { /* A damaged record must not prevent opening the conversation. */ }
      }
    }
    this.records.set(sessionId, records);
    return [...records.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  private key(id: string): string {
    return createHash("sha256").update(id).digest("hex");
  }
}
