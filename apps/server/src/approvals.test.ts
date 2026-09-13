import { describe, expect, test } from "bun:test";

import { ApprovalService } from "./approvals.js";

function input() {
  return { workspaceId: "ws_1", action: "codex.approval", summary: "Open browser", paths: [], actor: { kind: "agent", name: "codex" } as never };
}

describe("ApprovalService modes", () => {
  test("auto and full never prompt", async () => {
    for (const mode of ["auto", "full"] as const) {
      const svc = new ApprovalService({ mode, timeoutMs: 1000 });
      const r = await svc.requestApproval(input());
      expect(r.allowed).toBe(true);
      expect(svc.list()).toHaveLength(0);
    }
  });

  test("manual, ask, and approve prompt and can be denied", async () => {
    for (const mode of ["manual", "ask", "approve"] as const) {
      const svc = new ApprovalService({ mode, timeoutMs: 5000 });
      const prom = svc.requestApproval(input());
      expect(svc.list()).toHaveLength(1);
      const result = svc.respond(svc.list()[0].id, "deny");
      expect(await prom).toEqual({ id: result!.id, allowed: false, reason: "denied" });
    }
  });

  test("respond allow resolves true", async () => {
    const svc = new ApprovalService({ mode: "ask", timeoutMs: 5000 });
    const prom = svc.requestApproval(input());
    const id = svc.list()[0].id;
    expect(svc.respond(id, "allow")).not.toBeNull();
    expect(await prom).toEqual({ id, allowed: true, reason: undefined });
  });

  test("mode get/set round-trips", () => {
    const svc = new ApprovalService({ mode: "ask", timeoutMs: 1000 });
    expect(svc.getMode()).toBe("ask");
    svc.setMode("full");
    expect(svc.getMode()).toBe("full");
  });
});
