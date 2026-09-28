import AppKit

/// 回收站, 彻底删除, the 项目书架, 导出为 Markdown 文件夹 and the 诊断摘要 through
/// the real AppKit controllers, the tab host, the Rust workspace and SQLite,
/// wired as AppDelegate wires them. Alerts, panels and pasteboards are
/// answered here without windows on screen; every title, body and file is
/// synthetic.
extension BindingAcceptance {
    static func trashShelfAcceptance() throws -> [String] {
        let saved = (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay)
        defer { (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay) = saved }
        DocumentStore.entityLinkDelay = 0.05
        MacChapterWorkspace.backlinkDelay = 0.05
        try trashListsFiltersAndRestores()
        try trashPurgesAndEmpties()
        try trashKeepsUnknownKinds()
        try shelfListsOpensCreatesRenamesAndDeletes()
        try markdownFolderExport()
        try diagnosticSummary()
        return [
            "AppKit 回收站 lists trashed chapters, drifts, elements, categories and storylines from workspaceTrash newest first by their own trash time (a category above an element of it trashed earlier) with kind, title and time, filters by kind, follows a trash made elsewhere, 恢复 each kind with one original through its restore command while the 设定库, 漂流, 故事线 and chapter trash lists follow and nothing opens, and a failed read turns 清空回收站 off naming the kinds it could not read",
            "AppKit 彻底删除 asks naming the item and what goes with it, writes nothing on 取消, for live content (Rust's refusal) or while input is marked, purges an element with its facts, patch, TODO, body and history in one original, leaves links to it as plain unrewritten prose, and 清空回收站 asks with counts and sends exactly the counted entries: one trashed elsewhere while it asks makes Rust refuse with nothing deleted and the list read again, then the rest is purged in one original that survives a cold reopen",
            "AppKit 回收站 lists a kind this client does not know as 未知类型 with restore and 彻底删除 refused, counts it in the 清空回收站 question and keeps it in the confirmed set Rust compares, so a listing Rust does not hold makes Rust refuse with nothing deleted",
            "AppKit 项目书架 lists every project with summary, chapters, words and last edit newest first, reorders after an edit, creates, renames and opens projects, deletes through the project deletion sheet, reads without writing and lists the same after a cold relaunch",
            "AppKit 导出为 Markdown 文件夹 writes every archive file as UTF-8 into <项目名>-<yyyy-MM-dd> with subfolders, wiki links and front matter, adds a numeric suffix instead of overwriting, offers 在访达中显示, writes no journal row and refuses paths that leave the folder",
            "AppKit 诊断摘要 shows Rust's counts with the app version, macOS version and architecture as read-only JSON, says it holds no book content, copies and saves it, and contains no synthetic title, prose, identity or path",
        ]
    }

    // MARK: Harness

    private final class TrashHarness {
        let root: URL
        let directory: URL
        let journal: JournalProbe
        let workspace: LabWorkspaceCore
        let project: WorkspaceProject
        private(set) var chapters: [WorkspaceChapter] = []
        let window: NSWindow
        let host: MacChapterWorkspace
        /// What AppDelegate's chapter list would hold, from the host's trash hook.
        private(set) var liveChapters: [WorkspaceChapter] = []
        private(set) var trashedChapters: [WorkspaceChapter] = []
        var trashModel: WorkspaceTrashModel?
        let elements: ElementLibraryModel
        let drifts: DriftLibraryModel
        let storylines: StorylineLibraryModel
        private(set) var purged: [WorkspaceTrashPurgeReply.Purged] = []

        init(name: String, chapterTitles: [String]) throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            directory = root.appendingPathComponent("apple-native-lab")
            journal = JournalProbe(directory: directory)
            let workspace = LabWorkspaceCore(directory: directory)
            self.workspace = workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(listed.isEmpty, "Trash fixture was not isolated")
            let created: WorkspaceProject = try BindingAcceptance.elementResult { workspace.createProject(name: name, completion: $0) }
            project = created
            var made: [WorkspaceChapter] = []
            for title in chapterTitles {
                made.append(try BindingAcceptance.elementResult { workspace.createChapter(projectID: created.id, title: title, completion: $0) })
            }
            chapters = made
            (window, host) = BindingAcceptance.elementHost(workspace)
            elements = ElementLibraryModel(workspace: workspace, projectID: project.id)
            drifts = DriftLibraryModel(workspace: workspace, projectID: project.id)
            storylines = StorylineLibraryModel(workspace: workspace, projectID: project.id)
            // As AppDelegate wires the panels' models and the host.
            let host = self.host, projectID = project.id
            elements.onLibrary = { host.applyElementLibrary(projectID: projectID, library: $0) }
            drifts.onLibrary = { host.applyDriftLibrary(projectID: projectID, library: $0) }
            storylines.onLibrary = { host.applyStorylineLibrary(projectID: projectID, library: $0) }
            host.onElementLibrary = { [weak self] _, library in self?.elements.apply(library, message: nil) }
            host.onDriftLibrary = { [weak self] _, library in self?.drifts.apply(library, message: nil) }
            host.onStorylineLibrary = { [weak self] _, library in self?.storylines.apply(library, message: nil) }
            host.onTrash = { [weak self] id, source in
                guard let self, id == projectID else { return }
                self.trashModel?.apply(source)
                if case .chapters(let live, let trashed) = source { self.liveChapters = live; self.trashedChapters = trashed }
            }
            host.onPurged = { [weak self] _, entities in self?.purged += entities }
            elements.load(); drifts.load(); storylines.load()
            try BindingAcceptance.wait { self.elements.loaded && self.drifts.loaded && self.storylines.loaded
                && !self.elements.busy && !self.drifts.busy && !self.storylines.busy }
        }

        func cleanup() {
            window.close()
            try? FileManager.default.removeItem(at: root)
        }

        func open(_ chapter: WorkspaceChapter) throws -> NativeDocumentView {
            let view: NativeDocumentView = try BindingAcceptance.elementResult { host.open(project: project, chapter: chapter, completion: $0) }
            try settled(view)
            return view
        }

        /// Idle: no queued input, save or scheduled link pass.
        func settled(_ views: NativeDocumentView...) throws {
            try BindingAcceptance.wait {
                !self.host.isBusy && views.allSatisfy {
                    $0.binding.state != nil && !$0.binding.hasPendingWork && !$0.binding.store.hasScheduledLinks && !$0.binding.store.isLinking
                }
            }
        }

        func type(_ view: NativeDocumentView, _ text: String) throws {
            let end = (view.textView.string as NSString).length
            view.textView.setSelectedRange(NSRange(location: end, length: 0))
            view.textView.insertText(text, replacementRange: NSRange(location: end, length: 0))
            try settled(view)
        }

        /// Trash stamps milliseconds; apart so newest-first is exact.
        func pause() { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }

        func trashChapter(_ chapter: WorkspaceChapter) throws {
            let reply: WorkspaceChapterTrashReply = try BindingAcceptance.elementResult {
                host.trash(projectID: project.id, chapterID: chapter.id, completion: $0)
            }
            // AppDelegate adopts the reply's lists.
            host.applyChapters(projectID: project.id, chapters: reply.chapters, trashed: reply.trashedChapters)
        }

        func count(_ sql: String) throws -> Int64 {
            guard case .integer(let value)? = try WorkspaceRemoteProseFixture.query(in: directory, sql: sql).first?["n"] else {
                throw LabError.message("Count query returned no row: \(sql)")
            }
            return value
        }

        func trashController() throws -> (MacTrashViewController, NSWindow) {
            let model = WorkspaceTrashModel(workspace: workspace, projectID: project.id)
            trashModel = model
            let controller = MacTrashViewController(model: model, host: host)
            controller.canNavigate = { [host] in host.canNavigate }
            let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 460), styleMask: [.titled, .resizable],
                                 backing: .buffered, defer: false)
            panel.isReleasedWhenClosed = false
            panel.contentViewController = controller
            model.load()
            try BindingAcceptance.wait { model.loaded }
            return (controller, panel)
        }
    }

    private static func trashTitles(_ controller: MacTrashViewController) -> [String] {
        controller.rows.map { "\($0.kind.label):\($0.title)" }
    }

    // MARK: Listing, filter and restore

    private static func trashListsFiltersAndRestores() throws {
        let harness = try TrashHarness(name: "回收站合成项目", chapterTitles: ["雨夜", "钟楼", "归途"])
        defer { harness.cleanup() }
        let workspace = harness.workspace, host = harness.host, project = harness.project
        let people: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: project.id, name: "人物", completion: $0)
        }
        let places: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: project.id, name: "地点", completion: $0)
        }
        // 北塔 is in 地点, which is trashed after it: the list keeps each
        // entry's own trash time, not the later detach.
        let tower: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: project.id, categoryID: places.result!.id, name: "北塔", completion: $0)
        }
        let lamp: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: project.id, categoryID: people.result!.id, name: "灯塔", completion: $0)
        }
        let dream: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
            workspace.createDrift(projectID: project.id, title: "旧梦", groupID: nil, completion: $0)
        }
        let branch: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult {
            workspace.createStoryline(projectID: project.id, name: "支线", completion: $0)
        }
        harness.elements.load(); harness.drifts.load(); harness.storylines.load()
        try wait { !harness.elements.busy && !harness.drifts.busy && !harness.storylines.busy
            && harness.elements.library.elements.count == 2 && harness.drifts.library.drifts.count == 1 }
        let open = try harness.open(harness.chapters[0])
        _ = open
        let tabs = host.tabTitles(pane: 0)

        // Trash one of each kind from its own place, a moment apart.
        try harness.trashChapter(harness.chapters[1]); harness.pause()
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            host.trashElement(projectID: project.id, elementID: tower.result!.id, completion: $0)
        }
        harness.pause()
        let _: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            host.trashCategory(projectID: project.id, categoryID: places.result!.id, completion: $0)
        }
        harness.pause()
        let _: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
            host.trashDrift(projectID: project.id, driftID: dream.result!.id, completion: $0)
        }
        harness.pause()
        let _: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult {
            host.trashStoryline(projectID: project.id, storylineID: branch.result!.id, completion: $0)
        }
        harness.pause()

        let (controller, panel) = try harness.trashController()
        defer { panel.close() }
        let model = controller.model
        try require(trashTitles(controller) == ["故事线:支线", "漂流:旧梦", "分类:地点", "设定:北塔", "章节:钟楼"],
            "The trash is not newest first by trash time: \(trashTitles(controller))")
        let listed: WorkspaceTrashListing = try elementResult { workspace.trash(projectID: project.id, completion: $0) }
        try require(listed.trashed.map(\.id) == controller.rows.map(\.id)
            && zip(listed.trashed, listed.trashed.dropFirst()).allSatisfy { $0.trashedAt >= $1.trashedAt },
            "The panel does not show workspaceTrash's order")
        try require(controller.rows.allSatisfy { $0.trashedDate != nil && !WorkspaceTrashText.time($0).isEmpty }
            && controller.table.numberOfRows == 5 && controller.table.numberOfColumns == 3,
            "Rows lack a kind, title or trash time")
        try require(model.status.hasPrefix("回收站中有 5 项：1 个章节、1 条漂流、1 个设定、1 个分类、1 条故事线"), "Status reads \(model.status)")

        // A trash made in the 设定库 reaches the open panel.
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            host.trashElement(projectID: project.id, elementID: lamp.result!.id, completion: $0)
        }
        try wait { controller.rows.count == 6 }
        try require(trashTitles(controller).first == "设定:灯塔", "The panel did not follow a trash elsewhere: \(trashTitles(controller))")

        // Kind filter.
        controller.choose(filter: .element)
        try require(trashTitles(controller) == ["设定:灯塔", "设定:北塔"] && controller.filterPopup.titleOfSelectedItem == "设定（2）",
            "The element filter shows \(trashTitles(controller))")
        controller.choose(filter: .chapter)
        try require(trashTitles(controller) == ["章节:钟楼"], "The chapter filter shows \(trashTitles(controller))")
        controller.choose(filter: nil)
        try require(controller.rows.count == 6 && controller.filterPopup.titleOfSelectedItem == "全部（6）", "The filter did not clear")

        // 恢复 each kind: one original each, the kind's own list follows, nothing opens.
        func restore(_ kind: WorkspaceTrashKind, _ title: String, _ check: () -> Bool, _ label: String) throws {
            guard let item = controller.rows.first(where: { $0.kind == kind && $0.title == title }) else {
                throw LabError.message("\(label) is not listed")
            }
            try require(controller.select(item) && controller.restoreButton.isEnabled, "\(label) cannot be restored")
            let mark = try harness.journal.mark()
            var finished: Error??
            controller.restore(item) { finished = .some($0) }
            try wait { finished != nil && !model.busy }
            if case .some(.some(let error)) = finished { throw LabError.message("\(label) restore failed: \(error.localizedDescription)") }
            // The panel reads the trash again after the kind's list arrives.
            try wait { check() && !model.items.contains(where: { $0.key == item.key }) }
            try require(try harness.journal.originals(since: mark).count == 1, "\(label) restore wrote \(try harness.journal.originals(since: mark))")
            try require(!model.items.contains(where: { $0.key == item.key }) && host.tabTitles(pane: 0) == tabs && host.paneCount == 1,
                "\(label) stayed in the trash or opened a tab: \(host.tabTitles(pane: 0))")
        }
        let chapterID = harness.chapters[1].id
        try restore(.chapter, "钟楼", {
            !harness.trashedChapters.contains { $0.id == chapterID } && harness.liveChapters.contains { $0.id == chapterID }
                && host.linkDirectory(projectID: project.id)?.chapters[chapterID]?.trashed == false
        }, "Chapter")
        try restore(.element, "北塔", {
            harness.elements.library.elements.contains { $0.id == tower.result!.id }
                && !harness.elements.library.trashedElements.contains { $0.id == tower.result!.id }
                && host.linkDirectory(projectID: project.id)?.elements[tower.result!.id]?.trashed == false
        }, "Element")
        try restore(.category, "地点", {
            harness.elements.library.categories.contains { $0.id == places.result!.id } && harness.elements.library.trashedCategories.isEmpty
        }, "Category")
        try restore(.drift, "旧梦", {
            harness.drifts.library.drifts.contains { $0.id == dream.result!.id } && harness.drifts.library.trashedDrifts.isEmpty
        }, "Drift")
        try restore(.storyline, "支线", {
            harness.storylines.library.storylines.contains { $0.id == branch.result!.id } && harness.storylines.library.trashedStorylines.isEmpty
        }, "Storyline")
        try require(trashTitles(controller) == ["设定:灯塔"] && model.status.contains("已恢复"), "After restoring: \(trashTitles(controller)) \(model.status)")
        // The panel reads the same from Rust.
        let fresh = WorkspaceTrashModel(workspace: workspace, projectID: project.id)
        fresh.load(); try wait { fresh.loaded }
        try require(fresh.items.map(\.key) == model.items.map(\.key), "A fresh read differs: \(fresh.items.map(\.title))")

        // A failed read turns 清空回收站 off and names the kinds it could not read.
        var asked = 0
        controller.presentAlert = { _, done in asked += 1; done(.alertSecondButtonReturn) }
        try require(controller.emptyButton.isEnabled && model.canEmpty, "清空回收站 is off for a readable trash")
        let reader = model.read
        model.read = { done in done(.failure(LabError.message("合成的读取失败"))) }
        model.load()
        try wait { model.unread != nil }
        try require(!controller.emptyButton.isEnabled
            && model.status.contains("无法读取回收站中的章节、漂流、设定、分类和故事线：合成的读取失败") && model.status.contains("清空回收站已停用"),
            "A failed read left 清空回收站 on or unnamed: \(model.status)")
        var refused: Error??
        controller.emptyTrash { refused = .some($0) }
        try require(asked == 0 && refused != nil, "清空回收站 asked after a failed read")
        model.read = reader
        model.load()
        try wait { model.unread == nil && controller.emptyButton.isEnabled }
        // A re-read after a trash elsewhere fails: only that kind is named.
        model.read = { done in done(.failure(LabError.message("合成的读取失败"))) }
        let _: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
            host.trashDrift(projectID: project.id, driftID: dream.result!.id, completion: $0)
        }
        try wait { model.unread != nil }
        try require(model.unread?.kinds == [.drift] && model.status.contains("无法读取回收站中的漂流：") && !controller.emptyButton.isEnabled,
            "A failed re-read names \(model.status)")
        model.read = reader
        model.load()
        try wait { model.unread == nil && trashTitles(controller) == ["漂流:旧梦", "设定:灯塔"] }
        try require(controller.emptyButton.isEnabled && model.summary.hasPrefix("回收站中有 2 项") && !model.status.contains("无法读取"),
            "A later read did not restore 清空回收站: \(model.status)")
        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed, "The workspace did not close")
    }

    // MARK: Purge and empty

    private static func trashPurgesAndEmpties() throws {
        let harness = try TrashHarness(name: "彻底删除合成项目", chapterTitles: ["雨夜", "钟楼"])
        defer { harness.cleanup() }
        let workspace = harness.workspace, host = harness.host, project = harness.project, journal = harness.journal
        let places: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: project.id, name: "地点", completion: $0)
        }
        let created: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: project.id, categoryID: places.result!.id, name: "北塔", completion: $0)
        }
        let tower = created.result!
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.setElementFacts(projectID: project.id, elementID: tower.id, facts: [WorkspaceFact(key: "高度", value: "九层")], completion: $0)
        }
        let _: WorkspacePatchReply<WorkspacePatch> = try elementResult {
            workspace.createPatch(projectID: project.id, elementID: tower.id, title: "倒塌", body: "只剩地基", source: nil, completion: $0)
        }
        let _: WorkspaceCommentsReply = try elementResult {
            workspace.createComment(projectID: project.id, kind: "todo", target: RelationEndpoint(kind: "element", id: tower.id),
                                    body: "核对层数", priority: nil, completion: $0)
        }
        let dream: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
            workspace.createDrift(projectID: project.id, title: "旧梦", groupID: nil, completion: $0)
        }
        let branch: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult {
            workspace.createStoryline(projectID: project.id, name: "支线", completion: $0)
        }
        harness.elements.load(); harness.drifts.load(); harness.storylines.load()
        try wait { !harness.elements.busy && harness.elements.library.elements.count == 1 && !harness.drifts.busy && !harness.storylines.busy }
        // The element's body, closed so its version is kept.
        let page: NativeDocumentView = try elementResult { host.open(project: project, element: harness.elements.library.elements[0], completion: $0) }
        try harness.type(page, "塔顶有钟。")
        let _: Bool = try elementResult { host.closeTab(pane: 0, scope: .element(ElementScope(projectID: project.id, elementID: tower.id)), completion: $0) }
        // A chapter links it.
        let view = try harness.open(harness.chapters[0])
        try harness.type(view, "她爬上北塔。")
        let towerAt = (view.textView.string as NSString).range(of: "北塔").location
        try wait { view.linkTargets(at: towerAt).first?.id == tower.id }
        let linkedText = try read(host.activeCore!).projection.text
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            host.trashElement(projectID: project.id, elementID: tower.id, completion: $0)
        }
        try wait { view.linkTargets(at: towerAt).first?.trashed == true }
        try require(view.showLinkPreview(at: towerAt) && view.linkPreviewText == "北塔（已在回收站）", "The trashed link is not dimmed")
        view.closeLinkPreview()
        for table in ["entity_kv_entry WHERE owner_id='\(tower.id)'", "element_patch WHERE element_id='\(tower.id)'",
                      "comment WHERE target_id='\(tower.id)'", "yjs_document_revision WHERE document_id='element:\(tower.id)'",
                      "entity_snapshot_history WHERE entity_id='\(tower.id)'"] {
            try require(try harness.count("SELECT COUNT(*) AS n FROM \(table)") > 0, "Fixture lacks \(table)")
        }
        try require(try harness.count("SELECT (SELECT COUNT(*) FROM yjs_updates WHERE document_id='element:\(tower.id)') + (SELECT COUNT(*) FROM yjs_snapshots WHERE document_id='element:\(tower.id)') AS n") > 0,
            "Fixture lacks the element body")

        let (controller, panel) = try harness.trashController()
        defer { panel.close() }
        let model = controller.model
        guard let item = model.items.first(where: { $0.kind == .element }) else { throw LabError.message("北塔 is not listed") }

        // 取消 writes nothing.
        var answered: [NSAlert] = []
        controller.presentAlert = { alert, done in answered.append(alert); done(.alertSecondButtonReturn) }
        var mark = try journal.mark()
        var result: Error??
        controller.purge(item) { result = .some($0) }
        try wait { result != nil }
        try journal.expect([], since: mark, "A cancelled purge")
        try require(answered.last?.messageText == "彻底删除设定“北塔”？"
            && answered.last?.informativeText == "它的字段、补丁、正文和历史版本，以及写在它上面的批注与待办会一起永久删除，无法恢复。其他正文里指向它的链接会变为普通文字，正文本身不会改写。"
            && model.items.contains(item), "The purge question reads \(answered.last?.messageText ?? "none") / \(answered.last?.informativeText ?? "")")

        // Rust refuses live content and an open page; nothing is written.
        for (chapter, expected) in [(harness.chapters[1], "只有回收站里的内容才能彻底删除"), (harness.chapters[0], "请先关闭这一页，再彻底删除")] {
            let live = WorkspaceTrashItem(kind: .chapter, id: chapter.id, title: chapter.title, trashedAt: "")
            let refusal: String = try elementRefused({ (done: @escaping (Result<WorkspaceTrashPurgeReply, Error>) -> Void) in
                host.purge(live, projectID: project.id, completion: done)
            }, "A live chapter was purged")
            try require(refusal == expected, "Rust's refusal reads \(refusal)")
        }
        try journal.expect([], since: mark, "A refused purge")

        // Marked input holds it before any question.
        let end = (view.textView.string as NSString).length
        view.textView.setSelectedRange(NSRange(location: end, length: 0))
        view.textView.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: end, length: 0))
        let asked = answered.count
        result = nil
        controller.purge(item) { result = .some($0) }
        try wait { result != nil }
        try require(answered.count == asked && model.status == "请先完成输入，并等待正文保存后再操作回收站。", "Marked input did not hold the purge: \(model.status)")
        try journal.expect([], since: mark, "A purge held by marked input")
        view.textView.insertText("钟", replacementRange: NSRange(location: NSNotFound, length: 0))
        try harness.settled(view)
        let chapterText = try read(host.activeCore!).projection.text
        try require(chapterText == linkedText + "钟", "The committed text differs: \(chapterText)")

        // 彻底删除 in one original.
        controller.presentAlert = { alert, done in answered.append(alert); done(.alertFirstButtonReturn) }
        mark = try journal.mark()
        result = nil
        controller.purge(item) { result = .some($0) }
        try wait { result != nil && !model.busy }
        if case .some(.some(let error)) = result { throw LabError.message("Purge failed: \(error.localizedDescription)") }
        // The TODO, the fact and the patch (Rust retires patches with `entity.trash`), then the element.
        try journal.expect([["entity.purge comment", "entity.purge kv-entry", "entity.trash element-patch", "entity.purge element"]],
                           since: mark, "Purging 北塔")
        for table in ["element WHERE id='\(tower.id)'", "entity_kv_entry WHERE owner_id='\(tower.id)'", "element_patch WHERE element_id='\(tower.id)'",
                      "comment WHERE target_id='\(tower.id)'", "yjs_updates WHERE document_id='element:\(tower.id)'",
                      "yjs_snapshots WHERE document_id='element:\(tower.id)'", "yjs_document_revision WHERE document_id='element:\(tower.id)'",
                      "entity_snapshot_history WHERE entity_id='\(tower.id)'"] {
            try require(try harness.count("SELECT COUNT(*) AS n FROM \(table)") == 0, "\(table) survived the purge")
        }
        guard case .text(let state)? = try WorkspaceRemoteProseFixture.query(in: harness.directory,
            sql: "SELECT state FROM sync_entity_lifecycle WHERE entity_kind='element' AND entity_id='\(tower.id)'").first?["state"],
              state == "purged" else { throw LabError.message("The element lifecycle is not purged") }
        try wait { harness.elements.library.trashedElements.isEmpty && view.linkTargets(at: towerAt).isEmpty }
        try require(!model.items.contains(item) && harness.purged.map(\.id) == [tower.id] && model.status == "设定“北塔”已彻底删除。",
            "The panel or host did not follow the purge: \(model.status)")
        // The link mark stays in the prose, which reads as plain text now.
        let attributes = view.textView.textStorage!.attributes(at: towerAt, effectiveRange: nil)
        let purgedText = try read(host.activeCore!).projection.text
        try require(view.links(at: towerAt) == [NativeEntityLink(kind: "element", id: tower.id)]
            && attributes[.underlineStyle] == nil && !view.showLinkPreview(at: towerAt) && !view.openLink(at: towerAt)
            && purgedText == chapterText,
            "The purged link is not plain, unrewritten prose: \(attributes)")
        try requireStyleReference(view.textView.textStorage!, view.binding.store.projection!, "purged link", links: view.linkDirectory)

        // 清空回收站 sends the entries it counted: a category trashed elsewhere
        // while the question is open makes Rust refuse, deleting nothing.
        try harness.trashChapter(harness.chapters[1])
        let _: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
            host.trashDrift(projectID: project.id, driftID: dream.result!.id, completion: $0)
        }
        let _: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult {
            host.trashStoryline(projectID: project.id, storylineID: branch.result!.id, completion: $0)
        }
        try wait { model.items.count == 3 && controller.emptyButton.isEnabled }
        var answer: ((NSApplication.ModalResponse) -> Void)?
        controller.presentAlert = { alert, done in answered.append(alert); answer = done }
        result = nil
        controller.emptyTrash { result = .some($0) }
        try wait { answer != nil }
        try require(answered.last?.informativeText.hasPrefix("将永久删除回收站中的全部 3 项") == true, "The question did not count 3 entries")
        let _: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            host.trashCategory(projectID: project.id, categoryID: places.result!.id, completion: $0)
        }
        try wait { model.items.count == 4 }
        mark = try journal.mark()
        answer?(.alertFirstButtonReturn)
        try wait { result != nil && !model.busy }
        guard case .some(.some(let changed)) = result, changed.localizedDescription.contains("确认后有变化") else {
            throw LabError.message("A changed trash was emptied: \(String(describing: result))")
        }
        try journal.expect([], since: mark, "Emptying a trash that changed after the question")
        for table in ["book_node WHERE id='\(harness.chapters[1].id)'", "book_node WHERE id='\(dream.result!.id)'",
                      "storylines WHERE id='\(branch.result!.id)'", "element_category WHERE id='\(places.result!.id)'"] {
            try require(try harness.count("SELECT COUNT(*) AS n FROM \(table)") == 1, "\(table) was purged after the trash changed")
        }
        try wait { model.items.count == 4 && !model.busy && controller.emptyButton.isEnabled }
        try require(model.status.hasPrefix("回收站在确认后有变化，没有删除任何内容"), "The refusal reads \(model.status)")

        // 清空回收站 with counts, in one original.
        controller.presentAlert = { alert, done in answered.append(alert); done(.alertFirstButtonReturn) }
        mark = try journal.mark()
        result = nil
        controller.emptyTrash { result = .some($0) }
        try wait { result != nil && !model.busy }
        if case .some(.some(let error)) = result { throw LabError.message("Emptying failed: \(error.localizedDescription)") }
        try require(answered.last?.messageText == "清空回收站？"
            && answered.last?.informativeText == "将永久删除回收站中的全部 4 项：1 个章节、1 条漂流、1 个分类、1 条故事线，连同它们的字段、补丁、正文、历史版本和写在上面的批注与待办，无法恢复。",
            "The empty question reads \(answered.last?.informativeText ?? "none")")
        try journal.expect([["entity.purge node", "entity.purge node", "entity.purge element-category", "entity.purge storyline"]],
                           since: mark, "Emptying the trash")
        try wait { model.items.isEmpty && harness.trashedChapters.isEmpty && harness.drifts.library.trashedDrifts.isEmpty
            && harness.storylines.library.trashedStorylines.isEmpty && harness.elements.library.trashedCategories.isEmpty }
        try require(!controller.emptyButton.isEnabled && model.status.hasPrefix("回收站已清空，彻底删除了 4 项"), "After emptying: \(model.status)")
        for table in ["book_node WHERE id='\(harness.chapters[1].id)'", "yjs_updates WHERE document_id='node-content:\(harness.chapters[1].id)'",
                      "book_node WHERE id='\(dream.result!.id)'", "storylines WHERE id='\(branch.result!.id)'",
                      "element_category WHERE id='\(places.result!.id)'"] {
            try require(try harness.count("SELECT COUNT(*) AS n FROM \(table)") == 0, "\(table) survived emptying")
        }

        // Cold reopen: the trash stays empty and the prose keeps its text and mark.
        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed, "The workspace did not close")
        let cold = LabWorkspaceCore(directory: harness.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let coldTrash = WorkspaceTrashModel(workspace: cold, projectID: project.id)
        coldTrash.load(); try wait { coldTrash.loaded }
        let library: WorkspaceElementLibrary = try elementResult { cold.elementLibrary(projectID: project.id, completion: $0) }
        let coldCore: LabCore = try elementResult { cold.openChapter(projectID: project.id, chapterID: harness.chapters[0].id, completion: $0) }
        let coldText = try read(coldCore).projection
        try require(coldTrash.items.isEmpty && library.elements.isEmpty && coldText.text == chapterText
            && linkedRuns(coldText).map(\.1) == [NativeEntityLink(kind: "element", id: tower.id)],
            "After a cold reopen: \(coldTrash.items.map(\.title)) \(library.elements.map(\.name)) \(coldText.text)")
        let _: Bool = try elementResult { cold.close(completion: $0) }
    }

    // MARK: Unknown kinds

    private static func trashKeepsUnknownKinds() throws {
        let harness = try TrashHarness(name: "未知类型合成项目", chapterTitles: ["第一章", "第二章"])
        defer { harness.cleanup() }
        try harness.trashChapter(harness.chapters[1])
        let (controller, panel) = try harness.trashController()
        defer { panel.close() }
        let model = controller.model
        // Rust lists a kind this client does not know (a synthetic entry).
        let reader = model.read
        let unknown = WorkspaceTrashEntry(kind: "note", id: "synthetic-note", title: "未来的便签", trashedAt: "2026-09-28T10:00:00.000Z")
        model.read = { done in reader { result in done(result.map { $0 + [unknown] }) } }
        model.load()
        try wait { model.loaded && model.items.count == 2 }
        guard let item = model.items.first(where: { $0.id == "synthetic-note" }) else { throw LabError.message("The unknown kind was dropped") }
        try require(item.kind == .unknown && item.rawKind == "note" && item.kind.label == "未知类型" && item.confirmedKey == ["kind": "note", "id": "synthetic-note"]
            && trashTitles(controller).contains("未知类型:未来的便签") && model.summary.hasPrefix("回收站中有 2 项：1 个章节、1 项未知类型的内容。"),
            "The unknown kind is not listed: \(trashTitles(controller)) \(model.summary)")
        // It cannot be restored or purged alone.
        try require(controller.select(item) && !controller.restoreButton.isEnabled && !controller.purgeButton.isEnabled, "Its buttons are enabled")
        var refused: Error??
        controller.restore(item) { refused = .some($0) }
        try wait { refused != nil }
        guard case .some(.some(let error)) = refused, error.localizedDescription == WorkspaceTrashText.unknownRefusal else {
            throw LabError.message("Restoring an unknown kind was not refused: \(String(describing: refused))")
        }
        // 清空回收站 counts it and sends it; Rust holds no such entry and refuses.
        var asked: NSAlert?
        controller.presentAlert = { alert, done in asked = alert; done(.alertFirstButtonReturn) }
        let mark = try harness.journal.mark()
        var result: Error??
        controller.emptyTrash { result = .some($0) }
        try wait { result != nil && !model.busy }
        try require(asked?.informativeText.hasPrefix("将永久删除回收站中的全部 2 项：1 个章节、1 项未知类型的内容") == true,
            "The question did not count the unknown kind: \(asked?.informativeText ?? "")")
        guard case .some(.some(let changed)) = result, changed.localizedDescription.contains("确认后有变化") else {
            throw LabError.message("The confirmed set left the unknown kind out: \(String(describing: result))")
        }
        try harness.journal.expect([], since: mark, "Emptying with an entry Rust does not hold")
        try require(try harness.count("SELECT COUNT(*) AS n FROM book_node WHERE id='\(harness.chapters[1].id)'") == 1, "The chapter was purged")
        // With Rust's own listing, the trash empties.
        model.read = reader
        model.load()
        try wait { model.loaded && model.items.count == 1 && !model.busy }
        result = nil
        controller.emptyTrash { result = .some($0) }
        try wait { result != nil && !model.busy }
        if case .some(.some(let error)) = result { throw LabError.message("Emptying failed: \(error.localizedDescription)") }
        try require(model.items.isEmpty, "The trash did not empty")
    }

    // MARK: 项目书架

    private static func shelfListsOpensCreatesRenamesAndDeletes() throws {
        let harness = try TrashHarness(name: "长篇甲", chapterTitles: ["雨夜", "钟楼"])
        defer { harness.cleanup() }
        let workspace = harness.workspace, host = harness.host, first = harness.project, journal = harness.journal
        let _: WorkspaceProjectDetails = try elementResult {
            workspace.updateProject(projectID: first.id, changes: WorkspaceProjectChanges(summary: "港口城市的长篇"), completion: $0)
        }
        let view = try harness.open(harness.chapters[0])
        try harness.type(view, "雨夜里钟声响起。")
        harness.pause()
        let second: WorkspaceProject = try elementResult { workspace.createProject(name: "短篇乙", completion: $0) }
        let prologue: WorkspaceChapter = try elementResult { workspace.createChapter(projectID: second.id, title: "序章", completion: $0) }
        let prologueView: NativeDocumentView = try elementResult { host.open(project: second, chapter: prologue, completion: $0) }
        try harness.settled(prologueView)
        try harness.type(prologueView, "开头。")
        harness.pause()

        let model = ProjectShelfModel(workspace: workspace)
        let shelf = MacProjectShelfWindowController(model: model)
        defer { shelf.window?.close() }
        var mark = try journal.mark()
        var loaded = false
        model.load { loaded = true }
        try wait { loaded }
        try journal.expect([], since: mark, "Reading the shelf")
        func names() -> [String] { shelf.rows.map(\.project.name) }
        try require(names() == ["短篇乙", "长篇甲"] && shelf.table.numberOfRows == 2 && shelf.table.numberOfColumns == 4,
            "The shelf is not newest first: \(names())")
        guard let long = shelf.rows.first(where: { $0.project.id == first.id }),
              let short = shelf.rows.first(where: { $0.project.id == second.id }) else { throw LabError.message("A project is missing") }
        func words(_ id: String) throws -> Int {
            let counts: WorkspaceWordCounts = try elementResult { workspace.wordCounts(projectID: id, completion: $0) }
            return WordCountLibrary(counts.counts).chapterTotal
        }
        let (longWords, shortWords) = (try words(first.id), try words(second.id))
        try require(longWords > 0 && shortWords > 0, "The fixture has no counted words")
        try require(long.summary == "港口城市的长篇" && long.chapterCount == 2 && long.words == longWords && long.wordsReady
            && long.countsText == "2 章 · \(WordCountText.full(longWords))" && short.chapterCount == 1 && short.words == shortWords && short.summary.isEmpty
            && long.lastEditedDate != nil && short.lastEditedDate! >= long.lastEditedDate!
            && long.lastEditedText.hasPrefix("最后编辑 ") && model.status == "共 2 个项目，按最后编辑时间排列。",
            "Shelf rows differ: \(long) \(short)")

        // Editing the older book moves it first.
        try harness.type(view, "又一句。")
        loaded = false
        model.load { loaded = true }
        try wait { loaded }
        try require(names() == ["长篇甲", "短篇乙"] && shelf.rows[0].words == (try words(first.id)) && shelf.rows[0].words > longWords,
            "An edit did not reorder the shelf: \(names())")

        // 新建项目… and 重命名… through the name prompt.
        var created: WorkspaceProject?, renamed: WorkspaceProject?, opened: WorkspaceProject?, deleting: WorkspaceProject?
        var prompts: [(String, String?)] = []
        var answer: String? = "新书丙"
        shelf.askName = { title, current, done in prompts.append((title, current)); done(answer) }
        shelf.onCreated = { created = $0 }
        shelf.onRenamed = { renamed = $0 }
        shelf.onOpen = { opened = $0 }
        shelf.onDelete = { deleting = $0 }
        shelf.createProject()
        try wait { created != nil && !model.busy && shelf.rows.count == 3 }
        try require(created?.name == "新书丙" && prompts.last?.0 == "新建项目" && prompts.last?.1 == nil
            && shelf.selectedEntry?.project.id == created?.id && shelf.selectedEntry?.chapterCount == 0,
            "Creating from the shelf differs: \(names())")
        answer = "新书丙改"
        shelf.renameSelected()
        try wait { renamed != nil && !model.busy && names().contains("新书丙改") }
        try require(prompts.last?.0 == "重命名项目" && prompts.last?.1 == "新书丙" && renamed?.id == created?.id
            && shelf.selectedEntry?.project.name == "新书丙改", "Renaming from the shelf differs: \(names())")
        answer = "   "
        mark = try journal.mark()
        shelf.renameSelected()
        try require(model.status == "名称不能为空，请重新输入。", "A blank name was not refused: \(model.status)")
        try journal.expect([], since: mark, "A blank rename")
        try require(shelf.select(projectID: first.id), "长篇甲 is not listed")
        shelf.openSelected()
        try require(opened == WorkspaceProject(id: first.id, name: "长篇甲"), "打开 did not open 长篇甲")

        // 删除项目… through the deletion sheet, as AppDelegate wires it.
        try require(shelf.select(projectID: second.id), "短篇乙 is not listed")
        shelf.deleteSelected()
        guard let target = deleting else { throw LabError.message("删除项目… was not offered") }
        let coordinator = ProjectDeletionCoordinator(workspace: workspace, host: host)
        let sheet = ProjectDeletionSheet(project: target)
        var outcome: ProjectDeletionCoordinator.Outcome?
        sheet.onConfirm = { done in
            coordinator.delete(target) { result in
                switch result {
                case .success(let value): outcome = value; done(nil)
                case .failure(let error): done(error)
                }
            }
        }
        sheet.type("短篇乙")
        mark = try journal.mark()
        sheet.confirm()
        try wait { !sheet.isDeleting }
        guard outcome != nil else { throw LabError.message("Deletion failed: \(sheet.errorMessage ?? "")") }
        try journal.expect([["sync-generation.purge sync-generation"]], since: mark, "Deleting from the shelf")
        loaded = false
        model.load { loaded = true }
        try wait { loaded }
        try require(Set(names()) == ["长篇甲", "新书丙改"] && !host.hasTabs(projectID: second.id), "The shelf kept the deleted project: \(names())")
        let expected = shelf.rows.map { [$0.project.name, $0.countsText, $0.summary, $0.lastEdited] }

        // Cold relaunch.
        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed, "The workspace did not close")
        let cold = LabWorkspaceCore(directory: harness.directory)
        let coldModel = ProjectShelfModel(workspace: cold)
        loaded = false
        coldModel.load { loaded = true }
        try wait { loaded }
        try require(coldModel.entries.map { [$0.project.name, $0.countsText, $0.summary, $0.lastEdited] } == expected,
            "The shelf differs after a cold relaunch: \(coldModel.entries.map(\.project.name))")
        let _: Bool = try elementResult { cold.close(completion: $0) }
    }

    // MARK: 导出为 Markdown 文件夹

    private static func markdownFolderExport() throws {
        let harness = try TrashHarness(name: "导出/合成:项目", chapterTitles: ["雨夜"])
        defer { harness.cleanup() }
        let workspace = harness.workspace, host = harness.host, project = harness.project, journal = harness.journal
        let places: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: project.id, name: "地点", completion: $0)
        }
        let created: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: project.id, categoryID: places.result!.id, name: "北塔", completion: $0)
        }
        let tower = created.result!
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.setElementFacts(projectID: project.id, elementID: tower.id, facts: [WorkspaceFact(key: "高度", value: "九层")], completion: $0)
        }
        host.elementsChanged(projectID: project.id)
        let view = try harness.open(harness.chapters[0])
        try wait { host.linkDirectory(projectID: project.id)?.elements[tower.id] != nil }
        try harness.type(view, "她爬上北塔。")
        try wait { view.linkTargets(at: 3).first?.id == tower.id }

        let destination = harness.root.appendingPathComponent("导出位置", isDirectory: true)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let exporter = MacMarkdownFolderExport(workspace: workspace)
        let day = Calendar.current.date(from: DateComponents(year: 2026, month: 9, day: 28, hour: 12))!
        exporter.now = { day }
        exporter.chooseFolder = { _, done in done(destination) }
        var alerts: [NSAlert] = []
        exporter.presentAlert = { alert, done in alerts.append(alert); done(.alertFirstButtonReturn) }
        var revealed: [URL] = []
        exporter.reveal = { revealed.append($0) }
        let mark = try journal.mark()
        let folder: URL = try elementResult { exporter.begin(project: project, window: nil, completion: $0) }
        try journal.expect([], since: mark, "Exporting a Markdown folder")
        try require(folder.lastPathComponent == "导出／合成：项目-2026-09-28" && folder.deletingLastPathComponent().standardizedFileURL == destination.standardizedFileURL,
            "The folder is named \(folder.lastPathComponent)")
        let archive: WorkspaceMarkdownArchive = try elementResult { workspace.exportArchive(projectID: project.id, completion: $0) }
        let enumerator = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey])!
        var written: [String: String] = [:]
        for case let url as URL in enumerator where (try url.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true {
            let relative = String(url.standardizedFileURL.path.dropFirst(folder.standardizedFileURL.path.count + 1))
            written[relative] = try String(contentsOf: url, encoding: .utf8)
        }
        try require(Set(written.keys) == Set(archive.files.map(\.path)) && written.count == archive.documentCount + 2
            && archive.files.allSatisfy { written[$0.path] == $0.text }, "Written files differ: \(written.keys.sorted())")
        var isDirectory: ObjCBool = false
        try require(FileManager.default.fileExists(atPath: folder.appendingPathComponent("book/chapters").path, isDirectory: &isDirectory)
            && isDirectory.boolValue && FileManager.default.fileExists(atPath: folder.appendingPathComponent("elements").path),
            "Subfolders were not created")
        guard let chapter = written.first(where: { $0.key.hasPrefix("book/chapters/001-雨夜-") })?.value,
              let element = written["elements/北塔-\(tower.id).md"] else { throw LabError.message("Chapter or element file is missing") }
        try require(chapter.hasPrefix("---\n") && chapter.contains("drifting_kind: \"node\"") && chapter.contains("[[elements/北塔-\(tower.id)|北塔]]")
            && element.contains("- 高度：九层") && written["index.md"]?.contains("[[elements/北塔-\(tower.id)|北塔]]") == true
            && written["README.md"] != nil, "Front matter or wiki links are missing:\n\(chapter)")
        try require(alerts.count == 1 && alerts[0].messageText == "已导出 \(archive.files.count) 个 Markdown 文件"
            && alerts[0].buttons.first?.title == "在访达中显示" && revealed == [folder], "The report or 在访达中显示 differs")

        // The same day again: a numeric suffix, nothing overwritten.
        let again: URL = try elementResult { exporter.begin(project: project, window: nil, completion: $0) }
        try require(again.lastPathComponent == "导出／合成：项目-2026-09-28-2"
            && (try FileManager.default.contentsOfDirectory(atPath: destination.path)).sorted() == ["导出／合成：项目-2026-09-28", "导出／合成：项目-2026-09-28-2"],
            "A second export did not add a suffix: \(again.lastPathComponent)")
        try journal.expect([], since: mark, "Exporting twice")

        // Paths that leave the folder refuse the whole archive before writing.
        for path in ["../逃逸.md", "/tmp/逃逸.md", "book/../../逃逸.md", "book//逃逸.md"] {
            let hostile = WorkspaceMarkdownArchive(projectName: "逃逸", documentCount: 1,
                files: [WorkspaceMarkdownArchive.File(path: "index.md", text: "索引"), WorkspaceMarkdownArchive.File(path: path, text: "越界")])
            do {
                _ = try MarkdownFolderWriter.write(hostile, into: destination, date: day)
                throw LabError.message("\(path) was written")
            } catch let error as LabError {
                try require(error.localizedDescription.contains("无效的文件路径"), "\(path) was refused as \(error.localizedDescription)")
            }
        }
        try require((try FileManager.default.contentsOfDirectory(atPath: destination.path)).count == 2
            && !FileManager.default.fileExists(atPath: harness.root.appendingPathComponent("逃逸.md").path),
            "A refused archive wrote something")
        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed, "The workspace did not close")
    }

    // MARK: 诊断摘要

    private static func diagnosticSummary() throws {
        let harness = try TrashHarness(name: "诊断合成项目", chapterTitles: ["雨夜钟声"])
        defer { harness.cleanup() }
        let host = harness.host, journal = harness.journal
        let view = try harness.open(harness.chapters[0])
        try harness.type(view, "灯塔在雾里亮起。")
        let controller = MacDiagnosticsWindowController(workspace: harness.workspace)
        defer { controller.window?.close() }
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("drifting-acceptance-\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        controller.pasteboard = pasteboard
        let mark = try journal.mark()
        let text: String = try elementResult { controller.load(completion: $0) }
        try journal.expect([], since: mark, "Reading the diagnostic summary")
        guard let object = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let hostInfo = object["host"] as? [String: Any], let database = object["database"] as? [String: Any],
              let projects = object["projects"] as? [[String: Any]], let open = object["openBodies"] as? [String: Any] else {
            throw LabError.message("The summary is not the expected JSON: \(text)")
        }
        let version = ProcessInfo.processInfo.operatingSystemVersion
        try require(object["format"] as? String == "drifting.native-diagnostics" && database["integrity"] as? String == "ok"
            && projects.count == 1 && projects[0]["chapters"] as? Int == 1 && open["count"] as? Int == 1
            && hostInfo["macOS"] as? String == "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
            && ["arm64", "x86_64"].contains(hostInfo["architecture"] as? String ?? "") && hostInfo["appVersion"] != nil,
            "The summary lacks counts or host facts: \(text)")
        try require(controller.textView.string == text && !controller.textView.isEditable
            && controller.notice.stringValue.contains("不包含书名、章节标题、正文") && controller.copyButton.isEnabled,
            "The window does not show the read-only summary")
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        for secret in ["诊断合成项目", "雨夜钟声", "灯塔", "雾里", harness.project.id, harness.chapters[0].id,
                       harness.root.path, harness.directory.lastPathComponent, home, NSUserName()] {
            try require(!text.contains(secret), "The summary names \(secret)")
        }
        controller.copySummary()
        try require(pasteboard.string(forType: .string) == text, "拷贝 did not copy the summary")
        let saved = harness.root.appendingPathComponent(DiagnosticSummary.fileName())
        controller.chooseSaveURL = { _, name, done in
            done(name.hasSuffix(".json") ? saved : nil)
        }
        let url: URL = try elementResult { controller.save(completion: $0) }
        try require(url == saved && (try String(contentsOf: saved, encoding: .utf8)) == text, "存储为… wrote something else")
        try journal.expect([], since: mark, "Copying and saving the summary")
        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed, "The workspace did not close")
    }
}
