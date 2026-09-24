import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deriveAutoDevProfileName,
  legacyAppIdentifierFor,
  migrateLegacyUserDataDir,
  resolveAppIdentifier,
  resolveUserDataPath,
} from "./dev-profile.mjs";

const PROD_APP_IDENTIFIER = "com.differentai.sofia";
const DEV_APP_IDENTIFIER = "com.differentai.sofia.dev";
const APP_DATA_PATH = path.join("tmp", "appData");

function resolveProfile({
  appIdentifierOverride = "",
  appRootPath = path.join("tmp", "sofia"),
  devProfile = "",
  isDevMode = true,
  isPackaged = false,
  userDataOverride = "",
} = {}) {
  const baseAppIdentifier = isDevMode ? DEV_APP_IDENTIFIER : PROD_APP_IDENTIFIER;
  const appIdentifier = resolveAppIdentifier({
    appIdentifierOverride,
    appRootPath,
    baseAppIdentifier,
    devAppIdentifier: DEV_APP_IDENTIFIER,
    devProfile,
    isDevMode,
    isPackaged,
  });
  return {
    appIdentifier,
    userDataPath: resolveUserDataPath({
      appDataPath: APP_DATA_PATH,
      appIdentifier,
      userDataOverride,
    }),
  };
}

test("unset SOFIA_DEV_PROFILE keeps the legacy dev identifier", () => {
  const profile = resolveProfile();

  assert.equal(profile.appIdentifier, DEV_APP_IDENTIFIER);
  assert.equal(profile.userDataPath, path.join(APP_DATA_PATH, DEV_APP_IDENTIFIER));
});

test("auto dev profile is stable for one worktree and different for another", () => {
  const firstPath = path.join("tmp", "worktrees", "sofia");
  const secondPath = path.join("tmp", "other", "sofia");
  const firstProfile = deriveAutoDevProfileName(firstPath);

  assert.equal(deriveAutoDevProfileName(firstPath), firstProfile);
  assert.notEqual(deriveAutoDevProfileName(secondPath), firstProfile);
  assert.match(firstProfile, /^sofia-[a-f0-9]{10}$/);
});

test("named dev profile is sanitized into the dev app identifier", () => {
  const profile = resolveProfile({ devProfile: "  Feature/Profile: 01  " });

  assert.equal(profile.appIdentifier, `${DEV_APP_IDENTIFIER}.feature-profile-01`);
  assert.equal(profile.userDataPath, path.join(APP_DATA_PATH, `${DEV_APP_IDENTIFIER}.feature-profile-01`));
});

test("SOFIA_ELECTRON_USERDATA beats SOFIA_DEV_PROFILE for the profile directory", () => {
  const explicitUserData = path.join("tmp", "explicit-user-data");
  const profile = resolveProfile({ devProfile: "auto", userDataOverride: explicitUserData });

  assert.equal(profile.userDataPath, explicitUserData);
});

test("packaged mode ignores SOFIA_DEV_PROFILE", () => {
  const profile = resolveProfile({ devProfile: "auto", isPackaged: true });

  assert.equal(profile.appIdentifier, DEV_APP_IDENTIFIER);
  assert.equal(profile.userDataPath, path.join(APP_DATA_PATH, DEV_APP_IDENTIFIER));
});

test("maps a Sofia app identifier back to its pre-rebrand spelling", () => {
  assert.equal(legacyAppIdentifierFor("com.differentai.sofia"), "com.differentai.openwork");
  assert.equal(legacyAppIdentifierFor("com.differentai.sofia.dev"), "com.differentai.openwork.dev");
  assert.equal(legacyAppIdentifierFor("com.differentai.sofia.dev.feature-01"), "com.differentai.openwork.dev.feature-01");
  assert.equal(legacyAppIdentifierFor("app.sofia.desktop"), "app.openwork.desktop");
});

test("moves a pre-rebrand profile directory into the identity Sofia reads", async () => {
  const appDataPath = mkdtempSync(path.join(tmpdir(), "sofia-userdata-"));
  try {
    const legacy = path.join(appDataPath, "com.differentai.openwork");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "sofia-workspaces.json"), "{}", "utf8");

    const moved = await migrateLegacyUserDataDir({
      appDataPath,
      appIdentifier: "com.differentai.sofia",
      userDataOverride: "",
    });

    const current = path.join(appDataPath, "com.differentai.sofia");
    assert.equal(moved, current);
    assert.equal(existsSync(path.join(current, "sofia-workspaces.json")), true);
    assert.equal(existsSync(legacy), false);
  } finally {
    rmSync(appDataPath, { recursive: true, force: true });
  }
});

test("leaves an existing Sofia profile alone when a pre-rebrand profile is present", async () => {
  const appDataPath = mkdtempSync(path.join(tmpdir(), "sofia-userdata-"));
  try {
    const legacy = path.join(appDataPath, "com.differentai.openwork");
    const current = path.join(appDataPath, "com.differentai.sofia");
    mkdirSync(legacy, { recursive: true });
    mkdirSync(current, { recursive: true });
    writeFileSync(path.join(legacy, "legacy.json"), "{}", "utf8");
    writeFileSync(path.join(current, "current.json"), "{}", "utf8");

    const moved = await migrateLegacyUserDataDir({
      appDataPath,
      appIdentifier: "com.differentai.sofia",
      userDataOverride: "",
    });

    assert.equal(moved, null);
    assert.equal(existsSync(path.join(current, "current.json")), true);
    assert.equal(existsSync(path.join(current, "legacy.json")), false);
    assert.equal(existsSync(path.join(legacy, "legacy.json")), true);
  } finally {
    rmSync(appDataPath, { recursive: true, force: true });
  }
});

test("never moves profiles when an explicit user data directory is configured", async () => {
  const appDataPath = mkdtempSync(path.join(tmpdir(), "sofia-userdata-"));
  try {
    const legacy = path.join(appDataPath, "com.differentai.openwork");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "legacy.json"), "{}", "utf8");

    const moved = await migrateLegacyUserDataDir({
      appDataPath,
      appIdentifier: "com.differentai.sofia",
      userDataOverride: path.join(appDataPath, "explicit"),
    });

    assert.equal(moved, null);
    assert.equal(existsSync(path.join(legacy, "legacy.json")), true);
  } finally {
    rmSync(appDataPath, { recursive: true, force: true });
  }
});
