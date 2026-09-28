import AppKit

/// 设置 › 快捷键 (renderer: KeysPanel): the installed main menu's commands
/// grouped by menu with their shortcuts. Clicking a shortcut records the
/// next key press; Esc cancels and ⌫ removes it. A conflict with another
/// command, a combination macOS reserves (screenshots, input sources,
/// Mission Control) or the text editor uses (⌘/⌥ arrows, ⌘⌫, ⌥⌫, ⌃A/⌃E/⌃K
/// and the other Emacs keys) or one without ⌘ or ⌃ is refused in Chinese
/// while recording continues. The system's text-editing
/// commands and 退出 are listed but cannot change. Every change saves at
/// once and the menu follows through `MacShortcutApplier`.
final class MacShortcutSettingsViewController: NSViewController {
    let store: LabSettingsStore
    /// The menu whose commands are listed; the app's main menu by default.
    var menuSource: () -> NSMenu? = { NSApp.mainMenu }
    let message = NSTextField(wrappingLabelWithString: "")
    let resetAllButton = NSButton(title: "全部还原", target: nil, action: nil)
    private let rows = NSStackView()
    private let storageMessage = SettingsLayout.storageLabel()
    /// Each listed command's shortcut button (a label for system commands).
    private(set) var shortcutButtons: [MacMenuCommand: NSButton] = [:]
    private(set) var resetButtons: [MacMenuCommand: NSButton] = [:]
    /// The listed commands, grouped by menu, as last read from the menu.
    private(set) var listed: [(title: String, commands: [(command: MacMenuCommand, title: String)])] = []
    /// The command whose shortcut the next key press sets.
    private(set) var recording: MacMenuCommand?
    private var monitor: Any?

    init(store: LabSettingsStore) {
        self.store = store
        super.init(nibName: nil, bundle: nil)
        title = "快捷键"
        message.font = .systemFont(ofSize: 12)
        message.preferredMaxLayoutWidth = SettingsLayout.width - 48
        message.isHidden = true
        message.setAccessibilityIdentifier("shortcuts-message")
        resetAllButton.target = self; resetAllButton.action = #selector(resetAll)
        resetAllButton.setAccessibilityIdentifier("shortcuts-reset-all")
        rows.orientation = .vertical; rows.alignment = .leading; rows.spacing = 6
        rows.setAccessibilityIdentifier("shortcuts-list")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { if let monitor { NSEvent.removeMonitor(monitor) } }

    override func loadView() {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.drawsBackground = false; scroll.borderType = .noBorder
        let document = AgentFlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        rows.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(rows)
        scroll.documentView = document
        scroll.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            rows.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            rows.topAnchor.constraint(equalTo: document.topAnchor),
            rows.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -8),
            document.trailingAnchor.constraint(greaterThanOrEqualTo: rows.trailingAnchor),
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            scroll.widthAnchor.constraint(equalToConstant: SettingsLayout.width - 48),
            scroll.heightAnchor.constraint(equalToConstant: 420),
        ])
        view = SettingsLayout.page([
            SettingsLayout.heading("菜单命令"),
            SettingsLayout.detail("点按快捷键后按下新的组合即可更改，Esc 取消，⌫ 移除。与其他命令冲突、由系统保留（截屏、切换输入法、调度中心等）或由文本编辑使用（⌘/⌥ 加方向键、⌘⌫、⌥⌫、⌃A、⌃E、⌃K 等）的组合不会被接受。系统的文本编辑快捷键（撤销、复制、粘贴等）和“退出”不能在这里更改。"),
            message, scroll, SettingsLayout.line([resetAllButton]), storageMessage,
        ], spacing: [1: 12])
        refresh()
    }

    override func viewWillDisappear() {
        super.viewWillDisappear()
        endRecording()
    }

    /// Reads the menu's commands again and shows every current shortcut.
    func refresh() {
        guard isViewLoaded else { return }
        let effective = MacShortcuts.effective(store.settings.shortcuts)
        let groups = menuSource().map(MacMainMenu.groups) ?? []
        let sameList = groups.map { $0.title } == listed.map { $0.title }
            && groups.map { $0.commands.map(\.command) } == listed.map { $0.commands.map(\.command) }
        if !sameList {
            listed = groups
            rebuild()
        }
        for (command, button) in shortcutButtons {
            let shortcut = effective[command] ?? .unassigned
            button.title = recording == command ? "请按下快捷键…" : shortcut.display
            button.setAccessibilityValue(shortcut.display)
            resetButtons[command]?.isHidden = command.isSystem || store.settings.shortcuts[command.rawValue] == nil
        }
        resetAllButton.isEnabled = store.settings.shortcuts.keys.contains { MacMenuCommand(rawValue: $0) != nil }
        SettingsLayout.storage(storageMessage, store)
    }

    private func rebuild() {
        for view in rows.arrangedSubviews { rows.removeArrangedSubview(view); view.removeFromSuperview() }
        shortcutButtons = [:]; resetButtons = [:]
        for (index, group) in listed.enumerated() {
            let heading = SettingsLayout.heading(group.title)
            rows.addArrangedSubview(heading)
            if index > 0 { rows.setCustomSpacing(16, after: rows.arrangedSubviews[rows.arrangedSubviews.count - 2]) }
            let grid = NSGridView(views: group.commands.map { entry -> [NSView] in
                let name = NSTextField(labelWithString: entry.title)
                name.lineBreakMode = .byTruncatingTail
                let button = NSButton(title: "", target: self, action: #selector(toggleRecording(_:)))
                button.bezelStyle = .rounded; button.controlSize = .small
                button.setAccessibilityIdentifier("shortcut-\(entry.command.rawValue)")
                button.setAccessibilityLabel("\(group.title) › \(entry.title) 的快捷键")
                button.identifier = NSUserInterfaceItemIdentifier(entry.command.rawValue)
                shortcutButtons[entry.command] = button
                let reset = NSButton(title: "还原", target: self, action: #selector(resetOne(_:)))
                reset.bezelStyle = .rounded; reset.controlSize = .small
                reset.identifier = NSUserInterfaceItemIdentifier(entry.command.rawValue)
                reset.setAccessibilityIdentifier("shortcut-reset-\(entry.command.rawValue)")
                resetButtons[entry.command] = reset
                if entry.command.isSystem {
                    button.isEnabled = false
                    button.toolTip = "系统命令的快捷键不能更改"
                    let system = NSTextField(labelWithString: "系统")
                    system.textColor = .secondaryLabelColor
                    system.font = .systemFont(ofSize: 11)
                    return [name, button, system]
                }
                return [name, button, reset]
            })
            grid.columnSpacing = 12; grid.rowSpacing = 6
            grid.column(at: 0).width = 220
            grid.column(at: 1).width = 120
            grid.rowAlignment = .firstBaseline
            rows.addArrangedSubview(grid)
        }
    }

    // MARK: Recording

    @objc private func toggleRecording(_ sender: NSButton) {
        guard let raw = sender.identifier?.rawValue, let command = MacMenuCommand(rawValue: raw) else { return }
        if recording == command { endRecording(); refresh(); return }
        beginRecording(command)
    }

    /// The next key press sets `command`'s shortcut; menus do not see it.
    func beginRecording(_ command: MacMenuCommand) {
        guard !command.isSystem else { show("“\(command.title)”是系统命令，快捷键不能更改。", error: true); return }
        recording = command
        show(nil)
        if monitor == nil {
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, self.recording != nil, event.window == nil || event.window === self.view.window else { return event }
                return self.record(event) ? nil : event
            }
        }
        refresh()
    }

    func endRecording() {
        recording = nil
        if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
        if isViewLoaded { refresh() }
    }

    /// Handles a key press while recording; true when it was consumed.
    @discardableResult
    func record(_ event: NSEvent) -> Bool {
        guard let command = recording else { return false }
        let flags = event.modifierFlags.intersection([.command, .option, .control, .shift])
        if event.keyCode == 53, flags.isEmpty { endRecording(); show(nil); return true }
        guard let shortcut = MenuShortcut.recorded(from: event) else { return true }
        if flags.isEmpty, [0x08, 0x7F].contains(shortcut.key.unicodeScalars.first.map { Int($0.value) } ?? 0) {
            return set(.unassigned, for: command)
        }
        return set(shortcut, for: command, keyCode: event.keyCode)
    }

    /// Sets a command's shortcut through the rules; a refusal keeps
    /// recording and says why. `.unassigned` removes the shortcut.
    /// `keyCode` is the pressed key's, which reserved combinations also
    /// compare on (⇧⌘3 types “#”).
    @discardableResult
    func set(_ shortcut: MenuShortcut, for command: MacMenuCommand, keyCode: UInt16? = nil) -> Bool {
        if let refusal = MacShortcuts.refusal(shortcut, for: command, overrides: store.settings.shortcuts, keyCode: keyCode) {
            show(refusal, error: true); return true
        }
        recording = nil
        if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
        store.setShortcut(shortcut, for: command)
        show(shortcut.isNone ? "已移除“\(MacMainMenu.path(command))”的快捷键。"
             : "“\(MacMainMenu.path(command))”的快捷键已改为 \(shortcut.display)。", error: false)
        refresh()
        return true
    }

    // MARK: Reset

    @objc private func resetOne(_ sender: NSButton) {
        guard let raw = sender.identifier?.rawValue, let command = MacMenuCommand(rawValue: raw) else { return }
        reset(command)
    }

    /// 还原: the command's default, unless another command now uses it.
    func reset(_ command: MacMenuCommand) {
        endRecording()
        let target = command.defaultShortcut
        if !target.isNone, let other = MacMainMenu.layout.flatMap({ $0.items.compactMap { $0 } }).first(where: {
            $0 != command && store.settings.shortcuts[$0.rawValue] == target
        }) {
            show("无法还原：默认快捷键“\(target.display)”已用于“\(MacMainMenu.path(other))”。请先更改那个命令。", error: true)
            return
        }
        store.setShortcut(nil, for: command)
        show("“\(MacMainMenu.path(command))”已还原为 \(target.display)。", error: false)
        refresh()
    }

    @objc func resetAll() {
        endRecording()
        store.resetAllShortcuts()
        show("所有快捷键已还原为默认。", error: false)
        refresh()
    }

    private func show(_ text: String?, error: Bool = false) {
        message.stringValue = text ?? ""
        message.textColor = error ? .systemRed : .secondaryLabelColor
        message.isHidden = text == nil
    }
}
