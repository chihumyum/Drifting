import Foundation

/// Presentation state only. Rust supplies book order, heading membership and
/// parent identities; the UI owns disclosure and temporary read results.
final class WorkspaceOutlineModel {
    struct Row {
        let entry: WorkspaceOutlineEntry
        let heading: NativeOutlineItem?
        let message: String?
        let depth: Int
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
    private(set) var status = "正在读取整书大纲…"
    var onChange: (() -> Void)?

    init(workspace: LabWorkspaceCore, projectID: String) {
        self.workspace = workspace
        self.projectID = projectID
    }

    func showStatus(_ message: String) { status = message; onChange?() }

    func load() {
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
