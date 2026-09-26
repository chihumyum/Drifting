import AppKit

/// Headless execution of the real Swift queue + Rust ABI. TextKit calls below
/// are programmatic, not physical IME or desktop keyboard-synthesis evidence.
@main
struct BindingAcceptance {
    static func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        if try condition() == false { throw LabError.message(message) }
    }
    static func wait(file: String = #fileID, line: Int = #line, _ condition: () -> Bool) throws {
        let deadline = Date().addingTimeInterval(15)
        while !condition() && Date() < deadline {
            _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
        try require(condition(), "Timed out waiting for the Swift/Rust queue at \(file):\(line)")
    }
    static func read(_ core: LabCore) throws -> LabDocumentState {
        var result: Result<LabDocumentState, Error>?
        core.document { result = $0 }
        try wait { result != nil }
        return try result!.get()
    }
    static func main() throws {
        _ = NSApplication.shared
        if CommandLine.arguments.contains("--remote-recovery-only") {
            print(String(data: try JSONSerialization.data(withJSONObject: ["status": "passed", "cases": try remoteRecoveryAcceptance()]), encoding: .utf8)!)
            return
        }
        if CommandLine.arguments.contains("--text-identity-only") {
            print(String(data: try JSONSerialization.data(withJSONObject: ["status": "passed", "cases": try textIdentityAcceptance()]), encoding: .utf8)!)
            return
        }
        if CommandLine.arguments.contains("--style-only") {
            print(String(data: try JSONSerialization.data(withJSONObject: ["status": "passed", "cases": try styleAcceptance()]), encoding: .utf8)!)
            return
        }
        if CommandLine.arguments.contains("--prefix-deletion-only") {
            print(String(data: try JSONSerialization.data(withJSONObject: ["status": "passed", "cases": try prefixDeletionQueueAcceptance()]), encoding: .utf8)!)
            return
        }
        if CommandLine.arguments.contains("--partial-quote-only") {
            print(String(data: try JSONSerialization.data(withJSONObject: ["status": "passed", "cases": try partialQuoteHistoryAcceptance()]), encoding: .utf8)!)
            return
        }
        if CommandLine.arguments.contains("--relocation-only") {
            print(String(data: try JSONSerialization.data(withJSONObject: ["status": "passed", "cases": try relocationAcceptance()]), encoding: .utf8)!)
            return
        }
        if CommandLine.arguments.contains("--remote-block-only") {
            print(String(data: try JSONSerialization.data(withJSONObject: ["status": "passed", "cases": try remoteBlockAcceptance()]), encoding: .utf8)!)
            return
        }
        let hashedMarks = try JSONDecoder().decode(NativeMarks.self, from: Data("{\"entityLink--1234abcd\":{\"targetId\":\"synthetic\"},\"bold\":{}}".utf8))
        try require(hashedMarks.entityLink && hashedMarks.bold, "Overlapping Yjs link marks were not rendered")
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: parent) }
        let core = LabCore(directory: parent.appendingPathComponent("apple-native-lab"))
        var opened: Result<LabState, Error>?
        core.open { opened = $0 }; try wait { opened != nil }; _ = try opened!.get()
        let binding = DocumentBinding(core: core)
        var lastStatus = ""
        binding.onStatus = { lastStatus = $0 }
        binding.load(); try wait { binding.state != nil && !binding.hasPendingWork }
        let original = binding.state!.projection.text

        // Deliberately queue more input before a single asynchronous reply runs.
        var text = original
        for token in ["A", "👩🏽‍🚀", "𠮷", "e\u{301}"] {
            text = token + text
            binding.changed(text, marked: false)
        }
        try wait { !binding.hasPendingWork }
        try require(try read(core).projection.text == text, "A stale reply overwrote rapid input")
        binding.history(redo: false); try wait { !binding.hasPendingWork }
        try require(binding.state!.projection.text == "𠮷👩🏽‍🚀A" + original, "Undo crossed an input event boundary")
        binding.history(redo: true); try wait { !binding.hasPendingWork }
        try require(binding.state!.projection.text == text, "Redo did not restore the last event")

        let revision = binding.state!.projection.revision
        binding.changed("zhong" + text, marked: true)
        binding.changed("中文" + text, marked: true)
        try require(try read(core).projection.revision == revision, "Marked text was published before commit")
        binding.changed("中文" + text, marked: false)
        try wait { !binding.hasPendingWork }
        try require(try read(core).projection.text == "中文" + text, "Composition commit was lost")
        binding.history(redo: false); try wait { !binding.hasPendingWork }
        try require(binding.state!.projection.text == text, "Composition was split across undo units")
        try require(binding.allows(NSRange(location: 0, length: 0), replacement: "\n", marked: false), "Paragraph split was refused")
        // Enter at heading start, then type before its asynchronous reply.
        binding.changed("\n" + text, marked: false)
        binding.changed("新段\n" + text, marked: false)
        try wait { !binding.hasPendingWork || binding.hasFailedDraft || binding.state?.saveError != nil }
        try require(!binding.hasPendingWork, "Pending split failed: \(lastStatus); save: \(binding.state?.saveError ?? "none")")
        try require(binding.state!.projection.text == "新段\n" + text, "Typing after a pending split was lost")
        try require(binding.state!.projection.blocks[0].kind == "paragraph", "Heading-start Enter did not insert a paragraph")
        let stableHeading = binding.state!.projection.blocks[1].id
        try require(stableHeading == "fixture-heading", "Heading-start Enter replaced the original identity")
        binding.history(redo: false); try wait { !binding.hasPendingWork }
        binding.history(redo: false); try wait { !binding.hasPendingWork }
        try require(binding.state!.projection.text == text, "Split undo did not restore the document")

        var reopened: Result<LabState, Error>?
        core.reopen { reopened = $0 }; try wait { reopened != nil }; _ = try reopened!.get()
        binding.load(); try wait { !binding.hasPendingWork }
        try require(binding.state!.projection.text == text, "SQLite did not restore the same document")

        // Exercise actual AppKit delegates without generating global events.
        let view = NativeDocumentView(core: core)
        view.binding.load(); try wait { view.binding.state != nil && !view.binding.hasPendingWork }
        view.textView.setSelectedRange(NSRange(location: 0, length: 0))
        view.textView.insertText("灯", replacementRange: NSRange(location: 0, length: 0))
        try wait { !view.binding.hasPendingWork }
        try require(try read(core).projection.text == "灯" + text, "NSTextView edit did not reach Yrs")
        let beforeMarked = try read(core).projection.revision
        view.textView.setMarkedText("deng", selectedRange: NSRange(location: 4, length: 0), replacementRange: NSRange(location: 0, length: 0))
        view.textView.setMarkedText("灯塔", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        try require(try read(core).projection.revision == beforeMarked, "NSTextView marked text escaped the composition guard")
        view.textView.insertText("灯塔", replacementRange: NSRange(location: NSNotFound, length: 0))
        try wait { !view.binding.hasPendingWork }
        try require(try read(core).projection.text == "灯塔灯" + text, "NSTextView composition commit failed")
        view.undoProse(); try wait { !view.binding.hasPendingWork }
        try require(try read(core).projection.text == "灯" + text, "Native undo did not restore the pre-composition state")
        view.textView.insertText("\n", replacementRange: NSRange(location: 1, length: 0))
        try wait { !view.binding.hasPendingWork }
        let splitText = "灯\n" + text
        try require(try read(core).projection.text == splitText, "NSTextView Enter did not split the heading")
        view.textView.insertText("", replacementRange: NSRange(location: 1, length: 1))
        try wait { !view.binding.hasPendingWork }
        try require(try read(core).projection.text == "灯" + text, "NSTextView separator deletion did not join blocks")
        view.undoProse(); try wait { !view.binding.hasPendingWork }
        try require(try read(core).projection.text == splitText, "Join undo did not restore stable blocks")
        let comment = try read(core).projection.comments[0]
        try require(comment.quote == "北塔" && comment.status == "anchored", "Original comment quote was lost")
        let commentAt = comment.ranges[0].location
        try require(view.textView.textStorage?.attribute(.backgroundColor, at: commentAt, effectiveRange: nil) != nil,
            "Comment range did not receive its native highlight")
        view.textView.insertText("\n", replacementRange: NSRange(location: commentAt + 1, length: 0))
        try wait { !view.binding.hasPendingWork }
        let splitComment = try read(core).projection.comments[0]
        try require(splitComment.quote == "北塔" && splitComment.ranges[0].length == 3, "Comment did not follow Enter")
        view.undoProse(); try wait { !view.binding.hasPendingWork }
        try require(try read(core).projection.comments[0].ranges[0].length == 2, "Comment undo did not restore its range")
        view.redoProse(); try wait { !view.binding.hasPendingWork }
        reopened = nil
        core.reopen { reopened = $0 }; try wait { reopened != nil }; _ = try reopened!.get()
        view.binding.load(); try wait { !view.binding.hasPendingWork }
        let reopenedComment = try read(core).projection.comments[0]
        try require(reopenedComment.quote == "北塔" && reopenedComment.ranges[0].length == 3, "Redo comment anchor did not survive SQLite reopen")
        let cases = ["queued Unicode edits", "per-event undo and redo", "marked text waits for commit", "composition undo",
            "heading split and queued typing", "SQLite reopen", "AppKit delegate edit", "AppKit marked-text commit and undo",
            "AppKit Enter, join and structural undo", "AppKit comment highlight, split, history and SQLite reopen"] + (try multiViewAcceptance()) + (try selectionAcceptance()) + (try draftTransportAcceptance()) + (try inputQueueAcceptance()) + (try prefixDeletionQueueAcceptance()) + (try nativeHistoryAcceptance()) + (try partialQuoteHistoryAcceptance()) + (try remoteBlockAcceptance()) + (try remoteRecoveryAcceptance()) + (try relocationAcceptance()) + (try styleAcceptance()) + (try textIdentityAcceptance()) + (try formattingAcceptance()) + (try outlineAcceptance())
        print(String(data: try JSONSerialization.data(withJSONObject: ["status": "passed", "cases": cases]), encoding: .utf8)!)
    }
}
