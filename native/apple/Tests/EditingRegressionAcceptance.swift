import AppKit

/// Editing regressions found in daily writing, each through the real tab
/// host, text view, input queue and Rust workspace. Input is programmatic.
extension BindingAcceptance {
    static func editingRegressionAcceptance() throws -> [String] {
        try enterAfterLinkableName()
        return [
            "AppKit Enter typed at the end of a just-settled line holding a linkable chapter title, while its link pass is scheduled, becomes a new paragraph with no failed draft, keeps the link and survives cold reopen",
        ]
    }

    /// A structural draft (Enter) that crossed the background entity-link
    /// pass was refused as a concurrent structural change and kept as a
    /// failed draft, blocking the page. Derived link marks no longer count
    /// as a change to the draft's context.
    private static func enterAfterLinkableName() throws {
        let linkDelay = DocumentStore.entityLinkDelay
        defer { DocumentStore.entityLinkDelay = linkDelay }
        DocumentStore.entityLinkDelay = 0.5
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("apple-native-lab")
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let workspace = LabWorkspaceCore(directory: directory)
        let listed: [WorkspaceProject] = try elementResult { workspace.projects(completion: $0) }
        try require(listed.isEmpty, "Editing regression fixture was not isolated")
        let project: WorkspaceProject = try elementResult { workspace.createProject(name: "回车合成项目", completion: $0) }
        let prologue: WorkspaceChapter = try elementResult { workspace.createChapter(projectID: project.id, title: "序章", completion: $0) }
        let bell: WorkspaceChapter = try elementResult { workspace.createChapter(projectID: project.id, title: "钟声", completion: $0) }
        var (window, host) = elementHost(workspace)
        let view: NativeDocumentView = try elementResult { host.open(project: project, chapter: prologue, completion: $0) }
        try elementSettled(host, view)
        var statuses: [String] = []
        let previous = view.binding.onStatus
        view.binding.onStatus = { statuses.append($0); previous?($0) }

        // Type the line, let the input settle, then press Enter at its end
        // at once, while the link pass for the typed title is scheduled.
        view.textView.setSelectedRange(NSRange(location: 0, length: 0))
        view.textView.insertText("钟声响起。", replacementRange: NSRange(location: 0, length: 0))
        try wait { !view.binding.hasPendingWork }
        try require(view.binding.store.hasScheduledLinks, "No link pass was scheduled after typing a chapter title")
        let end = (view.textView.string as NSString).length
        view.textView.insertText("\n", replacementRange: NSRange(location: end, length: 0))
        try wait { !view.binding.hasPendingWork || view.binding.hasFailedDraft }
        try require(!view.binding.hasFailedDraft && view.binding.state?.saveError == nil,
            "Enter after a linkable name was refused: \(statuses.last ?? "no status")")
        try wait { !host.isBusy && !view.binding.hasPendingWork && !view.binding.store.hasScheduledLinks }
        try require(!view.binding.hasFailedDraft && view.binding.canEdit, "The page stayed blocked after Enter")

        let link = NativeEntityLink(kind: "node", id: bell.id)
        func check(_ projection: NativeProjection, _ context: String) throws {
            try require(projection.text == "钟声响起。\n", "\(context): the text is \(projection.text.debugDescription)")
            try require(projection.blocks.count == 2 && projection.blocks.allSatisfy { $0.kind == "paragraph" },
                "\(context): Enter did not make a new paragraph: \(projection.blocks.map(\.kind))")
            let linked = linkedRuns(projection)
            try require(linked.count == 1 && linked[0].0 == "钟声" && linked[0].1 == link,
                "\(context): the chapter link is missing or wrong: \(linked.map { "\($0.0)→\($0.1.id)" })")
        }
        guard let projection = view.binding.store.projection else { throw LabError.message("No projection after Enter") }
        try check(projection, "Live")
        try require(view.textView.string == "钟声响起。\n", "The text view differs: \(view.textView.string.debugDescription)")
        // Typing continues in the new paragraph.
        view.textView.insertText("雨停了。", replacementRange: NSRange(location: (view.textView.string as NSString).length, length: 0))
        try wait { !view.binding.hasPendingWork || view.binding.hasFailedDraft }
        try require(!view.binding.hasFailedDraft && view.binding.store.projection?.text == "钟声响起。\n雨停了。",
            "Typing after the new paragraph failed: \(statuses.last ?? "no status")")
        view.undoProse(); try wait { !view.binding.hasPendingWork }
        try require(view.binding.store.projection?.text == "钟声响起。\n", "Undo did not remove only the typed line")

        // Cold reopen: the paragraph and the link are durable.
        try wait { host.canNavigate && !host.isBusy && !view.binding.store.hasScheduledLinks }
        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed, "The workspace failed to close")
        window.close()
        let reopened = LabWorkspaceCore(directory: directory)
        let projects: [WorkspaceProject] = try elementResult { reopened.projects(completion: $0) }
        try require(projects.map(\.id) == [project.id], "Cold reopen lost the project")
        (window, host) = elementHost(reopened)
        let again: NativeDocumentView = try elementResult { host.open(project: project, chapter: prologue, completion: $0) }
        try elementSettled(host, again)
        try wait { !again.binding.store.hasScheduledLinks }
        guard let durable = again.binding.store.projection else { throw LabError.message("No projection after reopen") }
        try check(durable, "Cold reopen")
        let finished: Bool = try elementResult { host.close(completion: $0) }
        try require(finished, "The reopened workspace failed to close")
        window.close()
    }
}
