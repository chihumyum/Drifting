import AppKit

final class ElementLibraryPanel: NSPanel {
    var onClose: (() -> Void)?
    override func close() { super.close(); onClose?() }
}

/// The 设定库: categories with their elements grouped by group name, and the
/// element trash. Opening and trashing go through the owner of the editor tabs.
final class MacElementLibraryViewController: NSViewController, NSTableViewDataSource, NSTableViewDelegate, NSMenuDelegate {
    /// A small palette; Rust validates the stored `#RRGGBB` value.
    static let palette: [(name: String, hex: String)] = [
        ("红", "#E5484D"), ("橙", "#F76B15"), ("黄", "#FFC53D"), ("绿", "#30A46C"),
        ("青", "#12A594"), ("蓝", "#0090FF"), ("紫", "#8E4EC6"), ("灰", "#8D8D8D"),
    ]

    let model: ElementLibraryModel
    var onOpen: ((WorkspaceElement) -> Void)?
    var onTrash: ((WorkspaceElement) -> Void)?
    var onCreated: ((WorkspaceElement) -> Void)?
    var canNavigate: (() -> Bool)?
    var onClose: (() -> Void)?
    private let table = NSTableView()
    private let status = NSTextField(wrappingLabelWithString: "")
    private let createCategoryButton = NSButton(title: "新建分类", target: nil, action: nil)
    private(set) var rows: [ElementLibraryModel.Row] = []

    init(model: ElementLibraryModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        view = NSView()
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("element")))
        table.headerView = nil
        table.rowHeight = 30
        table.usesAutomaticRowHeights = false
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.dataSource = self; table.delegate = self
        table.setAccessibilityIdentifier("element-library-list")
        let menu = NSMenu()
        menu.delegate = self
        table.menu = menu
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.documentView = table
        status.textColor = .secondaryLabelColor
        status.setAccessibilityIdentifier("element-library-status")
        createCategoryButton.target = self; createCategoryButton.action = #selector(createCategory)
        createCategoryButton.setAccessibilityIdentifier("create-element-category")
        let close = NSButton(title: "关闭设定库", target: self, action: #selector(closeLibrary))
        close.setAccessibilityIdentifier("close-element-library")
        let actions = NSStackView(views: [createCategoryButton, NSView(), close])
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
        createCategoryButton.isEnabled = !model.busy && model.loaded
        table.reloadData()
    }

    // MARK: Rows

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        switch rows[row] {
        case .category, .uncategorized, .trashHeader: return 34
        case .element(let element, _) where !element.summary.isEmpty: return 40
        default: return 26
        }
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let item = rows[row]
        let stack = NSStackView()
        stack.spacing = 8
        stack.setAccessibilityIdentifier(item.identifier)
        switch item {
        case .category(let category, let count):
            let swatch = NSImageView(image: ElementSwatch.image(for: category))
            swatch.setAccessibilityLabel("颜色 \(category.color)")
            let name = heading(category.name)
            let create = LibraryButton(title: "新建设定", identifier: "create-element-\(category.id)") { [weak self] in
                self?.createElement(in: category)
            }
            create.isEnabled = !model.busy
            stack.setViews([swatch, name, countLabel(count), NSView(), create], in: .leading)
        case .uncategorized(let count):
            stack.setViews([heading("未分类"), countLabel(count)], in: .leading)
        case .group(let name, _):
            let label = NSTextField(labelWithString: name)
            label.font = .systemFont(ofSize: 12, weight: .medium)
            label.textColor = .secondaryLabelColor
            stack.setViews([label], in: .leading)
            stack.edgeInsets = NSEdgeInsets(top: 0, left: 20, bottom: 0, right: 0)
        case .element(let element, let grouped):
            stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 1
            let name = NSTextField(labelWithString: element.name)
            name.lineBreakMode = .byTruncatingTail
            name.setAccessibilityLabel(element.name)
            stack.addArrangedSubview(name)
            if !element.summary.isEmpty {
                let summary = NSTextField(labelWithString: MacChapterCommentsViewController.flatten(element.summary))
                summary.font = .systemFont(ofSize: 11); summary.textColor = .secondaryLabelColor
                summary.lineBreakMode = .byTruncatingTail
                stack.addArrangedSubview(summary)
            }
            stack.edgeInsets = NSEdgeInsets(top: 0, left: grouped ? 32 : 20, bottom: 0, right: 4)
        case .empty:
            let label = NSTextField(labelWithString: "还没有设定")
            label.textColor = .tertiaryLabelColor
            stack.setViews([label], in: .leading)
            stack.edgeInsets = NSEdgeInsets(top: 0, left: 20, bottom: 0, right: 0)
        case .trashHeader(let count):
            stack.setViews([heading("回收站"), countLabel(count)], in: .leading)
        case .trashed(let element):
            let name = NSTextField(labelWithString: element.name)
            name.textColor = .secondaryLabelColor
            name.lineBreakMode = .byTruncatingTail
            let restore = LibraryButton(title: "恢复", identifier: "restore-element-\(element.id)") { [weak self] in
                self?.restore(element)
            }
            restore.isEnabled = !model.busy
            stack.setViews([name, NSView(), restore], in: .leading)
            stack.edgeInsets = NSEdgeInsets(top: 0, left: 20, bottom: 0, right: 4)
        }
        return stack
    }

    private func heading(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        label.lineBreakMode = .byTruncatingTail
        return label
    }
    private func countLabel(_ count: Int) -> NSTextField {
        let label = NSTextField(labelWithString: "\(count)")
        label.textColor = .tertiaryLabelColor
        return label
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        if case .element = rows[row] { return !model.busy && canNavigate?() == true }
        return false
    }
    func tableViewSelectionDidChange(_ notification: Notification) {
        guard rows.indices.contains(table.selectedRow), case .element(let element, _) = rows[table.selectedRow] else { return }
        table.deselectAll(nil)
        onOpen?(element)
    }

    // MARK: Context menus

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let row = table.clickedRow
        guard rows.indices.contains(row) else { return }
        for item in menuItems(for: rows[row]) { menu.addItem(item) }
    }

    /// The context actions of one row, also used by acceptance.
    func menuItems(for row: ElementLibraryModel.Row) -> [NSMenuItem] {
        switch row {
        case .category(let category, _):
            let rename = LibraryMenuItem(title: "重命名…", identifier: "rename-element-category") { [weak self] in
                self?.renameCategory(category)
            }
            let colors = NSMenuItem(title: "更改颜色", action: nil, keyEquivalent: "")
            let palette = NSMenu(title: "更改颜色")
            for entry in Self.palette {
                let item = LibraryMenuItem(title: entry.name, identifier: "element-category-color-\(entry.hex)") { [weak self] in
                    self?.model.recolorCategory(id: category.id, color: entry.hex)
                }
                item.image = ElementSwatch.image(color: ElementSwatch.color(hex: entry.hex))
                item.state = category.color.uppercased() == entry.hex ? .on : .off
                palette.addItem(item)
            }
            colors.submenu = palette
            let create = LibraryMenuItem(title: "新建设定", identifier: "create-element") { [weak self] in
                self?.createElement(in: category)
            }
            return [rename, colors, .separator(), create]
        case .element(let element, _):
            let open = LibraryMenuItem(title: "打开", identifier: "open-element") { [weak self] in self?.open(element) }
            let trash = LibraryMenuItem(title: "移到回收站", identifier: "trash-element") { [weak self] in
                guard let self, self.canChange() else { return }
                self.onTrash?(element)
            }
            return [open, .separator(), trash]
        case .trashed(let element):
            return [LibraryMenuItem(title: "恢复", identifier: "restore-element") { [weak self] in self?.restore(element) }]
        default:
            return []
        }
    }

    private func canChange() -> Bool {
        guard !model.busy, canNavigate?() == true else {
            model.showStatus("请先完成输入，并等待正文保存后再修改设定库。"); return false
        }
        return true
    }

    private func open(_ element: WorkspaceElement) {
        guard canChange() else { return }
        onOpen?(element)
    }

    private func restore(_ element: WorkspaceElement) {
        guard canChange() else { return }
        model.restore(elementID: element.id)
    }

    private func createElement(in category: WorkspaceElementCategory) {
        guard canChange() else { return }
        model.createElement(categoryID: category.id) { [weak self] result in
            if case .success(let element) = result { self?.onCreated?(element) }
        }
    }

    @objc private func createCategory() {
        guard !model.busy else { return }
        askName(title: "新建分类", detail: "例如“人物”“地点”或“势力”。留空将使用默认名称。", current: "",
                identifier: "new-element-category-name", confirm: "创建") { [weak self] name in
            self?.model.createCategory(name: name)
        }
    }

    private func renameCategory(_ category: WorkspaceElementCategory) {
        guard !model.busy else { return }
        askName(title: "重命名分类", detail: "只更改分类名称，其中的设定保持不变。", current: category.name,
                identifier: "rename-element-category-name", confirm: "保存") { [weak self] name in
            guard !name.isEmpty else { self?.model.showStatus("分类名称不能为空，请重新输入。"); return }
            self?.model.renameCategory(id: category.id, name: name)
        }
    }

    private func askName(title: String, detail: String, current: String, identifier: String, confirm: String,
                         completion: @escaping (String) -> Void) {
        guard let window = view.window else { return }
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        let field = NSTextField(string: current)
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        field.placeholderString = "分类名称"
        field.setAccessibilityIdentifier(identifier)
        alert.accessoryView = field
        alert.addButton(withTitle: confirm).setAccessibilityIdentifier("confirm-\(identifier)")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { response in
            guard response == .alertFirstButtonReturn else { return }
            completion(field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        alert.window.makeFirstResponder(field)
        field.selectText(nil)
    }

    @objc private func closeLibrary() { onClose?() }
}

private final class LibraryButton: NSButton {
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

final class LibraryMenuItem: NSMenuItem {
    private let onPress: () -> Void
    init(title: String, identifier: String, onPress: @escaping () -> Void) {
        self.onPress = onPress
        super.init(title: title, action: #selector(press), keyEquivalent: "")
        target = self
        setAccessibilityIdentifier(identifier)
    }
    required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    @objc func press() { onPress() }
}
