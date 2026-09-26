import AppKit

private func changesResult<T>(_ operation: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
    var result: Result<T, Error>?
    operation { result = $0 }
    try BindingAcceptance.wait { result != nil }
    return try result!.get()
}

private final class RemoteChangesPair {
    typealias Fixture = WorkspaceRemoteProseFixture
    let parent: URL
    let sourceDirectory: URL
    let receiverDirectory: URL
    let source: LabWorkspaceCore
    let receiver: LabWorkspaceCore
    let project: WorkspaceProject
    let chapters: [WorkspaceChapter]

    init() throws {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let sourceDirectory = parent.appendingPathComponent("source/apple-native-lab")
        let receiverDirectory = parent.appendingPathComponent("receiver/apple-native-lab")
        let source = LabWorkspaceCore(directory: sourceDirectory)
        let receiver = LabWorkspaceCore(directory: receiverDirectory)
        let _: [WorkspaceProject] = try changesResult { source.projects(completion: $0) }
        let project: WorkspaceProject = try changesResult { source.createProject(name: "元数据合成项目", completion: $0) }
        let chapters: [WorkspaceChapter] = try ["首章", "次章"].map { title in
            try changesResult { source.createChapter(projectID: project.id, title: title, completion: $0) }
        }
        let _: Bool = try changesResult { source.close(completion: $0) }
        try Fixture.copyClosedBaseline(from: sourceDirectory, to: [receiverDirectory])
        let _: [WorkspaceProject] = try changesResult { source.projects(completion: $0) }
        let _: [WorkspaceProject] = try changesResult { receiver.projects(completion: $0) }
        self.parent = parent; self.sourceDirectory = sourceDirectory; self.receiverDirectory = receiverDirectory
        self.source = source; self.receiver = receiver; self.project = project; self.chapters = chapters
    }

    /// Read actual authored originals; no test payload or receipt is fabricated.
    private func originals() throws -> [[String: Fixture.SQLValue]] {
        try Fixture.query(in: sourceDirectory, sql: """
            SELECT project_id, project_sync_id, sync_generation_id, change_set_id, payload_sha256, encoded_bytes
            FROM sync_change_set WHERE origin = 'local' AND apply_state = 'applied' ORDER BY rowid
            """)
    }

    func author<T>(_ operation: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> (T, RemoteProseTestPacket) {
        let before = try originals().compactMap { row -> String? in
            if case .text(let id) = row["change_set_id"] { return id }; return nil
        }
        let value = try changesResult(operation)
        let rows = try originals().filter { row in
            if case .text(let id) = row["change_set_id"] { return !before.contains(id) }; return false
        }
        try BindingAcceptance.require(rows.count == 1, "One native metadata command did not author one original")
        let row = rows[0]
        guard case .text(let projectID) = row["project_id"],
              case .text(let projectSyncID) = row["project_sync_id"],
              case .text(let generationID) = row["sync_generation_id"],
              case .text(let changeSetID) = row["change_set_id"],
              case .text(let envelopeHash) = row["payload_sha256"],
              case .blob(let envelope) = row["encoded_bytes"] else {
            throw LabError.message("Metadata original fixture is malformed")
        }
        return (value, RemoteProseTestPacket(original: RemoteChangeOriginal(projectId: projectID,
            projectSyncId: projectSyncID, syncGenerationId: generationID, changeSetId: changeSetID,
            originalEnvelopeSha256: envelopeHash), envelope: envelope))
    }

    func receive(_ packet: RemoteProseTestPacket) throws -> WorkspaceRemoteChangesReply {
        try changesResult { receiver.receiveChanges(original: packet.original, envelope: packet.envelope, completion: $0) }
    }

    func open(_ chapter: WorkspaceChapter) throws -> (LabCore, NativeDocumentView) {
        let core: LabCore = try changesResult { receiver.openChapter(projectID: project.id, chapterID: chapter.id, completion: $0) }
        let view = NativeDocumentView(core: core)
        view.binding.load()
        try settle(view)
        return (core, view)
    }

    func settle(_ view: NativeDocumentView) throws {
        try BindingAcceptance.wait { view.binding.state != nil && !view.binding.hasPendingWork }
    }

    func close(_ view: NativeDocumentView) throws {
        try BindingAcceptance.require(view.binding.detach(), "Metadata receiver view did not detach")
        try BindingAcceptance.wait { !self.receiver.hasPendingDocuments }
        let _: Bool = try changesResult { receiver.close(completion: $0) }
        let _: Bool = try changesResult { source.close(completion: $0) }
        try FileManager.default.removeItem(at: parent)
    }
}

extension BindingAcceptance {
    static func workspaceRemoteChangesAcceptance() throws -> [String] {
        try workspaceRemoteChapterCreation()
        try workspaceRemoteMetadataRetainsEditor()
        return [
            "AppKit remote chapter creation refreshes workspace lists and remains editable after cold reopen",
            "AppKit remote metadata preserves the live owner selection and history and rejects invalid originals atomically",
        ]
    }

    private static func workspaceRemoteChapterCreation() throws {
        let pair = try RemoteChangesPair()
        let (chapter, packet): (WorkspaceChapter, RemoteProseTestPacket) = try pair.author {
            pair.source.createChapter(projectID: pair.project.id, title: "远端新章🙂", completion: $0)
        }
        let reply = try pair.receive(packet)
        try require(!reply.alreadyApplied && reply.projectId == pair.project.id, "Creation receipt identity differs")
        try require(reply.projects.contains { $0.id == pair.project.id } && reply.chapters.contains { $0.id == chapter.id && $0.title == chapter.title },
            "Creation reply omitted the fresh workspace lists")
        try require(reply.affectedDocuments.contains("node-content:" + chapter.id), "Creation did not materialize its real prose seed")
        let listed: [WorkspaceChapter] = try changesResult { pair.receiver.chapters(projectID: pair.project.id, completion: $0) }
        try require(listed.map(\.id) == reply.chapters.map(\.id), "Creation reply list differs from the shared workspace query")
        let (core, view) = try pair.open(chapter)
        try require(view.textView.string.isEmpty, "Remote chapter seed was not empty")
        view.textView.insertText("新章正文🙂", replacementRange: NSRange(location: 0, length: 0))
        try pair.settle(view)
        try require(try read(core).projection.text == "新章正文🙂", "Received chapter was not natively editable")
        try require(view.binding.detach(), "Received chapter could not detach")
        try wait { !pair.receiver.hasPendingDocuments }
        let _: Bool = try changesResult { pair.receiver.close(completion: $0) }
        let _: [WorkspaceProject] = try changesResult { pair.receiver.projects(completion: $0) }
        let (coldCore, coldView) = try pair.open(chapter)
        try require(coldCore !== core && core.isClosed && coldView.textView.string == "新章正文🙂", "Received chapter failed cold reopen")
        try pair.close(coldView)
    }

    private static func workspaceRemoteMetadataRetainsEditor() throws {
        let pair = try RemoteChangesPair(), (core, view) = try pair.open(pair.chapters[0])
        view.textView.insertText("正文🙂", replacementRange: NSRange(location: 0, length: 0))
        try pair.settle(view)
        view.textView.setSelectedRange(NSRange(location: 2, length: 2))
        try wait { view.binding.selectionIsAnchored }
        let before: NativeCheckpoint = try changesResult { core.exportDocument(completion: $0) }
        let (project, projectPacket): (WorkspaceProject, RemoteProseTestPacket) = try pair.author {
            pair.source.renameProject(projectID: pair.project.id, name: "远端项目名", completion: $0)
        }
        let projectReply = try pair.receive(projectPacket)
        try pair.settle(view)
        try require(projectReply.projects.contains { $0.id == project.id && $0.name == project.name }, "Project rename reply is stale")
        let (chapter, chapterPacket): (WorkspaceChapter, RemoteProseTestPacket) = try pair.author {
            pair.source.renameChapter(projectID: pair.project.id, chapterID: pair.chapters[0].id, title: "远端首章", completion: $0)
        }
        let chapterReply = try pair.receive(chapterPacket)
        try pair.settle(view)
        try require(chapterReply.chapters.contains { $0.id == chapter.id && $0.title == chapter.title }, "Chapter rename reply is stale")
        let (_, movePacket): ([WorkspaceChapter], RemoteProseTestPacket) = try pair.author {
            pair.source.moveChapter(projectID: pair.project.id, chapterID: pair.chapters[1].id,
                beforeChapterID: pair.chapters[0].id, completion: $0)
        }
        let moved = try pair.receive(movePacket)
        try pair.settle(view)
        try require(moved.chapters.map(\.id) == [pair.chapters[1].id, pair.chapters[0].id], "Received order did not refresh the chapter list")
        let retained: LabCore = try changesResult { pair.receiver.openChapter(projectID: pair.project.id, chapterID: chapter.id, completion: $0) }
        let after: NativeCheckpoint = try changesResult { core.exportDocument(completion: $0) }
        try require(retained === core && view.textView.string == "正文🙂" && before.update == after.update
            && view.textView.selectedRange() == NSRange(location: 2, length: 2) && view.binding.state?.projection.canUndo == true,
            "Metadata delivery replaced the owner, prose, selection or undo history")
        let counts = try WorkspaceRemoteProseFixture.durableCounts(in: pair.receiverDirectory, documentID: "node-content:" + chapter.id)
        let original = movePacket.original
        let invalid = RemoteChangeOriginal(projectId: original.projectId, projectSyncId: "wrong-scope",
            syncGenerationId: original.syncGenerationId, changeSetId: original.changeSetId, originalEnvelopeSha256: original.originalEnvelopeSha256)
        var refused: Result<WorkspaceRemoteChangesReply, Error>?
        pair.receiver.receiveChanges(original: invalid, envelope: movePacket.envelope) { refused = $0 }
        try wait { refused != nil }
        if case .success = refused! { throw LabError.message("Invalid whole metadata original returned a workspace refresh") }
        let stillListed: [WorkspaceChapter] = try changesResult { pair.receiver.chapters(projectID: pair.project.id, completion: $0) }
        let stillCounts = try WorkspaceRemoteProseFixture.durableCounts(in: pair.receiverDirectory, documentID: "node-content:" + chapter.id)
        try require(stillListed.map(\.id) == moved.chapters.map(\.id) && stillCounts == counts
            && view.textView.string == "正文🙂" && view.textView.selectedRange() == NSRange(location: 2, length: 2),
            "Rejected metadata changed lists, durable rows or the visible editor")
        view.undoProse(); try pair.settle(view)
        try require(view.textView.string.isEmpty, "Metadata delivery inserted a prose undo unit")
        view.redoProse(); try pair.settle(view)
        try require(view.textView.string == "正文🙂", "Metadata delivery changed redo")
        try pair.close(view)
    }
}
