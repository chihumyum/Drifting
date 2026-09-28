import AppKit

final class DriftLibraryPanel: NSPanel {
    var onClose: (() -> Void)?
    override func close() { super.close(); onClose?() }
}

/// The 漂流 panel: drift groups (collapsible, one nesting level) with their
/// drifts, drifts outside any group, and the trash with 恢复. 休眠 drifts stay
/// in place, muted. Opening, trashing and a drift's status go through the
/// owner of the editor tabs; every other command is a library command whose
/// reply reaches open pages, the outline and entity links through the model.
final class MacDriftLibraryViewController: NSViewController, NSTableViewDataSource, NSTableViewDelegate, NSMenuDelegate {
    let model: DriftLibraryModel
    var onOpen: ((WorkspaceDrift) -> Void)?
    var onTrash: ((WorkspaceDrift) -> Void)?
    var onCreated: ((WorkspaceDrift) -> Void)?
    /// The row menu chose another status (`drifting` or `resting`).
    var onSetStatus: ((WorkspaceDrift, String) -> Void)?
    /// 转为章节… or 转为设定… on a drift row.
    var onConvert: ((WorkspaceDrift, DriftConversionKind) -> Void)?
    var canNavigate: (() -> Bool)?
    var onClose: (() -> Void)?
    /// Presents an alert (prompts, pickers and confirmations). Nil uses a
    /// sheet on the panel; acceptance answers here without a window.
    var presentAlert: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
    let table = NSTableView()
    private let status = NSTextField(wrappingLabelWithString: "")
    let createDriftButton = NSButton(title: "新建漂流", target: nil, action: nil)
    let createGroupButton = NSButton(title: "新建分组", target: nil, action: nil)
    private(set) var rows: [DriftLibraryModel.Row] = []

    var statusText: String { status.stringValue }

    init(model: DriftLibraryModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        view = NSView()
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("drift")))
        table.headerView = nil
        table.rowHeight = 28
        table.usesAutomaticRowHeights = false
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.dataSource = self; table.delegate = self
        table.target = self; table.action = #selector(rowClicked)
        table.setAccessibilityIdentifier("drift-list")
        let menu = NSMenu()
        menu.delegate = self
        table.menu = menu
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.documentView = table
        status.textColor = .secondaryLabelColor
        status.setAccessibilityIdentifier("drift-status")
        createDriftButton.target = self; createDriftButton.action = #selector(createUngroupedDrift)
        createDriftButton.setAccessibilityIdentifier("create-drift")
        createGroupButton.target = self; createGroupButton.action = #selector(createRootGroup)
        createGroupButton.setAccessibilityIdentifier("create-drift-group")
        let close = NSButton(title: "关闭漂流", target: self, action: #selector(closePanel))
        close.setAccessibilityIdentifier("close-drifts")
        let actions = NSStackView(views: [createDriftButton, createGroupButton, NSView(), close])
        let stack = NSStackView(views: [status, actions, scroll])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -16),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            actions.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        model.onChange = { [weak self] in self?.reload() }
        reload()
    }

    func reload() {
        guard isViewLoaded else { return }
        rows = model.rows
        status.stringValue = model.status
        createDriftButton.isEnabled = !model.busy && model.loaded
        createGroupButton.isEnabled = !model.busy && model.loaded
        table.reloadData()
    }

    // MARK: Rows

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        switch rows[row] {
        case .group(_, let depth, _, _): return depth == 0 ? 32 : 28
        case .drift(let drift, _) where drift.actId != nil: return 40
        case .ungroupedHeader, .trashHeader: return 32
        default: return 26
        }
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        cellView(rows[row])
    }

    private static func indent(_ depth: Int) -> CGFloat { CGFloat(depth) * 18 }

    /// One row's view, also read by acceptance. Nesting is shown by spacing
    /// and weight only.
    func cellView(_ item: DriftLibraryModel.Row) -> NSStackView {
        let stack = NSStackView()
        stack.spacing = 6
        stack.setAccessibilityIdentifier(item.identifier)
        switch item {
        case .group(let group, let depth, let count, let collapsed):
            let toggle = DriftButton(title: collapsed ? "▸" : "▾", identifier: "drift-group-toggle-\(group.id)") { [weak self] in
                self?.model.toggle(groupID: group.id)
            }
            toggle.bezelStyle = .inline; toggle.isBordered = false
            toggle.setAccessibilityLabel("\(collapsed ? "展开" : "收起") \(group.name)")
            let name = NSTextField(labelWithString: group.name)
            name.font = .systemFont(ofSize: 13, weight: depth == 0 ? .semibold : .medium)
            name.textColor = depth == 0 ? .labelColor : .secondaryLabelColor
            name.lineBreakMode = .byTruncatingTail
            name.setAccessibilityLabel(group.name)
            name.setContentCompressionResistancePriority(.init(1), for: .horizontal)
            stack.setViews([toggle, name, countLabel(count), NSView()], in: .leading)
            stack.edgeInsets = NSEdgeInsets(top: 0, left: Self.indent(depth), bottom: 0, right: 4)
        case .drift(let drift, let depth):
            let text = NSStackView()
            text.orientation = .vertical; text.alignment = .leading; text.spacing = 1
            // A 休眠 drift stays in place, muted, with a small 休眠 note.
            let resting = model.isResting(drift)
            let title = NSTextField(labelWithString: drift.title)
            title.font = .systemFont(ofSize: 13)
            title.textColor = resting ? .tertiaryLabelColor : .labelColor
            title.lineBreakMode = .byTruncatingTail
            title.setAccessibilityIdentifier("drift-title-\(drift.id)")
            title.setAccessibilityLabel(resting ? "\(drift.title)，\(WritingStatus.resting.label)" : drift.title)
            text.addArrangedSubview(title)
            if drift.actId != nil {
                let act = NSTextField(labelWithString: "幕笔记 · \(model.actName(of: drift) ?? "已绑定")")
                act.font = .systemFont(ofSize: 11); act.textColor = .secondaryLabelColor
                act.lineBreakMode = .byTruncatingTail
                act.setAccessibilityIdentifier("drift-act-\(drift.id)")
                text.addArrangedSubview(act)
            }
            text.setContentCompressionResistancePriority(.init(1), for: .horizontal)
            var views: [NSView] = [text, NSView()]
            if let words = MacWordCount.rowLabel(model.wordCount(of: drift), identifier: "drift-words-\(drift.id)") {
                views.append(words)
            }
            if resting {
                let status = NSTextField(labelWithString: WritingStatus.resting.label)
                status.font = .systemFont(ofSize: 11); status.textColor = .tertiaryLabelColor
                status.setAccessibilityIdentifier("drift-resting-\(drift.id)")
                views.append(status)
            }
            stack.setViews(views, in: .leading)
            stack.edgeInsets = NSEdgeInsets(top: 0, left: Self.indent(depth) + 20, bottom: 0, right: 4)
        case .emptyGroup(_, let depth):
            let label = NSTextField(labelWithString: "空分组")
            label.font = .systemFont(ofSize: 12); label.textColor = .tertiaryLabelColor
            stack.setViews([label], in: .leading)
            stack.edgeInsets = NSEdgeInsets(top: 0, left: Self.indent(depth) + 20, bottom: 0, right: 0)
        case .ungroupedHeader(let count):
            stack.setViews([heading("未分组"), countLabel(count)], in: .leading)
            stack.edgeInsets = NSEdgeInsets(top: 0, left: 20, bottom: 0, right: 0)
        case .empty:
            let label = NSTextField(labelWithString: "还没有漂流")
            label.textColor = .tertiaryLabelColor
            stack.setViews([label], in: .leading)
        case .trashHeader(let count):
            stack.setViews([heading("回收站"), countLabel(count)], in: .leading)
        case .trashed(let drift):
            let title = NSTextField(labelWithString: drift.title)
            title.textColor = .secondaryLabelColor
            title.lineBreakMode = .byTruncatingTail
            let restore = DriftButton(title: "恢复", identifier: "restore-drift-\(drift.id)") { [weak self] in
                self?.restore(drift)
            }
            restore.bezelStyle = .rounded; restore.controlSize = .small
            restore.font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
            restore.isEnabled = !model.busy
            stack.setViews([title, NSView(), restore], in: .leading)
            stack.edgeInsets = NSEdgeInsets(top: 0, left: 12, bottom: 0, right: 4)
        }
        return stack
    }

    private func heading(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        return label
    }
    private func countLabel(_ count: Int) -> NSTextField {
        let label = NSTextField(labelWithString: "\(count)")
        label.textColor = .tertiaryLabelColor
        return label
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        if case .drift = rows[row] { return true }
        return false
    }

    /// A drift row opens its page; a group row folds or unfolds it.
    @objc private func rowClicked() {
        let row = table.clickedRow
        table.deselectAll(nil)
        guard rows.indices.contains(row) else { return }
        switch rows[row] {
        case .drift(let drift, _): open(drift)
        case .group(let group, _, _, _): model.toggle(groupID: group.id)
        default: break
        }
    }

    // MARK: Context menus

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let row = table.clickedRow
        guard rows.indices.contains(row) else { return }
        for item in menuItems(for: rows[row]) { menu.addItem(item) }
    }

    /// The context actions of one row, also used by acceptance.
    func menuItems(for row: DriftLibraryModel.Row) -> [NSMenuItem] {
        switch row {
        case .drift(let drift, _):
            let open = LibraryMenuItem(title: "打开", identifier: "open-drift") { [weak self] in self?.open(drift) }
            let rename = LibraryMenuItem(title: "重命名…", identifier: "rename-drift") { [weak self] in self?.rename(drift) }
            let move = LibraryMenuItem(title: "移到分组…", identifier: "move-drift") { [weak self] in self?.move(drift) }
            let trash = LibraryMenuItem(title: drift.actId == nil ? "移到回收站" : "移到回收站…", identifier: "trash-drift") { [weak self] in
                self?.trash(drift)
            }
            let converts = [DriftConversionKind.chapter, .element].map { kind in
                LibraryMenuItem(title: kind.title, identifier: kind.identifier) { [weak self] in self?.convert(drift, kind) }
            }
            var items: [NSMenuItem] = [open, .separator(), rename, move, .separator()]
            items += statusItems(drift)
            items += [.separator()] + converts + [.separator(), trash]
            return items
        case .group(let group, _, _, _):
            let create = LibraryMenuItem(title: "新建漂流", identifier: "create-drift-in-group") { [weak self] in
                self?.createDrift(in: group)
            }
            let nested = model.library.isSubgroup(group.id)
            let subgroup = LibraryMenuItem(title: nested ? "新建子分组…（分组最多嵌套一层）" : "新建子分组…",
                                           identifier: "create-drift-subgroup") { [weak self] in
                self?.createGroup(parent: group)
            }
            subgroup.isEnabled = !nested
            let rename = LibraryMenuItem(title: "重命名…", identifier: "rename-drift-group") { [weak self] in self?.renameGroup(group) }
            let delete = LibraryMenuItem(title: "删除分组…", identifier: "delete-drift-group") { [weak self] in
                self?.confirmDelete(group)
            }
            return [create, subgroup, .separator(), rename, delete]
        case .trashed(let drift):
            return [LibraryMenuItem(title: "恢复", identifier: "restore-drift") { [weak self] in self?.restore(drift) }]
        default:
            return []
        }
    }

    /// 状态: 漂浮中 and 休眠, the current one checked. Choosing it writes nothing.
    private func statusItems(_ drift: WorkspaceDrift) -> [NSMenuItem] {
        let heading = NSMenuItem(title: "状态", action: nil, keyEquivalent: "")
        heading.isEnabled = false
        let current = model.status(of: drift)
        return [heading] + WritingStatus.drift.map { status in
            let item = LibraryMenuItem(title: status.label, identifier: "drift-menu-status-\(status.rawValue)") { [weak self] in
                self?.setStatus(drift, status.rawValue)
            }
            item.state = current == status.rawValue ? .on : .off
            item.isEnabled = current != nil && onSetStatus != nil
            return item
        }
    }

    private func setStatus(_ drift: WorkspaceDrift, _ status: String) {
        guard model.status(of: drift) != status, canCommand() else { return }
        onSetStatus?(drift, status)
    }

    private func canCommand() -> Bool {
        guard !model.busy else { model.showStatus("正在保存漂流，请稍后重试。"); return false }
        return true
    }

    /// Opening a page or trashing (which closes pages) changes owners.
    private func canChange() -> Bool {
        guard !model.busy, canNavigate?() == true else {
            model.showStatus("请先完成输入，并等待正文保存后再修改漂流。"); return false
        }
        return true
    }

    private func open(_ drift: WorkspaceDrift) {
        guard canChange() else { return }
        onOpen?(drift)
    }

    /// Conversion closes the drift's pages, so it waits like opening does.
    private func convert(_ drift: WorkspaceDrift, _ kind: DriftConversionKind) {
        guard canChange() else { return }
        onConvert?(drift, kind)
    }

    private func restore(_ drift: WorkspaceDrift) {
        guard canChange() else { return }
        model.restore(id: drift.id)
    }

    @objc private func createUngroupedDrift() { createDrift(in: nil) }
    @objc private func createRootGroup() { createGroup(parent: nil) }

    /// Asks for an optional title; the new drift opens with its title selected.
    func createDrift(in group: WorkspaceDriftGroup?) {
        guard canCommand() else { return }
        let place = group.flatMap { model.library.path(groupID: $0.id) }.map { "新漂流会放在“\($0)”中。" } ?? ""
        askText(title: "新建漂流", detail: place + "留空将使用默认标题；与章节或其他漂流同名时会自动加上序号。",
                current: "", placeholder: "漂流标题", identifier: "new-drift-title", confirm: "创建") { [weak self] title in
            self?.model.createDrift(title: title, groupID: group?.id) { [weak self] result in
                if case .success(let drift) = result { self?.onCreated?(drift) }
            }
        }
    }

    /// A root group, or a subgroup of `parent`. Rust refuses a subgroup of a
    /// subgroup; the panel shows its reason.
    func createGroup(parent: WorkspaceDriftGroup?) {
        guard canCommand() else { return }
        askText(title: parent == nil ? "新建分组" : "新建子分组",
                detail: parent.map { "子分组会放在“\($0.name)”中。分组最多嵌套一层。留空将使用“新分组”。" } ?? "留空将使用“新分组”。",
                current: "", placeholder: "分组名称", identifier: "new-drift-group-name", confirm: "创建") { [weak self] name in
            self?.model.createGroup(name: name, parentID: parent?.id)
        }
    }

    private func rename(_ drift: WorkspaceDrift) {
        guard canCommand() else { return }
        askText(title: "重命名漂流", detail: "与章节或其他漂流同名时会自动加上序号。", current: drift.title,
                placeholder: "漂流标题", identifier: "rename-drift-title", confirm: "保存") { [weak self] title in
            guard !title.isEmpty else { self?.model.showStatus("漂流标题不能为空，请重新输入。"); return }
            self?.model.renameDrift(id: drift.id, title: title)
        }
    }

    /// Picks 未分组 or any group; subgroups are named with their parent.
    private func move(_ drift: WorkspaceDrift) {
        guard canCommand() else { return }
        let library = model.library
        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 280, height: 26), pullsDown: false)
        popup.addItem(withTitle: "未分组")
        popup.lastItem?.representedObject = ""
        for (group, _) in library.orderedGroups {
            popup.addItem(withTitle: library.path(groupID: group.id) ?? group.name)
            popup.lastItem?.representedObject = group.id
        }
        let current = drift.driftGroupId.flatMap { library.group(id: $0)?.id } ?? ""
        popup.selectItem(at: popup.itemArray.firstIndex { $0.representedObject as? String == current } ?? 0)
        popup.setAccessibilityIdentifier("move-drift-group")
        let alert = NSAlert()
        alert.messageText = "移到分组"
        alert.informativeText = "选择“\(drift.title)”所在的分组。"
        alert.accessoryView = popup
        alert.addButton(withTitle: "移动").setAccessibilityIdentifier("confirm-move-drift")
        alert.addButton(withTitle: "取消")
        present(alert) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn else { return }
            let chosen = popup.selectedItem?.representedObject as? String ?? ""
            guard chosen != current else { self.model.showStatus("漂流已在这个分组中。"); return }
            guard self.canCommand() else { return }
            self.model.moveDrift(id: drift.id, toGroup: chosen.isEmpty ? nil : chosen)
        }
    }

    /// A drift that is an act's notes explains the unbinding first.
    private func trash(_ drift: WorkspaceDrift) {
        guard canChange() else { return }
        guard drift.actId != nil else { onTrash?(drift); return }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "将漂流“\(drift.title)”移到回收站？"
        alert.informativeText = "它是“\(model.actName(of: drift) ?? "一幕")”的幕笔记。移到回收站会解除这一绑定；之后恢复时不会重新绑定。正文保持不变。"
        alert.addButton(withTitle: "移到回收站").setAccessibilityIdentifier("confirm-trash-drift")
        alert.addButton(withTitle: "取消")
        present(alert) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn, self.canChange() else { return }
            self.onTrash?(drift)
        }
    }

    private func renameGroup(_ group: WorkspaceDriftGroup) {
        guard canCommand() else { return }
        askText(title: "重命名分组", detail: "只更改分组名称，其中的漂流不变。", current: group.name,
                placeholder: "分组名称", identifier: "rename-drift-group-name", confirm: "保存") { [weak self] name in
            guard !name.isEmpty else { self?.model.showStatus("分组名称不能为空，请重新输入。"); return }
            self?.model.renameGroup(id: group.id, name: name)
        }
    }

    /// Explains that nothing is lost: drifts and subgroups move up.
    private func confirmDelete(_ group: WorkspaceDriftGroup) {
        guard canCommand() else { return }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "删除分组“\(group.name)”？"
        alert.informativeText = Self.deleteExplanation(group: group, library: model.library)
        alert.addButton(withTitle: "删除分组").setAccessibilityIdentifier("confirm-delete-drift-group")
        alert.addButton(withTitle: "取消")
        present(alert) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn, self.canCommand() else { return }
            self.model.deleteGroup(id: group.id)
        }
    }

    static func deleteExplanation(group: WorkspaceDriftGroup, library: WorkspaceDriftLibrary) -> String {
        let drifts = library.drifts(inGroup: group.id).count, subgroups = library.subgroups(of: group.id).count
        let target = group.parentGroupId.flatMap { library.group(id: $0)?.name }.map { "“\($0)”" } ?? "上一级（未分组）"
        var parts: [String] = []
        if drifts > 0 { parts.append("\(drifts) 条漂流") }
        if subgroups > 0 { parts.append("\(subgroups) 个子分组") }
        guard !parts.isEmpty else { return "这个分组是空的。删除后不会影响任何漂流。" }
        return "其中的 \(parts.joined(separator: "和 "))会移到\(target)，不会删除任何漂流。"
    }

    private func askText(title: String, detail: String, current: String, placeholder: String, identifier: String,
                         confirm: String, completion: @escaping (String) -> Void) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        let field = NSTextField(string: current)
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        field.placeholderString = placeholder
        field.setAccessibilityIdentifier(identifier)
        alert.accessoryView = field
        alert.addButton(withTitle: confirm).setAccessibilityIdentifier("confirm-\(identifier)")
        alert.addButton(withTitle: "取消")
        present(alert) { response in
            guard response == .alertFirstButtonReturn else { return }
            completion(field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        alert.window.makeFirstResponder(field)
        field.selectText(nil)
    }

    private func present(_ alert: NSAlert, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        if let presentAlert { presentAlert(alert, completion) }
        else if let window = view.window { alert.beginSheetModal(for: window, completionHandler: completion) }
    }

    @objc private func closePanel() { onClose?() }
}

private final class DriftButton: NSButton {
    private let pressed: () -> Void
    init(title: String, identifier: String, pressed: @escaping () -> Void) {
        self.pressed = pressed
        super.init(frame: .zero)
        self.title = title
        target = self; action = #selector(press)
        setAccessibilityIdentifier(identifier)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    @objc private func press() { pressed() }
}
