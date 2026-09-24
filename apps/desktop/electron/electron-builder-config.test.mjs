import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const dirname = path.dirname(fileURLToPath(import.meta.url));

async function readConfig(name) {
  return YAML.parse(await readFile(path.resolve(dirname, "..", name), "utf8"));
}

async function readSource(name) {
  return readFile(path.resolve(dirname, "..", name), "utf8");
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("Electron distribution configs", () => {
  it("uses a stable Linux desktop identity and ships integration icons", async () => {
    const packageMetadata = JSON.parse(
      await readFile(path.resolve(dirname, "..", "package.json"), "utf8"),
    );
    const config = await readConfig("electron-builder.base.yml");
    assert.equal(packageMetadata.desktopName, "app.sofia.desktop");
    assert.equal(config.npmRebuild, false);
    assert.deepEqual(config.files.at(-1), {
      from: ".electron-runtime/node_modules",
      to: "node_modules",
    });
    assert.equal(config.linux.syncDesktopName, true);
    assert.equal(config.linux.icon, "resources/icons/linux");
    assert.deepEqual(config.linux.extraResources[0], {
      from: "resources/icons/linux",
      to: "icons/linux",
      filter: ["*.png"],
    });
  });

  it("uses the Sofia product identity and keeps the sofia deep-link protocol", async () => {
    const config = await readConfig("electron-builder.yml");
    assert.equal(config.extends, "./electron-builder.base.yml");
    assert.equal(config.appId, "app.sofia.desktop");
    assert.equal(config.productName, "Sofia App");
    assert.equal(config.protocols[0].schemes[0], "sofia");
    assert.equal(config.artifactName, "sofia-${os}-${arch}-${version}.${ext}");
  });

  it("defines an enterprise flavor with the standard app identity and release provider", async () => {
    const config = await readConfig("electron-builder.enterprise.yml");
    assert.equal(config.extends, "./electron-builder.base.yml");
    assert.equal(config.appId, "app.sofia.desktop");
    assert.equal(config.productName, "Sofia App Enterprise");
    assert.equal(config.extraMetadata.sofiaDistribution, "enterprise");
    assert.equal(config.protocols[0].schemes[0], "sofia");
    // Sofia release destinations are supplied by the release owner.
    assert.equal(config.publish, null);
    assert.equal(
      config.artifactName,
      "sofia-enterprise-${os}-${arch}-${version}.${ext}",
    );
  });

  it("defines a Cloud flavor with its own artifacts and updater channel", async () => {
    const config = await readConfig("electron-builder.cloud.yml");
    assert.equal(config.extends, "./electron-builder.base.yml");
    assert.equal(config.appId, "app.sofia.desktop");
    assert.equal(config.productName, "Sofia App Cloud");
    assert.equal(config.extraMetadata.sofiaDistribution, "cloud");
    assert.equal(config.protocols[0].schemes[0], "sofia");
    assert.equal(config.publish, null);
    assert.equal(
      config.artifactName,
      "sofia-cloud-${os}-${arch}-${version}.${ext}",
    );
  });
  it("ships the Computer Use helper under the one name the runtime, signer and packager agree on", async () => {
    const config = await readConfig("electron-builder.base.yml");
    const [helpersResource] = config.mac.extraResources.filter((entry) => entry.to === "helpers");
    const declaration = /const computerUseHelperAppName = "([^"]+)"/.exec(
      await readSource("scripts/electron-after-pack.cjs"),
    );
    assert.ok(declaration, "scripts/electron-after-pack.cjs must declare computerUseHelperAppName");
    const helperAppName = declaration[1];
    assert.deepEqual(helpersResource, {
      from: "resources/helpers",
      to: "helpers",
      filter: [`${helperAppName}/**`],
    });
    const quotedName = new RegExp(`["'\`]${escapeForRegExp(helperAppName)}["'\`]`);
    for (const source of [
      "scripts/electron-after-pack.cjs",
      "scripts/electron-after-sign.cjs",
      "scripts/prepare-computer-use-helper.mjs",
      "electron/computer-use.mjs",
      "../../packages/handsfree/test/e2e/run.mjs",
    ]) {
      assert.match(await readSource(source), quotedName, `${source} must reference ${helperAppName}`);
    }
  });
});
