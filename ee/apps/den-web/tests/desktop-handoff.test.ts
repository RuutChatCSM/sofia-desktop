import { expect, test } from "bun:test";
import {
  getDesktopGrant,
  getDesktopHandoffGrant,
  getDesktopHandoffSofiaUrl,
} from "../app/(den)/_lib/desktop-handoff";

test("preserves the complete Sofia desktop handoff URL", () => {
  const sofiaUrl = "sofia://den-auth?grant=one-time-code&denBaseUrl=https%3A%2F%2Fapi.example.test";
  const payload = { grant: "one-time-code", sofiaUrl };

  expect(getDesktopHandoffSofiaUrl(payload)).toBe(sofiaUrl);
  expect(getDesktopHandoffGrant(payload, sofiaUrl)).toBe("one-time-code");
});

test("extracts a one-time grant from an Sofia desktop handoff", () => {
  expect(
    getDesktopGrant(
      "sofia://den-auth?grant=one-time-code&baseUrl=https%3A%2F%2Fapi.example.test"
    )
  ).toBe("one-time-code");
});

test("rejects missing and malformed desktop handoffs", () => {
  expect(
    getDesktopGrant(
      "sofia://den-auth?baseUrl=https%3A%2F%2Fapi.example.test"
    )
  ).toBeNull();
  expect(getDesktopGrant("not a url")).toBeNull();
  expect(getDesktopGrant(null)).toBeNull();
});
