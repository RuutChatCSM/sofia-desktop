export const deepLinkBridgeEvent = "sofia:deep-link";
export const nativeDeepLinkEvent = "sofia:deep-link-native";

export type DeepLinkBridgeDetail = {
  urls: string[];
};

declare global {
  interface Window {
    __SOFIA__?: {
      deepLinks?: string[];
    };
  }
}

function normalizeDeepLinks(urls: readonly string[]): string[] {
  return urls.flatMap((url) => {
    const trimmed = url.trim();
    return trimmed ? [trimmed] : [];
  });
}

export function pushPendingDeepLinks(target: Window, urls: readonly string[]): string[] {
  const normalized = normalizeDeepLinks(urls);
  if (normalized.length === 0) {
    return [];
  }

  target.__SOFIA__ ??= {};
  const pending = target.__SOFIA__.deepLinks ?? [];
  target.__SOFIA__.deepLinks = [...pending, ...normalized];
  target.dispatchEvent(
    new CustomEvent<DeepLinkBridgeDetail>(deepLinkBridgeEvent, {
      detail: { urls: normalized },
    }),
  );
  return normalized;
}

export function drainPendingDeepLinks(target: Window): string[] {
  const pending = target.__SOFIA__?.deepLinks ?? [];
  if (target.__SOFIA__) {
    target.__SOFIA__.deepLinks = [];
  }
  return [...pending];
}
