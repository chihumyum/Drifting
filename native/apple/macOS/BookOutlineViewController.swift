import AppKit

final class BookOutlinePanel: NSPanel {
    var onClose: (() -> Void)?
    override func close() { super.close(); onClose?() }
}

final class BookOutlineViewController: NSViewController, NSTableViewDataSource, NSTableViewDelegate {
    let model: WorkspaceOutlineModel
    var onNavigate: ((WorkspaceOutlineEntry, String?) -> Void)?
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
        let item = rows[row]
        let label = NSTextField(labelWithString: item.label)
        label.lineBreakMode = .byTruncatingTail
        label.textColor = item.navigable ? .labelColor : .secondaryLabelColor
        label.font = .systemFont(ofSize: 14, weight: item.entry.kind == "act" ? .semibold : .regular)
        label.setAccessibilityIdentifier(item.identifier)
        label.setAccessibilityLabel(item.label)
        let stack = NSStackView(views: [label])
        stack.spacing = 6
        stack.edgeInsets = NSEdgeInsets(top: 0, left: CGFloat(item.depth) * 14, bottom: 0, right: 4)
        if item.isChapter {
            let expanded = model.expanded.contains(item.entry.id)
            let button = OutlineDisclosureButton(title: expanded ? "▾" : "▸")
            button.bezelStyle = .inline
            button.setAccessibilityIdentifier("outline-expand-\(item.entry.id)")
            button.setAccessibilityLabel("\(expanded ? "收起" : "展开") \(item.entry.title)")
            button.onPress = { [weak self] in self?.model.toggle(item.entry.id) }
            stack.addArrangedSubview(button)
        }
        return stack
    }
    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        rows[row].navigable && canNavigate?() == true
    }
    func tableViewSelectionDidChange(_ notification: Notification) {
        guard rows.indices.contains(table.selectedRow) else { return }
        let item = rows[table.selectedRow]
        table.deselectAll(nil)
        guard item.navigable, canNavigate?() == true else { return }
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
