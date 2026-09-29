import XCTest
import ApplicationServices
import AppKit
@testable import HandsFreeComputerUse

final class SnapshotTests: XCTestCase {
    private func record(_ id: Int, pid: pid_t = 1, label: String = "Button", value: String? = nil) -> AXElementRecord {
        AXElementRecord(element: AXUIElementCreateApplication(pid), semantic: SemanticAXElement(
            id: id, ref: "{e\(id)}", role: "button", label: label, value: value,
            frame: ElementFrame(x: 0, y: 0, width: 20, height: 20),
            state: AXElementState(enabled: true, focused: nil, selected: nil, expanded: nil, checked: nil),
            capabilities: AXElementCapabilities(canPress: true, canFocus: false, canScroll: false, canAdjust: false, canSetValue: false, actions: ["AXPress"])
        ))
    }

    private func snapshot() -> AppSnapshot {
        AppSnapshot(id: "saved", observation: 1, appName: "Fixture", pid: 1, windowNumber: 1, windowTitle: "Fixture",
            screenshotData: Data(), screenshotMimeType: "image/jpeg",
            screenshotMeta: ScreenshotMetadata(imageWidth: 768, imageHeight: 768, capturedBounds: CGRect(x: 0, y: 0, width: 768, height: 768)),
            records: (1...80).map { record($0, label: $0 == 65 ? "Search" : "Item \($0)") }, treeTruncated: true,
            strictMode: true, backgroundActivated: false, recentActions: [], addedLabels: [], removedLabels: [])
    }

    func testPagingAndSearchKeepOriginalSnapshotRefs() throws {
        let saved = snapshot()
        let first = SnapshotPage.payload(saved)
        let second = SnapshotPage.payload(saved, offset: 30)
        let last = SnapshotPage.payload(saved, offset: 60)
        let search = SnapshotPage.payload(saved, query: "search")
        let pages = [first, second, last]
        let refs = try pages.flatMap { page in
            try XCTUnwrap(page["elements"] as? [[String: Any]]).compactMap { $0["ref"] as? String }
        }
        XCTAssertEqual(refs, (1...80).map { "{e\($0)}" })
        XCTAssertEqual(first["nextOffset"] as? Int, 30)
        XCTAssertEqual(second["nextOffset"] as? Int, 60)
        XCTAssertTrue(last["nextOffset"] is NSNull)
        XCTAssertEqual(search["snapshot_id"] as? String, "saved")
        XCTAssertEqual(search["treeTruncated"] as? Bool, true)
        let matches = try XCTUnwrap(search["elements"] as? [[String: Any]])
        XCTAssertEqual(matches.count, 1)
        XCTAssertEqual(matches[0]["ref"] as? String, "{e65}")
        XCTAssertTrue(search["nextOffset"] is NSNull)
        let empty = SnapshotPage.payload(saved, offset: Int.max)
        XCTAssertEqual((empty["elements"] as? [Any])?.count, 0)
        XCTAssertTrue(empty["nextOffset"] is NSNull)
        let capped = SnapshotPage.payload(saved, offset: -1, limit: Int.max)
        XCTAssertEqual((capped["elements"] as? [Any])?.count, 50)
    }

    func testElementIdentitySurvivesReorderingAndValueChangesButRejectsReplacement() {
        let original = record(1, pid: 10, label: "Search", value: "old")
        let replacement = record(1, pid: 11, label: "Search", value: "old")
        let moved = record(8, pid: 10, label: "Search", value: "new")
        XCTAssertEqual(SnapshotPolicy.refreshed(original, in: [replacement, moved])?.semantic.id, 8)
        XCTAssertNil(SnapshotPolicy.refreshed(original, in: [replacement]))
    }

    func testForegroundInputCannotGoToAnotherApp() {
        XCTAssertNoThrow(try SnapshotPolicy.validateFocus(strict: false, targetPID: 1, frontmostPID: 1, backgroundTargetPID: nil))
        XCTAssertThrowsError(try SnapshotPolicy.validateFocus(strict: false, targetPID: 1, frontmostPID: 2, backgroundTargetPID: 1))
        XCTAssertThrowsError(try SnapshotPolicy.validateFocus(strict: false, targetPID: 1, frontmostPID: nil, backgroundTargetPID: nil))
        XCTAssertNoThrow(try SnapshotPolicy.validateFocus(strict: true, targetPID: 1, frontmostPID: 2, backgroundTargetPID: 1))
        XCTAssertThrowsError(try SnapshotPolicy.validateFocus(strict: true, targetPID: 1, frontmostPID: 2, backgroundTargetPID: nil))
    }
    func testUnicodeChunksNeverSplitSurrogatePairs() {
        let texts = [String(repeating: "a", count: 19) + "😀z", "مرحبا 👩🏾‍💻 e\u{301} 日本語", "", String(repeating: "😀", count: 23)]
        for text in texts {
            let chunks = UnicodeInput.chunks(text)
            XCTAssertEqual(chunks.flatMap { $0 }, Array(text.utf16))
            for chunk in chunks {
                XCTAssertLessThanOrEqual(chunk.count, 20)
                XCTAssertEqual(Array(String(decoding: chunk, as: UTF16.self).utf16), chunk)
            }
        }
    }

    func testRetinaCropAndNegativeMonitorOriginMapBackToScreen() throws {
        let window = CGRect(x: -1440, y: -200, width: 1200, height: 800)
        let crop = try ScreenshotCrop.bounds(window: window, requested: CGRect(x: -1340, y: -150, width: 300, height: 200))
        XCTAssertEqual(ScreenshotCrop.pixels(window: window, crop: crop, width: 2400, height: 1600), CGRect(x: 200, y: 100, width: 600, height: 400))
        let meta = ScreenshotMetadata(imageWidth: 600, imageHeight: 400, capturedBounds: crop)
        let screen = meta.toScreen(imageX: 300, imageY: 200)
        XCTAssertEqual(screen, CGPoint(x: -1190, y: -50))
        XCTAssertEqual(meta.toImage(point: screen), CGPoint(x: 300, y: 200))
        XCTAssertThrowsError(try ScreenshotCrop.bounds(window: window, requested: CGRect(x: 100, y: 100, width: 20, height: 20)))
        XCTAssertEqual(try ScreenshotCrop.bounds(window: window, requested: nil), window)
    }

    func testEncodedScreenshotPixelsMatchCoordinateMetadata() throws {
        let context = try XCTUnwrap(CGContext(data: nil, width: 2400, height: 1600, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 2400, height: 1600))
        let image = try XCTUnwrap(context.makeImage())
        let (data, metadata) = try AccessibilityService().encodeScreenshot(image, capturedBounds: CGRect(x: -1200, y: 100, width: 1200, height: 800), imageWidth: 768)
        let decoded = try XCTUnwrap(NSBitmapImageRep(data: data))
        XCTAssertEqual(decoded.pixelsWide, metadata.imageWidth)
        XCTAssertEqual(decoded.pixelsHigh, metadata.imageHeight)
        XCTAssertEqual(decoded.pixelsWide, 768)
        XCTAssertEqual(decoded.pixelsHigh, 512)
        XCTAssertEqual(metadata.toScreen(imageX: 384, imageY: 256), CGPoint(x: -600, y: 500))
    }

    func testReadinessWaitsForDelayedControlWithoutInputAndTimesOut() async throws {
        var reads = 0
        let tree = try await AccessibilityService.awaitReady(waitFor: "Ready", waitMilliseconds: 1000) {
            reads += 1
            var tree = AXRecordCollection()
            if reads == 3 { tree.records = [self.record(1, label: "Ready")] }
            return tree
        }
        XCTAssertEqual(reads, 3)
        XCTAssertEqual(tree.records.first?.semantic.label, "Ready")
        do {
            _ = try await AccessibilityService.awaitReady(waitFor: "Never", waitMilliseconds: 0) { AXRecordCollection() }
            XCTFail("Missing control must not report a ready snapshot")
        } catch {
            guard case ComputerUseError.staleSnapshot = error else { return XCTFail("Expected explicit recapture recovery") }
        }
    }

}
