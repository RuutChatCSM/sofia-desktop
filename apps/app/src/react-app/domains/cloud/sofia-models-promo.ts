import { INFERENCE_MODEL_ALIASES } from "@sofia/types/den/inference";

import {
  buildDenAuthUrl,
  getDenInferenceUrl,
  isSelfHostedControlPlane,
  HOSTED_DEFAULT_DEN_BASE_URL,
  readDenBootstrapConfig,
  readDenSettings,
} from "../../../app/lib/den";
import { isDefaultControlPlaneUrl } from "../settings/cloud/control-plane-url";
import { denSettingsChangedEvent } from "../../../app/lib/den-session-events";
import { useSyncExternalStore } from "react";

export const SOFIA_MODELS_PROVIDER_ID = "sofia";
export const SOFIA_MODELS_PROVIDER_NAME = "Hosted models";
export const SOFIA_MODELS_PROMO_HIDDEN_KEY = "sofia.sofiaModelsPromo.hidden";
export const SOFIA_MODELS_PROMO_LAST_SHOWN_KEY = "sofia.sofiaModelsPromo.lastShownAt";
export const SOFIA_MODELS_STARTUP_PROMO_SHOWN_KEY = "sofia.sofiaModelsPromo.startupShown";
export const sofiaModelsPromoChangedEvent = "sofia-sofia-models-promo-changed";
export const SOFIA_MODELS_PROMO_SHOW_DELAY_MS = 4_000;
export const SOFIA_MODELS_PROMO_VISIBLE_MS = 14_000;
export const SOFIA_MODELS_PROMO_REPEAT_MS = 6 * 60 * 60 * 1000;

export function areSofiaModelsPromosDisabled() {
  if (/^(1|true|yes|on)$/i.test(String(import.meta.env.VITE_DISABLE_SOFIA_MODELS ?? "").trim())) {
    return true;
  }
  // Hosted models are a hosted Organization cloud offering; self-hosted
  // deployments should never see the upsell surfaces.
  return isSelfHostedControlPlane();
}

export function isSofiaModelsPromoEligibleForDenBaseUrl(baseUrl: string) {
  return !areSofiaModelsPromosDisabled() && isDefaultControlPlaneUrl(baseUrl, HOSTED_DEFAULT_DEN_BASE_URL);
}

export function isSofiaModelsPromoEligible() {
  return isSofiaModelsPromoEligibleForDenBaseUrl(readDenSettings().baseUrl);
}

export function useSofiaModelsPromoEligibility() {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === "undefined") return () => undefined;
      window.addEventListener(denSettingsChangedEvent, notify);
      return () => window.removeEventListener(denSettingsChangedEvent, notify);
    },
    isSofiaModelsPromoEligible,
    isSofiaModelsPromoEligible,
  );
}

export type SofiaModelPreview = {
  id: string;
  title: string;
  subtitle: string;
};

export const SOFIA_MODEL_PREVIEWS: SofiaModelPreview[] = Object.entries(
  INFERENCE_MODEL_ALIASES,
)
  .filter(([, model]) => model.enabled)
  .map(([id, model]) => ({
    id,
    title: model.displayName.replace(/^Sofia:\s*/, ""),
    subtitle: "Sofia hosted",
  }));

export function hasSofiaModelsProvider(providerIds: readonly string[]) {
  return providerIds.some((id) => id.trim().toLowerCase() === SOFIA_MODELS_PROVIDER_ID);
}

/** Local engine has Hosted models connected with at least one selectable model. */
export function hasSofiaModelsAvailable(input: {
  providerConnectedIds: readonly string[];
  providers: ReadonlyArray<{ id: string; models?: Record<string, unknown> | null }>;
}) {
  if (!hasSofiaModelsProvider(input.providerConnectedIds)) return false;
  const sofia = input.providers.find(
    (provider) => provider.id.trim().toLowerCase() === SOFIA_MODELS_PROVIDER_ID,
  );
  return Object.keys(sofia?.models ?? {}).length > 0;
}

export function shouldShowSofiaModelsSyncing(input: {
  entitled: boolean;
  available: boolean;
  workspaceReady: boolean;
  reloadPending: boolean;
}) {
  return input.entitled && !input.available && input.workspaceReady && input.reloadPending;
}

export function getSofiaModelsActionUrl(
  isSignedIn: boolean,
  authMode: "sign-in" | "sign-up" = "sign-in",
) {
  const settings = readDenSettings();
  const baseUrl = settings.baseUrl || readDenBootstrapConfig().baseUrl;
  // Signed-in users go straight to the Hosted models page — the value-prop
  // + subscribe surface — never to a bare auth or billing page.
  return isSignedIn ? getDenInferenceUrl(baseUrl) : buildDenAuthUrl(baseUrl, authMode);
}

export function isSofiaModelsPromoHidden() {
  if (areSofiaModelsPromosDisabled()) return true;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SOFIA_MODELS_PROMO_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function hideSofiaModelsPromo() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SOFIA_MODELS_PROMO_HIDDEN_KEY, "1");
    window.dispatchEvent(new Event(sofiaModelsPromoChangedEvent));
  } catch {}
}

export function wasSofiaModelsStartupPromoShown() {
  if (!isSofiaModelsPromoEligible()) return true;
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(SOFIA_MODELS_STARTUP_PROMO_SHOWN_KEY) === "1";
  } catch {
    return true;
  }
}

export function markSofiaModelsStartupPromoShown() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SOFIA_MODELS_STARTUP_PROMO_SHOWN_KEY, "1");
  } catch {}
}

export function shouldShowSofiaModelsPromo(now = Date.now()) {
  if (!isSofiaModelsPromoEligible() || typeof window === "undefined" || isSofiaModelsPromoHidden()) return false;
  try {
    const lastShown = Number(window.localStorage.getItem(SOFIA_MODELS_PROMO_LAST_SHOWN_KEY) ?? "0");
    return !Number.isFinite(lastShown) || now - lastShown >= SOFIA_MODELS_PROMO_REPEAT_MS;
  } catch {
    return true;
  }
}

export function markSofiaModelsPromoShown(now = Date.now()) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SOFIA_MODELS_PROMO_LAST_SHOWN_KEY, String(now));
  } catch {}
}
