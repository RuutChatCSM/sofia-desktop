import { test } from "@sofia/testkit";
import { expect } from "vitest";
import { buildCloudAuthUrl } from "../../apps/app/src/app/lib/cloud-auth-url";

test("Sofia Cloud sign-in and registration open Rails with one-time handoff intent", ({ evidence }) => {
  const signIn = new URL(buildCloudAuthUrl("https://cloud.example.test", "sign-in"));
  const signUp = new URL(buildCloudAuthUrl("https://cloud.example.test", "sign-up"));
  expect(signIn.pathname).toBe("/desktop/authorize");
  expect(signUp.pathname).toBe("/registration/new");
  expect(signIn.searchParams.get("desktopAuth")).toBe("1");
  expect(signUp.searchParams.get("desktopAuth")).toBe("1");
  expect(signIn.searchParams.has("token")).toBe(false);
  expect(signIn.searchParams.has("webAuthReturn")).toBe(false);
  const hosted = new URL(buildCloudAuthUrl("https://cloud.example.test/sofia/?token=secret#old", "sign-in"));
  expect(hosted.pathname).toBe("/sofia/desktop/authorize");
  expect(hosted.searchParams.has("token")).toBe(false);
  expect(hosted.hash).toBe("");
  evidence.recordAssertionEvidence("Desktop authentication belongs to Sofia Cloud", "Sign-in and registration target the Rails routes and retain handoff intent without forwarding tokens or arbitrary redirects.", true);
});
