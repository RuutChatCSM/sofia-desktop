// Keep recovery in the main process: a crashed renderer cannot show an error UI.
export function installRendererRecovery(window, dialog, log = console) {
  let prompting = false;
  window.webContents.on("render-process-gone", async (_event, details) => {
    if (details.reason === "clean-exit") return;
    log.error("[sofia] workspace renderer exited", details);
    if (prompting || window.isDestroyed()) return;
    prompting = true;
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: "error",
        title: "Sofia workspace stopped",
        message: "The workspace display stopped unexpectedly.",
        detail: "Reload the workspace to continue. Unsaved input may be lost.",
        buttons: ["Reload workspace", "Keep window open"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response === 0 && !window.isDestroyed()) window.webContents.reload();
    } catch (error) {
      log.error("[sofia] renderer recovery failed", error);
    } finally {
      prompting = false;
    }
  });
}
