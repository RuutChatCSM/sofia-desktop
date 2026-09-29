import AppKit
import CoreGraphics
let x = Double(CommandLine.arguments[1])!
let y = Double(CommandLine.arguments[2])!
let path = CommandLine.arguments[3]
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
let candidates = windows.filter { w in
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  return (owner.contains("Sofia") || owner == "Electron") && (w[kCGWindowLayer as String] as? Int == 0)
}.sorted { ($0[kCGWindowOwnerPID as String] as? Int ?? 0) > ($1[kCGWindowOwnerPID as String] as? Int ?? 0) }
guard let window = candidates.first, let id = window[kCGWindowNumber as String] as? Int,
 let bounds = window[kCGWindowBounds as String] as? [String: Double], let width = bounds["Width"] else { fatalError("No Sofia window") }
let capture = Process(); capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
capture.arguments = ["-x", "-o", "-l", String(id), path]; try capture.run(); capture.waitUntilExit()
guard capture.terminationStatus == 0, let data = NSData(contentsOfFile:path), let bitmap = NSBitmapImageRep(data:data as Data) else { fatalError("Native capture failed") }
let scale = Double(bitmap.pixelsWide) / width
let color = bitmap.colorAt(x:Int(x * scale), y:Int(y * scale))!.usingColorSpace(.deviceRGB)!
print("\(Int((color.redComponent * 255).rounded())),\(Int((color.greenComponent * 255).rounded())),\(Int((color.blueComponent * 255).rounded()))")
