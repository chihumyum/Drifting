import AppKit

// MARK: Positions in a prose text view

extension NSTextView {
    /// The top of the line holding a UTF-16 location, in this view's
    /// coordinates. Lays the text out up to it, with whichever text engine
    /// the view has (it never switches engines).
    func proseLineTop(at location: Int) -> CGFloat? {
        let length = (string as NSString).length
        let at = min(max(location, 0), length)
        let origin = textContainerOrigin
        if let manager = textLayoutManager, let content = manager.textContentManager {
            let document = content.documentRange
            guard length > 0 else { return origin.y }
            // The text's end (an empty last paragraph) sits below the last line.
            let probe = at == length ? length - 1 : at
            guard let position = content.location(document.location, offsetBy: probe) else { return nil }
            if let end = content.location(position, offsetBy: 1), let range = NSTextRange(location: document.location, end: end) {
                manager.ensureLayout(for: range)
            }
            guard let fragment = manager.textLayoutFragment(for: position) else { return nil }
            let frame = fragment.layoutFragmentFrame
            if at == length, (string as NSString).character(at: length - 1) == 10 {
                return origin.y + frame.maxY
            }
            let offset = content.offset(from: fragment.rangeInElement.location, to: position)
            let line = fragment.textLineFragments.first { $0.characterRange.contains(offset) } ?? fragment.textLineFragments.first
            return origin.y + frame.minY + (line?.typographicBounds.minY ?? 0)
        }
        guard let manager = layoutManager, let container = textContainer else { return nil }
        guard length > 0 else { return origin.y }
        if at == length, (string as NSString).character(at: length - 1) == 10 {
            manager.ensureLayout(for: container)
            return origin.y + manager.extraLineFragmentRect.minY
        }
        let glyph = manager.glyphIndexForCharacter(at: min(at, length - 1))
        manager.ensureLayout(forGlyphRange: NSRange(location: 0, length: min(glyph + 1, manager.numberOfGlyphs)))
        guard glyph < manager.numberOfGlyphs else { return nil }
        return origin.y + manager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil).minY
    }

    /// The height the whole laid-out text takes in this view, insets
    /// included. Lays out all of the text.
    func proseDocumentHeight() -> CGFloat {
        let insets = textContainerOrigin.y + textContainerInset.height
        if let manager = textLayoutManager {
            manager.ensureLayout(for: manager.documentRange)
            return max(bounds.height, manager.usageBoundsForTextContainer.maxY + insets)
        }
        guard let manager = layoutManager, let container = textContainer else { return bounds.height }
        manager.ensureLayout(for: container)
        return max(bounds.height, manager.usedRect(for: container).maxY + insets)
    }

    /// The reading line sits this far below the top of the visible prose.
    static let proseReadingLine: CGFloat = 16

    /// The character at the reading line near the top of the visible prose
    /// (the first line at the very top of the text).
    func proseFirstVisibleLocation() -> Int {
        let visible = visibleRect
        let y = visible.minY <= textContainerOrigin.y ? textContainerOrigin.y + 2 : visible.minY + Self.proseReadingLine
        return characterIndexForInsertion(at: NSPoint(x: textContainerOrigin.x + 1, y: y))
    }
}

// MARK: Scrollbar markers

/// A tick beside the prose: a comment (批注), an open TODO (待办) or a
/// pending proposal of the writing assistant anchored in the body.
struct ProseMarker: Equatable {
    enum Kind: String { case comment, todo, proposal }
    let kind: Kind
    /// The comment's or the proposal's identity.
    let id: String
    /// The anchored text in the body.
    let range: NSRange
    /// Where the anchor's line sits, 0 at the top of the prose, 1 at the end.
    var fraction: CGFloat
    /// The tick's tooltip.
    let label: String

    var color: NSColor {
        switch kind {
        case .comment: return .systemYellow
        case .todo: return .systemOrange
        case .proposal: return .systemPurple
        }
    }
}

/// A pending revision of the writing assistant, as a marker looks for it:
/// the text it replaces (every occurrence with `all`).
struct ProseProposalAnchor: Equatable {
    let id: String
    let text: String
    let all: Bool
    let label: String
}

/// The ticks at the prose's trailing edge, over the text container's inset
/// and left of the scroller; clicks between ticks reach the prose. Each tick
/// sits at its anchor's share of the text's height.
final class ProseMarkerStrip: NSView {
    static let width: CGFloat = 8
    static let tickHeight: CGFloat = 3
    var markers: [ProseMarker] = [] {
        didSet {
            guard markers != oldValue else { return }
            needsDisplay = true
            updateToolTips()
            setAccessibilityLabel(markers.isEmpty ? "没有标记" : "\(markers.count) 个标记")
        }
    }
    var onClick: ((ProseMarker) -> Void)?
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityIdentifier("prose-markers")
        setAccessibilityRole(.group)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// The tick's rectangle in this view.
    func tickRect(_ marker: ProseMarker) -> NSRect {
        let track = max(0, bounds.height - Self.tickHeight)
        return NSRect(x: 1, y: (min(max(marker.fraction, 0), 1) * track).rounded(), width: bounds.width - 2, height: Self.tickHeight)
    }

    /// The marker under a point of this view: the nearest tick within four points.
    func marker(at point: NSPoint) -> ProseMarker? {
        markers.map { ($0, abs(tickRect($0).midY - point.y)) }.filter { $0.1 <= 4 }.min { $0.1 < $1.1 }?.0
    }

    override func draw(_ dirtyRect: NSRect) {
        for marker in markers {
            let rect = tickRect(marker)
            guard rect.intersects(dirtyRect) else { continue }
            marker.color.setFill()
            NSBezierPath(roundedRect: rect, xRadius: 1, yRadius: 1).fill()
        }
    }

    /// Only a tick takes the mouse; elsewhere the prose does.
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, let superview else { return nil }
        let local = convert(point, from: superview)
        return bounds.contains(local) && marker(at: local) != nil ? self : nil
    }

    override func mouseDown(with event: NSEvent) {
        guard let marker = marker(at: convert(event.locationInWindow, from: nil)) else { return }
        onClick?(marker)
    }

    override func resetCursorRects() {
        for marker in markers { addCursorRect(tickRect(marker).insetBy(dx: 0, dy: -2), cursor: .pointingHand) }
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        updateToolTips()
    }

    private func updateToolTips() {
        removeAllToolTips()
        for marker in markers { addToolTip(tickRect(marker).insetBy(dx: 0, dy: -2), owner: marker.label as NSString, userData: nil) }
        window?.invalidateCursorRects(for: self)
    }
}

// MARK: 大纲轨道

/// 大纲轨道 beside a page: its fixed sections (on element, storyline and
/// category pages), 正文, and the body's headings indented by level. The
/// item in view is set in the label colour and a heavier weight (no edge
/// accent); a click scrolls there.
final class PageOutlineRail: NSView {
    struct Item: Equatable {
        enum Target: Equatable {
            /// A fixed section of the page, by key (overview, facts …).
            case section(String)
            /// The start of the body.
            case body
            /// A heading of the body at a UTF-16 location.
            case heading(id: String?, location: Int)
        }
        let title: String
        /// 0 for sections and 正文; 1–3 for headings.
        let level: Int
        let target: Target
    }
    static let width: CGFloat = 164
    private(set) var items: [Item] = []
    /// The item in view, highlighted.
    private(set) var current: Int?
    private(set) var buttons: [NSButton] = []
    /// The buttons carry the current item's styling.
    private var styled = false
    private(set) var emptyText: String?
    /// The fixed section a click last brought into view, for acceptance.
    var revealedSection: String?
    var onChoose: ((Item) -> Void)?
    private let heading = NSTextField(labelWithString: "大纲")
    private let stack = NSStackView()
    private let scroll = NSScrollView()
    private let empty = NSTextField(wrappingLabelWithString: "")

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityIdentifier("outline-rail")
        setAccessibilityLabel("大纲轨道")
        heading.font = .systemFont(ofSize: 11, weight: .semibold)
        heading.textColor = .secondaryLabelColor
        empty.font = .systemFont(ofSize: 11)
        empty.textColor = .tertiaryLabelColor
        empty.isHidden = true
        empty.setAccessibilityIdentifier("outline-rail-empty")
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        let document = RailDocument()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(stack)
        scroll.documentView = document
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        let column = NSStackView(views: [heading, scroll, empty])
        column.orientation = .vertical; column.alignment = .leading; column.spacing = 6
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            column.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
            column.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            column.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            scroll.widthAnchor.constraint(equalTo: column.widthAnchor),
            empty.widthAnchor.constraint(equalTo: column.widthAnchor),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor), stack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            stack.topAnchor.constraint(equalTo: document.topAnchor), stack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            widthAnchor.constraint(equalToConstant: Self.width),
        ])
        scroll.setContentHuggingPriority(.init(1), for: .vertical)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Shows the items; an unchanged list keeps its buttons. `emptyText`
    /// shows under them when the body has no headings.
    func show(_ items: [Item], emptyText: String?) {
        if emptyText != self.emptyText {
            self.emptyText = emptyText
            empty.stringValue = emptyText ?? ""
            empty.isHidden = emptyText == nil
        }
        guard items != self.items else { return }
        // Headings moved by typing keep their buttons; only their places change.
        if items.count == self.items.count, zip(items, self.items).allSatisfy({ Self.sameRow($0, $1) }) {
            self.items = items
            return
        }
        self.items = items
        for view in stack.arrangedSubviews { stack.removeArrangedSubview(view); view.removeFromSuperview() }
        buttons = items.enumerated().map { index, item in
            let button = NSButton(title: item.title.isEmpty ? "（无标题）" : item.title, target: self, action: #selector(chosen(_:)))
            button.isBordered = false
            button.alignment = .left
            button.lineBreakMode = .byTruncatingTail
            button.tag = index
            button.toolTip = item.title
            button.setAccessibilityIdentifier("outline-rail-item-\(index)")
            button.setContentCompressionResistancePriority(.init(1), for: .horizontal)
            let row = NSStackView(views: [button])
            row.edgeInsets = NSEdgeInsets(top: 0, left: CGFloat(max(0, item.level - 1)) * 10 + (item.level > 0 ? 6 : 0), bottom: 0, right: 0)
            stack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            return button
        }
        let previous = current
        current = nil
        styled = false
        setCurrent(previous.flatMap { items.indices.contains($0) ? $0 : nil })
    }

    /// The same row, wherever its heading now starts.
    private static func sameRow(_ left: Item, _ right: Item) -> Bool {
        guard left.title == right.title, left.level == right.level else { return false }
        switch (left.target, right.target) {
        case (.heading(let a, _), .heading(let b, _)): return a == b
        default: return left.target == right.target
        }
    }

    /// Highlights the item in view: the label colour and a heavier weight.
    func setCurrent(_ index: Int?) {
        let index = index.flatMap { items.indices.contains($0) ? $0 : nil }
        guard index != current || !styled else { return }
        styled = true
        for (position, button) in buttons.enumerated() {
            let on = position == index, item = items[position]
            let size: CGFloat = item.level == 0 ? 12 : 12
            let font = NSFont.systemFont(ofSize: size, weight: on ? .semibold : .regular)
            let color: NSColor = on ? .labelColor : (item.level == 0 ? .secondaryLabelColor : .labelColor.withAlphaComponent(0.75))
            button.attributedTitle = NSAttributedString(string: button.title, attributes: [.font: font, .foregroundColor: color])
            button.setAccessibilityValue(on ? "当前" : nil)
        }
        current = index
        if let index, buttons.indices.contains(index) { buttons[index].scrollToVisible(buttons[index].bounds) }
    }

    /// Chooses an item as a click does.
    func choose(_ index: Int) {
        guard items.indices.contains(index) else { return }
        setCurrent(index)
        onChoose?(items[index])
    }

    @objc private func chosen(_ sender: NSButton) { choose(sender.tag) }
}

private final class RailDocument: NSView {
    override var isFlipped: Bool { true }
}

/// A tab's page with its 大纲轨道 at the leading side and, while notes are
/// pinned to it, its 便笺栏 at the trailing side; a hidden rail gives the page
/// the width.
final class MacPageFrame: NSView {
    let page: NSView
    let rail = PageOutlineRail()
    let stickyRail = StickyNoteRail()
    private let separator = NSBox()
    private let stickySeparator = NSBox()
    private var shownConstraints: [NSLayoutConstraint] = []
    private var hiddenConstraints: [NSLayoutConstraint] = []
    private var stickyShownConstraints: [NSLayoutConstraint] = []
    private var stickyHiddenConstraints: [NSLayoutConstraint] = []
    var railShown = true {
        didSet {
            guard railShown != oldValue else { return }
            applyRail()
        }
    }
    /// The 便笺栏 shows while it has cards.
    var stickyShown = false {
        didSet {
            guard stickyShown != oldValue else { return }
            applySticky()
        }
    }

    init(page: NSView) {
        self.page = page
        super.init(frame: .zero)
        separator.boxType = .separator
        stickySeparator.boxType = .separator
        for view in [rail, separator, page, stickySeparator, stickyRail] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        NSLayoutConstraint.activate([
            rail.leadingAnchor.constraint(equalTo: leadingAnchor), rail.topAnchor.constraint(equalTo: topAnchor),
            rail.bottomAnchor.constraint(equalTo: bottomAnchor),
            separator.leadingAnchor.constraint(equalTo: rail.trailingAnchor), separator.topAnchor.constraint(equalTo: topAnchor),
            separator.bottomAnchor.constraint(equalTo: bottomAnchor), separator.widthAnchor.constraint(equalToConstant: 1),
            page.topAnchor.constraint(equalTo: topAnchor), page.bottomAnchor.constraint(equalTo: bottomAnchor),
            stickyRail.trailingAnchor.constraint(equalTo: trailingAnchor), stickyRail.topAnchor.constraint(equalTo: topAnchor),
            stickyRail.bottomAnchor.constraint(equalTo: bottomAnchor),
            stickySeparator.trailingAnchor.constraint(equalTo: stickyRail.leadingAnchor), stickySeparator.topAnchor.constraint(equalTo: topAnchor),
            stickySeparator.bottomAnchor.constraint(equalTo: bottomAnchor), stickySeparator.widthAnchor.constraint(equalToConstant: 1),
        ])
        shownConstraints = [page.leadingAnchor.constraint(equalTo: separator.trailingAnchor, constant: 8)]
        hiddenConstraints = [page.leadingAnchor.constraint(equalTo: leadingAnchor)]
        stickyShownConstraints = [page.trailingAnchor.constraint(equalTo: stickySeparator.leadingAnchor, constant: -8)]
        stickyHiddenConstraints = [page.trailingAnchor.constraint(equalTo: trailingAnchor)]
        applyRail()
        applySticky()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func applyRail() {
        rail.isHidden = !railShown; separator.isHidden = !railShown
        NSLayoutConstraint.deactivate(railShown ? hiddenConstraints : shownConstraints)
        NSLayoutConstraint.activate(railShown ? shownConstraints : hiddenConstraints)
        needsLayout = true
    }

    private func applySticky() {
        stickyRail.isHidden = !stickyShown; stickySeparator.isHidden = !stickyShown
        NSLayoutConstraint.deactivate(stickyShown ? stickyHiddenConstraints : stickyShownConstraints)
        NSLayoutConstraint.activate(stickyShown ? stickyShownConstraints : stickyHiddenConstraints)
        needsLayout = true
    }
}

// MARK: 便笺栏

/// 便笺栏 at a page's trailing margin: the notes and TODOs pinned to the page
/// (放入便笺栏 in a card's ⋯ in 审阅), oldest first. Stacked, only the
/// newest card shows with how many lie under it; 展开 spreads them out. A
/// card opens its note (a passage note selects its text), 移出 unpins it and
/// 清空便笺栏 unpins them all.
final class StickyNoteRail: NSView {
    static let width: CGFloat = 220
    /// One pinned note as its card shows it.
    struct Card: Equatable {
        let id: String
        /// 批注, 待办, with 已解决 when resolved.
        let kind: String
        /// A passage note's quote; empty for a note on the whole page.
        let quote: String
        let body: String
    }
    private(set) var cards: [Card] = []
    private(set) var expanded = false
    /// The card views shown, top to bottom.
    private(set) var cardViews: [StickyNoteCardView] = []
    let toggleButton = NSButton(title: "展开", target: nil, action: nil)
    let clearButton = NSButton(title: "清空便笺栏", target: nil, action: nil)
    private let heading = NSTextField(labelWithString: "便笺")
    private let more = NSTextField(labelWithString: "")
    private let stack = NSStackView()
    var onOpen: ((String) -> Void)?
    var onUnpin: ((String) -> Void)?
    var onClear: (() -> Void)?
    var onExpand: ((Bool) -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityIdentifier("sticky-rail")
        setAccessibilityLabel("便笺栏")
        heading.font = .systemFont(ofSize: 11, weight: .semibold)
        heading.textColor = .secondaryLabelColor
        for button in [toggleButton, clearButton] {
            button.bezelStyle = .recessed; button.controlSize = .small
            button.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
            button.target = self
        }
        toggleButton.action = #selector(toggle)
        toggleButton.setAccessibilityIdentifier("sticky-toggle")
        clearButton.action = #selector(clear)
        clearButton.setAccessibilityIdentifier("sticky-clear")
        clearButton.toolTip = "把这一页的便笺全部移出便笺栏；批注和待办本身不受影响"
        more.font = .systemFont(ofSize: 11)
        more.textColor = .secondaryLabelColor
        more.setAccessibilityIdentifier("sticky-more")
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        let document = RailDocument()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(stack)
        let scroll = NSScrollView()
        scroll.documentView = document
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        let header = NSStackView(views: [heading, NSView(), toggleButton])
        header.spacing = 6
        let column = NSStackView(views: [header, scroll, more, clearButton])
        column.orientation = .vertical; column.alignment = .leading; column.spacing = 6
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            column.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            column.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            column.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            header.widthAnchor.constraint(equalTo: column.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: column.widthAnchor),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor), stack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            stack.topAnchor.constraint(equalTo: document.topAnchor), stack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            widthAnchor.constraint(equalToConstant: Self.width),
        ])
        scroll.setContentHuggingPriority(.init(1), for: .vertical)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Shows the pinned cards, oldest first; stacked shows the newest only.
    func show(_ cards: [Card], expanded: Bool) {
        guard cards != self.cards || expanded != self.expanded || cardViews.isEmpty != cards.isEmpty else { return }
        self.cards = cards; self.expanded = expanded
        for view in stack.arrangedSubviews { stack.removeArrangedSubview(view); view.removeFromSuperview() }
        let shown = expanded ? cards : Array(cards.suffix(1))
        cardViews = shown.map { card in
            let view = StickyNoteCardView(card: card)
            view.onOpen = { [weak self] in self?.onOpen?(card.id) }
            view.onUnpin = { [weak self] in self?.onUnpin?(card.id) }
            stack.addArrangedSubview(view)
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            return view
        }
        heading.stringValue = cards.isEmpty ? "便笺" : "便笺 · \(cards.count)"
        toggleButton.title = expanded ? "叠起" : "展开"
        toggleButton.isHidden = cards.count < 2
        let hidden = cards.count - shown.count
        more.stringValue = hidden > 0 ? "下面还有 \(hidden) 张便笺" : ""
        more.isHidden = hidden == 0
    }

    @objc private func toggle() { onExpand?(!expanded) }
    @objc private func clear() { onClear?() }
}

/// One pinned note: its kind, a passage note's quote and the body, on a wash
/// (no edge accent). A click opens it; 移出 unpins it.
final class StickyNoteCardView: NSView {
    let card: StickyNoteRail.Card
    let unpinButton = NSButton(title: "移出", target: nil, action: nil)
    var onOpen: (() -> Void)?
    var onUnpin: (() -> Void)?

    init(card: StickyNoteRail.Card) {
        self.card = card
        super.init(frame: .zero)
        wantsLayer = true
        setAccessibilityIdentifier("sticky-card-\(card.id)")
        setAccessibilityRole(.button)
        setAccessibilityLabel("\(card.kind)：\(card.body)")
        let kind = NSTextField(labelWithString: card.kind)
        kind.font = .systemFont(ofSize: 11, weight: .semibold)
        kind.textColor = .secondaryLabelColor
        unpinButton.bezelStyle = .recessed; unpinButton.controlSize = .mini
        unpinButton.font = .systemFont(ofSize: NSFont.systemFontSize(for: .mini))
        unpinButton.target = self; unpinButton.action = #selector(unpin)
        unpinButton.setAccessibilityIdentifier("sticky-unpin-\(card.id)")
        unpinButton.toolTip = "移出便笺栏"
        let header = NSStackView(views: [kind, NSView(), unpinButton])
        var views: [NSView] = [header]
        if !card.quote.isEmpty {
            let quote = NSTextField(wrappingLabelWithString: "「\(card.quote)」")
            quote.font = .systemFont(ofSize: 11)
            quote.textColor = .secondaryLabelColor
            quote.maximumNumberOfLines = 2
            quote.lineBreakMode = .byTruncatingTail
            views.append(quote)
        }
        let body = NSTextField(wrappingLabelWithString: card.body.isEmpty ? "（空白）" : card.body)
        body.font = .systemFont(ofSize: 12)
        body.maximumNumberOfLines = 6
        body.lineBreakMode = .byTruncatingTail
        views.append(body)
        let column = NSStackView(views: views)
        column.orientation = .vertical; column.alignment = .leading; column.spacing = 4
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            column.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            column.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            column.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            header.widthAnchor.constraint(equalTo: column.widthAnchor),
        ])
        for label in views.dropFirst() {
            (label as? NSTextField)?.preferredMaxLayoutWidth = StickyNoteRail.width - 36
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        layer?.cornerRadius = 6
        layer?.backgroundColor = NSColor.systemYellow.withAlphaComponent(0.14).cgColor
    }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard !unpinButton.frame.insetBy(dx: -2, dy: -2).contains(convert(point, to: unpinButton.superview)) else { return }
        onOpen?()
    }

    /// Opens the note, as a click does.
    func open() { onOpen?() }
    @objc private func unpin() { onUnpin?() }
}
