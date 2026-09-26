import AppKit

extension BindingAcceptance {
    private static func coreResult<T>(_ operation: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
        var result: Result<T, Error>?
        operation { result = $0 }; try wait { result != nil }
        return try result!.get()
    }

    /// Real serial Swift -> ABI -> SQLite calls; native marked-text callbacks
    /// are a separate integration gate and are not simulated by these methods.
    static func draftTransportAcceptance() throws -> [String] {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: parent) }
        let owner = LabCore(directory: parent.appendingPathComponent("owner/apple-native-lab"))
        let peer = LabCore(directory: parent.appendingPathComponent("peer/apple-native-lab"))
        let _: LabState = try coreResult { owner.open(completion: $0) }
        let _: LabState = try coreResult { peer.open(completion: $0) }
        let original = try read(owner), peerState = try read(peer)
        let quote = original.projection.comments[0].ranges[0].nsRange
        let before: NativeCheckpoint = try coreResult { owner.exportDocument(completion: $0) }
        let _: Bool = try coreResult { owner.beginDraft(key: "ime", revision: original.projection.revision, range: quote, completion: $0) }
        let marked: NativeCheckpoint = try coreResult { owner.exportDocument(completion: $0) }
        try require(before.update == marked.update, "Starting a draft published marked text or mutated the CRDT")
        let _: LabDocumentState = try coreResult { peer.document("documentReplace", edit: ["revision": peerState.projection.revision,
            "range": ["location": quote.location + 1, "length": 0], "text": "远端"], completion: $0) }
        let incoming: NativeCheckpoint = try coreResult { peer.exportDocument(completion: $0) }
        let received: LabDocumentState = try coreResult { owner.applyRemote(incoming.update, completion: $0) }
        try require(received.saved && received.projection.text.contains("北远端塔"), "Remote insertion did not persist while composing")
        let committed: LabDocumentState = try coreResult { owner.commitDraft(key: "ime", text: "新",
            selection: DraftSelection(viewID: "transport", epoch: 1, range: NSRange(location: quote.location + 1, length: 0)), completion: $0) }
        try require(committed.saved && committed.projection.text.contains("新") && committed.projection.text.contains("远端"), "Composition overwrote concurrent remote text")
        try require(!committed.projection.text.contains("北远端塔"), "Composition failed to replace its original items")
        let caret = committed.projection.selections.first { $0.viewId == "transport" }?.range?.location
        try require(caret == (committed.projection.text as NSString).range(of: "新").location + 1, "Authored caret did not resolve in the merged text")
        let duplicate: LabDocumentState = try coreResult { owner.applyRemote(incoming.update, completion: $0) }
        try require(duplicate.projection.text == committed.projection.text, "Duplicate replay changed committed prose")
        let undone: LabDocumentState = try coreResult { owner.document("documentUndo", completion: $0) }
        try require(undone.projection.text == received.projection.text, "Local undo removed remote text")
        let redone: LabDocumentState = try coreResult { owner.document("documentRedo", completion: $0) }
        try require(redone.projection.text == committed.projection.text, "Draft redo diverged")
        let _: Bool = try coreResult { owner.beginDraft(key: "cancel", revision: redone.projection.revision,
            range: NSRange(location: 0, length: 0), completion: $0) }
        var refused: Result<LabState, Error>?
        owner.reopen { refused = $0 }; try wait { refused != nil }
        if case .success = refused! { throw LabError.message("Reopen discarded an active draft") }
        let _: Bool = try coreResult { owner.cancelDraft(key: "cancel", completion: $0) }
        let _: LabState = try coreResult { owner.reopen(completion: $0) }
        let recovered = try read(owner)
        try require(recovered.projection.text == committed.projection.text, "Merged draft did not survive SQLite reopen")
        return ["Swift draft transport preserves overlapping remote text and authored selection",
            "draft cancel, duplicate replay, local history and SQLite reopen"]
    }
}
