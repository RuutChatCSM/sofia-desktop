import { describe, expect, test } from "bun:test";

import {
  getDenMcpUrl,
  isLegacyWebAppMcpUrl,
  parseDenMcpToken,
  resolveCloudMcpResourceUrl,
  resolveDenBaseUrls,
} from "../src/app/lib/den";

describe("resolveDenBaseUrls", () => {
  test("adds the API proxy path to an explicit API base URL", () => {
    const resolved = resolveDenBaseUrls({
      baseUrl: "https://sofia-app.ruut.chat",
      apiBaseUrl: "https://sofia-app.ruut.chat",
    });
    expect(resolved.apiBaseUrl).toBe("https://sofia-app.ruut.chat/api/den");
  });

  test("keeps an explicit API origin independent from the web base URL", () => {
    const resolved = resolveDenBaseUrls({
      baseUrl: "https://sofia-app.ruut.chat",
      apiBaseUrl: "https://api.example.com",
    });
    expect(resolved.baseUrl).toBe("https://sofia-app.ruut.chat");
    expect(resolved.apiBaseUrl).toBe("https://api.example.com/api/den");
  });

  test("keeps an explicit loopback API URL when a base URL is present", () => {
    const resolved = resolveDenBaseUrls({
      baseUrl: "http://localhost:3000",
      apiBaseUrl: "http://127.0.0.1:8787",
    });
    expect(resolved.baseUrl).toBe("http://localhost:3000");
    expect(resolved.apiBaseUrl).toBe("http://127.0.0.1:8787/api/den");
  });

  test("derives the /api/den proxy from a web-app baseUrl when no apiBaseUrl is set", () => {
    const resolved = resolveDenBaseUrls({ baseUrl: "https://den.self-hosted.example.com" });
    expect(resolved.baseUrl).toBe("https://den.self-hosted.example.com");
    expect(resolved.apiBaseUrl).toBe("https://den.self-hosted.example.com/api/den");
  });
});

describe("getDenMcpUrl", () => {
  test("never targets the bare web-app origin", () => {
    const url = getDenMcpUrl();
    expect(isLegacyWebAppMcpUrl(url)).toBe(false);
    expect(url.endsWith("/mcp")).toBe(true);
  });
});

describe("isLegacyWebAppMcpUrl", () => {
  test("flags the legacy bare web-app MCP URL", () => {
    expect(isLegacyWebAppMcpUrl("https://sofia-app.ruut.chat/mcp")).toBe(true);
    expect(isLegacyWebAppMcpUrl("https://app.sofia.software/mcp/")).toBe(true);
  });

  test("accepts valid MCP URLs", () => {
    expect(isLegacyWebAppMcpUrl("https://sofia-app.ruut.chat/api/den/mcp")).toBe(false);
    expect(isLegacyWebAppMcpUrl("http://127.0.0.1:8787/mcp")).toBe(false);
  });

  test("ignores empty or malformed input", () => {
    expect(isLegacyWebAppMcpUrl(null)).toBe(false);
    expect(isLegacyWebAppMcpUrl("not a url")).toBe(false);
  });
});

describe("resolveCloudMcpResourceUrl", () => {
  test("heals a minted legacy web-app resource through the /api/den proxy", () => {
    expect(resolveCloudMcpResourceUrl("https://sofia-app.ruut.chat/mcp")).toBe(
      "https://sofia-app.ruut.chat/api/den/mcp",
    );
    expect(resolveCloudMcpResourceUrl("https://app.sofia.software/mcp/")).toBe(
      "https://app.sofia.software/api/den/mcp",
    );
  });

  test("keeps healthy resources verbatim", () => {
    expect(resolveCloudMcpResourceUrl("https://sofia-app.ruut.chat/api/den/mcp")).toBe(
      "https://sofia-app.ruut.chat/api/den/mcp",
    );
    expect(resolveCloudMcpResourceUrl("http://127.0.0.1:8787/mcp")).toBe(
      "http://127.0.0.1:8787/mcp",
    );
  });

  test("returns null for unusable resources so callers keep their fallback", () => {
    expect(resolveCloudMcpResourceUrl(null)).toBeNull();
    expect(resolveCloudMcpResourceUrl("")).toBeNull();
    expect(resolveCloudMcpResourceUrl("   ")).toBeNull();
    expect(resolveCloudMcpResourceUrl("not a url")).toBeNull();
    expect(resolveCloudMcpResourceUrl("ftp://sofia-app.ruut.chat/mcp")).toBeNull();
  });
});

describe("parseDenMcpToken", () => {
  test("accepts an older Den response while leaving the private App host closed", () => {
    expect(parseDenMcpToken({
      token: "central-token",
      expiresAt: "2026-08-18T00:00:00.000Z",
      organizationId: "org_1",
      scopes: ["mcp:read", "mcp:write"],
      resource: "https://api.sofia.test/mcp",
    })).toEqual({
      token: "central-token",
      expiresAt: "2026-08-18T00:00:00.000Z",
      organizationId: "org_1",
      scopes: ["mcp:read", "mcp:write"],
      resource: "https://api.sofia.test/mcp",
    });
  });

  test("keeps the App-host token pair only when both fields are present", () => {
    const base = {
      token: "central-token",
      expiresAt: "2026-08-18T00:00:00.000Z",
      organizationId: "org_1",
      scopes: ["mcp:read", "mcp:write"],
      resource: "https://api.sofia.test/mcp",
    };
    expect(parseDenMcpToken({ ...base, appHostToken: "private-token" })?.appHostToken).toBeUndefined();
    expect(parseDenMcpToken({
      ...base,
      appHostToken: "private-token",
      appHostExpiresAt: "2026-08-18T00:00:00.000Z",
    })?.appHostToken).toBe("private-token");
  });
});
