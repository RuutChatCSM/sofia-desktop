import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const srcRoot = join(appRoot, "src");
const publicRoot = join(appRoot, "public");

/**
 * The packaged desktop build loads the renderer with `loadFile(app-dist/index.html)`,
 * so the document origin is `file://`. Vite rewrites root-absolute asset URLs in
 * index.html (base `./`) but never rewrites string literals in JS, so a
 * `/sofia-mark.png` written in a component resolves to `file:///sofia-mark.png`
 * and renders as a broken image. Brand assets must go through
 * `resolveExtensionIconSrc`, which prefixes `import.meta.env.BASE_URL`.
 */
const ROOT_ABSOLUTE_ASSET =
  /(?:src|href)=\{?["'`]\/[^"'`]*\.(?:svg|png|jpg|jpeg|webp|gif|ico)|url\(\/[^)]*\.(?:svg|png|jpg|jpeg|webp|gif|ico)/;
const BASE_AWARE_RESOLVER = "resolveExtensionIconSrc(";

/** Public asset paths referenced as Vue/JSX string literals, e.g. `"/sofia-mark.png"`. */
const PUBLIC_ASSET_REFERENCE = /["'`](\/[A-Za-z0-9_.\-]+\.(?:svg|png|jpg|jpeg|webp|gif|ico|webmanifest))["'`]/g;

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(file));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      files.push(file);
    }
  }
  return files;
}

function referencedPublicAssets(): { asset: string; source: string }[] {
  const sources = [
    join(appRoot, "index.html"),
    join(publicRoot, "manifest.webmanifest"),
    ...collectSourceFiles(srcRoot),
  ];
  const references: { asset: string; source: string }[] = [];
  for (const file of sources) {
    const contents = readFileSync(file, "utf8");
    for (const match of contents.matchAll(PUBLIC_ASSET_REFERENCE)) {
      references.push({ asset: match[1], source: relative(appRoot, file).split(sep).join("/") });
    }
  }
  return references;
}

describe("packaged renderer asset paths", () => {
  test("resolves every root-absolute asset URL against the build base", () => {
    const offenders: string[] = [];

    for (const file of collectSourceFiles(srcRoot)) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!ROOT_ABSOLUTE_ASSET.test(line)) return;
        if (line.includes(BASE_AWARE_RESOLVER)) return;
        offenders.push(`${relative(srcRoot, file).split(sep).join("/")}:${index + 1}`);
      });
    }

    expect(offenders).toEqual([]);
  });

  test("every referenced public asset is actually shipped", () => {
    const missing = referencedPublicAssets()
      .filter(({ asset }) => !existsSync(join(publicRoot, asset.replace(/^\//, ""))))
      .map(({ asset, source }) => `${source} references ${asset}, which is not in public/`);

    expect(missing).toEqual([]);
  });

  test("the brand logo default goes through the resolver", () => {
    const brandTheme = readFileSync(
      join(srcRoot, "react-app/domains/cloud/brand-theme.tsx"),
      "utf8",
    );

    expect(brandTheme.includes('DEFAULT_BRAND_LOGO_SRC = resolveExtensionIconSrc("/sofia-mark')).toBe(true);
  });

  /**
   * The monochrome marks ship as two real vector variants: a black
   * `sofia-mark.svg` for light surfaces and a white `sofia-mark-inverse.svg`
   * for dark ones. They must stay the same artwork with only the fill swapped,
   * because recolouring the colour raster with a CSS filter is what this pair
   * replaced.
   */
  test("the monochrome Sofia marks are one artwork in two fills", () => {
    const paths = (svg: string) =>
      [...svg.matchAll(/<path[^>]*d="([^"]+)"[^>]*fill="([^"]+)"/g)].map((match) => [match[1], match[2]]);

    const black = paths(readFileSync(join(publicRoot, "sofia-mark.svg"), "utf8"));
    const white = paths(readFileSync(join(publicRoot, "sofia-mark-inverse.svg"), "utf8"));

    expect(black.map(([, fill]) => fill)).toEqual(["#171717", "#171717"]);
    expect(white.map(([, fill]) => fill)).toEqual(["white", "white"]);
    expect(white.map(([d]) => d)).toEqual(black.map(([d]) => d));
  });

  test("brand marks are never recoloured with a CSS filter", () => {
    const css = readFileSync(join(srcRoot, "app/index.css"), "utf8");

    expect(css).not.toContain("brightness(0)");
  });
});
