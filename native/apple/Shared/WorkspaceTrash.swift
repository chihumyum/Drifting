import Foundation

/// The kinds of content one project's 回收站 holds. `unknown` is a kind
/// Rust lists that this client does not know: it is shown as 未知类型,
/// cannot be restored or purged alone here, and stays in the confirmed set
/// of 清空回收站, so emptying never leaves Rust's check blind to it.
enum WorkspaceTrashKind: String, CaseIterable {
    case chapter, drift, element, category, storyline
    case unknown = "__unknown__"

    /// The kinds this client restores and filters by; `unknown` is not one.
    static var allCases: [WorkspaceTrashKind] { [.chapter, .drift, .element, .category, .storyline] }

    var label: String {
        switch self {
        case .chapter: return "章节"
        case .drift: return "漂流"
        case .element: return "设定"
        case .category: return "分类"
        case .storyline: return "故事线"
        case .unknown: return "未知类型"
        }
    }

    /// “个章节”, “条漂流” … after a count.
    var counted: String {
        switch self {
        case .chapter: return "个章节"
        case .drift: return "条漂流"
        case .element: return "个设定"
        case .category: return "个分类"
        case .storyline: return "条故事线"
        case .unknown: return "项未知类型的内容"
        }
    }

    /// What 彻底删除 removes with an item of this kind, as Rust purges it.
    var purgedWithIt: String {
        switch self {
        case .chapter, .drift: return "它的正文和历史版本，以及写在它上面的批注与待办"
        case .element: return "它的字段、补丁、正文和历史版本，以及写在它上面的批注与待办"
        case .category: return "它的模板字段、正文和历史版本，以及写在它上面的批注与待办"
        case .storyline: return "它的字段、正文和历史版本，以及写在它上面的批注与待办"
        case .unknown: return "它的全部内容"
        }
    }
}

/// One trashed entity as `workspaceTrash` lists it: its kind, title and
/// when it entered the trash (its `deleted_at`). `rawKind` is Rust's kind
/// string, kept for a kind this client does not know.
struct WorkspaceTrashItem: Equatable {
    let kind: WorkspaceTrashKind
    let rawKind: String
    let id: String
    let title: String
    let trashedAt: String

    init(kind: WorkspaceTrashKind, id: String, title: String, trashedAt: String, rawKind: String? = nil) {
        self.kind = kind; self.id = id; self.title = title; self.trashedAt = trashedAt
        self.rawKind = rawKind ?? kind.rawValue
    }

    var key: String { "\(rawKind):\(id)" }
    /// The `{kind, id}` Rust's 清空回收站 compares.
    var confirmedKey: [String: String] { ["kind": rawKind, "id": id] }
    var displayTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "未命名" : title }
    var trashedDate: Date? { WorkspaceTrashText.date(trashedAt) }
}

/// A row of Rust's trash listing. A kind this client does not know is
/// listed as 未知类型 and stays in the confirmed set of 清空回收站, so
/// Rust's check still sees it.
struct WorkspaceTrashEntry: Decodable, Equatable {
    let kind: String
    let id: String
    let title: String
    let trashedAt: String

    var item: WorkspaceTrashItem {
        let known = WorkspaceTrashKind.allCases.first { $0.rawValue == kind } ?? .unknown
        return WorkspaceTrashItem(kind: known, id: id, title: title, trashedAt: trashedAt, rawKind: kind)
    }
}

/// `workspaceTrash`: the project's trash, newest first by trash time.
struct WorkspaceTrashListing: Decodable, Equatable {
    let trashed: [WorkspaceTrashEntry]
}

/// A library or chapter list that names trashed content, as it reaches the
/// tab host from any command.
enum WorkspaceTrashSource {
    case elements(WorkspaceElementLibrary)
    case chapters(live: [WorkspaceChapter], trashed: [WorkspaceChapter])
    case drifts(WorkspaceDriftLibrary)
    case storylines(WorkspaceStorylineLibrary)

    /// The kinds whose trashed rows it names.
    var kinds: [WorkspaceTrashKind] {
        switch self {
        case .elements: return [.element, .category]
        case .chapters: return [.chapter]
        case .drifts: return [.drift]
        case .storylines: return [.storyline]
        }
    }
}

/// `workspacePurgeTrashed` / `workspaceEmptyTrash`: what was purged (with
/// its body's document identity) and the project's trash after it, listed
/// as `workspaceTrash` lists it.
struct WorkspaceTrashPurgeReply: Decodable, Equatable {
    struct Purged: Decodable, Equatable {
        let kind: String
        let id: String
        let documentId: String
    }
    let purged: [Purged]
    let trashed: [WorkspaceTrashEntry]
}

enum WorkspaceTrashText {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let whole = ISO8601DateFormatter()
    private static let display: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter
    }()

    static func date(_ iso: String) -> Date? { fractional.date(from: iso) ?? whole.date(from: iso) }

    /// “2026-09-28 14:05” in local time, or the stored text when unreadable.
    static func time(_ item: WorkspaceTrashItem) -> String {
        item.trashedDate.map { display.string(from: $0) } ?? item.trashedAt
    }

    /// “1 个章节、2 个设定”, in kind order, unknown kinds last; kinds
    /// without items are left out.
    static func counts(_ items: [WorkspaceTrashItem]) -> String {
        (WorkspaceTrashKind.allCases + [.unknown]).compactMap { kind in
            let count = items.filter { $0.kind == kind }.count
            return count > 0 ? "\(count) \(kind.counted)" : nil
        }.joined(separator: "、")
    }

    static func purgeQuestion(_ item: WorkspaceTrashItem) -> String {
        "彻底删除\(item.kind.label)“\(item.displayTitle)”？"
    }

    static func purgeDetail(_ item: WorkspaceTrashItem) -> String {
        "\(item.kind.purgedWithIt)会一起永久删除，无法恢复。其他正文里指向它的链接会变为普通文字，正文本身不会改写。"
    }

    static let emptyQuestion = "清空回收站？"

    /// Restore or purge of an item of a kind this client does not know.
    static let unknownRefusal = "这一项是当前版本不认识的类型，不能单独恢复或彻底删除；清空回收站时会一并删除。"

    static func emptyDetail(_ items: [WorkspaceTrashItem]) -> String {
        "将永久删除回收站中的全部 \(items.count) 项：\(counts(items))，连同它们的字段、补丁、正文、历史版本和写在上面的批注与待办，无法恢复。"
    }
}

/// One project's 回收站: every trashed chapter, drift, element, category
/// and storyline, newest first by the time it was trashed, with a kind
/// filter. Rust owns the list (`workspaceTrash`): a library or chapter list
/// that arrives from elsewhere reads it again, and a purge's reply replaces
/// it. While a read has failed, 清空回收站 waits and the status names the
/// kinds that could not be read.
final class WorkspaceTrashModel {
    let projectID: String
    private(set) var items: [WorkspaceTrashItem] = []
    private(set) var loaded = false
    private(set) var busy = false
    /// The kinds whose last read failed and why; nil once a read succeeds.
    private(set) var unread: (kinds: [WorkspaceTrashKind], reason: String)?
    /// An action's message, shown until the next action; nil shows the summary.
    private var message: String?
    /// Nil shows every kind.
    var filter: WorkspaceTrashKind? { didSet { if filter != oldValue { onChange?() } } }
    var onChange: (() -> Void)?
    /// Reads Rust's listing; acceptance replaces it to make a read fail.
    var read: (@escaping (Result<[WorkspaceTrashEntry], Error>) -> Void) -> Void
    /// Reads sent, for acceptance.
    private(set) var reads = 0
    private var reading = false
    /// Kinds asked for while a read was in flight; read once more after it.
    private var queued: Set<WorkspaceTrashKind> = []

    init(workspace: LabWorkspaceCore, projectID: String) {
        self.projectID = projectID
        read = { [weak workspace] done in
            guard let workspace else { done(.failure(LabError.message("工作区已关闭，请重新打开后再试。"))); return }
            workspace.trash(projectID: projectID) { done($0.map(\.trashed)) }
        }
    }

    /// The items the filter shows, newest first.
    var shown: [WorkspaceTrashItem] { filter.map { kind in items.filter { $0.kind == kind } } ?? items }

    func count(_ kind: WorkspaceTrashKind) -> Int { items.filter { $0.kind == kind }.count }

    /// 清空回收站 is offered only for a list read completely.
    var canEmpty: Bool { loaded && unread == nil && !items.isEmpty }

    /// The action's message, the failed read, or the count summary.
    var status: String {
        if let unread {
            let names = unread.kinds.map(\.label)
            let kinds = names.count > 1 ? names.dropLast().joined(separator: "、") + "和" + names.last! : names.joined()
            let reason = unread.reason.hasSuffix("。") ? unread.reason : unread.reason + "。"
            let failure = "无法读取回收站中的\(kinds)：\(reason)列表可能不完整，清空回收站已停用，可以稍后重新打开回收站。"
            return [message, failure].compactMap { $0 }.joined(separator: " ")
        }
        return message ?? (loaded ? summary : "正在读取回收站…")
    }

    func showStatus(_ message: String) { self.message = message; onChange?() }

    func setBusy(_ value: Bool) { busy = value; onChange?() }

    /// Reads the whole trash.
    func load() { refresh(WorkspaceTrashKind.allCases) }

    /// A library or chapter list naming trashed content arrived elsewhere,
    /// e.g. after a trash in the 设定库 or a restore here: the list is read
    /// again. A read in flight is followed by one more.
    func apply(_ source: WorkspaceTrashSource) { refresh(source.kinds) }

    private func refresh(_ kinds: [WorkspaceTrashKind]) {
        queued.formUnion(kinds)
        guard !reading else { return }
        let asked = queued
        queued = []
        reading = true
        reads += 1
        read { [weak self] result in
            guard let self else { return }
            self.reading = false
            switch result {
            case .success(let entries):
                self.adopt(entries)
            case .failure(let error):
                let kinds = asked.union(self.unread?.kinds ?? [])
                self.unread = (WorkspaceTrashKind.allCases.filter(kinds.contains), error.localizedDescription)
            }
            self.loaded = true
            self.onChange?()
            if !self.queued.isEmpty { self.refresh([]) }
        }
    }

    /// Keeps exactly the list a purge or 清空回收站 replied with.
    func adopt(_ reply: WorkspaceTrashPurgeReply) {
        adopt(reply.trashed)
        onChange?()
    }

    /// A complete listing, in Rust's order (newest trash first).
    private func adopt(_ entries: [WorkspaceTrashEntry]) {
        items = entries.map(\.item)
        unread = nil
    }

    /// “回收站中有 3 项：…” or the empty notice.
    var summary: String {
        items.isEmpty ? "回收站是空的。移到回收站的章节、漂流、设定、分类和故事线会列在这里。"
            : "回收站中有 \(items.count) 项：\(WorkspaceTrashText.counts(items))。恢复后可以从原来的列表打开。"
    }
}
