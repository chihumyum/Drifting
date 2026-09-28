import AppKit
import CryptoKit
import UniformTypeIdentifiers

/// What the 恢复 window says, and what 拷贝诊断信息 copies: the failure's
/// code and versions with the host's app and macOS versions and
/// architecture. Never a path, title or identity beyond the opaque recovery
/// session.
enum DatabaseRecoveryText {
    static func detail(_ status: WorkspaceRecoveryStatus) -> String {
        if status.safetyBackup != nil {
            return "升级前已为资料库做了一份经过校验的安全副本。可以再试一次打开，或用安全副本重建资料库。在此之前不会打开或写入任何项目。"
        }
        if status.upgradeStopped {
            return "这次升级的恢复记录无法校验，没有可用的安全副本。可以再试一次打开；问题持续时，请拷贝诊断信息。"
        }
        return "可以再试一次打开；问题持续时，请拷贝诊断信息。在此之前不会打开或写入任何项目。"
    }

    /// “0.1.0 → 0.1.1”, or 未知 for an unknown earlier version.
    static func versions(_ status: WorkspaceRecoveryStatus) -> String {
        "\(status.sourceVersion ?? "未知") → \(status.targetVersion)"
    }

    /// “2.1 MB · 2026-09-28 14:05 · SHA-256 3f2a9c1b0d4e”, or 没有可用的安全副本.
    static func backup(_ status: WorkspaceRecoveryStatus) -> String {
        guard let backup = status.safetyBackup else { return "没有可用的安全副本" }
        return "\(size(backup.sizeBytes)) · \(time(backup.createdAtMs)) · SHA-256 \(backup.sha256.prefix(12))"
    }

    static func size(_ bytes: UInt64) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(clamping: bytes))
    }

    static func time(_ milliseconds: UInt64) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter.string(from: Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1000))
    }

    /// `Drifting-database-safety-<first 16 of backupId>.sqlite`.
    static func exportName(_ backup: WorkspaceRecoveryStatus.SafetyBackup) -> String {
        "Drifting-database-safety-\(backup.backupId.prefix(16)).sqlite"
    }

    /// Pretty, key-sorted JSON for 拷贝诊断信息.
    static func diagnostics(_ status: WorkspaceRecoveryStatus, host: [String: Any] = DiagnosticSummary.hostInfo()) -> String {
        var object: [String: Any] = [
            "kind": "drifting-database-recovery",
            "code": status.code,
            "sourceVersion": status.sourceVersion ?? NSNull(),
            "targetVersion": status.targetVersion,
            "safetyBackupAvailable": status.safetyBackup != nil,
            "host": host,
        ]
        if let session = status.recoverySessionId { object["recoverySessionId"] = session }
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text + "\n"
    }
}

/// Opens the workspace, or shows 恢复 instead when it does not open. The
/// app opens through it at launch and on every reopen; while it recovers,
/// nothing else opens or writes. 重试 and 恢复安全副本… open the workspace
/// again and hand its projects back through `onRecovered`.
final class DatabaseRecoveryCoordinator {
    let workspace: LabWorkspaceCore
    private(set) var controller: MacDatabaseRecoveryWindowController?
    var isRecovering: Bool { controller != nil }
    /// The workspace did not open: hide everything that shows it.
    var onRecovering: (() -> Void)?
    /// 重试 or 恢复安全副本… opened the workspace; the 恢复 window has closed.
    var onRecovered: (([WorkspaceProject]) -> Void)?
    /// Each new 恢复 window before it shows, e.g. acceptance's panels.
    var configure: ((MacDatabaseRecoveryWindowController) -> Void)?

    init(workspace: LabWorkspaceCore) { self.workspace = workspace }

    /// Whether an error means the workspace itself did not open.
    static func isOpenFailure(_ error: Error) -> Bool {
        if case LabError.workspaceUnavailable = error { return true }
        return false
    }

    /// The projects, opening the workspace when needed. When it does not
    /// open, the 恢复 window shows (the completion still hears the failure).
    func open(completion: ((Result<[WorkspaceProject], Error>) -> Void)? = nil) {
        workspace.projects { [weak self] result in
            if case .failure(let error) = result, Self.isOpenFailure(error) { self?.recover(from: error) }
            completion?(result)
        }
    }

    /// Shows 恢复 for this failure, or updates the window already shown.
    func recover(from error: Error) {
        if let controller {
            controller.show(error)
        } else {
            let controller = MacDatabaseRecoveryWindowController(workspace: workspace)
            self.controller = controller
            controller.onOpened = { [weak self] projects in self?.recovered(projects) }
            configure?(controller)
            controller.window?.center()
            controller.show(error)
            controller.showWindow(nil)
        }
        onRecovering?()
    }

    private func recovered(_ projects: [WorkspaceProject]) {
        let controller = self.controller
        self.controller = nil
        controller?.onOpened = nil
        controller?.window?.close()
        onRecovered?(projects)
    }
}

/// 恢复: shown instead of the workspace when it does not open. It says what
/// happened, the versions and the safety copy, and offers 重试, 恢复安全副本…,
/// 导出安全副本…, 在访达中显示, 拷贝诊断信息 and 退出. Buttons that need the
/// safety copy (or its recovery session) are off without one.
final class MacDatabaseRecoveryWindowController: NSWindowController, NSWindowDelegate {
    private let workspace: LabWorkspaceCore
    let headline = NSTextField(wrappingLabelWithString: "")
    let detail = NSTextField(wrappingLabelWithString: "")
    let codeValue = NSTextField(labelWithString: "")
    let versionValue = NSTextField(labelWithString: "")
    let backupValue = NSTextField(wrappingLabelWithString: "")
    let notice = NSTextField(wrappingLabelWithString: "")
    let retryButton = NSButton(title: "重试", target: nil, action: nil)
    let restoreButton = NSButton(title: "恢复安全副本…", target: nil, action: nil)
    let exportButton = NSButton(title: "导出安全副本…", target: nil, action: nil)
    let revealButton = NSButton(title: "在访达中显示", target: nil, action: nil)
    let copyButton = NSButton(title: "拷贝诊断信息", target: nil, action: nil)
    let quitButton = NSButton(title: "退出", target: nil, action: nil)
    /// The open failure shown, as Rust gave it.
    private(set) var failure: String?
    private(set) var status: WorkspaceRecoveryStatus?
    private(set) var busy = false
    /// Status reads, for acceptance.
    private(set) var statusReads = 0
    /// 重试 or 恢复安全副本… opened the workspace.
    var onOpened: (([WorkspaceProject]) -> Void)?
    /// Where 拷贝诊断信息 writes; acceptance uses a private pasteboard.
    var pasteboard = NSPasteboard.general
    /// Presents the restore confirmation; nil uses a sheet. Acceptance answers here.
    var presentAlert: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
    /// Chooses where 导出安全副本… writes (default name given); nil uses a save panel.
    var chooseSaveURL: ((String, @escaping (URL?) -> Void) -> Void)?
    /// 在访达中显示; nil opens a Finder window on the folder.
    var reveal: ((URL) -> Void)?
    /// 退出; nil terminates the app.
    var quit: (() -> Void)?

    init(workspace: LabWorkspaceCore) {
        self.workspace = workspace
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 360), styleMask: [.titled, .closable],
                              backing: .buffered, defer: false)
        window.title = "恢复本地资料库"
        window.isReleasedWhenClosed = false
        window.setAccessibilityIdentifier("database-recovery")
        super.init(window: window)
        window.delegate = self
        headline.font = .systemFont(ofSize: 17, weight: .semibold)
        headline.setAccessibilityIdentifier("recovery-headline")
        detail.textColor = .secondaryLabelColor
        detail.setAccessibilityIdentifier("recovery-detail")
        notice.setAccessibilityIdentifier("recovery-notice")
        notice.isHidden = true
        codeValue.setAccessibilityIdentifier("recovery-code")
        versionValue.setAccessibilityIdentifier("recovery-versions")
        backupValue.setAccessibilityIdentifier("recovery-backup")
        for label in [codeValue, versionValue, backupValue] { label.isSelectable = true }
        let grid = NSGridView(views: [
            [Self.key("错误代码"), codeValue],
            [Self.key("版本"), versionValue],
            [Self.key("安全副本"), backupValue],
        ])
        grid.columnSpacing = 12; grid.rowSpacing = 6
        grid.column(at: 0).xPlacement = .trailing
        grid.rowAlignment = .firstBaseline
        for (button, id, action) in [(retryButton, "recovery-retry", #selector(retry)), (restoreButton, "recovery-restore", #selector(restore)),
                                     (exportButton, "recovery-export", #selector(exportBackup)),
                                     (revealButton, "recovery-reveal", #selector(revealFolder)),
                                     (copyButton, "recovery-copy", #selector(copyDiagnostics)), (quitButton, "recovery-quit", #selector(quitApp))] {
            button.target = self; button.action = action
            button.setAccessibilityIdentifier(id)
        }
        retryButton.keyEquivalent = "\r"
        let primary = NSStackView(views: [retryButton, restoreButton, exportButton])
        let secondary = NSStackView(views: [revealButton, copyButton, NSView(), quitButton])
        let stack = NSStackView(views: [headline, detail, grid, notice, primary, secondary])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.setCustomSpacing(18, after: grid)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -20),
            headline.widthAnchor.constraint(equalTo: stack.widthAnchor),
            detail.widthAnchor.constraint(equalTo: stack.widthAnchor),
            notice.widthAnchor.constraint(equalTo: stack.widthAnchor),
            secondary.widthAnchor.constraint(equalTo: stack.widthAnchor),
            backupValue.widthAnchor.constraint(lessThanOrEqualToConstant: 400),
        ])
        updateButtons()
        fitHeight()
    }

    /// The window is as tall as what it says.
    private func fitHeight() {
        guard let window, let content = window.contentView else { return }
        content.layoutSubtreeIfNeeded()
        guard let stack = content.subviews.first, stack.frame.height > 0 else { return }
        window.setContentSize(NSSize(width: content.frame.width, height: max(stack.frame.height + 40, 240)))
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private static func key(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.textColor = .secondaryLabelColor
        return label
    }

    /// Closing the window is 退出: nothing else is open.
    func windowWillClose(_ notification: Notification) {
        guard onOpened != nil else { return }
        onOpened = nil
        (quit ?? { NSApp.terminate(nil) })()
    }

    // MARK: State

    /// Shows an open failure: its headline at once, then Rust's status of it.
    func show(_ error: Error, notice message: String? = nil, completion: (() -> Void)? = nil) {
        let reason = (error as? LabError)?.diagnosticDescription ?? error.localizedDescription
        failure = reason
        headline.stringValue = WorkspaceRecoveryStatus.headline(stopped: WorkspaceRecoveryStatus.isStoppedUpgrade(reason))
        showNotice(message)
        setBusy(true)
        workspace.recoveryStatus(error: reason) { [weak self] result in
            guard let self else { return }
            self.statusReads += 1
            switch result {
            case .success(let status): self.apply(status); self.fitHeight()
            case .failure:
                // Without a status the window still offers 重试 and 退出.
                self.status = nil
                self.detail.stringValue = "无法读取这次失败的详细信息。可以再试一次打开，或退出。"
                self.codeValue.stringValue = "未知"; self.versionValue.stringValue = "未知"
                self.backupValue.stringValue = "没有可用的安全副本"
            }
            self.setBusy(false)
            completion?()
        }
    }

    private func apply(_ status: WorkspaceRecoveryStatus) {
        self.status = status
        headline.stringValue = WorkspaceRecoveryStatus.headline(stopped: status.upgradeStopped)
        detail.stringValue = DatabaseRecoveryText.detail(status)
        codeValue.stringValue = status.code
        versionValue.stringValue = DatabaseRecoveryText.versions(status)
        backupValue.stringValue = DatabaseRecoveryText.backup(status)
    }

    private func showNotice(_ message: String?, error: Bool = false) {
        notice.stringValue = message ?? ""
        notice.textColor = error ? .systemRed : .labelColor
        notice.isHidden = message == nil
    }

    private func setBusy(_ value: Bool) {
        busy = value
        updateButtons()
    }

    private func updateButtons() {
        let idle = !busy
        let session = status?.recoverySessionId != nil
        let backup = session && status?.safetyBackup != nil
        retryButton.isEnabled = idle
        restoreButton.isEnabled = idle && backup
        exportButton.isEnabled = idle && backup
        revealButton.isEnabled = idle && session
        copyButton.isEnabled = idle && status != nil
        quitButton.isEnabled = idle
    }

    // MARK: Commands

    /// 重试: opens the workspace again. A failure shows its new status.
    @objc func retry() {
        guard !busy else { return }
        setBusy(true)
        showNotice("正在重新打开…")
        workspace.retryOpen { [weak self] result in self?.opened(result, failed: "重试没有成功，资料库保持原样。") }
    }

    /// 恢复安全副本…: after confirmation, Rust rebuilds the database from the
    /// copy made before the upgrade and the workspace opens.
    @objc func restore() {
        guard !busy, let session = status?.recoverySessionId, let backup = status?.safetyBackup else { return }
        let alert = NSAlert()
        alert.messageText = "用安全副本恢复资料库？"
        alert.informativeText = "将用升级前（\(DatabaseRecoveryText.time(backup.createdAtMs))）做的安全副本重建本地资料库，重新升级后打开。安全副本本身保持不变。"
        alert.addButton(withTitle: "恢复")
        alert.addButton(withTitle: "取消")
        let answer: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard let self, response == .alertFirstButtonReturn, !self.busy else { return }
            self.setBusy(true)
            self.showNotice("正在用安全副本恢复…")
            self.workspace.restoreSafetyBackup(sessionID: session, backupID: backup.backupId) { [weak self] result in
                self?.opened(result, failed: "恢复没有完成，资料库保持原样。")
            }
        }
        if let presentAlert { presentAlert(alert, answer); return }
        if let window { alert.beginSheetModal(for: window, completionHandler: answer) } else { answer(alert.runModal()) }
    }

    private func opened(_ result: Result<[WorkspaceProject], Error>, failed: String) {
        switch result {
        case .success(let projects):
            setBusy(false)
            showNotice(nil)
            onOpened?(projects)
        case .failure(let error):
            // The window follows the new failure.
            show(error, notice: DatabaseRecoveryCoordinator.isOpenFailure(error) ? failed : "\(failed)（\(error.localizedDescription)）")
            notice.textColor = .systemRed
        }
    }

    /// 导出安全副本…: copies the verified file where the author chooses; the
    /// copy is checked against its SHA-256 and the original stays in place.
    @objc func exportBackup() { export(completion: nil) }

    func export(completion: ((Result<URL, Error>) -> Void)?) {
        guard !busy, let session = status?.recoverySessionId, let backup = status?.safetyBackup else { return }
        let name = DatabaseRecoveryText.exportName(backup)
        let write: (URL?) -> Void = { [weak self] destination in
            guard let self else { return }
            guard let destination else { completion?(.failure(LabError.message("已取消导出。"))); return }
            self.setBusy(true)
            self.workspace.recoveryBackupFile(sessionID: session, backupID: backup.backupId) { [weak self] result in
                guard let self else { return }
                self.setBusy(false)
                do {
                    let source = try result.get()
                    try Self.copy(source, to: destination, sha256: backup.sha256)
                    self.showNotice("安全副本已导出为“\(destination.lastPathComponent)”。")
                    completion?(.success(destination))
                } catch {
                    self.showNotice("无法导出安全副本，请换一个位置再试。", error: true)
                    completion?(.failure(LabError.message(self.notice.stringValue)))
                }
            }
        }
        if let chooseSaveURL { chooseSaveURL(name, write); return }
        let panel = NSSavePanel()
        panel.title = "导出安全副本"
        panel.nameFieldStringValue = name
        panel.allowedContentTypes = [UTType(filenameExtension: "sqlite") ?? .data]
        panel.canCreateDirectories = true
        if let window { panel.beginSheetModal(for: window) { write($0 == .OK ? panel.url : nil) } }
        else { write(panel.runModal() == .OK ? panel.url : nil) }
    }

    /// Copies beside the destination first and replaces it only once the
    /// copy's SHA-256 matches; the source is never moved or changed.
    static func copy(_ source: URL, to destination: URL, sha256: String) throws {
        let manager = FileManager.default
        let partial = destination.deletingLastPathComponent().appendingPathComponent(".\(destination.lastPathComponent).\(UUID().uuidString).partial")
        try manager.copyItem(at: source, to: partial)
        do {
            let digest = SHA256.hash(data: try Data(contentsOf: partial, options: .mappedIfSafe)).map { String(format: "%02x", $0) }.joined()
            guard digest == sha256.lowercased() else { throw LabError.message("安全副本校验不一致") }
            if manager.fileExists(atPath: destination.path) {
                _ = try manager.replaceItemAt(destination, withItemAt: partial)
            } else {
                try manager.moveItem(at: partial, to: destination)
            }
        } catch {
            try? manager.removeItem(at: partial)
            throw error
        }
    }

    /// 在访达中显示: the folder that holds the safety copy.
    @objc func revealFolder() { revealBackupFolder(completion: nil) }

    func revealBackupFolder(completion: ((Result<URL, Error>) -> Void)?) {
        guard !busy, let session = status?.recoverySessionId else { return }
        workspace.recoveryBackupFolder(sessionID: session) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let folder):
                (self.reveal ?? { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: $0.path) })(folder)
                completion?(.success(folder))
            case .failure(let error):
                self.showNotice("无法找到安全副本所在的文件夹。", error: true)
                completion?(.failure(error))
            }
        }
    }

    /// 拷贝诊断信息: the code, versions and host facts as JSON.
    @objc func copyDiagnostics() {
        guard let status else { return }
        pasteboard.clearContents()
        pasteboard.setString(DatabaseRecoveryText.diagnostics(status), forType: .string)
        showNotice("诊断信息已拷贝。其中没有书名、正文、文件路径或标识符。")
    }

    @objc func quitApp() {
        onOpened = nil
        (quit ?? { NSApp.terminate(nil) })()
    }
}
