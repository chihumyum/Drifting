import Foundation

/// The kinds of content one project's 回收站 holds.
enum WorkspaceTrashKind: String, CaseIterable {
    case chapter, drift, element, category, storyline

    var label: String {
        switch self {
        case .chapter: return "章节"
        case .drift: return "漂流"
        case .element: return "设定"
        case .category: return "分类"
        case .storyline: return "故事线"
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
        }
    }

    /// What 彻底删除 removes with an item of this kind, as Rust purges it.
    var purgedWithIt: String {
        switch self {
        case .chapter, .drift: return "它的正文和历史版本，以及写在它上面的批注与待办"
        case .element: return "它的字段、补丁、正文和历史版本，以及写在它上面的批注与待办"
        case .category: return "它的模板字段、正文和历史版本，以及写在它上面的批注与待办"
        case .storyline: return "它的字段、正文和历史版本，以及写在它上面的批注与待办"
        }
    }
}

/// One trashed entity: its kind, title and when it was trashed (trash
/// stamps `updated_at` with `deleted_at`).
struct WorkspaceTrashItem: Equatable {
    let kind: WorkspaceTrashKind
    let id: String
    let title: String
    let trashedAt: String

    var key: String { "\(kind.rawValue):\(id)" }
    var displayTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "未命名" : title }
    var trashedDate: Date? { WorkspaceTrashText.date(trashedAt) }
}

/// A library or chapter list that names trashed content, as it reaches the
/// tab host from any command.
enum WorkspaceTrashSource {
    case elements(WorkspaceElementLibrary)
    case chapters(live: [WorkspaceChapter], trashed: [WorkspaceChapter])
    case drifts(WorkspaceDriftLibrary)
    case storylines(WorkspaceStorylineLibrary)
}

/// `workspacePurgeTrashed` / `workspaceEmptyTrash`: what was purged (with
/// its body's document identity) and what remains in the project's trash.
struct WorkspaceTrashPurgeReply: Decodable, Equatable {
    struct Purged: Decodable, Equatable {
        let kind: String
        let id: String
        let documentId: String
    }
    struct Remaining: Decodable, Equatable {
        let kind: String
        let id: String
    }
    let purged: [Purged]
    let trashed: [Remaining]
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

    /// “1 个章节、2 个设定”, in kind order; kinds without items are left out.
    static func counts(_ items: [WorkspaceTrashItem]) -> String {
        WorkspaceTrashKind.allCases.compactMap { kind in
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

    static func emptyDetail(_ items: [WorkspaceTrashItem]) -> String {
        "将永久删除回收站中的全部 \(items.count) 项：\(counts(items))，连同它们的字段、补丁、正文、历史版本和写在上面的批注与待办，无法恢复。"
    }
}

/// One project's 回收站: every trashed chapter, drift, element, category
/// and storyline, newest first, with a kind filter. Rust owns every list;
/// the model adopts the libraries and chapter lists it is given and the
/// remaining set a purge returns.
final class WorkspaceTrashModel {
    let projectID: String
    private let workspace: LabWorkspaceCore
    private var parts: [WorkspaceTrashKind: [WorkspaceTrashItem]] = [:]
    private(set) var items: [WorkspaceTrashItem] = []
    private(set) var loaded = false
    private(set) var busy = false
    private(set) var status = "正在读取回收站…"
    /// The status is the count summary, which follows changes; an action's
    /// message stays until the next action.
    private var statusIsSummary = true
    /// Nil shows every kind.
    var filter: WorkspaceTrashKind? { didSet { if filter != oldValue { onChange?() } } }
    var onChange: (() -> Void)?

    init(workspace: LabWorkspaceCore, projectID: String) {
        self.workspace = workspace
        self.projectID = projectID
    }

    /// The items the filter shows, newest first.
    var shown: [WorkspaceTrashItem] { filter.map { kind in items.filter { $0.kind == kind } } ?? items }

    func count(_ kind: WorkspaceTrashKind) -> Int { items.filter { $0.kind == kind }.count }

    func showStatus(_ message: String) { status = message; statusIsSummary = false; onChange?() }

    func setBusy(_ value: Bool) { busy = value; onChange?() }

    /// Reads the four sources; the list shows once all have arrived.
    func load() {
        var pending = 4
        var failure: String?
        let arrived: (String?) -> Void = { [weak self] error in
            guard let self else { return }
            failure = failure ?? error
            pending -= 1
            guard pending == 0 else { return }
            self.loaded = true
            self.status = failure ?? self.summary
            self.statusIsSummary = failure == nil
            self.onChange?()
        }
        workspace.trashedChapters(projectID: projectID) { [weak self] result in
            if case .success(let chapters) = result { self?.set(.chapter, Self.items(chapters: chapters)) }
            arrived(Self.message(result))
        }
        workspace.elementLibrary(projectID: projectID) { [weak self] result in
            if case .success(let library) = result { self?.adoptElements(library) }
            arrived(Self.message(result))
        }
        workspace.driftLibrary(projectID: projectID) { [weak self] result in
            if case .success(let library) = result { self?.set(.drift, Self.items(drifts: library)) }
            arrived(Self.message(result))
        }
        workspace.storylineLibrary(projectID: projectID) { [weak self] result in
            if case .success(let library) = result { self?.set(.storyline, Self.items(storylines: library)) }
            arrived(Self.message(result))
        }
    }

    /// A library or chapter list that arrived elsewhere, e.g. after a trash
    /// in the 设定库 or a restore here.
    func apply(_ source: WorkspaceTrashSource) {
        switch source {
        case .elements(let library): adoptElements(library)
        case .chapters(_, let trashed): set(.chapter, Self.items(chapters: trashed))
        case .drifts(let library): set(.drift, Self.items(drifts: library))
        case .storylines(let library): set(.storyline, Self.items(storylines: library))
        }
        if loaded, statusIsSummary { status = summary }
        onChange?()
    }

    /// Keeps exactly what a purge says remains.
    func adoptRemaining(_ reply: WorkspaceTrashPurgeReply) {
        let remaining = Set(reply.trashed.map { "\($0.kind):\($0.id)" })
        for (kind, list) in parts { parts[kind] = list.filter { remaining.contains($0.key) } }
        rebuild()
        onChange?()
    }

    /// “回收站中有 3 项：…” or the empty notice.
    var summary: String {
        items.isEmpty ? "回收站是空的。移到回收站的章节、漂流、设定、分类和故事线会列在这里。"
            : "回收站中有 \(items.count) 项：\(WorkspaceTrashText.counts(items))。恢复后可以从原来的列表打开。"
    }

    private func adoptElements(_ library: WorkspaceElementLibrary) {
        set(.element, library.trashedElements.map {
            WorkspaceTrashItem(kind: .element, id: $0.id, title: $0.name, trashedAt: $0.updatedAt)
        })
        set(.category, library.trashedCategories.map {
            WorkspaceTrashItem(kind: .category, id: $0.id, title: $0.name, trashedAt: $0.updatedAt)
        })
    }

    private func set(_ kind: WorkspaceTrashKind, _ list: [WorkspaceTrashItem]) {
        parts[kind] = list
        rebuild()
    }

    private func rebuild() {
        let order = Dictionary(uniqueKeysWithValues: WorkspaceTrashKind.allCases.enumerated().map { ($1, $0) })
        items = parts.values.flatMap { $0 }.sorted { left, right in
            let (a, b) = (left.trashedDate, right.trashedDate)
            if let a, let b, a != b { return a > b }
            if a == nil || b == nil, left.trashedAt != right.trashedAt { return left.trashedAt > right.trashedAt }
            if left.kind != right.kind { return order[left.kind]! < order[right.kind]! }
            return left.title.localizedStandardCompare(right.title) == .orderedAscending
        }
    }

    static func items(chapters: [WorkspaceChapter]) -> [WorkspaceTrashItem] {
        chapters.map { WorkspaceTrashItem(kind: .chapter, id: $0.id, title: $0.title, trashedAt: $0.updatedAt ?? "") }
    }
    static func items(drifts: WorkspaceDriftLibrary) -> [WorkspaceTrashItem] {
        drifts.trashedDrifts.map { WorkspaceTrashItem(kind: .drift, id: $0.id, title: $0.title, trashedAt: $0.updatedAt) }
    }
    static func items(storylines: WorkspaceStorylineLibrary) -> [WorkspaceTrashItem] {
        storylines.trashedStorylines.map { WorkspaceTrashItem(kind: .storyline, id: $0.id, title: $0.name, trashedAt: $0.updatedAt) }
    }

    private static func message<T>(_ result: Result<T, Error>) -> String? {
        if case .failure(let error) = result { return error.localizedDescription }
        return nil
    }
}
