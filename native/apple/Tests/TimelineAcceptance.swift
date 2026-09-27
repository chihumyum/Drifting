import AppKit

/// The authored journal of a lab workspace, for acceptance: one list of
/// “action kind” per original committed after a mark.
struct JournalProbe {
    let directory: URL

    func mark() throws -> Int64 {
        guard case .integer(let value)? = try WorkspaceRemoteProseFixture.query(in: directory,
            sql: "SELECT COALESCE(MAX(rowid), 0) AS n FROM sync_change_set").first?["n"] else {
            throw LabError.message("Journal mark query returned no row")
        }
        return value
    }

    func originals(since: Int64) throws -> [[String]] {
        try WorkspaceRemoteProseFixture.query(in: directory,
            sql: "SELECT change_set_id FROM sync_change_set WHERE rowid > \(since) ORDER BY rowid").map { row in
            guard case .text(let id)? = row["change_set_id"] else { throw LabError.message("Journal row has no identity") }
            return try WorkspaceRemoteProseFixture.query(in: directory,
                sql: "SELECT action || ' ' || target_kind AS m FROM sync_mutation WHERE change_set_id = ? ORDER BY mutation_index",
                parameters: [.text(id)]).map { mutation in
                guard case .text(let value)? = mutation["m"] else { throw LabError.message("Journal mutation is unreadable") }
                return value
            }
        }
    }

    func expect(_ expected: [[String]], since: Int64, _ step: String) throws {
        let written = try originals(since: since)
        try BindingAcceptance.require(written == expected, "\(step) wrote \(written) instead of \(expected)")
    }

    func count(_ table: String) throws -> Int64 {
        guard case .integer(let value)? = try WorkspaceRemoteProseFixture.query(in: directory,
            sql: "SELECT COUNT(*) AS n FROM \(table)").first?["n"] else {
            throw LabError.message("Count query returned no row")
        }
        return value
    }
}

/// The 故事图谱 panel through the real AppKit controller, canvas and card
/// views, the Rust workspace and SQLite, wired as AppDelegate wires it.
/// Drags are synthesized mouse events sent to the card views; every title
/// and label is synthetic.
extension BindingAcceptance {
    private final class GraphHarness {
        let directory: URL
        private(set) var workspace: LabWorkspaceCore
        let project: WorkspaceProject
        private(set) var chapters: [WorkspaceChapter] = []
        private(set) var window: NSWindow
        private(set) var host: MacChapterWorkspace
        private(set) var model: StoryGraphModel!
        private(set) var controller: MacStoryGraphViewController!
        private(set) var graphWindow: NSWindow!
        let journal: JournalProbe
        /// Answers the panel's alerts; nil cancels.
        var answer: ((NSAlert) -> NSApplication.ModalResponse)?
        var opened: [String] = []
        var chapterLists: [[String]] = []

        init(titles: [String] = ["序章", "雨夜", "北塔", "钟声", "归途", "尾声"]) throws {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                .appendingPathComponent("apple-native-lab")
            self.directory = directory
            journal = JournalProbe(directory: directory)
            let workspace = LabWorkspaceCore(directory: directory)
            self.workspace = workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(listed.isEmpty, "Graph fixture was not isolated")
            project = try BindingAcceptance.elementResult { workspace.createProject(name: "图谱合成项目", completion: $0) }
            let projectID = project.id
            for title in titles {
                chapters.append(try BindingAcceptance.elementResult { workspace.createChapter(projectID: projectID, title: title, completion: $0) })
            }
            (window, host) = BindingAcceptance.elementHost(workspace)
        }

        func chapter(_ title: String) throws -> WorkspaceChapter {
            guard let chapter = chapters.first(where: { $0.title == title }) else { throw LabError.message("No chapter \(title)") }
            return chapter
        }

        func storyline(_ name: String) throws -> WorkspaceStoryline {
            let projectID = project.id
            let reply: WorkspaceStorylineReply<WorkspaceStoryline> = try BindingAcceptance.elementResult {
                workspace.createStoryline(projectID: projectID, name: name, completion: $0)
            }
            guard let storyline = reply.result else { throw LabError.message("No storyline \(name)") }
            return storyline
        }

        func member(_ title: String, _ ids: [String], primary: String?) throws {
            let projectID = project.id, chapterID = try chapter(title).id
            let _: WorkspaceStorylineReply<WorkspaceChapterStorylines> = try BindingAcceptance.elementResult {
                workspace.setChapterStorylines(projectID: projectID, chapterID: chapterID, storylineIDs: ids, primary: primary, completion: $0)
            }
        }

        func drift(_ title: String) throws -> WorkspaceDrift {
            let projectID = project.id
            let reply: WorkspaceDriftReply<WorkspaceDrift> = try BindingAcceptance.elementResult {
                workspace.createDrift(projectID: projectID, title: title, groupID: nil, completion: $0)
            }
            guard let drift = reply.result else { throw LabError.message("No drift \(title)") }
            return drift
        }

        func order(_ title: String, _ order: Double?) throws {
            let projectID = project.id, chapterID = try chapter(title).id
            let _: WorkspaceTimelineReply<WorkspaceTimelineNode> = try BindingAcceptance.elementResult {
                workspace.setNarrativeOrder(projectID: projectID, chapterID: chapterID, order: order, completion: $0)
            }
        }

        /// 主线 and 暗线: 序章, 雨夜 and 归途 in 主线; 北塔 in 暗线; 钟声 in both
        /// with 暗线 as its primary; 尾声 in none.
        func standardLanes() throws -> (main: WorkspaceStoryline, hidden: WorkspaceStoryline) {
            let main = try storyline("主线"), hidden = try storyline("暗线")
            try member("北塔", [hidden.id], primary: hidden.id)
            try member("钟声", [main.id, hidden.id], primary: hidden.id)
            try member("尾声", [], primary: nil)
            return (main, hidden)
        }

        /// A new model and panel, as AppDelegate.showStoryGraph builds them.
        func openGraph(counts: WordCountLibrary? = nil) throws {
            graphWindow?.close()
            let model = StoryGraphModel(workspace: workspace, projectID: project.id)
            if let counts { model.applyWordCounts(counts) }
            let host = self.host, projectID = project.id
            model.onChapters = { [weak self] chapters in
                self?.chapterLists.append(chapters.map(\.id))
                host.applyChapters(projectID: projectID, chapters: chapters, trashed: nil)
            }
            model.onStorylineLibrary = { library in host.applyStorylineLibrary(projectID: projectID, library: library) }
            let controller = MacStoryGraphViewController(model: model)
            controller.presentAlert = { [weak self] alert, done in
                alert.layout()
                done(self?.answer?(alert) ?? .alertSecondButtonReturn)
            }
            controller.onOpenChapter = { [weak self] chapter in self?.opened.append(chapter.id) }
            controller.onOpenDrift = { [weak self] drift in self?.opened.append(drift.id) }
            let graphWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 820),
                                       styleMask: [.titled, .resizable], backing: .buffered, defer: false)
            graphWindow.isReleasedWhenClosed = false
            graphWindow.contentViewController = controller
            graphWindow.setContentSize(NSSize(width: 1200, height: 820))
            controller.view.layoutSubtreeIfNeeded()
            self.model = model; self.controller = controller; self.graphWindow = graphWindow
            model.load()
            try settled()
        }

        func settled(file: String = #fileID, line: Int = #line) throws {
            try BindingAcceptance.wait(file: file, line: line) { self.model.loaded && !self.model.busy }
            controller.view.layoutSubtreeIfNeeded()
        }

        var canvas: StoryGraphCanvas { controller.canvas }

        func setAxis(_ axis: StoryGraphModel.Axis) {
            controller.axisControl.selectedSegment = axis == .book ? 0 : 1
            _ = controller.axisControl.sendAction(controller.axisControl.action, to: controller.axisControl.target)
        }

        func card(_ title: String) throws -> StoryGraphCardView {
            let id = try chapter(title).id
            guard let card = canvas.cardViews[id] else { throw LabError.message("No card for \(title)") }
            return card
        }

        func laneBand(_ id: String) throws -> NSView {
            guard let band = canvas.laneBands.first(where: { $0.accessibilityIdentifier() == "graph-lane-\(id)" }) else {
                throw LabError.message("No lane band \(id)")
            }
            return band
        }

        /// The centre of lane `index`.
        func laneY(_ index: Int) -> CGFloat {
            canvas.lanesTop + CGFloat(index) * StoryGraphMetrics.laneHeight + StoryGraphMetrics.laneHeight / 2
        }

        func event(_ type: NSEvent.EventType, _ point: NSPoint, clicks: Int = 1) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: canvas.convert(point, to: nil), modifierFlags: [],
                               timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: graphWindow.windowNumber,
                               context: nil, eventNumber: 0, clickCount: clicks, pressure: type == .leftMouseUp ? 0 : 1)!
        }

        /// Presses on a view's centre, drags in `steps` moves so the pressed
        /// point lands on `target` (canvas coordinates) and releases there.
        /// `during` runs before the release.
        func drag(_ view: NSView, to target: NSPoint, steps: Int = 4, during: (() throws -> Void)? = nil) throws {
            let start = NSPoint(x: view.frame.midX, y: view.frame.midY)
            view.mouseDown(with: event(.leftMouseDown, start))
            for step in 1...steps {
                let t = CGFloat(step) / CGFloat(steps)
                view.mouseDragged(with: event(.leftMouseDragged, NSPoint(x: start.x + (target.x - start.x) * t,
                                                                          y: start.y + (target.y - start.y) * t)))
            }
            try during?()
            view.mouseUp(with: event(.leftMouseUp, target))
            try settled()
        }

        func doubleClick(_ view: NSView) {
            let point = NSPoint(x: view.frame.midX, y: view.frame.midY)
            view.mouseDown(with: event(.leftMouseDown, point, clicks: 2))
            view.mouseUp(with: event(.leftMouseUp, point, clicks: 2))
        }

        /// Presses a menu item by identifier, searching submenus.
        func press(_ identifier: String, in target: StoryGraphCanvas.Target) throws {
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

        func expect(journal expected: [[String]], since: Int64, _ step: String) throws {
            try journal.expect(expected, since: since, step)
        }

        func timeline() throws -> WorkspaceTimeline {
            let projectID = project.id
            return try BindingAcceptance.elementResult { workspace.timeline(projectID: projectID, completion: $0) }
        }

        func memberships() throws -> WorkspaceStorylineLibrary {
            let projectID = project.id
            return try BindingAcceptance.elementResult { workspace.storylineLibrary(projectID: projectID, completion: $0) }
        }

        func storedOrder(_ title: String) throws -> Double? {
            try timeline().node(id: try chapter(title).id)?.narrativeOrder
        }

        /// Closes every owner and the workspace, then opens the directory
        /// again with a new core and tab host.
        func coldReopen() throws {
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "Graph workspace failed to close")
            window.close(); graphWindow?.close()
            let reopened = LabWorkspaceCore(directory: directory)
            workspace = reopened
            let projects: [WorkspaceProject] = try BindingAcceptance.elementResult { reopened.projects(completion: $0) }
            try BindingAcceptance.require(projects.map(\.id) == [project.id], "Cold reopen lost the project")
            (window, host) = BindingAcceptance.elementHost(reopened)
            model = nil; controller = nil; graphWindow = nil
        }

        func close() throws {
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "Graph workspace failed to close")
            window.close(); graphWindow?.close()
        }

        func remove() { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
    }

    static func timelineAcceptance() throws -> [String] {
        try graphLanes()
        try graphBookDrag()
        try graphLaneDrag()
        try graphNarrativeDrag()
        try graphMarkers()
        try graphDriftCards()
        try graphColdReopen()
        try graphLargeBook()
        return [
            "AppKit 故事图谱 shows one lane per storyline in authored order and 未归属 for chapters without a primary, each chapter card in its primary's lane at its book position with its § number, status and word count, and card menus open a chapter and set its status with one field.set",
            "AppKit 故事图谱 book-order drag of a card sends nothing until the drop, then reorders chapters through the chapter move with one original that the chapter list and memberships follow, and a drop back in its slot writes nothing",
            "AppKit 故事图谱 drag across lanes and 移到轨道 make the target storyline primary, drop the previous primary's membership, keep other memberships and clear them all in 未归属, matching the storyline library and the tab host",
            "AppKit 故事图谱 故事时间 places chapters from the 未放置 tray at orders from their neighbours, reorders them by drag, changes lane and order in one drop, and 移出故事时间 or a drop on the tray sets null, one field.set per change and none for a drop in place",
            "AppKit 故事图谱 markers are created from 添加标记… and the marker row, renamed, bound to a drift that captions a label-less marker, dragged to a new narrative order, unbound keeping the caption and deleted after confirmation, numeric labels convert story time and an unnamed unbound marker is refused without writing",
            "AppKit 故事图谱 drift cards flow until placed, a drag stores the position inside the area as one tuple.set, a click-sized drag writes nothing and double-click or 打开 opens the drift",
            "AppKit 故事图谱 narrative orders, lanes, book order, markers with their bindings and drift positions survive a cold reopen into a new graph",
            "AppKit 故事图谱 lays out 200 chapters as layer-backed cards and a drag across them sends no Rust call and no render until the drop, which moves the chapter once",
        ]
    }

    // MARK: (a) Lanes

    private static func graphLanes() throws {
        let harness = try GraphHarness()
        defer { harness.remove() }
        let lanes = try harness.standardLanes()
        let projectID = harness.project.id
        // 序章 gets a body so it has a real count; 雨夜 is finished, 归途 discarded.
        let opening = try harness.chapter("序章")
        let view: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, chapter: opening, completion: $0) }
        try elementSettled(harness.host, view)
        view.textView.insertText("钟声在雨夜里响起。", replacementRange: NSRange(location: 0, length: 0))
        try elementSettled(harness.host, view)
        let _: Bool = try elementResult { harness.host.closeTab(pane: 0, scope: ChapterScope(projectID: projectID, chapterID: opening.id), completion: $0) }
        let workspace = harness.workspace
        for (title, status) in [("雨夜", "finished"), ("归途", "discarded")] {
            let id = try harness.chapter(title).id
            let _: WorkspaceNodeMetadata = try elementResult { workspace.setNodeStatus(projectID: projectID, nodeID: id, status: status, completion: $0) }
        }
        let counts: WorkspaceWordCounts = try elementResult { workspace.reconcileWordCounts(projectID: projectID, completion: $0) }
        let library = WordCountLibrary(counts.counts)
        guard let words = library.count(nodeID: opening.id), words > 0 else { throw LabError.message("序章 was not counted") }
        try harness.openGraph(counts: library)
        let model = harness.model!, canvas = harness.canvas

        try require(model.lanes.map(\.name) == ["主线", "暗线", "未归属"], "Lanes differ: \(model.lanes.map(\.name))")
        let ids = { (titles: [String]) in try titles.map { try harness.chapter($0).id } }
        try require(model.lanes.map(\.chapterIDs) == [try ids(["序章", "雨夜", "归途"]), try ids(["北塔", "钟声"]), try ids(["尾声"])],
            "Lane chapters differ: \(model.lanes.map(\.chapterIDs))")
        try require(canvas.rail.laneTitles == ["主线", "暗线", "未归属"], "The rail does not name the lanes")
        try require(canvas.cardViews.count == 6 && canvas.cardViews.values.allSatisfy { $0.wantsLayer && $0.layer != nil },
            "Cards are not one layer-backed view per chapter")
        for (laneID, titles) in [(lanes.main.id, ["序章", "雨夜", "归途"]), (lanes.hidden.id, ["北塔", "钟声"]), ("unaffiliated", ["尾声"])] {
            let band = try harness.laneBand(laneID)
            for title in titles {
                let card = try harness.card(title)
                let index = model.bookIndex(of: try harness.chapter(title).id) ?? -1
                try require(band.frame.contains(NSPoint(x: band.frame.minX + 1, y: card.frame.midY)),
                    "\(title) is not in its lane \(laneID): \(card.frame) vs \(band.frame)")
                try require(abs(card.frame.midX - StoryGraphMetrics.slotCenter(index)) < 0.5, "\(title) is not at its book position")
            }
        }
        try require(try harness.card("序章").metaLabel.stringValue == "§ 01 · \(WordCountText.compact(words))",
            "序章's meta differs: \(try harness.card("序章").metaLabel.stringValue)")
        try require(try harness.card("雨夜").metaLabel.stringValue.hasPrefix("§ 02 · 已完成"), "雨夜 does not show 已完成")
        try require(try harness.card("归途").alphaValue < 1 && (try harness.card("北塔").alphaValue) == 1, "A discarded chapter is not dimmed")
        try require(harness.controller.addMarkerButton.isEnabled == false, "添加标记… is enabled on the book axis")

        // Card menus: 打开 and double-click open; a status writes one field.set.
        let north = try harness.chapter("北塔")
        try harness.press("graph-card-open", in: .chapter(north.id))
        harness.doubleClick(try harness.card("钟声"))
        try require(harness.opened == [north.id, try harness.chapter("钟声").id], "Opening from cards differs: \(harness.opened)")
        let mark = try harness.journal.mark()
        try harness.press("graph-card-status-finished", in: .chapter(north.id))
        try wait { model.chapter(id: north.id)?.writingStatus == "finished" }
        try require(try harness.card("北塔").metaLabel.stringValue.contains("已完成"), "The card did not follow its status")
        try harness.expect(journal: [["field.set node"]], since: mark, "The status")
        try harness.close()
    }

    // MARK: (b) Book order

    private static func graphBookDrag() throws {
        let harness = try GraphHarness()
        defer { harness.remove() }
        _ = try harness.standardLanes()
        try harness.openGraph()
        let model = harness.model!, canvas = harness.canvas
        let homeward = try harness.card("归途")
        let requests = model.requests, renders = canvas.renders
        var mark = try harness.journal.mark()
        // Before 雨夜, in the same lane.
        try harness.drag(homeward, to: NSPoint(x: StoryGraphMetrics.slotCenter(1) - 30, y: homeward.frame.midY)) {
            try require(model.requests == requests && canvas.renders == renders, "A drag sent a Rust call or rendered")
            try require(!canvas.dropIndicator.isHidden, "The drop indicator is hidden during a drag")
        }
        let expected = try ["序章", "归途", "雨夜", "北塔", "钟声", "尾声"].map { try harness.chapter($0).id }
        try require(model.chapters.map(\.id) == expected, "Book order differs: \(model.chapters.map(\.title))")
        try require(harness.chapterLists.last == expected, "The chapter list did not follow")
        let stored: [WorkspaceChapter] = try elementResult { harness.workspace.chapters(projectID: harness.project.id, completion: $0) }
        try require(stored.map(\.id) == expected, "Stored book order differs")
        try require(try harness.memberships().memberships.map(\.chapterId) == expected, "Memberships do not follow book order")
        try require(abs(homeward.frame.midX - StoryGraphMetrics.slotCenter(1)) < 0.5, "The card was not laid out at its new slot")
        try require(canvas.dropIndicator.isHidden, "The drop indicator stayed")
        try harness.expect(journal: [["field.set node"]], since: mark, "The book move")
        // A quiet refresh (the panel becoming key) never blocks a drag.
        model.refresh()
        try require(!model.busy, "A refresh blocked drags")
        // Dropped back inside its own slot: nothing is written.
        mark = try harness.journal.mark()
        let before = model.requests
        try harness.drag(homeward, to: NSPoint(x: homeward.frame.midX + 30, y: homeward.frame.midY))
        try require(model.requests == before && abs(homeward.frame.midX - StoryGraphMetrics.slotCenter(1)) < 0.5,
            "A drop in place sent a command or left the card")
        try harness.expect(journal: [], since: mark, "The drop in place")
        try harness.close()
    }

    // MARK: (c) Lanes by drag

    private static func graphLaneDrag() throws {
        let harness = try GraphHarness()
        defer { harness.remove() }
        let lanes = try harness.standardLanes()
        try harness.openGraph()
        let model = harness.model!
        // 钟声 (暗线 primary, both memberships) into 主线: 暗线 is dropped.
        var mark = try harness.journal.mark()
        let bell = try harness.card("钟声")
        try harness.drag(bell, to: NSPoint(x: bell.frame.midX, y: harness.laneY(0)))
        let bellID = try harness.chapter("钟声").id
        var stored = try harness.memberships()
        try require(stored.membership(chapterID: bellID) == WorkspaceChapterStorylines(chapterId: bellID, storylineIds: [lanes.main.id], primary: lanes.main.id),
            "钟声's membership differs: \(String(describing: stored.membership(chapterID: bellID)))")
        try harness.expect(journal: [["set.remove membership", "field.set node-storyline-primary"]], since: mark, "The lane change")
        // 雨夜 (主线 only) into 暗线; its book place is unchanged.
        let rainID = try harness.chapter("雨夜").id
        let rain = try harness.card("雨夜")
        try harness.drag(rain, to: NSPoint(x: rain.frame.midX, y: harness.laneY(1)))
        stored = try harness.memberships()
        try require(stored.membership(chapterID: rainID)?.storylineIds == [lanes.hidden.id] && stored.primary(chapterID: rainID)?.id == lanes.hidden.id,
            "雨夜 did not move to 暗线")
        // 序章 into 未归属 clears its memberships.
        mark = try harness.journal.mark()
        let openingID = try harness.chapter("序章").id
        let opening = try harness.card("序章")
        try harness.drag(opening, to: NSPoint(x: opening.frame.midX, y: harness.laneY(2)))
        stored = try harness.memberships()
        try require(stored.membership(chapterID: openingID)?.storylineIds == [] && stored.primary(chapterID: openingID) == nil,
            "序章 was not cleared into 未归属")
        try require(try harness.journal.originals(since: mark).count == 1, "Clearing wrote more than one original")
        let expectedLanes = try [["钟声", "归途"], ["雨夜", "北塔"], ["序章", "尾声"]].map { try $0.map { try harness.chapter($0).id } }
        try require(model.lanes.map(\.chapterIDs) == expectedLanes, "Lanes after the drags differ: \(model.lanes.map(\.chapterIDs))")
        try require(model.chapters.map(\.id) == harness.chapters.map(\.id), "A lane drag changed the book order")
        try require(harness.host.storylineLibrary(projectID: harness.project.id) == stored, "The tab host did not receive the library")
        // 移到轨道 from the menu: 序章 into 暗线.
        try harness.press("graph-card-lane-\(lanes.hidden.id)", in: .chapter(openingID))
        try require(try harness.memberships().membership(chapterID: openingID)?.storylineIds == [lanes.hidden.id], "移到轨道 did not move 序章")
        // A drop in its own lane and slot writes nothing.
        mark = try harness.journal.mark()
        let north = try harness.card("北塔")
        try harness.drag(north, to: NSPoint(x: north.frame.midX + 12, y: north.frame.midY + 10))
        try harness.expect(journal: [], since: mark, "A drop in its own lane")
        try harness.close()
    }

    // MARK: (d) Story time

    private static func graphNarrativeDrag() throws {
        let harness = try GraphHarness()
        defer { harness.remove() }
        let lanes = try harness.standardLanes()
        try harness.openGraph()
        let model = harness.model!, canvas = harness.canvas
        harness.setAxis(.narrative)
        try require(model.axis == .narrative && harness.controller.addMarkerButton.isEnabled, "故事时间 was not chosen")
        try require(model.lanes.allSatisfy(\.chapterIDs.isEmpty) && model.unplacedChapters.count == 6, "New chapters were placed in story time")
        let north = try harness.card("北塔")
        try require(north.frame.minY >= canvas.trayTop, "未放置 chapters are not in the tray")

        // Into an empty axis, then after it, then between them.
        var mark = try harness.journal.mark()
        try harness.drag(north, to: NSPoint(x: StoryGraphMetrics.slotCenter(0), y: harness.laneY(1)))
        try require(try harness.storedOrder("北塔") == 1, "The first placed chapter is not at 1")
        try harness.drag(try harness.card("序章"), to: NSPoint(x: StoryGraphMetrics.slotCenter(1) + 10, y: harness.laneY(0)))
        try require(try harness.storedOrder("序章") == 2, "A chapter after the last is not one step later")
        try harness.drag(try harness.card("雨夜"), to: NSPoint(x: StoryGraphMetrics.slotCenter(0) + StoryGraphMetrics.slot / 2, y: harness.laneY(0)))
        try require(try harness.storedOrder("雨夜") == 1.5, "A chapter between two is not at their midpoint")
        try harness.expect(journal: [["field.set node"], ["field.set node"], ["field.set node"]], since: mark, "Three placements")
        for (title, rank) in [("北塔", 0), ("雨夜", 1), ("序章", 2)] {
            try require(abs(try harness.card(title).frame.midX - StoryGraphMetrics.slotCenter(rank)) < 0.5, "\(title) is not at story rank \(rank)")
        }
        try require(canvas.rail.laneTitles == ["主线", "暗线", "未归属"], "The rail lost its lanes")
        // Reorder: 北塔 after 序章.
        try harness.drag(try harness.card("北塔"), to: NSPoint(x: StoryGraphMetrics.slotCenter(2) + 60, y: harness.laneY(1)))
        try require(try harness.storedOrder("北塔") == 3, "北塔 was not moved after 序章")
        try require(model.placedChapters.map(\.title) == ["雨夜", "序章", "北塔"], "Story order differs: \(model.placedChapters.map(\.title))")
        // One drop changes lane and order: 钟声 (暗线) into 主线 at the start.
        mark = try harness.journal.mark()
        try harness.drag(try harness.card("钟声"), to: NSPoint(x: StoryGraphMetrics.slotCenter(0) - 60, y: harness.laneY(0)))
        let bellID = try harness.chapter("钟声").id
        try require(try harness.storedOrder("钟声") == 0.5 && model.primary(of: bellID) == lanes.main.id,
            "The combined drop differs: \(String(describing: try harness.storedOrder("钟声"))), \(String(describing: model.primary(of: bellID)))")
        try harness.expect(journal: [["set.remove membership", "field.set node-storyline-primary"], ["field.set node"]],
                           since: mark, "The combined drop")
        // A drop in place writes nothing.
        mark = try harness.journal.mark()
        let rain = try harness.card("雨夜")
        try harness.drag(rain, to: NSPoint(x: rain.frame.midX + 20, y: rain.frame.midY))
        try harness.expect(journal: [], since: mark, "A narrative drop in place")
        // 移出故事时间 and a drop on the tray set null.
        try harness.press("graph-card-unplace", in: .chapter(try harness.chapter("雨夜").id))
        try require(try harness.storedOrder("雨夜") == nil && model.unplacedChapters.map(\.title).contains("雨夜"), "移出故事时间 did not clear the order")
        try harness.drag(try harness.card("序章"), to: NSPoint(x: StoryGraphMetrics.slotCenter(3), y: canvas.trayTop + StoryGraphMetrics.trayHeight / 2))
        try require(try harness.storedOrder("序章") == nil, "A drop on the tray did not clear the order")
        try harness.expect(journal: [["field.set node"], ["field.set node"]], since: mark, "Two removals from story time")
        try require(try harness.card("序章").frame.minY >= canvas.trayTop, "The removed chapter is not in the tray")
        // 放到故事时间末尾 from the tray menu.
        try harness.press("graph-card-place-end", in: .chapter(try harness.chapter("尾声").id))
        try require(try harness.storedOrder("尾声") == 4, "放到故事时间末尾 did not place after 北塔")
        try harness.close()
    }

    // MARK: (e) Markers

    private static func graphMarkers() throws {
        let harness = try GraphHarness()
        defer { harness.remove() }
        _ = try harness.standardLanes()
        for (title, order) in [("序章", 1.0), ("雨夜", 2.0), ("北塔", 3.0)] { try harness.order(title, order) }
        let notes = try harness.drift("钟声札记")
        try harness.openGraph()
        let model = harness.model!, canvas = harness.canvas
        harness.setAxis(.narrative)

        // 添加标记… places a marker after the last chapter.
        var mark = try harness.journal.mark()
        harness.answer = { alert in
            (alert.accessoryView as? NSTextField)?.stringValue = " 1938 春 "
            return .alertFirstButtonReturn
        }
        harness.controller.addMarkerButton.performClick(nil)
        try harness.settled()
        guard let spring = model.markers.first(where: { $0.label == "1938 春" }) else { throw LabError.message("添加标记… created nothing") }
        try require(spring.narrativeOrder == 4 && spring.driftNodeId == nil, "The new marker is not after the last chapter")
        guard let springPin = canvas.markerViews[spring.id] else { throw LabError.message("No pin for the marker") }
        try require(abs(springPin.frame.midX - StoryGraphMetrics.slotCenter(3)) < 0.5 && springPin.captionLabel.stringValue == "1938 春",
            "The pin is not one slot after 北塔: \(springPin.frame)")
        try harness.expect(journal: [["entity.create timeline-marker"]], since: mark, "添加标记…")
        // The marker row's menu adds one between 序章 and 雨夜.
        harness.answer = { alert in
            (alert.accessoryView as? NSTextField)?.stringValue = "开战前夜"
            return .alertFirstButtonReturn
        }
        let between = canvas.markerOrder(x: StoryGraphMetrics.slotCenter(0) + StoryGraphMetrics.slot / 2)
        try require(between == 1.5, "The marker row maps the midpoint to \(between)")
        try harness.press("graph-axis-add-marker", in: .axis(between))
        guard let eve = model.markers.first(where: { $0.label == "开战前夜" }) else { throw LabError.message("The marker row created nothing") }
        try require(eve.narrativeOrder == 1.5 && model.markers.map(\.id) == [eve.id, spring.id], "Markers are not in narrative order")

        // Rename, bind a drift, then clear the label: the drift captions it.
        mark = try harness.journal.mark()
        harness.answer = { alert in
            (alert.accessoryView as? NSTextField)?.stringValue = "战前"
            return .alertFirstButtonReturn
        }
        try harness.press("graph-marker-rename", in: .marker(eve.id))
        try harness.press("graph-marker-bind-\(notes.id)", in: .marker(eve.id))
        try require(model.timeline.marker(id: eve.id)?.label == "战前" && model.timeline.marker(id: eve.id)?.driftNodeId == notes.id,
            "Rename and bind differ")
        try require(canvas.driftViews[notes.id]?.metaLabel.stringValue.contains("已绑定标记") == true, "The drift card does not show its marker")
        harness.answer = { alert in
            (alert.accessoryView as? NSTextField)?.stringValue = ""
            return .alertFirstButtonReturn
        }
        try harness.press("graph-marker-rename", in: .marker(eve.id))
        try require(model.timeline.marker(id: eve.id)?.label == "" && canvas.markerViews[eve.id]?.captionLabel.stringValue == "钟声札记",
            "A label-less bound marker is not captioned by its drift")
        try harness.expect(journal: [["field.set timeline-marker"], ["field.set timeline-marker"], ["field.set timeline-marker"]],
                           since: mark, "Rename, bind and clear")

        // Drag 1938 春 between 雨夜 and 北塔; its order follows the axis.
        mark = try harness.journal.mark()
        try harness.drag(springPin, to: NSPoint(x: StoryGraphMetrics.slotCenter(1) + StoryGraphMetrics.slot / 2, y: springPin.frame.midY))
        guard let moved = model.timeline.marker(id: spring.id) else { throw LabError.message("The dragged marker is gone") }
        try require(moved.narrativeOrder == 2.5 && abs(springPin.frame.midX - (StoryGraphMetrics.slotCenter(1) + StoryGraphMetrics.slot / 2)) < 0.5,
            "The dragged marker is at \(moved.narrativeOrder)")
        try harness.expect(journal: [["field.set timeline-marker"]], since: mark, "The marker drag")

        // Two numeric markers convert story time on the cards.
        harness.answer = { alert in
            (alert.accessoryView as? NSTextField)?.stringValue = "1940"
            return .alertFirstButtonReturn
        }
        harness.controller.addMarkerButton.performClick(nil)
        try harness.settled()
        try require(model.markers.last?.label == "1940" && model.markers.last?.narrativeOrder == 4, "The second numeric marker differs")
        try require(try harness.card("北塔").metaLabel.stringValue.hasSuffix("≈ 1938.7")
            && (try harness.card("雨夜").metaLabel.stringValue).hasSuffix("≈ 1937.3"),
            "Story time was not converted: \(try harness.card("北塔").metaLabel.stringValue)")

        // Unbinding a label-less marker keeps its drift's title as the label.
        mark = try harness.journal.mark()
        try harness.press("graph-marker-unbind", in: .marker(eve.id))
        try require(model.timeline.marker(id: eve.id)?.label == "钟声札记" && model.timeline.marker(id: eve.id)?.driftNodeId == nil,
            "Unbinding lost the caption")
        try harness.expect(journal: [["field.set timeline-marker", "field.set timeline-marker"]], since: mark, "Unbinding")
        // An unbound marker cannot lose its name.
        mark = try harness.journal.mark()
        harness.answer = { alert in
            (alert.accessoryView as? NSTextField)?.stringValue = "  "
            return .alertFirstButtonReturn
        }
        try harness.press("graph-marker-rename", in: .marker(eve.id))
        try require(model.status.contains("时间标记需要名称") && model.timeline.marker(id: eve.id)?.label == "钟声札记",
            "An empty name was not refused: \(model.status)")
        // Delete: cancel keeps it, confirm removes it.
        harness.answer = nil
        try harness.press("graph-marker-delete", in: .marker(eve.id))
        try require(model.timeline.marker(id: eve.id) != nil, "Cancelled deletion removed the marker")
        try harness.expect(journal: [], since: mark, "The refused rename and cancelled deletion")
        harness.answer = { _ in .alertFirstButtonReturn }
        try harness.press("graph-marker-delete", in: .marker(eve.id))
        try require(model.timeline.marker(id: eve.id) == nil && canvas.markerViews[eve.id] == nil, "The marker was not deleted")
        try harness.expect(journal: [["entity.purge timeline-marker"]], since: mark, "The deletion")
        try harness.close()
    }

    // MARK: (f) Drift cards

    private static func graphDriftCards() throws {
        let harness = try GraphHarness(titles: ["序章", "雨夜"])
        defer { harness.remove() }
        let first = try harness.drift("钟楼"), second = try harness.drift("旧信")
        try harness.openGraph()
        let model = harness.model!, canvas = harness.canvas
        guard let one = canvas.driftViews[first.id], let two = canvas.driftViews[second.id] else { throw LabError.message("No drift cards") }
        let area = canvas.driftAreaTop, left = StoryGraphMetrics.contentLeft
        try require(one.frame.origin == NSPoint(x: left + 12, y: area + 12) && two.frame.minX > one.frame.maxX,
            "Unplaced drifts do not flow: \(one.frame), \(two.frame)")
        var mark = try harness.journal.mark()
        let requests = model.requests
        try harness.drag(one, to: NSPoint(x: one.frame.midX + 300, y: one.frame.midY + 60)) {
            try require(model.requests == requests, "A drift drag sent a Rust call")
        }
        guard let node = try harness.timeline().node(id: first.id) else { throw LabError.message("The drift has no timeline node") }
        try require(node.positionX == 312 && node.positionY == 72, "Stored position differs: \(node.positionX), \(node.positionY)")
        try require(one.frame.origin == NSPoint(x: left + 312, y: area + 72), "The card is not at its stored place")
        try require(two.frame.origin == NSPoint(x: left + 12, y: area + 12), "The next unplaced drift did not flow into the first place")
        try harness.expect(journal: [["tuple.set node"]], since: mark, "The drift move")
        // Up into the lanes: kept inside the area.
        try harness.drag(two, to: NSPoint(x: two.frame.midX + 40, y: two.frame.midY - 600))
        guard let clamped = try harness.timeline().node(id: second.id) else { throw LabError.message("No node for 旧信") }
        try require(clamped.positionX == 52 && clamped.positionY == StoryGraphMetrics.driftMargin, "The drift left its area: \(clamped)")
        // A click-sized drag writes nothing; double-click and 打开 open.
        mark = try harness.journal.mark()
        try harness.drag(one, to: NSPoint(x: one.frame.midX + 2, y: one.frame.midY))
        try harness.expect(journal: [], since: mark, "A click-sized drag")
        try require(one.frame.origin == NSPoint(x: left + 312, y: area + 72), "A click moved the card")
        harness.doubleClick(two)
        try harness.press("graph-drift-open", in: .drift(first.id))
        try require(harness.opened == [second.id, first.id], "Drift cards did not open: \(harness.opened)")
        try harness.close()
    }

    // MARK: (g) Cold reopen

    private static func graphColdReopen() throws {
        let harness = try GraphHarness()
        defer { harness.remove() }
        let lanes = try harness.standardLanes()
        let notes = try harness.drift("钟声札记")
        try harness.openGraph()
        // Book order, a lane, story time, a marker and a drift position.
        let homeward = try harness.card("归途")
        try harness.drag(homeward, to: NSPoint(x: StoryGraphMetrics.slotCenter(0) - 30, y: harness.laneY(1)))
        harness.setAxis(.narrative)
        try harness.drag(try harness.card("北塔"), to: NSPoint(x: StoryGraphMetrics.slotCenter(0), y: harness.laneY(1)))
        try harness.drag(try harness.card("雨夜"), to: NSPoint(x: StoryGraphMetrics.slotCenter(1), y: harness.laneY(0)))
        harness.answer = { alert in
            (alert.accessoryView as? NSTextField)?.stringValue = "黎明"
            return .alertFirstButtonReturn
        }
        harness.controller.addMarkerButton.performClick(nil)
        try harness.settled()
        guard let dawn = harness.model.markers.first else { throw LabError.message("No marker before reopen") }
        try harness.press("graph-marker-bind-\(notes.id)", in: .marker(dawn.id))
        guard let card = harness.canvas.driftViews[notes.id] else { throw LabError.message("No drift card") }
        try harness.drag(card, to: NSPoint(x: card.frame.midX + 200, y: card.frame.midY + 40))
        let before = (lanes: harness.model.lanes, chapters: harness.model.chapters.map(\.id), timeline: try harness.timeline())

        try harness.coldReopen()
        try harness.openGraph()
        let model = harness.model!
        try require(model.chapters.map(\.id) == before.chapters && model.chapters.first?.title == "归途", "Book order was lost")
        try require(model.primary(of: try harness.chapter("归途").id) == lanes.hidden.id, "The lane change was lost")
        try require(model.timeline == before.timeline, "The timeline differs after reopen")
        harness.setAxis(.narrative)
        try require(model.lanes == before.lanes, "Narrative lanes differ after reopen")
        try require(model.placedChapters.map(\.title) == ["北塔", "雨夜"], "Story order was lost")
        guard let marker = model.markers.first, marker.label == "黎明", marker.driftNodeId == notes.id, marker.narrativeOrder == 3 else {
            throw LabError.message("The marker was lost: \(model.markers)")
        }
        guard let node = model.timeline.node(id: notes.id), node.hasPosition,
              let reopened = harness.canvas.driftViews[notes.id] else { throw LabError.message("The drift position was lost") }
        try require(reopened.frame.origin == NSPoint(x: StoryGraphMetrics.contentLeft + node.positionX, y: harness.canvas.driftAreaTop + node.positionY),
            "The drift card is not at its stored place after reopen")
        try harness.close()
    }

    // MARK: (h) 200 chapters

    private static func graphLargeBook() throws {
        let harness = try GraphHarness(titles: (1...200).map { "第\($0)章" })
        defer { harness.remove() }
        _ = try harness.storyline("主线")
        try harness.openGraph()
        let model = harness.model!, canvas = harness.canvas
        try require(canvas.cardViews.count == 200 && canvas.cardViews.values.allSatisfy { $0.layer != nil }, "Not 200 layer-backed cards")
        try require(canvas.frame.width >= StoryGraphMetrics.contentLeft + 200 * StoryGraphMetrics.slot, "The canvas does not hold 200 slots")
        let started = Date()
        canvas.render()
        let elapsed = Date().timeIntervalSince(started)
        try require(elapsed < 0.5, "A render of 200 cards took \(elapsed)s")
        let first = try harness.card("第1章")
        let requests = model.requests, renders = canvas.renders
        try harness.drag(first, to: NSPoint(x: StoryGraphMetrics.slotCenter(150) + 30, y: first.frame.midY), steps: 40) {
            try require(model.requests == requests && canvas.renders == renders, "The drag across 200 cards called Rust or rendered")
        }
        try require(model.bookIndex(of: try harness.chapter("第1章").id) == 150, "The chapter did not move to 150")
        try require(model.requests == requests + 2, "The drop sent \(model.requests - requests) requests instead of the move and one read")
        try harness.close()
    }
}
