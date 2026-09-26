import AppKit

extension BindingAcceptance {
    private static func actResult<T>(_ operation: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
        var result: Result<T, Error>?
        operation { result = $0 }
        try wait { result != nil }
        return try result!.get()
    }

    private static func actSettled(_ view: NativeDocumentView) throws {
        try wait { view.binding.state != nil && !view.binding.hasPendingWork }
    }

    static func actBoundaryAcceptance() throws -> [String] {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("apple-native-lab")
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let workspace = LabWorkspaceCore(directory: directory)
        let _: [WorkspaceProject] = try actResult { workspace.projects(completion: $0) }
        let project: WorkspaceProject = try actResult { workspace.createProject(name: "幕分界合成项目", completion: $0) }
        let chapters: [WorkspaceChapter] = try ["启程", "航行", "归岸"].map { title in
            try actResult { workspace.createChapter(projectID: project.id, title: title, completion: $0) }
        }
        let core: LabCore = try actResult { workspace.openChapter(projectID: project.id, chapterID: chapters[1].id, completion: $0) }
        let editor = NativeDocumentView(core: core)
        editor.binding.load(); try actSettled(editor)
        editor.textView.insertText("航🙂", replacementRange: NSRange(location: 0, length: 0))
        try actSettled(editor)
        editor.binding.format(.heading1, range: NSRange(location: 0, length: 0))
        try actSettled(editor)
        editor.textView.setSelectedRange(NSRange(location: 1, length: 2))
        try wait { editor.binding.selectionIsAnchored }
        let before = try read(core).projection
        let checkpoint: NativeCheckpoint = try actResult { core.exportDocument(completion: $0) }
        let model = WorkspaceOutlineModel(workspace: workspace, projectID: project.id)
        let controller = BookOutlineViewController(model: model)
        controller.canNavigate = { !editor.binding.hasPendingWork }
        _ = controller.view
        model.load(); try wait { model.entries.count == chapters.count }
        try require(!model.entries.contains { $0.kind == "act" }, "Outline invented an opening act")
        model.updateActive(chapterID: chapters[1].id, outline: before.outline)
        model.toggle(chapters[1].id)
        let headingIDs = model.rows.compactMap { $0.heading?.blockId }
        let act: WorkspaceAct = try actResult { model.createAct(beforeChapterID: chapters[1].id, completion: $0) }
        try require(act.projectId == project.id && !act.name.isEmpty && model.entries.filter { $0.kind == "act" }.count == 1,
                    "Create did not return the actual shared act")
        try require(model.entries.first { $0.id == chapters[0].id }?.actId == nil &&
                    model.entries.first { $0.id == chapters[1].id }?.actId == act.id &&
                    model.entries.first { $0.id == chapters[2].id }?.actId == act.id,
                    "Chapter membership disagrees with the shared boundary")
        let renamed: WorkspaceAct = try actResult { model.renameAct(id: act.id, name: "中幕🙂", completion: $0) }
        try require(renamed.id == act.id && model.entries.first { $0.id == act.id }?.title == "中幕🙂", "Rename did not refresh the act row")
        try require(model.expanded.contains(chapters[1].id) && model.rows.compactMap { $0.heading?.blockId } == headingIDs,
                    "Metadata refresh collapsed the chapter or discarded heading details")
        let retained: LabCore = try actResult { workspace.openChapter(projectID: project.id, chapterID: chapters[1].id, completion: $0) }
        let after: NativeCheckpoint = try actResult { core.exportDocument(completion: $0) }
        try require(retained === core && checkpoint.update == after.update && editor.textView.selectedRange() == NSRange(location: 1, length: 2) &&
                    editor.binding.state?.projection.canUndo == before.canUndo, "Act edits replaced the live owner, prose, selection or history")

        try WorkspaceRemoteProseFixture.execute(in: directory, sql: "CREATE TRIGGER fail_act_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic act receipt failure'); END")
        defer { try? WorkspaceRemoteProseFixture.execute(in: directory, sql: "DROP TRIGGER IF EXISTS fail_act_receipt") }
        var rejected: Result<WorkspaceAct, Error>?
        model.removeAct(id: act.id) { rejected = $0 }
        try wait { rejected != nil }
        if case .success = rejected! { throw LabError.message("Failed act receipt was reported as successful removal") }
        try require(!model.busy && model.entries.contains { $0.id == act.id } && !core.isClosed &&
                    editor.textView.selectedRange() == NSRange(location: 1, length: 2), "Failed act edit discarded presentation or editor state")
        try WorkspaceRemoteProseFixture.execute(in: directory, sql: "DROP TRIGGER fail_act_receipt")
        try require(editor.binding.detach(), "Editor failed to detach after metadata commands")
        try wait { !workspace.hasPendingDocuments }
        let closed: Bool = try actResult { workspace.close(completion: $0) }
        try require(closed, "Workspace failed to close")

        let cold = LabWorkspaceCore(directory: directory)
        let _: [WorkspaceProject] = try actResult { cold.projects(completion: $0) }
        let freshCore: LabCore = try actResult { cold.openChapter(projectID: project.id, chapterID: chapters[1].id, completion: $0) }
        let freshEditor = NativeDocumentView(core: freshCore)
        freshEditor.binding.load(); try actSettled(freshEditor)
        try require(freshEditor.textView.string == "航🙂", "Act metadata changed cold prose")
        let coldModel = WorkspaceOutlineModel(workspace: cold, projectID: project.id)
        coldModel.load(); try wait { coldModel.entries.count == 4 }
        try require(coldModel.entries.first { $0.id == act.id }?.title == "中幕🙂", "Renamed boundary did not survive cold reopen")
        coldModel.updateActive(chapterID: chapters[1].id, outline: freshEditor.binding.state!.projection.outline)
        coldModel.toggle(chapters[1].id)
        freshEditor.textView.insertText("续", replacementRange: NSRange(location: 3, length: 0))
        try actSettled(freshEditor)
        freshEditor.textView.setSelectedRange(NSRange(location: 1, length: 2))
        try wait { freshEditor.binding.selectionIsAnchored }
        let beforeRemove: NativeCheckpoint = try actResult { freshCore.exportDocument(completion: $0) }
        let removed: WorkspaceAct = try actResult { coldModel.removeAct(id: act.id, completion: $0) }
        let afterRemove: NativeCheckpoint = try actResult { freshCore.exportDocument(completion: $0) }
        try require(removed.id == act.id && coldModel.entries.map(\.id) == chapters.map(\.id) && coldModel.entries.allSatisfy { $0.actId == nil },
                    "Removing an act removed chapters or retained a stale boundary")
        try require(coldModel.expanded.contains(chapters[1].id) && beforeRemove.update == afterRemove.update &&
                    freshEditor.textView.selectedRange() == NSRange(location: 1, length: 2), "Boundary removal changed prose or selection")
        freshEditor.undoProse(); try actSettled(freshEditor)
        try require(freshEditor.textView.string == "航🙂", "Boundary removal added a prose undo unit")
        freshEditor.redoProse(); try actSettled(freshEditor)
        try require(freshEditor.textView.string == "航🙂续", "Boundary removal damaged redo history")
        try require(freshEditor.binding.detach(), "Cold editor failed to detach")
        try wait { !cold.hasPendingDocuments }
        let coldClosed: Bool = try actResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
        return ["Workspace act boundaries retain outline expansion chapter owners selection and history through create rename remove and cold reopen"]
    }
}
