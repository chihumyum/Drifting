import AppKit

final class StorylineLibraryPanel: NSPanel {
    var onClose: (() -> Void)?
    override func close() { super.close(); onClose?() }
}

/// The 故事线 panel: live storylines in their authored order with colour,
/// name and chapter count, reordered by dragging or 上移/下移, and the trash
/// with 恢复. Opening and trashing a storyline go through the owner of the
/// editor tabs; every other command is a library command whose reply reaches
/// open pages, the outline and chapter lists through the model.
final class MacStorylineLibraryViewController: NSViewController, NSTableViewDataSource, NSTableViewDelegate, NSMenuDelegate {
    static let dragType = NSPasteboard.PasteboardType("cc.drifting.native-lab.storyline")

    let model: StorylineLibraryModel
    var onOpen: ((WorkspaceStoryline) -> Void)?
    var onTrash: ((WorkspaceStoryline) -> Void)?
    var onCreated: ((WorkspaceStoryline) -> Void)?
    /// 新建章节… in a row's menu: a chapter in that storyline, from its 章节模版.
    var onCreateChapter: ((WorkspaceStoryline) -> Void)?
    var canNavigate: (() -> Bool)?
    var onClose: (() -> Void)?
    /// Presents an alert (confirmations and name or summary prompts). Nil uses
    /// a sheet on the panel; acceptance answers here without a window.
    var presentAlert: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
    let table = NSTableView()
    private let status = NSTextField(wrappingLabelWithString: "")
    let createButton = NSButton(title: "新建故事线", target: nil, action: nil)
    private(set) var rows: [StorylineLibraryModel.Row] = []

    init(model: StorylineLibraryModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        view = NSView()
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("storyline")))
        table.headerView = nil
        table.rowHeight = 30
        table.usesAutomaticRowHeights = false
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.dataSource = self; table.delegate = self
        // A click opens the page on mouse-up, so dragging a row to reorder
        // never opens it.
        table.target = self; table.action = #selector(rowClicked)
        table.registerForDraggedTypes([Self.dragType])
        table.draggingDestinationFeedbackStyle = .gap
        table.setDraggingSourceOperationMask(.move, forLocal: true)
        table.setAccessibilityIdentifier("storyline-list")
        let menu = NSMenu()
        menu.delegate = self
        table.menu = menu
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.documentView = table
        status.textColor = .secondaryLabelColor
        status.setAccessibilityIdentifier("storyline-status")
        createButton.target = self; createButton.action = #selector(createStoryline)
        createButton.setAccessibilityIdentifier("create-storyline")
        let close = NSButton(title: "关闭故事线", target: self, action: #selector(closePanel))
        close.setAccessibilityIdentifier("close-storylines")
        let actions = NSStackView(views: [createButton, NSView(), close])
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
        createButton.isEnabled = !model.busy && model.loaded
        table.reloadData()
    }

    // MARK: Rows

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        switch rows[row] {
        case .storyline(let storyline, _, _) where !storyline.summary.isEmpty: return 42
        case .trashHeader: return 34
        default: return 30
        }
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        cellView(rows[row])
    }

    /// One row's view, also read by acceptance.
    func cellView(_ item: StorylineLibraryModel.Row) -> NSView {
        let stack = NSStackView()
        stack.spacing = 8
        stack.setAccessibilityIdentifier(item.identifier)
        switch item {
        case .storyline(let storyline, let chapters, let primaries):
            let swatch = NSImageView(image: StorylineChip.dot(hex: storyline.color))
            swatch.setAccessibilityLabel("颜色 \(storyline.color)")
            let name = NSTextField(labelWithString: storyline.name)
            name.font = .systemFont(ofSize: 13, weight: .medium)
            name.lineBreakMode = .byTruncatingTail
            name.setAccessibilityLabel(storyline.name)
            let text = NSStackView(views: [name])
            text.orientation = .vertical; text.alignment = .leading; text.spacing = 1
            if !storyline.summary.isEmpty {
                let summary = NSTextField(labelWithString: MacChapterCommentsViewController.flatten(storyline.summary))
                summary.font = .systemFont(ofSize: 11); summary.textColor = .secondaryLabelColor
                summary.lineBreakMode = .byTruncatingTail
                text.addArrangedSubview(summary)
            }
            let count = NSTextField(labelWithString: Self.countText(chapters: chapters, primaries: primaries))
            count.textColor = .tertiaryLabelColor
            count.setAccessibilityIdentifier("storyline-count-\(storyline.id)")
            count.setContentCompressionResistancePriority(.required, for: .horizontal)
            text.setContentCompressionResistancePriority(.init(1), for: .horizontal)
            stack.setViews([swatch, text, NSView(), count], in: .leading)
            stack.edgeInsets = NSEdgeInsets(top: 0, left: 2, bottom: 0, right: 4)
        case .empty:
            let label = NSTextField(labelWithString: "还没有故事线")
            label.textColor = .tertiaryLabelColor
            stack.setViews([label], in: .leading)
        case .trashHeader(let count):
            let label = NSTextField(labelWithString: "回收站")
            label.font = .systemFont(ofSize: 13, weight: .semibold)
            let number = NSTextField(labelWithString: "\(count)")
            number.textColor = .tertiaryLabelColor
            stack.setViews([label, number], in: .leading)
        case .trashed(let storyline):
            let swatch = NSImageView(image: StorylineChip.dot(hex: storyline.color))
            swatch.setAccessibilityLabel("颜色 \(storyline.color)")
            let name = NSTextField(labelWithString: storyline.name)
            name.textColor = .secondaryLabelColor
            name.lineBreakMode = .byTruncatingTail
            let restore = StorylineButton(title: "恢复", identifier: "restore-storyline-\(storyline.id)") { [weak self] in
                self?.restore(storyline)
            }
            restore.isEnabled = !model.busy
            stack.setViews([swatch, name, NSView(), restore], in: .leading)
            stack.edgeInsets = NSEdgeInsets(top: 0, left: 12, bottom: 0, right: 4)
        }
        return stack
    }

    static func countText(chapters: Int, primaries: Int) -> String {
        chapters == 0 ? "0 章" : primaries == chapters ? "\(chapters) 章 · 均为主线" : "\(chapters) 章 · 主线 \(primaries)"
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        if case .storyline = rows[row] { return true }
        return false
    }

    @objc private func rowClicked() {
        let row = table.clickedRow
        table.deselectAll(nil)
        guard rows.indices.contains(row), case .storyline(let storyline, _, _) = rows[row] else { return }
        open(storyline)
    }

    // MARK: Drag to reorder

    func tableView(_ tableView: NSTableView, pasteboardWriterForRow row: Int) -> NSPasteboardWriting? {
        guard !model.busy, case .storyline(let storyline, _, _) = rows[row] else { return nil }
        let item = NSPasteboardItem()
        item.setString(storyline.id, forType: Self.dragType)
        return item
    }

    func tableView(_ tableView: NSTableView, validateDrop info: NSDraggingInfo, proposedRow row: Int,
                   proposedDropOperation dropOperation: NSTableView.DropOperation) -> NSDragOperation {
        guard let id = info.draggingPasteboard.string(forType: Self.dragType) else { return [] }
        let target = min(row, model.library.storylines.count)
        if dropOperation == .on || target != row { tableView.setDropRow(target, dropOperation: .above) }
        return model.destination(moving: id, toIndex: target) == nil ? [] : .move
    }

    func tableView(_ tableView: NSTableView, acceptDrop info: NSDraggingInfo, row: Int,
                   dropOperation: NSTableView.DropOperation) -> Bool {
        guard let id = info.draggingPasteboard.string(forType: Self.dragType) else { return false }
        return drop(storylineID: id, above: row)
    }

    /// Moves a dragged storyline above list position `row`; false when it
    /// would stay in place or the library is busy.
    @discardableResult
    func drop(storylineID id: String, above row: Int) -> Bool {
        let target = min(row, model.library.storylines.count)
        guard !model.busy, model.destination(moving: id, toIndex: target) != nil else { return false }
        model.move(id: id, toIndex: target)
        return true
    }

    // MARK: Context menus

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let row = table.clickedRow
        guard rows.indices.contains(row) else { return }
        for item in menuItems(for: rows[row]) { menu.addItem(item) }
    }

    /// The context actions of one row, also used by acceptance.
    func menuItems(for row: StorylineLibraryModel.Row) -> [NSMenuItem] {
        switch row {
        case .storyline(let storyline, _, _):
            let index = model.library.storylines.firstIndex { $0.id == storyline.id } ?? 0
            let open = LibraryMenuItem(title: "打开页面", identifier: "open-storyline") { [weak self] in self?.open(storyline) }
            let chapter = LibraryMenuItem(title: "新建章节…", identifier: "create-storyline-chapter") { [weak self] in
                guard let self, self.canChange() else { return }
                self.onCreateChapter?(storyline)
            }
            chapter.toolTip = "新章节以这条故事线为主线，正文从它的章节模版开始"
            chapter.isEnabled = onCreateChapter != nil
            let rename = LibraryMenuItem(title: "重命名…", identifier: "rename-storyline") { [weak self] in self?.rename(storyline) }
            let colors = NSMenuItem(title: "更改颜色", action: nil, keyEquivalent: "")
            let palette = NSMenu(title: "更改颜色")
            for entry in MacElementLibraryViewController.palette {
                let item = LibraryMenuItem(title: entry.name, identifier: "storyline-color-\(entry.hex)") { [weak self] in
                    guard let self, self.canCommand() else { return }
                    self.model.recolor(id: storyline.id, color: entry.hex)
                }
                item.image = ElementSwatch.image(color: ElementSwatch.color(hex: entry.hex))
                item.state = storyline.color.caseInsensitiveCompare(entry.hex) == .orderedSame ? .on : .off
                palette.addItem(item)
            }
            colors.submenu = palette
            let summary = LibraryMenuItem(title: "编辑简介…", identifier: "edit-storyline-summary") { [weak self] in
                self?.editSummary(storyline)
            }
            let up = LibraryMenuItem(title: "上移", identifier: "move-storyline-up") { [weak self] in
                guard let self, self.canCommand() else { return }
                self.model.moveUp(id: storyline.id)
            }
            up.isEnabled = index > 0
            let down = LibraryMenuItem(title: "下移", identifier: "move-storyline-down") { [weak self] in
                guard let self, self.canCommand() else { return }
                self.model.moveDown(id: storyline.id)
            }
            down.isEnabled = index + 1 < model.library.storylines.count
            let trash = LibraryMenuItem(title: "移到回收站…", identifier: "trash-storyline") { [weak self] in
                self?.confirmTrash(storyline)
            }
            return [open, chapter, .separator(), rename, colors, summary, .separator(), up, down, .separator(), trash]
        case .trashed(let storyline):
            return [LibraryMenuItem(title: "恢复", identifier: "restore-storyline") { [weak self] in self?.restore(storyline) }]
        default:
            return []
        }
    }

    private func canCommand() -> Bool {
        guard !model.busy else { model.showStatus("正在保存故事线，请稍后重试。"); return false }
        return true
    }

    /// Opening a page or trashing (which closes pages) changes owners.
    private func canChange() -> Bool {
        guard !model.busy, canNavigate?() == true else {
            model.showStatus("请先完成输入，并等待正文保存后再修改故事线。"); return false
        }
        return true
    }

    private func open(_ storyline: WorkspaceStoryline) {
        guard canChange() else { return }
        onOpen?(storyline)
    }

    private func restore(_ storyline: WorkspaceStoryline) {
        guard canChange() else { return }
        model.restore(id: storyline.id)
    }

    /// Explains the primary rule before a trash: chapters whose 主线 it is
    /// lose all their storylines; others lose only this one.
    private func confirmTrash(_ storyline: WorkspaceStoryline) {
        guard canChange() else { return }
        let library = model.library
        let primaries = library.primaryChapters(storylineID: storyline.id).count
        let others = library.chapters(storylineID: storyline.id).count - primaries
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "将故事线“\(storyline.name)”移到回收站？"
        alert.informativeText = Self.trashExplanation(primaries: primaries, others: others)
        alert.addButton(withTitle: "移到回收站").setAccessibilityIdentifier("confirm-trash-storyline")
        alert.addButton(withTitle: "取消")
        present(alert) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn, self.canChange() else { return }
            self.onTrash?(storyline)
        }
    }

    static func trashExplanation(primaries: Int, others: Int) -> String {
        guard primaries + others > 0 else { return "没有章节属于这条故事线。之后可以在回收站中恢复它。" }
        var parts: [String] = []
        if primaries > 0 { parts.append("\(primaries) 个章节以它为主线，这些章节会失去全部故事线，变为“未归属”。") }
        if others > 0 { parts.append("\(others) 个章节只会移除这条故事线，主线保持不变。") }
        parts.append("恢复故事线时，章节不会重新归属。正文和页面内容保持不变。")
        return parts.joined(separator: "\n")
    }

    @objc private func createStoryline() {
        guard canCommand() else { return }
        let first = model.library.storylines.isEmpty
        askText(title: "新建故事线",
                detail: first ? "第一条故事线会成为所有章节的主线。留空将使用默认名称。" : "留空将使用默认名称；同名时会自动加上序号。",
                current: "", identifier: "new-storyline-name", confirm: "创建") { [weak self] name in
            self?.model.create(name: name) { [weak self] result in
                if case .success(let storyline) = result { self?.onCreated?(storyline) }
            }
        }
    }

    private func rename(_ storyline: WorkspaceStoryline) {
        guard canCommand() else { return }
        askText(title: "重命名故事线", detail: "只更改名称；与其他故事线同名时会自动加上序号。", current: storyline.name,
                identifier: "rename-storyline-name", confirm: "保存") { [weak self] name in
            guard !name.isEmpty else { self?.model.showStatus("故事线名称不能为空，请重新输入。"); return }
            self?.model.rename(id: storyline.id, name: name)
        }
    }

    private func editSummary(_ storyline: WorkspaceStoryline) {
        guard canCommand() else { return }
        let alert = NSAlert()
        alert.messageText = "编辑简介"
        alert.informativeText = "“\(storyline.name)”的简介会显示在故事线列表和页面中。"
        let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 90))
        text.isRichText = false
        text.font = .systemFont(ofSize: 13)
        text.string = storyline.summary
        text.setAccessibilityIdentifier("storyline-summary-text")
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 300, height: 90))
        scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        scroll.documentView = text
        alert.accessoryView = scroll
        alert.addButton(withTitle: "保存").setAccessibilityIdentifier("confirm-storyline-summary")
        alert.addButton(withTitle: "取消")
        present(alert) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn else { return }
            self.model.setSummary(id: storyline.id, summary: text.string)
        }
        alert.window.makeFirstResponder(text)
    }

    private func askText(title: String, detail: String, current: String, identifier: String, confirm: String,
                         completion: @escaping (String) -> Void) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        let field = NSTextField(string: current)
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        field.placeholderString = "故事线名称"
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

private final class StorylineButton: NSButton {
    private let pressed: () -> Void
    init(title: String, identifier: String, pressed: @escaping () -> Void) {
        self.pressed = pressed
        super.init(frame: .zero)
        self.title = title
        bezelStyle = .rounded; controlSize = .small
        font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
        target = self; action = #selector(press)
        setAccessibilityIdentifier(identifier)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    @objc private func press() { pressed() }
}
