import AppKit

final class TrashPanel: NSPanel {
    var onClose: (() -> Void)?
    override func close() { super.close(); onClose?() }
}

/// 回收站 (视图 › 回收站, ⌥⌘⌫): every trashed chapter, drift, element, category
/// and storyline of one project with its kind, title and when it was
/// trashed, newest first, filtered by kind. 恢复 uses the kind's restore
/// command through the tab host and opens nothing; 彻底删除… and 清空回收站…
/// ask first and name what goes with each item. 清空回收站 sends exactly the
/// entries its confirmation counted, and is off while a read has failed.
final class MacTrashViewController: NSViewController, NSTableViewDataSource, NSTableViewDelegate, NSMenuDelegate {
    let model: WorkspaceTrashModel
    private weak var host: MacChapterWorkspace?
    let filterPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let table = NSTableView()
    let status = NSTextField(wrappingLabelWithString: "")
    let restoreButton = NSButton(title: "恢复", target: nil, action: nil)
    let purgeButton = NSButton(title: "彻底删除…", target: nil, action: nil)
    let emptyButton = NSButton(title: "清空回收站…", target: nil, action: nil)
    /// Shows a confirmation; nil presents it on the panel. Acceptance
    /// answers here without a window.
    var presentAlert: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
    /// Whether the main window lets a command run (no input in flight).
    var canNavigate: (() -> Bool)?
    var onClose: (() -> Void)?
    /// The last confirmation shown, for acceptance.
    private(set) var lastAlert: NSAlert?
    private(set) var rows: [WorkspaceTrashItem] = []

    init(model: WorkspaceTrashModel, host: MacChapterWorkspace) {
        self.model = model
        self.host = host
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    static let columns: [(id: String, title: String, width: CGFloat)] = [("kind", "类型", 70), ("title", "名称", 220), ("time", "移入回收站", 130)]

    override func loadView() {
        view = NSView()
        filterPopup.addItem(withTitle: "全部")
        filterPopup.lastItem?.setAccessibilityIdentifier("trash-filter-all")
        for kind in WorkspaceTrashKind.allCases {
            filterPopup.addItem(withTitle: kind.label)
            filterPopup.lastItem?.representedObject = kind.rawValue
            filterPopup.lastItem?.setAccessibilityIdentifier("trash-filter-\(kind.rawValue)")
        }
        filterPopup.target = self; filterPopup.action = #selector(filterChanged)
        filterPopup.setAccessibilityIdentifier("trash-filter")
        filterPopup.setAccessibilityLabel("类型")
        for column in Self.columns {
            let tableColumn = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(column.id))
            tableColumn.title = column.title
            tableColumn.width = column.width
            table.addTableColumn(tableColumn)
        }
        table.usesAlternatingRowBackgroundColors = true
        table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        table.dataSource = self; table.delegate = self
        table.target = self
        table.setAccessibilityIdentifier("trash-items")
        let menu = NSMenu()
        menu.delegate = self
        table.menu = menu
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder; scroll.documentView = table
        status.textColor = .secondaryLabelColor
        status.setAccessibilityIdentifier("trash-status")
        restoreButton.target = self; restoreButton.action = #selector(restoreSelected)
        restoreButton.setAccessibilityIdentifier("trash-restore")
        purgeButton.target = self; purgeButton.action = #selector(purgeSelected)
        purgeButton.setAccessibilityIdentifier("trash-purge")
        emptyButton.target = self; emptyButton.action = #selector(emptyTrashPressed)
        emptyButton.setAccessibilityIdentifier("trash-empty")
        let close = NSButton(title: "关闭", target: self, action: #selector(closePanel))
        close.setAccessibilityIdentifier("trash-close")
        let filterRow = NSStackView(views: [NSTextField(labelWithString: "显示："), filterPopup])
        let actions = NSStackView(views: [restoreButton, purgeButton, NSView(), emptyButton, close])
        let stack = NSStackView(views: [filterRow, scroll, status, actions])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -16),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 200),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            actions.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        model.onChange = { [weak self] in self?.reload() }
        reload()
    }

    func reload() {
        let selected = selectedItem?.key
        rows = model.shown
        status.stringValue = model.status
        table.reloadData()
        if let selected, let index = rows.firstIndex(where: { $0.key == selected }) {
            table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
        }
        for (index, kind) in WorkspaceTrashKind.allCases.enumerated() {
            let count = model.count(kind)
            filterPopup.item(at: index + 1)?.title = count > 0 ? "\(kind.label)（\(count)）" : kind.label
        }
        filterPopup.item(at: 0)?.title = model.items.isEmpty ? "全部" : "全部（\(model.items.count)）"
        updateButtons()
    }

    private func updateButtons() {
        let idle = !model.busy && model.loaded
        // An item of an unknown kind is only removed by 清空回收站.
        let known = selectedItem.map { $0.kind != .unknown } ?? false
        restoreButton.isEnabled = idle && known
        purgeButton.isEnabled = idle && known
        emptyButton.isEnabled = idle && model.canEmpty
    }

    var selectedItem: WorkspaceTrashItem? { rows.indices.contains(table.selectedRow) ? rows[table.selectedRow] : nil }

    /// Selects an item's row, as a click does.
    @discardableResult
    func select(_ item: WorkspaceTrashItem) -> Bool {
        guard let index = rows.firstIndex(where: { $0.key == item.key }) else { return false }
        table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
        updateButtons()
        return true
    }

    /// Chooses a kind in the filter, as the popup does; nil shows every kind.
    func choose(filter kind: WorkspaceTrashKind?) {
        filterPopup.selectItem(at: kind.flatMap { WorkspaceTrashKind.allCases.firstIndex(of: $0) }.map { $0 + 1 } ?? 0)
        filterChanged()
    }

    @objc private func filterChanged() {
        model.filter = (filterPopup.selectedItem?.representedObject as? String).flatMap(WorkspaceTrashKind.init(rawValue:))
    }

    @objc private func closePanel() { onClose?() }

    // MARK: Commands

    @objc func restoreSelected() { if let item = selectedItem { restore(item) } }
    @objc func purgeSelected() { if let item = selectedItem { purge(item) } }

    private func ready() -> Bool {
        guard !model.busy, host != nil else { return false }
        guard canNavigate?() ?? true else {
            model.showStatus("请先完成输入，并等待正文保存后再操作回收站。"); return false
        }
        return true
    }

    func restore(_ item: WorkspaceTrashItem, completion: ((Error?) -> Void)? = nil) {
        guard ready(), let host else { completion?(LabError.message("回收站正忙，请稍后重试。")); return }
        model.setBusy(true)
        host.restore(item, projectID: model.projectID) { [weak self] result in
            guard let self else { return }
            self.model.setBusy(false)
            switch result {
            case .success:
                self.model.showStatus("\(item.kind.label)“\(item.displayTitle)”已恢复，可以从原来的列表打开。")
                completion?(nil)
            case .failure(let error):
                self.model.showStatus(error.localizedDescription)
                completion?(error)
            }
        }
    }

    /// Asks, naming the item and what goes with it, then purges it.
    func purge(_ item: WorkspaceTrashItem, completion: ((Error?) -> Void)? = nil) {
        guard ready() else { completion?(LabError.message("回收站正忙，请稍后重试。")); return }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = WorkspaceTrashText.purgeQuestion(item)
        alert.informativeText = WorkspaceTrashText.purgeDetail(item)
        let confirm = alert.addButton(withTitle: "彻底删除")
        confirm.hasDestructiveAction = true
        confirm.setAccessibilityIdentifier("confirm-trash-purge")
        alert.addButton(withTitle: "取消")
        present(alert) { [weak self] response in
            guard let self else { return }
            guard response == .alertFirstButtonReturn, let host = self.host else {
                completion?(LabError.message("已取消。")); return
            }
            self.model.setBusy(true)
            host.purge(item, projectID: self.model.projectID) { [weak self] result in
                guard let self else { return }
                self.model.setBusy(false)
                switch result {
                case .success(let reply):
                    self.model.adopt(reply)
                    self.model.showStatus("\(item.kind.label)“\(item.displayTitle)”已彻底删除。")
                    completion?(nil)
                case .failure(let error):
                    self.model.showStatus(error.localizedDescription)
                    completion?(error)
                }
            }
        }
    }

    /// Asks with the counts, then purges exactly those entries in one
    /// original. Rust refuses when the trash changed after the question; the
    /// list is read again and nothing is deleted.
    @objc func emptyTrashPressed() { emptyTrash(completion: nil) }

    func emptyTrash(completion: ((Error?) -> Void)?) {
        guard ready() else { completion?(LabError.message("回收站正忙，请稍后重试。")); return }
        guard model.canEmpty else {
            let reason = model.unread != nil ? "回收站没能完整读取，暂时不能清空。" : "回收站是空的。"
            completion?(LabError.message(reason)); return
        }
        let items = model.items
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = WorkspaceTrashText.emptyQuestion
        alert.informativeText = WorkspaceTrashText.emptyDetail(items)
        let confirm = alert.addButton(withTitle: "清空回收站")
        confirm.hasDestructiveAction = true
        confirm.setAccessibilityIdentifier("confirm-trash-empty")
        alert.addButton(withTitle: "取消")
        present(alert) { [weak self] response in
            guard let self else { return }
            guard response == .alertFirstButtonReturn, let host = self.host else {
                completion?(LabError.message("已取消。")); return
            }
            self.model.setBusy(true)
            host.emptyTrash(projectID: self.model.projectID, confirmed: items) { [weak self] result in
                guard let self else { return }
                self.model.setBusy(false)
                switch result {
                case .success(let reply):
                    self.model.adopt(reply)
                    self.model.showStatus("回收站已清空，彻底删除了 \(reply.purged.count) 项。")
                    completion?(nil)
                case .failure(let error):
                    if error.localizedDescription.contains("确认后有变化") {
                        self.model.showStatus("回收站在确认后有变化，没有删除任何内容。列表已重新读取，请查看后再清空。")
                        self.model.load()
                    } else {
                        self.model.showStatus(error.localizedDescription)
                    }
                    completion?(error)
                }
            }
        }
    }

    private func present(_ alert: NSAlert, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        lastAlert = alert
        if let presentAlert { presentAlert(alert, completion); return }
        if let window = view.window { alert.beginSheetModal(for: window, completionHandler: completion) }
        else { completion(alert.runModal()) }
    }

    // MARK: Table

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard rows.indices.contains(row) else { return nil }
        let item = rows[row]
        let text: String
        switch tableColumn?.identifier.rawValue {
        case "kind": text = item.kind.label
        case "time": text = WorkspaceTrashText.time(item)
        default: text = item.displayTitle
        }
        let label = NSTextField(labelWithString: text)
        label.lineBreakMode = .byTruncatingTail
        if tableColumn?.identifier.rawValue != "title" { label.textColor = .secondaryLabelColor }
        label.setAccessibilityIdentifier("trash-\(tableColumn?.identifier.rawValue ?? "title")-\(item.rawKind)-\(item.id)")
        return label
    }

    func tableViewSelectionDidChange(_ notification: Notification) { updateButtons() }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let row = table.clickedRow
        guard rows.indices.contains(row), !model.busy else { return }
        let item = rows[row]
        guard item.kind != .unknown else { return }
        let restore = LibraryMenuItem(title: "恢复", identifier: "trash-menu-restore") { [weak self] in self?.restore(item) }
        let purge = LibraryMenuItem(title: "彻底删除…", identifier: "trash-menu-purge") { [weak self] in self?.purge(item) }
        menu.addItem(restore)
        menu.addItem(purge)
    }
}
