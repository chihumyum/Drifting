import AppKit

/// Chapter and drift word counts through the real AppKit pages, outline,
/// 漂流 panel and project sheet over the Rust workspace. The wiring mirrors
/// AppDelegate, including its status line; input is programmatic.
extension BindingAcceptance {
    /// One project, the tab host in a sized window, the outline, the 漂流
    /// panel and the 项目资料 sheet, connected as AppDelegate connects them.
    private final class WordCountHarness {
        typealias Fixture = WorkspaceRemoteProseFixture
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
        let profile: ProjectProfileModel
        let sheet: ProjectProfileSheet

        /// A new project with these chapters, or the only project of an
        /// existing directory. `openProject` runs AppDelegate.selectProject's
        /// count read (the first one reconciles).
        init(directory existing: URL? = nil, titles: [String] = [], openProject: Bool = true) throws {
            let directory = existing ?? FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                .appendingPathComponent("apple-native-lab")
            let workspace = LabWorkspaceCore(directory: directory)
            self.directory = directory
            self.workspace = workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            if existing == nil {
                try BindingAcceptance.require(listed.isEmpty, "Word count fixture was not isolated")
                let project: WorkspaceProject = try BindingAcceptance.elementResult { workspace.createProject(name: "字数合成项目", completion: $0) }
                self.project = project
                chapters = try titles.map { title in
                    try BindingAcceptance.elementResult { workspace.createChapter(projectID: project.id, title: title, completion: $0) }
                }
            } else {
                guard listed.count == 1 else { throw LabError.message("The reopened word count fixture lists \(listed.count) projects") }
                project = listed[0]
                chapters = try BindingAcceptance.elementResult { workspace.chapters(projectID: listed[0].id, completion: $0) }
            }
            (window, host) = BindingAcceptance.elementHost(workspace)
            drifts = DriftLibraryModel(workspace: workspace, projectID: project.id)
            driftController = MacDriftLibraryViewController(model: drifts)
            outline = WorkspaceOutlineModel(workspace: workspace, projectID: project.id)
            outlineController = BookOutlineViewController(model: outline)
            profile = ProjectProfileModel(workspace: workspace, projectID: project.id)
            sheet = ProjectProfileSheet(model: profile, projectName: project.name)
            _ = driftController.view
            _ = outlineController.view
            let (host, drifts, outline, profile, project) = (self.host, self.drifts, self.outline, self.profile, self.project)
            // AppDelegate.adoptWordCounts: lists, the outline, the panel and the sheet follow.
            host.onWordCounts = { projectID, library in
                guard projectID == project.id else { return }
                outline.applyWordCounts(library)
                drifts.applyWordCounts(library)
                profile.applyWordCounts(library)
            }
            drifts.onLibrary = { library in
                host.applyDriftLibrary(projectID: project.id, library: library)
                outline.applyDrifts(library)
            }
            host.onDriftLibrary = { projectID, library in
                guard projectID == project.id else { return }
                drifts.apply(library, message: nil)
                outline.applyDrifts(library)
            }
            driftController.canNavigate = { host.canNavigate }
            outlineController.canNavigate = { host.canNavigate }
            drifts.load()
            try BindingAcceptance.wait { drifts.loaded && !drifts.busy }
            outline.load()
            try BindingAcceptance.wait { outline.entries.count == self.chapters.count && outline.chapterStatuses != nil }
            profile.load()
            try BindingAcceptance.wait { !profile.loading && profile.details != nil }
            if openProject {
                host.wordCounts(projectID: project.id, refresh: true)
                try settle { host.wordCountLibrary(projectID: project.id) != nil }
            }
        }

        var counts: WordCountModel { host.wordCounts(projectID: project.id) }
        var library: WordCountLibrary? { host.wordCountLibrary(projectID: project.id) }

        /// Waits until every body is saved, no count read is waiting and the condition holds.
        func settle(_ condition: () -> Bool = { true }) throws {
            try BindingAcceptance.wait {
                host.canNavigate && !host.isBusy && host.wordCountLibrary(projectID: project.id) != nil
                    && counts.isIdle && condition()
            }
        }

        func journal() throws -> Int64 { try BindingAcceptance.elementCount(directory, "sync_change_set") }

        /// Every node's and body's `updated_at`.
        func stamps() throws -> [String] {
            try Fixture.query(in: directory, sql: """
                SELECT n.id, n.updated_at AS node, c.updated_at AS body
                FROM book_node n LEFT JOIN node_content c ON c.node_id = n.id ORDER BY n.id
                """).map { row in
                ["id", "node", "body"].map { key -> String in
                    if case .text(let value)? = row[key] { return value }
                    return "-"
                }.joined(separator: "|")
            }
        }

        /// AppDelegate.updateWordStatus over the active tab.
        func statusLine() -> String {
            var focus = WordCountFocus.none
            if host.activeProject?.id == project.id {
                if let id = host.activeChapter?.id ?? host.activeDrift?.id {
                    focus = .node(id)
                } else if let storyline = host.activeStoryline, let memberships = host.storylineLibrary(projectID: project.id) {
                    focus = .storyline(memberships.chapters(storylineID: storyline.id).map(\.chapterId))
                }
            }
            return WordCountText.statusLine(library, focus: focus)
        }

        func chapterPage(_ id: String) -> MacChapterPageView? {
            host.retainedChapterPage(pane: 0, scope: ChapterScope(projectID: project.id, chapterID: id))
        }

        func driftPage(_ id: String) -> MacDriftPageView? {
            host.retainedDriftPage(pane: 0, scope: DriftScope(projectID: project.id, driftID: id))
        }

        /// The count an outline chapter row draws; nil when it shows none.
        func outlineWords(_ chapterID: String) -> String? {
            outlineController.rowView(entryID: chapterID)
                .flatMap { BindingAcceptance.wordDescendant($0, "outline-words-\(chapterID)") as? NSTextField }?.stringValue
        }

        /// The count a 漂流 panel row draws; nil when it shows none.
        func driftWords(_ driftID: String) -> String? {
            guard let row = driftController.rows.first(where: { if case .drift(let drift, _) = $0 { return drift.id == driftID }; return false }) else {
                return nil
            }
            return (BindingAcceptance.wordDescendant(driftController.cellView(row), "drift-words-\(driftID)") as? NSTextField)?.stringValue
        }

        func close() throws {
            try settle()
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "Word count workspace failed to close")
            window.close()
        }

        func remove() { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
    }

    fileprivate static func wordDescendant(_ view: NSView, _ identifier: String) -> NSView? {
        if view.accessibilityIdentifier() == identifier { return view }
        for child in view.subviews { if let found = wordDescendant(child, identifier) { return found } }
        return nil
    }

    /// Appends text at the end of the body, as typing there would.
    private static func append(_ view: NativeDocumentView, _ text: String) {
        view.textView.insertText(text, replacementRange: NSRange(location: (view.textView.string as NSString).length, length: 0))
    }

    /// A page header's visible count, or nil while hidden.
    private static func header(_ label: NSTextField) -> String? { label.isHidden ? nil : label.stringValue }

    static func wordCountAcceptance() throws -> [String] {
        try wordCountFormats()
        try chapterTypingCounts()
        try driftCounts()
        try projectOpenReconcile()
        try trashRestoreAndColdReopen()
        return [
            "AppKit CJK and Latin typing in a chapter page updates its header, the outline row, the status line and the project sheet total after one debounced read per burst, an unchanged save reads nothing, undo and redo follow, a 1,234-word chapter reads 1.2k in rows, and counting and reconcile write no journal rows or stamps",
            "AppKit drift page and 漂流 panel rows show the drift's count while the book total counts chapters only, and drift trash and restore remove and return it without journal rows from counting",
            "AppKit project open reconciles stale and uncounted chapters that were never opened, showing 统计中… until every chapter is counted and nothing for an uncounted row, without journal rows or stamp changes",
            "AppKit chapter trash removes its count from the book total and outline and restore returns it, and a cold reopen shows 统计中… in the page header until the reconciled counts match",
        ]
    }

    // MARK: Formats

    /// The renderer's number formats and wording.
    private static func wordCountFormats() throws {
        try require(WordCountText.grouped(1_234_567) == "1,234,567" && WordCountText.full(0) == "0 字" && WordCountText.full(1234) == "1,234 字",
            "Grouped counts did not match toLocaleString")
        try require([0, 999, 1000, 1250, 9949, 9950, 12_499, 12_500].map(WordCountText.compact)
            == ["0 字", "999 字", "1.0k 字", "1.3k 字", "9.9k 字", "10.0k 字", "12k 字", "13k 字"],
            "Compact row counts did not match the chapter panel")
        let partial = WordCountLibrary([WorkspaceNodeWordCount(nodeId: "a", kind: "chapter", wordCount: 5),
                                        WorkspaceNodeWordCount(nodeId: "b", kind: "chapter", wordCount: nil),
                                        WorkspaceNodeWordCount(nodeId: "d", kind: "drift", wordCount: 7)])
        try require(!partial.ready && partial.chapterTotal == 5 && partial.driftTotal == 7 && partial.total(chapterIDs: ["a", "b"]) == nil
            && WordCountText.statusLine(nil, focus: .node("a")) == "正文统计中"
            && WordCountText.statusLine(partial, focus: .node("a")) == "当前 5 字 · 全书 统计中…"
            && WordCountText.statusLine(partial, focus: .node("b")) == "全书 统计中…"
            && WordCountText.statusLine(partial, focus: .storyline(["a", "b"])) == "故事线 统计中… · 全书 统计中…"
            && WordCountText.statusLine(partial, focus: .storyline(["a"])) == "故事线 5 字 · 全书 统计中…",
            "The status line did not follow the renderer's wording")
    }

    // MARK: (a) Chapter typing

    private static func chapterTypingCounts() throws {
        let harness = try WordCountHarness(titles: ["启程", "航行"])
        defer { harness.remove() }
        let (host, project, chapters, counts) = (harness.host, harness.project, harness.chapters, harness.counts)
        let (first, second) = (chapters[0].id, chapters[1].id)
        // Opening the project reconciled once; new chapters count 0, so the book is ready.
        try require(counts.reconciles == 1 && counts.failures.isEmpty && harness.library?.ready == true
            && harness.library?.chapterTotal == 0 && harness.library?.count(nodeID: first) == 0,
            "Opening the project did not reconcile ready counts")
        try require(harness.outlineWords(first) == "0 字" && harness.statusLine() == "全书 0 字"
            && harness.sheet.wordsLabel.stringValue == "全书 0 字", "The outline, status line or sheet did not show the empty book")

        let body: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapters[0], completion: $0) }
        try elementSettled(host, body)
        try harness.settle()
        guard let page = harness.chapterPage(first) else { throw LabError.message("The chapter tab has no page") }
        try require(header(page.wordCountLabel) == "0 字" && harness.statusLine() == "当前 0 字 · 全书 0 字",
            "The chapter page header did not show its count")

        // Three edits in one burst are saved one by one and read once.
        let reads = counts.reads
        let reconciles = counts.reconciles
        append(body, "他说 hello, ")
        append(body, "world！")
        append(body, "钟楼")
        try elementSettled(host, body)
        try harness.settle { harness.library?.count(nodeID: first) == 6 }
        try require(counts.reads == reads + 1 && counts.reconciles == reconciles,
            "A burst of saves was not counted by one debounced read: \(counts.reads - reads) reads")
        try require(body.textView.string == "他说 hello, world！钟楼" && header(page.wordCountLabel) == "6 字"
            && harness.outlineWords(first) == "6 字" && harness.outlineWords(second) == "0 字"
            && harness.statusLine() == "当前 6 字 · 全书 6 字" && harness.sheet.wordsLabel.stringValue == "全书 6 字",
            "Typing did not reach the header, the outline, the status line and the sheet")

        // 保存正文 saves the same body again at the same revision: nothing is read.
        let typed = counts.reads
        body.binding.retrySave()
        try elementSettled(host, body)
        try harness.settle()
        try require(counts.reads == typed && harness.library?.count(nodeID: first) == 6 && header(page.wordCountLabel) == "6 字",
            "Saving an unchanged body read the counts again or changed them")

        // Undo and redo are saves too.
        body.undoProse()
        try elementSettled(host, body)
        try harness.settle { (harness.library?.count(nodeID: first) ?? 6) < 6 }
        let undone = harness.library?.count(nodeID: first) ?? -1
        try require(header(page.wordCountLabel) == WordCountText.full(undone) && harness.outlineWords(first) == WordCountText.compact(undone)
            && harness.statusLine() == "当前 \(undone) 字 · 全书 \(undone) 字", "Undo did not update the counts: \(undone)")
        body.redoProse()
        try elementSettled(host, body)
        try harness.settle { harness.library?.count(nodeID: first) == 6 }
        try require(header(page.wordCountLabel) == "6 字" && harness.outlineWords(first) == "6 字", "Redo did not restore the count")

        // A long chapter reads compact in rows and grouped in its header.
        let long: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapters[1], completion: $0) }
        try elementSettled(host, long)
        append(long, String(repeating: "雨", count: 1230) + " bells ring toll now")
        try elementSettled(host, long)
        try harness.settle { harness.library?.count(nodeID: second) == 1234 }
        guard let longPage = harness.chapterPage(second) else { throw LabError.message("The second chapter tab has no page") }
        let outlineLabel = harness.outlineController.rowView(entryID: second)
            .flatMap { wordDescendant($0, "outline-words-\(second)") as? NSTextField }
        try require(header(longPage.wordCountLabel) == "1,234 字" && harness.outlineWords(second) == "1.2k 字"
            && outlineLabel?.accessibilityLabel() == "1,234 字" && harness.library?.chapterTotal == 1240
            && harness.statusLine() == "当前 1,234 字 · 全书 1,240 字" && harness.sheet.wordsLabel.stringValue == "全书 1,240 字",
            "A long chapter did not read 1.2k in rows and 1,234 in its header")
        // Switching tabs changes the status line only.
        let _: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapters[0], completion: $0) }
        try harness.settle()
        try require(harness.statusLine() == "当前 6 字 · 全书 1,240 字" && header(page.wordCountLabel) == "6 字",
            "The status line did not follow the active tab")

        // Counting and reconciling write no original and keep every stamp.
        let journal = try harness.journal(), stamps = try harness.stamps()
        counts.reconcile()
        try harness.settle { counts.reconciles == reconciles + 1 }
        counts.scheduleRefresh()
        try harness.settle()
        try require(counts.failures.isEmpty && harness.journal() == journal && harness.stamps() == stamps
            && harness.library?.chapterTotal == 1240, "Counting or reconciling wrote a journal row or a stamp")
        try harness.close()
    }

    // MARK: (b) Drifts

    private static func driftCounts() throws {
        let harness = try WordCountHarness(titles: ["启程"])
        defer { harness.remove() }
        let (host, project, drifts) = (harness.host, harness.project, harness.drifts)
        // A new drift joins the counts through the panel's library reply.
        let drift: WorkspaceDrift = try elementResult { drifts.createDrift(title: "潮汐手记", groupID: nil, completion: $0) }
        try harness.settle { harness.library?.count(nodeID: drift.id) == 0 }
        try require(harness.driftWords(drift.id) == "0 字", "The panel did not show the new drift's count")

        let body: NativeDocumentView = try elementResult { host.open(project: project, drift: drift, completion: $0) }
        try elementSettled(host, body)
        append(body, "雨夜 bells ring")
        try elementSettled(host, body)
        try harness.settle { harness.library?.count(nodeID: drift.id) == 4 }
        guard let page = harness.driftPage(drift.id) else { throw LabError.message("The drift tab has no page") }
        // The book total counts chapters only, as the renderer's does.
        try require(header(page.wordCountLabel) == "4 字" && harness.driftWords(drift.id) == "4 字"
            && harness.library?.driftTotal == 4 && harness.library?.chapterTotal == 0
            && harness.statusLine() == "当前 4 字 · 全书 0 字" && harness.sheet.wordsLabel.stringValue == "全书 0 字",
            "The drift count did not reach its page and panel row, or entered the book total")

        // Trash (as the panel's 移到回收站) removes it; restore returns it with its count.
        var journal = try harness.journal()
        let trashed: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
            host.trashDrift(projectID: project.id, driftID: drift.id, completion: $0)
        }
        drifts.apply(trashed.library, message: nil)
        try harness.settle { harness.library?.contains(nodeID: drift.id) == false }
        try require(harness.driftPage(drift.id) == nil && harness.driftWords(drift.id) == nil && harness.library?.driftTotal == 0
            && harness.journal() == journal + 1, "Drift trash did not remove its count, or counting wrote a journal row")
        journal = try harness.journal()
        let restored: WorkspaceDrift = try elementResult { drifts.restore(id: drift.id, completion: $0) }
        try harness.settle { harness.library?.count(nodeID: restored.id) == 4 }
        try require(harness.driftWords(drift.id) == "4 字" && harness.library?.driftTotal == 4 && harness.journal() == journal + 1,
            "Drift restore did not return its count, or counting wrote a journal row")
        try harness.close()
    }

    // MARK: (c) Project open

    private static func projectOpenReconcile() throws {
        typealias Fixture = WorkspaceRemoteProseFixture
        let session = try WordCountHarness(titles: ["启程", "航行", "归岸"])
        defer { session.remove() }
        let (lit, stale, blank) = (session.chapters[0].id, session.chapters[1].id, session.chapters[2].id)
        for (chapter, text) in [(session.chapters[0], "灯塔 light"), (session.chapters[1], "他说 hello, world！钟楼")] {
            let body: NativeDocumentView = try elementResult { session.host.open(project: session.project, chapter: chapter, completion: $0) }
            try elementSettled(session.host, body)
            append(body, text)
            try elementSettled(session.host, body)
        }
        try session.settle { session.library?.count(nodeID: stale) == 6 }
        try session.close()
        // Synthetic rows as a build before stored counts left them: one body
        // with a stale count, one never counted.
        try Fixture.execute(in: session.directory, sql: "UPDATE book_node SET word_count = 0, word_count_basis_revision = 1 WHERE id = ?",
                            parameters: [.text(stale)])
        try Fixture.execute(in: session.directory, sql: """
            UPDATE book_node SET word_count = 0, word_count_basis_kind = NULL, word_count_basis_hash = NULL,
                word_count_basis_revision = NULL WHERE id = ?
            """, parameters: [.text(blank)])

        let harness = try WordCountHarness(directory: session.directory, openProject: false)
        let (host, project) = (harness.host, harness.project)
        let journal = try harness.journal(), stamps = try harness.stamps()
        // Before the project opens, counts are stale and one chapter has none.
        let before: WorkspaceWordCounts = try elementResult { harness.workspace.wordCounts(projectID: project.id, completion: $0) }
        let raw = WordCountLibrary(before.counts)
        try require(raw.count(nodeID: stale) == 0 && raw.count(nodeID: blank) == nil && raw.contains(nodeID: blank) && !raw.ready,
            "The synthetic stale and uncounted rows did not read as such")
        harness.outline.applyWordCounts(raw)
        harness.profile.applyWordCounts(raw)
        try require(harness.outlineWords(blank) == nil && harness.outlineWords(stale) == "0 字" && harness.outlineWords(lit) == "3 字"
            && harness.sheet.wordsLabel.stringValue == "全书 统计中…"
            && WordCountText.statusLine(raw, focus: .none) == "全书 统计中…", "Incomplete counts were not shown as 统计中…")

        // AppDelegate.selectProject: the first read reconciles.
        let model = host.wordCounts(projectID: project.id, refresh: true)
        try require(!model.loaded && harness.statusLine() == "正文统计中", "The status line did not wait for the first read")
        try harness.settle { model.loaded }
        try require(model.reconciles == 1 && model.reads == 1 && model.failures.isEmpty && harness.library?.ready == true
            && harness.library?.count(nodeID: stale) == 6 && harness.library?.count(nodeID: blank) == 0
            && harness.library?.count(nodeID: lit) == 3 && harness.library?.chapterTotal == 9,
            "Opening the project did not reconcile the never-opened chapters: \(String(describing: harness.library?.nodes))")
        try require(harness.outlineWords(stale) == "6 字" && harness.outlineWords(blank) == "0 字"
            && harness.sheet.wordsLabel.stringValue == "全书 9 字" && harness.statusLine() == "全书 9 字",
            "The outline and the sheet did not follow the reconciled counts")
        let basis = try Fixture.query(in: harness.directory, sql: "SELECT word_count_basis_kind AS kind FROM book_node WHERE id = ?",
                                      parameters: [.text(blank)])
        try require(basis.first?["kind"] == .text("yjs") && harness.journal() == journal && harness.stamps() == stamps,
            "Reconcile wrote a journal row, a stamp, or no Yjs basis")
        // Selecting the project again only reads counts.
        host.wordCounts(projectID: project.id, refresh: true)
        try harness.settle()
        try require(model.reconciles == 1 && model.reads == 2 && harness.journal() == journal, "Selecting the project again reconciled")
        try harness.close()
    }

    // MARK: (d) Trash, restore and cold reopen

    private static func trashRestoreAndColdReopen() throws {
        let harness = try WordCountHarness(titles: ["启程", "航行"])
        defer { harness.remove() }
        let (host, project, chapters) = (harness.host, harness.project, harness.chapters)
        let (first, second) = (chapters[0].id, chapters[1].id)
        for (chapter, text) in [(chapters[0], "他说 hello, world！钟楼"), (chapters[1], "结尾 end 2026")] {
            let body: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
            try elementSettled(host, body)
            append(body, text)
            try elementSettled(host, body)
        }
        try harness.settle { harness.library?.chapterTotal == 10 }
        try require(harness.statusLine() == "当前 4 字 · 全书 10 字", "Both chapters were not counted")

        // Trash as AppDelegate.changeChapterTrash does; the outline is read again.
        var journal = try harness.journal()
        let trashed: WorkspaceChapterTrashReply = try elementResult { host.trash(projectID: project.id, chapterID: second, completion: $0) }
        host.applyChapters(projectID: project.id, chapters: trashed.chapters, trashed: trashed.trashedChapters)
        harness.outline.load()
        try harness.settle { harness.library?.contains(nodeID: second) == false && harness.outline.entries.count == 1 }
        try require(harness.library?.chapterTotal == 6 && harness.library?.ready == true && harness.outlineController.rowView(entryID: second) == nil
            && harness.statusLine() == "当前 6 字 · 全书 6 字" && harness.sheet.wordsLabel.stringValue == "全书 6 字"
            && harness.journal() == journal + 1, "Trash did not remove the chapter from the book total, or counting wrote a journal row")
        journal = try harness.journal()
        let restored: WorkspaceChapterTrashReply = try elementResult {
            harness.workspace.restoreChapter(projectID: project.id, chapterID: second, completion: $0)
        }
        host.applyChapters(projectID: project.id, chapters: restored.chapters, trashed: restored.trashedChapters)
        harness.outline.load()
        try harness.settle { harness.library?.count(nodeID: second) == 4 && harness.outline.entries.count == 2 }
        try require(harness.library?.chapterTotal == 10 && harness.outlineWords(second) == "4 字"
            && harness.sheet.wordsLabel.stringValue == "全书 10 字" && harness.journal() == journal + 1,
            "Restore did not return the chapter's count, or counting wrote a journal row")
        let counted = harness.library
        try harness.close()

        // Cold reopen: the first page shows 统计中… until the project's reconcile returns.
        journal = try harness.journal()
        let stamps = try harness.stamps()
        let cold = try WordCountHarness(directory: harness.directory, openProject: false)
        var pending: String??
        cold.host.open(project: project, chapter: chapters[0]) { result in
            pending = (try? result.get()).map { _ in cold.chapterPage(first).flatMap { header($0.wordCountLabel) } }
        }
        try wait { pending != nil }
        try require(pending! == WordCountText.counting, "The cold page header did not wait with 统计中…: \(String(describing: pending))")
        try cold.settle { cold.library != nil }
        guard let page = cold.chapterPage(first) else { throw LabError.message("The cold chapter tab has no page") }
        try require(cold.counts.reconciles == 1 && cold.library == counted && header(page.wordCountLabel) == "6 字"
            && cold.outlineWords(second) == "4 字" && cold.statusLine() == "当前 6 字 · 全书 10 字"
            && cold.sheet.wordsLabel.stringValue == "全书 10 字", "Counts did not survive cold reopen")
        try require(cold.journal() == journal && cold.stamps() == stamps, "Cold reopen and reconcile wrote a journal row or a stamp")
        try cold.close()
    }
}
