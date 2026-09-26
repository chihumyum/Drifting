import AppKit

extension BindingAcceptance {
    static func multiViewAcceptance() throws -> [String] {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: parent) }
        let core = LabCore(directory: parent.appendingPathComponent("apple-native-lab"))
        var opened: Result<LabState, Error>?
        core.open { opened = $0 }; try wait { opened != nil }; _ = try opened!.get()
        let first = NativeDocumentView(core: core), second = NativeDocumentView(core: core)
        first.binding.load(); second.binding.load()
        try wait { first.binding.state != nil && !first.binding.hasPendingWork }
        try require(first.binding.store === second.binding.store, "Views opened separate document queues")
        let original = try read(core).projection
        let quote = original.comments[0].ranges[0].nsRange
        second.textView.setSelectedRange(quote)
        first.textView.insertText("👩🏽‍🚀", replacementRange: NSRange(location: 0, length: 0))
        try require(second.textView.string == "👩🏽‍🚀" + original.text, "Other view did not receive queued input immediately")
        try require(second.textView.selectedRange() == NSRange(location: quote.location + 7, length: quote.length), "Passive selection did not follow UTF-16 input")
        second.textView.insertText("远", replacementRange: NSRange(location: 0, length: 0))
        first.textView.insertText("方", replacementRange: NSRange(location: 1, length: 0))
        try wait { !first.binding.hasPendingWork }
        let combined = "远方👩🏽‍🚀" + original.text
        try require(try read(core).projection.text == combined, "Interleaved views submitted stale ranges")
        try require(first.textView.string == combined && second.textView.string == combined, "Views diverged after replies")
        second.undoProse(); try wait { !first.binding.hasPendingWork }
        try require(first.textView.string == "远👩🏽‍🚀" + original.text, "Undo from another view missed the shared history")
        first.redoProse(); try wait { !first.binding.hasPendingWork }
        try require(second.textView.string == combined, "Shared redo did not publish to the other view")

        let comment = try read(core).projection.comments[0].ranges[0].nsRange
        second.textView.setSelectedRange(comment)
        first.textView.insertText("\n", replacementRange: NSRange(location: comment.location + 1, length: 0))
        try require(second.textView.selectedRange() == NSRange(location: comment.location, length: 3), "Passive selection lost its split tail")
        try wait { !first.binding.hasPendingWork }
        second.undoProse(); try wait { !first.binding.hasPendingWork }
        try require(second.textView.selectedRange() == comment, "Selection failed to follow structural undo")

        // Real marked-text API, with two disjoint changes around the draft.
        first.textView.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: 1, length: 0))
        let draft = first.textView.string
        second.textView.insertText("海", replacementRange: NSRange(location: 0, length: 0))
        let paragraph = second.binding.store.projection!.blocks.first { $0.id == "fixture-paragraph" }!
        second.textView.insertText("潮", replacementRange: NSRange(location: paragraph.range.location, length: 0))
        try wait { !first.binding.store.hasPendingCommits }
        let beforeCommit = try read(core).projection.text
        try require(first.textView.hasMarkedText() && first.textView.string == draft, "Another view reset the native input context")
        first.textView.insertText("中文", replacementRange: NSRange(location: NSNotFound, length: 0))
        try wait { !first.binding.hasPendingWork }
        let composed = (beforeCommit as NSString).replacingCharacters(in: NSRange(location: 2, length: 0), with: "中文")
        try require(first.textView.string == composed && second.textView.string == composed,
            "Composition failed to merge disjoint view input: first=\(first.textView.string.debugDescription), second=\(second.textView.string.debugDescription), expected=\(composed.debugDescription)")
        try require(first.textView.selectedRange().location == 4, "Composition caret did not follow the prefix edit")
        second.undoProse(); try wait { !first.binding.hasPendingWork }
        try require(first.textView.string == beforeCommit, "Composition undo removed the other view's work")

        first.textView.setMarkedText("cancel", selectedRange: NSRange(location: 6, length: 0), replacementRange: NSRange(location: 0, length: 0))
        second.textView.insertText("星", replacementRange: NSRange(location: 0, length: 0))
        try wait { !first.binding.store.hasPendingCommits }
        let beforeCancel = try read(core).projection
        first.textView.insertText("", replacementRange: NSRange(location: NSNotFound, length: 0))
        try wait { !first.binding.hasPendingWork }
        try require(first.textView.string == beforeCancel.text, "Cancel discarded another view's queued input")
        try require(try read(core).projection.revision == beforeCancel.revision, "Cancel created a prose transaction")

        var transient: NativeDocumentView? = NativeDocumentView(core: core)
        transient!.binding.load(); try wait { !first.binding.hasPendingWork }
        let subscriptions = first.binding.store.viewCount
        transient!.textView.insertText("舟", replacementRange: NSRange(location: 0, length: 0))
        try require(transient!.binding.detach(), "Committed input incorrectly prevented view detach")
        transient = nil
        try require(first.binding.store.viewCount == subscriptions - 1, "Closing a view leaked a subscription")
        try wait { !first.binding.hasPendingWork }
        try require(first.textView.string.hasPrefix("舟") && second.textView.string == first.textView.string, "Closing one view dropped its committed input")

        // Overlapping inline composition authors against its captured CRDT
        // basis and preserves another view's replacement as concurrent text.
        var conflict: NativeDocumentView? = NativeDocumentView(core: core)
        conflict!.binding.load(); try wait { !first.binding.hasPendingWork }
        conflict!.textView.setMarkedText("draft", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: 0, length: 2))
        second.textView.insertText("改", replacementRange: NSRange(location: 1, length: 1))
        try wait { !first.binding.store.hasPendingCommits }
        let conflictBase = try read(core).projection
        conflict!.textView.insertText("草稿", replacementRange: NSRange(location: NSNotFound, length: 0))
        conflict!.textView.insertText("续", replacementRange: NSRange(location: 2, length: 0))
        try wait { !first.binding.hasPendingWork }
        try require(conflict!.textView.string.contains("草稿续") && conflict!.textView.string.contains("改"), "Overlapping input lost committed or concurrent text")
        second.undoProse(); try wait { !first.binding.hasPendingWork }
        second.undoProse(); try wait { !first.binding.hasPendingWork }
        try require(try read(core).projection.text == conflictBase.text, "Composition undo removed another window's replacement")

        // Structural reconciliation remains an explicit gate. Rejection keeps
        // that window's visible draft while other windows can continue writing.
        conflict!.textView.setMarkedText("draft", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: 0, length: 0))
        second.textView.insertText("海", replacementRange: NSRange(location: 0, length: 0))
        conflict!.textView.insertText("草稿\n", replacementRange: NSRange(location: NSNotFound, length: 0))
        try wait { conflict!.binding.hasFailedDraft && !first.binding.store.hasPendingCommits }
        try require(conflict!.textView.string.hasPrefix("草稿\n"), "Rejected structural draft disappeared")
        try require(!conflict!.binding.detach(), "Closing a conflicted view discarded its draft")
        second.textView.insertText("保", replacementRange: NSRange(location: 0, length: 0))
        try wait { !first.binding.store.hasPendingCommits }
        try require(try read(core).projection.text.hasPrefix("保"), "One conflicted view blocked ordinary editing everywhere")
        conflict!.binding.discardDraft()
        try wait { !first.binding.hasPendingWork }
        try require(conflict!.textView.string == second.textView.string, "Explicit discard did not restore the current projection")
        try require(conflict!.binding.detach(), "Recovered view could not detach")
        conflict = nil

        // A snapshot failure pauses the single queue, including input already
        // staged by another view. Removing the fault resumes that exact queue.
        let database = parent.appendingPathComponent("apple-native-lab/native-lab.db")
        func sql(_ statement: String) throws {
            let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
            process.arguments = [database.path, statement]; try process.run(); process.waitUntilExit()
            try require(process.terminationStatus == 0, "Could not inject synthetic checkpoint failure")
        }
        try sql("CREATE TRIGGER fail_native_checkpoint BEFORE UPDATE ON yjs_snapshots BEGIN SELECT RAISE(ABORT, 'synthetic shared queue failure'); END")
        first.textView.insertText("甲", replacementRange: NSRange(location: 0, length: 0))
        second.textView.insertText("乙", replacementRange: NSRange(location: 1, length: 0))
        let queued = first.textView.string
        try wait { first.binding.state?.saved == false }
        try require(!first.binding.canEdit && !second.binding.canEdit, "Failed save did not pause all writers")
        try sql("DROP TRIGGER fail_native_checkpoint")
        second.binding.retrySave(); try wait { !first.binding.hasPendingWork }
        try require(try read(core).projection.text == queued, "Save retry dropped another view's queued event")
        var reopened: Result<LabState, Error>?
        core.reopen { reopened = $0 }; try wait { reopened != nil }; _ = try reopened!.get()
        first.binding.load(); try wait { !first.binding.hasPendingWork }
        try require(first.textView.string == queued && second.textView.string == queued, "Reopen did not refresh all subscribers")
        second.textView.setSelectedRange(NSRange(location: 1, length: 1))
        first.textView.insertText("替换", replacementRange: NSRange(location: 0, length: 3))
        try require(second.textView.selectedRange() == NSRange(location: 2, length: 0), "Deleted selection unexpectedly selected another view's replacement")
        try wait { !first.binding.hasPendingWork }

        let solitaryCore = LabCore(directory: parent.appendingPathComponent("solitary/apple-native-lab"))
        opened = nil
        solitaryCore.open { opened = $0 }; try wait { opened != nil }; _ = try opened!.get()
        try autoreleasepool {
            var solitary: DocumentBinding? = DocumentBinding(core: solitaryCore)
            solitary!.load(); try wait { solitary!.state != nil && !solitary!.hasPendingWork }
            let initial = solitary!.state!.projection.text
            solitary!.changed("终" + initial, marked: false)
            solitary!.changed("终章" + initial, marked: false)
            try require(solitary!.detach(), "Last view refused to detach committed events")
            solitary = nil
        }
        try wait { !solitaryCore.documentStore().hasPendingCommits }
        let solitarySaved = try read(solitaryCore).projection
        try require(solitarySaved.text.hasPrefix("终章"), "Last view released the queue before its second event was saved")
        try require(solitarySaved.selections.isEmpty, "Queued input resurrected a detached view selection")

        // The rebase must commute for every accepted pair, including insertion
        // affinity at replacement boundaries and UTF-16 emoji offsets.
        let sample = "甲👩🏽‍🚀乙北塔"
        var boundaries = [0]
        for scalar in sample.unicodeScalars { boundaries.append(boundaries.last! + scalar.utf16.count) }
        var accepted = 0
        for start in boundaries { for end in boundaries where end >= start {
            for otherStart in boundaries { for otherEnd in boundaries where otherEnd >= otherStart {
                for replacement in ["", "中", "👩🏽‍🚀"] {
                    let a = NativeTextChange(range: NSRange(location: start, length: end - start), text: replacement, target: "")
                    let b = NativeTextChange(range: NSRange(location: otherStart, length: otherEnd - otherStart), text: "远", target: "")
                    guard let afterB = a.rebased(over: b, insertAfter: true), let afterA = b.rebased(over: a, insertAfter: false) else { continue }
                    func apply(_ change: NativeTextChange, to text: String) -> String { (text as NSString).replacingCharacters(in: change.range, with: change.text) }
                    try require(apply(afterB, to: apply(b, to: sample)) == apply(afterA, to: apply(a, to: sample)), "Disjoint rebase did not commute at UTF-16 boundaries")
                    accepted += 1
                }
            } }
        } }
        try require(accepted > 1000, "Boundary matrix did not exercise enough interleavings")
        return ["interleaved multi-view input and shared history", "per-view UTF-16 selection and structural shifts",
            "marked composition retains context across disjoint view input", "composition cancel applies deferred input",
            "view detach preserves document and queued edits", "overlapping inline composition and continued input preserve concurrent work", "concurrent structural rejection retains recoverable draft",
            "shared queue save failure, retry and SQLite reopen", "last-view detach drains committed queue", "disjoint UTF-16 rebase commutation matrix"]
    }
}
