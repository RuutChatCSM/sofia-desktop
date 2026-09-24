import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { codexAuthStorePath, writeCodexAuthStore } from "../../apps/server/src/codex-auth-store.ts";
import { codexProvidersPath, codexConfigTomlPath, readCodexEngineConfig } from "../../apps/server/src/codex-providers.ts";
import { prepareSofiaAuthInHome } from "../../apps/server/src/codex-registry.ts";
import { describeSofiaError, useCodexSessionStore } from "../../apps/app/src/react-app/domains/session/codex-session-store.ts";

test("Sofia shares CLI providers and credentials while keeping development sessions isolated", async () => {
  const root = await mkdtemp(join(tmpdir(), "sofia-provider-test-"));
  const shared = join(root, ".sofia"), engine = join(root, "engine");
  const env = { HOME: join(root, "isolated"), REAL_HOME: root, SOFIA_PROVIDER_HOME: shared, SOFIA_CODEX_HOME: engine };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, env);
    await mkdir(shared, { recursive: true });
    await writeCodexAuthStore({ DEEPSEEK_API_KEY: "test-only-key" }, { env });
    await writeFile(codexProvidersPath({ env }), JSON.stringify({ providers: { deepseek: {
      name: "DeepSeek", api_key: "test-only-key", base_url: "https://api.deepseek.com", wire_api: "chat_completions",
      models: [{ id: "saved-model", name: "Saved model", reasoning: true }],
    } } }));
    await writeFile(codexConfigTomlPath({ env }), 'model_provider = "deepseek"\nmodel = "saved-model"\n');
    expect(codexAuthStorePath({ env })).toBe(join(shared, "sofia-auth.json"));
    const config = await readCodexEngineConfig({ env });
    expect(config.defaultProviderId).toBe("deepseek");
    expect(config.model).toBe("saved-model");
    expect(config.providers[0].models[0].id).toBe("saved-model");
    expect(JSON.stringify(config)).not.toContain("test-only-key");
    await prepareSofiaAuthInHome(engine);
    expect(JSON.parse(await readFile(join(engine, "sofia-auth.json"), "utf8"))).toEqual({ DEEPSEEK_API_KEY: "test-only-key" });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("A failed Sofia turn stops thinking and renders a single error across native notifications", () => {
  const store = useCodexSessionStore.getState();
  store.clear();
  store.upsertSession({ id: "s", threadId: "t", title: "Test", workspaceId: null, created: "2026-09-14", status: "running", turnId: "turn" });
  store.failSession("s", "Missing environment variable: DEEPSEEK_API_KEY", "turn");
  store.upsertSession({ ...useCodexSessionStore.getState().sessions.s.session, turnId: null });
  store.completeTurn("s");
  store.failSession("s", "Missing environment variable: DEEPSEEK_API_KEY", "turn");
  const entry = useCodexSessionStore.getState().sessions.s;
  expect(entry.session.status).toBe("error");
  expect(entry.items).toHaveLength(1);
  expect(entry.items[0].status).toBe("error");
  expect(entry.items[0].text).toBe("Deepseek credentials unavailable");
  expect(entry.items[0].errorPresentation?.technicalDetails).toBe("Missing environment variable: DEEPSEEK_API_KEY");
  store.failSession("s", "Another failure", "next-turn");
  expect(useCodexSessionStore.getState().sessions.s.items).toHaveLength(2);
  store.clear();
});


test("Sofia RPC errors display the provider message without transport prefixes", () => {
  const raw = "Sofia RPC error (-32600): Provider rejected the request";
  const error = describeSofiaError(raw);
  expect(error.title).toBe("Sofia hit an error");
  expect(error.body).toBe("Provider rejected the request");
  expect(error.raw).toBe(raw);
});
