import AppKit

// MARK: Prose shape

/// 段落, 句子 and 对白比 of a body, from its projection. Only paragraphs
/// count (headings, code and read-only blocks do not), those inside quotes
/// and lists included.
///
/// - 段落: paragraphs with any non-whitespace text.
/// - 句子: in each paragraph, runs of sentence-ending punctuation. 。！？ end
///   a sentence wherever they stand; ASCII . ! ? only before whitespace, a
///   closing quote or the paragraph's end (so 3.14 does not); an ellipsis
///   (…, ……, ...) only at the paragraph's end, since mid-paragraph it is a
///   pause. A run counts once, closing quotes after it belong to it, and
///   text after the last end counts as one more sentence.
/// - 对白比: the share of characters inside “”, 「」, 『』 or straight ""
///   quotes (nested quotes counted once; an unclosed quote runs to the
///   paragraph's end), over all characters. Whitespace and the quotation
///   marks themselves are not characters here.
struct ProseShape: Equatable {
    var paragraphs = 0
    var sentences = 0
    var dialogueCharacters = 0
    var characters = 0

    var dialogueRatio: Double { characters > 0 ? Double(dialogueCharacters) / Double(characters) : 0 }
    /// 对白比 in whole percent, rounded.
    var dialoguePercent: Int { Int((dialogueRatio * 100).rounded()) }

    init() {}

    init(text: String, blocks: [NativeBlock]) {
        let string = text as NSString
        for block in blocks where block.kind == "paragraph" && block.editable {
            let range = block.range.nsRange
            guard range.location >= 0, NSMaxRange(range) <= string.length else { continue }
            let paragraph = string.substring(with: range)
            guard paragraph.contains(where: { !$0.isWhitespace }) else { continue }
            paragraphs += 1
            sentences += Self.sentences(in: paragraph)
            let (quoted, all) = Self.dialogue(in: paragraph)
            dialogueCharacters += quoted; characters += all
        }
    }

    static let strongEnds: Set<Character> = ["。", "！", "？"]
    static let latinEnds: Set<Character> = [".", "!", "?"]
    static let ellipsis: Character = "…"
    /// Closing quotes and brackets that belong to the sentence before them.
    static let closers: Set<Character> = ["”", "’", "」", "』", "）", ")", "]", "】", "》", "〉", "\"", "'"]

    static func sentences(in paragraph: String) -> Int {
        let characters = Array(paragraph)
        var count = 0, open = false, index = 0
        func isEnd(_ character: Character) -> Bool {
            strongEnds.contains(character) || latinEnds.contains(character) || character == ellipsis
        }
        while index < characters.count {
            let character = characters[index]
            guard isEnd(character) else {
                if !character.isWhitespace, !closers.contains(character) { open = true }
                index += 1
                continue
            }
            var end = index
            while end < characters.count, isEnd(characters[end]) { end += 1 }
            let run = characters[index..<end]
            var after = end
            while after < characters.count, closers.contains(characters[after]) { after += 1 }
            let atParagraphEnd = characters[after...].allSatisfy(\.isWhitespace)
            let pause = run.allSatisfy { $0 == ellipsis } || (run.allSatisfy { $0 == "." } && run.count >= 3)
                || (run.allSatisfy { $0 == ellipsis || $0 == "." } && run.contains(ellipsis))
            let ends: Bool
            if pause { ends = atParagraphEnd }
            else if run.contains(where: strongEnds.contains) { ends = true }
            else { ends = after >= characters.count || characters[after].isWhitespace || after > end }
            if ends {
                if open { count += 1 }
                open = false
            } else {
                open = true
            }
            index = after
        }
        return count + (open ? 1 : 0)
    }

    /// Characters inside quotes, and all characters, of one paragraph.
    static func dialogue(in paragraph: String) -> (quoted: Int, all: Int) {
        var depth = 0, straight = false, quoted = 0, all = 0
        for character in paragraph {
            switch character {
            case "“", "「", "『": depth += 1
            case "”", "」", "』": depth = max(0, depth - 1)
            case "\"": straight.toggle()
            default:
                guard !character.isWhitespace else { continue }
                all += 1
                if depth > 0 || straight { quoted += 1 }
            }
        }
        return (quoted, all)
    }
}

// MARK: Links in a body

/// The entity links of one body: for each target the number of spans (a
/// span is a stretch of adjacent linked runs, as backlinks count them) and
/// the first span's range, in the order targets first appear.
struct ProseLinkCounts: Equatable {
    private(set) var targets: [NativeEntityLink] = []
    private(set) var spans: [NativeEntityLink: Int] = [:]
    private(set) var first: [NativeEntityLink: NSRange] = [:]

    init() {}

    init(blocks: [NativeBlock]) {
        var ends: [NativeEntityLink: Int] = [:]
        for block in blocks {
            for run in block.runs where !run.attributes.links.isEmpty {
                for link in run.attributes.links {
                    if ends[link] == run.range.location {
                        // The same span goes on (another mark split the run).
                        if let range = first[link], spans[link] == 1, NSMaxRange(range) == run.range.location {
                            first[link] = NSRange(location: range.location, length: range.length + run.range.length)
                        }
                    } else {
                        if spans[link] == nil { targets.append(link); first[link] = run.range.nsRange }
                        spans[link, default: 0] += 1
                    }
                    ends[link] = NSMaxRange(run.range.nsRange)
                }
            }
        }
    }

    func count(_ link: NativeEntityLink) -> Int { spans[link] ?? 0 }
    var total: Int { spans.values.reduce(0, +) }
    func elements() -> [NativeEntityLink] { targets.filter { $0.kind == "element" } }
    func nodes() -> [NativeEntityLink] { targets.filter { $0.kind == "node" } }
}

/// Every live chapter's (in book order) and drift's links, read once from
/// their live owners or stored bodies (reads only: no owner opens, nothing
/// is written). The tab host keeps one per project until a body saves or
/// the lists change.
struct BookLinkIndex {
    struct Body: Equatable {
        /// `chapter` or `drift`.
        let kind: String
        let id: String
        let title: String
        /// A chapter's number in book order; nil for a drift.
        let number: Int?
        let links: ProseLinkCounts
    }
    /// Chapters in book order, then drifts in library order.
    var bodies: [Body]
    /// Bodies that could not be read, named so a missing count is not mistaken for none.
    var unreadable: [String]

    /// The bodies that link a target, with their span counts.
    func mentions(of link: NativeEntityLink, excluding id: String? = nil) -> [(body: Body, spans: Int)] {
        bodies.compactMap { body in
            guard body.id != id else { return nil }
            let spans = body.links.count(link)
            return spans > 0 ? (body, spans) : nil
        }
    }
}

/// A chapter's place in the book, from the outline: its number among the
/// chapters, their count, and the act it is in (with the act's number).
struct BookPlace: Equatable {
    struct Act: Equatable { let id: String; let name: String; let number: Int }
    let number: Int
    let total: Int
    let act: Act?

    /// Chapters in book order with their acts, from `workspaceOutline` rows.
    static func chapters(_ entries: [WorkspaceOutlineEntry]) -> [(id: String, title: String, place: BookPlace)] {
        let total = entries.filter { $0.kind == "chapter" }.count
        var act: Act?, acts = 0, number = 0
        var result: [(String, String, BookPlace)] = []
        for entry in entries {
            if entry.kind == "act" {
                acts += 1
                act = Act(id: entry.id, name: entry.title, number: acts)
            } else if entry.kind == "chapter" {
                number += 1
                result.append((entry.id, entry.title, BookPlace(number: number, total: total, act: act)))
            }
        }
        return result
    }

    /// “第 2 章 / 共 5 章”.
    var text: String { "第 \(number) 章 / 共 \(total) 章" }
    /// “第一幕「启程」”, or 未分幕 before the first act.
    var actText: String {
        guard let act else { return "未分幕（在第一幕之前）" }
        return "第\(Self.chineseNumber(act.number))幕「\(act.name)」"
    }

    static func chineseNumber(_ value: Int) -> String {
        let digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"]
        guard value > 0 else { return "\(value)" }
        if value < 10 { return digits[value] }
        if value < 20 { return "十" + (value % 10 == 0 ? "" : digits[value % 10]) }
        if value < 100 { return digits[value / 10] + "十" + (value % 10 == 0 ? "" : digits[value % 10]) }
        return "\(value)"
    }
}

// MARK: The statistics shown

/// 统计 of one page: sections of values and of rows that open a page.
struct PageStats: Equatable {
    enum Row: Equatable {
        /// A label and its value; `id` names it for accessibility.
        case value(id: String, label: String, value: String)
        /// A page the row opens, with a detail such as “3 次”.
        case link(id: String, title: String, detail: String, target: RelationEndpoint)
        /// A muted line (统计中…, 暂无).
        case note(String)
    }
    struct Section: Equatable {
        let title: String
        var rows: [Row]
    }
    var title: String
    var sections: [Section]

    /// The value a row shows, by identifier.
    func value(_ id: String) -> String? {
        for section in sections {
            for row in section.rows { if case .value(id, _, let value) = row { return value } }
        }
        return nil
    }

    /// The link rows of a section, as (title, detail).
    func links(in section: String) -> [(title: String, detail: String)] {
        sections.first { $0.title == section }?.rows.compactMap { row in
            if case .link(_, let title, let detail, _) = row { return (title, detail) }
            return nil
        } ?? []
    }

    /// A section's muted lines.
    func notes(in section: String) -> [String] {
        sections.first { $0.title == section }?.rows.compactMap { row in
            if case .note(let text) = row { return text }
            return nil
        } ?? []
    }
}

/// 统计 in a popover beside the page header: sections of values in plain
/// labels and rows that open the page they name (设定, 章节, 漂流).
final class MacPageStatsViewController: NSViewController {
    private let stack = NSStackView()
    private let scroll = NSScrollView()
    private(set) var stats: PageStats
    /// A row was clicked: the page it names opens.
    var onOpen: ((RelationEndpoint) -> Void)?
    /// Every link row's button by identifier, for acceptance.
    private(set) var linkButtons: [String: NSButton] = [:]
    private var targets: [String: RelationEndpoint] = [:]

    init(stats: PageStats) {
        self.stats = stats
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 6
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let document = FlippedStackHost()
        document.addSubview(stack)
        document.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor), stack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            stack.topAnchor.constraint(equalTo: document.topAnchor), stack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            stack.widthAnchor.constraint(equalToConstant: 300),
        ])
        scroll.documentView = document
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor).isActive = true
        document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor).isActive = true
        scroll.setAccessibilityIdentifier("page-stats")
        view = scroll
        render()
    }

    func show(_ stats: PageStats) {
        guard stats != self.stats || linkButtons.isEmpty && targets.isEmpty else { return }
        self.stats = stats
        if isViewLoaded { render() }
    }

    private func render() {
        for view in stack.arrangedSubviews { stack.removeArrangedSubview(view); view.removeFromSuperview() }
        linkButtons = [:]; targets = [:]
        let title = NSTextField(labelWithString: stats.title)
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        title.lineBreakMode = .byTruncatingTail
        stack.addArrangedSubview(title)
        for section in stats.sections {
            stack.setCustomSpacing(12, after: stack.arrangedSubviews.last ?? title)
            let heading = NSTextField(labelWithString: section.title)
            heading.font = .systemFont(ofSize: 11, weight: .semibold)
            heading.textColor = .secondaryLabelColor
            stack.addArrangedSubview(heading)
            for row in section.rows { stack.addArrangedSubview(view(for: row)) }
        }
        stack.layoutSubtreeIfNeeded()
        let height = min(max(stack.fittingSize.height, 80), 520)
        preferredContentSize = NSSize(width: 300, height: height)
    }

    private func view(for row: PageStats.Row) -> NSView {
        switch row {
        case .value(let id, let label, let value):
            let name = NSTextField(labelWithString: label)
            name.textColor = .secondaryLabelColor
            name.setContentHuggingPriority(.required, for: .horizontal)
            let shown = NSTextField(labelWithString: value)
            shown.lineBreakMode = .byTruncatingTail
            shown.alignment = .right
            shown.setAccessibilityIdentifier(id)
            shown.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            let line = NSStackView(views: [name, NSView(), shown])
            line.spacing = 8
            line.widthAnchor.constraint(equalToConstant: 272).isActive = true
            return line
        case .link(let id, let title, let detail, let target):
            let button = NSButton(title: title, target: self, action: #selector(openRow(_:)))
            button.isBordered = false
            button.alignment = .left
            button.contentTintColor = .linkColor
            button.lineBreakMode = .byTruncatingTail
            button.setAccessibilityIdentifier(id)
            button.toolTip = "打开「\(title)」"
            button.identifier = NSUserInterfaceItemIdentifier(id)
            button.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            linkButtons[id] = button; targets[id] = target
            let count = NSTextField(labelWithString: detail)
            count.textColor = .secondaryLabelColor
            count.setContentHuggingPriority(.required, for: .horizontal)
            let line = NSStackView(views: [button, NSView(), count])
            line.spacing = 8
            line.widthAnchor.constraint(equalToConstant: 272).isActive = true
            return line
        case .note(let text):
            let label = NSTextField(wrappingLabelWithString: text)
            label.textColor = .secondaryLabelColor
            label.font = .systemFont(ofSize: 12)
            label.preferredMaxLayoutWidth = 272
            return label
        }
    }

    /// Opens the page a link row names, as a click does.
    @discardableResult
    func open(_ id: String) -> Bool {
        guard let target = targets[id] else { return false }
        onOpen?(target)
        return true
    }

    @objc private func openRow(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        open(id)
    }
}

/// A flipped document view, so a short list starts at the top of its scroll.
private final class FlippedStackHost: NSView {
    override var isFlipped: Bool { true }
}

/// A page's 统计 button in its header, beside the title or name.
enum MacPageStatsButton {
    static func make() -> NSButton {
        let button = NSButton(title: "统计", target: nil, action: nil)
        button.bezelStyle = .recessed
        button.controlSize = .small
        button.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        button.setAccessibilityIdentifier("page-stats-button")
        button.toolTip = "这一页的统计：字数、段落、句子、对白比、提到的设定和引用（视图 › 页面统计）"
        return button
    }
}

/// A fixed section of a page that its 大纲轨道 lists: the view scrolled into
/// view on a click, and the control that then takes the keyboard (if any).
struct PageRailSection {
    let key: String
    let title: String
    let view: NSView
    let focus: NSView?
}
