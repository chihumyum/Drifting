import Foundation

/// A project's 写作计划: the book's word target and a daily goal. The lab
/// stores it per project in its own `settings.json`, never in user
/// defaults. Zero turns a goal off, as in the renderer.
struct WritingPlan: Codable, Equatable {
    static let defaultTarget = 120_000
    static let defaultDailyGoal = 1_500
    static let maximum = 99_999_999

    var projectWordTarget: Int
    var dailyWordGoal: Int

    init(projectWordTarget: Int = WritingPlan.defaultTarget, dailyWordGoal: Int = WritingPlan.defaultDailyGoal) {
        self.projectWordTarget = Self.clamped(projectWordTarget)
        self.dailyWordGoal = Self.clamped(dailyWordGoal)
    }

    static func clamped(_ value: Int) -> Int { min(max(0, value), maximum) }

    private enum CodingKeys: String, CodingKey { case projectWordTarget, dailyWordGoal }

    /// A damaged value falls back to its default on its own.
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(projectWordTarget: (try? values.decodeIfPresent(Int.self, forKey: .projectWordTarget)).flatMap { $0 } ?? Self.defaultTarget,
                  dailyWordGoal: (try? values.decodeIfPresent(Int.self, forKey: .dailyWordGoal)).flatMap { $0 } ?? Self.defaultDailyGoal)
    }

    /// What the author typed: digits with optional grouping commas or spaces,
    /// full-width digits, a trailing 字, or a number of 万 (“12 万” is
    /// 120,000). Nil for anything else or beyond `maximum`.
    static func parse(_ text: String) -> Int? {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasSuffix("字") { value.removeLast() }
        value = String(value.unicodeScalars.compactMap { scalar -> Character? in
            // Full-width digits and the decimal point read as ASCII.
            if (0xFF10...0xFF19).contains(scalar.value) { return Character(UnicodeScalar(scalar.value - 0xFF10 + 0x30)!) }
            if scalar.value == 0xFF0E { return "." }
            if [",", "，", " ", "\u{3000}", "_"].contains(Character(scalar)) { return nil }
            return Character(scalar)
        })
        var multiplier = 1.0
        if value.hasSuffix("万") { value.removeLast(); multiplier = 10_000 }
        guard !value.isEmpty, value.allSatisfy({ $0.isASCII && ($0.isNumber || $0 == ".") }),
              value.filter({ $0 == "." }).count <= (multiplier > 1 ? 1 : 0), let number = Double(value) else { return nil }
        let result = (number * multiplier).rounded()
        guard result >= 0, result <= Double(maximum) else { return nil }
        return Int(result)
    }
}

/// One live chapter in reading order.
struct BookChapter: Equatable {
    let id: String
    let title: String
    /// `draft`, `finished` or `discarded`; nil until the chapter list was read.
    var writingStatus: String?
    /// The act the chapter falls in; nil before the first act boundary.
    let actID: String?
    /// Its 1-based position among chapters.
    let number: Int
}

/// One act separator in reading order, with its chapters.
struct BookAct: Equatable {
    let id: String
    let title: String
    /// Its position among acts; without a stored colour the act colour
    /// cycles by it.
    let index: Int
    let chapterIDs: [String]
    /// The stored `#rrggbb` colour chosen in 幕颜色; nil follows the cycle.
    var color: String? = nil

    /// The colour the act is drawn in: the stored one, else its hue by position.
    var hex: String { color ?? BookPalette.act(index) }
}

/// The book as the 全书长卷 shows it: Rust's outline rows in one reading
/// order (act separators, empty acts included, and chapters), each chapter
/// with its writing status from the chapter list. Drifts are not on the axis.
struct BookLayout: Equatable {
    enum Item: Equatable {
        case act(BookAct)
        case chapter(BookChapter)

        /// A stable key for rows, anchors and the jump menu.
        var key: String {
            switch self {
            case .act(let act): return "act:\(act.id)"
            case .chapter(let chapter): return "chapter:\(chapter.id)"
            }
        }
    }

    let items: [Item]
    let chapters: [BookChapter]
    let acts: [BookAct]
    private let chapterIndex: [String: Int]

    static let empty = BookLayout(entries: [], statuses: nil)

    init(entries: [WorkspaceOutlineEntry], statuses: [String: String]?) {
        var chapterIDsByAct: [String: [String]] = [:]
        for entry in entries where entry.kind == "chapter" {
            if let act = entry.actId { chapterIDsByAct[act, default: []].append(entry.id) }
        }
        var items: [Item] = [], chapters: [BookChapter] = [], acts: [BookAct] = []
        for entry in entries {
            switch entry.kind {
            case "act":
                let act = BookAct(id: entry.id, title: entry.title, index: acts.count, chapterIDs: chapterIDsByAct[entry.id] ?? [],
                                  color: entry.color)
                acts.append(act); items.append(.act(act))
            case "chapter":
                let chapter = BookChapter(id: entry.id, title: entry.title, writingStatus: statuses?[entry.id],
                                          actID: entry.actId, number: chapters.count + 1)
                chapters.append(chapter); items.append(.chapter(chapter))
            default: continue
            }
        }
        self.items = items; self.chapters = chapters; self.acts = acts
        chapterIndex = Dictionary(chapters.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    private init(items: [Item], chapters: [BookChapter], acts: [BookAct]) {
        self.items = items; self.chapters = chapters; self.acts = acts
        chapterIndex = Dictionary(chapters.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    static func == (lhs: BookLayout, rhs: BookLayout) -> Bool { lhs.items == rhs.items }

    func chapter(id: String) -> BookChapter? { chapterIndex[id].map { chapters[$0] } }
    func act(id: String) -> BookAct? { acts.first { $0.id == id } }
    /// The palette position of the chapter's act; nil before the first act.
    func actIndex(chapterID: String) -> Int? { chapter(id: chapterID)?.actID.flatMap { act(id: $0)?.index } }
    /// The colour of the chapter's act (stored or by position); nil before the first act.
    func actHex(chapterID: String) -> String? { chapter(id: chapterID)?.actID.flatMap { act(id: $0)?.hex } }

    /// The same book with one chapter's stored status.
    func updating(status: String, chapterID: String) -> BookLayout {
        guard let index = chapterIndex[chapterID], chapters[index].writingStatus != status else { return self }
        var chapters = self.chapters
        chapters[index].writingStatus = status
        let items = self.items.map { item -> Item in
            if case .chapter(let chapter) = item, chapter.id == chapterID { return .chapter(chapters[index]) }
            return item
        }
        return BookLayout(items: items, chapters: chapters, acts: acts)
    }
}

/// Act colours, cycled by reading position as the renderer does when an act
/// has no stored colour: its `--story-1…6` hues. 幕颜色 offers them by name
/// with a few more; Rust validates the stored `#rrggbb` value.
enum BookPalette {
    static let acts = ["#9D8BE4", "#6CACE5", "#72C096", "#EFCC61", "#C694DB", "#67BEC1"]
    static func act(_ index: Int) -> String { acts[((index % acts.count) + acts.count) % acts.count] }
    static let choices: [(name: String, hex: String)] = [
        ("紫", "#9D8BE4"), ("蓝", "#6CACE5"), ("绿", "#72C096"), ("黄", "#EFCC61"),
        ("丁香", "#C694DB"), ("青", "#67BEC1"), ("红", "#E5484D"), ("灰", "#8D8D8D"),
    ]
}

/// 统计 of the book on the reading axis: the overview, the writing plan's
/// progress, act rhythm and chapter-length rhythm. Chapters only; drifts are
/// not counted, as in `sumCanonicalChapterWordCounts`.
struct BookStats: Equatable {
    struct Bar: Equatable {
        let chapter: BookChapter
        let words: Int
        /// Palette position of the chapter's act; nil before the first act.
        let actIndex: Int?
        /// The act's colour, stored or by position; nil before the first act.
        var actHex: String? = nil
    }
    struct ActRow: Equatable {
        let act: BookAct
        let chapters: Int
        let words: Int
        /// Share of the book total, 0…1.
        let share: Double
    }

    let chapterCount: Int
    /// Every chapter has a canonical count, so the values below are exact.
    let ready: Bool
    let totalWords: Int
    let averageWords: Int
    let finished: Int
    let drafts: Int
    let discarded: Int
    /// Chapters 已完成 as a rounded percentage of all chapters.
    let completion: Int
    /// The plan's word target; 0 when none is set.
    let target: Int
    /// Written over target, capped at 1; nil without a target.
    let targetFraction: Double?
    let bars: [Bar]
    let longestWords: Int
    let acts: [ActRow]

    init(layout: BookLayout, counts: WordCountLibrary?, plan: WritingPlan) {
        let chapters = layout.chapters
        chapterCount = chapters.count
        ready = counts.map { library in chapters.allSatisfy { library.count(nodeID: $0.id) != nil } } ?? false
        let words = Dictionary(chapters.map { ($0.id, counts?.count(nodeID: $0.id) ?? 0) }, uniquingKeysWith: { first, _ in first })
        totalWords = chapters.reduce(0) { $0 + (words[$1.id] ?? 0) }
        averageWords = chapters.isEmpty ? 0 : Int((Double(totalWords) / Double(chapters.count)).rounded())
        finished = chapters.filter { $0.writingStatus == WritingStatus.finished.rawValue }.count
        discarded = chapters.filter { $0.writingStatus == WritingStatus.discarded.rawValue }.count
        drafts = chapters.filter { $0.writingStatus == WritingStatus.draft.rawValue }.count
        completion = chapters.isEmpty ? 0 : Int((Double(finished) / Double(chapters.count) * 100).rounded())
        target = plan.projectWordTarget
        targetFraction = target > 0 ? min(1, Double(totalWords) / Double(target)) : nil
        bars = chapters.map { Bar(chapter: $0, words: words[$0.id] ?? 0, actIndex: layout.actIndex(chapterID: $0.id),
                                  actHex: layout.actHex(chapterID: $0.id)) }
        longestWords = bars.map(\.words).max() ?? 0
        let total = totalWords
        acts = layout.acts.map { act in
            let sum = act.chapterIDs.reduce(0) { $0 + (words[$1] ?? 0) }
            return ActRow(act: act, chapters: act.chapterIDs.count, words: sum, share: total > 0 ? Double(sum) / Double(total) : 0)
        }
    }

    // MARK: Text

    var totalText: String { ready ? WordCountText.full(totalWords) : WordCountText.counting }
    var chaptersText: String { "\(chapterCount) 章" }
    var averageText: String { ready ? WordCountText.full(averageWords) : WordCountText.counting }
    var completionText: String { "\(completion)%" }
    /// “已完成 4 / 12 章”.
    var completionDetail: String { "已完成 \(finished) / \(chapterCount) 章" }
    /// “草稿 3 · 已完成 4 · 已弃用 1”; statuses without chapters are left out.
    var statusText: String {
        let parts = [(WritingStatus.draft, drafts), (.finished, finished), (.discarded, discarded)]
            .filter { $0.1 > 0 }.map { "\($0.0.label) \($0.1)" }
        return parts.isEmpty ? "—" : parts.joined(separator: " · ")
    }
    /// “12,345 / 120,000 字 · 10%”, rounded down so an unfinished book never
    /// reads 100%; 未设目标 without a target.
    var targetText: String {
        guard let targetFraction else { return "未设目标" }
        guard ready else { return WordCountText.counting }
        return "\(WordCountText.grouped(totalWords)) / \(WordCountText.full(target)) · \(Int((targetFraction * 100).rounded(.down)))%"
    }
    /// “3 章 · 4,200 字 · 35%”.
    static func actText(_ row: ActRow) -> String {
        "\(row.chapters) 章 · \(WordCountText.full(row.words)) · \(Int((row.share * 100).rounded()))%"
    }
    /// “《雨夜》1,234 字”.
    static func barText(_ bar: Bar) -> String { "《\(bar.chapter.title)》\(WordCountText.full(bar.words))" }
    /// The longest and shortest chapters, for the rhythm caption.
    var extremes: (longest: Bar, shortest: Bar)? {
        guard let longest = bars.max(by: { $0.words < $1.words }), let shortest = bars.min(by: { $0.words < $1.words }) else { return nil }
        return (longest, shortest)
    }
}

/// One project's book in reading order for the 全书长卷 and 统计: Rust's
/// outline rows with each chapter's status from the chapter list. Reads
/// only; a change during a read is read again afterwards.
final class WholeBookModel {
    let projectID: String
    private let workspace: LabWorkspaceCore
    private(set) var layout = BookLayout.empty
    private(set) var loaded = false
    private(set) var loading = false
    private(set) var status = "正在读取全书…"
    private var reread = false
    private var observers: [(owner: () -> AnyObject?, block: () -> Void)] = []

    init(workspace: LabWorkspaceCore, projectID: String) {
        self.workspace = workspace
        self.projectID = projectID
    }

    /// Calls `block` after every change while `owner` lives.
    func observe(_ owner: AnyObject, _ block: @escaping () -> Void) {
        observers.append(({ [weak owner] in owner }, block))
    }

    private func changed() {
        observers.removeAll { $0.owner() == nil }
        for observer in observers { observer.block() }
    }

    /// Reads the outline, then the chapter list for statuses.
    func load() {
        guard !loading else { reread = true; return }
        loading = true
        workspace.outline(projectID: projectID) { [weak self] outline in
            guard let self else { return }
            self.workspace.chapters(projectID: self.projectID) { [weak self] chapters in
                guard let self else { return }
                self.loading = false
                switch (outline, chapters) {
                case (.success(let entries), .success(let chapters)):
                    let statuses = Dictionary(chapters.compactMap { chapter in chapter.writingStatus.map { (chapter.id, $0) } },
                                              uniquingKeysWith: { first, _ in first })
                    self.layout = BookLayout(entries: entries, statuses: statuses)
                    self.loaded = true
                    self.status = self.layout.chapters.isEmpty ? "还没有章节。新建章节后，全书会显示在这里。" : ""
                case (.failure(let error), _), (_, .failure(let error)):
                    self.status = error.localizedDescription
                }
                self.changed()
                if self.reread { self.reread = false; self.load() }
            }
        }
    }

    /// A chapter's stored status after a page, a menu or the outline wrote it.
    func applyNodeMetadata(_ metadata: WorkspaceNodeMetadata) {
        guard metadata.kind == "chapter" else { return }
        let next = layout.updating(status: metadata.writingStatus, chapterID: metadata.id)
        guard next.chapters != layout.chapters else { return }
        layout = next
        changed()
    }

    func showStatus(_ message: String) { status = message; changed() }

    /// 幕颜色: a stored `#rrggbb` colour, or nil for the default hue. Rust
    /// writes nothing for an unchanged colour; the book is read again after.
    func setActColor(actID: String, color: String?, completion: ((Result<WorkspaceAct, Error>) -> Void)? = nil) {
        let title = layout.act(id: actID)?.title ?? "这一幕"
        workspace.setActColor(projectID: projectID, actID: actID, color: color) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success: self.status = color == nil ? "“\(title)”已恢复默认颜色。" : "“\(title)”的颜色已保存。"; self.load()
            case .failure(let error): self.showStatus(error.localizedDescription)
            }
            completion?(result)
        }
    }
}
