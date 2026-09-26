import AppKit

@main
struct NativeMacMain {
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private let core = LabCore()
    private lazy var documentView = NativeDocumentView(core: core)
    private var secondWindow: NSWindow?
    private var secondDocumentView: NativeDocumentView?
    private let nameField = NSTextField(string: "")
    private let status = NSTextField(wrappingLabelWithString: "正在打开项目…")
    private var saveButton: NSButton!
    private var reopenButton: NSButton!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出 Drifting Native Lab", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: #selector(ProseTextView.undo(_:)), keyEquivalent: "z")
        let redoItem = editMenu.addItem(withTitle: "重做", action: #selector(ProseTextView.redo(_:)), keyEquivalent: "z")
        redoItem.keyEquivalentModifierMask = [.command, .shift]
        for (title, action, key) in [("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = editMenu
        menu.addItem(editItem)
        NSApp.mainMenu = menu

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 740),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Drifting Native Lab"
        window.minSize = NSSize(width: 560, height: 640)
        window.delegate = self
        window.isReleasedWhenClosed = false
        let heading = NSTextField(labelWithString: "原生写作实验")
        heading.font = .systemFont(ofSize: 28, weight: .semibold)
        let subtitle = NSTextField(wrappingLabelWithString: "这里使用独立的合成项目。你的日常写作资料不会在这里打开。")
        subtitle.textColor = .secondaryLabelColor
        nameField.placeholderString = "项目名称"
        nameField.font = .systemFont(ofSize: 18)
        nameField.setAccessibilityIdentifier("project-name")
        saveButton = NSButton(title: "保存名称", target: self, action: #selector(save))
        saveButton.keyEquivalent = "s"
        saveButton.setAccessibilityIdentifier("save-project")
        reopenButton = NSButton(title: "重新打开", target: self, action: #selector(reopen))
        reopenButton.setAccessibilityIdentifier("reopen-project")
        let another = NSButton(title: "打开另一个编辑窗口", target: self, action: #selector(openSecondView))
        another.setAccessibilityIdentifier("open-second-view")
        let actions = NSStackView(views: [saveButton, reopenButton, another])
        actions.spacing = 12
        status.textColor = .secondaryLabelColor
        status.setAccessibilityIdentifier("project-status")
        let stack = NSStackView(views: [heading, subtitle, nameField, actions, status, documentView])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 36),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -36),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 36),
            stack.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor, constant: -24),
            nameField.widthAnchor.constraint(equalTo: stack.widthAnchor),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            documentView.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        documentView.onActivity = { [weak self] busy in self?.reopenButton.isEnabled = !busy }
        busy(true)
        core.open { [weak self] result in
            self?.receive(result, message: "项目已打开")
            if case .success = result { self?.documentView.binding.load() }
        }
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func busy(_ value: Bool) {
        nameField.isEnabled = !value
        saveButton.isEnabled = !value
        reopenButton.isEnabled = !value
    }
    private func receive(_ result: Result<LabState, Error>, message: String) {
        busy(false)
        switch result {
        case .success(let state): nameField.stringValue = state.name; status.stringValue = message
        case .failure(let error): status.stringValue = error.localizedDescription
        }
    }
    @objc private func save() {
        guard window.makeFirstResponder(nil) else { return }
        let name = nameField.stringValue
        busy(true)
        core.rename(name) { [weak self] in self?.receive($0, message: "已保存") }
    }
    @objc private func reopen() {
        guard !documentView.binding.hasPendingWork else { return }
        busy(true)
        core.reopen { [weak self] result in
            self?.receive(result, message: "已从磁盘重新打开")
            if case .success = result { self?.documentView.binding.load() }
        }
    }
    @objc private func openSecondView() {
        if let secondWindow { secondWindow.makeKeyAndOrderFront(nil); return }
        let view = NativeDocumentView(core: core)
        let second = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 620),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        second.title = "同一文档 · 第二视图"; second.minSize = NSSize(width: 480, height: 420)
        second.delegate = self; second.isReleasedWhenClosed = false
        view.translatesAutoresizingMaskIntoConstraints = false
        second.contentView!.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: second.contentView!.leadingAnchor, constant: 20),
            view.trailingAnchor.constraint(equalTo: second.contentView!.trailingAnchor, constant: -20),
            view.topAnchor.constraint(equalTo: second.contentView!.topAnchor, constant: 20),
            view.bottomAnchor.constraint(equalTo: second.contentView!.bottomAnchor, constant: -20),
        ])
        secondWindow = second; secondDocumentView = view
        view.binding.load(); second.center(); second.makeKeyAndOrderFront(nil)
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender === secondWindow ? secondDocumentView?.binding.hasUnsubmittedDraft != true : !documentView.binding.hasPendingWork
    }
    func windowWillClose(_ notification: Notification) {
        if notification.object as? NSWindow === window { documentView.binding.detach() }
        if notification.object as? NSWindow === secondWindow {
            secondDocumentView?.binding.detach(); secondDocumentView = nil; secondWindow = nil
        }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        documentView.binding.hasPendingWork ? .terminateCancel : .terminateNow
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
