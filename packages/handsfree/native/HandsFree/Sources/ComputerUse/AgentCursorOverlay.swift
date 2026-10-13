import AppKit

final class AgentCursorOverlay: @unchecked Sendable {
    static let shared = AgentCursorOverlay()

    private var panel: AgentCursorPanel?
    private var lastPoint: CGPoint?
    private var lastPID: pid_t?
    private var lastWindowNumber: Int?
    private var targetBounds: CGRect?
    private var visibilityTimer: Timer?
    private let size = CGSize(width: 30, height: 34)

    func show(at point: CGPoint) {
        DispatchQueue.main.async { [weak self] in
            self?.showOnMain(at: point)
        }
    }

    func present(in bounds: CGRect, pid: pid_t, windowNumber: Int?) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let point: CGPoint
            if self.lastPID == pid, let previous = self.lastPoint, bounds.contains(previous) {
                point = previous
            } else {
                point = CGPoint(x: bounds.midX, y: bounds.midY)
            }
            self.lastPID = pid
            self.lastWindowNumber = windowNumber
            self.targetBounds = bounds
            self.showOnMain(at: point)
        }
    }

    private func showOnMain(at point: CGPoint) {
        lastPoint = point
        let panel = ensurePanel()
        panel.setFrame(frame(for: point), display: true, animate: false)
        refreshVisibility()
        if visibilityTimer == nil {
            visibilityTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                self?.refreshVisibility()
            }
        }
    }

    private func refreshVisibility() {
        guard let panel, let pid = lastPID, let point = lastPoint,
              targetBounds?.contains(point) == true,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
              targetWindowIsVisible(pid: pid) else {
            panel?.orderOut(nil)
            return
        }
        panel.orderFrontRegardless()
    }

    private func targetWindowIsVisible(pid: pid_t) -> Bool {
        guard let lastWindowNumber else { return true }
        guard let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else { return false }
        return windows.first {
            ($0[kCGWindowOwnerPID as String] as? Int32) == pid &&
            ($0[kCGWindowLayer as String] as? Int) == 0
        }?[kCGWindowNumber as String] as? Int == lastWindowNumber
    }

    private func ensurePanel() -> AgentCursorPanel {
        if let panel { return panel }

        let panel = AgentCursorPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.contentView = AgentCursorView(frame: NSRect(origin: .zero, size: size))
        self.panel = panel
        return panel
    }

    private func frame(for topLeftPoint: CGPoint) -> NSRect {
        let primaryScreenTop = NSScreen.screens.first?.frame.maxY ?? 900
        let x = topLeftPoint.x - 9
        let y = primaryScreenTop - topLeftPoint.y - size.height + 2
        return NSRect(x: x, y: y, width: size.width, height: size.height)
    }
}

final class AgentCursorPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class AgentCursorView: NSView {
    override var isOpaque: Bool { false }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        let path = BrowserPointerArtwork.path()

        NSColor.white.setFill()
        path.fill()

        NSColor(calibratedWhite: 0.05, alpha: 0.65).setStroke()
        path.lineWidth = 1
        path.stroke()
    }
}
