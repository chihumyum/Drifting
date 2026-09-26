import AppKit

final class WorkspaceSearchPanel: NSPanel {
    var onClose: (() -> Void)?
    override func close() { super.close(); onClose?() }
}

final class MacWorkspaceSearchViewController: NSViewController, NSSearchFieldDelegate, NSTableViewDataSource, NSTableViewDelegate {
    let model: WorkspaceSearchModel
    var onNavigate: ((WorkspaceSearchHit) -> Void)?
    var canNavigate: (() -> Bool)?
    var onClose: (() -> Void)?
    private let query = NSSearchField()
    private let table = NSTableView()
    private let status = NSTextField(wrappingLabelWithString: "")

    init(model: WorkspaceSearchModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        view = NSView()
        query.placeholderString = "搜索章节标题和正文"
        query.setAccessibilityIdentifier("search-query")
        query.delegate = self
        query.target = self; query.action = #selector(search)
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("result")))
        table.headerView = nil; table.rowHeight = 66
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.dataSource = self; table.delegate = self
        table.setAccessibilityIdentifier("search-results")
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.documentView = table
        status.textColor = .secondaryLabelColor
        status.setAccessibilityIdentifier("search-status")
        let close = NSButton(title: "关闭搜索", target: self, action: #selector(closeSearch))
        close.setAccessibilityIdentifier("close-search")
        let stack = NSStackView(views: [query, status, scroll, close])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -16),
            query.widthAnchor.constraint(equalTo: stack.widthAnchor),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        model.onChange = { [weak self] in self?.reload() }
        reload()
    }

    func focusQuery() { view.window?.makeFirstResponder(query) }
    func controlTextDidChange(_ notification: Notification) { model.search(query.stringValue) }
    @objc private func search() { model.search(query.stringValue) }
    @objc private func closeSearch() { onClose?() }
    private func reload() { status.stringValue = model.status; table.reloadData() }
    func numberOfRows(in tableView: NSTableView) -> Int { model.hits.count + model.unavailable.count }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let label: NSTextField
        if model.hits.indices.contains(row) {
            let hit = model.hits[row]
            label = NSTextField(wrappingLabelWithString: "\(hit.chapterTitle)\n\(hit.kind == "title" ? "章节标题" : hit.preview)")
            label.setAccessibilityLabel("\(hit.chapterTitle) · \(hit.preview)")
            label.setAccessibilityIdentifier("search-result-\(row)")
        } else {
            let unavailable = model.unavailable[row - model.hits.count]
            label = NSTextField(wrappingLabelWithString: "暂不可用 · \(unavailable.chapterTitle)\n\(unavailable.message)")
            label.textColor = .secondaryLabelColor
        }
        label.maximumNumberOfLines = 3
        label.lineBreakMode = .byTruncatingTail
        return label
    }
    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        model.hits.indices.contains(row) && !model.busy && canNavigate?() == true
    }
    func tableViewSelectionDidChange(_ notification: Notification) {
        guard model.hits.indices.contains(table.selectedRow), !model.busy else { return }
        let hit = model.hits[table.selectedRow]
        table.deselectAll(nil)
        guard canNavigate?() == true else { return }
        onNavigate?(hit)
    }
}
