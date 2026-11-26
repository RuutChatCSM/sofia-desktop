// Bridge for the floating session dock document.
//
// The dock is a sandboxed, isolated renderer: it can draw the live turn and
// report user intent, but it can never read the window, tab state, or Node.
const { contextBridge, ipcRenderer } = require("electron");

const READY_CHANNEL = "sofia:browser:session-dock:ready";
const STATE_CHANNEL = "sofia:browser:session-dock:state";
const SUBMIT_CHANNEL = "sofia:browser:session-dock:submit";
const STOP_CHANNEL = "sofia:browser:session-dock:stop";
const LAYOUT_CHANNEL = "sofia:browser:session-dock:layout";
const BACK_CHANNEL = "sofia:browser:session-dock:back-to-chat";
const DRAG_CHANNEL = "sofia:browser:session-dock:drag";

let latestState = null;
let stateCallback = null;

ipcRenderer.on(STATE_CHANNEL, (_event, state) => {
  latestState = state;
  stateCallback?.(state);
});

contextBridge.exposeInMainWorld("__SOFIA_BROWSER_SESSION_DOCK__", {
  ready() {
    ipcRenderer.send(READY_CHANNEL);
  },
  onState(callback) {
    stateCallback = callback;
    if (latestState) callback(latestState);
    return () => {
      if (stateCallback === callback) stateCallback = null;
    };
  },
  submit(text, mode) {
    ipcRenderer.send(SUBMIT_CHANNEL, { text, mode });
  },
  stop() {
    ipcRenderer.send(STOP_CHANNEL);
  },
  setLayout(layout) {
    ipcRenderer.send(LAYOUT_CHANNEL, layout);
  },
  backToChat() {
    ipcRenderer.send(BACK_CHANNEL);
  },
  dragBy(dx, dy, phase) {
    ipcRenderer.send(DRAG_CHANNEL, { dx, dy, phase });
  },
});
