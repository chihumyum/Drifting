import AppKit

extension BindingAcceptance {
    /// Uses the real AppKit text storage and Rust-backed projections. Every
    /// UTF-16 position, including separators, is checked against full styling.
    static func styleAcceptance() throws -> [String] {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let core = LabCore(directory: directory.appendingPathComponent("apple-native-lab"))
        var opened: Result<LabState, Error>?
        core.open { opened = $0 }; try wait { opened != nil }; _ = try opened!.get()
        let view = NativeDocumentView(core: core)
        var decisions: [DocumentStyle.Update] = []
        view.onStyleUpdate = { decisions.append($0) }
        view.binding.load(); try wait { view.binding.state != nil && !view.binding.hasPendingWork }
        try require(decisions.contains(.full), "Initial AppKit styling did not use the full path")
        try requireStyleReference(view.textView.textStorage!, try read(core).projection, "initial fixture")

        func edit(_ replacement: String, at range: NSRange, expected: DocumentStyle.Update) throws {
            decisions.removeAll()
            view.textView.setSelectedRange(range)
            view.textView.insertText(replacement, replacementRange: range)
            try require(decisions.contains(expected), "AppKit optimistic style did not exercise \(expected): \(decisions)")
            if let optimistic = view.binding.store.projection {
                try requireStyleReference(view.textView.textStorage!, optimistic, "optimistic \(replacement)")
            }
            try wait { !view.binding.hasPendingWork }
            try requireStyleReference(view.textView.textStorage!, try read(core).projection, "authoritative \(replacement)")
        }

        // The unchanged authoritative reply must not silently restyle the whole
        // document. Unicode shifts also move all later marks and comments.
        try edit("中👩🏽‍🚀", at: NSRange(location: 2, length: 0), expected: .block(0))
        try require(decisions.contains(.unchanged), "Equivalent authoritative reply did not skip styling")
        let afterHeading = try read(core).projection
        try require(afterHeading.blocks[0].kind == "heading" && afterHeading.blocks[1].kind == "paragraph",
            "Style fixture no longer covers heading and plain paragraph fonts")
        let paragraph = afterHeading.blocks[1]
        try edit("𠮷e\u{301}", at: NSRange(location: paragraph.range.location + 2, length: 0), expected: .block(1))
        decisions.removeAll()
        view.textView.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0),
            replacementRange: NSRange(location: 0, length: 0))
        view.textView.insertText("中文", replacementRange: NSRange(location: NSNotFound, length: 0))
        try wait { !view.binding.hasPendingWork }
        try require(decisions.contains(.full), "Composition commit reused temporary marked-text attributes")
        try requireStyleReference(view.textView.textStorage!, try read(core).projection, "composition commit")
        let beforeCancel = try read(core).projection.text
        decisions.removeAll()
        view.textView.setMarkedText("linshi", selectedRange: NSRange(location: 6, length: 0),
            replacementRange: NSRange(location: 0, length: 0))
        view.textView.insertText("", replacementRange: NSRange(location: NSNotFound, length: 0))
        try wait { !view.binding.hasPendingWork }
        try require(try read(core).projection.text == beforeCancel, "Style composition cancellation changed prose")
        try require(decisions.contains(.full), "Composition cancellation reused temporary marked-text attributes")
        try requireStyleReference(view.textView.textStorage!, try read(core).projection, "composition cancellation")

        // A real Yjs format-only remote update traverses SQLite, Rust projection,
        // the shared queue and NativeDocumentView without changing plain text.
        let beforeFormat = try read(core).projection.text
        let remote = try styleRemoteFormat(core)
        decisions.removeAll(); view.binding.store.applyRemote(remote)
        try wait { !view.binding.hasPendingWork }
        let formatted = try read(core).projection
        try require(formatted.text == beforeFormat, "Remote format fixture unexpectedly changed text")
        try require(decisions.contains(.full), "Remote format-only refresh incorrectly skipped styling")
        try require(formatted.blocks[1].runs.contains { $0.attributes.italic && $0.attributes.strike },
            "Remote italic/strike marks did not reach the native projection")
        try requireStyleReference(view.textView.textStorage!, formatted, "remote format-only")

        // Exercise both sides of real link/bold and comment boundaries. The
        // optimistic run affinity may differ from the authoritative result;
        // both must agree with the full reference for their own projection.
        let link = formatted.blocks[1].runs.first { $0.attributes.bold && $0.attributes.entityLink }!
        try edit("界", at: NSRange(location: link.range.location, length: 0), expected: .block(1))
        let commentEnd = NSMaxRange(try read(core).projection.comments[0].ranges[0].nsRange)
        try edit("🚀", at: NSRange(location: commentEnd, length: 0), expected: .block(1))
        let italic = try read(core).projection.blocks[1].runs.first { $0.attributes.italic }!
        try edit("", at: NSRange(location: italic.range.location, length: 1), expected: .block(1))

        // Structural edits invalidate block topology and must take the full path.
        try edit("\n", at: NSRange(location: 1, length: 0), expected: .full)
        try edit("", at: NSRange(location: 1, length: 1), expected: .full)

        // The lab ABI has no comment mutation command yet. Exercise the exact
        // projection-only refresh seam on a separate real NSTextView storage;
        // this is not evidence of production comment synchronization.
        let original = try read(core).projection
        let commentView = NSTextView()
        commentView.string = original.text
        let storage = commentView.textStorage!
        DocumentStyle.apply(original, to: storage)
        let comment = original.comments[0], oldRange = comment.ranges[0]
        let changedComment = NativeComment(id: comment.id, quote: comment.quote, status: comment.status,
            ranges: [NativeRange(location: oldRange.location + 1, length: max(1, oldRange.length - 1))])
        let changed = styleProjection(original, comments: [changedComment])
        try require(DocumentStyle.update(changed, previous: original, localChange: nil, to: storage) == .full,
            "Comment-only refresh did not invalidate old highlights")
        try requireStyleReference(storage, changed, "comment-only range refresh")
        let removed = styleProjection(changed, comments: [])
        try require(DocumentStyle.update(removed, previous: changed, localChange: nil, to: storage) == .full,
            "Comment removal did not clear its old background")
        try requireStyleReference(storage, removed, "comment removal")
        let metadata = styleProjection(removed, revision: removed.revision + 1, selections: [
            NativeSelection(viewId: "style-selection", epoch: 2, range: NativeRange(location: 0, length: 0)),
        ])
        try require(DocumentStyle.update(metadata, previous: removed, localChange: nil, to: storage) == .unchanged,
            "Revision/selection-only refresh did not skip styling")
        try requireStyleReference(storage, metadata, "revision and selection-only refresh")
        return ["AppKit incremental style matches full reference at every UTF-16 position",
            "AppKit local Unicode styling uses one-block path and authoritative no-op skip",
            "AppKit composition commit and cancellation clear temporary text-system styling",
            "AppKit bold link italic strike and comment boundaries retain full-reference attributes",
            "AppKit remote format-only styling refreshes unchanged text",
            "AppKit structural style fallback matches full reference",
            "AppKit comment-only projection refresh removes stale highlights",
            "AppKit revision and selection-only refresh skips styling"]
    }

    private static func requireStyleReference(_ storage: NSTextStorage, _ projection: NativeProjection, _ context: String) throws {
        let referenceView = NSTextView()
        referenceView.isRichText = false
        referenceView.string = projection.text
        let reference = referenceView.textStorage!
        DocumentStyle.apply(projection, to: reference)
        // Normalize the same lazy CJK/emoji font substitution on both views.
        storage.fixAttributes(in: NSRange(location: 0, length: storage.length))
        reference.fixAttributes(in: NSRange(location: 0, length: reference.length))
        try require(storage.string == reference.string, "Style reference text mismatch: \(context)")
        for position in 0..<reference.length {
            let actual = storage.attributes(at: position, effectiveRange: nil)
            let expected = reference.attributes(at: position, effectiveRange: nil)
            try require(Set(actual.keys) == Set(expected.keys), "Style attribute keys differ at UTF-16 \(position), \(context)")
            for key in expected.keys {
                if let left = actual[key] as? NSFont, let right = expected[key] as? NSFont {
                    // Font substitution creates distinct NSFont objects for
                    // identical descriptors; object identity is not styling.
                    try require(left.fontName == right.fontName && left.pointSize == right.pointSize
                        && NSDictionary(dictionary: left.fontDescriptor.fontAttributes).isEqual(NSDictionary(dictionary: right.fontDescriptor.fontAttributes)),
                        "Font differs at UTF-16 \(position), \(context): \(left.fontDescriptor.fontAttributes) vs \(right.fontDescriptor.fontAttributes)")
                } else {
                    try require((actual[key] as? NSObject)?.isEqual(expected[key]) == true,
                        "Style \(key) differs at UTF-16 \(position), \(context): \(String(describing: actual[key])) vs \(String(describing: expected[key]))")
                }
            }
        }
    }

    private static func styleProjection(_ source: NativeProjection, comments: [NativeComment]? = nil,
                                        revision: UInt64? = nil, selections: [NativeSelection]? = nil) -> NativeProjection {
        NativeProjection(revision: revision ?? source.revision, text: source.text, blocks: source.blocks,
            comments: comments ?? source.comments, selections: selections ?? source.selections,
            canUndo: source.canUndo, canRedo: source.canRedo)
    }

    private static func styleRemoteFormat(_ core: LabCore) throws -> String {
        var checkpoint: Result<NativeCheckpoint, Error>?
        core.exportDocument { checkpoint = $0 }; try wait { checkpoint != nil }
        let script = """
        const Y = require('yjs');
        const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(process.argv[1], 'base64'));
        const before = Y.encodeStateVector(doc);
        const block = doc.getXmlFragment('default').toArray().find(node => node.getAttribute('id') === 'fixture-paragraph');
        if (!block) throw new Error('Synthetic style paragraph is missing');
        block.toArray()[0].format(0, 2, { italic: {}, strike: {} });
        process.stdout.write(Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString('base64'));
        """
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "-e", script, try checkpoint!.get().update]
        process.standardOutput = output
        try process.run()
        let bytes = output.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
        try require(process.terminationStatus == 0, "Synthetic remote style update failed")
        return String(decoding: bytes, as: UTF8.self)
    }
}
