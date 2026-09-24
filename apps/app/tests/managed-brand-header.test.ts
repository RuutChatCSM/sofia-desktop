import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const sidebarPath = fileURLToPath(
  new URL("../src/react-app/domains/session/sidebar/app-sidebar.tsx", import.meta.url),
);

describe("managed brand header", () => {
  test("shows the brand header only when a wordmark is supplied", () => {
    const source = readFileSync(sidebarPath, "utf8");

    expect(source).toMatch(/\{brandLogoUrl \? \([\s\S]*?data-testid="brand-logo"[\s\S]*?<img/);
    expect(source).not.toContain("brand-app-name");
    expect(source).not.toContain("useBrandAppName");
    expect(source).toMatch(/className="flex h-16 shrink-0 items-center/);
    expect(source).toMatch(/className="h-8 w-8 object-contain object-left"/);
    expect(source).toContain("DEFAULT_BRAND_LOGO_SRC");
  });
});
