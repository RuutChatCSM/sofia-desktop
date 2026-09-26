import { afterEach, describe, expect, test } from "bun:test";

import {
  clearDevLogs,
  formatDevLogLine,
  formatDevLogText,
  readDevLogs,
  recordDevLog,
  subscribeDevLogs,
} from "../src/app/lib/dev-log";

afterEach(() => {
  clearDevLogs();
});

describe("the developer log buffer", () => {
  test("records what was captured, with the source and label", () => {
    recordDevLog(true, { level: "debug", source: "transcript.turn", label: "turn live=false items=3" });

    const [entry] = readDevLogs();
    expect(entry).toMatchObject({ level: "debug", source: "transcript.turn", label: "turn live=false items=3" });
    expect(formatDevLogLine(entry!)).toContain("transcript.turn:turn live=false items=3");
    expect(formatDevLogText()).toContain("turn live=false items=3");
  });

  test("stays silent when it is not enabled", () => {
    // The panel is only meaningful in developer mode; nothing is retained when
    // the caller says the stream is off.
    recordDevLog(false, { level: "debug", source: "transcript.turn", label: "ignored" });
    expect(readDevLogs()).toEqual([]);
  });

  test("reads the most recent records, in order", () => {
    for (let index = 0; index < 5; index += 1) {
      recordDevLog(true, { level: "debug", source: "s", label: `line-${index}` });
    }

    expect(readDevLogs(2).map((entry) => entry.label)).toEqual(["line-3", "line-4"]);
    expect(readDevLogs(0)).toHaveLength(5);
  });

  test("notifies readers on record and on clear, so a panel can stay live", () => {
    // Regression: the Debug page's developer log was a private array nothing
    // wrote to, so it read "no logs captured yet" forever.
    let notifications = 0;
    const unsubscribe = subscribeDevLogs(() => {
      notifications += 1;
    });

    recordDevLog(true, { level: "debug", source: "s", label: "a" });
    expect(notifications).toBe(1);

    clearDevLogs();
    expect(notifications).toBe(2);

    unsubscribe();
    recordDevLog(true, { level: "debug", source: "s", label: "b" });
    expect(notifications).toBe(2);
  });
});
