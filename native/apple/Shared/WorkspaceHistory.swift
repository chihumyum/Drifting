import Foundation

/// The body whose 历史版本 are shown: a chapter, drift, element, storyline or
/// category.
struct VersionHistoryTarget: Equatable {
    let projectID: String
    /// `chapter`, `drift`, `element`, `storyline` or `category`.
    let kind: String
    let id: String
    /// The current title or name, for the sheet's heading.
    let title: String

    var kindName: String {
        switch kind {
        case "drift": return "漂流"
        case "element": return "设定"
        case "storyline": return "故事线"
        case "category": return "分类"
        default: return "章节"
        }
    }

    var payload: [String: Any] { ["kind": kind, "id": id] }

    var scope: DocumentScope {
        switch kind {
        case "drift": return .drift(DriftScope(projectID: projectID, driftID: id))
        case "element": return .element(ElementScope(projectID: projectID, elementID: id))
        case "storyline": return .storyline(StorylineScope(projectID: projectID, storylineID: id))
        case "category": return .category(CategoryScope(projectID: projectID, categoryID: id))
        default: return .chapter(ChapterScope(projectID: projectID, chapterID: id))
        }
    }
}

/// What a version records about its entity at that moment: a chapter's or
/// drift's title, summary and status; an element's or storyline's name and
/// summary (an element also its group); why it was captured and the body's
/// word count. Versions from before `reason` and `wordCount` lack them.
struct WorkspaceHistoryMeta: Decodable, Equatable {
    let title: String?
    let name: String?
    let summary: String?
    let writingStatus: String?
    let groupName: String?
    /// `periodic`, `close` or `restore`.
    let reason: String?
    let wordCount: Int?

    /// The title or name at the time.
    var displayName: String? { (title ?? name).flatMap { $0.isEmpty ? nil : $0 } }

    /// 自动保存, 关闭时 or 恢复前; nil for an unknown or missing reason.
    var reasonLabel: String? {
        switch reason {
        case "periodic": return "自动保存"
        case "close": return "关闭时"
        case "restore": return "恢复前"
        default: return nil
        }
    }

    /// “1,234 字”, when recorded.
    var wordCountText: String? { wordCount.map(WordCountText.full) }
}

/// One version, newest first in a list. `text` is a plain-text preview of
/// the whole body, one line per block.
struct WorkspaceHistoryEntry: Decodable, Equatable {
    let id: String
    let createdAt: String
    let meta: WorkspaceHistoryMeta?
    let text: String
}

struct WorkspaceHistoryList: Decodable {
    let entries: [WorkspaceHistoryEntry]
}

/// A restore's reply: the open owner that adopted the version (nil when a
/// temporary owner restored a closed body) and the body's state after it.
struct WorkspaceHistoryRestored: Decodable {
    let handle: UInt64?
    let document: LabDocumentState
}

/// How a version's time reads: 刚刚, N 分钟前, 今天 14:05, 昨天 14:05,
/// 9月25日 14:05, or with the year for earlier years.
enum VersionHistoryTime {
    static func date(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: iso) { return date }
        return ISO8601DateFormatter().date(from: iso)
    }

    static func label(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date = date(iso) else { return iso }
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "刚刚" }
        if seconds < 3600 { return "\(Int(seconds / 60)) 分钟前" }
        let time = format("HH:mm", date, calendar)
        if calendar.isDate(date, inSameDayAs: now) { return "今天 \(time)" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "昨天 \(time)"
        }
        if calendar.component(.year, from: date) == calendar.component(.year, from: now) {
            return format("M月d日 HH:mm", date, calendar)
        }
        return format("yyyy年M月d日 HH:mm", date, calendar)
    }

    /// The exact moment, for tooltips.
    static func exact(_ iso: String, calendar: Calendar = .current) -> String {
        guard let date = date(iso) else { return iso }
        return format("yyyy年M月d日 HH:mm:ss", date, calendar)
    }

    private static func format(_ pattern: String, _ date: Date, _ calendar: Calendar) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = pattern
        return formatter.string(from: date)
    }
}

/// A version compared with the current text, paragraph by paragraph (each
/// paragraph keeps its line break), with replaced paragraphs refined to
/// their changed middle. `added` text is in the version but not the current
/// text, so restoring brings it back; `removed` text restoring would remove.
/// Same and added segments spell the version; same and removed the current.
enum ProseDiff {
    enum Kind: Equatable { case same, added, removed }
    struct Segment: Equatable {
        let kind: Kind
        let text: String
    }

    static func segments(current: String, version: String, limit: Int = 1_000_000) -> [Segment] {
        let a = paragraphs(current), b = paragraphs(version)
        var prefix = 0
        while prefix < a.count, prefix < b.count, a[prefix] == b[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < a.count - prefix, suffix < b.count - prefix, a[a.count - 1 - suffix] == b[b.count - 1 - suffix] { suffix += 1 }
        var operations: [(Kind, String)] = a[..<prefix].map { (.same, $0) }
        operations += middle(Array(a[prefix..<(a.count - suffix)]), Array(b[prefix..<(b.count - suffix)]), limit: limit)
        operations += a[(a.count - suffix)...].map { (.same, $0) }
        var result: [Segment] = []
        func append(_ kind: Kind, _ text: String) {
            guard !text.isEmpty else { return }
            if let last = result.last, last.kind == kind { result[result.count - 1] = Segment(kind: kind, text: last.text + text) }
            else { result.append(Segment(kind: kind, text: text)) }
        }
        var index = 0
        while index < operations.count {
            if operations[index].0 == .same { append(.same, operations[index].1); index += 1; continue }
            var removed: [String] = [], added: [String] = []
            while index < operations.count, operations[index].0 != .same {
                if operations[index].0 == .removed { removed.append(operations[index].1) } else { added.append(operations[index].1) }
                index += 1
            }
            let pairs = min(removed.count, added.count)
            for pair in 0..<pairs {
                // Compare the paragraphs without their line breaks, so the
                // last paragraph of either text still pairs by its words.
                let oldBreak = removed[pair].hasSuffix("\n"), newBreak = added[pair].hasSuffix("\n")
                let old = Array(oldBreak ? removed[pair].dropLast() : Substring(removed[pair]))
                let new = Array(newBreak ? added[pair].dropLast() : Substring(added[pair]))
                var head = 0
                while head < old.count, head < new.count, old[head] == new[head] { head += 1 }
                var tail = 0
                while tail < old.count - head, tail < new.count - head, old[old.count - 1 - tail] == new[new.count - 1 - tail] { tail += 1 }
                append(.same, String(old[..<head]))
                append(.removed, String(old[head..<(old.count - tail)]))
                append(.added, String(new[head..<(new.count - tail)]))
                append(.same, String(old[(old.count - tail)...]))
                switch (oldBreak, newBreak) {
                case (true, true): append(.same, "\n")
                case (true, false): append(.removed, "\n")
                case (false, true): append(.added, "\n")
                case (false, false): break
                }
            }
            for text in removed.dropFirst(pairs) { append(.removed, text) }
            for text in added.dropFirst(pairs) { append(.added, text) }
        }
        return result
    }

    /// “a\nb” → ["a\n", "b"].
    static func paragraphs(_ text: String) -> [String] {
        guard !text.isEmpty else { return [] }
        var result: [String] = []
        var start = text.startIndex
        while let newline = text[start...].firstIndex(of: "\n") {
            let end = text.index(after: newline)
            result.append(String(text[start..<end]))
            start = end
        }
        if start < text.endIndex { result.append(String(text[start...])) }
        return result
    }

    /// A longest-common-subsequence script over paragraphs; beyond `limit`
    /// cells the whole middle reads as removed then added.
    private static func middle(_ a: [String], _ b: [String], limit: Int) -> [(Kind, String)] {
        if a.isEmpty { return b.map { (.added, $0) } }
        if b.isEmpty { return a.map { (.removed, $0) } }
        guard a.count * b.count <= limit else { return a.map { (.removed, $0) } + b.map { (.added, $0) } }
        let width = b.count + 1
        var table = [Int32](repeating: 0, count: (a.count + 1) * width)
        for i in stride(from: a.count - 1, through: 0, by: -1) {
            for j in stride(from: b.count - 1, through: 0, by: -1) {
                table[i * width + j] = a[i] == b[j] ? table[(i + 1) * width + j + 1] + 1
                    : max(table[(i + 1) * width + j], table[i * width + j + 1])
            }
        }
        var result: [(Kind, String)] = []
        var i = 0, j = 0
        while i < a.count, j < b.count {
            if a[i] == b[j] { result.append((.same, a[i])); i += 1; j += 1 }
            else if table[(i + 1) * width + j] >= table[i * width + j + 1] { result.append((.removed, a[i])); i += 1 }
            else { result.append((.added, b[j])); j += 1 }
        }
        result += a[i...].map { (.removed, $0) }
        result += b[j...].map { (.added, $0) }
        return result
    }
}

/// Presentation state of one body's 历史版本 sheet. Rust owns the versions,
/// their capture and the restore; this model sequences reads and one restore
/// at a time and keeps the status.
final class VersionHistoryModel {
    let target: VersionHistoryTarget
    private let workspace: LabWorkspaceCore
    private(set) var entries: [WorkspaceHistoryEntry] = []
    /// The body's text now, to compare versions with; nil until read.
    private(set) var currentText: String?
    private(set) var loaded = false
    private(set) var busy = false
    private(set) var status = "正在读取历史版本…"
    /// A refusal is shown as an error, other messages as information.
    private(set) var statusIsError = false
    var selectedID: String? { didSet { if selectedID != oldValue { loadSelectedPreview(); onChange?() } } }
    /// Each version's body with its formatting, as Rust projects it; read
    /// when the version is first selected. A failed read keeps the plain text.
    private(set) var previews: [String: NativeProjection] = [:]
    private var loadingPreviews: Set<String> = []
    var onChange: (() -> Void)?
    /// A restore succeeded; `live` when an open editor adopted it.
    var onRestored: ((Bool) -> Void)?

    init(workspace: LabWorkspaceCore, target: VersionHistoryTarget) {
        self.workspace = workspace
        self.target = target
    }

    var selected: WorkspaceHistoryEntry? { entries.first { $0.id == selectedID } }

    func showStatus(_ message: String, error: Bool = false) {
        status = message; statusIsError = error; onChange?()
    }

    private var defaultStatus: String {
        entries.isEmpty ? "还没有历史版本。编辑正文后，约每 15 分钟、关闭页面时和恢复之前会自动留存一个版本。"
            : "\(entries.count) 个版本，保留 30 天。选择一个版本查看内容和与当前正文的差异。"
    }

    /// Reads the versions, then the body's current text.
    func load(message: String? = nil) {
        guard !busy else { return }
        busy = true; onChange?()
        workspace.versionHistory(projectID: target.projectID, target: target) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let entries):
                self.entries = entries
                if self.selectedID.map({ id in !entries.contains { $0.id == id } }) ?? true { self.selectedID = entries.first?.id }
                self.workspace.agentReadProse(projectID: self.target.projectID, kind: self.target.kind, id: self.target.id) { [weak self] prose in
                    guard let self else { return }
                    self.busy = false
                    self.currentText = try? prose.get().text
                    self.loaded = true
                    self.showStatus(message ?? self.defaultStatus)
                }
            case .failure(let error):
                self.busy = false
                self.loaded = true
                self.showStatus(error.localizedDescription, error: true)
            }
        }
    }

    /// The selected version against the current text; nil until both are
    /// read. With its projection read, the version's text is the projection's,
    /// so the segments spell the formatted text exactly.
    func segments(of entry: WorkspaceHistoryEntry) -> [ProseDiff.Segment]? {
        currentText.map { ProseDiff.segments(current: $0, version: previews[entry.id]?.text ?? entry.text) }
    }

    /// The version's formatted body, once read.
    func preview(of entry: WorkspaceHistoryEntry) -> NativeProjection? { previews[entry.id] }

    private func loadSelectedPreview() {
        guard let id = selectedID, previews[id] == nil, loadingPreviews.insert(id).inserted else { return }
        workspace.versionPreview(projectID: target.projectID, target: target, snapshotID: id) { [weak self] result in
            guard let self else { return }
            self.loadingPreviews.remove(id)
            guard case .success(let projection) = result else { return }
            self.previews[id] = projection
            if self.selectedID == id { self.onChange?() }
        }
    }

    /// Restores one version, then reads the list again (the replaced state
    /// is now a version of its own).
    func restore(snapshotID: String, completion: ((Result<WorkspaceHistoryRestored, Error>) -> Void)? = nil) {
        guard !busy else { completion?(.failure(LabError.message("正在读取或恢复历史版本，请稍后重试。"))); return }
        busy = true; onChange?()
        workspace.restoreVersion(projectID: target.projectID, target: target, snapshotID: snapshotID) { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let reply):
                self.onRestored?(reply.handle != nil)
                self.load(message: "已恢复到所选版本。恢复前的正文已存为一个新版本，也可以在编辑器中撤销。")
            case .failure(let error):
                self.showStatus(error.localizedDescription, error: true)
            }
            completion?(result)
        }
    }
}
