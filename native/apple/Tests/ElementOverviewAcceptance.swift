import AppKit

/// The 设定总览 through the real controller, canvas, tab host, Rust
/// workspace and SQLite, wired as AppDelegate wires them. Pointer input is
/// synthesized mouse events sent to the canvas; every name is synthetic.
extension BindingAcceptance {
    fileprivate final class OverviewHarness {
        let directory: URL
        private(set) var workspace: LabWorkspaceCore
        private(set) var project: WorkspaceProject
        private(set) var chapters: [WorkspaceChapter] = []
        private(set) var window: NSWindow
        private(set) var host: MacChapterWorkspace
        private(set) var settings: LabSettingsStore
        private(set) var model: ElementOverviewModel!
        private(set) var controller: MacElementOverviewViewController!
        private(set) var panel: NSWindow!
        /// The 设定库 as the app keeps it beside the overview.
        private(set) var library: ElementLibraryModel!
        let journal: JournalProbe
        /// Pages the overview asked to open, as `kind:id`.
        var opened: [String] = []
        var answer: ((NSAlert) -> NSApplication.ModalResponse)?
        /// The sheet window the overview presented last.
        var sheet: NSWindow?

        init(chapters titles: [String], directory existing: URL? = nil) throws {
            let directory = existing ?? FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                .appendingPathComponent("apple-native-lab")
            self.directory = directory
            journal = JournalProbe(directory: directory)
            let workspace = LabWorkspaceCore(directory: directory)
            self.workspace = workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            if existing != nil, let first = listed.first {
                project = first
                chapters = try BindingAcceptance.elementResult { workspace.chapters(projectID: first.id, completion: $0) }
            } else {
                try BindingAcceptance.require(listed.isEmpty, "Overview fixture was not isolated")
                project = try BindingAcceptance.elementResult { workspace.createProject(name: "总览合成项目", completion: $0) }
            }
            settings = LabSettingsStore(directory: workspace.dataDirectory)
            (window, host) = BindingAcceptance.elementHost(workspace)
            let projectID = project.id
            for title in titles {
                chapters.append(try BindingAcceptance.elementResult { workspace.createChapter(projectID: projectID, title: title, completion: $0) })
            }
            wireHost()
        }

        /// The tab host and the 设定库 route libraries as AppDelegate routes them.
        private func wireHost() {
            let projectID = project.id
            library = ElementLibraryModel(workspace: workspace, projectID: projectID)
            library.onLibrary = { [weak self] library in
                self?.host.applyElementLibrary(projectID: projectID, library: library)
                self?.model?.applyElementLibrary(library)
            }
            host.onElementLibrary = { [weak self] _, library in
                self?.library.apply(library, message: nil)
                self?.model?.applyElementLibrary(library)
            }
            host.onStorylineLibrary = { [weak self] _, library in self?.model?.applyStorylines(library) }
            host.onDriftLibrary = { [weak self] _, library in self?.model?.applyDrifts(library) }
            host.onNodeMetadata = { [weak self] _, metadata in self?.model?.applyNodeMetadata(metadata) }
            host.onRemoteOriginal = { [weak self] _ in self?.model?.refresh() }
        }

        func chapter(_ title: String) throws -> WorkspaceChapter {
            guard let chapter = chapters.first(where: { $0.title == title }) else { throw LabError.message("No chapter \(title)") }
            return chapter
        }

        func category(_ name: String) throws -> WorkspaceElementCategory {
            let projectID = project.id
            let reply: WorkspaceElementReply<WorkspaceElementCategory> = try BindingAcceptance.elementResult {
                workspace.createElementCategory(projectID: projectID, name: name, completion: $0)
            }
            guard let category = reply.result else { throw LabError.message("No category \(name)") }
            return category
        }

        @discardableResult
        func element(_ name: String, in category: WorkspaceElementCategory, group: String? = nil) throws -> WorkspaceElement {
            let projectID = project.id
            let reply: WorkspaceElementReply<WorkspaceElement> = try BindingAcceptance.elementResult {
                workspace.createElement(projectID: projectID, categoryID: category.id, name: name, groupName: group, completion: $0)
            }
            guard let element = reply.result else { throw LabError.message("No element \(name)") }
            return element
        }

        func update(_ element: WorkspaceElement, _ changes: WorkspaceElementChanges) throws {
            let projectID = project.id
            let _: WorkspaceElementReply<WorkspaceElement> = try BindingAcceptance.elementResult {
                workspace.updateElement(projectID: projectID, elementID: element.id, changes: changes, completion: $0)
            }
        }

        func storyline(_ name: String) throws -> WorkspaceStoryline {
            let projectID = project.id
            let reply: WorkspaceStorylineReply<WorkspaceStoryline> = try BindingAcceptance.elementResult {
                workspace.createStoryline(projectID: projectID, name: name, completion: $0)
            }
            guard let storyline = reply.result else { throw LabError.message("No storyline \(name)") }
            return storyline
        }

        @discardableResult
        func member(_ title: String, _ ids: [String], primary: String?) throws -> WorkspaceStorylineLibrary {
            let projectID = project.id, chapterID = try chapter(title).id
            let reply: WorkspaceStorylineReply<WorkspaceChapterStorylines> = try BindingAcceptance.elementResult {
                workspace.setChapterStorylines(projectID: projectID, chapterID: chapterID, storylineIDs: ids, primary: primary, completion: $0)
            }
            return reply.library
        }

        func act(at title: String, named name: String) throws {
            let projectID = project.id, chapterID = try chapter(title).id
            let act: WorkspaceAct = try BindingAcceptance.elementResult { workspace.createAct(projectID: projectID, chapterID: chapterID, completion: $0) }
            let _: WorkspaceAct = try BindingAcceptance.elementResult { workspace.renameAct(projectID: projectID, actID: act.id, name: name, completion: $0) }
        }

        func relationType(_ name: String, symmetric: Bool = false, roles: (String, String) = ("", ""),
                          from: [String] = ["element"], to: [String] = ["element"]) throws -> WorkspaceRelationType {
            let projectID = project.id
            let definition = RelationTypeDefinition(name: name, orientation: symmetric ? "symmetric" : "directed", sourceRole: roles.0,
                                                    targetRole: symmetric ? roles.0 : roles.1, sourceKinds: from, targetKinds: symmetric ? from : to)
            let reply: WorkspaceRelationReply<WorkspaceRelationType> = try BindingAcceptance.elementResult {
                workspace.createRelationType(projectID: projectID, definition: definition, completion: $0)
            }
            guard let type = reply.result else { throw LabError.message("No relation type \(name)") }
            return type
        }

        @discardableResult
        func relate(_ from: RelationEndpoint, _ to: RelationEndpoint, _ type: WorkspaceRelationType) throws -> WorkspaceRelation {
            let projectID = project.id
            let reply: WorkspaceRelationReply<WorkspaceRelation> = try BindingAcceptance.elementResult {
                workspace.addRelation(projectID: projectID, from: from, to: to, relationTypeID: type.id, completion: $0)
            }
            guard let relation = reply.result else { throw LabError.message("No relation") }
            return relation
        }

        /// A new model, controller and panel, as AppDelegate.showElementOverview builds them.
        func openOverview(size: NSSize = NSSize(width: 1200, height: 800)) throws {
            panel?.close()
            let projectID = project.id
            let model = ElementOverviewModel(workspace: workspace, projectID: projectID, relations: host.relations.model(projectID: projectID))
            let viewport = settings.elementOverviewViewport(projectID: projectID)
            model.showsDrifts = viewport?.showsDrifts ?? false
            let host = self.host
            model.onElementLibrary = { [weak self] library in
                host.applyElementLibrary(projectID: projectID, library: library)
                self?.library.apply(library, message: nil)
            }
            let controller = MacElementOverviewViewController(model: model)
            controller.initialViewport = viewport
            controller.presentAlert = { [weak self] alert, done in
                alert.layout()
                done(self?.answer?(alert) ?? .alertSecondButtonReturn)
            }
            controller.presentSheet = { [weak self] window in self?.sheet = window }
            let project = self.project
            controller.onOpenElement = { [weak self] element in
                self?.opened.append("element:\(element.id)")
                host.open(project: project, element: element) { _ in }
            }
            controller.onOpenCategory = { [weak self] category in
                self?.opened.append("category:\(category.id)")
                host.open(project: project, category: category) { _ in }
            }
            controller.onOpenChapter = { [weak self] chapter in
                self?.opened.append("chapter:\(chapter.id)")
                host.open(project: project, chapter: chapter) { _ in }
            }
            controller.onOpenDrift = { [weak self] drift in self?.opened.append("drift:\(drift.id)") }
            controller.onTrashElement = { element in
                host.trashElement(projectID: projectID, elementID: element.id) { _ in }
            }
            let panel = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
            panel.isReleasedWhenClosed = false
            panel.contentViewController = controller
            panel.setContentSize(size)
            controller.view.layoutSubtreeIfNeeded()
            self.model = model; self.controller = controller; self.panel = panel
            model.load()
            try settled()
        }

        func settled(file: String = #fileID, line: Int = #line) throws {
            try BindingAcceptance.wait(file: file, line: line) {
                self.model.loaded && !self.model.busy && self.model.relations.loaded && !self.model.relations.busy && !self.host.isBusy
            }
            controller.view.layoutSubtreeIfNeeded()
        }

        /// Remembers the viewport and closes the panel, as the app does.
        func closeOverview() {
            guard let controller else { return }
            settings.setElementOverviewViewport(controller.viewport, projectID: project.id)
            panel?.close()
            self.controller = nil; self.model = nil; panel = nil
        }

        var canvas: ElementOverviewCanvas { controller.canvas }
        var scene: ElementOverviewScene { model.scene }

        func card(_ endpoint: RelationEndpoint) throws -> ElementOverviewScene.Card {
            guard let card = scene.card(endpoint) else { throw LabError.message("No card for \(endpoint.key)") }
            return card
        }
        func element(_ element: WorkspaceElement) -> RelationEndpoint { RelationEndpoint(kind: "element", id: element.id) }
        func node(_ id: String) -> RelationEndpoint { RelationEndpoint(kind: "node", id: id) }
        func centre(_ rect: CGRect) -> CGPoint { CGPoint(x: rect.midX, y: rect.midY) }

        func event(_ type: NSEvent.EventType, world point: CGPoint, flags: NSEvent.ModifierFlags = [], clicks: Int = 1) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: canvas.convert(canvas.viewPoint(world: point), to: nil), modifierFlags: flags,
                               timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel.windowNumber, context: nil,
                               eventNumber: 0, clickCount: clicks, pressure: type == .leftMouseUp ? 0 : 1)!
        }

        func click(world point: CGPoint, flags: NSEvent.ModifierFlags = [], clicks: Int = 1) throws {
            canvas.mouseDown(with: event(.leftMouseDown, world: point, flags: flags, clicks: clicks))
            canvas.mouseUp(with: event(.leftMouseUp, world: point, flags: flags, clicks: clicks))
            try settled()
        }

        /// Presses at `from`, drags in `steps` moves to `to` (world points at
        /// the zoom and pan when the press starts; the pointer path is fixed
        /// on screen) and releases there; `during` runs before release.
        func drag(from: CGPoint, to: CGPoint, flags: NSEvent.ModifierFlags = [], steps: Int = 5,
                  during: (() throws -> Void)? = nil) throws {
            let start = canvas.viewPoint(world: from), end = canvas.viewPoint(world: to)
            func mouse(_ type: NSEvent.EventType, _ point: CGPoint) -> NSEvent {
                NSEvent.mouseEvent(with: type, location: canvas.convert(point, to: nil), modifierFlags: flags,
                                   timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel.windowNumber, context: nil,
                                   eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1)!
            }
            canvas.mouseDown(with: mouse(.leftMouseDown, start))
            for step in 1...steps {
                let t = CGFloat(step) / CGFloat(steps)
                canvas.mouseDragged(with: mouse(.leftMouseDragged, CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)))
            }
            try during?()
            canvas.mouseUp(with: mouse(.leftMouseUp, end))
            try settled()
        }

        /// A box dragged by its legend so its visible frame starts at the cell's origin.
        func dragBox(_ key: String, to cell: ElementOverviewCell, flags: NSEvent.ModifierFlags = []) throws {
            guard let box = scene.box(key) else { throw LabError.message("No box \(key)") }
            let grab = CGPoint(x: box.legendFrame.minX + 10, y: box.legendFrame.midY)
            let target = CGPoint(x: CGFloat(cell.x) * ElementOverviewMetrics.cellWidth + ElementOverviewMetrics.gapX / 2,
                                 y: CGFloat(cell.y) * ElementOverviewMetrics.cellHeight)
            try drag(from: grab, to: CGPoint(x: grab.x + target.x - box.frame.minX, y: grab.y + target.y - box.frame.minY), flags: flags)
        }

        func key(_ characters: String, flags: NSEvent.ModifierFlags = .command) -> Bool {
            let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                         windowNumber: panel.windowNumber, context: nil, characters: characters,
                                         charactersIgnoringModifiers: characters, isARepeat: false, keyCode: 0)!
            return canvas.performKeyEquivalent(with: event)
        }

        /// A continuous trackpad scroll; with ⌘ it zooms.
        func scroll(dx: Int32, dy: Int32, command: Bool = false) {
            guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else { return }
            cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
            if command { cg.flags = .maskCommand }
            if let event = NSEvent(cgEvent: cg) { canvas.scrollWheel(with: event) }
        }

        func press(_ identifier: String, in target: ElementOverviewCanvas.Target) throws {
            func find(_ items: [NSMenuItem]) -> LibraryMenuItem? {
                for item in items {
                    if item.accessibilityIdentifier() == identifier, let entry = item as? LibraryMenuItem { return entry }
                    if let found = item.submenu.flatMap({ find($0.items) }) { return found }
                }
                return nil
            }
            guard let entry = find(controller.menuItems(for: target)) else { throw LabError.message("No menu item \(identifier)") }
            try BindingAcceptance.require(entry.isEnabled, "\(identifier) was disabled")
            entry.press()
            try settled()
        }

        func menuIdentifiers(_ target: ElementOverviewCanvas.Target) -> [String] {
            controller.menuItems(for: target).compactMap { $0.accessibilityIdentifier().isEmpty ? nil : $0.accessibilityIdentifier() }
        }

        func layouts() throws -> [String: WorkspaceCategoryLayout] {
            let projectID = project.id
            let reply: WorkspaceElementReply<[WorkspaceCategoryLayout]> = try BindingAcceptance.elementResult {
                workspace.categoryLayouts(projectID: projectID, completion: $0)
            }
            return Dictionary((reply.result ?? []).map { ($0.categoryId, $0) }, uniquingKeysWith: { first, _ in first })
        }

        func relations() throws -> WorkspaceRelationLibrary {
            let projectID = project.id
            return try BindingAcceptance.elementResult { workspace.relationLibrary(projectID: projectID, completion: $0) }
        }

        /// Closes the overview, every owner and the workspace, then opens the
        /// directory again with a new core, tab host and settings store.
        func coldRelaunch() throws {
            closeOverview()
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "Overview workspace failed to close")
            window.close()
            let reopened = LabWorkspaceCore(directory: directory)
            workspace = reopened
            let projects: [WorkspaceProject] = try BindingAcceptance.elementResult { reopened.projects(completion: $0) }
            try BindingAcceptance.require(projects.map(\.id) == [project.id], "Cold relaunch lost the project")
            settings = LabSettingsStore(directory: reopened.dataDirectory)
            (window, host) = BindingAcceptance.elementHost(reopened)
            wireHost()
        }

        func close() throws {
            closeOverview()
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "Overview workspace failed to close")
            window.close()
        }

        func remove() { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
    }

    static func elementOverviewAcceptance() throws -> [String] {
        try overviewSolver()
        try overviewLayout()
        try overviewPinning()
        try overviewEdges()
        try overviewOpening()
        try overviewLiveRefresh()
        try overviewLargeBook()
        return elementOverviewCases
    }

    static let elementOverviewCases = [
        "Swift 设定总览 solver packs automatic category boxes largest first on the side that keeps them lowest while balancing area above and below the band, routes them around pinned boxes, snaps a pinned box that crosses the band to the nearer side, sizes and groups boxes as the renderer does and places the same boxes identically in any input order",
        "AppKit 设定总览 shows the book's chapters in book order across the band grouped by act in storyline lanes, category boxes above and below it holding their element cards in groups, 未分类 for elements without a category and an empty category as 空, opens from the 设定库's 总览, and pans by drag and scroll and zooms by ⌘-scroll, ⌘+, ⌘− and ⌘0 within 40%–200% writing nothing",
        "AppKit 设定总览 dragging a category box pins it to the cell under the drop with one original of field.set placements, snaps a box dropped across the band to the nearer side, packs automatic boxes around the pins, writes nothing for a drop in place or a click-sized drag, returns it to the solver with 恢复自动排列 (offered only for pinned boxes), and keeps pins and the viewport (settings.json) through a cold relaunch",
        "AppKit 设定总览 draws relation edges between element cards and chapter pills, selects an edge to show its ends and type and retypes, swaps and removes it through the shared relation library that page 关系 sections follow, creates relations by ⌥-drag, Shift-click and the card menu in the 新建关系 sheet, and refuses a reversed type, a self relation (Rust's Chinese refusal) and a cancelled sheet without writing",
        "AppKit 设定总览 opens a double-clicked element card's page, a legend's 分类页 and a double-clicked chapter pill as tabs in the tab host, a single click on a card shows its popover and opens nothing, and 移到回收站 from a card's menu trashes the element through the tab host and removes its card and edges",
        "AppKit 设定总览 follows changes made elsewhere without reopening: elements created and categories renamed in the 设定库, an element renamed on its page and recategorised, a category trashed moving its elements to 未分类, a relation added through a page's relation library, chapters created and renamed, a lane change, drifts in the 漂流 row with their edges, and a remote chapter original",
        "AppKit 设定总览 lays out 60 chapters in 3 acts and 3 lanes, 20 categories, 300 elements and 400 relations with the solver under 100 ms and no main-thread pass (open, refresh, pan, zoom, sharpen) over 100 ms in a debug build, and opening, panning and zooming write nothing to the journal",
    ]

    // MARK: (a) Solver

    private static func overviewSolver() throws {
        typealias S = ElementOverviewSolver
        func input(_ id: String, _ w: Int, _ h: Int, _ pin: (Int, Int)? = nil) -> S.Input {
            S.Input(id: id, widthCells: w, heightCells: h, pinned: pin.map { ElementOverviewCell(x: $0.0, y: $0.1) })
        }
        func cell(_ result: S.Result, _ id: String) -> (Int, Int, S.Side)? {
            result.placement(id: id).map { ($0.cell.x, $0.cell.y, $0.side) }
        }
        let none = S.solve([], bandCells: 3)
        try require(none.placements.isEmpty && (none.minX, none.maxX, none.minY, none.maxY) == (0, 0, 0, 3), "An empty layout has other bounds")

        // Two equal boxes: the first above the band at the anchor, the second below.
        let pair = S.solve([input("a", 2, 1), input("b", 2, 1)], bandCells: 3)
        try require(cell(pair, "a")! == (-1, -1, .top) && cell(pair, "b")! == (-1, 3, .bottom), "Two boxes: \(pair.placements)")

        // A pinned box right above the anchor is an obstacle.
        let obstacle = S.solve([input("p", 2, 1, (-1, -1)), input("q", 2, 1), input("r", 2, 1)], bandCells: 3)
        try require(cell(obstacle, "p")! == (-1, -1, .top) && obstacle.placement(id: "p")?.pinned == true, "The pin moved")
        try require(cell(obstacle, "q")! == (-1, 3, .bottom) && cell(obstacle, "r")! == (-3, -1, .top),
            "Automatic boxes did not route around the pin: \(obstacle.placements)")

        // A pin crossing the band snaps to the nearer side.
        let crossing = S.solve([input("c", 2, 2, (5, 1)), input("d", 2, 2, (8, 2)), input("e", 1, 1, (0, -6)), input("f", 1, 1, (0, 9))], bandCells: 3)
        try require(cell(crossing, "c")! == (5, -2, .top) && cell(crossing, "d")! == (8, 3, .bottom)
            && cell(crossing, "e")! == (0, -6, .top) && cell(crossing, "f")! == (0, 9, .bottom), "Band crossings: \(crossing.placements)")
        try require(S.clamp(row: 0, heightCells: 1, bandCells: 4) == (-1, .top) && S.clamp(row: 2, heightCells: 3, bandCells: 4) == (4, .bottom)
            && S.clamp(row: -3, heightCells: 3, bandCells: 4) == (-3, .top), "clamp differs")

        // Largest first, balanced, no overlaps, never on the band, any order.
        let boxes = [input("big", 4, 3), input("mid", 3, 2), input("mid2", 3, 2), input("small", 1, 1), input("tall", 1, 4),
                     input("wide", 6, 1), input("pin", 2, 2, (-8, 3)), input("tiny", 1, 1), input("sq", 2, 2), input("sq2", 2, 2)]
        let solved = S.solve(boxes, bandCells: 4)
        try require(cell(solved, "big")! == (-2, -3, .top), "The largest box is not first at the anchor: \(String(describing: cell(solved, "big")))")
        var generator = SystemRandomNumberGenerator()
        for _ in 0..<6 {
            let shuffled = S.solve(boxes.shuffled(using: &generator), bandCells: 4)
            for box in boxes {
                try require(shuffled.placement(id: box.id) == solved.placement(id: box.id), "Input order changed \(box.id)")
            }
        }
        let rects = boxes.map { box -> CGRect in
            let p = solved.placement(id: box.id)!
            return CGRect(x: p.cell.x, y: p.cell.y, width: box.widthCells, height: box.heightCells)
        }
        for (i, a) in rects.enumerated() {
            try require(a.maxY <= 0 || a.minY >= 4, "\(boxes[i].id) sits on the band: \(a)")
            for b in rects[(i + 1)...] { try require(!a.intersects(b), "Boxes overlap: \(a) \(b)") }
        }
        let area = { (side: S.Side) in zip(boxes, solved.placements).filter { $0.1.side == side }.reduce(0) { $0 + $1.0.widthCells * $1.0.heightCells } }
        try require(abs(area(.top) - area(.bottom)) <= 12, "Areas are not balanced: \(area(.top)) / \(area(.bottom))")
        try require(solved.minY == Int(rects.map(\.minY).min()!) && solved.maxY == Int(rects.map(\.maxY).max()!), "Bounds differ")

        // Box sizes and groups (`buildSuperElementCategoryModel`).
        func elements(_ count: Int, group: (Int) -> String?) -> [WorkspaceElement] {
            (0..<count).map { WorkspaceElement(id: "e\($0)", projectId: "p", categoryId: "c", name: "设定\($0)", summary: "", aliases: [],
                                               groupName: group($0), facts: [], documentId: "d\($0)", createdAt: "", updatedAt: "") }
        }
        let empty = ElementOverviewBox(key: "c", category: nil, elements: [])
        try require((empty.widthCells, empty.heightCells, empty.count) == (2, 1, 0) && empty.name == "未分类", "An empty box is not 2 × 1")
        let single = ElementOverviewBox(key: "c", category: nil, elements: elements(1) { _ in nil })
        try require((single.widthCells, single.heightCells) == (1, 2) && single.groups.first?.headerTop == nil, "A single card box differs")
        let grouped = ElementOverviewBox(key: "c", category: nil, elements: elements(8) { $0 < 3 ? "A 主角" : $0 < 6 ? "B 配角" : ($0 == 6 ? "  " : nil) })
        try require(grouped.widthCells == 3 && grouped.heightCells == 4 && grouped.groups.map(\.name) == ["A 主角", "B 配角", nil]
            && grouped.groups.map(\.headerTop) == [8, 80, nil] && grouped.groups.map(\.cardRowsTop) == [24, 96, 158] && grouped.contentHeight == 218,
            "Groups differ: \(grouped.groups.map { ($0.name, $0.headerTop, $0.cardRowsTop) })")
        let many = ElementOverviewBox(key: "c", category: nil, elements: elements(40) { _ in "同组" })
        try require((many.widthCells, many.heightCells) == (6, 8) && many.groups.first?.headerTop == nil, "A 40-card box differs")
        // Relation colours: author types by creation order, whatever their names.
        func type(_ id: String, _ name: String, _ created: String, locked: Bool = false) -> WorkspaceRelationType {
            WorkspaceRelationType(id: id, projectId: "p", name: name, normalizedName: name, description: "", orientation: "directed",
                                  systemKey: locked ? "generic-association" : nil, locked: locked, sourceRole: "", targetRole: "",
                                  sourceKinds: ["element"], targetKinds: ["element"], createdAt: created, updatedAt: created)
        }
        let legend = WorkspaceRelationLibrary(types: [type("t-z", "阿", "2026-01-03"), type("t-a", "中", "2026-01-01"),
                                                      type("builtin", "Generic association", "2026-01-00", locked: true), type("t-m", "乙", "2026-01-02")],
                                              relations: [])
        try require(RelationTypeLegend.slots(legend) == ["t-a": 0, "t-m": 1, "t-z": 2], "Relation colours do not follow creation order")
    }

    // MARK: (b) Layout, 设定库 entry, pan and zoom

    private static func overviewLayout() throws {
        let harness = try OverviewHarness(chapters: ["序章", "雨夜", "北塔", "钟声", "归途", "尾声"])
        defer { harness.remove() }
        try harness.act(at: "序章", named: "起")
        try harness.act(at: "钟声", named: "转")
        let main = try harness.storyline("主线"), hidden = try harness.storyline("暗线")
        try harness.member("北塔", [hidden.id], primary: hidden.id)
        try harness.member("钟声", [main.id, hidden.id], primary: hidden.id)
        try harness.member("尾声", [], primary: nil)
        let people = try harness.category("人物"), places = try harness.category("地点"), factions = try harness.category("势力")
        var cast: [WorkspaceElement] = []
        for (index, name) in ["老周", "阿岚", "米拉", "守塔人", "邮差", "船夫", "渔女", "钟匠"].enumerated() {
            cast.append(try harness.element(name, in: people, group: index < 3 ? "A 主角" : index < 6 ? "B 配角" : nil))
        }
        for name in ["北塔", "码头", "旧城"] { try harness.element(name, in: places) }
        let loose = try harness.element("无名信", in: places)
        try harness.update(loose, WorkspaceElementChanges(categoryID: .some(nil)))
        let mark = try harness.journal.mark()

        // The 设定库's 总览 opens the overview.
        var asked = 0
        let libraryController = MacElementLibraryViewController(model: harness.library)
        libraryController.onShowOverview = { asked += 1 }
        _ = libraryController.view
        harness.library.load()
        try wait { harness.library.loaded && libraryController.overviewButton.isEnabled }
        libraryController.overviewButton.performClick(nil)
        try require(asked == 1, "总览 in the 设定库 did not ask for the overview")
        try harness.openOverview()
        let scene = harness.scene, model = harness.model!

        // The band: book order, acts, lanes by primary.
        let pills = scene.cards.filter { $0.kind == .chapter }
        try require(pills.map(\.title) == ["序章", "雨夜", "北塔", "钟声", "归途", "尾声"], "Pills are not in book order: \(pills.map(\.title))")
        try require(zip(pills, pills.dropFirst()).allSatisfy { $0.frame.midX + ElementOverviewMetrics.slot - 0.5 < $1.frame.midX + 1 },
            "Pills are not one slot apart")
        try require(scene.lanes.map(\.name) == ["主线", "暗线", "未归属"] && scene.lanes.map(\.count) == [3, 2, 1], "Lanes differ: \(scene.lanes.map(\.name))")
        for (title, lane) in [("序章", 0), ("雨夜", 0), ("北塔", 1), ("钟声", 1), ("归途", 0), ("尾声", 2)] {
            let pill = try harness.card(harness.node(try harness.chapter(title).id))
            try require(scene.lanes[lane].frame.contains(harness.centre(pill.frame)), "\(title) is not in lane \(lane)")
        }
        try require(scene.acts.map(\.title) == ["起", "转"] && scene.acts.map(\.count) == [3, 3], "Acts differ: \(scene.acts.map(\.title))")
        let first = try harness.card(harness.node(try harness.chapter("序章").id)), third = try harness.card(harness.node(try harness.chapter("北塔").id))
        try require(scene.acts[0].frame.minX <= first.frame.minX && scene.acts[0].frame.maxX >= third.frame.maxX
            && scene.acts[1].frame.minX > third.frame.maxX, "The act strip does not span its chapters")
        try require(scene.transits.count >= 1, "The chapter in two storylines has no transit")
        try require(abs(scene.bandFrame.midX) < 0.5, "The band is not centred on the anchor")

        // Boxes above and below, off the band and apart; cards in their boxes.
        try require(Set(scene.boxes.map(\.key)) == [people.id, places.id, factions.id, ElementOverviewBox.uncategorized], "Boxes differ")
        let band = CGRect(x: -10_000, y: 0, width: 20_000, height: CGFloat(scene.bandCells) * ElementOverviewMetrics.cellHeight)
        for box in scene.boxes {
            try require(!box.frame.intersects(band) && !box.frame.intersects(scene.bandFrame), "\(box.model.name) sits on the band")
            for other in scene.boxes where other.key != box.key { try require(!box.frame.intersects(other.frame), "Boxes overlap") }
        }
        try require(Set(scene.boxes.map(\.placement.side)) == [.top, .bottom], "Boxes are not on both sides")
        let peopleBox = scene.box(people.id)!
        try require(peopleBox.model.widthCells == 3 && peopleBox.headers.map(\.title) == ["A 主角", "B 配角"] && peopleBox.model.count == 8,
            "人物's box differs: \(peopleBox.model.widthCells) \(peopleBox.headers.map(\.title))")
        for element in cast { try require(peopleBox.frame.contains((try harness.card(harness.element(element))).frame), "\(element.name) is outside 人物") }
        try require(scene.box(factions.id)?.model.count == 0 && scene.box(factions.id)?.model.widthCells == 2, "势力 is not the empty 2 × 1 box")
        try require(scene.box(ElementOverviewBox.uncategorized)?.model.groups.first?.elements.map(\.name) == ["无名信"], "未分类 differs")
        try require(harness.canvas.boxLayer(people.id)?.legendText == "人物 ·8" && harness.canvas.cardLayerCount == 12 + 6,
            "Layers differ: \(harness.canvas.boxLayer(people.id)?.legendText ?? "") \(harness.canvas.cardLayerCount)")
        try require(harness.controller.metaLabel.stringValue == "3 类 · 12 设定 · 0 条关系", "The meta differs: \(harness.controller.metaLabel.stringValue)")
        try require(harness.canvas.cardLayer(harness.element(cast[0]))?.content?.title == "老周", "The card layer is not drawn with its name")

        // The band starts centred at 100%.
        let canvas = harness.canvas
        let bandCentre = canvas.viewPoint(world: harness.centre(scene.bandFrame))
        try require(abs(bandCentre.x - canvas.bounds.midX) < 1 && abs(bandCentre.y - canvas.bounds.midY) < 1 && canvas.zoom == 1,
            "The band is not centred at 100%")
        // Drag on empty canvas and on the band pans.
        let emptyPoint = CGPoint(x: scene.bounds.maxX - 20, y: scene.bandFrame.minY - 6)
        try require(scene.hit(emptyPoint, tolerance: 6) == .empty, "The pan start is not empty: \(scene.hit(emptyPoint, tolerance: 6))")
        let before = canvas.pan
        try harness.drag(from: emptyPoint, to: CGPoint(x: emptyPoint.x - 150, y: emptyPoint.y + 40))
        try require(abs(canvas.pan.x - (before.x - 150)) < 1 && abs(canvas.pan.y - (before.y + 40)) < 1, "A drag did not pan: \(canvas.pan)")
        let pill = harness.centre(first.frame)
        let beforeBand = canvas.pan
        try harness.drag(from: pill, to: CGPoint(x: pill.x + 60, y: pill.y))
        try require(abs(canvas.pan.x - (beforeBand.x + 60)) < 1, "A drag on a pill did not pan")
        let scrolled = canvas.pan
        harness.scroll(dx: -30, dy: 20)
        try require(canvas.pan != scrolled && canvas.zoom == 1, "A scroll did not pan")
        // ⌘-scroll, ⌘+, ⌘− and ⌘0 zoom within 40%–200% around the centre.
        harness.scroll(dx: 0, dy: 60, command: true)
        try require(canvas.zoom != 1, "⌘-scroll did not zoom: \(canvas.zoom)")
        let anchor = CGPoint(x: canvas.bounds.midX, y: canvas.bounds.midY)
        let world = canvas.worldPoint(view: anchor)
        try require(harness.key("="), "⌘+ was not handled")
        let after = canvas.viewPoint(world: world)
        try require(abs(after.x - anchor.x) < 0.5 && abs(after.y - anchor.y) < 0.5, "⌘+ did not zoom around the centre")
        for _ in 0..<10 { _ = harness.key("=") }
        try require(canvas.zoom == ElementOverviewMetrics.zoomRange.upperBound && harness.controller.zoomLabel.stringValue == "200%", "Zoom exceeded 200%")
        for _ in 0..<20 { _ = harness.key("-") }
        try require(canvas.zoom == ElementOverviewMetrics.zoomRange.lowerBound && harness.controller.zoomLabel.stringValue == "40%", "Zoom fell below 40%")
        canvas.zoom(by: 1.5, around: CGPoint(x: 100, y: 80))
        try require(abs(canvas.zoom - 0.6) < 0.001, "Pinch zoom differs: \(canvas.zoom)")
        try require(harness.key("0") && canvas.zoom == 1, "⌘0 did not reset")
        let reset = canvas.viewPoint(world: harness.centre(scene.bandFrame))
        try require(abs(reset.x - canvas.bounds.midX) < 1, "⌘0 did not centre the band")
        try require(!harness.key("k"), "⌘K was taken")
        try wait { canvas.renders > 0 }
        try harness.journal.expect([], since: mark, "Opening, panning and zooming")
        try require(model.requests >= 6, "The overview did not read")
        try harness.close()
    }

    // MARK: (c) Pinning

    private static func overviewPinning() throws {
        let harness = try OverviewHarness(chapters: ["第一章", "第二章", "第三章"])
        defer { harness.remove() }
        let people = try harness.category("人物"), places = try harness.category("地点"), factions = try harness.category("势力")
        let things = try harness.category("物品")
        for name in ["老周", "阿岚", "米拉", "守塔人"] { try harness.element(name, in: people) }
        for name in ["北塔", "码头"] { try harness.element(name, in: places) }
        try harness.element("钟楼会", in: factions)
        _ = things
        try harness.openOverview()
        let bandCells = harness.scene.bandCells
        let auto = harness.scene.solution
        try require(harness.menuIdentifiers(.box(places.id)) == ["overview-category-open"], "恢复自动排列 is offered for an automatic box")

        // Pin 地点 far above on the left.
        var mark = try harness.journal.mark()
        let target = ElementOverviewCell(x: -12, y: -5)
        try harness.dragBox(places.id, to: target)
        try require(harness.scene.box(places.id)?.placement == ElementOverviewSolver.Placement(id: places.id, cell: target, side: .top, pinned: true),
            "地点 is not pinned at the drop: \(String(describing: harness.scene.box(places.id)?.placement))")
        try require(try harness.layouts()[places.id] == WorkspaceCategoryLayout(categoryId: places.id, layoutMode: "pinned", gridX: -12, gridY: -5),
            "The stored placement differs")
        try harness.expect(journal: [["field.set element-category", "field.set element-category", "field.set element-category"]], since: mark,
                           "Pinning", harness.journal)
        try require(harness.model.status.contains("已固定"), "The status does not say it is pinned: \(harness.model.status)")
        try require(harness.menuIdentifiers(.box(places.id)) == ["overview-category-open", "overview-category-auto"], "恢复自动排列 is missing")
        try require(harness.library.library == harness.model.library, "The 设定库 did not receive the reply")
        // Its box's layer sits at the cell after the drop.
        try require(harness.canvas.boxLayer(places.id)?.frame == harness.scene.box(places.id)?.frame, "The layer is not at its cell")

        // A pin right above the anchor: automatic boxes pack around it.
        let obstacle = ElementOverviewCell(x: -1, y: -2)
        try harness.dragBox(factions.id, to: obstacle)
        let pinned = harness.scene.box(factions.id)!
        for box in harness.scene.boxes where !box.pinned {
            try require(!box.frame.intersects(pinned.frame), "\(box.model.name) overlaps the pin")
        }
        let expected = ElementOverviewSolver.solve(harness.scene.boxes.map { box in
            ElementOverviewSolver.Input(id: box.key, widthCells: box.model.widthCells, heightCells: box.model.heightCells,
                                        pinned: box.pinned ? box.placement.cell : nil)
        }, bandCells: bandCells)
        try require(expected == harness.scene.solution, "The scene is not the solver's layout")
        try require(harness.scene.solution != auto, "Pins changed nothing")

        // Dropped across the band: the nearer side.
        mark = try harness.journal.mark()
        try harness.dragBox(things.id, to: ElementOverviewCell(x: 6, y: 1))
        try require(try harness.layouts()[things.id]?.cell == ElementOverviewCell(x: 6, y: -1)
            && harness.scene.box(things.id)?.placement.side == .top, "A drop on the band's upper half did not snap above")
        try harness.dragBox(things.id, to: ElementOverviewCell(x: 6, y: bandCells - 1))
        try require(try harness.layouts()[things.id]?.cell == ElementOverviewCell(x: 6, y: bandCells)
            && harness.scene.box(things.id)?.placement.side == .bottom, "A drop on the band's lower half did not snap below")
        try harness.expect(journal: [["field.set element-category", "field.set element-category", "field.set element-category"],
                                     ["field.set element-category"]], since: mark, "Two band crossings", harness.journal)

        // A drop in place and a click-sized drag write nothing.
        mark = try harness.journal.mark()
        let requests = harness.model.requests
        guard let box = harness.scene.box(places.id) else { throw LabError.message("No 地点 box") }
        // Below its one row of cards: the box's own area.
        let grab = CGPoint(x: box.frame.minX + 20, y: box.frame.maxY - 20)
        try require(harness.scene.hit(grab, tolerance: 6) == .box(places.id), "The grab point is not the box: \(harness.scene.hit(grab, tolerance: 6))")
        try harness.drag(from: grab, to: CGPoint(x: grab.x + 20, y: grab.y + 10))
        try harness.drag(from: grab, to: CGPoint(x: grab.x + 1, y: grab.y + 1), steps: 1)
        try require(harness.opened.isEmpty, "A click on the box opened a page")
        try require(harness.model.requests == requests && harness.scene.box(places.id)?.placement.cell == target,
            "A drop in place sent a command or moved the box")
        try harness.expect(journal: [], since: mark, "Drops in place", harness.journal)
        // The empty category's box drags too; 未分类 has no menu and no pin.
        try require(harness.menuIdentifiers(.box(ElementOverviewBox.uncategorized)).isEmpty, "未分类 has a menu")

        // 恢复自动排列.
        mark = try harness.journal.mark()
        try harness.press("overview-category-auto", in: .box(places.id))
        try require(try harness.layouts()[places.id] == WorkspaceCategoryLayout(categoryId: places.id, layoutMode: "auto", gridX: nil, gridY: nil),
            "恢复自动排列 did not store auto")
        try require(harness.scene.box(places.id)?.pinned == false, "地点 is still pinned")
        try harness.expect(journal: [["field.set element-category", "field.set element-category", "field.set element-category"]], since: mark,
                           "恢复自动排列", harness.journal)

        // Pins and the viewport survive a cold relaunch.
        harness.canvas.zoom(by: 1.3)
        harness.canvas.pan(by: CGPoint(x: -80, y: 35))
        let viewport = harness.controller.viewport
        let before = harness.scene.solution
        try harness.coldRelaunch()
        try require(harness.settings.elementOverviewViewport(projectID: harness.project.id) == viewport, "settings.json lost the viewport")
        let file = harness.settings.fileURL
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        try require(((json?["elementOverviewViewports"] as? [String: Any])?[harness.project.id] as? [String: Any])?["zoom"] != nil,
            "settings.json does not hold the viewport")
        mark = try harness.journal.mark()
        try harness.openOverview()
        try require(harness.scene.solution == before, "Placements differ after relaunch")
        try require(harness.scene.box(factions.id)?.placement.cell == obstacle && harness.scene.box(factions.id)?.pinned == true, "The pin was lost")
        try require(abs(harness.canvas.zoom - CGFloat(viewport.zoom)) < 0.001
            && abs(harness.controller.viewport.centerX - viewport.centerX) < 0.5 && abs(harness.controller.viewport.centerY - viewport.centerY) < 0.5,
            "The viewport was not restored: \(harness.controller.viewport) vs \(viewport)")
        try harness.expect(journal: [], since: mark, "Opening after relaunch", harness.journal)
        try harness.close()
    }

    // MARK: (d) Edges

    private static func overviewEdges() throws {
        let harness = try OverviewHarness(chapters: ["雨夜", "北塔之夜"])
        defer { harness.remove() }
        // Separate boxes, so edges cross open canvas.
        let people = try harness.category("人物"), companions = try harness.category("同伴"), places = try harness.category("地点")
        let zhou = try harness.element("老周", in: people), lan = try harness.element("阿岚", in: companions)
        try harness.element("米拉", in: people)
        let tower = try harness.element("北塔", in: places)
        let mentor = try harness.relationType("师徒", roles: ("师父", "徒弟"))
        let allies = try harness.relationType("同盟", symmetric: true, roles: ("盟友", ""))
        let appears = try harness.relationType("出场", roles: ("角色", "章节"), from: ["element"], to: ["node"])
        let rain = try harness.chapter("雨夜"), night = try harness.chapter("北塔之夜")
        let taught = try harness.relate(harness.element(zhou), harness.element(lan), mentor)
        try harness.relate(harness.element(lan), harness.node(rain.id), appears)
        // A page's 关系 section shares the relation library.
        let page: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, element: zhou, completion: $0) }
        try elementSettled(harness.host, page)
        guard let zhouPage = harness.host.retainedElementPage(pane: 0, scope: ElementScope(projectID: harness.project.id, elementID: zhou.id)) else {
            throw LabError.message("No 老周 page")
        }
        try harness.openOverview()
        var scene = harness.scene
        try require(scene.edges.count == 2 && scene.edges.allSatisfy(\.directed), "Edges differ: \(scene.edges.count)")
        guard let edge = scene.edge(taught.id) else { throw LabError.message("No 师徒 edge") }
        let zhouCard = try harness.card(harness.element(zhou)), lanCard = try harness.card(harness.element(lan))
        try require(edge.from == harness.centre(zhouCard.frame) && edge.fromName == "老周" && edge.toName == "阿岚", "The edge ends differ")
        try require(!lanCard.frame.contains(edge.to) && lanCard.frame.insetBy(dx: -30, dy: -30).contains(edge.to), "The arrow does not meet 阿岚's side")
        try require(harness.controller.metaLabel.stringValue.hasSuffix("2 条关系"), "The meta does not count edges")

        /// A point on the edge that no card covers.
        func grip(_ id: String) throws -> CGPoint {
            guard let edge = harness.scene.edge(id) else { throw LabError.message("No edge \(id)") }
            for t in stride(from: 0.5, through: 0.9, by: 0.05) {
                let point = edge.point(at: CGFloat(t))
                if harness.scene.hit(point, tolerance: 6 / harness.canvas.zoom) == .edge(id) { return point }
            }
            throw LabError.message("Edge \(id) has no free point")
        }

        // Selecting shows the ends and type.
        var mark = try harness.journal.mark()
        try harness.click(world: try grip(taught.id))
        let controller = harness.controller!
        try require(harness.canvas.selectedEdge == taught.id && !controller.edgeBar.isHidden && controller.edgeLabel.stringValue == "老周 → 阿岚"
            && controller.edgeTypePopup.titleOfSelectedItem == "师徒（师父 → 徒弟）", "The edge bar differs: \(controller.edgeLabel.stringValue)")
        try require(controller.edgeTypePopup.itemArray.compactMap { $0.representedObject as? String }.contains(allies.id), "同盟 is not offered")
        // Retype to 同盟: one original; the page's section follows.
        controller.chooseEdgeType(allies.id)
        try harness.settled()
        var stored = try harness.relations().relation(id: taught.id)
        try require(stored?.relationTypeId == allies.id && harness.scene.edge(taught.id)?.directed == false, "Retyping did not store 同盟")
        try require(zhouPage.relationsView.entries.first { $0.relation.id == taught.id }?.typeName == "同盟", "The page did not follow the retype")
        let retypeOriginal = try harness.journal.originals(since: mark)
        try require(retypeOriginal.count == 1 && retypeOriginal[0].allSatisfy { $0 == "field.set entity-relation" }, "Retyping wrote \(retypeOriginal)")
        // The current type writes nothing.
        mark = try harness.journal.mark()
        controller.chooseEdgeType(allies.id)
        try harness.settled()
        try harness.expect(journal: [], since: mark, "Choosing the current type", harness.journal)
        // Back to 师徒, then 交换方向.
        controller.chooseEdgeType(mentor.id)
        try harness.settled()
        try require(!controller.edgeSwapButton.isHidden && controller.edgeSwapButton.isEnabled, "交换方向 is unavailable for 师徒")
        guard let directed = try harness.relations().relation(id: taught.id) else { throw LabError.message("The relation is gone") }
        let names = [zhou.id: "老周", lan.id: "阿岚"]
        mark = try harness.journal.mark()
        controller.edgeSwapButton.performClick(nil)
        try harness.settled()
        stored = try harness.relations().relation(id: taught.id)
        try require(stored?.fromId == directed.toId && stored?.toId == directed.fromId
            && controller.edgeLabel.stringValue == "\(names[directed.toId]!) → \(names[directed.fromId]!)", "交换方向 did not swap")
        try require(try harness.journal.originals(since: mark).count == 1, "交换方向 wrote more than one original")
        // Escape clears the selection; 删除关系 from the menu removes it.
        harness.canvas.keyDown(with: NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: harness.panel.windowNumber,
                                                      context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53)!)
        try require(harness.canvas.selectedEdge == nil && controller.edgeBar.isHidden, "Escape kept the selection")
        mark = try harness.journal.mark()
        try harness.press("overview-edge-remove-menu", in: .edge(taught.id))
        try require(try harness.relations().relation(id: taught.id) == nil && harness.scene.edge(taught.id) == nil
            && !zhouPage.relationsView.entries.contains { $0.relation.id == taught.id }, "删除关系 did not remove it everywhere")
        try harness.expect(journal: [["entity.purge entity-relation"]], since: mark, "删除关系", harness.journal)

        // ⌥-drag from 北塔 to 老周: the 新建关系 sheet.
        mark = try harness.journal.mark()
        let towerCard = try harness.card(harness.element(tower))
        try harness.drag(from: harness.centre(towerCard.frame), to: harness.centre(zhouCard.frame), flags: .option)
        guard let sheet = controller.relationSheet else { throw LabError.message("⌥-drag did not open the sheet") }
        try require(harness.sheet === sheet.window && sheet.directionLabel.stringValue == "北塔 → 老周" && !sheet.addButton.isEnabled,
            "The sheet differs: \(sheet.directionLabel.stringValue)")
        try require(Set(sheet.typeOptions.map(\.id)) == [mentor.id, allies.id], "Type options differ")
        sheet.chooseType(mentor.id)
        try require(sheet.addButton.isEnabled, "添加 is disabled for a fitting type")
        sheet.add()
        try harness.settled()
        try require(controller.relationSheet == nil, "The sheet stayed open")
        let created = try harness.relations().relations.first { $0.fromId == tower.id && $0.toId == zhou.id }
        try require(created?.relationTypeId == mentor.id && harness.canvas.selectedEdge == created?.id && harness.scene.edge(created!.id) != nil,
            "The new relation is not drawn and selected")
        try harness.expect(journal: [["entity.create entity-relation"]], since: mark, "The new relation", harness.journal)

        // A reversed type is explained and refused before writing; swapping fits it.
        mark = try harness.journal.mark()
        let nightPill = try harness.card(harness.node(night.id))
        try harness.drag(from: harness.centre(nightPill.frame), to: harness.centre(lanCard.frame), flags: .option)
        guard let reversed = controller.relationSheet else { throw LabError.message("No sheet from the pill") }
        try require(reversed.directionLabel.stringValue == "北塔之夜 → 阿岚" && reversed.typeOptions.map(\.id) == [appears.id], "Pill sheet differs")
        reversed.chooseType(appears.id)
        try require(!reversed.addButton.isEnabled && reversed.errorMessage?.contains("交换两端") == true, "The reversed type was not refused")
        reversed.add()
        try harness.expect(journal: [], since: mark, "A reversed type", harness.journal)
        reversed.swapDirection()
        reversed.chooseType(appears.id)
        try require(reversed.addButton.isEnabled && reversed.directionLabel.stringValue == "阿岚 → 北塔之夜", "Swapping did not fit 出场")
        reversed.add()
        try harness.settled()
        try require(try harness.relations().relations.contains { $0.fromId == lan.id && $0.toId == night.id }, "The swapped relation is missing")
        scene = harness.scene
        try require(scene.edges.contains { $0.relation.toId == night.id && $0.relation.fromId == lan.id }, "The element–chapter edge is not drawn")

        // A self relation: Rust refuses in Chinese and nothing is written.
        mark = try harness.journal.mark()
        let centre = harness.centre(zhouCard.frame)
        try harness.drag(from: centre, to: CGPoint(x: centre.x + 12, y: centre.y + 6), flags: .option)
        guard let own = controller.relationSheet else { throw LabError.message("A self drop opened no sheet") }
        try require(own.directionLabel.stringValue == "老周 → 老周", "The self sheet differs")
        own.chooseType(allies.id)
        own.add()
        try wait { !own.isSaving }
        try harness.settled()
        try require(own.errorMessage == "关系的两端不能是同一个实体" && controller.relationSheet === own,
            "The self relation was not refused in the sheet: \(own.errorMessage ?? "")")
        own.cancel()
        try require(controller.relationSheet == nil, "Cancel kept the sheet")
        // Shift-click and the card menu pick ends too; cancelling writes nothing.
        try harness.click(world: harness.centre(lanCard.frame), flags: .shift)
        try require(harness.canvas.linkSource == harness.element(lan) && controller.statusLabel.stringValue.contains("阿岚"), "Shift-click did not start a link")
        try require(harness.canvas.cardLayer(harness.element(lan))?.content?.linkSource == true, "The link source is not marked")
        try harness.click(world: harness.centre(towerCard.frame))
        try require(controller.relationSheet?.directionLabel.stringValue == "阿岚 → 北塔", "Shift-click did not open the sheet")
        controller.relationSheet?.cancel()
        try harness.press("overview-element-link", in: .card(.element, tower.id))
        try require(harness.canvas.linkSource == harness.element(tower), "从此设定新建关系… did not start a link")
        try harness.click(world: harness.centre(nightPill.frame))
        try require(controller.relationSheet?.directionLabel.stringValue == "北塔 → 北塔之夜", "The menu link did not reach the pill")
        controller.relationSheet?.cancel()
        try harness.expect(journal: [], since: mark, "The self relation and cancelled sheets", harness.journal)
        try require(harness.opened.isEmpty, "Linking opened a page")
        try harness.close()
    }

    // MARK: (e) Opening

    private static func overviewOpening() throws {
        let harness = try OverviewHarness(chapters: ["雨夜", "北塔"])
        defer { harness.remove() }
        let people = try harness.category("人物")
        let zhou = try harness.element("老周", in: people), lan = try harness.element("阿岚", in: people)
        let allies = try harness.relationType("同盟", symmetric: true, roles: ("盟友", ""))
        try harness.relate(harness.element(zhou), harness.element(lan), allies)
        try harness.openOverview()
        // A click shows the card's popover; a double-click opens its page.
        try harness.click(world: harness.centre(try harness.card(harness.element(zhou)).frame))
        try require(harness.opened.isEmpty && harness.controller.cardPopover?.endpoint == harness.element(zhou), "A click did not show 老周's popover")
        try harness.click(world: harness.centre(try harness.card(harness.element(zhou)).frame), clicks: 2)
        try wait { harness.host.tabTitles(pane: 0).contains("老周") && harness.host.canNavigate }
        try require(harness.opened == ["element:\(zhou.id)"] && harness.host.activeElement?.id == zhou.id && harness.controller.cardPopover == nil,
                    "The card did not open 老周's page")
        guard let legend = harness.scene.box(people.id)?.legendFrame else { throw LabError.message("No legend") }
        try harness.click(world: CGPoint(x: legend.minX + 12, y: legend.midY))
        try wait { harness.host.activeCategory?.id == people.id && harness.host.canNavigate }
        try require(harness.opened.last == "category:\(people.id)", "The legend did not open the 分类页")
        let north = try harness.chapter("北塔")
        let pill = harness.centre(try harness.card(harness.node(north.id)).frame)
        try harness.click(world: pill)
        try require(harness.opened.count == 2 && harness.controller.cardPopover?.endpoint == harness.node(north.id),
                    "A single click on a pill opened a page or showed no popover")
        try harness.click(world: pill, clicks: 2)
        try wait { harness.host.activeChapter?.id == north.id && harness.host.canNavigate }
        try require(harness.opened.last == "chapter:\(north.id)" && harness.host.tabTitles(pane: 0) == ["老周", "人物", "北塔"],
            "The pill did not open its chapter: \(harness.host.tabTitles(pane: 0))")
        // A card's menu: 打开, 从此设定新建关系…, 移到回收站.
        try require(harness.menuIdentifiers(.card(.element, lan.id)) == ["overview-element-open", "overview-element-link", "overview-element-trash"],
            "The card menu differs")
        let mark = try harness.journal.mark()
        try harness.press("overview-element-trash", in: .card(.element, lan.id))
        try wait { harness.scene.card(harness.element(lan)) == nil }
        try harness.settled()
        try require(harness.scene.edges.isEmpty && harness.scene.box(people.id)?.model.count == 1 && harness.library.library.elements.count == 1,
            "The trashed element's card or edge stayed")
        let trashed = try harness.journal.originals(since: mark)
        try require(trashed.count == 1 && trashed[0].contains("entity.purge entity-relation"), "Trash wrote \(trashed)")
        try harness.close()
    }

    // MARK: (f) Live refresh

    private static func overviewLiveRefresh() throws {
        // A source replica authors the remote chapter at the end.
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: parent) }
        let sourceDirectory = parent.appendingPathComponent("source/apple-native-lab")
        let receiverDirectory = parent.appendingPathComponent("receiver/apple-native-lab")
        let source = LabWorkspaceCore(directory: sourceDirectory)
        let _: [WorkspaceProject] = try elementResult { source.projects(completion: $0) }
        let sourceProject: WorkspaceProject = try elementResult { source.createProject(name: "总览合成项目", completion: $0) }
        for title in ["雨夜", "北塔"] {
            let _: WorkspaceChapter = try elementResult { source.createChapter(projectID: sourceProject.id, title: title, completion: $0) }
        }
        let _: Bool = try elementResult { source.close(completion: $0) }
        try WorkspaceRemoteProseFixture.copyClosedBaseline(from: sourceDirectory, to: [receiverDirectory])
        let _: [WorkspaceProject] = try elementResult { source.projects(completion: $0) }

        let harness = try OverviewHarness(chapters: [], directory: receiverDirectory)
        let people = try harness.category("人物"), places = try harness.category("地点")
        let zhou = try harness.element("老周", in: people)
        let tower = try harness.element("北塔", in: places)
        let allies = try harness.relationType("同盟", symmetric: true, roles: ("盟友", ""))
        let main = try harness.storyline("主线")
        try harness.openOverview()
        harness.library.load()
        try wait { harness.library.loaded }
        let model = harness.model!
        let renders = harness.canvas.renders

        // The 设定库 creates an element and renames a category.
        var done = false
        harness.library.createElement(categoryID: people.id) { _ in done = true }
        try wait { done }
        try require(harness.scene.box(people.id)?.model.count == 2, "A 设定库 element did not appear")
        done = false
        harness.library.renameCategory(id: places.id, name: "场所") { _ in done = true }
        try wait { done }
        try require(harness.canvas.boxLayer(places.id)?.legendText == "场所 ·1", "The renamed category's legend did not follow")
        // An element page renames 老周.
        let view: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, element: zhou, completion: $0) }
        try elementSettled(harness.host, view)
        guard let page = harness.host.retainedElementPage(pane: 0, scope: ElementScope(projectID: harness.project.id, elementID: zhou.id)) else {
            throw LabError.message("No page")
        }
        try editHeader(harness.window, page.nameField, "老周头")
        try wait { harness.scene.card(harness.element(zhou))?.title == "老周头" }
        try require(harness.canvas.cardLayer(harness.element(zhou))?.content?.title == "老周头", "The card layer did not follow the rename")
        // Recategorised elsewhere and read again by the tab host.
        try harness.update(tower, WorkspaceElementChanges(categoryID: .some(people.id)))
        harness.host.elementsChanged(projectID: harness.project.id)
        try wait { harness.scene.card(harness.element(tower))?.boxKey == people.id }
        // A category trashed in the 设定库: its elements move to 未分类.
        done = false
        harness.library.trashCategory(id: people.id) { _ in done = true }
        try wait { done && harness.scene.box(people.id) == nil }
        try harness.settled()
        try require(harness.scene.box(ElementOverviewBox.uncategorized)?.model.count == 3, "Trashed category elements are not in 未分类")
        // A relation added through the page's relation library.
        done = false
        harness.host.relations.model(projectID: harness.project.id).add(from: harness.element(zhou), to: harness.element(tower), typeID: allies.id) { _ in done = true }
        try wait { done && harness.scene.edges.count == 1 }
        // Chapters created and renamed elsewhere; a lane change.
        let projectID = harness.project.id, workspace = harness.workspace
        let dawn: WorkspaceChapter = try elementResult { workspace.createChapter(projectID: projectID, title: "黎明", completion: $0) }
        model.chaptersChanged()
        try wait { harness.scene.card(harness.node(dawn.id)) != nil }
        let _: WorkspaceChapter = try elementResult { workspace.renameChapter(projectID: projectID, chapterID: dawn.id, title: "破晓", completion: $0) }
        model.chaptersChanged()
        try wait { harness.scene.card(harness.node(dawn.id))?.title == "破晓" }
        try require(harness.scene.lanes.map(\.name) == ["主线", "未归属"], "Lanes differ before the change: \(harness.scene.lanes.map(\.name))")
        let rain = harness.chapters.first { $0.title == "雨夜" }!
        let library = try harness.member("雨夜", [main.id], primary: main.id)
        model.applyStorylines(library)
        try require(harness.scene.lanes[0].frame.contains(harness.centre(harness.scene.card(harness.node(rain.id))!.frame)), "The lane change was not drawn")
        // Drifts: created elsewhere, shown in the 漂流 row with their edges.
        let reply: WorkspaceDriftReply<WorkspaceDrift> = try elementResult { workspace.createDrift(projectID: projectID, title: "旧信", groupID: nil, completion: $0) }
        guard let drift = reply.result else { throw LabError.message("No drift") }
        let links = try harness.relationType("提及", roles: ("来源", "对象"), from: ["node"], to: ["element"])
        try harness.relate(harness.node(drift.id), harness.element(zhou), links)
        harness.host.relations.reload(projectID: projectID)
        harness.host.driftsChanged(projectID: projectID)
        try wait { harness.controller.driftButton.isEnabled && harness.controller.driftButton.title == "漂流 · 1" }
        try require(harness.scene.card(harness.node(drift.id)) == nil && harness.scene.driftArea == nil, "The 漂流 row is shown before it is asked for")
        harness.controller.driftButton.performClick(nil)
        try require(harness.scene.card(harness.node(drift.id))?.kind == .drift && harness.scene.driftArea != nil
            && harness.scene.edges.contains { $0.relation.fromId == drift.id }, "The 漂流 row or its edge is missing")
        try require(harness.controller.viewport.showsDrifts, "The viewport does not remember the 漂流 row")
        try harness.click(world: harness.centre(harness.scene.card(harness.node(drift.id))!.frame), clicks: 2)
        try require(harness.opened.last == "drift:\(drift.id)", "A drift card did not open")

        // A remote chapter original arrives.
        let before = try harness.journal.mark()
        let beforeSource = try WorkspaceRemoteProseFixture.query(in: sourceDirectory,
            sql: "SELECT COALESCE(MAX(rowid), 0) AS n FROM sync_change_set").first?["n"]
        let arrived: WorkspaceChapter = try elementResult { source.createChapter(projectID: sourceProject.id, title: "远方来信", completion: $0) }
        guard case .integer(let floor)? = beforeSource else { throw LabError.message("No source mark") }
        let rows = try WorkspaceRemoteProseFixture.query(in: sourceDirectory, sql: """
            SELECT project_id, project_sync_id, sync_generation_id, change_set_id, payload_sha256, encoded_bytes
            FROM sync_change_set WHERE origin = 'local' AND apply_state = 'applied' AND rowid > \(floor) ORDER BY rowid
            """)
        guard rows.count == 1, case .text(let p)? = rows[0]["project_id"], case .text(let s)? = rows[0]["project_sync_id"],
              case .text(let g)? = rows[0]["sync_generation_id"], case .text(let c)? = rows[0]["change_set_id"],
              case .text(let h)? = rows[0]["payload_sha256"], case .blob(let envelope)? = rows[0]["encoded_bytes"] else {
            throw LabError.message("The remote chapter original is malformed")
        }
        let original = RemoteChangeOriginal(projectId: p, projectSyncId: s, syncGenerationId: g, changeSetId: c, originalEnvelopeSha256: h)
        let _: WorkspaceRemoteChangesReply = try elementResult { workspace.receiveChanges(original: original, envelope: envelope, completion: $0) }
        try wait { harness.scene.card(harness.node(arrived.id))?.title == "远方来信" }
        try harness.settled()
        try require(try harness.journal.originals(since: before).count == 1, "Receiving wrote other originals")
        try require(harness.canvas.renders > renders, "The canvas was not rendered again")
        let _: Bool = try elementResult { source.close(completion: $0) }
        try harness.close()
    }

    // MARK: (g) A large book

    private static func overviewLargeBook() throws {
        let harness = try OverviewHarness(chapters: (1...60).map { "第\($0)章" })
        defer { harness.remove() }
        for (title, name) in [("第1章", "第一幕"), ("第21章", "第二幕"), ("第41章", "第三幕")] { try harness.act(at: title, named: name) }
        let lanes = try ["主线", "副线", "暗线"].map { try harness.storyline($0) }
        for (index, chapter) in harness.chapters.enumerated() {
            let lane = lanes[index % 3]
            try harness.member(chapter.title, [lane.id], primary: lane.id)
        }
        var elements: [WorkspaceElement] = []
        for index in 0..<20 {
            let category = try harness.category("分类\(index + 1)")
            for item in 0..<15 {
                elements.append(try harness.element("设定\(index + 1)-\(item + 1)", in: category, group: item % 5 == 0 ? nil : "组\(item % 3)"))
            }
        }
        let allies = try harness.relationType("同盟", symmetric: true, roles: ("盟友", ""))
        let appears = try harness.relationType("出场", roles: ("角色", "章节"), from: ["element"], to: ["node"])
        var pairs = Set<String>()
        var index = 0
        while pairs.count < 300 {
            let a = elements[index % 300], b = elements[(index * 7 + 13) % 300]
            index += 1
            guard a.id != b.id else { continue }
            let key = [a.id, b.id].sorted().joined(separator: "|")
            guard pairs.insert(key).inserted else { continue }
            try harness.relate(harness.element(a), harness.element(b), allies)
        }
        for item in 0..<100 {
            try harness.relate(harness.element(elements[(item * 3) % 300]), harness.node(harness.chapters[item % 60].id), appears)
        }
        let mark = try harness.journal.mark()
        let started = Date()
        try harness.openOverview()
        let opening = Date().timeIntervalSince(started)

        let scene = harness.scene, canvas = harness.canvas
        try require(scene.cards.filter { $0.kind == .element }.count == 300 && scene.cards.filter { $0.kind == .chapter }.count == 60
            && scene.boxes.count == 20 && scene.edges.count == 400 && scene.acts.count == 3 && scene.lanes.count == 3,
            "The large scene differs: \(scene.cards.count) cards, \(scene.boxes.count) boxes, \(scene.edges.count) edges")
        try require(canvas.slowestSolver < 0.1 && scene.solverSeconds < 0.1, "The solver took \(Int(canvas.slowestSolver * 1000)) ms")
        let openingPass = canvas.slowestPass
        try require(openingPass < 0.1, "Opening took a \(Int(openingPass * 1000)) ms pass")
        for (i, a) in scene.boxes.enumerated() {
            for b in scene.boxes[(i + 1)...] { try require(!a.frame.intersects(b.frame), "Boxes overlap in the large book") }
        }
        // Pan across the whole world and zoom in and out.
        canvas.resetTiming()
        for step in 0..<30 { canvas.pan(by: CGPoint(x: step < 15 ? -120 : 120, y: step % 2 == 0 ? 40 : -40)) }
        let emptyPoint = CGPoint(x: scene.bounds.minX + 30, y: scene.bounds.minY + 30)
        try harness.drag(from: emptyPoint, to: CGPoint(x: emptyPoint.x + 400, y: emptyPoint.y + 200), steps: 30)
        for _ in 0..<4 { _ = harness.key("=") }
        try wait(timeout: 0.4)
        for _ in 0..<8 { _ = harness.key("-") }
        _ = harness.key("0")
        try wait(timeout: 0.4)
        canvas.sharpen()
        // A change elsewhere while it is open.
        var done = false
        harness.library.load()
        try wait { harness.library.loaded }
        harness.library.renameCategory(id: scene.boxes[0].key, name: "改名分类") { _ in done = true }
        try wait { done }
        try require(canvas.slowestPass < 0.1, "A pan, zoom, sharpen or refresh took a \(Int(canvas.slowestPass * 1000)) ms pass")
        try harness.journal.expect([["field.set element-category"]], since: mark, "Opening, panning, zooming and one rename")
        print("element-overview-timing open=\(Int(opening * 1000))ms opening-pass=\(Int(openingPass * 1000))ms solver=\(String(format: "%.2f", scene.solverSeconds * 1000))ms slowest-later-pass=\(Int(canvas.slowestPass * 1000))ms")
        try harness.close()
    }

    /// Runs the loop for a while, e.g. for a debounced pass.
    fileprivate static func wait(timeout: TimeInterval) throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
    }
}

private extension BindingAcceptance.OverviewHarness {
    func expect(journal expected: [[String]], since: Int64, _ step: String, _ probe: JournalProbe) throws {
        try probe.expect(expected, since: since, step)
    }
}
