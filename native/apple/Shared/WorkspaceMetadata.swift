import Foundation

/// A chapter's or drift's writing status. Chapters take 草稿, 已完成 and 已弃用;
/// drifts take 漂浮中 and 休眠 (the renderer's zh-CN `editorTopBar.status`
/// labels). Rust refuses a status of the other kind.
enum WritingStatus: String, CaseIterable {
    case draft, finished, discarded, drifting, resting

    static let chapter: [WritingStatus] = [.draft, .finished, .discarded]
    static let drift: [WritingStatus] = [.drifting, .resting]
    /// The statuses a node of this kind (`chapter` or `drift`) offers, in menu order.
    static func options(kind: String) -> [WritingStatus] { kind == "drift" ? drift : chapter }

    var label: String {
        switch self {
        case .draft: return "草稿"
        case .finished: return "已完成"
        case .discarded: return "已弃用"
        case .drifting: return "漂浮中"
        case .resting: return "休眠"
        }
    }

    /// The label of a stored value; an unknown value shows as stored.
    static func label(_ value: String) -> String { WritingStatus(rawValue: value)?.label ?? value }
}

/// A chapter's or drift's summary and writing status as Rust stores them.
struct WorkspaceNodeMetadata: Decodable, Equatable {
    let id: String
    /// `chapter` or `drift`.
    let kind: String
    let title: String
    let summary: String
    let writingStatus: String
    let updatedAt: String
}

/// A project with its summary, ordered facts (本书字段) and the storyline
/// template (故事线字段模版) that new storylines clone at creation.
struct WorkspaceProjectDetails: Decodable, Equatable {
    let id: String
    let name: String
    let summary: String
    let userId: String
    let createdAt: String
    let updatedAt: String
    let projectSyncId: String
    let syncGenerationId: String
    /// Ordered facts; rows with a blank key and value are never stored.
    let facts: [WorkspaceFact]
    let storylineTemplate: [WorkspaceFact]
}

/// Present fields are written in one original; absent fields stay unchanged
/// and an unchanged field writes nothing. Facts are sent exactly as typed.
struct WorkspaceProjectChanges: Equatable {
    var summary: String?
    var facts: [WorkspaceFact]?
    var storylineTemplate: [WorkspaceFact]?

    var fields: [String: Any] {
        var fields: [String: Any] = [:]
        if let summary { fields["summary"] = summary }
        if let facts { fields["facts"] = facts.map(\.payload) }
        if let storylineTemplate { fields["storylineTemplate"] = storylineTemplate.map(\.payload) }
        return fields
    }
}

/// Every metadata command replies `{"result": …}`.
struct WorkspaceMetadataReply<Value: Decodable>: Decodable {
    let result: Value
}

extension WorkspaceChapter {
    /// “共 3 章 · 草稿 1 · 已完成 1 · 已弃用 1”, counting chapters by status as
    /// the renderer's dashboard does; statuses without chapters are left out.
    static func statusSummary(_ chapters: [WorkspaceChapter]) -> String {
        guard !chapters.isEmpty else { return "还没有章节。" }
        let counts = WritingStatus.chapter.compactMap { status -> String? in
            let count = chapters.filter { $0.writingStatus == status.rawValue }.count
            return count == 0 ? nil : "\(status.label) \(count)"
        }
        return (["共 \(chapters.count) 章"] + counts).joined(separator: " · ")
    }
}

/// Presentation state of one project's 项目资料 sheet: the stored details and
/// the chapters counted by status. Rust owns every value; the sheet owns
/// typed text and when each part is written.
final class ProjectProfileModel {
    let projectID: String
    private let workspace: LabWorkspaceCore
    private(set) var details: WorkspaceProjectDetails?
    private(set) var chapters: [WorkspaceChapter]?
    private(set) var loading = false
    /// Why the details could not be read; the sheet then stays read-only.
    private(set) var loadError: String?
    var onChange: (() -> Void)?

    init(workspace: LabWorkspaceCore, projectID: String) {
        self.workspace = workspace
        self.projectID = projectID
    }

    var chapterSummary: String? { chapters.map(WorkspaceChapter.statusSummary) }

    /// The project's word counts, supplied by the window; nil until read.
    private(set) var wordCounts: WordCountLibrary?

    /// “全书 1,234 字”, or 统计中… until every chapter is counted.
    var wordSummary: String { WordCountText.book(wordCounts) }

    func applyWordCounts(_ library: WordCountLibrary) {
        guard wordCounts != library else { return }
        wordCounts = library
        onChange?()
    }

    /// Reads the project's details, then its chapters for the status counts.
    func load() {
        guard !loading else { return }
        loading = true; onChange?()
        workspace.projectDetails(projectID: projectID) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let details): self.details = details; self.loadError = nil
            case .failure(let error): self.loadError = error.localizedDescription
            }
            self.workspace.chapters(projectID: self.projectID) { [weak self] chapters in
                guard let self else { return }
                self.loading = false
                if case .success(let chapters) = chapters { self.chapters = chapters }
                self.onChange?()
            }
        }
    }

    /// Writes the present fields in one original and adopts the stored details.
    func update(_ changes: WorkspaceProjectChanges, completion: @escaping (Result<WorkspaceProjectDetails, Error>) -> Void) {
        workspace.updateProject(projectID: projectID, changes: changes) { [weak self] result in
            if let self, case .success(let details) = result {
                self.details = details
                self.onChange?()
            }
            completion(result)
        }
    }
}
