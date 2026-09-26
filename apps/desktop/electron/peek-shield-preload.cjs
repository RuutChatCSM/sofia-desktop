// Bridge for the Peek shield document.
//
// The shield is a sandboxed, isolated renderer, so the only thing it can do is
// report what the user did to it: the card was activated, hidden, or dragged.
// It has no access to window state, tab state, or Node.
const { contextBridge, ipcRenderer } = require("electron");

const CHROME_CHANNEL = "sofia:browser:peek-chrome";
const READY_CHANNEL = "sofia:browser:peek-shield:ready";
const POINTER_CHANNEL = "sofia:browser:peek-shield:pointer";
const ACTION_CHANNEL = "sofia:browser:peek-shield:action";

let latestChrome = null;
let chromeCallback = null;

ipcRenderer.on(CHROME_CHANNEL, (_event, chrome) => {
  latestChrome = chrome;
  chromeCallback?.(chrome);
});

contextBridge.exposeInMainWorld("__SOFIA_PEEK_SHIELD__", {
  ready() {
    ipcRenderer.send(READY_CHANNEL);
  },
  onChrome(callback) {
    chromeCallback = callback;
    if (latestChrome) callback(latestChrome);
    return () => {
      if (chromeCallback === callback) chromeCallback = null;
    };
  },
  pointer(payload) {
    ipcRenderer.send(POINTER_CHANNEL, payload);
  },
  action(action) {
    ipcRenderer.send(ACTION_CHANNEL, action);
  },
});
