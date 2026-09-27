import Foundation

/// A direct chapter comment row as the shared Rust workspace store returns it.
/// Review state (`status`) is business data; anchor placement comes separately
/// from the live projection and is never inferred from this row.
struct WorkspaceComment: Decodable, Equatable {
    let id: String
    let projectId: String
    let kind: String
    let targetKind: String?
    let targetId: String?
    let targetBlockId: String?
    let anchorJson: String
    let authorKind: String
    let authorId: String?
    let authorName: String?
    let bodyJson: String
    let status: String
    let priority: String?
    let source: String
    let metadataJson: String?
    let targetBlockIdsJson: String
    let resolvedAt: String?
    let createdAt: String
    let updatedAt: String

    var review: CommentReviewStatus { CommentReviewStatus(rawValue: status) ?? .other }
    var bodyText: String { CommentBody.text(fromJSON: bodyJson) }
    /// Only author-written notes are editable here; generated rows stay read-only.
    var canEditBody: Bool { source == "manual" }
    /// Converted suggestions are terminal, as in the desktop review flow.
    var canChangeResolution: Bool { review == .open || review == .resolved }
    /// The quote captured at creation. The live anchor quote takes precedence.
    var selectedText: String {
        guard let data = anchorJson.data(using: .utf8),
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return "" }
        return payload["selectedText"] as? String ?? ""
    }
}

/// Open/resolved review state of a comment row.
enum CommentReviewStatus: String {
    case open, resolved, converted, other

    var label: String {
        switch self {
        case .open: return "未解决"
        case .resolved: return "已解决"
        case .converted: return "已转化"
        case .other: return "状态未知"
        }
    }
}

/// Placement of a comment's anchor in the current projection. It is distinct
/// from review state: a resolved comment can still be anchored, and an open one
/// can have lost its original text.
enum CommentAnchorStatus: String {
    case anchored, changed, collapsed, wholeBlock = "whole-block", unresolved

    var label: String {
        switch self {
        case .anchored: return "已定位"
        case .changed: return "原文已改动"
        case .collapsed: return "原文已删除"
        case .unresolved: return "未能定位"
        case .wholeBlock: return "整段"
        }
    }
}

extension NativeComment {
    var anchorStatus: CommentAnchorStatus { CommentAnchorStatus(rawValue: status) ?? .unresolved }

    /// The current span to select, or nil when the anchor has no visible text.
    var locatableRange: NativeRange? {
        let ranges = self.ranges.filter { $0.location >= 0 && $0.length > 0 }
        guard let start = ranges.map(\.location).min(),
              let end = ranges.map({ $0.location + $0.length }).max(), end > start else { return nil }
        return NativeRange(location: start, length: end - start)
    }
}

/// Port of the renderer's `extractTextFromCommentBody`, except that blocks are
/// separated by a blank line so an edited body round-trips through the core's
/// `createPlainCommentDoc` paragraph split.
enum CommentBody {
    static func text(fromJSON json: String) -> String {
        guard let data = json.data(using: .utf8), let root = try? JSONSerialization.jsonObject(with: data) else { return "" }
        var chunks: [String] = []
        func visit(_ node: Any) {
            guard let record = node as? [String: Any] else { return }
            if let text = record["text"] as? String { chunks.append(text) }
            if let content = record["content"] as? [Any] { content.forEach(visit) }
            if let type = record["type"] as? String, ["paragraph", "heading", "blockquote"].contains(type) {
                chunks.append("\n\n")
            }
        }
        visit(root)
        return chunks.joined()
            .replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct WorkspaceCommentList: Decodable { let comments: [WorkspaceComment] }
struct WorkspaceCommentReply: Decodable { let comment: WorkspaceComment }
struct WorkspaceCommentCreation: Decodable {
    let comment: WorkspaceComment
    let state: LabDocumentState
}

/// One listed row: the SQLite comment joined with its live anchor view.
struct ChapterCommentEntry {
    let comment: WorkspaceComment
    let anchor: NativeComment?

    var id: String { comment.id }
    /// A note or TODO on the whole chapter (written in 审阅), without a passage.
    var isWholePage: Bool { comment.targetBlockId == nil }
    var anchorStatus: CommentAnchorStatus { anchor?.anchorStatus ?? .unresolved }
    var quote: String {
        if let quote = anchor?.quote, !quote.isEmpty { return quote }
        return comment.selectedText
    }
    var canLocate: Bool { anchor?.locatableRange != nil }
}

/// Presentation state for the comments of one chapter owner. Commands go
/// through that owner's DocumentStore queue and guards; this model never
/// edits prose or anchors itself.
final class ChapterCommentsModel {
    private(set) weak var store: DocumentStore?
    private(set) var comments: [WorkspaceComment] = []
    private(set) var anchors: [NativeComment] = []
    private(set) var busy = false
    private(set) var status = "打开章节后查看批注。"
    private var generation = 0
    private var loading = false
    private var listedAnchorIDs: Set<String> = []
    var showResolved = false {
        didSet { guard oldValue != showResolved else { return }; summarize(); onChange?() }
    }
    var onChange: (() -> Void)?
    /// A body or resolution change was stored; 审阅 reads the rows again.
    var onCommitted: ((WorkspaceComment) -> Void)?

    var entries: [ChapterCommentEntry] {
        comments.filter { showResolved || $0.review != .resolved }.map { comment in
            ChapterCommentEntry(comment: comment, anchor: anchors.first { $0.id == comment.id })
        }
    }

    /// Follow the active pane's chapter owner. The same owner keeps its rows.
    func bind(_ store: DocumentStore?) {
        precondition(Thread.isMainThread)
        if let store, store === self.store { updateAnchors(from: store); return }
        self.store = store
        comments = []; anchors = store?.projection?.comments ?? []; listedAnchorIDs = []
        reload()
    }

    /// Read the owner's rows again. A command's own message replaces the
    /// loading state, so the list stays visible while it refreshes.
    func reload(after message: String? = nil) {
        precondition(Thread.isMainThread)
        generation += 1
        let request = generation
        guard let store else {
            comments = []; anchors = []; busy = false; loading = false; status = "打开章节后查看批注。"; onChange?(); return
        }
        loading = true
        if message == nil { busy = true; status = "正在读取批注…"; onChange?() }
        let requested = Set((store.projection?.comments ?? anchors).map(\.id))
        store.comments { [weak self, weak store] result in
            guard let self, let store, self.generation == request, store === self.store else { return }
            // Also on failure: a refused read is not retried for the same set.
            self.busy = false; self.loading = false; self.listedAnchorIDs = requested
            switch result {
            case .success(let comments):
                self.comments = comments
                self.anchors = store.projection?.comments ?? self.anchors
                self.summarize()
                if let message { self.status = message + " " + self.status }
            case .failure(let error): self.status = error.localizedDescription
            }
            self.onChange?()
            // Anchors that arrived while this read was queued may name a row
            // committed after it; read once more for that new identity set.
            self.updateAnchors(from: store)
        }
    }

    /// Adopt the owner's current anchor views. A new anchor identity means a
    /// row was added elsewhere (another pane or a received original).
    func updateAnchors(from store: DocumentStore) {
        precondition(Thread.isMainThread)
        guard store === self.store, let current = store.projection?.comments else { return }
        let ids = Set(current.map(\.id))
        if !loading, ids != listedAnchorIDs, !ids.isSubset(of: Set(comments.map(\.id))) {
            reload(); return
        }
        guard current != anchors else { return }
        // Typing shifts ranges on every keystroke; the list shows only
        // placement, quote and whether locating is possible.
        let visible = Self.display(current) != Self.display(anchors)
        anchors = current
        if visible { onChange?() }
    }

    private static func display(_ anchors: [NativeComment]) -> [String: String] {
        Dictionary(anchors.map { ($0.id, "\($0.status)\u{1f}\($0.quote)\u{1f}\($0.locatableRange != nil)") }) { first, _ in first }
    }

    func updateBody(_ id: String, body: String, completion: @escaping (Result<WorkspaceComment, Error>) -> Void) {
        guard let store else { completion(.failure(LabError.message("请先打开章节。"))); return }
        guard comments.first(where: { $0.id == id })?.canEditBody != false else {
            completion(.failure(LabError.message("这条批注来自其他来源，只能查看。"))); return
        }
        store.updateCommentBody(id: id, body: body) { [weak self] result in
            self?.received(result, message: "批注已保存。")
            completion(result)
        }
    }

    func setResolved(_ id: String, resolved: Bool, completion: @escaping (Result<WorkspaceComment, Error>) -> Void) {
        guard let store else { completion(.failure(LabError.message("请先打开章节。"))); return }
        guard comments.first(where: { $0.id == id })?.canChangeResolution != false else {
            completion(.failure(LabError.message("已转化的建议不能解决或重新打开。"))); return
        }
        store.setCommentResolved(id: id, resolved: resolved) { [weak self] result in
            self?.received(result, message: resolved ? "批注已解决。" : "批注已重新打开。")
            completion(result)
        }
    }

    func showStatus(_ message: String) { status = message; onChange?() }

    private func received(_ result: Result<WorkspaceComment, Error>, message: String) {
        switch result {
        case .success(let comment):
            if let index = comments.firstIndex(where: { $0.id == comment.id }) { comments[index] = comment }
            summarize(); status = message + " " + status; onChange?()
            onCommitted?(comment)
            reload(after: message)
        case .failure(let error): showStatus(error.localizedDescription)
        }
    }

    private func summarize() {
        let resolved = comments.filter { $0.review == .resolved }.count
        if comments.isEmpty { status = "这一章还没有批注。选中文字后可以添加批注。"; return }
        status = "共 \(comments.count) 条批注"
        if resolved > 0 { status += showResolved ? "，其中 \(resolved) 条已解决" : "，已隐藏 \(resolved) 条已解决" }
        status += "。"
    }
}
