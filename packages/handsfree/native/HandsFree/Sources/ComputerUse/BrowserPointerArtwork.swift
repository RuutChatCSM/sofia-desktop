import AppKit

/// Native rendering of the SVG pointer used by browser-cursor.mjs. The path
/// supports its relative m/c/l/z commands and maps the 512-unit viewBox into
/// the 30-point cursor panel without changing the target click coordinate.
enum BrowserPointerArtwork {
    static let mousePath = "m151 41.78c-3.03 0.99-7.53 2.97-10 4.4-2.47 1.43-6.86 5.13-9.75 8.21-2.89 3.09-6.45 8.2-7.91 11.36-1.46 3.16-3.09 8.45-3.62 11.75-0.74 4.55 0.74 41.29 6.12 152.5 3.9 80.58 7.49 150.77 7.98 156 0.61 6.49 1.69 11.24 3.4 15 1.37 3.02 4.48 7.69 6.89 10.36 2.91 3.22 6.9 6.09 11.84 8.5 6.92 3.38 8.08 3.64 16.5 3.6 6.85-0.02 10.39-0.56 14.55-2.2 3.03-1.19 7.71-4.09 10.41-6.46 2.7-2.36 16.95-20.28 31.67-39.8 14.72-19.52 29.39-38.09 32.59-41.25 3.21-3.16 8.53-7.55 11.83-9.75 3.3-2.2 9.15-5.32 13-6.92 3.85-1.6 10.49-3.62 14.75-4.5 6.43-1.31 15.89-1.58 55.5-1.59 39.26-0.01 48.73-0.28 53.25-1.51 3.02-0.82 7.52-2.72 10-4.2 2.48-1.49 6.19-4.41 8.25-6.49 2.06-2.09 4.81-5.93 6.11-8.54 1.3-2.61 2.94-7.23 3.64-10.25 0.77-3.31 1.02-7.79 0.64-11.25-0.35-3.16-1.52-8.11-2.59-11-1.07-2.89-3.88-7.46-6.25-10.16-2.36-2.71-54.25-46.16-115.3-96.57-61.05-50.41-114.6-94.56-119-98.1-4.4-3.54-10.93-7.75-14.5-9.34-5.25-2.34-8.23-2.97-15.5-3.25-6.72-0.26-10.39 0.1-14.5 1.45z"

    static func path() -> NSBezierPath {
        let expression = try! NSRegularExpression(pattern: #"[mclz]|-?\d+(?:\.\d+)?"#)
        let tokens = expression.matches(in: mousePath, range: NSRange(mousePath.startIndex..., in: mousePath))
            .compactMap { Range($0.range, in: mousePath).map { String(mousePath[$0]) } }
        let path = NSBezierPath()
        var index = 0
        var x = 0.0
        var y = 0.0
        func mapped(_ px: Double, _ py: Double) -> NSPoint {
            NSPoint(x: px * 30 / 512, y: 34 - py * 30 / 512)
        }
        func number() -> Double {
            defer { index += 1 }
            return Double(tokens[index])!
        }
        while index < tokens.count {
            let command = tokens[index]
            index += 1
            switch command {
            case "m":
                x += number(); y += number()
                path.move(to: mapped(x, y))
            case "l":
                while index < tokens.count, Double(tokens[index]) != nil {
                    x += number(); y += number()
                    path.line(to: mapped(x, y))
                }
            case "c":
                while index < tokens.count, Double(tokens[index]) != nil {
                    let c1x = x + number(), c1y = y + number()
                    let c2x = x + number(), c2y = y + number()
                    x += number(); y += number()
                    path.curve(to: mapped(x, y), controlPoint1: mapped(c1x, c1y), controlPoint2: mapped(c2x, c2y))
                }
            case "z": path.close()
            default: break
            }
        }
        return path
    }
}
