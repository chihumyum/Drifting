import Foundation

/// A live or trashed storyline as the shared Rust workspace store returns it.
/// Its prose body is the `storyline:<id>` document.
struct WorkspaceStoryline: Decodable, Equatable {
    let id: String
    let projectId: String
    let name: String
    /// `#RRGGBB`; Rust validates every stored value.
    let color: String
    let summary: String
    /// The rank among live storylines. Lists already arrive in this order.
    let orderKey: Int
    /// Ordered facts; rows with a blank key and value are never stored.
    let facts: [WorkspaceFact]
    let documentId: String
    let createdAt: String
    let updatedAt: String

    var rgb: (red: Double, green: Double, blue: Double)? { WorkspaceElementCategory.rgb(hex: color) }
}

/// One live chapter's storylines (UTF-8 identity order) and its primary
/// storyline (主线), which is always one of them.
struct WorkspaceChapterStorylines: Decodable, Equatable {
    let chapterId: String
    let storylineIds: [String]
    let primary: String?
}

struct WorkspaceStorylineLibrary: Decodable, Equatable {
    /// Live storylines in their authored order.
    var storylines: [WorkspaceStoryline]
    var trashedStorylines: [WorkspaceStoryline]
    /// Every live chapter in book order, including chapters with none.
    var memberships: [WorkspaceChapterStorylines]

    static let empty = WorkspaceStorylineLibrary(storylines: [], trashedStorylines: [], memberships: [])

    func storyline(id: String) -> WorkspaceStoryline? { storylines.first { $0.id == id } }
    func membership(chapterID: String) -> WorkspaceChapterStorylines? { memberships.first { $0.chapterId == chapterID } }
    /// The chapter's live primary storyline, or nil when it is 未归属.
    func primary(chapterID: String) -> WorkspaceStoryline? {
        membership(chapterID: chapterID)?.primary.flatMap { storyline(id: $0) }
    }
    /// Chapters that belong to the storyline, in book order.
    func chapters(storylineID: String) -> [WorkspaceChapterStorylines] {
        memberships.filter { $0.storylineIds.contains(storylineID) }
    }
    /// Chapters whose primary is the storyline; trashing it clears all of
    /// their storylines, not only this one.
    func primaryChapters(storylineID: String) -> [WorkspaceChapterStorylines] {
        memberships.filter { $0.primary == storylineID }
    }
}

/// Every storyline command returns its own result and the complete library
/// after it, so no list or membership is patched locally.
struct WorkspaceStorylineReply<Value: Decodable>: Decodable {
    let result: Value?
    let library: WorkspaceStorylineLibrary
}

/// Present fields are written; absent fields stay unchanged. Rust keeps
/// names unique (case-insensitively) with “ 2”, “ 3” suffixes.
struct WorkspaceStorylineChanges {
    var name: String?
    var color: String?
    var summary: String?

    var fields: [String: Any] {
        var fields: [String: Any] = [:]
        if let name { fields["name"] = name }
        if let color { fields["color"] = color }
        if let summary { fields["summary"] = summary }
        return fields
    }
}

/// The choice edited in a chapter's 故事线 sheet: checked storylines in the
/// library's order, and a primary among them. Pure presentation rules; Rust
/// validates and stores the result.
struct ChapterStorylineSelection: Equatable {
    private(set) var checked: [String]
    private(set) var primary: String?
    let order: [String]

    init(order: [String], membership: WorkspaceChapterStorylines?) {
        self.order = order
        let current = Set(membership?.storylineIds ?? [])
        checked = order.filter { current.contains($0) }
        primary = membership?.primary.flatMap { current.contains($0) && order.contains($0) ? $0 : nil }
        normalize()
    }

    func isChecked(_ id: String) -> Bool { checked.contains(id) }

    /// Checking the first storyline makes it primary; unchecking the primary
    /// passes 主线 to the first remaining storyline in library order.
    mutating func set(_ id: String, checked value: Bool) {
        guard order.contains(id) else { return }
        let set = Set(value ? checked + [id] : checked.filter { $0 != id })
        checked = order.filter { set.contains($0) }
        normalize()
    }

    mutating func choosePrimary(_ id: String) {
        guard checked.contains(id) else { return }
        primary = id
    }

    private mutating func normalize() {
        if let primary, checked.contains(primary) { return }
        primary = checked.first
    }
}

/// Presentation state of one project's 故事线 panel. Rust owns the list
/// order, names, memberships and the trash; this model only lays out rows.
final class StorylineLibraryModel {
    enum Row: Equatable {
        /// `chapters` belong to it; `primaries` have it as 主线.
        case storyline(WorkspaceStoryline, chapters: Int, primaries: Int)
        case empty
        case trashHeader(count: Int)
        case trashed(WorkspaceStoryline)

        var storyline: WorkspaceStoryline? {
            switch self {
            case .storyline(let storyline, _, _), .trashed(let storyline): return storyline
            default: return nil
            }
        }
        var identifier: String {
            switch self {
            case .storyline(let storyline, _, _): return "storyline-row-\(storyline.id)"
            case .empty: return "storyline-empty"
            case .trashHeader: return "storyline-trash"
            case .trashed(let storyline): return "trashed-storyline-\(storyline.id)"
            }
        }
    }

    let projectID: String
    private let workspace: LabWorkspaceCore
    private(set) var library = WorkspaceStorylineLibrary.empty
    private(set) var loaded = false
    private(set) var busy = false
    private(set) var status = "正在读取故事线…"
    var onChange: (() -> Void)?
    /// Every successful read or command's complete library, for pages,
    /// the outline and chapter lists.
    var onLibrary: ((WorkspaceStorylineLibrary) -> Void)?

    init(workspace: LabWorkspaceCore, projectID: String) {
        self.workspace = workspace
        self.projectID = projectID
    }

    var rows: [Row] {
        var rows: [Row] = library.storylines.map { storyline in
            .storyline(storyline, chapters: library.chapters(storylineID: storyline.id).count,
                       primaries: library.primaryChapters(storylineID: storyline.id).count)
        }
        if rows.isEmpty { rows.append(.empty) }
        if !library.trashedStorylines.isEmpty {
            rows.append(.trashHeader(count: library.trashedStorylines.count))
            rows += library.trashedStorylines.map { .trashed($0) }
        }
        return rows
    }

    func showStatus(_ message: String) { status = message; onChange?() }

    func load() {
        guard !busy else { return }
        busy = true; onChange?()
        workspace.storylineLibrary(projectID: projectID) { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let library): self.apply(library, message: nil); self.onLibrary?(library)
            case .failure(let error): self.showStatus(error.localizedDescription)
            }
        }
    }

    /// Adopt a library returned elsewhere, e.g. by a page edit, a storyline
    /// trash that also closed pages, or a chapter list change.
    func apply(_ library: WorkspaceStorylineLibrary, message: String?) {
        self.library = library; loaded = true
        status = message ?? (library.storylines.isEmpty
            ? "还没有故事线。新建的第一条故事线会成为所有章节的主线。"
            : "点击故事线打开页面；拖动或右键调整顺序和更多操作。")
        onChange?()
    }

    func create(name: String, completion: ((Result<WorkspaceStoryline, Error>) -> Void)? = nil) {
        let first = library.storylines.isEmpty && !library.memberships.isEmpty
        mutate(message: first ? "故事线已创建，并已成为所有章节的主线。" : "故事线已创建。", completion: completion) {
            workspace.createStoryline(projectID: projectID, name: name, completion: $0)
        }
    }

    func rename(id: String, name: String, completion: ((Result<WorkspaceStoryline, Error>) -> Void)? = nil) {
        update(id: id, changes: WorkspaceStorylineChanges(name: name), message: "故事线名称已保存。", completion: completion)
    }

    func recolor(id: String, color: String, completion: ((Result<WorkspaceStoryline, Error>) -> Void)? = nil) {
        update(id: id, changes: WorkspaceStorylineChanges(color: color), message: "故事线颜色已保存。", completion: completion)
    }

    func setSummary(id: String, summary: String, completion: ((Result<WorkspaceStoryline, Error>) -> Void)? = nil) {
        update(id: id, changes: WorkspaceStorylineChanges(summary: summary), message: "故事线简介已保存。", completion: completion)
    }

    private func update(id: String, changes: WorkspaceStorylineChanges, message: String,
                        completion: ((Result<WorkspaceStoryline, Error>) -> Void)?) {
        mutate(message: message, completion: completion) {
            workspace.updateStoryline(projectID: projectID, storylineID: id, changes: changes, completion: $0)
        }
    }

    /// Places the storyline before another one, or last with nil.
    func move(id: String, before: String?, completion: ((Result<[WorkspaceStoryline], Error>) -> Void)? = nil) {
        mutate(message: "故事线顺序已保存。", completion: completion) {
            workspace.moveStoryline(projectID: projectID, storylineID: id, beforeStorylineID: before, completion: $0)
        }
    }

    /// The destination of a drop above list position `index` (0...count), or
    /// nil when the storyline would stay where it is.
    func destination(moving id: String, toIndex index: Int) -> String?? {
        let ids = library.storylines.map(\.id)
        guard let from = ids.firstIndex(of: id), (0...ids.count).contains(index), index != from, index != from + 1 else { return nil }
        return .some(index < ids.count ? ids[index] : nil)
    }

    func move(id: String, toIndex index: Int, completion: ((Result<[WorkspaceStoryline], Error>) -> Void)? = nil) {
        guard let before = destination(moving: id, toIndex: index) else {
            completion?(.failure(LabError.message("故事线已在这个位置。"))); return
        }
        move(id: id, before: before, completion: completion)
    }

    func moveUp(id: String, completion: ((Result<[WorkspaceStoryline], Error>) -> Void)? = nil) {
        let index = library.storylines.firstIndex { $0.id == id } ?? 0
        move(id: id, toIndex: index - 1, completion: completion)
    }

    func moveDown(id: String, completion: ((Result<[WorkspaceStoryline], Error>) -> Void)? = nil) {
        let index = library.storylines.firstIndex { $0.id == id } ?? library.storylines.count
        move(id: id, toIndex: index + 2, completion: completion)
    }

    /// Restoring does not link chapters again.
    func restore(id: String, completion: ((Result<WorkspaceStoryline, Error>) -> Void)? = nil) {
        mutate(message: "故事线已恢复。原来的章节归属不会自动恢复，可以在章节的“故事线…”中重新选择。", completion: completion) {
            workspace.restoreStoryline(projectID: projectID, storylineID: id, completion: $0)
        }
    }

    /// Replaces the chapter's storylines; `primary` must be one of them.
    func setChapterStorylines(chapterID: String, storylineIDs: [String], primary: String?,
                              completion: ((Result<WorkspaceChapterStorylines, Error>) -> Void)? = nil) {
        mutate(message: "章节的故事线已保存。", completion: completion) {
            workspace.setChapterStorylines(projectID: projectID, chapterID: chapterID, storylineIDs: storylineIDs,
                                           primary: primary, completion: $0)
        }
    }

    private func mutate<Value: Decodable>(message: String, completion: ((Result<Value, Error>) -> Void)?,
                                          operation: (@escaping (Result<WorkspaceStorylineReply<Value>, Error>) -> Void) -> Void) {
        guard !busy else {
            completion?(.failure(LabError.message("正在保存故事线，请稍后重试"))); return
        }
        busy = true; onChange?()
        operation { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let reply):
                self.apply(reply.library, message: message)
                self.onLibrary?(reply.library)
                if let value = reply.result { completion?(.success(value)) }
                else { completion?(.failure(LabError.message("故事线结果缺失"))) }
            case .failure(let error):
                self.showStatus(error.localizedDescription)
                completion?(.failure(error))
            }
        }
    }
}
