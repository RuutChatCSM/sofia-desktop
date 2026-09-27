/** Rails owns registration and the one-use desktop handoff. The same handoff
 * also works in local web previews through the existing paste-code UI. */
export function buildCloudAuthUrl(baseUrl: string, mode: "sign-in" | "sign-up"): string {
  const target = new URL(baseUrl);
  target.pathname = `${target.pathname.replace(/\/+$/, "")}${mode === "sign-up" ? "/registration/new" : "/desktop/authorize"}`;
  target.search = "";
  target.hash = "";
  target.searchParams.set("desktopAuth", "1");
  return target.toString();
}
