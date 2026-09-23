import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appRoot = join(import.meta.dir, "..", "app", "(den)");

function read(...segments: string[]) {
  return readFileSync(join(appRoot, ...segments), "utf8");
}

const screen = read("dashboard", "_components", "marketplace-onboarding-screen.tsx");
const page = read("dashboard", "(admin)", "onboarding", "page.tsx");
const publicInstallers = read("_lib", "public-installers.ts");

describe("Marketplace onboarding page", () => {
  test("reuses the landing download card and den choice cards", () => {
    expect(screen).toContain("DownloadSofiaCard");
    expect(screen).toContain("DenChoiceCard");
    expect(screen).toContain("DenSectionHeader");
    expect(screen).toContain("DenBadge");
    expect(page).toContain("getPublicInstallers");
    expect(publicInstallers).toContain('name.startsWith("sofia-cloud-")');
    expect(publicInstallers).toContain('name.startsWith("sofia-enterprise-")');
  });

  test("offers Sofia Models and Bring your Own Keys as the model path", () => {
    expect(screen).toContain("onboarding-choice-sofia-models");
    expect(screen).toContain("onboarding-choice-byok");
    expect(screen).toContain("Turn on models");
    expect(screen).toContain("Bring your Own Keys");
    expect(screen).toContain("/sofia-mark.svg");
  });

  test("keeps the installed flag and inference check", () => {
    expect(screen).toContain("sofia:onboarding:app-installed");
    expect(screen).toContain("/v1/inference");
    expect(screen).toContain("onboarding-app-installed");
  });
});
