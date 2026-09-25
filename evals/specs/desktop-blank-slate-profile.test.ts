import { rm } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { test } from "@sofia/testkit";
import {
  BLANK_SLATE_PATH_ENV_KEYS,
  prepareBlankSlateProfile,
  resolveBlankSlateLaunch,
} from "../../apps/desktop/electron/blank-slate-profile.mjs";

test("any desktop build can launch with an isolated blank-slate profile", async ({ evidence }) => {
  const normalEnv: NodeJS.ProcessEnv = {
    HOME: "/Users/installed",
    SOFIA_DESKTOP_BOOTSTRAP_PATH: "/Users/installed/.config/sofia/desktop-bootstrap.json",
  };
  const originalNormalEnv = { ...normalEnv };
  const normalProfile = prepareBlankSlateProfile({ argv: [], env: normalEnv });
  const normal = resolveBlankSlateLaunch({ appName: "Sofia Enterprise", profile: normalProfile });
  expect(normal).toEqual({ enabled: false, appName: "Sofia Enterprise", userDataPath: null });
  expect(normalEnv).toEqual(originalNormalEnv);

  const firstEnv: NodeJS.ProcessEnv = { SOFIA_DESKTOP_DISTRIBUTION: "enterprise" };
  const secondEnv: NodeJS.ProcessEnv = {};
  const firstProfile = prepareBlankSlateProfile({ argv: ["--blank-slate"], env: firstEnv });
  const secondProfile = prepareBlankSlateProfile({ argv: ["--blank-slate"], env: secondEnv });
  const first = resolveBlankSlateLaunch({ appName: "Sofia Enterprise", profile: firstProfile });
  const second = resolveBlankSlateLaunch({ appName: "Sofia Enterprise", profile: secondProfile });

  try {
    expect(first.enabled).toBe(true);
    expect(first.appName).toBe("Sofia Enterprise - Test profile");
    expect(first.rootPath).not.toBe(second.rootPath);
    expect(first.userDataPath).not.toContain("com.differentai.sofia");

    const allPathOverridesIsolated = BLANK_SLATE_PATH_ENV_KEYS.every((key) => {
      const value = firstEnv[key];
      if (!value) return false;
      const relative = path.relative(first.rootPath, value);
      return Boolean(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    });
    expect(allPathOverridesIsolated).toBe(true);
    expect(firstEnv.SOFIA_DESKTOP_BOOTSTRAP_PATH).toBe(first.environment.SOFIA_DESKTOP_BOOTSTRAP_PATH);

    const packageFlavorPreserved = firstEnv.SOFIA_DESKTOP_DISTRIBUTION === "enterprise"
      && !("SOFIA_DEV_MODE" in firstEnv)
      && first.appName.startsWith("Sofia Enterprise");
    expect(packageFlavorPreserved).toBe(true);

    const normalLaunchUnchanged = normal.userDataPath === null
      && normal.appName === "Sofia Enterprise"
      && normalEnv.SOFIA_DESKTOP_BOOTSTRAP_PATH === originalNormalEnv.SOFIA_DESKTOP_BOOTSTRAP_PATH;
    expect(normalLaunchUnchanged).toBe(true);

    evidence.recordAssertionEvidence(
      "Blank-slate launches cannot read or overwrite the installed profile",
      "Every Electron, Sofia, Sofia engine, home, XDG, and Windows mutable path is below one unique per-launch temporary root.",
      allPathOverridesIsolated && first.rootPath !== second.rootPath,
    );
    evidence.recordAssertionEvidence(
      "Blank-slate isolates desktop bootstrap before workspace startup",
      "SOFIA_DESKTOP_BOOTSTRAP_PATH points inside the temporary root, so an installed localhost bootstrap cannot bypass Enterprise activation.",
      firstEnv.SOFIA_DESKTOP_BOOTSTRAP_PATH === first.environment.SOFIA_DESKTOP_BOOTSTRAP_PATH,
    );
    evidence.recordAssertionEvidence(
      "Package flavor is preserved without development mode",
      "Enterprise remains Enterprise and the blank-slate profile does not set SOFIA_DEV_MODE.",
      packageFlavorPreserved,
    );
    evidence.recordAssertionEvidence(
      "Normal desktop launches remain unchanged",
      "Without --blank-slate no temporary profile or process environment override is applied.",
      normalLaunchUnchanged,
    );
  } finally {
    await Promise.all([
      rm(first.rootPath, { recursive: true, force: true }),
      rm(second.rootPath, { recursive: true, force: true }),
    ]);
  }
});
