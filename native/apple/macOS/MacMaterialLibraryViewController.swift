import AppKit
import QuickLookUI
import UniformTypeIdentifiers

final class MaterialLibraryPanel: NSPanel {
    var onClose: (() -> Void)?
    override func close() { super.close(); onClose?() }
}

/// The 素材库: a list of cards for imported images and PDFs, links and text
/// notes. Files are imported with an open panel or dropped on the list;
/// images and PDFs preview in Quick Look, links open in the browser and
/// notes edit in a sheet. Every command's reply replaces the whole list.
final class MacMaterialLibraryViewController: NSViewController, NSTableViewDataSource, NSTableViewDelegate, NSMenuDelegate,
                                              QLPreviewPanelDataSource, QLPreviewPanelDelegate {
    static let cardHeight: CGFloat = 84

    let model: MaterialLibraryModel
    var onClose: (() -> Void)?
    /// Presents a confirmation or a text prompt. Nil uses a sheet on the
    /// panel; acceptance answers here without a window.
    var presentAlert: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
    /// Chooses files to import; nil uses an open panel with multiple selection.
    var chooseFiles: ((@escaping ([URL]) -> Void) -> Void)?
    /// Opens a link; nil uses the default browser.
    var openURL: ((URL) -> Void)?
    /// Shows files in Quick Look; nil uses the shared preview panel.
    var onQuickLook: (([URL]) -> Void)?
    /// 关联 chips and menus; nil shows neither.
    var associations: AssociationModel? {
        didSet { associations?.observe(self) { [weak self] in self?.reload() }; reload() }
    }
    /// Opens an associated entity from a chip.
    var onOpenAssociation: ((RelationEndpoint) -> Void)?
    /// Kinds (`image`, `pdf`, `url`, `text`) the list leaves out, e.g. by the
    /// 备忘与素材 board's filter chips. Drags still place items in the whole order.
    var hiddenKinds: Set<String> = [] { didSet { if oldValue != hiddenKinds { reload() } } }
    /// The 关闭 button; the board hosts the list without it.
    var showsCloseButton = true { didSet { closeButton.isHidden = !showsCloseButton } }
    static let itemPasteboardType = NSPasteboard.PasteboardType("cc.drifting.native-lab.library-item")
    private let closeButton = NSButton(title: "关闭", target: nil, action: nil)
    /// The open 编辑 or 新建笔记 sheet, if any.
    private(set) var editSheet: MaterialEditSheet?
    /// What Quick Look shows: the stored file of the previewed item.
    private(set) var previewItems: [URL] = []
    let table = MaterialTableView()
    let importButton = NSButton(title: "导入文件…", target: nil, action: nil)
    let linkButton = NSButton(title: "添加链接…", target: nil, action: nil)
    let noteButton = NSButton(title: "新建笔记", target: nil, action: nil)
    private let status = NSTextField(wrappingLabelWithString: "")
    private(set) var items: [WorkspaceMaterialItem] = []

    init(model: MaterialLibraryModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        view = NSView()
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("material")))
        table.headerView = nil
        table.style = .plain
        table.rowHeight = Self.cardHeight
        table.intercellSpacing = NSSize(width: 0, height: 8)
        table.selectionHighlightStyle = .none
        table.backgroundColor = .clear
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.dataSource = self; table.delegate = self
        table.target = self; table.doubleAction = #selector(previewClicked)
        table.setAccessibilityIdentifier("material-library-list")
        table.registerForDraggedTypes([.fileURL, Self.itemPasteboardType])
        table.setDraggingSourceOperationMask(.move, forLocal: true)
        table.onSpace = { [weak self] in self?.toggleQuickLook() }
        table.onReturn = { [weak self] in self?.previewSelected() }
        table.onDelete = { [weak self] in
            guard let self, let item = self.selectedItem else { return }
            self.confirmDelete(item)
        }
        let menu = NSMenu()
        menu.delegate = self
        table.menu = menu
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.documentView = table
        status.textColor = .secondaryLabelColor
        status.setAccessibilityIdentifier("material-library-status")
        for (button, id, action) in [(importButton, "import-materials", #selector(importFiles)),
                                     (linkButton, "add-material-link", #selector(addLink)),
                                     (noteButton, "create-material-note", #selector(createNote))] {
            button.target = self; button.action = action
            button.setAccessibilityIdentifier(id)
        }
        importButton.toolTip = "导入图片或 PDF，可以多选；也可以把文件拖到下方列表。"
        closeButton.target = self; closeButton.action = #selector(closeLibrary)
        closeButton.setAccessibilityIdentifier("close-material-library")
        closeButton.isHidden = !showsCloseButton
        let actions = NSStackView(views: [importButton, linkButton, noteButton, NSView(), closeButton])
        let stack = NSStackView(views: [actions, status, scroll])
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
        model.observe(self) { [weak self] in self?.reload() }
        reload()
    }

    func reload() {
        guard isViewLoaded else { return }
        let selected = selectedItem?.id
        items = model.items.filter { !hiddenKinds.contains($0.kind) }
        status.stringValue = model.status
        for button in [importButton, linkButton, noteButton] { button.isEnabled = !model.busy && model.loaded }
        table.reloadData()
        if let selected, let row = items.firstIndex(where: { $0.id == selected }) {
            table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        }
        if QLPreviewPanel.sharedPreviewPanelExists(), QLPreviewPanel.shared().isVisible,
           QLPreviewPanel.shared().dataSource === self {
            // A deleted file leaves the preview.
            previewItems = previewItems.filter { url in items.contains { $0.assetPath == url.path } }
            QLPreviewPanel.shared().reloadData()
        }
    }

    // MARK: Cards

    func numberOfRows(in tableView: NSTableView) -> Int { items.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let card = MaterialCardView()
        let item = items[row]
        card.show(item, selected: table.selectedRow == row)
        card.chips.show(associationEntries(item))
        card.chips.onOpen = { [weak self] entry in self?.onOpenAssociation?(entry.target) }
        card.chips.onRemove = { [weak self] entry in self?.dissociate(item, from: entry.target) }
        return card
    }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        guard items.indices.contains(row) else { return Self.cardHeight }
        return Self.cardHeight + (associationEntries(items[row]).isEmpty ? 0 : MaterialCardView.chipsHeight)
    }

    // MARK: 关联

    private func associationEntries(_ item: WorkspaceMaterialItem) -> [AssociationEntry] {
        associations?.entries(of: RelationEndpoint(kind: "library_item", id: item.id)) ?? []
    }

    func associate(_ item: WorkspaceMaterialItem, with target: RelationEndpoint) {
        guard let associations else { return }
        associations.add(RelationEndpoint(kind: "library_item", id: item.id), target) { [weak self] result in
            switch result {
            case .success: self?.model.showStatus("“\(item.title)”已关联“\(associations.names().name(of: target).name)”。")
            case .failure(let error): self?.model.showStatus(error.localizedDescription)
            }
        }
    }

    func dissociate(_ item: WorkspaceMaterialItem, from target: RelationEndpoint) {
        guard let associations else { return }
        associations.remove(RelationEndpoint(kind: "library_item", id: item.id), target) { [weak self] result in
            switch result {
            case .success: self?.model.showStatus("已移除“\(item.title)”的关联。")
            case .failure(let error): self?.model.showStatus(error.localizedDescription)
            }
        }
    }

    // MARK: Reordering

    /// A card dragged within the list carries the item's identity.
    func tableView(_ tableView: NSTableView, pasteboardWriterForRow row: Int) -> NSPasteboardWriting? {
        guard model.loaded, !model.busy, items.indices.contains(row) else { return nil }
        let item = NSPasteboardItem()
        item.setString(items[row].id, forType: Self.itemPasteboardType)
        return item
    }

    private func draggedItemID(on pasteboard: NSPasteboard) -> String? {
        pasteboard.string(forType: Self.itemPasteboardType).flatMap { id in model.library.item(id: id) == nil ? nil : id }
    }

    /// Where a card dropped above `row` of the shown list goes in the whole
    /// order: before the shown card it lands above, else after the last shown
    /// card. Hidden kinds keep their places.
    func destination(forDropAt row: Int, moving itemID: String) -> String? {
        let shown = items.map(\.id), all = model.items.map(\.id)
        let row = min(max(row, 0), shown.count)
        if let above = shown[row...].first(where: { $0 != itemID }) { return above }
        guard let last = shown.last(where: { $0 != itemID }), let index = all.firstIndex(of: last) else { return nil }
        return all[(index + 1)...].first { $0 != itemID }
    }

    /// Moves the card on the pasteboard above `row`. A drop in its own place
    /// writes nothing.
    @discardableResult
    func dropReorder(from pasteboard: NSPasteboard, row: Int) -> Bool {
        guard !model.busy, let id = draggedItemID(on: pasteboard) else { return false }
        model.move(itemID: id, before: destination(forDropAt: row, moving: id)) { [weak self] result in
            if case .success = result { self?.select(itemID: id) }
        }
        return true
    }

    /// Writes a row's drag to a pasteboard, as a drag would, for acceptance.
    func dragPasteboard(row: Int) -> NSPasteboard? {
        guard let writer = tableView(table, pasteboardWriterForRow: row) else { return nil }
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("drifting-library-drag-\(UUID().uuidString)"))
        pasteboard.clearContents()
        pasteboard.writeObjects([writer])
        return pasteboard
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        for row in 0..<items.count {
            (table.view(atColumn: 0, row: row, makeIfNecessary: false) as? MaterialCardView)?.isSelected = table.selectedRow == row
        }
        if QLPreviewPanel.sharedPreviewPanelExists(), QLPreviewPanel.shared().isVisible,
           QLPreviewPanel.shared().dataSource === self, let item = selectedItem, let url = item.fileURL {
            previewItems = [url]
            QLPreviewPanel.shared().reloadData()
        }
    }

    /// The card of an item; created if it is not on screen.
    func card(itemID: String) -> MaterialCardView? {
        guard let row = items.firstIndex(where: { $0.id == itemID }) else { return nil }
        return table.view(atColumn: 0, row: row, makeIfNecessary: true) as? MaterialCardView
    }

    private var selectedItem: WorkspaceMaterialItem? { items.indices.contains(table.selectedRow) ? items[table.selectedRow] : nil }

    func select(itemID: String) {
        guard let row = items.firstIndex(where: { $0.id == itemID }) else { return }
        table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        table.scrollRowToVisible(row)
    }

    // MARK: Drop

    func tableView(_ tableView: NSTableView, validateDrop info: NSDraggingInfo, proposedRow row: Int,
                   proposedDropOperation dropOperation: NSTableView.DropOperation) -> NSDragOperation {
        if draggedItemID(on: info.draggingPasteboard) != nil {
            guard !model.busy, model.loaded else { return [] }
            if dropOperation == .on { tableView.setDropRow(row, dropOperation: .above) }
            return .move
        }
        let urls = MaterialThumbnails.fileURLs(on: info.draggingPasteboard)
        guard !model.busy, model.loaded, urls.contains(where: { MaterialThumbnails.conforms($0, to: [.image, .pdf]) }) else { return [] }
        // The whole list is the target; imported items join the end.
        tableView.setDropRow(-1, dropOperation: .on)
        return .copy
    }

    func tableView(_ tableView: NSTableView, acceptDrop info: NSDraggingInfo, row: Int,
                   dropOperation: NSTableView.DropOperation) -> Bool {
        if draggedItemID(on: info.draggingPasteboard) != nil { return dropReorder(from: info.draggingPasteboard, row: row) }
        return importDropped(from: info.draggingPasteboard)
    }

    /// Imports the files on a pasteboard; files that are not images or PDFs
    /// are named in the status and nothing is written for them.
    @discardableResult
    func importDropped(from pasteboard: NSPasteboard) -> Bool {
        let urls = MaterialThumbnails.fileURLs(on: pasteboard)
        guard !urls.isEmpty, !model.busy else { return false }
        model.importFiles(urls) { [weak self] imported in
            if let last = imported.last { self?.select(itemID: last.id) }
        }
        return true
    }

    // MARK: Actions

    @objc func importFiles() {
        guard !model.busy else { return }
        let finish: ([URL]) -> Void = { [weak self] urls in
            guard let self, !urls.isEmpty else { return }
            self.model.importFiles(urls) { [weak self] imported in
                if let last = imported.last { self?.select(itemID: last.id) }
            }
        }
        if let chooseFiles { chooseFiles(finish); return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image, .pdf]
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.message = "选择要放进素材库的图片或 PDF，可以多选。文件会复制到本地素材库，原文件保持不变。"
        panel.prompt = "导入"
        if let window = view.window { panel.beginSheetModal(for: window) { if $0 == .OK { finish(panel.urls) } } }
        else if panel.runModal() == .OK { finish(panel.urls) }
    }

    @objc func addLink() {
        guard !model.busy else { return }
        let alert = NSAlert()
        alert.messageText = "添加链接"
        alert.informativeText = "输入以 http:// 或 https:// 开头的网址。标题可以留空，将使用网站名称。"
        let title = NSTextField(string: "")
        title.placeholderString = "标题（可留空）"
        title.setAccessibilityIdentifier("new-material-link-title")
        let url = NSTextField(string: "")
        url.placeholderString = "https://"
        url.setAccessibilityIdentifier("new-material-link-url")
        let fields = NSStackView(views: [title, url])
        fields.orientation = .vertical; fields.spacing = 8
        fields.frame = NSRect(x: 0, y: 0, width: 300, height: 56)
        for field in [title, url] { field.widthAnchor.constraint(equalToConstant: 300).isActive = true }
        alert.accessoryView = fields
        alert.addButton(withTitle: "添加").setAccessibilityIdentifier("confirm-new-material-link")
        alert.addButton(withTitle: "取消")
        present(alert) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self else { return }
            self.model.createLink(title: title.stringValue, url: url.stringValue) { [weak self] result in
                if case .success(let item) = result { self?.select(itemID: item.id) }
            }
        }
        alert.window.makeFirstResponder(url)
    }

    /// 新建笔记: the edit sheet with an empty title and body.
    @objc func createNote() {
        guard !model.busy, editSheet == nil else { return }
        beginSheet(MaterialEditSheet(item: nil), focus: .body)
    }

    /// Double-click or Return: Quick Look for files, the browser for links
    /// and the edit sheet for notes.
    @objc private func previewClicked() {
        guard items.indices.contains(table.clickedRow) else { return }
        preview(items[table.clickedRow])
    }

    private func previewSelected() { if let item = selectedItem { preview(item) } }

    func preview(_ item: WorkspaceMaterialItem) {
        switch item.kind {
        case "image", "pdf":
            guard let url = item.fileURL, FileManager.default.fileExists(atPath: url.path) else {
                model.showStatus("找不到“\(item.title)”的本地文件，请重新导入。"); return
            }
            quickLook([url])
        case "url":
            guard let link = item.link, ["http", "https"].contains(link.scheme?.lowercased() ?? "") else {
                model.showStatus("这个链接无法打开。"); return
            }
            if let openURL { openURL(link) } else { NSWorkspace.shared.open(link) }
            model.showStatus("已在浏览器中打开“\(item.title)”。")
        default:
            edit(item, focus: .body)
        }
    }

    private func toggleQuickLook() {
        if QLPreviewPanel.sharedPreviewPanelExists(), QLPreviewPanel.shared().isVisible {
            QLPreviewPanel.shared().orderOut(nil); return
        }
        guard let item = selectedItem else { return }
        if item.hasFile { preview(item) }
    }

    private func quickLook(_ urls: [URL]) {
        previewItems = urls
        if let onQuickLook { onQuickLook(urls); return }
        guard let panel = QLPreviewPanel.shared() else { return }
        view.window?.makeFirstResponder(table)
        if panel.isVisible, panel.dataSource === self { panel.reloadData() } else { panel.makeKeyAndOrderFront(nil) }
    }

    // MARK: Quick Look

    override func acceptsPreviewPanelControl(_ panel: QLPreviewPanel!) -> Bool { true }
    override func beginPreviewPanelControl(_ panel: QLPreviewPanel!) { panel.dataSource = self; panel.delegate = self }
    override func endPreviewPanelControl(_ panel: QLPreviewPanel!) { panel.dataSource = nil; panel.delegate = nil }
    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int { previewItems.count }
    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> QLPreviewItem! {
        previewItems.indices.contains(index) ? previewItems[index] as NSURL : nil
    }
    func previewPanel(_ panel: QLPreviewPanel!, handle event: NSEvent!) -> Bool {
        // Arrow keys move the list selection, which the preview follows.
        guard event.type == .keyDown, [125, 126].contains(event.keyCode) else { return false }
        table.keyDown(with: event)
        return true
    }

    // MARK: Context menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let row = table.clickedRow
        guard items.indices.contains(row) else { return }
        for item in menuItems(for: items[row]) { menu.addItem(item) }
    }

    /// The context actions of one card, also used by acceptance.
    func menuItems(for item: WorkspaceMaterialItem) -> [NSMenuItem] {
        var menu: [NSMenuItem] = []
        switch item.kind {
        case "image", "pdf":
            menu.append(LibraryMenuItem(title: "快速查看", identifier: "preview-material") { [weak self] in self?.preview(item) })
            menu.append(LibraryMenuItem(title: "用默认应用打开", identifier: "open-material-externally") { [weak self] in
                guard let url = item.fileURL else { return }
                if !NSWorkspace.shared.open(url) { self?.model.showStatus("无法打开“\(item.title)”。") }
            })
            menu.append(LibraryMenuItem(title: "在访达中显示", identifier: "reveal-material") {
                if let url = item.fileURL { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            })
        case "url":
            menu.append(LibraryMenuItem(title: "在浏览器中打开", identifier: "open-material-link") { [weak self] in self?.preview(item) })
            menu.append(LibraryMenuItem(title: "拷贝链接", identifier: "copy-material-link") { [weak self] in
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(item.externalUrl ?? "", forType: .string)
                self?.model.showStatus("链接已拷贝。")
            })
        default:
            menu.append(LibraryMenuItem(title: "编辑笔记…", identifier: "edit-material-note") { [weak self] in
                self?.edit(item, focus: .body)
            })
        }
        if let associations {
            menu.append(.separator())
            let associate = NSMenuItem(title: "关联", action: nil, keyEquivalent: "")
            associate.setAccessibilityIdentifier("associate-material")
            associate.submenu = AssociationMenu.make(candidates: associations.candidates(for: RelationEndpoint(kind: "library_item", id: item.id)),
                                                     prefix: "associate-material") { [weak self] target in self?.associate(item, with: target) }
            menu.append(associate)
            let existing = associationEntries(item)
            if !existing.isEmpty {
                let remove = NSMenuItem(title: "移除关联", action: nil, keyEquivalent: "")
                remove.setAccessibilityIdentifier("dissociate-material")
                let submenu = NSMenu(title: "移除关联")
                for entry in existing {
                    submenu.addItem(LibraryMenuItem(title: entry.label,
                        identifier: "dissociate-material-\(entry.target.kind)-\(entry.target.id)") { [weak self] in
                        self?.dissociate(item, from: entry.target)
                    })
                }
                remove.submenu = submenu
                menu.append(remove)
            }
        }
        menu.append(.separator())
        menu.append(LibraryMenuItem(title: "重命名…", identifier: "rename-material") { [weak self] in self?.rename(item) })
        menu.append(LibraryMenuItem(title: "编辑备注…", identifier: "edit-material-notes") { [weak self] in
            self?.edit(item, focus: .notes)
        })
        menu.append(.separator())
        menu.append(LibraryMenuItem(title: "删除…", identifier: "delete-material") { [weak self] in self?.confirmDelete(item) })
        for entry in menu { entry.isEnabled = !model.busy }
        return menu
    }

    private func rename(_ item: WorkspaceMaterialItem) {
        guard !model.busy else { model.showStatus("正在保存素材库，请稍后重试。"); return }
        let alert = NSAlert()
        alert.messageText = "重命名素材"
        alert.informativeText = "只更改标题，文件、链接和笔记内容保持不变。"
        let field = NSTextField(string: item.title)
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        field.placeholderString = "标题"
        field.setAccessibilityIdentifier("rename-material-title")
        alert.accessoryView = field
        alert.addButton(withTitle: "保存").setAccessibilityIdentifier("confirm-rename-material-title")
        alert.addButton(withTitle: "取消")
        present(alert) { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            self?.model.update(itemID: item.id, changes: WorkspaceMaterialChanges(title: field.stringValue), message: "标题已保存。")
        }
        alert.window.makeFirstResponder(field)
        field.selectText(nil)
    }

    private func confirmDelete(_ item: WorkspaceMaterialItem) {
        guard !model.busy else { model.showStatus("正在保存素材库，请稍后重试。"); return }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "删除素材“\(item.title)”？"
        alert.informativeText = item.hasFile
            ? "素材和复制到本地素材库的文件会一起删除，无法恢复。你电脑上的原文件不受影响。"
            : "删除后无法恢复。"
        alert.addButton(withTitle: "删除").setAccessibilityIdentifier("confirm-delete-material")
        alert.addButton(withTitle: "取消")
        present(alert) { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            if self?.previewItems.contains(where: { $0.path == item.assetPath }) == true {
                if QLPreviewPanel.sharedPreviewPanelExists(), QLPreviewPanel.shared().isVisible { QLPreviewPanel.shared().orderOut(nil) }
                self?.previewItems = []
            }
            let associated = self?.associationEntries(item).isEmpty == false
            self?.model.delete(itemID: item.id) { [weak self] result in
                // Rust purged its 关联 with it; the relation library is read again.
                if case .success = result, associated { self?.associations?.relations.load() }
            }
        }
    }

    // MARK: Edit sheet

    func edit(_ item: WorkspaceMaterialItem, focus: MaterialEditSheet.Focus) {
        guard !model.busy else { model.showStatus("正在保存素材库，请稍后重试。"); return }
        guard editSheet == nil else { return }
        beginSheet(MaterialEditSheet(item: item), focus: focus)
    }

    private func beginSheet(_ sheet: MaterialEditSheet, focus: MaterialEditSheet.Focus) {
        editSheet = sheet
        sheet.onCancel = { [weak self] in self?.endEditSheet() }
        sheet.onSave = { [weak self, weak sheet] title, body, notes in
            guard let self, let sheet else { return }
            sheet.showError(nil)
            sheet.setSaving(true)
            let done: (Result<WorkspaceMaterialItem, Error>) -> Void = { [weak self, weak sheet] result in
                sheet?.setSaving(false)
                switch result {
                case .success(let item): self?.endEditSheet(); self?.select(itemID: item.id)
                // The typed text stays in the sheet for another try.
                case .failure(let error): sheet?.showError(error.localizedDescription)
                }
            }
            if let item = sheet.item {
                self.model.update(itemID: item.id, changes: WorkspaceMaterialChanges(title: title, notes: notes, body: body),
                                  completion: done)
            } else {
                self.model.createText(title: title, body: body ?? "") { [weak self] result in
                    guard case .success(let created) = result, !notes.isEmpty, let self else { done(result); return }
                    self.model.update(itemID: created.id, changes: WorkspaceMaterialChanges(notes: notes), message: "笔记已保存。",
                                      completion: done)
                }
            }
        }
        if let window = view.window { window.beginSheet(sheet.window) }
        sheet.focus(focus)
    }

    private func endEditSheet() {
        guard let sheet = editSheet else { return }
        editSheet = nil
        if let parent = sheet.window.sheetParent { parent.endSheet(sheet.window) } else { sheet.window.orderOut(nil) }
    }

    private func present(_ alert: NSAlert, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        if let presentAlert { presentAlert(alert, completion) }
        else if let window = view.window { alert.beginSheetModal(for: window, completionHandler: completion) }
    }

    override func viewDidDisappear() {
        super.viewDidDisappear()
        endEditSheet()
        if QLPreviewPanel.sharedPreviewPanelExists(), QLPreviewPanel.shared().dataSource === self {
            QLPreviewPanel.shared().orderOut(nil)
        }
    }

    @objc private func closeLibrary() { endEditSheet(); onClose?() }
}

/// Space previews, Return opens and Delete asks to delete the selected card.
final class MaterialTableView: NSTableView {
    var onSpace: (() -> Void)?
    var onReturn: (() -> Void)?
    var onDelete: (() -> Void)?
    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 49: onSpace?()
        case 36, 76: onReturn?()
        case 51, 117: onDelete?()
        default: super.keyDown(with: event)
        }
    }
}

/// One 素材 card on a soft wash: its preview well, title, a detail line
/// (image size, PDF, the link's host or a note's first lines) and notes.
final class MaterialCardView: NSView {
    static let wellSide: CGFloat = 64
    /// Extra height of a card showing 关联 chips.
    static let chipsHeight: CGFloat = 26
    let well = MaterialPreviewWell()
    let titleLabel = NSTextField(labelWithString: "")
    let detailLabel = NSTextField(wrappingLabelWithString: "")
    let notesLabel = NSTextField(labelWithString: "")
    let chips = AssociationChipsView(prefix: "material-association")
    private(set) var item: WorkspaceMaterialItem?
    var isSelected = false { didSet { needsDisplay = true } }
    /// True once an image or PDF preview replaced the placeholder.
    var thumbnailLoaded: Bool { item?.assetPath != nil && well.loadedPath == item?.assetPath }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        titleLabel.lineBreakMode = .byTruncatingTail
        detailLabel.font = .systemFont(ofSize: 11)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.maximumNumberOfLines = 2
        detailLabel.lineBreakMode = .byTruncatingTail
        notesLabel.font = .systemFont(ofSize: 11)
        notesLabel.textColor = .tertiaryLabelColor
        notesLabel.lineBreakMode = .byTruncatingTail
        for label in [titleLabel, detailLabel, notesLabel] {
            label.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        }
        let text = NSStackView(views: [titleLabel, detailLabel, notesLabel])
        text.orientation = .vertical; text.alignment = .leading; text.spacing = 2
        text.detachesHiddenViews = true
        let row = NSStackView(views: [well, text])
        row.alignment = .centerY; row.spacing = 12
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        chips.translatesAutoresizingMaskIntoConstraints = false
        chips.isHidden = true
        addSubview(chips)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            row.topAnchor.constraint(equalTo: topAnchor, constant: (MacMaterialLibraryViewController.cardHeight - Self.wellSide) / 2),
            well.widthAnchor.constraint(equalToConstant: Self.wellSide),
            well.heightAnchor.constraint(equalToConstant: Self.wellSide),
            text.trailingAnchor.constraint(equalTo: row.trailingAnchor),
            chips.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10 + Self.wellSide + 12),
            chips.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -10),
            chips.topAnchor.constraint(equalTo: row.bottomAnchor, constant: 4),
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var wantsUpdateLayer: Bool { true }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    override func updateLayer() {
        layer?.cornerRadius = 8
        layer?.backgroundColor = (isSelected ? NSColor.labAccent.withAlphaComponent(0.14)
            : NSColor.secondaryLabelColor.withAlphaComponent(0.05)).cgColor
    }

    static func kindName(_ kind: String) -> String {
        switch kind {
        case "image": return "图片"
        case "pdf": return "PDF"
        case "url": return "链接"
        default: return "笔记"
        }
    }

    /// The second line of a card.
    static func detail(of item: WorkspaceMaterialItem) -> String {
        let size = item.asset.map { ByteCountFormatter.string(fromByteCount: Int64($0.sizeBytes), countStyle: .file) }
        switch item.kind {
        case "image":
            let dimensions = item.asset.flatMap { asset in asset.width.flatMap { w in asset.height.map { "\(w) × \($0)" } } }
            return (["图片", dimensions, size] as [String?]).compactMap { $0 }.joined(separator: " · ")
        case "pdf":
            return (["PDF", size] as [String?]).compactMap { $0 }.joined(separator: " · ")
        case "url":
            guard let address = item.externalUrl else { return "链接" }
            let host = URLComponents(string: address)?.host ?? address
            // A title that already names the host shows the address instead.
            guard item.title == host else { return host }
            return address.replacingOccurrences(of: #"^https?://"#, with: "", options: .regularExpression)
        default:
            let lines = item.text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            return lines.isEmpty ? "空白笔记" : lines.prefix(2).joined(separator: "\n")
        }
    }

    func show(_ item: WorkspaceMaterialItem, selected: Bool) {
        self.item = item
        isSelected = selected
        setAccessibilityIdentifier("material-card-\(item.id)")
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("\(Self.kindName(item.kind))：\(item.title)")
        titleLabel.stringValue = item.title.isEmpty ? "未命名" : item.title
        titleLabel.setAccessibilityIdentifier("material-title-\(item.id)")
        detailLabel.stringValue = Self.detail(of: item)
        detailLabel.setAccessibilityIdentifier("material-detail-\(item.id)")
        let notes = item.notes.split(separator: "\n").joined(separator: " ")
        notesLabel.stringValue = notes.isEmpty ? "" : "备注：\(notes)"
        notesLabel.isHidden = notes.isEmpty
        notesLabel.setAccessibilityIdentifier("material-notes-\(item.id)")
        well.setAccessibilityIdentifier("material-preview-\(item.id)")
        toolTip = item.kind == "url" ? item.externalUrl : nil
        switch item.kind {
        case "image", "pdf":
            if let path = item.assetPath {
                well.showFile(path: path, kind: item.kind, side: Self.wellSide,
                              placeholderSymbol: item.kind == "pdf" ? "doc.richtext" : "photo")
            } else { well.showPlaceholder(symbol: "questionmark.square.dashed") }
        case "url": well.showPlaceholder(symbol: "link")
        default: well.showPlaceholder(symbol: "note.text")
        }
    }
}

/// 编辑 or 新建笔记: 标题, a text note's 正文 and 备注. A refusal keeps the
/// typed text; unchanged fields write nothing.
final class MaterialEditSheet: NSObject {
    enum Focus { case title, body, notes }
    /// Nil for a new note.
    let item: WorkspaceMaterialItem?
    let window: NSWindow
    let titleField = NSTextField()
    let bodyView: NSTextView
    let notesView: NSTextView
    let saveButton = NSButton(title: "保存", target: nil, action: nil)
    let cancelButton = NSButton(title: "取消", target: nil, action: nil)
    private let message = NSTextField(wrappingLabelWithString: "")
    private let bodyScroll = NSTextView.scrollableTextView()
    private let notesScroll = NSTextView.scrollableTextView()
    /// Title, body (text notes only) and notes exactly as typed.
    var onSave: ((String, String?, String) -> Void)?
    var onCancel: (() -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }
    var hasBody: Bool { item == nil || item?.kind == "text" }

    init(item: WorkspaceMaterialItem?) {
        self.item = item
        bodyView = bodyScroll.documentView as! NSTextView
        notesView = notesScroll.documentView as! NSTextView
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 360), styleMask: [.titled],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        super.init()
        window.title = item == nil ? "新建笔记" : "编辑素材"
        let heading = NSTextField(labelWithString: item == nil ? "新建笔记"
            : "编辑\(MaterialCardView.kindName(item!.kind))“\(item!.title)”")
        heading.font = .systemFont(ofSize: 15, weight: .semibold)
        heading.lineBreakMode = .byTruncatingTail
        titleField.stringValue = item?.title ?? ""
        titleField.placeholderString = item == nil ? "标题（可留空，将使用第一行）" : "标题"
        titleField.setAccessibilityIdentifier("material-edit-title")
        for (view, text, id) in [(bodyView, item?.text ?? "", "material-edit-body"), (notesView, item?.notes ?? "", "material-edit-notes")] {
            view.isRichText = false
            view.allowsUndo = true
            view.font = .systemFont(ofSize: 13)
            view.textContainerInset = NSSize(width: 2, height: 4)
            view.string = text
            view.setAccessibilityIdentifier(id)
        }
        for scroll in [bodyScroll, notesScroll] { scroll.borderType = .bezelBorder }
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("material-edit-error")
        saveButton.target = self; saveButton.action = #selector(save)
        saveButton.keyEquivalent = "\r"; saveButton.keyEquivalentModifierMask = .command
        saveButton.setAccessibilityIdentifier("save-material")
        saveButton.toolTip = "⌘↩"
        cancelButton.target = self; cancelButton.action = #selector(cancel)
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.setAccessibilityIdentifier("cancel-material")
        var rows: [[NSView]] = [[label("标题"), titleField]]
        if hasBody { rows.append([label("正文"), bodyScroll]) }
        rows.append([label("备注"), notesScroll])
        let grid = NSGridView(views: rows)
        grid.rowSpacing = 10; grid.columnSpacing = 10
        grid.column(at: 0).xPlacement = .trailing
        grid.row(at: 0).rowAlignment = .firstBaseline
        for index in 1..<grid.numberOfRows { grid.row(at: index).yPlacement = .top }
        let buttons = NSStackView(views: [NSView(), cancelButton, saveButton])
        let stack = NSStackView(views: [heading, grid, message, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            content.widthAnchor.constraint(equalToConstant: 460),
            heading.widthAnchor.constraint(equalTo: stack.widthAnchor),
            grid.widthAnchor.constraint(equalTo: stack.widthAnchor),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
            bodyScroll.heightAnchor.constraint(equalToConstant: 150),
            notesScroll.heightAnchor.constraint(equalToConstant: hasBody ? 64 : 110),
        ])
        content.layoutSubtreeIfNeeded()
        window.setContentSize(content.fittingSize)
    }

    private func label(_ text: String) -> NSTextField {
        let value = NSTextField(labelWithString: text)
        value.textColor = .secondaryLabelColor
        return value
    }

    func focus(_ focus: Focus) {
        switch focus {
        case .title: window.makeFirstResponder(titleField)
        case .body: window.makeFirstResponder(hasBody ? bodyView : notesView)
        case .notes: window.makeFirstResponder(notesView)
        }
    }

    func showError(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    func setSaving(_ saving: Bool) {
        saveButton.isEnabled = !saving
        cancelButton.isEnabled = !saving
    }

    @objc func save() {
        let title = titleField.currentEditor()?.string ?? titleField.stringValue
        onSave?(title, hasBody ? bodyView.string : nil, notesView.string)
    }
    @objc func cancel() { onCancel?() }
}
