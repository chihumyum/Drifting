import AppKit

/// Chapter and drift 摘要 and 状态, and the project's 项目资料, through the real
/// AppKit pages, drift panel, outline and project sheet over the Rust
/// workspace. The wiring mirrors AppDelegate; input is programmatic.
extension BindingAcceptance {
    /// One project with chapters, the tab host in a sized window, the 漂流
    /// panel and the outline, connected as AppDelegate connects them.
    private final class MetadataHarness {
        let directory: URL
        let workspace: LabWorkspaceCore
        let project: WorkspaceProject
        let chapters: [WorkspaceChapter]
        let window: NSWindow
        let host: MacChapterWorkspace
        let drifts: DriftLibraryModel
        let driftController: MacDriftLibraryViewController
        let outline: WorkspaceOutlineModel
        let outlineController: BookOutlineViewController
        /// The last status written from the panel or the outline menu.
        var statusResult: Result<WorkspaceNodeMetadata, Error>?

        init(titles: [String]) throws {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                .appendingPathComponent("apple-native-lab")
            let workspace = LabWorkspaceCore(directory: directory)
            self.directory = directory
            self.workspace = workspace
            let initial: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(initial.isEmpty, "Metadata fixture was not isolated")
            let project: WorkspaceProject = try BindingAcceptance.elementResult { workspace.createProject(name: "钟楼合成项目", completion: $0) }
            self.project = project
            chapters = try titles.map { title in
                try BindingAcceptance.elementResult { workspace.createChapter(projectID: project.id, title: title, completion: $0) }
            }
            (window, host) = BindingAcceptance.elementHost(workspace)
            drifts = DriftLibraryModel(workspace: workspace, projectID: project.id)
            driftController = MacDriftLibraryViewController(model: drifts)
            outline = WorkspaceOutlineModel(workspace: workspace, projectID: project.id)
            outlineController = BookOutlineViewController(model: outline)
            _ = driftController.view
            _ = outlineController.view
            let (host, drifts, outline) = (self.host, self.drifts, self.outline)
            drifts.onLibrary = { library in
                host.applyDriftLibrary(projectID: project.id, library: library)
                outline.applyDrifts(library)
            }
            host.onDriftLibrary = { projectID, library in
                guard projectID == project.id else { return }
                drifts.apply(library, message: nil)
                outline.applyDrifts(library)
            }
            // AppDelegate.adoptNodeMetadata: the outline and the panel follow.
            host.onNodeMetadata = { projectID, metadata in
                guard projectID == project.id else { return }
                outline.applyNodeMetadata(metadata)
                drifts.applyNodeMetadata(metadata)
            }
            driftController.canNavigate = { host.canNavigate }
            driftController.onOpen = { drift in host.open(project: project, drift: drift) { _ in } }
            driftController.onSetStatus = { [weak self] drift, status in
                host.setNodeStatus(projectID: project.id, nodeID: drift.id, status: status) { result in
                    if case .failure(let error) = result { drifts.showStatus(error.localizedDescription) }
                    self?.statusResult = result
                }
            }
            outlineController.canNavigate = { host.canNavigate }
            outlineController.onSetChapterStatus = { [weak self] entry, status in
                host.setNodeStatus(projectID: project.id, nodeID: entry.id, status: status) { result in
                    if case .failure(let error) = result { outline.showStatus(error.localizedDescription) }
                    self?.statusResult = result
                }
            }
            drifts.load()
            try BindingAcceptance.wait { drifts.loaded && !drifts.busy }
            outline.load()
            try BindingAcceptance.wait { outline.entries.count == titles.count && outline.chapterStatuses?.count == titles.count }
        }

        func journal() throws -> Int64 { try BindingAcceptance.elementCount(directory, "sync_change_set") }

        func chapterPage(_ chapter: WorkspaceChapter, pane: Int = 0) -> MacChapterPageView? {
            host.retainedChapterPage(pane: pane, scope: ChapterScope(projectID: project.id, chapterID: chapter.id))
        }

        func driftPage(_ drift: WorkspaceDrift) -> MacDriftPageView? {
            host.retainedDriftPage(pane: 0, scope: DriftScope(projectID: project.id, driftID: drift.id))
        }

        func driftRow(_ id: String) throws -> DriftLibraryModel.Row {
            guard let row = driftController.rows.first(where: { if case .drift(let drift, _) = $0 { return drift.id == id }; return false }) else {
                throw LabError.message("The panel lists no drift row \(id)")
            }
            return row
        }

        func driftItem(_ id: String, _ identifier: String) throws -> LibraryMenuItem {
            guard let item = driftController.menuItems(for: try driftRow(id))
                    .first(where: { $0.accessibilityIdentifier() == identifier }) as? LibraryMenuItem else {
                throw LabError.message("Drift row lacks \(identifier)")
            }
            return item
        }

        func outlineItem(_ chapterID: String, _ identifier: String) throws -> NSMenuItem {
            guard let item = outlineController.actionItems(entryID: chapterID).first(where: { $0.accessibilityIdentifier() == identifier }) else {
                throw LabError.message("Outline chapter row lacks \(identifier)")
            }
            return item
        }

        /// Sends an outline menu item's action and waits for its status reply.
        func sendStatus(_ item: NSMenuItem) throws {
            guard let action = item.action else { throw LabError.message("Menu item \(item.title) has no action") }
            statusResult = nil
            NSApp.sendAction(action, to: item.target, from: item)
            try BindingAcceptance.wait { self.statusResult != nil }
        }

        func close() throws {
            try BindingAcceptance.wait { self.host.canNavigate && !self.drifts.busy && !self.outline.busy }
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "Metadata workspace failed to close")
            window.close()
        }

        func remove() { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
    }

    private static func metadataFact(_ key: String, _ value: String) -> WorkspaceFact { WorkspaceFact(key: key, value: value) }

    private static func metadataPress(_ button: NSButton) { button.sendAction(button.action, to: button.target) }

    /// Chooses the popup entry with this value, as a click would.
    private static func choose(_ popup: NSPopUpButton, _ value: String) throws {
        guard let index = popup.itemArray.firstIndex(where: { $0.representedObject as? String == value }) else {
            throw LabError.message("Popup lacks \(value)")
        }
        popup.selectItem(at: index)
        popup.sendAction(popup.action, to: popup.target)
    }

    /// Types into a summary text view and ends editing by moving the keyboard away.
    private static func editSummary(_ window: NSWindow, _ view: NSTextView, _ text: String) throws {
        try require(window.makeFirstResponder(view), "Summary refused keyboard focus")
        view.selectAll(nil)
        view.insertText(text, replacementRange: view.selectedRange())
        try require(window.makeFirstResponder(nil), "Summary did not end editing")
    }

    private static func metadataSettled(_ editor: NodeMetadataEditor, _ condition: () -> Bool) throws {
        try wait { !editor.isCommitting && condition() }
    }

    private static func metadataDescendant(_ view: NSView, _ identifier: String) -> NSView? {
        if view.accessibilityIdentifier() == identifier { return view }
        for child in view.subviews { if let found = metadataDescendant(child, identifier) { return found } }
        return nil
    }

    /// The status text of a chapter row in the outline, as the table draws it.
    private static func outlineStatus(_ controller: BookOutlineViewController, _ chapterID: String) -> String? {
        controller.rowView(entryID: chapterID).flatMap { metadataDescendant($0, "outline-status-\(chapterID)") as? NSTextField }?.stringValue
    }

    private static func outlineTitleColor(_ controller: BookOutlineViewController, _ chapterID: String) -> NSColor? {
        controller.rowView(entryID: chapterID).flatMap { metadataDescendant($0, "outline-chapter-\(chapterID)") as? NSTextField }?.textColor
    }

    /// Whether the panel draws the drift muted with its 休眠 note.
    private static func driftMuted(_ harness: MetadataHarness, _ id: String) throws -> Bool {
        let cell = harness.driftController.cellView(try harness.driftRow(id))
        guard let title = metadataDescendant(cell, "drift-title-\(id)") as? NSTextField else {
            throw LabError.message("Drift row lacks its title")
        }
        let note = metadataDescendant(cell, "drift-resting-\(id)") as? NSTextField
        return title.textColor == .tertiaryLabelColor && note?.stringValue == "休眠"
    }

    static func metadataAcceptance() throws -> [String] {
        try chapterSummaryAndStatus()
        try driftSummaryStatusAndPanel()
        try projectProfileSheet()
        return [
            "AppKit chapter page 摘要 and 状态 trim and write once, skip unchanged, Escape and refused edits without journal rows, follow the split pane and the outline status and 操作 menu, keep body history and survive cold reopen",
            "AppKit drift page 摘要 and 状态 reach the panel, which mutes 休眠 drifts and offers the other status in its row menu, the current status and a chapter status write nothing, and statuses survive cold reopen into a new panel",
            "AppKit project sheet trims 本书简介, edits 本书字段 and 故事线字段模版 as ordered untrimmed lists, writes nothing when unchanged, keeps typed rows and stays open on refusal, 完成 saves pending edits, a new storyline clones the template while an older one stays unchanged, and everything survives cold reopen",
        ]
    }

    // MARK: (a) Chapter page and outline

    private static func chapterSummaryAndStatus() throws {
        let harness = try MetadataHarness(titles: ["启程", "航行", "归岸"])
        defer { harness.remove() }
        let (host, window, project, chapters) = (harness.host, harness.window, harness.project, harness.chapters)
        let (outline, outlineController) = (harness.outline, harness.outlineController)
        try require(chapters.allSatisfy { outline.writingStatus(chapterID: $0.id) == "draft" }
            && outlineStatus(outlineController, chapters[0].id) == "草稿", "The outline did not show every new chapter as 草稿")

        let body: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapters[0], completion: $0) }
        try elementSettled(host, body)
        guard let page = harness.chapterPage(chapters[0]) else { throw LabError.message("The chapter tab has no page") }
        let editor = page.metadataEditor
        try wait { editor.metadata != nil }
        try require(host.activeChapterPage === page && page.documentView === body && body.allowsComments
            && page.titleLabel.stringValue == "启程" && editor.summaryText.isEmpty && editor.statusValue == "draft"
            && editor.statusPopup.itemArray.map(\.title) == ["草稿", "已完成", "已弃用"] && editor.summaryView.isEditable,
            "The chapter page did not show its title, an empty 摘要 and 草稿")
        body.textView.insertText("灯塔熄灭的那夜。", replacementRange: NSRange(location: 0, length: 0))
        try elementSettled(host, body)
        let core = host.activeCore!

        // 摘要 is trimmed and written once on end-editing.
        let start = try harness.journal()
        try editSummary(window, editor.summaryView, "  雨夜启程，灯塔熄灭。 \n")
        try metadataSettled(editor) { editor.metadata?.summary == "雨夜启程，灯塔熄灭。" }
        try wait { editor.summaryText == "雨夜启程，灯塔熄灭。" }
        try require(try harness.journal() == start + 1 && page.errorMessage == nil, "The summary was not written once")

        // Unchanged after trimming: nothing is written and the stored form returns.
        try editSummary(window, editor.summaryView, "雨夜启程，灯塔熄灭。   ")
        try wait { editor.summaryText == "雨夜启程，灯塔熄灭。" && !editor.isCommitting }
        try require(try harness.journal() == start + 1, "An unchanged summary was written")

        // Escape restores the stored summary without writing.
        try require(window.makeFirstResponder(editor.summaryView), "Summary refused keyboard focus")
        editor.summaryView.insertText("改了又不要", replacementRange: editor.summaryView.selectedRange())
        editor.summaryView.doCommand(by: #selector(NSResponder.cancelOperation(_:)))
        try wait { editor.summaryText == "雨夜启程，灯塔熄灭。" && !editor.isCommitting }
        try require(try harness.journal() == start + 1 && window.firstResponder !== editor.summaryView,
            "Escape did not restore the stored summary without writing")

        // 状态 from the page; the outline row follows. The current status writes nothing.
        try choose(editor.statusPopup, "finished")
        try metadataSettled(editor) { editor.metadata?.writingStatus == "finished" }
        try wait { outline.writingStatus(chapterID: chapters[0].id) == "finished" && outlineStatus(outlineController, chapters[0].id) == "已完成" }
        try require(try harness.journal() == start + 2, "The status was not written once")
        try choose(editor.statusPopup, "finished")
        try metadataSettled(editor) { true }
        try require(try harness.journal() == start + 2, "Choosing the current status wrote a change")

        // A refused write keeps the typed summary, shows the stored status again and explains itself.
        let write = editor.onCommit
        editor.onCommit = { _, done in done(.failure(LabError.metadataUnavailable(reason: "Chapter or drift is not available in this project"))) }
        try editSummary(window, editor.summaryView, "北岸无灯。")
        try metadataSettled(editor) { page.errorMessage != nil }
        try require(page.errorMessage == "这一章或这条漂流已不可用，请刷新列表。" && editor.summaryText == "北岸无灯。"
            && editor.metadata?.summary == "雨夜启程，灯塔熄灭。", "A refused summary did not keep the typed text: \(page.errorMessage ?? "none")")
        try choose(editor.statusPopup, "discarded")
        try metadataSettled(editor) { editor.statusValue == "finished" }
        editor.onCommit = write
        try require(try harness.journal() == start + 2, "A refused edit wrote a change")
        try editSummary(window, editor.summaryView, "雨夜启程，北岸无灯。")
        try metadataSettled(editor) { editor.metadata?.summary == "雨夜启程，北岸无灯。" }
        try require(page.errorMessage == nil && harness.journal() == start + 3, "Retrying after a refusal did not write the summary")

        // Rust refuses a drift status for a chapter before writing.
        let refused = try elementRefused({ host.setNodeStatus(projectID: project.id, nodeID: chapters[0].id, status: "resting", completion: $0) },
            "A chapter took a drift status")
        try require(refused == "章节只能设为草稿、已完成或已弃用。" && harness.journal() == start + 3 && editor.statusValue == "finished",
            "A chapter status refusal was not explained or wrote a change: \(refused)")

        // The outline's 操作 menu offers the statuses with the current one checked.
        let draftItem = try harness.outlineItem(chapters[1].id, "outline-chapter-status-draft")
        let discardItem = try harness.outlineItem(chapters[1].id, "outline-chapter-status-discarded")
        try require(draftItem.state == .on && discardItem.state == .off && discardItem.isEnabled && draftItem.title == "草稿",
            "The outline menu did not check the current status")
        try harness.sendStatus(discardItem)
        _ = try harness.statusResult!.get()
        try wait { outlineStatus(outlineController, chapters[1].id) == "已弃用" }
        try require(outlineTitleColor(outlineController, chapters[1].id) == .secondaryLabelColor
            && outlineTitleColor(outlineController, chapters[2].id) == .labelColor
            && (try harness.outlineItem(chapters[1].id, "outline-chapter-status-discarded")).state == .on
            && harness.journal() == start + 4, "A discarded chapter was not muted in the outline")
        harness.statusResult = nil
        let current = try harness.outlineItem(chapters[1].id, "outline-chapter-status-discarded")
        NSApp.sendAction(current.action!, to: current.target, from: current)
        try require(harness.statusResult == nil && harness.journal() == start + 4, "The current status was written again from the outline")

        // A second page of the chapter shows and follows the stored values; the
        // outline menu reaches both pages.
        let twin: NativeDocumentView = try elementResult { host.split(completion: $0) }
        try elementSettled(host, twin)
        guard let twinPage = harness.chapterPage(chapters[0], pane: 1) else { throw LabError.message("Split did not open the chapter page") }
        try wait { twinPage.metadataEditor.metadata?.summary == "雨夜启程，北岸无灯。" }
        try require(twinPage.metadataEditor.summaryText == "雨夜启程，北岸无灯。" && twinPage.metadataEditor.statusValue == "finished",
            "The second page did not show the stored values")
        try choose(twinPage.metadataEditor.statusPopup, "draft")
        try metadataSettled(twinPage.metadataEditor) { twinPage.metadataEditor.metadata?.writingStatus == "draft" }
        try wait { editor.statusValue == "draft" && outline.writingStatus(chapterID: chapters[0].id) == "draft" }
        try harness.sendStatus(try harness.outlineItem(chapters[0].id, "outline-chapter-status-finished"))
        try wait { editor.statusValue == "finished" && twinPage.metadataEditor.statusValue == "finished" }
        try editSummary(window, twinPage.metadataEditor.summaryView, "雨夜启程。")
        try metadataSettled(twinPage.metadataEditor) { twinPage.metadataEditor.metadata?.summary == "雨夜启程。" }
        try wait { editor.summaryText == "雨夜启程。" }
        try require(try harness.journal() == start + 7, "Page and outline edits were not one change each")

        // Metadata never touches the body or its history.
        try require(try read(core).projection.text == "灯塔熄灭的那夜。" && read(core).projection.canUndo,
            "Metadata edits changed the body or its history")
        body.undoProse(); try elementSettled(host, body, twin)
        try require(try read(core).projection.text.isEmpty && editor.metadata?.summary == "雨夜启程。", "Body undo touched the metadata")
        body.redoProse(); try elementSettled(host, body, twin)

        try harness.close()
        let cold = LabWorkspaceCore(directory: harness.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let listed: [WorkspaceChapter] = try elementResult { cold.chapters(projectID: project.id, completion: $0) }
        try require(listed.map(\.writingStatus) == ["finished", "discarded", "draft"], "Statuses did not survive cold reopen")
        let (coldWindow, coldHost) = elementHost(cold)
        defer { coldWindow.close() }
        let coldBody: NativeDocumentView = try elementResult { coldHost.open(project: project, chapter: listed[0], completion: $0) }
        try elementSettled(coldHost, coldBody)
        guard let coldPage = coldHost.activeChapterPage else { throw LabError.message("Cold chapter tab has no page") }
        try wait { coldPage.metadataEditor.metadata != nil }
        try require(coldPage.metadataEditor.summaryText == "雨夜启程。" && coldPage.metadataEditor.statusValue == "finished"
            && coldBody.textView.string == "灯塔熄灭的那夜。", "The chapter page did not survive cold reopen")
        let coldClosed: Bool = try elementResult { coldHost.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }

    // MARK: (b) Drift page and panel

    private static func driftSummaryStatusAndPanel() throws {
        let harness = try MetadataHarness(titles: ["启程"])
        defer { harness.remove() }
        let (host, window, project, drifts) = (harness.host, harness.window, harness.project, harness.drifts)
        let tide: WorkspaceDrift = try elementResult { drifts.createDrift(title: "潮汐手记", groupID: nil, completion: $0) }
        let shore: WorkspaceDrift = try elementResult { drifts.createDrift(title: "北岸", groupID: nil, completion: $0) }
        try wait { drifts.status(of: tide) == "drifting" && drifts.status(of: shore) == "drifting" }
        try require(!(try driftMuted(harness, tide.id)) && !(try driftMuted(harness, shore.id)), "A new drift was muted")

        try harness.driftItem(tide.id, "open-drift").press()
        try wait { host.activeDrift?.id == tide.id && !host.isBusy }
        guard let page = harness.driftPage(tide) else { throw LabError.message("打开 did not open the drift page") }
        let editor = page.metadataEditor
        try elementSettled(host, page.documentView)
        try wait { editor.metadata != nil }
        try require(editor.statusValue == "drifting" && editor.statusPopup.itemArray.map(\.title) == ["漂浮中", "休眠"]
            && editor.summaryText.isEmpty, "The drift page did not show 漂浮中 and an empty 摘要")

        // 摘要 is trimmed; the drift library and link targets follow.
        let start = try harness.journal()
        try editSummary(window, editor.summaryView, "  月亮牵引潮水。 ")
        try metadataSettled(editor) { editor.metadata?.summary == "月亮牵引潮水。" }
        try wait { drifts.library.drift(id: tide.id)?.summary == "月亮牵引潮水。" && editor.summaryText == "月亮牵引潮水。" }
        try wait { host.linkDirectory(projectID: project.id)?.drifts[tide.id]?.summary == "月亮牵引潮水。" }
        try require(try harness.journal() == start + 1 && page.text(of: .title) == "潮汐手记", "The drift summary was not written once")

        // 休眠 from the page mutes the panel row; its menu checks 休眠.
        try choose(editor.statusPopup, "resting")
        try metadataSettled(editor) { editor.metadata?.writingStatus == "resting" }
        try wait { drifts.isResting(tide) }
        try require(try driftMuted(harness, tide.id) && !(try driftMuted(harness, shore.id)) && harness.journal() == start + 2,
            "A resting drift was not muted in the panel")
        let restingItem = try harness.driftItem(tide.id, "drift-menu-status-resting")
        let driftingItem = try harness.driftItem(tide.id, "drift-menu-status-drifting")
        try require(restingItem.state == .on && driftingItem.state == .off && driftingItem.isEnabled && driftingItem.title == "漂浮中",
            "The panel menu did not check the current status")

        // Choosing the current status writes nothing; 漂浮中 reaches the page.
        harness.statusResult = nil
        restingItem.press()
        try require(harness.statusResult == nil && harness.journal() == start + 2, "The current status was written again from the panel")
        driftingItem.press()
        try wait { harness.statusResult != nil }
        _ = try harness.statusResult!.get()
        try wait { editor.statusValue == "drifting" && !drifts.isResting(tide) }
        try require(!(try driftMuted(harness, tide.id)) && harness.journal() == start + 3, "漂浮中 from the panel did not reach the page")

        // A drift without a page rests from the panel.
        harness.statusResult = nil
        try harness.driftItem(shore.id, "drift-menu-status-resting").press()
        try wait { harness.statusResult != nil }
        try wait { drifts.isResting(shore) }
        try require(try driftMuted(harness, shore.id) && harness.journal() == start + 4, "A drift was not rested from the panel")

        // Rust refuses a chapter status for a drift before writing.
        let refused = try elementRefused({ host.setNodeStatus(projectID: project.id, nodeID: tide.id, status: "finished", completion: $0) },
            "A drift took a chapter status")
        try require(refused == "漂流只能设为漂浮中或休眠。" && harness.journal() == start + 4 && editor.statusValue == "drifting",
            "A drift status refusal was not explained or wrote a change: \(refused)")

        // Page edits never touch the drift body or the title.
        page.documentView.textView.insertText("潮声", replacementRange: NSRange(location: 0, length: 0))
        try elementSettled(host, page.documentView)
        try choose(editor.statusPopup, "resting")
        try metadataSettled(editor) { editor.metadata?.writingStatus == "resting" }
        try wait { drifts.isResting(tide) }
        try require(page.documentView.binding.state?.projection.canUndo == true && page.documentView.textView.string == "潮声",
            "A status edit touched the drift body")

        try harness.close()
        let cold = LabWorkspaceCore(directory: harness.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let stored: WorkspaceNodeMetadata = try elementResult { cold.nodeMetadata(projectID: project.id, nodeID: tide.id, completion: $0) }
        try require(stored.kind == "drift" && stored.summary == "月亮牵引潮水。" && stored.writingStatus == "resting" && stored.title == "潮汐手记",
            "Drift metadata did not survive cold reopen")
        let coldPanel = DriftLibraryModel(workspace: cold, projectID: project.id)
        let coldController = MacDriftLibraryViewController(model: coldPanel)
        _ = coldController.view
        coldPanel.load()
        try wait { coldPanel.loaded && coldPanel.status(of: tide) != nil && coldPanel.status(of: shore) != nil }
        try require(coldPanel.isResting(tide) && coldPanel.isResting(shore), "A cold panel did not read the statuses")
        let coldClosed: Bool = try elementResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }

    // MARK: (c) Project sheet and storyline template

    private static func projectProfileSheet() throws {
        let harness = try MetadataHarness(titles: ["启程", "航行"])
        defer { harness.remove() }
        let (host, project, workspace) = (harness.host, harness.project, harness.workspace)
        let _: WorkspaceNodeMetadata = try elementResult {
            host.setNodeStatus(projectID: project.id, nodeID: harness.chapters[1].id, status: "finished", completion: $0)
        }
        let storylines = StorylineLibraryModel(workspace: workspace, projectID: project.id)
        storylines.load()
        try wait { storylines.loaded && !storylines.busy }
        let early: WorkspaceStoryline = try elementResult { storylines.create(name: "主线", completion: $0) }
        try require(early.facts.isEmpty, "A storyline created without a template carried facts")

        let model = ProjectProfileModel(workspace: workspace, projectID: project.id)
        let sheet = ProjectProfileSheet(model: model, projectName: project.name)
        var finished = false
        sheet.onFinish = { finished = true }
        sheet.begin(in: nil)
        try wait { sheet.stored != nil && !model.loading }
        let window = sheet.window
        guard let defaults = sheet.stored?.facts else { throw LabError.message("The sheet read no details") }
        try require(defaults.count == 6 && defaults.allSatisfy { $0.value.isEmpty } && sheet.factsEditor.facts == defaults
            && sheet.templateEditor.facts.isEmpty && sheet.summaryView.string.isEmpty && sheet.summaryView.isEditable && sheet.errorMessage == nil
            && sheet.chaptersLabel.stringValue == "共 2 章 · 草稿 1 · 已完成 1",
            "The sheet did not show the new project's defaults and counts: \(sheet.chaptersLabel.stringValue)")
        let settle = { (condition: () -> Bool) throws in try wait { !sheet.isCommitting && condition() } }

        // 本书简介 is trimmed and written once; unchanged text writes nothing.
        let start = try harness.journal()
        try editSummary(window, sheet.summaryView, "  一座钟楼与它的守夜人。\n")
        try settle { sheet.stored?.summary == "一座钟楼与它的守夜人。" }
        try wait { sheet.summaryView.string == "一座钟楼与它的守夜人。" }
        try require(try harness.journal() == start + 1 && sheet.errorMessage == nil, "The project summary was not written once")
        try editSummary(window, sheet.summaryView, "一座钟楼与它的守夜人。  ")
        try wait { sheet.summaryView.string == "一座钟楼与它的守夜人。" && !sheet.isCommitting }
        try require(try harness.journal() == start + 1, "An unchanged project summary was written")

        // 本书字段: values are stored untrimmed, rows are removed and added in order.
        let facts = sheet.factsEditor
        try editHeader(window, facts.rows[0].valueField, " 近未来的北方小城🙂 ")
        try settle { sheet.stored?.facts.first?.value == " 近未来的北方小城🙂 " }
        metadataPress(facts.rows[1].deleteButton)
        try settle { sheet.stored?.facts.count == 5 }
        metadataPress(facts.addButton)
        try settle { true }
        try require(try harness.journal() == start + 3 && facts.rows.count == 6, "A blank fact row was written")
        try editHeader(window, facts.rows[5].keyField, "基调")
        try editHeader(window, facts.rows[5].valueField, "安静", returnKey: true)
        try settle { sheet.stored?.facts.last == metadataFact("基调", "安静") }
        var expectedFacts = defaults
        expectedFacts[0].value = " 近未来的北方小城🙂 "
        expectedFacts.remove(at: 1)
        expectedFacts.append(metadataFact("基调", "安静"))
        try require(sheet.stored?.facts == expectedFacts && facts.facts == expectedFacts && harness.journal() == start + 5,
            "Project facts were not stored exactly and in order")

        // 故事线字段模版. Rows edited while a write is in flight are coalesced
        // into the next write of the whole list.
        let template = sheet.templateEditor
        metadataPress(template.addButton)
        try editHeader(window, template.rows[0].keyField, "视角")
        try editHeader(window, template.rows[0].valueField, "第三人称")
        metadataPress(template.addButton)
        try editHeader(window, template.rows[1].keyField, "主角", returnKey: true)
        try settle { sheet.stored?.storylineTemplate.count == 2 }
        try require(sheet.stored?.storylineTemplate == [metadataFact("视角", "第三人称"), metadataFact("主角", "")]
            && harness.journal() == start + 7, "The storyline template was not stored in two writes")

        // A refusal keeps the typed rows and the sheet; nothing is written.
        let write = sheet.onCommit
        sheet.onCommit = { _, done in done(.failure(LabError.metadataUnavailable(reason: "Project does not exist"))) }
        metadataPress(template.addButton)
        try editHeader(window, template.rows[2].keyField, "时间线")
        try settle { sheet.errorMessage != nil }
        try require(sheet.errorMessage == "这个项目已不可用，请重新选择项目。" && template.facts.last == metadataFact("时间线", "")
            && sheet.stored?.storylineTemplate.count == 2 && harness.journal() == start + 7,
            "A refused template did not keep the typed rows: \(sheet.errorMessage ?? "none")")
        sheet.done()
        try settle { true }
        try require(!finished && sheet.errorMessage != nil, "完成 closed the sheet over a refusal")

        // 完成 writes a summary still being typed and the refused rows, then closes.
        sheet.onCommit = write
        try require(window.makeFirstResponder(sheet.summaryView), "Summary refused keyboard focus")
        sheet.summaryView.selectAll(nil)
        sheet.summaryView.insertText("一座钟楼与它的守夜人。钟声每夜十二响。 ", replacementRange: sheet.summaryView.selectedRange())
        sheet.done()
        try wait { finished }
        let expectedTemplate = [metadataFact("视角", "第三人称"), metadataFact("主角", ""), metadataFact("时间线", "")]
        try require(sheet.stored?.summary == "一座钟楼与它的守夜人。钟声每夜十二响。" && sheet.stored?.storylineTemplate == expectedTemplate
            && sheet.errorMessage == nil && harness.journal() == start + 9, "完成 did not save the pending edits")

        // A storyline created now clones the template; the older one is unchanged.
        let late: WorkspaceStoryline = try elementResult { storylines.create(name: "暗线", completion: $0) }
        try require(late.facts == expectedTemplate && storylines.library.storyline(id: early.id)?.facts.isEmpty == true,
            "A new storyline did not clone the template, or an older one changed")

        try harness.close()
        let cold = LabWorkspaceCore(directory: harness.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let details: WorkspaceProjectDetails = try elementResult { cold.projectDetails(projectID: project.id, completion: $0) }
        try require(details.summary == "一座钟楼与它的守夜人。钟声每夜十二响。" && details.facts == expectedFacts
            && details.storylineTemplate == expectedTemplate && details.name == project.name,
            "Project details did not survive cold reopen")
        let library: WorkspaceStorylineLibrary = try elementResult { cold.storylineLibrary(projectID: project.id, completion: $0) }
        try require(library.storyline(id: late.id)?.facts == expectedTemplate && library.storyline(id: early.id)?.facts.isEmpty == true,
            "Storyline facts did not survive cold reopen")
        let coldSheet = ProjectProfileSheet(model: ProjectProfileModel(workspace: cold, projectID: project.id), projectName: project.name)
        coldSheet.begin(in: nil)
        try wait { coldSheet.stored != nil && !coldSheet.model.loading }
        try require(coldSheet.summaryView.string == details.summary && coldSheet.factsEditor.facts == expectedFacts
            && coldSheet.templateEditor.facts == expectedTemplate && coldSheet.chaptersLabel.stringValue == "共 2 章 · 草稿 1 · 已完成 1",
            "A cold sheet did not show the stored details")
        let coldClosed: Bool = try elementResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }
}
