import AppKit

extension BindingAcceptance {
    private static func trashResult<T>(_ operation: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
        var result: Result<T, Error>?
        operation { result = $0 }
        try wait { result != nil }
        return try result!.get()
    }

    private static func trashRefused(_ operation: (@escaping (Result<WorkspaceChapterTrashReply, Error>) -> Void) -> Void) throws {
        var result: Result<WorkspaceChapterTrashReply, Error>?
        operation { result = $0 }
        try wait { result != nil }
        if case .success = result! { throw LabError.message("Trash discarded an unfinished or unsaved chapter") }
    }

    private static func trashSettled(_ host: MacChapterWorkspace, _ view: NativeDocumentView) throws {
        try wait { !host.isBusy && view.binding.state != nil && !view.binding.hasPendingWork }
    }

    private static func trashFixture() throws -> (URL, LabWorkspaceCore, WorkspaceProject, [WorkspaceChapter]) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("apple-native-lab")
        let workspace = LabWorkspaceCore(directory: directory)
        let _: [WorkspaceProject] = try trashResult { workspace.projects(completion: $0) }
        let project: WorkspaceProject = try trashResult { workspace.createProject(name: "回收站合成项目", completion: $0) }
        let chapters: [WorkspaceChapter] = try ["初航", "归航"].map { title in
            try trashResult { workspace.createChapter(projectID: project.id, title: title, completion: $0) }
        }
        return (directory, workspace, project, chapters)
    }

    static func workspaceTrashAcceptance() throws -> [String] {
        try workspaceTrashAllDisplays()
        try workspaceTrashRetainsDrafts()
        return [
            "Workspace trash removes all chapter displays after commit and restores through a fresh owner",
            "Workspace trash preserves queued marked and failed-save drafts and rolls back a failed lifecycle transaction",
        ]
    }

    private static func workspaceTrashAllDisplays() throws {
        let (directory, workspace, project, chapters) = try trashFixture()
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let host = MacChapterWorkspace(workspace: workspace)
        let a = chapters[0], b = chapters[1]
        let scope = ChapterScope(projectID: project.id, chapterID: a.id)
        let first: NativeDocumentView = try trashResult { host.open(project: project, chapter: a, completion: $0) }
        try trashSettled(host, first)
        let originalCore = host.activeCore!
        first.textView.insertText("海🙂", replacementRange: NSRange(location: 0, length: 0))
        try trashSettled(host, first)
        let twin: NativeDocumentView = try trashResult { host.split(completion: $0) }
        try trashSettled(host, twin)
        try require(twin.binding.store === first.binding.store && twin.textView.string == "海🙂", "Split did not share the saved chapter")
        let other: NativeDocumentView = try trashResult { host.open(project: project, chapter: b, in: 0, completion: $0) }
        try trashSettled(host, other)
        let otherCore = host.activeCore!
        other.textView.insertText("岸🙂", replacementRange: NSRange(location: 0, length: 0))
        try trashSettled(host, other)
        other.textView.setSelectedRange(NSRange(location: 1, length: 2))
        try wait { other.binding.selectionIsAnchored }
        let reply: WorkspaceChapterTrashReply = try trashResult { host.trash(projectID: project.id, chapterID: a.id, completion: $0) }
        try require(reply.chapters.map(\.id) == [b.id] && reply.trashedChapters.map(\.id) == [a.id], "Trash returned an incorrect chapter list")
        try require(originalCore.isClosed && host.retainedView(pane: 0, scope: scope) == nil && host.retainedView(pane: 1, scope: scope) == nil,
                    "Trash retained a visible or hidden display of the old incarnation")
        try require(host.activeView === other && host.activeCore === otherCore && !otherCore.isClosed &&
                    other.textView.string == "岸🙂" && other.textView.selectedRange() == NSRange(location: 1, length: 2),
                    "Trash replaced another chapter or its selection")
        let restored: WorkspaceChapterTrashReply = try trashResult { workspace.restoreChapter(projectID: project.id, chapterID: a.id, completion: $0) }
        try require(restored.trashedChapters.isEmpty && Set(restored.chapters.map(\.id)) == Set([a.id, b.id]) &&
                    host.retainedView(pane: 0, scope: scope) == nil && host.retainedView(pane: 1, scope: scope) == nil,
                    "Restore opened an editor or lost another chapter")
        let fresh: NativeDocumentView = try trashResult { host.open(project: project, chapter: a, in: 1, completion: $0) }
        try trashSettled(host, fresh)
        try require(host.activeCore !== originalCore && fresh !== first && fresh !== twin && fresh.textView.string == "海🙂" &&
                    fresh.binding.state?.projection.canUndo == false, "Restore reused the old scoped owner or lost prose")
        fresh.textView.insertText("归", replacementRange: NSRange(location: 3, length: 0))
        try trashSettled(host, fresh)
        other.undoProse(); try trashSettled(host, other)
        try require(other.textView.string.isEmpty, "Trash/restore changed another chapter's undo history")
        other.redoProse(); try trashSettled(host, other)
        let closed: Bool = try trashResult { host.close(completion: $0) }
        try require(closed, "Restored workspace could not close")
        let cold = LabWorkspaceCore(directory: directory)
        let _: [WorkspaceProject] = try trashResult { cold.projects(completion: $0) }
        let coldCore: LabCore = try trashResult { cold.openChapter(projectID: project.id, chapterID: a.id, completion: $0) }
        try require(try read(coldCore).projection.text == "海🙂归", "Restored chapter did not survive cold reopen")
        let coldClosed: Bool = try trashResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }

    private static func workspaceTrashRetainsDrafts() throws {
        let (directory, workspace, project, chapters) = try trashFixture()
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let host = MacChapterWorkspace(workspace: workspace)
        let chapter = chapters[0], scope = ChapterScope(projectID: project.id, chapterID: chapters[0].id)
        let view: NativeDocumentView = try trashResult { host.open(project: project, chapter: chapter, completion: $0) }
        try trashSettled(host, view)
        let core = host.activeCore!
        view.textView.insertText("排队🙂", replacementRange: NSRange(location: 0, length: 0))
        try require(view.binding.hasPendingWork, "Queued trash fixture was already idle")
        try trashRefused { host.trash(projectID: project.id, chapterID: chapter.id, completion: $0) }
        try trashSettled(host, view)
        view.textView.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: 0, length: 0))
        let marked = view.textView.string
        try trashRefused { host.trash(projectID: project.id, chapterID: chapter.id, completion: $0) }
        try require(view.textView.hasMarkedText() && view.textView.string == marked && host.retainedView(pane: 0, scope: scope) === view,
                    "Rejected trash discarded the actual TextKit marked draft")
        view.textView.insertText("中文", replacementRange: NSRange(location: NSNotFound, length: 0))
        try trashSettled(host, view)
        try WorkspaceRemoteProseFixture.execute(in: directory, sql: "CREATE TRIGGER fail_trash_save BEFORE INSERT ON sync_change_set BEGIN SELECT RAISE(ABORT, 'synthetic save failure'); END")
        defer { try? WorkspaceRemoteProseFixture.execute(in: directory, sql: "DROP TRIGGER IF EXISTS fail_trash_save") }
        view.textView.insertText("保留", replacementRange: NSRange(location: (view.textView.string as NSString).length, length: 0))
        try wait { view.binding.state?.saveError != nil }
        let unsaved = view.textView.string
        try trashRefused { host.trash(projectID: project.id, chapterID: chapter.id, completion: $0) }
        try require(host.activeCore === core && !core.isClosed && view.textView.string == unsaved,
                    "Trash discarded input after save failure")
        try WorkspaceRemoteProseFixture.execute(in: directory, sql: "DROP TRIGGER fail_trash_save")
        view.binding.retrySave(); try trashSettled(host, view)
        try WorkspaceRemoteProseFixture.execute(in: directory, sql: "CREATE TRIGGER fail_trash_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic trash receipt failure'); END")
        defer { try? WorkspaceRemoteProseFixture.execute(in: directory, sql: "DROP TRIGGER IF EXISTS fail_trash_receipt") }
        try trashRefused { host.trash(projectID: project.id, chapterID: chapter.id, completion: $0) }
        let listed: [WorkspaceChapter] = try trashResult { workspace.chapters(projectID: project.id, completion: $0) }
        let trashed: [WorkspaceChapter] = try trashResult { workspace.trashedChapters(projectID: project.id, completion: $0) }
        try require(listed.contains { $0.id == chapter.id } && trashed.isEmpty && !core.isClosed &&
                    host.retainedView(pane: 0, scope: scope) === view && view.textView.string == unsaved,
                    "Failed lifecycle transaction changed the chapter or released its owner")
        try WorkspaceRemoteProseFixture.execute(in: directory, sql: "DROP TRIGGER fail_trash_receipt")
        let _: WorkspaceChapterTrashReply = try trashResult { host.trash(projectID: project.id, chapterID: chapter.id, completion: $0) }
        let _: WorkspaceChapterTrashReply = try trashResult { workspace.restoreChapter(projectID: project.id, chapterID: chapter.id, completion: $0) }
        let reopened: NativeDocumentView = try trashResult { host.open(project: project, chapter: chapter, completion: $0) }
        try trashSettled(host, reopened)
        try require(reopened.textView.string == unsaved && host.activeCore !== core, "Retry and restore lost saved draft text")
        let closed: Bool = try trashResult { host.close(completion: $0) }
        try require(closed, "Recovered workspace failed to close")
    }
}
