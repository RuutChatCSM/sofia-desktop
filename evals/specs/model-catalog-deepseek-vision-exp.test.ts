import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const execFileAsync = promisify(execFile);

const inferenceRoot = path.resolve(import.meta.dirname, "../../ee/apps/inference");
const generatedCatalogPath = path.join(inferenceRoot, "models-site", "models", "api.json");

const VISION_MODEL_ID = "deepseek-v4-flash-vision-exp";

/**
 * ACCEPTANCE TEST for shipping DeepSeek-V4-Flash-Vision-Exp (published
 * 2026-08-21 on DeepSeek's API platform) through the OpenWork curated model
 * catalog served at models.openworklabs.com/models/api.json.
 *
 * Regression this pins: the deployed catalog lacked the new model entirely,
 * so engines merging a configured-but-unknown model synthesized default
 * capabilities with input.image=false — attachments silently degraded to
 * text and agents claimed they could not see images even though the upstream
 * API accepts them.
 *
 * Claims:
 *   1. The refreshed upstream snapshot (base.json) carries the vision model
 *      with image input (and its text-only sibling does NOT claim image).
 *   2. The real generator script produces a catalog whose deepseek provider
 *      serves that exact model shape — these are the bytes engines fetch.
 *   3. The OpenWork overlay in the same catalog exposes the model too.
 *   4. Every OpenWork overlay model has a Den inference alias, and the
 *      vision alias is enabled — an uncovered alias is unreachable in Den.
 */
test("curated catalog ships deepseek v4 flash vision exp with image input", async () => {
  const base = JSON.parse(await readFile(path.join(inferenceRoot, "src", "models", "base.json"), "utf8"));
  const deepseek = base.deepseek;
  expect(deepseek, "base.json must keep the deepseek provider").toBeTruthy();

  const vision = deepseek.models[VISION_MODEL_ID];
  expect(vision, `base.json must include ${VISION_MODEL_ID}`).toBeTruthy();
  expect(vision.modalities?.input).toContain("text");
  expect(vision.modalities?.input).toContain("image");

  const textOnlySibling = deepseek.models["deepseek-v4-flash"];
  expect(textOnlySibling.modalities?.input).toContain("text");
  expect(textOnlySibling.modalities?.input).not.toContain("image");
});

test("generated models/api.json serves the vision model exactly as engines fetch it", async () => {
  await execFileAsync(process.execPath, [path.join(inferenceRoot, "scripts", "build-models.mjs")]);
  const catalog = JSON.parse(await readFile(generatedCatalogPath, "utf8"));

  const vision = catalog.deepseek?.models?.[VISION_MODEL_ID];
  expect(vision, `generated catalog must include ${VISION_MODEL_ID} under deepseek`).toBeTruthy();
  expect(vision.modalities?.input).toEqual(["text", "image"]);
  expect(vision.attachment).toBe(true);

  const openworkOverlay = catalog.openwork?.models;
  expect(openworkOverlay, "generated catalog must expose the openwork provider").toBeTruthy();
  const overlayModel = openworkOverlay[`deepseek/${VISION_MODEL_ID}`];
  expect(overlayModel, "openwork provider must serve deepseek/deepseek-v4-flash-vision-exp").toBeTruthy();
  expect(overlayModel.modalities?.input).toEqual(["text", "image"]);
});

test("every openwork overlay model has an enabled den inference alias", async () => {
  const [{ INFERENCE_MODEL_ALIASES }, openworkModels] = await Promise.all([
    import("../../packages/types/src/den/inference.ts"),
    readFile(path.join(inferenceRoot, "src", "models", "openwork-models.json"), "utf8").then(JSON.parse),
  ]);

  const overlayIds = Object.keys(openworkModels);
  expect(overlayIds.length, "overlay must not be empty").toBeGreaterThan(0);

  const aliasIds = Object.keys(INFERENCE_MODEL_ALIASES);
  expect(aliasIds.sort()).toEqual([...overlayIds].sort());

  const visionAlias = INFERENCE_MODEL_ALIASES[`deepseek/${VISION_MODEL_ID}`];
  expect(visionAlias, `den alias must exist for deepseek/${VISION_MODEL_ID}`).toBeTruthy();
  expect(visionAlias.enabled).toBe(true);
  expect(visionAlias.upstreamModel).toBe(`deepseek/${VISION_MODEL_ID}`);
});
