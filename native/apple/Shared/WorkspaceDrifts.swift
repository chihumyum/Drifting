import Foundation

/// A live or trashed drift (漂流) as the shared Rust workspace store returns
/// it: a free-floating book node with its own `node-content:<id>` body.
struct WorkspaceDrift: Decodable, Equatable {
    let id: String
    let projectId: String
    let title: String
    let summary: String
    let driftGroupId: String?
    /// The act boundary whose notes this drift is, if any. A drift binds to
    /// at most one act.
    let actId: String?
    let documentId: String
    let createdAt: String
    let updatedAt: String
}

/// A drift group. Groups nest one level: a root group may hold subgroups.
struct WorkspaceDriftGroup: Decodable, Equatable {
    let id: String
    let projectId: String
    let name: String
    let parentGroupId: String?
    let sortOrder: Double?
    let createdAt: String
    let updatedAt: String
}

struct WorkspaceDriftLibrary: Decodable, Equatable {
    /// Live drifts in creation order.
    var drifts: [WorkspaceDrift]
    var trashedDrifts: [WorkspaceDrift]
    /// Groups in their authored order within each parent.
    var groups: [WorkspaceDriftGroup]

    static let empty = WorkspaceDriftLibrary(drifts: [], trashedDrifts: [], groups: [])

    func drift(id: String) -> WorkspaceDrift? { drifts.first { $0.id == id } }
    func group(id: String) -> WorkspaceDriftGroup? { groups.first { $0.id == id } }
    /// The live drift bound to the act as its notes, if any.
    func drift(actID: String) -> WorkspaceDrift? { drifts.first { $0.actId == actID } }
    /// Live drifts not yet bound to any act, in list order.
    var unboundDrifts: [WorkspaceDrift] { drifts.filter { $0.actId == nil } }

    /// Groups whose parent is absent or unknown, in order.
    var rootGroups: [WorkspaceDriftGroup] {
        let ids = Set(groups.map(\.id))
        return groups.filter { $0.parentGroupId.map { !ids.contains($0) } ?? true }
    }
    func subgroups(of id: String) -> [WorkspaceDriftGroup] { groups.filter { $0.parentGroupId == id } }
    /// Whether the group is itself inside another live group; such a group
    /// cannot hold subgroups.
    func isSubgroup(_ id: String) -> Bool {
        guard let parent = group(id: id)?.parentGroupId else { return false }
        return group(id: parent) != nil
    }
    func drifts(inGroup id: String) -> [WorkspaceDrift] { drifts.filter { $0.driftGroupId == id } }
    /// Drifts without a live group, e.g. created outside any group.
    var ungroupedDrifts: [WorkspaceDrift] {
        let ids = Set(groups.map(\.id))
        return drifts.filter { $0.driftGroupId.map { !ids.contains($0) } ?? true }
    }
    /// “组名” or “组名 / 子分组名”, for pickers and the page.
    func path(groupID: String) -> String? {
        guard let group = group(id: groupID) else { return nil }
        guard let parent = group.parentGroupId.flatMap({ self.group(id: $0) }) else { return group.name }
        return "\(parent.name) / \(group.name)"
    }
    /// Every group in display order (each root group, then its subgroups),
    /// with its nesting depth, for group pickers.
    var orderedGroups: [(group: WorkspaceDriftGroup, depth: Int)] {
        var result: [(WorkspaceDriftGroup, Int)] = []
        var seen = Set<String>()
        func visit(_ group: WorkspaceDriftGroup, _ depth: Int) {
            guard seen.insert(group.id).inserted else { return }
            result.append((group, depth))
            for child in subgroups(of: group.id) { visit(child, depth + 1) }
        }
        for root in rootGroups { visit(root, 0) }
        return result
    }
}

/// Every drift command returns its own result and the complete library
/// after it, so no list is patched locally. Group deletion has no result.
struct WorkspaceDriftReply<Value: Decodable>: Decodable {
    let result: Value?
    let library: WorkspaceDriftLibrary
}

/// Present fields are written; an explicit nil inside `groupID` ungroups the
/// drift. Rust keeps titles unique across chapters and drifts.
struct WorkspaceDriftChanges {
    var title: String?
    var groupID: String??

    var fields: [String: Any] {
        var fields: [String: Any] = [:]
        if let title { fields["title"] = title }
        if let groupID { fields["groupId"] = groupID.map { $0 as Any } ?? NSNull() }
        return fields
    }
}

extension EntityLinkDirectory {
    /// What linking reads from drifts: live titles by identity.
    static func linkNames(_ drifts: WorkspaceDriftLibrary) -> [[String]] {
        drifts.drifts.sorted { $0.id < $1.id }.map { [$0.id, $0.title] }
    }
}

/// Presentation state of one project's 漂流 panel. Rust owns the lists,
/// group order and nesting rules; this model lays out rows and remembers
/// which groups are collapsed.
final class DriftLibraryModel {
    enum Row: Equatable {
        /// `count` includes the drifts of its subgroups.
        case group(WorkspaceDriftGroup, depth: Int, count: Int, collapsed: Bool)
        case drift(WorkspaceDrift, depth: Int)
        case emptyGroup(groupID: String, depth: Int)
        /// “未分组” above drifts outside any group, shown when groups exist.
        case ungroupedHeader(count: Int)
        case empty
        case trashHeader(count: Int)
        case trashed(WorkspaceDrift)

        var drift: WorkspaceDrift? {
            switch self {
            case .drift(let drift, _), .trashed(let drift): return drift
            default: return nil
            }
        }
        var group: WorkspaceDriftGroup? {
            if case .group(let group, _, _, _) = self { return group }
            return nil
        }
        var identifier: String {
            switch self {
            case .group(let group, _, _, _): return "drift-group-\(group.id)"
            case .drift(let drift, _): return "drift-row-\(drift.id)"
            case .emptyGroup(let id, _): return "drift-group-empty-\(id)"
            case .ungroupedHeader: return "drift-ungrouped"
            case .empty: return "drift-empty"
            case .trashHeader: return "drift-trash"
            case .trashed(let drift): return "trashed-drift-\(drift.id)"
            }
        }
    }

    let projectID: String
    private let workspace: LabWorkspaceCore
    private(set) var library = WorkspaceDriftLibrary.empty
    private(set) var loaded = false
    private(set) var busy = false
    private(set) var status = "正在读取漂流…"
    private(set) var collapsed: Set<String> = []
    /// Act names by identity, from the outline; a bound drift names its act.
    private(set) var actNames: [String: String] = [:]
    /// Writing statuses of live drifts by identity. Library rows carry none,
    /// so each drift's node metadata is read once and replies keep it current.
    private(set) var statuses: [String: String] = [:]
    private var readingStatuses: Set<String> = []
    private var rereadAfterCommand = false
    /// Each drift's word count; nil until read.
    private(set) var wordCounts: WordCountLibrary?
    var onChange: (() -> Void)?
    /// Every successful read or command's complete library, for pages, the
    /// outline and entity links.
    var onLibrary: ((WorkspaceDriftLibrary) -> Void)?

    init(workspace: LabWorkspaceCore, projectID: String) {
        self.workspace = workspace
        self.projectID = projectID
    }

    var rows: [Row] {
        var rows: [Row] = []
        var seen = Set<String>()
        func total(_ id: String, _ visited: Set<String>) -> Int {
            library.drifts(inGroup: id).count + library.subgroups(of: id)
                .filter { !visited.contains($0.id) }
                .reduce(0) { $0 + total($1.id, visited.union([id])) }
        }
        func append(_ group: WorkspaceDriftGroup, depth: Int) {
            guard seen.insert(group.id).inserted else { return }
            let folded = collapsed.contains(group.id)
            rows.append(.group(group, depth: depth, count: total(group.id, [group.id]), collapsed: folded))
            guard !folded else { return }
            let subgroups = library.subgroups(of: group.id), members = library.drifts(inGroup: group.id)
            for child in subgroups { append(child, depth: depth + 1) }
            rows += members.map { .drift($0, depth: depth + 1) }
            if subgroups.isEmpty && members.isEmpty { rows.append(.emptyGroup(groupID: group.id, depth: depth + 1)) }
        }
        for root in library.rootGroups { append(root, depth: 0) }
        let ungrouped = library.ungroupedDrifts
        if !library.groups.isEmpty && !ungrouped.isEmpty { rows.append(.ungroupedHeader(count: ungrouped.count)) }
        rows += ungrouped.map { .drift($0, depth: 0) }
        if library.groups.isEmpty && library.drifts.isEmpty { rows.append(.empty) }
        if !library.trashedDrifts.isEmpty {
            rows.append(.trashHeader(count: library.trashedDrifts.count))
            rows += library.trashedDrifts.map { .trashed($0) }
        }
        return rows
    }

    /// The name of the act a drift is bound to, once the outline was read.
    func actName(of drift: WorkspaceDrift) -> String? { drift.actId.flatMap { actNames[$0] } }

    /// `drifting` or `resting`; nil until the drift's metadata was read.
    func status(of drift: WorkspaceDrift) -> String? { statuses[drift.id] }
    /// 休眠 drifts stay in place and are muted, as in the renderer's panel.
    func isResting(_ drift: WorkspaceDrift) -> Bool { statuses[drift.id] == WritingStatus.resting.rawValue }

    /// Adopt the project's word counts; drift rows show theirs.
    func applyWordCounts(_ library: WordCountLibrary) {
        guard wordCounts != library else { return }
        wordCounts = library
        onChange?()
    }

    /// The drift's canonical count; nil before counts are read or while it has none.
    func wordCount(of drift: WorkspaceDrift) -> Int? { wordCounts?.count(nodeID: drift.id) }

    /// Adopt a drift's stored metadata, e.g. after its page or a menu wrote it.
    func applyNodeMetadata(_ metadata: WorkspaceNodeMetadata) {
        guard metadata.kind == "drift", library.drift(id: metadata.id) != nil,
              statuses[metadata.id] != metadata.writingStatus else { return }
        statuses[metadata.id] = metadata.writingStatus
        onChange?()
    }

    /// Reads the statuses of live drifts not yet known, with every node's
    /// metadata in one read. A trashed drift is forgotten, so a restored one
    /// is read again.
    private func readStatuses() {
        let live = library.drifts.map(\.id), liveSet = Set(live)
        statuses = statuses.filter { liveSet.contains($0.key) }
        let missing = live.filter { statuses[$0] == nil && !readingStatuses.contains($0) }
        guard !missing.isEmpty else { return }
        readingStatuses.formUnion(missing)
        workspace.nodesMetadata(projectID: projectID) { [weak self] result in
            guard let self else { return }
            self.readingStatuses.subtract(missing)
            guard case .success(let nodes) = result else { return }
            // Replies arrive in queue order, so a later command's reply still
            // lands after this read; statuses already known stay.
            for node in nodes where node.kind == "drift" && missing.contains(node.id) && self.library.drift(id: node.id) != nil {
                self.statuses[node.id] = node.writingStatus
            }
            self.onChange?()
        }
    }

    func showStatus(_ message: String) { status = message; onChange?() }

    func toggle(groupID: String) {
        if collapsed.remove(groupID) == nil { collapsed.insert(groupID) }
        onChange?()
    }

    /// Adopt act names from outline entries (act rows only).
    func applyActs(_ entries: [WorkspaceOutlineEntry]) {
        let names = Dictionary(entries.filter { $0.kind == "act" }.map { ($0.id, $0.title) }, uniquingKeysWith: { first, _ in first })
        guard names != actNames else { return }
        actNames = names
        onChange?()
    }

    /// Reads the library. While a command runs, the read follows it.
    func load() {
        guard !busy else { rereadAfterCommand = true; return }
        busy = true; onChange?()
        workspace.driftLibrary(projectID: projectID) { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let library): self.apply(library, message: nil); self.onLibrary?(library)
            case .failure(let error): self.showStatus(error.localizedDescription)
            }
            self.rereadIfNeeded()
        }
    }

    /// Adopt a library returned elsewhere, e.g. by a page edit, a drift trash
    /// that also closed pages, or an act binding from the outline.
    func apply(_ library: WorkspaceDriftLibrary, message: String?) {
        self.library = library; loaded = true
        collapsed.formIntersection(library.groups.map(\.id))
        status = message ?? (library.drifts.isEmpty && library.groups.isEmpty
            ? "还没有漂流。漂流是书序之外的笔记，可以分组整理，也可以绑定为某一幕的笔记。"
            : "点击漂流打开页面；右键漂流或分组查看更多操作。")
        onChange?()
        readStatuses()
    }

    /// An empty title uses Rust's default name.
    func createDrift(title: String, groupID: String?, completion: ((Result<WorkspaceDrift, Error>) -> Void)? = nil) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        mutate(message: "漂流已创建。", completion: completion) {
            workspace.createDrift(projectID: projectID, title: trimmed.isEmpty ? nil : trimmed, groupID: groupID, completion: $0)
        }
    }

    func renameDrift(id: String, title: String, completion: ((Result<WorkspaceDrift, Error>) -> Void)? = nil) {
        mutate(message: "漂流标题已保存。", completion: completion) {
            workspace.updateDrift(projectID: projectID, driftID: id, changes: WorkspaceDriftChanges(title: title), completion: $0)
        }
    }

    /// Moves the drift into a group, or out of every group with nil.
    func moveDrift(id: String, toGroup groupID: String?, completion: ((Result<WorkspaceDrift, Error>) -> Void)? = nil) {
        let name = groupID.flatMap { library.path(groupID: $0) }
        mutate(message: name.map { "漂流已移到“\($0)”。" } ?? "漂流已移出分组。", completion: completion) {
            workspace.updateDrift(projectID: projectID, driftID: id,
                                  changes: WorkspaceDriftChanges(groupID: .some(groupID)), completion: $0)
        }
    }

    /// Restoring does not bind the drift to its act again.
    func restore(id: String, completion: ((Result<WorkspaceDrift, Error>) -> Void)? = nil) {
        mutate(message: "漂流已恢复。原来的幕笔记绑定不会自动恢复，可以在整书大纲中重新绑定。", completion: completion) {
            workspace.restoreDrift(projectID: projectID, driftID: id, completion: $0)
        }
    }

    /// An empty name becomes “新分组”. Rust refuses a subgroup of a subgroup.
    func createGroup(name: String, parentID: String?, completion: ((Result<WorkspaceDriftGroup, Error>) -> Void)? = nil) {
        mutate(message: parentID == nil ? "分组已创建。" : "子分组已创建。", completion: completion) {
            workspace.createDriftGroup(projectID: projectID, name: name, parentGroupID: parentID, completion: $0)
        }
    }

    func renameGroup(id: String, name: String, completion: ((Result<WorkspaceDriftGroup, Error>) -> Void)? = nil) {
        mutate(message: "分组名称已保存。", completion: completion) {
            workspace.renameDriftGroup(projectID: projectID, groupID: id, name: name, completion: $0)
        }
    }

    /// Its subgroups and drifts move up to its parent; nothing is lost.
    func deleteGroup(id: String, completion: ((Result<Bool, Error>) -> Void)? = nil) {
        let name = library.group(id: id)?.name ?? "分组"
        let parent = library.group(id: id)?.parentGroupId.flatMap { library.group(id: $0)?.name }
        let message = "“\(name)”已删除，其中的漂流和子分组已移到\(parent.map { "“\($0)”" } ?? "上一级")。"
        let finish: ((Result<WorkspaceDriftGroup?, Error>) -> Void)? = completion.map { done in
            { (result: Result<WorkspaceDriftGroup?, Error>) in done(result.map { _ in true }) }
        }
        mutate(message: message, requiresResult: false, completion: finish) {
            workspace.deleteDriftGroup(projectID: projectID, groupID: id, completion: $0)
        }
    }

    /// Binds the drift as the act's notes, or unbinds the act with nil.
    func bindAct(actID: String, driftID: String?, completion: ((Result<WorkspaceAct, Error>) -> Void)? = nil) {
        mutate(message: driftID == nil ? "幕笔记已解除，漂流本身保留。" : "漂流已绑定为幕笔记。", completion: completion) {
            workspace.bindActDrift(projectID: projectID, actID: actID, driftID: driftID, completion: $0)
        }
    }

    private func mutate<Value: Decodable>(message: String, completion: ((Result<Value, Error>) -> Void)?,
                                          operation: (@escaping (Result<WorkspaceDriftReply<Value>, Error>) -> Void) -> Void) {
        let finish: ((Result<Value?, Error>) -> Void)? = completion.map { done in
            { (result: Result<Value?, Error>) in
                done(result.flatMap { value -> Result<Value, Error> in
                    value.map { .success($0) } ?? .failure(LabError.message("漂流结果缺失"))
                })
            }
        }
        mutate(message: message, requiresResult: true, completion: finish, operation: operation)
    }

    private func mutate<Value: Decodable>(message: String, requiresResult: Bool, completion: ((Result<Value?, Error>) -> Void)?,
                                          operation: (@escaping (Result<WorkspaceDriftReply<Value>, Error>) -> Void) -> Void) {
        guard !busy else {
            completion?(.failure(LabError.message("正在保存漂流，请稍后重试"))); return
        }
        busy = true; onChange?()
        operation { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let reply):
                self.apply(reply.library, message: message)
                self.onLibrary?(reply.library)
                if reply.result == nil, requiresResult { completion?(.failure(LabError.message("漂流结果缺失"))) }
                else { completion?(.success(reply.result)) }
            case .failure(let error):
                self.showStatus(error.localizedDescription)
                completion?(.failure(error))
            }
            self.rereadIfNeeded()
        }
    }

    private func rereadIfNeeded() {
        guard rereadAfterCommand, !busy else { return }
        rereadAfterCommand = false
        load()
    }
}
