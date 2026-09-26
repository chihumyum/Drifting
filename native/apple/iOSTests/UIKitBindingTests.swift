import XCTest
import UIKit
@testable import DriftingNativeIOS

/// Hosted simulator tests of actual UITextInput methods and delegate callbacks.
/// No test calls DocumentBinding.changed/prepareInput to simulate those events.
/// Programmatic marked text is distinct from a physical keyboard/IME session.
@MainActor
final class UIKitBindingTests: XCTestCase {
    private var directory: URL!
    private var core: LabCore!
    private var view: NativeDocumentView!
    private var text: UITextView!
    private var window: UIWindow!
    private weak var previousWindow: UIWindow?

    private func result<T>(_ operation: (@escaping (Result<T, Error>) -> Void) -> Void) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in operation { continuation.resume(with: $0) } }
    }
    private func eventually(_ context: String = "input", file: StaticString = #filePath, line: UInt = #line, _ ready: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(10)
        while !ready() && Date() < deadline { try await Task.sleep(nanoseconds: 5_000_000) }
        guard ready() else {
            let detail = "UIKit input did not settle at \(context): "
                + "commits=\(view?.binding.store.hasPendingCommits == true), "
                + "draft=\(view?.binding.hasUnsubmittedDraft == true), failed=\(view?.binding.hasFailedDraft == true), "
                + "marked=\(text?.markedTextRange != nil), saved=\(view?.binding.state?.saved == true), "
                + "saveError=\(view?.binding.state?.saveError ?? "none"), "
                + "visiblePrefix=\(Array((text?.text ?? "").utf16.prefix(20)))"
            XCTFail(detail, file: file, line: line)
            throw LabError.message(detail)
        }
    }
    private func settle(_ context: String = "input", file: StaticString = #filePath, line: UInt = #line) async throws {
        try await eventually(context, file: file, line: line) { !self.view.binding.hasPendingWork }
    }
    private func read() async throws -> LabDocumentState { try await result { core.document(completion: $0) } }
    private func exported(_ owner: LabCore) async throws -> NativeCheckpoint {
        try await result { owner.exportDocument(completion: $0) }
    }
    private func history(redo: Bool = false) async throws {
        view.binding.history(redo: redo); try await settle()
    }
    private func prepare() async throws {
        continueAfterFailure = false
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        core = LabCore(directory: directory.appendingPathComponent("owner/apple-native-lab"))
        let _: LabState = try await result { core.open(completion: $0) }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        previousWindow = scene.windows.first { $0.isKeyWindow }
        window = UIWindow(windowScene: scene)
        let controller = UIViewController()
        view = NativeDocumentView(core: core)
        controller.view = view
        window.rootViewController = controller; window.makeKeyAndVisible()
        func findText(_ view: UIView) -> UITextView? {
            if let text = view as? UITextView { return text }
            for child in view.subviews { if let text = findText(child) { return text } }
            return nil
        }
        text = try XCTUnwrap(findText(view))
        view.binding.load(); try await settle()
        window.layoutIfNeeded()
        XCTAssertTrue(text.becomeFirstResponder())
        text.selectedRange = NSRange(location: 0, length: 0)
    }
    override func tearDown() {
        text?.resignFirstResponder()
        window?.isHidden = true; window?.rootViewController = nil
        previousWindow?.makeKey()
        text = nil; view = nil; window = nil; core = nil
        if let directory { try? FileManager.default.removeItem(at: directory) }
        super.tearDown()
    }

    func testSelectionFormattingHeadingStylesHistoryAndReopen() async throws {
        try await prepare()
        let original = try await read().projection
        let range = NSRange(location: 0, length: NSMaxRange(original.blocks[1].range.nsRange))
        text.selectedRange = range
        view.binding.format(.bold, range: range); try await settle("multiblock bold")
        var projection = try await read().projection
        XCTAssertTrue(projection.blocks.prefix(2).allSatisfy { $0.runs.allSatisfy { $0.attributes.bold } })
        XCTAssertEqual(text.selectedRange, range)
        XCTAssertEqual(text.text, original.text)
        try await history()
        projection = try await read().projection
        XCTAssertTrue(projection.blocks[0].runs.allSatisfy { !$0.attributes.bold })
        XCTAssertTrue(projection.blocks[1].runs.contains { !$0.attributes.bold })
        try await history(redo: true)
        text.selectedRange = range
        view.binding.format(.italic, range: range); try await settle("multiblock italic")
        let font = try XCTUnwrap(text.textStorage.attribute(.font, at: original.blocks[1].range.location, effectiveRange: nil) as? UIFont)
        XCTAssertTrue(font.fontDescriptor.symbolicTraits.contains([.traitBold, .traitItalic]))
        for (action, level, size) in [(NativeFormatAction.heading1, 1, 28.0), (.heading2, 2, 24.0), (.heading3, 3, 20.0)] {
            text.selectedRange = NSRange(location: 0, length: 0)
            view.binding.format(action, range: text.selectedRange); try await settle("heading")
            projection = try await read().projection
            XCTAssertEqual(projection.blocks[0].kind, "heading")
            XCTAssertEqual(projection.blocks[0].headingLevel, level)
            let headingFont = try XCTUnwrap(text.textStorage.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)
            XCTAssertEqual(headingFont.pointSize, size)
        }
        text.selectedRange = range
        view.binding.format(.paragraph, range: range); try await settle("body reset")
        projection = try await read().projection
        XCTAssertTrue(projection.blocks.prefix(2).allSatisfy { $0.kind == "paragraph" && $0.runs.allSatisfy { !$0.attributes.bold && !$0.attributes.italic && !$0.attributes.strike } })
        XCTAssertTrue(projection.blocks[1].runs.contains { $0.attributes.entityLink })
        XCTAssertEqual(projection.comments.first?.quote, original.comments.first?.quote)
        let _: LabState = try await result { core.reopen(completion: $0) }
        view.binding.load(); try await settle("format reopen")
        projection = try await read().projection
        XCTAssertTrue(projection.blocks.prefix(2).allSatisfy { $0.kind == "paragraph" })
        XCTAssertEqual(projection.text, original.text)
        text.selectedRange = NSRange(location: 0, length: 0)
        text.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0))
        XCTAssertFalse(view.binding.canFormat(.heading1, range: range))
        text.setMarkedText("", selectedRange: NSRange(location: 0, length: 0))
        text.unmarkText(); try await settle("format composition guard")
    }

    func testMarkedCommitContinuedUnicodeInputAndCancel() async throws {
        try await prepare()
        let before = try await read()
        let original = before.projection.text
        let checkpoint = try await exported(core)
        text.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0))
        XCTAssertNotNil(text.markedTextRange)
        XCTAssertTrue(view.binding.hasUnsubmittedDraft)
        text.setMarkedText("中文", selectedRange: NSRange(location: 2, length: 0))
        let marked = try await exported(core)
        XCTAssertEqual(marked.update, checkpoint.update, "Marked text escaped into live prose")
        text.unmarkText()
        text.insertText("👩🏽‍🚀")
        try await settle()
        XCTAssertEqual(text.text, "中文👩🏽‍🚀" + original)
        XCTAssertEqual(text.selectedRange, NSRange(location: 9, length: 0))
        XCTAssertEqual(text.undoManager?.isUndoRegistrationEnabled, false, "UIKit must not maintain an independent prose history")
        try await history(); XCTAssertEqual(text.text, "中文" + original)
        try await history(); XCTAssertEqual(text.text, original)
        let beforeCancel = try await read()
        text.selectedRange = NSRange(location: 0, length: 0)
        text.setMarkedText("cancel", selectedRange: NSRange(location: 6, length: 0))
        text.setMarkedText("", selectedRange: NSRange(location: 0, length: 0))
        text.unmarkText(); try await settle()
        let afterCancel = try await read()
        XCTAssertEqual(afterCancel.projection.text, original)
        XCTAssertEqual(afterCancel.projection.revision, beforeCancel.projection.revision, "Cancel created a prose write")
    }

    func testCanonicalUnicodeReplacementAndCompositionPreserveExactUTF16AcrossViews() async throws {
        try await prepare()
        let original = try await read().projection
        let decomposed = "e\u{301}", composed = "\u{e9}"
        XCTAssertEqual(decomposed, composed, "Fixture must expose Swift canonical equality")
        XCTAssertNotEqual(Array(decomposed.utf16), Array(composed.utf16))

        let passive = NativeDocumentView(core: core)
        func findText(_ root: UIView) -> UITextView? {
            if let candidate = root as? UITextView { return candidate }
            return root.subviews.lazy.compactMap { findText($0) }.first
        }
        let passiveText = try XCTUnwrap(findText(passive))
        XCTAssertFalse(passive.binding.hasUnsubmittedDraft, "Constructing a shared view must not submit its initially empty text")
        passive.binding.load(); try await settle("passive load")
        defer { _ = passive.binding.detach() }
        XCTAssertTrue(text.isFirstResponder)
        XCTAssertFalse(passiveText.isFirstResponder)
        let manager = try XCTUnwrap(text.undoManager)

        func exact(_ prefix: String, _ context: String) async throws {
            let saved = try await read()
            let expected = Array((prefix + original.text).utf16)
            XCTAssertTrue(saved.saved, context)
            XCTAssertEqual(Array(saved.projection.text.utf16), expected, "Stored scalar identity: \(context)")
            for actual in [text!, passiveText] {
                XCTAssertEqual(Array(actual.text.utf16), expected, "Active/passive scalar identity: \(context)")
                XCTAssertEqual(actual.textStorage.length, expected.count, "Storage UTF-16 length: \(context)")
                XCTAssertEqual(actual.offset(from: actual.beginningOfDocument, to: actual.endOfDocument), expected.count,
                               "UITextInput UTF-16 extent: \(context)")
                XCTAssertLessThanOrEqual(NSMaxRange(actual.selectedRange), expected.count, context)
            }
            XCTAssertEqual(saved.projection.blocks.count, original.blocks.count, context)
            for (index, pair) in zip(original.blocks, saved.projection.blocks).enumerated() {
                XCTAssertEqual(pair.0.id, pair.1.id, context)
                XCTAssertEqual(pair.1.range.location, pair.0.range.location + (index == 0 ? 0 : prefix.utf16.count),
                               "Stored block UTF-16 start: \(context)")
                XCTAssertEqual(pair.1.range.length, pair.0.range.length + (index == 0 ? prefix.utf16.count : 0),
                               "Stored block UTF-16 length: \(context)")
            }
        }
        func replacePrefix(length: Int, with value: String) throws {
            let end = try XCTUnwrap(text.position(from: text.beginningOfDocument, offset: length))
            let range = try XCTUnwrap(text.textRange(from: text.beginningOfDocument, to: end))
            text.replace(range, withText: value)
        }

        text.insertText(decomposed); try await settle("seed NFD"); try await exact(decomposed, "seed NFD")
        try replacePrefix(length: 2, with: composed)
        try await settle("UITextInput NFD to NFC"); try await exact(composed, "UITextInput NFD to NFC")
        manager.undo(); try await settle("shorter replacement undo"); try await exact(decomposed, "shorter replacement undo")
        manager.redo(); try await settle("shorter replacement redo"); try await exact(composed, "shorter replacement redo")
        try replacePrefix(length: 1, with: decomposed)
        try await settle("UITextInput NFC to NFD"); try await exact(decomposed, "UITextInput NFC to NFD")
        manager.undo(); try await settle("longer replacement undo"); try await exact(composed, "longer replacement undo")
        manager.redo(); try await settle("longer replacement redo"); try await exact(decomposed, "longer replacement redo")

        text.selectedRange = NSRange(location: 0, length: 2)
        let beforeMarked = try await exported(core)
        text.setMarkedText("temporary", selectedRange: NSRange(location: 9, length: 0))
        XCTAssertNotNil(text.markedTextRange)
        XCTAssertTrue(view.binding.hasUnsubmittedDraft)
        let whileMarked = try await exported(core)
        XCTAssertEqual(whileMarked.update, beforeMarked.update, "Marked candidate escaped into saved prose")
        XCTAssertEqual(Array(passiveText.text.utf16), Array((decomposed + original.text).utf16))
        text.insertText(composed)
        try await settle("marked NFD to NFC commit"); XCTAssertNil(text.markedTextRange)
        try await exact(composed, "marked NFD to NFC commit")
        manager.undo(); try await settle("composition single undo"); try await exact(decomposed, "composition single undo")
        manager.redo(); try await settle("composition redo"); try await exact(composed, "composition redo")

        // The marked candidate is canonically equal to the saved character,
        // so a Swift String == shortcut would incorrectly discard this commit.
        text.selectedRange = NSRange(location: 0, length: 1)
        text.setMarkedText(decomposed, selectedRange: NSRange(location: 2, length: 0))
        XCTAssertNotNil(text.markedTextRange)
        XCTAssertEqual(Array(passiveText.text.utf16), Array((composed + original.text).utf16))
        text.unmarkText(); try await settle("canonical-equal candidate unmark commit")
        try await exact(decomposed, "canonical-equal candidate unmark commit")
        manager.undo(); try await settle("unmark single undo"); try await exact(composed, "unmark single undo")
        manager.redo(); try await settle("unmark redo"); try await exact(decomposed, "unmark redo")

        let _: LabState = try await result { core.reopen(completion: $0) }
        view.binding.load(); try await settle("SQLite reopen")
        try await exact(decomposed, "SQLite reopen")
    }

    func testOverlappingRemoteCompositionAndImmediateContinuedInput() async throws {
        try await prepare()
        let peer = LabCore(directory: directory.appendingPathComponent("peer/apple-native-lab"))
        let _: LabState = try await result { peer.open(completion: $0) }
        let original = try await read().projection
        let quote = original.comments[0].ranges[0].nsRange
        let _: LabDocumentState = try await result { peer.document("documentReplace", edit: ["revision": original.revision,
            "range": ["location": quote.location + 1, "length": 0], "text": "远端"], completion: $0) }
        let remote = try await exported(peer)
        text.selectedRange = quote
        text.setMarkedText("xin", selectedRange: NSRange(location: 3, length: 0))
        let visibleDraft = text.text
        view.binding.store.applyRemote(remote.update)
        try await eventually { !self.view.binding.store.hasPendingCommits }
        XCTAssertEqual(text.text, visibleDraft, "Remote reply reset marked text")
        XCTAssertNotNil(text.markedTextRange)
        text.insertText("新")
        text.insertText("续")
        XCTAssertTrue(view.binding.canEdit)
        try await settle()
        let merged = try await read().projection.text
        XCTAssertTrue(merged.contains("新续") && merged.contains("远端"))
        XCTAssertFalse(merged.contains("北远端塔"))
        XCTAssertEqual(text.text, merged)
        XCTAssertEqual(text.selectedRange, NSRange(location: (merged as NSString).range(of: "新续").location + 2, length: 0))
        try await history(); XCTAssertFalse(text.text.contains("续")); XCTAssertTrue(text.text.contains("远端"))
        try await history(); XCTAssertTrue(text.text.contains("北远端塔"))
        try await history(redo: true); try await history(redo: true)
        XCTAssertEqual(text.text, merged)
        view.binding.store.applyRemote(remote.update); try await settle()
        XCTAssertEqual(text.text, merged, "Duplicate replay changed prose")
        let _: LabState = try await result { core.reopen(completion: $0) }
        view.binding.load(); try await settle()
        XCTAssertEqual(text.text, merged)
    }

    func testLateOriginalQuotePrefixAcrossTwoViewsHistoryAndSQLiteReopen() async throws {
        try await assertLateOriginalQuotePrefix(mixed: false)
    }

    func testMixedLatePrefixAndSafeSuffixAcrossTwoViewsHistoryAndSQLiteReopen() async throws {
        try await assertLateOriginalQuotePrefix(mixed: true)
    }

    func testInterleavedUnicodePrefixAndSafeSuffixClocksAcrossTwoViewsHistoryAndSQLiteReopen() async throws {
        try await assertLateOriginalQuotePrefix(mixed: true, interleaved: true)
    }

    private func assertLateOriginalQuotePrefix(mixed: Bool, interleaved: Bool = false) async throws {
        try await prepare()
        let latePrefix = interleaved ? "保🙂续🚀" : "保🙂"
        // Synthetic Yjs v1 seed shared with drifting-prose/tests/durability.rs:
        // client 37501, left[b=潮汐], right[c=夜航,d=终章]. The late update was
        // generated by Node's production yjs package: new Y.Doc(); clientID=37502,
        // applyUpdate(seed), save encodeStateVector, original b XmlText.insert
        // (0, '保🙂'), then encodeStateAsUpdate(doc, savedVector). The mixed
        // variant uses one transaction with b.insert(0, '保🙂') followed by
        // d.insert(1, '合') from that same client. The interleaved variant then
        // performs b.insert(3, '续🚀') in the same transaction; full is
        // encodeStateAsUpdate(doc). Yjs verifies d text-type ID 37501:14, 合
        // item ID 37502:3, and b's prefix clocks [0,1,2,4,5,6] from client 37502.
        // No Node runtime or generated callback is used by this hosted UIKit test.
        let seed = "ARD9pAIABwEHZGVmYXVsdAMKYmxvY2txdW90ZQcA/aQCAAMJcGFyYWdyYXBoBwD9pAIBBgQA/aQCAgbmva7msZAoAP2kAgECaWQBdwFiKAD9pAIAAmlkAXcEbGVmdIf9pAIAAwpibG9ja3F1b3RlBwD9pAIHAwlwYXJhZ3JhcGgHAP2kAggGBAD9pAIJBuWknOiIqigA/aQCCAJpZAF3AWOH/aQCCAMJcGFyYWdyYXBoBwD9pAINBgQA/aQCDgbnu4jnq6AoAP2kAg0CaWQBdwFkKAD9pAIHAmlkAXcFcmlnaHQA"
        let late = interleaved
            ? "AQP+pAIARP2kAgMH5L+d8J+ZgsT9pAIP/aQCEAPlkIjE/qQCAv2kAgMH57ut8J+agAA="
            : mixed ? "AQL+pAIARP2kAgMH5L+d8J+ZgsT9pAIP/aQCEAPlkIgA" : "AQH+pAIARP2kAgMH5L+d8J+ZggA="
        let full = interleaved
            ? "AgP+pAIARP2kAgMH5L+d8J+ZgsT9pAIP/aQCEAPlkIjE/qQCAv2kAgMH57ut8J+agBH9pAIABwEHZGVmYXVsdAMKYmxvY2txdW90ZQcA/aQCAAMJcGFyYWdyYXBoBwD9pAIBBgQA/aQCAgbmva7msZAoAP2kAgECaWQBdwFiKAD9pAIAAmlkAXcEbGVmdIf9pAIAAwpibG9ja3F1b3RlBwD9pAIHAwlwYXJhZ3JhcGgHAP2kAggGBAD9pAIJBuWknOiIqigA/aQCCAJpZAF3AWOH/aQCCAMJcGFyYWdyYXBoBwD9pAINBgQA/aQCDgPnu4iE/aQCDwPnq6AoAP2kAg0CaWQBdwFkKAD9pAIHAmlkAXcFcmlnaHQA"
            : mixed
            ? "AgL+pAIARP2kAgMH5L+d8J+ZgsT9pAIP/aQCEAPlkIgR/aQCAAcBB2RlZmF1bHQDCmJsb2NrcXVvdGUHAP2kAgADCXBhcmFncmFwaAcA/aQCAQYEAP2kAgIG5r2u5rGQKAD9pAIBAmlkAXcBYigA/aQCAAJpZAF3BGxlZnSH/aQCAAMKYmxvY2txdW90ZQcA/aQCBwMJcGFyYWdyYXBoBwD9pAIIBgQA/aQCCQblpJzoiKooAP2kAggCaWQBdwFjh/2kAggDCXBhcmFncmFwaAcA/aQCDQYEAP2kAg4D57uIhP2kAg8D56ugKAD9pAINAmlkAXcBZCgA/aQCBwJpZAF3BXJpZ2h0AA=="
            : late
        view.binding.store.applyRemote(seed)
        try await settle("quote seed")
        let initial = try await read().projection
        let b = try XCTUnwrap(initial.blocks.first { $0.id == "b" })
        let d = try XCTUnwrap(initial.blocks.first { $0.id == "d" })
        let original = initial.text as NSString
        let prefix = original.substring(to: b.range.location)
        let suffix = original.substring(from: NSMaxRange(d.range.nsRange))

        let passive = NativeDocumentView(core: core)
        func findText(_ root: UIView) -> UITextView? {
            if let candidate = root as? UITextView { return candidate }
            return root.subviews.lazy.compactMap { findText($0) }.first
        }
        let passiveText = try XCTUnwrap(findText(passive))
        passive.binding.load(); try await settle("quote passive view")
        defer { _ = passive.binding.detach() }
        XCTAssertTrue(text.isFirstResponder)
        XCTAssertFalse(passiveText.isFirstResponder)
        let manager = try XCTUnwrap(text.undoManager)

        let start = try XCTUnwrap(text.position(from: text.beginningOfDocument, offset: b.range.location + 1))
        let end = try XCTUnwrap(text.position(from: start, offset: 3))
        let deletion = try XCTUnwrap(text.textRange(from: start, to: end))
        text.selectedTextRange = deletion
        text.replace(deletion, withText: "")
        try await settle("quote partial deletion")
        XCTAssertEqual(Array(text.text.utf16), Array((prefix + "潮航\n终章" + suffix).utf16))
        XCTAssertTrue(manager.canUndo)

        var selectedLateText = false
        if mixed {
            let joinedProjection = try await read().projection
            let joinedD = try XCTUnwrap(joinedProjection.blocks.first { $0.id == "d" })
            passiveText.selectedRange = NSRange(location: joinedD.range.location + 1, length: 1)
            try await eventually("initial passive suffix selection") { passive.binding.selectionIsAnchored }
            selectedLateText = true
        }
        func exact(joined: Bool, _ context: String) async throws {
            try await settle(context)
            if selectedLateText {
                try await eventually("\(context) passive selection") { passive.binding.selectionIsAnchored }
            }
            let saved = try await read()
            let expected = prefix + latePrefix + (joined ? "潮航" : "潮汐\n夜航")
                + (mixed ? "\n终合章" : "\n终章") + suffix
            XCTAssertTrue(saved.saved, context)
            XCTAssertNil(saved.saveError, context)
            XCTAssertNil(saved.remoteBlock, context)
            XCTAssertEqual(Array(saved.projection.text.utf16), Array(expected.utf16), context)
            for actual in [text!, passiveText] {
                XCTAssertEqual(Array(actual.text.utf16), Array(expected.utf16), "Two-view text: \(context)")
                XCTAssertEqual(actual.textStorage.length, expected.utf16.count, "UTF-16 extent: \(context)")
            }
            XCTAssertEqual(saved.projection.blocks.filter { $0.id == "b" }.count, 1, context)
            XCTAssertEqual(saved.projection.blocks.contains { $0.id == "c" }, !joined, context)
            if selectedLateText {
                let currentD = try XCTUnwrap(saved.projection.blocks.first { $0.id == "d" })
                let selection = mixed ? NSRange(location: currentD.range.location + 2, length: 1)
                    : NSRange(location: b.range.location, length: 3)
                XCTAssertEqual(passiveText.selectedRange, selection, context)
                XCTAssertEqual(saved.projection.selections.first { $0.viewId == passive.binding.viewID }?.range?.nsRange,
                               selection, "Core selection on late prefix or original suffix: \(context)")
            }
            for comment in initial.comments {
                let current = try XCTUnwrap(saved.projection.comments.first { $0.id == comment.id })
                XCTAssertEqual(current.quote, comment.quote, context)
                XCTAssertEqual(current.status, comment.status, context)
            }
        }

        view.binding.store.applyRemote(late)
        try await exact(joined: true, "late original prefix")
        if !mixed {
            passiveText.selectedRange = NSRange(location: b.range.location, length: 3)
            try await eventually("initial passive 保🙂 selection") { passive.binding.selectionIsAnchored }
            selectedLateText = true
        }
        let beforeDuplicate = try await exported(core)
        view.binding.store.applyRemote(late)
        try await exact(joined: true, "duplicate late update")
        if mixed {
            view.binding.store.applyRemote(full)
            try await exact(joined: true, "duplicate full update")
        }
        let afterDuplicate = try await exported(core)
        XCTAssertEqual(afterDuplicate.update, beforeDuplicate.update, "Duplicate packet authored another repair")
        for cycle in 0..<2 {
            XCTAssertTrue(manager.canUndo)
            manager.undo()
            try await exact(joined: false, "quote undo \(cycle)")
            XCTAssertTrue(manager.canRedo)
            manager.redo()
            try await exact(joined: true, "quote redo \(cycle)")
        }
        let _: LabState = try await result { core.reopen(completion: $0) }
        view.binding.load()
        try await exact(joined: true, "quote SQLite reopen")
        view.binding.store.applyRemote(late)
        try await exact(joined: true, "duplicate after SQLite reopen")
        if mixed {
            view.binding.store.applyRemote(full)
            try await exact(joined: true, "duplicate full update after SQLite reopen")
        }
    }

    func testBlockedDependencyRecoveryPreservesQueuedInputAcrossTwoViewsAndSQLiteReopen() async throws {
        try await assertBlockedDependencyRecovery(marked: false)
    }

    func testBlockedDependencyRecoveryPreservesMarkedInputAcrossTwoViewsAndSQLiteReopen() async throws {
        try await assertBlockedDependencyRecovery(marked: true)
    }

    private func assertBlockedDependencyRecovery(marked: Bool) async throws {
        try await prepare()
        // Production Yjs v1 events on the same synthetic 37501 quote seed as
        // the relocation tests. Writer 37931 first inserts d[0] = "远🙂"
        // (clocks 0..<3), then original b[0] = "保" (clock 3). Each literal
        // is the exact on("update") event; full is encodeStateAsUpdate(peer).
        // Receiving b before d must durably block, not treat an unproved Skip
        // as safe. The later dependency releases that stored row via the owner.
        let seed = "ARD9pAIABwEHZGVmYXVsdAMKYmxvY2txdW90ZQcA/aQCAAMJcGFyYWdyYXBoBwD9pAIBBgQA/aQCAgbmva7msZAoAP2kAgECaWQBdwFiKAD9pAIAAmlkAXcEbGVmdIf9pAIAAwpibG9ja3F1b3RlBwD9pAIHAwlwYXJhZ3JhcGgHAP2kAggGBAD9pAIJBuWknOiIqigA/aQCCAJpZAF3AWOH/aQCCAMJcGFyYWdyYXBoBwD9pAINBgQA/aQCDgbnu4jnq6AoAP2kAg0CaWQBdwFkKAD9pAIHAmlkAXcFcmlnaHQA"
        let blocked = "AQGrqAIDRP2kAgMD5L+dAA=="
        let dependency = "AQGrqAIARP2kAg8H6L+c8J+ZggA="
        let full = "AgKrqAIARP2kAg8H6L+c8J+ZgkT9pAIDA+S/nRD9pAIABwEHZGVmYXVsdAMKYmxvY2txdW90ZQcA/aQCAAMJcGFyYWdyYXBoBwD9pAIBBgQA/aQCAgbmva7msZAoAP2kAgECaWQBdwFiKAD9pAIAAmlkAXcEbGVmdIf9pAIAAwpibG9ja3F1b3RlBwD9pAIHAwlwYXJhZ3JhcGgHAP2kAggGBAD9pAIJBuWknOiIqigA/aQCCAJpZAF3AWOH/aQCCAMJcGFyYWdyYXBoBwD9pAINBgQA/aQCDgbnu4jnq6AoAP2kAg0CaWQBdwFkKAD9pAIHAmlkAXcFcmlnaHQA"
        view.binding.store.applyRemote(seed)
        try await settle("recovery quote seed")
        let initial = try await read().projection
        let b = try XCTUnwrap(initial.blocks.first { $0.id == "b" })
        let d = try XCTUnwrap(initial.blocks.first { $0.id == "d" })
        let original = initial.text as NSString
        let prefix = original.substring(to: b.range.location)
        let suffix = original.substring(from: NSMaxRange(d.range.nsRange))
        let passive = NativeDocumentView(core: core)
        func findText(_ root: UIView) -> UITextView? {
            if let candidate = root as? UITextView { return candidate }
            return root.subviews.lazy.compactMap { findText($0) }.first
        }
        let passiveText = try XCTUnwrap(findText(passive))
        func status(_ root: UIView) -> String? {
            if let label = root as? UILabel, label.accessibilityIdentifier == "document-status" { return label.text }
            return root.subviews.lazy.compactMap { status($0) }.first
        }
        passive.binding.load(); try await settle("recovery passive view")
        defer { _ = passive.binding.detach() }
        XCTAssertTrue(text.isFirstResponder)
        XCTAssertFalse(passiveText.isFirstResponder)
        let manager = try XCTUnwrap(text.undoManager)
        let start = try XCTUnwrap(text.position(from: text.beginningOfDocument, offset: b.range.location + 1))
        let end = try XCTUnwrap(text.position(from: start, offset: 3))
        let deletion = try XCTUnwrap(text.textRange(from: start, to: end))
        text.selectedTextRange = deletion
        text.replace(deletion, withText: "")
        try await settle("recovery quote partial deletion")
        let joined = try await read()
        XCTAssertEqual(Array(joined.projection.text.utf16), Array((prefix + "潮航\n终章" + suffix).utf16))
        let joinedD = try XCTUnwrap(joined.projection.blocks.first { $0.id == "d" })
        passiveText.selectedRange = NSRange(location: joinedD.range.location + 1, length: 1)
        try await eventually("recovery passive original suffix selection") { passive.binding.selectionIsAnchored }
        text.selectedRange = NSRange(location: b.range.location + 1, length: 0)
        if marked {
            text.setMarkedText("中文", selectedRange: NSRange(location: 2, length: 0))
            XCTAssertNotNil(text.markedTextRange)
            try await eventually("recovery composition fork") { !self.view.binding.store.hasPendingCommits }
            view.binding.store.applyRemote(blocked)
        } else {
            // Do not yield between remote receipt and UITextInput. Both local
            // jobs stay queued behind its ABI reply while their visible branch
            // and exact item identities already contain these characters.
            view.binding.store.applyRemote(blocked)
            text.insertText("续")
            text.insertText("后")
        }
        let visible = text.text ?? "", passiveVisible = passiveText.text ?? ""
        let selection = text.selectedRange, passiveSelection = passiveText.selectedRange
        let inputKey = view.binding.inputKey, compositionParent = view.binding.compositionParent
        func markedRange() -> NSRange? {
            text.markedTextRange.map { NSRange(location: text.offset(from: text.beginningOfDocument, to: $0.start),
                                               length: text.offset(from: $0.start, to: $0.end)) }
        }
        let compositionRange = markedRange()
        try await eventually("recovery initial durable block") { self.view.binding.hasRemoteBlock }
        let blockedID = try XCTUnwrap(view.binding.state?.remoteBlock).updateId
        XCTAssertGreaterThan(blockedID, 0)
        func retained(_ context: String) async throws {
            let saved = try await read()
            XCTAssertFalse(saved.saved, context)
            XCTAssertNil(saved.saveError, context)
            XCTAssertEqual(saved.remoteBlock?.updateId, blockedID, context)
            XCTAssertEqual(saved.projection.revision, joined.projection.revision, context)
            XCTAssertEqual(Array(saved.projection.text.utf16), Array(joined.projection.text.utf16), context)
            XCTAssertEqual(Array(text.text.utf16), Array(visible.utf16), context)
            XCTAssertEqual(Array(passiveText.text.utf16), Array(passiveVisible.utf16), context)
            XCTAssertEqual(text.selectedRange, selection, context)
            XCTAssertEqual(passiveText.selectedRange, passiveSelection, context)
            XCTAssertEqual(view.binding.inputKey, inputKey, context)
            XCTAssertEqual(passive.binding.state?.remoteBlock?.updateId, blockedID, context)
            XCTAssertTrue(view.binding.hasPendingWork && passive.binding.hasPendingWork, context)
            XCTAssertFalse(view.binding.canEdit || passive.binding.canEdit, context)
            XCTAssertFalse(manager.canUndo || manager.canRedo, context)
            XCTAssertEqual(status(view), status(passive), context)
            XCTAssertTrue(status(view)?.contains("远端更新已保存，但尚未应用") == true, context)
            if marked {
                XCTAssertEqual(markedRange(), compositionRange, context)
                XCTAssertNotNil(text.markedTextRange, context)
                XCTAssertTrue(view.binding.hasUnsubmittedDraft, context)
                XCTAssertEqual(view.binding.compositionParent, compositionParent, context)
            }
        }
        try await retained("initial block")
        view.binding.store.applyRemote(blocked)
        _ = try await read() // Serial ABI barrier for the duplicate receipt.
        try await retained("duplicate block")
        view.binding.store.applyRemote(dependency)
        view.binding.store.applyRemote(full)
        try await eventually("durable dependency releases queue") {
            !self.view.binding.hasRemoteBlock && !self.view.binding.store.hasPendingCommits
        }
        let remoteText = prefix + "保潮航\n远🙂终章" + suffix
        if marked {
            let recovered = try await read()
            XCTAssertTrue(recovered.saved)
            XCTAssertNil(recovered.remoteBlock)
            XCTAssertEqual(Array(recovered.projection.text.utf16), Array(remoteText.utf16))
            XCTAssertEqual(Array(passiveText.text.utf16), Array(remoteText.utf16))
            XCTAssertEqual(Array(text.text.utf16), Array(visible.utf16), "Recovery replaced the active marked branch")
            XCTAssertEqual(text.selectedRange, selection)
            XCTAssertEqual(markedRange(), compositionRange)
            XCTAssertNotNil(text.markedTextRange)
            XCTAssertTrue(view.binding.hasUnsubmittedDraft)
            XCTAssertEqual(view.binding.inputKey, inputKey)
            XCTAssertEqual(view.binding.compositionParent, compositionParent)
            XCTAssertTrue(view.binding.canEdit && passive.binding.canEdit)
            XCTAssertTrue(status(view)?.contains("已恢复应用") == true)
            XCTAssertTrue(status(view)?.contains("尚未提交") == true)
            XCTAssertFalse(status(view)?.contains("尚未应用") == true)
            text.insertText("中文")
            try await settle("recovered native marked commit")
        }
        let local = marked ? "中文" : "续后"
        let expected = prefix + "保潮" + local + "航\n远🙂终章" + suffix
        func converged(_ expected: String, _ context: String) async throws {
            try await settle(context)
            try await eventually("\(context) original suffix selection") { passive.binding.selectionIsAnchored }
            let saved = try await read()
            XCTAssertTrue(saved.saved, context)
            XCTAssertNil(saved.remoteBlock, context)
            XCTAssertNil(saved.saveError, context)
            XCTAssertTrue(view.binding.canEdit && passive.binding.canEdit, context)
            XCTAssertEqual(Array(saved.projection.text.utf16), Array(expected.utf16), context)
            for actual in [text!, passiveText] {
                XCTAssertEqual(Array(actual.text.utf16), Array(expected.utf16), "Two views: \(context)")
                XCTAssertEqual(actual.textStorage.length, expected.utf16.count, context)
            }
            let currentD = try XCTUnwrap(saved.projection.blocks.first { $0.id == "d" })
            let originalSuffix = NSRange(location: currentD.range.location + 4, length: 1)
            XCTAssertEqual(passiveText.selectedRange, originalSuffix, context)
            XCTAssertEqual(saved.projection.selections.first { $0.viewId == passive.binding.viewID }?.range?.nsRange,
                           originalSuffix, "Original suffix CRDT selection: \(context)")
            for comment in initial.comments {
                let current = try XCTUnwrap(saved.projection.comments.first { $0.id == comment.id })
                XCTAssertEqual(current.quote, comment.quote, context)
                XCTAssertEqual(current.status, comment.status, context)
            }
        }
        try await converged(expected, "recovered draft")
        XCTAssertEqual(text.selectedRange, NSRange(location: b.range.location + 2 + local.utf16.count, length: 0))
        text.insertText("再🙂")
        let continued = prefix + "保潮" + local + "再🙂航\n远🙂终章" + suffix
        try await converged(continued, "continued UITextInput after recovery")
        manager.undo(); try await converged(expected, "undo continued input")
        manager.undo()
        try await converged(marked ? remoteText : prefix + "保潮续航\n远🙂终章" + suffix, "undo retained draft")
        if !marked {
            manager.undo(); try await converged(remoteText, "undo first queued input")
            manager.redo(); try await settle("redo first queued input")
        }
        manager.redo(); try await converged(expected, "redo retained draft")
        manager.redo(); try await converged(continued, "redo continued input")
        let beforeDuplicate = try await exported(core)
        view.binding.store.applyRemote(blocked)
        view.binding.store.applyRemote(dependency)
        view.binding.store.applyRemote(full)
        try await converged(continued, "duplicate dependency closure")
        let afterDuplicate = try await exported(core)
        XCTAssertEqual(afterDuplicate.update, beforeDuplicate.update, "Duplicate closure changed saved CRDT bytes")
        let _: LabState = try await result { core.reopen(completion: $0) }
        view.binding.load()
        try await converged(continued, "recovered SQLite reopen")
        XCTAssertNil(text.markedTextRange)
    }

    func testRepeatedCharacterDeletionKeepsOriginalItemIdentity() async throws {
        try await prepare()
        text.insertText("AAAA"); try await settle()
        let before = try await read().projection
        let _: NativeSelectionCapture = try await result { core.selection(viewID: "original-first-A", epoch: 1,
            revision: before.revision, range: NSRange(location: 0, length: 1), completion: $0) }
        text.selectedRange = NSRange(location: 0, length: 1)
        text.deleteBackward(); try await settle()
        let after = try await read().projection
        XCTAssertEqual(after.text, String(before.text.dropFirst()))
        let anchor = try XCTUnwrap(after.selections.first { $0.viewId == "original-first-A" }?.range)
        XCTAssertEqual(anchor.nsRange, NSRange(location: 0, length: 0), "Text diff deleted the wrong repeated character")
        try await history(); XCTAssertEqual(text.text, before.text)
        try await history(redo: true); XCTAssertEqual(text.text, after.text)
        let beforeInsert = try await read().projection
        let _: NativeSelectionCapture = try await result { core.selection(viewID: "original-first-A", epoch: 2,
            revision: beforeInsert.revision, range: NSRange(location: 0, length: 1), completion: $0) }
        text.selectedRange = NSRange(location: 0, length: 0)
        text.insertText("A"); try await settle()
        let inserted = try await read().projection
        XCTAssertEqual(inserted.selections.first { $0.viewId == "original-first-A" }?.range?.location, 1,
            "Repeated insertion targeted the wrong item boundary")
        let end = try XCTUnwrap(text.position(from: text.beginningOfDocument, offset: 1))
        let range = try XCTUnwrap(text.textRange(from: text.beginningOfDocument, to: end))
        text.replace(range, withText: ""); try await settle()
        let replaced = try await read().projection
        XCTAssertEqual(replaced.selections.first { $0.viewId == "original-first-A" }?.range?.location, 0,
            "UITextInput replacement deleted the wrong repeated item")
        text.selectedRange = NSRange(location: 0, length: 1)
        text.setMarkedText("A", selectedRange: NSRange(location: 1, length: 0))
        XCTAssertTrue(view.binding.hasUnsubmittedDraft)
        text.insertText(""); try await settle()
        let committed = try await read().projection
        XCTAssertEqual(committed.selections.first { $0.viewId == "original-first-A" }?.range?.nsRange,
            NSRange(location: 0, length: 0), "Unchanged initial marked text lost its replacement identity")
        core.dropSelection(viewID: "original-first-A")
    }

    func testNativeUnicodeBackspaceUsesUIKitDeletionBoundaries() async throws {
        try await prepare()
        let original = try await read().projection.text
        text.insertText("👩🏽‍🚀e\u{301}𠮷"); try await settle()
        var steps = 0
        while text.selectedRange.location > 0 && steps < 20 {
            text.deleteBackward()
            let visible = text.text
            try await settle()
            let saved = try await read().projection.text
            XCTAssertEqual(saved, visible, "Core disagreed with UIKit's Unicode deletion boundary")
            steps += 1
        }
        XCTAssertEqual(text.text, original)
        XCTAssertGreaterThan(steps, 0)
        let settled = try await read().projection.revision
        text.deleteBackward(); try await settle()
        let unchanged = try await read().projection.revision
        XCTAssertEqual(unchanged, settled, "Backspace at document start changed prose")
    }

    func testResigningFirstResponderCommitsOnceAndPreservesSelection() async throws {
        try await prepare()
        let original = try await read().projection.text
        text.setMarkedText("灯塔", selectedRange: NSRange(location: 2, length: 0))
        XCTAssertTrue(text.resignFirstResponder())
        try await settle()
        XCTAssertNil(text.markedTextRange)
        XCTAssertEqual(text.text, "灯塔" + original)
        XCTAssertEqual(text.selectedRange, NSRange(location: 2, length: 0))
        try await history(); XCTAssertEqual(text.text, original)
        let state = try await read()
        XCTAssertFalse(state.projection.canUndo, "Responder change split one composition into multiple undo units")
    }

    func testHardwareCommandsAndNativeHistoryAdapterUseSharedOwner() async throws {
        try await prepare()
        let original = try await read().projection.text
        let manager = try XCTUnwrap(text.undoManager)
        let undo = try XCTUnwrap(text.keyCommands?.first { $0.input == "z" && $0.modifierFlags == .command })
        let redo = try XCTUnwrap(text.keyCommands?.first { $0.input == "z" && $0.modifierFlags == [.command, .shift] })
        let undoAction = try XCTUnwrap(undo.action), redoAction = try XCTUnwrap(redo.action)
        XCTAssertTrue(undo.wantsPriorityOverSystemBehavior && redo.wantsPriorityOverSystemBehavior)
        XCTAssertFalse(manager.canUndo)
        XCTAssertFalse(text.canPerformAction(undoAction, withSender: undo))
        text.insertText("历史")
        XCTAssertFalse(manager.canUndo, "Pending input enabled native undo")
        try await settle()
        XCTAssertTrue(manager.canUndo)
        XCTAssertTrue(text.canPerformAction(undoAction, withSender: undo))
        XCTAssertTrue(UIApplication.shared.sendAction(undoAction, to: nil, from: undo, for: nil))
        // UIApplication dispatch does not guarantee that it checked availability;
        // the action itself must guard duplicate commands before the async reply.
        _ = UIApplication.shared.sendAction(undoAction, to: text, from: undo, for: nil)
        try await settle()
        XCTAssertEqual(text.text, original)
        XCTAssertFalse(manager.canUndo); XCTAssertTrue(manager.canRedo)
        XCTAssertTrue(UIApplication.shared.sendAction(redoAction, to: nil, from: redo, for: nil))
        try await settle()
        XCTAssertEqual(text.text, "历史" + original)
        // Exercise the same UndoManager entry point used by system editing UI.
        manager.undo(); try await settle()
        XCTAssertEqual(text.text, original)
        manager.redo(); try await settle()
        XCTAssertEqual(text.text, "历史" + original)
        manager.removeAllActions()
        manager.enableUndoRegistration()
        XCTAssertFalse(manager.isUndoRegistrationEnabled)
        XCTAssertTrue(manager.canUndo, "UIKit reset discarded the CRDT history")
        var localUndoRan = false
        manager.registerUndo(withTarget: text) { _ in localUndoRan = true }
        manager.undo(); try await settle()
        XCTAssertEqual(text.text, original)
        XCTAssertFalse(localUndoRan, "UIKit registered a second independent history stack")
        XCTAssertFalse(manager.canUndo)
    }

    func testNativeHistoryActionsWaitForComposition() async throws {
        try await prepare()
        let original = try await read().projection.text
        text.insertText("前"); try await settle()
        let revision = try await read().projection.revision
        text.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0))
        let marked = text.text
        let manager = try XCTUnwrap(text.undoManager)
        let undo = try XCTUnwrap(text.keyCommands?.first { $0.input == "z" && $0.modifierFlags == .command })
        let undoAction = try XCTUnwrap(undo.action)
        XCTAssertFalse(manager.canUndo)
        XCTAssertFalse(text.canPerformAction(undoAction, withSender: undo))
        _ = UIApplication.shared.sendAction(undoAction, to: text, from: undo, for: nil)
        manager.undo()
        let after = try await read()
        XCTAssertEqual(after.projection.revision, revision)
        XCTAssertEqual(text.text, marked)
        XCTAssertNotNil(text.markedTextRange)
        text.insertText("中"); try await settle()
        XCTAssertTrue(manager.canUndo)
        manager.undo(); try await settle()
        XCTAssertEqual(text.text, "前" + original)
        manager.undo(); try await settle()
        XCTAssertEqual(text.text, original)
    }
}
