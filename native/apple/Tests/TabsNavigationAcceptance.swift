import AppKit

/// 后退/前进, tab management and restoring tabs through the real tab host,
/// panes, main-menu layout, settings store and tab session, the Rust
/// workspace and SQLite, wired as AppDelegate wires them. Key presses go
/// through a menu built from the app's layout; mouse events are synthesized
/// and sent to the tab buttons. Windows are never on screen, and every
/// project, title and body is synthetic.
extension BindingAcceptance {
    static let tabsNavigationCases = [
        "AppKit 后退 and 前进 (⌘[ ⌘]) step through the chapter, element, drift, category, storyline and 项目主页 pages the window showed in the panes that showed them, reopen a closed tab in its pane or in the active pane once that pane is gone, skip a trashed and a purged page, drop the pages ahead after a new visit, hold while input is queued or composing or a 情节规划格 edit is on its way, start a new history on a project switch and write nothing to the journal",
        "AppKit tab context menus 关闭, 关闭其他, 关闭右侧全部, 全部关闭, 在另一侧打开, 移到另一侧 and 解除分屏 go through the close path, keep the views, selections and history of moved tabs and one owner per page, and 全部关闭 stops at a 情节规划格 refusal in the middle naming the tab while the tabs before it stay closed; ⌥⌘← and ⌥⌘→ cycle the active pane's tabs, ⌘W closes the shown tab and then the window, and a dragged tab reorders within its pane",
        "AppKit tabs of both panes, each pane's shown tab, the 项目主页 tab and the split are kept per project in settings.json as they change, coalesced and not while typing, and a cold relaunch opens the last selected project with only each pane's shown tab owning its body while the others open in place when selected, leaving out trashed and purged pages, unreadable entries and a deleted project, and opens no project without a last one",
        "AppKit switching projects saves and closes the shown project's tabs through the close path, a tab that cannot close keeping the project and naming the tab, restores the other project's tabs with their split and text and back again with a new 后退 history, writes nothing to the journal, and 设置 › 快捷键 lists 关闭标签 (⌘W, fixed), 后退, 前进, 上一个标签 and 下一个标签",
        "AppKit 解除分屏 first saves the right pane's unsaved 摘要, element name and 情节规划格 cell, also for pages both panes show, and a refused cell keeps both panes and says why; ⌘W with the active pane empty shows another pane's tab or a restored tab instead of closing the window, which closes only without tabs",
        "AppKit a refused restore and one overtaken by another project's switch restore nothing and leave the saved tabs as they were, a switch refused by a tab that cannot close keeps the project's restored tabs and 项目主页 and saves nothing, and forgetting a deleted project drops its pages from 后退 and 前进",
        restoreKeepsPagesCase,
    ]
    static let restoreKeepsPagesCase = "AppKit a restore whose drift list cannot be read puts back the other tabs, says so and keeps the unread page at its place in every later save until a complete restore brings it back or the author opens it (closing it then leaves it out, also when opened and closed between two saves), and a restore refused while navigation is held keeps the stored tabs through a save and is tried again once navigation is possible"

    static func tabsNavigationAcceptance() throws -> [String] {
        let saved = (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay, WordCountModel.refreshDelay,
                     ProjectHomeModel.stampDelay, MacTabSession.saveDelay)
        defer {
            (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay, WordCountModel.refreshDelay,
             ProjectHomeModel.stampDelay, MacTabSession.saveDelay) = saved
        }
        DocumentStore.entityLinkDelay = 0.05
        MacChapterWorkspace.backlinkDelay = 0.05
        WordCountModel.refreshDelay = 0.05
        ProjectHomeModel.stampDelay = 0.05
        MacTabSession.saveDelay = 0.1
        try tabsBackForward()
        try tabsManagement()
        try tabsRestore()
        try tabsProjectSwitch()
        try tabsMergeAndClose()
        try tabsRestoreGuards()
        try tabsRestoreKeepsUnread()
        return tabsNavigationCases
    }

    // MARK: Harness

    /// Answers ⌘W's window close without closing the window.
    private final class TabsWindowProbe: NSObject, NSWindowDelegate {
        var closeRequests = 0
        func windowShouldClose(_ sender: NSWindow) -> Bool { closeRequests += 1; return false }
    }

    /// The menu's targets, acting as AppDelegate's actions do.
    private final class TabsMenuProbe: NSObject {
        let host: MacChapterWorkspace
        let window: NSWindow
        init(host: MacChapterWorkspace, window: NSWindow) { self.host = host; self.window = window }
        @objc func back(_ sender: Any?) { host.goBack() }
        @objc func forward(_ sender: Any?) { host.goForward() }
        @objc func previous(_ sender: Any?) { host.selectAdjacentTab(-1) }
        @objc func next(_ sender: Any?) { host.selectAdjacentTab(1) }
        @objc func close(_ sender: Any?) {
            if !host.hasAnyTab || !host.closeTabOrShowAnother() { window.performClose(nil) }
        }
        func menu() -> NSMenu {
            MacMainMenu.build([
                .back: MacMainMenu.Action(#selector(back(_:)), self), .forward: MacMainMenu.Action(#selector(forward(_:)), self),
                .previousTab: MacMainMenu.Action(#selector(previous(_:)), self), .nextTab: MacMainMenu.Action(#selector(next(_:)), self),
                .closeTab: MacMainMenu.Action(#selector(close(_:)), self),
            ])
        }
    }

    private final class TabsHarness {
        let root: URL
        let directory: URL
        let journal: JournalProbe
        let workspace: LabWorkspaceCore
        let settings: LabSettingsStore
        let window: NSWindow
        let host: MacChapterWorkspace
        let session: MacTabSession
        /// The tab host's refusals, as the status line would show them.
        var errors: [String] = []

        /// A new lab, or a cold relaunch of `root`: a new workspace, settings
        /// store, window, tab host and session.
        init(root existing: URL? = nil) throws {
            root = existing ?? FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            directory = root.appendingPathComponent("apple-native-lab")
            journal = JournalProbe(directory: directory)
            workspace = LabWorkspaceCore(directory: directory)
            settings = LabSettingsStore(directory: root)
            (window, host) = BindingAcceptance.elementHost(workspace)
            // As AppDelegate wires the tab host.
            host.homeSettings = settings
            host.plotPlannerSettings = settings
            session = MacTabSession(host: host, store: settings, workspace: workspace)
            host.onError = { [weak self] in self?.errors.append($0.localizedDescription) }
            let workspace = self.workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(existing != nil || listed.isEmpty, "The tabs fixture was not isolated")
        }

        func projects() throws -> [WorkspaceProject] {
            let workspace = self.workspace
            return try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
        }

        func project(_ name: String, chapters titles: [String]) throws -> (WorkspaceProject, [WorkspaceChapter]) {
            let workspace = self.workspace
            let project: WorkspaceProject = try BindingAcceptance.elementResult { workspace.createProject(name: name, completion: $0) }
            let chapters: [WorkspaceChapter] = try titles.map { title in
                try BindingAcceptance.elementResult { workspace.createChapter(projectID: project.id, title: title, completion: $0) }
            }
            return (project, chapters)
        }

        /// A category with two elements, a storyline and a drift, adopted by
        /// the host as the panels' replies are.
        func pages(_ project: WorkspaceProject) throws -> TabsPages {
            let workspace = self.workspace, host = self.host, id = project.id
            let category: WorkspaceElementReply<WorkspaceElementCategory> = try BindingAcceptance.elementResult {
                workspace.createElementCategory(projectID: id, name: "人物", completion: $0)
            }
            guard let people = category.result else { throw LabError.message("No category was created") }
            let first: WorkspaceElementReply<WorkspaceElement> = try BindingAcceptance.elementResult {
                workspace.createElement(projectID: id, categoryID: people.id, name: "林雾", completion: $0)
            }
            let second: WorkspaceElementReply<WorkspaceElement> = try BindingAcceptance.elementResult {
                workspace.createElement(projectID: id, categoryID: people.id, name: "阿青", completion: $0)
            }
            host.applyElementLibrary(projectID: id, library: second.library)
            let storyline: WorkspaceStorylineReply<WorkspaceStoryline> = try BindingAcceptance.elementResult {
                workspace.createStoryline(projectID: id, name: "主线", completion: $0)
            }
            host.applyStorylineLibrary(projectID: id, library: storyline.library)
            let drift: WorkspaceDriftReply<WorkspaceDrift> = try BindingAcceptance.elementResult {
                workspace.createDrift(projectID: id, title: "旧信", groupID: nil, completion: $0)
            }
            host.applyDriftLibrary(projectID: id, library: drift.library)
            guard let element = first.result, let other = second.result, let line = storyline.result, let note = drift.result else {
                throw LabError.message("The synthetic pages were not created")
            }
            return TabsPages(element: element, other: other, category: people, storyline: line, drift: note)
        }

        func settled() throws {
            try BindingAcceptance.wait { !self.host.isBusy && self.host.canNavigate }
        }

        @discardableResult
        func open(_ project: WorkspaceProject, _ target: WorkspaceTabTarget, in pane: Int? = nil,
                  file: String = #fileID, line: Int = #line) throws -> NativeDocumentView {
            do { return try opened(project, target, in: pane) } catch {
                throw LabError.message("Opening a tab at \(file):\(line) failed: \(error.localizedDescription)")
            }
        }

        private func opened(_ project: WorkspaceProject, _ target: WorkspaceTabTarget, in pane: Int?) throws -> NativeDocumentView {
            let host = self.host
            let view: NativeDocumentView = try BindingAcceptance.elementResult { done in
                switch target {
                case .chapter(let chapter): host.open(project: project, chapter: chapter, in: pane, completion: done)
                case .element(let element): host.open(project: project, element: element, in: pane, completion: done)
                case .storyline(let storyline): host.open(project: project, storyline: storyline, in: pane, completion: done)
                case .drift(let drift): host.open(project: project, drift: drift, in: pane, completion: done)
                case .category(let category): host.open(project: project, category: category, in: pane, completion: done)
                }
            }
            try settled()
            return view
        }

        func show(_ project: WorkspaceProject, file: String = #fileID, line: Int = #line) throws {
            let session = self.session
            do {
                let _: Void = try BindingAcceptance.elementResult { session.show(project, completion: $0) }
            } catch {
                throw LabError.message("Showing \(project.name) at \(file):\(line) failed: \(error.localizedDescription)")
            }
            try settled()
        }

        /// Runs a step that reports through a completion and waits until
        /// the host is idle again; its error is returned, not thrown.
        @discardableResult
        func step(settling: Bool = true, _ run: (@escaping (Error?) -> Void) -> Void) throws -> Error? {
            var done = false
            var error: Error?
            run { error = $0; done = true }
            try BindingAcceptance.wait { done }
            if settling { try settled() } else { try BindingAcceptance.wait { !self.host.isBusy } }
            return error
        }

        func type(_ view: NativeDocumentView, _ text: String) throws {
            let end = (view.textView.string as NSString).length
            view.textView.setSelectedRange(NSRange(location: end, length: 0))
            view.textView.insertText(text, replacementRange: NSRange(location: end, length: 0))
            try idle(view)
        }

        /// The body's input has landed and its link pass has run.
        func idle(_ view: NativeDocumentView) throws {
            try BindingAcceptance.wait {
                !self.host.isBusy && view.binding.state != nil && !view.binding.hasPendingWork
                    && !view.binding.store.hasScheduledLinks && !view.binding.store.isLinking
            }
        }

        /// “林雾@1”: the page the active pane shows and that pane.
        func shown() -> String {
            let title = host.activeHome.map { "项目主页 · \($0.name)" } ?? host.activeChapter?.title ?? host.activeElement?.name
                ?? host.activeDrift?.title ?? host.activeCategory?.name ?? host.activeStoryline?.name ?? "无"
            return "\(title)@\(host.activePane)"
        }

        func key(_ project: WorkspaceProject, _ target: WorkspaceTabTarget) -> MacChapterWorkspace.TabKey {
            .body(BindingAcceptance.tabsScope(project, target))
        }

        func titles(_ pane: Int) -> [String] { host.tabTitles(pane: pane) }

        /// The tab's context menu as a right-click on its button asks for it.
        func menuItem(pane: Int, _ key: MacChapterWorkspace.TabKey, _ identifier: String) throws -> LibraryMenuItem {
            guard let index = host.tabKeys(pane: pane).firstIndex(of: key) else { throw LabError.message("Pane \(pane) has no tab \(key)") }
            let button = host.tabButtons(pane: pane)[index]
            window.contentView?.layoutSubtreeIfNeeded()
            let point = button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: nil)
            let event = NSEvent.mouseEvent(with: .rightMouseDown, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                           windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
            guard let menu = button.menu(for: event),
                  let item = menu.items.first(where: { $0.accessibilityIdentifier() == identifier }) as? LibraryMenuItem else {
                throw LabError.message("The tab menu has no \(identifier)")
            }
            return item
        }

        /// Chooses a tab menu command and waits until nothing is in flight.
        func choose(pane: Int, _ key: MacChapterWorkspace.TabKey, _ identifier: String) throws {
            let item = try menuItem(pane: pane, key, identifier)
            try BindingAcceptance.require(item.isEnabled, "\(identifier) is off")
            item.press()
            try BindingAcceptance.wait { !self.host.isBusy && self.host.canNavigateAfterPlotGrids }
            // A batch waits between its closes; let it finish.
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
            try BindingAcceptance.wait { !self.host.isBusy && self.host.canNavigateAfterPlotGrids }
        }

        /// A key press through the menu, as the app's main menu performs it.
        func press(_ menu: NSMenu, _ characters: String, _ flags: NSEvent.ModifierFlags, code: UInt16) throws {
            let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                         windowNumber: window.windowNumber, context: nil, characters: characters,
                                         charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code)!
            try BindingAcceptance.require(menu.performKeyEquivalent(with: event), "The menu did not perform \(characters)")
            try BindingAcceptance.wait { !self.host.isBusy }
            try settled()
        }

        func mouse(_ type: NSEvent.EventType, _ point: NSPoint) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                               windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
                               pressure: type == .leftMouseUp ? 0 : 1)!
        }

        /// Drags the tab's button by `dx` along its strip (or `dy` off it) and lets go.
        func drag(pane: Int, _ key: MacChapterWorkspace.TabKey, to end: (NSView) -> NSPoint) throws {
            window.contentView?.layoutSubtreeIfNeeded()
            guard let index = host.tabKeys(pane: pane).firstIndex(of: key) else { throw LabError.message("No tab to drag") }
            let button = host.tabButtons(pane: pane)[index]
            let start = button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: nil)
            let target = end(button)
            button.mouseDown(with: mouse(.leftMouseDown, start))
            for step in 1...4 {
                let t = CGFloat(step) / 4
                button.mouseDragged(with: mouse(.leftMouseDragged, NSPoint(x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t)))
            }
            button.mouseUp(with: mouse(.leftMouseUp, target))
        }

        /// Starts editing a 情节规划格 cell of the shown chapter with more
        /// text than Rust accepts: the gesture is refused once committed.
        func overlongCell(_ project: WorkspaceProject, _ chapter: WorkspaceChapter, pane: Int = 0) throws {
            host.setPlotPlanner(shown: true, projectID: project.id, nodeID: chapter.id)
            guard let dock = host.retainedPlotDock(pane: pane, nodeID: chapter.id) else { throw LabError.message("No 情节规划格 dock") }
            try BindingAcceptance.wait { dock.model.loaded && !dock.model.busy }
            window.contentView?.layoutSubtreeIfNeeded()
            let grid = dock.canvas.grid
            dock.canvas.beginEditing(.cell(row: grid.rows[0].id, column: grid.columns[0].id))
            dock.canvas.editor.insertText(String(repeating: "长", count: 10_001), replacementRange: dock.canvas.editor.selectedRange())
        }

        /// Quitting: the tabs are saved as they are, then every owner closes.
        func quit() throws {
            session.suspend()
            let host = self.host
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "The workspace did not close")
            window.close()
        }

        func cleanup() {
            window.close()
            try? FileManager.default.removeItem(at: root)
        }
    }

    private struct TabsPages {
        let element: WorkspaceElement
        let other: WorkspaceElement
        let category: WorkspaceElementCategory
        let storyline: WorkspaceStoryline
        let drift: WorkspaceDrift
    }

    private static func tabsScope(_ project: WorkspaceProject, _ target: WorkspaceTabTarget) -> DocumentScope {
        switch target {
        case .chapter(let chapter): return .chapter(ChapterScope(projectID: project.id, chapterID: chapter.id))
        case .element(let element): return .element(ElementScope(projectID: project.id, elementID: element.id))
        case .storyline(let storyline): return .storyline(StorylineScope(projectID: project.id, storylineID: storyline.id))
        case .drift(let drift): return .drift(DriftScope(projectID: project.id, driftID: drift.id))
        case .category(let category): return .category(CategoryScope(projectID: project.id, categoryID: category.id))
        }
    }

    // MARK: 后退 and 前进

    private static func tabsBackForward() throws {
        let harness = try TabsHarness()
        defer { harness.cleanup() }
        let host = harness.host, journal = harness.journal
        let (project, chapters) = try harness.project("导航合成项目", chapters: ["雨夜", "钟楼", "码头"])
        let pages = try harness.pages(project)
        try harness.show(project)
        let (rain, bell) = (chapters[0], chapters[1])
        let homeTitle = "项目主页 · 导航合成项目"

        // Visits across kinds and panes.
        try harness.open(project, .chapter(rain))
        try harness.open(project, .element(pages.element))
        let _: NativeDocumentView = try tabsStep { host.split(completion: $0) }
        try harness.settled()
        try harness.open(project, .drift(pages.drift), in: 1)
        try harness.open(project, .category(pages.category), in: 0)
        try harness.open(project, .storyline(pages.storyline), in: 0)
        try require(host.openHome(project: project) != nil, "项目主页 did not open")
        try harness.settled()
        let visited = ["雨夜", "林雾", "林雾", "旧信", "人物", "主线", homeTitle]
        try require(host.historyTitles.titles == visited && host.historyTitles.current == 6 && host.canGoBack && !host.canGoForward,
                    "The history reads \(host.historyTitles)")

        // 后退 through every page in the pane that showed it; nothing is written.
        var mark = try journal.mark()
        var backward: [String] = []
        while host.canGoBack {
            try require(harness.step { host.goBack(completion: $0) } == nil, "后退 failed: \(harness.errors)")
            backward.append(harness.shown())
        }
        try require(backward == ["主线@0", "人物@0", "旧信@1", "林雾@1", "林雾@0", "雨夜@0"], "后退 showed \(backward)")
        var forward: [String] = []
        while host.canGoForward {
            try require(harness.step { host.goForward(completion: $0) } == nil, "前进 failed: \(harness.errors)")
            forward.append(harness.shown())
        }
        try require(forward == ["林雾@0", "林雾@1", "旧信@1", "人物@0", "主线@0", "\(homeTitle)@0"], "前进 showed \(forward)")
        // ⌘[ and ⌘] through the menu the app builds from its layout.
        let probe = TabsMenuProbe(host: host, window: harness.window)
        let menu = probe.menu()
        try harness.press(menu, "[", .command, code: 33)
        try require(harness.shown() == "主线@0", "⌘[ showed \(harness.shown())")
        try harness.press(menu, "]", .command, code: 30)
        try require(harness.shown() == "\(homeTitle)@0" && !host.canGoForward, "⌘] showed \(harness.shown())")
        try journal.expect([], since: mark, "后退 and 前进")

        // A new visit drops the pages ahead.
        try harness.step { host.goBack(completion: $0) }
        try harness.step { host.goBack(completion: $0) }
        try require(harness.shown() == "人物@0" && host.canGoForward, "Two steps back showed \(harness.shown())")
        try harness.open(project, .chapter(bell), in: 0)
        try require(!host.canGoForward && host.historyTitles.titles == ["雨夜", "林雾", "林雾", "旧信", "人物", "钟楼"],
                    "A new visit kept the pages ahead: \(host.historyTitles)")

        // A closed tab opens again in its pane.
        let categoryKey = harness.key(project, .category(pages.category))
        let _: Bool = try tabsStep { host.closeTab(pane: 0, scope: tabsScope(project, .category(pages.category)), completion: $0) }
        try require(!host.tabKeys(pane: 0).contains(categoryKey), "The category tab did not close")
        mark = try journal.mark()
        try harness.step { host.goBack(completion: $0) }
        try require(harness.shown() == "人物@0" && host.isTabOpen(pane: 0, scope: tabsScope(project, .category(pages.category))),
                    "后退 did not reopen the closed tab: \(harness.shown())")
        // Its pane gone, a page opens in the active pane.
        let _: Bool = try tabsStep { host.closeSecondPane(completion: $0) }
        try require(host.paneCount == 1, "The second pane stayed")
        try harness.step { host.goBack(completion: $0) }
        try require(harness.shown() == "旧信@0", "A page of the closed pane showed as \(harness.shown())")
        try journal.expect([], since: mark, "Reopening pages through 后退")

        // Trashed and purged pages are skipped.
        let _: WorkspaceElementReply<WorkspaceElement> = try tabsStep {
            host.trashElement(projectID: project.id, elementID: pages.element.id, completion: $0)
        }
        try harness.settled()
        try harness.step { host.goBack(completion: $0) }
        try require(harness.shown() == "雨夜@0" && !host.canGoBack, "后退 over a trashed element showed \(harness.shown())")
        let _: WorkspaceDriftReply<WorkspaceDrift> = try tabsStep { host.trashDrift(projectID: project.id, driftID: pages.drift.id, completion: $0) }
        let workspace = harness.workspace
        let listing: WorkspaceTrashListing = try tabsStep { workspace.trash(projectID: project.id, completion: $0) }
        guard let trashedDrift = listing.trashed.first(where: { $0.id == pages.drift.id })?.item else { throw LabError.message("旧信 is not in the trash") }
        let _: WorkspaceTrashPurgeReply = try tabsStep { host.purge(trashedDrift, projectID: project.id, completion: $0) }
        try harness.settled()
        mark = try journal.mark()
        try harness.step { host.goForward(completion: $0) }
        try require(harness.shown() == "人物@0", "前进 over a trashed and a purged page showed \(harness.shown())")
        try journal.expect([], since: mark, "Skipping trashed and purged pages")

        // Queued input, composition and a 情节规划格 edit on its way hold it.
        let view = try require(value: host.activeView, "The category page has no body")
        view.textView.setSelectedRange(NSRange(location: 0, length: 0))
        view.textView.insertText("风", replacementRange: NSRange(location: 0, length: 0))
        try require(view.binding.hasPendingWork, "The queued fixture was already idle")
        try require(harness.step(settling: false) { host.goBack(completion: $0) } != nil && harness.shown() == "人物@0",
                    "后退 went ahead with queued input")
        try harness.idle(view)
        view.textView.setMarkedText("feng", selectedRange: NSRange(location: 4, length: 0), replacementRange: NSRange(location: 1, length: 0))
        try require(view.textView.hasMarkedText(), "Composition did not start")
        try require(harness.step(settling: false) { host.goBack(completion: $0) } != nil && harness.shown() == "人物@0"
                    && view.textView.hasMarkedText(),
                    "后退 went ahead while composing")
        view.textView.insertText("丰", replacementRange: NSRange(location: NSNotFound, length: 0))
        try harness.idle(view)
        try harness.open(project, .chapter(bell), in: 0)
        host.setPlotPlanner(shown: true, projectID: project.id, nodeID: bell.id)
        let dock = try require(value: host.retainedPlotDock(pane: 0, nodeID: bell.id), "钟楼 shows no 情节规划格")
        try wait { dock.model.loaded && !dock.model.busy }
        let grid = dock.canvas.grid
        _ = dock.model.perform([.setCell(row: grid.rows[0].id, column: grid.columns[0].id, value: "钟声")])
        try require(!host.canNavigate && harness.step(settling: false) { host.goBack(completion: $0) } != nil && harness.shown() == "钟楼@0",
                    "后退 went ahead while a 情节规划格 edit was on its way")
        try wait { dock.model.loaded && !dock.model.busy && host.canNavigate }
        try harness.step { host.goBack(completion: $0) }
        try require(harness.shown() == "人物@0", "后退 after the guards showed \(harness.shown())")

        // Another project starts a new history; coming back starts one too.
        let (other, _) = try harness.project("另一部", chapters: ["序章"])
        try harness.show(other)
        try require(!host.canGoBack && !host.canGoForward && host.historyTitles.titles.isEmpty && !host.hasTabs(projectID: project.id),
                    "Switching projects kept the history: \(host.historyTitles)")
        try harness.show(project)
        try require(!host.canGoBack && !host.canGoForward && host.historyTitles.titles.count == 1, "Coming back kept the history: \(host.historyTitles)")
        try harness.quit()
    }

    // MARK: Tab management

    private static func tabsManagement() throws {
        let harness = try TabsHarness()
        defer { harness.cleanup() }
        let host = harness.host, journal = harness.journal, workspace = harness.workspace
        let (project, chapters) = try harness.project("标签合成项目", chapters: ["晨雾", "午潮", "暮钟", "夜航"])
        let pages = try harness.pages(project)
        try harness.show(project)
        let (a, b, c, d) = (chapters[0], chapters[1], chapters[2], chapters[3])
        let keyA = harness.key(project, .chapter(a)), keyB = harness.key(project, .chapter(b))
        let keyC = harness.key(project, .chapter(c)), keyD = harness.key(project, .chapter(d))
        let keyE = harness.key(project, .element(pages.element))
        for chapter in chapters { try harness.open(project, .chapter(chapter)) }
        try harness.open(project, .element(pages.element))
        try require(host.tabKeys(pane: 0) == [keyA, keyB, keyC, keyD, keyE], "Tabs read \(harness.titles(0))")

        // 关闭 on the shown tab saves its text through the close path; the tab in its place shows.
        let viewC = try harness.open(project, .chapter(c))
        try harness.type(viewC, "潮水退去。")
        var mark = try journal.mark()
        try harness.choose(pane: 0, keyC, "tab-menu-close")
        try wait { host.shownTab(pane: 0) == keyD && !host.isBusy }
        try require(host.tabKeys(pane: 0) == [keyA, keyB, keyD, keyE] && host.shownTab(pane: 0) == keyD
                    && !workspace.hasOpenDocument(tabsScope(project, .chapter(c))), "关闭 left \(harness.titles(0)) showing \(harness.shown())")
        let reopened = try harness.open(project, .chapter(c))
        try require(reopened !== viewC && reopened.textView.string.contains("潮水退去。"), "The closed tab's text was not saved: \(reopened.textView.string)")
        // 关闭右侧全部 and 关闭其他 keep the tab they were chosen on and show it.
        try harness.choose(pane: 0, keyD, "tab-menu-close-right")
        try wait { host.tabKeys(pane: 0) == [keyA, keyB, keyD] && !host.isBusy }
        try require(host.tabKeys(pane: 0) == [keyA, keyB, keyD] && host.shownTab(pane: 0) == keyD, "关闭右侧全部 left \(harness.titles(0))")
        try harness.choose(pane: 0, keyB, "tab-menu-close-others")
        try wait { host.tabKeys(pane: 0) == [keyB] && !host.isBusy }
        try require(host.tabKeys(pane: 0) == [keyB] && host.shownTab(pane: 0) == keyB && workspace.openDocumentCount == 1,
                    "关闭其他 left \(harness.titles(0)) with \(workspace.openDocumentCount) owners")
        try require((try harness.menuItem(pane: 0, keyB, "tab-menu-close-others")).isEnabled == false
                    && (try harness.menuItem(pane: 0, keyB, "tab-menu-close-right")).isEnabled == false, "A lone tab offers closing others")
        try journal.expect([], since: mark, "Closing tabs whose text was saved")

        // 全部关闭 stops at a refusal in the middle and names the tab.
        try harness.open(project, .chapter(a))
        try harness.open(project, .chapter(c))
        try harness.open(project, .chapter(d))
        try harness.open(project, .chapter(c))
        try harness.overlongCell(project, c)
        mark = try journal.mark()
        harness.errors.removeAll()
        try harness.choose(pane: 0, keyB, "tab-menu-close-all")
        try wait { harness.errors.contains { $0.contains("无法关闭") } }
        try wait { !host.isBusy && host.canNavigate }
        let refusal = harness.errors.first { $0.contains("无法关闭") } ?? ""
        try require(refusal.hasPrefix("“暮钟”无法关闭：情节规划格的修改没有保存：") && refusal.contains("没有关闭")
                    && host.tabKeys(pane: 0) == [keyC, keyD] && host.shownTab(pane: 0) == keyC
                    && !workspace.hasOpenDocument(tabsScope(project, .chapter(b))) && !workspace.hasOpenDocument(tabsScope(project, .chapter(a))),
                    "全部关闭 read “\(refusal)” leaving \(harness.titles(0))")
        try journal.expect([], since: mark, "A 全部关闭 refused in the middle")
        try harness.choose(pane: 0, keyC, "tab-menu-close-all")
        try wait { host.tabKeys(pane: 0).isEmpty && !host.isBusy }
        try require(host.tabKeys(pane: 0).isEmpty && workspace.openDocumentCount == 0, "全部关闭 left \(harness.titles(0))")

        // 在另一侧打开: a second pane shows the page on the same owner.
        try harness.open(project, .chapter(a))
        let viewB = try harness.open(project, .chapter(b))
        try harness.choose(pane: 0, keyA, "tab-menu-open-other-side")
        try require(host.paneCount == 2 && host.tabKeys(pane: 0) == [keyA, keyB] && host.tabKeys(pane: 1) == [keyA]
                    && host.shownTab(pane: 1) == keyA && host.activePane == 1 && workspace.openDocumentCount == 2,
                    "在另一侧打开 left \(harness.titles(0)) | \(harness.titles(1)) with \(workspace.openDocumentCount) owners")
        // 移到另一侧 keeps the view, its selection and its history.
        try harness.type(viewB, "午后潮声。")
        viewB.textView.setSelectedRange(NSRange(location: 1, length: 2))
        let selection = viewB.textView.selectedRange()
        try require(viewB.binding.state?.projection.canUndo == true, "午潮 has nothing to undo")
        mark = try journal.mark()
        try harness.choose(pane: 0, keyB, "tab-menu-move-other-side")
        try require(host.tabKeys(pane: 0) == [keyA] && host.tabKeys(pane: 1) == [keyA, keyB] && host.shownTab(pane: 1) == keyB
                    && host.retainedView(pane: 1, scope: tabsScope(project, .chapter(b))) === viewB
                    && viewB.textView.selectedRange() == selection && viewB.binding.state?.projection.canUndo == true
                    && viewB.textView.string.contains("午后潮声。") && workspace.openDocumentCount == 2,
                    "移到另一侧 left \(harness.titles(0)) | \(harness.titles(1))")
        // Moving a page the other pane has: that pane's tab shows it.
        try harness.choose(pane: 0, keyA, "tab-menu-move-other-side")
        try require(host.tabKeys(pane: 0).isEmpty && host.tabKeys(pane: 1) == [keyA, keyB] && host.shownTab(pane: 1) == keyA
                    && workspace.openDocumentCount == 2, "Moving onto the same page left \(harness.titles(0)) | \(harness.titles(1))")
        // 解除分屏: the right pane's tabs join the left with their views; its shown page stays shown.
        try harness.open(project, .chapter(c), in: 0)
        host.activate(pane: 1)
        try harness.choose(pane: 1, keyB, "tab-menu-unsplit")
        try require(host.paneCount == 1 && host.tabKeys(pane: 0) == [keyC, keyA, keyB] && host.shownTab(pane: 0) == keyA
                    && host.retainedView(pane: 0, scope: tabsScope(project, .chapter(b))) === viewB && workspace.openDocumentCount == 3,
                    "解除分屏 left \(harness.titles(0)) showing \(harness.shown())")
        try journal.expect([], since: mark, "Moving tabs and merging panes")

        // ⌥⌘← and ⌥⌘→ cycle the active pane's tabs; ⌘W closes the shown one, then the window.
        let probe = TabsMenuProbe(host: host, window: harness.window)
        let windowProbe = TabsWindowProbe()
        harness.window.delegate = windowProbe
        let menu = probe.menu()
        try require(host.openHome(project: project) != nil, "项目主页 did not open")
        try harness.settled()
        let home = MacChapterWorkspace.TabKey.home(project.id)
        let left = "\u{F702}", right = "\u{F703}"
        var cycled: [MacChapterWorkspace.TabKey?] = []
        for _ in 0..<5 {
            try harness.press(menu, right, [.command, .option], code: 124)
            cycled.append(host.shownTab(pane: 0))
        }
        try harness.press(menu, left, [.command, .option], code: 123)
        cycled.append(host.shownTab(pane: 0))
        try require(cycled == [keyC, keyA, keyB, home, keyC, home], "⌥⌘→ and ⌥⌘← showed \(cycled)")
        try harness.press(menu, "w", .command, code: 13)
        try require(host.tabKeys(pane: 0) == [keyC, keyA, keyB] && host.shownTab(pane: 0) == keyC && windowProbe.closeRequests == 0,
                    "⌘W left \(host.tabKeys(pane: 0))")
        try harness.press(menu, "w", .command, code: 13)
        try require(host.tabKeys(pane: 0) == [keyA, keyB] && host.shownTab(pane: 0) == keyA, "The second ⌘W left \(harness.titles(0))")
        for _ in 0..<2 { try harness.press(menu, "w", .command, code: 13) }
        try require(host.tabKeys(pane: 0).isEmpty && windowProbe.closeRequests == 0 && workspace.openDocumentCount == 0, "⌘W kept tabs")
        try harness.press(menu, "w", .command, code: 13)
        try require(windowProbe.closeRequests == 1, "⌘W without a tab did not close the window")

        // Dragging a tab reorders it within its pane; a click selects; a drop off the strip changes nothing.
        for chapter in chapters { try harness.open(project, .chapter(chapter)) }
        let owners = workspace.openDocumentCount
        mark = try journal.mark()
        try harness.drag(pane: 0, keyA) { _ in
            let last = host.tabButtons(pane: 0)[3]
            return last.convert(NSPoint(x: last.bounds.maxX + 20, y: last.bounds.midY), to: nil)
        }
        try require(host.tabKeys(pane: 0) == [keyB, keyC, keyD, keyA] && host.shownTab(pane: 0) == keyD, "Dragging 晨雾 last read \(harness.titles(0))")
        try harness.drag(pane: 0, keyD) { _ in
            let first = host.tabButtons(pane: 0)[0]
            return first.convert(NSPoint(x: first.bounds.minX + 2, y: first.bounds.midY), to: nil)
        }
        try require(host.tabKeys(pane: 0) == [keyD, keyB, keyC, keyA], "Dragging 夜航 first read \(harness.titles(0))")
        try harness.drag(pane: 0, keyB) { button in button.convert(NSPoint(x: button.bounds.midX + 30, y: button.bounds.midY + 200), to: nil) }
        try require(host.tabKeys(pane: 0) == [keyD, keyB, keyC, keyA], "A drop off the strip moved a tab: \(harness.titles(0))")
        try harness.drag(pane: 0, keyC) { button in button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: nil) }
        try harness.settled()
        try require(host.shownTab(pane: 0) == keyC && host.tabKeys(pane: 0) == [keyD, keyB, keyC, keyA] && workspace.openDocumentCount == owners,
                    "A click on a tab showed \(harness.shown())")
        try journal.expect([], since: mark, "Dragging tabs")
        harness.window.delegate = nil
        try harness.quit()
    }

    // MARK: Restore on relaunch

    private static func tabsRestore() throws {
        let first = try TabsHarness()
        let root = first.root
        defer { first.cleanup() }
        var host = first.host
        let (project, chapters) = try first.project("恢复标签合成项目", chapters: ["雨夜", "钟楼", "码头"])
        let pages = try first.pages(project)
        let (rain, bell, dock) = (chapters[0], chapters[1], chapters[2])
        try first.show(project)
        try require(first.settings.lastProject == project.id, "The shown project is not the last one")

        // Pane 0: 雨夜, 码头, 林雾, 阿青, 人物 showing 林雾; pane 1: 林雾, 旧信, 主线, 钟楼 and
        // the 项目主页, showing 主线; the right pane active.
        for target: WorkspaceTabTarget in [.chapter(rain), .chapter(dock), .element(pages.element), .element(pages.other), .category(pages.category)] {
            try first.open(project, target)
        }
        try first.open(project, .element(pages.element))
        let _: NativeDocumentView = try tabsStep { host.split(completion: $0) }
        try first.settled()
        for target: WorkspaceTabTarget in [.drift(pages.drift), .storyline(pages.storyline), .chapter(bell)] { try first.open(project, target, in: 1) }
        try require(host.openHome(project: project, in: 1) != nil, "项目主页 did not open")
        try first.settled()
        let storylineView = try first.open(project, .storyline(pages.storyline), in: 1)
        let page = { (kind: RecentPage.Kind, id: String) in RecentPage(kind: kind, id: id) }
        let expected = TabSession(panes: [
            TabSession.Pane(tabs: [page(.chapter, rain.id), page(.chapter, dock.id), page(.element, pages.element.id), page(.element, pages.other.id),
                                   page(.category, pages.category.id)], active: page(.element, pages.element.id)),
            TabSession.Pane(tabs: [page(.element, pages.element.id), page(.drift, pages.drift.id), page(.storyline, pages.storyline.id),
                                   page(.chapter, bell.id)], active: page(.storyline, pages.storyline.id), home: true),
        ], activePane: 1)
        try require(host.tabSession(projectID: project.id) == expected, "The host's tabs read \(host.tabSession(projectID: project.id))")
        try wait { first.settings.tabSession(projectID: project.id) == expected }
        try require(LabSettingsStore(directory: root).tabSession(projectID: project.id) == expected, "settings.json lacks the tabs")

        // Changes gather before they are saved, once for a burst; typing saves nothing.
        let driftScope = tabsScope(project, .drift(pages.drift))
        host.moveTab(pane: 1, scope: driftScope, to: 0)
        host.moveTab(pane: 1, scope: driftScope, to: 2)
        try require(first.settings.tabSession(projectID: project.id) == expected, "A tab change was saved at once")
        try wait {
            first.settings.tabSession(projectID: project.id)?.panes[1].tabs
                == [page(.element, pages.element.id), page(.storyline, pages.storyline.id), page(.drift, pages.drift.id), page(.chapter, bell.id)]
        }
        host.moveTab(pane: 1, scope: driftScope, to: 1)
        try wait { first.settings.tabSession(projectID: project.id) == expected }
        let before = try Data(contentsOf: first.settings.fileURL)
        try first.type(storylineView, "风从海上吹来。")
        try first.type(storylineView, "潮声渐远。")
        RunLoop.current.run(until: Date().addingTimeInterval(MacTabSession.saveDelay * 3))
        try require((try Data(contentsOf: first.settings.fileURL)) == before, "Typing wrote settings.json")

        // Another project with saved tabs, then deleted: it leaves nothing behind.
        let (doomed, doomedChapters) = try first.project("将删除的项目", chapters: ["残页"])
        try first.show(doomed)
        try first.open(doomed, .chapter(doomedChapters[0]))
        try first.show(project)
        try require(first.settings.tabSession(projectID: doomed.id) != nil && first.settings.tabSession(projectID: project.id) == expected
                    && !host.hasTabs(projectID: doomed.id), "Switching back lost a project's tabs")
        try require(host.tabSession(projectID: project.id).panes.map(\.tabs) == expected.panes.map(\.tabs), "Coming back restored \(host.tabSession(projectID: project.id))")

        // Quitting keeps the tabs as they are.
        try first.quit()
        try require(LabSettingsStore(directory: root).tabSession(projectID: project.id) == expected, "Quitting changed the saved tabs")

        // While the app is closed: 码头 goes to the trash, 阿青 is purged, the other project is deleted.
        do {
            let offline = LabWorkspaceCore(directory: first.directory)
            let _: [WorkspaceProject] = try tabsStep { offline.projects(completion: $0) }
            let _: WorkspaceChapterTrashReply = try tabsStep { offline.trashChapter(projectID: project.id, chapterID: dock.id, completion: $0) }
            let _: WorkspaceElementReply<WorkspaceElement> = try tabsStep {
                offline.trashElement(projectID: project.id, elementID: pages.other.id, completion: $0)
            }
            let _: WorkspaceTrashPurgeReply = try tabsStep {
                offline.purgeTrashed(projectID: project.id, kind: "element", id: pages.other.id, completion: $0)
            }
            let _: WorkspaceProjectDeletionReply = try tabsStep { offline.deleteProject(projectID: doomed.id, completion: $0) }
            let closed: Bool = try tabsStep { offline.close(completion: $0) }
            try require(closed, "The offline workspace did not close")
            // As the deletion flow does: its settings go, and it can no longer open at launch.
            let store = LabSettingsStore(directory: root)
            store.setLastProject(doomed.id)
            store.forgetProject(doomed.id)
            try require(store.tabSession(projectID: doomed.id) == nil && store.lastProject == nil, "The deleted project kept its tabs")
            store.setLastProject(project.id)
        }
        // A hand-edited file: an unreadable tab and an unreadable project entry drop alone.
        var json = try JSONSerialization.jsonObject(with: Data(contentsOf: first.settings.fileURL)) as! [String: Any]
        var sessions = json["tabSessions"] as! [String: Any]
        var stored = sessions[project.id] as! [String: Any]
        var storedPanes = stored["panes"] as! [[String: Any]]
        var storedTabs = storedPanes[0]["tabs"] as! [Any]
        storedTabs.insert(["kind": "planet", "id": "synthetic"], at: 1)
        storedPanes[0]["tabs"] = storedTabs
        stored["panes"] = storedPanes
        sessions[project.id] = stored
        sessions["unreadable"] = 5
        json["tabSessions"] = sessions
        try JSONSerialization.data(withJSONObject: json).write(to: first.settings.fileURL)

        // A cold relaunch opens the last project with its tabs.
        let second = try TabsHarness(root: root)
        defer { second.window.close() }
        host = second.host
        let workspace = second.workspace
        let projects = try second.projects()
        try require(projects.map(\.id) == [project.id] && second.settings.tabSession(projectID: "unreadable") == nil,
                    "The relaunch lists \(projects.map(\.name))")
        guard let launch = second.session.launchProject(in: projects) else { throw LabError.message("No project opens at launch") }
        try require(launch == project && second.session.launchProject(in: []) == nil, "The launch project is \(launch.name)")
        let recents = second.settings.recentPages(projectID: project.id)
        let mark = try second.journal.mark()
        try second.show(launch)
        let paneTitles = [second.titles(0), second.titles(1)]
        try require(paneTitles == [["雨夜", "林雾", "人物"], ["林雾", "旧信", "主线", "钟楼"]] && host.paneCount == 2 && host.activePane == 1
                    && host.homeProjects(pane: 1) == [project] && host.activeHome == nil,
                    "The relaunch restored \(paneTitles) in \(host.paneCount) panes")
        try require(host.shownTab(pane: 0) == second.key(project, .element(pages.element))
                    && host.shownTab(pane: 1) == second.key(project, .storyline(pages.storyline)) && second.shown() == "主线@1",
                    "The relaunch shows \(second.shown())")
        // Only each pane's shown tab owns its body.
        let rainScope = tabsScope(project, .chapter(rain))
        try require(workspace.openDocumentCount == 2 && workspace.hasOpenDocument(tabsScope(project, .element(pages.element)))
                    && workspace.hasOpenDocument(tabsScope(project, .storyline(pages.storyline)))
                    && !workspace.hasOpenDocument(rainScope) && !host.isTabOpen(pane: 0, scope: rainScope)
                    && !workspace.hasOpenDocument(tabsScope(project, .chapter(bell))), "The relaunch opened \(workspace.openDocumentCount) owners")
        try require(host.retainedView(pane: 1, scope: tabsScope(project, .storyline(pages.storyline)))?.textView.string.contains("潮声渐远。") == true,
                    "The restored storyline lost its text")
        try second.journal.expect([], since: mark, "Restoring tabs")
        try require(second.settings.recentPages(projectID: project.id) == recents, "Restoring changed 最近")
        try require(!host.canGoBack && host.historyTitles.titles == ["主线"], "The restored history reads \(host.historyTitles)")
        // Pages left out leave the saved tabs too.
        try wait {
            second.settings.tabSession(projectID: project.id)?.panes[0].tabs == [page(.chapter, rain.id), page(.element, pages.element.id),
                                                                                 page(.category, pages.category.id)]
        }
        // A restored tab opens its body in place when selected.
        let buttons = host.tabButtons(pane: 0)
        try require(buttons.count == 3 && buttons[0].title == "雨夜", "Pane 0's buttons read \(buttons.map(\.title))")
        buttons[0].performClick(nil)
        try wait { host.shownTab(pane: 0) == second.key(project, .chapter(rain)) && !host.isBusy }
        try second.settled()
        try require(workspace.hasOpenDocument(rainScope) && host.isTabOpen(pane: 0, scope: rainScope) && second.titles(0) == ["雨夜", "林雾", "人物"]
                    && workspace.openDocumentCount == 3, "Selecting a restored tab read \(second.titles(0))")
        try second.journal.expect([], since: mark, "Opening a restored tab")
        try second.quit()

        // Without a last project nothing opens at launch (the 项目书架 shows).
        let fresh = LabSettingsStore(directory: root.appendingPathComponent("fresh"))
        let bare = MacTabSession(host: MacChapterWorkspace(workspace: workspace), store: fresh, workspace: workspace)
        try require(bare.launchProject(in: projects) == nil, "A project opened without a last one")
    }

    // MARK: Switching projects

    private static func tabsProjectSwitch() throws {
        let harness = try TabsHarness()
        defer { harness.cleanup() }
        let host = harness.host, workspace = harness.workspace, journal = harness.journal
        let (first, chapters) = try harness.project("第一部", chapters: ["晨雾", "午潮", "暮钟"])
        let (second, secondChapters) = try harness.project("第二部", chapters: ["序章"])
        let (a, b, c) = (chapters[0], chapters[1], chapters[2])
        try harness.show(first)
        let viewA = try harness.open(first, .chapter(a))
        try harness.type(viewA, "雾里有船。")
        try harness.open(first, .chapter(b))
        let _: NativeDocumentView = try tabsStep { host.split(completion: $0) }
        try harness.settled()
        host.activate(pane: 0)
        try require(host.paneCount == 2 && harness.titles(0) == ["晨雾", "午潮"] && harness.titles(1) == ["午潮"], "The first project's tabs differ")

        // Switching saves and closes them; the other project has none yet.
        var mark = try journal.mark()
        try harness.show(second)
        try require(!host.hasTabs(projectID: first.id) && workspace.openDocumentCount == 0 && harness.settings.lastProject == second.id
                    && harness.settings.tabSession(projectID: first.id)?.panes.map(\.tabs.count) == [2, 1] && !host.canGoBack,
                    "Switching kept \(host.projectsWithTabs) with \(workspace.openDocumentCount) owners")
        try harness.open(second, .chapter(secondChapters[0]))
        // Back again: its tabs, split and text return, only the shown ones opened.
        try harness.show(first)
        try require(host.paneCount == 2 && harness.titles(0) == ["晨雾", "午潮"] && harness.titles(1) == ["午潮"]
                    && host.shownTab(pane: 0) == harness.key(first, .chapter(b)) && host.activePane == 0
                    && workspace.openDocumentCount == 1 && !host.hasTabs(projectID: second.id)
                    && harness.settings.tabSession(projectID: second.id)?.panes.first?.tabs.count == 1,
                    "Coming back restored \(harness.titles(0)) | \(harness.titles(1)) with \(workspace.openDocumentCount) owners")
        try require(!host.canGoBack && host.historyTitles.titles == ["午潮"], "Coming back kept the history: \(host.historyTitles)")
        let restoredA = try harness.open(first, .chapter(a))
        try require(restoredA.textView.string.contains("雾里有船。"), "The first chapter lost its text")
        try journal.expect([], since: mark, "Switching projects and back")

        // A tab that cannot close keeps the project and is named.
        try harness.open(first, .chapter(c))
        try harness.overlongCell(first, c)
        mark = try journal.mark()
        let session = harness.session
        var result: Result<Void, Error>?
        session.show(second) { result = $0 }
        try wait { result != nil }
        guard case .failure(let refusal)? = result else { throw LabError.message("The switch went ahead past a tab that could not close") }
        try wait { !host.isBusy && host.canNavigate }
        try require(refusal.localizedDescription.hasPrefix("“暮钟”无法关闭：情节规划格的修改没有保存：") && host.hasTabs(projectID: first.id)
                    && host.tabKeys(pane: 0).contains(harness.key(first, .chapter(c))) && session.projectID == first.id
                    && !host.hasTabs(projectID: second.id) && harness.settings.lastProject == first.id,
                    "The refused switch read “\(refusal.localizedDescription)” with \(host.projectsWithTabs)")
        try journal.expect([], since: mark, "A refused switch")
        try harness.show(second)
        try require(!host.hasTabs(projectID: first.id) && harness.titles(0) == ["序章"], "The second switch read \(harness.titles(0))")
        try harness.quit()

        // 设置 › 快捷键 lists the new commands; ⌘W is fixed, ⌘[ is taken.
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = LabSettingsStore(directory: root)
        let menu = MacMainMenu.build([:])
        for (command, key, flags, path) in [
            (MacMenuCommand.closeTab, "w", NSEvent.ModifierFlags.command, "文件 › 关闭标签"),
            (.back, "[", .command, "视图 › 后退"), (.forward, "]", .command, "视图 › 前进"),
            (.previousTab, "\u{F702}", [.command, .option], "视图 › 上一个标签"), (.nextTab, "\u{F703}", [.command, .option], "视图 › 下一个标签"),
        ] {
            let item = try require(value: MacMainMenu.item(command, in: menu), "The menu lacks \(command)")
            try require(item.keyEquivalent == key && item.keyEquivalentModifierMask == flags && MacMainMenu.path(command) == path,
                        "\(path) is “\(item.keyEquivalent)” \(item.keyEquivalentModifierMask.rawValue)")
        }
        let pane = MacShortcutSettingsViewController(store: store)
        pane.menuSource = { menu }
        _ = pane.view
        let listed = pane.listed.flatMap { group in group.commands.map { "\(group.title) › \($0.title)" } }
        for path in ["文件 › 关闭标签", "视图 › 后退", "视图 › 前进", "视图 › 上一个标签", "视图 › 下一个标签"] {
            try require(listed.contains(path), "设置 › 快捷键 lacks \(path)")
        }
        try require(pane.shortcutButtons[.closeTab]?.title == "⌘W" && pane.shortcutButtons[.closeTab]?.isEnabled == false
                    && pane.shortcutButtons[.back]?.title == "⌘[" && pane.shortcutButtons[.nextTab]?.title == "⌥⌘→",
                    "The pane shows \(String(describing: pane.shortcutButtons[.closeTab]?.title))")
        pane.beginRecording(.print)
        let bracket = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime,
                                       windowNumber: 0, context: nil, characters: "[", charactersIgnoringModifiers: "[", isARepeat: false, keyCode: 33)!
        try require(pane.record(bracket) && pane.recording == .print && pane.message.stringValue.contains("视图 › 后退"),
                    "Recording ⌘[ read “\(pane.message.stringValue)”")
        _ = pane.record(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                         windowNumber: 0, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}",
                                         isARepeat: false, keyCode: 53)!)
        try require(store.settings.shortcuts.isEmpty, "A refused shortcut was stored")
    }

    // MARK: 解除分屏 and ⌘W

    private static func tabsMergeAndClose() throws {
        let harness = try TabsHarness()
        defer { harness.cleanup() }
        let host = harness.host, workspace = harness.workspace, window = harness.window
        let (project, chapters) = try harness.project("合并合成项目", chapters: ["雨夜", "钟楼"])
        let pages = try harness.pages(project)
        try harness.show(project)
        let (rain, bell) = (chapters[0], chapters[1])
        let rainScope = ChapterScope(projectID: project.id, chapterID: rain.id)
        func split(showing target: WorkspaceTabTarget) throws {
            try harness.open(project, target, in: 0)
            let _: NativeDocumentView = try tabsStep { host.split(completion: $0) }
            try harness.settled()
            try require(host.paneCount == 2 && host.shownTab(pane: 1) == harness.key(project, target), "The split did not show the page on the right")
        }
        func unsplit(_ target: WorkspaceTabTarget) throws {
            try harness.choose(pane: 1, harness.key(project, target), "tab-menu-unsplit")
        }

        // An unsaved 摘要 in the right pane, on a chapter the left pane shows too.
        try split(showing: .chapter(rain))
        let right = try require(value: host.retainedChapterPage(pane: 1, scope: rainScope), "The right pane has no 雨夜 page")
        let editor = right.metadataEditor
        try wait { editor.metadata != nil && editor.summaryView.isEditable }
        try require(window.makeFirstResponder(editor.summaryView), "The 摘要 refused keyboard focus")
        editor.summaryView.insertText("雨夜启程，北岸无灯。", replacementRange: NSRange(location: 0, length: (editor.summaryView.string as NSString).length))
        try unsplit(.chapter(rain))
        try wait { !editor.isCommitting }
        let metadata: WorkspaceNodeMetadata = try tabsStep { workspace.nodeMetadata(projectID: project.id, nodeID: rain.id, completion: $0) }
        try require(host.paneCount == 1 && metadata.summary == "雨夜启程，北岸无灯。", "解除分屏 lost the 摘要: “\(metadata.summary)”")

        // An unsaved element name in the right pane.
        try split(showing: .element(pages.element))
        let elementPage = try require(value: host.retainedElementPage(pane: 1, scope: ElementScope(projectID: project.id, elementID: pages.element.id)),
                                      "The right pane has no element page")
        try require(window.makeFirstResponder(elementPage.nameField), "The name refused keyboard focus")
        guard let field = elementPage.nameField.currentEditor() as? NSTextView else { throw LabError.message("The name has no field editor") }
        field.selectAll(nil)
        field.insertText("林雾生", replacementRange: field.selectedRange())
        try unsplit(.element(pages.element))
        try wait { !elementPage.isCommitting }
        try harness.settled()
        let library: WorkspaceElementLibrary = try tabsStep { workspace.elementLibrary(projectID: project.id, completion: $0) }
        try require(host.paneCount == 1 && library.elements.contains { $0.id == pages.element.id && $0.name == "林雾生" },
                    "解除分屏 lost the element name: \(library.elements.map(\.name))")

        // A 情节规划格 cell being edited in the right pane.
        try split(showing: .chapter(bell))
        host.setPlotPlanner(shown: true, projectID: project.id, nodeID: bell.id)
        let dock = try require(value: host.retainedPlotDock(pane: 1, nodeID: bell.id), "The right pane shows no 情节规划格")
        try wait { dock.model.loaded && !dock.model.busy }
        window.contentView?.layoutSubtreeIfNeeded()
        let grid = dock.canvas.grid
        let (row, column) = (grid.rows[0].id, grid.columns[0].id)
        dock.canvas.beginEditing(.cell(row: row, column: column))
        dock.canvas.editor.insertText("钟声三响", replacementRange: dock.canvas.editor.selectedRange())
        try unsplit(.chapter(bell))
        try wait { host.paneCount == 1 && !host.plotGridsWriting() }
        let stored: WorkspacePlotGridReply = try tabsStep { workspace.plotGrid(projectID: project.id, nodeID: bell.id, ops: [], completion: $0) }
        try require(stored.grid?.value(row: row, column: column) == "钟声三响", "解除分屏 lost the 情节规划格 cell")

        // A cell Rust refuses keeps both panes and says why.
        try split(showing: .chapter(bell))
        try harness.overlongCell(project, bell, pane: 1)
        harness.errors.removeAll()
        try unsplit(.chapter(bell))
        try wait { harness.errors.contains { $0.contains("情节规划格的修改没有保存") } }
        try wait { !host.isBusy && host.canNavigate }
        try require(host.paneCount == 2 && harness.errors.contains { $0.contains("没有解除分屏") }, "A refused cell read \(harness.errors)")
        try unsplit(.chapter(bell))
        try require(host.paneCount == 1, "解除分屏 after the refusal did not merge")

        // ⌘W with the active pane empty shows the other pane's tab instead of closing.
        let probe = TabsMenuProbe(host: host, window: window)
        let windowProbe = TabsWindowProbe()
        window.delegate = windowProbe
        defer { window.delegate = nil }
        let menu = probe.menu()
        try split(showing: .chapter(rain))
        let _: Void = try tabsStep { host.closeAllTabs(pane: 1, completion: $0) }
        try harness.settled()
        host.activate(pane: 1)
        let shownLeft = host.shownTab(pane: 0)
        try require(host.activePane == 1 && host.tabKeys(pane: 1).isEmpty && shownLeft != nil, "The right pane is not empty and active")
        try harness.press(menu, "w", .command, code: 13)
        try require(windowProbe.closeRequests == 0 && host.activePane == 0 && host.shownTab(pane: 0) == shownLeft,
                    "⌘W with the active pane empty closed the window or a tab: \(windowProbe.closeRequests)")
        // Only restored tabs, none shown: ⌘W shows one.
        let _: Void = try tabsStep { host.closeAllTabs(pane: 0, completion: $0) }
        try harness.settled()
        var restored: (Bool, Error?)?
        host.restoreTabs(project: project, panes: [MacChapterWorkspace.RestoredPane(targets: [.chapter(bell)], active: nil)], activePane: 0) {
            restored = ($0, $1)
        }
        try wait { restored != nil }
        try harness.settled()
        try require(restored?.0 == true && host.paneCount == 1 && host.shownTab(pane: 0) == nil && host.tabKeys(pane: 0) == [harness.key(project, .chapter(bell))],
                    "The restored tab is not waiting unopened")
        try harness.press(menu, "w", .command, code: 13)
        try require(windowProbe.closeRequests == 0 && host.shownTab(pane: 0) == harness.key(project, .chapter(bell)),
                    "⌘W with only a restored tab closed the window: \(windowProbe.closeRequests)")
        try harness.press(menu, "w", .command, code: 13)
        try require(windowProbe.closeRequests == 0 && !host.hasAnyTab, "⌘W did not close the shown tab")
        try harness.press(menu, "w", .command, code: 13)
        try require(windowProbe.closeRequests == 1, "⌘W without any tab did not close the window")
        try harness.quit()
    }

    // MARK: Restore guards

    private static func tabsRestoreGuards() throws {
        let harness = try TabsHarness()
        defer { harness.cleanup() }
        let host = harness.host, session = harness.session, settings = harness.settings
        let (first, chapters) = try harness.project("守护第一部", chapters: ["晨雾", "午潮"])
        let (second, _) = try harness.project("守护第二部", chapters: ["序章"])
        let (a, b) = (chapters[0], chapters[1])
        try harness.show(first)
        try harness.open(first, .chapter(a))
        try harness.open(first, .chapter(b))
        try harness.show(second)
        let saved = try require(value: settings.tabSession(projectID: first.id), "第一部's tabs were not saved")
        try require(saved.panes.first?.tabs.count == 2 && !host.hasTabs(projectID: first.id), "The switch kept 第一部's tabs")

        // Refused (navigation held): nothing restored, and a save meanwhile
        // keeps the stored tabs; once navigation is possible it runs again.
        host.lockViews(true)
        let refused = try harness.step(settling: false) { session.enter(first, completion: $0) }
        try require(refused != nil && !host.hasTabs(projectID: first.id) && settings.tabSession(projectID: first.id) == saved
                    && session.unrestored[first.id]?.whole == true, "A refused restore saved \(String(describing: settings.tabSession(projectID: first.id)))")
        session.saveNow()
        try require(settings.tabSession(projectID: first.id) == saved, "A save after the refusal dropped the stored tabs")
        host.lockViews(false)
        try wait { host.hasTabs(projectID: first.id) && session.unrestored[first.id] == nil }
        try harness.settled()
        try require(host.tabTitles(pane: 0) == ["晨雾", "午潮"] && settings.tabSession(projectID: first.id)?.panes.map(\.tabs) == saved.panes.map(\.tabs),
                    "The retried restore put back \(host.tabTitles(pane: 0))")
        try harness.show(second)
        try require(!host.hasTabs(projectID: first.id) && settings.tabSession(projectID: first.id)?.panes.map(\.tabs) == saved.panes.map(\.tabs),
                    "Switching away after the retry lost 第一部's tabs")

        // Overtaken by another switch before its lists were read: nothing mixes in.
        var overtaken = false
        session.enter(first) { _ in overtaken = true }
        session.enter(second) { _ in }
        try wait { overtaken }
        try harness.settled()
        RunLoop.current.run(until: Date().addingTimeInterval(MacTabSession.saveDelay * 3))
        try require(session.projectID == second.id && !host.hasTabs(projectID: first.id) && settings.tabSession(projectID: first.id) == saved,
                    "A stale restore put back \(host.projectsWithTabs)")

        // A switch refused by a tab that cannot close keeps the restored tab and
        // the 项目主页, and saves nothing.
        try harness.show(first)
        try require(host.tabTitles(pane: 0) == ["晨雾", "午潮"] && host.isTabOpen(pane: 0, scope: tabsScope(first, .chapter(b)))
                    && !host.isTabOpen(pane: 0, scope: tabsScope(first, .chapter(a))), "第一部 restored \(host.tabTitles(pane: 0))")
        try require(host.openHome(project: first) != nil, "项目主页 did not open")
        try harness.open(first, .chapter(b))
        try harness.overlongCell(first, b)
        let before = host.tabSession(projectID: first.id)
        var result: Result<Void, Error>?
        session.show(second) { result = $0 }
        try wait { result != nil }
        guard case .failure? = result else { throw LabError.message("The switch went ahead past a tab that could not close") }
        try wait { !host.isBusy && host.canNavigate }
        RunLoop.current.run(until: Date().addingTimeInterval(MacTabSession.saveDelay * 3))
        try require(host.tabTitles(pane: 0) == ["晨雾", "午潮"] && host.homeProjects(pane: 0) == [first] && session.projectID == first.id
                    && settings.tabSession(projectID: first.id)?.panes.map(\.tabs) == before.panes.map(\.tabs)
                    && settings.tabSession(projectID: first.id)?.panes.first?.home == true,
                    "The refused switch left \(host.tabTitles(pane: 0)) and saved \(String(describing: settings.tabSession(projectID: first.id)))")
        try harness.show(second)

        // Forgetting a deleted project drops its pages from 后退 and 前进.
        try harness.show(first)
        try harness.open(first, .chapter(a))
        try require(host.openHome(project: first) != nil, "项目主页 did not open")
        try harness.settled()
        try require(host.canGoBack && !host.historyTitles.titles.isEmpty, "No history to forget")
        let _: Void = try tabsStep { host.closeTabs(projectID: first.id, completion: $0) }
        host.forget(projectID: first.id)
        try require(host.historyTitles.titles.isEmpty && !host.canGoBack && !host.canGoForward,
                    "The forgotten project stayed in 后退: \(host.historyTitles)")
        try harness.quit()
    }

    /// A list that cannot be read leaves its pages out of the restore but in
    /// the stored tabs, at their places, until a complete restore.
    private static func tabsRestoreKeepsUnread() throws {
        let harness = try TabsHarness()
        defer { harness.cleanup() }
        let host = harness.host, session = harness.session, settings = harness.settings
        let (first, chapters) = try harness.project("未读第一部", chapters: ["晨雾", "午潮", "暮钟"])
        let (second, _) = try harness.project("未读第二部", chapters: ["序章"])
        let pages = try harness.pages(first)
        let page = { (kind: RecentPage.Kind, id: String) in RecentPage(kind: kind, id: id) }
        try harness.show(first)
        try harness.open(first, .chapter(chapters[0]))
        try harness.open(first, .drift(pages.drift))
        try harness.open(first, .chapter(chapters[1]))
        try harness.show(second)
        let stored = [page(.chapter, chapters[0].id), page(.drift, pages.drift.id), page(.chapter, chapters[1].id)]
        try require(settings.tabSession(projectID: first.id)?.panes.first?.tabs == stored && !host.hasTabs(projectID: first.id),
                    "第一部's tabs were not saved: \(String(describing: settings.tabSession(projectID: first.id)))")

        // The drift list cannot be read: the chapters come back, the drift stays stored.
        try WorkspaceRemoteProseFixture.execute(in: harness.directory, sql: "ALTER TABLE drift_group RENAME TO drift_group_unreadable")
        let partial = try harness.step { done in session.leave(for: first) { _ in session.enter(first, completion: done) } }
        try require(partial?.localizedDescription.hasPrefix("部分标签未能恢复") == true && host.tabTitles(pane: 0) == ["晨雾", "午潮"],
                    "The partial restore read “\(partial?.localizedDescription ?? "")” with \(host.tabTitles(pane: 0))")
        try require(session.unrestored[first.id]?.pages == [page(.drift, pages.drift.id)]
                    && settings.tabSession(projectID: first.id)?.panes.first?.tabs == stored, "The partial restore dropped the unread drift")
        // A tab change saves the new tab and keeps the drift at its place.
        try harness.open(first, .chapter(chapters[2]))
        try wait { settings.tabSession(projectID: first.id)?.panes.first?.tabs == stored + [page(.chapter, chapters[2].id)] }
        try require(host.tabTitles(pane: 0) == ["晨雾", "午潮", "暮钟"], "The host shows \(host.tabTitles(pane: 0))")

        // Readable again: a complete restore brings the drift back and forgets it.
        try WorkspaceRemoteProseFixture.execute(in: harness.directory, sql: "ALTER TABLE drift_group_unreadable RENAME TO drift_group")
        try harness.show(second)
        try harness.show(first)
        try require(host.tabTitles(pane: 0) == ["晨雾", "旧信", "午潮", "暮钟"] && session.unrestored[first.id] == nil,
                    "The complete restore put back \(host.tabTitles(pane: 0))")

        // Unread again; the author opens the drift and closes it before the
        // save: it is no longer unread, and the stored tabs leave it out.
        try harness.show(second)
        try WorkspaceRemoteProseFixture.execute(in: harness.directory, sql: "ALTER TABLE drift_group RENAME TO drift_group_unreadable")
        let again = try harness.step { done in session.leave(for: first) { _ in session.enter(first, completion: done) } }
        try require(again != nil && session.unrestored[first.id]?.pages == [page(.drift, pages.drift.id)],
                    "The second partial restore kept \(String(describing: session.unrestored[first.id]?.pages))")
        try WorkspaceRemoteProseFixture.execute(in: harness.directory, sql: "ALTER TABLE drift_group_unreadable RENAME TO drift_group")
        let saveDelay = MacTabSession.saveDelay
        MacTabSession.saveDelay = 5
        defer { MacTabSession.saveDelay = saveDelay }
        try harness.open(first, .drift(pages.drift))
        try require(session.unrestored[first.id] == nil, "Opening the unread drift kept it unread")
        let closed = try harness.step { done in
            host.closeTab(pane: 0, scope: .drift(DriftScope(projectID: first.id, driftID: pages.drift.id))) { result in
                if case .failure(let error) = result { done(error) } else { done(nil) }
            }
        }
        try require(closed == nil, "The drift tab did not close: \(closed?.localizedDescription ?? "")")
        session.saveNow()
        try require(settings.tabSession(projectID: first.id)?.panes.first?.tabs == [page(.chapter, chapters[0].id), page(.chapter, chapters[1].id),
                                                                                  page(.chapter, chapters[2].id)],
                    "The closed drift came back: \(String(describing: settings.tabSession(projectID: first.id)))")
        try harness.show(second)
        try harness.show(first)
        try require(host.tabTitles(pane: 0) == ["晨雾", "午潮", "暮钟"], "The restore put back \(host.tabTitles(pane: 0))")
        try harness.quit()
    }

    /// A host or workspace step that reports through a completion; its
    /// failure names where it was taken.
    private static func tabsStep<T>(file: String = #fileID, line: Int = #line,
                                    _ run: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
        do { return try elementResult(run) } catch { throw LabError.message("\(file):\(line): \(error.localizedDescription)") }
    }

    private static func require<T>(value: T?, _ message: String) throws -> T {
        guard let value else { throw LabError.message(message) }
        return value
    }
}
