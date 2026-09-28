import AppKit

/// A storyline's 章节模版 and chapters created in a storyline, the storyline
/// and category pages' list filters, importing several files or a folder,
/// exporting every project, 设置 › 编辑器's 段间距, 版心宽度, 打字机位置 and
/// 自动链接设定名称, the 全书长卷's remembered reading position and the
/// formatted 历史版本 preview, through the real pages, sheets, panels, tab
/// host, transfer coordinator, exporter, settings store and window, the Rust
/// workspace and SQLite, wired as AppDelegate wires them. Windows are never
/// on screen; every name, body and file is synthetic and generated here.
extension BindingAcceptance {
    static let smallItemsCases = [
        "AppKit 章节模版 on a storyline page is edited in the template sheet (a heading, a paragraph with bold on a selected range, Return adding a row), writes one field.set storyline on 保存 and nothing when unchanged or cancelled, and 新建章节 on the page and 新建章节… in the 故事线 panel create the chapter with that storyline as its 主线 and its body from the template, listed on the page, told to the chapter list and opened; 清空模版 returns new chapters to an empty body, an unknown or trashed storyline is refused before anything is written, and templates and chapters survive a cold reopen",
        "AppKit a storyline page filters its chapters by 全部, 已写 and 未起 from the canonical word counts (following typing in a chapter) and a category page lists its 设定 and filters them by 已填写 and 未填写 (简介, a 字段 value beyond the 模板字段, or body text beyond the 新设定模版, following a body edit); each page's filter is kept per page in settings.json, another view of the page follows, and both come back after a cold relaunch",
        "AppKit 文件 › 导入… with several Markdown, text and Word files, and with a folder, lists the supported files sorted by name (a chosen image and an empty file skipped with their reasons, other folder files left out), imports each through the single-file path as chapters joining a chosen 故事线 as 主线, as 设定 of a chosen 分类 or as 漂流, and shows each file as created or skipped with Rust's reason, telling the lists without opening pages",
        "AppKit 文件 › 导出全部项目为 Markdown 文件夹… writes every project's archive (the same files as its own export) into its own folder inside a new 全部项目 folder named by the day, suffixes a second export and a second project of the same name, reports the projects and files with 在访达中显示, and writes nothing to the journal",
        "AppKit 设置 › 编辑器 段间距, 版心宽度, 打字机位置 and 自动链接设定名称 apply at once and persist in settings.json: paragraph spacing in every body's paragraph style (a hidden tab too) and the 全书长卷, a centred text column of the chosen width in pane editors and the 全书长卷's rows (a narrow pane keeps its margins), the caret line at the chosen height with 打字机滚动, and with linking off typed names get no new link while existing links stay, until linking is on again",
        "AppKit 全书长卷 reports its reading position (the row at the top and the offset into it) per project to settings.json after scrolling and on closing, a cold relaunch opens the book at that chapter and offset, another project keeps its own position, and a position whose chapter left the book opens at the top",
        "AppKit 历史版本 preview reads the selected version from Rust's projection and sets it with its headings, bold, italic, underline, strike, URL links, centred alignment and block indent, keeps marking text the current body lacks on a green wash and striking text the version lacks, falls back to plain text when the marks are off, and another body's version is refused",
        "AppKit import fixes: 导入 and the target popups stay disabled while an import runs in both sheets, so a late library reply or a second Return imports nothing twice; a chapter that could not join its 故事线 says so in its file line, the summary and the single-file sheet's final status; bulk import shows its sheet at once and reads the files off the main thread one by one, skips a file above 200 MB unread, and 取消 closes the sheet while reading or stops the import before the next file",
        "AppKit list fixes: a category page lists its 设定 from the library a reply brings at once; an element body save reads only that body, library replies read only 设定 not read yet, and a newer sweep stops an older chain; a chapter whose body is still its storyline's 章节模版 counts as 未起 until it is written, and only chapters no longer than the template are read",
    ]

    static func smallItemsAcceptance() throws -> [String] {
        let saved = (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay, WordCountModel.refreshDelay,
                     MacChapterWorkspace.elementBodyDelay, MacWholeBookViewController.positionDelay,
                     MacWholeBookViewController.typingPause, MacWholeBookViewController.retryDelay)
        defer {
            (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay, WordCountModel.refreshDelay,
             MacChapterWorkspace.elementBodyDelay, MacWholeBookViewController.positionDelay,
             MacWholeBookViewController.typingPause, MacWholeBookViewController.retryDelay) = saved
            LabSettingsStore.restoreUnconfigured()
        }
        DocumentStore.entityLinkDelay = 0.05
        MacChapterWorkspace.backlinkDelay = 0.05
        WordCountModel.refreshDelay = 0.05
        MacChapterWorkspace.elementBodyDelay = 0.05
        MacWholeBookViewController.positionDelay = 0.05
        MacWholeBookViewController.typingPause = 0.2
        MacWholeBookViewController.retryDelay = 0.05
        // Template rows and previews are checked in the default typography.
        let typography = DocumentStyle.typography
        DocumentStyle.typography = .standard
        defer { DocumentStyle.typography = typography }
        try smallTemplates()
        try smallFilters()
        try smallImport()
        try smallExportAll()
        try smallSettings()
        try smallWholeBookPosition()
        try smallHistoryPreview()
        try smallImportFixes()
        try smallListFixes()
        return smallItemsCases
    }

    // MARK: Harness

    private final class SmallHarness {
        let root: URL
        let directory: URL
        let journal: JournalProbe
        private(set) var workspace: LabWorkspaceCore
        private(set) var settings: LabSettingsStore
        private(set) var window: NSWindow
        private(set) var host: MacChapterWorkspace
        var errors: [String] = []
        /// Chapters `onChapterCreated` reported (nil: read the list again).
        var created: [WorkspaceChapter?] = []
        /// Answers for 新建章节's title prompt, in order; none cancels.
        var titles: [String] = []
        var asked: [String] = []

        init(root existing: URL? = nil) throws {
            root = existing ?? FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            directory = root.appendingPathComponent("apple-native-lab")
            journal = JournalProbe(directory: directory)
            workspace = LabWorkspaceCore(directory: directory)
            settings = LabSettingsStore(directory: root)
            (window, host) = BindingAcceptance.elementHost(workspace)
            let workspace = self.workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(existing != nil || listed.isEmpty, "The small-items fixture was not isolated")
            wire()
        }

        /// As AppDelegate wires the tab host.
        private func wire() {
            host.listFilterSettings = settings
            host.plotPlannerSettings = settings
            host.onError = { [weak self] in self?.errors.append($0.localizedDescription) }
            host.askChapterTitle = { [weak self] _, storyline, done in
                guard let self else { done(nil); return }
                self.asked.append(storyline.name)
                done(self.titles.isEmpty ? nil : self.titles.removeFirst())
            }
            host.onChapterCreated = { [weak self] _, chapter in self?.created.append(chapter) }
        }

        func project(_ name: String) throws -> WorkspaceProject {
            let workspace = self.workspace
            return try BindingAcceptance.elementResult { workspace.createProject(name: name, completion: $0) }
        }

        func chapter(_ project: WorkspaceProject, _ title: String, _ paragraphs: [String] = []) throws -> WorkspaceChapter {
            let workspace = self.workspace
            if paragraphs.isEmpty {
                return try BindingAcceptance.elementResult { workspace.createChapter(projectID: project.id, title: title, completion: $0) }
            }
            let imported: WorkspaceImportedEntity = try BindingAcceptance.elementResult {
                workspace.importBlocks(projectID: project.id, title: title, target: .chapter, blocks: paragraphs.map { .paragraph($0) }, completion: $0)
            }
            guard case .chapter(let chapter) = imported else { throw LabError.message("\(title) was not imported as a chapter") }
            return chapter
        }

        func storyline(_ project: WorkspaceProject, _ name: String) throws -> WorkspaceStoryline {
            let workspace = self.workspace
            let reply: WorkspaceStorylineReply<WorkspaceStoryline> = try BindingAcceptance.elementResult {
                workspace.createStoryline(projectID: project.id, name: name, completion: $0)
            }
            host.applyStorylineLibrary(projectID: project.id, library: reply.library)
            guard let storyline = reply.result else { throw LabError.message("\(name) was not created") }
            return storyline
        }

        func library(_ project: WorkspaceProject) throws -> WorkspaceStorylineLibrary {
            let workspace = self.workspace
            return try BindingAcceptance.elementResult { workspace.storylineLibrary(projectID: project.id, completion: $0) }
        }

        func chapters(_ project: WorkspaceProject) throws -> [WorkspaceChapter] {
            let workspace = self.workspace
            return try BindingAcceptance.elementResult { workspace.chapters(projectID: project.id, completion: $0) }
        }

        func prose(_ project: WorkspaceProject, _ kind: String, _ id: String) throws -> String {
            let workspace = self.workspace
            let prose: WorkspaceAgentProse = try BindingAcceptance.elementResult {
                workspace.agentReadProse(projectID: project.id, kind: kind, id: id, completion: $0)
            }
            return prose.text
        }

        func settled(file: String = #fileID, line: Int = #line) throws {
            try BindingAcceptance.wait(file: file, line: line) {
                !self.host.isBusy && self.host.canNavigate
                    && (self.host.activeView.map { $0.binding.state != nil && !$0.binding.hasPendingWork
                        && !$0.binding.store.hasScheduledLinks && !$0.binding.store.isLinking } ?? true)
            }
            window.contentView?.layoutSubtreeIfNeeded()
        }

        @discardableResult
        func open(_ project: WorkspaceProject, _ target: WorkspaceTabTarget, in pane: Int? = nil) throws -> NativeDocumentView {
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

        func type(_ view: NativeDocumentView, _ text: String, at location: Int? = nil) throws {
            let at = location ?? (view.textView.string as NSString).length
            view.textView.setSelectedRange(NSRange(location: at, length: 0))
            view.textView.insertText(text, replacementRange: NSRange(location: at, length: 0))
            try BindingAcceptance.wait {
                !self.host.isBusy && !view.binding.hasPendingWork && !view.binding.store.hasScheduledLinks && !view.binding.store.isLinking
            }
        }

        func settingsJSON() throws -> [String: Any] {
            let data = try Data(contentsOf: settings.fileURL)
            return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        }

        /// A cold relaunch: the host and workspace close, then a new
        /// workspace, settings store (read from disk), window and host open.
        func relaunch() throws {
            try close()
            workspace = LabWorkspaceCore(directory: directory)
            let workspace = self.workspace
            let _: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            settings = LabSettingsStore(directory: root)
            (window, host) = BindingAcceptance.elementHost(workspace)
            wire()
        }

        func close() throws {
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "The small-items workspace failed to close")
            window.close()
        }

        func remove() { try? FileManager.default.removeItem(at: root) }
    }

    private static func smallPress(_ button: NSButton) { button.sendAction(button.action, to: button.target) }

    private static func smallChoose(_ control: NSSegmentedControl, _ segment: Int) {
        control.selectedSegment = segment
        control.sendAction(control.action, to: control.target)
    }

    /// Types into a template sheet row through its field editor.
    private static func smallTypeRow(_ sheet: ElementTemplateSheet, _ index: Int, _ text: String) throws -> NSTextView {
        let field = sheet.editor.rows[index].textField
        if field.currentEditor() == nil { try require(sheet.window.makeFirstResponder(field), "Template row refused keyboard focus") }
        guard let editor = field.currentEditor() as? NSTextView else { throw LabError.message("Template row has no field editor") }
        editor.insertText(text, replacementRange: editor.selectedRange())
        return editor
    }

    /// Each block as “h2 开场” or its text, from a view's projection.
    private static func smallBlocks(_ view: NativeDocumentView) -> [String] {
        guard let projection = view.binding.store.projection else { return [] }
        let text = projection.text as NSString
        return projection.blocks.map { block in
            let value = text.substring(with: block.range.nsRange)
            return block.kind == "heading" ? "h\(block.headingLevel) \(value)" : value
        }
    }

    // MARK: (a) 章节模版 and new chapters in a storyline

    private static func smallTemplates() throws {
        let harness = try SmallHarness()
        defer { harness.remove() }
        let journal = harness.journal
        let project = try harness.project("章节模版合成项目")
        let opening = try harness.chapter(project, "第一章")
        let main = try harness.storyline(project, "主线")
        let side = try harness.storyline(project, "支线")
        harness.host.chaptersChanged(projectID: project.id)
        try harness.open(project, .storyline(main))
        guard let page = harness.host.activeStorylinePage else { throw LabError.message("The storyline page did not open") }
        try wait { page.template != nil && page.chaptersView.listed.count == 1 }
        try require(page.template == [] && page.templateView.detail.stringValue == "未设置"
            && page.templateView.accessibilityIdentifier() == "chapter-template-section"
            && page.templateView.editButton.accessibilityIdentifier() == "edit-chapter-template"
            && page.chaptersView.createButton.title == "新建章节",
            "The storyline page lacks its 章节模版 section or 新建章节")

        // The sheet: a heading, Return, a paragraph with bold on a selection.
        smallPress(page.templateView.editButton)
        guard let sheet = page.templateSheet else { throw LabError.message("编辑模版… did not open the sheet") }
        try require(sheet.window.title == "章节模版" && sheet.explanation.stringValue.contains("加入这条故事线")
            && sheet.explanation.stringValue.contains("已有的章节不会改变") && sheet.editor.rows.isEmpty,
            "The 章节模版 sheet does not explain itself: \(sheet.explanation.stringValue)")
        smallPress(sheet.editor.addButton)
        var editor = try smallTypeRow(sheet, 0, "开场")
        let popup = sheet.editor.rows[0].kindPopup
        popup.selectItem(withTag: 2)
        popup.sendAction(popup.action, to: popup.target)
        editor.doCommand(by: #selector(NSResponder.insertNewline(_:)))
        try require(sheet.editor.rows.count == 2, "Return did not add a paragraph row")
        editor = try smallTypeRow(sheet, 1, "要点：冲突")
        editor.setSelectedRange(NSRange(location: 0, length: 2))
        smallPress(sheet.editor.rows[1].boldButton)
        let expected = [BookImportBlock(kind: .heading, level: 2, text: "开场", marks: []),
                        BookImportBlock(kind: .paragraph, level: nil, text: "要点：冲突", marks: [BookImportMark(kind: .bold, location: 0, length: 2)])]
        try require(sheet.editor.blocks == expected, "The sheet's blocks differ: \(sheet.editor.blocks)")
        try require(sheet.preview.text.contains("开场") && sheet.preview.text.contains("要点：冲突"), "The preview did not follow the rows")
        var mark = try journal.mark()
        smallPress(sheet.saveButton)
        try wait { page.templateSheet == nil }
        try journal.expect([["field.set storyline"]], since: mark, "保存 of the 章节模版")
        try require(page.template == expected && page.templateView.detail.stringValue.hasPrefix("在这条故事线中新建的章节正文从这里开始"),
            "The page did not show the stored template: \(page.templateView.detail.stringValue)")
        // Unchanged and cancelled sheets write nothing.
        mark = try journal.mark()
        smallPress(page.templateView.editButton)
        guard let unchanged = page.templateSheet, unchanged.editor.blocks == expected else {
            throw LabError.message("The sheet did not reopen with the stored template")
        }
        smallPress(unchanged.saveButton)
        try wait { page.templateSheet == nil }
        smallPress(page.templateView.editButton)
        guard let cancelled = page.templateSheet else { throw LabError.message("The sheet did not open a third time") }
        smallPress(cancelled.clearButton)
        try require(cancelled.editor.rows.isEmpty, "清空模版 left rows")
        smallPress(cancelled.cancelButton)
        try wait { page.templateSheet == nil }
        try journal.expect([], since: mark, "An unchanged and a cancelled 章节模版")
        try require(page.template == expected, "Cancelling changed the stored template")

        // 新建章节 on the page: the chapter joins 主线 and starts from the template.
        harness.titles = ["  第二章 "]
        mark = try journal.mark()
        smallPress(page.chaptersView.createButton)
        try wait { harness.host.activeChapter?.title == "第二章" }
        try harness.settled()
        guard let second = harness.host.activeChapter, let secondView = harness.host.activeView else {
            throw LabError.message("The new chapter did not open")
        }
        try require(harness.asked == ["主线"] && harness.created.compactMap { $0?.id } == [second.id],
            "The title was not asked in 主线 or the chapter list was not told: \(harness.asked)")
        try require(smallBlocks(secondView) == ["h2 开场", "要点：冲突"], "The new chapter did not start from the template: \(smallBlocks(secondView))")
        guard let emphasis = secondView.binding.store.projection?.blocks[1].runs.first,
              emphasis.attributes.bold, emphasis.range.length == 2 else { throw LabError.message("The template's bold did not reach the chapter") }
        let written = try journal.originals(since: mark)
        try require(written.count >= 2 && written[0].contains("entity.create node")
            && written.contains { $0.contains("set.add membership") && $0.contains("field.set node-storyline-primary") }
            && written.last?.contains("yjs.update prose-document") == true && !written.joined().contains("field.set storyline"),
            "Creating in a storyline wrote \(written)")
        var library = try harness.library(project)
        try require(library.membership(chapterID: second.id)?.primary == main.id && library.membership(chapterID: second.id)?.storylineIds == [main.id],
            "The chapter did not join 主线 as its primary")
        try wait { page.chaptersView.listed.map(\.chapter.title) == ["第一章", "第二章"] && page.chaptersView.listed[1].primary }
        // Typing in it is the author's, with its own undo.
        try harness.type(secondView, "风起。")
        secondView.undoProse()
        try harness.settled()
        try require(smallBlocks(secondView) == ["h2 开场", "要点：冲突"], "Undo reached into the template fill")

        // 新建章节… in the 故事线 panel, for 支线 (no template: an empty body).
        let model = StorylineLibraryModel(workspace: harness.workspace, projectID: project.id)
        let controller = MacStorylineLibraryViewController(model: model)
        controller.onCreateChapter = { storyline in harness.host.createChapter(project: project, storyline: storyline) }
        controller.canNavigate = { harness.host.canNavigate }
        _ = controller.view
        model.load()
        try wait { model.loaded && !model.busy }
        guard let row = model.rows.first(where: { $0.storyline?.id == side.id }),
              let item = controller.menuItems(for: row).first(where: { $0.accessibilityIdentifier() == "create-storyline-chapter" }) as? LibraryMenuItem else {
            throw LabError.message("The 故事线 panel row has no 新建章节…")
        }
        try require(item.title == "新建章节…", "The panel item is named \(item.title)")
        harness.titles = ["第三章"]
        item.press()
        try wait { harness.host.activeChapter?.title == "第三章" }
        try harness.settled()
        guard let third = harness.host.activeChapter, let thirdView = harness.host.activeView else { throw LabError.message("第三章 did not open") }
        try require(thirdView.textView.string.isEmpty && harness.asked == ["主线", "支线"], "支线's chapter did not start empty")
        library = try harness.library(project)
        try require(library.membership(chapterID: third.id)?.primary == side.id, "The panel's chapter did not join 支线")
        // Cancelling the title prompt creates nothing.
        let before = try harness.chapters(project).count
        harness.titles = []
        var cancelledCreate: Result<WorkspaceChapter, Error>?
        harness.host.createChapter(project: project, storyline: main) { cancelledCreate = $0 }
        try wait { cancelledCreate != nil }
        try require(try harness.chapters(project).count == before, "A cancelled title created a chapter")

        // 清空模版 returns new chapters to an empty body.
        try harness.open(project, .storyline(main))
        mark = try journal.mark()
        smallPress(page.templateView.editButton)
        guard let clearing = page.templateSheet else { throw LabError.message("The sheet did not open to clear") }
        smallPress(clearing.clearButton)
        smallPress(clearing.saveButton)
        try wait { page.templateSheet == nil }
        try journal.expect([["field.set storyline"]], since: mark, "清空模版")
        try require(page.template == [] && page.templateView.detail.stringValue == "未设置", "The template was not cleared")
        harness.titles = ["第四章"]
        smallPress(page.chaptersView.createButton)
        try wait { harness.host.activeChapter?.title == "第四章" }
        try harness.settled()
        try require(harness.host.activeView?.textView.string.isEmpty == true, "A chapter after 清空模版 did not start empty")

        // An unknown or trashed storyline refuses before anything is written.
        let trashed: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult {
            harness.workspace.trashStoryline(projectID: project.id, storylineID: side.id, completion: $0)
        }
        harness.host.applyStorylineLibrary(projectID: project.id, library: trashed.library)
        mark = try journal.mark()
        let count = try harness.chapters(project).count
        for storylineID in ["missing", side.id] {
            let refusal = try elementRefused({ (done: @escaping (Result<WorkspaceChapter, Error>) -> Void) in
                harness.workspace.createChapter(projectID: project.id, title: "第五章", storylineID: storylineID, completion: done)
            }, "A chapter in \(storylineID) was created")
            try require(refusal.contains("故事线"), "The refusal does not name the storyline: \(refusal)")
        }
        try journal.expect([], since: mark, "Refused chapters")
        try require(try harness.chapters(project).count == count, "A refused chapter was listed")

        // Cold reopen keeps the chapters, their bodies and the cleared template.
        try harness.relaunch()
        let bodies = try [second, third].map { try harness.prose(project, "chapter", $0.id) }
        try require(bodies == ["开场\n要点：冲突", ""], "Chapter bodies differ after cold reopen: \(bodies)")
        let template: [BookImportBlock] = try elementResult {
            harness.workspace.storylineChapterTemplate(projectID: project.id, storylineID: main.id, completion: $0)
        }
        try require(template == [] && (try harness.chapters(project)).map(\.title) == ["第一章", "第二章", "第三章", "第四章"],
            "The template or chapters differ after cold reopen")
        _ = opening
        try harness.close()
    }

    // MARK: (b) List filters

    private static func smallFilters() throws {
        let harness = try SmallHarness()
        defer { harness.remove() }
        let project = try harness.project("筛选合成项目")
        let written = try harness.chapter(project, "有字", ["海风吹过码头。"])
        let blank = try harness.chapter(project, "空白")
        let later = try harness.chapter(project, "待写")
        let line = try harness.storyline(project, "主线")
        harness.host.chaptersChanged(projectID: project.id)
        // Selecting a project reads its counts, as AppDelegate does.
        harness.host.wordCounts(projectID: project.id, refresh: true)
        try harness.open(project, .storyline(line))
        guard let page = harness.host.activeStorylinePage else { throw LabError.message("The storyline page did not open") }
        let chapters = page.chaptersView
        try wait { chapters.listed.count == 3 && chapters.countsReady }
        try require(chapters.filterControl.label(forSegment: 0) == "全部 3" && chapters.filterControl.label(forSegment: 1) == "已写 1"
            && chapters.filterControl.label(forSegment: 2) == "未起 2", "The chapter filter counts differ")
        smallChoose(chapters.filterControl, 1)
        try require(chapters.filter == "written" && chapters.chapterButtons.count == 1
            && chapters.filtered.map(\.chapter.id) == [written.id], "已写 lists \(chapters.filtered.map(\.chapter.title))")
        try require(harness.settings.listFilter(projectID: project.id, page: "storyline:\(line.id)") == "written"
            && ((try harness.settingsJSON())["listFilters"] as? [String: [String: String]])?[project.id]?["storyline:\(line.id)"] == "written",
            "已写 was not kept in settings.json")
        smallChoose(chapters.filterControl, 2)
        try require(chapters.filtered.map(\.chapter.id) == [blank.id, later.id], "未起 lists \(chapters.filtered.map(\.chapter.title))")
        // Typing in 待写 moves it to 已写.
        let view = try harness.open(project, .chapter(later), in: 0)
        try harness.type(view, "夜里起雾。")
        try harness.open(project, .storyline(line), in: 0)
        try wait { chapters.filtered.map(\.chapter.id) == [blank.id] }
        smallChoose(chapters.filterControl, 1)
        try wait { chapters.filtered.map(\.chapter.id) == [written.id, later.id] }
        // A second view of the page follows the filter.
        let twin: NativeDocumentView = try elementResult { harness.host.split(completion: $0) }
        try harness.settled()
        _ = twin
        guard let twinPage = harness.host.retainedStorylinePage(pane: 1, scope: StorylineScope(projectID: project.id, storylineID: line.id)) else {
            throw LabError.message("The split did not show the storyline page")
        }
        try wait { twinPage.chaptersView.filter == "written" }
        smallChoose(twinPage.chaptersView.filterControl, 0)
        try wait { chapters.filter == "all" && harness.settings.listFilter(projectID: project.id, page: "storyline:\(line.id)") == nil }
        smallChoose(chapters.filterControl, 2)
        let closedTwin: Bool = try elementResult { harness.host.closeSecondPane(completion: $0) }
        try require(closedTwin, "The second pane did not close")

        // A category page lists its 设定 and filters them.
        let workspace = harness.workspace
        let category: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: project.id, name: "人物", completion: $0)
        }
        guard let people = category.result else { throw LabError.message("No category") }
        let blankElement: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: project.id, categoryID: people.id, name: "空人", completion: $0)
        }
        let _: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.setCategoryTemplateFacts(projectID: project.id, categoryID: people.id, facts: [WorkspaceFact(key: "身份", value: "待定")], completion: $0)
        }
        let _: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.setElementTemplate(projectID: project.id, categoryID: people.id,
                                         blocks: [BookImportBlock(kind: .heading, level: 2, text: "外貌", marks: []), .paragraph("待补充")], completion: $0)
        }
        func element(_ name: String) throws -> WorkspaceElement {
            let reply: WorkspaceElementReply<WorkspaceElement> = try elementResult {
                workspace.createElement(projectID: project.id, categoryID: people.id, name: name, completion: $0)
            }
            guard let element = reply.result else { throw LabError.message("\(name) was not created") }
            return element
        }
        let summarized = try element("有简介")
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.updateElement(projectID: project.id, elementID: summarized.id, changes: WorkspaceElementChanges(summary: "港口的守夜人"), completion: $0)
        }
        let faceted = try element("有字段")
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.setElementFacts(projectID: project.id, elementID: faceted.id, facts: [WorkspaceFact(key: "身份", value: "船长")], completion: $0)
        }
        let templated = try element("只有模版")
        let bodied = try element("写了正文")
        let reply: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: project.id, categoryID: people.id, name: "后来写", completion: $0)
        }
        guard let untouched = blankElement.result, let editedLater = reply.result else { throw LabError.message("Elements were not created") }
        harness.host.applyElementLibrary(projectID: project.id, library: reply.library)
        let bodyView = try harness.open(project, .element(bodied), in: 0)
        try harness.type(bodyView, "左手有旧伤。")
        try harness.open(project, .category(people), in: 0)
        guard let categoryPage = harness.host.activeCategoryPage else { throw LabError.message("The category page did not open") }
        let elements = categoryPage.elementsView
        try wait { elements.listed.count == 6 && elements.ready }
        func names(_ entries: [CategoryElementsView.Entry]) -> [String] { entries.map(\.element.name) }
        func entries(_ list: [CategoryElementsView.Entry], filled: Bool) -> [String] { names(list.filter { $0.filled == filled }) }
        let filled = entries(elements.listed, filled: true), unfilled = entries(elements.listed, filled: false)
        try require(Set(filled) == ["有简介", "有字段", "写了正文"] && Set(unfilled) == ["空人", "只有模版", "后来写"],
            "已填写 is \(filled) and 未填写 \(unfilled)")
        try require(try harness.prose(project, "element", templated.id) == "外貌\n待补充", "The templated element's body differs")
        try require(elements.filterControl.label(forSegment: 1) == "已填写 3" && elements.filterControl.label(forSegment: 2) == "未填写 3",
            "The element filter counts differ")
        smallChoose(elements.filterControl, 2)
        try require(Set(names(elements.filtered)) == ["空人", "只有模版", "后来写"] && elements.elementButtons.count == 3,
            "未填写 shows \(names(elements.filtered))")
        try require(harness.settings.listFilter(projectID: project.id, page: "category:\(people.id)") == "unfilled", "未填写 was not kept")
        // Writing 后来写's body moves it to 已填写 once it settles.
        let laterView = try harness.open(project, .element(editedLater), in: 0)
        try harness.type(laterView, "喜欢下棋。")
        try harness.open(project, .category(people), in: 0)
        try wait { Set(names(elements.filtered)) == ["空人", "只有模版"] }
        // A row opens the element in the page's pane.
        guard let button = elements.elementButtons.first(where: { $0.accessibilityIdentifier() == "category-element-\(untouched.id)" }) else {
            throw LabError.message("空人 has no row")
        }
        smallPress(button)
        try wait { harness.host.activeElement?.id == untouched.id }
        try harness.settled()

        // Both filters come back after a cold relaunch.
        try harness.relaunch()
        harness.host.chaptersChanged(projectID: project.id)
        harness.host.storylinesChanged(projectID: project.id)
        harness.host.wordCounts(projectID: project.id, refresh: true)
        try harness.open(project, .storyline(line))
        guard let coldPage = harness.host.activeStorylinePage else { throw LabError.message("The storyline page did not reopen") }
        try wait { coldPage.chaptersView.listed.count == 3 && coldPage.chaptersView.countsReady }
        try require(coldPage.chaptersView.filter == "unwritten" && coldPage.chaptersView.filterControl.selectedSegment == 2
            && coldPage.chaptersView.filtered.map(\.chapter.id) == [blank.id], "未起 did not come back: \(coldPage.chaptersView.filter)")
        try harness.open(project, .category(people))
        guard let coldCategory = harness.host.activeCategoryPage else { throw LabError.message("The category page did not reopen") }
        try wait { coldCategory.elementsView.listed.count == 6 && coldCategory.elementsView.ready }
        try require(coldCategory.elementsView.filter == "unfilled" && Set(names(coldCategory.elementsView.filtered)) == ["空人", "只有模版"],
            "未填写 did not come back")
        try require(harness.errors.isEmpty, "The host reported \(harness.errors)")
        _ = faceted
        try harness.close()
    }

    // MARK: (c) Importing several files or a folder

    private static func smallImport() throws {
        let harness = try SmallHarness()
        defer { harness.remove() }
        let project = try harness.project("导入合成项目")
        let workspace = harness.workspace
        let line = try harness.storyline(project, "主线")
        let category: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: project.id, name: "地点", completion: $0)
        }
        guard let places = category.result else { throw LabError.message("No category") }
        let sources = harness.root.appendingPathComponent("来源", isDirectory: true)
        try FileManager.default.createDirectory(at: sources, withIntermediateDirectories: true)
        func write(_ name: String, _ text: String, in folder: URL? = nil) throws -> URL {
            let url = (folder ?? sources).appendingPathComponent(name)
            try Data(text.utf8).write(to: url)
            return url
        }
        func docx(_ name: String, in folder: URL) throws -> URL {
            let text = NSMutableAttributedString()
            text.append(NSAttributedString(string: "灯塔\n", attributes: [.font: NSFont.boldSystemFont(ofSize: 24)]))
            text.append(NSAttributedString(string: "灯塔在北岸，", attributes: [.font: NSFont.systemFont(ofSize: 12)]))
            text.append(NSAttributedString(string: "夜里", attributes: [.font: NSFont.boldSystemFont(ofSize: 12)]))
            text.append(NSAttributedString(string: "一明一灭。", attributes: [.font: NSFont.systemFont(ofSize: 12)]))
            let url = folder.appendingPathComponent(name)
            try text.data(from: NSRange(location: 0, length: text.length),
                          documentAttributes: [.documentType: NSAttributedString.DocumentType.officeOpenXML]).write(to: url)
            return url
        }
        let second = try write("第2章 雨夜.md", "# 雨夜\n\n她推开**北塔**的门。")
        let tenth = try write("第10章 归航.txt", "船回来了。\n\n灯还亮着。")
        let first = try write("第1章 启程.md", "# 启程\n\n风从海上来。")
        let image = sources.appendingPathComponent("第3章 插图.png")
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: image)
        let empty = try write("第4章 空白.md", "\n\n")
        let transfer = MacBookTransfer(workspace: workspace, host: harness.host)
        var statuses: [String] = []
        var imported: [WorkspaceImportedEntity] = []
        transfer.onStatus = { statuses.append($0) }
        transfer.onImported = { _, entity in imported.append(entity) }
        var chosen: [URL] = [second, tenth, image, empty, first]
        transfer.chooseImportFiles = { _, done in done(chosen) }

        // Several files as chapters in 主线.
        transfer.beginImport(project: project, window: nil)
        guard let sheet = transfer.bulkSheet else { throw LabError.message("Several files showed no sheet: \(statuses)") }
        try require(transfer.importSheet == nil, "Several files opened the single-file sheet")
        // The sheet shows at once; the files are read off the main thread.
        try require(sheet.isReading && sheet.lines.contains { $0.hasSuffix("正在读取…") } && !sheet.importButton.isEnabled,
                    "The files were read before the sheet showed: \(sheet.lines)")
        try wait { !sheet.isReading && sheet.storylinePopup.numberOfItems == 2
            && sheet.categoryPopup.itemArray.contains { $0.representedObject as? String == places.id } }
        try require(sheet.lines == ["第1章 启程.md · Markdown · 2 段", "第2章 雨夜.md · Markdown · 2 段",
                                    "第3章 插图.png · 跳过：不是 Markdown、纯文本或 Word（.docx）文件", "第4章 空白.md · 跳过：“第4章 空白.md”中没有可导入的文字。",
                                    "第10章 归航.txt · 纯文本 · 2 段"],
            "The files are listed as \(sheet.lines)")
        try require(sheet.summary.stringValue.contains("3 个可以导入") && sheet.summary.stringValue.contains("2 个将跳过")
            && !sheet.storylinePopup.isHidden && sheet.categoryPopup.isHidden, "The sheet summary or target differs: \(sheet.summary.stringValue)")
        sheet.select(storylineID: line.id)
        var mark = try harness.journal.mark()
        sheet.importButton.performClick(nil)
        try wait { sheet.finished }
        try require(sheet.lines == ["第1章 启程.md · 已创建「启程」", "第2章 雨夜.md · 已创建「雨夜」",
                                    "第3章 插图.png · 跳过：不是 Markdown、纯文本或 Word（.docx）文件", "第4章 空白.md · 跳过：“第4章 空白.md”中没有可导入的文字。",
                                    "第10章 归航.txt · 已创建「船回来了。」"]
            && sheet.summary.stringValue == "已创建 3 个，跳过 2 个。" && sheet.importButton.title == "完成",
            "The results are \(sheet.lines) / \(sheet.summary.stringValue)")
        let chapters = try harness.chapters(project)
        try require(chapters.map(\.title) == ["启程", "雨夜", "船回来了。"] && imported.count == 3 && harness.host.activeView == nil,
            "Imported chapters differ or a page opened: \(chapters.map(\.title))")
        let library = try harness.library(project)
        try require(chapters.allSatisfy { library.membership(chapterID: $0.id)?.primary == line.id }, "An imported chapter did not join 主线")
        try require(try harness.prose(project, "chapter", chapters[1].id) == "雨夜\n她推开北塔的门。", "The Markdown body differs")
        let originals = try harness.journal.originals(since: mark)
        try require(originals.filter { $0.contains("entity.create node") }.count == 3
            && originals.filter { $0 == ["set.add membership", "field.set node-storyline-primary"] }.count == 3, "Import wrote \(originals)")
        try require(statuses.last == "导入完成：已创建 3 个，跳过 2 个。", "The status says \(statuses.last ?? "")")
        smallPress(sheet.importButton)
        try require(transfer.bulkSheet == nil, "完成 did not close the sheet")

        // A folder: its supported files sorted by name, as 设定 of 地点.
        let folder = sources.appendingPathComponent("地点资料", isDirectory: true)
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("子文件夹"), withIntermediateDirectories: true)
        _ = try write("1 北岸.md", "# 北岸\n\n北岸多雾。", in: folder)
        _ = try write("2 港口.txt", "港口很小。", in: folder)
        _ = try docx("3 灯塔.docx", in: folder)
        _ = try write("说明.pdf", "%PDF", in: folder)
        _ = try write(".隐藏.md", "不导入", in: folder)
        chosen = [folder]
        transfer.beginImport(project: project, window: nil)
        guard let folderSheet = transfer.bulkSheet else { throw LabError.message("A folder showed no sheet: \(statuses)") }
        try wait { !folderSheet.isReading && folderSheet.categoryPopup.itemArray.contains { $0.representedObject as? String == places.id } }
        try require(folderSheet.lines == ["1 北岸.md · Markdown · 2 段", "2 港口.txt · 纯文本 · 1 段", "3 灯塔.docx · Word 文档 · 2 段"]
            && folderSheet.summary.stringValue.contains("另有 2 个其他文件或子文件夹未列出"),
            "The folder is listed as \(folderSheet.lines) / \(folderSheet.summary.stringValue)")
        folderSheet.select(kind: "element")
        folderSheet.select(categoryID: places.id)
        try require(folderSheet.storylinePopup.isHidden && !folderSheet.categoryPopup.isHidden, "设定 did not show 分类")
        // A name already taken is Rust's refusal: 北岸 exists.
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: project.id, categoryID: places.id, name: "北岸", completion: $0)
        }
        mark = try harness.journal.mark()
        folderSheet.importButton.performClick(nil)
        try wait { folderSheet.finished }
        try require(folderSheet.lines[1] == "2 港口.txt · 已创建「港口很小。」" && folderSheet.lines[2] == "3 灯塔.docx · 已创建「3 灯塔」"
            && folderSheet.lines[0].hasPrefix("1 北岸.md · 跳过：") && folderSheet.summary.stringValue == "已创建 2 个，跳过 1 个。",
            "The folder results are \(folderSheet.lines)")
        let elements: WorkspaceElementLibrary = try elementResult { workspace.elementLibrary(projectID: project.id, completion: $0) }
        let created = elements.elements.filter { $0.categoryId == places.id }.map(\.name)
        try require(Set(created) == ["北岸", "港口很小。", "3 灯塔"], "The folder's 设定 are \(created)")
        guard let lighthouse = elements.elements.first(where: { $0.name == "3 灯塔" }) else { throw LabError.message("灯塔 is missing") }
        try require(try harness.prose(project, "element", lighthouse.id) == "灯塔\n灯塔在北岸，夜里一明一灭。", "The Word body differs")
        transfer.endImport()

        // The same folder as 漂流.
        transfer.beginImport(project: project, window: nil)
        guard let driftSheet = transfer.bulkSheet else { throw LabError.message("The folder did not open a second time") }
        try wait { !driftSheet.isReading }
        driftSheet.select(kind: "drift")
        driftSheet.importButton.performClick(nil)
        try wait { driftSheet.finished }
        let drifts: WorkspaceDriftLibrary = try elementResult { workspace.driftLibrary(projectID: project.id, completion: $0) }
        try require(Set(drifts.drifts.map(\.title)) == ["北岸", "港口很小。", "3 灯塔"] && driftSheet.summary.stringValue == "已创建 3 个。",
            "The folder's 漂流 are \(drifts.drifts.map(\.title))")
        transfer.endImport()
        try harness.close()
    }

    // MARK: (d) Exporting every project

    private static func smallExportAll() throws {
        let harness = try SmallHarness()
        defer { harness.remove() }
        let north = try harness.project("北岸")
        _ = try harness.chapter(north, "雨夜", ["雨落在码头。"])
        let south = try harness.project("南港")
        _ = try harness.chapter(south, "归航", ["船回来了。"])
        let twin = try harness.project("北岸")
        let destination = harness.root.appendingPathComponent("导出", isDirectory: true)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let exporter = MacMarkdownFolderExport(workspace: harness.workspace)
        let day = Calendar.current.date(from: DateComponents(year: 2026, month: 9, day: 29, hour: 12))!
        exporter.now = { day }
        exporter.chooseFolder = { _, done in done(destination) }
        var alerts: [NSAlert] = []
        exporter.presentAlert = { alert, done in alerts.append(alert); done(.alertFirstButtonReturn) }
        var revealed: [URL] = []
        exporter.reveal = { revealed.append($0) }
        var statuses: [String] = []
        exporter.onStatus = { statuses.append($0) }
        let mark = try harness.journal.mark()
        let (folder, results) = try elementResult { exporter.beginAll(projects: [north, south, twin], window: nil, completion: $0) }
        try harness.journal.expect([], since: mark, "Exporting every project")
        try require(folder.lastPathComponent == "全部项目-2026-09-29" && folder.deletingLastPathComponent().standardizedFileURL == destination.standardizedFileURL,
            "The outer folder is \(folder.path)")
        try require(results.map { $0.folder?.lastPathComponent ?? "" } == ["北岸-2026-09-29", "南港-2026-09-29", "北岸-2026-09-29-2"]
            && results.allSatisfy { $0.failure == nil }, "The project folders are \(results.map { $0.folder?.lastPathComponent ?? $0.failure ?? "" })")
        for (project, result) in zip([north, south, twin], results) {
            let archive: WorkspaceMarkdownArchive = try elementResult { harness.workspace.exportArchive(projectID: project.id, completion: $0) }
            guard let written = result.folder else { throw LabError.message("\(project.name) has no folder") }
            var files: [String: String] = [:]
            let enumerator = FileManager.default.enumerator(at: written, includingPropertiesForKeys: [.isRegularFileKey])!
            for case let url as URL in enumerator where (try url.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true {
                files[String(url.standardizedFileURL.path.dropFirst(written.standardizedFileURL.path.count + 1))] = try String(contentsOf: url, encoding: .utf8)
            }
            try require(result.files == archive.files.count && Set(files.keys) == Set(archive.files.map(\.path))
                && archive.files.allSatisfy { files[$0.path] == $0.text }, "\(project.name)'s folder differs from its archive")
        }
        let total = results.reduce(0) { $0 + $1.files }
        try require(alerts.count == 1 && alerts[0].messageText == "已导出 3 个项目" && alerts[0].informativeText.contains("共 \(total) 个 Markdown 文件")
            && alerts[0].buttons.first?.title == "在访达中显示" && revealed == [folder]
            && statuses.last == "已导出 3 个项目、共 \(total) 个 Markdown 文件到“全部项目-2026-09-29”。",
            "The report differs: \(alerts.first?.informativeText ?? "") / \(statuses.last ?? "")")
        // The same day again: a numeric suffix, nothing overwritten.
        let (again, _) = try elementResult { exporter.beginAll(projects: [north], window: nil, completion: $0) }
        try require(again.lastPathComponent == "全部项目-2026-09-29-2"
            && (try FileManager.default.contentsOfDirectory(atPath: destination.path)).sorted() == ["全部项目-2026-09-29", "全部项目-2026-09-29-2"],
            "A second export is \(again.lastPathComponent)")
        try harness.journal.expect([], since: mark, "Exporting twice")
        try harness.close()
    }

    // MARK: (e) 段间距, 版心宽度, 打字机位置 and 自动链接设定名称

    private static func smallSettings() throws {
        let harness = try SmallHarness()
        defer { harness.remove() }
        defer { LabSettingsStore.restoreUnconfigured() }
        let store = harness.settings
        store.apply()
        try require(store.settings.paragraphSpacing == 0.7 && store.settings.columnWidth == 760 && store.settings.typewriterPosition == 40
            && store.settings.autoEntityLinks && MacEditorPreferences.columnWidth == 760 && DocumentStore.automaticEntityLinks
            && abs(NativeDocumentView.typewriterPosition - 0.4) < 0.001 && DocumentStyle.typography.paragraphSpacing == 12,
            "The defaults differ")
        let project = try harness.project("设置合成项目")
        let workspace = harness.workspace
        let long = try harness.chapter(project, "长夜", (1...80).map { "第\($0)段：夜色里的港口很安静，灯塔一明一灭，潮水一遍遍拍着石阶。" })
        let hidden = try harness.chapter(project, "隐藏", ["藏在后面的标签。", "第二段。"])
        let pane = SettingsPane(store: store)
        let hiddenView = try harness.open(project, .chapter(hidden), in: 0)
        let view = try harness.open(project, .chapter(long), in: 0)
        harness.window.contentView?.layoutSubtreeIfNeeded()
        func spacing(_ view: NativeDocumentView) -> CGFloat? {
            (view.textView.textStorage?.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)?.paragraphSpacing
        }
        let width = view.textView.enclosingScrollView?.contentView.bounds.width ?? 0
        try require(width > 900 && abs(view.textColumnWidth - 760) <= 1 && abs(view.columnInset - ((width - 760) / 2).rounded(.down)) <= 0.5,
            "The pane editor's column is \(view.textColumnWidth) in \(width)")
        try require(spacing(view) == 12, "The default paragraph spacing is \(spacing(view) ?? -1)")

        // 段间距 1.5: every body, a hidden tab too.
        pane.controller.paragraphSpacingSlider.doubleValue = 1.5
        pane.controller.paragraphSpacingChanged()
        try require(store.settings.paragraphSpacing == 1.5 && pane.controller.paragraphSpacingValue.stringValue == "1.5 倍字号"
            && DocumentStyle.typography.paragraphSpacing == 26 && spacing(view) == 26 && spacing(hiddenView) == 26,
            "段间距 did not reach the editors: \(spacing(view) ?? -1) / \(spacing(hiddenView) ?? -1)")
        // 版心宽度 600: a centred column; a narrow pane keeps its margins.
        pane.controller.columnWidthSlider.doubleValue = 604
        pane.controller.columnWidthChanged()
        harness.window.contentView?.layoutSubtreeIfNeeded()
        try require(store.settings.columnWidth == 600 && pane.controller.columnWidthValue.stringValue == "600 pt"
            && abs(view.textColumnWidth - 600) <= 1 && view.textView.textContainerOrigin.x == view.columnInset,
            "版心宽度 did not centre the column: \(view.textColumnWidth), inset \(view.columnInset)")
        harness.window.setContentSize(NSSize(width: 560, height: 760))
        harness.window.contentView?.layoutSubtreeIfNeeded()
        try wait { view.columnInset == 20 }
        try require(abs(view.textColumnWidth - ((view.textView.enclosingScrollView?.contentView.bounds.width ?? 0) - 40)) <= 1,
            "A narrow pane lost its margins: \(view.textColumnWidth) text \(view.textView.bounds.width) clip \(view.textView.enclosingScrollView?.contentView.bounds.width ?? 0) inset \(view.textView.textContainerInset)")
        harness.window.setContentSize(NSSize(width: 1200, height: 760))
        harness.window.contentView?.layoutSubtreeIfNeeded()
        try wait { abs(view.textColumnWidth - 600) <= 1 }

        // The 全书长卷 follows both at once.
        let model = WholeBookModel(workspace: workspace, projectID: project.id)
        let book = MacWholeBookViewController(project: project, model: model, workspace: workspace, host: harness.host)
        let bookWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 700), styleMask: [.titled, .resizable],
                                  backing: .buffered, defer: false)
        bookWindow.isReleasedWhenClosed = false
        defer { bookWindow.close() }
        bookWindow.contentViewController = book
        bookWindow.setContentSize(NSSize(width: 1000, height: 700))
        book.view.layoutSubtreeIfNeeded()
        harness.host.wordCounts(projectID: project.id)
        model.load()
        try wait { model.loaded && book.isSettled && harness.host.canNavigate }
        book.documentView.layoutSubtreeIfNeeded()
        try require(book.frame(ofChapter: long.id)?.width == 600, "The 全书长卷's column is \(book.frame(ofChapter: long.id)?.width ?? 0)")
        guard let bookEditor = book.chapterRow(long.id)?.editor else { throw LabError.message("The 全书长卷 attached no editor") }
        try require(spacing(bookEditor) == 26 && bookEditor.columnInset == 20, "The 全书长卷's editor differs")
        pane.controller.columnWidthSlider.doubleValue = 700
        pane.controller.columnWidthChanged()
        try wait { book.frame(ofChapter: long.id)?.width == 700 && book.isSettled }
        pane.controller.paragraphSpacingSlider.doubleValue = 0.5
        pane.controller.paragraphSpacingChanged()
        try wait { spacing(bookEditor) == 9 && spacing(view) == 9 }
        try require(book.shutdown(), "The 全书长卷 did not shut down")
        try wait { book.isShutDown }

        // 打字机位置 60%: the caret line settles there after typing.
        pane.controller.typewriterCheckbox.state = .on
        pane.controller.typewriterChanged()
        try require(pane.controller.typewriterPositionSlider.isEnabled, "打字机位置 stayed disabled with 打字机滚动 on")
        pane.controller.typewriterPositionSlider.doubleValue = 60
        pane.controller.typewriterPositionChanged()
        try require(store.settings.typewriterPosition == 60 && abs(NativeDocumentView.typewriterPosition - 0.6) < 0.001
            && pane.controller.typewriterPositionValue.stringValue == "60%", "打字机位置 was not applied")
        guard let scroll = view.textView.enclosingScrollView else { throw LabError.message("The prose does not scroll") }
        try require(abs(view.typewriterTail - ceil(scroll.contentView.bounds.height * 0.4)) <= 1,
            "The room below the text is \(view.typewriterTail) for 60%")
        func line(_ context: String, _ expected: CGFloat) throws {
            try wait { !view.hasScheduledTypewriterAlignment }
            guard let position = view.caretLinePosition else { throw LabError.message("\(context): the caret line was not measured") }
            try require(abs(position - expected) < 0.02, "\(context): the caret line sits at \(position)")
        }
        try harness.type(view, "尾")
        try line("Typing at the end with 60%", 0.6)
        let middle = NSMaxRange((view.textView.string as NSString).range(of: "第40段"))
        try harness.type(view, "中", at: middle)
        try line("Typing in the middle with 60%", 0.6)
        pane.controller.typewriterPositionSlider.doubleValue = 30
        pane.controller.typewriterPositionChanged()
        try harness.type(view, "再", at: middle + 1)
        try line("Typing with 30%", 0.3)

        // 自动链接设定名称: off adds no new links, existing ones stay.
        let category: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: project.id, name: "人物", completion: $0)
        }
        let kai: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: project.id, categoryID: category.result!.id, name: "林凯", completion: $0)
        }
        harness.host.applyElementLibrary(projectID: project.id, library: kai.library)
        try wait { harness.host.linkDirectory(projectID: project.id)?.elements[kai.result!.id] != nil }
        try harness.settled()
        let linked = (view.textView.string as NSString).length
        try harness.type(view, "林凯到了。")
        try wait { view.linkTargets(at: linked).first?.id == kai.result!.id }
        let waiting = (view.textView.string as NSString).length
        try harness.type(view, "周策在等。")
        pane.controller.autoLinkCheckbox.state = .off
        pane.controller.autoLinkChanged()
        try require(!store.settings.autoEntityLinks && !DocumentStore.automaticEntityLinks, "自动链接设定名称 was not switched off")
        let unlinked = (view.textView.string as NSString).length
        let mark = try harness.journal.mark()
        try harness.type(view, "林凯又来了。")
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        try harness.settled()
        try require(view.linkTargets(at: unlinked).isEmpty && view.linkTargets(at: linked).first?.id == kai.result!.id,
            "Typing linked a name with linking off, or an existing link was lost")
        try harness.journal.expect([["yjs.update prose-document"]], since: mark, "Typing with linking off")
        // A new element's name is not linked retroactively either.
        let ce: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: project.id, categoryID: category.result!.id, name: "周策", completion: $0)
        }
        harness.host.applyElementLibrary(projectID: project.id, library: ce.library)
        try wait { harness.host.linkDirectory(projectID: project.id)?.elements[ce.result!.id] != nil }
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        try harness.settled()
        try require(view.linkTargets(at: waiting).isEmpty && !view.binding.store.hasScheduledLinks, "A retroactive pass linked with linking off")
        pane.controller.autoLinkCheckbox.state = .on
        pane.controller.autoLinkChanged()
        try harness.type(view, "。")
        try wait { view.linkTargets(at: unlinked).first?.id == kai.result!.id && view.linkTargets(at: waiting).first?.id == ce.result!.id }

        // settings.json keeps them; a cold store reads them back.
        let json = try harness.settingsJSON()
        try require(json["paragraphSpacing"] as? Double == 0.5 && json["columnWidth"] as? Double == 700
            && json["typewriterPosition"] as? Double == 30 && json["autoEntityLinks"] as? Bool == true,
            "settings.json holds \(json.filter { ["paragraphSpacing", "columnWidth", "typewriterPosition", "autoEntityLinks"].contains($0.key) })")
        let reread = LabSettingsStore(directory: harness.root).settings
        try require(reread.paragraphSpacing == 0.5 && reread.columnWidth == 700 && reread.typewriterPosition == 30 && reread.autoEntityLinks,
            "A cold settings store read other values")
        // Out-of-range values are clamped on read.
        var edited = json
        edited["paragraphSpacing"] = 9; edited["columnWidth"] = 100; edited["typewriterPosition"] = "中"; edited["autoEntityLinks"] = "否"
        try JSONSerialization.data(withJSONObject: edited).write(to: store.fileURL)
        let clamped = LabSettingsStore(directory: harness.root).settings
        try require(clamped.paragraphSpacing == 2.5 && clamped.columnWidth == 480 && clamped.typewriterPosition == 40 && clamped.autoEntityLinks,
            "Hand-edited values were not clamped: \(clamped.paragraphSpacing) \(clamped.columnWidth) \(clamped.typewriterPosition)")
        pane.window.close()
        try harness.close()
    }

    /// 设置's 编辑器 pane, loaded as the window loads it.
    private final class SettingsPane {
        let window: MacSettingsWindowController
        var controller: MacEditorSettingsViewController { window.editorPane }
        init(store: LabSettingsStore) {
            window = MacSettingsWindowController(store: store)
            _ = window.editorPane.view
            window.editorPane.refresh()
        }
    }

    // MARK: (f) The 全书长卷's reading position

    private static func smallWholeBookPosition() throws {
        let harness = try SmallHarness()
        defer { harness.remove() }
        let first = try harness.project("长卷甲")
        let other = try harness.project("长卷乙")
        let chapters = try (1...24).map { number in
            try harness.chapter(first, "长卷章节 \(number)", (1...6).map { "第\(number)章第\($0)段：潮水涨上来，又退下去，港口的灯一盏盏亮起。" })
        }
        let others = try (1...4).map { try harness.chapter(other, "乙章 \($0)", ["乙的正文。"]) }

        func openBook(_ project: WorkspaceProject) throws -> (MacWholeBookViewController, NSWindow) {
            let model = WholeBookModel(workspace: harness.workspace, projectID: project.id)
            let book = MacWholeBookViewController(project: project, model: model, workspace: harness.workspace, host: harness.host)
            // As AppDelegate.openWholeBook wires it.
            let settings = harness.settings
            book.initialPosition = settings.wholeBookPosition(projectID: project.id)
            book.onPosition = { settings.setWholeBookPosition($0, projectID: project.id) }
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 640), styleMask: [.titled, .resizable],
                                  backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentViewController = book
            window.setContentSize(NSSize(width: 900, height: 640))
            book.view.layoutSubtreeIfNeeded()
            harness.host.wordCounts(projectID: project.id)
            model.load()
            try wait { model.loaded && book.isSettled && harness.host.canNavigate }
            book.documentView.layoutSubtreeIfNeeded()
            return (book, window)
        }
        func close(_ book: MacWholeBookViewController, _ window: NSWindow) throws {
            try require(book.shutdown(), "The 全书长卷 did not shut down")
            try wait { book.isShutDown }
            window.close()
        }
        func top(_ book: MacWholeBookViewController) -> CGFloat { book.scrollView.contentView.bounds.minY }

        // A new book opens at the top; scrolling reports the row and offset.
        var (book, window) = try openBook(first)
        try require(top(book) == 0 && harness.settings.wholeBookPosition(projectID: first.id) == nil, "A new book did not open at the top")
        book.scroll(toChapter: chapters[15].id)
        try wait { book.isSettled }
        guard let frame = book.frame(ofChapter: chapters[15].id) else { throw LabError.message("Chapter 16 has no row") }
        book.scrollDocument(toY: frame.minY + 120)
        try wait {
            harness.settings.wholeBookPosition(projectID: first.id).map { $0.row == "chapter:\(chapters[15].id)" && abs($0.offset - 120) <= 1 } == true
                && book.isSettled
        }
        guard let position = harness.settings.wholeBookPosition(projectID: first.id) else { throw LabError.message("No position was kept") }
        try require(abs(position.offset - 120) <= 1, "The offset kept is \(position.offset)")
        let json = try harness.settingsJSON()
        try require(((json["wholeBookPositions"] as? [String: [String: Any]])?[first.id]?["row"] as? String) == "chapter:\(chapters[15].id)",
            "settings.json does not hold the position")
        // Closing reports the latest position without waiting.
        MacWholeBookViewController.positionDelay = 30
        book.scroll(toChapter: chapters[9].id)
        try close(book, window)
        try require(harness.settings.wholeBookPosition(projectID: first.id)?.row == "chapter:\(chapters[9].id)", "Closing did not keep the position")
        MacWholeBookViewController.positionDelay = 0.05
        (book, window) = try openBook(first)
        book.scroll(toChapter: chapters[15].id)
        try wait { book.isSettled }
        if let row = book.frame(ofChapter: chapters[15].id) { book.scrollDocument(toY: row.minY + 120) }
        try wait {
            harness.settings.wholeBookPosition(projectID: first.id).map { $0.row == "chapter:\(chapters[15].id)" && abs($0.offset - 120) <= 1 } == true
                && book.isSettled
        }
        try close(book, window)

        // Another project keeps its own position.
        var (otherBook, otherWindow) = try openBook(other)
        try require(top(otherBook) == 0, "The other project's book did not open at the top")
        otherBook.scroll(toChapter: others[2].id)
        try wait { harness.settings.wholeBookPosition(projectID: other.id)?.row == "chapter:\(others[2].id)" }
        try close(otherBook, otherWindow)

        // A cold relaunch opens each book where it was read.
        try harness.relaunch()
        (book, window) = try openBook(first)
        guard let reopened = book.frame(ofChapter: chapters[15].id) else { throw LabError.message("Chapter 16 has no row after relaunch") }
        try require(abs(top(book) - (reopened.minY + 120)) <= 2 && book.readingPosition?.row == "chapter:\(chapters[15].id)"
            && book.chapterRow(chapters[15].id)?.isAttached == true,
            "The book reopened at \(top(book)) instead of \(reopened.minY + 120)")
        try close(book, window)
        (otherBook, otherWindow) = try openBook(other)
        try require(otherBook.readingPosition?.row == "chapter:\(others[2].id)", "The other project's position was lost")
        try close(otherBook, otherWindow)

        // A position whose chapter left the book opens at the top.
        let _: [WorkspaceChapter] = try elementResult { done in
            harness.host.trash(projectID: first.id, chapterID: chapters[15].id) { result in done(result.map(\.chapters)) }
        }
        (book, window) = try openBook(first)
        try require(top(book) == 0, "A trashed chapter's position did not open at the top: \(top(book))")
        try close(book, window)
        try harness.close()
    }

    // MARK: (g) 历史版本 preview with formatting

    private static func smallHistoryPreview() throws {
        let harness = try SmallHarness()
        defer { harness.remove() }
        let project = try harness.project("历史格式合成项目")
        let workspace = harness.workspace
        let blocks = [BookImportBlock(kind: .heading, level: 1, text: "北塔", marks: []),
                      BookImportBlock(kind: .paragraph, level: nil, text: "粗体与斜体。", marks: [BookImportMark(kind: .bold, location: 0, length: 2),
                                                                                           BookImportMark(kind: .italic, location: 3, length: 2)]),
                      .paragraph("下划线和删除线。"), .paragraph("居中的一段。"), .paragraph("缩进的一段。"), .paragraph("网址链接在这里。")]
        let imported: WorkspaceImportedEntity = try elementResult {
            workspace.importBlocks(projectID: project.id, title: "北塔", target: .chapter, blocks: blocks, completion: $0)
        }
        guard case .chapter(let chapter) = imported else { throw LabError.message("北塔 was not imported") }
        let other = try harness.chapter(project, "别章", ["别章正文。"])
        let view = try harness.open(project, .chapter(chapter), in: 0)
        let text = view.textView.string as NSString
        func format(_ action: NativeFormatAction, _ phrase: String, length: Int? = nil) throws {
            let range = text.range(of: phrase)
            view.binding.format(action, range: NSRange(location: range.location, length: length ?? range.length))
            try harness.settled()
        }
        try format(.underline, "下划线")
        try format(.strike, "删除线")
        try format(.alignCenter, "居中的一段", length: 0)
        try format(.indentIncrease, "缩进的一段", length: 0)
        var linked: Error?
        var linkDone = false
        view.binding.link(range: text.range(of: "网址链接"), href: "https://example.invalid/north") { linked = $0; linkDone = true }
        try wait { linkDone }
        try require(linked == nil, "The URL link was refused: \(linked?.localizedDescription ?? "")")
        try harness.settled()
        // Closing captures this version; then the body changes.
        let closed: Bool = try elementResult { harness.host.closeTab(pane: 0, scope: .chapter(ChapterScope(projectID: project.id, chapterID: chapter.id)), completion: $0) }
        try require(closed, "The chapter did not close")
        let edited = try harness.open(project, .chapter(chapter), in: 0)
        let removedRange = (edited.textView.string as NSString).range(of: "与斜体")
        edited.textView.insertText("", replacementRange: removedRange)
        try harness.settled()
        try harness.type(edited, "新加的一句。")
        let target = VersionHistoryTarget(projectID: project.id, kind: "chapter", id: chapter.id, title: chapter.title)
        let model = VersionHistoryModel(workspace: workspace, target: target)
        let sheet = VersionHistorySheet(model: model)
        sheet.begin(in: nil)
        model.load()
        try wait { model.loaded && !model.busy }
        guard let version = model.entries.first(where: { $0.text.contains("粗体与斜体。") }) else {
            throw LabError.message("No version with the formatted text: \(model.entries.map(\.text))")
        }
        sheet.select(entryID: version.id)
        try wait { model.preview(of: version) != nil }
        sheet.reload()
        guard let storage = sheet.previewView.textStorage else { throw LabError.message("The preview has no storage") }
        let shown = storage.string as NSString
        func attributes(_ phrase: String) throws -> [NSAttributedString.Key: Any] {
            let range = shown.range(of: phrase)
            try require(range.location != NSNotFound, "The preview lacks “\(phrase)”: \(shown)")
            return storage.attributes(at: range.location, effectiveRange: nil)
        }
        func traits(_ phrase: String) throws -> NSFontTraitMask {
            guard let font = try attributes(phrase)[.font] as? NSFont else { throw LabError.message("“\(phrase)” has no font") }
            return NSFontManager.shared.traits(of: font)
        }
        let heading = try attributes("北塔")[.font] as? NSFont
        try require((heading?.pointSize ?? 0) > DocumentStyle.typography.size + 4, "The heading is not set as a heading")
        try require(try traits("粗体").contains(.boldFontMask) && !(try traits("与")).contains(.boldFontMask)
            && (try traits("斜体")).contains(.italicFontMask),
            "Bold or italic did not reach the preview: \(try attributes("粗体")[.font] ?? "") / \(try attributes("斜体")[.font] ?? "") / \(model.preview(of: version).map { $0.blocks.map { $0.runs.map { "\($0.range.location)+\($0.range.length) b\($0.attributes.bold) i\($0.attributes.italic)" } } } ?? [])")
        try require(try attributes("下划线")[.underlineStyle] as? Int == NSUnderlineStyle.single.rawValue
            && (try attributes("删除线")[.strikethroughStyle] as? Int) == NSUnderlineStyle.single.rawValue
            && (try attributes("删除线")[.strikethroughColor]) == nil,
            "Underline or strike did not reach the preview")
        try require((try attributes("网址链接")[.underlineStyle] as? Int) == NSUnderlineStyle.single.rawValue
            && (try attributes("网址链接")[.foregroundColor] as? NSColor) == NSColor.linkColor, "The URL link is not styled")
        let centred = try attributes("居中的一段")[.paragraphStyle] as? NSParagraphStyle
        let indented = try attributes("缩进的一段")[.paragraphStyle] as? NSParagraphStyle
        try require(centred?.alignment == .center && (indented?.headIndent ?? 0) >= DocumentStyle.typography.size * 2 - 0.5,
            "Alignment or indent did not reach the preview")
        // The diff marks stay: 与斜体 is the version's (green), the new sentence is struck.
        let added = try attributes("与斜体")
        let removed = try attributes("新加的一句")
        try require((added[.backgroundColor] as? NSColor) == NSColor.systemGreen.withAlphaComponent(0.22)
            && (try traits("斜体")).contains(.italicFontMask), "Text the current body lacks is not on a green wash with its format")
        try require((removed[.strikethroughStyle] as? Int) == NSUnderlineStyle.single.rawValue
            && (removed[.strikethroughColor] as? NSColor) == NSColor.systemRed, "Text the version lacks is not struck through")
        try require(sheet.legend.stringValue.hasPrefix("绿色底"), "The legend differs: \(sheet.legend.stringValue)")
        // Without marks the formatted version reads alone.
        sheet.diffCheckbox.state = .off
        sheet.diffCheckbox.sendAction(sheet.diffCheckbox.action, to: sheet.diffCheckbox.target)
        try require(sheet.previewView.string == model.preview(of: version)?.text && !sheet.previewView.string.contains("新加的一句")
            && ((sheet.previewView.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize ?? 0) > DocumentStyle.typography.size + 4,
            "Turning the marks off did not show the formatted version")
        // Another body's version is refused.
        let refusal = try elementRefused({ (done: @escaping (Result<NativeProjection, Error>) -> Void) in
            workspace.versionPreview(projectID: project.id,
                                     target: VersionHistoryTarget(projectID: project.id, kind: "chapter", id: other.id, title: other.title),
                                     snapshotID: version.id, completion: done)
        }, "Another body's version was previewed")
        try require(refusal.contains("不属于"), "The refusal says \(refusal)")
        sheet.close()
        try harness.close()
    }

    // MARK: Review fixes of the import sheets

    private static func smallImportFixes() throws {
        let harness = try SmallHarness()
        defer { harness.remove() }
        let project = try harness.project("导入修正合成项目")
        let workspace = harness.workspace
        let doomed = try harness.storyline(project, "将删的线")
        let sources = harness.root.appendingPathComponent("来源", isDirectory: true)
        try FileManager.default.createDirectory(at: sources, withIntermediateDirectories: true)
        func write(_ name: String, _ text: String) throws -> URL {
            let url = sources.appendingPathComponent(name)
            try Data(text.utf8).write(to: url)
            return url
        }
        let one = try write("一 起风.md", "起风了。")
        let two = try write("二 落雨.md", "落雨了。")
        let three = try write("三 天晴.md", "天晴了。")
        // A file above 200 MB: sparse, so the disk is not filled.
        let huge = sources.appendingPathComponent("四 巨大.md")
        FileManager.default.createFile(atPath: huge.path, contents: Data("大".utf8))
        let handle = try FileHandle(forWritingTo: huge)
        try handle.truncate(atOffset: UInt64(200 * 1024 * 1024 + 1))
        try handle.close()
        let transfer = MacBookTransfer(workspace: workspace, host: harness.host)
        var statuses: [String] = []
        transfer.onStatus = { statuses.append($0) }
        var chosen: [URL] = []
        transfer.chooseImportFiles = { _, done in done(chosen) }
        func chapterCount() throws -> Int { try harness.chapters(project).count }

        // 取消 while the files are read closes the sheet; reading stops.
        chosen = [one, two, three]
        transfer.beginImport(project: project, window: nil)
        guard let reading = transfer.bulkSheet else { throw LabError.message("No bulk sheet") }
        try require(reading.isReading, "The sheet did not show before reading")
        smallPress(reading.cancelButton)
        try require(transfer.bulkSheet == nil && reading.isClosed, "取消 while reading did not close the sheet")
        let until = Date().addingTimeInterval(0.3)
        while Date() < until { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
        try require(reading.lines.allSatisfy { $0.hasSuffix("正在读取…") }, "Reading went on after 取消: \(reading.lines)")

        // A 故事线 trashed after it was chosen: the chapters are created and
        // their lines, the summary and the status say the join failed. While
        // the import runs, late library replies and a second Return change
        // nothing.
        chosen = [one, two, huge]
        transfer.beginImport(project: project, window: nil)
        guard let sheet = transfer.bulkSheet else { throw LabError.message("No bulk sheet") }
        try wait { !sheet.isReading && sheet.storylinePopup.numberOfItems == 2 }
        try require(sheet.lines[2] == "四 巨大.md · 跳过：文件超过 200 MB，未读取", "The huge file reads \(sheet.lines[2])")
        sheet.select(storylineID: doomed.id)
        let _: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult {
            workspace.trashStoryline(projectID: project.id, storylineID: doomed.id, completion: $0)
        }
        let before = try chapterCount()
        smallPress(sheet.importButton)
        try require(sheet.importing && !sheet.importButton.isEnabled && !sheet.targetPopup.isEnabled, "导入 stayed enabled while importing")
        sheet.setStorylines([]); sheet.setCategories([])
        try require(!sheet.importButton.isEnabled && !sheet.storylinePopup.isEnabled && !sheet.targetPopup.isEnabled,
                    "A late library reply enabled 导入")
        sheet.confirm()
        try wait { sheet.finished }
        try require(try chapterCount() == before + 2, "The files were imported \(try chapterCount() - before) times")
        try require(sheet.lines[0].hasPrefix("一 起风.md · 已创建「起风了。」，但未能加入故事线：") && sheet.lines[1].contains("但未能加入故事线")
                    && sheet.summary.stringValue == "已创建 2 个（其中 2 个未能加入故事线），跳过 1 个。"
                    && statuses.last == "导入完成：已创建 2 个（其中 2 个未能加入故事线），跳过 1 个。",
                    "The join failure reads \(sheet.lines) / \(sheet.summary.stringValue) / \(statuses.last ?? "")")
        smallPress(sheet.importButton)

        // 取消 during the import stops before the next file.
        chosen = [one, two, three]
        transfer.beginImport(project: project, window: nil)
        guard let stopping = transfer.bulkSheet else { throw LabError.message("No bulk sheet") }
        try wait { !stopping.isReading }
        let beforeStop = try chapterCount()
        smallPress(stopping.importButton)
        smallPress(stopping.cancelButton)
        try require(stopping.stopRequested && transfer.bulkSheet === stopping, "取消 during the import closed the sheet")
        try wait { stopping.finished }
        try require(try chapterCount() == beforeStop + 1 && stopping.lines[0].contains("已创建")
                    && stopping.lines.dropFirst().allSatisfy { $0.hasSuffix("跳过：已取消") } && stopping.summary.stringValue.contains("导入已取消")
                    && statuses.last?.hasPrefix("导入已停止：") == true,
                    "取消 did not stop the import: \(stopping.lines) / \(statuses.last ?? "")")
        smallPress(stopping.importButton)

        // The single-file sheet: the same guard, and the failed join in its final status.
        let line = try harness.storyline(project, "另一条将删的线")
        transfer.chooseImportFiles = nil
        transfer.chooseImportFile = { _, done in done(three) }
        transfer.beginImport(project: project, window: nil)
        guard let single = transfer.importSheet else { throw LabError.message("No single-file sheet") }
        try wait { single.storylinePopup.itemArray.contains { $0.representedObject as? String == line.id } }
        single.select(storylineID: line.id)
        let _: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult {
            workspace.trashStoryline(projectID: project.id, storylineID: line.id, completion: $0)
        }
        let beforeSingle = try chapterCount()
        smallPress(single.importButton)
        try require(single.importing && !single.importButton.isEnabled, "The single-file 导入 stayed enabled")
        single.setCategories([]); single.setStorylines([])
        try require(!single.importButton.isEnabled && !single.targetPopup.isEnabled, "A late reply enabled the single-file 导入")
        single.confirm()
        try wait { transfer.importSheet == nil && harness.host.activeChapter?.title == "天晴了。" }
        try wait { statuses.last?.contains("已导入“天晴了。”") == true }
        try require(try chapterCount() == beforeSingle + 1 && statuses.last?.contains("但未能加入故事线") == true,
                    "The single file imported \(try chapterCount() - beforeSingle) times: \(statuses.last ?? "")")
        try harness.close()
    }

    // MARK: Review fixes of the list filters

    private static func smallListFixes() throws {
        let harness = try SmallHarness()
        defer { harness.remove() }
        let project = try harness.project("筛选修正合成项目")
        let workspace = harness.workspace
        let host = harness.host

        // A chapter still exactly its storyline's 章节模版 is 未起.
        let line = try harness.storyline(project, "主线")
        let _: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult {
            workspace.setStorylineChapterTemplate(projectID: project.id, storylineID: line.id,
                                                  blocks: [.paragraph("开场。"), .paragraph("冲突：")], completion: $0)
        }
        let fromTemplate: WorkspaceChapter = try elementResult {
            workspace.createChapter(projectID: project.id, title: "照模版", storylineID: line.id, completion: $0)
        }
        let short: WorkspaceChapter = try elementResult {
            workspace.createChapter(projectID: project.id, title: "短章", storylineID: line.id, completion: $0)
        }
        let long: WorkspaceChapter = try elementResult {
            workspace.createChapter(projectID: project.id, title: "长章", storylineID: line.id, completion: $0)
        }
        host.chaptersChanged(projectID: project.id)
        let shortView = try harness.open(project, .chapter(short))
        shortView.textView.selectAll(nil)
        shortView.textView.insertText("海风。", replacementRange: NSRange(location: 0, length: (shortView.textView.string as NSString).length))
        try harness.settled()
        let longView = try harness.open(project, .chapter(long))
        try harness.type(longView, "港口起了很大的雾，船都停着。")
        host.wordCounts(projectID: project.id, refresh: true)
        try wait {
            let counts = host.wordCountLibrary(projectID: project.id)
            return counts?.count(nodeID: fromTemplate.id) == 4 && counts?.count(nodeID: short.id) == 2 && (counts?.count(nodeID: long.id) ?? 0) > 4
        }
        try harness.open(project, .storyline(line))
        guard let page = host.activeStorylinePage else { throw LabError.message("The storyline page did not open") }
        let chapters = page.chaptersView
        try wait { chapters.listed.count == 3 && chapters.countsReady }
        func entry(_ id: String) -> StorylineChaptersView.Entry? { chapters.listed.first { $0.chapter.id == id } }
        try require(entry(fromTemplate.id)?.atTemplate == true && entry(fromTemplate.id)?.written == false
                    && (entry(fromTemplate.id)?.words ?? 0) > 0 && entry(short.id)?.written == true && entry(long.id)?.written == true,
                    "The template chapter is not 未起: \(chapters.listed.map { ($0.chapter.title, $0.words ?? -1, String(describing: $0.atTemplate)) })")
        try require(chapters.filterControl.label(forSegment: 1) == "已写 2" && chapters.filterControl.label(forSegment: 2) == "未起 1",
                    "The filter counts differ: \(chapters.filterControl.label(forSegment: 1) ?? "")")
        try require(chapters.chapterButtons.first { $0.accessibilityIdentifier() == "storyline-chapter-\(fromTemplate.id)" }?.title.hasSuffix("未起") == true,
                    "The template chapter's row does not read 未起")
        // Only the chapters no longer than the template were read.
        try require(host.templateBodyReads == 2, "\(host.templateBodyReads) chapter bodies were read")
        // Writing in it makes it 已写.
        let templated = try harness.open(project, .chapter(fromTemplate))
        try harness.type(templated, "她推开门。")
        host.wordCounts(projectID: project.id, refresh: true)
        try harness.open(project, .storyline(line))
        try wait { entry(fromTemplate.id)?.written == true && chapters.filterControl.label(forSegment: 1) == "已写 3" }

        // A category page with many 设定.
        let category: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: project.id, name: "地点", completion: $0)
        }
        guard let places = category.result else { throw LabError.message("No category") }
        var library = category.library
        var elements: [WorkspaceElement] = []
        for index in 1...24 {
            let reply: WorkspaceElementReply<WorkspaceElement> = try elementResult {
                workspace.createElement(projectID: project.id, categoryID: places.id, name: "地点\(index)", completion: $0)
            }
            if let element = reply.result { elements.append(element) }
            library = reply.library
        }
        host.applyElementLibrary(projectID: project.id, library: library)
        try harness.open(project, .category(places))
        guard let categoryPage = host.activeCategoryPage else { throw LabError.message("The category page did not open") }
        let listed = categoryPage.elementsView
        try wait { listed.listed.count == 24 && listed.ready }
        let sweeps = host.elementBodySweeps, reads = host.elementBodyReads
        try require(reads >= 24, "Opening the page read \(reads) bodies")
        // A rename is a library reply without new 设定: the list shows the new
        // name at once and no body is read.
        let renamed: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.updateElement(projectID: project.id, elementID: elements[0].id, changes: WorkspaceElementChanges(name: "改名的地点"), completion: $0)
        }
        host.applyElementLibrary(projectID: project.id, library: renamed.library)
        try require(listed.listed.contains { $0.element.name == "改名的地点" } && !listed.listed.contains { $0.element.name == "地点1" },
                    "The 设定 list shows the old library: \(listed.listed.map(\.element.name).prefix(3))")
        let pause = Date().addingTimeInterval(0.3)
        while Date() < pause { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
        try require(host.elementBodySweeps == sweeps && host.elementBodyReads == reads, "A rename read bodies again")
        // A body save reads only that body.
        let body = try harness.open(project, .element(elements[1]))
        try harness.type(body, "东边的码头。")
        try harness.open(project, .category(places))
        try wait { host.elementBodyReads == reads + 1 && listed.listed.first { $0.element.id == elements[1].id }?.filled == true }
        try require(host.elementBodySweeps == sweeps, "A body save swept every body")
        // A new 设定 reads only its own body.
        let added: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: project.id, categoryID: places.id, name: "新地点", completion: $0)
        }
        host.applyElementLibrary(projectID: project.id, library: added.library)
        try wait { host.elementBodyReads == reads + 2 && listed.listed.count == 25 && listed.ready }
        // A newer sweep stops an older chain: the page opened in the other
        // pane sweeps all 25, and a new 设定 arriving meanwhile takes over.
        let later: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: project.id, categoryID: places.id, name: "更新的地点", completion: $0)
        }
        let beforeSplit = (host.elementBodySweeps, host.elementBodyReads)
        let _: NativeDocumentView = try elementResult { host.split(completion: $0) }
        while host.elementBodySweeps == beforeSplit.0 { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.001)) }
        // The newer sweep starts at the next turn, while the older one reads.
        let delay = MacChapterWorkspace.elementBodyDelay
        MacChapterWorkspace.elementBodyDelay = 0
        defer { MacChapterWorkspace.elementBodyDelay = delay }
        host.applyElementLibrary(projectID: project.id, library: later.library)
        try wait { host.elementBodySweeps == beforeSplit.0 + 2 && listed.listed.count == 26 && listed.ready }
        let settle = Date().addingTimeInterval(0.3)
        while Date() < settle { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
        try require(host.elementBodyReads - beforeSplit.1 < 25 + 1, "The older sweep went on: \(host.elementBodyReads - beforeSplit.1) reads")
        try harness.close()
    }
}
