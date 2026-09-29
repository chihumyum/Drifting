import AppKit

/// The fixed palette relation edges are drawn in on the 故事图谱 and the
/// 设定总览: system colours, one per slot of `RelationTypeLegend`, so a type
/// keeps its colour across launches and follows light and dark appearance.
enum RelationTypeColors {
    static let palette: [NSColor] = [.systemBlue, .systemOrange, .systemGreen, .systemPink, .systemPurple, .systemTeal,
                                     .systemRed, .systemBrown, .systemIndigo, .systemYellow, .systemMint, .systemCyan]

    /// A slot's colour; types beyond the palette cycle it, and a type
    /// without a slot (missing from the library) is neutral.
    static func color(slot: Int?) -> NSColor {
        guard let slot, slot >= 0 else { return .secondaryLabelColor }
        return palette[slot % palette.count]
    }

    /// A small rounded swatch in the slot's colour, drawn in the current
    /// appearance each time it is shown.
    static func swatch(slot: Int?) -> NSImage {
        let color = color(slot: slot)
        let image = NSImage(size: NSSize(width: 14, height: 10), flipped: false) { rect in
            color.setFill()
            NSBezierPath(roundedRect: rect.insetBy(dx: 1, dy: 1), xRadius: 2, yRadius: 2).fill()
            return true
        }
        image.accessibilityDescription = "关系颜色"
        return image
    }
}

/// 关系类型 in a canvas toolbar: a pull-down menu of the author's relation
/// types in legend order, each with its colour swatch, its name and how many
/// of its relations this canvas can draw, checked while its edges are shown.
/// Choosing a type hides or shows its edges; 全部显示 shows every type.
final class RelationFilterButton: NSPopUpButton {
    struct Entry: Equatable {
        let typeID: String
        let name: String
        let slot: Int
        let count: Int
        let hidden: Bool
    }

    var onToggle: ((String) -> Void)?
    var onShowAll: (() -> Void)?
    private(set) var entries: [Entry] = []

    init() {
        super.init(frame: .zero, pullsDown: true)
        setAccessibilityIdentifier("relation-filter")
        toolTip = "选择在画布上显示哪些关系类型的连线；颜色按关系类型区分"
        update([])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// The listed types; the title counts hidden ones.
    func update(_ entries: [Entry]) {
        self.entries = entries
        guard let menu else { return }
        menu.removeAllItems()
        let hidden = entries.filter(\.hidden).count
        menu.addItem(withTitle: hidden > 0 ? "关系类型 · 隐藏 \(hidden)" : "关系类型", action: nil, keyEquivalent: "")
        if entries.isEmpty {
            let empty = NSMenuItem(title: "还没有关系类型", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        }
        for entry in entries {
            let item = LibraryMenuItem(title: "\(entry.name) · \(entry.count)", identifier: "relation-filter-\(entry.typeID)") { [weak self] in
                self?.onToggle?(entry.typeID)
            }
            item.image = RelationTypeColors.swatch(slot: entry.slot)
            item.state = entry.hidden ? .off : .on
            item.toolTip = entry.hidden ? "显示“\(entry.name)”的连线" : "隐藏“\(entry.name)”的连线"
            menu.addItem(item)
        }
        if hidden > 0 {
            menu.addItem(.separator())
            menu.addItem(LibraryMenuItem(title: "全部显示", identifier: "relation-filter-show-all") { [weak self] in self?.onShowAll?() })
        }
        isEnabled = true
    }

    /// The menu item of a type, for acceptance.
    func item(typeID: String) -> LibraryMenuItem? {
        menu?.items.first { $0.accessibilityIdentifier() == "relation-filter-\(typeID)" } as? LibraryMenuItem
    }

    /// The legend entries of a library: author types in legend order with
    /// the counts this canvas can draw.
    static func entries(_ library: WorkspaceRelationLibrary, counts: [String: Int], hidden: Set<String>) -> [Entry] {
        RelationTypeLegend.ordered(library).enumerated().map { slot, type in
            Entry(typeID: type.id, name: type.displayName, slot: slot, count: counts[type.id] ?? 0, hidden: hidden.contains(type.id))
        }
    }
}

/// The small popover a card of the 故事图谱 or the 设定总览 opens: its title,
/// its status or category, the summary editable in place, an element's key
/// facts and 打开. The summary commits on Return, when the field ends
/// editing and when the popover closes, only when the author changed what
/// was shown: an element's as typed (as its page writes it), a chapter's
/// or drift's trimmed. Esc closes the popover. It is its own window above
/// the panel; a panel that is not on screen (acceptance) keeps it unshown.
/// Closing lets go of the popover, so neither keeps the other alive.
final class CanvasCardPopover: NSViewController, NSPopoverDelegate, NSTextViewDelegate {
    struct Content: Equatable {
        var title: String
        /// “章节 · § 03 · 草稿”, “漂流 · 漂浮中”, “设定 · 人物”.
        var detail: String
        var facts: [WorkspaceFact] = []
    }

    let endpoint: RelationEndpoint
    let popover = NSPopover()
    let titleLabel = NSTextField(wrappingLabelWithString: "")
    let detailLabel = NSTextField(labelWithString: "")
    let summaryView = NSTextView()
    let summaryScroll = NSScrollView()
    let factsLabel = NSTextField(wrappingLabelWithString: "")
    let messageLabel = NSTextField(wrappingLabelWithString: "")
    let openButton = NSButton(title: "打开", target: nil, action: nil)
    private(set) var content: Content
    /// The stored summary; nil until it has been read.
    private(set) var storedSummary: String?
    /// The summary on its way to Rust.
    private var sending: String?
    /// Summary writes sent, for acceptance.
    private(set) var writes = 0
    private(set) var isShown = false

    /// Writes a changed summary; reports the stored one.
    var onCommit: ((String, @escaping (Result<String, Error>) -> Void) -> Void)?
    var onOpen: (() -> Void)?
    var onClosed: (() -> Void)?

    static let maximumFacts = 6

    init(endpoint: RelationEndpoint, content: Content, summary: String?) {
        self.endpoint = endpoint
        self.content = content
        storedSummary = summary
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        let root = NSView()
        titleLabel.font = .systemFont(ofSize: 14, weight: .semibold)
        titleLabel.maximumNumberOfLines = 2
        titleLabel.setAccessibilityIdentifier("card-popover-title")
        detailLabel.font = .systemFont(ofSize: 11)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.setAccessibilityIdentifier("card-popover-detail")
        let summaryTitle = NSTextField(labelWithString: "摘要")
        summaryTitle.font = .systemFont(ofSize: 11)
        summaryTitle.textColor = .secondaryLabelColor
        summaryView.isRichText = false
        summaryView.allowsUndo = true
        summaryView.font = .systemFont(ofSize: 13)
        summaryView.isVerticallyResizable = true
        summaryView.autoresizingMask = [.width]
        summaryView.textContainer?.widthTracksTextView = true
        summaryView.textContainerInset = NSSize(width: 2, height: 4)
        summaryView.delegate = self
        summaryView.setAccessibilityIdentifier("card-popover-summary")
        summaryView.setAccessibilityLabel("摘要")
        summaryView.toolTip = "一两句话概括；回车保存，⌥回车换行，Esc 关闭"
        summaryScroll.hasVerticalScroller = true
        summaryScroll.borderType = .bezelBorder
        summaryScroll.documentView = summaryView
        factsLabel.font = .systemFont(ofSize: 12)
        factsLabel.setAccessibilityIdentifier("card-popover-facts")
        messageLabel.font = .systemFont(ofSize: 11)
        messageLabel.textColor = .secondaryLabelColor
        messageLabel.setAccessibilityIdentifier("card-popover-message")
        openButton.target = self; openButton.action = #selector(openPage)
        openButton.bezelStyle = .rounded
        openButton.setAccessibilityIdentifier("card-popover-open")
        openButton.toolTip = "打开这一页"
        let buttons = NSStackView(views: [NSView(), openButton])
        let stack = NSStackView(views: [titleLabel, detailLabel, summaryTitle, summaryScroll, factsLabel, messageLabel, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 6
        stack.setCustomSpacing(10, after: detailLabel)
        stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -12),
            root.widthAnchor.constraint(equalToConstant: 300),
            summaryScroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            summaryScroll.heightAnchor.constraint(equalToConstant: 72),
            titleLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
            factsLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
            messageLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        view = root
        showContent()
        showSummary()
    }

    // MARK: Showing

    /// Shows the popover below a rectangle of a view; a view not on screen
    /// keeps it unshown (the content is still built).
    func show(relativeTo rect: NSRect, of view: NSView) {
        loadViewIfNeeded()
        popover.contentViewController = self
        popover.behavior = .transient
        popover.animates = false
        popover.delegate = self
        isShown = true
        if view.window?.isVisible == true {
            popover.show(relativeTo: rect, of: view, preferredEdge: .maxY)
        }
    }

    /// New stored values from elsewhere; a summary being edited keeps its text.
    func update(content: Content, summary: String?) {
        self.content = content
        let clean = storedSummary.map { summaryView.string == $0 } ?? true
        storedSummary = summary
        guard isViewLoaded else { return }
        showContent()
        if clean || summaryView.isEditable == false { showSummary() }
    }

    /// The stored summary once it has been read.
    func adopt(summary: String) { update(content: content, summary: summary) }

    func showMessage(_ text: String?, error: Bool = false) {
        messageLabel.stringValue = text ?? ""
        messageLabel.isHidden = text == nil
        messageLabel.textColor = error ? .systemRed : .secondaryLabelColor
    }

    private func showContent() {
        titleLabel.stringValue = content.title
        detailLabel.stringValue = content.detail
        let facts = content.facts.filter { !ElementText.trimmed($0.key).isEmpty || !ElementText.trimmed($0.value).isEmpty }
        var lines = facts.prefix(Self.maximumFacts).map { fact in
            ElementText.trimmed(fact.key).isEmpty ? fact.value : "\(fact.key)：\(fact.value)"
        }
        if facts.count > Self.maximumFacts { lines.append("另有 \(facts.count - Self.maximumFacts) 项，在设定页查看") }
        factsLabel.stringValue = lines.joined(separator: "\n")
        factsLabel.isHidden = lines.isEmpty
    }

    private func showSummary() {
        if let storedSummary {
            if summaryView.string != storedSummary { summaryView.string = storedSummary }
            summaryView.isEditable = true
            if messageLabel.stringValue == "正在读取摘要…" { showMessage(nil) }
        } else {
            summaryView.isEditable = false
            showMessage("正在读取摘要…")
        }
    }

    // MARK: Commit and close

    /// Sends a summary the author changed from the one shown: an element's
    /// as typed, a chapter's or drift's trimmed (a change of spacing alone
    /// writes nothing). The one already on its way writes nothing.
    func commit() {
        guard let storedSummary, let onCommit else { return }
        let typed = summaryView.string
        let summary = endpoint.kind == "element" ? typed : ElementText.trimmed(typed)
        guard typed != storedSummary, summary != storedSummary, summary != sending else { return }
        sending = summary
        writes += 1
        onCommit(summary) { [self] result in
            sending = nil
            switch result {
            case .success(let stored):
                self.storedSummary = stored
                // Show the stored form unless the author typed on meanwhile.
                if summaryView.string == typed { summaryView.string = stored }
                showMessage("摘要已保存。")
            case .failure(let error):
                showMessage(error.localizedDescription, error: true)
            }
        }
    }

    /// Commits a changed summary and closes (Esc, a click elsewhere, 打开).
    func close() {
        commit()
        guard isShown else { return }
        isShown = false
        if popover.isShown { popover.performClose(nil) }
        release()
        onClosed?()
    }

    /// Closes without writing, e.g. when the card is gone.
    func dismiss() {
        guard isShown else { return }
        isShown = false
        popover.delegate = nil
        if popover.isShown { popover.close() }
        release()
        onClosed?()
    }

    /// The popover holds this controller as its content: let go, so both go.
    private func release() {
        guard !popover.isShown else { return }
        popover.contentViewController = nil
    }

    @objc func openPage() {
        let open = onOpen
        close()
        open?()
    }

    override func cancelOperation(_ sender: Any?) { close() }

    func popoverWillClose(_ notification: Notification) { commit() }

    func popoverDidClose(_ notification: Notification) {
        release()
        guard isShown else { return }
        isShown = false
        onClosed?()
    }

    // MARK: Summary field

    func textDidEndEditing(_ notification: Notification) { commit() }

    /// Return saves, ⌥Return adds a line, Esc closes.
    func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        switch commandSelector {
        case #selector(NSResponder.insertNewline(_:)): commit(); return true
        case #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)):
            textView.insertText("\n", replacementRange: textView.selectedRange()); return true
        case #selector(NSResponder.cancelOperation(_:)): close(); return true
        default: return false
        }
    }
}
