import AppKit

// MARK: 设置 › 写作助手 › MCP 扩展

/// The open project's MCP servers: add, edit, enable or disable and remove
/// them, see each one's health (未启用 / 连接中… / 可用 N 个工具 / 出错：…)
/// and discovered tools, and choose 允许 / 每次询问 / 禁用 per tool.
/// Settings go to `settings.json`; secret values go to the Keychain only.
final class MacMcpSettingsViewController: NSViewController {
    struct Project {
        let id: String
        let name: String
        let hub: AgentMcpHub?
    }

    let store: LabSettingsStore
    /// The open project and its servers' hub; nil without a project.
    var source: (() -> Project?)? { didSet { refresh() } }
    /// Where secret values go: the writing assistant's Keychain service.
    var secrets: AgentSecretStore?
    /// Whether a project still exists; a sheet or confirmation opened on a
    /// project deleted since is refused. Nil treats every project as live.
    var projectExists: ((String) -> Bool)?
    /// Confirmations; nil shows them on the settings window. Acceptance
    /// answers them here.
    var presentAlert: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
    /// Shows the edit sheet; nil begins it on the settings window.
    var presentSheet: ((MacMcpServerSheet) -> Void)?
    let projectLabel = NSTextField(wrappingLabelWithString: "")
    let addButton = NSButton(title: "添加服务器…", target: nil, action: nil)
    let message = SettingsLayout.detail("")
    let serversStack = NSStackView()
    private(set) var rows: [String: MacMcpServerRow] = [:]
    /// The sheet shown last, while it is open.
    private(set) var sheet: MacMcpServerSheet?

    init(store: LabSettingsStore) {
        self.store = store
        super.init(nibName: nil, bundle: nil)
        title = "MCP 扩展"
        projectLabel.setAccessibilityIdentifier("settings-mcp-project")
        addButton.target = self; addButton.action = #selector(addServer)
        addButton.setAccessibilityIdentifier("settings-mcp-add")
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("settings-mcp-message")
        serversStack.orientation = .vertical; serversStack.alignment = .leading; serversStack.spacing = 16
        serversStack.setAccessibilityIdentifier("settings-mcp-servers")
        NotificationCenter.default.addObserver(self, selector: #selector(hubChanged(_:)), name: AgentMcpHub.didChange, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(storeChanged), name: LabSettingsStore.mcpDidChange, object: store)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        let note = SettingsLayout.detail("""
            MCP 服务器为写作助手提供额外的工具，按项目分别设置。工具的结果只交给写作助手，不会直接修改作品。\
            本地命令会在这台 Mac 上运行，请只添加你信任的服务器。密钥保存在钥匙串（Drifting Native Lab）中，不写入设置文件。
            """)
        note.preferredMaxLayoutWidth = SettingsLayout.width - 48
        serversStack.widthAnchor.constraint(equalToConstant: SettingsLayout.width - 48).isActive = true
        view = SettingsLayout.page([projectLabel, note, SettingsLayout.line([addButton]), message, serversStack], spacing: [1: 12, 2: 12])
        refresh()
    }

    override func viewWillAppear() { super.viewWillAppear(); refresh() }

    private var project: Project? { source?() }
    private var servers: [AgentMcpServerConfig] { project.map { store.mcpServers(projectID: $0.id) } ?? [] }

    @objc private func hubChanged(_ notification: Notification) {
        guard isViewLoaded, let hub = project?.hub, notification.object as AnyObject? === hub else { return }
        refresh()
    }

    @objc private func storeChanged() { if isViewLoaded { refresh() } }

    func refresh() {
        guard isViewLoaded else { return }
        let project = self.project
        projectLabel.stringValue = project.map { "项目《\($0.name)》的 MCP 服务器" } ?? "没有打开的项目。打开一个项目后，可以在这里为它添加 MCP 服务器。"
        addButton.isEnabled = project != nil
        for view in serversStack.arrangedSubviews { serversStack.removeArrangedSubview(view); view.removeFromSuperview() }
        rows = [:]
        let list = servers
        if project != nil, list.isEmpty {
            serversStack.addArrangedSubview(SettingsLayout.detail("还没有 MCP 服务器。点“添加服务器…”添加本地命令或 HTTP 服务器。"))
        }
        for config in list {
            let row = MacMcpServerRow(config: config, state: project?.hub?.server(config.id), prefix: project?.hub?.prefix(config.id) ?? "")
            row.onEnabled = { [weak self] on in self?.setEnabled(config.id, on) }
            row.onPolicy = { [weak self] tool, policy in self?.setPolicy(config.id, tool: tool, policy) }
            row.onEdit = { [weak self] in self?.editServer(config.id) }
            row.onDelete = { [weak self] in self?.deleteServer(config.id) }
            row.onReconnect = { [weak self] in self?.project?.hub?.reconnect(config.id) }
            rows[config.id] = row
            serversStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: serversStack.widthAnchor).isActive = true
        }
    }

    private func show(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    /// Saves the list of `target` (the open project unless given) and lets
    /// its hub follow at once.
    private func commit(_ list: [AgentMcpServerConfig], to target: Project? = nil) {
        guard let project = target ?? project else { return }
        store.setMcpServers(list, projectID: project.id)
        project.hub?.reconcile()
        refresh()
    }

    /// Why a sheet or confirmation opened on `target` can no longer write
    /// to it, in Chinese, or nil.
    private func goneRefusal(_ target: Project, serverID: String?) -> String? {
        if projectExists?(target.id) == false { return "项目《\(target.name)》已经删除，修改没有保存。" }
        if let serverID, !store.mcpServers(projectID: target.id).contains(where: { $0.id == serverID }) {
            return "这个 MCP 服务器已经从项目《\(target.name)》中删除，修改没有保存。"
        }
        return nil
    }

    func setEnabled(_ id: String, _ enabled: Bool) {
        var list = servers
        guard let index = list.firstIndex(where: { $0.id == id }) else { return }
        list[index].enabled = enabled
        show(nil)
        commit(list)
    }

    func setPolicy(_ id: String, tool: String, _ policy: AgentMcpToolPolicy) {
        var list = servers
        guard let index = list.firstIndex(where: { $0.id == id }) else { return }
        list[index].toolPolicies[tool] = policy == .standard ? nil : policy
        commit(list)
    }

    // MARK: Add, edit, delete

    @objc func addServer() {
        guard project != nil else { return }
        begin(MacMcpServerSheet(config: AgentMcpServerConfig(name: "", transport: .stdio), isNew: true, storedSecret: { _, _ in false }))
    }

    func editServer(_ id: String) {
        guard let project, let config = servers.first(where: { $0.id == id }) else { return }
        let secrets = self.secrets
        let sheet = MacMcpServerSheet(config: config, isNew: false) { header, name in
            let account = AgentMcpSecrets.account(projectID: project.id, serverID: config.id, header: header, name: name)
            return ((try? secrets?.secret(account: account)) ?? nil)?.isEmpty == false
        }
        begin(sheet)
    }

    /// The sheet writes to the project it opened on, even after the window
    /// switched project.
    private func begin(_ sheet: MacMcpServerSheet) {
        guard let project else { return }
        self.sheet = sheet
        sheet.projectID = project.id
        sheet.onSave = { [weak self, weak sheet] draft, typed in
            guard let self else { return "设置窗口已关闭。" }
            return self.save(draft, typed: typed, into: project, isNew: sheet?.isNew ?? false)
        }
        sheet.onFinish = { [weak self, weak sheet] in if let self, self.sheet === sheet { self.sheet = nil } }
        if let presentSheet { presentSheet(sheet); return }
        view.window?.beginSheet(sheet.window)
    }

    /// Validates, writes typed secrets to the Keychain, removes secrets no
    /// longer used and saves into `target` (the project the sheet opened
    /// on). A change to how the server is reached raises its revision, so
    /// the running connection is replaced; a change of where it is reached
    /// (transport, command, arguments, folder, URL) also resets every tool
    /// to 每次询问. A project or edited server deleted meanwhile is refused.
    func save(_ draft: AgentMcpServerConfig, typed: [String: String], into target: Project? = nil, isNew: Bool = false) -> String? {
        guard let project = target ?? project else { return "没有打开的项目。" }
        guard let secrets else { return "钥匙串不可用，修改没有保存。" }
        let exists = store.mcpServers(projectID: project.id).contains { $0.id == draft.id }
        if let refusal = goneRefusal(project, serverID: isNew || (target == nil && !exists) ? nil : draft.id) { return refusal }
        var list = store.mcpServers(projectID: project.id)
        let original = list.first { $0.id == draft.id }
        var next = draft
        next.name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        next.toolPolicies = original.map { $0.endpointKey == next.endpointKey ? $0.toolPolicies : [:] } ?? [:]
        let account = { (header: Bool, name: String) in
            AgentMcpSecrets.account(projectID: project.id, serverID: next.id, header: header, name: name)
        }
        let refusal = AgentMcpValidation.refusal(next, others: list) { header, name in
            if typed[account(header, name)]?.isEmpty == false { return true }
            let stored = ((try? secrets.secret(account: account(header, name))) ?? nil)?.isEmpty == false
            // A variable that was not a secret before has no stored value yet.
            let wasSecret = (header ? original?.headers : original?.environment)?.contains { $0.name == name && $0.secret } == true
            return stored && wasSecret
        }
        if let refusal { return refusal }
        if let original {
            var before = original, after = next
            before.revision = 0; after.revision = 0
            next.revision = original.revision + (before.connectionKey != after.connectionKey || !typed.isEmpty ? 1 : 0)
        }
        do {
            for (key, value) in typed where !value.isEmpty { try secrets.setSecret(value, account: key) }
        } catch {
            return "无法把密钥保存到钥匙串：\(error.localizedDescription)"
        }
        let kept = Set(AgentMcpSecrets.accounts(projectID: project.id, config: next))
        for key in original.map({ AgentMcpSecrets.accounts(projectID: project.id, config: $0) }) ?? [] where !kept.contains(key) {
            try? secrets.removeSecret(account: key)
        }
        if let index = list.firstIndex(where: { $0.id == next.id }) { list[index] = next } else { list.append(next) }
        show(nil)
        commit(list, to: project)
        return nil
    }

    /// 删除… removes the server from the project the confirmation named,
    /// with its secrets as stored when the author confirmed; a project or
    /// server deleted meanwhile is refused.
    func deleteServer(_ id: String) {
        guard let project, let config = servers.first(where: { $0.id == id }) else { return }
        let alert = NSAlert()
        alert.messageText = "删除 MCP 服务器“\(config.name)”？"
        alert.informativeText = "它的设置和保存在钥匙串中的密钥会一起删除，正在运行的本地命令会结束。写作助手之后不能再用它的工具。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "删除"); alert.addButton(withTitle: "取消")
        present(alert) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn else { return }
            if let refusal = self.goneRefusal(project, serverID: id) { self.show(refusal); return }
            let list = self.store.mcpServers(projectID: project.id)
            if let secrets = self.secrets, let current = list.first(where: { $0.id == id }) {
                AgentMcpSecrets.remove(projectID: project.id, config: current, from: secrets)
            }
            self.show(nil)
            self.commit(list.filter { $0.id != id }, to: project)
        }
    }

    private func present(_ alert: NSAlert, _ done: @escaping (NSApplication.ModalResponse) -> Void) {
        if let presentAlert { presentAlert(alert, done); return }
        if let window = view.window { alert.beginSheetModal(for: window, completionHandler: done) } else { done(alert.runModal()) }
    }
}

/// One server in the MCP 扩展 pane: its switch, transport, health, tool
/// name prefix, recent error output and discovered tools with policies.
final class MacMcpServerRow: NSStackView {
    let config: AgentMcpServerConfig
    let enabledCheckbox: NSButton
    let statusLabel = NSTextField(wrappingLabelWithString: "")
    let logLabel = NSTextField(wrappingLabelWithString: "")
    let editButton = NSButton(title: "编辑…", target: nil, action: nil)
    let deleteButton = NSButton(title: "删除…", target: nil, action: nil)
    let reconnectButton = NSButton(title: "重新连接", target: nil, action: nil)
    /// Policy popups by tool name.
    private(set) var policies: [String: NSPopUpButton] = [:]
    /// Tool rows as shown: `名称` or `名称 · 已跳过：…`.
    private(set) var toolLines: [String] = []
    var onEnabled: ((Bool) -> Void)?
    var onPolicy: ((String, AgentMcpToolPolicy) -> Void)?
    var onEdit: (() -> Void)?
    var onDelete: (() -> Void)?
    var onReconnect: (() -> Void)?

    init(config: AgentMcpServerConfig, state: AgentMcpHub.Server?, prefix: String) {
        self.config = config
        enabledCheckbox = NSButton(checkboxWithTitle: config.name, target: nil, action: nil)
        super.init(frame: .zero)
        orientation = .vertical; alignment = .leading; spacing = 4
        let id = config.id
        setAccessibilityIdentifier("settings-mcp-server-\(id)")
        enabledCheckbox.state = config.enabled ? .on : .off
        enabledCheckbox.font = .systemFont(ofSize: 13, weight: .semibold)
        enabledCheckbox.target = self; enabledCheckbox.action = #selector(toggled)
        enabledCheckbox.setAccessibilityIdentifier("settings-mcp-enabled-\(id)")
        enabledCheckbox.toolTip = "启用"
        for (button, name, action) in [(editButton, "edit", #selector(edit)), (deleteButton, "delete", #selector(remove)),
                                       (reconnectButton, "reconnect", #selector(reconnect))] {
            button.target = self; button.action = action
            button.bezelStyle = .rounded; button.controlSize = .small
            button.font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
            button.setAccessibilityIdentifier("settings-mcp-\(name)-\(id)")
        }
        let kind = NSTextField(labelWithString: config.transport.label)
        kind.textColor = .secondaryLabelColor
        kind.font = .systemFont(ofSize: 11)
        let health = config.enabled ? (state?.health ?? .connecting) : .disabled
        reconnectButton.isHidden = !config.enabled
        let header = NSStackView(views: [enabledCheckbox, kind, NSView(), reconnectButton, editButton, deleteButton])
        header.spacing = 6
        let summary = SettingsLayout.detail(config.summary)
        summary.setAccessibilityIdentifier("settings-mcp-summary-\(id)")
        statusLabel.stringValue = health.label
        statusLabel.font = .systemFont(ofSize: 12)
        statusLabel.textColor = { if case .failed = health { return NSColor.systemRed }; return NSColor.labelColor }()
        statusLabel.preferredMaxLayoutWidth = SettingsLayout.width - 80
        statusLabel.setAccessibilityIdentifier("settings-mcp-status-\(id)")
        var views: [NSView] = [header, summary, statusLabel]
        if let info = state?.serverInfo, config.enabled {
            let label = SettingsLayout.detail("服务器：\(info)")
            label.setAccessibilityIdentifier("settings-mcp-info-\(id)")
            views.append(label)
        }
        if !prefix.isEmpty {
            let label = SettingsLayout.detail("工具名前缀：\(prefix)")
            label.setAccessibilityIdentifier("settings-mcp-prefix-\(id)")
            views.append(label)
        }
        let log = state?.log.suffix(3) ?? []
        if case .failed = health, !log.isEmpty {
            logLabel.stringValue = "最近的错误输出：\n" + log.joined(separator: "\n")
            logLabel.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
            logLabel.textColor = .secondaryLabelColor
            logLabel.preferredMaxLayoutWidth = SettingsLayout.width - 80
            logLabel.setAccessibilityIdentifier("settings-mcp-log-\(id)")
            views.append(logLabel)
        }
        for tool in config.enabled ? (state?.tools ?? []) : [] {
            let name = NSTextField(labelWithString: tool.name)
            name.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
            name.toolTip = tool.description.isEmpty ? nil : tool.description
            name.setAccessibilityIdentifier("settings-mcp-tool-\(id)-\(tool.name)")
            name.lineBreakMode = .byTruncatingTail
            name.setContentCompressionResistancePriority(.init(1), for: .horizontal)
            if let skipped = tool.skipped {
                let reason = SettingsLayout.detail(skipped)
                reason.setAccessibilityIdentifier("settings-mcp-skipped-\(id)-\(tool.name)")
                let line = NSStackView(views: [name, reason])
                line.orientation = .vertical; line.alignment = .leading; line.spacing = 1
                views.append(line)
                toolLines.append("\(tool.name) · \(skipped)")
                continue
            }
            let popup = NSPopUpButton(frame: .zero, pullsDown: false)
            popup.controlSize = .small
            popup.font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
            for policy in AgentMcpToolPolicy.allCases {
                popup.addItem(withTitle: policy.label)
                popup.lastItem?.representedObject = policy.rawValue
            }
            popup.selectItem(at: AgentMcpToolPolicy.allCases.firstIndex(of: tool.policy) ?? 1)
            popup.target = self; popup.action = #selector(policyChanged(_:))
            popup.identifier = NSUserInterfaceItemIdentifier(tool.name)
            popup.setAccessibilityIdentifier("settings-mcp-policy-\(id)-\(tool.name)")
            popup.setAccessibilityLabel("\(tool.name) 的权限")
            policies[tool.name] = popup
            let line = NSStackView(views: [name, NSView(), popup])
            line.spacing = 8
            views.append(line)
            line.widthAnchor.constraint(equalToConstant: SettingsLayout.width - 80).isActive = true
            toolLines.append(tool.name)
        }
        for view in views { addArrangedSubview(view) }
        header.widthAnchor.constraint(equalToConstant: SettingsLayout.width - 64).isActive = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    @objc private func toggled() { onEnabled?(enabledCheckbox.state == .on) }
    @objc private func edit() { onEdit?() }
    @objc private func remove() { onDelete?() }
    @objc private func reconnect() { onReconnect?() }

    @objc private func policyChanged(_ sender: NSPopUpButton) {
        guard let tool = sender.identifier?.rawValue, let raw = sender.selectedItem?.representedObject as? String,
              let policy = AgentMcpToolPolicy(rawValue: raw) else { return }
        onPolicy?(tool, policy)
    }

    /// Chooses a policy as the popup does.
    func choose(_ policy: AgentMcpToolPolicy, for tool: String) {
        guard let popup = policies[tool] else { return }
        popup.selectItem(at: AgentMcpToolPolicy.allCases.firstIndex(of: policy) ?? 1)
        policyChanged(popup)
    }
}

// MARK: - Edit sheet

/// 添加或编辑 MCP 服务器: name, transport, then the command, its arguments
/// (one per line), working folder and environment, or the URL and headers.
/// A secret's value is typed here and goes to the Keychain on 保存; a
/// stored one is never shown, and leaving it empty keeps it.
final class MacMcpServerSheet: NSObject, NSTextFieldDelegate, NSTextViewDelegate {
    static let policyResetNote = "连接方式已改变：保存后，这个服务器所有工具的权限都会恢复为“每次询问”，需要时请重新选择“允许”。"
    let window: NSWindow
    let isNew: Bool
    private(set) var config: AgentMcpServerConfig
    let nameField = NSTextField()
    let transportControl = NSSegmentedControl(labels: AgentMcpTransportKind.allCases.map(\.label), trackingMode: .selectOne, target: nil, action: nil)
    let commandField = NSTextField()
    let argumentsView = NSTextView()
    let folderField = NSTextField()
    let environment: MacMcpVariablesEditor
    let urlField = NSTextField()
    let headers: MacMcpVariablesEditor
    let message = NSTextField(wrappingLabelWithString: "")
    /// Says that saving resets every tool to 每次询问 once where the server
    /// is reached has changed.
    let policyNote = NSTextField(wrappingLabelWithString: "")
    let saveButton = NSButton(title: "保存", target: nil, action: nil)
    let cancelButton = NSButton(title: "取消", target: nil, action: nil)
    private let stdioBox = NSStackView()
    private let httpBox = NSStackView()
    /// Returns why the server could not be saved; nil closes the sheet.
    var onSave: ((AgentMcpServerConfig, [String: String]) -> String?)?
    var onFinish: (() -> Void)?
    private let storedSecret: (Bool, String) -> Bool

    /// `storedSecret(header, name)` says whether the Keychain holds a
    /// value for that secret of this server.
    init(config: AgentMcpServerConfig, isNew: Bool, storedSecret: @escaping (Bool, String) -> Bool) {
        self.config = config
        self.isNew = isNew
        self.storedSecret = storedSecret
        environment = MacMcpVariablesEditor(header: false)
        headers = MacMcpVariablesEditor(header: true)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 560), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = isNew ? "添加 MCP 服务器" : "编辑 MCP 服务器"
        super.init()
        build()
        load()
    }

    private func build() {
        let title = NSTextField(labelWithString: window.title)
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        nameField.placeholderString = "例如：资料检索"
        nameField.setAccessibilityIdentifier("mcp-sheet-name")
        transportControl.target = self; transportControl.action = #selector(transportChanged)
        transportControl.setAccessibilityIdentifier("mcp-sheet-transport")
        commandField.placeholderString = "可执行文件的完整路径，例如 /usr/local/bin/my-server"
        commandField.setAccessibilityIdentifier("mcp-sheet-command")
        argumentsView.isRichText = false
        argumentsView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        argumentsView.isVerticallyResizable = true; argumentsView.autoresizingMask = [.width]
        argumentsView.textContainer?.widthTracksTextView = true
        argumentsView.setAccessibilityIdentifier("mcp-sheet-arguments")
        let argumentsScroll = NSScrollView()
        argumentsScroll.hasVerticalScroller = true; argumentsScroll.borderType = .bezelBorder
        argumentsScroll.documentView = argumentsView
        folderField.placeholderString = "可选，完整路径"
        folderField.setAccessibilityIdentifier("mcp-sheet-folder")
        urlField.placeholderString = "https://example.com/mcp"
        urlField.setAccessibilityIdentifier("mcp-sheet-url")
        let stdioGrid = SettingsLayout.grid([
            ("命令", [commandField]),
            ("参数", [argumentsScroll, SettingsLayout.detail("每行一个参数。")]),
            ("工作文件夹", [folderField]),
            ("环境变量", [environment, SettingsLayout.detail("勾选“密钥”的值保存在钥匙串中，不写入设置文件。")]),
        ])
        stdioBox.setViews([stdioGrid], in: .leading)
        let httpGrid = SettingsLayout.grid([
            ("地址", [urlField, SettingsLayout.detail("必须是 https://；本机服务器可以用 http://localhost。")]),
            ("请求头", [headers, SettingsLayout.detail("例如 Authorization；勾选“密钥”的值保存在钥匙串中。")]),
        ])
        httpBox.setViews([httpGrid], in: .leading)
        let top = SettingsLayout.grid([("名称", [nameField]), ("类型", [transportControl])])
        message.textColor = .systemRed
        message.font = .systemFont(ofSize: 12)
        message.isHidden = true
        message.setAccessibilityIdentifier("mcp-sheet-message")
        policyNote.textColor = .systemOrange
        policyNote.font = .systemFont(ofSize: 12)
        policyNote.isHidden = true
        policyNote.setAccessibilityIdentifier("mcp-sheet-policy-note")
        for field in [commandField, folderField, urlField] { field.delegate = self }
        argumentsView.delegate = self
        saveButton.target = self; saveButton.action = #selector(save)
        saveButton.keyEquivalent = "\r"
        saveButton.setAccessibilityIdentifier("mcp-sheet-save")
        cancelButton.target = self; cancelButton.action = #selector(cancel)
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.setAccessibilityIdentifier("mcp-sheet-cancel")
        let stack = NSStackView(views: [title, top, stdioBox, httpBox, policyNote, message, NSStackView(views: [NSView(), cancelButton, saveButton])])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.detachesHiddenViews = true
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            content.widthAnchor.constraint(equalToConstant: 540),
            nameField.widthAnchor.constraint(equalToConstant: 300),
            commandField.widthAnchor.constraint(equalToConstant: 340),
            folderField.widthAnchor.constraint(equalToConstant: 340),
            urlField.widthAnchor.constraint(equalToConstant: 340),
            argumentsScroll.widthAnchor.constraint(equalToConstant: 340),
            argumentsScroll.heightAnchor.constraint(equalToConstant: 64),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            policyNote.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }

    private func load() {
        nameField.stringValue = config.name
        transportControl.selectedSegment = AgentMcpTransportKind.allCases.firstIndex(of: config.transport) ?? 0
        commandField.stringValue = config.command
        argumentsView.string = config.arguments.joined(separator: "\n")
        folderField.stringValue = config.workingDirectory
        urlField.stringValue = config.url
        environment.load(config.environment) { [storedSecret] name in storedSecret(false, name) }
        headers.load(config.headers) { [storedSecret] name in storedSecret(true, name) }
        transportChanged()
    }

    @objc func transportChanged() {
        let kind = transport
        stdioBox.isHidden = kind != .stdio
        httpBox.isHidden = kind != .http
        updatePolicyNote()
        window.contentView?.layoutSubtreeIfNeeded()
        if let size = window.contentView?.fittingSize { window.setContentSize(size) }
    }

    /// Shown while the form reaches the server somewhere else than the
    /// stored configuration and some tool has a policy other than 每次询问.
    func updatePolicyNote() {
        let (next, _) = draft(projectID: projectID)
        let resets = !isNew && !config.toolPolicies.isEmpty && next.endpointKey != config.endpointKey
        policyNote.stringValue = resets ? Self.policyResetNote : ""
        guard policyNote.isHidden == resets else { return }
        policyNote.isHidden = !resets
        window.contentView?.layoutSubtreeIfNeeded()
        if let size = window.contentView?.fittingSize { window.setContentSize(size) }
    }

    func controlTextDidChange(_ notification: Notification) { updatePolicyNote() }
    func textDidChange(_ notification: Notification) { updatePolicyNote() }

    var transport: AgentMcpTransportKind {
        AgentMcpTransportKind.allCases.indices.contains(transportControl.selectedSegment)
            ? AgentMcpTransportKind.allCases[transportControl.selectedSegment] : .stdio
    }

    /// The form as a configuration, and the secret values typed now by
    /// Keychain account. `projectID` names the accounts.
    func draft(projectID: String) -> (AgentMcpServerConfig, [String: String]) {
        var next = config
        next.name = nameField.stringValue
        next.transport = transport
        next.command = commandField.stringValue.trimmingCharacters(in: .whitespaces)
        next.arguments = argumentsView.string.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        next.workingDirectory = folderField.stringValue.trimmingCharacters(in: .whitespaces)
        next.url = urlField.stringValue.trimmingCharacters(in: .whitespaces)
        let env = environment.entries(), head = headers.entries()
        next.environment = env.map(\.variable)
        next.headers = head.map(\.variable)
        var typed: [String: String] = [:]
        for (list, header) in [(env, false), (head, true)] {
            for entry in list where entry.variable.secret {
                guard let value = entry.secret, !value.isEmpty else { continue }
                typed[AgentMcpSecrets.account(projectID: projectID, serverID: next.id, header: header, name: entry.variable.name)] = value
            }
        }
        return (next, typed)
    }

    /// The project the accounts belong to; set by the pane.
    var projectID = ""

    @objc func save() {
        let (next, typed) = draft(projectID: projectID)
        if let refusal = onSave?(next, typed) {
            message.stringValue = refusal
            message.isHidden = false
            return
        }
        config = next
        close()
    }

    @objc func cancel() { close() }

    private func close() {
        if let parent = window.sheetParent { parent.endSheet(window) }
        window.orderOut(nil)
        onFinish?()
    }
}

/// Rows of names and values with a 密钥 switch, for environment variables
/// or HTTP headers. A secret's field is a secure field; a secret already
/// in the Keychain shows only that it is saved.
final class MacMcpVariablesEditor: NSStackView {
    final class Row: NSStackView {
        let nameField = NSTextField()
        private(set) var valueField: NSTextField
        let secretCheckbox = NSButton(checkboxWithTitle: "密钥", target: nil, action: nil)
        let removeButton = NSButton(title: "−", target: nil, action: nil)
        /// A secret this server already has in the Keychain.
        let stored: Bool
        var onRemove: ((Row) -> Void)?

        init(name: String, value: String, secret: Bool, stored: Bool) {
            self.stored = stored
            valueField = secret ? NSSecureTextField() : NSTextField()
            super.init(frame: .zero)
            spacing = 4
            nameField.stringValue = name
            nameField.placeholderString = "名称"
            valueField.stringValue = value
            secretCheckbox.state = secret ? .on : .off
            secretCheckbox.target = self; secretCheckbox.action = #selector(secretChanged)
            removeButton.bezelStyle = .rounded; removeButton.controlSize = .small
            removeButton.target = self; removeButton.action = #selector(remove)
            setViews([nameField, valueField, secretCheckbox, removeButton], in: .leading)
            nameField.widthAnchor.constraint(equalToConstant: 110).isActive = true
            styleValue()
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        var isSecret: Bool { secretCheckbox.state == .on }

        private func styleValue() {
            valueField.placeholderString = isSecret && stored ? "已保存在钥匙串，留空保持不变" : "值"
            valueField.widthAnchor.constraint(equalToConstant: 150).isActive = true
        }

        /// 密钥 switches between a plain and a secure field, keeping the text.
        @objc func secretChanged() {
            let text = valueField.stringValue
            let next: NSTextField = isSecret ? NSSecureTextField() : NSTextField()
            next.stringValue = text
            removeView(valueField)
            insertView(next, at: 1, in: .leading)
            valueField = next
            styleValue()
        }

        @objc private func remove() { onRemove?(self) }
    }

    let header: Bool
    let addButton = NSButton(title: "添加", target: nil, action: nil)
    private(set) var rows: [Row] = []

    init(header: Bool) {
        self.header = header
        super.init(frame: .zero)
        orientation = .vertical; alignment = .leading; spacing = 4
        addButton.bezelStyle = .rounded; addButton.controlSize = .small
        addButton.target = self; addButton.action = #selector(addPressed)
        addButton.setAccessibilityIdentifier(header ? "mcp-sheet-add-header" : "mcp-sheet-add-variable")
        addArrangedSubview(addButton)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func load(_ variables: [AgentMcpVariable], stored: (String) -> Bool) {
        for row in rows { removeArrangedSubview(row); row.removeFromSuperview() }
        rows = []
        for variable in variables { add(name: variable.name, value: variable.value, secret: variable.secret, stored: variable.secret && stored(variable.name)) }
    }

    @objc private func addPressed() { add(name: "", value: "", secret: false, stored: false) }

    /// A new row, as 添加 makes one.
    @discardableResult
    func add(name: String, value: String, secret: Bool, stored: Bool = false) -> Row {
        let row = Row(name: name, value: value, secret: secret, stored: stored)
        row.onRemove = { [weak self] row in
            guard let self else { return }
            self.rows.removeAll { $0 === row }
            self.removeArrangedSubview(row); row.removeFromSuperview()
        }
        rows.append(row)
        insertArrangedSubview(row, at: arrangedSubviews.count - 1)
        return row
    }

    /// Rows with a name, in order: each variable and, for a secret, the
    /// value typed now (nil keeps the stored one).
    func entries() -> [(variable: AgentMcpVariable, secret: String?)] {
        rows.compactMap { row in
            let name = row.nameField.stringValue.trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty else { return nil }
            let value = row.valueField.stringValue
            return row.isSecret ? (AgentMcpVariable(name: name, value: "", secret: true), value.isEmpty ? nil : value)
                : (AgentMcpVariable(name: name, value: value, secret: false), nil)
        }
    }
}
