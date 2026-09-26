import Foundation

struct WorkspaceSearchScope: Codable, Equatable {
    let projectId: String
    let projectSyncId: String
    let syncGenerationId: String
    let documentId: String
    let incarnation: UInt64
}

struct WorkspaceSearchMatch: Codable, Equatable {
    let startAnchor: String
    let endAnchor: String
    let matchedText: String
}

struct WorkspaceSearchHit: Codable, Equatable {
    let chapterId: String
    let chapterTitle: String
    let kind: String
    let preview: String
    let scope: WorkspaceSearchScope
    let match: WorkspaceSearchMatch?
}

struct WorkspaceSearchUnavailable: Decodable {
    let chapterId: String
    let chapterTitle: String
    let message: String
}

struct WorkspaceSearchResult: Decodable {
    let hits: [WorkspaceSearchHit]
    let unavailable: [WorkspaceSearchUnavailable]
    let truncated: Bool
}

struct WorkspaceSearchLocation: Decodable {
    let revision: UInt64
    let range: NativeRange?
}

/// Only query presentation is shared here. Matching, limits, scope validation
/// and CRDT anchor resolution remain in the Rust workspace owner.
final class WorkspaceSearchModel {
    let projectID: String
    private let workspace: LabWorkspaceCore
    private var generation = 0
    private var scheduledSearch: DispatchWorkItem?
    private(set) var query = ""
    private(set) var hits: [WorkspaceSearchHit] = []
    private(set) var unavailable: [WorkspaceSearchUnavailable] = []
    private(set) var truncated = false
    private(set) var busy = false
    private(set) var status = "输入文字，搜索章节标题和正文。"
    var onChange: (() -> Void)?

    init(workspace: LabWorkspaceCore, projectID: String) {
        self.workspace = workspace; self.projectID = projectID
    }

    func search(_ query: String) {
        precondition(Thread.isMainThread)
        generation += 1
        let request = generation
        self.query = query; hits = []; unavailable = []; truncated = false
        scheduledSearch?.cancel()
        scheduledSearch = nil
        if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            busy = false; status = "输入文字，搜索章节标题和正文。"; onChange?()
            return
        }
        busy = true; status = "正在搜索…"; onChange?()
        let work = DispatchWorkItem { [weak self] in self?.performSearch(query, request: request) }
        scheduledSearch = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(180), execute: work)
    }

    private func performSearch(_ query: String, request: Int) {
        guard generation == request else { return }
        scheduledSearch = nil
        workspace.search(projectID: projectID, query: query) { [weak self] result in
            guard let self, self.generation == request else { return }
            self.busy = false
            switch result {
            case .success(let value):
                self.hits = value.hits; self.unavailable = value.unavailable; self.truncated = value.truncated
                self.status = value.hits.isEmpty
                    ? (value.unavailable.isEmpty ? "没有找到匹配内容。" : "搜索未完成，当前可读取章节中没有匹配内容。")
                    : "找到 \(value.hits.count) 个结果。"
                if value.truncated { self.status += " 结果已截断，请缩小查询范围。" }
                if !value.unavailable.isEmpty { self.status += " \(value.unavailable.count) 个章节暂时无法搜索，详情见列表。" }
            case .failure(let error): self.status = error.localizedDescription
            }
            self.onChange?()
        }
    }

    func showStatus(_ message: String) { status = message; onChange?() }
}
