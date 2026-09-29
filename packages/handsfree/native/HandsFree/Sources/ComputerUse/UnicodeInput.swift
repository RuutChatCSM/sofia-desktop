import Foundation

// Keep surrogate pairs intact when CoreGraphics limits the text in one event.
enum UnicodeInput {
    static func chunks(_ text: String, limit: Int = 20) -> [[UInt16]] {
        precondition(limit >= 2)
        var chunks: [[UInt16]] = []
        var current: [UInt16] = []
        for scalar in text.unicodeScalars {
            let units = Array(String(scalar).utf16)
            if current.count + units.count > limit {
                chunks.append(current)
                current = []
            }
            current.append(contentsOf: units)
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }
}
