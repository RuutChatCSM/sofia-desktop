declare const afterEach: (fn: () => void | Promise<void>) => void;
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
};

import { DEFAULT_DEN_BASE_URL, HOSTED_DEFAULT_DEN_BASE_URL, setDenBootstrapConfig } from "../../../app/lib/den";
import {
  hasSofiaModelsAvailable,
  isSofiaModelsPromoEligible,
  isSofiaModelsPromoEligibleForDenBaseUrl,
  shouldShowSofiaModelsPromo,
  shouldShowSofiaModelsSyncing,
  wasSofiaModelsStartupPromoShown,
} from "./sofia-models-promo";

afterEach(async () => {
  await setDenBootstrapConfig({ baseUrl: DEFAULT_DEN_BASE_URL, requireSignin: false });
});

describe("Hosted models promo eligibility", () => {
  test("allows promotions on the default Den URL after normalization", () => {
    expect(isSofiaModelsPromoEligibleForDenBaseUrl(`${HOSTED_DEFAULT_DEN_BASE_URL}/api/den/`)).toBe(true);
  });

  test("suppresses promotions for custom configured Den URLs", async () => {
    await setDenBootstrapConfig({ baseUrl: "https://custom-den.example.com", requireSignin: false });

    expect(isSofiaModelsPromoEligible()).toBe(false);
    expect(shouldShowSofiaModelsPromo()).toBe(false);
    expect(wasSofiaModelsStartupPromoShown()).toBe(true);
  });
});

describe("hasSofiaModelsAvailable", () => {
  test("requires a connected sofia provider with at least one model", () => {
    expect(
      hasSofiaModelsAvailable({
        providerConnectedIds: ["sofia"],
        providers: [{ id: "sofia", models: {} }],
      }),
    ).toBe(false);
    expect(
      hasSofiaModelsAvailable({
        providerConnectedIds: ["sofia"],
        providers: [{ id: "sofia", models: { "gpt-5": {} } }],
      }),
    ).toBe(true);
  });
});

describe("shouldShowSofiaModelsSyncing", () => {
  test("only reports a real pending workspace reload", () => {
    expect(shouldShowSofiaModelsSyncing({
      entitled: true,
      available: false,
      workspaceReady: false,
      reloadPending: true,
    })).toBe(false);
    expect(shouldShowSofiaModelsSyncing({
      entitled: true,
      available: false,
      workspaceReady: true,
      reloadPending: false,
    })).toBe(false);
    expect(shouldShowSofiaModelsSyncing({
      entitled: true,
      available: false,
      workspaceReady: true,
      reloadPending: true,
    })).toBe(true);
  });
});
