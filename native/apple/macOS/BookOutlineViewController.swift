import AppKit

final class BookOutlinePanel: NSPanel {
    var onClose: (() -> Void)?
    override func close() { super.close(); onClose?() }
}

final class BookOutlineViewController: NSViewController, NSTableViewDataSource, NSTableViewDelegate {
    let model: WorkspaceOutlineModel
    var onNavigate: ((WorkspaceOutlineEntry, String?) -> Void)?
    /// “故事线…” on a chapter row: edit its storylines and 主线.
    var onEditStorylines: ((WorkspaceOutlineEntry) -> Void)?
    var canNavigate: (() -> Bool)?
    var onClose: (() -> Void)?
    private let table = NSTableView()
    private let status = NSTextField(wrappingLabelWithString: "")
    private var rows: [WorkspaceOutlineModel.Row] = []

    init(model: WorkspaceOutlineModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        view = NSView()
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("outline"))
        table.addTableColumn(column)
        table.headerView = nil
        table.rowHeight = 38
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.dataSource = self; table.delegate = self
        table.setAccessibilityIdentifier("book-outline-list")
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.documentView = table
        status.textColor = .secondaryLabelColor
        status.setAccessibilityIdentifier("outline-status")
        let close = NSButton(title: "关闭大纲", target: self, action: #selector(closeOutline))
        close.setAccessibilityIdentifier("close-outline")
        let stack = NSStackView(views: [status, scroll, close])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -16),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        model.onChange = { [weak self] in self?.reload() }
        reload()
    }

    private func reload() {
        rows = model.rows
        status.stringValue = model.status
        table.reloadData()
    }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        cellView(rows[row])
    }

    /// The 主线 chip a chapter row shows, built as the table builds it; nil
    /// before memberships are read or when the chapter is not listed.
    func storylineChip(chapterID: String) -> StorylineChip? {
        guard let item = rows.first(where: { $0.isChapter && $0.entry.id == chapterID }) else { return nil }
        return cellView(item).arrangedSubviews.compactMap { $0 as? StorylineChip }.first
    }

    private func cellView(_ item: WorkspaceOutlineModel.Row) -> NSStackView {
        let label = NSTextField(labelWithString: item.label)
        label.lineBreakMode = .byTruncatingTail
        label.textColor = item.navigable ? .labelColor : .secondaryLabelColor
        label.font = .systemFont(ofSize: 14, weight: item.entry.kind == "act" ? .semibold : .regular)
        label.setAccessibilityIdentifier(item.identifier)
        label.setAccessibilityLabel(item.label)
        let stack = NSStackView(views: [label])
        stack.spacing = 6
        stack.edgeInsets = NSEdgeInsets(top: 0, left: CGFloat(item.depth) * 14, bottom: 0, right: 4)
        // A leading dot in the 主线 colour, hollow for 未归属, and the
        // storyline's name in secondary text after the title; no edge accent.
        if item.isChapter, model.storylines != nil {
            let chip = StorylineChip(storyline: model.primaryStoryline(chapterID: item.entry.id), showsName: false)
            chip.setAccessibilityIdentifier("outline-storyline-\(item.entry.id)")
            stack.insertArrangedSubview(chip, at: 0)
            let name = NSTextField(labelWithString: chip.text)
            name.font = .systemFont(ofSize: 11)
            name.textColor = chip.storyline == nil ? .tertiaryLabelColor : .secondaryLabelColor
            name.lineBreakMode = .byTruncatingTail
            name.setContentCompressionResistancePriority(.init(1), for: .horizontal)
            name.setAccessibilityIdentifier("outline-storyline-name-\(item.entry.id)")
            stack.addArrangedSubview(name)
        }
        if item.isChapter {
            let expanded = model.expanded.contains(item.entry.id)
            let button = OutlineDisclosureButton(title: expanded ? "▾" : "▸")
            button.bezelStyle = .inline
            button.setAccessibilityIdentifier("outline-expand-\(item.entry.id)")
            button.setAccessibilityLabel("\(expanded ? "收起" : "展开") \(item.entry.title)")
            button.onPress = { [weak self] in self?.model.toggle(item.entry.id) }
            stack.addArrangedSubview(button)
        }
        if item.isChapter || item.isAct { stack.addArrangedSubview(actions(for: item)) }
        return stack
    }

    /// The 操作 menu items of a chapter or act row, as the table builds them.
    func actionItems(entryID: String) -> [NSMenuItem] {
        guard let item = rows.first(where: { ($0.isChapter || $0.isAct) && $0.entry.id == entryID }) else { return [] }
        return Array(actions(for: item).itemArray.dropFirst())
    }

    private func actions(for item: WorkspaceOutlineModel.Row) -> NSPopUpButton {
        let button = NSPopUpButton(frame: .zero, pullsDown: true)
        button.addItem(withTitle: "操作")
        button.setAccessibilityIdentifier("outline-actions-\(item.entry.id)")
        button.setAccessibilityLabel("\(item.isAct ? "幕" : "章节")操作 \(item.entry.title)")
        button.isEnabled = !model.busy
        if item.isChapter {
            let create = OutlineActionMenuItem(title: "在此开始一幕") { [weak self] in
                guard let self, self.canChangeBoundary() else { return }
                self.model.createAct(beforeChapterID: item.entry.id)
            }
            create.setAccessibilityIdentifier("outline-create-act")
            button.menu?.addItem(create)
            let storylines = OutlineActionMenuItem(title: "故事线…") { [weak self] in self?.onEditStorylines?(item.entry) }
            storylines.setAccessibilityIdentifier("outline-chapter-storylines")
            storylines.isEnabled = onEditStorylines != nil
            button.menu?.addItem(storylines)
        } else {
            let rename = OutlineActionMenuItem(title: "改名") { [weak self] in self?.renameAct(item.entry) }
            rename.setAccessibilityIdentifier("outline-rename-act")
            let remove = OutlineActionMenuItem(title: "移除分界（保留章节）") { [weak self] in
                guard let self, self.canChangeBoundary() else { return }
                self.model.removeAct(id: item.entry.id)
            }
            remove.setAccessibilityIdentifier("outline-remove-act")
            button.menu?.addItem(rename); button.menu?.addItem(remove)
        }
        return button
    }

    private func canChangeBoundary() -> Bool {
        guard !model.busy, canNavigate?() == true else {
            model.showStatus("请先完成输入，并等待正文保存后再修改幕分界。"); return false
        }
        return true
    }

    private func renameAct(_ entry: WorkspaceOutlineEntry) {
        guard canChangeBoundary(), let window = view.window else { return }
        let alert = NSAlert()
        alert.messageText = "重命名幕"
        alert.informativeText = "只更改幕名称，章节和正文保持不变。"
        let field = NSTextField(string: entry.title)
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        field.setAccessibilityIdentifier("rename-act-name")
        alert.accessoryView = field
        let save = alert.addButton(withTitle: "保存")
        save.setAccessibilityIdentifier("confirm-rename-act")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn, self.canChangeBoundary() else { return }
            let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { self.model.showStatus("幕名称不能为空，请重新输入。"); return }
            self.model.renameAct(id: entry.id, name: name)
        }
        alert.window.makeFirstResponder(field)
        field.selectText(nil)
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        rows[row].navigable && !model.busy && canNavigate?() == true
    }
    func tableViewSelectionDidChange(_ notification: Notification) {
        guard rows.indices.contains(table.selectedRow) else { return }
        let item = rows[table.selectedRow]
        table.deselectAll(nil)
        guard item.navigable, !model.busy, canNavigate?() == true else { return }
        onNavigate?(item.entry, item.heading?.blockId)
    }
    @objc private func closeOutline() { onClose?() }
}

private final class OutlineDisclosureButton: NSButton {
    var onPress: (() -> Void)?
    init(title: String) {
        super.init(frame: .zero)
        self.title = title
        target = self; action = #selector(press)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    @objc private func press() { onPress?() }
}

private final class OutlineActionMenuItem: NSMenuItem {
    private let onPress: () -> Void
    init(title: String, onPress: @escaping () -> Void) {
        self.onPress = onPress
        super.init(title: title, action: #selector(press), keyEquivalent: "")
        target = self
    }
    required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    @objc private func press() { onPress() }
}
