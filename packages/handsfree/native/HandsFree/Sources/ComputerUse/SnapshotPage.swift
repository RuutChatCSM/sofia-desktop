import Foundation

enum SnapshotPage {
    static func payload(_ snapshot: AppSnapshot, offset: Int = 0, limit: Int = 30, query: String? = nil) -> [String: Any] {
        let filtered = snapshot.elements.filter { element in
            guard let query, !query.isEmpty else { return true }
            return "\(element.role) \(element.label) \(element.value ?? "")".localizedCaseInsensitiveContains(query)
        }
        let start = min(max(0, offset), filtered.count)
        let end = start + min(max(1, min(limit, 50)), filtered.count - start)
        let elements = filtered[start..<end].map { element -> [String: Any] in
            var dict = element.dictionary
            let imagePoint = snapshot.screenshotMeta.toImage(point: element.frame.center)
            dict["center"] = [
                "screenX": Int(element.frame.center.x),
                "screenY": Int(element.frame.center.y),
                "imageX": Int(imagePoint.x),
                "imageY": Int(imagePoint.y),
            ]
            return dict
        }

        var result: [String: Any] = [
            "ok": true,
            "semanticAXVersion": 1,
            "snapshotId": snapshot.id,
            "snapshot_id": snapshot.id,
            "observation": snapshot.observation,
            "app": snapshot.appName,
            "pid": Int(snapshot.pid),
            "windowTitle": snapshot.windowTitle ?? "",
            "screenshot": snapshot.screenshotMeta.dictionary,
            "execution": [
                "strictMode": snapshot.strictMode,
                "backgroundActivated": snapshot.backgroundActivated,
                "defaultPath": snapshot.strictMode ? "accessibility_then_background_cgevent" : "accessibility_then_foreground_fallback",
            ],
            "elements": elements,
            "totalElements": snapshot.records.count,
            "matchingElements": filtered.count,
            "offset": start,
            "nextOffset": end < filtered.count ? end as Any : NSNull(),
            "treeTruncated": snapshot.treeTruncated,
            "hint": "Use refs like {e1}. Read more with snapshot_elements(snapshot_id, offset: nextOffset), or query by label/role; paging keeps refs stable. treeTruncated means collection hit its safety limit: scroll to the relevant area and take a new snapshot. Verify the resulting UI after actions; AX acceptance alone does not prove a visible change.",
        ]
        if !snapshot.recentActions.isEmpty {
            result["recentActions"] = snapshot.recentActions
        }
        if !snapshot.addedLabels.isEmpty || !snapshot.removedLabels.isEmpty {
            result["stateDelta"] = ["added": snapshot.addedLabels, "removed": snapshot.removedLabels]
        }
        if let windowNumber = snapshot.windowNumber {
            result["windowNumber"] = windowNumber
        }
        return result
    }

}
