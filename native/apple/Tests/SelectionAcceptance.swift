import AppKit

extension BindingAcceptance {
    static func selectionAcceptance() throws -> [String] {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: parent) }
        let core = LabCore(directory: parent.appendingPathComponent("apple-native-lab"))
        var opened: Result<LabState, Error>?
        core.open { opened = $0 }; try wait { opened != nil }; _ = try opened!.get()
        let first = NativeDocumentView(core: core), second = NativeDocumentView(core: core)
        first.binding.load(); second.binding.load()
        try wait { first.binding.state != nil && !first.binding.hasPendingWork }
        first.textView.insertText("AAAA", replacementRange: NSRange(location: 0, length: 0))
        try wait { !first.binding.hasPendingWork }
        second.textView.setSelectedRange(NSRange(location: 2, length: 0))
        try wait { second.binding.selectionIsAnchored }
        let registered = try read(core).projection.selections.first { $0.viewId == second.binding.viewID }
        try require(registered?.range?.location == 2, "Native selection never reached the Rust registry")
        first.textView.insertText("", replacementRange: NSRange(location: 0, length: 1))
        try wait { !first.binding.hasPendingWork }
        try require(second.textView.selectedRange().location == 1, "Selection did not follow the actual repeated-text deletion")
        // A prefix/suffix text diff sees insertion at index 3 here. CRDT
        // identity must restore the caret at index 2 instead of leaving it at 1.
        first.undoProse(); try wait { !first.binding.hasPendingWork }
        try require(second.textView.selectedRange().location == 2, "Undo used an ambiguous repeated-text diff instead of the anchor")
        first.redoProse(); try wait { !first.binding.hasPendingWork }
        try require(second.textView.selectedRange().location == 1, "Redo lost the same CRDT selection")
        second.textView.setSelectedRange(NSRange(location: 0, length: 0))
        try wait { second.binding.selectionIsAnchored }
        first.undoProse(); try wait { !first.binding.hasPendingWork }
        try require(second.textView.selectedRange().location == 1, "Old history overwrote a newer manual selection")

        // Move again while earlier capture replies are still in flight.
        for location in [2, 0, 3] { second.textView.setSelectedRange(NSRange(location: location, length: 0)) }
        try wait { second.binding.selectionIsAnchored }
        try require(second.textView.selectedRange().location == 3, "An old capture reply moved the current native caret")
        let latest = try read(core).projection.selections.first { $0.viewId == second.binding.viewID }
        try require(latest?.range?.location == 3, "Capture coalescing lost the newest user-selection epoch")

        second.textView.setSelectedRange(NSRange(location: 2, length: 0))
        try wait { second.binding.selectionIsAnchored }
        // Marking the existing first A does not change the visible string.
        // Its eventual deletion must still remove that first CRDT item.
        first.textView.setMarkedText("A", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: 0, length: 1))
        try require(first.textView.hasMarkedText(), "Repeated-text composition did not start")
        first.textView.insertText("", replacementRange: NSRange(location: NSNotFound, length: 0))
        try wait { !first.binding.hasPendingWork }
        try require(second.textView.selectedRange().location == 1, "Marked replacement used an ambiguous final-string diff")
        first.undoProse(); try wait { !first.binding.hasPendingWork }
        try require(second.textView.selectedRange().location == 2, "Marked replacement undo lost the original selection")

        let quote = try read(core).projection.comments[0].ranges[0].nsRange
        second.textView.setSelectedRange(quote)
        try wait { second.binding.selectionIsAnchored }
        first.textView.insertText("\n", replacementRange: NSRange(location: quote.location + 1, length: 0))
        try wait { !first.binding.hasPendingWork }
        try require(second.textView.selectedRange().length == 3, "Registered selection did not follow a split tail")
        first.undoProse(); try wait { !first.binding.hasPendingWork }
        try require(second.textView.selectedRange() == quote, "Structural history did not restore the registered range")
        first.redoProse(); try wait { !first.binding.hasPendingWork }
        // This range was not present when the split happened. It references
        // copied items, so merely restoring old per-view history cannot work.
        let tailRange = NSRange(location: quote.location + 2, length: 1)
        second.textView.setSelectedRange(tailRange)
        try wait { second.binding.selectionIsAnchored }
        first.undoProse(); try wait { !first.binding.hasPendingWork }
        try require(second.textView.selectedRange() == NSRange(location: quote.location + 1, length: 1), "New tail selection lost its original text on structural undo")
        first.redoProse(); try wait { !first.binding.hasPendingWork }
        try require(second.textView.selectedRange() == tailRange, "Structural redo did not restore the newer manual range")
        // Force another epoch on redone item IDs, not the first copy's IDs.
        second.textView.setSelectedRange(NSRange(location: quote.location + 3, length: 0))
        try wait { second.binding.selectionIsAnchored }
        first.undoProse(); try wait { !first.binding.hasPendingWork }
        try require(second.textView.selectedRange() == NSRange(location: quote.location + 2, length: 0), "Manual caret on redone text did not follow lineage")
        var reopened: Result<LabState, Error>?
        core.reopen { reopened = $0 }; try wait { reopened != nil }; _ = try reopened!.get()
        first.binding.load(); try wait { !first.binding.hasPendingWork && second.binding.selectionIsAnchored }
        try require(try read(core).projection.selections.contains { $0.viewId == second.binding.viewID }, "Reopen did not recapture session-local view positions")
        try require(second.binding.detach(), "Settled view could not detach")
        try require(try read(core).projection.selections.allSatisfy { $0.viewId != second.binding.viewID }, "Detached view still owned a Rust selection")
        return ["CRDT selection survives repeated-text undo and newer manual movement",
            "selection capture epochs, structural history, reopen and detach",
            "TextKit marked replacement retains identity when its initial string is unchanged",
            "new AppKit selections follow copied and redone text through structural history"]
    }
}
