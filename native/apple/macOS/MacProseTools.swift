import AppKit

// MARK: Link addresses

/// What 链接… accepts before Rust checks it again: http, https and mailto
/// addresses without spaces or control characters, at most 2,048 bytes. A
/// bare domain means https and a bare e-mail address mailto.
enum ProseLinkAddress {
    static let maximumLength = 2048
    static let refusal = "链接地址需要以 http://、https:// 或 mailto: 开头，且不能包含空格。"

    /// The address to store, or why it is refused (in Chinese).
    static func normalized(_ typed: String) -> Result<String, LabError> {
        let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failure(.message("请输入链接地址。")) }
        var address = trimmed
        if !hasScheme(address) {
            address = address.contains("@") && !address.contains("/") ? "mailto:" + address : "https://" + address
        }
        let lower = address.lowercased()
        let allowed = ["http://", "https://", "mailto:"].contains { lower.hasPrefix($0) && lower.count > $0.count }
        let spaced = address.unicodeScalars.contains {
            CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0)
        }
        guard allowed, !spaced, address.utf8.count <= maximumLength else { return .failure(.message(refusal)) }
        return .success(address)
    }

    static func hasScheme(_ text: String) -> Bool {
        text.range(of: "^[A-Za-z][A-Za-z0-9+.-]*:", options: .regularExpression) != nil
    }

    /// Selected text that reads as an address prefills the sheet: a URL, a
    /// `www.` host or an e-mail address, without spaces.
    static func looksLikeAddress(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { return false }
        let lower = trimmed.lowercased()
        if ["http://", "https://", "mailto:", "www."].contains(where: { lower.hasPrefix($0) && lower.count > $0.count }) { return true }
        return trimmed.range(of: "^[^@/]+@[^@/]+\\.[^@/]+$", options: .regularExpression) != nil
    }

    /// A stored address the editor opens: http, https and mailto only.
    static func openable(_ href: String) -> URL? {
        guard let url = URL(string: href), let scheme = url.scheme?.lowercased(),
              ["http", "https", "mailto"].contains(scheme) else { return nil }
        return url
    }
}

// MARK: 链接… sheet

/// The address of the selection's URL link: prefilled from an existing link
/// or a selected address. 好 sets it, 移除链接 (when there is one) removes
/// it; a refusal keeps the typed address and shows why. Only success or 取消
/// dismisses the sheet.
final class MacLinkSheetController: NSViewController {
    private let initialAddress: String
    let hasLink: Bool
    private let quote: String
    private let field = NSTextField()
    private let message = NSTextField(wrappingLabelWithString: "")
    private let confirm = NSButton(title: "好", target: nil, action: nil)
    private let cancel = NSButton(title: "取消", target: nil, action: nil)
    private let remove = NSButton(title: "移除链接", target: nil, action: nil)
    private(set) var isSubmitting = false
    /// Receives the address (nil removes the link) and reports nil or the refusal.
    var onSubmit: ((String?, @escaping (Error?) -> Void) -> Void)?
    var onFinish: (() -> Void)?

    var address: String {
        get { _ = view; return field.stringValue }
        set { _ = view; field.stringValue = newValue }
    }
    var errorMessage: String { _ = view; return message.isHidden ? "" : message.stringValue }

    init(address: String, hasLink: Bool, quote: String) {
        initialAddress = address; self.hasLink = hasLink; self.quote = quote
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        view = NSView()
        let title = NSTextField(labelWithString: hasLink ? "编辑链接" : "添加链接")
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        let flat = quote.split(whereSeparator: \.isNewline).joined(separator: " ")
        let excerpt = NSTextField(labelWithString: "「\(flat.count > 40 ? String(flat.prefix(40)) + "…" : flat)」")
        excerpt.textColor = .secondaryLabelColor
        excerpt.lineBreakMode = .byTruncatingTail
        excerpt.setAccessibilityIdentifier("link-sheet-quote")
        let label = NSTextField(labelWithString: "地址：")
        field.stringValue = initialAddress
        field.placeholderString = "https://"
        field.setAccessibilityIdentifier("link-sheet-address")
        field.setAccessibilityLabel("链接地址")
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("link-sheet-error")
        confirm.target = self; confirm.action = #selector(submit)
        confirm.keyEquivalent = "\r"
        confirm.setAccessibilityIdentifier("link-sheet-confirm")
        cancel.target = self; cancel.action = #selector(cancelSheet)
        cancel.keyEquivalent = "\u{1b}"
        cancel.setAccessibilityIdentifier("link-sheet-cancel")
        remove.target = self; remove.action = #selector(removeLink)
        remove.isHidden = !hasLink
        remove.setAccessibilityIdentifier("link-sheet-remove")
        let row = NSStackView(views: [label, field])
        row.spacing = 6
        let buttons = NSStackView(views: [remove, NSView(), cancel, confirm])
        buttons.spacing = 8
        let stack = NSStackView(views: [title, excerpt, row, message, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -18),
            stack.widthAnchor.constraint(equalToConstant: 380),
            row.widthAnchor.constraint(equalTo: stack.widthAnchor),
            excerpt.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }

    func present(on window: NSWindow) {
        let sheet = NSWindow(contentViewController: self)
        sheet.styleMask = [.titled]
        window.beginSheet(sheet)
        sheet.makeFirstResponder(field)
    }

    @objc func submit() {
        guard !isSubmitting else { return }
        switch ProseLinkAddress.normalized(field.stringValue) {
        case .failure(let refusal): show(refusal.localizedDescription)
        case .success(let href):
            field.stringValue = href
            send(href)
        }
    }

    @objc func removeLink() {
        guard !isSubmitting, hasLink else { return }
        send(nil)
    }

    @objc func cancelSheet() {
        guard !isSubmitting else { return }
        finish()
    }

    private func send(_ href: String?) {
        guard let onSubmit else { return }
        isSubmitting = true; updateButtons(); show(nil)
        onSubmit(href) { [weak self] error in
            guard let self else { return }
            self.isSubmitting = false; self.updateButtons()
            if let error { self.show(error.localizedDescription) } else { self.finish() }
        }
    }

    private func show(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }
    private func updateButtons() {
        confirm.isEnabled = !isSubmitting; cancel.isEnabled = !isSubmitting; remove.isEnabled = !isSubmitting
        field.isEditable = !isSubmitting
    }
    private func finish() {
        if let sheet = view.window, let parent = sheet.sheetParent { parent.endSheet(sheet) }
        onFinish?()
    }
}

// MARK: Find

/// The prose as `NSTextFinder`'s client: the find bar, incremental search,
/// ⌘G, ⇧⌘G and ⌘E. It reports itself read-only so the bar offers no 替换:
/// a replacement from the bar would not pass through the binding's input
/// path, and 全部替换 could not be one undo unit.
final class ProseFinderClient: NSObject, NSTextFinderClient {
    weak var textView: NSTextView?
    init(textView: NSTextView) { self.textView = textView }

    var string: String { textView?.string ?? "" }
    var isSelectable: Bool { true }
    var isEditable: Bool { false }
    var allowsMultipleSelection: Bool { false }
    var firstSelectedRange: NSRange { textView?.selectedRange() ?? NSRange(location: 0, length: 0) }
    var selectedRanges: [NSValue] {
        get { textView?.selectedRanges ?? [] }
        set { if let textView, !newValue.isEmpty { textView.selectedRanges = newValue } }
    }
    func scrollRangeToVisible(_ range: NSRange) { textView?.scrollRangeToVisible(range) }

    func contentView(at index: Int, effectiveCharacterRange outRange: NSRangePointer) -> NSView {
        outRange.pointee = NSRange(location: 0, length: (string as NSString).length)
        return textView ?? NSView()
    }

    func rects(forCharacterRange range: NSRange) -> [NSValue]? {
        guard let textView, let manager = textView.layoutManager, let container = textView.textContainer else { return nil }
        let glyphs = manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        let origin = textView.textContainerOrigin
        var rects: [NSValue] = []
        manager.enumerateEnclosingRects(forGlyphRange: glyphs, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0),
                                        in: container) { rect, _ in
            rects.append(NSValue(rect: rect.offsetBy(dx: origin.x, dy: origin.y)))
        }
        return rects
    }

    var visibleCharacterRanges: [NSValue] {
        guard let textView, let manager = textView.layoutManager, let container = textView.textContainer else { return [] }
        let origin = textView.textContainerOrigin
        let glyphs = manager.glyphRange(forBoundingRect: textView.visibleRect.offsetBy(dx: -origin.x, dy: -origin.y), in: container)
        return [NSValue(range: manager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil))]
    }

    func drawCharacters(in range: NSRange, forContentView view: NSView) {
        guard let textView, let manager = textView.layoutManager else { return }
        manager.drawGlyphs(forGlyphRange: manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil),
                           at: textView.textContainerOrigin)
    }
}

// MARK: Slash menu and @ picker

/// One row of the slash menu or the @ picker.
struct ProsePickerItem: Equatable {
    enum Action: Equatable {
        case format(NativeFormatAction)
        /// Inserts an element name or alias, or a chapter title, which the
        /// link pass then links.
        case mention(name: String, kind: EntityLinkTarget.Kind, id: String)
        /// ＋ 新建设定「name」 in a category, then inserts and links it.
        case createElement(name: String, categoryID: String)
    }
    let title: String
    let detail: String
    let action: Action
}

/// What the @ picker offers: live element names and aliases in library
/// order, then live chapter titles in book order, and the categories a new
/// element can go in.
struct ProseMentionSource: Equatable {
    struct Entry: Equatable {
        let name: String
        let kind: EntityLinkTarget.Kind
        let id: String
        let detail: String
    }
    struct Category: Equatable {
        let id: String
        let name: String
    }
    var entries: [Entry] = []
    var categories: [Category] = []
    /// Every name the link pass resolves in this body, whatever its target.
    var linkedNames: Set<String> = []

    static let empty = ProseMentionSource()

    init(entries: [Entry] = [], categories: [Category] = [], linkedNames: Set<String> = []) {
        self.entries = entries; self.categories = categories; self.linkedNames = linkedNames
    }

    /// Only a name the link pass resolves to the row's own target is offered.
    /// Its map holds every live element's name and aliases in library order,
    /// then chapter and drift titles, and the last target given a name wins;
    /// a body never links its own element, chapter or drift. So a name or
    /// alias a later element, a chapter or a drift also has is left out.
    init(library: WorkspaceElementLibrary?, chapters: [WorkspaceChapter], drifts: [WorkspaceDrift] = [],
         excludingElement: String? = nil, excludingNode: String? = nil) {
        let categoryNames = Dictionary((library?.categories ?? []).map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        var all: [Entry] = []
        for element in library?.elements ?? [] where element.id != excludingElement {
            let category = element.categoryId.flatMap { categoryNames[$0] }
            if !element.name.isEmpty {
                all.append(Entry(name: element.name, kind: .element, id: element.id, detail: category.map { "设定 · \($0)" } ?? "设定"))
            }
            for alias in element.aliases where !alias.isEmpty {
                all.append(Entry(name: alias, kind: .element, id: element.id, detail: "「\(element.name)」的别名"))
            }
        }
        for chapter in chapters where chapter.id != excludingNode && !chapter.title.isEmpty {
            all.append(Entry(name: chapter.title, kind: .chapter, id: chapter.id, detail: "章节"))
        }
        func target(_ kind: EntityLinkTarget.Kind, _ id: String) -> String { (kind == .element ? "element:" : "node:") + id }
        var resolved: [String: String] = [:]
        for entry in all { resolved[entry.name] = target(entry.kind, entry.id) }
        for drift in drifts where drift.id != excludingNode && !drift.title.isEmpty { resolved[drift.title] = target(.drift, drift.id) }
        var offered = Set<String>()
        entries = all.filter { resolved[$0.name] == target($0.kind, $0.id) && offered.insert($0.name).inserted }
        linkedNames = Set(resolved.keys)
        categories = (library?.categories ?? []).map { Category(id: $0.id, name: $0.name) }
    }
}

enum ProsePickerKind: Equatable { case slash, mention }

/// An open slash menu or @ picker: the trigger character's UTF-16 index,
/// the text typed after it and the rows it matches.
struct ProsePickerSession: Equatable {
    let kind: ProsePickerKind
    let trigger: Int
    let triggerCharacter: String
    var query: String
    var items: [ProsePickerItem]
    var selected: Int
    /// The author moved through these rows with ↑ or ↓: only then does
    /// Return choose a ＋ 新建设定 row.
    var navigated = false
    /// The trigger and the query, which choosing a row replaces.
    var range: NSRange { NSRange(location: trigger, length: 1 + (query as NSString).length) }
}

enum ProsePickers {
    /// “/” opens the slash menu at the start of an empty paragraph; the
    /// full-width ／ and 、 (what the / key types with the Pinyin input
    /// method) do too. “@” (or ＠) opens the picker anywhere except right
    /// after an ASCII letter or digit, as in an e-mail address.
    static let slashTriggers: Set<String> = ["/", "／", "、"]
    static let mentionTriggers: Set<String> = ["@", "＠"]
    static let maximumMentions = 30
    static let maximumQuery = 40
    /// Whitespace and sentence punctuation end a query and close the picker.
    static let queryEnds = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "，。！？；：、,.!?;:"))

    /// An ASCII letter or digit before “@” makes it part of an address.
    static func opensMention(after previous: unichar?) -> Bool {
        guard let previous, previous < 0x80, let scalar = Unicode.Scalar(previous) else { return true }
        return !CharacterSet.alphanumerics.contains(scalar)
    }

    private static let slash: [(NativeFormatAction, [String])] = [
        (.paragraph, ["paragraph", "body", "p"]), (.heading1, ["heading1", "h1"]), (.heading2, ["heading2", "h2"]),
        (.heading3, ["heading3", "h3"]), (.alignCenter, ["center"]), (.alignRight, ["right"]),
    ]

    /// 正文, 标题 1–3, 居中 and 右对齐 whose title contains the query, or
    /// whose keyword starts with it (h1, center …).
    static func slashItems(query: String) -> [ProsePickerItem] {
        let q = query.lowercased()
        return slash.filter { action, keywords in
            q.isEmpty || action.title.lowercased().contains(q) || keywords.contains { $0.hasPrefix(q) }
        }.map { ProsePickerItem(title: $0.0.title, detail: "", action: .format($0.0)) }
    }

    /// Names containing the query (ignoring case): exact matches, then
    /// prefixes, then the rest, elements before chapters, at most 30. None
    /// means no rows: ＋ 新建设定「…」 alone never keeps the picker open. After
    /// the names, a query no element is named or aliased and the link pass
    /// does not already resolve adds ＋ 新建设定「…」 for each category when
    /// `canCreate`.
    static func mentionItems(query: String, source: ProseMentionSource, canCreate: Bool) -> [ProsePickerItem] {
        let q = query.lowercased()
        func rank(_ entry: ProseMentionSource.Entry) -> Int? {
            let name = entry.name.lowercased()
            guard q.isEmpty || name.contains(q) else { return nil }
            let closeness = q.isEmpty ? 2 : (name == q ? 0 : (name.hasPrefix(q) ? 1 : 2))
            return closeness * 2 + (entry.kind == .element ? 0 : 1)
        }
        let ranked = source.entries.enumerated().compactMap { index, entry in rank(entry).map { (rank: $0, index: index, entry: entry) } }
            .sorted { ($0.rank, $0.index) < ($1.rank, $1.index) }
        var items = ranked.prefix(maximumMentions).map {
            ProsePickerItem(title: $0.entry.name, detail: $0.entry.detail,
                            action: .mention(name: $0.entry.name, kind: $0.entry.kind, id: $0.entry.id))
        }
        guard !items.isEmpty else { return [] }
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let named = source.entries.contains { $0.kind == .element && $0.name.lowercased() == trimmed.lowercased() }
        if canCreate, !trimmed.isEmpty, !named, !source.linkedNames.contains(trimmed) {
            items += source.categories.map {
                ProsePickerItem(title: "＋ 新建设定「\(trimmed)」", detail: $0.name, action: .createElement(name: trimmed, categoryID: $0.id))
            }
        }
        return items
    }
}

/// The rows of an open picker, in a popover beside the trigger. The table
/// never takes the keyboard: the editor keeps its caret, and ↑, ↓, Return
/// and Esc reach the picker through the editor's key commands.
final class ProsePickerController: NSViewController, NSTableViewDataSource, NSTableViewDelegate {
    private let table = NSTableView()
    private(set) var items: [ProsePickerItem] = []
    private(set) var selected = 0
    var onChoose: ((Int) -> Void)?
    static let rowHeight: CGFloat = 24
    static let width: CGFloat = 260

    override func loadView() {
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("item"))
        column.width = Self.width - 12
        table.addTableColumn(column)
        table.headerView = nil
        table.rowHeight = Self.rowHeight
        table.refusesFirstResponder = true
        table.allowsEmptySelection = false
        table.dataSource = self; table.delegate = self
        table.target = self; table.action = #selector(clicked)
        table.setAccessibilityIdentifier("prose-picker")
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        view = scroll
    }

    func show(_ items: [ProsePickerItem], selected: Int) {
        _ = view
        self.items = items; self.selected = selected
        table.reloadData()
        if items.indices.contains(selected) {
            table.selectRowIndexes(IndexSet(integer: selected), byExtendingSelection: false)
            table.scrollRowToVisible(selected)
        }
        preferredContentSize = NSSize(width: Self.width, height: CGFloat(min(max(items.count, 1), 10)) * (Self.rowHeight + 2) + 8)
    }

    func numberOfRows(in tableView: NSTableView) -> Int { items.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let item = items[row]
        let title = NSTextField(labelWithString: item.title)
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let detail = NSTextField(labelWithString: item.detail)
        detail.textColor = .secondaryLabelColor
        detail.font = .systemFont(ofSize: 11)
        detail.lineBreakMode = .byTruncatingTail
        let stack = NSStackView(views: [title, NSView(), detail])
        stack.spacing = 6
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 6, bottom: 0, right: 6)
        stack.setAccessibilityIdentifier("prose-picker-row-\(row)")
        return stack
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        if table.selectedRow >= 0 { selected = table.selectedRow }
    }

    @objc private func clicked() {
        guard items.indices.contains(table.clickedRow) else { return }
        onChoose?(table.clickedRow)
    }
}
