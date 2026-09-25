declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toEqual: (expected: unknown) => void;
};

import {
  SOFIA_EXTENSION_CATALOG,
  filterSofiaExtensionCatalogForPlatform,
  resolveSofiaExtensionCatalogPlatform,
} from "./constants";

function filteredIds(platform: "darwin" | "linux" | "windows" | "web") {
  return filterSofiaExtensionCatalogForPlatform(SOFIA_EXTENSION_CATALOG, platform)
    .flatMap((entry) => entry.id ? [entry.id] : []);
}

describe("Sofia extension catalog platform filter", () => {
  test("resolves browser runtime to web and desktop runtime to OS", () => {
    expect(resolveSofiaExtensionCatalogPlatform("web", "macos")).toEqual("web");
    expect(resolveSofiaExtensionCatalogPlatform("desktop", "macos")).toEqual("darwin");
    expect(resolveSofiaExtensionCatalogPlatform("desktop", "windows")).toEqual("windows");
    expect(resolveSofiaExtensionCatalogPlatform("desktop", "linux")).toEqual("linux");
  });

  test("hides desktop-only extensions in web", () => {
    expect(filteredIds("web")).toEqual(["sofia-voice", "ollama"]);
  });

  test("keeps Sofia Browser desktop-only and Computer Use mac-only", () => {
    expect(filteredIds("darwin")).toEqual(["sofia-browser", "computer-use", "sofia-voice", "ollama"]);
    expect(filteredIds("linux")).toEqual(["sofia-browser", "sofia-voice", "ollama"]);
  });
});
