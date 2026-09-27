import AppKit

/// 项目书架 (项目 › 项目书架…, and at launch while no project is chosen):
/// every project with its summary, chapters, words and last edit, newest
/// first. 打开 shows the project in the main window; 新建项目…, 重命名…,
/// 导出为 Markdown 文件夹… and 删除项目… (the existing deletion sheet) act on
/// the selected row.
final class MacProjectShelfWindowController: NSWindowController, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate, NSMenuDelegate {
    let model: ProjectShelfModel
    let table = NSTableView()
    let status = NSTextField(wrappingLabelWithString: "")
    let openButton = NSButton(title: "打开", target: nil, action: nil)
    let createButton = NSButton(title: "新建项目…", target: nil, action: nil)
    let renameButton = NSButton(title: "重命名…", target: nil, action: nil)
    let exportButton = NSButton(title: "导出为 Markdown 文件夹…", target: nil, action: nil)
    let deleteButton = NSButton(title: "删除项目…", target: nil, action: nil)
    /// Asks for a name (title, current name); nil answers cancel. Nil uses
    /// an alert with a text field. Acceptance answers here.
    var askName: ((String, String?, @escaping (String?) -> Void) -> Void)?
    var onOpen: ((WorkspaceProject) -> Void)?
    var onCreated: ((WorkspaceProject) -> Void)?
    var onRenamed: ((WorkspaceProject) -> Void)?
    var onDelete: ((WorkspaceProject) -> Void)?
    var onExport: ((WorkspaceProject) -> Void)?
    /// Whether the main window lets a project command run.
    var canAct: (() -> Bool)?
    var onClose: (() -> Void)?
    private(set) var rows: [ProjectShelfEntry] = []

    static let columns: [(id: String, title: String, width: CGFloat)] = [
        ("name", "项目", 150), ("summary", "简介", 220), ("counts", "章节与字数", 150), ("edited", "最后编辑", 150),
    ]

    init(model: ProjectShelfModel) {
        self.model = model
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 440), styleMask: [.titled, .closable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "项目书架"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 560, height: 320)
        window.setAccessibilityIdentifier("project-shelf")
        super.init(window: window)
        window.delegate = self
        for column in Self.columns {
            let tableColumn = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(column.id))
            tableColumn.title = column.title
            tableColumn.width = column.width
            table.addTableColumn(tableColumn)
        }
        table.rowHeight = 36
        table.usesAlternatingRowBackgroundColors = true
        table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        table.dataSource = self; table.delegate = self
        table.target = self; table.doubleAction = #selector(openSelected)
        table.setAccessibilityIdentifier("project-shelf-list")
        let menu = NSMenu()
        menu.delegate = self
        table.menu = menu
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder; scroll.documentView = table
        status.textColor = .secondaryLabelColor
        status.setAccessibilityIdentifier("project-shelf-status")
        for (button, id, action) in [(openButton, "shelf-open", #selector(openSelected)), (createButton, "shelf-create", #selector(createProject)),
                                     (renameButton, "shelf-rename", #selector(renameSelected)),
                                     (exportButton, "shelf-export", #selector(exportSelected)),
                                     (deleteButton, "shelf-delete", #selector(deleteSelected))] {
            button.target = self; button.action = action
            button.setAccessibilityIdentifier(id)
        }
        openButton.keyEquivalent = "\r"
        let buttons = NSStackView(views: [openButton, createButton, renameButton, NSView(), exportButton, deleteButton])
        let stack = NSStackView(views: [scroll, status, buttons])
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
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 200),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        model.onChange = { [weak self] in self?.reload() }
        reload()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func windowWillClose(_ notification: Notification) { onClose?() }

    func reload() {
        let selected = selectedEntry?.project.id
        rows = model.entries
        status.stringValue = model.status
        table.reloadData()
        if let selected, let index = rows.firstIndex(where: { $0.project.id == selected }) {
            table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
        }
        updateButtons()
    }

    private func updateButtons() {
        let idle = !model.busy
        let chosen = idle && selectedEntry != nil
        openButton.isEnabled = chosen
        createButton.isEnabled = idle
        renameButton.isEnabled = chosen
        exportButton.isEnabled = chosen
        deleteButton.isEnabled = chosen
    }

    var selectedEntry: ProjectShelfEntry? { rows.indices.contains(table.selectedRow) ? rows[table.selectedRow] : nil }

    @discardableResult
    func select(projectID: String) -> Bool {
        guard let index = rows.firstIndex(where: { $0.project.id == projectID }) else { return false }
        table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
        updateButtons()
        return true
    }

    private func allowed() -> Bool {
        guard !model.busy else { return false }
        guard canAct?() ?? true else { model.showStatus("请先完成输入，并等待正文保存后再操作项目。"); return false }
        return true
    }

    // MARK: Commands

    @objc func openSelected() {
        guard let entry = selectedEntry, allowed() else { return }
        onOpen?(entry.project)
    }

    @objc func createProject() {
        guard allowed() else { return }
        name(title: "新建项目", current: nil) { [weak self] name in
            guard let self, let name else { return }
            self.model.create(name: name) { [weak self] result in
                guard let self, case .success(let project) = result else { return }
                self.onCreated?(project)
                self.select(projectID: project.id)
            }
        }
    }

    @objc func renameSelected() {
        guard let entry = selectedEntry, allowed() else { return }
        name(title: "重命名项目", current: entry.project.name) { [weak self] name in
            guard let self, let name, name != entry.project.name else { return }
            self.model.rename(projectID: entry.project.id, name: name) { [weak self] result in
                if case .success(let project) = result { self?.onRenamed?(project) }
            }
        }
    }

    @objc func exportSelected() {
        guard let entry = selectedEntry, allowed() else { return }
        onExport?(entry.project)
    }

    @objc func deleteSelected() {
        guard let entry = selectedEntry, allowed() else { return }
        onDelete?(entry.project)
    }

    /// A trimmed, nonblank name, or nil when cancelled.
    private func name(title: String, current: String?, completion: @escaping (String?) -> Void) {
        let finish: (String?) -> Void = { [weak self] raw in
            guard let raw else { completion(nil); return }
            let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { self?.model.showStatus("名称不能为空，请重新输入。"); completion(nil); return }
            completion(name)
        }
        if let askName { askName(title, current, finish); return }
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = "给你的写作项目起个名字。"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 28))
        field.stringValue = current ?? ""
        field.placeholderString = "项目名称"
        field.setAccessibilityIdentifier("shelf-project-name")
        alert.accessoryView = field
        alert.addButton(withTitle: current == nil ? "创建" : "保存")
        alert.addButton(withTitle: "取消")
        let done: (NSApplication.ModalResponse) -> Void = { finish($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
        if let window { alert.beginSheetModal(for: window, completionHandler: done); alert.window.makeFirstResponder(field) }
        else { done(alert.runModal()) }
    }

    // MARK: Table

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard rows.indices.contains(row) else { return nil }
        let entry = rows[row]
        let id = tableColumn?.identifier.rawValue ?? "name"
        let text: String
        switch id {
        case "summary": text = entry.summary.isEmpty ? "暂无简介" : entry.summary.replacingOccurrences(of: "\n", with: " ")
        case "counts": text = entry.countsText
        case "edited": text = entry.lastEditedText.replacingOccurrences(of: "最后编辑 ", with: "")
        default: text = entry.project.name
        }
        let label = NSTextField(labelWithString: text)
        label.lineBreakMode = .byTruncatingTail
        label.toolTip = text
        if id == "name" { label.font = .systemFont(ofSize: 13, weight: .medium) }
        else { label.textColor = id == "summary" && entry.summary.isEmpty ? .tertiaryLabelColor : .secondaryLabelColor }
        label.setAccessibilityIdentifier("shelf-\(id)-\(entry.project.id)")
        return label
    }

    func tableViewSelectionDidChange(_ notification: Notification) { updateButtons() }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let row = table.clickedRow
        guard rows.indices.contains(row), !model.busy else { return }
        table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        menu.addItem(LibraryMenuItem(title: "打开", identifier: "shelf-menu-open") { [weak self] in self?.openSelected() })
        menu.addItem(LibraryMenuItem(title: "重命名…", identifier: "shelf-menu-rename") { [weak self] in self?.renameSelected() })
        menu.addItem(LibraryMenuItem(title: "导出为 Markdown 文件夹…", identifier: "shelf-menu-export") { [weak self] in self?.exportSelected() })
        menu.addItem(.separator())
        menu.addItem(LibraryMenuItem(title: "删除项目…", identifier: "shelf-menu-delete") { [weak self] in self?.deleteSelected() })
    }
}
