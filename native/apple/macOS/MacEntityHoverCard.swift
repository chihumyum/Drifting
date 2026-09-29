import AppKit

/// What a link's 悬停卡片 shows. An element: name, category and group, up to
/// three aliases, the summary, the first facts, its portrait and the counts
/// of valid patches and of pages that link it. A chapter or drift: title,
/// writing status, words and summary. A trashed target only says so.
struct EntityHoverCardContent: Equatable {
    var kind: EntityLinkTarget.Kind
    var id: String
    var title: String
    /// Small secondary line: category and group, or kind, status and words.
    var meta: [String] = []
    var aliases: String?
    var summary: String = ""
    /// “键：值” for the first facts with text.
    var facts: [String] = []
    /// “补丁 2 · 被引用 3”; nil for chapters and drifts.
    var counts: String?
    /// The element's portrait in the asset store, read-only.
    var portraitPath: String?
    var trashed = false

    static let factLimit = 3

    /// The card from what the link directory already knows, e.g. before
    /// reads or for a trashed target.
    init(target: EntityLinkTarget) {
        kind = target.kind
        id = target.id
        title = target.name
        trashed = target.trashed
        switch target.kind {
        case .element:
            meta = [target.category ?? "未分类"]
            aliases = Self.aliases(target.aliases)
            summary = target.summary
        case .chapter: meta = ["章节"]
        case .drift: meta = ["漂流"]
        }
        if trashed { meta = ["已在回收站"]; aliases = nil; summary = "" }
    }

    /// “别名：甲、乙、丙 等 5 个”.
    static func aliases(_ list: [String]) -> String? {
        guard !list.isEmpty else { return nil }
        let shown = list.prefix(3).joined(separator: "、")
        return list.count > 3 ? "别名：\(shown) 等 \(list.count) 个" : "别名：\(shown)"
    }

    static func facts(_ list: [WorkspaceFact]) -> [String] {
        list.compactMap { fact -> String? in
            let key = fact.key.trimmingCharacters(in: .whitespacesAndNewlines)
            let value = fact.value.trimmingCharacters(in: .whitespacesAndNewlines)
            if key.isEmpty && value.isEmpty { return nil }
            return key.isEmpty || value.isEmpty ? key + value : "\(key)：\(value)"
        }.prefix(factLimit).map { $0 }
    }

    /// What an empty summary reads: an element's 简介, a chapter's or
    /// drift's 摘要 (the renderer's “暂无摘要”).
    var emptySummary: String { kind == .element ? "暂无简介" : "暂无摘要" }

    /// Every line in reading order, as the card shows it.
    var lines: [String] {
        var lines = [title]
        if !meta.isEmpty { lines.append(meta.joined(separator: " · ")) }
        if let aliases { lines.append(aliases) }
        let brief = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trashed { lines.append(brief.isEmpty ? emptySummary : brief) }
        lines += facts
        if let counts { lines.append(counts) }
        return lines
    }
}

/// The card's content view. It never takes the keyboard, so the editor
/// keeps its caret and selection; a click opens the target's page.
final class EntityHoverCardView: NSView {
    var onOpen: (() -> Void)?
    override var acceptsFirstResponder: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    /// Labels never take the click; the whole card is one target.
    override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) == nil ? nil : self }
    override func mouseDown(with event: NSEvent) { onOpen?() }
    override func resetCursorRects() { if onOpen != nil { addCursorRect(bounds, cursor: .pointingHand) } }
}

final class EntityHoverCardController: NSViewController {
    let content: EntityHoverCardContent
    let portrait = NSImageView()
    private(set) var labels: [NSTextField] = []
    var onOpen: (() -> Void)?
    /// “点击打开” under the card; a list row's preview (the row opens it) has none.
    var showsOpenHint = true

    init(content: EntityHoverCardContent) {
        self.content = content
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    static let portraitSide: CGFloat = 44
    static let width: CGFloat = 280

    override func loadView() {
        let card = EntityHoverCardView()
        card.onOpen = { [weak self] in self?.onOpen?() }
        card.setAccessibilityIdentifier("entity-link-preview")
        card.setAccessibilityRole(.button)
        card.setAccessibilityLabel(content.lines.joined(separator: "，"))
        let title = label(content.title, size: 13, weight: .semibold)
        var views: [NSView] = []
        if let path = content.portraitPath {
            portrait.imageScaling = .scaleProportionallyUpOrDown
            portrait.wantsLayer = true
            portrait.layer?.cornerRadius = 4
            portrait.layer?.masksToBounds = true
            portrait.setAccessibilityIdentifier("entity-link-preview-portrait")
            NSLayoutConstraint.activate([
                portrait.widthAnchor.constraint(equalToConstant: Self.portraitSide),
                portrait.heightAnchor.constraint(equalToConstant: Self.portraitSide),
            ])
            MaterialThumbnails.shared.load(path: path, kind: "image", side: Self.portraitSide) { [weak self] image in
                self?.portrait.image = image
            }
            let heading = NSStackView(views: [portrait, title])
            heading.alignment = .centerY; heading.spacing = 8
            views.append(heading)
        } else {
            views.append(title)
        }
        if !content.meta.isEmpty {
            views.append(label(content.meta.joined(separator: " · "), size: 11, color: .secondaryLabelColor))
        }
        if let aliases = content.aliases { views.append(label(aliases, size: 11, color: .secondaryLabelColor)) }
        if !content.trashed {
            let brief = content.summary.trimmingCharacters(in: .whitespacesAndNewlines)
            let summary = label(brief.isEmpty ? content.emptySummary : brief, size: 12, color: brief.isEmpty ? .tertiaryLabelColor : .labelColor)
            summary.maximumNumberOfLines = 5
            views.append(summary)
        }
        for fact in content.facts { views.append(label(fact, size: 11)) }
        if let counts = content.counts { views.append(label(counts, size: 11, color: .secondaryLabelColor)) }
        if !content.trashed, showsOpenHint { views.append(label("点击打开", size: 10, color: .tertiaryLabelColor)) }
        let stack = NSStackView(views: views)
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 4
        stack.edgeInsets = NSEdgeInsets(top: 10, left: 12, bottom: 10, right: 12)
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor), stack.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            stack.topAnchor.constraint(equalTo: card.topAnchor), stack.bottomAnchor.constraint(equalTo: card.bottomAnchor),
            card.widthAnchor.constraint(equalToConstant: Self.width),
        ])
        view = card
    }

    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = .labelColor) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = .systemFont(ofSize: size, weight: weight)
        field.textColor = color
        field.isSelectable = false
        field.maximumNumberOfLines = 3
        field.preferredMaxLayoutWidth = Self.width - 24
        field.refusesFirstResponder = true
        labels.append(field)
        return field
    }
}

/// A list's 悬停预览, like a tooltip: resting on a row for `delay` shows its
/// chapter's card (title, 写作状态, words and 摘要) in a popover beside the
/// row; another row, leaving the list, scrolling or a click closes it.
/// Reads only, and never takes the keyboard: the list keeps its selection.
final class TableHoverPreview: NSResponder, NSPopoverDelegate {
    /// A little longer than a link's 220 ms, so moving across a list does not
    /// flash cards.
    static var delay: TimeInterval = 0.5
    let table: NSTableView
    /// The row's target, or nil for a row without a preview.
    var target: ((Int) -> EntityLinkTarget?)?
    /// Reads the card, as link hover cards read it.
    var source: ((EntityLinkTarget, @escaping (EntityHoverCardContent) -> Void) -> Void)?
    /// The row whose card is waiting or shown.
    private(set) var hoveredRow: Int?
    private(set) var hoveredTarget: EntityLinkTarget?
    /// The card shown for `hoveredRow`; set even when the list is not on
    /// screen, where no popover can be shown.
    private(set) var content: EntityHoverCardContent?
    private(set) var controller: EntityHoverCardController?
    private let popover = NSPopover()
    private var timer: DispatchWorkItem?
    private var area: NSTrackingArea?
    /// The card is waiting for its delay or its read.
    var isPending: Bool { timer != nil || (hoveredTarget != nil && content == nil) }

    init(table: NSTableView) {
        self.table = table
        super.init()
        popover.behavior = .semitransient
        popover.animates = false
        popover.delegate = self
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
                                  owner: self, userInfo: nil)
        table.addTrackingArea(area)
        self.area = area
        if let clip = table.enclosingScrollView?.contentView {
            clip.postsBoundsChangedNotifications = true
            NotificationCenter.default.addObserver(self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification, object: clip)
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit {
        NotificationCenter.default.removeObserver(self)
        if let area { table.removeTrackingArea(area) }
    }

    override func mouseMoved(with event: NSEvent) {
        let row = table.row(at: table.convert(event.locationInWindow, from: nil))
        hover(row: row >= 0 ? row : nil)
    }
    override func mouseEntered(with event: NSEvent) { mouseMoved(with: event) }
    override func mouseExited(with event: NSEvent) { hover(row: nil) }
    @objc private func scrolled() { close() }

    /// The pointer rests on a row (nil: on none). A new row starts the delay;
    /// the same row keeps its card.
    func hover(row: Int?) {
        let next = row.flatMap { target?($0) }
        guard row != hoveredRow || next?.id != hoveredTarget?.id else { return }
        close()
        guard let row, let next else { return }
        hoveredRow = row; hoveredTarget = next
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.hoveredRow == row, self.hoveredTarget?.id == next.id else { return }
            self.timer = nil
            self.show(row: row, target: next)
        }
        timer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.delay, execute: work)
    }

    private func show(row: Int, target: EntityLinkTarget) {
        guard let source else { present(EntityHoverCardContent(target: target), row: row); return }
        source(target) { [weak self] content in
            guard let self, self.hoveredRow == row, self.hoveredTarget?.id == target.id else { return }
            self.present(content, row: row)
        }
    }

    private func present(_ content: EntityHoverCardContent, row: Int) {
        let controller = EntityHoverCardController(content: content)
        controller.showsOpenHint = false
        self.content = content; self.controller = controller
        popover.contentViewController = controller
        guard let window = table.window, window.isVisible, row < table.numberOfRows,
              // The row still shows the hovered page (a reload may have moved it).
              let hovered = hoveredTarget, target?(row)?.id == hovered.id else { return }
        popover.show(relativeTo: table.rect(ofRow: row), of: table, preferredEdge: .maxX)
    }

    /// Closes the card or stops the one waiting.
    func close() {
        timer?.cancel(); timer = nil
        hoveredRow = nil; hoveredTarget = nil; content = nil; controller = nil
        if popover.isShown { popover.performClose(nil) }
        popover.contentViewController = nil
    }

    /// Closed by itself (a click elsewhere): the row shows its card again
    /// the next time the pointer rests on it.
    func popoverDidClose(_ notification: Notification) {
        guard !popover.isShown else { return }
        timer?.cancel(); timer = nil
        hoveredRow = nil; hoveredTarget = nil; content = nil; controller = nil
        popover.contentViewController = nil
    }
}
