import AppKit

extension BindingAcceptance {
    static func prefixDeletionQueueAcceptance() throws -> [String] {
        var cases: [String] = []
        for entirePrefix in [false, true] {
            let scenario = entirePrefix ? "complete prefix" : "partial prefix"
            let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: parent) }
            let owner = LabCore(directory: parent.appendingPathComponent("owner/apple-native-lab"))
            let peer = LabCore(directory: parent.appendingPathComponent("peer/apple-native-lab"))
            func result<T>(_ run: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
                var value: Result<T, Error>?
                run { value = $0 }; try wait { value != nil }; return try value!.get()
            }
            let _: LabState = try result { owner.open(completion: $0) }
            let _: LabState = try result { peer.open(completion: $0) }
            let first = NativeDocumentView(core: owner), second = NativeDocumentView(core: owner)
            defer { _ = first.binding.detach(); _ = second.binding.detach() }
            func settle(_ stage: String) throws {
                try wait {
                    !first.binding.hasPendingWork || first.binding.hasFailedDraft || second.binding.hasFailedDraft
                }
                try require(!first.binding.hasPendingWork && !first.binding.hasUnsubmittedDraft
                    && !second.binding.hasUnsubmittedDraft, "\(scenario), \(stage): queue retained a draft or pending work")
            }
            first.binding.load(); second.binding.load(); try settle("load")
            let original = try read(owner).projection
            guard let paragraph = original.blocks.first(where: { $0.id == "fixture-paragraph" }),
                  let comment = original.comments.first(where: { $0.quote == "北塔" }),
                  let quote = comment.ranges.first else {
                throw LabError.message("Prefix deletion fixture is missing its paragraph or comment")
            }
            let cut = quote.location - paragraph.range.location
            try require(cut > 1 && cut < paragraph.range.length, "Fixture cut must have a nonempty prefix and tail")
            let deleted = NSRange(location: paragraph.range.location + (entirePrefix ? 0 : 1),
                                  length: entirePrefix ? cut : cut - 1)
            let remoteText = (original.text as NSString).replacingCharacters(in: deleted, with: "")
            let liveCut = quote.location - deleted.length
            let splitText = (remoteText as NSString).replacingCharacters(in: NSRange(location: liveCut, length: 0), with: "\n")
            let mergedText = (remoteText as NSString).replacingCharacters(in: NSRange(location: liveCut, length: 0), with: "\n续")
            let authoredText = (original.text as NSString).replacingCharacters(in: NSRange(location: quote.location, length: 0), with: "\n续")
            let peerBefore = try read(peer).projection
            let peerAfter: LabDocumentState = try result {
                peer.document("documentReplace", edit: ["revision": peerBefore.revision,
                    "range": ["location": deleted.location, "length": deleted.length], "text": ""], completion: $0)
            }
            try require(Array(peerAfter.projection.text.utf16) == Array(remoteText.utf16), "Peer deleted the wrong synthetic prefix")
            let incoming: NativeCheckpoint = try result { peer.exportDocument(completion: $0) }
            // Actual TextKit calls retain the old visible offsets while the
            // earlier remote job is still waiting for its asynchronous reply.
            first.textView.setSelectedRange(NSRange(location: quote.location, length: 0))
            first.binding.store.applyRemote(incoming.update)
            first.textView.insertText("\n", replacementRange: NSRange(location: quote.location, length: 0))
            first.textView.insertText("续", replacementRange: NSRange(location: quote.location + 1, length: 0))
            try require(first.binding.canEdit && Array(first.textView.string.utf16) == Array(authoredText.utf16),
                        "\(scenario): pending remote deletion replaced the author basis")
            try settle("Enter and continued input")

            func exact(_ expected: String, commentAt: Int, caret: Int?, stage: String) throws {
                let saved = try read(owner)
                try require(saved.saved && saved.saveError == nil, "\(scenario), \(stage): prose was not saved")
                let units = Array(expected.utf16)
                try require(Array(saved.projection.text.utf16) == units, "\(scenario), \(stage): stored UTF-16 differs")
                for view in [first, second] {
                    try require(Array(view.textView.string.utf16) == units && view.textView.textStorage?.length == units.count,
                                "\(scenario), \(stage): native views did not converge exactly")
                    try require(!view.binding.hasUnsubmittedDraft, "\(scenario), \(stage): view retained a draft")
                }
                guard let currentComment = saved.projection.comments.first(where: { $0.id == comment.id }) else {
                    throw LabError.message("\(scenario), \(stage): comment identity was lost")
                }
                try require(Array(currentComment.quote.utf16) == Array(comment.quote.utf16)
                    && currentComment.ranges.count == 1
                    && currentComment.ranges[0].nsRange == NSRange(location: commentAt, length: quote.length),
                            "\(scenario), \(stage): comment moved away from its original quote")
                if let caret {
                    try require(first.textView.selectedRange() == NSRange(location: caret, length: 0),
                        "\(scenario), \(stage): native caret \(first.textView.selectedRange()) did not follow cut \(caret)")
                }
            }
            try exact(mergedText, commentAt: liveCut + 2, caret: liveCut + 2, stage: "merged")
            first.undoProse(); try settle("typing undo")
            try exact(splitText, commentAt: liveCut + 1, caret: liveCut + 1, stage: "typing undo")
            first.undoProse(); try settle("split undo")
            try exact(remoteText, commentAt: liveCut, caret: liveCut, stage: "split undo preserves remote deletion")
            try require(try read(owner).projection.canUndo == false, "Remote prefix deletion entered native undo history")
            first.redoProse(); try settle("split redo")
            try exact(splitText, commentAt: liveCut + 1, caret: nil, stage: "split redo")
            first.redoProse(); try settle("typing redo")
            try exact(mergedText, commentAt: liveCut + 2, caret: nil, stage: "typing redo")
            first.binding.store.applyRemote(incoming.update); try settle("duplicate remote")
            try exact(mergedText, commentAt: liveCut + 2, caret: nil, stage: "duplicate remote")
            let _: LabState = try result { owner.reopen(completion: $0) }
            first.binding.load(); try settle("SQLite reopen")
            try exact(mergedText, commentAt: liveCut + 2, caret: nil, stage: "SQLite reopen")
            cases.append(entirePrefix
                ? "AppKit queued Enter after complete remote prefix deletion preserves two views, comments, history and reopen"
                : "AppKit queued Enter after partial remote prefix deletion preserves two views, comments, history and reopen")
        }
        return cases
    }

    static func inputQueueAcceptance() throws -> [String] {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: parent) }
        let owner = LabCore(directory: parent.appendingPathComponent("owner/apple-native-lab"))
        let peer = LabCore(directory: parent.appendingPathComponent("peer/apple-native-lab"))
        func result<T>(_ run: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
            var value: Result<T, Error>?
            run { value = $0 }; try wait { value != nil }; return try value!.get()
        }
        let _: LabState = try result { owner.open(completion: $0) }
        let _: LabState = try result { peer.open(completion: $0) }
        let first = NativeDocumentView(core: owner), second = NativeDocumentView(core: owner)
        first.binding.load(); try wait { !first.binding.hasPendingWork }
        let original = try read(owner).projection
        let quote = original.comments[0].ranges[0].nsRange
        let _: LabDocumentState = try result { peer.document("documentReplace", edit: ["revision": original.revision,
            "range": ["location": quote.location + 1, "length": 0], "text": "远端"], completion: $0) }
        let incoming: NativeCheckpoint = try result { peer.exportDocument(completion: $0) }

        // No run-loop yield between these TextKit calls: every numeric range is
        // taken from text actually visible before remote/commit replies arrive.
        first.textView.setMarkedText("xin", selectedRange: NSRange(location: 3, length: 0), replacementRange: quote)
        first.binding.store.applyRemote(incoming.update)
        second.textView.insertText("前", replacementRange: NSRange(location: 0, length: 0))
        first.textView.insertText("新", replacementRange: NSRange(location: NSNotFound, length: 0))
        first.textView.insertText("续", replacementRange: NSRange(location: quote.location + 1, length: 0))
        try require(first.binding.canEdit && first.textView.string.contains("新续"), "Pending merge blocked or replaced continued input")
        try wait { !first.binding.hasPendingWork }
        let merged = try read(owner).projection.text
        try require(merged.contains("新续") && merged.contains("远端") && merged.hasPrefix("前"), "Queued edits lost concurrent text")
        try require(!merged.contains("北远端塔") && !merged.contains("北塔"), "Composition failed to replace original quote items")
        try require(first.textView.string == merged && second.textView.string == merged, "Views did not converge after draining")
        let caret = (merged as NSString).range(of: "新续").location + 2
        try require(first.textView.selectedRange() == NSRange(location: caret, length: 0), "Continued-input caret jumped across remote text")
        first.undoProse(); try wait { !first.binding.hasPendingWork }
        try require(!first.textView.string.contains("续") && first.textView.string.contains("远端"), "Undo removed remote text or another input event")
        first.undoProse(); try wait { !first.binding.hasPendingWork }
        try require(first.textView.string.contains("北远端塔") && first.textView.string.hasPrefix("前"), "Composition undo did not preserve concurrent operations")
        first.redoProse(); try wait { !first.binding.hasPendingWork }
        first.redoProse(); try wait { !first.binding.hasPendingWork }
        try require(first.textView.string == merged, "Merged continued input did not survive redo")

        // Remote replay can be enqueued before ordinary input too. Deleting a
        // visible character must not accidentally target an unseen remote one.
        let peerCurrent = try read(peer).projection
        let _: LabDocumentState = try result { peer.document("documentReplace", edit: ["revision": peerCurrent.revision,
            "range": ["location": 0, "length": 0], "text": "海"], completion: $0) }
        let next: NativeCheckpoint = try result { peer.exportDocument(completion: $0) }
        first.binding.store.applyRemote(next.update)
        first.textView.insertText("", replacementRange: NSRange(location: 0, length: 1)) // visible 前
        first.textView.insertText("岸", replacementRange: NSRange(location: 0, length: 0))
        try wait { !first.binding.hasPendingWork }
        let final = try read(owner).projection.text
        try require(final.contains("海") && final.contains("岸") && !final.contains("前"), "Remote replay shifted a queued deletion onto the wrong item")
        first.binding.store.applyRemote(next.update); try wait { !first.binding.hasPendingWork }
        try require(try read(owner).projection.text == final, "Duplicate queued replay was not idempotent")
        // Inject input from the activity callback exactly as a merged snapshot
        // refresh starts, before its asynchronous reply can replace the display.
        let peerBeforeRefresh = try read(peer).projection
        let _: LabDocumentState = try result { peer.document("documentReplace", edit: ["revision": peerBeforeRefresh.revision,
            "range": ["location": 0, "length": 0], "text": "风"], completion: $0) }
        let refreshRemote: NativeCheckpoint = try result { peer.exportDocument(completion: $0) }
        let activity = first.binding.onActivity
        var injected = false
        first.binding.onActivity = { busy in
            activity?(busy)
            if !injected && busy && first.binding.state?.projection.text.contains("风") == true && !first.textView.string.contains("风") {
                injected = true
                first.textView.insertText("帆", replacementRange: NSRange(location: 0, length: 0))
            }
        }
        first.binding.store.applyRemote(refreshRemote.update)
        try wait { !first.binding.hasPendingWork }
        first.binding.onActivity = activity
        let refreshed = try read(owner).projection.text
        try require(injected && refreshed.contains("风") && refreshed.contains("帆"), "Refresh reply overwrote newly queued visible-basis input")
        let _: LabState = try result { owner.reopen(completion: $0) }
        first.binding.load(); try wait { !first.binding.hasPendingWork }
        try require(first.textView.string == refreshed && second.textView.string == refreshed, "Queued merge did not survive SQLite reopen")
        // A committed event may be rejected after its last view closes. Keep
        // that optimistic text reachable, and let the next view recover it.
        let abandoned = LabCore(directory: parent.appendingPathComponent("abandoned/apple-native-lab"))
        let _: LabState = try result { abandoned.open(completion: $0) }
        try autoreleasepool {
            var transient: DocumentBinding? = DocumentBinding(core: abandoned)
            transient!.load(); try wait { !transient!.hasPendingWork }
            let text = transient!.state!.projection.text
            // This update also changes the heading being split. Disjoint
            // paragraph changes now merge and are no longer a rejection case.
            transient!.store.applyRemote(next.update)
            transient!.changed("草稿\n" + text, marked: false)
            try require(transient!.detach(), "Queued committed input unexpectedly prevented detach")
            transient = nil
        }
        try wait { !abandoned.documentStore().hasPendingCommits }
        try require(abandoned.documentStore().hasPendingWork, "Rejected detached input lost its recovery owner")
        var reopenResult: Result<LabState, Error>?
        abandoned.reopen { reopenResult = $0 }
        if case .success = reopenResult { throw LabError.message("Reopen discarded a detached recovery draft") }
        let recovered = NativeDocumentView(core: abandoned)
        recovered.binding.load()
        try require(recovered.binding.hasFailedDraft && recovered.textView.string.hasPrefix("草稿\n"), "New view did not restore the detached draft")
        recovered.binding.discardDraft(); try wait { !recovered.binding.hasPendingWork }
        try require(recovered.textView.string.contains("北远端塔") && !recovered.textView.string.contains("草稿"), "Explicit recovery discard altered committed prose")
        return ["AppKit overlapping remote composition with immediate continued input and history",
            "queued remote replay preserves visible-basis deletion, duplicates and SQLite reopen",
            "input arriving during merged-projection refresh remains responsive and converges",
            "last-view rejection retains draft for a new view and refuses destructive reopen"]
    }
}
