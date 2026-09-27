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
    /// “绑定幕笔记…” chose a drift for the act, or “解除幕笔记” passed nil.
    var onBindDrift: ((WorkspaceOutlineEntry, WorkspaceDrift?) -> Void)?
    /// An act row's notes subtitle opens the drift page.
    var onOpenDrift: ((WorkspaceDrift) -> Void)?
    /// A chapter row's 操作 menu chose another writing status.
    var onSetChapterStatus: ((WorkspaceOutlineEntry, String) -> Void)?
    /// Presents the drift picker. Nil uses a sheet on the panel; acceptance
    /// answers here without a window.
    var presentAlert: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
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

    /// A chapter or act row's view, built as the table builds it.
    func rowView(entryID: String) -> NSStackView? {
        rows.first { ($0.isChapter || $0.isAct) && $0.entry.id == entryID }.map(cellView)
    }

    /// The notes subtitle of an act row, built as the table builds it; nil
    /// when no drift is bound (or drifts are not yet read).
    func actDriftButton(actID: String) -> NSButton? {
        guard let item = rows.first(where: { $0.isAct && $0.entry.id == actID }) else { return nil }
        return cellView(item).arrangedSubviews.compactMap { $0 as? NSButton }
            .first { $0.accessibilityIdentifier() == "outline-act-drift-\(actID)" }
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
        // An act leads with a small swatch of its colour; no edge accent.
        if item.isAct, let hex = model.actHex(actID: item.entry.id) {
            let swatch = NSImageView(image: ElementSwatch.image(color: ElementSwatch.color(hex: hex)))
            swatch.setAccessibilityIdentifier("outline-act-swatch-\(item.entry.id)")
            swatch.setAccessibilityLabel("幕颜色")
            swatch.toolTip = hex
            swatch.setContentHuggingPriority(.required, for: .horizontal)
            stack.insertArrangedSubview(swatch, at: 0)
        }
        // The writing status follows the title in small text: 已完成 a little
        // stronger, 已弃用 with the title muted. No edge accent.
        if item.isChapter, let status = model.writingStatus(chapterID: item.entry.id) {
            let finished = status == WritingStatus.finished.rawValue
            let text = NSTextField(labelWithString: WritingStatus.label(status))
            text.font = .systemFont(ofSize: 11, weight: finished ? .medium : .regular)
            text.textColor = finished ? .secondaryLabelColor : .tertiaryLabelColor
            text.setContentHuggingPriority(.required, for: .horizontal)
            text.setAccessibilityIdentifier("outline-status-\(item.entry.id)")
            stack.addArrangedSubview(text)
            if status == WritingStatus.discarded.rawValue { label.textColor = .secondaryLabelColor }
            label.setAccessibilityLabel("\(item.label)，\(WritingStatus.label(status))")
        }
        // The chapter's compact word count; nothing until it has one.
        if item.isChapter, let words = MacWordCount.rowLabel(model.wordCount(chapterID: item.entry.id),
                                                             identifier: "outline-words-\(item.entry.id)") {
            stack.addArrangedSubview(words)
        }
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
        // An act's bound notes follow its name in secondary text; clicking
        // them opens the drift page.
        if item.isAct, let drift = model.boundDrift(actID: item.entry.id) {
            let notes = OutlineDisclosureButton(title: "幕笔记 · \(drift.title)")
            notes.isBordered = false
            notes.font = .systemFont(ofSize: 11)
            notes.contentTintColor = .secondaryLabelColor
            notes.lineBreakMode = .byTruncatingTail
            notes.setContentCompressionResistancePriority(.init(1), for: .horizontal)
            notes.setAccessibilityIdentifier("outline-act-drift-\(item.entry.id)")
            notes.setAccessibilityLabel("打开幕笔记 \(drift.title)")
            notes.toolTip = "打开漂流「\(drift.title)」"
            notes.onPress = { [weak self] in
                guard let self, self.canNavigate?() == true else {
                    self?.model.showStatus("请先完成输入，并等待正文保存后再打开幕笔记。"); return
                }
                self.onOpenDrift?(drift)
            }
            stack.addArrangedSubview(notes)
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
            // 写作状态: the current status is checked; choosing it writes nothing.
            button.menu?.addItem(.separator())
            let heading = NSMenuItem(title: "写作状态", action: nil, keyEquivalent: "")
            heading.isEnabled = false
            button.menu?.addItem(heading)
            let current = model.writingStatus(chapterID: item.entry.id)
            for status in WritingStatus.chapter {
                let choice = OutlineActionMenuItem(title: status.label) { [weak self] in self?.setStatus(item.entry, status.rawValue) }
                choice.setAccessibilityIdentifier("outline-chapter-status-\(status.rawValue)")
                choice.state = current == status.rawValue ? .on : .off
                choice.isEnabled = onSetChapterStatus != nil && current != nil
                button.menu?.addItem(choice)
            }
        } else {
            let rename = OutlineActionMenuItem(title: "改名") { [weak self] in self?.renameAct(item.entry) }
            rename.setAccessibilityIdentifier("outline-rename-act")
            let remove = OutlineActionMenuItem(title: "移除分界（保留章节）") { [weak self] in
                guard let self, self.canChangeBoundary() else { return }
                self.model.removeAct(id: item.entry.id)
            }
            remove.setAccessibilityIdentifier("outline-remove-act")
            button.menu?.addItem(rename); button.menu?.addItem(remove)
            button.menu?.addItem(actColorItem(item.entry))
            button.menu?.addItem(.separator())
            let bound = model.boundDrift(actID: item.entry.id)
            let bind = OutlineActionMenuItem(title: bound == nil ? "绑定幕笔记…" : "更换幕笔记…") { [weak self] in
                self?.chooseDrift(for: item.entry)
            }
            bind.setAccessibilityIdentifier("outline-bind-act-drift")
            bind.isEnabled = onBindDrift != nil && model.drifts?.unboundDrifts.isEmpty == false
            let unbind = OutlineActionMenuItem(title: "解除幕笔记") { [weak self] in
                guard let self, self.canBindDrift() else { return }
                self.onBindDrift?(item.entry, nil)
            }
            unbind.setAccessibilityIdentifier("outline-unbind-act-drift")
            unbind.isEnabled = onBindDrift != nil && bound != nil
            button.menu?.addItem(bind); button.menu?.addItem(unbind)
        }
        return button
    }

    /// 幕颜色: the palette with the stored colour checked, and 恢复默认 while
    /// one is stored. Choosing the stored colour writes nothing.
    private func actColorItem(_ entry: WorkspaceOutlineEntry) -> NSMenuItem {
        let item = NSMenuItem(title: "幕颜色", action: nil, keyEquivalent: "")
        item.setAccessibilityIdentifier("outline-act-color")
        item.submenu = ActColorMenu.make(stored: entry.color, prefix: "outline-act-color") { [weak self] color in
            guard let self, self.canChangeColor() else { return }
            self.model.setActColor(id: entry.id, color: color)
        }
        item.isEnabled = !model.busy
        return item
    }

    private func canChangeColor() -> Bool {
        guard !model.busy else { model.showStatus("正在保存幕分界，请稍后重试。"); return false }
        return true
    }

    private func setStatus(_ entry: WorkspaceOutlineEntry, _ status: String) {
        guard model.writingStatus(chapterID: entry.id) != status else { return }
        guard !model.busy else { model.showStatus("正在保存幕分界，请稍后重试。"); return }
        onSetChapterStatus?(entry, status)
    }

    private func canBindDrift() -> Bool {
        guard !model.busy else { model.showStatus("正在保存幕分界，请稍后重试。"); return false }
        return true
    }

    /// Picks one of the drifts not yet bound to any act.
    private func chooseDrift(for entry: WorkspaceOutlineEntry) {
        guard canBindDrift() else { return }
        let candidates = model.drifts?.unboundDrifts ?? []
        guard !candidates.isEmpty else {
            model.showStatus("没有可绑定的漂流。每条漂流只能作为一幕的笔记；可以先在“漂流”中新建。"); return
        }
        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 280, height: 26), pullsDown: false)
        for drift in candidates {
            popup.addItem(withTitle: drift.title)
            popup.lastItem?.representedObject = drift.id
        }
        popup.setAccessibilityIdentifier("bind-act-drift-choice")
        let alert = NSAlert()
        alert.messageText = "绑定幕笔记"
        alert.informativeText = "选择一条尚未绑定的漂流，作为“\(entry.title)”的笔记。每条漂流只能绑定一幕。"
        alert.accessoryView = popup
        alert.addButton(withTitle: "绑定").setAccessibilityIdentifier("confirm-bind-act-drift")
        alert.addButton(withTitle: "取消")
        let finish: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard let self, response == .alertFirstButtonReturn, self.canBindDrift(),
                  let id = popup.selectedItem?.representedObject as? String,
                  let drift = candidates.first(where: { $0.id == id }) else { return }
            self.onBindDrift?(entry, drift)
        }
        if let presentAlert { presentAlert(alert, finish) }
        else if let window = view.window { alert.beginSheetModal(for: window, completionHandler: finish) }
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

/// 幕颜色's submenu, shared by the 整书大纲 and the 全书长卷's act separators:
/// the palette with swatches, the stored colour checked, then 恢复默认.
enum ActColorMenu {
    static func make(stored: String?, prefix: String, choose: @escaping (String?) -> Void) -> NSMenu {
        let menu = NSMenu(title: "幕颜色")
        for entry in BookPalette.choices {
            let item = LibraryMenuItem(title: entry.name, identifier: "\(prefix)-\(entry.hex.dropFirst().lowercased())") {
                // The stored colour is already applied; nothing is written.
                guard stored?.caseInsensitiveCompare(entry.hex) != .orderedSame else { return }
                choose(entry.hex)
            }
            item.image = ElementSwatch.image(color: ElementSwatch.color(hex: entry.hex))
            item.state = stored?.caseInsensitiveCompare(entry.hex) == .orderedSame ? .on : .off
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let reset = LibraryMenuItem(title: "恢复默认", identifier: "\(prefix)-default") { choose(nil) }
        reset.isEnabled = stored != nil
        reset.toolTip = "按幕的顺序使用默认颜色"
        menu.addItem(reset)
        menu.autoenablesItems = false
        return menu
    }
}
