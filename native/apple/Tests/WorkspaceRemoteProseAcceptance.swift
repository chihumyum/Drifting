import AppKit

private final class RemoteProsePair {
    let parent: URL
    let source: LabWorkspaceCore
    let receiver: LabWorkspaceCore
    let sourceDirectory: URL
    let receiverDirectory: URL
    let project: WorkspaceProject
    let chapters: [WorkspaceChapter]
    static let seed = "甲甲🙂海岸"

    init() throws {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let sourceDirectory = parent.appendingPathComponent("source/apple-native-lab")
        let receiverDirectory = parent.appendingPathComponent("receiver/apple-native-lab")
        let source = LabWorkspaceCore(directory: sourceDirectory)
        let receiver = LabWorkspaceCore(directory: receiverDirectory)
        let _: [WorkspaceProject] = try remoteResult { source.projects(completion: $0) }
        let project: WorkspaceProject = try remoteResult { source.createProject(name: "同步原件合成项目", completion: $0) }
        let first: WorkspaceChapter = try remoteResult { source.createChapter(projectID: project.id, title: "初航", completion: $0) }
        let second: WorkspaceChapter = try remoteResult { source.createChapter(projectID: project.id, title: "归航", completion: $0) }
        let chapters = [first, second]
        for (index, chapter) in chapters.enumerated() {
            let core: LabCore = try remoteResult { source.openChapter(projectID: project.id, chapterID: chapter.id, completion: $0) }
            try directEdit(core, text: index == 0 ? Self.seed : "次章正文", range: NSRange(location: 0, length: 0))
        }
        let _: Bool = try remoteResult { source.close(completion: $0) }
        try WorkspaceRemoteProseFixture.copyClosedBaseline(from: sourceDirectory, to: [receiverDirectory])
        let _: [WorkspaceProject] = try remoteResult { source.projects(completion: $0) }
        let _: [WorkspaceProject] = try remoteResult { receiver.projects(completion: $0) }
        self.parent = parent; self.sourceDirectory = sourceDirectory; self.receiverDirectory = receiverDirectory
        self.source = source; self.receiver = receiver; self.project = project; self.chapters = chapters
    }
    func core(_ index: Int, from workspace: LabWorkspaceCore? = nil) throws -> LabCore {
        try remoteResult { (workspace ?? receiver).openChapter(projectID: project.id, chapterID: chapters[index].id, completion: $0) }
    }
    func packet(_ index: Int, text: String, range: NSRange = NSRange(location: 0, length: 0)) throws -> RemoteProseTestPacket {
        let id = "node-content:" + chapters[index].id
        let old = Set(try WorkspaceRemoteProseFixture.localPackets(in: sourceDirectory, documentID: id).map { $0.original.changeSetId })
        try directEdit(core(index, from: source), text: text, range: range)
        let packets = try WorkspaceRemoteProseFixture.localPackets(in: sourceDirectory, documentID: id, excluding: old)
        try BindingAcceptance.require(packets.count == 1, "Native authoring did not produce exactly one original")
        return packets[0]
    }
    func receive(_ packet: RemoteProseTestPacket) throws -> WorkspaceRemoteProseReply {
        try remoteResult { receiver.receiveProse(original: packet.original, envelope: packet.envelope, completion: $0) }
    }
    func counts(_ index: Int = 0) throws -> [String: Int64] {
        try WorkspaceRemoteProseFixture.durableCounts(in: receiverDirectory, documentID: "node-content:" + chapters[index].id)
    }
    func close(_ views: [NativeDocumentView]) throws {
        for view in views { try BindingAcceptance.require(view.binding.detach(), "Could not detach settled remote view") }
        try BindingAcceptance.wait { !self.receiver.hasPendingDocuments }
        let _: Bool = try remoteResult { receiver.close(completion: $0) }
        let _: Bool = try remoteResult { source.close(completion: $0) }
        try FileManager.default.removeItem(at: parent)
    }
}

private func remoteResult<T>(_ operation: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
    var result: Result<T, Error>?
    operation { result = $0 }; try BindingAcceptance.wait { result != nil }
    return try result!.get()
}
private func directEdit(_ core: LabCore, text: String, range: NSRange) throws {
    let state = try BindingAcceptance.read(core)
    let result: LabDocumentState = try remoteResult { core.document("documentReplace", edit: [
        "revision": state.projection.revision, "range": ["location": range.location, "length": range.length], "text": text,
    ], completion: $0) }
    try BindingAcceptance.require(result.saved, "Synthetic direct native edit failed")
}
private func remoteViews(_ core: LabCore) throws -> (NativeDocumentView, NativeDocumentView) {
    let first = NativeDocumentView(core: core), second = NativeDocumentView(core: core)
    first.binding.load(); second.binding.load()
    try BindingAcceptance.wait { first.binding.state != nil && !first.binding.hasPendingWork }
    return (first, second)
}

extension BindingAcceptance {
    static func workspaceRemoteProseAcceptance() throws -> [String] {
        try workspaceRemoteQueuedInput()
        try workspaceRemoteMarkedInput()
        try workspaceRemoteHiddenOwners()
        try workspaceRemoteFailureRetry()
        return [
            "AppKit canonical remote originals preserve queued Unicode input passive selection and local undo",
            "AppKit canonical remote originals preserve marked branches through native commit and cancellation",
            "AppKit duplicate and explicit reconciliation refresh every retained chapter without rewriting receipts",
            "AppKit rejected originals and committed checkpoint failure retain owners drafts and retry through cold reopen",
        ]
    }

    private static func workspaceRemoteQueuedInput() throws {
        let pair = try RemoteProsePair(), core = try pair.core(0)
        let (first, second) = try remoteViews(core)
        let packet = try pair.packet(0, text: "远🙂")
        second.textView.setSelectedRange(NSRange(location: 4, length: 2))
        try wait { second.binding.selectionIsAnchored }
        var received: Result<WorkspaceRemoteProseReply, Error>?
        first.textView.insertText("乙", replacementRange: NSRange(location: 1, length: 1))
        pair.receiver.receiveProse(original: packet.original, envelope: packet.envelope) { received = $0 }
        first.textView.insertText("续", replacementRange: NSRange(location: 6, length: 0))
        var close: Result<Bool, Error>?
        pair.receiver.close { close = $0 }
        try wait { received != nil && close != nil && !first.binding.hasPendingWork }
        if case .success = close! { throw LabError.message("Workspace closed during remote delivery and queued input") }
        try require(!(try received!.get()).alreadyApplied, "First original was skipped")
        let expected = "远🙂甲乙🙂海岸续"
        try require(first.textView.string == expected && second.textView.string == expected, "Remote delivery lost or moved queued repeated-text input")
        try require(second.textView.selectedRange() == NSRange(location: 7, length: 2), "Remote delivery moved passive selection to the wrong CRDT text")
        first.undoProse(); try wait { !first.binding.hasPendingWork }
        try require(first.textView.string == "远🙂甲乙🙂海岸", "Local undo removed remote text")
        first.undoProse(); try wait { !first.binding.hasPendingWork }
        try require(first.textView.string == "远🙂" + RemoteProsePair.seed, "Second local undo changed the remote insertion")
        let before = try pair.counts()
        try require(try pair.receive(packet).alreadyApplied, "Repeated original was not deduplicated")
        try wait { !first.binding.hasPendingWork }
        try require(try pair.counts() == before, "Duplicate authored another receipt or revision")
        try pair.close([first, second])
    }

    private static func workspaceRemoteMarkedInput() throws {
        let pair = try RemoteProsePair(), core = try pair.core(0)
        let (first, second) = try remoteViews(core)
        first.textView.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: 1, length: 0))
        try wait { !first.binding.store.hasPendingCommits }
        let visible = first.textView.string, inputKey = first.binding.inputKey, markedRange = first.textView.markedRange()
        _ = try pair.receive(pair.packet(0, text: "远🙂"))
        try wait { !first.binding.store.hasPendingCommits }
        try require(first.textView.string == visible && first.textView.hasMarkedText() && first.textView.markedRange() == markedRange
            && first.binding.inputKey == inputKey, "Remote original replaced an active TextKit branch")
        try require(second.textView.string == "远🙂" + RemoteProsePair.seed, "Passive view did not receive prose while composition stayed private")
        first.textView.insertText("中", replacementRange: NSRange(location: NSNotFound, length: 0))
        try wait { !first.binding.hasPendingWork }
        try require(first.textView.string == "远🙂甲中甲🙂海岸" && second.textView.string == first.textView.string, "Composition committed against the wrong input basis")
        first.undoProse(); try wait { !first.binding.hasPendingWork }
        try require(first.textView.string == "远🙂" + RemoteProsePair.seed, "Composition undo removed the remote original")
        first.textView.setMarkedText("linshi", selectedRange: NSRange(location: 6, length: 0), replacementRange: NSRange(location: 0, length: 0))
        try wait { !first.binding.store.hasPendingCommits }
        let tail = try pair.packet(0, text: "终", range: NSRange(location: 9, length: 0))
        _ = try pair.receive(tail); try wait { !first.binding.store.hasPendingCommits }
        first.textView.insertText("", replacementRange: NSRange(location: NSNotFound, length: 0))
        try wait { !first.binding.hasPendingWork }
        try require(first.textView.string == "远🙂" + RemoteProsePair.seed + "终" && second.textView.string == first.textView.string,
            "Native cancellation lost the later original or published marked text")
        try pair.close([first, second])
    }

    private static func workspaceRemoteHiddenOwners() throws {
        let pair = try RemoteProsePair(), firstCore = try pair.core(0), secondCore = try pair.core(1)
        let (first, passive) = try remoteViews(firstCore), (hidden, other) = try remoteViews(secondCore)
        hidden.isHidden = true; other.isHidden = true
        let packet = try pair.packet(0, text: "远")
        _ = try pair.receive(packet); try wait { !first.binding.hasPendingWork && !hidden.binding.hasPendingWork }
        // This real lower-level ABI edit deliberately omits the Swift store
        // notification. Remote COMMIT-before-replay is separately tested in Rust.
        try directEdit(secondCore, text: "未通知", range: NSRange(location: 0, length: 0))
        try require(hidden.textView.string == "次章正文", "The low-level edit unexpectedly refreshed Swift")
        let before = try pair.counts(1)
        _ = try pair.receive(packet); try wait { !first.binding.hasPendingWork && !hidden.binding.hasPendingWork }
        try require(hidden.textView.string == "未通知次章正文" && other.textView.string == hidden.textView.string,
            "A duplicate in another chapter skipped a stale hidden owner")
        try require(try pair.counts(1) == before, "All-owner reconciliation rewrote durable original identity")
        try directEdit(secondCore, text: "再", range: NSRange(location: 0, length: 0))
        let beforeExplicit = try pair.counts(1)
        let _: Bool = try remoteResult { pair.receiver.reconcileProse(projectID: pair.project.id, completion: $0) }
        try wait { !hidden.binding.hasPendingWork }
        try require(try hidden.textView.string == "再未通知次章正文" && pair.counts(1) == beforeExplicit, "Explicit reconciliation did not refresh the same retained owner")
        hidden.undoProse(); try wait { !hidden.binding.hasPendingWork }
        try require(hidden.textView.string == "未通知次章正文", "Reconciliation reset retained chapter history")
        try pair.close([first, passive, hidden, other])
    }

    private static func workspaceRemoteFailureRetry() throws {
        let pair = try RemoteProsePair(), core = try pair.core(0)
        let (first, second) = try remoteViews(core)
        let packet = try pair.packet(0, text: "远🙂")
        first.textView.insertText("本", replacementRange: NSRange(location: 6, length: 0)); try wait { !first.binding.hasPendingWork }
        let before = try pair.counts(), original = packet.original
        let wrong = RemoteProseOriginal(projectId: original.projectId, projectSyncId: "wrong-scope",
            syncGenerationId: original.syncGenerationId, changeSetId: original.changeSetId, originalEnvelopeSha256: original.originalEnvelopeSha256)
        var refused: Result<WorkspaceRemoteProseReply, Error>?
        pair.receiver.receiveProse(original: wrong, envelope: packet.envelope) { refused = $0 }
        try wait { refused != nil }
        if case .success = refused! { throw LabError.message("Wrong-scope original was accepted") }
        try require(try first.binding.canEdit && pair.counts() == before, "Rejected original poisoned input or wrote data")
        try WorkspaceRemoteProseFixture.execute(in: pair.receiverDirectory, sql: "CREATE TRIGGER fail_remote_apply BEFORE INSERT ON sync_apply_receipt BEGIN SELECT RAISE(ABORT,'synthetic receipt fault'); END")
        refused = nil; pair.receiver.receiveProse(original: original, envelope: packet.envelope) { refused = $0 }; try wait { refused != nil }
        if case .success = refused! { throw LabError.message("Injected receipt fault was ignored") }
        try require(try pair.counts() == before && first.textView.string == RemoteProsePair.seed + "本" && first.binding.canEdit, "Receipt rollback changed the live owner")
        try WorkspaceRemoteProseFixture.execute(in: pair.receiverDirectory, sql: "DROP TRIGGER fail_remote_apply")
        first.textView.setMarkedText("pin", selectedRange: NSRange(location: 3, length: 0), replacementRange: NSRange(location: 0, length: 0))
        try wait { !first.binding.store.hasPendingCommits }
        let draft = first.textView.string, key = first.binding.inputKey
        try WorkspaceRemoteProseFixture.execute(in: pair.receiverDirectory, sql: "CREATE TRIGGER fail_remote_checkpoint BEFORE UPDATE ON yjs_snapshots BEGIN SELECT RAISE(ABORT,'synthetic checkpoint fault'); END")
        let receipt = try pair.receive(packet)
        try require(!receipt.alreadyApplied && receipt.documents.contains { !$0.document.saved }, "Checkpoint fault was not separated from durable receive")
        try require(first.textView.string == draft && first.binding.inputKey == key && first.textView.hasMarkedText(), "Committed receive failure replaced a marked draft")
        try WorkspaceRemoteProseFixture.execute(in: pair.receiverDirectory, sql: "DROP TRIGGER fail_remote_checkpoint")
        first.binding.retrySave(); try wait { !first.binding.store.hasPendingCommits }
        try require(second.textView.string == "远🙂" + RemoteProsePair.seed + "本" && first.textView.string == draft, "Save retry lost remote or private marked input")
        first.textView.insertText("", replacementRange: NSRange(location: NSNotFound, length: 0)); try wait { !first.binding.hasPendingWork }
        first.undoProse(); try wait { !first.binding.hasPendingWork }
        let expected = "远🙂" + RemoteProsePair.seed
        try require(first.textView.string == expected, "Retry changed local-only history")
        try require(first.binding.detach() && second.binding.detach(), "Recovered views did not detach")
        try wait { !pair.receiver.hasPendingDocuments }
        let _: Bool = try remoteResult { pair.receiver.close(completion: $0) }
        let _: [WorkspaceProject] = try remoteResult { pair.receiver.projects(completion: $0) }
        let coldCore = try pair.core(0), (cold, coldPassive) = try remoteViews(coldCore)
        try require(coldCore !== core && core.isClosed && cold.textView.string == expected && cold.binding.state?.projection.canUndo == false,
            "Cold reopen did not recover the accepted prose with a fresh owner")
        try pair.close([cold, coldPassive])
    }
}
