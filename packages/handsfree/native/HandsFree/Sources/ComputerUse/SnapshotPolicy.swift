import ApplicationServices
import Foundation

enum SnapshotPolicy {
    static func refreshed(_ record: AXElementRecord, in records: [AXElementRecord]) -> AXElementRecord? {
        records.first { CFEqual($0.element, record.element) }
    }

    static func validateFocus(strict: Bool, targetPID: pid_t, frontmostPID: pid_t?, backgroundTargetPID: pid_t?) throws {
        if frontmostPID == targetPID { return }
        guard strict else {
            throw ComputerUseError.staleSnapshot("The target app is not frontmost. Activate it and take a new snapshot before sending foreground input.")
        }
        guard backgroundTargetPID == targetPID else {
            throw ComputerUseError.staleSnapshot("The target app is no longer safely activated. Take a new snapshot before retrying.")
        }
    }
}
