import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  buildDenAuthUrl,
  createDenClient,
  getDenMcpUrl,
  initializeDenBootstrapConfig,
  readDenBootstrapConfig,
  readDenSettings,
  resolveDenBaseUrls,
} from "../src/app/lib/den";
import {
  hydrateSofiaServerSettingsFromEnv,
  readSofiaServerSettings,
} from "../src/app/lib/sofia-server";
import { createSofiaServerStore } from "../src/react-app/domains/connections/sofia-server-store";
import { buildSofiaHealthHeaders } from "../src/react-app/kernel/server-provider";
import {
  isStaleStoredDesktopConnection,
  resolveSofiaConnection,
} from "../src/react-app/shell/sofia-connection";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const originalDeployment = process.env.VITE_SOFIA_DEPLOYMENT;

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.toString();
  if (typeof input === "string") return input;
  return input.url;
}

function createTestSofiaServerStore(startupPreference: "local" | "server" = "server") {
  return createSofiaServerStore({
    startupPreference: () => startupPreference,
    documentVisible: () => true,
    developerMode: () => false,
    runtimeWorkspaceId: () => "workspace_test",
    activeClient: () => null,
    selectedWorkspaceDisplay: () => ({
      id: "workspace_test",
      name: "Test workspace",
      path: "/tmp/workspace_test",
      preset: "default",
      workspaceType: "local",
    }),
    restartLocalServer: async () => false,
    createRemoteWorkspaceFlow: async () => false,
  });
}

function installWindow(options: {
  origin: string;
  gateway?: boolean;
  bootstrapToken?: string;
  electronInfo?: {
    baseUrl: string;
    ownerToken: string;
    clientToken?: string;
    hostToken?: string;
  };
  /** Raw sofiaServerInfo response for non-ready/restarting server states. */
  electronServerInfoRaw?: Record<string, unknown>;
  /** Simulate a desktop bridge whose sofiaServerInfo call fails outright. */
  electronServerInfoError?: boolean;
}) {
  const localStorage = memoryStorage();
  const electronBridgeInstalled =
    options.electronInfo || options.electronServerInfoRaw || options.electronServerInfoError;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage,
      dispatchEvent: () => true,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      location: { origin: options.origin },
      __SOFIA_GATEWAY__: options.gateway ? { version: 1 } : undefined,
      __SOFIA_BOOTSTRAP__: options.bootstrapToken ? { token: options.bootstrapToken } : undefined,
      __SOFIA_ELECTRON__: electronBridgeInstalled
        ? {
            invokeDesktop: async (command: string) => {
              if (command !== "sofiaServerInfo") {
                throw new Error(`Unexpected desktop command: ${command}`);
              }
              if (options.electronServerInfoError) {
                throw new Error("desktop bridge unavailable");
              }
              if (options.electronServerInfoRaw) {
                return options.electronServerInfoRaw;
              }
              return {
                running: true,
                baseUrl: options.electronInfo?.baseUrl,
                ownerToken: options.electronInfo?.ownerToken,
                clientToken: options.electronInfo?.clientToken,
                hostToken: options.electronInfo?.hostToken,
              };
            },
          }
        : undefined,
    },
  });
  return localStorage;
}

describe("gateway runtime mode", () => {
  beforeEach(() => {
    process.env.VITE_SOFIA_DEPLOYMENT = "web";
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
    if (originalDeployment === undefined) {
      delete process.env.VITE_SOFIA_DEPLOYMENT;
    } else {
      process.env.VITE_SOFIA_DEPLOYMENT = originalDeployment;
    }
  });

  test("resolves Sofia App server traffic through the gateway origin with the Den session token", async () => {
    const storage = installWindow({ origin: "https://sofia-web.ruut.chat", gateway: true });
    storage.setItem("sofia.den.authToken", "den-session-token");
    storage.setItem("sofia.server.urlOverride", "https://direct-instance.example.com");
    storage.setItem("sofia.server.token", "stale-instance-token");

    const connection = await resolveSofiaConnection();

    expect(connection).toEqual({
      normalizedBaseUrl: "https://sofia-web.ruut.chat",
      resolvedToken: "den-session-token",
      resolvedHostToken: "",
      hostInfo: null,
      source: "gateway",
    });
  });

  test("keeps Den web on the configured origin and Den API calls on the gateway origin", () => {
    const storage = installWindow({ origin: "https://gw.example", gateway: true });
    storage.setItem("sofia.den.baseUrl", "https://sofia-app.ruut.chat");
    storage.setItem("sofia.den.authToken", "den-session-token");

    expect(resolveDenBaseUrls("https://gw.example")).toEqual({
      baseUrl: "https://sofia-app.ruut.chat",
      apiBaseUrl: "https://gw.example/api/den",
    });
    expect(readDenSettings().baseUrl).toBe("https://sofia-app.ruut.chat");
    expect(readDenSettings().apiBaseUrl).toBe("https://gw.example/api/den");
    expect(readDenSettings().authToken).toBe("den-session-token");
  });

  test("builds web auth URLs on the Den web origin with the gateway return origin", () => {
    installWindow({ origin: "https://gw.example", gateway: true });

    const authUrl = new URL(buildDenAuthUrl(readDenSettings().baseUrl, "sign-up"));

    expect(authUrl.origin).toBe("https://sofia-app.ruut.chat");
    expect(authUrl.searchParams.get("mode")).toBe("sign-up");
    expect(authUrl.searchParams.get("webAuth")).toBe("1");
    expect(authUrl.searchParams.get("webAuthReturn")).toBe("https://gw.example");
  });

  test("routes Den auth API paths to Den web and v1 paths through the gateway API", async () => {
    installWindow({ origin: "https://gw.example", gateway: true });
    const requestedUrls: string[] = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        requestedUrls.push(getRequestUrl(input));
        return new Response(JSON.stringify({
          user: { id: "user_test", email: "user@example.com" },
          token: "tok_test",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const client = createDenClient({ baseUrl: readDenSettings().baseUrl, token: "tok_test" });
    await client.signInEmail("user@example.com", "password");
    await client.getSession();

    expect(requestedUrls).toEqual([
      "https://sofia-app.ruut.chat/api/auth/sign-in/email",
      "https://gw.example/api/den/v1/me",
    ]);
  });

  test("uses the gateway Den API proxy for MCP", () => {
    installWindow({ origin: "https://gw.example", gateway: true });

    expect(getDenMcpUrl()).toBe("https://gw.example/api/den/mcp");
  });

  test("returns a stable gateway bootstrap snapshot for React external stores", () => {
    installWindow({ origin: "https://sofia-web.ruut.chat", gateway: true });

    const first = readDenBootstrapConfig();
    const second = readDenBootstrapConfig();

    expect(second).toBe(first);
    expect(first.baseUrl).toBe("https://sofia-app.ruut.chat");
    expect(first.apiBaseUrl).toBe("https://sofia-web.ruut.chat/api/den");
  });

  test("does not hydrate an instance bootstrap token into server storage behind the gateway", () => {
    const storage = installWindow({
      origin: "https://sofia-web.ruut.chat",
      gateway: true,
      bootstrapToken: "instance-token-must-not-store",
    });

    hydrateSofiaServerSettingsFromEnv();

    expect(storage.getItem("sofia.server.token")).toBeNull();
    expect(readSofiaServerSettings().token).toBeUndefined();
  });

  test("uses same-origin and the Den bearer for Sofia App server store env calls behind the gateway", async () => {
    const storage = installWindow({ origin: "https://gw.example", gateway: true });
    storage.setItem("sofia.den.authToken", "den-session-token");
    storage.setItem("sofia.server.urlOverride", "https://direct-instance.example.com");
    storage.setItem("sofia.server.token", "stale-instance-token");
    storage.setItem("sofia.server.hostToken", "stale-host-token");
    const requests: Array<{ url: string; authorization: string | null; hostToken: string | null }> = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        requests.push({
          url: getRequestUrl(input),
          authorization: headers.get("authorization"),
          hostToken: headers.get("x-sofia-host-token"),
        });
        return new Response(JSON.stringify({ runtimeKey: "runtime-a", pendingChanges: false, ok: true, count: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const store = createTestSofiaServerStore();
    const snapshot = store.getSnapshot();
    const client = snapshot.sofiaServerClient;
    if (!client) throw new Error("Expected a gateway Sofia App server client");

    expect(snapshot.sofiaServerBaseUrl).toBe("https://gw.example");
    expect(snapshot.sofiaServerAuth.token).toBe("den-session-token");
    expect(snapshot.sofiaServerAuth.hostToken).toBeUndefined();
    expect(client.baseUrl).toBe("https://gw.example");
    expect(client.token).toBe("den-session-token");

    await client.getUserEnvStatus("runtime-a");
    await client.upsertUserEnv([{ key: "OPENAI_API_KEY", value: "sk-test" }]);

    expect(requests).toEqual([
      {
        url: "https://gw.example/env/status?runtimeKey=runtime-a",
        authorization: "Bearer den-session-token",
        hostToken: null,
      },
      {
        url: "https://gw.example/env",
        authorization: "Bearer den-session-token",
        hostToken: null,
      },
    ]);
  });

  test("uses the Den bearer for same-origin Sofia engine health polling behind the gateway", () => {
    const storage = installWindow({ origin: "https://gw.example", gateway: true });
    storage.setItem("sofia.den.authToken", "den-session-token");
    storage.setItem("sofia.server.token", "stale-instance-token");

    expect(buildSofiaHealthHeaders("https://gw.example/opencode")).toEqual({
      Authorization: "Bearer den-session-token",
    });
  });
});

describe("non-gateway connection modes", () => {
  beforeEach(() => {
    process.env.VITE_SOFIA_DEPLOYMENT = "web";
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
    if (originalDeployment === undefined) {
      delete process.env.VITE_SOFIA_DEPLOYMENT;
    } else {
      process.env.VITE_SOFIA_DEPLOYMENT = originalDeployment;
    }
  });

  test("direct instance bootstrap hydration and same-origin resolution are unchanged without the marker", async () => {
    installWindow({ origin: "https://instance.example.com", bootstrapToken: "instance-token" });

    hydrateSofiaServerSettingsFromEnv();
    const connection = await resolveSofiaConnection();

    expect(readSofiaServerSettings().token).toBe("instance-token");
    expect(connection.normalizedBaseUrl).toBe("https://instance.example.com");
    expect(connection.resolvedToken).toBe("instance-token");
    expect(connection.source).toBe("same-origin");
  });

  test("force-env settings overwrite stale localStorage sofia-server credentials", () => {
    const previous = {
      url: process.env.VITE_SOFIA_URL,
      port: process.env.VITE_SOFIA_PORT,
      token: process.env.VITE_SOFIA_TOKEN,
      hostToken: process.env.VITE_SOFIA_HOST_TOKEN,
      force: process.env.VITE_SOFIA_FORCE_ENV_SETTINGS,
    };
    process.env.VITE_SOFIA_URL = "http://127.0.0.1:8787";
    process.env.VITE_SOFIA_PORT = "8787";
    process.env.VITE_SOFIA_TOKEN = "fresh-token";
    process.env.VITE_SOFIA_HOST_TOKEN = "fresh-host-token";
    process.env.VITE_SOFIA_FORCE_ENV_SETTINGS = "1";

    const storage = installWindow({ origin: "http://127.0.0.1:5173" });
    storage.setItem("sofia.server.urlOverride", "http://127.0.0.1:9999");
    storage.setItem("sofia.server.token", "stale-token");
    storage.setItem("sofia.server.hostToken", "stale-host-token");

    try {
      hydrateSofiaServerSettingsFromEnv();
      expect(readSofiaServerSettings()).toEqual({
        urlOverride: "http://127.0.0.1:8787",
        portOverride: 8787,
        token: "fresh-token",
        hostToken: "fresh-host-token",
        remoteAccessEnabled: false,
      });
    } finally {
      restoreEnv("VITE_SOFIA_URL", previous.url);
      restoreEnv("VITE_SOFIA_PORT", previous.port);
      restoreEnv("VITE_SOFIA_TOKEN", previous.token);
      restoreEnv("VITE_SOFIA_HOST_TOKEN", previous.hostToken);
      restoreEnv("VITE_SOFIA_FORCE_ENV_SETTINGS", previous.force);
    }
  });

  test("force-env without a VITE host token clears a leftover browser host token", () => {
    const previous = {
      url: process.env.VITE_SOFIA_URL,
      port: process.env.VITE_SOFIA_PORT,
      token: process.env.VITE_SOFIA_TOKEN,
      hostToken: process.env.VITE_SOFIA_HOST_TOKEN,
      force: process.env.VITE_SOFIA_FORCE_ENV_SETTINGS,
    };
    process.env.VITE_SOFIA_URL = "http://127.0.0.1:8787";
    process.env.VITE_SOFIA_PORT = "8787";
    process.env.VITE_SOFIA_TOKEN = "fresh-token";
    delete process.env.VITE_SOFIA_HOST_TOKEN;
    process.env.VITE_SOFIA_FORCE_ENV_SETTINGS = "1";

    const storage = installWindow({ origin: "http://127.0.0.1:5178" });
    storage.setItem("sofia.server.hostToken", "leaked-host-token");

    try {
      hydrateSofiaServerSettingsFromEnv();
      expect(readSofiaServerSettings().hostToken).toBeUndefined();
      expect(storage.getItem("sofia.server.hostToken")).toBeNull();
    } finally {
      restoreEnv("VITE_SOFIA_URL", previous.url);
      restoreEnv("VITE_SOFIA_PORT", previous.port);
      restoreEnv("VITE_SOFIA_TOKEN", previous.token);
      restoreEnv("VITE_SOFIA_HOST_TOKEN", previous.hostToken);
      restoreEnv("VITE_SOFIA_FORCE_ENV_SETTINGS", previous.force);
    }
  });

  test("stored server settings still win without the marker", async () => {
    const storage = installWindow({ origin: "https://instance.example.com" });
    storage.setItem("sofia.server.urlOverride", "https://manual.example.com");
    storage.setItem("sofia.server.token", "manual-token");
    storage.setItem("sofia.server.hostToken", "host-token");

    const connection = await resolveSofiaConnection();

    expect(connection.normalizedBaseUrl).toBe("https://manual.example.com");
    expect(connection.resolvedToken).toBe("manual-token");
    expect(connection.resolvedHostToken).toBe("");
    expect(connection.source).toBe("stored-settings");

    const store = createTestSofiaServerStore();
    const snapshot = store.getSnapshot();

    expect(snapshot.sofiaServerBaseUrl).toBe("https://manual.example.com");
    expect(snapshot.sofiaServerAuth.token).toBe("manual-token");
    expect(snapshot.sofiaServerAuth.hostToken).toBeUndefined();
    expect(snapshot.sofiaServerClient?.baseUrl).toBe("https://manual.example.com");
    expect(snapshot.sofiaServerClient?.token).toBe("manual-token");
  });

  test("Sofia engine health polling still uses the stored instance token without the gateway marker", () => {
    const storage = installWindow({ origin: "https://instance.example.com" });
    storage.setItem("sofia.server.token", "instance-token");

    expect(buildSofiaHealthHeaders("https://instance.example.com/opencode")).toEqual({
      Authorization: "Bearer instance-token",
    });
  });

  test("plain web Den settings still use a stored custom base URL without the marker", () => {
    const storage = installWindow({ origin: "https://instance.example.com" });
    storage.setItem("sofia.den.baseUrl", "https://den.self-hosted.example.com");

    expect(readDenSettings().baseUrl).toBe("https://den.self-hosted.example.com");
    expect(readDenSettings().apiBaseUrl).toBe("https://den.self-hosted.example.com/api/den");
  });

  test("VITE_DEN_API_BASE_URL pins Den API calls to the proxy while sign-in stays on the web base", () => {
    const previous = process.env.VITE_DEN_API_BASE_URL;
    process.env.VITE_DEN_API_BASE_URL = "http://127.0.0.1:5178/api/den";
    installWindow({ origin: "http://127.0.0.1:5178" });

    try {
      const settings = readDenSettings();
      expect(settings.baseUrl).toBe("https://sofia-app.ruut.chat");
      expect(settings.apiBaseUrl).toBe("http://127.0.0.1:5178/api/den");

      // Every Den client derives its API base the same way, so requests go
      // through the same-origin proxy even when created from the web base.
      const client = createDenClient({ baseUrl: settings.baseUrl, token: "den-token" });
      expect(client.baseUrls.apiBaseUrl).toBe("http://127.0.0.1:5178/api/den");
      expect(client.baseUrls.baseUrl).toBe("https://sofia-app.ruut.chat");

      // Sign-in still opens the real Den web app, not the proxy origin.
      // Loopback cannot use webAuth return URLs against hosted Den, so the
      // URL uses desktopAuth (copy link / paste grant) instead.
      const authUrl = new URL(buildDenAuthUrl(settings.baseUrl, "sign-in"));
      expect(authUrl.origin).toBe("https://sofia-app.ruut.chat");
      expect(authUrl.searchParams.get("desktopAuth")).toBe("1");
      expect(authUrl.searchParams.get("webAuth")).toBeNull();
    } finally {
      restoreEnv("VITE_DEN_API_BASE_URL", previous);
    }
  });

  test("loopback web auth uses desktop handoff instead of an unapprovable webAuth return URL", () => {
    installWindow({ origin: "http://127.0.0.1:5178" });

    const authUrl = new URL(buildDenAuthUrl(readDenSettings().baseUrl, "sign-in"));

    expect(authUrl.origin).toBe("https://sofia-app.ruut.chat");
    expect(authUrl.searchParams.get("desktopAuth")).toBe("1");
    expect(authUrl.searchParams.get("desktopScheme")).toBe("sofia");
    expect(authUrl.searchParams.get("webAuth")).toBeNull();
    expect(authUrl.searchParams.get("webAuthReturn")).toBeNull();
  });

  test("force-env clears a stale stored Den base URL on web bootstrap init", async () => {
    const previous = process.env.VITE_SOFIA_FORCE_ENV_SETTINGS;
    process.env.VITE_SOFIA_FORCE_ENV_SETTINGS = "1";
    const storage = installWindow({ origin: "http://127.0.0.1:5178" });
    storage.setItem("sofia.den.baseUrl", "http://127.0.0.1:8779");

    try {
      await initializeDenBootstrapConfig();
      expect(storage.getItem("sofia.den.baseUrl")).toBeNull();
      expect(readDenSettings().baseUrl).toBe("https://sofia-app.ruut.chat");
    } finally {
      restoreEnv("VITE_SOFIA_FORCE_ENV_SETTINGS", previous);
    }
  });

  test("desktop runtime still uses live desktop server info without the marker", async () => {
    installWindow({
      origin: "https://instance.example.com",
      electronInfo: {
        baseUrl: "http://127.0.0.1:8787",
        ownerToken: "owner-token",
        hostToken: "host-token",
      },
    });

    const connection = await resolveSofiaConnection();

    expect(connection.normalizedBaseUrl).toBe("http://127.0.0.1:8787");
    expect(connection.resolvedToken).toBe("owner-token");
    expect(connection.resolvedHostToken).toBe("host-token");
    expect(connection.source).toBe("desktop-runtime");
  });

  test("desktop reconnect persists the complete live server credential bundle", async () => {
    const storage = installWindow({
      origin: "https://instance.example.com",
      electronInfo: {
        baseUrl: "http://127.0.0.1:8787",
        ownerToken: "owner-token",
        clientToken: "live-client-token",
        hostToken: "live-host-token",
      },
    });
    storage.setItem("sofia.server.token", "stale-client-token");
    storage.setItem("sofia.server.hostToken", "stale-host-token");
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async () => new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });

    const store = createTestSofiaServerStore("local");

    expect(await store.reconnectSofiaServer()).toBe(true);
    expect(readSofiaServerSettings().token).toBe("live-client-token");
    expect(readSofiaServerSettings().hostToken).toBe("live-host-token");
    expect(store.getSnapshot().sofiaServerAuth).toEqual({
      token: "live-client-token",
      hostToken: "live-host-token",
    });
  });

  test("a restarting desktop server invalidates stored loopback settings instead of resolving a dead port", async () => {
    // App update / slow restart: the live runtime answers definitively, but
    // the server has not republished its base URL and tokens yet. The stored
    // loopback settings are from the previous server lifetime.
    const storage = installWindow({
      origin: "https://instance.example.com",
      electronServerInfoRaw: { running: false, baseUrl: null, ownerToken: null, clientToken: null },
    });
    storage.setItem("sofia.server.urlOverride", "http://127.0.0.1:4100");
    storage.setItem("sofia.server.token", "tok_previous_lifetime");

    const connection = await resolveSofiaConnection();

    expect(connection.source).toBe("empty");
    expect(connection.normalizedBaseUrl).toBe("");
    expect(connection.resolvedToken).toBe("");
  });

  test("a restarting desktop server keeps stored remote/manual servers as the fallback", async () => {
    const storage = installWindow({
      origin: "https://instance.example.com",
      electronServerInfoRaw: { running: false, baseUrl: null, ownerToken: null, clientToken: null },
    });
    storage.setItem("sofia.server.urlOverride", "https://manual.example.com");
    storage.setItem("sofia.server.token", "manual-token");

    const connection = await resolveSofiaConnection();

    expect(connection.source).toBe("stored-settings");
    expect(connection.normalizedBaseUrl).toBe("https://manual.example.com");
    expect(connection.resolvedToken).toBe("manual-token");
  });

  test("a failing desktop bridge still falls back to stored settings", async () => {
    // No definitive live answer: keep the pre-existing fallback so broken
    // bridges do not strand configured connections.
    const storage = installWindow({
      origin: "https://instance.example.com",
      electronServerInfoError: true,
    });
    storage.setItem("sofia.server.urlOverride", "http://127.0.0.1:4100");
    storage.setItem("sofia.server.token", "tok_stored");

    const connection = await resolveSofiaConnection();

    expect(connection.source).toBe("stored-settings");
    expect(connection.normalizedBaseUrl).toBe("http://127.0.0.1:4100");
    expect(connection.resolvedToken).toBe("tok_stored");
  });
});

describe("isStaleStoredDesktopConnection", () => {
  test("marks stored loopback connections stale only on a definitive not-ready answer", () => {
    expect(
      isStaleStoredDesktopConnection({
        desktopRuntime: true,
        desktopServerReportedNotReady: true,
        storedBaseUrl: "http://127.0.0.1:4100",
        runtimeReportedBaseUrl: "",
      }),
    ).toBe(true);
    expect(
      isStaleStoredDesktopConnection({
        desktopRuntime: true,
        desktopServerReportedNotReady: false,
        storedBaseUrl: "http://127.0.0.1:4100",
        runtimeReportedBaseUrl: "",
      }),
    ).toBe(false);
    expect(
      isStaleStoredDesktopConnection({
        desktopRuntime: false,
        desktopServerReportedNotReady: true,
        storedBaseUrl: "http://127.0.0.1:4100",
        runtimeReportedBaseUrl: "",
      }),
    ).toBe(false);
  });

  test("keeps remote URLs unless they match the runtime-reported base URL", () => {
    expect(
      isStaleStoredDesktopConnection({
        desktopRuntime: true,
        desktopServerReportedNotReady: true,
        storedBaseUrl: "https://manual.example.com",
        runtimeReportedBaseUrl: "",
      }),
    ).toBe(false);
    expect(
      isStaleStoredDesktopConnection({
        desktopRuntime: true,
        desktopServerReportedNotReady: true,
        storedBaseUrl: "https://manual.example.com",
        runtimeReportedBaseUrl: "https://manual.example.com",
      }),
    ).toBe(true);
    expect(
      isStaleStoredDesktopConnection({
        desktopRuntime: true,
        desktopServerReportedNotReady: true,
        storedBaseUrl: "",
        runtimeReportedBaseUrl: "",
      }),
    ).toBe(false);
  });
});
