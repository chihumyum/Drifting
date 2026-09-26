import AppKit

extension BindingAcceptance {
    private static func searchResult<T>(_ run: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
        var result: Result<T, Error>?
        run { result = $0 }; try wait { result != nil }
        return try result!.get()
    }

    private static func searchSettled(_ host: MacChapterWorkspace, _ view: NativeDocumentView) throws {
        try wait { !host.isBusy && view.binding.state != nil && !view.binding.hasPendingWork }
    }

    private static func searchFixture() throws -> (URL, LabWorkspaceCore, WorkspaceProject, [WorkspaceChapter]) {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let workspace = LabWorkspaceCore(directory: parent.appendingPathComponent("apple-native-lab"))
        let _: [WorkspaceProject] = try searchResult { workspace.projects(completion: $0) }
        let project: WorkspaceProject = try searchResult { workspace.createProject(name: "搜索合成项目", completion: $0) }
        let first: WorkspaceChapter = try searchResult {
            workspace.createChapter(projectID: project.id, title: "Harbor ALPHA", completion: $0)
        }
        let second: WorkspaceChapter = try searchResult {
            workspace.createChapter(projectID: project.id, title: "Cabin note", completion: $0)
        }
        return (parent, workspace, project, [first, second])
    }

    static func searchAcceptance() throws -> [String] {
        try searchReadsLiveAndColdChapters()
        try searchRevalidatesAnchorsAndFocus()
        try searchGuardsInputAndSupersededQueries()
        return [
            "AppKit project search reads live and cold chapter text without changing owners or history",
            "AppKit search revalidates anchored Unicode matches and preserves other pane selection and history",
            "AppKit search guards queued and marked input and discards superseded query results",
        ]
    }

    private static func searchReadsLiveAndColdChapters() throws {
        let (parent, workspace, project, chapters) = try searchFixture()
        defer { try? FileManager.default.removeItem(at: parent) }
        let host = MacChapterWorkspace(workspace: workspace)
        let first: NativeDocumentView = try searchResult { host.open(project: project, chapter: chapters[0], completion: $0) }
        try searchSettled(host, first)
        let core = host.activeCore!
        first.textView.insertText("起🙂ALPHA 海岸 alpha", replacementRange: NSRange(location: 0, length: 0))
        try searchSettled(host, first)
        let second: NativeDocumentView = try searchResult { host.open(project: project, chapter: chapters[1], completion: $0) }
        try searchSettled(host, second)
        second.textView.insertText("Cold ALPHA paragraph", replacementRange: NSRange(location: 0, length: 0))
        try searchSettled(host, second)
        let secondScope = ChapterScope(projectID: project.id, chapterID: chapters[1].id)
        let _: Bool = try searchResult { host.closeTab(pane: 0, scope: secondScope, completion: $0) }
        try searchSettled(host, first)
        first.textView.setSelectedRange(NSRange(location: 1, length: 2))
        try wait { first.binding.selectionIsAnchored }
        let before = try read(core).projection

        let found: WorkspaceSearchResult = try searchResult { workspace.search(projectID: project.id, query: "ALPHA", completion: $0) }
        try require(found.unavailable.isEmpty && !found.truncated && found.hits.count == 4,
            "Search did not combine chapter title, live prose and cold prose")
        try require(found.hits.filter { $0.kind == "title" }.map(\.chapterId) == [chapters[0].id], "Title search used the wrong scope")
        try require(found.hits.filter { $0.kind == "prose" && $0.chapterId == chapters[0].id }.count == 2
            && found.hits.filter { $0.kind == "prose" && $0.chapterId == chapters[1].id }.count == 1,
            "Search missed accepted live or saved cold text")
        try require(host.activeCore === core && host.activeView === first && host.retainedView(pane: 0, scope: secondScope) == nil,
            "Reading search results replaced or opened a chapter owner")
        let after = try read(core).projection
        try require(NativeText.identical(after.text, before.text) && after.revision == before.revision
            && after.canUndo == before.canUndo && first.textView.selectedRange() == NSRange(location: 1, length: 2),
            "Search changed prose, selection or history")
        let empty: WorkspaceSearchResult = try searchResult { workspace.search(projectID: project.id, query: "不存在的词", completion: $0) }
        try require(empty.hits.isEmpty && empty.unavailable.isEmpty, "No-match search did not return a complete empty result")
        first.undoProse(); try searchSettled(host, first)
        try require(try read(core).projection.text.isEmpty, "Search introduced an undo unit")
        first.redoProse(); try searchSettled(host, first)
        let _: Bool = try searchResult { host.close(completion: $0) }
    }

    private static func searchRevalidatesAnchorsAndFocus() throws {
        let (parent, workspace, project, chapters) = try searchFixture()
        defer { try? FileManager.default.removeItem(at: parent) }
        let host = MacChapterWorkspace(workspace: workspace)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 720),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host
        defer { window.close() }
        let first: NativeDocumentView = try searchResult { host.open(project: project, chapter: chapters[0], completion: $0) }
        try searchSettled(host, first)
        let core = host.activeCore!
        first.textView.insertText("前🙂alpha 后 alpha", replacementRange: NSRange(location: 0, length: 0))
        try searchSettled(host, first)
        let found: WorkspaceSearchResult = try searchResult { workspace.search(projectID: project.id, query: "alpha", completion: $0) }
        let hit = try found.hits.first(where: { $0.kind == "prose" }).unwrap("Missing body match")
        let passive: NativeDocumentView = try searchResult { host.split(completion: $0) }
        try searchSettled(host, passive)
        first.textView.insertText("插入 ", replacementRange: NSRange(location: 0, length: 0))
        try searchSettled(host, first)
        passive.textView.setSelectedRange(NSRange(location: 0, length: 0))
        try wait { passive.binding.selectionIsAnchored }
        let resolved: WorkspaceSearchLocation = try searchResult { workspace.resolveSearchHit(hit, completion: $0) }
        let range = try resolved.range.unwrap("Body match did not resolve to a range")
        try require(range.nsRange == NSRange(location: 6, length: 5), "Search reused the old offset or split Unicode text")
        let before = try read(core).projection
        try require(first.reveal(range: range, revision: resolved.revision), "Resolved current search match was not navigable")
        try wait { first.binding.selectionIsAnchored }
        try require(first.textView.selectedRange() == range.nsRange && host.activeView === first
            && passive.textView.selectedRange() == NSRange(location: 0, length: 0),
            "Search reveal selected the wrong pane or moved another selection")
        try require((first.textView.string as NSString).substring(with: range.nsRange) == "alpha", "Search selected the wrong text")
        let after = try read(core).projection
        try require(after.revision == before.revision && after.canUndo == before.canUndo, "Search navigation authored history")

        first.textView.insertText("coast", replacementRange: range.nsRange)
        try searchSettled(host, first)
        let selection = first.textView.selectedRange()
        var stale: Result<WorkspaceSearchLocation, Error>?
        workspace.resolveSearchHit(hit) { stale = $0 }; try wait { stale != nil }
        if case .success = stale! { throw LabError.message("Search navigated to a replaced occurrence") }
        try require(!first.reveal(range: range, revision: resolved.revision)
            && first.textView.selectedRange() == selection, "Stale result changed the current selection")
        let _: Bool = try searchResult { host.close(completion: $0) }
    }

    private static func searchGuardsInputAndSupersededQueries() throws {
        let (parent, workspace, project, chapters) = try searchFixture()
        defer { try? FileManager.default.removeItem(at: parent) }
        let host = MacChapterWorkspace(workspace: workspace)
        let view: NativeDocumentView = try searchResult { host.open(project: project, chapter: chapters[0], completion: $0) }
        try searchSettled(host, view)
        view.textView.insertText("🙂target", replacementRange: NSRange(location: 0, length: 0))
        try searchSettled(host, view)
        let found: WorkspaceSearchResult = try searchResult { workspace.search(projectID: project.id, query: "TARGET", completion: $0) }
        let hit = try found.hits.first(where: { $0.kind == "prose" }).unwrap("Missing guarded search match")
        let location: WorkspaceSearchLocation = try searchResult { workspace.resolveSearchHit(hit, completion: $0) }
        let range = try location.range.unwrap("Missing guarded search range")
        view.textView.insertText("前", replacementRange: NSRange(location: 0, length: 0))
        try require(!view.reveal(range: range, revision: location.revision), "Search reveal bypassed queued input")
        try searchSettled(host, view)
        let current: WorkspaceSearchLocation = try searchResult { workspace.resolveSearchHit(hit, completion: $0) }
        view.textView.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0),
            replacementRange: NSRange(location: 0, length: 0))
        let visible = view.textView.string, selected = view.textView.selectedRange()
        try require(!view.reveal(range: current.range!, revision: current.revision)
            && view.textView.hasMarkedText() && NativeText.identical(view.textView.string, visible)
            && view.textView.selectedRange() == selected, "Search reveal disturbed composition")
        view.textView.insertText("", replacementRange: NSRange(location: NSNotFound, length: 0))
        try searchSettled(host, view)

        let model = WorkspaceSearchModel(workspace: workspace, projectID: project.id)
        model.search("target"); model.search("不存在的词")
        try wait { !model.busy }
        try require(model.query == "不存在的词" && model.hits.isEmpty, "An old search response replaced the latest query")
        model.search("target"); model.search("")
        let _: [WorkspaceChapter] = try searchResult { workspace.chapters(projectID: project.id, completion: $0) }
        try require(model.query.isEmpty && model.hits.isEmpty && !model.busy, "Cleared search repopulated from an older response")
        let _: Bool = try searchResult { host.close(completion: $0) }
    }
}

private extension Optional {
    func unwrap(_ message: String) throws -> Wrapped {
        guard let value = self else { throw LabError.message(message) }
        return value
    }
}
