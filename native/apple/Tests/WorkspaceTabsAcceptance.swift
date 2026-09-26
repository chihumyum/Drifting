import AppKit

extension BindingAcceptance {
    private static func tabsResult<T>(_ run: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
        var result: Result<T, Error>?
        run { result = $0 }
        try wait { result != nil }
        return try result!.get()
    }

    private static func tabsRefused(_ run: (@escaping (Result<Bool, Error>) -> Void) -> Void, _ message: String) throws {
        var result: Result<Bool, Error>?
        run { result = $0 }
        try wait { result != nil }
        if case .success(true) = result! { throw LabError.message(message) }
    }

    private static func tabsSettled(_ host: MacChapterWorkspace, _ view: NativeDocumentView) throws {
        try wait { !host.isBusy && view.binding.state != nil && !view.binding.hasPendingWork }
    }

    private static func tabsFixture() throws -> (URL, LabWorkspaceCore, WorkspaceProject, [WorkspaceChapter]) {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let workspace = LabWorkspaceCore(directory: parent.appendingPathComponent("apple-native-lab"))
        let initial: [WorkspaceProject] = try tabsResult { workspace.projects(completion: $0) }
        try require(initial.isEmpty, "Workspace tab fixture was not isolated")
        let project: WorkspaceProject = try tabsResult { workspace.createProject(name: "标签分栏合成项目", completion: $0) }
        let first: WorkspaceChapter = try tabsResult {
            workspace.createChapter(projectID: project.id, title: "初航", completion: $0)
        }
        let second: WorkspaceChapter = try tabsResult {
            workspace.createChapter(projectID: project.id, title: "归航", completion: $0)
        }
        return (parent, workspace, project, [first, second])
    }

    private static func tabsSQL(_ parent: URL, _ statement: String) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
        process.arguments = ["-bail", parent.appendingPathComponent("apple-native-lab/apple-native-workspace.db").path, statement]
        let error = Pipe(); process.standardError = error
        try process.run(); process.waitUntilExit()
        try require(process.terminationStatus == 0, "Synthetic workspace SQL failed: " +
            String(decoding: error.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self))
    }

    static func workspaceTabsAcceptance() throws -> [String] {
        try workspaceTabsRetainOwners()
        try workspacePanesShareOwner()
        try workspaceCloseRetainsInput()
        return [
            "Workspace tabs retain chapter owners views selections and independent history",
            "Workspace split panes share one chapter owner and preserve independent selections after closing one pane",
            "Workspace close guards retain queued marked and failed-save input through retry and cold reopen",
        ]
    }

    private static func workspaceTabsRetainOwners() throws {
        let (parent, workspace, project, chapters) = try tabsFixture()
        defer { try? FileManager.default.removeItem(at: parent) }
        let host = MacChapterWorkspace(workspace: workspace)
        let firstScope = ChapterScope(projectID: project.id, chapterID: chapters[0].id)
        let secondScope = ChapterScope(projectID: project.id, chapterID: chapters[1].id)
        let first: NativeDocumentView = try tabsResult { host.open(project: project, chapter: chapters[0], completion: $0) }
        try tabsSettled(host, first)
        let firstCore = host.activeCore!
        first.textView.insertText("甲🙂", replacementRange: NSRange(location: 0, length: 0))
        try tabsSettled(host, first)
        first.textView.setSelectedRange(NSRange(location: 1, length: 2))
        try wait { first.binding.selectionIsAnchored }

        let second: NativeDocumentView = try tabsResult { host.open(project: project, chapter: chapters[1], completion: $0) }
        try tabsSettled(host, second)
        let secondCore = host.activeCore!
        try require(firstCore !== secondCore && first.binding.store !== second.binding.store, "Different chapter tabs shared a document owner")
        second.textView.insertText("乙海", replacementRange: NSRange(location: 0, length: 0))
        try tabsSettled(host, second)
        second.textView.setSelectedRange(NSRange(location: 1, length: 0))
        try wait { second.binding.selectionIsAnchored }

        let returned: NativeDocumentView = try tabsResult { host.open(project: project, chapter: chapters[0], completion: $0) }
        try tabsSettled(host, returned)
        try require(returned === first && host.retainedView(pane: 0, scope: firstScope) === first && host.activeCore === firstCore,
            "A to B to A recreated the retained view or owner")
        try require(first.textView.selectedRange() == NSRange(location: 1, length: 2), "Tab switching lost the emoji selection")
        first.undoProse(); try tabsSettled(host, first)
        try require(try read(firstCore).projection.text == "" && read(secondCore).projection.text == "乙海", "First chapter undo crossed chapter history")
        first.redoProse(); try tabsSettled(host, first)

        let returnedSecond: NativeDocumentView = try tabsResult { host.open(project: project, chapter: chapters[1], completion: $0) }
        try tabsSettled(host, returnedSecond)
        try require(returnedSecond === second && host.activeCore === secondCore, "Second chapter was not retained")
        try require(second.textView.selectedRange() == NSRange(location: 1, length: 0), "Inactive chapter selection changed")
        second.undoProse(); try tabsSettled(host, second)
        try require(try read(secondCore).projection.text == "" && read(firstCore).projection.text == "甲🙂", "Second chapter undo crossed chapter history")
        second.redoProse(); try tabsSettled(host, second)
        let closedFirst: Bool = try tabsResult { host.closeTab(pane: 0, scope: firstScope, completion: $0) }
        let closedSecond: Bool = try tabsResult { host.closeTab(pane: 0, scope: secondScope, completion: $0) }
        try require(closedFirst && closedSecond, "Saved chapter tabs could not close")
        let closed: Bool = try tabsResult { host.close(completion: $0) }
        try require(closed, "Empty workspace could not close")
    }

    private static func workspacePanesShareOwner() throws {
        let (parent, workspace, project, chapters) = try tabsFixture()
        defer { try? FileManager.default.removeItem(at: parent) }
        let host = MacChapterWorkspace(workspace: workspace)
        // A detached coordinator has no usable layout: mount the real view tree
        // in a sized window before opening either pane.
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 720),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        let scope = ChapterScope(projectID: project.id, chapterID: chapters[0].id)
        let first: NativeDocumentView = try tabsResult { host.open(project: project, chapter: chapters[0], completion: $0) }
        try tabsSettled(host, first)
        let core = host.activeCore!
        first.textView.insertText("甲🙂海岸", replacementRange: NSRange(location: 0, length: 0))
        try tabsSettled(host, first)
        let second: NativeDocumentView = try tabsResult { host.split(completion: $0) }
        try tabsSettled(host, second)
        try require(host.paneCount == 2 && first !== second && host.activeCore === core && first.binding.store === second.binding.store,
            "Split did not create two views of one chapter owner")
        try require(first.binding.store.viewCount == 2, "Split did not register two bindings")
        try require(first.textView.string == "甲🙂海岸" && second.textView.string == "甲🙂海岸",
            "Split exposed an empty editor instead of rendering the retained owner's text")
        host.layoutSubtreeIfNeeded()
        let firstFrame = first.convert(first.bounds, to: host)
        let secondFrame = second.convert(second.bounds, to: host)
        try require(first.window === window && second.window === window &&
            !first.isHiddenOrHasHiddenAncestor && !second.isHiddenOrHasHiddenAncestor &&
            first.visibleRect.width >= 300 && second.visibleRect.width >= 300 &&
            first.visibleRect.height >= 220 && second.visibleRect.height >= 220 &&
            secondFrame.minX >= firstFrame.maxX,
            "Split panes lack usable visible layout: first=\(firstFrame), second=\(secondFrame), visible=\(first.visibleRect)/\(second.visibleRect)")
        guard let split = host.subviews.first(where: { $0 is NSSplitView }) as? NSSplitView else {
            throw LabError.message("Chapter workspace did not mount its split view")
        }
        split.setPosition(450, ofDividerAt: 0)
        host.layoutSubtreeIfNeeded()
        let resizedWidths = (first.bounds.width, second.bounds.width)
        let existingPane: NativeDocumentView = try tabsResult { host.split(completion: $0) }
        try tabsSettled(host, existingPane)
        host.layoutSubtreeIfNeeded()
        try require(existingPane === first && host.paneCount == 2 && first.binding.store.viewCount == 2,
            "Splitting again created a third pane or another chapter owner")
        try require(abs(first.bounds.width - resizedWidths.0) < 1 && abs(second.bounds.width - resizedWidths.1) < 1,
            "Reusing a split pane reset the divider position")
        first.textView.setSelectedRange(NSRange(location: 1, length: 2))
        second.textView.setSelectedRange(NSRange(location: 4, length: 0))
        try wait { first.binding.selectionIsAnchored && second.binding.selectionIsAnchored }
        first.textView.insertText("前", replacementRange: NSRange(location: 0, length: 0))
        try tabsSettled(host, first)
        try require(second.textView.string == "前甲🙂海岸" && second.textView.selectedRange() == NSRange(location: 5, length: 0),
            "Passive pane did not preserve its independent anchored selection")
        let firstSelection = first.textView.selectedRange()
        let closedSecond: Bool = try tabsResult { host.closeSecondPane(completion: $0) }
        try require(closedSecond && host.paneCount == 1 && host.activeView === first && host.activeCore === core && first.binding.store.viewCount == 1,
            "Closing one pane detached the remaining view or closed its owner")
        try require(first.textView.selectedRange() == firstSelection, "Closing another pane changed the surviving selection")
        first.textView.insertText("续", replacementRange: NSRange(location: (first.textView.string as NSString).length, length: 0))
        try tabsSettled(host, first)
        try require(try read(core).projection.text == "前甲🙂海岸续", "Surviving pane could not continue editing")
        first.undoProse(); try tabsSettled(host, first)
        try require(try read(core).projection.text == "前甲🙂海岸", "Closing another pane reset shared history")
        let closedTab: Bool = try tabsResult { host.closeTab(pane: 0, scope: scope, completion: $0) }
        let closed: Bool = try tabsResult { host.close(completion: $0) }
        try require(closedTab && closed, "Surviving saved pane could not close")
    }

    private static func workspaceCloseRetainsInput() throws {
        let (parent, workspace, project, chapters) = try tabsFixture()
        defer { try? FileManager.default.removeItem(at: parent) }
        let host = MacChapterWorkspace(workspace: workspace)
        let scope = ChapterScope(projectID: project.id, chapterID: chapters[0].id)
        let view: NativeDocumentView = try tabsResult { host.open(project: project, chapter: chapters[0], completion: $0) }
        try tabsSettled(host, view)
        let core = host.activeCore!
        // No run-loop yield between input and close: the coordinator sees the real queued events.
        view.textView.insertText("排", replacementRange: NSRange(location: 0, length: 0))
        view.textView.insertText("队🙂", replacementRange: NSRange(location: 1, length: 0))
        try require(view.binding.hasPendingWork, "Queued close fixture was already idle")
        try tabsRefused({ host.closeTab(pane: 0, scope: scope, completion: $0) }, "Closing a tab dropped queued input")
        try tabsSettled(host, view)
        try require(try host.retainedView(pane: 0, scope: scope) === view && host.activeCore === core && read(core).projection.text == "排队🙂",
            "Refused close did not retain the queued chapter")

        view.textView.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: 0, length: 0))
        let marked = view.textView.string
        try require(view.textView.hasMarkedText() && view.binding.hasUnsubmittedDraft, "Marked close fixture did not start composition")
        try tabsRefused({ host.closeTab(pane: 0, scope: scope, completion: $0) }, "Closing a tab dropped marked input")
        try tabsRefused({ host.close(completion: $0) }, "Closing the workspace dropped marked input")
        try require(view.textView.hasMarkedText() && view.textView.string == marked && host.retainedView(pane: 0, scope: scope) === view,
            "Refused close changed the TextKit composition")
        try require(try read(core).projection.text == "排队🙂", "Marked input was persisted before commit")
        view.textView.insertText("中文", replacementRange: NSRange(location: NSNotFound, length: 0))
        try tabsSettled(host, view)

        try tabsSQL(parent, "CREATE TRIGGER fail_workspace_tab_save BEFORE INSERT ON sync_change_set BEGIN SELECT RAISE(ABORT, 'synthetic tab save failure'); END")
        defer { try? tabsSQL(parent, "DROP TRIGGER IF EXISTS fail_workspace_tab_save") }
        view.textView.insertText("保留", replacementRange: NSRange(location: (view.textView.string as NSString).length, length: 0))
        try wait { view.binding.state?.saveError != nil }
        let unsaved = view.textView.string
        try tabsRefused({ host.closeTab(pane: 0, scope: scope, completion: $0) }, "Closing a tab dropped input after save failure")
        try tabsRefused({ host.close(completion: $0) }, "Closing the workspace dropped input after save failure")
        try require(host.retainedView(pane: 0, scope: scope) === view && host.activeCore === core && view.textView.string == unsaved,
            "Failed save or close replaced the retained view")
        try tabsSQL(parent, "DROP TRIGGER fail_workspace_tab_save")
        view.binding.retrySave(); try tabsSettled(host, view)
        let saved = try read(core)
        try require(saved.saved && saved.projection.text == "中文排队🙂保留", "Retry failed to save the exact retained input")
        let closedTab: Bool = try tabsResult { host.closeTab(pane: 0, scope: scope, completion: $0) }
        try require(closedTab && host.retainedView(pane: 0, scope: scope) == nil, "Saved final tab did not close")
        let reopened: NativeDocumentView = try tabsResult { host.open(project: project, chapter: chapters[0], completion: $0) }
        try tabsSettled(host, reopened)
        try require(reopened !== view && host.activeCore !== core && reopened.textView.string == saved.projection.text,
            "Closed chapter did not reopen from SQLite with the same text")
        try require(reopened.binding.state?.projection.canUndo == false, "Cold reopen accidentally reused the old history owner")
        let closed: Bool = try tabsResult { host.close(completion: $0) }
        try require(closed, "Recovered workspace could not close")
    }
}
