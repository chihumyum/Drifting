import Foundation

/// A live chapter's or drift's place on the story graph: its narrative order
/// (chapters only; nil while it is not placed in story time) and a drift
/// card's position in the free area.
struct WorkspaceTimelineNode: Decodable, Equatable {
    let id: String
    /// `chapter` or `drift`.
    let kind: String
    let narrativeOrder: Double?
    let positionX: Double
    let positionY: Double

    /// New nodes sit at the origin; a card placed by the author never does
    /// (the graph keeps dropped cards inside its margin).
    var hasPosition: Bool { positionX != 0 || positionY != 0 }
}

/// A pin on the narrative axis, optionally bound to a live drift, which
/// captions a label-less marker.
struct WorkspaceTimelineMarker: Decodable, Equatable {
    let id: String
    let narrativeOrder: Double
    let label: String
    let driftNodeId: String?
    let createdAt: String
    let updatedAt: String
}

struct WorkspaceTimeline: Decodable, Equatable {
    var nodes: [WorkspaceTimelineNode]
    /// In narrative order.
    var markers: [WorkspaceTimelineMarker]

    static let empty = WorkspaceTimeline(nodes: [], markers: [])

    func node(id: String) -> WorkspaceTimelineNode? { nodes.first { $0.id == id } }
    func marker(id: String) -> WorkspaceTimelineMarker? { markers.first { $0.id == id } }
}

/// Every timeline command returns its own result (nil for the read and a
/// deletion) and the complete timeline after it.
struct WorkspaceTimelineReply<Value: Decodable>: Decodable {
    let result: Value?
    let timeline: WorkspaceTimeline
}

/// Present fields are written; an explicit nil inside `driftID` unbinds the
/// drift. Unchanged fields write nothing.
struct TimelineMarkerChanges: Equatable {
    var narrativeOrder: Double?
    var label: String?
    var driftID: String??

    var fields: [String: Any] {
        var fields: [String: Any] = [:]
        if let narrativeOrder { fields["narrativeOrder"] = narrativeOrder }
        if let label { fields["label"] = label }
        if let driftID { fields["driftId"] = driftID.map { $0 as Any } ?? NSNull() }
        return fields
    }
}

/// The renderer's order-to-time conversion: once two markers carry numeric
/// labels (“1938 春” reads 1938), story time is interpolated linearly between
/// the two numeric markers furthest apart in order, and extrapolated outside.
struct TimelineConversion: Equatable {
    let a: (order: Double, time: Double)
    let b: (order: Double, time: Double)

    static func == (lhs: TimelineConversion, rhs: TimelineConversion) -> Bool {
        lhs.a == rhs.a && lhs.b == rhs.b
    }

    /// The first signed decimal in a label, ASCII digits only as in the renderer.
    static func numeric(_ label: String) -> Double? {
        guard let range = label.range(of: "-?[0-9]+(\\.[0-9]+)?", options: .regularExpression),
              let value = Double(label[range]), value.isFinite else { return nil }
        return value
    }

    init?(markers: [WorkspaceTimelineMarker]) {
        let numeric = markers.compactMap { marker -> (order: Double, time: Double)? in
            guard marker.narrativeOrder.isFinite, let time = Self.numeric(marker.label) else { return nil }
            return (marker.narrativeOrder, time)
        }.sorted { $0.order < $1.order }
        guard numeric.count >= 2, let first = numeric.first, let last = numeric.last, first.order != last.order else { return nil }
        a = first; b = last
    }

    func time(order: Double) -> Double? {
        guard order.isFinite else { return nil }
        let value = a.time + (order - a.order) * ((b.time - a.time) / (b.order - a.order))
        return value.isFinite ? value : nil
    }

    func order(time: Double) -> Double? {
        guard time.isFinite, a.time != b.time else { return nil }
        let value = a.order + (time - a.time) * ((b.order - a.order) / (b.time - a.time))
        return value.isFinite ? value : nil
    }

    /// “1938” or “1938.5”: at most one decimal, as a time reads.
    static func text(_ time: Double) -> String {
        let rounded = (time * 10).rounded() / 10
        return rounded == rounded.rounded() ? String(Int(rounded)) : String(format: "%.1f", rounded)
    }
}

/// Presentation state of one project's 故事图谱: chapters in storyline lanes
/// along the book or the narrative axis, timeline markers and drift cards.
/// Rust owns every order, membership, marker and position; this model reads
/// them, lays out lanes and turns a drop into one command at a time.
final class StoryGraphModel {
    enum Axis: String { case book, narrative }

    /// One lane: a live storyline in authored order, or the synthetic lane of
    /// chapters without a primary (未归属; 本书 while there are no storylines).
    struct Lane: Equatable {
        let storylineID: String?
        let name: String
        let color: String?
        /// In the axis order.
        let chapterIDs: [String]
        var identifier: String { storylineID ?? "unaffiliated" }
    }

    let projectID: String
    private let workspace: LabWorkspaceCore
    /// Live chapters in book order, with their writing status.
    private(set) var chapters: [WorkspaceChapter] = []
    private(set) var storylines = WorkspaceStorylineLibrary.empty
    private(set) var drifts = WorkspaceDriftLibrary.empty
    private(set) var timeline = WorkspaceTimeline.empty
    /// Supplied by the window; nil until counts are read.
    private(set) var wordCounts: WordCountLibrary?
    private(set) var loaded = false
    private(set) var busy = false
    private(set) var status = "正在读取故事图谱…"
    /// Reads and commands sent to Rust, for acceptance: a drag sends none
    /// until its drop.
    private(set) var requests = 0
    private var refreshQueued = false
    private var refreshing = false
    /// Commands sent so far; a read that saw fewer is stale.
    private var commands = 0
    var axis: Axis = .book {
        didSet { if axis != oldValue { status = defaultStatus; onChange?() } }
    }
    var onChange: (() -> Void)?
    /// A book-order move returned the project's chapters in their new order.
    var onChapters: (([WorkspaceChapter]) -> Void)?
    /// A lane change returned the project's complete storyline library.
    var onStorylineLibrary: ((WorkspaceStorylineLibrary) -> Void)?

    init(workspace: LabWorkspaceCore, projectID: String) {
        self.workspace = workspace
        self.projectID = projectID
    }

    func showStatus(_ message: String) { status = message; onChange?() }

    private var defaultStatus: String {
        guard !chapters.isEmpty else { return "还没有章节。新建章节后，它们会出现在故事线轨道上。" }
        switch axis {
        case .book: return "按成书顺序排列。左右拖动章节调整顺序，上下拖到另一条轨道改变主线；右键查看更多操作。"
        case .narrative:
            return unplacedChapters.isEmpty
                ? "按故事时间排列。拖动章节调整它在故事中的时间；在标记行右键或点“添加标记…”新建时间标记。"
                : "按故事时间排列。把“未放置”中的章节拖到轨道上，即可放进故事时间。"
        }
    }

    // MARK: Reading

    private typealias Snapshot = (chapters: [WorkspaceChapter], storylines: WorkspaceStorylineLibrary,
                                  drifts: WorkspaceDriftLibrary, timeline: WorkspaceTimeline)

    /// Reads chapters, storylines, drifts and the timeline, in queue order.
    private func read(_ completion: @escaping (Result<Snapshot, Error>) -> Void) {
        requests += 4
        workspace.chapters(projectID: projectID) { [weak self] chapters in
            guard let self else { return }
            self.workspace.storylineLibrary(projectID: self.projectID) { [weak self] storylines in
                guard let self else { return }
                self.workspace.driftLibrary(projectID: self.projectID) { [weak self] drifts in
                    guard let self else { return }
                    self.workspace.timeline(projectID: self.projectID) { timeline in
                        completion(Result { (try chapters.get(), try storylines.get(), try drifts.get(), try timeline.get()) })
                    }
                }
            }
        }
    }

    private func adopt(_ snapshot: Snapshot) {
        chapters = snapshot.chapters
        storylines = snapshot.storylines
        drifts = snapshot.drifts
        timeline = snapshot.timeline
    }

    /// The first read; drags wait for it.
    func load() {
        guard !loaded else { refresh(); return }
        guard !busy else { return }
        busy = true; onChange?()
        read { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let snapshot):
                self.adopt(snapshot)
                self.loaded = true
                self.showStatus(self.defaultStatus)
            case .failure(let error): self.showStatus(error.localizedDescription)
            }
            self.runQueuedRefresh()
        }
    }

    /// Reads everything again without blocking drags, e.g. when the panel
    /// becomes key after edits elsewhere. A command sent meanwhile makes the
    /// read stale: it is dropped and read again after the command.
    func refresh() {
        guard loaded else { load(); return }
        guard !busy, !refreshing else { refreshQueued = true; return }
        refreshing = true
        let generation = commands
        read { [weak self] result in
            guard let self else { return }
            self.refreshing = false
            if generation != self.commands {
                self.refreshQueued = true
            } else if case .success(let snapshot) = result {
                self.adopt(snapshot)
                self.onChange?()
            }
            self.runQueuedRefresh()
        }
    }

    private func runQueuedRefresh() {
        guard refreshQueued, !busy, !refreshing else { return }
        refreshQueued = false
        refresh()
    }

    /// Every command marks reads started before it as stale.
    private func beginCommand() { commands += 1; requests += 1 }

    /// Adopt values written elsewhere. Unknown chapters wait for a refresh.
    func applyNodeMetadata(_ metadata: WorkspaceNodeMetadata) {
        guard metadata.kind == "chapter", let index = chapters.firstIndex(where: { $0.id == metadata.id }),
              chapters[index].writingStatus != metadata.writingStatus else { return }
        chapters[index].writingStatus = metadata.writingStatus
        onChange?()
    }

    func applyWordCounts(_ library: WordCountLibrary) {
        guard wordCounts != library else { return }
        wordCounts = library
        onChange?()
    }

    func applyStorylines(_ library: WorkspaceStorylineLibrary) {
        guard storylines != library else { return }
        storylines = library
        onChange?()
    }

    /// A drift change elsewhere may also have unbound markers (trash), so
    /// the timeline is read again.
    func applyDrifts(_ library: WorkspaceDriftLibrary) {
        guard drifts != library else { return }
        drifts = library
        onChange?()
        guard !busy else { refreshQueued = true; return }
        let generation = commands
        requests += 1
        workspace.timeline(projectID: projectID) { [weak self] result in
            guard let self, generation == self.commands, case .success(let timeline) = result, self.timeline != timeline else { return }
            self.timeline = timeline
            self.onChange?()
        }
    }

    // MARK: Layout

    func chapter(id: String) -> WorkspaceChapter? { chapters.first { $0.id == id } }
    func bookIndex(of chapterID: String) -> Int? { chapters.firstIndex { $0.id == chapterID } }
    func narrativeOrder(of chapterID: String) -> Double? { timeline.node(id: chapterID)?.narrativeOrder }
    /// The chapter's live primary storyline, or nil for 未归属.
    func primary(of chapterID: String) -> String? { storylines.primary(chapterID: chapterID)?.id }
    func wordCount(of nodeID: String) -> Int? { wordCounts?.count(nodeID: nodeID) }

    /// Chapters placed in story time, by narrative order, ties by book order.
    var placedChapters: [WorkspaceChapter] {
        let orders = Dictionary(timeline.nodes.compactMap { node in node.narrativeOrder.map { (node.id, $0) } },
                                uniquingKeysWith: { first, _ in first })
        return chapters.enumerated().compactMap { index, chapter in orders[chapter.id].map { (index, chapter, $0) } }
            .sorted { $0.2 != $1.2 ? $0.2 < $1.2 : $0.0 < $1.0 }
            .map(\.1)
    }

    /// Chapters not yet placed in story time, in book order (the 未放置 tray).
    var unplacedChapters: [WorkspaceChapter] { chapters.filter { narrativeOrder(of: $0.id) == nil } }

    /// The chapters shown along the current axis, in its order.
    var axisChapters: [WorkspaceChapter] { axis == .book ? chapters : placedChapters }

    /// Storyline lanes in authored order, then 未归属 (本书 without storylines).
    var lanes: [Lane] {
        let ordered = axisChapters
        var byLane: [String: [String]] = [:]
        var unaffiliated: [String] = []
        for chapter in ordered {
            if let primary = primary(of: chapter.id) { byLane[primary, default: []].append(chapter.id) }
            else { unaffiliated.append(chapter.id) }
        }
        var lanes = storylines.storylines.map {
            Lane(storylineID: $0.id, name: $0.name, color: $0.color, chapterIDs: byLane[$0.id] ?? [])
        }
        lanes.append(Lane(storylineID: nil, name: storylines.storylines.isEmpty ? "本书" : "未归属", color: nil,
                          chapterIDs: unaffiliated))
        return lanes
    }

    /// Live drifts in library order with their graph position, if placed.
    var driftCards: [(drift: WorkspaceDrift, position: (x: Double, y: Double)?)] {
        drifts.drifts.map { drift in
            let node = timeline.node(id: drift.id)
            return (drift, node.flatMap { $0.hasPosition ? ($0.positionX, $0.positionY) : nil })
        }
    }

    var markers: [WorkspaceTimelineMarker] { timeline.markers }
    var conversion: TimelineConversion? { TimelineConversion(markers: timeline.markers) }

    /// A marker's caption: its label, else its bound drift's title.
    func caption(of marker: WorkspaceTimelineMarker) -> String {
        if !marker.label.isEmpty { return marker.label }
        if let id = marker.driftNodeId, let drift = drifts.drift(id: id) { return drift.title }
        return "标记"
    }

    // MARK: Ordering rules

    /// A narrative order between two neighbours: their midpoint, one step
    /// beyond a single neighbour, or 1 on an empty axis.
    static func order(between previous: Double?, and next: Double?) -> Double {
        switch (previous, next) {
        case (let previous?, let next?): return previous + (next - previous) / 2
        case (let previous?, nil): return previous + 1
        case (nil, let next?): return next - 1
        case (nil, nil): return 1
        }
    }

    /// The narrative order of a chapter dropped at `index` among the other
    /// placed chapters, or nil when it would keep its place.
    func narrativeOrder(moving id: String, toIndex index: Int) -> Double?? {
        let placed = placedChapters
        let others = placed.filter { $0.id != id }
        guard (0...others.count).contains(index) else { return nil }
        if let current = placed.firstIndex(where: { $0.id == id }), current == index { return nil }
        let previous = index > 0 ? narrativeOrder(of: others[index - 1].id) : nil
        let next = index < others.count ? narrativeOrder(of: others[index].id) : nil
        return .some(Self.order(between: previous, and: next))
    }

    /// The chapter to move before when a chapter is dropped at book position
    /// `index` among the others (nil: last), or nil when it keeps its place.
    func bookDestination(moving id: String, toIndex index: Int) -> String?? {
        guard let current = bookIndex(of: id) else { return nil }
        let others = chapters.filter { $0.id != id }
        guard (0...others.count).contains(index), index != current else { return nil }
        return .some(index < others.count ? others[index].id : nil)
    }

    /// The renderer's lane-change rule: the target storyline becomes primary,
    /// the previous primary's membership is dropped and other memberships
    /// stay; 未归属 clears every membership. Nil when nothing would change.
    static func laneMembership(current: WorkspaceChapterStorylines?, target: String?) -> (ids: [String], primary: String?)? {
        let ids = current?.storylineIds ?? []
        let primary = current?.primary
        guard primary != target else { return nil }
        guard let target else { return ids.isEmpty ? nil : ([], nil) }
        var next = ids.filter { $0 != primary }
        if !next.contains(target) { next.append(target) }
        return (next, target)
    }

    // MARK: Commands

    /// Where a dragged chapter card was dropped.
    enum Placement: Equatable {
        /// Book axis: before this chapter, or last with nil.
        case book(before: String?)
        /// Narrative axis at this order, or back to 未放置 with nil.
        case narrative(Double?)
    }

    /// Applies one drop. On the narrative axis the lane and the order are one
    /// `moveChapter` command that changes both or neither; elsewhere the lane
    /// (membership) goes first, then the book position, each only when it
    /// changes. `lane` nil keeps the lane; `.some(nil)` is 未归属. The first
    /// refusal stops and is shown.
    func drop(chapterID: String, lane: String??, placement: Placement?, completion: ((Bool) -> Void)? = nil) {
        guard !busy else { showStatus("正在保存故事图谱，请稍后再拖动。"); completion?(false); return }
        let title = chapter(id: chapterID)?.title ?? "章节"
        var laneChange: (target: String?, membership: (ids: [String], primary: String?), message: String)?
        if case .some(let target) = lane, !storylines.storylines.isEmpty,
           let membership = Self.laneMembership(current: storylines.membership(chapterID: chapterID), target: target) {
            let name = target.flatMap { storylines.storyline(id: $0)?.name }
            laneChange = (target, membership, name.map { "“\(title)”的主线已改为“\($0)”" } ?? "“\(title)”已移到未归属")
        }
        if case .narrative(let order)? = placement {
            let orderChanged = order != narrativeOrder(of: chapterID)
            guard orderChanged || laneChange != nil else { onChange?(); completion?(false); return }
            // JSON has no non-finite numbers; such an order is refused here
            // and the lane stays as it is.
            if let order, !order.isFinite {
                showStatus("这个位置无法保存，请重新拖动。章节的轨道和位置都未改变。"); completion?(false); return
            }
            busy = true; onChange?()
            let orderArgument: Double?? = orderChanged ? .some(order) : nil
            var laneArgument: String?? = nil
            if let laneChange { laneArgument = .some(laneChange.target) }
            moveOnTimeline(chapterID: chapterID, order: orderArgument, lane: laneArgument,
                           message: Self.moveMessage(title: title, lane: laneChange?.message, order: orderArgument)) { [weak self] ok in
                guard let self else { return }
                self.busy = false
                self.onChange?()
                completion?(ok)
                self.runQueuedRefresh()
            }
            return
        }
        var steps: [(@escaping (Bool) -> Void) -> Void] = []
        if let laneChange {
            steps.append { [weak self] next in
                self?.setMembership(chapterID: chapterID, membership: laneChange.membership, message: laneChange.message + "。", completion: next)
            }
        }
        if case .book(let before)? = placement {
            steps.append { [weak self] next in self?.moveInBook(chapterID: chapterID, before: before, title: title, completion: next) }
        }
        guard !steps.isEmpty else { onChange?(); completion?(false); return }
        busy = true; onChange?()
        func run(_ index: Int) {
            guard index < steps.count else { finish(true); return }
            let step = steps[index]
            step { ok in ok ? run(index + 1) : finish(false) }
        }
        func finish(_ ok: Bool) {
            busy = false
            onChange?()
            completion?(ok)
            runQueuedRefresh()
        }
        run(0)
    }

    /// 移出故事时间: back to the 未放置 tray.
    func unplace(chapterID: String, completion: ((Bool) -> Void)? = nil) {
        drop(chapterID: chapterID, lane: nil, placement: .narrative(nil), completion: completion)
    }

    /// Moves a chapter to another lane by the lane-change rule.
    func setLane(chapterID: String, storylineID: String?, completion: ((Bool) -> Void)? = nil) {
        drop(chapterID: chapterID, lane: .some(storylineID), placement: nil, completion: completion)
    }

    /// Places a chapter after the last placed one.
    func placeAtEnd(chapterID: String, completion: ((Bool) -> Void)? = nil) {
        let last = placedChapters.last(where: { $0.id != chapterID }).flatMap { narrativeOrder(of: $0.id) }
        drop(chapterID: chapterID, lane: nil, placement: .narrative(Self.order(between: last, and: nil)), completion: completion)
    }

    private func setMembership(chapterID: String, membership: (ids: [String], primary: String?), message: String,
                               completion: @escaping (Bool) -> Void) {
        beginCommand()
        workspace.setChapterStorylines(projectID: projectID, chapterID: chapterID, storylineIDs: membership.ids,
                                       primary: membership.primary) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let reply):
                self.storylines = reply.library
                self.status = message
                self.onStorylineLibrary?(reply.library)
                completion(true)
            case .failure(let error): self.status = error.localizedDescription; completion(false)
            }
        }
    }

    private func moveInBook(chapterID: String, before: String?, title: String, completion: @escaping (Bool) -> Void) {
        beginCommand()
        workspace.moveChapter(projectID: projectID, chapterID: chapterID, beforeChapterID: before) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let chapters):
                self.chapters = chapters
                self.status = "“\(title)”的成书顺序已保存。"
                self.onChapters?(chapters)
                // Memberships list chapters in book order.
                self.requests += 1
                self.workspace.storylineLibrary(projectID: self.projectID) { [weak self] library in
                    guard let self else { return }
                    if case .success(let library) = library {
                        self.storylines = library
                        self.onStorylineLibrary?(library)
                    }
                    completion(true)
                }
            case .failure(let error): self.status = error.localizedDescription; completion(false)
            }
        }
    }

    private static func moveMessage(title: String, lane: String?, order: Double??) -> String {
        let place: String?
        switch order {
        case .some(nil): place = "移出故事时间，放回“未放置”"
        case .some(.some): place = "在故事时间中的位置已保存"
        case nil: place = nil
        }
        switch (lane, place) {
        case (let lane?, let place?): return "\(lane)，\(place)。"
        case (let lane?, nil): return "\(lane)。"
        case (nil, let place?): return place.hasPrefix("移出") ? "“\(title)”已\(place)。" : "“\(title)”\(place)。"
        case (nil, nil): return "“\(title)”未改变。"
        }
    }

    /// One `moveChapter` original: the order and the lane together. A lane
    /// change reads the storyline library again, as a membership reply
    /// would carry it.
    private func moveOnTimeline(chapterID: String, order: Double??, lane: String??, message: String,
                                completion: @escaping (Bool) -> Void) {
        beginCommand()
        workspace.moveChapterOnTimeline(projectID: projectID, chapterID: chapterID, order: order, lane: lane) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let reply):
                self.timeline = reply.timeline
                self.status = message
                guard lane != nil else { completion(true); return }
                self.requests += 1
                self.workspace.storylineLibrary(projectID: self.projectID) { [weak self] library in
                    guard let self else { return }
                    if case .success(let library) = library {
                        self.storylines = library
                        self.onStorylineLibrary?(library)
                    }
                    completion(true)
                }
            case .failure(let error): self.status = error.localizedDescription; completion(false)
            }
        }
    }

    /// A marker needs a trimmed label or a drift.
    func createMarker(order: Double, label: String, driftID: String? = nil,
                      completion: ((Result<WorkspaceTimelineMarker, Error>) -> Void)? = nil) {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || driftID != nil else {
            let refusal = "时间标记需要名称，或绑定一条漂流。"
            showStatus(refusal); completion?(.failure(LabError.message(refusal))); return
        }
        markerCommand(message: "时间标记“\(trimmed.isEmpty ? "漂流" : trimmed)”已添加。", completion: completion) {
            self.workspace.createTimelineMarker(projectID: self.projectID, narrativeOrder: order, label: trimmed,
                                                driftID: driftID, completion: $0)
        }
    }

    /// Unchanged fields are not sent; nothing changed writes nothing.
    func updateMarker(id: String, changes: TimelineMarkerChanges, message: String,
                      completion: ((Result<WorkspaceTimelineMarker, Error>) -> Void)? = nil) {
        guard let marker = timeline.marker(id: id) else {
            showStatus("这个时间标记已不可用，请刷新故事图谱。")
            completion?(.failure(LabError.message("这个时间标记已不可用。"))); return
        }
        var sent = changes
        if let label = sent.label {
            let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
            sent.label = trimmed == marker.label ? nil : trimmed
        }
        if sent.narrativeOrder == marker.narrativeOrder { sent.narrativeOrder = nil }
        if let driftID = sent.driftID, driftID == marker.driftNodeId { sent.driftID = nil }
        guard !sent.fields.isEmpty else { completion?(.success(marker)); return }
        markerCommand(message: message, completion: completion) {
            self.workspace.updateTimelineMarker(projectID: self.projectID, markerID: id, changes: sent, completion: $0)
        }
    }

    func deleteMarker(id: String, completion: ((Result<Void, Error>) -> Void)? = nil) {
        let caption = timeline.marker(id: id).map(caption(of:)) ?? "标记"
        guard !busy else { completion?(.failure(LabError.message("正在保存故事图谱，请稍后重试。"))); return }
        busy = true; onChange?(); beginCommand()
        workspace.deleteTimelineMarker(projectID: projectID, markerID: id) { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let reply):
                self.timeline = reply.timeline
                self.showStatus("时间标记“\(caption)”已删除。")
                completion?(.success(()))
            case .failure(let error):
                self.showStatus(error.localizedDescription)
                completion?(.failure(error))
            }
            self.runQueuedRefresh()
        }
    }

    /// Writes a chapter's status without a tab host; the window routes
    /// status through the tab host instead so pages follow.
    func setStatus(chapterID: String, status: String) {
        guard let chapter = chapter(id: chapterID), chapter.writingStatus != status else { return }
        beginCommand()
        workspace.setNodeStatus(projectID: projectID, nodeID: chapterID, status: status) { [weak self] result in
            switch result {
            case .success(let metadata):
                self?.applyNodeMetadata(metadata)
                self?.showStatus("“\(chapter.title)”已设为\(WritingStatus.label(metadata.writingStatus))。")
            case .failure(let error): self?.showStatus(error.localizedDescription)
            }
        }
    }

    /// Stores a drift card's place; an unchanged place writes nothing.
    func moveDrift(id: String, x: Double, y: Double, completion: ((Bool) -> Void)? = nil) {
        if let node = timeline.node(id: id), node.positionX == x, node.positionY == y { completion?(false); return }
        guard !busy else { showStatus("正在保存故事图谱，请稍后再拖动。"); onChange?(); completion?(false); return }
        busy = true; onChange?(); beginCommand()
        workspace.setNodePosition(projectID: projectID, nodeID: id, x: x, y: y) { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let reply): self.timeline = reply.timeline; self.showStatus("漂流卡片的位置已保存。"); completion?(true)
            case .failure(let error): self.showStatus(error.localizedDescription); completion?(false)
            }
            self.runQueuedRefresh()
        }
    }

    private func markerCommand(message: String, completion: ((Result<WorkspaceTimelineMarker, Error>) -> Void)?,
                               operation: @escaping (@escaping (Result<WorkspaceTimelineReply<WorkspaceTimelineMarker>, Error>) -> Void) -> Void) {
        guard !busy else { completion?(.failure(LabError.message("正在保存故事图谱，请稍后重试。"))); return }
        busy = true; onChange?(); beginCommand()
        operation { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let reply):
                self.timeline = reply.timeline
                self.showStatus(message)
                if let marker = reply.result { completion?(.success(marker)) }
                else { completion?(.failure(LabError.message("时间标记结果缺失"))) }
            case .failure(let error):
                self.showStatus(error.localizedDescription)
                completion?(.failure(error))
            }
            self.runQueuedRefresh()
        }
    }
}
