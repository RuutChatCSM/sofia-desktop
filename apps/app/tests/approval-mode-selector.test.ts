import { describe, expect, test } from "bun:test";

import { approvalModeTriggerClass } from "../src/react-app/domains/session/codex/approval-mode-selector";

describe("composer permission chip", () => {
  test("full access is orange so it never reads like the model picker", () => {
    expect(approvalModeTriggerClass("full")).toContain("text-amber-11");
  });

  test("the other modes stay quiet", () => {
    for (const mode of ["ask", "approve", null] as const) {
      const className = approvalModeTriggerClass(mode);
      expect(className).toContain("text-dls-secondary");
      expect(className).not.toContain("text-amber-11");
    }
  });
});
