import { describe, expect, test } from "bun:test";

import { resolveSubmitAction } from "../src/react-app/domains/session/surface/composer/submit-action";

// Guards the interaction contract that regressed once: while the agent is
// busy, a plain submit must QUEUE (so a compact pending row appears above the
// composer, with an explicit Steer action), and only the Cmd/Ctrl modifier
// steers the active turn. Neither busy case may "send" (which would make the
// message disappear without a pending row).
describe("resolveSubmitAction", () => {
  test("idle submits send (regardless of modifier)", () => {
    expect(resolveSubmitAction({ busy: false, modifier: false })).toBe("send");
    expect(resolveSubmitAction({ busy: false, modifier: true })).toBe("send");
  });

  test("busy + plain submit queues, never steers or sends", () => {
    const action = resolveSubmitAction({ busy: true, modifier: false });
    expect(action).toBe("queue");
    expect(action).not.toBe("steer");
    expect(action).not.toBe("send");
  });

  test("busy + modifier steers", () => {
    expect(resolveSubmitAction({ busy: true, modifier: true })).toBe("steer");
  });
});
