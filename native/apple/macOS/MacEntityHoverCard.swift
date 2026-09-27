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

    /// Every line in reading order, as the card shows it.
    var lines: [String] {
        var lines = [title]
        if !meta.isEmpty { lines.append(meta.joined(separator: " · ")) }
        if let aliases { lines.append(aliases) }
        let brief = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trashed { lines.append(brief.isEmpty ? "暂无简介" : brief) }
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
            let summary = label(brief.isEmpty ? "暂无简介" : brief, size: 12, color: brief.isEmpty ? .tertiaryLabelColor : .labelColor)
            summary.maximumNumberOfLines = 5
            views.append(summary)
        }
        for fact in content.facts { views.append(label(fact, size: 11)) }
        if let counts = content.counts { views.append(label(counts, size: 11, color: .secondaryLabelColor)) }
        if !content.trashed { views.append(label("点击打开", size: 10, color: .tertiaryLabelColor)) }
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
