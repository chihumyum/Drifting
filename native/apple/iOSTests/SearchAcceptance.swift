import XCTest
import UIKit
@testable import DriftingNativeIOS

/// Real workspace ABI and UITextInput routing. Marked text below is a
/// programmatic UIKit guard check, not a physical keyboard/IME claim.
@MainActor
final class SearchAcceptance: XCTestCase {
    private var directory: URL!
    private var workspace: LabWorkspaceCore!
    private var project: WorkspaceProject!
    private var core: LabCore!
    private var editor: NativeDocumentView!
    private var text: UITextView!
    private var window: UIWindow!
    private weak var previousWindow: UIWindow?

    private func result<T>(_ operation: (@escaping (Result<T, Error>) -> Void) -> Void) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in operation { continuation.resume(with: $0) } }
    }
    private func eventually(_ context: String, _ ready: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(15)
        while !ready() && Date() < deadline { try await Task.sleep(nanoseconds: 5_000_000) }
        guard ready() else { throw LabError.message("Search acceptance did not settle: " + context) }
    }
    private func settle() async throws {
        try await eventually("editor") { self.editor.binding.state != nil && !self.editor.binding.hasPendingWork }
    }
    private func read() async throws -> LabDocumentState { try await result { core.document(completion: $0) } }
    private func exported() async throws -> NativeCheckpoint { try await result { core.exportDocument(completion: $0) } }
    private func resolve(_ hit: WorkspaceSearchHit) async throws -> WorkspaceSearchLocation {
        try await result { workspace.resolveSearchHit(hit, completion: $0) }
    }
    private func search(_ query: String) async throws -> WorkspaceSearchResult {
        try await result { workspace.search(projectID: project.id, query: query, completion: $0) }
    }
    private func prepare() async throws {
        continueAfterFailure = false
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        workspace = LabWorkspaceCore(directory: directory.appendingPathComponent("apple-native-lab"))
        let projects: [WorkspaceProject] = try await result { workspace.projects(completion: $0) }
        XCTAssertTrue(projects.isEmpty)
        project = try await result { workspace.createProject(name: "合成搜索项目", completion: $0) }
        let chapter: WorkspaceChapter = try await result {
            workspace.createChapter(projectID: project.id, title: "灯🙂章", completion: $0)
        }
        core = try await result { workspace.openChapter(projectID: project.id, chapterID: chapter.id, completion: $0) }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        previousWindow = scene.windows.first { $0.isKeyWindow }
        window = UIWindow(windowScene: scene)
        editor = NativeDocumentView(core: core)
        let controller = UIViewController()
        controller.view = editor
        window.rootViewController = controller
        window.makeKeyAndVisible()
        func findText(_ view: UIView) -> UITextView? {
            if let text = view as? UITextView { return text }
            return view.subviews.lazy.compactMap { findText($0) }.first
        }
        text = try XCTUnwrap(findText(editor))
        editor.binding.load(); try await settle()
        window.layoutIfNeeded()
        XCTAssertTrue(text.becomeFirstResponder())
        text.selectedRange = NSRange(location: 0, length: 0)
    }
    private func closeWorkspace() async throws {
        XCTAssertTrue(editor.binding.detach())
        try await eventually("detached input queue") { !self.workspace.hasPendingDocuments }
        let closed: Bool = try await result { workspace.close(completion: $0) }
        XCTAssertTrue(closed)
    }
    override func tearDown() {
        text?.resignFirstResponder()
        window?.isHidden = true
        window?.rootViewController = nil
        previousWindow?.makeKey()
        text = nil; editor = nil; window = nil; core = nil; workspace = nil
        if let directory { try? FileManager.default.removeItem(at: directory) }
        super.tearDown()
    }

    func testSearchResolvesExactUTF16OccurrenceAfterPrefixInputWithoutAddingHistory() async throws {
        try await prepare()
        let original = "前👩🏽‍🚀 灯🙂 后 灯🙂"
        text.insertText(original); try await settle()
        let before = try await read().projection
        let beforeBytes = try await exported().update
        let matches = try await search("灯🙂")
        XCTAssertTrue(matches.unavailable.isEmpty)
        XCTAssertFalse(matches.truncated)
        let title = try XCTUnwrap(matches.hits.first { $0.kind == "title" })
        let titleLocation = try await resolve(title)
        XCTAssertNil(titleLocation.range)
        let prose = matches.hits.filter { $0.kind == "prose" }
        XCTAssertEqual(prose.count, 2)
        let hit = prose[1]
        let resolved = try await resolve(hit)
        let range = try XCTUnwrap(resolved.range)
        let expected = (original as NSString).range(of: "灯🙂", options: .backwards)
        XCTAssertEqual(range.nsRange, expected)
        XCTAssertEqual(range.length, 3)
        XCTAssertTrue(editor.reveal(range: range, revision: resolved.revision))
        try await eventually("search selection") { self.editor.binding.selectionIsAnchored }
        XCTAssertEqual(text.selectedRange, expected)
        let unchanged = try await read().projection
        let unchangedBytes = try await exported().update
        XCTAssertEqual(unchanged.revision, before.revision)
        XCTAssertEqual(unchanged.canUndo, before.canUndo)
        XCTAssertEqual(unchangedBytes, beforeBytes)

        text.selectedRange = NSRange(location: 0, length: 0)
        text.insertText("新增🙂"); try await settle()
        let shifted = try await resolve(hit)
        let shiftedRange = try XCTUnwrap(shifted.range)
        XCTAssertEqual(shiftedRange.nsRange, NSRange(location: expected.location + 4, length: 3))
        let caret = text.selectedRange
        XCTAssertFalse(editor.reveal(range: range, revision: resolved.revision))
        XCTAssertEqual(text.selectedRange, caret, "An old resolved revision moved the current selection")
        XCTAssertTrue(editor.reveal(range: shiftedRange, revision: shifted.revision))
        XCTAssertEqual((text.text as NSString).substring(with: text.selectedRange), "灯🙂")
        text.insertText("替换"); try await settle()
        XCTAssertEqual(text.text, "新增🙂前👩🏽‍🚀 灯🙂 后 替换")
        editor.binding.history(redo: false); try await settle()
        XCTAssertEqual(text.text, "新增🙂" + original)
        editor.binding.history(redo: false); try await settle()
        XCTAssertEqual(text.text, original, "Search added a history unit between edits")
        try await closeWorkspace()
    }

    func testStaleSearchAndMarkedRevealKeepSelectionTextAndHistoryUnchanged() async throws {
        try await prepare()
        text.insertText("海灯🙂岸"); try await settle()
        let matches = try await search("灯🙂")
        let hit = try XCTUnwrap(matches.hits.first { $0.kind == "prose" })
        let originalLocation = try await resolve(hit)
        let originalRange = try XCTUnwrap(originalLocation.range)
        XCTAssertTrue(editor.reveal(range: originalRange, revision: originalLocation.revision))
        text.insertText("灯⭐"); try await settle()
        text.selectedRange = NSRange(location: 0, length: 0)
        try await eventually("stale selection baseline") { self.editor.binding.selectionIsAnchored }
        let baseline = try await read().projection
        let bytes = try await exported().update
        let selected = text.selectedRange
        do {
            _ = try await resolve(hit)
            XCTFail("Deleted search anchors were accepted as the old occurrence")
        } catch {
            XCTAssertFalse(error.localizedDescription.isEmpty)
        }
        XCTAssertFalse(editor.reveal(range: originalRange, revision: originalLocation.revision))
        XCTAssertEqual(text.selectedRange, selected)
        let after = try await read().projection
        let afterBytes = try await exported().update
        XCTAssertEqual(after.text, baseline.text)
        XCTAssertEqual(after.revision, baseline.revision)
        XCTAssertEqual(after.canUndo, baseline.canUndo)
        XCTAssertEqual(after.canRedo, baseline.canRedo)
        XCTAssertEqual(afterBytes, bytes)

        text.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0))
        XCTAssertNotNil(text.markedTextRange)
        let marked = text.text, markedSelection = text.selectedRange
        XCTAssertFalse(editor.reveal(range: NativeRange(location: 1, length: 1), revision: baseline.revision))
        XCTAssertEqual(text.text, marked)
        XCTAssertEqual(text.selectedRange, markedSelection)
        XCTAssertNotNil(text.markedTextRange)
        let markedBytes = try await exported().update
        XCTAssertEqual(markedBytes, bytes)
        text.setMarkedText("", selectedRange: NSRange(location: 0, length: 0))
        text.unmarkText(); try await settle()
        editor.binding.history(redo: false); try await settle()
        XCTAssertEqual(text.text, "海灯🙂岸", "Rejected search or canceled composition authored history")
        try await closeWorkspace()
    }
}
