export const SOFIA_DEPLOYMENT_ENV_VAR = "VITE_SOFIA_DEPLOYMENT";

export type SofiaDeployment = "desktop" | "web";

function normalizeDeployment(value: string | undefined): SofiaDeployment {
  const normalized = value?.trim().toLowerCase();
  return normalized === "web" ? "web" : "desktop";
}

export function getSofiaDeployment(): SofiaDeployment {
  const envValue =
    typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_SOFIA_DEPLOYMENT === "string"
      ? import.meta.env.VITE_SOFIA_DEPLOYMENT
      : undefined;

  return normalizeDeployment(envValue);
}

export function isWebDeployment(): boolean {
  return getSofiaDeployment() === "web";
}

export function isDesktopDeployment(): boolean {
  return getSofiaDeployment() === "desktop";
}
