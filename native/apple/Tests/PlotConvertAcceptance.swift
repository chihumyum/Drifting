import AppKit

/// 情节规划格 and drift conversions through the real tab host, pages, dock,
/// grid canvas, 漂流 panel and view models over the Rust workspace, SQLite
/// and `settings.json`, wired as AppDelegate wires them. Clicks and keys
/// are synthesized events sent to the grid, text goes through its editor,
/// and a private pasteboard stands in for the general one. Every title and
/// cell is synthetic.
extension BindingAcceptance {
    static func plotConvertAcceptance() throws -> [String] {
        try plotDockAndKeyboard()
        try plotRowsAndColumns()
        try plotPasteAndLimits()
        try plotPanesAndRelaunch()
        try convertToChapterFollows()
        try convertToElementAndConflict()
        try plotLoadingAndWaits()
        try convertToElementCarries()
        return [
            "AppKit 情节规划格 toggles below a chapter's prose from the page header and 视图 › 情节规划格, remembered per page in settings.json, starts from an unsaved 3×3 template written by the first edit as one original, edits cells by click and Return with Tab, ⇧Tab and arrows moving, ⌥Return for a new line, Esc cancelling and Delete clearing, writes nothing for unchanged edits, and never touches the Yjs body, its undo history or word counts",
            "AppKit 情节规划格 rows and columns are added after the selection or at the end with their header then edited, renamed by double-click, moved by the header menu and by dragging a header with one order original each (a drop in place writes nothing), and deleted at once when empty or after confirmation when they hold text, with 取消 writing nothing",
            "AppKit 情节规划格 pastes a tab-separated block from a cell or from the cell editor as one original that adds the rows and columns it needs, and sets the cell size within Rust's limits from the dock while an out-of-range size or an over-long cell is refused in Chinese with nothing written and the grid restored from Rust",
            "AppKit 情节规划格 in two panes of one chapter shares one grid so each follows the other's edits, 隐藏 hides it for the page in both panes, a grid written elsewhere is read again, a drift page has its own planner, the dock height drags and is remembered, docks, heights and grids survive a cold relaunch, and 彻底删除 of a drift takes its grid and remembered dock",
            "AppKit 转为章节… from the drift page and the 漂流 panel asks for the primary storyline or none and converts in one original: the drift's tab becomes the chapter's tab with the same body and 情节规划格, and the chapter list, 整书大纲, 全书长卷, story graph, 底部时间轴 and 漂流 panel follow with its act notes and timeline marker released; 取消 writes nothing",
            "AppKit 转为设定… from the drift page and the 漂流 panel creates the element with the drift's title, summary and body in the chosen category, moves the drift to the trash, closes its tab and opens the element page, while a title already used by an element is refused in Chinese before anything is written and the drift page stays open",
            plotConvertReviewCases[0], plotConvertReviewCases[1],
        ]
    }

    static let plotConvertReviewCases = [
        "AppKit 情节规划格 accepts no edit before its first read replies (the dock reads 正在读取… and edits then change the stored grid, never a template over it), shows the blank template again when Rust answers a write with no grid, holds navigation while a gesture is queued, and closing a tab or the workspace, trashing and converting commit the cell being edited and wait for queued gestures, while a refused gesture keeps the page with Rust's reason and a wait that runs out refuses in Chinese",
        "AppKit 转为设定… says what moves and what stays, carries relations whose type allows an element and notes on the whole drift to the element and reports the counts, the element's and chapter's 关系 sections, the 设定总览 and 审阅 follow, a note anchored in the drift's text stays with it in the trash and returns on restore, and a conversion that stopped after the element was created shows Rust's message, reads the lists again and keeps the drift's tab (reopening a released body) unless the drift is in the trash",
    ]

    // MARK: Harness

    private final class PlotHarness {
        let root: URL
        let directory: URL
        private(set) var workspace: LabWorkspaceCore
        let project: WorkspaceProject
        let journal: JournalProbe
        private(set) var chapters: [WorkspaceChapter] = []
        private(set) var window: NSWindow
        private(set) var host: MacChapterWorkspace
        private(set) var settings: LabSettingsStore
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("cc.drifting.native-lab.plot-acceptance.\(UUID().uuidString)"))
        /// Answers the next alerts; nil cancels.
        var answer: ((NSAlert) -> NSApplication.ModalResponse)?
        private(set) var alerts: [String] = []
        /// Each alert's informative text, in the same order.
        private(set) var details: [String] = []

        init(titles: [String], name: String = "情节规划合成项目") throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            directory = root.appendingPathComponent("apple-native-lab")
            journal = JournalProbe(directory: directory)
            let workspace = LabWorkspaceCore(directory: directory)
            self.workspace = workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(listed.isEmpty, "Plot fixture was not isolated")
            project = try BindingAcceptance.elementResult { workspace.createProject(name: name, completion: $0) }
            let projectID = project.id
            for title in titles {
                chapters.append(try BindingAcceptance.elementResult { workspace.createChapter(projectID: projectID, title: title, completion: $0) })
            }
            (window, host) = BindingAcceptance.elementHost(workspace)
            settings = LabSettingsStore(directory: workspace.dataDirectory)
            wire()
        }

        /// As AppDelegate wires the tab host.
        private func wire() {
            host.plotPlannerSettings = settings
            host.presentAlert = { [weak self] alert, _, done in
                alert.layout()
                self?.alerts.append(alert.messageText)
                self?.details.append(alert.informativeText)
                done(self?.answer?(alert) ?? .alertSecondButtonReturn)
            }
        }

        var projectID: String { project.id }

        func chapter(_ title: String) throws -> WorkspaceChapter {
            guard let chapter = chapters.first(where: { $0.title == title }) else { throw LabError.message("No chapter \(title)") }
            return chapter
        }

        @discardableResult
        func open(_ chapter: WorkspaceChapter, pane: Int? = nil) throws -> NativeDocumentView {
            let project = self.project, host = self.host
            let view: NativeDocumentView = try BindingAcceptance.elementResult { host.open(project: project, chapter: chapter, in: pane, completion: $0) }
            try settled(view)
            return view
        }

        func settled(_ views: NativeDocumentView...) throws {
            try BindingAcceptance.wait { !self.host.isBusy && views.allSatisfy { $0.binding.state != nil && !$0.binding.hasPendingWork } }
        }

        func chapterPage(_ id: String, pane: Int = 0) throws -> MacChapterPageView {
            guard let page = host.retainedChapterPage(pane: pane, scope: ChapterScope(projectID: projectID, chapterID: id)) else {
                throw LabError.message("Pane \(pane) has no chapter page \(id)")
            }
            return page
        }

        /// The page's dock once its grid was read, laid out.
        func dock(_ nodeID: String, pane: Int = 0) throws -> MacPlotPlannerDock {
            guard let dock = host.retainedPlotDock(pane: pane, nodeID: nodeID) else { throw LabError.message("Pane \(pane) shows no 情节规划格 for \(nodeID)") }
            try gridSettled(dock.model)
            window.contentView?.layoutSubtreeIfNeeded()
            return dock
        }

        func gridSettled(_ model: PlotGridModel) throws {
            try BindingAcceptance.wait { model.loaded && !model.busy }
        }

        func event(_ type: NSEvent.EventType, _ canvas: PlotGridCanvas, _ point: NSPoint, clicks: Int = 1) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: canvas.convert(point, to: nil), modifierFlags: [],
                               timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                               context: nil, eventNumber: 0, clickCount: clicks, pressure: type == .leftMouseUp ? 0 : 1)!
        }

        func click(_ canvas: PlotGridCanvas, _ target: PlotGridCanvas.Target, clicks: Int = 1) {
            let rect = canvas.rect(of: target), point = NSPoint(x: rect.midX, y: rect.midY)
            canvas.mouseDown(with: event(.leftMouseDown, canvas, point, clicks: clicks))
            canvas.mouseUp(with: event(.leftMouseUp, canvas, point, clicks: clicks))
        }

        func drag(_ canvas: PlotGridCanvas, from start: NSPoint, to end: NSPoint) {
            canvas.mouseDown(with: event(.leftMouseDown, canvas, start))
            for step in 1...4 {
                let t = CGFloat(step) / 4
                canvas.mouseDragged(with: event(.leftMouseDragged, canvas, NSPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)))
            }
            canvas.mouseUp(with: event(.leftMouseUp, canvas, end))
        }

        /// A key press delivered to the focused grid.
        func key(_ canvas: PlotGridCanvas, _ code: UInt16, _ characters: String, shift: Bool = false) {
            let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: shift ? .shift : [],
                                         timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                         context: nil, characters: characters, charactersIgnoringModifiers: characters,
                                         isARepeat: false, keyCode: code)!
            canvas.keyDown(with: event)
        }

        /// Text typed into the open cell editor.
        func type(_ canvas: PlotGridCanvas, _ text: String) {
            canvas.editor.insertText(text, replacementRange: canvas.editor.selectedRange())
        }

        /// A key binding in the open cell editor (Return, Tab, Esc, …).
        func command(_ canvas: PlotGridCanvas, _ selector: Selector) {
            canvas.editor.doCommand(by: selector)
        }

        func stored(_ nodeID: String) throws -> WorkspacePlotGrid? {
            let projectID = self.projectID, workspace = self.workspace
            let reply: WorkspacePlotGridReply = try BindingAcceptance.elementResult {
                workspace.plotGrid(projectID: projectID, nodeID: nodeID, ops: [], completion: $0)
            }
            return reply.grid
        }

        func counts() throws -> [String: Int?] {
            let projectID = self.projectID, workspace = self.workspace
            let counts: WorkspaceWordCounts = try BindingAcceptance.elementResult { workspace.wordCounts(projectID: projectID, completion: $0) }
            return Dictionary(counts.counts.map { ($0.nodeId, $0.wordCount) }, uniquingKeysWith: { first, _ in first })
        }

        /// The kinds a batch of originals touched, e.g. `field.set plot-grid-cell`.
        func written(since mark: Int64) throws -> [[String]] { try journal.originals(since: mark) }

        func coldReopen() throws {
            try close()
            try reopen()
        }

        /// A new workspace, tab host and store over the same files, after the
        /// old host was closed.
        func reopen() throws {
            let reopened = LabWorkspaceCore(directory: directory)
            workspace = reopened
            let projects: [WorkspaceProject] = try BindingAcceptance.elementResult { reopened.projects(completion: $0) }
            try BindingAcceptance.require(projects.map(\.id).contains(project.id), "Cold reopen lost the project")
            (window, host) = BindingAcceptance.elementHost(reopened)
            settings = LabSettingsStore(directory: reopened.dataDirectory)
            wire()
        }

        func close() throws {
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let host = self.host
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "Plot workspace failed to close")
            window.close()
        }

        func remove() {
            pasteboard.releaseGlobally()
            try? FileManager.default.removeItem(at: root)
        }
    }

    private static func plotRequire(_ condition: @autoclosure () throws -> Bool, _ message: @autoclosure () -> String) throws {
        if try condition() == false { throw LabError.message(message()) }
    }

    /// Waits for a view to follow (refreshes run without a busy flag).
    private static func eventually(_ condition: () throws -> Bool, _ message: @autoclosure () -> String) throws {
        let deadline = Date().addingTimeInterval(15)
        while (try? condition()) != true && Date() < deadline {
            _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
        try plotRequire(try condition(), message())
    }

    /// Every mutation of the originals is a 情节规划格 one.
    private static func onlyPlotGrid(_ originals: [[String]]) -> Bool {
        originals.joined().allSatisfy { $0.hasSuffix(" plot-grid-row") || $0.hasSuffix(" plot-grid-column") || $0.hasSuffix(" plot-grid-cell")
            || $0 == "tuple.set node-content" }
    }

    // MARK: (a) Dock, template and keyboard editing

    private static func plotDockAndKeyboard() throws {
        let harness = try PlotHarness(titles: ["启程", "雨夜"])
        defer { harness.remove() }
        let start = try harness.chapter("启程"), host = harness.host
        let view = try harness.open(start)
        // Prose first: its revision, history and count must not move.
        view.textView.setSelectedRange(NSRange(location: 0, length: 0))
        view.textView.insertText("北塔在雨里。", replacementRange: NSRange(location: 0, length: 0))
        try harness.settled(view)
        let prose = view.binding.state!.projection
        try plotRequire(prose.text == "北塔在雨里。" && prose.canUndo, "The chapter body was not typed")
        let counts = try harness.counts()
        try plotRequire((counts[start.id] ?? nil).map { $0 > 0 } == true, "The chapter has no count: \(counts)")
        var mark = try harness.journal.mark()

        // The page header toggles the dock; settings.json remembers it.
        let page = try harness.chapterPage(start.id)
        try plotRequire(page.plotDock == nil && page.plotPlannerButton.state == .off && !host.isActivePlotPlannerShown && host.canTogglePlotPlanner,
                        "A new page showed a 情节规划格")
        page.plotPlannerButton.performClick(nil)
        let dock = try harness.dock(start.id)
        try plotRequire(page.plotDock === dock && page.plotPlannerButton.state == .on && host.isActivePlotPlannerShown,
                        "The header toggle did not show the dock")
        try plotRequire(harness.settings.plotPlanner(projectID: harness.projectID, nodeID: start.id) == PlotPlannerSetting(shown: true),
                        "settings.json did not remember the dock")
        try plotRequire(try String(contentsOf: harness.settings.fileURL, encoding: .utf8).contains("\"plotPlanners\""), "settings.json lacks plotPlanners")
        let canvas = dock.canvas, model = dock.model
        try plotRequire(model.stored == nil && canvas.grid.rows.count == 3 && canvas.grid.columns.count == 3 && canvas.grid.cells.isEmpty
                        && dock.hintText.contains("空白规划格") && dock.sizeLabel.stringValue == "184 × 96",
                        "The dock did not show the blank 3×3 template: \(canvas.grid)")
        // 视图 › 情节规划格 hides and shows it again.
        host.toggleActivePlotPlanner()
        try plotRequire(page.plotDock == nil && !host.isActivePlotPlannerShown
                        && harness.settings.plotPlanner(projectID: harness.projectID, nodeID: start.id)?.shown == false, "The menu did not hide the dock")
        host.toggleActivePlotPlanner()
        let shown = try harness.dock(start.id)
        try plotRequire(shown.model === model && page.plotPlannerButton.state == .on, "The menu did not show the page's dock again")
        try harness.journal.expect([], since: mark, "Showing, hiding and the template")
        try plotRequire(model.sentBatches.isEmpty, "Showing the dock wrote \(model.sentBatches)")

        // Click a cell, type, Tab: the template and the cell in one original.
        let template = canvas.grid
        let (r0, r1, r2) = (template.rows[0].id, template.rows[1].id, template.rows[2].id)
        let (c0, c1, c2) = (template.columns[0].id, template.columns[1].id, template.columns[2].id)
        let canvasNow = shown.canvas
        harness.click(canvasNow, .cell(row: r0, column: c0))
        try plotRequire(canvasNow.editing == .cell(row: r0, column: c0) && harness.window.firstResponder === canvasNow.editor,
                        "A click did not edit the cell")
        harness.type(canvasNow, "林岚")
        harness.command(canvasNow, #selector(NSResponder.insertTab(_:)))
        try plotRequire(canvasNow.editing == .cell(row: r0, column: c1), "Tab did not move to the next cell")
        try harness.gridSettled(model)
        let written = try harness.written(since: mark)
        try plotRequire(written.count == 1 && model.sentBatches.count == 1, "The first edit wrote \(written)")
        try plotRequire(written[0].filter { $0 == "entity.create plot-grid-row" }.count == 3
                        && written[0].filter { $0 == "entity.create plot-grid-column" }.count == 3
                        && written[0].contains("entity.create plot-grid-cell") && onlyPlotGrid(written),
                        "The template original was \(written[0])")
        let first = try harness.stored(start.id)
        try plotRequire(first?.rows.map(\.id) == [r0, r1, r2] && first?.columns.map(\.id) == [c0, c1, c2]
                        && first?.value(row: r0, column: c0) == "林岚" && first?.cellWidth == 184, "Rust stored \(String(describing: first))")
        try plotRequire(dock.hintText.isEmpty, "The dock still called the grid unsaved")

        // Esc cancels: nothing written, the cell stays empty.
        harness.type(canvasNow, "不写")
        harness.command(canvasNow, #selector(NSResponder.cancelOperation(_:)))
        try plotRequire(canvasNow.editing == nil && canvasNow.selection == .cell(row: r0, column: c1)
                        && harness.window.firstResponder === canvasNow, "Esc did not end the edit on the cell")
        // Arrows move; Return edits; Return commits.
        harness.key(canvasNow, 125, "\u{F701}")
        try plotRequire(canvasNow.selection == .cell(row: r1, column: c1), "↓ did not move: \(String(describing: canvasNow.selection))")
        harness.key(canvasNow, 123, "\u{F702}")
        harness.key(canvasNow, 126, "\u{F700}")
        harness.key(canvasNow, 124, "\u{F703}")
        harness.key(canvasNow, 124, "\u{F703}")
        try plotRequire(canvasNow.selection == .cell(row: r0, column: c2), "Arrows moved to \(String(describing: canvasNow.selection))")
        harness.key(canvasNow, 48, "\t", shift: true)
        try plotRequire(canvasNow.selection == .cell(row: r0, column: c1), "⇧Tab did not move back")
        mark = try harness.journal.mark()
        harness.key(canvasNow, 36, "\r")
        try plotRequire(canvasNow.editing == .cell(row: r0, column: c1), "Return did not edit the cell")
        harness.type(canvasNow, "北塔")
        harness.command(canvasNow, #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)))
        harness.type(canvasNow, "雨夜")
        harness.command(canvasNow, #selector(NSResponder.insertNewline(_:)))
        try plotRequire(canvasNow.editing == nil && canvasNow.selection == .cell(row: r0, column: c1), "Return did not commit")
        try harness.gridSettled(model)
        try harness.journal.expect([["entity.create plot-grid-cell", "field.set plot-grid-cell"]], since: mark, "A new cell")
        try plotRequire(try harness.stored(start.id)?.value(row: r0, column: c1) == "北塔\n雨夜", "⌥Return did not keep a new line")
        // ⇧Tab from an edit commits and edits the previous cell.
        harness.key(canvasNow, 36, "\r")
        harness.command(canvasNow, #selector(NSResponder.insertBacktab(_:)))
        try plotRequire(canvasNow.editing == .cell(row: r0, column: c0), "⇧Tab did not edit the previous cell")
        // Unchanged: committing the stored text writes nothing.
        mark = try harness.journal.mark()
        let batches = model.sentBatches.count
        harness.command(canvasNow, #selector(NSResponder.insertNewline(_:)))
        harness.click(canvasNow, .cell(row: r0, column: c0))
        harness.command(canvasNow, #selector(NSResponder.insertTab(_:)))
        harness.command(canvasNow, #selector(NSResponder.cancelOperation(_:)))
        try harness.gridSettled(model)
        try harness.journal.expect([], since: mark, "Unchanged edits")
        try plotRequire(model.sentBatches.count == batches, "Unchanged edits sent \(model.sentBatches.suffix(2))")
        // Typing on a selected cell edits it; Delete clears a cell.
        canvasNow.select(.cell(row: r1, column: c0))
        harness.window.makeFirstResponder(canvasNow)
        harness.key(canvasNow, 0, "a")
        try plotRequire(canvasNow.editing == .cell(row: r1, column: c0) && canvasNow.editor.string == "a", "Typing did not start an edit")
        harness.type(canvasNow, "阿")
        harness.command(canvasNow, #selector(NSResponder.insertNewline(_:)))
        try harness.gridSettled(model)
        try plotRequire(model.grid.value(row: r1, column: c0) == "a阿", "The typed cell reads \(model.grid.value(row: r1, column: c0))")
        mark = try harness.journal.mark()
        harness.key(canvasNow, 51, "\u{7F}")
        try harness.gridSettled(model)
        try harness.journal.expect([["field.set plot-grid-cell"]], since: mark, "Delete")
        try plotRequire(model.grid.value(row: r1, column: c0).isEmpty, "Delete did not clear the cell")

        // Hiding the dock keeps a cell being edited.
        harness.click(canvasNow, .cell(row: r2, column: c2))
        harness.type(canvasNow, "收起前")
        host.toggleActivePlotPlanner()
        try harness.gridSettled(model)
        try plotRequire(page.plotDock == nil && model.stored?.value(row: r2, column: c2) == "收起前", "Hiding lost the cell being edited")

        // The prose is untouched: text, revision, history and counts.
        let after = view.binding.state!.projection
        try plotRequire(after.text == prose.text && after.revision == prose.revision && after.canUndo == prose.canUndo
                        && after.canRedo == prose.canRedo, "The grid changed the chapter body or its history")
        try plotRequire(try harness.counts() == counts, "The grid changed word counts")
        view.binding.history(redo: false)
        try harness.settled(view)
        let kept = try harness.stored(start.id)?.value(row: r0, column: c0)
        try plotRequire(view.binding.state!.projection.text.isEmpty && kept == "林岚", "⌘Z on the prose did not undo only the typing")
        try harness.close()
    }

    // MARK: (b) Rows and columns

    private static func plotRowsAndColumns() throws {
        let harness = try PlotHarness(titles: ["启程"])
        defer { harness.remove() }
        let start = try harness.chapter("启程")
        try harness.open(start)
        harness.host.setPlotPlanner(shown: true, projectID: harness.projectID, nodeID: start.id)
        let dock = try harness.dock(start.id), canvas = dock.canvas, model = dock.model
        let (r0, c0, c1, c2) = (canvas.grid.rows[0].id, canvas.grid.columns[0].id, canvas.grid.columns[1].id, canvas.grid.columns[2].id)
        // Double-click renames a row header.
        harness.click(canvas, .row(r0), clicks: 2)
        try plotRequire(canvas.editing == .row(r0), "Double-click did not rename the row")
        harness.type(canvas, "  人物 ")
        harness.command(canvas, #selector(NSResponder.insertNewline(_:)))
        try harness.gridSettled(model)
        try plotRequire(model.stored?.rows.first?.label == "人物", "The row label is \(String(describing: model.stored?.rows.first))")

        // 添加行 after the selected row, its header then edited.
        canvas.select(.cell(row: r0, column: c1))
        var mark = try harness.journal.mark()
        dock.addRowButton.performClick(nil)
        guard case .row(let added)? = canvas.editing else { throw LabError.message("添加行 did not edit the new header") }
        try plotRequire(model.grid.rows.map(\.id).firstIndex(of: added) == 1, "The row was not added after the selection")
        harness.type(canvas, "地点")
        harness.command(canvas, #selector(NSResponder.insertNewline(_:)))
        try harness.gridSettled(model)
        var written = try harness.written(since: mark)
        try plotRequire(written == [["entity.create plot-grid-row", "field.set plot-grid-row", "order.move plot-grid-row"], ["field.set plot-grid-row"]],
                        "添加行 and naming wrote \(written)")
        try plotRequire(model.stored?.rows[1] == WorkspacePlotGrid.Axis(id: added, label: "地点") && model.stored?.rows.count == 4,
                        "Rust stored rows \(String(describing: model.stored?.rows))")
        // 添加列 with nothing selected: at the end; Esc leaves it unnamed.
        canvas.select(nil)
        dock.addColumnButton.performClick(nil)
        guard case .column(let tail)? = canvas.editing else { throw LabError.message("添加列 did not edit the new header") }
        harness.command(canvas, #selector(NSResponder.cancelOperation(_:)))
        try harness.gridSettled(model)
        try plotRequire(model.stored?.columns.map(\.id) == [c0, c1, c2, tail] && model.stored?.columns.last?.label == "", "添加列 was not at the end")

        // The header menu moves a row down; a drag moves a column.
        mark = try harness.journal.mark()
        guard let down = canvas.menuItems(for: .row(r0)).first(where: { $0.accessibilityIdentifier() == "plot-row-move-forward" }) as? LibraryMenuItem,
              down.isEnabled else { throw LabError.message("No enabled 下移") }
        down.press()
        try harness.gridSettled(model)
        try harness.journal.expect([["order.rebalance plot-grid-row"]], since: mark, "下移")
        try plotRequire(model.stored?.rows.prefix(2).map(\.id) == [added, r0], "下移 left \(String(describing: model.stored?.rows.map(\.label)))")
        mark = try harness.journal.mark()
        let from = canvas.rect(of: .column(c0))
        harness.drag(canvas, from: NSPoint(x: from.midX, y: from.midY), to: NSPoint(x: canvas.rect(of: .column(c2)).maxX - 2, y: from.midY))
        try harness.gridSettled(model)
        try harness.journal.expect([["order.rebalance plot-grid-column"]], since: mark, "Dragging a column")
        try plotRequire(model.stored?.columns.map(\.id) == [c1, c2, c0, tail], "The drag left columns \(String(describing: model.stored?.columns.map(\.id)))")
        mark = try harness.journal.mark()
        let own = canvas.rect(of: .column(c2))
        harness.drag(canvas, from: NSPoint(x: own.midX, y: own.midY), to: NSPoint(x: own.midX + 8, y: own.midY + 2))
        try harness.gridSettled(model)
        try harness.journal.expect([], since: mark, "A drop in place")

        // Deleting: an empty column at once; one with text after confirmation.
        _ = model.perform([.setCell(row: r0, column: c1, value: "北塔"), .setCell(row: added, column: c1, value: "灯塔")])
        try harness.gridSettled(model)
        mark = try harness.journal.mark()
        guard let deleteEmpty = canvas.menuItems(for: .column(tail)).first(where: { $0.accessibilityIdentifier() == "plot-column-delete" }) as? LibraryMenuItem
        else { throw LabError.message("No 删除此列") }
        try plotRequire(deleteEmpty.title == "删除此列", "An empty column asks: \(deleteEmpty.title)")
        deleteEmpty.press()
        try harness.gridSettled(model)
        try plotRequire(harness.alerts.isEmpty, "An empty column asked for confirmation")
        try harness.journal.expect([["entity.purge plot-grid-column"]], since: mark, "Deleting an empty column")
        guard let deleteFilled = canvas.menuItems(for: .column(c1)).first(where: { $0.accessibilityIdentifier() == "plot-column-delete" }) as? LibraryMenuItem
        else { throw LabError.message("No 删除此列…") }
        try plotRequire(deleteFilled.title == "删除此列…", "A column with text reads \(deleteFilled.title)")
        mark = try harness.journal.mark()
        harness.answer = nil
        deleteFilled.press()
        try plotRequire(harness.alerts.last == "删除这一列？", "No confirmation: \(harness.alerts)")
        try harness.journal.expect([], since: mark, "取消")
        harness.answer = { _ in .alertFirstButtonReturn }
        deleteFilled.press()
        try harness.gridSettled(model)
        written = try harness.written(since: mark)
        try plotRequire(written == [["entity.purge plot-grid-cell", "entity.purge plot-grid-cell", "entity.purge plot-grid-column"]],
                        "Deleting a column with text wrote \(written)")
        try plotRequire(model.stored?.columns.map(\.id) == [c2, c0] && model.stored?.cells.isEmpty == true, "The column or its cells remain")
        // The last column stays.
        _ = model.perform([.removeAxis(.column, id: c2)])
        try harness.gridSettled(model)
        let last = canvas.menuItems(for: .column(c0)).first { $0.accessibilityIdentifier() == "plot-column-delete" }
        try plotRequire(last?.isEnabled == false, "The last column could be deleted")
        try harness.close()
    }

    // MARK: (c) Paste and limits

    private static func plotPasteAndLimits() throws {
        let harness = try PlotHarness(titles: ["启程"])
        defer { harness.remove() }
        let start = try harness.chapter("启程")
        try harness.open(start)
        harness.host.setPlotPlanner(shown: true, projectID: harness.projectID, nodeID: start.id)
        let dock = try harness.dock(start.id), canvas = dock.canvas, model = dock.model
        canvas.pasteboard = harness.pasteboard
        // Written first so the paste adds to a stored grid.
        _ = model.perform([.setCell(row: canvas.grid.rows[0].id, column: canvas.grid.columns[0].id, value: "序")])
        try harness.gridSettled(model)
        let rows = model.grid.rows.map(\.id), columns = model.grid.columns.map(\.id)

        // A 3-line block from (1, 1): one more row and two more columns, one original.
        harness.pasteboard.clearContents()
        harness.pasteboard.setString("甲\t乙\t丙\r\n丁\t\t己\n庚\t辛\t壬\t癸\n", forType: .string)
        canvas.select(.cell(row: rows[1], column: columns[1]))
        var mark = try harness.journal.mark()
        let batches = model.sentBatches.count
        canvas.paste(nil)
        try harness.gridSettled(model)
        let written = try harness.written(since: mark)
        try plotRequire(written.count == 1 && model.sentBatches.count == batches + 1, "The paste wrote \(written.count) originals")
        try plotRequire(written[0].filter { $0 == "entity.create plot-grid-row" }.count == 1
                        && written[0].filter { $0 == "entity.create plot-grid-column" }.count == 2
                        && written[0].filter { $0 == "entity.create plot-grid-cell" }.count == 9, "The paste original was \(written[0])")
        let pasted = try harness.stored(start.id)
        try plotRequire(pasted?.rows.count == 4 && pasted?.columns.count == 5, "The paste grew the grid to \(String(describing: pasted.map { ($0.rows.count, $0.columns.count) }))")
        if let pasted {
            let text = pasted.rows[1...3].map { row in pasted.columns[1...4].map { pasted.value(row: row.id, column: $0.id) } }
            try plotRequire(text == [["甲", "乙", "丙", ""], ["丁", "", "己", ""], ["庚", "辛", "壬", "癸"]], "The block landed as \(text)")
        }
        // Pasting a block into the cell editor fills from the edited cell.
        harness.pasteboard.clearContents()
        harness.pasteboard.setString("东\t西", forType: .string)
        harness.click(canvas, .cell(row: rows[0], column: columns[0]))
        mark = try harness.journal.mark()
        canvas.editor.paste(nil)
        try harness.gridSettled(model)
        try harness.journal.expect([["field.set plot-grid-cell", "entity.create plot-grid-cell", "field.set plot-grid-cell"]], since: mark, "Editor paste")
        try plotRequire(canvas.editing == nil && model.grid.value(row: rows[0], column: columns[0]) == "东"
                        && model.grid.value(row: rows[0], column: columns[1]) == "西", "The editor paste did not fill two cells")
        // Pasting the same block again changes nothing.
        mark = try harness.journal.mark()
        canvas.select(.cell(row: rows[0], column: columns[0]))
        canvas.paste(nil)
        try harness.gridSettled(model)
        try harness.journal.expect([], since: mark, "The same paste again")

        // Size: the sliders stay within Rust's limits; one original each.
        try plotRequire(dock.widthSlider.minValue == 120 && dock.widthSlider.maxValue == 440
                        && dock.heightSlider.minValue == 56 && dock.heightSlider.maxValue == 380, "The sliders have other limits")
        mark = try harness.journal.mark()
        dock.widthSlider.doubleValue = 300.4
        dock.widthSlider.sendAction(dock.widthSlider.action, to: dock.widthSlider.target)
        try harness.gridSettled(model)
        dock.heightSlider.doubleValue = 1_000
        dock.heightSlider.sendAction(dock.heightSlider.action, to: dock.heightSlider.target)
        try harness.gridSettled(model)
        try harness.journal.expect([["tuple.set node-content"], ["tuple.set node-content"]], since: mark, "Two sizes")
        try plotRequire(model.stored?.cellWidth == 300 && model.stored?.cellHeight == 380 && dock.sizeLabel.stringValue == "300 × 380"
                        && canvas.rect(of: .cell(row: rows[0], column: columns[0])).size == NSSize(width: 300, height: 380),
                        "The size is \(String(describing: model.stored.map { ($0.cellWidth, $0.cellHeight) })) / \(dock.sizeLabel.stringValue)")
        // Out of range, or a cell over 10,000 characters: refused in Chinese, nothing written.
        mark = try harness.journal.mark()
        _ = model.perform([.setSize(width: 90, height: 96)])
        try harness.gridSettled(model)
        try plotRequire(dock.errorMessage?.contains("格子宽度须在 120–440") == true && model.grid.cellWidth == 300 && canvas.grid.cellWidth == 300,
                        "The size refusal read \(String(describing: dock.errorMessage)) with width \(model.grid.cellWidth)")
        harness.pasteboard.clearContents()
        harness.pasteboard.setString(String(repeating: "长", count: 10_001) + "\t尾", forType: .string)
        canvas.select(.cell(row: rows[0], column: columns[0]))
        canvas.paste(nil)
        try plotRequire(model.grid.value(row: rows[0], column: columns[1]) == "尾", "The refused paste was not shown while sent")
        try harness.gridSettled(model)
        try plotRequire(dock.errorMessage?.contains("最多 10000 字") == true && model.grid.value(row: rows[0], column: columns[0]) == "东"
                        && model.grid.value(row: rows[0], column: columns[1]) == "西", "The over-long paste was not restored: \(String(describing: dock.errorMessage))")
        try harness.journal.expect([], since: mark, "Refused size and text")
        // The next accepted gesture clears the message.
        _ = model.perform([.setCell(row: rows[0], column: columns[0], value: "东方")])
        try harness.gridSettled(model)
        try plotRequire(dock.errorMessage == nil, "The refusal stayed after a later edit")
        try harness.close()
    }

    // MARK: (d) Two panes, elsewhere, drift pages, height and cold relaunch

    private static func plotPanesAndRelaunch() throws {
        let harness = try PlotHarness(titles: ["启程", "雨夜"])
        defer { harness.remove() }
        let start = try harness.chapter("启程"), host = harness.host, projectID = harness.projectID
        try harness.open(start)
        host.setPlotPlanner(shown: true, projectID: projectID, nodeID: start.id)
        let left = try harness.dock(start.id, pane: 0)
        let split: NativeDocumentView = try elementResult { host.split(completion: $0) }
        try harness.settled(split)
        let right = try harness.dock(start.id, pane: 1)
        try plotRequire(left !== right && left.model === right.model, "The two panes do not share one grid")
        let rows = left.canvas.grid.rows.map(\.id), columns = left.canvas.grid.columns.map(\.id)
        try plotRequire(right.canvas.grid.rows.map(\.id) == rows, "The panes show different templates")
        // An edit in either pane shows in the other.
        harness.click(left.canvas, .cell(row: rows[0], column: columns[0]))
        harness.type(left.canvas, "左栏")
        harness.command(left.canvas, #selector(NSResponder.insertNewline(_:)))
        try harness.gridSettled(left.model)
        try plotRequire(right.canvas.grid.value(row: rows[0], column: columns[0]) == "左栏", "The right pane did not follow")
        right.canvas.select(.cell(row: rows[2], column: columns[0]))
        right.addRowButton.performClick(nil)
        harness.type(right.canvas, "右栏行")
        harness.command(right.canvas, #selector(NSResponder.insertNewline(_:)))
        try harness.gridSettled(right.model)
        try plotRequire(left.canvas.grid.rows.count == 4 && left.canvas.grid.rows.last?.label == "右栏行", "The left pane did not follow")
        // Written elsewhere: read again when told.
        let workspace = harness.workspace
        let _: WorkspacePlotGridReply = try elementResult {
            workspace.plotGrid(projectID: projectID, nodeID: start.id, ops: [.setCell(row: rows[1], column: columns[1], value: "别处")], completion: $0)
        }
        try plotRequire(left.canvas.grid.value(row: rows[1], column: columns[1]).isEmpty, "The dock read before it was told")
        host.refreshPlotGrids(projectID: projectID)
        try harness.gridSettled(left.model)
        try plotRequire(left.canvas.grid.value(row: rows[1], column: columns[1]) == "别处"
                        && right.canvas.grid.value(row: rows[1], column: columns[1]) == "别处", "A grid written elsewhere was not read again")

        // The dock's top edge drags; the height is remembered per page.
        let handle = left.resizeHandle
        let before = left.height
        let down = NSEvent.mouseEvent(with: .leftMouseDown, location: NSPoint(x: 10, y: 100), modifierFlags: [], timestamp: 0,
                                      windowNumber: harness.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        let moved = NSEvent.mouseEvent(with: .leftMouseDragged, location: NSPoint(x: 10, y: 160), modifierFlags: [], timestamp: 0,
                                       windowNumber: harness.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        let up = NSEvent.mouseEvent(with: .leftMouseUp, location: NSPoint(x: 10, y: 180), modifierFlags: [], timestamp: 0,
                                    windowNumber: harness.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 0)!
        handle.mouseDown(with: down); handle.mouseDragged(with: moved)
        try plotRequire(left.height == before + 60, "Dragging did not resize: \(left.height)")
        handle.mouseUp(with: up)
        try plotRequire(left.height == before + 80 && right.height == before + 80
                        && harness.settings.plotPlanner(projectID: projectID, nodeID: start.id)?.height == Double(before + 80),
                        "The height was not remembered for the page")
        // 隐藏 hides it for the page in both panes.
        right.hideButton.performClick(nil)
        try plotRequire(host.retainedPlotDock(pane: 0, nodeID: start.id) == nil && host.retainedPlotDock(pane: 1, nodeID: start.id) == nil
                        && harness.settings.plotPlanner(projectID: projectID, nodeID: start.id)?.shown == false, "隐藏 left a dock")
        host.setPlotPlanner(shown: true, projectID: projectID, nodeID: start.id)
        try plotRequire(try harness.dock(start.id, pane: 1).height == before + 80, "The height was lost")

        // A drift page has its own planner.
        let drifts: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
            workspace.createDrift(projectID: projectID, title: "灵光", groupID: nil, completion: $0)
        }
        guard let drift = drifts.result else { throw LabError.message("No drift") }
        host.applyDriftLibrary(projectID: projectID, library: drifts.library)
        let driftView: NativeDocumentView = try elementResult { host.open(project: harness.project, drift: drift, in: 0, completion: $0) }
        try harness.settled(driftView)
        guard let driftPage = host.retainedDriftPage(pane: 0, scope: DriftScope(projectID: projectID, driftID: drift.id)) else {
            throw LabError.message("No drift page")
        }
        try plotRequire(driftPage.plotDock == nil && host.canTogglePlotPlanner, "The drift page showed a dock")
        driftPage.plotPlannerButton.performClick(nil)
        let driftDock = try harness.dock(drift.id)
        try plotRequire(driftDock.model !== left.model && driftDock.canvas.grid.cells.isEmpty, "The drift shares the chapter's grid")
        _ = driftDock.model.perform([.setLabel(.column, id: driftDock.canvas.grid.columns[0].id, label: "线索")])
        try harness.gridSettled(driftDock.model)
        try plotRequire(try harness.stored(drift.id)?.columns.first?.label == "线索", "The drift grid was not stored")

        // Cold relaunch: shown docks, heights and grids come back.
        let expected = try harness.stored(start.id)
        try harness.coldReopen()
        try harness.open(start)
        let reopened = try harness.dock(start.id)
        try plotRequire(reopened.height == before + 80 && reopened.canvas.grid == expected && reopened.canvas.grid.value(row: rows[1], column: columns[1]) == "别处",
                        "The relaunched dock differs: \(reopened.height)")
        let other = try harness.chapter("雨夜")
        try harness.open(other)
        try plotRequire(harness.host.retainedPlotDock(pane: 0, nodeID: other.id) == nil, "Another chapter showed a dock")
        let driftAgain: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, drift: drift, in: 0, completion: $0) }
        try harness.settled(driftAgain)
        try plotRequire(try harness.dock(drift.id).canvas.grid.columns.first?.label == "线索", "The drift dock did not come back")
        // 彻底删除 takes the planner with the drift, and its remembered dock.
        let reopenedHost = harness.host
        let _: WorkspaceDriftReply<WorkspaceDrift> = try elementResult { reopenedHost.trashDrift(projectID: projectID, driftID: drift.id, completion: $0) }
        try plotRequire(reopenedHost.retainedPlotDock(pane: 0, nodeID: drift.id) == nil, "The trashed drift kept its dock")
        let _: WorkspaceTrashPurgeReply = try elementResult {
            reopenedHost.purge(WorkspaceTrashItem(kind: .drift, id: drift.id, title: "灵光", trashedAt: ""), projectID: projectID, completion: $0)
        }
        try plotRequire(harness.settings.plotPlanner(projectID: projectID, nodeID: drift.id) == nil
                        && harness.settings.plotPlanner(projectID: projectID, nodeID: start.id)?.shown == true, "彻底删除 left the drift's dock state")
        try plotRequire(try harness.stored(drift.id) == nil, "彻底删除 left the drift's grid")
        try harness.close()
    }

    // MARK: Conversions

    /// The 漂流 panel, 整书大纲, 全书长卷, story graph and 底部时间轴 of the
    /// project, wired to the tab host as AppDelegate wires them.
    private final class Followers {
        let panelModel: DriftLibraryModel
        let panel: MacDriftLibraryViewController
        let outline: WorkspaceOutlineModel
        let book: WholeBookModel
        let graph: StoryGraphModel
        let dock: BottomTimelineModel
        /// 审阅 and the 设定总览, as AppDelegate keeps them.
        let review: ReviewModel
        let overview: ElementOverviewModel
        let host: MacChapterWorkspace
        /// The sidebar's chapter list, kept as AppDelegate keeps it.
        var chapterList: [WorkspaceChapter]
        var outcomes: [DriftConversionOutcome] = []
        var panelResults: [Result<DriftConversionOutcome, Error>?] = []

        init(_ harness: PlotHarness) throws {
            let workspace = harness.workspace, projectID = harness.projectID, host = harness.host, project = harness.project
            self.host = host
            chapterList = harness.chapters
            panelModel = DriftLibraryModel(workspace: workspace, projectID: projectID)
            panel = MacDriftLibraryViewController(model: panelModel)
            _ = panel.view
            outline = WorkspaceOutlineModel(workspace: workspace, projectID: projectID)
            book = WholeBookModel(workspace: workspace, projectID: projectID)
            graph = StoryGraphModel(workspace: workspace, projectID: projectID)
            dock = BottomTimelineModel(workspace: workspace, projectID: projectID)
            review = ReviewModel(workspace: workspace, projectID: projectID, associations: host.relations.associations(projectID: projectID))
            overview = ElementOverviewModel(workspace: workspace, projectID: projectID, relations: host.relations.model(projectID: projectID))
            let (panelModel, outline, graph, book, dock) = (self.panelModel, self.outline, self.graph, self.book, self.dock)
            let (review, overview) = (self.review, self.overview)
            host.onElementLibrary = { id, library in if id == projectID { overview.applyElementLibrary(library) } }
            host.onDriftConversionStopped = { id in if id == projectID { review.load() } }
            panelModel.onLibrary = { library in
                host.applyDriftLibrary(projectID: projectID, library: library)
                outline.applyDrifts(library); graph.applyDrifts(library); dock.graph.applyDrifts(library)
            }
            host.onDriftLibrary = { id, library in
                guard id == projectID else { return }
                panelModel.apply(library, message: nil)
                outline.applyDrifts(library); graph.applyDrifts(library); dock.graph.applyDrifts(library); overview.applyDrifts(library)
            }
            host.onStorylineLibrary = { id, library in
                guard id == projectID else { return }
                outline.applyStorylines(library); graph.applyStorylines(library); dock.graph.applyStorylines(library)
            }
            host.onOutline = { id, entries in if id == projectID { panelModel.applyActs(entries) } }
            // As AppDelegate's adoptDriftConversion and graphChaptersChanged.
            host.onDriftConverted = { [weak self] id, outcome in
                guard id == projectID else { return }
                self?.outcomes.append(outcome)
                if case .chapter(let chapter, _) = outcome, self?.chapterList.contains(where: { $0.id == chapter.id }) == false {
                    self?.chapterList.append(chapter)
                }
                graph.refresh(); dock.refresh(); book.load(); outline.load()
                if case .element = outcome { review.load() }
                panelModel.showStatus(outcome.message)
            }
            panel.canNavigate = { host.canNavigate }
            panel.presentAlert = { alert, done in host.presentAlert?(alert, nil, done) }
            panel.onOpen = { drift in host.open(project: project, drift: drift) { _ in } }
            panel.onConvert = { [weak self] drift, kind in
                host.beginConversion(kind, driftID: drift.id, project: project, from: nil) { self?.panelResults.append($0) }
            }
            panelModel.load(); outline.load(); book.load(); graph.load(); dock.load(); review.load(); overview.load()
            host.actsChanged(projectID: projectID)
            try settled()
        }

        func settled() throws {
            try BindingAcceptance.wait {
                self.panelModel.loaded && !self.panelModel.busy && !self.outline.busy && self.book.loaded && !self.book.loading
                    && self.graph.loaded && !self.graph.busy && self.dock.loaded && !self.dock.busy && self.review.loaded && !self.review.isReading
                    && self.overview.loaded
            }
        }

        func driftRow(_ id: String) throws -> DriftLibraryModel.Row {
            guard let row = panel.rows.first(where: { $0.drift?.id == id && { if case .drift = $0 { return true }; return false }($0) }) else {
                throw LabError.message("The panel lists no drift \(id)")
            }
            return row
        }

        func press(_ kind: DriftConversionKind, on id: String) throws {
            let host = self.host
            try BindingAcceptance.wait { host.canNavigate }
            guard let item = panel.menuItems(for: try driftRow(id)).first(where: { $0.accessibilityIdentifier() == kind.identifier }) as? LibraryMenuItem else {
                throw LabError.message("The panel row has no \(kind.title)")
            }
            item.press()
        }
    }

    /// Picks the popup entry with this identity ("" for 无主线) and confirms.
    private static func plotChoice(_ id: String) -> (NSAlert) -> NSApplication.ModalResponse {
        { alert in
            guard let popup = alert.accessoryView as? NSPopUpButton,
                  let index = popup.itemArray.firstIndex(where: { $0.representedObject as? String == id }) else { return .alertSecondButtonReturn }
            popup.selectItem(at: index)
            return .alertFirstButtonReturn
        }
    }

    private static func typeBody(_ view: NativeDocumentView, _ text: String, _ harness: PlotHarness) throws {
        view.textView.setSelectedRange(NSRange(location: 0, length: 0))
        view.textView.insertText(text, replacementRange: NSRange(location: 0, length: 0))
        try harness.settled(view)
    }

    private static func convertToChapterFollows() throws {
        let harness = try PlotHarness(titles: ["启程", "雨夜"], name: "转换合成项目")
        defer { harness.remove() }
        let host = harness.host, workspace = harness.workspace, projectID = harness.projectID, project = harness.project
        let storylineReply: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult {
            workspace.createStoryline(projectID: projectID, name: "主线", completion: $0)
        }
        guard let main = storylineReply.result else { throw LabError.message("No storyline") }
        let groupReply: WorkspaceDriftReply<WorkspaceDriftGroup> = try elementResult {
            workspace.createDriftGroup(projectID: projectID, name: "信件", parentGroupID: nil, completion: $0)
        }
        guard let group = groupReply.result else { throw LabError.message("No drift group") }
        let letterReply: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
            workspace.createDrift(projectID: projectID, title: "旧信", groupID: group.id, completion: $0)
        }
        guard let letter = letterReply.result else { throw LabError.message("No drift") }
        let rainy = try harness.chapter("雨夜")
        let act: WorkspaceAct = try elementResult { workspace.createAct(projectID: projectID, chapterID: rainy.id, completion: $0) }
        let _: WorkspaceDriftReply<WorkspaceAct> = try elementResult {
            workspace.bindActDrift(projectID: projectID, actID: act.id, driftID: letter.id, completion: $0)
        }
        let markerReply: WorkspaceTimelineReply<WorkspaceTimelineMarker> = try elementResult {
            workspace.createTimelineMarker(projectID: projectID, narrativeOrder: 3, label: "", driftID: letter.id, completion: $0)
        }
        guard let marker = markerReply.result else { throw LabError.message("No marker") }
        let followers = try Followers(harness)
        try plotRequire(followers.outline.boundDrift(actID: act.id)?.id == letter.id && followers.panelModel.library.drift(id: letter.id) != nil,
                        "The act notes were not bound before the conversion")

        // The drift page in both panes, with a body and a 情节规划格, beside a chapter tab.
        try harness.open(try harness.chapter("启程"))
        let driftView: NativeDocumentView = try elementResult { host.open(project: project, drift: letter, in: 0, completion: $0) }
        try harness.settled(driftView)
        try typeBody(driftView, "信里提到北塔。", harness)
        guard let page = host.retainedDriftPage(pane: 0, scope: DriftScope(projectID: projectID, driftID: letter.id)) else {
            throw LabError.message("No drift page")
        }
        page.plotPlannerButton.performClick(nil)
        let driftDock = try harness.dock(letter.id)
        _ = driftDock.model.perform([.setCell(row: driftDock.canvas.grid.rows[0].id, column: driftDock.canvas.grid.columns[0].id, value: "寄信人")])
        try harness.gridSettled(driftDock.model)
        let grid = try harness.stored(letter.id)
        let split: NativeDocumentView = try elementResult { host.split(completion: $0) }
        try harness.settled(split)
        let driftScope = DriftScope(projectID: projectID, driftID: letter.id)
        try plotRequire(host.tabTitles(pane: 0) == ["启程", "旧信"] && host.tabTitles(pane: 1) == ["旧信"]
                        && host.retainedDriftPage(pane: 1, scope: driftScope) != nil, "Tabs before: \(host.tabTitles(pane: 0))")
        host.activate(pane: 0)

        // 取消 writes nothing.
        var mark = try harness.journal.mark()
        harness.answer = nil
        page.conversionItem(.chapter)?.press()
        try wait { harness.alerts.count == 1 && !host.isBusy }
        try plotRequire(harness.alerts.last == "将漂流“旧信”转为章节？" && host.retainedDriftPage(pane: 0, scope: driftScope) != nil,
                        "取消 changed the tabs: \(harness.alerts)")
        try harness.journal.expect([], since: mark, "取消")

        // From the page, primary in 主线: one original.
        mark = try harness.journal.mark()
        harness.answer = plotChoice(main.id)
        page.conversionItem(.chapter)?.press()
        try wait { followers.outcomes.count == 1 && !host.isBusy }
        guard case .chapter(let chapter, let driftID)? = followers.outcomes.last, driftID == letter.id else {
            throw LabError.message("The page conversion reported \(followers.outcomes)")
        }
        try followers.settled()
        let written = try harness.written(since: mark)
        try plotRequire(written.count == 1 && written[0].contains("field.set node") && written[0].contains("field.set timeline-marker")
                        && written[0].contains("field.set book-act"), "The conversion wrote \(written)")
        try plotRequire(chapter.id == letter.id && chapter.title == "旧信" && chapter.writingStatus == "draft", "The chapter is \(chapter)")
        // Tabs: the drift's tab became the chapter's in both panes, same body and planner.
        try plotRequire(host.tabTitles(pane: 0) == ["启程", "旧信"] && host.tabTitles(pane: 1) == ["旧信"] && host.activeChapter?.id == letter.id,
                        "Tabs after: \(host.tabTitles(pane: 0)) / \(host.tabTitles(pane: 1))")
        try plotRequire(host.retainedDriftPage(pane: 0, scope: driftScope) == nil && host.retainedDriftPage(pane: 1, scope: driftScope) == nil
                        && (try? harness.chapterPage(letter.id, pane: 1)) != nil, "The drift page stayed")
        let chapterPage = try harness.chapterPage(letter.id)
        try plotRequire(chapterPage.documentView.textView.string == "信里提到北塔。" && chapterPage.documentView.binding.canEdit,
                        "The chapter tab has another body: \(chapterPage.documentView.textView.string)")
        let (leftGrid, rightGrid) = (try harness.dock(letter.id).canvas.grid, try harness.dock(letter.id, pane: 1).canvas.grid)
        try plotRequire(leftGrid == grid && rightGrid == grid, "The chapter page lost the 情节规划格")
        try typeBody(chapterPage.documentView, "续：", harness)
        let opened: WorkspaceAgentProse = try elementResult { workspace.agentReadProse(projectID: projectID, kind: "chapter", id: letter.id, completion: $0) }
        try plotRequire(opened.text == "续：信里提到北塔。", "The chapter body does not save: \(opened.text)")
        // Every view follows.
        try eventually({ followers.outline.entries.last?.id == letter.id && followers.outline.boundDrift(actID: act.id) == nil
                        && followers.outline.primaryStoryline(chapterID: letter.id)?.id == main.id }, "The 整书大纲 did not follow")
        try eventually({ followers.book.layout.chapters.last?.id == letter.id }, "The 全书长卷 did not follow")
        try plotRequire(followers.chapterList.last?.id == letter.id && followers.chapterList.last?.title == "旧信", "The chapter list did not follow")
        try eventually({ followers.graph.chapters.last?.id == letter.id && followers.graph.drifts.drift(id: letter.id) == nil
                        && followers.graph.timeline.marker(id: marker.id)?.driftNodeId == nil
                        && followers.graph.timeline.marker(id: marker.id)?.label == "旧信" }, "The story graph did not follow")
        try eventually({ followers.dock.chapters.last?.id == letter.id }, "The 底部时间轴 did not follow")
        try eventually({ followers.panelModel.library.drift(id: letter.id) == nil && followers.panelModel.library.trashedDrifts.isEmpty
                        && followers.panelModel.actNames[act.id] != nil }, "The 漂流 panel did not follow")
        try eventually({ host.storylineLibrary(projectID: projectID)?.primary(chapterID: letter.id)?.id == main.id }, "The chapter is not in 主线")
        try plotRequire(host.linkDirectory(projectID: projectID) != nil, "Links lost their directory")

        // From the panel, with no storyline and no open tab: the chapter opens under the drift's unique title.
        let twinReply: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
            workspace.createDrift(projectID: projectID, title: "雨夜 草稿", groupID: nil, completion: $0)
        }
        guard let twin = twinReply.result else { throw LabError.message("No second drift") }
        let _: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
            workspace.updateDrift(projectID: projectID, driftID: twin.id, changes: WorkspaceDriftChanges(title: "雨夜"), completion: $0)
        }
        followers.panelModel.load()
        try followers.settled()
        let stored = followers.panelModel.library.drift(id: twin.id)
        mark = try harness.journal.mark()
        harness.answer = plotChoice("")
        try followers.press(.chapter, on: twin.id)
        try wait { followers.outcomes.count == 2 && !host.isBusy }
        try followers.settled()
        guard case .chapter(let second, _)? = followers.outcomes.last else { throw LabError.message("The panel conversion reported nothing") }
        try plotRequire(try harness.written(since: mark).count == 1 && second.id == twin.id && second.title == stored?.title && second.title.hasPrefix("雨夜"),
                        "The panel conversion is \(second) from \(String(describing: stored?.title))")
        try plotRequire(host.activeChapter?.id == twin.id && host.storylineLibrary(projectID: projectID)?.primary(chapterID: twin.id) == nil,
                        "The panel conversion did not open the chapter without a storyline")
        try eventually({ followers.dock.chapters.map(\.id).suffix(2) == [letter.id, twin.id] && followers.panelModel.library.drifts.isEmpty },
                        "The views did not follow the panel conversion: \(followers.dock.chapters.map(\.title)) \(followers.panelModel.library.drifts.map(\.title))")
        try harness.close()
    }

    private static func convertToElementAndConflict() throws {
        let harness = try PlotHarness(titles: ["启程"], name: "转为设定合成项目")
        defer { harness.remove() }
        let host = harness.host, workspace = harness.workspace, projectID = harness.projectID, project = harness.project
        let categoryReply: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: projectID, name: "地点", completion: $0)
        }
        guard let place = categoryReply.result else { throw LabError.message("No category") }
        let otherCategory: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: projectID, name: "物件", completion: $0)
        }
        guard let things = otherCategory.result else { throw LabError.message("No second category") }
        func drift(_ title: String, summary: String? = nil) throws -> WorkspaceDrift {
            let reply: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
                workspace.createDrift(projectID: projectID, title: title, groupID: nil, completion: $0)
            }
            guard let drift = reply.result else { throw LabError.message("No drift \(title)") }
            if let summary {
                let _: WorkspaceNodeMetadata = try elementResult {
                    workspace.setNodeSummary(projectID: projectID, nodeID: drift.id, summary: summary, completion: $0)
                }
            }
            return drift
        }
        let lighthouse = try drift("灯塔", summary: "海边的灯塔")
        let shore = try drift("北岸")
        let followers = try Followers(harness)

        // From the page: the category is asked, the element opens where the drift was.
        try harness.open(try harness.chapter("启程"))
        let view: NativeDocumentView = try elementResult { host.open(project: project, drift: lighthouse, in: 0, completion: $0) }
        try harness.settled(view)
        try typeBody(view, "灯塔在北岸。", harness)
        guard let page = host.retainedDriftPage(pane: 0, scope: DriftScope(projectID: projectID, driftID: lighthouse.id)) else {
            throw LabError.message("No drift page")
        }
        var mark = try harness.journal.mark()
        harness.answer = plotChoice(place.id)
        page.conversionItem(.element)?.press()
        try wait { followers.outcomes.count == 1 && !host.isBusy }
        guard case .element(let element, _, _)? = followers.outcomes.last else { throw LabError.message("The page conversion reported \(followers.outcomes)") }
        try followers.settled()
        try plotRequire(harness.alerts.last == "将漂流“灯塔”转为设定？", "The picker read \(harness.alerts)")
        try plotRequire(element.name == "灯塔" && element.summary == "海边的灯塔" && element.categoryId == place.id, "The element is \(element)")
        try plotRequire(host.tabTitles(pane: 0) == ["启程", "灯塔"] && host.activeElement?.id == element.id
                        && host.retainedDriftPage(pane: 0, scope: DriftScope(projectID: projectID, driftID: lighthouse.id)) == nil
                        && host.retainedElementPage(pane: 0, scope: ElementScope(projectID: projectID, elementID: element.id)) != nil,
                        "Tabs: \(host.tabTitles(pane: 0))")
        let body: WorkspaceAgentProse = try elementResult { workspace.agentReadProse(projectID: projectID, kind: "element", id: element.id, completion: $0) }
        try plotRequire(body.text == "灯塔在北岸。", "The element body is \(body.text)")
        try wait { host.activeView?.textView.string == "灯塔在北岸。" && host.elementLibrary(projectID: projectID)?.elements.contains { $0.id == element.id } == true }
        let written = try harness.written(since: mark)
        // The element with its seed, the copied body, the drift's trash; a
        // later link pass on the new body may follow.
        try plotRequire(Array(written.prefix(3)) == [["entity.create element", "yjs.update prose-document"], ["yjs.update prose-document"],
                                                     ["entity.trash node"]]
                        && written.dropFirst(3).allSatisfy { $0 == ["yjs.update prose-document"] }, "The element conversion wrote \(written)")
        try plotRequire(followers.panelModel.library.drift(id: lighthouse.id) == nil
                        && followers.panelModel.library.trashedDrifts.contains { $0.id == lighthouse.id }, "The drift is not in the trash")

        // From the panel: a drift that is not open; the element opens in the active pane.
        mark = try harness.journal.mark()
        harness.answer = plotChoice(things.id)
        try followers.press(.element, on: shore.id)
        try wait { followers.outcomes.count == 2 && !host.isBusy }
        guard case .element(let second, _, _)? = followers.outcomes.last else { throw LabError.message("The panel conversion reported nothing") }
        try plotRequire(second.name == "北岸" && second.categoryId == things.id && host.activeElement?.id == second.id
                        && followers.panelResults.count == 1, "The panel conversion is \(second)")
        try wait { host.elementLibrary(projectID: projectID)?.elements.count == 2 }

        // A title an element already uses: refused in Chinese, nothing written.
        let clash = try drift("灯塔")
        followers.panelModel.load()
        try followers.settled()
        try wait { host.canNavigate }
        let clashView: NativeDocumentView = try elementResult { host.open(project: project, drift: clash, in: 0, completion: $0) }
        try harness.settled(clashView)
        guard let clashPage = host.retainedDriftPage(pane: 0, scope: DriftScope(projectID: projectID, driftID: clash.id)) else {
            throw LabError.message("No clashing drift page")
        }
        let elements = host.elementLibrary(projectID: projectID)?.elements.count
        mark = try harness.journal.mark()
        harness.answer = plotChoice(place.id)
        clashPage.conversionItem(.element)?.press()
        try wait { clashPage.errorMessage != nil && !host.isBusy }
        try plotRequire(clashPage.errorMessage == "“灯塔”已被设定“灯塔”使用，请先给漂流或那个设定改名，再转为设定。", "The refusal read \(String(describing: clashPage.errorMessage))")
        try harness.journal.expect([], since: mark, "The refused conversion")
        try plotRequire(host.activeDrift?.id == clash.id && clashView.binding.canEdit && host.elementLibrary(projectID: projectID)?.elements.count == elements
                        && followers.panelModel.library.drift(id: clash.id) != nil,
                        "The refusal changed the drift, its page or the 设定库: \(String(describing: host.activeDrift?.title)) \(clashView.binding.canEdit) \(String(describing: host.elementLibrary(projectID: projectID)?.elements.count)) \(String(describing: elements)) \(followers.panelModel.library.drifts.map(\.title))")
        try typeBody(clashView, "仍可编辑", harness)
        // The panel reports the same refusal.
        mark = try harness.journal.mark()
        try followers.press(.element, on: clash.id)
        try wait { followers.panelResults.count == 2 && !host.isBusy }
        guard case .failure(let refusal)?? = followers.panelResults.last else { throw LabError.message("The panel refusal was not reported") }
        try plotRequire(refusal.localizedDescription.contains("已被设定“灯塔”使用"), "The panel refusal read \(refusal.localizedDescription)")
        try harness.journal.expect([], since: mark, "The refused panel conversion")
        try harness.close()
    }

    // MARK: Review fixes: loading, empty replies and waits

    private static func plotLoadingAndWaits() throws {
        let harness = try PlotHarness(titles: ["启程", "雨夜", "归途"], name: "规划等待合成项目")
        defer { harness.remove() }
        let host = harness.host, workspace = harness.workspace, projectID = harness.projectID, project = harness.project
        let start = try harness.chapter("启程"), rainy = try harness.chapter("雨夜"), home = try harness.chapter("归途")

        // A grid written elsewhere before the dock reads it.
        let (row, column) = (WorkspacePlotGrid.newID(.row), WorkspacePlotGrid.newID(.column))
        let _: WorkspacePlotGridReply = try elementResult {
            workspace.plotGrid(projectID: projectID, nodeID: rainy.id, ops: [.addAxis(.row, id: row, label: "人物", after: nil),
                .addAxis(.column, id: column, label: "场景", after: nil), .setCell(row: row, column: column, value: "林岚")], completion: $0)
        }
        let existing = try harness.stored(rainy.id)
        var mark = try harness.journal.mark()
        // No gesture before the first read: it could only be built on the template.
        let early = host.plotGridModel(projectID: projectID, nodeID: rainy.id)
        try plotRequire(!early.loaded && !early.perform([.setSize(width: 200, height: 100)]) && early.sentBatches.isEmpty
                        && early.grid.rows.isEmpty, "A gesture before the first read was accepted")
        try harness.open(rainy)
        host.setPlotPlanner(shown: true, projectID: projectID, nodeID: rainy.id)
        guard let loading = host.retainedPlotDock(pane: 0, nodeID: rainy.id) else { throw LabError.message("No dock for 雨夜") }
        try plotRequire(loading.model === early && !early.loaded && loading.hintText == "正在读取…" && !loading.addRowButton.isEnabled
                        && !loading.addColumnButton.isEnabled && !loading.widthSlider.isEnabled && loading.canvas.grid.rows.isEmpty,
                        "The dock did not read as loading: \(loading.hintText)")
        loading.addRowButton.performClick(nil)
        harness.key(loading.canvas, 0, "a")
        loading.canvas.beginEditing(.cell(row: row, column: column))
        try plotRequire(loading.canvas.editing == nil && early.sentBatches.isEmpty, "The loading dock accepted an edit")
        let dock = try harness.dock(rainy.id)
        try plotRequire(dock.canvas.grid == existing && dock.hintText.isEmpty && dock.addRowButton.isEnabled,
                        "The dock did not show the stored grid: \(dock.canvas.grid)")
        try harness.journal.expect([], since: mark, "Reading the grid")
        // The first edit changes the stored grid, not a template over it.
        harness.click(dock.canvas, .cell(row: row, column: column))
        harness.type(dock.canvas, "与沈舟")
        harness.command(dock.canvas, #selector(NSResponder.insertNewline(_:)))
        try harness.gridSettled(early)
        try harness.journal.expect([["field.set plot-grid-cell"]], since: mark, "The first edit after the read")
        try plotRequire(try harness.stored(rainy.id)?.rows.map(\.id) == [row] && early.stored?.value(row: row, column: column) == "林岚与沈舟",
                        "The first edit replaced the stored grid")

        // A write Rust answers with no grid: nothing stored, the template again.
        try harness.open(start)
        host.setPlotPlanner(shown: true, projectID: projectID, nodeID: start.id)
        let blank = try harness.dock(start.id), model = blank.model
        let template = blank.canvas.grid
        mark = try harness.journal.mark()
        model.sendUnchecked([.setSize(width: WorkspacePlotGrid.defaultWidth, height: WorkspacePlotGrid.defaultHeight)])
        try harness.gridSettled(model)
        try plotRequire(model.sentBatches.count == 1 && model.stored == nil && model.message == nil && blank.errorMessage == nil
                        && blank.canvas.grid == template && blank.hintText.contains("空白规划格"), "An empty reply did not show the template again")
        try plotRequire(try harness.stored(start.id) == nil, "Rust stored a grid for a write that changed nothing")
        try harness.journal.expect([], since: mark, "A write that changed nothing")

        // A queued gesture holds navigation like queued input.
        try plotRequire(model.perform([.setCell(row: template.rows[0].id, column: template.columns[0].id, value: "序")]), "The edit was not sent")
        try plotRequire(host.plotGridsWriting(projectID: projectID) && !host.canNavigate && host.canNavigateAfterPlotGrids,
                        "A queued gesture did not hold navigation")
        try harness.gridSettled(model)
        let templateWrite = try harness.written(since: mark)
        try plotRequire(host.canNavigate && templateWrite.count == 1 && templateWrite[0].filter { $0 == "entity.create plot-grid-row" }.count == 3,
                        "The template was not written after the empty reply: \(templateWrite)")

        // Closing a tab commits the cell being edited and waits for queued gestures.
        let rows = model.grid.rows.map(\.id), columns = model.grid.columns.map(\.id)
        harness.click(blank.canvas, .cell(row: rows[1], column: columns[1]))
        harness.type(blank.canvas, "关前")
        _ = model.perform([.setCell(row: rows[2], column: columns[2], value: "排队一")])
        _ = model.perform([.setCell(row: rows[2], column: columns[0], value: "排队二")])
        let closed: Bool = try elementResult {
            host.closeTab(pane: 0, scope: .chapter(ChapterScope(projectID: projectID, chapterID: start.id)), completion: $0)
        }
        let afterClose = try harness.stored(start.id)
        try plotRequire(closed && !host.tabTitles(pane: 0).contains("启程") && afterClose?.value(row: rows[1], column: columns[1]) == "关前"
                        && afterClose?.value(row: rows[2], column: columns[2]) == "排队一" && afterClose?.value(row: rows[2], column: columns[0]) == "排队二",
                        "Closing the tab lost gestures: \(String(describing: afterClose?.cells))")

        // Trash commits the cell being edited first; a refused one keeps the chapter.
        try harness.open(rainy)
        let rainyDock = try harness.dock(rainy.id)
        harness.click(rainyDock.canvas, .cell(row: row, column: column))
        harness.type(rainyDock.canvas, "回收前")
        mark = try harness.journal.mark()
        let _: WorkspaceChapterTrashReply = try elementResult { host.trash(projectID: projectID, chapterID: rainy.id, completion: $0) }
        var written = try harness.written(since: mark)
        try plotRequire(written.count == 2 && written[0] == ["field.set plot-grid-cell"] && written[1].contains("entity.trash node"),
                        "Trash did not write the cell first: \(written)")
        try plotRequire(host.retainedPlotDock(pane: 0, nodeID: rainy.id) == nil, "The trashed chapter kept its dock")
        let _: Void = try elementResult { host.restore(WorkspaceTrashItem(kind: .chapter, id: rainy.id, title: "雨夜", trashedAt: ""), projectID: projectID, completion: $0) }
        try plotRequire(try harness.stored(rainy.id)?.value(row: row, column: column) == "林岚与沈舟回收前", "The committed cell is not stored")
        try harness.open(home)
        host.setPlotPlanner(shown: true, projectID: projectID, nodeID: home.id)
        let homeDock = try harness.dock(home.id)
        let homeGrid = homeDock.canvas.grid
        harness.click(homeDock.canvas, .cell(row: homeGrid.rows[0].id, column: homeGrid.columns[0].id))
        harness.type(homeDock.canvas, String(repeating: "长", count: 10_001))
        mark = try harness.journal.mark()
        var refused: Result<WorkspaceChapterTrashReply, Error>?
        host.trash(projectID: projectID, chapterID: home.id) { refused = $0 }
        try wait { refused != nil }
        guard case .failure(let refusal)? = refused else { throw LabError.message("Trash went ahead after a refused 情节规划格 write") }
        try plotRequire(refusal.localizedDescription.contains("最多 10000 字") && refusal.localizedDescription.contains("没有移到回收站")
                        && homeDock.errorMessage?.contains("最多 10000 字") == true, "The refusal read \(refusal.localizedDescription)")
        try harness.journal.expect([], since: mark, "A trash after a refused 情节规划格 write")
        let live: [WorkspaceChapter] = try elementResult { workspace.chapters(projectID: projectID, completion: $0) }
        try plotRequire(live.contains { $0.id == home.id } && host.retainedPlotDock(pane: 0, nodeID: home.id) != nil, "The refused trash lost the chapter")

        // 转为章节 and 转为设定 wait for the drift's gestures.
        let letterReply: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
            workspace.createDrift(projectID: projectID, title: "旧信", groupID: nil, completion: $0)
        }
        let lampReply: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
            workspace.createDrift(projectID: projectID, title: "油灯", groupID: nil, completion: $0)
        }
        guard let letter = letterReply.result, let lamp = lampReply.result else { throw LabError.message("No drifts") }
        host.applyDriftLibrary(projectID: projectID, library: lampReply.library)
        let categoryReply: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: projectID, name: "物件", completion: $0)
        }
        guard let things = categoryReply.result else { throw LabError.message("No category") }
        for drift in [letter, lamp] {
            let view: NativeDocumentView = try elementResult { host.open(project: project, drift: drift, in: 0, completion: $0) }
            try harness.settled(view)
            host.setPlotPlanner(shown: true, projectID: projectID, nodeID: drift.id)
        }
        let letterDock = try harness.dock(letter.id)
        harness.click(letterDock.canvas, .cell(row: letterDock.canvas.grid.rows[0].id, column: letterDock.canvas.grid.columns[0].id))
        harness.type(letterDock.canvas, "寄信人")
        mark = try harness.journal.mark()
        let chapter: WorkspaceChapter = try elementResult {
            host.convertDriftToChapter(project: project, driftID: letter.id, storylineID: nil, completion: $0)
        }
        written = try harness.written(since: mark)
        try plotRequire(chapter.id == letter.id && written.count == 2 && onlyPlotGrid([written[0]]) && written[1].contains("field.set node"),
                        "转为章节 did not write the cell first: \(written)")
        try plotRequire(try harness.stored(letter.id)?.cells.map(\.value) == ["寄信人"], "The converted chapter lost the cell")
        let lampDock = try harness.dock(lamp.id), lampGrid = lampDock.canvas.grid
        mark = try harness.journal.mark()
        _ = lampDock.model.perform([.setCell(row: lampGrid.rows[0].id, column: lampGrid.columns[0].id, value: "灯芯")])
        _ = lampDock.model.perform([.setCell(row: lampGrid.rows[1].id, column: lampGrid.columns[0].id, value: "灯油")])
        let conversion: WorkspaceDriftElementConversion = try elementResult {
            host.convertDriftToElement(project: project, driftID: lamp.id, categoryID: things.id, completion: $0)
        }
        written = try harness.written(since: mark)
        try plotRequire(conversion.element.name == "油灯" && written.count >= 4 && onlyPlotGrid(Array(written.prefix(2)))
                        && written[2].contains("entity.create element") && written.contains { $0.contains("entity.trash node") },
                        "转为设定 did not write the gestures first: \(written)")

        // A wait that runs out refuses in Chinese; closing then waits and keeps every gesture.
        try wait { host.canNavigate }
        try harness.open(home)
        let saved = MacChapterWorkspace.plotGridWait
        MacChapterWorkspace.plotGridWait = 0
        _ = homeDock.model.perform([.setCell(row: homeGrid.rows[1].id, column: homeGrid.columns[1].id, value: "限时")])
        var timedOut: Result<Bool, Error>?
        host.close { timedOut = $0 }
        MacChapterWorkspace.plotGridWait = saved
        try wait { timedOut != nil }
        guard case .failure(let wait)? = timedOut else { throw LabError.message("Closing did not refuse while a gesture was out") }
        try plotRequire(wait.localizedDescription == "情节规划格还在保存，没有关闭。请稍后再试。", "The timeout read \(wait.localizedDescription)")
        try harness.gridSettled(homeDock.model)
        harness.click(homeDock.canvas, .cell(row: homeGrid.rows[2].id, column: homeGrid.columns[2].id))
        harness.type(homeDock.canvas, "退出前")
        _ = homeDock.model.perform([.setCell(row: homeGrid.rows[1].id, column: homeGrid.columns[2].id, value: "排队")])
        let quit: Bool = try elementResult { host.close(completion: $0) }
        try plotRequire(quit, "Closing with queued gestures failed")
        harness.window.close()
        try harness.reopen()
        let reopened = try harness.stored(home.id)
        try plotRequire(reopened?.value(row: homeGrid.rows[1].id, column: homeGrid.columns[1].id) == "限时"
                        && reopened?.value(row: homeGrid.rows[2].id, column: homeGrid.columns[2].id) == "退出前"
                        && reopened?.value(row: homeGrid.rows[1].id, column: homeGrid.columns[2].id) == "排队",
                        "Closing lost gestures: \(String(describing: reopened?.cells))")
        try harness.close()
    }

    // MARK: Review fixes: what 转为设定 carries

    private static func convertToElementCarries() throws {
        let harness = try PlotHarness(titles: ["启程"], name: "转为设定携带合成项目")
        defer { harness.remove() }
        let host = harness.host, workspace = harness.workspace, projectID = harness.projectID, project = harness.project
        let start = try harness.chapter("启程")
        let placeReply: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: projectID, name: "地点", completion: $0)
        }
        guard let place = placeReply.result else { throw LabError.message("No category") }
        let harbourReply: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: projectID, categoryID: place.id, name: "港口", completion: $0)
        }
        guard let harbour = harbourReply.result else { throw LabError.message("No element") }
        let driftReply: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
            workspace.createDrift(projectID: projectID, title: "灯塔", groupID: nil, completion: $0)
        }
        guard let lighthouse = driftReply.result else { throw LabError.message("No drift") }
        func type(_ name: String, _ kinds: [String]) throws -> WorkspaceRelationType {
            let reply: WorkspaceRelationReply<WorkspaceRelationType> = try elementResult {
                workspace.createRelationType(projectID: projectID, definition: RelationTypeDefinition(name: name, orientation: "directed",
                    sourceRole: "源", targetRole: "目标", sourceKinds: kinds, targetKinds: kinds), completion: $0)
            }
            guard let type = reply.result else { throw LabError.message("No relation type \(name)") }
            return type
        }
        let near = try type("邻近", ["node", "element"]), follows = try type("承接", ["node"])
        let driftEnd = RelationEndpoint(kind: "node", id: lighthouse.id), chapterEnd = RelationEndpoint(kind: "node", id: start.id)
        for (from, to, kind) in [(driftEnd, RelationEndpoint(kind: "element", id: harbour.id), near), (chapterEnd, driftEnd, near),
                                 (driftEnd, chapterEnd, follows)] {
            let _: WorkspaceRelationReply<WorkspaceRelation> = try elementResult {
                workspace.addRelation(projectID: projectID, from: from, to: to, relationTypeID: kind.id, completion: $0)
            }
        }
        let wholeReply: WorkspaceCommentsReply = try elementResult {
            workspace.createComment(projectID: projectID, kind: "todo", target: driftEnd, body: "查证灯塔年代", priority: nil, completion: $0)
        }
        guard let whole = wholeReply.result else { throw LabError.message("No whole-drift TODO") }
        let followers = try Followers(harness)

        // The chapter and the drift open, the drift with a note in its text.
        try harness.open(start)
        let view: NativeDocumentView = try elementResult { host.open(project: project, drift: lighthouse, in: 0, completion: $0) }
        try harness.settled(view)
        try typeBody(view, "灯塔在北岸。", harness)
        let revision = view.binding.state!.projection.revision
        let passage: WorkspaceComment = try elementResult {
            view.binding.store.createComment(range: NSRange(location: 3, length: 2), revision: revision, body: "北岸是哪一岸", completion: $0)
        }
        try harness.settled(view)
        guard let page = host.retainedDriftPage(pane: 0, scope: DriftScope(projectID: projectID, driftID: lighthouse.id)) else {
            throw LabError.message("No drift page")
        }
        followers.review.load()
        try followers.settled()

        // The dialog says what moves and what stays; the report counts it.
        var mark = try harness.journal.mark()
        harness.answer = plotChoice(place.id)
        page.conversionItem(.element)?.press()
        try wait { followers.outcomes.count == 1 && !host.isBusy }
        guard case .element(let element, let driftID, let carried)? = followers.outcomes.last, driftID == lighthouse.id else {
            throw LabError.message("The conversion reported \(followers.outcomes)")
        }
        let detail = harness.details.last ?? ""
        try plotRequire(detail.contains("关系类型允许设定的关系、整篇漂流上的批注和待办会转到新设定上，其余关系会删除")
                        && detail.contains("正文里锚定的批注、历史版本、情节规划格和补丁来源留在漂流上，恢复漂流时一起回来"), "The dialog read \(detail)")
        let report = "已转为设定「灯塔」：转移了 2 条关系、1 条批注和待办；1 条关系的类型不允许设定，已随漂流删除。"
        try plotRequire(carried == WorkspaceDriftCarry(relations: 2, skippedRelations: 1, comments: 1)
                        && followers.outcomes.last?.message == report,
                        "The report read \(String(describing: followers.outcomes.last?.message)) for \(carried)")
        try plotRequire(WorkspaceDriftCarry(relations: 0, skippedRelations: 0, comments: 0).report(elementName: "北岸") == "已转为设定「北岸」，原漂流已移到回收站。"
                        && WorkspaceDriftCarry(relations: 0, skippedRelations: 2, comments: 0).report(elementName: "北岸")
                            == "已转为设定「北岸」：2 条关系的类型不允许设定，已随漂流删除。", "Zero parts were not left out")
        let written = try harness.written(since: mark)
        try plotRequire(written.count >= 4 && written[2] == ["entity.create entity-relation", "entity.create entity-relation", "field.set comment", "field.set comment"]
                        && written[3].last == "entity.trash node" && written[3].filter { $0 == "entity.purge entity-relation" }.count == 3,
                        "The conversion wrote \(written)")
        // The 关系 sections, the 设定总览 and 审阅 follow.
        guard let elementPage = host.retainedElementPage(pane: 0, scope: ElementScope(projectID: projectID, elementID: element.id)) else {
            throw LabError.message("No element page")
        }
        let elementEnd = RelationEndpoint(kind: "element", id: element.id)
        try eventually({ Set(elementPage.relationsView.entries.map(\.other)) == [RelationEndpoint(kind: "element", id: harbour.id), chapterEnd] },
                       "The element's 关系 read \(elementPage.relationsView.entries.map(\.text))")
        try eventually({ try harness.chapterPage(start.id).relationsView.entries.map(\.other) == [elementEnd] },
                       "The chapter's 关系 read \((try? harness.chapterPage(start.id).relationsView.entries.map(\.text)) ?? [])")
        try eventually({ followers.overview.scene.edges.filter { $0.relation.from == elementEnd || $0.relation.to == elementEnd }.count == 2 },
                       "The 设定总览 shows \(followers.overview.scene.edges.map { "\($0.fromName)→\($0.toName)" })")
        try eventually({ followers.review.comment(id: whole.id)?.target == elementEnd && followers.review.comment(id: passage.id)?.target == driftEnd },
                       "审阅 did not follow: \(String(describing: followers.review.comment(id: whole.id)?.target))")
        followers.review.setFocus(ReviewFocus(endpoint: elementEnd, label: "设定「灯塔」"))
        try plotRequire(followers.review.items.filter { $0.rank == 0 }.map(\.comment.id) == [whole.id], "The element's notes are \(followers.review.items)")

        // Restoring the drift brings the note in its text back.
        let _: Void = try elementResult {
            host.restore(WorkspaceTrashItem(kind: .drift, id: lighthouse.id, title: "灯塔", trashedAt: ""), projectID: projectID, completion: $0)
        }
        let restored: NativeDocumentView = try elementResult { host.open(project: project, drift: lighthouse, in: 0, completion: $0) }
        try harness.settled(restored)
        try plotRequire(restored.binding.state?.projection.comments.contains { $0.id == passage.id && $0.anchorStatus == .anchored } == true
                        && restored.textView.string == "灯塔在北岸。", "The restored drift lost its passage note")
        guard let restoredPage = host.retainedDriftPage(pane: 0, scope: DriftScope(projectID: projectID, driftID: lighthouse.id)) else {
            throw LabError.message("No restored drift page")
        }

        // Stopped after the element was created: Rust's message as it is, lists read again, the tab kept.
        func elementCreated(_ name: String) throws {
            let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
                workspace.createElement(projectID: projectID, categoryID: place.id, name: name, completion: $0)
            }
        }
        try elementCreated("灯塔二号")
        let moved = "设定「灯塔二号」已创建并复制了正文，但关系和批注未能转移：合成的转移失败"
        host.injectedElementConversionFailure = { _ in LabError.driftUnavailable(reason: moved) }
        mark = try harness.journal.mark()
        restoredPage.conversionItem(.element)?.press()
        try wait { restoredPage.errorMessage != nil && !host.isBusy }
        try plotRequire(restoredPage.errorMessage == moved && followers.outcomes.count == 1, "The page read \(String(describing: restoredPage.errorMessage))")
        try eventually({ host.elementLibrary(projectID: projectID)?.elements.contains { $0.name == "灯塔二号" } == true }, "The 设定库 was not read again")
        try plotRequire(host.retainedDriftPage(pane: 0, scope: DriftScope(projectID: projectID, driftID: lighthouse.id)) === restoredPage
                        && restored.binding.canEdit && followers.panelModel.library.drift(id: lighthouse.id) != nil, "The drift's tab did not stay")
        try harness.journal.expect([], since: mark, "The injected failure")
        try followers.press(.element, on: lighthouse.id)
        try wait { followers.panelResults.count == 1 && !host.isBusy }
        guard case .failure(let panelFailure)?? = followers.panelResults.last else { throw LabError.message("The panel reported no failure") }
        try plotRequire(panelFailure.localizedDescription == moved, "The panel read \(panelFailure.localizedDescription)")

        // A failed trash after Rust released the body: the tab shows the drift again.
        try elementCreated("灯塔三号")
        let _: Bool = try elementResult { workspace.closeDrift(projectID: projectID, driftID: lighthouse.id, completion: $0) }
        let trashFailed = "设定「灯塔三号」已创建并复制了正文，但灵感未能移入回收站：合成的回收站失败"
        host.injectedElementConversionFailure = { _ in LabError.driftUnavailable(reason: trashFailed) }
        restoredPage.conversionItem(.element)?.press()
        try wait { !host.isBusy && host.retainedDriftPage(pane: 0, scope: DriftScope(projectID: projectID, driftID: lighthouse.id)).map { $0 !== restoredPage } == true }
        guard let reopenedPage = host.retainedDriftPage(pane: 0, scope: DriftScope(projectID: projectID, driftID: lighthouse.id)) else {
            throw LabError.message("The drift's tab closed after a failed trash")
        }
        try harness.settled(reopenedPage.documentView)
        try plotRequire(reopenedPage.errorMessage == trashFailed && reopenedPage.documentView.textView.string == "灯塔在北岸。"
                        && reopenedPage.documentView.binding.canEdit && host.activeDrift?.id == lighthouse.id,
                        "The reopened drift page read \(String(describing: reopenedPage.errorMessage))")
        try eventually({ host.elementLibrary(projectID: projectID)?.elements.contains { $0.name == "灯塔三号" } == true }, "The 设定库 was not read again")

        // The drift already in the trash: its tabs go.
        try elementCreated("灯塔四号")
        let _: WorkspaceDriftReply<WorkspaceDrift> = try elementResult { workspace.trashDrift(projectID: projectID, driftID: lighthouse.id, completion: $0) }
        host.injectedElementConversionFailure = { _ in LabError.driftUnavailable(reason: "设定「灯塔四号」已创建并复制了正文，但灵感未能移入回收站：合成的失败") }
        reopenedPage.conversionItem(.element)?.press()
        try wait { !host.isBusy && host.retainedDriftPage(pane: 0, scope: DriftScope(projectID: projectID, driftID: lighthouse.id)) == nil }
        try eventually({ followers.panelModel.library.trashedDrifts.contains { $0.id == lighthouse.id } }, "The 漂流 panel did not read the trash")
        host.injectedElementConversionFailure = nil
        try harness.close()
    }
}
