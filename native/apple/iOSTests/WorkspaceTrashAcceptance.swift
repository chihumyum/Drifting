import XCTest
import UIKit
@testable import DriftingNativeIOS

/// Hosted UITextView lifecycle coverage; this does not simulate a provider or
/// claim physical keyboard/IME input.
@MainActor
final class WorkspaceTrashAcceptance: XCTestCase {
    private var directory: URL!
    private var workspace: LabWorkspaceCore!
    private var window: UIWindow!
    private weak var previousWindow: UIWindow?

    private func result<T>(_ operation: (@escaping (Result<T, Error>) -> Void) -> Void) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in operation { continuation.resume(with: $0) } }
    }

    private func eventually(_ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(15)
        while !condition() && Date() < deadline { try await Task.sleep(nanoseconds: 5_000_000) }
        guard condition() else { throw LabError.message("UIKit trash fixture did not settle") }
    }

    private func settle(_ editor: NativeDocumentView) async throws {
        try await eventually { editor.binding.state != nil && !editor.binding.hasPendingWork }
    }

    private func textView(in view: UIView) throws -> UITextView {
        func find(_ view: UIView) -> UITextView? {
            if let text = view as? UITextView { return text }
            return view.subviews.lazy.compactMap { find($0) }.first
        }
        return try XCTUnwrap(find(view))
    }

    override func tearDown() {
        window?.endEditing(true)
        window?.isHidden = true
        window?.rootViewController = nil
        previousWindow?.makeKey()
        window = nil; workspace = nil
        if let directory { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        super.tearDown()
    }

    func testTrashRestoreRetainsOtherChapterAndRejectsUnsubmittedInput() async throws {
        continueAfterFailure = false
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("apple-native-lab")
        workspace = LabWorkspaceCore(directory: directory)
        let _: [WorkspaceProject] = try await result { workspace.projects(completion: $0) }
        let project: WorkspaceProject = try await result { workspace.createProject(name: "UIKit 回收站合成项目", completion: $0) }
        let a: WorkspaceChapter = try await result { workspace.createChapter(projectID: project.id, title: "初航", completion: $0) }
        let b: WorkspaceChapter = try await result { workspace.createChapter(projectID: project.id, title: "归航", completion: $0) }
        let firstCore: LabCore = try await result { workspace.openChapter(projectID: project.id, chapterID: a.id, completion: $0) }
        let first = NativeDocumentView(core: firstCore)
        let firstText = try textView(in: first)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        previousWindow = scene.windows.first { $0.isKeyWindow }
        window = UIWindow(windowScene: scene)
        window.rootViewController = UIViewController()
        window.rootViewController?.view = first
        window.makeKeyAndVisible()
        first.binding.load(); try await settle(first)
        XCTAssertTrue(firstText.becomeFirstResponder())
        firstText.insertText("海🙂")
        XCTAssertTrue(first.binding.hasPendingWork)
        var refused = false
        do {
            let _: WorkspaceChapterTrashReply = try await result { workspace.trashChapter(projectID: project.id, chapterID: a.id, completion: $0) }
        } catch { refused = true }
        XCTAssertTrue(refused, "Trash accepted input still queued by UITextView")
        try await settle(first)
        firstText.selectedRange = NSRange(location: 0, length: 0)
        firstText.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0))
        XCTAssertNotNil(firstText.markedTextRange)
        let marked = firstText.text
        refused = false
        do {
            let _: WorkspaceChapterTrashReply = try await result { workspace.trashChapter(projectID: project.id, chapterID: a.id, completion: $0) }
        } catch { refused = true }
        XCTAssertTrue(refused)
        XCTAssertEqual(firstText.text, marked)
        XCTAssertNotNil(firstText.markedTextRange)
        firstText.insertText("中文"); try await settle(first)
        firstText.resignFirstResponder()

        let otherCore: LabCore = try await result { workspace.openChapter(projectID: project.id, chapterID: b.id, completion: $0) }
        let other = NativeDocumentView(core: otherCore)
        let otherText = try textView(in: other)
        window.rootViewController?.view = other
        other.binding.load(); try await settle(other)
        XCTAssertTrue(otherText.becomeFirstResponder())
        otherText.insertText("岸🙂"); try await settle(other)
        otherText.selectedRange = NSRange(location: 1, length: 2)
        try await eventually { other.binding.selectionIsAnchored }
        let reply: WorkspaceChapterTrashReply = try await result { workspace.trashChapter(projectID: project.id, chapterID: a.id, completion: $0) }
        XCTAssertEqual(reply.chapters.map(\.id), [b.id])
        XCTAssertEqual(reply.trashedChapters.map(\.id), [a.id])
        XCTAssertTrue(firstCore.isClosed)
        XCTAssertTrue(first.binding.detach())
        XCTAssertFalse(otherCore.isClosed)
        XCTAssertEqual(otherText.text, "岸🙂")
        XCTAssertEqual(otherText.selectedRange, NSRange(location: 1, length: 2))
        other.binding.history(redo: false); try await settle(other)
        XCTAssertEqual(otherText.text, "")
        other.binding.history(redo: true); try await settle(other)
        XCTAssertEqual(otherText.text, "岸🙂")

        let restored: WorkspaceChapterTrashReply = try await result { workspace.restoreChapter(projectID: project.id, chapterID: a.id, completion: $0) }
        XCTAssertTrue(restored.trashedChapters.isEmpty)
        XCTAssertEqual(Set(restored.chapters.map(\.id)), Set([a.id, b.id]))
        let freshCore: LabCore = try await result { workspace.openChapter(projectID: project.id, chapterID: a.id, completion: $0) }
        XCTAssertFalse(freshCore === firstCore)
        let fresh = NativeDocumentView(core: freshCore)
        let freshText = try textView(in: fresh)
        otherText.resignFirstResponder()
        window.rootViewController?.view = fresh
        fresh.binding.load(); try await settle(fresh)
        XCTAssertEqual(freshText.text, "中文海🙂")
        XCTAssertEqual(fresh.binding.state?.projection.canUndo, false)
        XCTAssertTrue(freshText.becomeFirstResponder())
        freshText.selectedRange = NSRange(location: (freshText.text as NSString).length, length: 0)
        freshText.insertText("归"); try await settle(fresh)
        freshText.resignFirstResponder()
        XCTAssertTrue(other.binding.detach()); XCTAssertTrue(fresh.binding.detach())
        try await eventually { !self.workspace.hasPendingDocuments }
        let closed: Bool = try await result { workspace.close(completion: $0) }
        XCTAssertTrue(closed)
        let cold = LabWorkspaceCore(directory: directory)
        let _: [WorkspaceProject] = try await result { cold.projects(completion: $0) }
        let coldCore: LabCore = try await result { cold.openChapter(projectID: project.id, chapterID: a.id, completion: $0) }
        let saved: LabDocumentState = try await result { coldCore.document(completion: $0) }
        XCTAssertEqual(saved.projection.text, "中文海🙂归")
        let coldClosed: Bool = try await result { cold.close(completion: $0) }
        XCTAssertTrue(coldClosed)
    }
}
