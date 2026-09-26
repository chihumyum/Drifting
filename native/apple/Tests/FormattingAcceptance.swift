import AppKit

extension BindingAcceptance {
    static func formattingAcceptance() throws -> [String] {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let core = LabCore(directory: directory.appendingPathComponent("apple-native-lab"))
        var opened: Result<LabState, Error>?
        core.open { opened = $0 }; try wait { opened != nil }; _ = try opened!.get()
        let view = NativeDocumentView(core: core), passive = NativeDocumentView(core: core)
        view.binding.load(); passive.binding.load()
        try wait { view.binding.state != nil && !view.binding.hasPendingWork }
        let original = try read(core).projection
        let range = NSRange(location: 0, length: NSMaxRange(original.blocks[1].range.nsRange))
        func format(_ action: NativeFormatAction, _ selection: NSRange = NSRange(location: 0, length: 0)) throws {
            view.textView.setSelectedRange(selection)
            try require(view.binding.canFormat(action, range: selection), "Format was disabled: \(action)")
            view.binding.format(action, range: selection)
            try wait { !view.binding.hasPendingWork }
            try require(view.binding.state?.saved == true, "Format did not persist")
            try require(view.textView.string == original.text && passive.textView.string == original.text, "Format changed plain text")
            try require(view.textView.selectedRange() == selection, "Format lost the active selection")
        }
        try require(!view.binding.canFormat(.bold, range: NSRange(location: 0, length: 0)), "Empty inline selection was enabled")
        try format(.bold, range)
        try require(try read(core).projection.blocks.prefix(2).allSatisfy { $0.runs.allSatisfy { $0.attributes.bold } }, "Bold did not cover both blocks")
        view.undoProse(); try wait { !view.binding.hasPendingWork }
        try require(try read(core).projection.blocks[0].runs.allSatisfy { !$0.attributes.bold }, "One undo did not restore the heading marks")
        try require(try read(core).projection.blocks[1].runs.contains { !$0.attributes.bold }, "One undo did not restore the paragraph marks")
        view.redoProse(); try wait { !view.binding.hasPendingWork }
        try format(.italic, range)
        for candidate in [view, passive] {
            let at = original.blocks[1].range.location
            let font = candidate.textView.textStorage!.attribute(.font, at: at, effectiveRange: nil) as! NSFont
            try require(NSFontManager.shared.traits(of: font).contains(.boldFontMask), "Shared native storage missed bold")
            try require(NSFontManager.shared.traits(of: font).contains(.italicFontMask), "Shared native storage missed italic")
        }
        for (action, level, size) in [(NativeFormatAction.heading1, 1, 28.0), (.heading2, 2, 24.0), (.heading3, 3, 20.0)] {
            try format(action)
            let block = try read(core).projection.blocks[0]
            try require(block.kind == "heading" && block.headingLevel == level, "Heading did not reach the document")
            for candidate in [view, passive] {
                let font = candidate.textView.textStorage!.attribute(.font, at: 0, effectiveRange: nil) as! NSFont
                try require(font.pointSize == size, "Heading level did not invalidate native styling")
            }
        }
        try format(.paragraph, range)
        let cleared = try read(core).projection
        try require(cleared.blocks.prefix(2).allSatisfy { $0.kind == "paragraph" && $0.runs.allSatisfy { !$0.attributes.bold && !$0.attributes.italic && !$0.attributes.strike } }, "Body reset did not clear root block formatting")
        try require(cleared.blocks[1].runs.contains { $0.attributes.entityLink }, "Body reset removed an entity link")
        try require(cleared.comments.first?.quote == original.comments.first?.quote, "Formatting lost the comment")
        opened = nil; core.reopen { opened = $0 }; try wait { opened != nil }; _ = try opened!.get()
        view.binding.load(); try wait { !view.binding.hasPendingWork }
        try require(try read(core).projection.blocks.prefix(2).allSatisfy { $0.kind == "paragraph" }, "Body formatting did not survive cold reopen")
        let quote = try read(core).projection.blocks.first { $0.id == "fixture-quote-paragraph" }!
        view.binding.format(.paragraph, range: NSRange(location: quote.range.location, length: 0))
        try wait { !view.binding.hasPendingWork }
        try require(view.binding.canEdit && !view.binding.hasFailedDraft, "Container refusal poisoned the shared owner")
        view.textView.insertText("新", replacementRange: NSRange(location: 0, length: 0))
        try wait { !view.binding.hasPendingWork }
        try require(try read(core).projection.text == "新" + original.text, "Refused format made the existing input base unusable")
        view.textView.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: 0, length: 0))
        try require(!view.binding.canFormat(.heading1, range: range) && !passive.binding.canFormat(.bold, range: range), "Composition enabled formatting in another view")
        view.textView.insertText("", replacementRange: NSRange(location: NSNotFound, length: 0))
        try wait { !view.binding.hasPendingWork }
        return ["AppKit native multiblock formatting shares styles selection one-step history and persisted structure",
            "AppKit heading levels body reset and container refusal preserve links comments and usable input"]
    }
}
