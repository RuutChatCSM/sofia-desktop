import AppKit
import Foundation

actor ComputerUseRuntime {
    private let accessibility = AccessibilityService()
    private let foregroundInput = InputService()
    private var snapshots = SnapshotRegistry()
    private var strictMode = true
    private var activationSession: BackgroundActivationSession?
    private var activationKey: String?
    private var activatedWindowKey: String?
    private var activationPreviousPID: pid_t?
    private var activationTargetPID: pid_t?
    private var frontmostMonitor: FrontmostApplicationMonitor?
    private var snapshotSequence = 0
    private var previousLabelsByWindow: [String: Set<String>] = [:]
    private var recentActionsByTarget: [String: [String]] = [:]
    private var activationStartedAt: UInt64 = 0

    func setStrictMode(_ enabled: Bool) -> ActionMetadata {
        strictMode = enabled
        if !enabled {
            resetBackgroundActivation()
        }
        return ActionMetadata(
            ok: true,
            path: .none,
            strictMode: enabled,
            backgroundSafe: enabled,
            fallbackUsed: false,
            message: enabled ? "Strict background mode enabled." : "Strict background mode disabled. Foreground fallback is allowed."
        )
    }

    func snapshot(targetID: String? = nil, appName: String?, pid: Int? = nil, windowTitle: String? = nil, windowNumber: Int? = nil, strict requestedStrict: Bool?, crop: CGRect? = nil, imageWidth: Int = 768, waitFor: String? = nil, waitMilliseconds: Int = 2000) async throws -> AppSnapshot {
        let effectiveStrict = requestedStrict ?? strictMode
        if !effectiveStrict {
            resetBackgroundActivation()
        }

        let requestedPID = pid.map(pid_t.init)
        var target = try targetID.map { try accessibility.resolveTarget(targetID: $0) }
            ?? accessibility.resolveTarget(appName: appName, pid: requestedPID, windowTitle: windowTitle, windowNumber: windowNumber)
        let backgroundActivated: Bool
        if effectiveStrict, !target.isFrontmost {
            backgroundActivated = try await ensureBackgroundActivation(target: target)
            target = try accessibility.resolveTarget(targetID: target.targetID)
        } else {
            backgroundActivated = false
        }

        let snapshot = try await accessibility.snapshot(
            target: target,
            strictMode: effectiveStrict,
            backgroundActivated: backgroundActivated, crop: crop, imageWidth: imageWidth, waitFor: waitFor, waitMilliseconds: waitMilliseconds
        )
        let annotatedSnapshot = annotate(snapshot: snapshot)
        snapshots.save(annotatedSnapshot)
        return annotatedSnapshot
    }

    func click(snapshotID: String?, ref: String?, index: Int?, imageX: Double?, imageY: Double?, screenX: Double? = nil, screenY: Double? = nil, clickCount: Int, rightClick: Bool = false, strict requestedStrict: Bool?) async throws -> ActionMetadata {
        let snapshot = try requireSnapshot(snapshotID: snapshotID)
        let effectiveStrict = requestedStrict ?? snapshot.strictMode
        _ = try await prepareAction(snapshot: snapshot, strict: effectiveStrict)

        if let record = findRecord(ref: ref, index: index, in: snapshot) {
            guard let fresh = freshRecord(matching: record, in: snapshot) else {
                throw ComputerUseError.staleSnapshot("The target element changed. Take a new snapshot before clicking.")
            }
            AgentCursorOverlay.shared.show(at: fresh.semantic.frame.center)
            if !rightClick, clickCount == 1, fresh.semantic.capabilities.canPress, accessibility.press(record: fresh) {
                return recordAction(ActionMetadata(ok: true, path: .accessibility, strictMode: effectiveStrict, backgroundSafe: true, fallbackUsed: false, message: "Pressed \(record.semantic.ref) via AXPress."), targetID: snapshot.targetID)
            }
            return try await clickPoint(fresh.semantic.frame.center, snapshot: snapshot, clickCount: clickCount, rightClick: rightClick, strict: effectiveStrict, fallbackUsed: true)
        }

        if ref != nil || index != nil {
            throw ComputerUseError.invalidElement(ref ?? index.map(String.init) ?? "<missing>")
        }
        if let screenX, let screenY {
            return try await clickPoint(CGPoint(x: screenX, y: screenY), snapshot: snapshot, clickCount: clickCount, rightClick: rightClick, strict: effectiveStrict, fallbackUsed: false)
        }

        if let imageX, let imageY {
            let point = snapshot.screenshotMeta.toScreen(imageX: imageX, imageY: imageY)
            return try await clickPoint(point, snapshot: snapshot, clickCount: clickCount, rightClick: rightClick, strict: effectiveStrict, fallbackUsed: false)
        }

        throw ComputerUseError.invalidElement(ref ?? index.map(String.init) ?? "<missing>")
    }

    func typeText(snapshotID: String?, text: String, strict requestedStrict: Bool?) async throws -> ActionMetadata {
        let snapshot = try requireSnapshot(snapshotID: snapshotID)
        let effectiveStrict = requestedStrict ?? snapshot.strictMode
        _ = try await prepareAction(snapshot: snapshot, strict: effectiveStrict)
        if effectiveStrict {
            try BackgroundInputDispatcher.typeText(pid: snapshot.pid, text: text)
            return recordAction(ActionMetadata(ok: true, path: .backgroundCGEvent, strictMode: true, backgroundSafe: true, fallbackUsed: false, message: "Typed text with postToPid."), targetID: snapshot.targetID)
        }

        try foregroundInput.typeText(text)
        return recordAction(ActionMetadata(ok: true, path: .foregroundCGEvent, strictMode: false, backgroundSafe: false, fallbackUsed: true, message: "Typed text with foreground HID fallback."), targetID: snapshot.targetID)
    }

    func pressKey(snapshotID: String?, combo: String, milliseconds: Int = 0, strict requestedStrict: Bool?) async throws -> ActionMetadata {
        let snapshot = try requireSnapshot(snapshotID: snapshotID)
        let effectiveStrict = requestedStrict ?? snapshot.strictMode
        _ = try await prepareAction(snapshot: snapshot, strict: effectiveStrict)
        if effectiveStrict {
            try BackgroundInputDispatcher.pressKey(pid: snapshot.pid, combo: combo, milliseconds: milliseconds)
            return recordAction(ActionMetadata(ok: true, path: .backgroundCGEvent, strictMode: true, backgroundSafe: true, fallbackUsed: false, message: "Pressed key with postToPid."), targetID: snapshot.targetID)
        }

        try foregroundInput.pressKey(combo, milliseconds: milliseconds)
        return recordAction(ActionMetadata(ok: true, path: .foregroundCGEvent, strictMode: false, backgroundSafe: false, fallbackUsed: true, message: "Pressed key with foreground HID fallback."), targetID: snapshot.targetID)
    }

    func scroll(snapshotID: String?, direction: String?, pages: Double, imageX: Double?, imageY: Double?, strict requestedStrict: Bool?) async throws -> ActionMetadata {
        let snapshot = try requireSnapshot(snapshotID: snapshotID)
        let effectiveStrict = requestedStrict ?? snapshot.strictMode
        _ = try await prepareAction(snapshot: snapshot, strict: effectiveStrict)
        let amount = max(1, Int32(pages * 5))
        let deltas = scrollDeltas(direction: direction, amount: amount)
        let point: CGPoint = {
            if let imageX, let imageY {
                return snapshot.screenshotMeta.toScreen(imageX: imageX, imageY: imageY)
            }
            return CGPoint(x: snapshot.screenshotMeta.capturedBounds.midX, y: snapshot.screenshotMeta.capturedBounds.midY)
        }()
        AgentCursorOverlay.shared.show(at: point)

        if effectiveStrict {
            guard let windowNumber = snapshot.windowNumber else {
                throw ComputerUseError.strictModeViolation("background scroll requires a CG window number")
            }
            try BackgroundInputDispatcher.scroll(pid: snapshot.pid, windowNumber: windowNumber, point: point, deltaX: deltas.x, deltaY: deltas.y)
            return recordAction(ActionMetadata(ok: true, path: .backgroundCGEvent, strictMode: true, backgroundSafe: true, fallbackUsed: false, message: "Scrolled with postToPid."), targetID: snapshot.targetID)
        }

        try foregroundInput.scroll(point: point, deltaX: deltas.x, deltaY: deltas.y)
        return recordAction(ActionMetadata(ok: true, path: .foregroundCGEvent, strictMode: false, backgroundSafe: false, fallbackUsed: true, message: "Scrolled with foreground HID fallback."), targetID: snapshot.targetID)
    }

    func setValue(snapshotID: String?, ref: String?, index: Int?, value: String) async throws -> ActionMetadata {
        let snapshot = try requireSnapshot(snapshotID: snapshotID)
        _ = try await prepareAction(snapshot: snapshot, strict: snapshot.strictMode)
        guard let record = findRecord(ref: ref, index: index, in: snapshot) else {
            throw ComputerUseError.invalidElement(ref ?? index.map(String.init) ?? "<missing>")
        }
        guard let fresh = freshRecord(matching: record, in: snapshot) else {
            throw ComputerUseError.staleSnapshot("The target element changed. Take a new snapshot before setting its value.")
        }
        AgentCursorOverlay.shared.show(at: fresh.semantic.frame.center)
        let axWriteAccepted = accessibility.setValue(record: fresh, value: value)
        if axWriteAccepted, valueMatches(record: fresh, expected: value) {
            return recordAction(ActionMetadata(ok: true, path: .accessibility, strictMode: snapshot.strictMode, backgroundSafe: true, fallbackUsed: false, message: "Set \(record.semantic.ref) via AXValue."), targetID: snapshot.targetID)
        }

        // Web inputs (Chromium/Electron) accept AXValue writes without applying
        // them. Fall back to focus + select-all + retype, then verify.
        guard accessibility.focus(record: fresh) else {
            return recordAction(ActionMetadata(ok: false, path: .accessibility, strictMode: snapshot.strictMode, backgroundSafe: true, fallbackUsed: false, message: "Could not focus the intended field; no keyboard input was sent."), targetID: snapshot.targetID)
        }
        try BackgroundInputDispatcher.pressKey(pid: snapshot.pid, combo: "command+a")
        try BackgroundInputDispatcher.typeText(pid: snapshot.pid, text: value)
        try await Task.sleep(nanoseconds: 80_000_000)
        let verified = valueMatches(record: fresh, expected: value)
        return recordAction(ActionMetadata(
            ok: verified,
            path: .backgroundCGEvent,
            strictMode: snapshot.strictMode,
            backgroundSafe: true,
            fallbackUsed: true,
            message: verified
                ? "AXValue write did not stick; set \(record.semantic.ref) via select-all + retype fallback."
                : "Could not verify the value of \(record.semantic.ref) after AXValue and retype fallback."
        ), targetID: snapshot.targetID)
    }

    private func valueMatches(record: AXElementRecord, expected: String) -> Bool {
        accessibility.value(record: record) == expected
    }

    func performAction(snapshotID: String?, ref: String?, index: Int?, action: String) async throws -> ActionMetadata {
        let snapshot = try requireSnapshot(snapshotID: snapshotID)
        _ = try await prepareAction(snapshot: snapshot, strict: snapshot.strictMode)
        guard let record = findRecord(ref: ref, index: index, in: snapshot) else {
            throw ComputerUseError.invalidElement(ref ?? index.map(String.init) ?? "<missing>")
        }
        guard let fresh = freshRecord(matching: record, in: snapshot) else {
            throw ComputerUseError.staleSnapshot("The target element changed. Take a new snapshot before performing another action.")
        }
        AgentCursorOverlay.shared.show(at: fresh.semantic.frame.center)
        let ok = accessibility.performAction(record: fresh, action: action)
        return recordAction(ActionMetadata(ok: ok, path: .accessibility, strictMode: snapshot.strictMode, backgroundSafe: true, fallbackUsed: false, message: ok ? "Performed \(action) on \(record.semantic.ref)." : "AX action \(action) failed."), targetID: snapshot.targetID)
    }

    func wait(milliseconds: Int) async -> ActionMetadata {
        let clamped = max(0, min(milliseconds, 10_000))
        try? await Task.sleep(nanoseconds: UInt64(clamped) * 1_000_000)
        return ActionMetadata(ok: true, path: .none, strictMode: strictMode, backgroundSafe: true, fallbackUsed: false, message: "Waited \(clamped)ms.")
    }

    func listWindows(appName: String?, pid: Int?) throws -> [WindowTarget] {
        try accessibility.listTargets(appName: appName, pid: pid.map(pid_t.init))
    }

    private func clickPoint(_ point: CGPoint, snapshot: AppSnapshot, clickCount: Int, rightClick: Bool, strict: Bool, fallbackUsed: Bool) async throws -> ActionMetadata {
        guard point.x.isFinite, point.y.isFinite, snapshot.windowBounds.contains(point) else {
            throw ComputerUseError.staleSnapshot("Click coordinates fall outside the observed target window. Recapture before input.")
        }
        AgentCursorOverlay.shared.show(at: point)
        if strict {
            guard let windowNumber = snapshot.windowNumber else {
                throw ComputerUseError.strictModeViolation("background click requires a CG window number")
            }
            try await BackgroundInputDispatcher.click(pid: snapshot.pid, windowNumber: windowNumber, point: point, doubleClick: clickCount >= 2, rightClick: rightClick)
            return recordAction(ActionMetadata(ok: true, path: .backgroundCGEvent, strictMode: true, backgroundSafe: true, fallbackUsed: fallbackUsed, message: "Clicked with postToPid at \(Int(point.x)),\(Int(point.y))."), targetID: snapshot.targetID)
        }

        try await foregroundInput.click(point: point, doubleClick: clickCount >= 2, rightClick: rightClick)
        return recordAction(ActionMetadata(ok: true, path: .foregroundCGEvent, strictMode: false, backgroundSafe: false, fallbackUsed: true, message: "Clicked with foreground HID fallback at \(Int(point.x)),\(Int(point.y))."), targetID: snapshot.targetID)
    }

    private func ensureBackgroundActivation(target: WindowTarget) async throws -> Bool {
        ensureFrontmostMonitor()
        guard let previousPID = NSWorkspace.shared.frontmostApplication?.processIdentifier else {
            throw ComputerUseError.noFrontmostApplication
        }
        let nextActivationKey = "\(previousPID):\(target.pid)"
        if activationKey != nextActivationKey {
            resetBackgroundActivation()
            let next = BackgroundActivationSession(previousPID: previousPID, targetPID: target.pid)
            try next.start()
            activationStartedAt = DispatchTime.now().uptimeNanoseconds
            activationSession = next
            activationKey = nextActivationKey
            activationPreviousPID = previousPID
            activationTargetPID = target.pid
            activatedWindowKey = nil
        }

        let nextWindowKey = "\(target.pid):\(target.windowNumber ?? -1)"
        if activatedWindowKey != nextWindowKey {
            guard let activationSession else {
                throw ComputerUseError.strictModeViolation("background activation session was not created")
            }
            try await activationSession.activate(target: target)
            activatedWindowKey = nextWindowKey
        }
        return true
    }

    private func ensureFrontmostMonitor() {
        if frontmostMonitor != nil { return }
        frontmostMonitor = FrontmostApplicationMonitor { [weak self] pid, observedAt in
            guard let runtime = self else { return }
            Task { await runtime.frontmostApplicationChanged(pid: pid, observedAt: observedAt) }
        }
    }

    private func frontmostApplicationChanged(pid: pid_t?, observedAt: UInt64) {
        // A callback queued for an earlier activation must not invalidate the new one.
        guard observedAt >= activationStartedAt, activationSession != nil else { return }
        if pid == activationPreviousPID {
            snapshots.markAllStale(reason: "The user returned focus to the previous app. Take a new snapshot before sending more input.")
        } else if pid == activationTargetPID {
            snapshots.markAllStale(reason: "The target app became frontmost. Take a new snapshot before continuing.")
        } else {
            snapshots.markAllStale(reason: "The user changed app focus. Take a new snapshot before sending more input.")
        }
        resetBackgroundActivation()
    }

    private func resetBackgroundActivation() {
        activationSession?.stop()
        activationSession = nil
        activationKey = nil
        activatedWindowKey = nil
        activationPreviousPID = nil
        activationTargetPID = nil
    }

    func requireSnapshot(snapshotID: String? = nil) throws -> AppSnapshot {
        try snapshots.require(snapshotID)
    }

    private func prepareAction(snapshot: AppSnapshot, strict: Bool) async throws -> WindowTarget {
        var target = try accessibility.resolveTarget(targetID: snapshot.targetID)
        guard target.windowNumber == snapshot.windowNumber, target.bounds.equalTo(snapshot.windowBounds) else {
            throw ComputerUseError.staleSnapshot("The target window moved, resized, or was replaced. Take a fresh snapshot before input.")
        }
        if strict, !target.isFrontmost {
            _ = try await ensureBackgroundActivation(target: target)
            target = try accessibility.resolveTarget(targetID: snapshot.targetID)
            guard target.windowNumber == snapshot.windowNumber, target.bounds.equalTo(snapshot.windowBounds) else {
                throw ComputerUseError.staleSnapshot("The target window moved or was replaced during background activation. Take a fresh snapshot before input.")
            }
        }
        try SnapshotPolicy.validateFocus(
            strict: strict, targetPID: snapshot.pid,
            frontmostPID: NSWorkspace.shared.frontmostApplication?.processIdentifier,
            backgroundTargetPID: activationSession == nil ? nil : activationTargetPID
        )
        return target
    }

    private func annotate(snapshot: AppSnapshot) -> AppSnapshot {
        snapshotSequence += 1
        let key = snapshot.targetID
        let labels = Set(snapshot.records.map { stableLabel(for: $0.semantic) }.filter { !$0.isEmpty })
        let previous = previousLabelsByWindow[key] ?? []
        previousLabelsByWindow[key] = labels

        let added = labels.subtracting(previous).sorted()
        let removed = previous.subtracting(labels).sorted()
        return snapshot.withSessionMetadata(
            id: UUID().uuidString.lowercased(),
            observation: snapshotSequence,
            recentActions: Array((recentActionsByTarget[key] ?? []).suffix(8)),
            addedLabels: Array(added.prefix(16)),
            removedLabels: Array(removed.prefix(16))
        )
    }

    private func recordAction(_ metadata: ActionMetadata, targetID: String) -> ActionMetadata {
        var actions = recentActionsByTarget[targetID] ?? []
        actions.append(metadata.message)
        if actions.count > 12 {
            actions.removeFirst(actions.count - 12)
        }
        recentActionsByTarget[targetID] = actions
        return metadata
    }

    private func freshRecord(matching record: AXElementRecord, in snapshot: AppSnapshot) -> AXElementRecord? {
        guard let target = try? accessibility.resolveTarget(targetID: snapshot.targetID) else {
            return nil
        }
        let records = accessibility.records(target: target)
        // Traversal numbers, labels, and text-field values are not identity. A rotating
        // banner can reorder the tree; duplicate unlabeled buttons can share all three.
        return SnapshotPolicy.refreshed(record, in: records)
    }

    private func stableLabel(for element: SemanticAXElement) -> String {
        let value = element.value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
        let display = value.isEmpty ? label : "\(label) \(value)"
        return "\(element.role):\(display)"
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .lowercased()
    }

    private func findRecord(ref: String?, index: Int?, in snapshot: AppSnapshot) -> AXElementRecord? {
        if let ref {
            let normalized = normalizeRef(ref)
            return snapshot.records.first { $0.semantic.ref == normalized }
        }
        if let index {
            if let byID = snapshot.records.first(where: { $0.semantic.id == index }) {
                return byID
            }
            if index >= 0 && index < snapshot.records.count {
                return snapshot.records[index]
            }
        }
        return nil
    }

    private func normalizeRef(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("{e"), trimmed.hasSuffix("}") { return trimmed }
        if trimmed.hasPrefix("e") { return "{\(trimmed)}" }
        return "{e\(trimmed)}"
    }

    private func scrollDeltas(direction: String?, amount: Int32) -> (x: Int32, y: Int32) {
        switch direction?.lowercased() ?? "down" {
        case "up": return (0, amount)
        case "left": return (amount, 0)
        case "right": return (-amount, 0)
        default: return (0, -amount)
        }
    }
}
