import AppKit

/// The 底部时间轴 dock through the real dock coordinator, controller, canvas,
/// tab host, Rust workspace, SQLite and `settings.json`, wired as the window
/// wires them. Clicks and drags are synthesized mouse events sent to the
/// canvas; every title is synthetic.
extension BindingAcceptance {
    static func bottomTimelineAcceptance() throws -> [String] {
        try dockReadingOrder()
        try dockActRail()
        try dockTileDrags()
        try dockFollowsAndRemembers()
        try dockLargeBook()
        return [
            "AppKit 底部时间轴 阅读顺序 shows chapter tiles in book order in storyline rows with 未归属, the 幕 rail's bands over their chapters in stored or default act colours, highlights the current chapter and follows the active tab, opens a chapter from a tile click, and showing, switching modes and scrolling write nothing to the journal",
            "AppKit 底部时间轴 幕 rail: dragging a boundary sends nothing until the drop and then one workspaceMoveAct field.set, a drop at its own start writes nothing, the drag is clamped strictly between the neighbouring boundaries, a boundary created elsewhere makes Rust refuse the stale drop in Chinese without writing and the rail reads acts again; double-click and 重命名… rename, 在此处开始新幕 creates, 删除 after confirmation removes only the boundary, 幕颜色 stores and clears a colour, and other act views are told",
            "AppKit 底部时间轴 tile drags reuse the story graph's commands: a book move with one original that the tab host and the 幕 rail follow, a row change making the storyline primary, a drop in place and a click writing nothing; 故事时间 lists chapters without a story time in 未放置, places them with 放到末尾, orders them by drag, shows the timeline markers and takes one back with 移出故事时间",
            "AppKit 底部时间轴 follows chapters created, renamed and moved, acts created, renamed and recoloured in the 整书大纲, storyline changes and story time set in the 故事图谱 without reopening, and 视图 › 底部时间轴 remembers shown or hidden and the mode per project in settings.json through a cold relaunch, writing nothing to the journal",
            "AppKit 底部时间轴 lays out 200 chapters in 3 acts and 3 storyline rows with no main-thread pass over 100 ms in a debug build while loading, switching modes, scrolling and dragging, and a drag across them sends no Rust call and no render until the drop, which moves the chapter once",
        ]
    }

    // MARK: Harness

    private final class DockHarness {
        typealias M = BottomTimelineMetrics
        let root: URL
        let directory: URL
        private(set) var workspace: LabWorkspaceCore
        let project: WorkspaceProject
        let journal: JournalProbe
        private(set) var chapters: [WorkspaceChapter] = []
        private(set) var window: NSWindow
        private(set) var host: MacChapterWorkspace
        private(set) var settings: LabSettingsStore
        private(set) var dock: BottomTimelineDock
        let dockWindow: NSWindow
        /// Answers the dock's prompts; nil cancels.
        var answer: ((NSAlert) -> NSApplication.ModalResponse)?
        var alerts: [String] = []
        var opened: [String] = []
        var chapterLists: [[String]] = []
        var actReports: [[WorkspaceOutlineEntry]] = []
        /// The slowest run-loop pass while waiting, for the 100 ms budget.
        var slowestWait: TimeInterval = 0

        init(titles: [String] = ["序章", "雨夜", "北塔", "钟声", "归途", "尾声"], name: String = "时间轴合成项目") throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            directory = root.appendingPathComponent("apple-native-lab")
            journal = JournalProbe(directory: directory)
            let workspace = LabWorkspaceCore(directory: directory)
            self.workspace = workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(listed.isEmpty, "Dock fixture was not isolated")
            project = try BindingAcceptance.elementResult { workspace.createProject(name: name, completion: $0) }
            let projectID = project.id
            for title in titles {
                chapters.append(try BindingAcceptance.elementResult { workspace.createChapter(projectID: projectID, title: title, completion: $0) })
            }
            (window, host) = BindingAcceptance.elementHost(workspace)
            settings = LabSettingsStore(directory: workspace.dataDirectory)
            dock = BottomTimelineDock(workspace: workspace, settings: settings)
            dockWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: M.dockHeight),
                                  styleMask: [.titled, .resizable], backing: .buffered, defer: false)
            dockWindow.isReleasedWhenClosed = false
            wire()
        }

        /// As AppDelegate wires the dock: it sits in its own window here.
        private func wire() {
            let host = self.host, projectID = project.id, content = dockWindow.contentView!
            dock.onPresent = { view in
                content.subviews.forEach { $0.removeFromSuperview() }
                guard let view else { return }
                view.frame = content.bounds
                view.autoresizingMask = [.width, .height]
                content.addSubview(view)
                view.layoutSubtreeIfNeeded()
            }
            dock.configure = { [weak self] controller, project in
                controller.presentAlert = { [weak self] alert, done in
                    alert.layout()
                    self?.alerts.append(alert.messageText)
                    done(self?.answer?(alert) ?? .alertSecondButtonReturn)
                }
                controller.onOpenChapter = { [weak self] chapter in
                    guard let self else { return }
                    self.opened.append(chapter.id)
                    host.open(project: project, chapter: chapter) { _ in }
                }
                let model = controller.model
                if host.activeProject?.id == project.id { model.setCurrentChapter(host.activeChapter?.id) }
                model.onChapters = { [weak self] chapters in
                    self?.chapterLists.append(chapters.map(\.id))
                    host.applyChapters(projectID: projectID, chapters: chapters, trashed: nil)
                }
                model.onStorylineLibrary = { library in host.applyStorylineLibrary(projectID: projectID, library: library) }
                model.onActs = { [weak self] entries in
                    self?.actReports.append(entries)
                    host.applyOutline(projectID: projectID, entries: entries)
                }
            }
            host.onChange = { [weak self] in
                guard let self else { return }
                self.dock.currentChapterChanged(projectID: self.host.activeProject?.id, chapterID: self.host.activeChapter?.id)
            }
        }

        var controller: MacBottomTimelineController { dock.controller! }
        var model: BottomTimelineModel { dock.model! }
        var canvas: BottomTimelineCanvas { controller.canvas }

        func chapter(_ title: String) throws -> WorkspaceChapter {
            guard let chapter = chapters.first(where: { $0.title == title }) else { throw LabError.message("No chapter \(title)") }
            return chapter
        }

        func storyline(_ name: String) throws -> WorkspaceStoryline {
            let projectID = project.id, workspace = self.workspace
            let reply: WorkspaceStorylineReply<WorkspaceStoryline> = try BindingAcceptance.elementResult {
                workspace.createStoryline(projectID: projectID, name: name, completion: $0)
            }
            guard let storyline = reply.result else { throw LabError.message("No storyline \(name)") }
            return storyline
        }

        @discardableResult
        func member(_ chapterID: String, _ ids: [String], primary: String?) throws -> WorkspaceStorylineLibrary {
            let projectID = project.id, workspace = self.workspace
            let reply: WorkspaceStorylineReply<WorkspaceChapterStorylines> = try BindingAcceptance.elementResult {
                workspace.setChapterStorylines(projectID: projectID, chapterID: chapterID, storylineIDs: ids, primary: primary, completion: $0)
            }
            return reply.library
        }

        /// 主线 and 暗线: 北塔 in 暗线; 钟声 in both with 暗线 primary; 尾声 in none.
        func standardLanes() throws -> (main: WorkspaceStoryline, hidden: WorkspaceStoryline) {
            let main = try storyline("主线"), hidden = try storyline("暗线")
            try member(try chapter("北塔").id, [hidden.id], primary: hidden.id)
            try member(try chapter("钟声").id, [main.id, hidden.id], primary: hidden.id)
            try member(try chapter("尾声").id, [], primary: nil)
            return (main, hidden)
        }

        @discardableResult
        func act(before title: String) throws -> WorkspaceAct {
            let projectID = project.id, workspace = self.workspace, chapterID = try chapter(title).id
            return try BindingAcceptance.elementResult { workspace.createAct(projectID: projectID, chapterID: chapterID, completion: $0) }
        }

        /// 视图 › 底部时间轴, then the first read.
        func showDock() throws {
            dock.toggle(project)
            try settled()
        }

        func settled(file: String = #fileID, line: Int = #line) throws {
            let deadline = Date().addingTimeInterval(15)
            let ready = { self.dock.model.map { $0.loaded && !$0.busy && !$0.outline.busy } ?? true }
            while !ready() && Date() < deadline {
                let started = Date()
                _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
                slowestWait = max(slowestWait, Date().timeIntervalSince(started))
            }
            try BindingAcceptance.require(ready(), "Timed out waiting for the dock at \(file):\(line)")
            dock.controller?.view.layoutSubtreeIfNeeded()
        }

        /// Runs the loop for a while so debounced and queued reads land.
        func pump(_ seconds: TimeInterval = 0.15) {
            let until = Date().addingTimeInterval(seconds)
            while Date() < until {
                let started = Date()
                _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
                slowestWait = max(slowestWait, Date().timeIntervalSince(started))
            }
        }

        func tile(_ title: String) throws -> NSRect {
            let id = try chapter(title).id
            guard let frame = canvas.tileFrames[id] else { throw LabError.message("No tile for \(title)") }
            return frame
        }

        func band(_ id: String) throws -> NSRect {
            guard let view = canvas.actViews[id] else { throw LabError.message("No band for act \(id)") }
            return view.frame
        }

        /// The centre of lane `index`.
        func laneY(_ index: Int) -> CGFloat { M.lanesTop + CGFloat(index) * M.laneHeight + M.laneHeight / 2 }

        func event(_ type: NSEvent.EventType, _ point: NSPoint, clicks: Int = 1) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: canvas.convert(point, to: nil), modifierFlags: [],
                               timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: dockWindow.windowNumber,
                               context: nil, eventNumber: 0, clickCount: clicks, pressure: type == .leftMouseUp ? 0 : 1)!
        }

        /// Presses at `start`, drags in `steps` moves to `end` and releases
        /// there; `during` runs before the release.
        func drag(from start: NSPoint, to end: NSPoint, steps: Int = 4, during: (() throws -> Void)? = nil) throws {
            canvas.mouseDown(with: event(.leftMouseDown, start))
            for step in 1...steps {
                let t = CGFloat(step) / CGFloat(steps)
                canvas.mouseDragged(with: event(.leftMouseDragged, NSPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)))
            }
            try during?()
            canvas.mouseUp(with: event(.leftMouseUp, end))
            try settled()
        }

        func click(_ point: NSPoint, clicks: Int = 1) {
            canvas.mouseDown(with: event(.leftMouseDown, point, clicks: clicks))
            canvas.mouseUp(with: event(.leftMouseUp, point, clicks: clicks))
        }

        /// Presses a dock menu item by identifier, searching submenus.
        func press(_ identifier: String, in target: BottomTimelineCanvas.Target) throws {
            func find(_ items: [NSMenuItem]) -> LibraryMenuItem? {
                for item in items {
                    if item.accessibilityIdentifier() == identifier, let entry = item as? LibraryMenuItem { return entry }
                    if let found = item.submenu.flatMap({ find($0.items) }) { return found }
                }
                return nil
            }
            guard let entry = find(controller.menuItems(for: target)) else { throw LabError.message("No dock menu item \(identifier)") }
            try BindingAcceptance.require(entry.isEnabled, "\(identifier) was disabled")
            entry.press()
            try settled()
        }

        func expect(journal expected: [[String]], since: Int64, _ step: String) throws {
            try journal.expect(expected, since: since, step)
        }

        func storedOrder(_ title: String) throws -> Double? {
            let projectID = project.id, workspace = self.workspace, id = try chapter(title).id
            let timeline: WorkspaceTimeline = try BindingAcceptance.elementResult { workspace.timeline(projectID: projectID, completion: $0) }
            return timeline.node(id: id)?.narrativeOrder
        }

        func outline() throws -> [WorkspaceOutlineEntry] {
            let projectID = project.id, workspace = self.workspace
            return try BindingAcceptance.elementResult { workspace.outline(projectID: projectID, completion: $0) }
        }

        /// The act a chapter falls in, from Rust's outline.
        func storedAct(of title: String) throws -> String? {
            let id = try chapter(title).id
            return try outline().first { $0.id == id }?.actId
        }

        func coldReopen() throws {
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "Dock workspace failed to close")
            window.close()
            // The dock goes with the window; settings.json keeps it shown.
            dock.forget(projectID: project.id)
            let reopened = LabWorkspaceCore(directory: directory)
            workspace = reopened
            let projects: [WorkspaceProject] = try BindingAcceptance.elementResult { reopened.projects(completion: $0) }
            try BindingAcceptance.require(projects.map(\.id).contains(project.id), "Cold reopen lost the project")
            (window, host) = BindingAcceptance.elementHost(reopened)
            settings = LabSettingsStore(directory: reopened.dataDirectory)
            dock = BottomTimelineDock(workspace: reopened, settings: settings)
            wire()
        }

        func close() throws {
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "Dock workspace failed to close")
            window.close(); dockWindow.close()
        }

        func remove() { try? FileManager.default.removeItem(at: root) }
    }

    // MARK: (a) 阅读顺序

    private static func dockReadingOrder() throws {
        let harness = try DockHarness()
        defer { harness.remove() }
        typealias M = BottomTimelineMetrics
        _ = try harness.standardLanes()
        let first = try harness.act(before: "雨夜"), second = try harness.act(before: "钟声")
        let projectID = harness.project.id, workspace = harness.workspace
        let _: WorkspaceAct = try elementResult { workspace.setActColor(projectID: projectID, actID: second.id, color: "#E5484D", completion: $0) }
        let north = try harness.chapter("北塔")
        let northView: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, chapter: north, completion: $0) }
        try elementSettled(harness.host, northView)

        let mark = try harness.journal.mark()
        try harness.showDock()
        let model = harness.model, canvas = harness.canvas
        try require(canvas.lanes.map(\.name) == ["主线", "暗线", "未归属"] && canvas.names.titles == ["幕", "主线", "暗线", "未归属"],
            "Rows differ: \(canvas.lanes.map(\.name))")
        let expectedRows = [["序章", "雨夜", "归途"], ["北塔", "钟声"], ["尾声"]]
        for (row, titles) in expectedRows.enumerated() {
            for title in titles {
                let frame = try harness.tile(title)
                let index = model.graph.bookIndex(of: try harness.chapter(title).id) ?? -1
                try require(abs(frame.midX - M.slotCenter(index)) < 0.5 && frame.minY >= M.lanesTop + CGFloat(row) * M.laneHeight
                    && frame.maxY <= M.lanesTop + CGFloat(row + 1) * M.laneHeight, "\(title) is not in row \(row) at its book slot: \(frame)")
            }
        }
        try require(canvas.tiles[try harness.chapter("雨夜").id]?.number == "§02", "Tiles are not numbered in book order")
        // Bands span their chapters; the stored colour and the hue by position.
        try require(model.acts.map(\.start) == [1, 3] && model.acts.map(\.end) == [3, 6], "Act slots differ: \(model.acts)")
        let firstBand = try harness.band(first.id), secondBand = try harness.band(second.id)
        try require(abs(firstBand.minX - M.gapX(1)) <= 1.5 && abs(firstBand.maxX - M.gapX(3)) <= 1.5
            && abs(secondBand.minX - M.gapX(3)) <= 1.5 && abs(secondBand.maxX - M.gapX(6)) <= 1.5,
            "Bands do not span their chapters: \(firstBand) \(secondBand)")
        try require(canvas.actViews[first.id]?.tint == ElementSwatch.color(hex: BookPalette.act(0))
            && canvas.actViews[second.id]?.tint == ElementSwatch.color(hex: "#E5484D"), "Bands do not use the act colours")
        try require(canvas.actViews[first.id]?.detail == "2 章" && canvas.actViews[second.id]?.detail == "3 章", "Band counts differ")
        // The current chapter is outlined, and follows the active tab.
        try require(canvas.tiles[north.id]?.isCurrent == true && canvas.tiles.values.filter(\.isCurrent).count == 1,
            "北塔 is not the highlighted chapter")
        // A click opens the chapter; the highlight moves with the tab.
        let bell = try harness.chapter("钟声")
        let bellFrame = try harness.tile("钟声")
        harness.click(NSPoint(x: bellFrame.midX, y: bellFrame.midY))
        try wait { harness.host.activeChapter?.id == bell.id && !harness.host.isBusy }
        try require(harness.opened == [bell.id] && canvas.tiles[bell.id]?.isCurrent == true && canvas.tiles[north.id]?.isCurrent == false,
            "The click did not open 钟声 and move the highlight")
        harness.controller.locateCurrent()
        // Switching modes and scrolling read and write nothing new.
        harness.controller.setAxis(.narrative)
        try harness.settled()
        try require(canvas.actViews.isEmpty && canvas.names.titles.first == "时间" && harness.controller.unplacedButton.title == "未放置 6",
            "故事时间 still shows the rail or miscounts 未放置")
        harness.controller.setAxis(.book)
        try harness.settled()
        let requests = model.requests
        for x in stride(from: 0, through: 600, by: 150) {
            harness.controller.scrollView.contentView.scroll(to: NSPoint(x: CGFloat(x), y: 0))
            harness.controller.scrollView.reflectScrolledClipView(harness.controller.scrollView.contentView)
        }
        harness.pump()
        try require(model.requests == requests, "Scrolling read \(model.requests - requests) times")
        try harness.expect(journal: [], since: mark, "Showing, switching and scrolling")
        try require(harness.settings.bottomTimeline(projectID: projectID) == BottomTimelineSetting(shown: true, axis: .book),
            "settings.json does not remember the dock")
        try harness.close()
    }

    // MARK: (b) 幕 rail

    private static func dockActRail() throws {
        let harness = try DockHarness(titles: (1...8).map { "第\($0)章" })
        defer { harness.remove() }
        typealias M = BottomTimelineMetrics
        let a = try harness.act(before: "第3章"), b = try harness.act(before: "第6章")
        try harness.showDock()
        let model = harness.model, canvas = harness.canvas
        try require(model.acts.map(\.start) == [2, 5], "Acts start at \(model.acts.map(\.start))")

        // A drags left to before 第2章: nothing until the drop, then one field.set.
        var mark = try harness.journal.mark()
        var band = try harness.band(a.id)
        var grip = NSPoint(x: band.minX + 20, y: band.midY)
        let requests = model.requests, renders = canvas.renders
        try harness.drag(from: grip, to: NSPoint(x: grip.x - M.slot, y: grip.y)) {
            try require(model.requests == requests && canvas.renders == renders, "A boundary drag read, wrote or rendered")
            try require(!canvas.indicator.isHidden && abs(canvas.indicator.frame.midX - M.gapX(1)) < 1.5, "The divider is not at slot 1")
        }
        try harness.expect(journal: [["field.set book-act"]], since: mark, "The boundary move")
        try require(model.acts.map(\.start) == [1, 5] && (try harness.storedAct(of: "第2章")) == a.id && (try harness.storedAct(of: "第1章")) == nil,
            "The boundary did not move: \(model.acts.map(\.start))")
        try require(harness.actReports.count == 1 && canvas.indicator.isHidden, "Other act views were not told, or the divider stayed")
        // A drop at its own start writes nothing.
        mark = try harness.journal.mark()
        band = try harness.band(a.id)
        grip = NSPoint(x: band.minX + 20, y: band.midY)
        try harness.drag(from: grip, to: NSPoint(x: grip.x + 30, y: grip.y))
        try harness.expect(journal: [], since: mark, "A drop at its own start")
        // B drags far left: clamped just after A's start.
        band = try harness.band(b.id)
        grip = NSPoint(x: band.minX + 20, y: band.midY)
        try harness.drag(from: grip, to: NSPoint(x: grip.x - 6 * M.slot, y: grip.y)) {
            try require(abs(canvas.indicator.frame.midX - M.gapX(2)) < 1.5, "The divider left its clamp: \(canvas.indicator.frame)")
        }
        try require(model.acts.map(\.start) == [1, 2], "The clamped move differs: \(model.acts.map(\.start))")
        // Far right: the last act may end the book but not pass it.
        try require(model.boundaryRange(actID: b.id) == 2...8 && model.boundaryRange(actID: a.id) == 0...1, "Ranges differ")

        // A boundary created elsewhere: the stale drop is refused and read again.
        let third = try harness.act(before: "第5章")
        try require(model.acts.count == 2, "The rail learned of the new act without a read")
        mark = try harness.journal.mark()
        band = try harness.band(b.id)
        grip = NSPoint(x: band.minX + 20, y: band.midY)
        try harness.drag(from: grip, to: NSPoint(x: grip.x + 4 * M.slot, y: grip.y))
        try require(model.status == "幕的起点不能越过相邻的幕", "The refusal was not shown: \(model.status)")
        try harness.expect(journal: [], since: mark, "The refused stale drop")
        try wait { model.acts.count == 3 && !model.busy }
        try require(model.acts.map(\.id) == [a.id, b.id, third.id] && model.acts.map(\.start) == [1, 2, 4], "The rail did not read acts again")

        // Double-click and 重命名… rename.
        mark = try harness.journal.mark()
        harness.answer = { alert in
            (alert.accessoryView as? NSTextField)?.stringValue = " 开端 "
            return .alertFirstButtonReturn
        }
        band = try harness.band(a.id)
        harness.click(NSPoint(x: band.minX + 20, y: band.midY), clicks: 2)
        try harness.settled()
        try require(model.act(id: a.id)?.act.title == "开端" && harness.alerts.last == "重命名幕", "Double-click did not rename")
        harness.answer = { alert in
            (alert.accessoryView as? NSTextField)?.stringValue = "终局"
            return .alertFirstButtonReturn
        }
        try harness.press("timeline-act-rename", in: .act(third.id, gap: 5))
        try require(model.act(id: third.id)?.act.title == "终局" && canvas.actViews[third.id]?.name == "终局", "重命名… did not rename")
        try harness.expect(journal: [["field.set book-act"], ["field.set book-act"]], since: mark, "Two renames")
        // 在此处开始新幕 on the bare rail and inside an act.
        mark = try harness.journal.mark()
        try require(canvas.target(at: NSPoint(x: M.slotCenter(0), y: 10)) == .rail(gap: 0), "The bare rail is not a rail target")
        try harness.press("timeline-rail-start-act", in: .rail(gap: 0))
        try harness.press("timeline-act-start-here", in: .act(third.id, gap: 6))
        try harness.expect(journal: [["entity.create book-act"], ["entity.create book-act"]], since: mark, "Two new acts")
        try require(model.acts.map(\.start) == [0, 1, 2, 4, 6] && canvas.actViews.count == 5, "New acts differ: \(model.acts.map(\.start))")
        // 幕颜色 stores and clears; the current colour writes nothing.
        mark = try harness.journal.mark()
        try harness.press("timeline-act-color-e5484d", in: .act(a.id, gap: 1))
        try require(model.act(id: a.id)?.act.color?.uppercased() == "#E5484D" && canvas.actViews[a.id]?.tint == ElementSwatch.color(hex: "#E5484D"),
            "The colour was not stored")
        try harness.press("timeline-act-color-e5484d", in: .act(a.id, gap: 1))
        try harness.press("timeline-act-color-default", in: .act(a.id, gap: 1))
        try require(model.act(id: a.id)?.act.color == nil, "恢复默认 kept the colour")
        try harness.expect(journal: [["field.set book-act"], ["field.set book-act"]], since: mark, "Colour and default")
        // 删除 after confirmation removes only the boundary.
        mark = try harness.journal.mark()
        harness.answer = nil
        try harness.press("timeline-act-delete", in: .act(third.id, gap: 4))
        try require(model.acts.count == 5 && harness.alerts.last == "删除“终局”？", "The deletion was not confirmed")
        harness.answer = { _ in .alertFirstButtonReturn }
        try harness.press("timeline-act-delete", in: .act(third.id, gap: 4))
        try require(model.act(id: third.id) == nil && model.acts.count == 4 && model.chapters.count == 8, "删除 did not remove only the boundary")
        try harness.expect(journal: [["entity.purge book-act"]], since: mark, "The deletion")
        try require(harness.actReports.count >= 8 && (try harness.outline()).filter { $0.kind == "act" }.count == 4,
            "Act commands were not reported to other views")
        try harness.close()
    }

    // MARK: (c) Tiles

    private static func dockTileDrags() throws {
        let harness = try DockHarness()
        defer { harness.remove() }
        typealias M = BottomTimelineMetrics
        let lanes = try harness.standardLanes()
        let act = try harness.act(before: "北塔")
        try harness.showDock()
        let model = harness.model, canvas = harness.canvas
        try require(model.acts.first?.start == 2, "The act does not start at 北塔")

        // 归途 before 雨夜 in its row: one move; the tab host and the rail follow.
        var mark = try harness.journal.mark()
        let homeward = try harness.tile("归途")
        let requests = model.requests, renders = canvas.renders
        try harness.drag(from: NSPoint(x: homeward.midX, y: homeward.midY), to: NSPoint(x: M.slotCenter(1) - 30, y: homeward.midY)) {
            try require(model.requests == requests && canvas.renders == renders, "A tile drag read or rendered")
            try require(!canvas.indicator.isHidden, "No insertion point while dragging")
        }
        let expected = try ["序章", "归途", "雨夜", "北塔", "钟声", "尾声"].map { try harness.chapter($0).id }
        try require(model.chapters.map(\.id) == expected && harness.chapterLists.last == expected, "Book order differs: \(model.chapters.map(\.title))")
        try harness.expect(journal: [["field.set node"]], since: mark, "The book move")
        try wait { model.acts.first?.start == 3 && !model.busy }
        try require(abs((try harness.tile("归途")).midX - M.slotCenter(1)) < 0.5 && model.acts.first?.id == act.id,
            "The tile or the rail did not follow: \(model.acts.map(\.start))")
        // A drop in place and a click write nothing; the click opens.
        mark = try harness.journal.mark()
        let rain = try harness.tile("雨夜")
        try harness.drag(from: NSPoint(x: rain.midX, y: rain.midY), to: NSPoint(x: rain.midX + 20, y: rain.midY + 4))
        harness.click(NSPoint(x: rain.midX, y: rain.midY))
        try wait { harness.opened.last == (try? harness.chapter("雨夜").id) && !harness.host.isBusy }
        try harness.expect(journal: [], since: mark, "A drop in place and a click")
        // 钟声 (暗线 primary) into 主线's row: the lane-change rule.
        mark = try harness.journal.mark()
        let bell = try harness.tile("钟声")
        try harness.drag(from: NSPoint(x: bell.midX, y: bell.midY), to: NSPoint(x: bell.midX, y: harness.laneY(0)))
        let bellID = try harness.chapter("钟声").id
        try require(model.graph.primary(of: bellID) == lanes.main.id
            && harness.host.storylineLibrary(projectID: harness.project.id)?.membership(chapterID: bellID)?.storylineIds == [lanes.main.id],
            "The row change did not make 主线 primary")
        try harness.expect(journal: [["set.remove membership", "field.set node-storyline-primary"]], since: mark, "The row change")
        // 移到轨道 from the tile menu: 尾声 into 暗线.
        try harness.press("timeline-tile-lane-\(lanes.hidden.id)", in: .chapter(try harness.chapter("尾声").id))
        try require(model.graph.primary(of: try harness.chapter("尾声").id) == lanes.hidden.id, "移到轨道 did not move 尾声")

        // 故事时间: 未放置, 放到末尾, a drag and 移出故事时间.
        harness.controller.setAxis(.narrative)
        try harness.settled()
        try require(model.graph.unplacedChapters.count == 6 && canvas.tileFrames.isEmpty, "New chapters were placed in story time")
        harness.controller.toggleUnplaced()
        guard let list = harness.controller.unplacedList else { throw LabError.message("未放置 was not listed") }
        try require(list.rows.count == 6, "未放置 lists \(list.rows.count)")
        mark = try harness.journal.mark()
        for title in ["北塔", "序章", "雨夜"] {
            let id = try harness.chapter(title).id
            guard let row = list.rows.first(where: { $0.chapterID == id }) else { throw LabError.message("未放置 lacks \(title)") }
            row.place.performClick(nil)
            try harness.settled()
        }
        try require(try harness.storedOrder("北塔") == 1 && (try harness.storedOrder("序章")) == 2 && (try harness.storedOrder("雨夜")) == 3,
            "放到末尾 orders differ")
        try require(list.rows.count == 3 && harness.controller.unplacedButton.title == "未放置 3", "未放置 did not follow")
        try harness.expect(journal: [["field.set node"], ["field.set node"], ["field.set node"]], since: mark, "Three placements")
        // A marker between 北塔 and 序章 shows on the time row.
        let projectID = harness.project.id, workspace = harness.workspace
        let marker: WorkspaceTimelineReply<WorkspaceTimelineMarker> = try elementResult {
            workspace.createTimelineMarker(projectID: projectID, narrativeOrder: 1.5, label: "开战前夜", driftID: nil, completion: $0)
        }
        harness.dock.chaptersChanged(projectID: projectID)
        guard let markerID = marker.result?.id else { throw LabError.message("No marker") }
        try wait { canvas.markerViews[markerID] != nil }
        guard let pin = canvas.markerViews[markerID] else { throw LabError.message("The marker is not shown") }
        try require(abs(pin.frame.midX - (M.slotCenter(0) + M.slot / 2)) < 0.5 && pin.caption == "开战前夜", "The marker is misplaced: \(pin.frame)")
        // 雨夜 dragged before 北塔: one step before it.
        mark = try harness.journal.mark()
        let rainPlaced = try harness.tile("雨夜")
        try harness.drag(from: NSPoint(x: rainPlaced.midX, y: rainPlaced.midY), to: NSPoint(x: M.slotCenter(0) - 40, y: rainPlaced.midY))
        try require(try harness.storedOrder("雨夜") == 0 && model.graph.placedChapters.map(\.title) == ["雨夜", "北塔", "序章"],
            "The story-time drag differs: \(model.graph.placedChapters.map(\.title))")
        // 移出故事时间 from the tile menu.
        try harness.press("timeline-tile-unplace", in: .chapter(try harness.chapter("北塔").id))
        try require(try harness.storedOrder("北塔") == nil && list.rows.count == 4, "移出故事时间 did not clear the order")
        try harness.expect(journal: [["field.set node"], ["field.set node"]], since: mark, "A drag and 移出故事时间")
        try harness.close()
    }

    // MARK: (d) Following and remembering

    private static func dockFollowsAndRemembers() throws {
        let harness = try DockHarness()
        defer { harness.remove() }
        let projectID = harness.project.id, workspace = harness.workspace
        let other: WorkspaceProject = try elementResult { workspace.createProject(name: "另一个合成项目", completion: $0) }
        try harness.showDock()
        let model = harness.model, canvas = harness.canvas

        // Chapters created, renamed and moved elsewhere (the window calls chaptersChanged).
        let added: WorkspaceChapter = try elementResult { workspace.createChapter(projectID: projectID, title: "番外", completion: $0) }
        harness.dock.chaptersChanged(projectID: projectID)
        try harness.settled()
        try wait { canvas.tileFrames[added.id] != nil }
        let north = try harness.chapter("北塔")
        let _: WorkspaceChapter = try elementResult { workspace.renameChapter(projectID: projectID, chapterID: north.id, title: "北塔之夜", completion: $0) }
        let _: [WorkspaceChapter] = try elementResult { workspace.moveChapter(projectID: projectID, chapterID: added.id, beforeChapterID: north.id, completion: $0) }
        harness.dock.chaptersChanged(projectID: projectID)
        try harness.settled()
        try wait { canvas.tiles[north.id]?.title == "北塔之夜" && model.graph.bookIndex(of: added.id) == 2 }

        // Acts through the 整书大纲, wired as the window wires it.
        let outline = WorkspaceOutlineModel(workspace: workspace, projectID: projectID)
        outline.onEntries = { [weak dock = harness.dock] _ in dock?.actsChanged(projectID: projectID) }
        outline.load()
        try wait { !outline.entries.isEmpty }
        let act: WorkspaceAct = try elementResult { outline.createAct(beforeChapterID: north.id, completion: $0) }
        try harness.settled()
        try wait { model.acts.map(\.id) == [act.id] && canvas.actViews[act.id] != nil }
        let _: WorkspaceAct = try elementResult { outline.renameAct(id: act.id, name: "北塔篇", completion: $0) }
        let _: WorkspaceAct = try elementResult { outline.setActColor(id: act.id, color: "#72C096", completion: $0) }
        try harness.settled()
        try wait { canvas.actViews[act.id]?.name == "北塔篇" && canvas.actViews[act.id]?.tint == ElementSwatch.color(hex: "#72C096") }

        // A storyline change from the chapter's 故事线 sheet.
        let main: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult { workspace.createStoryline(projectID: projectID, name: "主线", completion: $0) }
        let library = try harness.member(north.id, [main.result!.id], primary: main.result!.id)
        harness.dock.storylinesChanged(projectID: projectID, library: library)
        try harness.settled()
        try require(canvas.lanes.map(\.name) == ["主线", "未归属"] && model.graph.primary(of: north.id) == main.result!.id,
            "The storyline change was not followed: \(canvas.lanes.map(\.name))")

        // Story time set in the 故事图谱.
        let graph = StoryGraphModel(workspace: workspace, projectID: projectID)
        graph.onTimeline = { [weak dock = harness.dock] in dock?.chaptersChanged(projectID: projectID) }
        graph.load()
        try wait { graph.loaded }
        var dropped: Bool?
        graph.drop(chapterID: north.id, lane: nil, placement: .narrative(1)) { dropped = $0 }
        try wait { dropped != nil }
        harness.controller.setAxis(.narrative)
        try harness.settled()
        try wait { model.graph.placedChapters.map(\.id) == [north.id] && canvas.tileFrames[north.id] != nil }

        // Remembered per project: hidden, shown again in 故事时间, another project apart.
        let quiet = try harness.journal.mark()
        try require(harness.settings.bottomTimeline(projectID: projectID) == BottomTimelineSetting(shown: true, axis: .narrative),
            "The mode was not remembered")
        harness.dock.follow(other)
        try require(harness.dock.controller == nil && harness.settings.bottomTimeline(projectID: other.id) == nil,
            "A project never shown got a dock")
        harness.dock.follow(harness.project)
        try harness.settled()
        try require(harness.dock.isShown(projectID: projectID) && harness.model.axis == .narrative, "Following the project again lost the dock")
        harness.controller.hideButton.performClick(nil)
        try require(harness.dock.controller == nil && harness.settings.bottomTimeline(projectID: projectID)?.shown == false, "隐藏 was not remembered")
        harness.dock.toggle(harness.project)
        try harness.settled()
        try require(harness.model.axis == .narrative, "Showing again lost the mode")
        let file = harness.settings.fileURL
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        let stored = (json?["bottomTimelines"] as? [String: Any])?[projectID] as? [String: Any]
        try require(stored?["shown"] as? Bool == true && stored?["mode"] as? String == "narrative", "settings.json holds \(String(describing: stored))")
        try harness.expect(journal: [], since: quiet, "Showing, hiding and following")
        try harness.coldReopen()
        harness.dock.follow(harness.project)
        try harness.settled()
        try require(harness.dock.isShown(projectID: projectID) && harness.model.axis == .narrative
            && harness.canvas.tileFrames[north.id] != nil, "The dock was not restored after a cold relaunch")
        harness.dock.follow(other)
        try require(harness.dock.controller == nil, "The other project showed a dock after the relaunch")
        try harness.close()
    }

    // MARK: (e) 200 chapters

    private static func dockLargeBook() throws {
        let harness = try DockHarness(titles: (1...200).map { "第\($0)章" }, name: "长篇合成项目")
        defer { harness.remove() }
        typealias M = BottomTimelineMetrics
        let lines = try ["主线", "暗线", "支线"].map { try harness.storyline($0) }
        for (index, chapter) in harness.chapters.enumerated() {
            let line = lines[index % 3]
            try harness.member(chapter.id, [line.id], primary: line.id)
        }
        for title in ["第1章", "第70章", "第140章"] { try harness.act(before: title) }
        let mark = try harness.journal.mark()
        harness.slowestWait = 0
        let started = Date()
        try harness.showDock()
        let opening = Date().timeIntervalSince(started)
        let model = harness.model, canvas = harness.canvas
        try require(canvas.tiles.count == 200 && canvas.lanes.count == 4 && model.acts.map(\.start) == [0, 69, 139],
            "The large book differs: \(canvas.tiles.count) tiles, acts \(model.acts.map(\.start))")
        try require(canvas.frame.width >= M.contentLeft + 200 * M.slot, "The canvas does not hold 200 slots")
        harness.controller.resetTiming()
        // Modes.
        harness.controller.setAxis(.narrative); try harness.settled()
        harness.controller.setAxis(.book); try harness.settled()
        // Scrolling to the end and back.
        let clip = harness.controller.scrollView.contentView
        var slowestScroll: TimeInterval = 0
        for x in stride(from: 0, through: Int(canvas.frame.width), by: 400) + [0] {
            let step = Date()
            clip.scroll(to: NSPoint(x: CGFloat(x), y: 0))
            harness.controller.scrollView.reflectScrolledClipView(clip)
            harness.dockWindow.displayIfNeeded()
            slowestScroll = max(slowestScroll, Date().timeIntervalSince(step))
        }
        // A drag across 150 slots sends nothing until the drop.
        let first = try harness.tile("第1章")
        let requests = model.requests, renders = canvas.renders
        var slowestDrag: TimeInterval = 0
        canvas.mouseDown(with: harness.event(.leftMouseDown, NSPoint(x: first.midX, y: first.midY)))
        for step in 1...40 {
            let point = NSPoint(x: first.midX + (M.slotCenter(150) + 30 - first.midX) * CGFloat(step) / 40, y: first.midY)
            let moved = Date()
            canvas.mouseDragged(with: harness.event(.leftMouseDragged, point))
            slowestDrag = max(slowestDrag, Date().timeIntervalSince(moved))
        }
        try require(model.requests == requests && canvas.renders == renders, "The drag across 200 tiles read or rendered")
        let drop = Date()
        canvas.mouseUp(with: harness.event(.leftMouseUp, NSPoint(x: M.slotCenter(150) + 30, y: first.midY)))
        slowestDrag = max(slowestDrag, Date().timeIntervalSince(drop))
        try harness.settled()
        try require(model.graph.bookIndex(of: try harness.chapter("第1章").id) == 150, "The chapter did not move to slot 150")
        try require(try harness.journal.originals(since: mark) == [["field.set node"]], "The large book wrote more than the move")
        let slowest = max(harness.controller.slowestPass, harness.slowestWait, slowestScroll, slowestDrag)
        print("bottom-timeline-timing open=\(Int(opening * 1000))ms slowest-render=\(Int(harness.controller.slowestPass * 1000))ms slowest-wait=\(Int(harness.slowestWait * 1000))ms slowest-scroll=\(Int(slowestScroll * 1000))ms slowest-drag=\(Int(slowestDrag * 1000))ms")
        try require(slowest < 0.1, "A main-thread pass took \(Int(slowest * 1000)) ms")
        try harness.close()
    }
}
