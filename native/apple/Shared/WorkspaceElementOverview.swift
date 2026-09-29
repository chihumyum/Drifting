import Foundation
import CoreGraphics

/// Presentation state of one project's 设定总览: the element library with
/// each category's stored placement, the book in reading order with acts,
/// storylines, chapter and drift metadata, drifts and the project's relation
/// library (shared with every page's 关系 section). Rust owns every row;
/// this model reads, builds the scene and sends one command per pin, unpin
/// or relation change. Reads, opening, panning and zooming write nothing.
final class ElementOverviewModel {
    let projectID: String
    private let workspace: LabWorkspaceCore
    /// The project's relation library, shared with page sections.
    let relations: RelationLibraryModel
    private(set) var library = WorkspaceElementLibrary.empty
    private(set) var layouts: [String: WorkspaceCategoryLayout] = [:]
    private(set) var book = BookLayout.empty
    private(set) var storylines = WorkspaceStorylineLibrary.empty
    private(set) var nodes: [String: WorkspaceNodeMetadata] = [:]
    private(set) var drifts = WorkspaceDriftLibrary.empty
    /// Drifts bound to a timeline marker or an act have landed and are not
    /// in the 漂流 row.
    private(set) var markerDriftIDs: Set<String> = []
    private(set) var loaded = false
    /// A pin, unpin or relation command is in flight.
    private(set) var busy = false
    /// The last command's message or refusal; nil shows the guidance.
    private var message: String?
    private(set) var statusIsError = false
    var status: String { message ?? (loaded ? defaultStatus : "正在读取设定总览…") }
    /// Reads and commands sent to Rust, for acceptance.
    private(set) var requests = 0
    /// The 漂流 row is shown.
    var showsDrifts = false { didSet { if showsDrifts != oldValue { invalidate() } } }
    /// Relation types whose edges are hidden (关系类型), remembered per
    /// project in settings.json by the window.
    var hiddenRelationTypes: Set<String> = [] {
        didSet {
            guard hiddenRelationTypes != oldValue else { return }
            invalidate()
            onHiddenRelationTypes?(hiddenRelationTypes)
        }
    }
    var onHiddenRelationTypes: ((Set<String>) -> Void)?
    /// Writes a chapter's or drift's summary through the tab host, so pages
    /// follow; nil writes through the workspace.
    var onSetNodeSummary: ((_ nodeID: String, _ summary: String,
                            _ done: @escaping (Result<WorkspaceNodeMetadata, Error>) -> Void) -> Void)?
    /// Writes an element's summary through the tab host; nil writes through
    /// the workspace.
    var onSetElementSummary: ((_ elementID: String, _ summary: String,
                               _ done: @escaping (Result<WorkspaceElementReply<WorkspaceElement>, Error>) -> Void) -> Void)?
    var onChange: (() -> Void)?
    /// A pin or unpin returned the project's complete element library.
    var onElementLibrary: ((WorkspaceElementLibrary) -> Void)?

    private var cachedScene: ElementOverviewScene?
    /// Commands sent so far; a read that saw fewer is stale.
    private var commands = 0
    private var reading = false
    private var rereadQueued = false
    /// Data adopted from elsewhere so far; a full read that saw fewer is
    /// older than what is shown and is read again instead of adopted.
    private var applied = 0

    init(workspace: LabWorkspaceCore, projectID: String, relations: RelationLibraryModel) {
        self.workspace = workspace
        self.projectID = projectID
        self.relations = relations
        relations.observe(self) { [weak self] _ in self?.invalidate() }
    }

    /// The scene of the current data, built once per change.
    var scene: ElementOverviewScene {
        if let cachedScene { return cachedScene }
        let scene = ElementOverviewScene(input: sceneInput)
        cachedScene = scene
        return scene
    }

    var sceneInput: ElementOverviewScene.Input {
        ElementOverviewScene.Input(library: library, layouts: layouts, book: book, storylines: storylines, nodes: nodes,
                                   relations: relations.library, drifts: showsDrifts ? unboundDrifts : [],
                                   hiddenRelationTypes: hiddenRelationTypes)
    }

    /// Live drifts not bound to a marker or an act, oldest change first.
    var unboundDrifts: [WorkspaceDrift] {
        drifts.drifts.filter { $0.actId == nil && !markerDriftIDs.contains($0.id) }.sorted { $0.updatedAt < $1.updatedAt }
    }

    var summary: String {
        let categories = library.categories.count, elements = library.elements.count
        let edges = scene.edges.count
        return "\(categories) 类 · \(elements) 设定 · \(edges) 条关系"
    }

    private func invalidate() {
        cachedScene = nil
        onChange?()
    }

    func showStatus(_ message: String, error: Bool = false) {
        self.message = message; statusIsError = error
        onChange?()
    }

    private var defaultStatus: String {
        if library.categories.isEmpty && library.elements.isEmpty {
            return "还没有设定分类。在设定库中新建分类后，它们会排在章节带的上下。"
        }
        return "拖动分类框可固定到网格上；右键可恢复自动排列。按住 ⌥ 从一张卡片拖到另一张，或先后 Shift-点击两张卡片，可新建关系。"
    }

    // MARK: Reading

    /// Reads everything: the library with placements, the outline, storylines,
    /// chapter and drift metadata in one read, drifts and the timeline's
    /// markers. The relation library is shared and read once.
    func load() {
        guard !reading else { rereadQueued = true; return }
        reading = true
        let generation = commands, seen = applied
        requests += 6
        let project = projectID
        workspace.categoryLayouts(projectID: project) { [weak self] placed in
            guard let self else { return }
            self.workspace.outline(projectID: project) { [weak self] outline in
                guard let self else { return }
                self.workspace.storylineLibrary(projectID: project) { [weak self] storylines in
                    guard let self else { return }
                    self.workspace.nodesMetadata(projectID: project) { [weak self] nodes in
                        guard let self else { return }
                        self.workspace.driftLibrary(projectID: project) { [weak self] drifts in
                            guard let self else { return }
                            self.workspace.timeline(projectID: project) { [weak self] timeline in
                                guard let self else { return }
                                self.reading = false
                                do {
                                    let placed = try placed.get()
                                    let entries = try outline.get(), storylines = try storylines.get(), nodes = try nodes.get()
                                    let drifts = try drifts.get(), timeline = try timeline.get()
                                    if generation == self.commands, seen == self.applied {
                                        self.adoptPlacements(placed.library, placed.result ?? [])
                                        self.nodes = Dictionary(nodes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
                                        self.adoptBook(entries)
                                        self.storylines = storylines
                                        self.drifts = drifts
                                        self.markerDriftIDs = Set(timeline.markers.compactMap(\.driftNodeId))
                                        self.loaded = true
                                        self.invalidate()
                                    } else { self.rereadQueued = true }
                                } catch {
                                    self.showStatus(error.localizedDescription, error: true)
                                }
                                if self.relations.loaded == false, !self.relations.busy { self.relations.load() }
                                self.runQueuedRead()
                            }
                        }
                    }
                }
            }
        }
    }

    /// Reads everything again without blocking, e.g. when the panel becomes
    /// key or a remote original arrived.
    func refresh() { load() }

    private func runQueuedRead() {
        guard rereadQueued, !reading, !busy else { return }
        rereadQueued = false
        load()
    }

    private func adoptPlacements(_ library: WorkspaceElementLibrary, _ placed: [WorkspaceCategoryLayout]) {
        self.library = library
        layouts = Dictionary(placed.map { ($0.categoryId, $0) }, uniquingKeysWith: { first, _ in first })
    }

    private func adoptBook(_ entries: [WorkspaceOutlineEntry]) {
        let statuses = Dictionary(nodes.values.filter { $0.kind == "chapter" }.map { ($0.id, $0.writingStatus) },
                                  uniquingKeysWith: { first, _ in first })
        book = BookLayout(entries: entries, statuses: statuses)
    }

    /// Chapters or acts changed elsewhere (created, renamed, moved, trashed,
    /// restored, received): the outline, storylines and metadata are read.
    func chaptersChanged() {
        guard loaded else { load(); return }
        let generation = commands
        requests += 3
        workspace.outline(projectID: projectID) { [weak self] outline in
            guard let self else { return }
            self.workspace.storylineLibrary(projectID: self.projectID) { [weak self] storylines in
                guard let self else { return }
                self.workspace.nodesMetadata(projectID: self.projectID) { [weak self] nodes in
                    guard let self else { return }
                    guard generation == self.commands, case .success(let entries) = outline, case .success(let storylines) = storylines,
                          case .success(let nodes) = nodes else { return }
                    self.nodes = Dictionary(nodes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
                    self.adoptBook(entries)
                    self.storylines = storylines
                    self.invalidate()
                }
            }
        }
    }

    /// A library returned elsewhere (设定库, a page, a trash). A category that
    /// appeared or left means its placement is read again.
    func applyElementLibrary(_ library: WorkspaceElementLibrary) {
        guard library != self.library else { return }
        applied += 1
        let categoriesChanged = Set(library.categories.map(\.id)) != Set(self.library.categories.map(\.id))
        self.library = library
        layouts = layouts.filter { id, _ in library.categories.contains { $0.id == id } }
        invalidate()
        guard categoriesChanged else { return }
        let generation = commands
        requests += 1
        workspace.categoryLayouts(projectID: projectID) { [weak self] result in
            guard let self, generation == self.commands, case .success(let reply) = result else { return }
            self.adoptPlacements(reply.library, reply.result ?? [])
            self.invalidate()
        }
    }

    func applyStorylines(_ library: WorkspaceStorylineLibrary) {
        guard library != storylines else { return }
        applied += 1
        storylines = library
        invalidate()
    }

    /// A chapter's or drift's stored summary and status.
    func applyNodeMetadata(_ metadata: WorkspaceNodeMetadata) {
        guard nodes[metadata.id] != metadata else { return }
        applied += 1
        nodes[metadata.id] = metadata
        if metadata.kind == "chapter" { book = book.updating(status: metadata.writingStatus, chapterID: metadata.id) }
        invalidate()
    }

    /// Drifts changed elsewhere; bindings to markers are read again.
    func applyDrifts(_ library: WorkspaceDriftLibrary) {
        guard library != drifts else { return }
        applied += 1
        drifts = library
        invalidate()
        requests += 1
        workspace.timeline(projectID: projectID) { [weak self] result in
            guard let self, case .success(let timeline) = result else { return }
            let bound = Set(timeline.markers.compactMap(\.driftNodeId))
            guard bound != self.markerDriftIDs else { return }
            self.markerDriftIDs = bound
            self.invalidate()
        }
    }

    // MARK: Names

    func element(id: String) -> WorkspaceElement? { library.elements.first { $0.id == id } }
    func category(id: String) -> WorkspaceElementCategory? { library.categories.first { $0.id == id } }
    func chapter(id: String) -> WorkspaceChapter? {
        book.chapter(id: id).map { WorkspaceChapter(id: $0.id, title: $0.title, writingStatus: $0.writingStatus) }
    }
    func drift(id: String) -> WorkspaceDrift? { drifts.drift(id: id) }

    /// Names of every endpoint the overview shows, for the relation sheet.
    func name(of endpoint: RelationEndpoint) -> String {
        if let card = scene.card(endpoint) { return card.title }
        switch endpoint.kind {
        case "element": return element(id: endpoint.id)?.name ?? "已不可用的设定"
        case "category": return category(id: endpoint.id)?.name ?? "已不可用的分类"
        default: return chapter(id: endpoint.id)?.title ?? drift(id: endpoint.id)?.title ?? "已不可用的章节或漂流"
        }
    }

    // MARK: Placement commands

    /// Pins a category to a grid cell. The cell the box already occupies
    /// writes nothing.
    func pin(categoryID: String, cell: ElementOverviewCell, completion: ((Bool) -> Void)? = nil) {
        guard let box = scene.box(categoryID), box.model.category != nil else { completion?(false); return }
        guard box.placement.cell != cell else { onChange?(); completion?(false); return }
        place(categoryID: categoryID, cell: cell, message: "“\(box.model.name)”已固定在网格上；右键可恢复自动排列。", completion: completion)
    }

    /// 恢复自动排列: the solver places the category again. An automatic
    /// category writes nothing.
    func unpin(categoryID: String, completion: ((Bool) -> Void)? = nil) {
        guard let box = scene.box(categoryID), box.model.category != nil, layouts[categoryID]?.cell != nil else {
            completion?(false); return
        }
        place(categoryID: categoryID, cell: nil, message: "“\(box.model.name)”已恢复自动排列。", completion: completion)
    }

    private func place(categoryID: String, cell: ElementOverviewCell?, message: String, completion: ((Bool) -> Void)?) {
        guard !busy else { showStatus("正在保存设定总览，请稍后再拖动。"); completion?(false); return }
        busy = true; commands += 1; requests += 1
        onChange?()
        workspace.setCategoryLayout(projectID: projectID, categoryID: categoryID, cell: cell) { [weak self] result in
            guard let self else { return }
            self.busy = false
            switch result {
            case .success(let reply):
                self.library = reply.library
                if let layout = reply.result { self.layouts[categoryID] = layout }
                self.message = message; self.statusIsError = false
                self.invalidate()
                self.onElementLibrary?(reply.library)
                completion?(true)
            case .failure(let error):
                self.showStatus(error.localizedDescription, error: true)
                completion?(false)
            }
            self.runQueuedRead()
        }
    }

    // MARK: Summaries

    /// The stored summary a card popover edits: an element's, or a chapter's
    /// or drift's from the metadata read.
    func summary(of endpoint: RelationEndpoint) -> String? {
        endpoint.kind == "element" ? element(id: endpoint.id)?.summary : nodes[endpoint.id]?.summary
    }

    /// Writes a card's summary in one original, as its page writes it (an
    /// element's as typed, a chapter's or drift's trimmed), and adopts the
    /// reply; the stored summary writes nothing.
    func setSummary(of endpoint: RelationEndpoint, to text: String, completion: @escaping (Result<String, Error>) -> Void) {
        let summary = endpoint.kind == "element" ? text : ElementText.trimmed(text)
        guard summary != self.summary(of: endpoint) else { completion(.success(summary)); return }
        requests += 1
        if endpoint.kind == "element" {
            let done: (Result<WorkspaceElementReply<WorkspaceElement>, Error>) -> Void = { [weak self] result in
                switch result {
                case .success(let reply):
                    guard let stored = reply.result else { completion(.failure(LabError.message("设定结果缺失"))); return }
                    self?.applyElementLibrary(reply.library)
                    completion(.success(stored.summary))
                case .failure(let error): completion(.failure(error))
                }
            }
            if let onSetElementSummary { onSetElementSummary(endpoint.id, summary, done) }
            else {
                workspace.updateElement(projectID: projectID, elementID: endpoint.id, changes: WorkspaceElementChanges(summary: summary)) {
                    [weak self] result in
                    if case .success(let reply) = result { self?.onElementLibrary?(reply.library) }
                    done(result)
                }
            }
            return
        }
        let done: (Result<WorkspaceNodeMetadata, Error>) -> Void = { [weak self] result in
            switch result {
            case .success(let metadata):
                self?.applyNodeMetadata(metadata)
                completion(.success(metadata.summary))
            case .failure(let error): completion(.failure(error))
            }
        }
        if let onSetNodeSummary { onSetNodeSummary(endpoint.id, summary, done) }
        else { workspace.setNodeSummary(projectID: projectID, nodeID: endpoint.id, summary: summary, completion: done) }
    }

    // MARK: Relation commands

    /// Through the shared relation library: every page section follows.
    func addRelation(from: RelationEndpoint, to: RelationEndpoint, typeID: String,
                     completion: @escaping (Result<WorkspaceRelation, Error>) -> Void) {
        requests += 1
        relations.add(from: from, to: to, typeID: typeID, completion: completion)
    }

    func removeRelation(id: String, completion: ((Result<Void, Error>) -> Void)? = nil) {
        guard relations.library.relation(id: id) != nil else { completion?(.success(())); return }
        requests += 1
        relations.remove(relationID: id) { [weak self] result in
            switch result {
            case .success: self?.showStatus("关系已删除。")
            case .failure(let error): self?.showStatus(error.localizedDescription, error: true)
            }
            completion?(result)
        }
    }

    /// The current type without a swap writes nothing.
    func retypeRelation(id: String, typeID: String, swap: Bool, completion: ((Result<WorkspaceRelation, Error>) -> Void)? = nil) {
        guard let relation = relations.library.relation(id: id) else { return }
        guard typeID != relation.relationTypeId || swap else { completion?(.success(relation)); return }
        requests += 1
        relations.retype(relationID: id, typeID: typeID, swap: swap) { [weak self] result in
            switch result {
            case .success: self?.showStatus(swap && typeID == relation.relationTypeId ? "关系方向已交换。" : "关系类型已更改。")
            case .failure(let error): self?.showStatus(error.localizedDescription, error: true)
            }
            completion?(result)
        }
    }
}

/// The 设定总览 viewport remembered per project: the world point at the
/// centre of the view, the zoom and whether the 漂流 row is shown.
struct ElementOverviewViewport: Codable, Equatable {
    var centerX: Double
    var centerY: Double
    var zoom: Double
    var showsDrifts: Bool

    /// Damaged values fall back one by one; the zoom is clamped.
    init(centerX: Double, centerY: Double, zoom: Double, showsDrifts: Bool) {
        self.centerX = centerX.isFinite ? centerX : 0
        self.centerY = centerY.isFinite ? centerY : 0
        let range = ElementOverviewMetrics.zoomRange
        self.zoom = zoom.isFinite ? min(max(zoom, Double(range.lowerBound)), Double(range.upperBound)) : 1
        self.showsDrifts = showsDrifts
    }

    private enum CodingKeys: String, CodingKey { case centerX, centerY, zoom, showsDrifts }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(centerX: (try? values.decodeIfPresent(Double.self, forKey: .centerX)).flatMap { $0 } ?? 0,
                  centerY: (try? values.decodeIfPresent(Double.self, forKey: .centerY)).flatMap { $0 } ?? 0,
                  zoom: (try? values.decodeIfPresent(Double.self, forKey: .zoom)).flatMap { $0 } ?? 1,
                  showsDrifts: (try? values.decodeIfPresent(Bool.self, forKey: .showsDrifts)).flatMap { $0 } ?? false)
    }
}
