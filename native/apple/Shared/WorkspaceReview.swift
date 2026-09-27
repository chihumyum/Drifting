import Foundation

/// `workspaceComments`: the command's comment (nil for a read or a delete)
/// and every note and TODO of the project after it, oldest first.
struct WorkspaceCommentsReply: Decodable {
    let result: WorkspaceComment?
    let comments: [WorkspaceComment]
}

/// 低, 中 or 高; Rust stores `low`, `med` or `high`.
enum CommentPriority: String, CaseIterable {
    case low, med, high

    var label: String {
        switch self {
        case .low: return "低"
        case .med: return "中"
        case .high: return "高"
        }
    }
}

/// Present fields change; absent fields stay. `priority: .some(nil)` clears
/// the priority. Rust writes nothing for a value equal to the stored one.
struct WorkspaceCommentChanges: Equatable {
    var body: String?
    var kind: String?
    var priority: CommentPriority??

    var fields: [String: Any] {
        var fields: [String: Any] = [:]
        if let body { fields["body"] = body }
        if let kind { fields["kind"] = kind }
        if let priority { fields["priority"] = priority.map { $0.rawValue as Any } ?? NSNull() }
        return fields
    }
}

extension WorkspaceComment {
    var isTodo: Bool { kind == "todo" }
    /// A TODO not written on any page.
    var isFloating: Bool { targetId == nil }
    /// Written on a passage of a chapter, rather than the whole page.
    var isBlock: Bool { targetBlockId != nil }
    /// The page it is written on, as a relation endpoint.
    var target: RelationEndpoint? {
        guard let targetKind, let targetId else { return nil }
        return RelationEndpoint(kind: targetKind, id: targetId)
    }
    var endpoint: RelationEndpoint { RelationEndpoint(kind: "comment", id: id) }
    var priorityLevel: CommentPriority? { priority.flatMap(CommentPriority.init(rawValue:)) }
    var kindLabel: String { isTodo ? "待办" : "批注" }
}

// MARK: Associations (关联)

/// One association of a TODO, note or library item with a chapter, drift,
/// element, category or storyline, with the other end's current name.
struct AssociationEntry: Equatable {
    let relation: WorkspaceRelation
    let target: RelationEndpoint
    let name: RelationEndpointName
    /// “章节 · 雨夜”.
    var label: String { "\(name.kindLabel) · \(name.name)" }
}

/// 关联: the built-in Generic association from a comment or library item to
/// a structural entity. Rust owns the rows and checks every end; replies
/// replace the project's relation library, which this model reads through.
final class AssociationModel {
    let projectID: String
    let relations: RelationLibraryModel
    /// The project's current names; set by the tab host.
    var names: () -> RelationNameDirectory
    private var observers: [(owner: () -> AnyObject?, block: () -> Void)] = []

    init(projectID: String, relations: RelationLibraryModel, names: @escaping () -> RelationNameDirectory) {
        self.projectID = projectID
        self.relations = relations
        self.names = names
        relations.observe(self) { [weak self] _ in self?.changed() }
    }

    /// Calls `block` after the library or the names changed while `owner` lives.
    func observe(_ owner: AnyObject, _ block: @escaping () -> Void) {
        observers.append(({ [weak owner] in owner }, block))
    }

    /// Names followed a rename, a trash or a first read.
    func namesChanged() { changed() }

    private func changed() {
        observers.removeAll { $0.owner() == nil }
        for observer in observers { observer.block() }
    }

    /// The Generic association seeded with every project.
    var typeID: String {
        relations.library.types.first { $0.systemKey == "generic-association" }?.id ?? "system:generic-association:\(projectID)"
    }

    /// The source's associations in the order they were made.
    func entries(of source: RelationEndpoint) -> [AssociationEntry] {
        let names = self.names(), type = typeID
        return relations.library.relations.filter { $0.relationTypeId == type && $0.from == source }.map { relation in
            AssociationEntry(relation: relation, target: relation.to, name: names.name(of: relation.to))
        }
    }

    /// Identities of sources of `kind` associated with the target.
    func sources(kind: String, associatedWith target: RelationEndpoint) -> Set<String> {
        let type = typeID
        return Set(relations.library.relations.filter { $0.relationTypeId == type && $0.fromKind == kind && $0.to == target }
            .map(\.fromId))
    }

    /// Live chapters, drifts, elements, categories and storylines not yet
    /// associated with the source (or not in `excluding`), in picker order.
    func candidates(for source: RelationEndpoint?, excluding: [RelationEndpoint] = []) -> [RelationNameDirectory.Candidate] {
        let taken = Set((source.map { entries(of: $0).map(\.target) } ?? []) + excluding)
        return names().candidates.filter { !taken.contains($0.endpoint) }
    }

    /// An existing association is returned without writing.
    func add(_ source: RelationEndpoint, _ target: RelationEndpoint, completion: @escaping (Result<Void, Error>) -> Void) {
        relations.add(from: source, to: target, typeID: typeID) { completion($0.map { _ in () }) }
    }

    /// Removing an association that is already gone writes nothing.
    func remove(_ source: RelationEndpoint, _ target: RelationEndpoint, completion: @escaping (Result<Void, Error>) -> Void) {
        guard let relation = entries(of: source).first(where: { $0.target == target })?.relation else {
            completion(.success(())); return
        }
        relations.remove(relationID: relation.id, completion: completion)
    }
}

// MARK: 审阅

enum ReviewFilter: CaseIterable {
    case all, notes, todos, copilot

    var label: String {
        switch self {
        case .all: return "全部"
        case .notes: return "批注"
        case .todos: return "待办"
        case .copilot: return "Copilot"
        }
    }

    /// 批注 are the author's and the assistant's notes; Copilot suggestions
    /// have their own filter.
    func matches(_ comment: WorkspaceComment) -> Bool {
        switch self {
        case .all: return true
        case .notes: return !comment.isTodo && !comment.isCopilot
        case .todos: return comment.isTodo
        case .copilot: return comment.isCopilot
        }
    }
}

enum ReviewScope {
    case current, project
    var label: String { self == .current ? "当前" : "全书" }
}

/// The focused tab's page: a chapter, drift, element, category or storyline.
struct ReviewFocus: Equatable {
    let endpoint: RelationEndpoint
    /// “章节「雨夜」”.
    let label: String
}

struct ReviewItem: Equatable {
    let comment: WorkspaceComment
    /// 0 on the whole focused page, 1 on a passage of it, 2 associated with
    /// it, 3 elsewhere in the book.
    let rank: Int
}

/// What a review command changed, for views showing the same rows: the
/// chapter's comment panel and the open owner of a deleted anchor.
enum ReviewChange {
    case created(WorkspaceComment)
    case updated(WorkspaceComment)
    case deleted(WorkspaceComment)

    var comment: WorkspaceComment {
        switch self {
        case .created(let comment), .updated(let comment), .deleted(let comment): return comment
        }
    }
}

/// One project's notes and TODOs for the 审阅 panel and the 备忘与素材
/// board. Rust owns every row, check and association; each reply replaces
/// the list. Commands run one at a time.
final class ReviewModel {
    let projectID: String
    private let workspace: LabWorkspaceCore
    let associations: AssociationModel
    private(set) var comments: [WorkspaceComment] = []
    private(set) var loaded = false
    /// Commands sent and not yet answered. Reads do not count: a click that
    /// makes the panel key (and reads again) still runs its command.
    private(set) var pending = 0
    var busy: Bool { pending > 0 }
    /// A read is in flight.
    var isReading: Bool { reading }
    private(set) var status = "正在读取批注和待办…"
    /// The last command's message or refusal; nil while the status is the
    /// list's summary.
    private(set) var message: String?
    private(set) var focus: ReviewFocus?
    var filter: ReviewFilter = .all { didSet { if oldValue != filter { changed() } } }
    var scope: ReviewScope = .current { didSet { if oldValue != scope { changed() } } }
    /// Whether a chapter's open owner has input in flight; a passage note on
    /// it is not deleted meanwhile.
    var ownerBusy: ((String) -> Bool)?
    /// A command changed a row; views of the same rows follow.
    var onChanged: ((ReviewChange) -> Void)?
    private var observers: [(owner: () -> AnyObject?, block: () -> Void)] = []
    private var reading = false
    private var reread = false

    init(workspace: LabWorkspaceCore, projectID: String, associations: AssociationModel) {
        self.workspace = workspace
        self.projectID = projectID
        self.associations = associations
        associations.observe(self) { [weak self] in self?.changed() }
    }

    /// Calls `block` after every change while `owner` lives.
    func observe(_ owner: AnyObject, _ block: @escaping () -> Void) {
        observers.append(({ [weak owner] in owner }, block))
    }

    private func changed() {
        observers.removeAll { $0.owner() == nil }
        for observer in observers { observer.block() }
    }

    func showStatus(_ message: String) { status = message; self.message = message; changed() }

    /// The focused tab changed; without one, 当前 reads as 全书.
    func setFocus(_ focus: ReviewFocus?) {
        guard focus != self.focus else { return }
        self.focus = focus
        changed()
    }

    var effectiveScope: ReviewScope { focus == nil ? .project : scope }

    /// Reads every note and TODO again, e.g. after a selection note was
    /// written through a chapter's owner. A read during a read runs once more.
    func load() {
        guard !reading else { reread = true; return }
        reading = true
        workspace.projectComments(projectID: projectID) { [weak self] result in
            guard let self else { return }
            self.reading = false
            switch result {
            case .success(let comments):
                self.comments = comments; self.loaded = true
                self.status = self.summary; self.message = nil
            case .failure(let error): self.status = error.localizedDescription; self.message = self.status
            }
            self.changed()
            if self.reread { self.reread = false; self.load() }
        }
    }

    func comment(id: String) -> WorkspaceComment? { comments.first { $0.id == id } }

    /// A reply from outside this model (a Copilot decision) listed every
    /// comment of the project: adopt it, with the command's message.
    func adopt(_ comments: [WorkspaceComment], message: String?) {
        self.comments = comments; loaded = true
        status = message ?? summary; self.message = message
        changed()
    }

    // MARK: Lists

    /// Whether the comment is written on the focused page or associated with it.
    func belongsToFocus(_ comment: WorkspaceComment) -> Bool { rank(comment) < 3 }

    private func rank(_ comment: WorkspaceComment, related: Set<String>? = nil) -> Int {
        guard let focus else { return 3 }
        if comment.target == focus.endpoint { return comment.isBlock ? 1 : 0 }
        let related = related ?? associations.sources(kind: "comment", associatedWith: focus.endpoint)
        return related.contains(comment.id) ? 2 : 3
    }

    /// The filtered notes and TODOs in scope: on the whole focused page
    /// first, then on its passages, then associated with it (all in the book
    /// for 全书), each newest first. Converted suggestions are left out.
    var items: [ReviewItem] {
        let related = focus.map { associations.sources(kind: "comment", associatedWith: $0.endpoint) } ?? []
        let current = effectiveScope == .current
        // Equal times keep the later-written row first.
        return comments.enumerated().filter { $0.element.review != .converted && filter.matches($0.element) }
            .map { (index: $0.offset, item: ReviewItem(comment: $0.element, rank: rank($0.element, related: related))) }
            .filter { !current || $0.item.rank < 3 }
            .sorted { first, second in
                if first.item.rank != second.item.rank { return first.item.rank < second.item.rank }
                if first.item.comment.updatedAt != second.item.comment.updatedAt { return first.item.comment.updatedAt > second.item.comment.updatedAt }
                return first.index > second.index
            }
            .map(\.item)
    }
    var openItems: [ReviewItem] { items.filter { $0.comment.review == .open } }
    var resolvedItems: [ReviewItem] { items.filter { $0.comment.review == .resolved } }

    /// Every open TODO of the project in the order they were written.
    var openTodos: [WorkspaceComment] { comments.filter { $0.isTodo && $0.review == .open } }
    /// Finished TODOs, most recently finished first.
    var resolvedTodos: [WorkspaceComment] {
        comments.filter { $0.isTodo && $0.review == .resolved }.sorted { ($0.resolvedAt ?? "") > ($1.resolvedAt ?? "") }
    }

    private var summary: String {
        let open = comments.filter { $0.review == .open }.count, resolved = comments.filter { $0.review == .resolved }.count
        if comments.isEmpty { return "还没有批注和待办。可以在当前页面写批注，或新建一条待办。" }
        return "共 \(open) 条未解决" + (resolved > 0 ? "，\(resolved) 条已解决。" : "。")
    }

    // MARK: Commands

    /// A note or TODO on the focused page, or a floating TODO, then its
    /// associations one by one. A refused association keeps the new row and
    /// is named in the status.
    func create(kind: String, onFocus: Bool, body: String, priority: CommentPriority?, associate: [RelationEndpoint] = [],
                completion: ((Result<WorkspaceComment, Error>) -> Void)? = nil) {
        if onFocus, focus == nil {
            let refusal = "请先打开一个章节、漂流、设定、分类或故事线，或写一条浮动待办。"
            showStatus(refusal); completion?(.failure(LabError.message(refusal))); return
        }
        create(kind: kind, on: onFocus ? focus : nil, body: body, priority: priority, associate: associate, completion: completion)
    }

    /// A note or TODO on exactly `page` (the page a sheet was opened on,
    /// whatever is focused now), or a floating TODO with nil. A page that
    /// is gone is refused in Chinese, naming it; nothing is written.
    func create(kind: String, on page: ReviewFocus?, body: String, priority: CommentPriority?, associate: [RelationEndpoint] = [],
                completion: ((Result<WorkspaceComment, Error>) -> Void)? = nil) {
        let target = page?.endpoint
        send(message: { "\($0?.kindLabel ?? "批注")已添加。" }, change: { $0.map(ReviewChange.created) }, completion: { [weak self] result in
            guard let self else { return }
            if case .failure(let error) = result, let page, error.localizedDescription.contains("所在的页面已不可用") {
                let refusal = "\(page.label)已不可用（可能已移到回收站），\(kind == "todo" ? "待办" : "批注")没有创建。"
                self.showStatus(refusal); completion?(.failure(LabError.message(refusal))); return
            }
            guard case .success(let created) = result, let created else {
                completion?(result.flatMap { $0.map { .success($0) } ?? .failure(LabError.message("审阅结果缺失")) }); return
            }
            let targets = associate.filter { $0 != target }
            self.associateAll(created, targets) { failures in
                if !failures.isEmpty {
                    self.showStatus("\(created.kindLabel)已添加，但有 \(failures.count) 个关联未能保存：\(failures.joined(separator: "；"))")
                }
                completion?(.success(created))
            }
        }) { workspace.createComment(projectID: projectID, kind: kind, target: target, body: body, priority: priority?.rawValue,
                                     completion: $0) }
    }

    private func associateAll(_ comment: WorkspaceComment, _ targets: [RelationEndpoint], done: @escaping ([String]) -> Void) {
        var remaining = targets[...], failures: [String] = []
        func next() {
            guard let target = remaining.popFirst() else { done(failures); return }
            associations.add(comment.endpoint, target) { result in
                if case .failure(let error) = result { failures.append(error.localizedDescription) }
                next()
            }
        }
        next()
    }

    func updateBody(id: String, body: String, completion: ((Result<WorkspaceComment, Error>) -> Void)? = nil) {
        update(id: id, changes: WorkspaceCommentChanges(body: body), message: "内容已保存。", completion: completion)
    }

    /// nil clears the priority.
    func setPriority(id: String, _ priority: CommentPriority?, completion: ((Result<WorkspaceComment, Error>) -> Void)? = nil) {
        update(id: id, changes: WorkspaceCommentChanges(priority: .some(priority)),
               message: priority.map { "优先级已设为\($0.label)。" } ?? "已清除优先级。", completion: completion)
    }

    /// 批注 ↔ 待办. Rust refuses to make a floating TODO a note.
    func convert(id: String, completion: ((Result<WorkspaceComment, Error>) -> Void)? = nil) {
        guard let comment = comment(id: id) else { missing(completion); return }
        update(id: id, changes: WorkspaceCommentChanges(kind: comment.isTodo ? "note" : "todo"),
               message: comment.isTodo ? "已转为批注。" : "已转为待办。", completion: completion)
    }

    private func update(id: String, changes: WorkspaceCommentChanges, message: String,
                        completion: ((Result<WorkspaceComment, Error>) -> Void)?) {
        send(message: { _ in message }, change: { $0.map(ReviewChange.updated) }, completion: { completion?(Self.required($0)) }) {
            workspace.updateComment(projectID: projectID, commentID: id, changes: changes, completion: $0)
        }
    }

    func setResolved(id: String, resolved: Bool, completion: ((Result<WorkspaceComment, Error>) -> Void)? = nil) {
        guard let comment = comment(id: id) else { missing(completion); return }
        guard comment.canChangeResolution else {
            let refusal = "已转化的建议不能解决或重新打开。"
            showStatus(refusal); completion?(.failure(LabError.message(refusal))); return
        }
        send(message: { _ in resolved ? "\(comment.kindLabel)已解决。" : "\(comment.kindLabel)已重新打开。" },
             change: { $0.map(ReviewChange.updated) }, completion: { completion?(Self.required($0)) }) {
            workspace.setCommentResolved(projectID: projectID, commentID: id, resolved: resolved, completion: $0)
        }
    }

    /// Removes the note or TODO with its associations. A passage note waits
    /// while its chapter has input in flight.
    func delete(id: String, completion: ((Result<Void, Error>) -> Void)? = nil) {
        guard let comment = comment(id: id) else { completion?(.success(())); return }
        if comment.isBlock, comment.targetKind == "node", let chapter = comment.targetId, ownerBusy?(chapter) == true {
            let refusal = "请先完成输入，并等待正文保存后再删除这条批注。"
            showStatus(refusal); completion?(.failure(LabError.message(refusal))); return
        }
        let associated = !associations.entries(of: comment.endpoint).isEmpty
        send(message: { _ in "\(comment.kindLabel)已删除。" }, change: { _ in .deleted(comment) },
             completion: { [weak self] result in
                 // Rust purged its relations with it; the library is read again.
                 if case .success = result, associated { self?.associations.relations.load() }
                 completion?(result.map { _ in () })
             }) {
            workspace.deleteComment(projectID: projectID, commentID: id, completion: $0)
        }
    }

    /// 关联 a note or TODO with a structural entity.
    func associate(id: String, with target: RelationEndpoint, completion: ((Result<Void, Error>) -> Void)? = nil) {
        guard let comment = comment(id: id) else { completion?(.failure(LabError.message("这条批注或待办已被删除，请刷新审阅列表。"))); return }
        associations.add(comment.endpoint, target) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success: self.showStatus("已关联“\(self.associations.names().name(of: target).name)”。")
            case .failure(let error): self.showStatus(error.localizedDescription)
            }
            completion?(result)
        }
    }

    func dissociate(id: String, from target: RelationEndpoint, completion: ((Result<Void, Error>) -> Void)? = nil) {
        guard let comment = comment(id: id) else { completion?(.success(())); return }
        associations.remove(comment.endpoint, target) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success: self.showStatus("已移除关联。")
            case .failure(let error): self.showStatus(error.localizedDescription)
            }
            completion?(result)
        }
    }

    private func missing(_ completion: ((Result<WorkspaceComment, Error>) -> Void)?) {
        let refusal = "这条批注或待办已被删除，请刷新审阅列表。"
        showStatus(refusal); completion?(.failure(LabError.message(refusal)))
    }

    private static func required(_ result: Result<WorkspaceComment?, Error>) -> Result<WorkspaceComment, Error> {
        result.flatMap { $0.map { .success($0) } ?? .failure(LabError.message("审阅结果缺失")) }
    }

    /// Adopts the reply's list before reporting, so every view already shows
    /// the stored rows when the caller continues.
    private func send(message: @escaping (WorkspaceComment?) -> String, change: @escaping (WorkspaceComment?) -> ReviewChange?,
                      completion: @escaping (Result<WorkspaceComment?, Error>) -> Void,
                      operation: (@escaping (Result<WorkspaceCommentsReply, Error>) -> Void) -> Void) {
        guard !busy else {
            let refusal = "正在保存批注和待办，请稍后重试。"
            showStatus(refusal); completion(.failure(LabError.message(refusal))); return
        }
        pending += 1; changed()
        operation { [weak self] result in
            guard let self else { return }
            self.pending -= 1
            switch result {
            case .success(let reply):
                self.comments = reply.comments; self.loaded = true
                self.status = message(reply.result); self.message = self.status
                self.changed()
                if let change = change(reply.result) { self.onChanged?(change) }
                completion(.success(reply.result))
            case .failure(let error):
                self.showStatus(error.localizedDescription)
                completion(.failure(error))
            }
        }
    }
}
