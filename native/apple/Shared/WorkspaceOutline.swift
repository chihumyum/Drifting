import Foundation

/// Presentation state only. Rust supplies book order, heading membership and
/// parent identities; the UI owns disclosure and temporary read results.
final class WorkspaceOutlineModel {
    struct Row {
        let entry: WorkspaceOutlineEntry
        let heading: NativeOutlineItem?
        let message: String?
        let depth: Int
        var isAct: Bool { entry.kind == "act" && heading == nil && message == nil }
        var isChapter: Bool { entry.kind == "chapter" && heading == nil && message == nil }
        var navigable: Bool { entry.kind == "chapter" && message == nil }
        var label: String { message ?? heading?.label ?? "\(entry.kind == "act" ? "幕" : "章") · \(entry.title)" }
        var identifier: String {
            if let heading { return "outline-heading-\(heading.blockId)" }
            return "outline-\(entry.kind)-\(entry.id)"
        }
    }

    let projectID: String
    private let workspace: LabWorkspaceCore
    private(set) var entries: [WorkspaceOutlineEntry] = []
    private(set) var expanded: Set<String> = []
    private var details: [String: [NativeOutlineItem]] = [:]
    private var reading: Set<String> = []
    private var errors: [String: String] = [:]
    private var activeChapterID: String?
    private var activeOutline: [NativeOutlineItem] = []
    private var requestID = 0
    private(set) var busy = false
    private(set) var status = "正在读取整书大纲…"
    /// Chapter memberships for each chapter's 主线 colour; nil until read.
    private(set) var storylines: WorkspaceStorylineLibrary?
    var onChange: (() -> Void)?

    init(workspace: LabWorkspaceCore, projectID: String) {
        self.workspace = workspace
        self.projectID = projectID
    }

    func showStatus(_ message: String) { status = message; onChange?() }

    /// Adopt the project's storyline library; rows show each chapter's 主线.
    func applyStorylines(_ library: WorkspaceStorylineLibrary) {
        guard storylines != library else { return }
        storylines = library
        onChange?()
    }

    /// The chapter's live 主线, or nil when it is 未归属 (or not yet read).
    func primaryStoryline(chapterID: String) -> WorkspaceStoryline? { storylines?.primary(chapterID: chapterID) }

    func load() {
        guard !busy else { return }
        requestID += 1
        let request = requestID
        workspace.outline(projectID: projectID) { [weak self] result in
            guard let self, self.requestID == request else { return }
            switch result {
            case .success(let entries):
                self.entries = entries
                self.status = entries.isEmpty ? "还没有章节。新建章节后，大纲会显示在这里。" : "展开章节查看场、拍、注；点击标题跳转。"
            case .failure(let error): self.status = error.localizedDescription
            }
            self.onChange?()
        }
    }

    func createAct(beforeChapterID: String, completion: ((Result<WorkspaceAct, Error>) -> Void)? = nil) {
        mutate(message: "已在此章节前开始一幕。", completion: completion) {
            workspace.createAct(projectID: projectID, chapterID: beforeChapterID, completion: $0)
        }
    }

    func renameAct(id: String, name: String, completion: ((Result<WorkspaceAct, Error>) -> Void)? = nil) {
        mutate(message: "幕名称已保存。", completion: completion) {
            workspace.renameAct(projectID: projectID, actID: id, name: name, completion: $0)
        }
    }

    func removeAct(id: String, completion: ((Result<WorkspaceAct, Error>) -> Void)? = nil) {
        mutate(message: "幕分界已移除，章节和正文保持不变。", completion: completion) {
            workspace.removeAct(projectID: projectID, actID: id, completion: $0)
        }
    }

    private func mutate(message: String, completion: ((Result<WorkspaceAct, Error>) -> Void)?,
                        operation: (@escaping (Result<WorkspaceAct, Error>) -> Void) -> Void) {
        guard !busy else {
            completion?(.failure(LabError.message("正在保存幕分界，请稍后重试"))); return
        }
        busy = true
        requestID += 1 // An older initial read must not overwrite the refreshed hierarchy.
        status = "正在保存幕分界…"
        onChange?()
        operation { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.busy = false; self.status = error.localizedDescription
                self.onChange?(); completion?(.failure(error))
            case .success(let act):
                // Only Rust assigns coordinates, names and chapter membership.
                // Keep disclosures and authoritative heading details in place.
                self.workspace.outline(projectID: self.projectID) { [weak self] refreshed in
                    guard let self else { return }
                    self.busy = false
                    switch refreshed {
                    case .success(let entries): self.entries = entries; self.status = message
                    case .failure(let error): self.status = "幕分界已保存，大纲读取失败：" + error.localizedDescription
                    }
                    self.onChange?(); completion?(.success(act))
                }
            }
        }
    }

    func updateActive(chapterID: String, outline: [NativeOutlineItem]) {
        guard activeChapterID != chapterID || activeOutline != outline else { return }
        activeChapterID = chapterID
        activeOutline = outline
        details[chapterID] = outline
        errors.removeValue(forKey: chapterID)
        onChange?()
    }

    func toggle(_ chapterID: String) {
        if expanded.remove(chapterID) != nil { onChange?(); return }
        expanded.insert(chapterID)
        if chapterID == activeChapterID { details[chapterID] = activeOutline }
        guard details[chapterID] == nil, !reading.contains(chapterID) else { onChange?(); return }
        errors.removeValue(forKey: chapterID)
        reading.insert(chapterID)
        onChange?()
        workspace.chapterOutline(projectID: projectID, chapterID: chapterID) { [weak self] result in
            guard let self else { return }
            self.reading.remove(chapterID)
            if chapterID == self.activeChapterID { self.details[chapterID] = self.activeOutline }
            else {
                switch result {
                case .success(let items): self.details[chapterID] = items
                case .failure(let error): self.errors[chapterID] = error.localizedDescription
                }
            }
            self.onChange?()
        }
    }

    var rows: [Row] {
        entries.flatMap { entry -> [Row] in
            var rows = [Row(entry: entry, heading: nil, message: nil, depth: 0)]
            guard entry.kind == "chapter", expanded.contains(entry.id) else { return rows }
            guard let items = details[entry.id] else {
                rows.append(Row(entry: entry, heading: nil, message: errors[entry.id] ?? "正在读取章节大纲…", depth: 1))
                return rows
            }
            if items.isEmpty {
                rows.append(Row(entry: entry, heading: nil, message: "本章暂无场、拍或注", depth: 1))
            }
            let byID = Dictionary(items.map { ($0.blockId, $0) }, uniquingKeysWith: { first, _ in first })
            for item in items {
                var depth = 1, parent = item.parentId, seen = Set([item.blockId])
                while let id = parent, let ancestor = byID[id], seen.insert(id).inserted {
                    depth += 1; parent = ancestor.parentId
                }
                rows.append(Row(entry: entry, heading: item, message: nil, depth: depth))
            }
            return rows
        }
    }
}
