// Gateway runtime detection primitives. Leaf module by design: keep it import-free
// so low-level clients can choose same-origin gateway behavior without cycles.
export type SofiaGatewayMarker = {
  version?: number;
  build?: string;
};

declare global {
  interface Window {
    __SOFIA_GATEWAY__?: SofiaGatewayMarker;
  }
}

const DEN_AUTH_TOKEN_STORAGE_KEY = "sofia.den.authToken";

export function isSofiaGatewayRuntime() {
  return typeof window !== "undefined" && window.__SOFIA_GATEWAY__?.version === 1;
}

export function getSofiaGatewayBuild(): string | null {
  if (!isSofiaGatewayRuntime()) return null;
  const build = window.__SOFIA_GATEWAY__?.build?.trim() ?? "";
  return build || null;
}

export function getSofiaGatewayOrigin() {
  if (!isSofiaGatewayRuntime()) return null;
  const origin = window.location.origin.trim();
  return origin || null;
}

export function readSofiaGatewayDenToken() {
  if (!isSofiaGatewayRuntime()) return "";
  try {
    return window.localStorage.getItem(DEN_AUTH_TOKEN_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}
