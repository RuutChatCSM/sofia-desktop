import { describe, expect, test } from "bun:test";
import { parseConnectDeepLink } from "../src/app/lib/sofia-links";

const TOKEN = "eyJhbGciOiJFZERTQSJ9.eyJmYWtlIjoxfQ.c2ln";

describe("parseConnectDeepLink", () => {
  test("parses production and dev desktop connect links", () => {
    const rawUrl = `sofia://connect?token=${TOKEN}`;
    expect(parseConnectDeepLink(rawUrl)).toEqual({ rawUrl, key: `signed:${TOKEN}` });
    expect(parseConnectDeepLink(`sofia-dev://connect?token=${TOKEN}`)?.key).toBe(`signed:${TOKEN}`);
    expect(parseConnectDeepLink(`sofia:///connect?token=${TOKEN}`)?.key).toBe(`signed:${TOKEN}`);
  });

  test("parses keyless exchange links without accepting ambiguous transports", () => {
    const code = "abcdefghijklmnopqrstuvwxyz123456";
    const apiBaseUrl = "https://den.example.com/api/den";
    const rawUrl = `sofia://connect?code=${code}&apiBaseUrl=${encodeURIComponent(apiBaseUrl)}`;
    expect(parseConnectDeepLink(rawUrl)).toEqual({
      rawUrl,
      key: `exchange:${apiBaseUrl}:${code}`,
    });
    expect(parseConnectDeepLink(`${rawUrl}&token=${TOKEN}`)).toBeNull();
  });

  test("does not activate from web URLs or unrelated desktop routes", () => {
    expect(parseConnectDeepLink(`https://sofia.example.com/connect?token=${TOKEN}`)).toBeNull();
    expect(parseConnectDeepLink(`sofia://den-auth?grant=${TOKEN}`)).toBeNull();
    expect(parseConnectDeepLink("sofia://connect")).toBeNull();
    expect(parseConnectDeepLink("not a url")).toBeNull();
  });
});
