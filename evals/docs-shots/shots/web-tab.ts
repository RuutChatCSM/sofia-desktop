import { waitFor } from "@sofia/behaviors";
import { webTab } from "../surfaces.ts";
import { shot } from "./shot.ts";

const browser = webTab();

async function waitForSofiaWeb(surface: Awaited<ReturnType<typeof browser.load>>): Promise<void> {
  await waitFor(surface, "Boolean(window.__sofiaControl)", {
    timeoutMs: 120_000,
    label: "Sofia Web booted",
  });
  await waitFor(surface, `document.body.innerText.includes("acme-robotics")
    && document.body.innerText.includes("Describe your task")
    && !document.body.innerText.includes("Pulling in the latest messages")`, {
    timeoutMs: 120_000,
    label: "Sofia Web settled on the demo workspace",
  });
}

export const sofiaWebTab = shot("sofia-web-tab", {
  use: browser,
  at: "/",
  steps: [waitForSofiaWeb],
  expect: ["acme-robotics", "What do you need done?"],
  never: ["Something went wrong", "Unable to connect", "docs-3959-screenshots"],
  out: "packages/docs/images/sofia-web-browser-tab.png",
});
