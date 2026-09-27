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

/// A hit beyond chapter titles and prose: a chapter summary, a drift, an
/// element (name, alias, summary, fact), a category, a storyline or a library
/// item. Body hits carry their document scope and CRDT anchors and are sent
/// back unchanged to `workspaceResolveEntityHit`.
struct WorkspaceEntitySearchHit: Codable, Equatable {
    /// `chapter`, `drift`, `element`, `category`, `storyline` or `library`.
    let kind: String
    let id: String
    let title: String
    /// `title`, `name`, `alias`, `summary`, `fact`, `body`, `text` or `notes`.
    let field: String
    let preview: String
    let scope: WorkspaceSearchScope?
    let match: WorkspaceSearchMatch?

    var isBody: Bool { field == "body" && match != nil }
}

/// A body that could not be read; it is listed, never treated as no match.
struct WorkspaceEntitySearchUnavailable: Decodable, Equatable {
    let kind: String
    let id: String
    let title: String
    let message: String
}

struct WorkspaceEntitySearchResult: Decodable {
    let hits: [WorkspaceEntitySearchHit]
    let unavailable: [WorkspaceEntitySearchUnavailable]
    let truncated: Bool
}

/// The global search panel's sections and field names, in Chinese.
enum WorkspaceSearchText {
    /// Entity sections after the chapter results, in display order.
    static let sections: [(kind: String, title: String)] = [
        ("chapter", "章节摘要"), ("drift", "漂流"), ("element", "设定"), ("category", "分类"), ("storyline", "故事线"), ("library", "素材"),
    ]

    static func field(_ field: String) -> String {
        switch field {
        case "title", "name": return "名称"
        case "alias": return "别名"
        case "summary": return "摘要"
        case "fact": return "设定项"
        case "body": return "正文"
        case "text": return "文字"
        case "notes": return "备注"
        default: return field
        }
    }

    /// UTF-16 ranges of the trimmed query in `text`, matched by Unicode scalar
    /// lowercase as Rust matches it, for emphasis in a preview.
    static func matches(of query: String, in text: String) -> [NSRange] {
        let needle = Array(query.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.flatMap { $0.properties.lowercaseMapping.unicodeScalars })
        guard !needle.isEmpty else { return [] }
        var folded: [Unicode.Scalar] = []
        var owners: [(start: Int, end: Int)] = []
        var offset = 0
        for scalar in text.unicodeScalars {
            let end = offset + scalar.utf16.count
            for lowered in scalar.properties.lowercaseMapping.unicodeScalars {
                folded.append(lowered); owners.append((offset, end))
            }
            offset = end
        }
        var ranges: [NSRange] = []
        var index = 0
        while index + needle.count <= folded.count {
            if Array(folded[index..<(index + needle.count)]) == needle {
                let start = owners[index].start, end = owners[index + needle.count - 1].end
                if ranges.last.map({ start >= $0.location + $0.length }) ?? true {
                    ranges.append(NSRange(location: start, length: end - start))
                }
                index += needle.count
            } else {
                index += 1
            }
        }
        return ranges
    }
}

/// Only query presentation is shared here. Matching, limits, scope validation
/// and CRDT anchor resolution remain in the Rust workspace owner. With
/// `includesEntities` (the Mac's global search) each query also searches
/// summaries, drifts, elements, categories, storylines and materials; both
/// replies of one query are shown together.
final class WorkspaceSearchModel {
    let projectID: String
    let includesEntities: Bool
    private let workspace: LabWorkspaceCore
    private var generation = 0
    private var scheduledSearch: DispatchWorkItem?
    private(set) var query = ""
    private(set) var hits: [WorkspaceSearchHit] = []
    private(set) var unavailable: [WorkspaceSearchUnavailable] = []
    private(set) var truncated = false
    private(set) var entityHits: [WorkspaceEntitySearchHit] = []
    private(set) var entityUnavailable: [WorkspaceEntitySearchUnavailable] = []
    private(set) var entityTruncated = false
    private(set) var busy = false
    private(set) var status: String
    /// Queries sent to Rust, for acceptance: superseded input sends nothing.
    private(set) var requests = 0
    var onChange: (() -> Void)?

    init(workspace: LabWorkspaceCore, projectID: String, includesEntities: Bool = false) {
        self.workspace = workspace; self.projectID = projectID; self.includesEntities = includesEntities
        status = includesEntities ? Self.globalPrompt : Self.chapterPrompt
    }

    private static let chapterPrompt = "输入文字，搜索章节标题和正文。"
    private static let globalPrompt = "输入文字，搜索章节、摘要、漂流、设定、分类、故事线和素材。"

    func search(_ query: String) {
        precondition(Thread.isMainThread)
        generation += 1
        let request = generation
        self.query = query; hits = []; unavailable = []; truncated = false
        entityHits = []; entityUnavailable = []; entityTruncated = false
        scheduledSearch?.cancel()
        scheduledSearch = nil
        if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            busy = false; status = includesEntities ? Self.globalPrompt : Self.chapterPrompt; onChange?()
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
        requests += 1
        workspace.search(projectID: projectID, query: query) { [weak self] result in
            guard let self, self.generation == request else { return }
            guard self.includesEntities, case .success = result else { self.finish(result, nil); return }
            self.workspace.searchEntities(projectID: self.projectID, query: query) { [weak self] entities in
                guard let self, self.generation == request else { return }
                self.finish(result, entities)
            }
        }
    }

    private func finish(_ chapters: Result<WorkspaceSearchResult, Error>, _ entities: Result<WorkspaceEntitySearchResult, Error>?) {
        busy = false
        switch chapters {
        case .success(let value):
            hits = value.hits; unavailable = value.unavailable; truncated = value.truncated
        case .failure(let error):
            status = error.localizedDescription; onChange?(); return
        }
        var entityError: String?
        switch entities {
        case .success(let value)?:
            entityHits = value.hits; entityUnavailable = value.unavailable; entityTruncated = value.truncated
        case .failure(let error)?: entityError = error.localizedDescription
        case nil: break
        }
        let found = hits.count + entityHits.count
        let unreadable = unavailable.count + entityUnavailable.count
        status = found == 0
            ? (unreadable == 0 ? "没有找到匹配内容。" : "搜索未完成，当前可读取的内容中没有匹配。")
            : "找到 \(found) 个结果。"
        if !includesEntities {
            status = hits.isEmpty
                ? (unavailable.isEmpty ? "没有找到匹配内容。" : "搜索未完成，当前可读取章节中没有匹配内容。")
                : "找到 \(hits.count) 个结果。"
        }
        if truncated || entityTruncated { status += " 结果已截断，请缩小查询范围。" }
        if !unavailable.isEmpty && !includesEntities { status += " \(unavailable.count) 个章节暂时无法搜索，详情见列表。" }
        if includesEntities && unreadable > 0 { status += " \(unreadable) 处正文暂时无法读取，详情见列表。" }
        if let entityError { status += " 设定、漂流等内容未能搜索：\(entityError)" }
        onChange?()
    }

    func showStatus(_ message: String) { status = message; onChange?() }
}
