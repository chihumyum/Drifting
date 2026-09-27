import AppKit

extension BindingAcceptance {
    private static func commentResult<T>(_ run: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
        var result: Result<T, Error>?
        run { result = $0 }
        try wait { result != nil }
        return try result!.get()
    }

    private static func commentRefused<T>(_ run: (@escaping (Result<T, Error>) -> Void) -> Void,
                                          _ message: String) throws -> String {
        var result: Result<T, Error>?
        run { result = $0 }
        try wait { result != nil }
        guard case .failure(let error) = result! else { throw LabError.message(message) }
        return error.localizedDescription
    }

    private static func commentSettled(_ host: MacChapterWorkspace, _ views: NativeDocumentView...) throws {
        try wait { !host.isBusy && views.allSatisfy { $0.binding.state != nil && !$0.binding.hasPendingWork } }
    }

    private static func commentFixture() throws -> (URL, LabWorkspaceCore, WorkspaceProject, WorkspaceChapter) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("apple-native-lab")
        let workspace = LabWorkspaceCore(directory: directory)
        let _: [WorkspaceProject] = try commentResult { workspace.projects(completion: $0) }
        let project: WorkspaceProject = try commentResult { workspace.createProject(name: "批注合成项目", completion: $0) }
        let chapter: WorkspaceChapter = try commentResult { workspace.createChapter(projectID: project.id, title: "雨夜", completion: $0) }
        return (directory, workspace, project, chapter)
    }

    /// Mirrors AppDelegate: the panel model follows anchor renders and creations.
    private static func commentModel(_ host: MacChapterWorkspace, _ view: NativeDocumentView) throws -> ChapterCommentsModel {
        let model = ChapterCommentsModel()
        host.onComments = { [weak model] view in model?.updateAnchors(from: view.binding.store) }
        host.onCommentCreated = { [weak model] view, _ in
            if let model, model.store === view.binding.store { model.reload(after: "批注已添加。") }
        }
        model.bind(view.binding.store)
        try wait { !model.busy }
        return model
    }

    private static func commentControl(_ root: NSView, _ id: String) -> NSView? {
        if root.accessibilityIdentifier() == id { return root }
        for child in root.subviews { if let found = commentControl(child, id) { return found } }
        return nil
    }

    private static func commentCount(_ directory: URL, _ sql: String) throws -> Int64 {
        guard case .integer(let count)? = try WorkspaceRemoteProseFixture.query(in: directory, sql: sql).first?["n"] else {
            throw LabError.message("Comment count query returned no row")
        }
        return count
    }

    private static func commentMutations(_ directory: URL) throws -> Int64 {
        try commentCount(directory, "SELECT COUNT(*) AS n FROM sync_mutation WHERE target_kind = 'comment'")
    }

    private static func highlighted(_ view: NativeDocumentView, at location: Int) -> Bool {
        view.textView.textStorage?.attribute(.backgroundColor, at: location, effectiveRange: nil) != nil
    }

    static func commentAcceptance() throws -> [String] {
        try commentCreateHighlightsLocatesAndReopens()
        try commentBodyAndResolutionKeepProse()
        try commentRefusalsCreateNothing()
        return [
            "AppKit selection comment highlights both same-chapter views lists and locates only in the initiating pane without authoring history and survives cold reopen",
            "AppKit comment body edit resolve and reopen keep prose selections anchors and undo history and survive cold reopen",
            "AppKit comment refusals for stale revision blank selection empty body failed commit queued and marked input create nothing and keep composer text",
        ]
    }

    private static func commentCreateHighlightsLocatesAndReopens() throws {
        let (directory, workspace, project, chapter) = try commentFixture()
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let host = MacChapterWorkspace(workspace: workspace)
        let first: NativeDocumentView = try commentResult { host.open(project: project, chapter: chapter, completion: $0) }
        try commentSettled(host, first)
        let core = host.activeCore!
        // Two paragraphs: "雨夜🙂来信" (6 UTF-16 units) and "海岸线".
        first.textView.insertText("雨夜🙂来信\n海岸线", replacementRange: NSRange(location: 0, length: 0))
        try commentSettled(host, first)
        try require(first.binding.state!.projection.blocks.count == 2, "Comment fixture did not create two paragraphs")
        let passive: NativeDocumentView = try commentResult { host.split(completion: $0) }
        try commentSettled(host, first, passive)
        try require(passive.binding.store === first.binding.store, "Split views did not share the chapter owner")
        passive.textView.setSelectedRange(NSRange(location: 8, length: 2))
        try wait { passive.binding.selectionIsAnchored }
        host.activate(pane: 0)
        let selection = NSRange(location: 2, length: 6)
        first.textView.setSelectedRange(selection)
        try wait { first.binding.selectionIsAnchored }
        try require(host.activeView === first && first.canAddComment, "Add comment was unavailable for a non-empty selection")
        let model = try commentModel(host, first)
        let controller = MacChapterCommentsViewController(model: model)
        _ = controller.view
        try require(model.comments.isEmpty && controller.renderedIDs.isEmpty, "New chapter listed comments")
        let before = try read(core).projection

        let comment: WorkspaceComment = try commentResult {
            first.addComment("核对：🙂\n\n第二段", range: first.textView.selectedRange(), revision: first.binding.store.projection!.revision, completion: $0)
        }
        try commentSettled(host, first, passive)
        try wait { !model.busy && model.comments.count == 1 }
        try require(comment.review == .open && comment.source == "manual" && comment.kind == "note"
            && comment.targetId == chapter.id && comment.bodyText == "核对：🙂\n\n第二段" && comment.selectedText == "🙂来信\n海",
            "Created comment row differs from the manual note contract")
        let after = try read(core).projection
        let anchor = after.comments.first { $0.id == comment.id }
        try require(NativeText.identical(after.text, before.text) && after.revision > before.revision
            && after.canUndo == before.canUndo && after.canRedo == before.canRedo,
            "Creating a comment changed prose or history availability")
        try require(anchor?.anchorStatus == .anchored && anchor?.ranges == [NativeRange(location: 2, length: 6)],
            "Created comment was not anchored at the trimmed selection")
        for view in [first, passive] {
            try require(highlighted(view, at: 2) && highlighted(view, at: 7) && !highlighted(view, at: 0) && !highlighted(view, at: 9),
                "A same-chapter view did not adopt the new highlight")
        }
        try require(first.textView.selectedRange() == selection && passive.textView.selectedRange() == NSRange(location: 8, length: 2),
            "Creating a comment moved a view selection")
        let entry = try model.entries.first.unwrapComment("Model did not list the created comment")
        try require(entry.id == comment.id && entry.quote == "🙂来信\n海" && entry.anchorStatus == .anchored
            && entry.canLocate && entry.comment.bodyText == comment.bodyText && controller.renderedIDs == [comment.id],
            "Comment list did not join the row with its anchor")

        // Move the anchor, then locate by identity from the current projection.
        first.textView.insertText("序", replacementRange: NSRange(location: 0, length: 0))
        try commentSettled(host, first, passive)
        first.textView.setSelectedRange(NSRange(location: 0, length: 0))
        try wait { first.binding.selectionIsAnchored }
        let passiveSelection = passive.textView.selectedRange()
        try require(passiveSelection == NSRange(location: 9, length: 2), "Passive selection did not follow the prefix edit")
        try wait { model.entries.first?.anchor?.locatableRange == NativeRange(location: 3, length: 6) }
        let beforeLocate = try read(core).projection
        try require(first.locateComment(id: comment.id) == nil, "Current comment anchor was not locatable")
        try wait { first.binding.selectionIsAnchored }
        try require(first.textView.selectedRange() == NSRange(location: 3, length: 6)
            && (first.textView.string as NSString).substring(with: first.textView.selectedRange()) == "🙂来信\n海",
            "Locate selected the wrong text")
        try require(passive.textView.selectedRange() == passiveSelection && host.activeView === first,
            "Locate moved the other pane's selection or changed the active pane")
        let afterLocate = try read(core).projection
        try require(afterLocate.revision == beforeLocate.revision && afterLocate.canUndo == beforeLocate.canUndo,
            "Locate authored document history")
        try require(first.locateComment(id: "missing-comment") != nil && first.textView.selectedRange() == NSRange(location: 3, length: 6),
            "Locating an unknown comment changed the selection")
        first.undoProse(); try commentSettled(host, first, passive)
        let undone = try read(core).projection
        try require(first.textView.string == "雨夜🙂来信\n海岸线"
            && undone.comments.first { $0.id == comment.id }?.ranges == [NativeRange(location: 2, length: 6)],
            "Undo did not revert only the prose edit around the comment")
        first.redoProse(); try commentSettled(host, first, passive)

        let closed: Bool = try commentResult { host.close(completion: $0) }
        try require(closed, "Comment workspace failed to close")
        let cold = LabWorkspaceCore(directory: directory)
        let _: [WorkspaceProject] = try commentResult { cold.projects(completion: $0) }
        let coldCore: LabCore = try commentResult { cold.openChapter(projectID: project.id, chapterID: chapter.id, completion: $0) }
        let coldView = NativeDocumentView(core: coldCore)
        coldView.binding.load(); try wait { coldView.binding.state != nil && !coldView.binding.hasPendingWork }
        let coldProjection = try read(coldCore).projection
        try require(coldProjection.text == "序雨夜🙂来信\n海岸线"
            && coldProjection.comments.first { $0.id == comment.id }?.ranges == [NativeRange(location: 3, length: 6)]
            && highlighted(coldView, at: 3), "Comment anchor did not survive cold reopen")
        let coldComments: [WorkspaceComment] = try commentResult { coldCore.comments(completion: $0) }
        try require(coldComments.map(\.id) == [comment.id] && coldComments[0].bodyJson == comment.bodyJson
            && coldComments[0].review == .open, "Comment body did not survive cold reopen")
        try require(coldView.binding.detach(), "Cold comment view failed to detach")
        try wait { !cold.hasPendingDocuments }
        let coldClosed: Bool = try commentResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold comment workspace failed to close")
    }

    private static func commentBodyAndResolutionKeepProse() throws {
        let (directory, workspace, project, chapter) = try commentFixture()
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let host = MacChapterWorkspace(workspace: workspace)
        let first: NativeDocumentView = try commentResult { host.open(project: project, chapter: chapter, completion: $0) }
        try commentSettled(host, first)
        let core = host.activeCore!
        first.textView.insertText("灯塔🙂守夜人", replacementRange: NSRange(location: 0, length: 0))
        try commentSettled(host, first)
        first.textView.insertText("续", replacementRange: NSRange(location: 7, length: 0))
        try commentSettled(host, first)
        let revision = { first.binding.store.projection!.revision }
        let note: WorkspaceComment = try commentResult {
            first.addComment("原批注", range: NSRange(location: 2, length: 2), revision: revision(), completion: $0)
        }
        try commentSettled(host, first)
        let generated: WorkspaceComment = try commentResult {
            first.addComment("生成的建议", range: NSRange(location: 4, length: 2), revision: revision(), completion: $0)
        }
        try commentSettled(host, first)
        // A synthetic generated suggestion that was already converted.
        try WorkspaceRemoteProseFixture.execute(in: directory,
            sql: "UPDATE comment SET source = 'copilot', status = 'converted' WHERE id = ?", parameters: [.text(generated.id)])
        let passive: NativeDocumentView = try commentResult { host.split(completion: $0) }
        try commentSettled(host, first, passive)
        passive.textView.setSelectedRange(NSRange(location: 4, length: 2))
        try wait { passive.binding.selectionIsAnchored }
        host.activate(pane: 0)
        first.textView.setSelectedRange(NSRange(location: 0, length: 1))
        try wait { first.binding.selectionIsAnchored }
        let model = try commentModel(host, first)
        let controller = MacChapterCommentsViewController(model: model)
        _ = controller.view
        try require(model.comments.map(\.id) == [note.id, generated.id], "Comment list order differs from creation order")

        let checkpoint: NativeCheckpoint = try commentResult { core.exportDocument(completion: $0) }
        let baseline = try read(core).projection
        func unchanged(_ step: String) throws {
            try commentSettled(host, first, passive)
            let current = try read(core).projection
            let exported: NativeCheckpoint = try commentResult { core.exportDocument(completion: $0) }
            try require(exported.update == checkpoint.update && NativeText.identical(current.text, baseline.text)
                && current.revision == baseline.revision && current.canUndo == baseline.canUndo
                && current.canRedo == baseline.canRedo && current.comments == baseline.comments,
                "\(step) changed prose, anchors or history")
            try require(first.textView.selectedRange() == NSRange(location: 0, length: 1)
                && passive.textView.selectedRange() == NSRange(location: 4, length: 2), "\(step) moved a selection")
        }

        let mutations = try commentMutations(directory)
        let edited: WorkspaceComment = try commentResult { model.updateBody(note.id, body: "改写：🙂\n\n第二段", completion: $0) }
        try wait { !model.busy && model.comments.first?.bodyText == "改写：🙂\n\n第二段" }
        try require(edited.bodyText == "改写：🙂\n\n第二段" && edited.bodyJson != note.bodyJson
            && edited.anchorJson == note.anchorJson && edited.review == .open, "Body edit changed more than the body")
        try require(try commentMutations(directory) == mutations + 1, "Body edit did not write exactly one comment field")
        try unchanged("Body edit")

        let resolved: WorkspaceComment = try commentResult { model.setResolved(note.id, resolved: true, completion: $0) }
        try require(resolved.review == .resolved && resolved.resolvedAt != nil && resolved.bodyJson == edited.bodyJson,
            "Resolve did not record the review state")
        try wait { !model.busy && model.comments.first?.review == .resolved }
        // Resolved notes and accepted or rejected suggestions wait behind 显示已解决.
        try require(model.entries.isEmpty && controller.renderedIDs.isEmpty,
            "Resolved comment and converted suggestion were not hidden by default")
        model.showResolved = true
        try require(controller.renderedIDs == [note.id, generated.id]
            && (commentControl(controller.view, "resolve-comment-\(note.id)") as? NSButton)?.title == "重新打开",
            "显示已解决 did not list the resolved comment with a reopen action")
        try require(try commentMutations(directory) == mutations + 3, "Resolve did not write resolvedAt and status")
        let repeated: WorkspaceComment = try commentResult { model.setResolved(note.id, resolved: true, completion: $0) }
        let repeatedMutations = try commentMutations(directory)
        try require(repeated.review == .resolved && repeatedMutations == mutations + 3, "Repeating resolve wrote another original")
        try unchanged("Resolve")
        let reopened: WorkspaceComment = try commentResult { model.setResolved(note.id, resolved: false, completion: $0) }
        try require(reopened.review == .open && reopened.resolvedAt == nil, "Reopen did not clear the resolution")
        try unchanged("Reopen")
        let _: WorkspaceComment = try commentResult { model.setResolved(note.id, resolved: true, completion: $0) }
        try unchanged("Second resolve")

        // Generated and converted rows (under 显示已解决) are read-only and terminal.
        let generatedEntry = try model.entries.first { $0.id == generated.id }.unwrapComment("Converted row was hidden")
        try require(!generatedEntry.comment.canEditBody && !generatedEntry.comment.canChangeResolution
            && commentControl(controller.view, "edit-comment-\(generated.id)")?.isHidden == true
            && commentControl(controller.view, "resolve-comment-\(generated.id)")?.isHidden == true,
            "Generated converted comment offered edit or resolve")
        let beforeRefusals = try commentMutations(directory)
        _ = try commentRefused({ model.updateBody(generated.id, body: "改写", completion: $0) }, "Model edited a generated comment")
        _ = try commentRefused({ model.setResolved(generated.id, resolved: true, completion: $0) }, "Model resolved a converted comment")
        let coreRefusal = try commentRefused({ first.binding.store.setCommentResolved(id: generated.id, resolved: true, completion: $0) },
            "Core resolved a converted suggestion")
        let afterRefusals = try commentMutations(directory)
        try require(coreRefusal == "已转化的建议不能解决或重新打开。" && afterRefusals == beforeRefusals,
            "Converted refusal was not explained or wrote an original")
        try unchanged("Refused converted commands")
        try require(first.binding.canEdit && first.canAddComment, "A refused comment command left the editor unusable")

        first.undoProse(); try commentSettled(host, first, passive)
        try require(first.textView.string == "灯塔🙂守夜人", "Comment commands added an undo step")
        first.redoProse(); try commentSettled(host, first, passive)
        try require(first.textView.string == "灯塔🙂守夜人续", "Comment commands damaged redo")

        let closed: Bool = try commentResult { host.close(completion: $0) }
        try require(closed, "Comment workspace failed to close")
        let cold = LabWorkspaceCore(directory: directory)
        let _: [WorkspaceProject] = try commentResult { cold.projects(completion: $0) }
        let coldCore: LabCore = try commentResult { cold.openChapter(projectID: project.id, chapterID: chapter.id, completion: $0) }
        let coldComments: [WorkspaceComment] = try commentResult { coldCore.comments(completion: $0) }
        try require(coldComments.map(\.id) == [note.id, generated.id]
            && coldComments[0].bodyText == "改写：🙂\n\n第二段" && coldComments[0].review == .resolved && coldComments[0].resolvedAt != nil
            && coldComments[1].review == .converted && coldComments[1].source == "copilot",
            "Body or review state did not survive cold reopen")
        let coldProjection = try read(coldCore).projection
        try require(coldProjection.text == "灯塔🙂守夜人续" && coldProjection.comments == baseline.comments,
            "Cold reopen changed prose or anchors")
        let coldClosed: Bool = try commentResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold comment workspace failed to close")
    }

    private static func commentRefusalsCreateNothing() throws {
        let (directory, workspace, project, chapter) = try commentFixture()
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let host = MacChapterWorkspace(workspace: workspace)
        let view: NativeDocumentView = try commentResult { host.open(project: project, chapter: chapter, completion: $0) }
        try commentSettled(host, view)
        let core = host.activeCore!
        view.textView.insertText("北岸  🙂灯火", replacementRange: NSRange(location: 0, length: 0))
        try commentSettled(host, view)
        let valid = NSRange(location: 0, length: 2)
        view.textView.setSelectedRange(valid)
        try wait { view.binding.selectionIsAnchored }
        let before = try read(core).projection
        let checkpoint: NativeCheckpoint = try commentResult { core.exportDocument(completion: $0) }
        func nothingCreated(_ step: String) throws {
            try commentSettled(host, view)
            let current = try read(core).projection
            let listed: [WorkspaceComment] = try commentResult { core.comments(completion: $0) }
            let rows = try commentCount(directory, "SELECT COUNT(*) AS n FROM comment"), originals = try commentMutations(directory)
            try require(listed.isEmpty && current.comments.isEmpty && current.revision == before.revision && rows == 0 && originals == 0,
                "\(step) created a comment row, anchor or original")
            let exported: NativeCheckpoint = try commentResult { core.exportDocument(completion: $0) }
            try require(exported.update == checkpoint.update && view.textView.selectedRange() == valid && view.binding.canEdit,
                "\(step) changed prose, selection or editability")
        }

        let stale = try commentRefused({ view.addComment("过期", range: valid, revision: before.revision - 1, completion: $0) },
            "Stale revision created a comment")
        try require(stale == "正文已变化，请重新选择要批注的文字。", "Stale refusal did not explain the reselection")
        _ = try commentRefused({ (done: @escaping (Result<WorkspaceCommentCreation, Error>) -> Void) in
            core.createComment(revision: before.revision + 7, range: valid, body: "过期", completion: done)
        }, "Core accepted a stale revision")
        try nothingCreated("Stale revision")

        view.textView.setSelectedRange(NSRange(location: 2, length: 2))
        try require(!view.canAddComment, "Add comment was enabled for a blank selection")
        view.textView.setSelectedRange(valid)
        try wait { view.binding.selectionIsAnchored }
        _ = try commentRefused({ view.addComment("空白", range: NSRange(location: 2, length: 2), revision: before.revision, completion: $0) },
            "Blank selection created a comment")
        let empty = try commentRefused({ view.addComment(" \n ", range: valid, revision: before.revision, completion: $0) },
            "Empty body created a comment")
        try require(empty == "批注内容不能为空。", "Empty body refusal was not explained")
        try nothingCreated("Blank selection and empty body")

        try WorkspaceRemoteProseFixture.execute(in: directory,
            sql: "CREATE TRIGGER fail_comment_receipt BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT, 'synthetic comment receipt failure'); END")
        defer { try? WorkspaceRemoteProseFixture.execute(in: directory, sql: "DROP TRIGGER IF EXISTS fail_comment_receipt") }
        let composer = MacCommentComposerViewController(title: "添加批注", confirmTitle: "添加", quote: "北岸")
        composer.onSubmit = { body, done in
            view.addComment(body, range: valid, revision: before.revision) { result in
                if case .failure(let error) = result { done(error) } else { done(nil) }
            }
        }
        composer.text = "保留的批注🙂"
        composer.submit()
        try wait { !composer.isSubmitting }
        try require(composer.text == "保留的批注🙂" && !composer.errorMessage.isEmpty,
            "Failed commit discarded the composer text or hid the reason")
        try WorkspaceRemoteProseFixture.execute(in: directory, sql: "DROP TRIGGER fail_comment_receipt")
        try nothingCreated("Failed comment transaction")
        let blank = MacCommentComposerViewController(title: "添加批注", confirmTitle: "添加", quote: "北岸")
        var submitted = false
        blank.onSubmit = { _, done in submitted = true; done(nil) }
        blank.text = "  \n"
        blank.submit()
        try require(!submitted && blank.errorMessage == "请输入批注内容。" && blank.text == "  \n", "Composer submitted an empty body")

        view.textView.insertText("前", replacementRange: NSRange(location: 0, length: 0))
        try require(view.binding.hasPendingWork && !view.canAddComment, "Queued input left add comment enabled")
        _ = try commentRefused({ view.addComment("排队", range: NSRange(location: 1, length: 2), revision: before.revision, completion: $0) },
            "Queued input created a comment")
        try require(view.locateComment(id: "any") != nil, "Locate ran behind queued input")
        try commentSettled(host, view)
        let queued = try read(core).projection
        let queuedRows = try commentCount(directory, "SELECT COUNT(*) AS n FROM comment")
        try require(queued.text == "前北岸  🙂灯火" && queued.comments.isEmpty && queuedRows == 0, "Queued input refusal created a comment")

        view.textView.setSelectedRange(NSRange(location: 1, length: 2))
        try wait { view.binding.selectionIsAnchored }
        view.textView.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: 0, length: 0))
        let marked = view.textView.string
        try require(!view.canAddComment, "Marked input left add comment enabled")
        _ = try commentRefused({ view.addComment("标记", range: NSRange(location: 6, length: 2), revision: queued.revision, completion: $0) },
            "Marked input created a comment")
        _ = try commentRefused({ view.binding.store.createComment(range: NSRange(location: 1, length: 2), revision: queued.revision,
            body: "标记", completion: $0) }, "Store created a comment behind marked input")
        try require(view.textView.hasMarkedText() && view.textView.string == marked, "Comment refusal disturbed marked input")
        view.textView.insertText("", replacementRange: NSRange(location: NSNotFound, length: 0))
        try commentSettled(host, view)
        let afterMarked = try read(core).projection
        let markedRows = try commentCount(directory, "SELECT COUNT(*) AS n FROM comment"), markedOriginals = try commentMutations(directory)
        try require(afterMarked.text == "前北岸  🙂灯火" && afterMarked.comments.isEmpty && markedRows == 0 && markedOriginals == 0,
            "Marked input refusal created a comment")

        // The owner stays usable after every refusal.
        view.textView.setSelectedRange(NSRange(location: 1, length: 2))
        try wait { view.binding.selectionIsAnchored }
        let accepted: WorkspaceComment = try commentResult {
            view.addComment("通过", range: view.textView.selectedRange(), revision: afterMarked.revision, completion: $0)
        }
        try commentSettled(host, view)
        let acceptedAnchors = try read(core).projection.comments.map(\.id), acceptedOriginals = try commentMutations(directory)
        try require(acceptedAnchors == [accepted.id] && acceptedOriginals == 1, "A valid comment after refusals was not created exactly once")
        let closed: Bool = try commentResult { host.close(completion: $0) }
        try require(closed, "Comment workspace failed to close")
    }
}

private extension Optional {
    func unwrapComment(_ message: String) throws -> Wrapped {
        guard let value = self else { throw LabError.message(message) }
        return value
    }
}
