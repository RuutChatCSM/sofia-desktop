import XCTest
import ApplicationServices
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
}
