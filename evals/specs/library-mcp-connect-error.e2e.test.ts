import { expect } from "vitest";
import { evalIn, waitFor } from "@sofia/behaviors";
import { app, eventually, mcpMock, needs, server, test, unmetNeeds } from "@sofia/testkit";
import type { TestNeeds } from "@sofia/testkit";

const requirements: TestNeeds = {
  optIn: ["SOFIA_EVAL_E2E_TESTS", "SOFIA_EVAL_LOCAL_MANAGED_MCP"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `Library managed MCP connect error skipped — needs: ${missingRequirements.join(", ")}`
  : "Library keeps a failed managed MCP out and connects it after the URL is fixed";
const safeConnectionFailure =
  "Sofia App could not connect to this MCP server. Check its OAuth settings and availability, then try again.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test(title, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({
    place,
    org: {
      name: `Library MCP connect error ${Date.now()}`,
      admin: { name: "Sarah" },
    },
    mocks: {
      connector: mcpMock({ profileId: "synthetic-enterprise-oauth-mcp" }),
    },
  });
  await using desktop = await app({ den, as: "admin", place });
  const timestamp = Date.now();
  const name = `lib-connect-err-${timestamp}`;
  const invalidHostname = `managed-mcp-${timestamp}.invalid`;
  const invalidUrl = `https://${invalidHostname}/mcp`;

  await waitFor(
    desktop,
    `(() => {
      const ready = window.location.hash.includes("/extensions")
        && [...document.querySelectorAll("h1, h2")].some((heading) => heading.textContent?.trim() === "Library");
      if (!ready) window.location.hash = ${JSON.stringify(`#${`/workspace/${desktop.workspaceId}/settings/extensions`}`)};
      return ready;
    })()`,
    { timeoutMs: 60_000, label: "Library settings page" },
  );

  const expandedAdvanced = await evalIn(desktop, `(() => {
    const advanced = [...document.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").includes("Advanced settings"));
    if (!(advanced instanceof HTMLButtonElement)) return false;
    advanced.click();
    return true;
  })()`);
  expect(expandedAdvanced).toBe(true);
  await waitFor(
    desktop,
    `document.body.innerText.includes("Config file") && !document.body.innerText.includes("Not loaded yet")`,
    { timeoutMs: 30_000, label: "workspace MCP config loaded" },
  );
  await waitFor(
    desktop,
    `[...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Add workspace MCP")`,
    { timeoutMs: 10_000, label: "Add workspace MCP action" },
  );
  const openedDialog = await evalIn(desktop, `(() => {
    const add = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Add workspace MCP");
    if (!(add instanceof HTMLButtonElement)) return false;
    add.click();
    return true;
  })()`);
  expect(openedDialog).toBe(true);
  await waitFor(desktop, `Boolean(document.querySelector('[role="dialog"]'))`, {
    timeoutMs: 10_000,
    label: "Add workspace MCP dialog",
  });

  const filledName = await evalIn(desktop, `(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) return null;
    const nameInput = [...dialog.querySelectorAll("input")]
      .find((input) => input.labels?.[0]?.textContent?.includes("App name"));
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!(nameInput instanceof HTMLInputElement) || !setValue) return null;
    setValue.call(nameInput, ${JSON.stringify(name)});
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    return nameInput.value;
  })()`);
  expect(filledName).toBe(name);

  const filledInvalidUrl = await evalIn(desktop, `(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) return null;
    const urlInput = [...dialog.querySelectorAll("input")]
      .find((input) => input.labels?.[0]?.textContent?.includes("Server URL"));
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!(urlInput instanceof HTMLInputElement) || !setValue) return null;
    setValue.call(urlInput, ${JSON.stringify(invalidUrl)});
    urlInput.dispatchEvent(new Event("input", { bubbles: true }));
    return urlInput.value;
  })()`);
  expect(filledInvalidUrl).toBe(invalidUrl);
  await waitFor(desktop, `(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) return false;
    const inputs = [...dialog.querySelectorAll("input")];
    const nameInput = inputs.find((input) => input.labels?.[0]?.textContent?.includes("App name"));
    const urlInput = inputs.find((input) => input.labels?.[0]?.textContent?.includes("Server URL"));
    return nameInput?.value === ${JSON.stringify(name)} && urlInput?.value === ${JSON.stringify(invalidUrl)};
  })()`, {
    timeoutMs: 10_000,
    label: "managed MCP name and invalid URL values",
  });

  const expandedOAuth = await evalIn(desktop, `(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) return null;
    const oauth = [...dialog.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").includes("OAuth on this device"));
    if (!(oauth instanceof HTMLButtonElement)) return null;
    oauth.click();
    return "OAuth on this device";
  })()`);
  expect(expandedOAuth).toBe("OAuth on this device");
  await waitFor(desktop, `document.querySelector('[role="dialog"]')?.textContent?.includes("OAuth client ID")`, {
    timeoutMs: 10_000,
    label: "OAuth on this device fields",
  });
  await waitFor(desktop, `(async () => {
    const info = await window.__SOFIA_ELECTRON__?.invokeDesktop?.("sofiaServerInfo");
    const baseUrl = String(info?.baseUrl ?? info?.connectUrl ?? "").trim();
    const token = String(info?.ownerToken ?? info?.clientToken ?? "").trim();
    return Boolean(baseUrl && token);
  })()`, {
    awaitPromise: true,
    timeoutMs: 60_000,
    label: "local Sofia App server credentials before managed MCP submission",
  });

  const submittedInvalidUrl = await evalIn(desktop, `(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) return false;
    const submit = [...dialog.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Add App");
    if (!(submit instanceof HTMLButtonElement)) return false;
    submit.click();
    return true;
  })()`);
  expect(submittedInvalidUrl).toBe(true);

  const failureText = await eventually(async () => {
    const value = await evalIn(desktop, `document.querySelector('[role="dialog"]')?.textContent?.trim() ?? ""`);
    return typeof value === "string" ? value : "";
  }, {
    within: 60_000,
    intervalMs: 500,
    label: "managed MCP discovery failure in the open dialog",
    until: (text) => text.includes(safeConnectionFailure),
  });
  expect(failureText).toContain(safeConnectionFailure);
  expect(await evalIn(desktop, `Boolean(document.querySelector('[role="dialog"]'))`)).toBe(true);
  console.log(`[library-mcp-connect-error] dialog failure: ${failureText}`);

  const revealedFailure = await evalIn(desktop, `(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) return false;
    const error = [...dialog.querySelectorAll("div")].find((entry) =>
      (entry.textContent ?? "").includes(${JSON.stringify(safeConnectionFailure)})
      && ![...entry.children].some((child) => (child.textContent ?? "").includes(${JSON.stringify(safeConnectionFailure)}))
    );
    if (!(error instanceof HTMLElement)) return false;
    error.scrollIntoView({ block: "center" });
    return true;
  })()`);
  expect(revealedFailure).toBe(true);
  evidence.recordAssertionEvidence(
    "The add dialog stays open and shows a safe connection failure",
    "The open Add workspace MCP dialog showed the safe retry message after the invalid URL failed.",
    revealedFailure && failureText.includes(safeConnectionFailure),
  );

  const absent = await evalIn(desktop, `(async () => {
    const info = await window.__SOFIA_ELECTRON__?.invokeDesktop?.("sofiaServerInfo");
    const baseUrl = String(info?.baseUrl ?? info?.connectUrl ?? "").replace(/\\/+$/, "");
    const token = String(info?.ownerToken ?? info?.clientToken ?? "");
    if (!baseUrl || !token) return { ok: false, error: "Local server credentials unavailable" };
    const headers = { authorization: "Bearer " + token };
    const statusResponse = await fetch(
      baseUrl + "/workspace/${encodeURIComponent(desktop.workspaceId)}/mcp/${encodeURIComponent(name)}/managed",
      { headers },
    );
    const listResponse = await fetch(
      baseUrl + "/workspace/${encodeURIComponent(desktop.workspaceId)}/mcp",
      { headers },
    );
    const listBody = await listResponse.json();
    const items = Array.isArray(listBody?.items) ? listBody.items : [];
    return {
      ok: true,
      status: statusResponse.status,
      listStatus: listResponse.status,
      count: items.filter((item) => item?.name === ${JSON.stringify(name)}).length,
    };
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  expect(absent).toMatchObject({ ok: true, status: 404, listStatus: 200, count: 0 });
  evidence.recordAssertionEvidence(
    "A failed managed MCP attempt leaves no connection behind",
    `${name} returned 404 from managed status and appeared zero times in the workspace MCP list.`,
    isRecord(absent) && absent.status === 404 && absent.count === 0,
  );

  const filledRetryUrl = await evalIn(desktop, `(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) return null;
    const urlInput = [...dialog.querySelectorAll("input")]
      .find((input) => input.labels?.[0]?.textContent?.includes("Server URL"));
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!(urlInput instanceof HTMLInputElement) || !setValue) return null;
    setValue.call(urlInput, ${JSON.stringify(den.mocks.connector.mcpUrl)});
    urlInput.dispatchEvent(new Event("input", { bubbles: true }));
    return urlInput.value;
  })()`);
  expect(filledRetryUrl).toBe(den.mocks.connector.mcpUrl);
  await waitFor(desktop, `(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) return false;
    const urlInput = [...dialog.querySelectorAll("input")]
      .find((input) => input.labels?.[0]?.textContent?.includes("Server URL"));
    return urlInput?.value === ${JSON.stringify(den.mocks.connector.mcpUrl)};
  })()`, {
    timeoutMs: 10_000,
    label: "managed MCP retry URL value",
  });

  const retried = await evalIn(desktop, `(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!(dialog instanceof HTMLElement)) return false;
    const submit = [...dialog.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Add App");
    if (!(submit instanceof HTMLButtonElement)) return false;
    submit.click();
    return true;
  })()`);
  expect(retried).toBe(true);

  const pending = await eventually(async () => {
    const value = await evalIn(desktop, `(async () => {
      const info = await window.__SOFIA_ELECTRON__?.invokeDesktop?.("sofiaServerInfo");
      const baseUrl = String(info?.baseUrl ?? info?.connectUrl ?? "").replace(/\\/+$/, "");
      const token = String(info?.ownerToken ?? info?.clientToken ?? "");
      if (!baseUrl || !token) return { ok: false, error: "Local server credentials unavailable" };
      const response = await fetch(
        baseUrl + "/workspace/${encodeURIComponent(desktop.workspaceId)}/mcp/${encodeURIComponent(name)}/managed",
        { headers: { authorization: "Bearer " + token } },
      );
      const body = response.ok ? await response.json() : null;
      return { ok: response.ok, statusCode: response.status, status: body?.status };
    })()`, { awaitPromise: true, timeoutMs: 30_000 });
    return isRecord(value) ? value : {};
  }, {
    within: 30_000,
    intervalMs: 100,
    label: "managed MCP retry reaches needs_auth or auto-connects",
    until: (value) => value.ok === true && (value.status === "needs_auth" || value.status === "connected"),
  });
  expect(pending).toMatchObject({ ok: true, statusCode: 200 });
  expect(["needs_auth", "connected"]).toContain(pending.status);

  if (pending.status === "needs_auth") {
    const started = await evalIn(desktop, `(async () => {
      const info = await window.__SOFIA_ELECTRON__?.invokeDesktop?.("sofiaServerInfo");
      const baseUrl = String(info?.baseUrl ?? info?.connectUrl ?? "").replace(/\\/+$/, "");
      const token = String(info?.ownerToken ?? info?.clientToken ?? "");
      if (!baseUrl || !token) return { ok: false, error: "Local server credentials unavailable" };
      const response = await fetch(
        baseUrl + "/workspace/${encodeURIComponent(desktop.workspaceId)}/mcp/${encodeURIComponent(name)}/managed/connect",
        { method: "POST", headers: { authorization: "Bearer " + token } },
      );
      return { ok: response.ok, status: response.status, body: await response.json() };
    })()`, { awaitPromise: true, timeoutMs: 60_000 });
    if (!isRecord(started) || !isRecord(started.body) || typeof started.body.authorizeUrl !== "string") {
      throw new Error(`Managed MCP connect response was invalid: ${JSON.stringify(started)}`);
    }
    expect(started.ok).toBe(true);
    expect(started.body.status).toBe("needs_auth");

    const authorization = await fetch(started.body.authorizeUrl, { redirect: "manual" });
    expect(authorization.status).toBe(302);
    const callbackUrl = authorization.headers.get("location");
    if (!callbackUrl) throw new Error("Managed MCP authorization did not return a callback Location");
    const callback = await fetch(callbackUrl);
    expect(callback.ok).toBe(true);
  }

  await waitFor(desktop, `!document.querySelector('[role="dialog"]')`, {
    timeoutMs: 90_000,
    label: "dialog closes after managed MCP authorization completes",
  });

  const connected = await eventually(async () => {
    const value = await evalIn(desktop, `(async () => {
      const info = await window.__SOFIA_ELECTRON__?.invokeDesktop?.("sofiaServerInfo");
      const baseUrl = String(info?.baseUrl ?? info?.connectUrl ?? "").replace(/\\/+$/, "");
      const token = String(info?.ownerToken ?? info?.clientToken ?? "");
      if (!baseUrl || !token) return { ok: false };
      const headers = { authorization: "Bearer " + token };
      const statusResponse = await fetch(
        baseUrl + "/workspace/${encodeURIComponent(desktop.workspaceId)}/mcp/${encodeURIComponent(name)}/managed",
        { headers },
      );
      const listResponse = await fetch(baseUrl + "/workspace/${encodeURIComponent(desktop.workspaceId)}/mcp", { headers });
      const statusBody = await statusResponse.json();
      const listBody = await listResponse.json();
      const items = Array.isArray(listBody?.items) ? listBody.items : [];
      return {
        ok: statusResponse.ok && listResponse.ok,
        status: statusBody?.status,
        hasCredential: statusBody?.hasCredential,
        enabled: statusBody?.enabled,
        count: items.filter((item) => item?.name === ${JSON.stringify(name)}).length,
      };
    })()`, { awaitPromise: true, timeoutMs: 30_000 });
    return isRecord(value) ? value : {};
  }, {
    within: 60_000,
    intervalMs: 500,
    label: "managed MCP connected status and one list entry",
    until: (value) => value.status === "connected"
      && value.hasCredential === true
      && value.enabled === true
      && value.count === 1,
  });
  expect(connected).toMatchObject({ status: "connected", hasCredential: true, enabled: true, count: 1 });
  expect(await evalIn(desktop, `!document.querySelector('[role="dialog"]')`)).toBe(true);
  evidence.recordAssertionEvidence(
    "Fixing the URL connects exactly one managed MCP",
    `${name} reported connected, hasCredential=true, enabled=true, and appeared once in the workspace MCP list.`,
    connected.status === "connected"
      && connected.hasCredential === true
      && connected.enabled === true
      && connected.count === 1,
  );

  await waitFor(desktop, `document.body.innerText.includes(${JSON.stringify(name)})`, {
    timeoutMs: 60_000,
    label: "connected MCP visible in Library",
  });
  const connectedVisible = await evalIn(desktop, `document.body.innerText.includes(${JSON.stringify(name)})`);
  expect(connectedVisible).toBe(true);
  evidence.recordAssertionEvidence(
    "The Library shows the connected managed MCP after recovery",
    `${name} was visible in the Library after the corrected connection completed and the add dialog closed.`,
    connectedVisible === true,
  );
});
