import Foundation

/// One project on the 项目书架: its name and summary, live chapters, book
/// words and when anything in it was last edited.
struct ProjectShelfEntry: Equatable {
    let project: WorkspaceProject
    var summary: String
    var chapterCount: Int
    /// Chapter words; `wordsReady` is false while a chapter has no count yet.
    var words: Int
    var wordsReady: Bool
    /// The latest `updated_at` of the project and its live chapters and drifts.
    var lastEdited: String

    var lastEditedDate: Date? { WorkspaceTrashText.date(lastEdited) }

    /// “12 章 · 34,567 字”.
    var countsText: String {
        "\(chapterCount) 章 · " + (wordsReady ? WordCountText.full(words) : "\(WordCountText.full(words))（部分章节尚未统计）")
    }

    /// “最后编辑 2026-09-28 14:05”.
    var lastEditedText: String {
        guard let date = lastEditedDate else { return "最后编辑时间未知" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return "最后编辑 \(formatter.string(from: date))"
    }
}

/// 项目书架: every project of the workspace, newest edit first. Each is
/// read with `workspaceMetadata` (project and nodes) and `workspaceMetrics`;
/// reading writes nothing. Create and rename go through the workspace
/// commands; deletion reuses the project deletion flow.
final class ProjectShelfModel {
    private let workspace: LabWorkspaceCore
    private(set) var entries: [ProjectShelfEntry] = []
    private(set) var loaded = false
    private(set) var busy = false
    private(set) var status = "正在读取项目…"
    var onChange: (() -> Void)?
    private var generation = 0

    init(workspace: LabWorkspaceCore) { self.workspace = workspace }

    func showStatus(_ message: String) { status = message; onChange?() }

    /// Reads every project again, then its details, nodes and counts.
    func load(completion: (() -> Void)? = nil) {
        generation += 1
        let current = generation
        busy = true; onChange?()
        workspace.projects { [weak self] result in
            guard let self, current == self.generation else { return }
            switch result {
            case .failure(let error):
                self.busy = false; self.loaded = true
                self.showStatus(error.localizedDescription)
                completion?()
            case .success(let projects):
                self.read(projects[...], into: [], generation: current, completion: completion)
            }
        }
    }

    /// One project after another on the serial workspace queue.
    private func read(_ remaining: ArraySlice<WorkspaceProject>, into read: [ProjectShelfEntry], generation current: Int,
                      completion: (() -> Void)?) {
        guard current == generation else { return }
        guard let project = remaining.first else {
            entries = Self.sorted(read)
            busy = false; loaded = true
            status = read.isEmpty ? "还没有项目。点“新建项目”开始写作。" : "共 \(read.count) 个项目，按最后编辑时间排列。"
            onChange?()
            completion?()
            return
        }
        entry(for: project) { [weak self] entry in
            self?.read(remaining.dropFirst(), into: read + [entry], generation: current, completion: completion)
        }
    }

    private func entry(for project: WorkspaceProject, completion: @escaping (ProjectShelfEntry) -> Void) {
        workspace.projectDetails(projectID: project.id) { [weak self] details in
            guard let self else { return }
            self.workspace.nodesMetadata(projectID: project.id) { [weak self] nodes in
                guard let self else { return }
                self.workspace.wordCounts(projectID: project.id) { counts in
                    let library = (try? counts.get()).map { WordCountLibrary($0.counts) }
                    let details = try? details.get()
                    let stamps = [details?.updatedAt].compactMap { $0 } + ((try? nodes.get()) ?? []).map(\.updatedAt)
                    let latest = stamps.max { (WorkspaceTrashText.date($0) ?? .distantPast) < (WorkspaceTrashText.date($1) ?? .distantPast) }
                    let chapters = ((try? nodes.get()) ?? []).filter { $0.kind == "chapter" }.count
                    completion(ProjectShelfEntry(project: project, summary: details?.summary ?? "",
                                                 chapterCount: library?.chapters.count ?? chapters,
                                                 words: library?.chapterTotal ?? 0, wordsReady: library?.ready ?? false,
                                                 lastEdited: latest ?? ""))
                }
            }
        }
    }

    static func sorted(_ entries: [ProjectShelfEntry]) -> [ProjectShelfEntry] {
        entries.sorted { left, right in
            let (a, b) = (left.lastEditedDate ?? .distantPast, right.lastEditedDate ?? .distantPast)
            if a != b { return a > b }
            return left.project.name.localizedStandardCompare(right.project.name) == .orderedAscending
        }
    }

    func create(name: String, completion: @escaping (Result<WorkspaceProject, Error>) -> Void) {
        guard !busy else { completion(.failure(LabError.message("正在读取项目，请稍后重试。"))); return }
        workspace.createProject(name: name) { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error): self.showStatus(error.localizedDescription); completion(result)
            case .success(let project):
                self.load { [weak self] in self?.showStatus("已新建项目“\(project.name)”。"); completion(result) }
            }
        }
    }

    func rename(projectID: String, name: String, completion: @escaping (Result<WorkspaceProject, Error>) -> Void) {
        guard !busy else { completion(.failure(LabError.message("正在读取项目，请稍后重试。"))); return }
        workspace.renameProject(projectID: projectID, name: name) { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error): self.showStatus(error.localizedDescription); completion(result)
            case .success(let project):
                self.load { [weak self] in self?.showStatus("项目已重命名为“\(project.name)”。"); completion(result) }
            }
        }
    }
}
