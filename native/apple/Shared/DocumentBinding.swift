import Foundation

enum NativeText {
    /// Prose identity is exact UTF-16, not Swift's canonical Unicode equality.
    /// Foundation also avoids Swift's expensive normalization comparison when
    /// one operand is TextKit's Cocoa-backed string.
    static func identical(_ left: String, _ right: String) -> Bool {
        (left as NSString).isEqual(to: right)
    }
}

struct NativeRange: Decodable, Equatable {
    var location: Int
    var length: Int
    var nsRange: NSRange { NSRange(location: location, length: length) }
}

enum NativeFormatAction: String, CaseIterable {
    case bold, italic, underline, strike, paragraph, heading1, heading2, heading3
    case alignLeft, alignCenter, alignRight, indentIncrease, indentDecrease
    case blockquote, bulletList, orderedList
    /// The second half of Return in a list item: the caret's paragraph, the
    /// last of its item and not the first, becomes the next item. Not a menu
    /// command; the editor applies it once the Return has landed.
    case splitListItem

    /// Marks toggle over selected text; a caret has nothing to mark.
    var isMark: Bool { Self.marks.contains(self) }
    var requiresSelection: Bool { isMark }
    /// Alignment and indent set one attribute of each paragraph or heading
    /// the selection touches (a caret takes its block).
    var isBlockAttribute: Bool { Self.alignments.contains(self) || self == .indentIncrease || self == .indentDecrease }
    /// 引用, 无序列表 and 有序列表 toggle a root container around the
    /// paragraphs and headings the selection touches (a caret takes its block).
    var isContainer: Bool { Self.containers.contains(self) }
    var title: String {
        switch self {
        case .bold: return "加粗"
        case .italic: return "斜体"
        case .underline: return "下划线"
        case .strike: return "删除线"
        case .paragraph: return "正文"
        case .heading1: return "标题 1"
        case .heading2: return "标题 2"
        case .heading3: return "标题 3"
        case .alignLeft: return "左对齐"
        case .alignCenter: return "居中"
        case .alignRight: return "右对齐"
        case .indentIncrease: return "增加缩进"
        case .indentDecrease: return "减少缩进"
        case .blockquote: return "引用"
        case .bulletList: return "无序列表"
        case .orderedList: return "有序列表"
        case .splitListItem: return "新列表项"
        }
    }
    var accessibilityID: String { "format-\(rawValue)" }
    /// The `textAlign` an alignment leaves; left is the absent default.
    var textAlign: String? { self == .alignCenter ? "center" : (self == .alignRight ? "right" : nil) }
    static let marks: [NativeFormatAction] = [.bold, .italic, .underline, .strike]
    static let blocks: [NativeFormatAction] = [.paragraph, .heading1, .heading2, .heading3]
    static let alignments: [NativeFormatAction] = [.alignLeft, .alignCenter, .alignRight]
    static let containers: [NativeFormatAction] = [.blockquote, .bulletList, .orderedList]
}

/// How much of a selection has a format, for menu checkmarks.
enum NativeFormatState: Equatable { case off, mixed, on }

/// The target one entity-link mark names. A payload without a kind is an
/// element, as in the renderer; one without an identity names nothing.
struct NativeEntityLink: Hashable {
    let kind: String
    let id: String
}

// Only display hints cross into the view. Unrecognized mark payloads remain in
// Yrs; attributed strings are never used to reconstruct the document.
struct NativeMarks: Decodable {
    let bold: Bool
    let italic: Bool
    let entityLink: Bool
    let strike: Bool
    let underline: Bool
    /// The address of the run's URL link (`link` mark), if any.
    let href: String?
    /// Every link on the run, ordered by mark key; one run may link several
    /// targets. Empty when `entityLink` carries no readable target.
    let links: [NativeEntityLink]
    private struct Keys: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
    private struct LinkPayload: Decodable {
        let targetKind: String?
        let targetId: String?
    }
    private struct URLPayload: Decodable { let href: String? }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        // y-prosemirror hashes overlapping mark keys; these are display hints
        // only. The exact keys/payloads stay in the Rust document projection.
        func base(_ key: Keys) -> String {
            key.stringValue.replacingOccurrences(of: "--[a-zA-Z0-9+/=]{8}$", with: "", options: .regularExpression)
        }
        let names = Set(values.allKeys.map(base))
        bold = names.contains("bold"); italic = names.contains("italic")
        entityLink = names.contains("entityLink"); strike = names.contains("strike")
        underline = names.contains("underline")
        href = values.allKeys.filter { base($0) == "link" }.sorted { $0.stringValue < $1.stringValue }
            .lazy.compactMap { (try? values.decode(URLPayload.self, forKey: $0))?.href }.first { !$0.isEmpty }
        var links: [NativeEntityLink] = []
        for key in values.allKeys.filter({ base($0) == "entityLink" }).sorted(by: { $0.stringValue < $1.stringValue }) {
            guard let payload = try? values.decode(LinkPayload.self, forKey: key), let id = payload.targetId else { continue }
            let link = NativeEntityLink(kind: payload.targetKind ?? "element", id: id)
            if !links.contains(link) { links.append(link) }
        }
        self.links = links
    }
}
struct NativeRun: Decodable { let range: NativeRange; let attributes: NativeMarks }
struct NativeBlockAttributes: Decodable, Equatable {
    let level: Int?
    /// `center` or `right`; nil is left, the default.
    let textAlign: String?
    /// The block indent level, 0 (none) to 8.
    let indent: Int
    static let maximumIndent = 8
    private enum CodingKeys: String, CodingKey { case level, textAlign, indent }
    init(level: Int? = nil, textAlign: String? = nil, indent: Int = 0) {
        self.level = level; self.textAlign = textAlign; self.indent = indent
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        // Unknown attribute payloads remain in Rust; a display hint must not
        // prevent opening a document whose metadata this view cannot render.
        level = try? values.decode(Int.self, forKey: .level)
        let align = try? values.decode(String.self, forKey: .textAlign)
        textAlign = align == "center" || align == "right" ? align : nil
        let stored = (try? values.decode(Double.self, forKey: .indent)).flatMap { $0.isFinite ? $0 : nil } ?? 0
        indent = Int(min(max(stored, 0), Double(Self.maximumIndent)))
    }
}
struct NativeBlock: Decodable {
    let id: String?
    var kind: String
    let depth: Int
    let container: String
    var structuralAttributes: [String: String]
    var range: NativeRange
    let editable: Bool
    var runs: [NativeRun]
    var attributes: NativeBlockAttributes? = nil
    /// Enclosing `blockquote`, `bulletList`, `orderedList` and `listItem`
    /// tags, outermost first; empty at the root.
    var containers: [String] = []
    /// The number of the nearest enclosing ordered-list item.
    var listNumber: Int? = nil
    var headingLevel: Int { attributes?.level ?? 1 }
    var textAlign: String? { attributes?.textAlign }
    var indent: Int { attributes?.indent ?? 0 }
    /// Alignment and indent apply to paragraphs and headings.
    var acceptsBlockAttributes: Bool { editable && (kind == "paragraph" || kind == "heading") }
    var quoteDepth: Int { containers.filter { $0 == "blockquote" }.count }
    var listDepth: Int { containers.filter { $0 == "listItem" }.count }
    /// `bulletList` or `orderedList`: the innermost list holding the block.
    var listKind: String? { containers.last { $0 == "bulletList" || $0 == "orderedList" } }
    /// A paragraph or heading directly in a root quote (`blockquote`) or in
    /// an item of a root list (`bulletList`/`orderedList`): the shapes
    /// 引用 and the lists lift out of.
    var rootContainer: String? {
        if containers == ["blockquote"] { return "blockquote" }
        if containers.count == 2, containers[1] == "listItem", containers[0] == "bulletList" || containers[0] == "orderedList" {
            return containers[0]
        }
        return nil
    }
}

extension NativeBlock {
    private enum CodingKeys: String, CodingKey {
        case id, kind, depth, container, structuralAttributes, range, editable, runs, attributes, containers, listNumber
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decodeIfPresent(String.self, forKey: .id)
        kind = try values.decode(String.self, forKey: .kind)
        depth = try values.decode(Int.self, forKey: .depth)
        container = try values.decode(String.self, forKey: .container)
        structuralAttributes = try values.decode([String: String].self, forKey: .structuralAttributes)
        range = try values.decode(NativeRange.self, forKey: .range)
        editable = try values.decode(Bool.self, forKey: .editable)
        runs = try values.decode([NativeRun].self, forKey: .runs)
        attributes = try values.decodeIfPresent(NativeBlockAttributes.self, forKey: .attributes)
        // Display hints: a projection without them draws the block at the root.
        containers = (try? values.decodeIfPresent([String].self, forKey: .containers)) ?? []
        listNumber = (try? values.decodeIfPresent(Int.self, forKey: .listNumber)) ?? nil
    }
}
struct NativeProjection: Decodable {
    let revision: UInt64
    let text: String
    let blocks: [NativeBlock]
    let comments: [NativeComment]
    let selections: [NativeSelection]
    let canUndo: Bool
    let canRedo: Bool
    // Optimistic text projections deliberately omit navigation ranges. The
    // outline panel keeps its last authoritative list while input is pending.
    var outline: [NativeOutlineItem] = []
}
/// Display hints about a selection's formats and links. Rust decides what a
/// command edits; these only enable commands and draw checkmarks.
extension NativeProjection {
    /// The blocks a range touches, as Rust counts them: a caret its block, a
    /// selection every block from its start to the last one it enters.
    func blockIndices(touching range: NSRange) -> ClosedRange<Int>? {
        guard range.location >= 0, range.length >= 0, let first = NativeLayout.index(range.location, blocks: blocks) else { return nil }
        guard range.length > 0 else { return first...first }
        let end = NSMaxRange(range)
        guard let last = blocks.lastIndex(where: { $0.range.location < end }), last >= first else { return nil }
        return first...last
    }

    /// The block and run holding the character at a UTF-16 index.
    func run(at index: Int) -> (block: NativeBlock, run: NativeRun)? {
        guard let block = blocks.first(where: { $0.range.location <= index && index < NSMaxRange($0.range.nsRange) }),
              let run = block.runs.first(where: { $0.range.location <= index && index < NSMaxRange($0.range.nsRange) }) else { return nil }
        return (block, run)
    }

    /// A mark over a selection: on when all selected text has it. At a caret
    /// the character before it (or after it at a block's start) decides.
    func markState(in range: NSRange, _ has: (NativeMarks) -> Bool) -> NativeFormatState {
        if range.length == 0 {
            guard let index = NativeLayout.index(range.location, blocks: blocks) else { return .off }
            let block = blocks[index]
            let at = range.location > block.range.location ? range.location - 1 : range.location
            return run(at: at).map { has($0.run.attributes) ? .on : .off } ?? .off
        }
        var marked = 0, plain = 0
        for block in blocks {
            for run in block.runs {
                let overlap = NSIntersectionRange(run.range.nsRange, range).length
                guard overlap > 0 else { continue }
                if has(run.attributes) { marked += overlap } else { plain += overlap }
            }
        }
        return marked == 0 ? .off : (plain == 0 ? .on : .mixed)
    }

    /// A format's state over a selection: marks by their characters, block
    /// styles and alignments by the blocks the selection touches.
    func formatState(_ action: NativeFormatAction, in range: NSRange) -> NativeFormatState {
        func blockState(_ matches: (NativeBlock) -> Bool, considered: (NativeBlock) -> Bool = { _ in true }) -> NativeFormatState {
            guard let indices = blockIndices(touching: range) else { return .off }
            let touched = blocks[indices].filter(considered)
            let count = touched.filter(matches).count
            return count == 0 ? .off : (count == touched.count ? .on : .mixed)
        }
        switch action {
        case .bold: return markState(in: range) { $0.bold }
        case .italic: return markState(in: range) { $0.italic }
        case .underline: return markState(in: range) { $0.underline }
        case .strike: return markState(in: range) { $0.strike }
        case .paragraph: return blockState { $0.kind == "paragraph" }
        case .heading1, .heading2, .heading3:
            return blockState { $0.kind == "heading" && "heading\($0.headingLevel)" == action.rawValue }
        case .alignLeft, .alignCenter, .alignRight:
            return blockState({ $0.textAlign == action.textAlign }, considered: \.acceptsBlockAttributes)
        case .indentIncrease, .indentDecrease, .splitListItem: return .off
        case .blockquote, .bulletList, .orderedList:
            return blockState({ $0.containers.contains(action.rawValue) }, considered: \.acceptsBlockAttributes)
        }
    }

    /// Whether `splitListItem` applies at a caret: its paragraph or heading
    /// is in an item of a root list, the last child of that item and not
    /// its first (the new paragraph a Return in the item made).
    func canSplitListItem(in range: NSRange) -> Bool {
        guard range.length == 0, let index = NativeLayout.index(range.location, blocks: blocks) else { return false }
        let block = blocks[index]
        guard block.acceptsBlockAttributes, block.rootContainer == "bulletList" || block.rootContainer == "orderedList" else { return false }
        let first = index == 0 || blocks[index - 1].container != block.container
        return !first && NativeLayout.lastInItem(blocks, at: index)
    }

    /// The horizontal rule (分隔线) holding a UTF-16 location: its one U+FFFC
    /// unit, or the places before and after it.
    func rule(at location: Int) -> NativeBlock? {
        guard let index = NativeLayout.index(location, blocks: blocks), blocks[index].kind == "horizontalRule" else { return nil }
        return blocks[index]
    }

    /// Whether 插入分隔线 applies at a location: an editable block holds it
    /// (the rule goes after its top-level block, or before an empty
    /// top-level paragraph).
    func canInsertRule(at location: Int) -> Bool {
        guard let index = NativeLayout.index(location, blocks: blocks) else { return false }
        return blocks[index].editable
    }

    /// The rule ⌫ (backward) or ⌦ (forward) at a caret removes: the caret
    /// on a rule, at the start of a block right after one, or at the end of
    /// a block right before one.
    func ruleBeside(caret range: NSRange, forward: Bool) -> NativeBlock? {
        guard range.length == 0, let index = NativeLayout.index(range.location, blocks: blocks) else { return nil }
        let block = blocks[index]
        if block.kind == "horizontalRule" { return block }
        if forward {
            guard range.location == NSMaxRange(block.range.nsRange), blocks.indices.contains(index + 1),
                  blocks[index + 1].kind == "horizontalRule" else { return nil }
            return blocks[index + 1]
        }
        guard range.location == block.range.location, index > 0, blocks[index - 1].kind == "horizontalRule" else { return nil }
        return blocks[index - 1]
    }

    /// Why Rust refused 引用 or a list over a range, in Chinese with what to
    /// do instead, read from the blocks the range touches. `reason` is the
    /// core's own (English) refusal.
    func containerRefusal(_ action: NativeFormatAction, in range: NSRange, reason: String) -> String {
        let kept = "正文和选区已保留。"
        guard let indices = blockIndices(touching: range) else { return "当前选区暂时无法设为\(action.title)。" + kept }
        let touched = Array(blocks[indices])
        let list = action != .blockquote
        if touched.contains(where: { !$0.acceptsBlockAttributes }) { return "引用和列表只能用于正文段落和标题。" + kept }
        if list, reason.contains("heading cannot become a list item") {
            return "标题不能设为列表项。可以先把它改为正文（格式 › 正文），再设为列表；引用可以包含标题。" + kept
        }
        if reason.contains("Lift the first or last") {
            return (list ? "只能取消列表开头或结尾的项目，或整个列表；中间的项目不能单独移出。"
                : "只能取消引用开头或结尾的段落，或整段引用；中间的段落不能单独移出。") + kept
        }
        if list, let other = touched.first(where: { $0.listKind != nil && $0.listKind != action.rawValue }) {
            let name = other.listKind == "orderedList" ? "有序列表" : "无序列表"
            return "所选段落在\(name)里。请先取消列表再切换列表类型。" + kept
        }
        if !list, touched.contains(where: { $0.listKind != nil }) { return "列表项不能直接设为引用。请先取消列表，再设为引用。" + kept }
        if list, touched.contains(where: { $0.quoteDepth > 0 }) { return "引用中的段落不能直接设为列表。请先取消引用，再设为列表。" + kept }
        if touched.contains(where: { $0.containers.isEmpty }), touched.contains(where: { !$0.containers.isEmpty }) {
            return "所选段落有的在引用或列表里，有的不在。请只选其中一种再试。" + kept
        }
        if touched.contains(where: { $0.rootContainer == nil && !$0.containers.isEmpty }) {
            return "嵌套的引用或列表暂时不能在这里切换。" + kept
        }
        // An item holding several paragraphs cannot leave its list.
        let crowded = indices.contains { index in
            blocks[index].listDepth > 0 && [index - 1, index + 1].contains {
                blocks.indices.contains($0) && blocks[$0].container == blocks[index].container
            }
        }
        if list, crowded { return "这个列表项有不止一段，暂时不能取消列表。可以先把几段合并成一段。" + kept }
        if reason.contains("consecutive") { return "请选择相邻的段落。" + kept }
        return "当前选区暂时无法设为\(action.title)。" + kept
    }

    /// Whether alignment and indent can apply: every touched block is an
    /// editable paragraph or heading.
    func acceptsBlockAttributes(in range: NSRange) -> Bool {
        guard let indices = blockIndices(touching: range) else { return false }
        return blocks[indices].allSatisfy(\.acceptsBlockAttributes)
    }

    /// The URL link around a character or caret: the contiguous linked runs
    /// of its block (any address), as Rust removes it at a caret.
    func urlLinkRange(around location: Int) -> NSRange? {
        guard let index = NativeLayout.index(location, blocks: blocks) else { return nil }
        let runs = blocks[index].runs
        guard let hit = runs.firstIndex(where: {
            $0.attributes.href != nil && $0.range.location <= location && location <= NSMaxRange($0.range.nsRange)
        }) else { return nil }
        var from = hit, to = hit
        while from > 0, runs[from - 1].attributes.href != nil, NSMaxRange(runs[from - 1].range.nsRange) == runs[from].range.location { from -= 1 }
        while to + 1 < runs.count, runs[to + 1].attributes.href != nil, runs[to + 1].range.location == NSMaxRange(runs[to].range.nsRange) { to += 1 }
        return NSUnionRange(runs[from].range.nsRange, runs[to].range.nsRange)
    }

    /// The first URL link address in a selection, or around a caret.
    func urlLink(in range: NSRange) -> String? {
        if range.length == 0 {
            guard let around = urlLinkRange(around: range.location) else { return nil }
            return run(at: around.location)?.run.attributes.href
        }
        for block in blocks {
            for run in block.runs where run.attributes.href != nil && NSIntersectionRange(run.range.nsRange, range).length > 0 {
                return run.attributes.href
            }
        }
        return nil
    }
}

struct NativeOutlineItem: Decodable, Equatable {
    let blockId: String
    let level: Int
    let text: String
    let parentId: String?
    let range: NativeRange

    var label: String {
        let kind = level == 1 ? "场" : (level == 2 ? "拍" : "注")
        return "\(kind) · \(text)"
    }
}
struct NativeSelection: Decodable {
    let viewId: String
    let epoch: UInt64
    let range: NativeRange?
}
struct NativeSelectionCapture: Decodable {
    let revision: UInt64
    let selection: NativeSelection
}
struct NativeComment: Decodable, Equatable {
    let id: String
    let quote: String
    let status: String
    let ranges: [NativeRange]

    var summary: String {
        let state: String
        switch status {
        case "anchored", "whole-block": state = "已定位"
        case "changed": state = "引文已变化"
        case "collapsed": state = "原文已删除"
        default: state = "暂未定位"
        }
        return quote.isEmpty ? "段落评论 · \(state)" : "评论「\(quote)」· \(state)"
    }
}
struct NativeRemoteBlock: Decodable {
    let updateId: Int64
    let reason: String

    var userMessage: String {
        if reason.hasPrefix("REMOTE_TEXT_RETENTION_REQUIRED") {
            return "这条远端修改涉及已合并的段落，需要先恢复对应关系"
        }
        return "当前版本暂时无法应用这条远端更新"
    }
}
struct LabDocumentState: Decodable {
    let projection: NativeProjection
    let saved: Bool
    let saveError: String?
    let remoteBlock: NativeRemoteBlock?
}

struct NativeTextChange {
    let range: NSRange
    let text: String
    let target: String

    /// Scalar boundaries keep NSRange in UTF-16 without splitting a surrogate.
    static func between(_ before: String, _ after: String) -> NativeTextChange? {
        if NativeText.identical(before, after) { return nil }
        let old = Array(before.unicodeScalars), new = Array(after.unicodeScalars)
        var prefix = 0, suffix = 0
        while prefix < min(old.count, new.count), old[prefix] == new[prefix] { prefix += 1 }
        while suffix < min(old.count, new.count) - prefix,
              old[old.count - suffix - 1] == new[new.count - suffix - 1] { suffix += 1 }
        let start = old.prefix(prefix).reduce(0) { $0 + $1.utf16.count }
        let length = old[prefix..<(old.count - suffix)].reduce(0) { $0 + $1.utf16.count }
        let replacement = String(String.UnicodeScalarView(new[prefix..<(new.count - suffix)]))
        return NativeTextChange(range: NSRange(location: start, length: length), text: replacement, target: after)
    }
}

/// A view keeps its own composition draft. The store owns committed input,
/// persistence and history; detaching a view never closes the Rust document.
final class DocumentBinding {
    let store: DocumentStore
    let viewID = UUID().uuidString
    private var selectionRange = NSRange(location: 0, length: 0)
    private var selectionEpoch: UInt64 = 1
    private var capturedEpoch: UInt64 = 0
    private var captureInFlight = false
    private var captureAttempt: (epoch: UInt64, revision: UInt64)?
    private var localText = ""
    private var displayedProjection: NativeProjection?
    private var localBlocks: [NativeBlock] = []
    private(set) var inputKey: String?
    private(set) var compositionParent: String?
    private var composing = false
    private var failed = false
    private var attached = true
    private var preparedInput: NativeTextChange?
    private var compositionRange: NSRange?
    var onProjection: ((NativeProjection, [NativeTextChange]) -> Void)?
    var onStatus: ((String) -> Void)?
    var onActivity: ((Bool) -> Void)?
    /// A background link pass added links to this owner's prose.
    var onEntityLinks: (() -> Void)?
    var state: LabDocumentState? { store.state }
    var hasUnsubmittedDraft: Bool { composing || failed }
    /// Marked text of an input method that is not committed yet.
    var isComposing: Bool { composing }
    var hasFailedDraft: Bool { failed }
    var hasPendingWork: Bool { store.hasPendingWork }
    var canEdit: Bool { attached && store.canEdit && !failed }
    /// The text and blocks this view shows, including its own input still
    /// on its way to Rust (display hints only).
    var displayedText: String { localText }
    var displayedBlocks: [NativeBlock] { localBlocks }
    var hasRemoteBlock: Bool { store.remoteBlock != nil }
    var selectionIsAnchored: Bool { capturedEpoch == selectionEpoch }

    func showStatus(_ message: String) { onStatus?(store.remoteBlockStatus ?? message) }

    init(core: LabCore) {
        store = core.documentStore()
        store.attach(self)
    }

    func load() {
        guard attached else { return }
        if let message = store.remoteBlockStatus {
            if !hasUnsubmittedDraft, let displayedProjection { onProjection?(displayedProjection, []) }
            showStatus(message); store.activity(); return
        }
        guard !hasUnsubmittedDraft else {
            if failed && !composing, let displayedProjection { onProjection?(displayedProjection, []) }
            showStatus("窗口草稿尚未提交，请先复制草稿以便恢复"); return
        }
        if let projection = store.projection { receive(projection, changes: []) }
        store.load()
    }

    func allows(_ range: NSRange, replacement: String, marked: Bool) -> Bool {
        guard canEdit else { return false }
        if marked { return true }
        if let error = NativeLayout.rejection(blocks: localBlocks, range: range, text: replacement) {
            showStatus(error); return false
        }
        return true
    }

    /// TextKit's actual range is authoritative. A string diff is ambiguous for
    /// repeated characters and would delete the wrong CRDT items/marks.
    func prepareInput(_ range: NSRange, replacement: String, marked: Bool) -> Bool {
        guard allows(range, replacement: replacement, marked: marked) else { return false }
        if !composing, range.location <= (localText as NSString).length,
           range.length <= (localText as NSString).length - range.location {
            preparedInput = NativeTextChange(range: range, text: replacement,
                target: (localText as NSString).replacingCharacters(in: range, with: replacement))
        }
        return true
    }

    private func committedComposition(_ text: String, range: NSRange) -> NativeTextChange? {
        let before = localText as NSString, after = text as NSString
        let suffixLength = before.length - NSMaxRange(range)
        guard after.length >= range.location + suffixLength,
              NativeText.identical(after.substring(to: range.location), before.substring(to: range.location)),
              NativeText.identical(after.substring(from: after.length - suffixLength), before.substring(from: NSMaxRange(range))) else { return nil }
        return NativeTextChange(range: range,
            text: after.substring(with: NSRange(location: range.location, length: after.length - range.location - suffixLength)), target: text)
    }

    func changed(_ text: String, marked: Bool) {
        guard attached, !failed else { return }
        if hasRemoteBlock {
            // A remote reply can arrive between marked-text callbacks. Keep
            // that text in the view without committing or cancelling its fork.
            preparedInput = nil
            if composing || marked || !NativeText.identical(text, localText) {
                composing = marked; failed = !marked
            }
            store.activity(); return
        }
        let wasComposing = composing
        if marked && !wasComposing {
            compositionRange = preparedInput?.range ?? NativeTextChange.between(localText, text)?.range
            preparedInput = nil
            compositionParent = store.beginComposition(self)
            guard compositionParent != nil else { rejectInput("无法建立输入副本"); return }
        }
        composing = marked
        if marked { store.activity(); return }
        let proposed: NativeTextChange?
        if wasComposing, NativeText.identical(text, localText) { proposed = nil }
        else if wasComposing, let range = compositionRange {
            guard let committed = committedComposition(text, range: range) else {
                failed = true; showStatus("输入法替换范围发生变化，窗口草稿仍然保留。请先复制草稿以便恢复。")
                store.activity(); return
            }
            proposed = committed
        } else if let preparedInput, NativeText.identical(preparedInput.target, text) { proposed = preparedInput }
        else { proposed = NativeTextChange.between(localText, text) }
        compositionRange = nil
        preparedInput = nil
        guard let change = proposed else {
            if wasComposing { store.cancelComposition(self, parent: compositionParent) }
            compositionParent = nil; store.activity(); return
        }
        selectionEpoch += 1
        guard store.submit(change, origin: self,
            selection: DraftSelection(viewID: viewID, epoch: selectionEpoch, range: selectionRange)) else {
            failed = true; store.activity(); return
        }
        compositionParent = nil
    }

    func useInput(_ key: String) { inputKey = key }
    func adopt(_ key: String, projection: NativeProjection) {
        let changes = inputKey == nil ? [] : (NativeTextChange.between(localText, projection.text).map { [$0] } ?? [])
        inputKey = key
        receive(projection, changes: changes)
    }
    func rejectInput(_ message: String) {
        failed = true
        showStatus(message + "。窗口草稿仍然保留，请先复制草稿以便恢复。")
        store.activity()
    }

    func receive(_ projection: NativeProjection, changes: [NativeTextChange], authoritative: Bool = true) {
        guard attached else { return }
        if composing || failed { return }
        if authoritative && !captureInFlight && capturedEpoch == selectionEpoch
            && !projection.selections.contains(where: { $0.viewId == viewID }) {
            capturedEpoch = 0; captureAttempt = nil
        }
        localText = projection.text; localBlocks = projection.blocks; displayedProjection = projection
        onProjection?(projection, changes)
    }

    func selectionChanged(_ range: NSRange, text: String, marked: Bool) {
        guard attached else { return }
        if selectionRange != range {
            selectionRange = range; selectionEpoch += 1
        }
        if !marked, let projection = selectionCaptureCandidate,
           NativeText.identical(text, projection.text) { captureSelection() }
    }

    func displayedSelection(_ range: NSRange) { selectionRange = range }

    func resolvedSelection(in projection: NativeProjection) -> NSRange? {
        projection.selections.first { $0.viewId == viewID && $0.epoch == selectionEpoch }?.range?.nsRange
    }

    private var selectionCaptureCandidate: NativeProjection? {
        guard attached, !hasUnsubmittedDraft, !store.hasPendingCommits, !captureInFlight,
              capturedEpoch != selectionEpoch, let projection = store.projection,
              captureAttempt?.epoch != selectionEpoch || captureAttempt?.revision != projection.revision else { return nil }
        return projection
    }

    func captureSelection() {
        guard let projection = selectionCaptureCandidate else { return }
        let epoch = selectionEpoch, revision = projection.revision
        captureAttempt = (epoch, revision); captureInFlight = true
        store.captureSelection(viewID: viewID, epoch: epoch, revision: revision, range: selectionRange) { [weak self] result in
            guard let self else { return }
            self.captureInFlight = false
            if self.attached, self.selectionEpoch == epoch, case .success = result { self.capturedEpoch = epoch }
            self.captureSelection()
        }
    }

    func history(redo: Bool) { store.history(redo: redo) }
    /// The projection a command may use: the owner is idle and the range lies
    /// in its text. Pending input, drafts and recovery guard every command.
    private func commandProjection(_ range: NSRange) -> NativeProjection? {
        guard canEdit, !hasPendingWork, !hasUnsubmittedDraft, let projection = store.projection,
              range.location >= 0, range.length >= 0,
              range.location <= (projection.text as NSString).length,
              range.length <= (projection.text as NSString).length - range.location else { return nil }
        return projection
    }
    func canFormat(_ action: NativeFormatAction, range: NSRange) -> Bool {
        guard let projection = commandProjection(range) else { return false }
        if action == .splitListItem { return projection.canSplitListItem(in: range) }
        if action.isBlockAttribute || action.isContainer { return projection.acceptsBlockAttributes(in: range) }
        return !action.requiresSelection || range.length > 0
    }

    /// 插入分隔线 at the end of a range: after its top-level block, or before
    /// an empty top-level paragraph.
    func canInsertRule(range: NSRange) -> Bool {
        commandProjection(range)?.canInsertRule(at: NSMaxRange(range)) == true
    }
    func insertRule(range: NSRange, completion: ((Result<Int, Error>) -> Void)? = nil) {
        guard canInsertRule(range: range), let projection = store.projection else {
            completion?(.failure(LabError.message("请先完成输入，并等待正文保存后再插入分隔线。"))); return
        }
        selectionChanged(range, text: projection.text, marked: false)
        store.rule("insert", location: NSMaxRange(range), revision: projection.revision, completion: completion)
    }
    /// The rule the idle owner's projection has at a location, which
    /// 删除分隔线 removes.
    func removableRule(at location: Int) -> NativeBlock? {
        guard let projection = commandProjection(NSRange(location: location, length: 0)) else { return nil }
        return projection.rule(at: location)
    }
    func removeRule(at location: Int, completion: ((Result<Int, Error>) -> Void)? = nil) {
        guard let rule = removableRule(at: location), let projection = store.projection else {
            completion?(.failure(LabError.message("请先完成输入，并等待正文保存后再删除分隔线。"))); return
        }
        store.rule("remove", location: rule.range.location, revision: projection.revision, completion: completion)
    }
    func format(_ action: NativeFormatAction, range: NSRange) {
        guard canFormat(action, range: range), let projection = store.projection else { return }
        selectionChanged(range, text: projection.text, marked: false)
        store.format(action, range: range, revision: projection.revision)
    }
    /// Checkmarks: how much of the selection has the format (display only).
    func formatState(_ action: NativeFormatAction, range: NSRange) -> NativeFormatState {
        store.projection?.formatState(action, in: range) ?? .off
    }

    /// Setting a URL link needs selected text; removing one needs a link in
    /// the selection or around the caret.
    func canLink(range: NSRange) -> Bool { commandProjection(range) != nil && range.length > 0 }
    func canRemoveLink(range: NSRange) -> Bool { commandProjection(range)?.urlLink(in: range) != nil }
    /// Sets (`href`) or removes (nil) the URL link of the range; the reply
    /// reports nil or the refusal. Rust validates the address.
    func link(range: NSRange, href: String?, completion: ((Error?) -> Void)? = nil) {
        guard href == nil ? canRemoveLink(range: range) : canLink(range: range), let projection = store.projection else {
            completion?(LabError.message("请先完成输入，并等待正文保存后再设置链接。")); return
        }
        selectionChanged(range, text: projection.text, marked: false)
        store.link(range: range, href: href, revision: projection.revision, completion: completion)
    }

    /// A comment needs non-blank text in the authoritative display. Rust trims
    /// surrounding whitespace and validates the anchor against the revision.
    func canComment(range: NSRange) -> Bool {
        guard canEdit, !hasPendingWork, !hasUnsubmittedDraft, let projection = store.projection,
              NativeText.identical(localText, projection.text), range.location >= 0, range.length > 0,
              range.location <= (projection.text as NSString).length,
              range.length <= (projection.text as NSString).length - range.location else { return false }
        return !(projection.text as NSString).substring(with: range).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    func addComment(_ body: String, range: NSRange, revision: UInt64,
                    completion: @escaping (Result<WorkspaceComment, Error>) -> Void) {
        guard attached, !hasUnsubmittedDraft else {
            completion(.failure(LabError.message("请先完成输入，再添加批注。"))); return
        }
        store.createComment(range: range, revision: revision, body: body, completion: completion)
    }

    /// This is a display hint only; Rust decides which blocks a command edits.
    func blockFormat(at range: NSRange) -> NativeFormatAction? {
        guard let projection = store.projection,
              let index = NativeLayout.index(range.location, blocks: projection.blocks) else { return nil }
        let block = projection.blocks[index]
        if block.kind == "paragraph" { return .paragraph }
        guard block.kind == "heading" else { return nil }
        return NativeFormatAction.blocks.first { $0.rawValue == "heading\(block.headingLevel)" }
    }
    func retrySave() { store.retrySave() }

    /// Called only by the explicit recovery action after a rejected draft.
    func discardDraft() {
        guard !hasRemoteBlock else { store.activity(); return }
        guard failed else { return }
        failed = false; composing = false; preparedInput = nil; compositionRange = nil; compositionParent = nil
        store.discardDraft(self)
        showStatus(store.hasPendingCommits ? "正在保存正文…" : "正文已保存")
        store.activity()
    }

    @discardableResult
    func detach() -> Bool {
        guard !hasUnsubmittedDraft else { return false }
        attached = false; store.detach(self)
        return true
    }
}
