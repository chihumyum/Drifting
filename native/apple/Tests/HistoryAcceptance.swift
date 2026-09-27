import AppKit

/// 历史版本… through the real AppKit sheet, tab host, document views and
/// the Rust workspace, wired as AppDelegate wires them. Every text is
/// synthetic and typed through NSTextView.
extension BindingAcceptance {
    private final class HistoryHarness {
        let directory: URL
        let workspace: LabWorkspaceCore
        let project: WorkspaceProject
        let chapters: [WorkspaceChapter]
        let window: NSWindow
        let host: MacChapterWorkspace
        let journal: JournalProbe
        /// Answers the sheet's confirmation; nil cancels.
        var answer: ((NSAlert) -> NSApplication.ModalResponse)?
        var restored: [Bool] = []
        var historyRequests = 0

        init() throws {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                .appendingPathComponent("apple-native-lab")
            self.directory = directory
            journal = JournalProbe(directory: directory)
            let workspace = LabWorkspaceCore(directory: directory)
            self.workspace = workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(listed.isEmpty, "History fixture was not isolated")
            project = try BindingAcceptance.elementResult { workspace.createProject(name: "历史合成项目", completion: $0) }
            let projectID = project.id
            chapters = try ["雨夜", "北塔"].map { title in
                try BindingAcceptance.elementResult { workspace.createChapter(projectID: projectID, title: title, completion: $0) }
            }
            (window, host) = BindingAcceptance.elementHost(workspace)
            host.onShowHistory = { [weak self] in self?.historyRequests += 1 }
        }

        func open(_ chapter: WorkspaceChapter) throws -> NativeDocumentView {
            let view: NativeDocumentView = try BindingAcceptance.elementResult { host.open(project: project, chapter: chapter, in: 0, completion: $0) }
            try settle(view)
            return view
        }

        func settle(_ view: NativeDocumentView) throws {
            try BindingAcceptance.wait {
                !self.host.isBusy && view.binding.state != nil && !view.binding.hasPendingWork && !view.binding.store.hasScheduledLinks
            }
        }

        /// Types at a UTF-16 location, or at the end.
        func type(_ view: NativeDocumentView, _ text: String, at location: Int? = nil) throws {
            let at = location ?? (view.textView.string as NSString).length
            view.textView.insertText(text, replacementRange: NSRange(location: at, length: 0))
            try settle(view)
        }

        func delete(_ view: NativeDocumentView, _ range: NSRange) throws {
            view.textView.insertText("", replacementRange: range)
            try settle(view)
        }

        func close(_ scope: DocumentScope) throws {
            let closed: Bool = try BindingAcceptance.elementResult { host.closeTab(pane: 0, scope: scope, completion: $0) }
            try BindingAcceptance.require(closed, "The tab did not close")
        }

        func scope(_ chapter: WorkspaceChapter) -> DocumentScope { .chapter(ChapterScope(projectID: project.id, chapterID: chapter.id)) }

        /// Opens, edits and closes a chapter: closing captures a version.
        func draft(_ chapter: WorkspaceChapter, _ edit: (NativeDocumentView) throws -> Void) throws {
            let view = try open(chapter)
            try edit(view)
            try close(scope(chapter))
        }

        func target(_ chapter: WorkspaceChapter) -> VersionHistoryTarget {
            VersionHistoryTarget(projectID: project.id, kind: "chapter", id: chapter.id, title: chapter.title)
        }

        /// A model and sheet as AppDelegate.showHistory builds them.
        func sheet(_ target: VersionHistoryTarget) throws -> VersionHistorySheet {
            let model = VersionHistoryModel(workspace: workspace, target: target)
            let host = self.host
            model.onRestored = { [weak self] live in
                self?.restored.append(live)
                host.adoptRestoredVersion(target, live: live)
            }
            let sheet = VersionHistorySheet(model: model)
            sheet.presentAlert = { [weak self] alert, done in
                alert.layout()
                done(self?.answer?(alert) ?? .alertSecondButtonReturn)
            }
            sheet.begin(in: nil)
            model.load()
            try settled(sheet)
            return sheet
        }

        func settled(_ sheet: VersionHistorySheet, file: String = #fileID, line: Int = #line) throws {
            try BindingAcceptance.wait(file: file, line: line) { sheet.model.loaded && !sheet.model.busy }
            sheet.window.contentView?.layoutSubtreeIfNeeded()
        }

        func entry(_ sheet: VersionHistorySheet, text: String) throws -> WorkspaceHistoryEntry {
            guard let entry = sheet.model.entries.first(where: { $0.text == text }) else {
                throw LabError.message("No version \(text): \(sheet.model.entries.map(\.text))")
            }
            return entry
        }

        func stored(_ target: VersionHistoryTarget) throws -> String {
            let projectID = project.id
            let prose: WorkspaceAgentProse = try BindingAcceptance.elementResult {
                workspace.agentReadProse(projectID: projectID, kind: target.kind, id: target.id, completion: $0)
            }
            return prose.text
        }

        func snapshots() throws -> Int64 { try journal.count("entity_snapshot_history") }

        func shutdown() throws {
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "History workspace failed to close")
            window.close()
        }

        func remove() { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
    }

    private static func historyDescendant(_ view: NSView, _ identifier: String) -> NSView? {
        if view.accessibilityIdentifier() == identifier { return view }
        for child in view.subviews { if let found = historyDescendant(child, identifier) { return found } }
        return nil
    }

    static func historyAcceptance() throws -> [String] {
        try historyTimes()
        try historyVersionsAppear()
        try historyPreview()
        try historyRestoreOpen()
        try historyRestoreClosed()
        try historyRefusals()
        return [
            "AppKit 历史版本 times read 刚刚, N 分钟前, 今天, 昨天, a date this year and a date with its year, and rows name why a version was kept (自动保存, 关闭时, 恢复前) and its word count, leaving both out for older versions",
            "AppKit 历史版本 lists versions captured on save and close newest first with relative times, the title at that time, why each was kept and its word count, capturing without journal rows, reachable from every page kind's pane header",
            "AppKit 历史版本 previews the selected version read-only, marking text the current body lacks on a green wash and struck-through text the version lacks, identical versions as such, and the plain version without the diff",
            "AppKit 历史版本 restore into an open chapter after confirmation updates the editor in place with one original, keeps the replaced text as a version, and one undo returns the text before redo restores the version; restoring over newer text keeps it as a version marked 恢复前 with its word count",
            "AppKit 历史版本 restore into a closed chapter through a temporary owner and into an open element page reaches the stored body and the editor",
            "AppKit 历史版本 refuses a version of another body, a missing version and queued input in Chinese in the sheet without changing the body or the journal, and cancelling the confirmation writes nothing",
        ]
    }

    // MARK: (a) Times

    private static func historyTimes() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        let now = VersionHistoryTime.date("2026-09-27T07:00:00.000Z")!   // 15:00 in Shanghai
        let cases: [(String, String)] = [
            ("2026-09-27T06:59:40.000Z", "刚刚"),
            ("2026-09-27T06:55:00Z", "5 分钟前"),
            ("2026-09-27T01:30:00.000Z", "今天 09:30"),
            ("2026-09-26T14:05:00.000Z", "昨天 22:05"),
            ("2026-03-05T02:00:00.000Z", "3月5日 10:00"),
            ("2025-12-31T15:59:00.000Z", "2025年12月31日 23:59"),
        ]
        for (iso, expected) in cases {
            let label = VersionHistoryTime.label(iso, now: now, calendar: calendar)
            try require(label == expected, "\(iso) reads \(label) instead of \(expected)")
        }
        try require(VersionHistoryTime.exact("2026-09-27T01:30:05.000Z", calendar: calendar) == "2026年9月27日 09:30:05", "The exact time differs")
        // Why a version was kept and its words; versions from before both were recorded lack them.
        let json = #"{"entries":[{"id":"a","createdAt":"2026-09-27T06:59:40.000Z","meta":{"title":"雨夜","writingStatus":"finished","reason":"periodic","wordCount":1234},"text":"甲"},{"id":"b","createdAt":"2026-09-27T06:59:40.000Z","meta":{"title":"雨夜","reason":"close","wordCount":0},"text":""},{"id":"c","createdAt":"2026-09-27T06:59:40.000Z","meta":{"name":"北塔","reason":"restore"},"text":"乙"},{"id":"d","createdAt":"2026-09-27T06:59:40.000Z","meta":{"title":"旧版"},"text":"丙"}]}"#
        let list = try JSONDecoder().decode(WorkspaceHistoryList.self, from: Data(json.utf8))
        let details = list.entries.map(VersionHistorySheet.details)
        try require(details == ["雨夜 · 已完成 · 自动保存 · 1,234 字", "雨夜 · 关闭时 · 0 字", "北塔 · 恢复前", "旧版"],
            "Row details differ: \(details)")
    }

    // MARK: (b) Versions appear

    private static func historyVersionsAppear() throws {
        let harness = try HistoryHarness()
        defer { harness.remove() }
        let rain = harness.chapters[0]
        try harness.draft(rain) { try harness.type($0, "第一稿。") }
        // The second draft: its close captures a version without a journal row.
        let view = try harness.open(rain)
        try harness.type(view, "改写：", at: 0)
        // The pane header offers 历史版本… for the active page.
        guard let button = historyDescendant(harness.host, "show-history-0") as? NSButton else { throw LabError.message("No pane history button") }
        try require(button.isEnabled && harness.host.activeHistoryTarget == harness.target(rain), "The pane button does not target the chapter")
        button.performClick(nil)
        try require(harness.historyRequests == 1, "The pane button did not ask for history")
        let snapshots = try harness.snapshots(), mark = try harness.journal.mark()
        try harness.close(harness.scope(rain))
        try require(try harness.snapshots() == snapshots + 1, "Closing did not capture a version")
        try harness.journal.expect([], since: mark, "Capturing on close")

        // A rename after these versions: they keep the title of their time.
        let projectID = harness.project.id
        let renamed: WorkspaceChapter = try elementResult {
            harness.workspace.renameChapter(projectID: projectID, chapterID: rain.id, title: "雨夜（二稿）", completion: $0)
        }
        try harness.draft(renamed) { try harness.type($0, "终稿：", at: 0) }

        let sheet = try harness.sheet(VersionHistoryTarget(projectID: projectID, kind: "chapter", id: rain.id, title: renamed.title))
        let model = sheet.model
        let texts = model.entries.map(\.text)
        try require(Array(texts.prefix(3)) == ["终稿：改写：第一稿。", "改写：第一稿。", "第一稿。"], "Versions are not newest first: \(texts)")
        try require(model.entries[0].meta?.displayName == "雨夜（二稿）" && model.entries[1].meta?.displayName == "雨夜"
            && model.entries[1].meta?.writingStatus == "draft", "Versions do not keep the title of their time")
        try require(sheet.table.numberOfRows == model.entries.count && model.selectedID == model.entries[0].id, "The list or its selection differs")
        let row = sheet.rowView(model.entries[1])
        guard let words = model.entries[1].meta?.wordCount, model.entries[1].meta?.reason == "close", words > 0 else {
            throw LabError.message("The closed version lacks its reason or words: \(String(describing: model.entries[1].meta))")
        }
        try require(row.accessibilityLabel() == "刚刚 雨夜 · 草稿 · 关闭时 · \(words) 字", "The row reads \(row.accessibilityLabel() ?? "")")
        try require(model.entries.allSatisfy { $0.meta?.reasonLabel != nil && $0.meta?.wordCount != nil }, "A new version lacks its reason or words")
        try require(model.entries.contains { $0.meta?.reason == "periodic" }, "No version was kept by 自动保存: \(model.entries.map { $0.meta?.reason ?? "" })")
        try require(historyDescendant(sheet.window.contentView!, "history-title").flatMap { ($0 as? NSTextField)?.stringValue }
            == "历史版本 · 章节“雨夜（二稿）”", "The sheet title differs")
        try require(model.status.contains("个版本") && !model.statusIsError, "The status differs: \(model.status)")

        // Drift, element and storyline pages have 历史版本 too.
        let drift: WorkspaceDriftReply<WorkspaceDrift> = try elementResult { harness.workspace.createDrift(projectID: projectID, title: "旧信", groupID: nil, completion: $0) }
        let category: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            harness.workspace.createElementCategory(projectID: projectID, name: "人物", completion: $0)
        }
        let element: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            harness.workspace.createElement(projectID: projectID, categoryID: category.result!.id, name: "守塔人", completion: $0)
        }
        let storyline: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult {
            harness.workspace.createStoryline(projectID: projectID, name: "主线", completion: $0)
        }
        for (kind, open) in [("drift", { harness.host.open(project: harness.project, drift: drift.result!, in: 0, completion: $0) }),
                             ("element", { harness.host.open(project: harness.project, element: element.result!, in: 0, completion: $0) }),
                             ("storyline", { harness.host.open(project: harness.project, storyline: storyline.result!, in: 0, completion: $0) })]
            as [(String, (@escaping (Result<NativeDocumentView, Error>) -> Void) -> Void)] {
            let page: NativeDocumentView = try elementResult(open)
            try harness.settle(page)
            try harness.type(page, "\(kind)正文。")
            guard let target = harness.host.activeHistoryTarget, target.kind == kind else { throw LabError.message("No \(kind) history target") }
            try require(button.isEnabled, "The pane button is disabled on a \(kind) page")
            button.performClick(nil)
            try harness.close(target.scope)
            let pageSheet = try harness.sheet(target)
            try require(pageSheet.model.entries.first?.text == "\(kind)正文。", "\(kind) versions differ: \(pageSheet.model.entries.map(\.text))")
            let name = pageSheet.model.entries.first?.meta?.displayName
            try require(name == target.title, "\(kind) version names \(String(describing: name))")
        }
        try require(harness.historyRequests == 4, "The pane button asked \(harness.historyRequests) times")
        try harness.shutdown()
    }

    // MARK: (c) Preview

    private static func historyPreview() throws {
        let harness = try HistoryHarness()
        defer { harness.remove() }
        let rain = harness.chapters[0]
        try harness.draft(rain) { view in
            try harness.type(view, "钟声响起。")
            try harness.type(view, "\n")
            try harness.type(view, "北塔的灯亮着。")
        }
        try harness.draft(rain) { view in
            try harness.type(view, "再次", at: 2)
            try harness.delete(view, NSRange(location: 11, length: 1))
            try harness.type(view, "\n")
            try harness.type(view, "她推开了门。")
        }
        let sheet = try harness.sheet(harness.target(rain))
        let model = sheet.model
        try require(model.currentText == "钟声再次响起。\n北塔的亮着。\n她推开了门。", "The current text differs: \(model.currentText ?? "nil")")
        // The newest version is the current text.
        try require(sheet.legend.stringValue == "这个版本与当前正文相同。", "The newest version is not identical: \(sheet.legend.stringValue)")
        let first = try harness.entry(sheet, text: "钟声响起。\n北塔的灯亮着。")
        sheet.select(entryID: first.id)
        let preview = sheet.previewView
        try require(!preview.isEditable, "The preview is editable")
        let shown = preview.string as NSString
        try require(shown as String == "钟声再次响起。\n北塔的灯亮着。\n她推开了门。", "The marked preview reads \(shown)")
        func struck(_ text: String) -> Bool {
            let range = shown.range(of: text)
            guard range.location != NSNotFound else { return false }
            var effective = NSRange()
            let style = preview.textStorage?.attribute(.strikethroughStyle, at: range.location, longestEffectiveRange: &effective, in: range) as? Int
            return style == NSUnderlineStyle.single.rawValue && effective == range
        }
        func washed(_ text: String) -> Bool {
            let range = shown.range(of: text)
            guard range.location != NSNotFound else { return false }
            return preview.textStorage?.attribute(.backgroundColor, at: range.location, effectiveRange: nil) != nil
                && preview.textStorage?.attribute(.strikethroughStyle, at: range.location, effectiveRange: nil) == nil
        }
        try require(struck("再次") && struck("\n她推开了门。"), "Text the version lacks is not struck through")
        try require(washed("灯"), "Text the current body lacks is not on a wash")
        try require(!struck("钟声") && !washed("钟声") && !washed("北塔的"), "Unchanged text is marked")
        try require(sheet.legend.stringValue.hasPrefix("绿色底"), "The legend differs: \(sheet.legend.stringValue)")
        let segments = model.segments(of: first) ?? []
        try require(segments.filter { $0.kind != .removed }.map(\.text).joined() == first.text
            && segments.filter { $0.kind != .added }.map(\.text).joined() == model.currentText,
            "The marks do not spell both texts")
        // Without the diff: the version alone.
        sheet.diffCheckbox.performClick(nil)
        try require(preview.string == first.text && preview.textStorage?.attribute(.strikethroughStyle, at: 0, effectiveRange: nil) == nil,
            "The plain preview differs: \(preview.string)")
        try require(sheet.previewView.window === sheet.window && sheet.restoreButton.isEnabled, "The sheet is not ready to restore")
        try harness.shutdown()
    }

    // MARK: (d) Restore into an open chapter

    private static func historyRestoreOpen() throws {
        let harness = try HistoryHarness()
        defer { harness.remove() }
        let rain = harness.chapters[0]
        try harness.draft(rain) { try harness.type($0, "第一稿。") }
        try harness.draft(rain) { try harness.type($0, "改写：", at: 0) }
        let view = try harness.open(rain)
        let sheet = try harness.sheet(harness.target(rain))
        let first = try harness.entry(sheet, text: "第一稿。")
        let count = sheet.model.entries.count
        sheet.select(entryID: first.id)
        var confirmation: NSAlert?
        harness.answer = { alert in confirmation = alert; return .alertFirstButtonReturn }
        let mark = try harness.journal.mark()
        sheet.restoreButton.performClick(nil)
        try harness.settled(sheet)
        try harness.settle(view)
        try require(confirmation?.informativeText.contains("先自动存为一个历史版本") == true
            && confirmation?.informativeText.contains("撤销") == true, "The confirmation does not explain the saved version and undo")
        try require(view.textView.string == "第一稿。" && harness.restored == [true], "The open editor did not adopt the version: \(view.textView.string)")
        try require(try harness.stored(harness.target(rain)) == "第一稿。", "The stored body differs")
        try harness.journal.expect([["yjs.update prose-document"]], since: mark, "The restore")
        try require(sheet.model.status.hasPrefix("已恢复到所选版本") && !sheet.model.statusIsError, "The sheet status differs: \(sheet.model.status)")
        try require(sheet.model.entries.count == count && sheet.model.entries.first?.text == "改写：第一稿。",
            "The replaced text is not the newest version: \(sheet.model.entries.map(\.text))")
        try require(sheet.legend.stringValue == "这个版本与当前正文相同。", "The restored version is not identical to the body")
        sheet.close()
        // One undo returns the text; redo restores the version.
        view.undoProse(); try harness.settle(view)
        try require(view.textView.string == "改写：第一稿。", "Undo did not return the text: \(view.textView.string)")
        view.redoProse(); try harness.settle(view)
        try require(view.textView.string == "第一稿。", "Redo did not restore the version")
        try harness.type(view, "续写。")
        try require(try harness.stored(harness.target(rain)) == "第一稿。续写。", "Typing after the restore was lost")
        // Restoring over the newer text keeps it as a version marked 恢复前.
        let again = try harness.sheet(harness.target(rain))
        harness.answer = { _ in .alertFirstButtonReturn }
        again.restore(snapshotID: try harness.entry(again, text: "改写：第一稿。").id)
        try harness.settled(again)
        try harness.settle(view)
        guard let kept = again.model.entries.first, kept.text == "第一稿。续写。", let words = kept.meta?.wordCount else {
            throw LabError.message("The replaced text was not kept: \(again.model.entries.map(\.text))")
        }
        try require(kept.meta?.reason == "restore" && VersionHistorySheet.details(kept) == "雨夜 · 草稿 · 恢复前 · \(words) 字" && words > 0,
            "The kept version reads \(VersionHistorySheet.details(kept))")
        again.close()
        try harness.shutdown()
    }

    // MARK: (e) Restore into a closed chapter and an open element

    private static func historyRestoreClosed() throws {
        let harness = try HistoryHarness()
        defer { harness.remove() }
        let rain = harness.chapters[0]
        try harness.draft(rain) { try harness.type($0, "第一稿。") }
        try harness.draft(rain) { try harness.type($0, "改写：", at: 0) }
        let sheet = try harness.sheet(harness.target(rain))
        harness.answer = { _ in .alertFirstButtonReturn }
        sheet.restore(snapshotID: try harness.entry(sheet, text: "第一稿。").id)
        try harness.settled(sheet)
        try require(harness.restored == [false] && !sheet.model.statusIsError, "The closed restore reported \(harness.restored): \(sheet.model.status)")
        try require(try harness.stored(harness.target(rain)) == "第一稿。", "The closed body was not restored")
        let view = try harness.open(rain)
        try require(view.textView.string == "第一稿。", "Reopening shows \(view.textView.string)")

        // An element page, open while its version is restored.
        let projectID = harness.project.id
        let category: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            harness.workspace.createElementCategory(projectID: projectID, name: "地点", completion: $0)
        }
        let created: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            harness.workspace.createElement(projectID: projectID, categoryID: category.result!.id, name: "北塔", completion: $0)
        }
        let element = created.result!
        let scope = DocumentScope.element(ElementScope(projectID: projectID, elementID: element.id))
        var page: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, element: element, in: 0, completion: $0) }
        try harness.settle(page)
        try harness.type(page, "塔高九层。")
        try harness.close(scope)
        page = try elementResult { harness.host.open(project: harness.project, element: element, in: 0, completion: $0) }
        try harness.settle(page)
        try harness.type(page, "顶层有灯。")
        guard let target = harness.host.activeHistoryTarget, target.kind == "element" else { throw LabError.message("No element target") }
        let elementSheet = try harness.sheet(target)
        elementSheet.restore(snapshotID: try harness.entry(elementSheet, text: "塔高九层。").id)
        try harness.settled(elementSheet)
        try harness.settle(page)
        try require(page.textView.string == "塔高九层。" && harness.restored == [false, true], "The element page did not adopt the version: \(page.textView.string)")
        try require(elementSheet.model.entries.contains { $0.text == "塔高九层。顶层有灯。" }, "The replaced element text is not a version")
        page.undoProse(); try harness.settle(page)
        try require(page.textView.string == "塔高九层。顶层有灯。", "Undo did not return the element text")
        try harness.shutdown()
    }

    // MARK: (f) Refusals

    private static func historyRefusals() throws {
        let harness = try HistoryHarness()
        defer { harness.remove() }
        let rain = harness.chapters[0], north = harness.chapters[1]
        try harness.draft(rain) { try harness.type($0, "雨夜的稿子。") }
        try harness.draft(north) { try harness.type($0, "北塔的稿子。") }
        try harness.draft(north) { try harness.type($0, "再改：", at: 0) }
        let rainSheet = try harness.sheet(harness.target(rain))
        let foreign = try harness.entry(rainSheet, text: "雨夜的稿子。")
        let sheet = try harness.sheet(harness.target(north))
        harness.answer = { _ in .alertFirstButtonReturn }
        var mark = try harness.journal.mark()
        sheet.restore(snapshotID: foreign.id)
        try harness.settled(sheet)
        try require(sheet.errorMessage == "这个历史版本不属于当前文档", "A foreign version was not refused: \(sheet.model.status)")
        try require(sheet.message.textColor == .systemRed, "The refusal is not shown as an error")
        sheet.restore(snapshotID: "missing-snapshot")
        try harness.settled(sheet)
        try require(sheet.errorMessage == "这个历史版本不存在", "A missing version was not refused: \(sheet.model.status)")
        // Cancelling the confirmation writes nothing.
        harness.answer = nil
        sheet.restore(snapshotID: try harness.entry(sheet, text: "北塔的稿子。").id)
        try require(!sheet.model.busy, "A cancelled restore started")
        try require(try harness.stored(harness.target(north)) == "再改：北塔的稿子。" && harness.restored.isEmpty, "A refusal changed the body")
        try harness.journal.expect([], since: mark, "Refused and cancelled restores")
        // Queued input in the open editor is refused before Rust.
        let view = try harness.open(north)
        view.textView.insertText("又", replacementRange: NSRange(location: 0, length: 0))
        harness.answer = { _ in .alertFirstButtonReturn }
        sheet.restore(snapshotID: try harness.entry(sheet, text: "北塔的稿子。").id)
        try require(sheet.errorMessage?.hasPrefix("正在输入或保存正文") == true, "Queued input was not refused: \(sheet.model.status)")
        try harness.settle(view)
        try require(view.textView.string == "又再改：北塔的稿子。" && harness.restored.isEmpty, "The queued input was not kept")
        mark = try harness.journal.mark()
        try require(try harness.stored(harness.target(north)) == "又再改：北塔的稿子。", "The stored body differs")
        try harness.journal.expect([], since: mark, "Reading after the refusal")
        try harness.shutdown()
    }
}
