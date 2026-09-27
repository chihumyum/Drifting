import AppKit
import UniformTypeIdentifiers

/// 诊断摘要: Rust's sanitized workspace summary (counts, sizes, integrity,
/// journal and open-body state) with the app version, macOS version and
/// architecture the host adds. It never holds titles, identities, prose or
/// paths, so an author can share it as it is.
enum DiagnosticSummary {
    static let notice = "这份摘要只有数量、大小和检查结果，用于排查问题。它不包含书名、章节标题、正文、设定内容、标识符或文件路径，可以放心分享。"

    /// What the host adds under `host`.
    static func hostInfo(bundle: Bundle = .main, process: ProcessInfo = .processInfo) -> [String: Any] {
        let version = process.operatingSystemVersion
        #if arch(arm64)
        let architecture = "arm64"
        #else
        let architecture = "x86_64"
        #endif
        return [
            "appVersion": bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "未知",
            "appBuild": bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "未知",
            "macOS": "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)",
            "architecture": architecture,
        ]
    }

    /// Pretty, key-sorted JSON of Rust's summary with `host` added.
    static func text(_ summary: AgentJSON, host: [String: Any] = hostInfo()) -> String {
        var object = (summary.any as? [String: Any]) ?? ["summary": summary.any]
        object["host"] = host
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text + "\n"
    }

    static func fileName(date: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return "Drifting-诊断摘要-\(formatter.string(from: date)).json"
    }
}

/// 帮助 › 诊断摘要…: a read-only window with the summary as JSON, 拷贝 and
/// 存储为….
final class MacDiagnosticsWindowController: NSWindowController, NSWindowDelegate {
    private let workspace: LabWorkspaceCore
    let textView = NSTextView()
    let notice = NSTextField(wrappingLabelWithString: DiagnosticSummary.notice)
    let status = NSTextField(wrappingLabelWithString: "正在生成诊断摘要…")
    let copyButton = NSButton(title: "拷贝", target: nil, action: nil)
    let saveButton = NSButton(title: "存储为…", target: nil, action: nil)
    /// Where 拷贝 writes; acceptance uses a private pasteboard.
    var pasteboard = NSPasteboard.general
    /// Chooses where 存储为… writes; nil uses a save panel. Acceptance answers here.
    var chooseSaveURL: ((NSWindow?, String, @escaping (URL?) -> Void) -> Void)?
    private(set) var summaryText: String?
    var onClose: (() -> Void)?

    init(workspace: LabWorkspaceCore) {
        self.workspace = workspace
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 520), styleMask: [.titled, .closable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "诊断摘要"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 420, height: 360)
        super.init(window: window)
        window.delegate = self
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        textView.textContainerInset = NSSize(width: 6, height: 6)
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.setAccessibilityIdentifier("diagnostics-text")
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder; scroll.documentView = textView
        notice.font = .systemFont(ofSize: 12)
        notice.setAccessibilityIdentifier("diagnostics-notice")
        status.textColor = .secondaryLabelColor
        status.font = .systemFont(ofSize: 11)
        status.setAccessibilityIdentifier("diagnostics-status")
        copyButton.target = self; copyButton.action = #selector(copySummary)
        copyButton.setAccessibilityIdentifier("diagnostics-copy")
        saveButton.target = self; saveButton.action = #selector(saveSummary)
        saveButton.setAccessibilityIdentifier("diagnostics-save")
        copyButton.isEnabled = false; saveButton.isEnabled = false
        let close = NSButton(title: "关闭", target: self, action: #selector(closeWindow))
        close.keyEquivalent = "\u{1b}"
        let buttons = NSStackView(views: [copyButton, saveButton, NSView(), close])
        let stack = NSStackView(views: [notice, scroll, status, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            notice.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 220),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func windowWillClose(_ notification: Notification) { onClose?() }

    /// Reads the summary again and shows it.
    func load(completion: ((Result<String, Error>) -> Void)? = nil) {
        status.stringValue = "正在生成诊断摘要…"
        workspace.diagnostics { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let summary):
                let text = DiagnosticSummary.text(summary)
                self.summaryText = text
                self.textView.string = text
                self.copyButton.isEnabled = true; self.saveButton.isEnabled = true
                self.status.stringValue = "只读。可以拷贝或存储为 JSON 文件后分享。"
                completion?(.success(text))
            case .failure(let error):
                self.status.stringValue = error.localizedDescription
                completion?(.failure(error))
            }
        }
    }

    @objc func copySummary() {
        guard let summaryText else { return }
        pasteboard.clearContents()
        pasteboard.setString(summaryText, forType: .string)
        status.stringValue = "诊断摘要已拷贝。"
    }

    @objc func saveSummary() { save(completion: nil) }

    func save(completion: ((Result<URL, Error>) -> Void)?) {
        guard let summaryText else { return }
        let write: (URL?) -> Void = { [weak self] url in
            guard let self, let url else { completion?(.failure(LabError.message("已取消存储。"))); return }
            do {
                try Data(summaryText.utf8).write(to: url, options: .atomic)
                self.status.stringValue = "诊断摘要已存储为“\(url.lastPathComponent)”。"
                completion?(.success(url))
            } catch {
                self.status.stringValue = "无法写入“\(url.lastPathComponent)”，请换一个位置再试。"
                completion?(.failure(LabError.message(self.status.stringValue)))
            }
        }
        let name = DiagnosticSummary.fileName()
        if let chooseSaveURL { chooseSaveURL(window, name, write); return }
        let panel = NSSavePanel()
        panel.title = "存储诊断摘要"
        panel.nameFieldStringValue = name
        panel.allowedContentTypes = [.json]
        panel.canCreateDirectories = true
        if let window { panel.beginSheetModal(for: window) { write($0 == .OK ? panel.url : nil) } }
        else { write(panel.runModal() == .OK ? panel.url : nil) }
    }

    @objc private func closeWindow() { window?.close() }
}
