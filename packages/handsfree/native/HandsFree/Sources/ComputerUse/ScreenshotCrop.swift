import Foundation

// All requested bounds are absolute screen points; pixels are local to the capture.
enum ScreenshotCrop {
    static func bounds(window: CGRect, requested: CGRect?) throws -> CGRect {
        guard let requested else { return window }
        guard requested.origin.x.isFinite, requested.origin.y.isFinite,
              requested.width.isFinite, requested.height.isFinite,
              requested.width > 0, requested.height > 0 else {
            throw ComputerUseError.staleSnapshot("Crop must have finite coordinates and positive dimensions.")
        }
        let result = window.intersection(requested)
        guard !result.isNull, result.width > 0, result.height > 0 else {
            throw ComputerUseError.staleSnapshot("Crop does not intersect the target window.")
        }
        return result
    }

    static func pixels(window: CGRect, crop: CGRect, width: Int, height: Int) -> CGRect {
        CGRect(x: (crop.minX - window.minX) * CGFloat(width) / window.width,
               y: (crop.minY - window.minY) * CGFloat(height) / window.height,
               width: crop.width * CGFloat(width) / window.width,
               height: crop.height * CGFloat(height) / window.height)
    }
}
