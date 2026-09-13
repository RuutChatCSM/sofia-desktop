import type { ApprovalConfig, ApprovalRequest } from "./types.js";
import { shortId } from "./utils.js";

interface ApprovalResult {
  id: string;
  allowed: boolean;
  reason?: string;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (result: ApprovalResult) => void;
  timeout?: NodeJS.Timeout;
}

export class ApprovalService {
  private config: ApprovalConfig;
  private pending = new Map<string, PendingApproval>();

  constructor(config: ApprovalConfig) {
    this.config = config;
  }

  getMode(): string {
    return this.config.mode;
  }

  setMode(mode: ApprovalConfig["mode"]): void {
    this.config = { ...this.config, mode };
  }

  list(): ApprovalRequest[] {
    return Array.from(this.pending.values()).map((entry) => entry.request);
  }

  async requestApproval(
    input: Omit<ApprovalRequest, "id" | "createdAt">,
  ): Promise<ApprovalResult> {
    // ChatGPT-style permission modes: "ask" always prompts, "full" (Full access)
    // never prompts, and "auto"/"manual" keep the legacy semantics. "approve"
    // (Approve for me) should only prompt for unsafe actions; without a safety
    // classifier it conservatively prompts, so a denial never slips through.
    const neverPrompts = this.config.mode === "auto" || this.config.mode === "full";
    if (neverPrompts) {
      return { id: "auto", allowed: true };
    }
    const id = shortId();
    const request: ApprovalRequest = {
      ...input,
      id,
      createdAt: Date.now(),
    };

    const result = await new Promise<ApprovalResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, allowed: false, reason: "timeout" });
      }, this.config.timeoutMs);

      this.pending.set(id, { request, resolve, timeout });
    });

    return result;
  }

  respond(id: string, reply: "allow" | "deny"): ApprovalResult | null {
    const pending = this.pending.get(id);
    if (!pending) return null;
    if (pending.timeout) clearTimeout(pending.timeout);
    this.pending.delete(id);
    const result: ApprovalResult = {
      id,
      allowed: reply === "allow",
      reason: reply === "allow" ? undefined : "denied",
    };
    pending.resolve(result);
    return result;
  }
}
