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
    case bold, italic, paragraph, heading1, heading2, heading3

    var requiresSelection: Bool { self == .bold || self == .italic }
    var title: String {
        switch self {
        case .bold: return "加粗"
        case .italic: return "斜体"
        case .paragraph: return "正文"
        case .heading1: return "标题 1"
        case .heading2: return "标题 2"
        case .heading3: return "标题 3"
        }
    }
    var accessibilityID: String { "format-\(rawValue)" }
    static let blocks: [NativeFormatAction] = [.paragraph, .heading1, .heading2, .heading3]
}

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
struct NativeBlockAttributes: Decodable {
    let level: Int?
    private enum CodingKeys: String, CodingKey { case level }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        // Unknown attribute payloads remain in Rust; a display hint must not
        // prevent opening a document whose metadata this view cannot render.
        level = try? values.decode(Int.self, forKey: .level)
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
    var headingLevel: Int { attributes?.level ?? 1 }
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
    var hasFailedDraft: Bool { failed }
    var hasPendingWork: Bool { store.hasPendingWork }
    var canEdit: Bool { attached && store.canEdit && !failed }
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
    func canFormat(_ action: NativeFormatAction, range: NSRange) -> Bool {
        guard canEdit, !hasPendingWork, !hasUnsubmittedDraft, let projection = store.projection,
              range.location >= 0, range.length >= 0,
              range.location <= (projection.text as NSString).length,
              range.length <= (projection.text as NSString).length - range.location else { return false }
        return !action.requiresSelection || range.length > 0
    }
    func format(_ action: NativeFormatAction, range: NSRange) {
        guard canFormat(action, range: range), let projection = store.projection else { return }
        selectionChanged(range, text: projection.text, marked: false)
        store.format(action, range: range, revision: projection.revision)
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
