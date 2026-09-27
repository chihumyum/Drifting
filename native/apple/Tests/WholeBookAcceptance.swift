import AppKit

/// 全书长卷, 统计 and 写作计划 through the real AppKit controllers, the tab
/// host, the Rust workspace and SQLite, wired as AppDelegate wires them.
/// Scrolling is programmatic (the clip view, the 跳到 menu, the outline and
/// a synthesized click on a 统计 bar); every title and body is synthetic.
extension BindingAcceptance {
    static func wholeBookAcceptance() throws -> [String] {
        let saved = (MacWholeBookViewController.typingPause, MacWholeBookViewController.retryDelay,
                     DocumentStore.entityLinkDelay, WordCountModel.refreshDelay)
        defer {
            (MacWholeBookViewController.typingPause, MacWholeBookViewController.retryDelay,
             DocumentStore.entityLinkDelay, WordCountModel.refreshDelay) = saved
        }
        MacWholeBookViewController.typingPause = 0.2
        MacWholeBookViewController.retryDelay = 0.05
        DocumentStore.entityLinkDelay = 0.05
        WordCountModel.refreshDelay = 0.05
        try wholeBookVirtualizes()
        try wholeBookCloseFailures()
        try wholeBookEditsShareOwners()
        try wholeBookNavigates()
        try wholeBookStatistics()
        try wholeBookPlanPersists()
        try wholeBookTodayWords()
        return [
            "AppKit 全书长卷 opens 200 synthetic chapters in book order with act separators, keeps row views, editors and owners only near the viewport (at most six editors, plus the chapter being written in, and owners kept for undo), attaches and releases them while scrolling to the end with no main-thread step over 100 ms and nothing written to the journal, and text typed in chapter 3 just before scrolling far away is saved with its owner kept, so ⌘Z on return undoes the typing, while beyond the kept limit the least recently edited owner closes",
            "AppKit 全书长卷 keeps tracking an owner whose close fails, names its chapter in the status line, tries again at the next quiet moment until it closes, makes 删除项目 refuse naming the chapter before anything closes, and a shutdown reports the failure instead of waiting",
            "AppKit 全书长卷 edits, undo and redo in an attached chapter go through the owner a tab of that chapter shares, typed element names link, a comment reaches the tab, word counts follow in the header and 统计, a closed tab leaves the owner to the long page, ⌘-click opens the element, and releasing closes only owners no tab shows",
            "AppKit 全书长卷 scrolls to a chapter or a heading chosen in the 整书大纲 and to chapters and acts in the 跳到 menu, attaching the chapter's editor at the top of the viewport with the caret on the heading",
            "AppKit 统计 reads 统计中… until every chapter is counted, then the total, chapter count, average, completion and written/target progress of a synthetic book, colours each chapter bar by its act, lists each act's chapters and words, and a click on a bar scrolls the 全书长卷 to its chapter",
            "AppKit 写作计划 in 项目资料 parses and stores the target and daily goal per project in settings.json with the book's progress, refuses unreadable input without saving, writes nothing to the journal, and restores both after a cold relaunch of the workspace and settings",
            "AppKit 今日字数 in 项目资料 and 统计 counts the net change of this device's saves against the daily goal (typing, undo and redo, an accepted writing-assistant change and an import), leaves out received remote originals for open and closed chapters, a version restore and chapter trash and restore, rolls over at local midnight with an injected clock, keeps 30 days in settings.json, writes nothing to the journal and survives a cold relaunch without counting twice",
        ]
    }

    // MARK: Harness

    private final class BookHarness {
        let root: URL
        let directory: URL
        private(set) var workspace: LabWorkspaceCore
        let project: WorkspaceProject
        let journal: JournalProbe
        private(set) var chapters: [WorkspaceChapter] = []
        private(set) var window: NSWindow
        private(set) var host: MacChapterWorkspace
        private(set) var settings: LabSettingsStore
        private(set) var model: WholeBookModel!
        private(set) var controller: MacWholeBookViewController!
        private(set) var bookWindow: NSWindow!
        var openedLinks: [EntityLinkTarget] = []
        var createdComments: [String] = []

        init(name: String) throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            directory = root.appendingPathComponent("apple-native-lab")
            journal = JournalProbe(directory: directory)
            let workspace = LabWorkspaceCore(directory: directory)
            self.workspace = workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(listed.isEmpty, "Whole-book fixture was not isolated")
            project = try BindingAcceptance.elementResult { workspace.createProject(name: name, completion: $0) }
            (window, host) = BindingAcceptance.elementHost(workspace)
            settings = LabSettingsStore(directory: workspace.dataDirectory)
        }

        /// A chapter with a body, created as 文件 › 导入… creates one.
        @discardableResult
        func chapter(_ title: String, _ blocks: [BookImportBlock]) throws -> WorkspaceChapter {
            let workspace = self.workspace, projectID = project.id
            let imported: WorkspaceImportedEntity = try BindingAcceptance.elementResult {
                workspace.importBlocks(projectID: projectID, title: title, target: .chapter, blocks: blocks, completion: $0)
            }
            guard case .chapter(let chapter) = imported else { throw LabError.message("Import did not create a chapter") }
            chapters.append(chapter)
            return chapter
        }

        @discardableResult
        func act(before chapter: WorkspaceChapter) throws -> WorkspaceAct {
            let workspace = self.workspace, projectID = project.id
            return try BindingAcceptance.elementResult { workspace.createAct(projectID: projectID, chapterID: chapter.id, completion: $0) }
        }

        func status(_ chapter: WorkspaceChapter, _ status: WritingStatus) throws {
            let workspace = self.workspace, projectID = project.id
            let _: WorkspaceNodeMetadata = try BindingAcceptance.elementResult {
                workspace.setNodeStatus(projectID: projectID, nodeID: chapter.id, status: status.rawValue, completion: $0)
            }
        }

        /// The panel as AppDelegate.openWholeBook builds it, in a window that
        /// is never ordered on screen.
        func openBook(height: CGFloat = 720) throws {
            let model = WholeBookModel(workspace: workspace, projectID: project.id)
            let controller = MacWholeBookViewController(project: project, model: model, workspace: workspace, host: host)
            let settings = self.settings, projectID = project.id
            controller.plan = { settings.writingPlan(projectID: projectID) }
            controller.onOpenLink = { [weak self] target in self?.openedLinks.append(target) }
            controller.onSetStatus = { [weak self] chapter, status in
                self?.host.setNodeStatus(projectID: projectID, nodeID: chapter.id, status: status) { _ in }
            }
            host.onWordCounts = { [weak controller] id, library in if id == projectID { controller?.applyWordCounts(library) } }
            host.onNodeMetadata = { [weak controller] id, metadata in if id == projectID { controller?.applyNodeMetadata(metadata) } }
            host.onCommentCreated = { [weak self] _, comment in self?.createdComments.append(comment.id) }
            let bookWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: height),
                                      styleMask: [.titled, .resizable], backing: .buffered, defer: false)
            bookWindow.isReleasedWhenClosed = false
            bookWindow.contentViewController = controller
            bookWindow.setContentSize(NSSize(width: 900, height: height))
            controller.view.layoutSubtreeIfNeeded()
            self.model = model; self.controller = controller; self.bookWindow = bookWindow
            host.wordCounts(projectID: projectID)
            model.load()
            try BindingAcceptance.wait { model.loaded }
            try settle()
        }

        /// Every owner change, read and save has finished and the counts are read.
        func settle(file: String = #fileID, line: Int = #line) throws {
            try BindingAcceptance.wait(file: file, line: line) {
                self.controller.isSettled && self.host.canNavigate && !self.host.isBusy
                    && self.host.wordCounts(projectID: self.project.id).isIdle && self.host.wordCountLibrary(projectID: self.project.id) != nil
            }
            controller.documentView.layoutSubtreeIfNeeded()
        }

        var visible: NSRect { controller.scrollView.contentView.bounds }

        func row(_ chapter: WorkspaceChapter) throws -> WholeBookChapterRow {
            guard let row = controller.chapterRow(chapter.id) else { throw LabError.message("No row for \(chapter.title)") }
            return row
        }

        func editor(_ chapter: WorkspaceChapter) throws -> NativeDocumentView {
            guard let editor = try row(chapter).editor else { throw LabError.message("\(chapter.title) has no editor") }
            return editor
        }

        /// Editors in the long page, found in the view hierarchy.
        var editorsShown: Int { BindingAcceptance.bookDescendants(controller.documentView).count }

        /// A chapter's stored or live text, read without opening an owner.
        func prose(_ chapter: WorkspaceChapter) throws -> WorkspaceAgentProse {
            let workspace = self.workspace, projectID = project.id
            return try BindingAcceptance.elementResult {
                workspace.agentReadProse(projectID: projectID, kind: "chapter", id: chapter.id, completion: $0)
            }
        }

        func closeBook() throws {
            var drained = false
            try BindingAcceptance.require(controller.shutdown { _ in drained = true }, "The long page refused to close")
            try BindingAcceptance.wait { drained }
            bookWindow.close()
        }

        /// A fresh process: new workspace, tab host and settings over the same
        /// directories. `whileClosed` runs after the workspace closed.
        func relaunch(whileClosed: (() throws -> Void)? = nil) throws {
            if controller?.isShutDown == false { try closeBook() }
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "The workspace failed to close")
            window.close()
            try whileClosed?()
            let reopened = LabWorkspaceCore(directory: directory)
            workspace = reopened
            let projects: [WorkspaceProject] = try BindingAcceptance.elementResult { reopened.projects(completion: $0) }
            try BindingAcceptance.require(projects.contains { $0.id == project.id }, "Relaunch lost the project")
            (window, host) = BindingAcceptance.elementHost(reopened)
            settings = LabSettingsStore(directory: reopened.dataDirectory)
        }

        func close() throws {
            if controller?.isShutDown == false { try closeBook() }
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "The workspace failed to close")
            window.close()
            try? FileManager.default.removeItem(at: root)
        }
    }

    static func bookDescendants(_ view: NSView) -> [NativeDocumentView] {
        if let editor = view as? NativeDocumentView { return [editor] }
        return view.subviews.flatMap(bookDescendants)
    }

    /// Synthetic prose of `count` ideographs from a pool that holds no
    /// chapter title or element name.
    private static func ideographs(_ count: Int, seed: Int) -> String {
        let pool = Array("山河风雨灯塔钟声北城南渡旧梦新月江湖夜行人远方故里春秋晨昏云海星辰松竹梅兰")
        return String((0..<count).map { pool[($0 * 7 + seed * 13) % pool.count] })
    }

    // MARK: (a) 200 chapters, bounded owners, scrolling and saved input

    private static func wholeBookVirtualizes() throws {
        let harness = try BookHarness(name: "长卷合成项目")
        defer { try? harness.close() }
        // Short chapters so that more of them than the bound fall near the viewport.
        for index in 1...200 {
            var blocks = [BookImportBlock.paragraph(ideographs(24 + (index % 5) * 12, seed: index))]
            if index % 3 == 0 { blocks.append(.paragraph(ideographs(30, seed: index + 1))) }
            try harness.chapter(String(format: "长卷章节 %03d", index), blocks)
        }
        let chapters = harness.chapters
        let first = try harness.act(before: chapters[5]), second = try harness.act(before: chapters[69]), third = try harness.act(before: chapters[139])
        let mark = try harness.journal.mark()
        try harness.openBook()
        let controller = harness.controller!, workspace = harness.workspace
        let maximum = MacWholeBookViewController.maximumAttached

        // Book order with act separators before chapters 6, 70 and 140.
        var expected = chapters.map { "chapter:\($0.id)" }
        expected.insert("act:\(third.id)", at: 139); expected.insert("act:\(second.id)", at: 69); expected.insert("act:\(first.id)", at: 5)
        try require(controller.rowOrder == expected, "The long page is not in book order with its act separators")
        func checkSeparator(_ act: WorkspaceAct, _ count: Int) throws {
            guard let row = controller.actRow(act.id), row.superview != nil else { throw LabError.message("No separator for \(act.name)") }
            try require(row.titleLabel.stringValue == act.name && row.detailLabel.stringValue == "\(count) 章"
                && row.wash.tint == ElementSwatch.color(hex: BookPalette.act(controller.rowOrder.filter { $0.hasPrefix("act:") }.firstIndex(of: "act:\(act.id)")!)),
                "The separator of \(act.name) reads \(row.titleLabel.stringValue) / \(row.detailLabel.stringValue)")
        }
        try checkSeparator(first, 64)
        try require(try harness.row(chapters[0]).titleLabel.stringValue == "长卷章节 001"
            && harness.row(chapters[0]).statusLabel.stringValue == "草稿", "A chapter header lacks its title or status")

        func checkBound(_ context: String) throws {
            let attached = controller.attachedChapterIDs
            // Owners: the editors', plus those kept for undo of edited chapters.
            try require(attached.count <= maximum && harness.editorsShown == attached.count
                && workspace.openDocumentCount <= maximum + controller.keptChapterIDs.count,
                "\(context): \(attached.count) editors, \(harness.editorsShown) shown and \(workspace.openDocumentCount) owners exceed \(maximum)")
            // Row views exist only near the viewport, never for the whole book.
            try require(controller.shownRowCount <= 60, "\(context): \(controller.shownRowCount) row views are in the page")
            // Every editor is near the viewport, and the chapter at its centre has one.
            let visible = harness.visible
            let near = visible.insetBy(dx: 0, dy: -visible.height * (MacWholeBookViewController.attachMargin + 0.6))
            for id in attached {
                try require(controller.chapterRow(id)!.frame.intersects(near), "\(context): an editor far from the viewport stayed attached")
            }
            if let center = chapters.first(where: { chapter in
                controller.frame(ofChapter: chapter.id).map { $0.minY <= visible.midY && $0.maxY >= visible.midY } == true
            }) {
                try require(controller.chapterRow(center.id)?.isAttached == true, "\(context): the chapter at the viewport's centre has no editor")
            }
        }
        try checkBound("Opening")
        try require(controller.attachedChapterIDs.first == chapters[0].id, "The first chapter is not attached at the top")
        try require(try harness.row(chapters[0]).wordsLabel.stringValue.hasSuffix(" 字"), "The header shows no word count")

        // Scroll to the end one and a half viewports at a time.
        var attachedEver = Set(controller.attachedChapterIDs)
        // No placement or pass on the main thread takes longer than the
        // 100 ms stall budget while scrolling (debug build).
        MacWholeBookViewController.resetSlowest()
        var y: CGFloat = 0
        while true {
            y += harness.visible.height * 1.5
            controller.scrollDocument(toY: y)
            try harness.settle()
            try checkBound("Scrolled to \(Int(y))")
            attachedEver.formUnion(controller.attachedChapterIDs)
            if harness.visible.maxY >= controller.documentView.frame.height - 1 { break }
        }
        try require(controller.attachedChapterIDs.contains(chapters[199].id), "The last chapter is not attached at the end")
        try require(attachedEver.count > 60, "Scrolling attached only \(attachedEver.count) chapters")
        try require(MacWholeBookViewController.slowestStep < 0.1,
            "A pass or row placement took \(Int(MacWholeBookViewController.slowestStep * 1000)) ms while scrolling")
        // Rows far away show placeholders or read-only text, never an editor.
        try require(controller.chapterRow(chapters[0].id)?.isAttached != true && controller.chapterRow(chapters[0].id)?.superview == nil,
            "The first chapter kept its editor or view at the end of the book")
        // The later separators, once near.
        for (act, count) in [(second, 70), (third, 61)] {
            controller.scroll(toAct: act.id)
            try harness.settle()
            try checkSeparator(act, count)
        }
        try harness.journal.expect([], since: mark, "Opening and scrolling the long page")

        // Type in chapter 3, then scroll far away at once.
        controller.scroll(toChapter: chapters[2].id)
        try harness.settle()
        let writing = try harness.editor(chapters[2])
        let typed = "灯塔守夜"
        try require(harness.bookWindow.makeFirstResponder(writing.textView), "Chapter 3 refused keyboard focus")
        let end = (writing.textView.string as NSString).length
        writing.textView.setSelectedRange(NSRange(location: end, length: 0))
        writing.textView.insertText(typed, replacementRange: NSRange(location: end, length: 0))
        // Nearby (outside the attach band, inside the read-only band), the
        // chapter being written in keeps its editor.
        let nearby = try harness.row(chapters[2]).frame.maxY + harness.visible.height * (MacWholeBookViewController.attachMargin + 0.8)
        controller.scrollDocument(toY: nearby)
        try harness.settle()
        try require(try harness.row(chapters[2]).isAttached && harness.row(chapters[2]).isFocused,
            "The chapter being written in lost its editor nearby")
        try require(controller.attachedChapterIDs.count <= maximum + 1, "The focused chapter exceeded the bound by more than one")
        // Far away its editor is released once its input is saved; the owner
        // stays, since the chapter was edited here and has undo history.
        controller.scroll(toChapter: chapters[150].id)
        try harness.settle()
        let scope = DocumentScope.chapter(ChapterScope(projectID: harness.project.id, chapterID: chapters[2].id))
        try require(controller.chapterRow(chapters[2].id)?.isAttached != true && workspace.hasOpenDocument(scope)
            && controller.keptChapterIDs == [chapters[2].id], "Chapter 3 kept its editor, or lost its owner, far away")
        let stored = try harness.prose(chapters[2])
        try require(stored.text.hasSuffix(typed), "Chapter 3's typed text was not saved: \(stored.text.suffix(8))")
        try checkBound("Far away")
        let afterTyping = try harness.journal.mark()
        // Back again: the kept owner shows the saved text and ⌘Z undoes the typing.
        controller.scroll(toChapter: chapters[2].id)
        try harness.settle()
        let returned = try harness.editor(chapters[2])
        try require(returned !== writing && returned.textView.string.hasSuffix(typed) && returned.binding.canEdit
            && controller.keptChapterIDs.isEmpty, "Chapter 3 did not show its saved text on return")
        try harness.journal.expect([], since: afterTyping, "Scrolling away from and back to chapter 3")
        try checkBound("Returned")
        try require(harness.bookWindow.makeFirstResponder(returned.textView), "Chapter 3 refused keyboard focus on return")
        try require(NSApp.sendAction(Selector(("undo:")), to: returned.textView, from: nil), "⌘Z found no undo")
        try harness.settle()
        try require(!returned.textView.string.hasSuffix(typed) && !(try harness.prose(chapters[2])).text.hasSuffix(typed),
            "⌘Z on return did not undo the typing: \(returned.textView.string.suffix(8))")

        // Beyond the kept limit the least recently edited owner closes.
        let limit = MacWholeBookViewController.keptOwnerLimit
        MacWholeBookViewController.keptOwnerLimit = 1
        defer { MacWholeBookViewController.keptOwnerLimit = limit }
        controller.scroll(toChapter: chapters[150].id)
        try harness.settle()
        let later = try harness.editor(chapters[150])
        try require(harness.bookWindow.makeFirstResponder(later.textView), "Chapter 151 refused keyboard focus")
        later.textView.insertText("钟声", replacementRange: NSRange(location: 0, length: 0))
        try harness.settle()
        controller.scroll(toChapter: chapters[60].id)
        try harness.settle()
        let laterScope = DocumentScope.chapter(ChapterScope(projectID: harness.project.id, chapterID: chapters[150].id))
        try require(controller.keptChapterIDs == [chapters[150].id] && workspace.hasOpenDocument(laterScope) && !workspace.hasOpenDocument(scope),
            "The kept limit did not close the least recently edited owner: \(controller.keptChapterIDs)")
        let afterEdits = try harness.journal.mark()

        // Closing releases every editor and closes every owner, kept ones too.
        try harness.closeBook()
        try require(workspace.openDocumentCount == 0 && harness.editorsShown == 0, "Closing left \(workspace.openDocumentCount) owners open")
        try harness.journal.expect([], since: afterEdits, "Closing the long page")
    }

    // MARK: (a2) An owner that fails to close

    private static func wholeBookCloseFailures() throws {
        let harness = try BookHarness(name: "长卷关闭合成项目")
        defer { try? harness.close() }
        for index in 1...40 { try harness.chapter(String(format: "关闭章节 %02d", index), [.paragraph(ideographs(40, seed: index))]) }
        let chapters = harness.chapters, project = harness.project, workspace = harness.workspace
        let savedDelay = MacWholeBookViewController.closeRetryDelay
        MacWholeBookViewController.closeRetryDelay = 0.1
        defer { MacWholeBookViewController.closeRetryDelay = savedDelay }
        try harness.openBook()
        let controller = harness.controller!
        let first = chapters[0], scope = DocumentScope.chapter(ChapterScope(projectID: project.id, chapterID: chapters[0].id))
        try require(controller.attachedChapterIDs.contains(first.id), "The first chapter is not attached")

        // Every close fails: the owner stays tracked and is tried again.
        var attempts: [String] = []
        controller.closeChapterOwner = { chapter, done in attempts.append(chapter.chapterID); done(.failure(LabError.message("合成的关闭失败"))) }
        controller.scroll(toChapter: chapters[39].id)
        try wait { attempts.filter { $0 == first.id }.count >= 4 }
        try harness.settle()
        try require(workspace.hasOpenDocument(scope) && controller.unclosedChapterTitles.contains(first.title)
            && !controller.statusLabel.isHidden && controller.statusLabel.stringValue.contains("“\(first.title)”")
            && controller.statusLabel.stringValue.contains("的正文未能关闭：合成的关闭失败。稍后空闲时会再试。"),
            "A failed close is not tracked or shown: \(controller.statusLabel.stringValue)")

        // 删除项目 refuses, naming the chapter, before anything closes.
        let tab: NativeDocumentView = try elementResult { harness.host.open(project: project, chapter: chapters[20], completion: $0) }
        try elementSettled(harness.host, tab)
        let coordinator = ProjectDeletionCoordinator(workspace: workspace, host: harness.host)
        var panelsClosed = false
        coordinator.panelRefusal = { _ in controller.deletionRefusal }
        coordinator.closePanels = { _, done in panelsClosed = true; done(nil) }
        let mark = try harness.journal.mark()
        let refusal = try elementRefused({ (done: @escaping (Result<ProjectDeletionCoordinator.Outcome, Error>) -> Void) in
            coordinator.delete(project, completion: done)
        }, "Deletion went ahead with an owner the long page could not close")
        try require(refusal.contains("“\(first.title)”") && refusal.contains("合成的关闭失败") && refusal.hasSuffix("项目未删除。")
            && !panelsClosed && harness.host.hasTabs(projectID: project.id), "The deletion refusal reads \(refusal)")
        try harness.journal.expect([], since: mark, "A deletion refused for an unclosed owner")
        let _: Bool = try elementResult { harness.host.closeTab(pane: 0, scope: .chapter(ChapterScope(projectID: project.id, chapterID: chapters[20].id)), completion: $0) }

        // Once closes work again, the next quiet moment closes it.
        controller.closeChapterOwner = nil
        try wait { controller.unclosedChapterTitles.isEmpty && !workspace.hasOpenDocument(scope) }
        try harness.settle()
        try require(!controller.statusLabel.stringValue.contains("未能关闭") && controller.deletionRefusal == nil,
            "The status line kept the failure: \(controller.statusLabel.stringValue)")

        // A shutdown hears the failure instead of waiting, and the owner still closes later.
        controller.scroll(toChapter: first.id)
        try harness.settle()
        controller.closeChapterOwner = { _, done in done(.failure(LabError.message("合成的关闭失败"))) }
        var reported: String??
        try require(controller.shutdown { reported = .some($0) }, "The long page refused to shut down")
        try wait { reported != nil }
        guard case .some(.some(let reason)) = reported, !controller.unclosedChapterTitles.isEmpty,
              controller.unclosedChapterTitles.allSatisfy({ reason.contains("“\($0)”") }) else {
            throw LabError.message("The shutdown did not report the failed close: \(String(describing: reported))")
        }
        try require(!controller.isShutDown && workspace.hasOpenDocument(scope), "The shutdown finished with an owner open")
        controller.closeChapterOwner = nil
        try wait { controller.isShutDown && workspace.openDocumentCount == 0 }
        harness.bookWindow.close()
    }

    // MARK: (b) Editing, undo, links, comments and counts beside a tab

    private static func wholeBookEditsShareOwners() throws {
        let harness = try BookHarness(name: "长卷编辑合成项目")
        defer { try? harness.close() }
        let projectID = harness.project.id, workspace = harness.workspace
        for index in 1...4 { try harness.chapter("编辑章节 \(index)", [.paragraph(ideographs(20, seed: index))]) }
        let chapters = harness.chapters
        let category: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: projectID, name: "地点", completion: $0)
        }
        let element: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: projectID, categoryID: category.result!.id, name: "北塔", completion: $0)
        }
        let tower = element.result!
        // Chapter 2 in a tab and in the long page share one owner.
        let tab: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, chapter: chapters[1], completion: $0) }
        try elementSettled(harness.host, tab)
        try harness.openBook()
        let controller = harness.controller!
        try require(Set(controller.attachedChapterIDs) == Set(chapters.map(\.id)), "A short book did not attach every chapter")
        let view = try harness.editor(chapters[1])
        try require(view.binding.store === tab.binding.store && view !== tab, "The long page and the tab do not share the chapter's owner")
        let counted = harness.host.wordCountLibrary(projectID: projectID)!.count(nodeID: chapters[1].id)!
        try require(try harness.row(chapters[1]).wordsLabel.stringValue == WordCountText.full(counted), "The header count differs")

        // Typing links the element name after the debounce, in both views.
        try require(harness.bookWindow.makeFirstResponder(view.textView), "The editor refused keyboard focus")
        let original = view.textView.string
        let end = (original as NSString).length
        view.textView.setSelectedRange(NSRange(location: end, length: 0))
        view.textView.insertText("北塔在雨中", replacementRange: NSRange(location: end, length: 0))
        try harness.settle()
        let at = (view.textView.string as NSString).range(of: "北塔").location
        try wait { view.linkTargets(at: at).first?.id == tower.id && !view.binding.store.hasScheduledLinks }
        try harness.settle()
        try require(tab.textView.string == view.textView.string && tab.links(at: at).contains(NativeEntityLink(kind: "element", id: tower.id)),
            "The tab did not follow the long page's edit and link")
        try wait { harness.host.wordCountLibrary(projectID: projectID)?.count(nodeID: chapters[1].id) == counted + 5 }
        try harness.settle()
        try require(try harness.row(chapters[1]).wordsLabel.stringValue == WordCountText.full(counted + 5),
            "The header did not follow the count: \(try harness.row(chapters[1]).wordsLabel.stringValue)")
        controller.showStats()
        try require(controller.statsController?.stats?.totalWords == harness.host.wordCountLibrary(projectID: projectID)!.chapterTotal,
            "统计 did not follow the count")

        // One undo removes the typing (the link pass is not a step); redo restores it.
        view.undoProse(); try harness.settle()
        try require(view.textView.string == original && tab.textView.string == original, "Undo in the long page differs")
        view.redoProse(); try harness.settle()
        try require(view.textView.string == original + "北塔在雨中" && tab.textView.string == view.textView.string, "Redo in the long page differs")

        // A comment added in the long page reaches the tab.
        let revision = view.binding.store.projection!.revision
        let comment: WorkspaceComment = try elementResult {
            view.addComment("合成批注", range: NSRange(location: at, length: 2), revision: revision, completion: $0)
        }
        try harness.settle()
        try require(tab.binding.store.projection?.comments.contains { $0.id == comment.id } == true
            && harness.createdComments == [comment.id], "The comment did not reach the tab or the host")

        // ⌘-click (打开「北塔」) asks the window to open the element.
        try require(view.openLink(at: at) && harness.openedLinks.map(\.id) == [tower.id], "Opening the link did not reach the window")

        // Closing the tab leaves the owner to the long page, which keeps editing.
        let scope = DocumentScope.chapter(ChapterScope(projectID: projectID, chapterID: chapters[1].id))
        let closedTab: Bool = try elementResult { harness.host.closeTab(pane: 0, scope: scope, completion: $0) }
        try require(closedTab && workspace.hasOpenDocument(scope) && view.binding.canEdit, "Closing the tab closed the long page's owner")
        let length = (view.textView.string as NSString).length
        view.textView.insertText("又", replacementRange: NSRange(location: length, length: 0))
        try harness.settle()
        try require(try harness.prose(chapters[1]).text.hasSuffix("北塔在雨中又"), "Typing after the tab closed was not saved")

        // Chapter 1 in a tab: releasing the long page closes chapter 2's owner, not chapter 1's.
        let first: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, chapter: chapters[0], completion: $0) }
        try elementSettled(harness.host, first)
        try harness.closeBook()
        let firstScope = DocumentScope.chapter(ChapterScope(projectID: projectID, chapterID: chapters[0].id))
        try require(!workspace.hasOpenDocument(scope) && workspace.hasOpenDocument(firstScope) && first.binding.canEdit
            && workspace.openDocumentCount == 1, "Releasing closed an owner a tab shows, or kept one no tab shows")
    }

    // MARK: (c) The outline and the 跳到 menu

    private static func wholeBookNavigates() throws {
        let harness = try BookHarness(name: "长卷跳转合成项目")
        defer { try? harness.close() }
        for index in 1...40 {
            var blocks = [BookImportBlock.paragraph(ideographs(60, seed: index)), .paragraph(ideographs(40, seed: index + 2))]
            if index == 30 { blocks += [.heading("钟楼之下", level: 1), .paragraph(ideographs(50, seed: 7))] }
            try harness.chapter("跳转章节 \(index)", blocks)
        }
        let chapters = harness.chapters
        let act = try harness.act(before: chapters[20])
        try harness.openBook()
        let controller = harness.controller!, host = harness.host, project = harness.project

        func atTop(_ chapter: WorkspaceChapter, _ context: String) throws {
            let row = try harness.row(chapter)
            try require(abs(row.frame.minY - MacWholeBookViewController.topInset - harness.visible.minY) <= 1 && row.isAttached,
                "\(context): \(chapter.title) is not attached at the top (row \(row.frame.minY), top \(harness.visible.minY))")
        }

        // The outline as AppDelegate wires it while the long page is open.
        let outline = WorkspaceOutlineModel(workspace: harness.workspace, projectID: project.id)
        let outlineController = BookOutlineViewController(model: outline)
        outlineController.canNavigate = { host.canNavigate }
        outlineController.onNavigate = { entry, blockID in controller.scroll(toChapter: entry.id, blockID: blockID) }
        let outlineWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
        outlineWindow.isReleasedWhenClosed = false
        outlineWindow.contentViewController = outlineController
        defer { outlineWindow.close() }
        outline.load()
        try wait { outline.entries.count == 41 }
        guard let table = findTable("book-outline-list", in: outlineController.view) else { throw LabError.message("No outline table") }
        func select(_ identifier: String) throws {
            table.reloadData()
            guard let index = outline.rows.firstIndex(where: { $0.identifier == identifier }) else { throw LabError.message("No outline row \(identifier)") }
            table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
        }
        try select("outline-chapter-\(chapters[34].id)")
        try harness.settle()
        try atTop(chapters[34], "Outline chapter")

        // A heading: the chapter's editor takes the caret on it.
        outline.toggle(chapters[29].id)
        try wait { outline.rows.contains { $0.heading?.text == "钟楼之下" } }
        guard let heading = outline.rows.first(where: { $0.heading?.text == "钟楼之下" })?.heading else { throw LabError.message("No heading row") }
        try select("outline-heading-\(heading.blockId)")
        try harness.settle()
        let editor = try harness.editor(chapters[29])
        let headingAt = (editor.textView.string as NSString).range(of: "钟楼之下").location
        try require(harness.bookWindow.firstResponder === editor.textView && editor.textView.selectedRange().location == headingAt,
            "The heading did not take the caret: \(editor.textView.selectedRange())")
        let headingRow = try harness.row(chapters[29])
        try require(headingRow.frame.intersects(harness.visible), "The heading's chapter is not in view")

        // 跳到: a chapter, then an act.
        guard let menu = controller.jumpButton.menu else { throw LabError.message("No 跳到 menu") }
        func jump(_ identifier: String) throws {
            guard let index = menu.items.firstIndex(where: { $0.accessibilityIdentifier() == identifier }) else {
                throw LabError.message("No 跳到 item \(identifier)")
            }
            menu.performActionForItem(at: index)
        }
        try require(menu.items.count == 42 && menu.items[1].title == "1. 跳转章节 1" && menu.items[21].title == act.name
            && menu.items[22].indentationLevel == 1, "The 跳到 menu does not list the book in order")
        try jump("whole-book-jump-chapter-\(chapters[9].id)")
        try harness.settle()
        try atTop(chapters[9], "跳到 chapter")
        try jump("whole-book-jump-act-\(act.id)")
        try harness.settle()
        guard let actRow = controller.actRow(act.id) else { throw LabError.message("No act row") }
        try require(abs(actRow.frame.minY - harness.visible.minY) <= 1 && (try harness.row(chapters[20])).isAttached,
            "跳到 the act did not bring its separator and first chapter to the top")
    }

    private static func findTable(_ identifier: String, in view: NSView) -> NSTableView? {
        if let table = view as? NSTableView, table.accessibilityIdentifier() == identifier { return table }
        for child in view.subviews { if let found = findTable(identifier, in: child) { return found } }
        return nil
    }

    // MARK: (d) 统计

    /// Six chapters of 120, 80, 300, 400, 500 and 600 ideographs: two before
    /// the first act, two in 第一幕 and two in 第二幕.
    private static func statsBook(_ harness: BookHarness) throws -> [WorkspaceChapter] {
        for (index, count) in [120, 80, 300, 400, 500, 600].enumerated() {
            try harness.chapter("节奏章节 \(index + 1)", [.paragraph(ideographs(count, seed: index))])
        }
        let chapters = harness.chapters
        try harness.act(before: chapters[2]); try harness.act(before: chapters[4])
        try harness.status(chapters[2], .finished); try harness.status(chapters[5], .finished); try harness.status(chapters[1], .discarded)
        return chapters
    }

    private static func wholeBookStatistics() throws {
        let harness = try BookHarness(name: "统计合成项目")
        defer { try? harness.close() }
        let chapters = try statsBook(harness)
        harness.settings.setWritingPlan(WritingPlan(projectWordTarget: 10_000, dailyWordGoal: 800), projectID: harness.project.id)

        // Before counts are read, 统计 reads 统计中….
        let loose = WholeBookModel(workspace: harness.workspace, projectID: harness.project.id)
        let early = MacBookStatsViewController(model: loose)
        var provided: WordCountLibrary?
        early.counts = { provided }
        early.plan = { harness.settings.writingPlan(projectID: harness.project.id) }
        _ = early.view
        loose.load()
        try wait { loose.loaded }
        try require(early.totalValue.stringValue == "统计中…" && early.averageValue.stringValue == "统计中…"
            && early.chaptersValue.stringValue == "6 章" && early.targetValue.stringValue == "统计中…"
            && early.rhythm.bars.count == 6, "统计 did not wait for counts: \(early.totalValue.stringValue)")

        try harness.openBook()
        let controller = harness.controller!
        provided = harness.host.wordCountLibrary(projectID: harness.project.id)
        early.reload()
        controller.showStats()
        guard let stats = controller.statsController else { throw LabError.message("No 统计") }
        for view in [early, stats] {
            try require(view.totalValue.stringValue == "2,000 字" && view.chaptersValue.stringValue == "6 章"
                && view.averageValue.stringValue == "333 字" && view.completionValue.stringValue == "33% · 已完成 2 / 6 章"
                && view.statusValue.stringValue == "草稿 3 · 已完成 2 · 已弃用 1"
                && view.targetValue.stringValue == "2,000 / 10,000 字 · 20%" && view.targetBar.fraction == 0.2 && !view.targetBar.isHidden,
                "统计 values differ: \(view.totalValue.stringValue) / \(view.averageValue.stringValue) / \(view.completionValue.stringValue) / \(view.targetValue.stringValue)")
        }

        // Bars in book order, coloured by act; act rows with their words.
        let statsWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 640), styleMask: [.titled], backing: .buffered, defer: false)
        statsWindow.isReleasedWhenClosed = false
        statsWindow.contentViewController = stats
        defer { statsWindow.close() }
        stats.view.layoutSubtreeIfNeeded()
        let rhythm = stats.rhythm
        try require(rhythm.bars.map(\.chapter.id) == chapters.map(\.id) && rhythm.bars.map(\.words) == [120, 80, 300, 400, 500, 600],
            "The rhythm bars are not the chapters in order")
        let neutral = BookRhythmChart.color(actIndex: nil), firstAct = ElementSwatch.color(hex: BookPalette.act(0))!,
            secondAct = ElementSwatch.color(hex: BookPalette.act(1))!
        try require((0..<6).map { rhythm.color(at: $0) } == [neutral, neutral, firstAct, firstAct, secondAct, secondAct],
            "The rhythm bars are not coloured by act")
        try require(rhythm.barRect(at: 5).width == rhythm.bounds.width && abs(rhythm.barRect(at: 0).width - rhythm.bounds.width * 0.2) < 0.5,
            "The rhythm bars are not scaled to the longest chapter")
        let actLabels = stats.actRows.arrangedSubviews.compactMap { $0.accessibilityLabel() }
        try require(actLabels == ["第一幕，2 章 · 700 字 · 35%", "第二幕，2 章 · 1,100 字 · 55%"], "The act rows read \(actLabels)")
        try require(stats.caption.stringValue == "最长：《节奏章节 6》600 字\n最短：《节奏章节 2》80 字", "The rhythm caption reads \(stats.caption.stringValue)")

        // A click on chapter 6's bar scrolls the long page there.
        controller.scrollDocument(toY: 0)
        try harness.settle()
        let point = rhythm.convert(NSPoint(x: rhythm.barRect(at: 5).midX, y: rhythm.rowRect(at: 5).midY), to: nil)
        guard let click = NSEvent.mouseEvent(with: .leftMouseDown, location: point, modifierFlags: [], timestamp: 0,
                                             windowNumber: statsWindow.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else {
            throw LabError.message("Could not synthesize the bar click")
        }
        rhythm.mouseDown(with: click)
        try harness.settle()
        let target = try harness.row(chapters[5])
        try require(target.isAttached && (abs(target.frame.minY - MacWholeBookViewController.topInset - harness.visible.minY) <= 1
            || harness.visible.maxY >= harness.controller.documentView.frame.height - 1),
            "The bar click did not scroll to chapter 6 (row \(target.frame.minY), top \(harness.visible.minY))")

        // A status written elsewhere reaches the header and 统计.
        let _: WorkspaceNodeMetadata = try elementResult {
            harness.host.setNodeStatus(projectID: harness.project.id, nodeID: chapters[0].id, status: WritingStatus.finished.rawValue, completion: $0)
        }
        try wait { stats.completionValue.stringValue == "50% · 已完成 3 / 6 章" }
        try require(try harness.row(chapters[0]).statusLabel.stringValue == "已完成", "The header did not follow the status")
        loose.load()
        try wait { !loose.loading && early.completionValue.stringValue == "50% · 已完成 3 / 6 章" }
    }

    // MARK: (e) The writing plan persists

    private static func wholeBookPlanPersists() throws {
        let harness = try BookHarness(name: "写作计划合成项目")
        defer { try? harness.close() }
        _ = try statsBook(harness)
        let other: WorkspaceProject = try elementResult { harness.workspace.createProject(name: "另一合成项目", completion: $0) }
        let projectID = harness.project.id
        harness.host.wordCounts(projectID: projectID)
        try wait { harness.host.wordCountLibrary(projectID: projectID) != nil }
        let mark = try harness.journal.mark()

        func sheet() throws -> ProjectProfileSheet {
            let model = ProjectProfileModel(workspace: harness.workspace, projectID: projectID)
            if let counts = harness.host.wordCountLibrary(projectID: projectID) { model.applyWordCounts(counts) }
            let sheet = ProjectProfileSheet(model: model, projectName: harness.project.name, plans: harness.settings)
            model.load()
            try wait { !model.loading && model.details != nil }
            return sheet
        }
        var profile = try sheet()
        try require(profile.targetField.stringValue == "120,000" && profile.dailyField.stringValue == "1,500"
            && profile.planLabel.stringValue == "已写 2,000 / 120,000 字 · 1%", "The default plan reads \(profile.targetField.stringValue) / \(profile.planLabel.stringValue)")
        try require(profile.chaptersLabel.stringValue == "共 6 章 · 草稿 3 · 已完成 2 · 已弃用 1", "The status counts read \(profile.chaptersLabel.stringValue)")
        try editHeader(profile.window, profile.targetField, "15万")
        try editHeader(profile.window, profile.dailyField, "2,000字")
        let plan = harness.settings.writingPlan(projectID: projectID)
        try require(plan == WritingPlan(projectWordTarget: 150_000, dailyWordGoal: 2_000), "The plan was stored as \(plan)")
        try require(profile.targetField.stringValue == "150,000" && profile.dailyField.stringValue == "2,000"
            && profile.planLabel.stringValue == "已写 2,000 / 150,000 字 · 1%" && profile.planMessage.isHidden,
            "The sheet does not show the stored plan: \(profile.planLabel.stringValue)")
        // Unreadable input is refused and keeps the typed text.
        try editHeader(profile.window, profile.targetField, "很多")
        try require(harness.settings.writingPlan(projectID: projectID) == plan && profile.targetField.stringValue == "很多"
            && profile.planMessage.stringValue.hasPrefix("字数须为") && !profile.planMessage.isHidden, "Unreadable input was not refused")
        try editHeader(profile.window, profile.targetField, "150000")
        try require(profile.planMessage.isHidden, "The refusal stayed after a valid entry")
        let file = harness.root.appendingPathComponent(LabSettingsStore.fileName)
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        let stored = (json?["writingPlans"] as? [String: Any])?[projectID] as? [String: Any]
        try require(stored?["projectWordTarget"] as? Int == 150_000 && stored?["dailyWordGoal"] as? Int == 2_000,
            "settings.json holds \(String(describing: json?["writingPlans"]))")
        try require(harness.settings.writingPlan(projectID: other.id) == WritingPlan(), "Another project did not keep the defaults")
        try harness.journal.expect([], since: mark, "Editing the writing plan")
        profile.window.close()

        // A cold relaunch restores the plan in the sheet and in 统计.
        try harness.relaunch()
        try require(harness.settings.writingPlan(projectID: projectID) == plan, "Relaunch lost the plan")
        harness.host.wordCounts(projectID: projectID)
        try wait { harness.host.wordCountLibrary(projectID: projectID) != nil }
        profile = try sheet()
        try require(profile.targetField.stringValue == "150,000" && profile.dailyField.stringValue == "2,000"
            && profile.planLabel.stringValue == "已写 2,000 / 150,000 字 · 1%", "The relaunched sheet reads \(profile.targetField.stringValue)")
        profile.window.close()
        try harness.openBook()
        harness.controller.showStats()
        try require(harness.controller.statsController?.targetValue.stringValue == "2,000 / 150,000 字 · 1%",
            "The relaunched 统计 reads \(harness.controller.statsController?.targetValue.stringValue ?? "")")
        try harness.journal.expect([], since: mark, "Relaunching with the writing plan")
    }

    // MARK: (f) Today's words

    private static func wholeBookTodayWords() throws {
        let harness = try BookHarness(name: "今日字数合成项目")
        defer { try? harness.close() }
        let chapters = try statsBook(harness)
        let projectID = harness.project.id
        // A second replica of the closed book authors the received originals.
        let peerDirectory = harness.root.appendingPathComponent("peer/apple-native-lab")
        try harness.relaunch { try WorkspaceRemoteProseFixture.copyClosedBaseline(from: harness.directory, to: [peerDirectory]) }
        let peer = LabWorkspaceCore(directory: peerDirectory)
        let _: [WorkspaceProject] = try elementResult { peer.projects(completion: $0) }

        let calendar = Calendar.current
        var clock = calendar.date(from: DateComponents(year: 2026, month: 9, day: 27, hour: 23, minute: 40))!
        var ledger: DailyWordLedger!
        func attach() {
            harness.settings.now = { clock }
            ledger = DailyWordLedger(store: harness.settings)
            ledger.attach(to: harness.workspace)
        }
        attach()
        harness.settings.setWritingPlan(WritingPlan(projectWordTarget: 10_000, dailyWordGoal: 100), projectID: projectID)
        /// Reads counts until the model and every bracketing read are idle.
        func settleCounts(file: String = #fileID, line: Int = #line) throws {
            let model = harness.host.wordCounts(projectID: projectID)
            try wait(file: file, line: line) { model.isIdle && harness.host.canNavigate && !harness.host.isBusy }
            let _: WorkspaceWordCounts = try elementResult { harness.workspace.wordCounts(projectID: projectID, completion: $0) }
            try wait(file: file, line: line) { model.isIdle }
        }
        func today() -> Int { harness.settings.todayWords(projectID: projectID) }
        func sheet() throws -> ProjectProfileSheet {
            let model = ProjectProfileModel(workspace: harness.workspace, projectID: projectID)
            let sheet = ProjectProfileSheet(model: model, projectName: harness.project.name, plans: harness.settings)
            model.load()
            try wait { !model.loading && model.details != nil }
            return sheet
        }
        func stats() throws -> MacBookStatsViewController {
            let book = WholeBookModel(workspace: harness.workspace, projectID: projectID)
            let stats = MacBookStatsViewController(model: book)
            let settings = harness.settings, host = harness.host
            stats.counts = { host.wordCountLibrary(projectID: projectID) }
            stats.plan = { settings.writingPlan(projectID: projectID) }
            stats.today = { settings.todayWords(projectID: projectID) }
            _ = stats.view
            book.load()
            try wait { book.loaded }
            return stats
        }
        func open(_ chapter: WorkspaceChapter) throws -> NativeDocumentView {
            let view: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, chapter: chapter, completion: $0) }
            try elementSettled(harness.host, view)
            return view
        }
        func write(_ text: String, in view: NativeDocumentView) throws {
            view.textView.setSelectedRange(NSRange(location: 0, length: 0))
            view.textView.insertText(text, replacementRange: NSRange(location: 0, length: 0))
            try elementSettled(harness.host, view)
            try settleCounts()
        }

        // The first read of the session is the baseline: nothing counts.
        try settleCounts()
        let profile = try sheet(), statsView = try stats()
        try require(today() == 0 && profile.todayLabel.stringValue == "今日 0 / 100 字 · 0%" && !profile.todayBar.isHidden
            && statsView.todayValue.stringValue == "0 / 100 字 · 0%", "Today starts at \(profile.todayLabel.stringValue)")

        // Typing, undo and redo in a chapter page.
        let first = try open(chapters[0])
        try write(ideographs(12, seed: 40), in: first)
        try require(today() == 12 && profile.todayLabel.stringValue == "今日 12 / 100 字 · 12%" && profile.todayBar.fraction == 0.12
            && statsView.todayValue.stringValue == "12 / 100 字 · 12%" && statsView.todayBar.fraction == 0.12,
            "Typing counted \(today()): \(profile.todayLabel.stringValue) / \(statsView.todayValue.stringValue)")
        first.undoProse(); try elementSettled(harness.host, first); try settleCounts()
        try require(today() == 0, "Undo left \(today())")
        first.redoProse(); try elementSettled(harness.host, first); try settleCounts()
        try require(today() == 12, "Redo left \(today())")

        // An accepted writing-assistant change to a closed chapter, applied
        // as the panel applies it, and an import.
        let agent = ["sessionId": "conversation-synthetic", "turnId": "turn-synthetic", "callId": "call-synthetic"]
        let _: WorkspaceAgentApplied = try elementResult {
            harness.workspace.agentApplyChanges(projectID: projectID, kind: "chapter", id: chapters[1].id,
                changes: [AgentProseChange.appending(ideographs(8, seed: 41)).payload], agent: agent, completion: $0)
        }
        harness.host.wordCounts(projectID: projectID, refresh: true)
        try settleCounts()
        try require(today() == 20, "The accepted change counted \(today() - 12)")
        let imported = try harness.chapter("导入章节", [.paragraph(ideographs(30, seed: 42))])
        harness.host.chaptersChanged(projectID: projectID)
        try wait { harness.host.wordCountLibrary(projectID: projectID)?.contains(nodeID: imported.id) == true }
        try settleCounts()
        try require(today() == 50 && harness.host.wordCountLibrary(projectID: projectID)?.count(nodeID: imported.id) == 30,
            "The import counted \(today() - 20)")

        // Received originals: one into the open chapter, one into a closed chapter.
        for (chapter, words) in [(chapters[0], 15), (chapters[3], 25)] {
            let documentID = "node-content:" + chapter.id
            let old = Set(try WorkspaceRemoteProseFixture.localPackets(in: peerDirectory, documentID: documentID).map { $0.original.changeSetId })
            let core: LabCore = try elementResult { peer.openChapter(projectID: projectID, chapterID: chapter.id, completion: $0) }
            let state = try read(core)
            let edited: LabDocumentState = try elementResult { core.document("documentReplace", edit: [
                "revision": state.projection.revision, "range": ["location": 0, "length": 0], "text": ideographs(words, seed: 43 + words),
            ], completion: $0) }
            try require(edited.saved, "The peer edit was not saved")
            let packets = try WorkspaceRemoteProseFixture.localPackets(in: peerDirectory, documentID: documentID, excluding: old)
            try require(packets.count == 1, "The peer edit made \(packets.count) originals")
            let before = harness.host.wordCountLibrary(projectID: projectID)?.count(nodeID: chapter.id) ?? 0
            let _: WorkspaceRemoteProseReply = try elementResult {
                harness.workspace.receiveProse(original: packets[0].original, envelope: packets[0].envelope, completion: $0)
            }
            try elementSettled(harness.host, first)
            try settleCounts()
            try require(harness.host.wordCountLibrary(projectID: projectID)?.count(nodeID: chapter.id) == before + words,
                "The received original did not change \(chapter.title)'s count")
        }
        try require(today() == 50 && first.textView.string.contains(ideographs(15, seed: 58)), "Received text counted: \(today())")

        // A version restore: the text since the version left is not counted.
        let scope = DocumentScope.chapter(ChapterScope(projectID: projectID, chapterID: chapters[0].id))
        let _: Bool = try elementResult { harness.host.closeTab(pane: 0, scope: scope, completion: $0) }
        let reopened = try open(chapters[0])
        try write(ideographs(5, seed: 44), in: reopened)
        try require(today() == 55, "Typing after reopening counted \(today() - 50)")
        let history = VersionHistoryModel(workspace: harness.workspace,
                                          target: VersionHistoryTarget(projectID: projectID, kind: "chapter", id: chapters[0].id, title: chapters[0].title))
        history.load()
        try wait { history.loaded && !history.busy }
        guard let closed = history.entries.first(where: { $0.meta?.reason == "close" }) else {
            throw LabError.message("No version kept on close: \(history.entries.map { $0.meta?.reason ?? "" })")
        }
        var restored: Result<WorkspaceHistoryRestored, Error>?
        history.restore(snapshotID: closed.id) { restored = $0 }
        try wait { restored != nil }
        _ = try restored!.get()
        try elementSettled(harness.host, reopened)
        try settleCounts()
        try require(!reopened.textView.string.hasPrefix(ideographs(5, seed: 44)) && today() == 55, "The version restore counted: \(today())")

        // Chapter trash and restore change the book, not today's words.
        let _: WorkspaceChapterTrashReply = try elementResult { harness.host.trash(projectID: projectID, chapterID: imported.id, completion: $0) }
        try settleCounts()
        let _: WorkspaceChapterTrashReply = try elementResult { harness.workspace.restoreChapter(projectID: projectID, chapterID: imported.id, completion: $0) }
        harness.host.chaptersChanged(projectID: projectID)
        harness.host.wordCounts(projectID: projectID, refresh: true)
        try wait { harness.host.wordCountLibrary(projectID: projectID)?.contains(nodeID: imported.id) == true }
        try settleCounts()
        try require(today() == 55 && harness.host.wordCountLibrary(projectID: projectID)?.count(nodeID: imported.id) == 30,
            "Trash and restore counted: \(today())")

        // Midnight: today starts again; yesterday stays in settings.json.
        clock = calendar.date(from: DateComponents(year: 2026, month: 9, day: 28, hour: 0, minute: 0, second: 10))!
        harness.settings.checkDay()
        try require(today() == 0 && profile.todayLabel.stringValue == "今日 0 / 100 字 · 0%" && statsView.todayValue.stringValue == "0 / 100 字 · 0%",
            "Midnight did not roll over: \(profile.todayLabel.stringValue)")
        try require(harness.settings.nextRollover == calendar.date(from: DateComponents(year: 2026, month: 9, day: 29)),
            "The next rollover is \(String(describing: harness.settings.nextRollover))")
        try write(ideographs(7, seed: 45), in: reopened)
        try require(today() == 7 && profile.todayLabel.stringValue == "今日 7 / 100 字 · 7%", "The new day counted \(today())")
        let file = harness.root.appendingPathComponent(LabSettingsStore.fileName)
        func storedDays() throws -> [String: Int] {
            let json = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
            return ((json?["dailyWords"] as? [String: Any])?[projectID] as? [String: Int]) ?? [:]
        }
        try require(try storedDays() == ["2026-09-27": 55, "2026-09-28": 7], "settings.json holds \(try storedDays())")
        // Reads, brackets and the rollover write nothing to the journal.
        let mark = try harness.journal.mark()
        let _: WorkspaceWordCounts = try elementResult { harness.workspace.reconcileWordCounts(projectID: projectID, completion: $0) }
        try settleCounts()
        harness.settings.checkDay()
        try harness.journal.expect([], since: mark, "Counting today's words")
        profile.window.close()

        // A cold relaunch keeps the day and counts only what follows.
        let _: Bool = try elementResult { peer.close(completion: $0) }
        try harness.relaunch()
        clock = calendar.date(from: DateComponents(year: 2026, month: 9, day: 28, hour: 0, minute: 5))!
        attach()
        try settleCounts()
        let relaunched = try sheet()
        try require(today() == 7 && relaunched.todayLabel.stringValue == "今日 7 / 100 字 · 7%", "The relaunch reads \(relaunched.todayLabel.stringValue)")
        let again = try open(chapters[0])
        try write(ideographs(3, seed: 46), in: again)
        try require(today() == 10 && relaunched.todayLabel.stringValue == "今日 10 / 100 字 · 10%", "After the relaunch today reads \(today())")
        relaunched.window.close()

        // 30 days are kept: a synthetic project observed on 35 days in a row.
        let start = clock
        for day in 0..<35 {
            clock = calendar.date(byAdding: .day, value: day, to: start)!
            ledger.observe(projectID: "synthetic-days", counts: WorkspaceWordCounts(
                counts: [WorkspaceNodeWordCount(nodeId: "chapter-synthetic", kind: "chapter", wordCount: day)], failures: []), authored: true)
        }
        let kept = harness.settings.dailyWords(projectID: "synthetic-days")
        let oldest = harness.settings.dayKey(calendar.date(byAdding: .day, value: 5, to: start)!)
        try require(kept.count == 30 && kept.keys.min() == oldest && kept.values.allSatisfy { $0 == 1 }
            && harness.settings.dailyWords(projectID: projectID).isEmpty,
            "Pruning kept \(kept.count) days from \(kept.keys.min() ?? "")")
    }
}
