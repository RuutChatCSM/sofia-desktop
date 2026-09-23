import { describe, expect, test } from "bun:test";

import { describeSofiaError } from "../src/react-app/domains/session/codex-session-store";

// The transcript must never surface a raw provider payload as the primary
// content. These pin the unwrapping: `codex rpc error (…):` prefix and an
// embedded `{"error":{"message":…}}` body become human prose, and the raw
// string is preserved separately for "technical details".
describe("describeSofiaError", () => {
  test("unwraps the rpc/JSON envelope and names the missing credential", () => {
    const raw = 'codex rpc error (-32600): {"error":{"message":"Missing environment variable: `DEEPSEEK_API_KEY`."}}';
    const described = describeSofiaError(raw);
    expect(described.title).toBe("Deepseek credentials unavailable");
    expect(described.variable).toBe("DEEPSEEK_API_KEY");
    expect(described.body).toContain("DEEPSEEK_API_KEY");
    expect(described.body).not.toContain("{");
    expect(described.raw).toBe(raw);
  });

  test("maps unauthorized failures to a provider-auth message", () => {
    const described = describeSofiaError("unexpected status 401 Unauthorized: Missing bearer authentication in header");
    expect(described.title).toBe("Provider authentication failed");
  });

  test("falls back to the cleaned detail and keeps the raw text", () => {
    const described = describeSofiaError("network error: error sending request");
    expect(described.title).toBe("Sofia hit an error");
    expect(described.body).toContain("network error");
    expect(described.raw).toBe("network error: error sending request");
  });
});
