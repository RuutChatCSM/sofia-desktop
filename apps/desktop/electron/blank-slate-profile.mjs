import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BLANK_SLATE_FLAG = "--blank-slate";

export const BLANK_SLATE_PATH_ENV_KEYS = Object.freeze([
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "SOFIA_ELECTRON_USERDATA",
  "SOFIA_DESKTOP_BOOTSTRAP_PATH",
  "SOFIA_SERVER_CONFIG",
  "SOFIA_ENV_STORE",
  "SOFIA_TOKEN_STORE",
  "SOFIA_RUNTIME_DB",
  "SOFIA_DATA_DIR",
  "SOFIA_ENGINE_CONFIG_DIR",
  "SOFIA_ENGINE_DB",
]);

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function prepareBlankSlateProfile({
  argv,
  env = process.env,
  platform = process.platform,
  temporaryDirectory = tmpdir(),
  createTempRoot = (prefix) => mkdtempSync(prefix),
  createDirectory = (directory) => {
    mkdirSync(directory, { recursive: true });
  },
}) {
  if (!argv.includes(BLANK_SLATE_FLAG)) {
    return null;
  }

  const paths = pathApi(platform);
  const rootPath = createTempRoot(paths.join(temporaryDirectory, "sofia-test-profile-"));
  const userDataPath = paths.join(rootPath, "electron", "user-data");
  const homePath = paths.join(rootPath, "home");
  const sofiaConfigPath = paths.join(rootPath, "sofia", "config");
  const engineDataPath = paths.join(rootPath, "engine", "data");
  const environment = {
    HOME: homePath,
    USERPROFILE: homePath,
    XDG_CONFIG_HOME: paths.join(rootPath, "xdg", "config"),
    XDG_DATA_HOME: paths.join(rootPath, "xdg", "data"),
    XDG_CACHE_HOME: paths.join(rootPath, "xdg", "cache"),
    XDG_STATE_HOME: paths.join(rootPath, "xdg", "state"),
    APPDATA: paths.join(rootPath, "windows", "app-data", "roaming"),
    LOCALAPPDATA: paths.join(rootPath, "windows", "app-data", "local"),
    SOFIA_ELECTRON_USERDATA: userDataPath,
    SOFIA_DESKTOP_BOOTSTRAP_PATH: paths.join(sofiaConfigPath, "desktop-bootstrap.json"),
    SOFIA_SERVER_CONFIG: paths.join(sofiaConfigPath, "server.json"),
    SOFIA_ENV_STORE: paths.join(sofiaConfigPath, "env.json"),
    SOFIA_TOKEN_STORE: paths.join(sofiaConfigPath, "tokens.json"),
    SOFIA_RUNTIME_DB: paths.join(sofiaConfigPath, "runtime.sqlite"),
    SOFIA_DATA_DIR: paths.join(rootPath, "sofia", "data"),
    SOFIA_ENGINE_CONFIG_DIR: paths.join(rootPath, "engine", "config"),
    SOFIA_ENGINE_DB: paths.join(engineDataPath, "engine.db"),
  };

  const directories = new Set([
    userDataPath,
    homePath,
    environment.XDG_CONFIG_HOME,
    environment.XDG_DATA_HOME,
    environment.XDG_CACHE_HOME,
    environment.XDG_STATE_HOME,
    environment.APPDATA,
    environment.LOCALAPPDATA,
    sofiaConfigPath,
    environment.SOFIA_DATA_DIR,
    environment.SOFIA_ENGINE_CONFIG_DIR,
    engineDataPath,
  ]);
  for (const directory of directories) createDirectory(directory);
  Object.assign(env, environment);

  return {
    rootPath,
    userDataPath,
    homePath,
    environment,
  };
}

// This module is the first import in main.mjs. Applying the overrides during
// dependency evaluation keeps module-load path constants and runtime children
// inside the same per-launch profile.
export const processBlankSlateProfile = prepareBlankSlateProfile({
  argv: process.argv,
});

export function resolveBlankSlateLaunch({ appName, profile }) {
  if (!profile) return { enabled: false, appName, userDataPath: null };
  return {
    enabled: true,
    appName: `${appName} - Test profile`,
    ...profile,
  };
}
