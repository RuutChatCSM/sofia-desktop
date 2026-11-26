export function isDockPath(pathname: string): boolean {
  return pathname === "/dock" || pathname.startsWith("/dock/");
}

/** Detect the dock before React mounts so its html/body are transparent. */
export function isDockDocumentLocation(): boolean {
  if (typeof window === "undefined") return false;
  const hash = window.location.hash;
  if (hash.startsWith("#/")) return isDockPath(hash.slice(1).split("?")[0] ?? "");
  return isDockPath(window.location.pathname);
}
