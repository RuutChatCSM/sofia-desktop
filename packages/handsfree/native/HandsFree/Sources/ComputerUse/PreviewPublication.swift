import Foundation
import AppKit

/// The desktop renderer reads the latest observation for its floating Peek.
/// This is a display copy, never an input channel or a replacement for the
/// agent's MCP screenshot. Atomic replacement prevents a half-written image.
enum PreviewPublication {
    static let presentationID = UUID().uuidString
    static var fileURL: URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("sofia-computer-peek-\(getuid()).json")
    }

    static func publish(_ snapshot: AppSnapshot) {
        var payload: [String: Any] = [
            "presentationId": presentationID,
            "revision": snapshot.observation,
            "imageWidth": snapshot.screenshotMeta.imageWidth,
            "imageHeight": snapshot.screenshotMeta.imageHeight,
            "app": snapshot.appName,
            "pid": Int(snapshot.pid),
            "windowNumber": snapshot.windowNumber ?? 0,
            "helperPid": Int(getpid()),
            "windowTitle": snapshot.windowTitle ?? "",
            "capturedAt": Date().timeIntervalSince1970,
            "image": snapshot.screenshotData.base64EncodedString(),
            "mimeType": snapshot.screenshotMimeType,
        ]
        if let icon = NSRunningApplication(processIdentifier: snapshot.pid)?.icon,
           let tiff = icon.tiffRepresentation,
           let bitmap = NSBitmapImageRep(data: tiff),
           let png = bitmap.representation(using: .png, properties: [:]) {
            payload["applicationIcon"] = png.base64EncodedString()
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        do {
            try data.write(to: fileURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        } catch {
            // A preview failure must never break the computer-use tool call.
        }
    }
}
