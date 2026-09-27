import Foundation

/// One act on the 底部时间轴's 幕 rail: the chapter slots it spans in book
/// order. Its boundary sits before slot `start`; an act after every chapter
/// starts at the chapter count.
struct BottomTimelineAct: Equatable {
    let act: BookAct
    let start: Int
    /// Where the next act starts, or the chapter count.
    let end: Int
    var id: String { act.id }
}

/// Presentation state of one project's 底部时间轴 (bottom timeline dock). The
/// story graph's model supplies chapters, storyline lanes, story time, markers
/// and every tile drop; the outline model supplies act rows and every act
/// command. This model only derives the 幕 rail from both and turns a
/// boundary drop into one `workspaceMoveAct` command.
final class BottomTimelineModel {
    let projectID: String
    /// Chapters in storyline lanes along book order or story time, and drops.
    let graph: StoryGraphModel
    /// Act rows in reading order, and act commands.
    let outline: WorkspaceOutlineModel
    /// Acts in reading order over the chapter slots of 阅读顺序.
    private(set) var acts: [BottomTimelineAct] = []
    /// The chapter the active tab shows; its tile is highlighted.
    private(set) var currentChapterID: String?
    private(set) var status = "正在读取时间轴…"
    private var outlineLoaded = false
    var onChange: (() -> Void)?
    /// An act command of the dock changed act rows; other views follow.
    var onActs: (([WorkspaceOutlineEntry]) -> Void)?
    /// A book move of the dock returned the project's chapters in order.
    var onChapters: (([WorkspaceChapter]) -> Void)?
    /// A lane change of the dock returned the complete storyline library.
    var onStorylineLibrary: ((WorkspaceStorylineLibrary) -> Void)?
    /// A drop of the dock changed story time.
    var onTimeline: (() -> Void)?

    init(workspace: LabWorkspaceCore, projectID: String) {
        self.projectID = projectID
        graph = StoryGraphModel(workspace: workspace, projectID: projectID)
        outline = WorkspaceOutlineModel(workspace: workspace, projectID: projectID)
        graph.onChange = { [weak self] in self?.changed() }
        outline.onEntries = { [weak self] _ in self?.outlineLoaded = true }
        outline.onChange = { [weak self] in self?.changed() }
        graph.onChapters = { [weak self] chapters in
            guard let self else { return }
            // Acts are boundaries on the book axis: a moved chapter may now
            // fall in another act.
            self.outline.load()
            self.onChapters?(chapters)
        }
        graph.onStorylineLibrary = { [weak self] library in self?.onStorylineLibrary?(library) }
        graph.onTimeline = { [weak self] in self?.onTimeline?() }
    }

    var axis: StoryGraphModel.Axis {
        get { graph.axis }
        set {
            guard newValue != graph.axis else { return }
            graph.axis = newValue
            status = defaultStatus
            onChange?()
        }
    }
    var loaded: Bool { graph.loaded && outlineLoaded }
    var busy: Bool { graph.busy || outline.busy }
    /// Reads and commands sent to Rust, for acceptance.
    var requests: Int { graph.requests + outline.requests }
    var chapters: [WorkspaceChapter] { graph.chapters }

    private var defaultStatus: String {
        guard !graph.chapters.isEmpty else { return "还没有章节。新建章节后，它们会出现在时间轴上。" }
        switch graph.axis {
        case .book: return "阅读顺序：拖动章节调整顺序或故事线；拖动幕的分界移动幕，双击幕名重命名，右键查看更多操作。"
        case .narrative:
            return graph.unplacedChapters.isEmpty ? "故事时间：拖动章节调整它在故事中的时间。"
                : "故事时间：拖动章节调整它在故事中的时间；没有故事时间的章节在“未放置”中。"
        }
    }

    func show(_ message: String) { status = message; onChange?() }

    private func changed() {
        recompute()
        if loaded, status == "正在读取时间轴…" { status = defaultStatus }
        onChange?()
    }

    // MARK: Reading

    /// The first read of chapters, lanes, story time and acts.
    func load() {
        graph.load()
        outline.load()
    }

    /// Reads everything again without blocking drags, e.g. after chapters,
    /// acts, storylines or story time changed elsewhere.
    func refresh() {
        graph.refresh()
        if !outline.busy { outline.load() }
    }

    /// Acts changed elsewhere (the 整书大纲, a 全书长卷 separator's 幕颜色).
    func actsChanged() {
        if !outline.busy { outline.load() }
    }

    func setCurrentChapter(_ id: String?) {
        guard currentChapterID != id else { return }
        currentChapterID = id
        onChange?()
    }

    // MARK: Act rail

    /// Each act's first chapter slot. An act row's stored boundary places it
    /// before the first chapter at or after that book-axis coordinate, as
    /// Rust assigns membership; a head-anchored act (no boundary) starts at
    /// slot 0. Only when a chapter lacks its book order is the slot taken
    /// from the next chapter the outline lists after the act.
    private func recompute() {
        let chapters = graph.chapters
        let slots = Dictionary(chapters.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        let orders = chapters.compactMap(\.bookOrder)
        let ordered = orders.count == chapters.count
        let entries = outline.entries
        let layout = BookLayout(entries: entries, statuses: nil)
        var starts: [(act: BookAct, start: Int)] = []
        for (position, entry) in entries.enumerated() where entry.kind == "act" {
            guard starts.count < layout.acts.count else { break }
            let start: Int
            if ordered {
                start = entry.startOrder.map { boundary in orders.firstIndex { $0 >= boundary } ?? chapters.count } ?? 0
            } else {
                start = entries[(position + 1)...].lazy.compactMap { $0.kind == "chapter" ? slots[$0.id] : nil }.first ?? chapters.count
            }
            starts.append((layout.acts[starts.count], max(start, starts.last?.start ?? 0)))
        }
        acts = starts.enumerated().map { index, entry in
            BottomTimelineAct(act: entry.act, start: entry.start,
                              end: index + 1 < starts.count ? starts[index + 1].start : chapters.count)
        }
    }

    func act(id: String) -> BottomTimelineAct? { acts.first { $0.id == id } }

    /// The slots an act's boundary may move to: strictly after the previous
    /// act's start and before the next act's, so act order never changes.
    /// Nil when it cannot move at all.
    func boundaryRange(actID: String) -> ClosedRange<Int>? {
        guard let index = acts.firstIndex(where: { $0.id == actID }), !graph.chapters.isEmpty else { return nil }
        let lower = index == 0 ? 0 : acts[index - 1].start + 1
        let upper = index + 1 < acts.count ? acts[index + 1].start - 1 : graph.chapters.count
        return lower <= upper ? lower...upper : nil
    }

    /// Where a boundary drag may show its divider: the allowed slots and the
    /// act's own start, where a drop writes nothing.
    func dragRange(actID: String) -> ClosedRange<Int>? {
        guard let act = act(id: actID) else { return nil }
        guard let range = boundaryRange(actID: actID) else { return act.start...act.start }
        return min(range.lowerBound, act.start)...max(range.upperBound, act.start)
    }

    /// The book-axis coordinate of a boundary before slot `gap`: that
    /// chapter's own coordinate, as 在此开始一幕 uses; after the last chapter,
    /// one step beyond it.
    func startOrder(gap: Int) -> Double? {
        let chapters = graph.chapters
        guard gap >= 0 else { return nil }
        if gap < chapters.count { return chapters[gap].bookOrder }
        return chapters.last?.bookOrder.map { $0 + 1 }
    }

    /// Moves an act's boundary before slot `gap`. A drop at its own start
    /// writes nothing; Rust refuses a start at or beyond a neighbouring
    /// boundary (e.g. one created elsewhere), and the rail reads acts again.
    func moveAct(id: String, toGap gap: Int, completion: ((Bool) -> Void)? = nil) {
        guard let act = act(id: id) else { completion?(false); return }
        guard gap != act.start else { completion?(false); return }
        guard !busy else { show("正在保存时间轴，请稍后再拖动。"); completion?(false); return }
        guard let order = startOrder(gap: gap), order.isFinite else {
            show("这个位置无法保存，请刷新时间轴后重试。"); completion?(false); return
        }
        let place = gap < graph.chapters.count ? "从“\(graph.chapters[gap].title)”开始" : "移到全书末尾"
        outline.moveAct(id: id, startOrder: order) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.show("“\(act.act.title)”现在\(place)。章节和正文保持不变。")
                self.onActs?(self.outline.entries)
                completion?(true)
            case .failure(let error):
                self.show(error.localizedDescription)
                // Acts may have changed elsewhere; read them again.
                self.refresh()
                completion?(false)
            }
        }
    }

    /// 在此处开始新幕: a boundary before the chapter in slot `gap`.
    func createAct(atGap gap: Int, completion: ((Bool) -> Void)? = nil) {
        guard graph.chapters.indices.contains(gap) else {
            show("需要在一个章节前开始新幕。"); completion?(false); return
        }
        let chapter = graph.chapters[gap]
        actCommand(success: "已在“\(chapter.title)”前开始新的一幕。", completion: completion) {
            self.outline.createAct(beforeChapterID: chapter.id, completion: $0)
        }
    }

    func renameAct(id: String, name: String, completion: ((Bool) -> Void)? = nil) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { show("幕名称不能为空，请重新输入。"); completion?(false); return }
        guard trimmed != act(id: id)?.act.title else { completion?(false); return }
        actCommand(success: "幕名称已保存。", completion: completion) { self.outline.renameAct(id: id, name: trimmed, completion: $0) }
    }

    /// Removes only the boundary: its chapters join the previous act.
    func removeAct(id: String, completion: ((Bool) -> Void)? = nil) {
        let name = act(id: id)?.act.title ?? "这一幕"
        actCommand(success: "“\(name)”的分界已删除，章节和正文保持不变。", completion: completion) {
            self.outline.removeAct(id: id, completion: $0)
        }
    }

    /// 幕颜色: a stored colour, or nil for 恢复默认; the current colour writes nothing.
    func setActColor(id: String, color: String?, completion: ((Bool) -> Void)? = nil) {
        guard act(id: id)?.act.color?.lowercased() != color?.lowercased() else { completion?(false); return }
        actCommand(success: color == nil ? "已恢复这一幕的默认颜色。" : "幕颜色已保存。", completion: completion) {
            self.outline.setActColor(id: id, color: color, completion: $0)
        }
    }

    private func actCommand(success: String, completion: ((Bool) -> Void)?,
                            operation: (@escaping (Result<WorkspaceAct, Error>) -> Void) -> Void) {
        guard !busy else { show("正在保存时间轴，请稍后重试。"); completion?(false); return }
        operation { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.show(success)
                self.onActs?(self.outline.entries)
                completion?(true)
            case .failure(let error):
                self.show(error.localizedDescription)
                completion?(false)
            }
        }
    }

    // MARK: Tiles

    /// One tile drop through the story graph's rules and commands; the
    /// graph's message is shown when it wrote or refused something.
    func drop(chapterID: String, lane: String??, placement: StoryGraphModel.Placement?, completion: ((Bool) -> Void)? = nil) {
        let before = graph.status
        graph.drop(chapterID: chapterID, lane: lane, placement: placement) { [weak self] ok in
            guard let self else { return }
            if self.graph.status != before { self.show(self.graph.status) }
            completion?(ok)
        }
    }

    /// 放到故事时间末尾.
    func placeAtEnd(chapterID: String, completion: ((Bool) -> Void)? = nil) {
        let last = graph.placedChapters.last(where: { $0.id != chapterID }).flatMap { graph.narrativeOrder(of: $0.id) }
        drop(chapterID: chapterID, lane: nil, placement: .narrative(StoryGraphModel.order(between: last, and: nil)), completion: completion)
    }

    /// 移出故事时间: back to 未放置.
    func unplace(chapterID: String, completion: ((Bool) -> Void)? = nil) {
        drop(chapterID: chapterID, lane: nil, placement: .narrative(nil), completion: completion)
    }

    /// 移到轨道: the lane-change rule of the story graph.
    func setLane(chapterID: String, storylineID: String?, completion: ((Bool) -> Void)? = nil) {
        drop(chapterID: chapterID, lane: .some(storylineID), placement: nil, completion: completion)
    }
}
