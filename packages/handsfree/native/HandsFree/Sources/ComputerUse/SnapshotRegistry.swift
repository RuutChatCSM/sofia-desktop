import Foundation

struct SnapshotRegistry {
    private var currentByTarget: [String: AppSnapshot] = [:]
    private var targetBySnapshot: [String: String] = [:]
    private var staleReasons: [String: String] = [:]
    private(set) var lastSnapshotID: String?

    mutating func save(_ snapshot: AppSnapshot) {
        if let previous = currentByTarget[snapshot.targetID] {
            targetBySnapshot.removeValue(forKey: previous.id)
        }
        currentByTarget[snapshot.targetID] = snapshot
        targetBySnapshot[snapshot.id] = snapshot.targetID
        lastSnapshotID = snapshot.id
        staleReasons.removeValue(forKey: snapshot.targetID)
    }

    func require(_ snapshotID: String? = nil) throws -> AppSnapshot {
        guard let id = snapshotID ?? lastSnapshotID,
              let targetID = targetBySnapshot[id],
              let snapshot = currentByTarget[targetID],
              snapshot.id == id else {
            if let snapshotID {
                throw ComputerUseError.staleSnapshot("Snapshot \(snapshotID) is no longer current. Take a new snapshot before retrying.")
            }
            throw ComputerUseError.noSnapshot
        }
        if let reason = staleReasons[targetID] {
            throw ComputerUseError.staleSnapshot(reason)
        }
        return snapshot
    }

    mutating func markAllStale(reason: String) {
        for targetID in currentByTarget.keys {
            staleReasons[targetID] = reason
        }
    }

    mutating func clearStale(targetID: String) {
        staleReasons.removeValue(forKey: targetID)
    }

    func staleReason(targetID: String) -> String? {
        staleReasons[targetID]
    }
}
