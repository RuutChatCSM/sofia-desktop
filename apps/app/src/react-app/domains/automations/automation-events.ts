export const automationsStateChangedEvent = "sofia:automations-state-changed"

export function dispatchAutomationsStateChanged() {
  window.dispatchEvent(new CustomEvent(automationsStateChangedEvent))
}
