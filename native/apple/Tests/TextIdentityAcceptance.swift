import AppKit

extension BindingAcceptance {
    static func textIdentityAcceptance() throws -> [String] {
        // Swift's canonical-equivalence equality is not document identity:
        // the view and CRDT exchange exact UTF-16 positions and scalar values.
        let decomposed = "e\u{301}", composed = "\u{e9}"
        try require(decomposed == composed && decomposed.utf16.count != composed.utf16.count,
                    "Canonical-equivalence fixture is invalid")
        guard let change = NativeTextChange.between(decomposed, composed) else {
            throw LabError.message("Canonical-equivalent scalar replacement was dropped")
        }
        try require(change.range == NSRange(location: 0, length: 2)
            && Array(change.text.utf16) == Array(composed.utf16), "Canonical replacement used wrong UTF-16 range")
        // Equal lengths do not establish identity either: combining-mark order
        // and Hangul canonical decomposition must survive without normalization.
        for (left, right) in [("a\u{301}\u{323}", "a\u{323}\u{301}"), ("\u{ac00}", "\u{1100}\u{1161}")] {
            try require(left == right && !NativeText.identical(left, right), "Canonical pair was normalized")
            let cocoa = NSTextStorage(string: left).string
            try require(!NativeText.identical(cocoa, right) && !NativeText.identical(right, cocoa),
                        "Cocoa-backed canonical pair was normalized")
            guard let exactChange = NativeTextChange.between(cocoa, right) else {
                throw LabError.message("Equal-length or Hangul canonical replacement was dropped")
            }
            try require(Array((left as NSString).replacingCharacters(in: exactChange.range, with: exactChange.text).utf16)
                == Array(right.utf16), "Canonical diff changed exact scalars")
        }

        let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: parent) }
        let core = LabCore(directory: parent.appendingPathComponent("owner/apple-native-lab"))
        var opened: Result<LabState, Error>?
        core.open { opened = $0 }; try wait { opened != nil }; _ = try opened!.get()
        let first = NativeDocumentView(core: core), second = NativeDocumentView(core: core)
        first.binding.load(); second.binding.load(); try wait { first.binding.state != nil && !first.binding.hasPendingWork }
        let initial = try read(core).projection.text
        func exact(_ expected: String, _ context: String) throws {
            let saved = try read(core).projection
            for actual in [first.textView.string, second.textView.string, saved.text] {
                try require(Array(actual.utf16) == Array(expected.utf16), "Exact scalar identity lost: \(context)")
            }
            for view in [first, second] {
                try require(view.textView.textStorage!.length == expected.utf16.count, "Text storage range mismatch: \(context)")
            }
        }
        first.textView.insertText(decomposed, replacementRange: NSRange(location: 0, length: 0))
        try wait { !first.binding.hasPendingWork }; try exact(decomposed + initial, "seed")
        first.textView.insertText(composed, replacementRange: NSRange(location: 0, length: 2))
        try wait { !first.binding.hasPendingWork }; try exact(composed + initial, "shorter canonical replacement and passive view")
        first.undoProse(); try wait { !first.binding.hasPendingWork }; try exact(decomposed + initial, "undo")
        first.redoProse(); try wait { !first.binding.hasPendingWork }; try exact(composed + initial, "redo")

        first.textView.setMarkedText("temporary", selectedRange: NSRange(location: 9, length: 0),
                                     replacementRange: NSRange(location: 0, length: 1))
        first.textView.insertText(decomposed, replacementRange: NSRange(location: NSNotFound, length: 0))
        try wait { !first.binding.hasPendingWork }; try exact(decomposed + initial, "canonical composition commit")
        first.undoProse(); try wait { !first.binding.hasPendingWork }; try exact(composed + initial, "composition single undo")
        first.redoProse(); try wait { !first.binding.hasPendingWork }; try exact(decomposed + initial, "composition redo")

        // A separate real owner generates the remote update; both native views
        // must replace canonically equivalent text before applying range styles.
        let peer = LabCore(directory: parent.appendingPathComponent("peer/apple-native-lab"))
        opened = nil; peer.open { opened = $0 }; try wait { opened != nil }; _ = try opened!.get()
        var checkpoint: Result<NativeCheckpoint, Error>?
        core.exportDocument { checkpoint = $0 }; try wait { checkpoint != nil }
        var remoteState: Result<LabDocumentState, Error>?
        peer.applyRemote(try checkpoint!.get().update) { remoteState = $0 }; try wait { remoteState != nil }
        let remoteBefore = try remoteState!.get()
        remoteState = nil
        peer.document("documentReplace", edit: ["revision": remoteBefore.projection.revision,
            "range": ["location": 0, "length": 2], "text": composed]) { remoteState = $0 }
        try wait { remoteState != nil }; _ = try remoteState!.get()
        checkpoint = nil; peer.exportDocument { checkpoint = $0 }; try wait { checkpoint != nil }
        first.binding.store.applyRemote(try checkpoint!.get().update)
        try wait { !first.binding.hasPendingWork }; try exact(composed + initial, "remote canonical replacement")
        opened = nil; core.reopen { opened = $0 }; try wait { opened != nil }; _ = try opened!.get()
        first.binding.load(); try wait { !first.binding.hasPendingWork }; try exact(composed + initial, "SQLite reopen")
        return ["Canonical-equivalent text replacement retains exact scalar and UTF-16 identity",
                "AppKit canonical replacement refreshes passive views and history",
                "AppKit canonical composition commits as one exact undo unit",
                "Remote canonical text refresh and SQLite reopen retain exact storage ranges"]
    }
}
