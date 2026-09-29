import Foundation

/// One live chapter's or drift's canonical word count as Rust reads it from
/// `book_node`; nil until a canonical basis exists (`hasCanonicalWordCount`).
struct WorkspaceNodeWordCount: Decodable, Equatable {
    let nodeId: String
    /// `chapter` or `drift`.
    let kind: String
    let wordCount: Int?
}

/// A node reconciliation could not project; its stored count is kept.
struct WorkspaceWordCountFailure: Decodable, Equatable {
    let nodeId: String
    let error: String
}

/// Every `workspaceMetrics` reply: the counts after the command, and the
/// nodes a reconcile could not project (always empty for `counts`).
struct WorkspaceWordCounts: Decodable, Equatable {
    let counts: [WorkspaceNodeWordCount]
    let failures: [WorkspaceWordCountFailure]
}

/// One project's counts, looked up by node. The book total counts chapters
/// only, as `sumCanonicalChapterWordCounts` does; it is ready once every live
/// chapter has a canonical count.
struct WordCountLibrary: Equatable {
    let nodes: [WorkspaceNodeWordCount]
    private let byID: [String: WorkspaceNodeWordCount]

    init(_ nodes: [WorkspaceNodeWordCount]) {
        self.nodes = nodes
        byID = Dictionary(nodes.map { ($0.nodeId, $0) }, uniquingKeysWith: { first, _ in first })
    }

    static let empty = WordCountLibrary([])

    static func == (lhs: WordCountLibrary, rhs: WordCountLibrary) -> Bool { lhs.nodes == rhs.nodes }

    /// Whether the node is a live chapter or drift of this project.
    func contains(nodeID: String) -> Bool { byID[nodeID] != nil }
    /// The node's canonical count; nil when it has none or is not live.
    func count(nodeID: String) -> Int? { byID[nodeID]?.wordCount }

    var chapters: [WorkspaceNodeWordCount] { nodes.filter { $0.kind == "chapter" } }
    var drifts: [WorkspaceNodeWordCount] { nodes.filter { $0.kind == "drift" } }
    /// Chapters with a count, summed; uncounted chapters add nothing.
    var chapterTotal: Int { chapters.reduce(0) { $0 + ($1.wordCount ?? 0) } }
    var driftTotal: Int { drifts.reduce(0) { $0 + ($1.wordCount ?? 0) } }
    /// Every live chapter has a canonical count, so the book total is exact.
    var ready: Bool { chapters.allSatisfy { $0.wordCount != nil } }

    /// The sum over these chapters, e.g. a storyline's; nil while any of
    /// them is uncounted or not live.
    func total(chapterIDs: [String]) -> Int? {
        var sum = 0
        for id in chapterIDs {
            guard let count = count(nodeID: id) else { return nil }
            sum += count
        }
        return sum
    }
}

/// `@drifting/prose-metrics`' `countWords` for a text the Mac holds but Rust
/// has not counted (a 章节模版): CJK ideographs, plus Latin tokens (runs
/// between whitespace, CJK and full-width forms counting as spaces) holding
/// an ASCII letter or digit. Canonical counts still come from Rust.
enum ProseWordCount {
    static func count(_ text: String) -> Int {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return 0 }
        func ideograph(_ value: UInt32) -> Bool { (0x3400...0x4DBF).contains(value) || (0x4E00...0x9FFF).contains(value) }
        func strippable(_ value: UInt32) -> Bool {
            (0x3000...0x303F).contains(value) || ideograph(value) || (0xFF00...0xFFEF).contains(value)
        }
        var cjk = 0, latin = 0, token = false, alphanumeric = false
        func end() { if token, alphanumeric { latin += 1 }; token = false; alphanumeric = false }
        for scalar in trimmed.unicodeScalars {
            if ideograph(scalar.value) { cjk += 1 }
            if strippable(scalar.value) || scalar.properties.isWhitespace { end(); continue }
            token = true
            if scalar.isASCII, CharacterSet.alphanumerics.contains(scalar) { alphanumeric = true }
        }
        end()
        return cjk + latin
    }
}

/// The renderer's zh-CN wording and number formats.
enum WordCountText {
    /// `common.counting`.
    static let counting = "统计中…"
    /// `bottomStatusBar.metricsPending`: nothing has been read yet.
    static let pending = "正文统计中"

    /// `toLocaleString()` in zh-CN: 1,234.
    static func grouped(_ value: Int) -> String {
        let digits = String(value.magnitude)
        var result = ""
        for (index, digit) in digits.enumerated() {
            if index > 0, (digits.count - index) % 3 == 0 { result.append(",") }
            result.append(digit)
        }
        return value < 0 ? "-" + result : result
    }

    /// `dashboard.wordCount`: “1,234 字”, for page headers.
    static func full(_ value: Int) -> String { "\(grouped(value)) 字" }

    /// The chapter panel's compact cell count, raw under 1k, one-decimal k up
    /// to 10k and rounded k beyond (0 / 521 / 1.2k / 12k), with its unit.
    static func compact(_ value: Int) -> String {
        guard value >= 1000 else { return "\(value) 字" }
        // `toFixed(1)` and `Math.round` round halves up.
        if value < 10000 {
            let tenths = (value + 50) / 100
            return "\(tenths / 10).\(tenths % 10)k 字"
        }
        return "\((value + 500) / 1000)k 字"
    }

    /// “全书 1,234 字” (`bottomStatusBar.projectWords`), or 统计中… until every
    /// chapter is counted; 正文统计中 before the first read.
    static func book(_ library: WordCountLibrary?) -> String {
        guard let library else { return pending }
        return library.ready ? "全书 \(grouped(library.chapterTotal)) 字" : "全书 \(counting)"
    }
}

/// What the window's status line counts beside the book.
enum WordCountFocus: Equatable {
    case none
    /// The active chapter or drift page (`bottomStatusBar.currentWords`).
    case node(String)
    /// The active chapter, with its 主线's name and that storyline's chapters.
    case chapter(String, storyline: String, chapterIDs: [String])
    /// The active storyline page's chapters (`bottomStatusBar.storylineWords`).
    case storyline([String])
}

extension WordCountText {
    /// “当前 1,234 字 · 主线「北境」5,678 字 · 全书 12,345 字”. An uncounted
    /// node shows no 当前; an incomplete storyline shows 统计中….
    static func statusLine(_ library: WordCountLibrary?, focus: WordCountFocus) -> String {
        guard let library else { return pending }
        var parts: [String] = []
        switch focus {
        case .none: break
        case .node(let id):
            if let count = library.count(nodeID: id) { parts.append("当前 \(grouped(count)) 字") }
        case .chapter(let id, let name, let ids):
            if let count = library.count(nodeID: id) { parts.append("当前 \(grouped(count)) 字") }
            parts.append("主线「\(name)」" + (library.total(chapterIDs: ids).map { "\(grouped($0)) 字" } ?? counting))
        case .storyline(let ids):
            parts.append(library.total(chapterIDs: ids).map { "故事线 \(grouped($0)) 字" } ?? "故事线 \(counting)")
        }
        parts.append(book(library))
        return parts.joined(separator: " · ")
    }
}

/// One project's counts. The first read reconciles every live chapter and
/// drift, as the renderer does when a project opens; later reads follow body
/// saves, creation, trash, restore and remote receipts, debounced and one at
/// a time. Reads write no original and never change `updated_at`.
final class WordCountModel {
    private enum Read { case counts, reconcile }

    let projectID: String
    private let workspace: LabWorkspaceCore
    /// Nil until the first read returns.
    private(set) var library: WordCountLibrary?
    private(set) var failures: [WorkspaceWordCountFailure] = []
    /// The last refused read's reason; the previous counts stay shown.
    private(set) var lastError: String?
    private(set) var reconciled = false
    /// Reads sent, for acceptance: bursts of saves coalesce into one.
    private(set) var reads = 0
    private(set) var reconciles = 0
    private var inFlight = false
    private var queued: Read?
    private var timer: DispatchWorkItem?
    /// Quiet time after the last save before counts are read again.
    static var refreshDelay: TimeInterval = 0.3
    /// Every read that changed the counts, and the first read.
    var onLibrary: ((WordCountLibrary) -> Void)?

    init(workspace: LabWorkspaceCore, projectID: String) {
        self.workspace = workspace
        self.projectID = projectID
    }

    var loaded: Bool { library != nil }
    /// No read is waiting, scheduled or in flight.
    var isIdle: Bool { !inFlight && queued == nil && timer == nil }

    /// Reconciles once, then only reads counts.
    func load() {
        if reconciled { scheduleRefresh() } else { send(.reconcile) }
    }

    /// Projects every live body again, e.g. after a remote original changed
    /// bodies that have no open owner.
    func reconcile() {
        cancelTimer()
        send(.reconcile)
    }

    /// Reads counts once saves have been quiet for `refreshDelay`.
    func scheduleRefresh() {
        cancelTimer()
        let timer = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.timer = nil
            self.send(.counts)
        }
        self.timer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.refreshDelay, execute: timer)
    }

    /// Stops a scheduled read, e.g. when the workspace closes.
    func cancel() { cancelTimer(); queued = nil }

    private func cancelTimer() { timer?.cancel(); timer = nil }

    private func send(_ read: Read) {
        guard !inFlight else {
            // A reconcile also reads counts, so it covers a queued read.
            if queued != .reconcile { queued = read }
            return
        }
        inFlight = true
        reads += 1
        if read == .reconcile { reconciles += 1 }
        let done: (Result<WorkspaceWordCounts, Error>) -> Void = { [weak self] result in
            guard let self else { return }
            self.inFlight = false
            switch result {
            case .success(let reply):
                if read == .reconcile { self.reconciled = true; self.failures = reply.failures }
                self.lastError = nil
                let next = WordCountLibrary(reply.counts)
                if self.library != next {
                    self.library = next
                    self.onLibrary?(next)
                }
            case .failure(let error):
                self.lastError = error.localizedDescription
            }
            if let next = self.queued { self.queued = nil; self.send(next) }
        }
        switch read {
        case .counts: workspace.wordCounts(projectID: projectID, completion: done)
        case .reconcile: workspace.reconcileWordCounts(projectID: projectID, completion: done)
        }
    }
}
