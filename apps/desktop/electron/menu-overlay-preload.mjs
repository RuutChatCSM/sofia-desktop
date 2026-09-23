import { contextBridge, ipcRenderer } from "electron";

let latestRequest = null;
let showCallback = null;

ipcRenderer.on("sofia:menu-overlay:show", (_event, request) => {
  latestRequest = request;
  showCallback?.(request);
});

contextBridge.exposeInMainWorld("__SOFIA_MENU_OVERLAY__", {
  ready() {
    ipcRenderer.send("sofia:menu-overlay:ready");
  },
  onShow(callback) {
    showCallback = callback;
    if (latestRequest) {
      callback(latestRequest);
    }
    return () => {
      if (showCallback === callback) {
        showCallback = null;
      }
    };
  },
  choose(requestId, itemId) {
    ipcRenderer.send("sofia:menu-overlay:choose", { requestId, itemId });
  },
  close(requestId) {
    ipcRenderer.send("sofia:menu-overlay:close", { requestId });
  },
});
