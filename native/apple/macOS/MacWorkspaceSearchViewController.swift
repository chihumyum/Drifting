import AppKit

final class WorkspaceSearchPanel: NSPanel {
    var onClose: (() -> Void)?
    override func close() { super.close(); onClose?() }
}

/// 项目搜索 (⇧⌘F): one query field over the project. Chapter titles and prose
/// come first; with a global model, grouped sections follow for 章节摘要,
/// 漂流, 设定, 分类, 故事线 and 素材. Each row names the entity, the field and
/// a preview with the match emphasised. Unreadable bodies and truncation
/// are listed as rows of their own.
final class MacWorkspaceSearchViewController: NSViewController, NSSearchFieldDelegate, NSTableViewDataSource, NSTableViewDelegate {
    enum Row {
        case header(String)
        case chapterHit(WorkspaceSearchHit)
        case chapterUnavailable(WorkspaceSearchUnavailable)
        case entityHit(WorkspaceEntitySearchHit)
        case entityUnavailable(WorkspaceEntitySearchUnavailable)
        case truncated(String)

        var isSelectable: Bool {
            switch self {
            case .chapterHit, .entityHit: return true
            default: return false
            }
        }
    }

    let model: WorkspaceSearchModel
    var onNavigate: ((WorkspaceSearchHit) -> Void)?
    /// A global hit: its page opens as a tab (a body hit then selects its
    /// match), a material in the 素材库.
    var onOpenEntity: ((WorkspaceEntitySearchHit) -> Void)?
    var canNavigate: (() -> Bool)?
    var onClose: (() -> Void)?
    let query = NSSearchField()
    let table = NSTableView()
    let status = NSTextField(wrappingLabelWithString: "")
    private(set) var rows: [Row] = []

    init(model: WorkspaceSearchModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        view = NSView()
        query.placeholderString = model.includesEntities ? "搜索章节、摘要、漂流、设定、分类、故事线和素材" : "搜索章节标题和正文"
        query.setAccessibilityIdentifier("search-query")
        query.delegate = self
        query.target = self; query.action = #selector(search)
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("result")))
        table.headerView = nil
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

    private func reload() {
        status.stringValue = model.status
        rows = Self.rows(of: model)
        table.reloadData()
    }

    /// Chapter titles and prose, then one section per entity kind that has
    /// hits or unreadable bodies, then the truncation notice.
    static func rows(of model: WorkspaceSearchModel) -> [Row] {
        var rows: [Row] = []
        let showsSections = model.includesEntities
        if !model.hits.isEmpty || !model.unavailable.isEmpty {
            if showsSections { rows.append(.header("章节")) }
            rows += model.hits.map(Row.chapterHit) + model.unavailable.map(Row.chapterUnavailable)
        }
        for section in WorkspaceSearchText.sections {
            let hits = model.entityHits.filter { $0.kind == section.kind }
            let unreadable = model.entityUnavailable.filter { $0.kind == section.kind }
            guard !hits.isEmpty || !unreadable.isEmpty else { continue }
            rows.append(.header(section.title))
            rows += hits.map(Row.entityHit) + unreadable.map(Row.entityUnavailable)
        }
        if model.truncated || model.entityTruncated {
            rows.append(.truncated("结果已截断：章节和其他内容各最多列出 100 条。请缩小查询范围后再搜索。"))
        }
        return rows
    }

    /// The preview with every occurrence of the query emphasised.
    static func emphasised(_ preview: String, query: String) -> NSAttributedString {
        let text = NSMutableAttributedString(string: preview, attributes: [
            .font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor])
        for range in WorkspaceSearchText.matches(of: query, in: preview) {
            text.addAttributes([.font: NSFont.systemFont(ofSize: 12, weight: .semibold), .foregroundColor: NSColor.labelColor,
                                .backgroundColor: NSColor.findHighlightColor.withAlphaComponent(0.45)], range: range)
        }
        return text
    }

    private static func wrapping(_ text: NSAttributedString) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: "")
        label.attributedStringValue = text
        return label
    }

    /// Where a hit was found: “林岚 · 别名”.
    static func caption(_ hit: WorkspaceEntitySearchHit) -> String {
        "\(hit.title.isEmpty ? "未命名" : hit.title) · \(WorkspaceSearchText.field(hit.field))"
    }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, isGroupRow row: Int) -> Bool {
        if case .header = rows[row] { return true }
        return false
    }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        switch rows[row] {
        case .header: return 24
        case .truncated: return 40
        default: return 50
        }
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let label: NSTextField
        switch rows[row] {
        case .header(let title):
            label = NSTextField(labelWithString: title)
            label.font = .systemFont(ofSize: 12, weight: .semibold)
            label.setAccessibilityIdentifier("search-section-\(title)")
            return label
        case .chapterHit(let hit):
            let text = NSMutableAttributedString(string: hit.chapterTitle + "\n", attributes: [.font: NSFont.systemFont(ofSize: 13)])
            text.append(hit.kind == "title"
                ? NSAttributedString(string: "章节标题", attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor])
                : Self.emphasised(hit.preview, query: model.query))
            label = Self.wrapping(text)
            label.setAccessibilityLabel("\(hit.chapterTitle) · \(hit.preview)")
            label.setAccessibilityIdentifier("search-result-\(row)")
        case .chapterUnavailable(let unavailable):
            label = NSTextField(wrappingLabelWithString: "暂不可用 · \(unavailable.chapterTitle)\n\(unavailable.message)")
            label.textColor = .secondaryLabelColor
        case .entityHit(let hit):
            let text = NSMutableAttributedString(string: Self.caption(hit) + "\n", attributes: [.font: NSFont.systemFont(ofSize: 13)])
            text.append(Self.emphasised(hit.preview, query: model.query))
            label = Self.wrapping(text)
            label.setAccessibilityLabel("\(Self.caption(hit)) · \(hit.preview)")
            label.setAccessibilityIdentifier("search-entity-\(hit.kind)-\(row)")
        case .entityUnavailable(let unavailable):
            label = NSTextField(wrappingLabelWithString: "暂不可读取 · \(unavailable.title) · 正文\n\(unavailable.message)")
            label.textColor = .secondaryLabelColor
            label.setAccessibilityIdentifier("search-unavailable-\(unavailable.kind)-\(row)")
        case .truncated(let notice):
            label = NSTextField(wrappingLabelWithString: notice)
            label.textColor = .secondaryLabelColor
            label.setAccessibilityIdentifier("search-truncated")
        }
        label.maximumNumberOfLines = 3
        label.lineBreakMode = .byTruncatingTail
        return label
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        rows.indices.contains(row) && rows[row].isSelectable && !model.busy && canNavigate?() == true
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard rows.indices.contains(table.selectedRow), !model.busy else { return }
        let row = rows[table.selectedRow]
        table.deselectAll(nil)
        guard row.isSelectable, canNavigate?() == true else { return }
        switch row {
        case .chapterHit(let hit): onNavigate?(hit)
        case .entityHit(let hit): onOpenEntity?(hit)
        default: break
        }
    }

    /// Chooses a row as a click does, under the same guards.
    func choose(row: Int) {
        guard tableView(table, shouldSelectRow: row) else { return }
        table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
    }
}
