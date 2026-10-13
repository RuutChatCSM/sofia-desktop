export function configureFakeMediaForTests(app, enabled) {
  if (!enabled) return;
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
}

function isLocalRendererOrigin(origin) {
  const value = String(origin ?? "").trim();
  if (!value || value === "file://") return true;
  try {
    const url = new URL(value);
    return url.protocol === "file:" || url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

function shouldAllowMainWindowPermission(input) {
  const { webContents, permission, origin, details, mainWindow, computerPeekCaptureActive } = input;
  if (!mainWindow || !webContents || webContents.id !== mainWindow.webContents.id) return false;
  if (!isLocalRendererOrigin(origin)) return false;
  if (permission === "display-capture") return Boolean(computerPeekCaptureActive);
  if (permission !== "media" && permission !== "audioCapture") return true;
  const mediaType = typeof details.mediaType === "string" ? details.mediaType : "";
  if (computerPeekCaptureActive && mediaType === "video") return true;
  if (mediaType && mediaType !== "audio") return false;
  const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
  if (computerPeekCaptureActive && mediaTypes.includes("video")) return true;
  return mediaType === "audio" || (mediaTypes.includes("audio") && !mediaTypes.includes("video"));
}

export function installMediaPermissionHandlers(session, getMainWindow, computerPeekCaptureActive = () => false) {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(shouldAllowMainWindowPermission({
      webContents,
      permission,
      origin: details?.requestingUrl,
      details: details ?? {},
      mainWindow: getMainWindow(),
      computerPeekCaptureActive: computerPeekCaptureActive(),
    }));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => (
    shouldAllowMainWindowPermission({
      webContents,
      permission,
      origin: requestingOrigin,
      details: details ?? {},
      mainWindow: getMainWindow(),
      computerPeekCaptureActive: computerPeekCaptureActive(),
    })
  ));
}
