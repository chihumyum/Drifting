import AppKit

/// Card popovers and 关系类型 filters on the 故事图谱 and the 设定总览 through
/// the real controllers, canvases, card views, tab host, Rust workspace and
/// SQLite, wired as AppDelegate wires them. Pointer input is synthesized
/// mouse events; the panels are never ordered on screen, so popovers are
/// built and driven but not shown. Every name is synthetic.
extension BindingAcceptance {
    static let canvasCases = [
        "AppKit 故事图谱 card popovers: a click on a chapter or drift card (not a drag, not a marker) shows its title, § number and status or 漂流 status and the summary read once; an edited summary is written trimmed on Return as one field.set node original that the chapter page shows, an unchanged or whitespace-only change and a second close write nothing, Esc closes it saving a changed summary as one more original, 打开 opens the drift page and closes it, a drag closes it, and a chapter trashed elsewhere dismisses it without writing; a closed or dismissed popover lets go of its NSPopover",
        "AppKit 设定总览 card popovers: a click on an element card shows its name, category and group, its summary and at most six key facts with the rest counted, and a chapter pill or drift card its status and summary; an edited element summary is written as one field.set element original that the element page and the card follow, a summary changed elsewhere reaches a clean popover, an unchanged one writes nothing and closing it untouched writes nothing even with spaces around the stored summary, while a change of spacing is written as typed as the element page writes it, Esc closes it saving, a closed popover is released, 打开 saves a changed chapter summary as one field.set node original and opens the chapter, a drift card's 打开 opens the drift, and scrolling closes the popover",
        "AppKit 关系类型 on both canvases lists the author's relation types in creation order (also after a rename) with a system-colour swatch and the count each canvas can draw; the 故事图谱 draws chapter and drift relations as edges in their type's colour with arrows for directed types, the 设定总览 colours its edges the same way, and on either canvas unchecking a type hides its edges (a selected edge is deselected and no longer hit) while checking it or 全部显示 shows them again, writing nothing to the journal; each canvas keeps its own choice per project in settings.json through a cold relaunch",
    ]

    static func canvasAcceptance() throws -> [String] {
        try canvasGraphPopovers()
        try canvasOverviewPopovers()
        try canvasRelationFilters()
        return canvasCases
    }

    // MARK: Harness

    fileprivate final class CanvasHarness {
        let directory: URL
        private(set) var workspace: LabWorkspaceCore
        let project: WorkspaceProject
        private(set) var chapters: [WorkspaceChapter] = []
        private(set) var window: NSWindow
        private(set) var host: MacChapterWorkspace
        private(set) var settings: LabSettingsStore
        let journal: JournalProbe
        private(set) var graph: StoryGraphModel?
        private(set) var graphController: MacStoryGraphViewController?
        private var graphWindow: NSWindow?
        private(set) var overview: ElementOverviewModel?
        private(set) var overviewController: MacElementOverviewViewController?
        private var overviewWindow: NSWindow?
        /// Pages a canvas asked to open, as `kind:id`.
        var opened: [String] = []

        init(chapters titles: [String]) throws {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                .appendingPathComponent("apple-native-lab")
            self.directory = directory
            journal = JournalProbe(directory: directory)
            let workspace = LabWorkspaceCore(directory: directory)
            self.workspace = workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(listed.isEmpty, "Canvas fixture was not isolated")
            project = try BindingAcceptance.elementResult { workspace.createProject(name: "画布合成项目", completion: $0) }
            let projectID = project.id
            for title in titles {
                chapters.append(try BindingAcceptance.elementResult { workspace.createChapter(projectID: projectID, title: title, completion: $0) })
            }
            settings = LabSettingsStore(directory: workspace.dataDirectory)
            (window, host) = BindingAcceptance.elementHost(workspace)
            wireHost()
        }

        /// Libraries and metadata from the tab host reach the canvases as
        /// AppDelegate routes them.
        private func wireHost() {
            host.onElementLibrary = { [weak self] _, library in self?.overview?.applyElementLibrary(library) }
            host.onStorylineLibrary = { [weak self] _, library in
                self?.overview?.applyStorylines(library); self?.graph?.applyStorylines(library)
            }
            host.onDriftLibrary = { [weak self] _, library in
                self?.overview?.applyDrifts(library); self?.graph?.applyDrifts(library)
            }
            host.onNodeMetadata = { [weak self] _, metadata in
                self?.overview?.applyNodeMetadata(metadata); self?.graph?.applyNodeMetadata(metadata)
            }
        }

        func chapter(_ title: String) throws -> WorkspaceChapter {
            guard let chapter = chapters.first(where: { $0.title == title }) else { throw LabError.message("No chapter \(title)") }
            return chapter
        }

        func drift(_ title: String) throws -> WorkspaceDrift {
            let projectID = project.id
            let reply: WorkspaceDriftReply<WorkspaceDrift> = try BindingAcceptance.elementResult {
                workspace.createDrift(projectID: projectID, title: title, groupID: nil, completion: $0)
            }
            guard let drift = reply.result else { throw LabError.message("No drift \(title)") }
            return drift
        }

        func category(_ name: String) throws -> WorkspaceElementCategory {
            let projectID = project.id
            let reply: WorkspaceElementReply<WorkspaceElementCategory> = try BindingAcceptance.elementResult {
                workspace.createElementCategory(projectID: projectID, name: name, completion: $0)
            }
            guard let category = reply.result else { throw LabError.message("No category \(name)") }
            return category
        }

        func element(_ name: String, in category: WorkspaceElementCategory, group: String? = nil) throws -> WorkspaceElement {
            let projectID = project.id
            let reply: WorkspaceElementReply<WorkspaceElement> = try BindingAcceptance.elementResult {
                workspace.createElement(projectID: projectID, categoryID: category.id, name: name, groupName: group, completion: $0)
            }
            guard let element = reply.result else { throw LabError.message("No element \(name)") }
            return element
        }

        @discardableResult
        func update(_ element: WorkspaceElement, summary: String? = nil, facts: [WorkspaceFact]? = nil) throws -> WorkspaceElement {
            let projectID = project.id
            var stored = element
            if let summary {
                let reply: WorkspaceElementReply<WorkspaceElement> = try BindingAcceptance.elementResult {
                    workspace.updateElement(projectID: projectID, elementID: element.id, changes: WorkspaceElementChanges(summary: summary), completion: $0)
                }
                stored = reply.result ?? stored
            }
            if let facts {
                let reply: WorkspaceElementReply<WorkspaceElement> = try BindingAcceptance.elementResult {
                    workspace.setElementFacts(projectID: projectID, elementID: element.id, facts: facts, completion: $0)
                }
                stored = reply.result ?? stored
            }
            return stored
        }

        func relationType(_ name: String, symmetric: Bool = false, from: [String], to: [String]) throws -> WorkspaceRelationType {
            // Types created in the same millisecond would tie on createdAt.
            Thread.sleep(forTimeInterval: 0.005)
            let projectID = project.id
            let definition = RelationTypeDefinition(name: name, orientation: symmetric ? "symmetric" : "directed",
                                                    sourceRole: symmetric ? "端点" : "源", targetRole: symmetric ? "端点" : "目标",
                                                    sourceKinds: from, targetKinds: symmetric ? from : to)
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

        /// A new model, controller and panel, as AppDelegate.showStoryGraph builds them.
        func openGraph() throws {
            graphWindow?.close()
            let projectID = project.id, project = self.project, host = self.host, settings = self.settings
            let model = StoryGraphModel(workspace: workspace, projectID: projectID, relations: host.relations.model(projectID: projectID))
            model.hiddenRelationTypes = settings.hiddenRelationTypes(projectID: projectID, canvas: .storyGraph)
            model.onHiddenRelationTypes = { settings.setHiddenRelationTypes($0, projectID: projectID, canvas: .storyGraph) }
            model.onSetSummary = { nodeID, summary, done in host.setNodeSummary(projectID: projectID, nodeID: nodeID, summary: summary, completion: done) }
            model.onStorylineLibrary = { library in host.applyStorylineLibrary(projectID: projectID, library: library) }
            let controller = MacStoryGraphViewController(model: model)
            controller.presentAlert = { alert, done in alert.layout(); done(.alertSecondButtonReturn) }
            controller.onOpenChapter = { [weak self] chapter in
                self?.opened.append("chapter:\(chapter.id)")
                host.open(project: project, chapter: chapter) { _ in }
            }
            controller.onOpenDrift = { [weak self] drift in
                self?.opened.append("drift:\(drift.id)")
                host.open(project: project, drift: drift) { _ in }
            }
            let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 820), styleMask: [.titled, .resizable],
                                 backing: .buffered, defer: false)
            panel.isReleasedWhenClosed = false
            panel.contentViewController = controller
            panel.setContentSize(NSSize(width: 1200, height: 820))
            controller.view.layoutSubtreeIfNeeded()
            graph = model; graphController = controller; graphWindow = panel
            model.load()
            try settled()
        }

        /// A new model, controller and panel, as AppDelegate.showElementOverview builds them.
        func openOverview(showsDrifts: Bool = false) throws {
            overviewWindow?.close()
            let projectID = project.id, project = self.project, host = self.host, settings = self.settings
            let model = ElementOverviewModel(workspace: workspace, projectID: projectID, relations: host.relations.model(projectID: projectID))
            model.showsDrifts = showsDrifts
            model.hiddenRelationTypes = settings.hiddenRelationTypes(projectID: projectID, canvas: .elementOverview)
            model.onHiddenRelationTypes = { settings.setHiddenRelationTypes($0, projectID: projectID, canvas: .elementOverview) }
            model.onSetNodeSummary = { nodeID, summary, done in
                host.setNodeSummary(projectID: projectID, nodeID: nodeID, summary: summary, completion: done)
            }
            model.onSetElementSummary = { elementID, summary, done in
                host.setElementSummary(projectID: projectID, elementID: elementID, summary: summary, completion: done)
            }
            model.onElementLibrary = { library in host.applyElementLibrary(projectID: projectID, library: library) }
            let controller = MacElementOverviewViewController(model: model)
            controller.presentAlert = { alert, done in alert.layout(); done(.alertSecondButtonReturn) }
            controller.presentSheet = { _ in }
            controller.onOpenElement = { [weak self] element in
                self?.opened.append("element:\(element.id)")
                host.open(project: project, element: element) { _ in }
            }
            controller.onOpenChapter = { [weak self] chapter in
                self?.opened.append("chapter:\(chapter.id)")
                host.open(project: project, chapter: chapter) { _ in }
            }
            controller.onOpenDrift = { [weak self] drift in self?.opened.append("drift:\(drift.id)") }
            controller.onOpenCategory = { [weak self] category in self?.opened.append("category:\(category.id)") }
            let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800), styleMask: [.titled, .resizable],
                                 backing: .buffered, defer: false)
            panel.isReleasedWhenClosed = false
            panel.contentViewController = controller
            panel.setContentSize(NSSize(width: 1200, height: 800))
            controller.view.layoutSubtreeIfNeeded()
            overview = model; overviewController = controller; overviewWindow = panel
            model.load()
            try settled()
        }

        func settled(file: String = #fileID, line: Int = #line) throws {
            try BindingAcceptance.wait(file: file, line: line) {
                (self.graph.map { $0.loaded && !$0.busy } ?? true)
                    && (self.overview.map { $0.loaded && !$0.busy && $0.relations.loaded && !$0.relations.busy } ?? true)
                    && !self.host.isBusy && self.host.canNavigate
            }
            graphController?.view.layoutSubtreeIfNeeded()
            overviewController?.view.layoutSubtreeIfNeeded()
        }

        // MARK: Pointer

        var graphCanvas: StoryGraphCanvas { graphController!.canvas }
        var overviewCanvas: ElementOverviewCanvas { overviewController!.canvas }

        func graphEvent(_ type: NSEvent.EventType, _ point: NSPoint, clicks: Int = 1) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: graphCanvas.convert(point, to: nil), modifierFlags: [],
                               timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: graphWindow?.windowNumber ?? 0,
                               context: nil, eventNumber: 0, clickCount: clicks, pressure: type == .leftMouseUp ? 0 : 1)!
        }

        /// A click (press and release in place) on a card view.
        func click(_ view: NSView) throws {
            let point = NSPoint(x: view.frame.midX, y: view.frame.midY)
            view.mouseDown(with: graphEvent(.leftMouseDown, point))
            view.mouseUp(with: graphEvent(.leftMouseUp, point))
            try settled()
        }

        /// Presses a card view, drags it by `offset` in four moves and releases.
        func drag(_ view: NSView, by offset: NSPoint) throws {
            let start = NSPoint(x: view.frame.midX, y: view.frame.midY)
            view.mouseDown(with: graphEvent(.leftMouseDown, start))
            for step in 1...4 {
                let t = CGFloat(step) / 4
                view.mouseDragged(with: graphEvent(.leftMouseDragged, NSPoint(x: start.x + offset.x * t, y: start.y + offset.y * t)))
            }
            view.mouseUp(with: graphEvent(.leftMouseUp, NSPoint(x: start.x + offset.x, y: start.y + offset.y)))
            try settled()
        }

        func overviewEvent(_ type: NSEvent.EventType, world point: CGPoint, clicks: Int) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: overviewCanvas.convert(overviewCanvas.viewPoint(world: point), to: nil), modifierFlags: [],
                               timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: overviewWindow?.windowNumber ?? 0, context: nil,
                               eventNumber: 0, clickCount: clicks, pressure: type == .leftMouseUp ? 0 : 1)!
        }

        func click(card endpoint: RelationEndpoint, clicks: Int = 1) throws {
            guard let card = overview?.scene.card(endpoint) else { throw LabError.message("No card for \(endpoint.key)") }
            let point = CGPoint(x: card.frame.midX, y: card.frame.midY)
            overviewCanvas.mouseDown(with: overviewEvent(.leftMouseDown, world: point, clicks: clicks))
            overviewCanvas.mouseUp(with: overviewEvent(.leftMouseUp, world: point, clicks: clicks))
            try settled()
        }

        /// A popover's summary once it has been read.
        func loaded(_ popover: CanvasCardPopover?, file: String = #fileID, line: Int = #line) throws -> CanvasCardPopover {
            guard let popover else { throw LabError.message("No card popover at \(file):\(line)") }
            try BindingAcceptance.wait(file: file, line: line) { popover.storedSummary != nil && popover.summaryView.isEditable }
            return popover
        }

        /// Types a summary and presses a key in the popover's field. The
        /// field is not first responder off screen, so no end-editing is sent.
        func type(_ text: String, in popover: CanvasCardPopover, then key: Selector? = #selector(NSResponder.insertNewline(_:))) {
            popover.summaryView.string = text
            if let key { _ = popover.textView(popover.summaryView, doCommandBy: key) }
        }

        func settingsJSON() throws -> [String: Any] {
            let data = try Data(contentsOf: settings.fileURL)
            return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        }

        func closeCanvases() {
            graphController?.closeCardPopover(); overviewController?.closeCardPopover()
            graphWindow?.close(); overviewWindow?.close()
            graph = nil; graphController = nil; graphWindow = nil
            overview = nil; overviewController = nil; overviewWindow = nil
        }

        /// Closes the canvases, every owner and the workspace, then opens the
        /// directory again with a new core, tab host and settings store.
        func coldRelaunch() throws {
            closeCanvases()
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "Canvas workspace failed to close")
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
            closeCanvases()
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "Canvas workspace failed to close")
            window.close()
        }

        func remove() { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
    }

    // MARK: (a) 故事图谱 popovers

    private static func canvasGraphPopovers() throws {
        let harness = try CanvasHarness(chapters: ["雨夜", "北塔", "钟声"])
        defer { harness.remove() }
        let rain = try harness.chapter("雨夜"), north = try harness.chapter("北塔")
        let letter = try harness.drift("旧信")
        // The chapter's page is open, so it can be seen to follow.
        let _: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, chapter: rain, completion: $0) }
        try harness.openGraph()
        guard let graph = harness.graph, let controller = harness.graphController else { throw LabError.message("No graph") }
        let canvas = harness.graphCanvas
        guard let rainCard = canvas.cardViews[rain.id], let letterCard = canvas.driftViews[letter.id] else {
            throw LabError.message("The graph has no cards")
        }

        // A click shows the chapter's popover and reads its summary once.
        let mark = try harness.journal.mark()
        let requests = graph.requests
        try harness.click(rainCard)
        var popover = try harness.loaded(controller.cardPopover)
        try require(popover.endpoint == RelationEndpoint(kind: "node", id: rain.id) && popover.isShown
                    && popover.titleLabel.stringValue == "雨夜" && popover.detailLabel.stringValue == "章节 · § 01 · 草稿"
                    && popover.summaryView.string.isEmpty && popover.factsLabel.isHidden && graph.requests == requests + 1,
                    "The chapter popover differs: \(popover.titleLabel.stringValue) / \(popover.detailLabel.stringValue)")
        try require(harness.opened.isEmpty, "A click opened a page")
        // Unchanged and whitespace-only summaries write nothing.
        popover.commit()
        harness.type("   ", in: popover)
        try harness.settled()
        try require(popover.writes == 0, "An unchanged summary was sent")
        try harness.journal.expect([], since: mark, "Opening the popover and unchanged summaries")

        // Return writes the trimmed summary once; the page follows.
        harness.type("  雨夜里，灯塔熄灭。 ", in: popover)
        try wait { popover.storedSummary == "雨夜里，灯塔熄灭。" }
        try harness.settled()
        try harness.journal.expect([["field.set node"]], since: mark, "Return in the popover")
        try require(popover.writes == 1 && popover.summaryView.string == "雨夜里，灯塔熄灭。" && popover.messageLabel.stringValue == "摘要已保存。",
                    "The popover did not show the stored summary")
        try wait { harness.host.activeChapterPage?.metadataEditor.summaryText == "雨夜里，灯塔熄灭。" }
        // A revert committed while a save is on its way is sent after it.
        let revert = try harness.journal.mark()
        harness.type("雨夜里，灯塔熄灭了。", in: popover)
        harness.type("雨夜里，灯塔熄灭。", in: popover)
        try wait { popover.writes == 3 && popover.storedSummary == "雨夜里，灯塔熄灭。" }
        try harness.settled()
        try harness.journal.expect([["field.set node"], ["field.set node"]], since: revert, "A revert during a save")
        try wait { harness.host.activeChapterPage?.metadataEditor.summaryText == "雨夜里，灯塔熄灭。" }
        // Esc closes it, saving a changed summary as one more original.
        var next = try harness.journal.mark()
        harness.type("雨夜里，北岸的灯塔熄灭。", in: popover, then: #selector(NSResponder.cancelOperation(_:)))
        try require(controller.cardPopover == nil && !popover.isShown, "Esc did not close the popover")
        try wait { harness.host.activeChapterPage?.metadataEditor.summaryText == "雨夜里，北岸的灯塔熄灭。" }
        try harness.settled()
        try harness.journal.expect([["field.set node"]], since: next, "Esc with a changed summary")
        // Opening it again reads the stored summary; closing unchanged writes nothing.
        next = try harness.journal.mark()
        try harness.click(rainCard)
        popover = try harness.loaded(controller.cardPopover)
        try require(popover.summaryView.string == "雨夜里，北岸的灯塔熄灭。", "The popover did not read the stored summary")
        popover.close()
        popover.close()
        try harness.settled()
        try harness.journal.expect([], since: next, "Closing an unchanged popover twice")

        // A drift card: 漂流 and its status; 打开 opens the drift and closes it.
        try harness.click(letterCard)
        popover = try harness.loaded(controller.cardPopover)
        try require(popover.titleLabel.stringValue == "旧信" && popover.detailLabel.stringValue == "漂流 · 漂浮中",
                    "The drift popover reads \(popover.detailLabel.stringValue)")
        popover.openButton.performClick(nil)
        try harness.settled()
        try require(harness.opened == ["drift:\(letter.id)"] && controller.cardPopover == nil, "打开 did not open the drift: \(harness.opened)")
        try harness.journal.expect([], since: next, "打开 without a change")

        // A drag closes the popover; a marker has none.
        guard let northCard = canvas.cardViews[north.id] else { throw LabError.message("No 北塔 card") }
        try harness.click(northCard)
        _ = try harness.loaded(controller.cardPopover)
        try harness.drag(northCard, by: NSPoint(x: 12, y: 0))
        try require(controller.cardPopover == nil, "A drag did not close the popover")
        // A chapter trashed elsewhere dismisses its popover without writing.
        try harness.click(northCard)
        popover = try harness.loaded(controller.cardPopover)
        harness.type("北塔无灯。", in: popover, then: nil)
        next = try harness.journal.mark()
        let projectID = harness.project.id
        let _: WorkspaceChapterTrashReply = try elementResult { harness.workspace.trashChapter(projectID: projectID, chapterID: north.id, completion: $0) }
        graph.refresh()
        try wait { canvas.cardViews[north.id] == nil }
        try harness.settled()
        try require(controller.cardPopover == nil && !popover.isShown && popover.writes == 0 && popover.popover.contentViewController == nil,
                    "The trashed chapter's popover stayed, wrote or is still held: \(controller.cardPopover.map { $0.endpoint.key } ?? "none") shown \(popover.isShown) writes \(popover.writes) same \(controller.cardPopover === popover)")
        try require(try harness.journal.originals(since: next).count == 1, "Dismissing the popover wrote")
        // A timeline marker has no popover.
        graph.axis = .narrative
        try harness.settled()
        graph.createMarker(order: 1, label: "开战前夜")
        try harness.settled()
        guard let marker = canvas.markerViews.values.first else { throw LabError.message("No marker pin") }
        try harness.click(marker)
        try require(controller.cardPopover == nil, "A marker click showed a popover")
        try harness.close()
    }

    // MARK: (b) 设定总览 popovers

    private static func canvasOverviewPopovers() throws {
        let harness = try CanvasHarness(chapters: ["雨夜", "北塔"])
        defer { harness.remove() }
        let rain = try harness.chapter("雨夜")
        let letter = try harness.drift("旧信")
        let people = try harness.category("人物")
        var zhou = try harness.element("老周", in: people, group: "主角")
        let facts = (1...8).map { WorkspaceFact(key: "字段\($0)", value: "值\($0)") }
        zhou = try harness.update(zhou, summary: "旧港的守灯人", facts: facts)
        let _: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, element: zhou, completion: $0) }
        try harness.openOverview(showsDrifts: true)
        guard let model = harness.overview, let controller = harness.overviewController else { throw LabError.message("No overview") }
        let zhouCard = RelationEndpoint(kind: "element", id: zhou.id)

        // An element card: name, category and group, summary and six facts.
        let mark = try harness.journal.mark()
        try harness.click(card: zhouCard)
        var popover = try harness.loaded(controller.cardPopover)
        let lines = popover.factsLabel.stringValue.components(separatedBy: "\n")
        try require(popover.titleLabel.stringValue == "老周" && popover.detailLabel.stringValue == "设定 · 人物 · 主角"
                    && popover.summaryView.string == "旧港的守灯人" && lines.count == 7 && lines.first == "字段1：值1"
                    && lines.last == "另有 2 项，在设定页查看" && !popover.factsLabel.isHidden,
                    "The element popover differs: \(popover.detailLabel.stringValue) / \(lines)")
        try require(harness.opened.isEmpty, "A click on the card opened its page")
        harness.type("旧港的守灯人", in: popover)
        try harness.settled()
        try require(popover.writes == 0, "An unchanged summary was sent")
        // An edited summary: one original; the page and the card follow.
        harness.type("旧港的守灯人，也是信使。", in: popover)
        try wait { popover.storedSummary == "旧港的守灯人，也是信使。" }
        try harness.settled()
        try harness.journal.expect([["field.set element"]], since: mark, "The element summary")
        try wait { harness.host.activeElementPage?.summaryView.string == "旧港的守灯人，也是信使。" }
        try require(model.scene.card(zhouCard)?.detail == "旧港的守灯人，也是信使。", "The card does not show the new summary")
        // A summary changed elsewhere, with spaces around it, reaches the
        // clean popover; closing it untouched writes nothing.
        var next = try harness.journal.mark()
        let spaced = " 旧港的守灯人。 "
        let changed: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            harness.host.setElementSummary(projectID: harness.project.id, elementID: zhou.id, summary: spaced, completion: $0)
        }
        try require(changed.result?.summary == spaced, "The summary was not changed elsewhere: \(changed.result?.summary.debugDescription ?? "")")
        try wait { popover.summaryView.string == spaced && popover.storedSummary == spaced }
        harness.type(spaced, in: popover, then: #selector(NSResponder.cancelOperation(_:)))
        try require(controller.cardPopover == nil && popover.writes == 1, "Closing untouched sent the summary again")
        try harness.settled()
        try harness.journal.expect([["field.set element"]], since: next, "Elsewhere, then an untouched close")
        // The closed popover lets go of its NSPopover (which held it as its
        // content), so neither keeps the other alive; the reopened one writes
        // a change of spacing as typed, as the element page writes it.
        let closed = popover
        try require(closed.popover.contentViewController == nil, "The closed popover is still held by its NSPopover")
        try harness.click(card: zhouCard)
        popover = try harness.loaded(controller.cardPopover)
        try require(popover !== closed && popover.popover.contentViewController === popover, "The card did not open a new popover")
        harness.type("旧港的守灯人。", in: popover)
        try wait { popover.storedSummary == "旧港的守灯人。" && model.element(id: zhou.id)?.summary == "旧港的守灯人。" }
        // Esc closes it, saving a changed summary.
        harness.type("旧港的守灯人，常去北塔。", in: popover, then: #selector(NSResponder.cancelOperation(_:)))
        try require(controller.cardPopover == nil, "Esc did not close the popover")
        try wait { model.element(id: zhou.id)?.summary == "旧港的守灯人，常去北塔。" }
        try harness.settled()
        try harness.journal.expect([["field.set element"], ["field.set element"], ["field.set element"]], since: next,
                                   "Elsewhere, spacing, then Esc")

        // A chapter pill: its status; 打开 saves a changed summary and opens.
        next = try harness.journal.mark()
        try harness.click(card: RelationEndpoint(kind: "node", id: rain.id))
        popover = try harness.loaded(controller.cardPopover)
        try require(popover.titleLabel.stringValue == "雨夜" && popover.detailLabel.stringValue == "章节 · § 01 · 草稿"
                    && popover.summaryView.string.isEmpty && popover.factsLabel.isHidden, "The pill popover differs")
        harness.type("雨夜启程。", in: popover, then: nil)
        popover.openButton.performClick(nil)
        try wait { harness.opened == ["chapter:\(rain.id)"] }
        try wait { model.nodes[rain.id]?.summary == "雨夜启程。" && harness.host.activeChapterPage?.metadataEditor.summaryText == "雨夜启程。" }
        try harness.settled()
        try require(controller.cardPopover == nil, "打开 did not close the popover")
        try harness.journal.expect([["field.set node"]], since: next, "打开 with a changed chapter summary")
        // A drift card: 漂流 · 漂浮中; 打开 opens the drift.
        try harness.click(card: RelationEndpoint(kind: "node", id: letter.id))
        popover = try harness.loaded(controller.cardPopover)
        try require(popover.detailLabel.stringValue == "漂流 · 漂浮中", "The drift popover reads \(popover.detailLabel.stringValue)")
        popover.openButton.performClick(nil)
        try require(harness.opened.last == "drift:\(letter.id)", "打开 did not open the drift")
        // Scrolling closes it.
        try harness.click(card: zhouCard)
        try require(controller.cardPopover?.isShown == true, "The popover did not open again")
        if let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: 10, wheel2: 0, wheel3: 0),
           let event = NSEvent(cgEvent: cg) { harness.overviewCanvas.scrollWheel(with: event) }
        try require(controller.cardPopover == nil, "Scrolling did not close the popover")
        try harness.settled()
        try harness.journal.expect([["field.set node"]], since: next, "The drift popover and scrolling")
        try harness.close()
    }

    // MARK: (c) 关系类型 filters and colours

    private static func canvasRelationFilters() throws {
        let harness = try CanvasHarness(chapters: ["雨夜", "北塔", "钟声"])
        defer { harness.remove() }
        let rain = try harness.chapter("雨夜"), north = try harness.chapter("北塔"), bell = try harness.chapter("钟声")
        let letter = try harness.drift("旧信")
        let people = try harness.category("人物")
        let zhou = try harness.element("老周", in: people), lan = try harness.element("阿岚", in: people)
        // Created in this order; Rust lists them by name.
        let echo = try harness.relationType("呼应", from: ["node"], to: ["node"])
        let allies = try harness.relationType("同盟", symmetric: true, from: ["element"], to: ["element"])
        let mention = try harness.relationType("提及", from: ["node"], to: ["element"])
        let hint = try harness.relationType("伏笔", from: ["node"], to: ["node"])
        func node(_ id: String) -> RelationEndpoint { RelationEndpoint(kind: "node", id: id) }
        func element(_ id: String) -> RelationEndpoint { RelationEndpoint(kind: "element", id: id) }
        try harness.relate(node(rain.id), node(north.id), echo)
        try harness.relate(node(letter.id), node(rain.id), echo)
        try harness.relate(node(north.id), node(bell.id), hint)
        let alliance = try harness.relate(element(zhou.id), element(lan.id), allies)
        try harness.relate(node(rain.id), element(zhou.id), mention)
        let mark = try harness.journal.mark()

        // 故事图谱: edges in their type's colour, arrows for directed types.
        try harness.openGraph()
        guard let graph = harness.graph, let graphController = harness.graphController else { throw LabError.message("No graph") }
        let edges = harness.graphCanvas.edgeView
        let order = [echo.id, allies.id, mention.id, hint.id]
        try require(graphController.relationFilter.entries.map(\.typeID) == order && graphController.relationFilter.entries.map(\.name) == ["呼应", "同盟", "提及", "伏笔"]
                    && graphController.relationFilter.entries.map(\.count) == [2, 0, 0, 1],
                    "The graph lists \(graphController.relationFilter.entries.map { "\($0.name) \($0.count)" })")
        try require(Set(edges.edges.map(\.typeID)) == [echo.id, hint.id] && edges.edges.count == 3
                    && edges.edges.allSatisfy { $0.curve.arrowBarbs != nil } && Set(edges.edges.compactMap(\.slot)) == [0, 3],
                    "The graph draws \(edges.edges.map { ($0.typeID, $0.slot) })")
        func resolved(_ slot: Int, in view: NSView) -> CGColor {
            var color = NSColor.clear.cgColor
            view.effectiveAppearance.performAsCurrentDrawingAppearance { color = RelationTypeColors.palette[slot].cgColor }
            return color
        }
        try require(edges.strokes[0] == resolved(0, in: edges) && edges.strokes[3] == resolved(3, in: edges) && edges.strokes.count == 2,
                    "The graph's edge colours differ")
        try require(graphController.relationFilter.item(typeID: echo.id)?.image != nil
                    && graphController.relationFilter.item(typeID: echo.id)?.state == .on, "The filter lacks a swatch or checkmark")
        // Unchecking 呼应 hides its two edges; checking it shows them again.
        graphController.relationFilter.item(typeID: echo.id)?.press()
        try harness.settled()
        try require(graph.hiddenRelationTypes == [echo.id] && edges.edges.map(\.typeID) == [hint.id]
                    && graphController.relationFilter.item(typeID: echo.id)?.state == .off
                    && graphController.relationFilter.itemArray.first?.title == "关系类型 · 隐藏 1",
                    "Unchecking 呼应 left \(edges.edges.map(\.typeID))")
        try require(harness.settings.hiddenRelationTypes(projectID: harness.project.id, canvas: .storyGraph) == [echo.id],
                    "The graph's choice was not saved")
        graphController.relationFilter.item(typeID: echo.id)?.press()
        try require(edges.edges.count == 3 && graph.hiddenRelationTypes.isEmpty, "Checking 呼应 did not show its edges")
        graphController.relationFilter.item(typeID: echo.id)?.press()
        graphController.relationFilter.item(typeID: hint.id)?.press()
        try require(edges.edges.isEmpty, "Hiding both types left edges")
        guard let showAll = graphController.relationFilter.itemArray.first(where: { $0.accessibilityIdentifier() == "relation-filter-show-all" })
                as? LibraryMenuItem else { throw LabError.message("No 全部显示") }
        showAll.press()
        try require(edges.edges.count == 3 && harness.settings.hiddenRelationTypes(projectID: harness.project.id, canvas: .storyGraph).isEmpty,
                    "全部显示 did not show every type")
        // Keep 伏笔 hidden on the graph.
        graphController.relationFilter.item(typeID: hint.id)?.press()
        try require(edges.edges.map(\.typeID).allSatisfy { $0 == echo.id } && edges.edges.count == 2, "伏笔 is still drawn")

        // 设定总览: the same colours by type; its own choice.
        try harness.openOverview()
        guard let overview = harness.overview, let overviewController = harness.overviewController else { throw LabError.message("No overview") }
        let canvas = harness.overviewCanvas
        try require(overviewController.relationFilter.entries.map(\.typeID) == order
                    && overviewController.relationFilter.entries.map(\.count) == [0, 1, 1, 0] && overview.hiddenRelationTypes.isEmpty,
                    "The overview lists \(overviewController.relationFilter.entries.map { "\($0.name) \($0.count)" })")
        try require(Set(overview.scene.edges.map(\.relation.relationTypeId)) == [allies.id, mention.id]
                    && overview.scene.edges.first { $0.relation.relationTypeId == allies.id }?.slot == 1
                    && overview.scene.edges.first { $0.relation.relationTypeId == mention.id }?.slot == 2
                    && canvas.edgeStrokes[1] == resolved(1, in: canvas) && canvas.edgeStrokes[2] == resolved(2, in: canvas),
                    "The overview's edges or colours differ")
        // Unchecking 同盟 deselects and hides its edge.
        canvas.select(edge: alliance.id)
        guard let allianceEdge = overview.scene.edge(alliance.id) else { throw LabError.message("No 同盟 edge") }
        let middle = allianceEdge.midpoint
        overviewController.relationFilter.item(typeID: allies.id)?.press()
        try harness.settled()
        try require(canvas.selectedEdge == nil && overviewController.edgeBar.isHidden && overview.scene.edge(alliance.id) == nil
                    && overview.scene.hit(middle, tolerance: 6) != .edge(alliance.id) && overview.scene.edges.count == 1
                    && overviewController.metaLabel.stringValue.hasSuffix("1 条关系"), "Hiding 同盟 left its edge: \(overviewController.metaLabel.stringValue)")
        overviewController.relationFilter.item(typeID: allies.id)?.press()
        try require(overview.scene.edge(alliance.id) != nil, "Checking 同盟 did not show its edge")
        // Keep 提及 hidden on the overview.
        overviewController.relationFilter.item(typeID: mention.id)?.press()
        try require(overview.scene.edges.map(\.relation.relationTypeId) == [allies.id], "提及 is still drawn")
        try harness.journal.expect([], since: mark, "Opening and filtering both canvases")
        let stored = (try harness.settingsJSON())["relationFilters"] as? [String: [String: [String]]]
        try require(stored?[harness.project.id] == ["storyGraph": [hint.id], "elementOverview": [mention.id]],
                    "settings.json holds \(String(describing: stored))")

        // A rename keeps the order and the colours.
        let projectID = harness.project.id
        let renamed = RelationTypeDefinition(name: "照应", orientation: "directed", sourceRole: "源", targetRole: "目标",
                                             sourceKinds: ["node"], targetKinds: ["node"])
        let _: WorkspaceRelationReply<WorkspaceRelationType> = try elementResult {
            harness.workspace.updateRelationType(projectID: projectID, relationTypeID: echo.id, definition: renamed, completion: $0)
        }
        harness.host.relations.reload(projectID: projectID)
        try wait { graphController.relationFilter.entries.first?.name == "照应" }
        try require(graphController.relationFilter.entries.map(\.typeID) == order && Set(edges.edges.compactMap(\.slot)) == [0],
                    "A rename moved the type's colour")

        // Cold relaunch: each canvas keeps its choice.
        try harness.coldRelaunch()
        try harness.openGraph()
        try harness.openOverview()
        guard let coldGraph = harness.graph, let coldOverview = harness.overview else { throw LabError.message("No canvases after relaunch") }
        try require(coldGraph.hiddenRelationTypes == [hint.id] && harness.graphCanvas.edgeView.edges.count == 2
                    && harness.graphCanvas.edgeView.edges.allSatisfy { $0.typeID == echo.id && $0.slot == 0 }
                    && harness.graphController?.relationFilter.item(typeID: hint.id)?.state == .off,
                    "The graph's choice did not survive a cold relaunch")
        try require(coldOverview.hiddenRelationTypes == [mention.id] && coldOverview.scene.edges.map(\.relation.relationTypeId) == [allies.id]
                    && coldOverview.scene.edges.first?.slot == 1, "The overview's choice did not survive a cold relaunch")
        try harness.close()
    }
}
