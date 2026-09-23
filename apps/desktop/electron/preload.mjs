import { contextBridge, ipcRenderer } from "electron";

const NATIVE_DEEP_LINK_EVENT = "sofia:deep-link-native";
const NATIVE_MENU_OPEN_SETTINGS_EVENT = "sofia:native-menu:open-settings";
const NATIVE_MENU_TOGGLE_SIDEBAR_EVENT = "sofia:native-menu:toggle-sidebar";
const NATIVE_MENU_CHECK_UPDATES_EVENT = "sofia:native-menu:check-updates";
const NATIVE_MENU_ZOOM_EVENT = "sofia:native-menu:zoom";
const AUTOMATION_RUNNER_CREDENTIAL_REJECTED_EVENT = "sofia:automation-runner:credential-rejected";

function normalizePlatform(value) {
  if (value === "darwin" || value === "linux") return value;
  if (value === "win32") return "windows";
  return "linux";
}

function applyShellDocumentMarkers() {
  try {
    const root = document?.documentElement;
    if (!root) return false;

    root.dataset.sofiaShell = "electron";
    root.classList.add("sofia-electron");
    if (process.platform === "darwin") {
      root.classList.add("sofia-platform-mac");
    } else if (process.platform === "win32") {
      root.classList.add("sofia-platform-windows");
    } else if (process.platform === "linux") {
      root.classList.add("sofia-platform-linux");
    }
    return true;
  } catch {
    return false;
  }
}

function notifyMenuOverlayDismiss() {
  ipcRenderer.send("sofia:menu-overlay:dismiss");
}

function installMenuOverlayDismissListeners() {
  try {
    const target = window;
    target.addEventListener("pointerdown", notifyMenuOverlayDismiss, { capture: true });
    target.addEventListener("wheel", notifyMenuOverlayDismiss, { capture: true, passive: true });
    target.addEventListener("keydown", notifyMenuOverlayDismiss, { capture: true });
    return true;
  } catch {
    return false;
  }
}

let desktopBootstrap = null;
let desktopDistribution = null;
try {
  desktopBootstrap = ipcRenderer.sendSync("sofia:desktop-bootstrap-sync");
  desktopDistribution = ipcRenderer.sendSync("sofia:desktop-distribution-sync");
} catch {
  desktopBootstrap = null;
  desktopDistribution = null;
}

contextBridge.exposeInMainWorld("__SOFIA_ELECTRON__", {
  invokeDesktop(command, ...args) {
    return ipcRenderer.invoke("sofia:desktop", command, ...args);
  },
  automationRunner: {
    onCredentialRejected(callback) {
      const handler = () => callback();
      ipcRenderer.on(AUTOMATION_RUNNER_CREDENTIAL_REJECTED_EVENT, handler);
      return () => ipcRenderer.removeListener(AUTOMATION_RUNNER_CREDENTIAL_REJECTED_EVENT, handler);
    },
  },
  shell: {
    openExternal(url) {
      return ipcRenderer.invoke("sofia:shell:openExternal", url);
    },
    relaunch() {
      return ipcRenderer.invoke("sofia:shell:relaunch");
    },
  },
  system: {
    getArchitectureInfo() {
      return ipcRenderer.invoke("sofia:system:architecture");
    },
    getMicrophoneStatus() {
      return ipcRenderer.invoke("sofia:system:microphoneStatus");
    },
    askMicrophoneAccess() {
      return ipcRenderer.invoke("sofia:system:askMicrophoneAccess");
    },
  },
  migration: {
    readSnapshot() {
      return ipcRenderer.invoke("sofia:migration:read");
    },
    ackSnapshot() {
      return ipcRenderer.invoke("sofia:migration:ack");
    },
  },
  brandIcon: {
    apply(url) {
      return ipcRenderer.invoke("sofia:desktop", "__applyBrandIcon", url ?? null);
    },
    getState() {
      return ipcRenderer.invoke("sofia:desktop", "__getBrandIconState");
    },
  },
  dev: {
    evalRelaunch() {
      return ipcRenderer.invoke("sofia:desktop", "__evalRelaunch");
    },
  },
  nuke: {
    preview(options) {
      return ipcRenderer.invoke("sofia:desktop", "nukeSofiaAndOpencodeConfigPreview", options);
    },
    execute(options) {
      return ipcRenderer.invoke("sofia:desktop", "nukeSofiaAndOpencodeConfigAndExit", options);
    },
  },
  updater: {
    getChannel() {
      return ipcRenderer.invoke("sofia:updater:getChannel");
    },
    setChannel(channel) {
      return ipcRenderer.invoke("sofia:updater:setChannel", channel);
    },
    check(channel, targetVersion) {
      return ipcRenderer.invoke("sofia:updater:check", channel, targetVersion);
    },
    download() {
      return ipcRenderer.invoke("sofia:updater:download");
    },
    installAndRestart() {
      return ipcRenderer.invoke("sofia:updater:installAndRestart");
    },
    /** Subscribe to incremental download progress from electron-updater. */
    onDownloadProgress(callback) {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on("sofia:updater:download-progress", handler);
      return () => {
        ipcRenderer.removeListener("sofia:updater:download-progress", handler);
      };
    },
  },
  recovery: {
    recordHealthy() {
      return ipcRenderer.invoke("sofia:recovery:recordHealthy");
    },
    list(policy) {
      return ipcRenderer.invoke("sofia:recovery:list", policy);
    },
    restorePrevious() {
      return ipcRenderer.invoke("sofia:recovery:restorePrevious");
    },
    use(id) {
      return ipcRenderer.invoke("sofia:recovery:use", id);
    },
  },
  browser: {
    show(bounds) { return ipcRenderer.invoke("sofia:browser:show", bounds); },
    hide() { return ipcRenderer.invoke("sofia:browser:hide"); },
    openUrl(url, provider) { return ipcRenderer.invoke("sofia:browser:openUrl", url, provider); },
    navigate(url) { return ipcRenderer.invoke("sofia:browser:navigate", url); },
    back() { return ipcRenderer.invoke("sofia:browser:back"); },
    forward() { return ipcRenderer.invoke("sofia:browser:forward"); },
    reload() { return ipcRenderer.invoke("sofia:browser:reload"); },
    setBounds(bounds) { return ipcRenderer.invoke("sofia:browser:bounds", bounds); },
    getState() { return ipcRenderer.invoke("sofia:browser:state"); },
    createTab(url) { return ipcRenderer.invoke("sofia:browser:createTab", url); },
    closeTab(tabId) { return ipcRenderer.invoke("sofia:browser:closeTab", tabId); },
    closeAllTabs() { return ipcRenderer.invoke("sofia:browser:closeAllTabs"); },
    selectTab(tabId) { return ipcRenderer.invoke("sofia:browser:selectTab", tabId); },
    reorderTabs(tabIds) { return ipcRenderer.invoke("sofia:browser:reorderTabs", tabIds); },
    listTabs() { return ipcRenderer.invoke("sofia:browser:listTabs"); },
    setProxy(proxy) { return ipcRenderer.invoke("sofia:browser:setProxy", proxy); },
    getProxy() { return ipcRenderer.invoke("sofia:browser:getProxy"); },
    showTabContextMenu(tabId, point) { return ipcRenderer.invoke("sofia:browser:tabContextMenu", tabId, point); },
    destroy() { return ipcRenderer.invoke("sofia:browser:destroy"); },
    onStateChange(callback) {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on("sofia:browser:state", handler);
      return () => ipcRenderer.removeListener("sofia:browser:state", handler);
    },
    onPanelOpened(callback) {
      const handler = () => callback();
      ipcRenderer.on("sofia:browser:panel-opened", handler);
      return () => ipcRenderer.removeListener("sofia:browser:panel-opened", handler);
    },
    onPanelClosed(callback) {
      const handler = () => callback();
      ipcRenderer.on("sofia:browser:panel-closed", handler);
      return () => ipcRenderer.removeListener("sofia:browser:panel-closed", handler);
    },
  },
  terminal: {
    create(options) { return ipcRenderer.invoke("sofia:terminal:create", options); },
    write(terminalId, data) { return ipcRenderer.invoke("sofia:terminal:write", terminalId, data); },
    resize(terminalId, cols, rows) { return ipcRenderer.invoke("sofia:terminal:resize", terminalId, cols, rows); },
    kill(terminalId) { return ipcRenderer.invoke("sofia:terminal:kill", terminalId); },
    onData(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("sofia:terminal:data", handler);
      return () => ipcRenderer.removeListener("sofia:terminal:data", handler);
    },
    onExit(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("sofia:terminal:exit", handler);
      return () => ipcRenderer.removeListener("sofia:terminal:exit", handler);
    },
  },
  meta: {
    desktopBootstrap,
    distribution: desktopDistribution,
    initialDeepLinks: [],
    platform: normalizePlatform(process.platform),
    version: process.versions.electron,
    evalFatalBootstrapFailure: process.env.SOFIA_EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE ?? null,
  },
});

if (
  process.env.SOFIA_EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE
  && (process.env.SOFIA_EVAL_RECOVERY_CANDIDATES || process.env.SOFIA_EVAL_RECOVERY_RELEASES)
) {
  contextBridge.exposeInMainWorld("__sofiaRecoveryControl", {
    snapshot() {
      return ipcRenderer.invoke("sofia:recovery:evalSnapshot");
    },
    select(id) {
      return ipcRenderer.invoke("sofia:recovery:use", id);
    },
  });
}

ipcRenderer.on(NATIVE_DEEP_LINK_EVENT, (_event, urls) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NATIVE_DEEP_LINK_EVENT, { detail: urls }));
});

ipcRenderer.on(NATIVE_MENU_OPEN_SETTINGS_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_OPEN_SETTINGS_EVENT));
});

ipcRenderer.on(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT));
});

ipcRenderer.on(NATIVE_MENU_CHECK_UPDATES_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_CHECK_UPDATES_EVENT));
});

ipcRenderer.on(NATIVE_MENU_ZOOM_EVENT, (_event, action) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NATIVE_MENU_ZOOM_EVENT, { detail: action }));
});

if (!applyShellDocumentMarkers() && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", applyShellDocumentMarkers, { once: true });
}

if (!installMenuOverlayDismissListeners() && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", installMenuOverlayDismissListeners, { once: true });
}
