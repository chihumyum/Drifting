import XCTest
import UIKit
@testable import DriftingNativeIOS

@MainActor
final class ActBoundaryAcceptance: XCTestCase {
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
        guard condition() else { throw LabError.message("Act boundary fixture did not settle") }
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

    func testActBoundariesPreserveEditorAndOutlineThroughCreateRenameRemove() async throws {
        continueAfterFailure = false
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("apple-native-lab")
        workspace = LabWorkspaceCore(directory: directory)
        let _: [WorkspaceProject] = try await result { workspace.projects(completion: $0) }
        let project: WorkspaceProject = try await result { workspace.createProject(name: "UIKit 幕分界合成项目", completion: $0) }
        var chapters: [WorkspaceChapter] = []
        for title in ["启程", "航行", "归岸"] {
            chapters.append(try await result { workspace.createChapter(projectID: project.id, title: title, completion: $0) })
        }
        let core: LabCore = try await result { workspace.openChapter(projectID: project.id, chapterID: chapters[1].id, completion: $0) }
        let editor = NativeDocumentView(core: core)
        func findText(_ view: UIView) -> UITextView? {
            if let text = view as? UITextView { return text }
            return view.subviews.lazy.compactMap { findText($0) }.first
        }
        let text = try XCTUnwrap(findText(editor))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        previousWindow = scene.windows.first { $0.isKeyWindow }
        window = UIWindow(windowScene: scene)
        window.rootViewController = UIViewController()
        window.rootViewController?.view = editor
        window.makeKeyAndVisible()
        editor.binding.load()
        try await eventually { editor.binding.state != nil && !editor.binding.hasPendingWork }
        XCTAssertTrue(text.becomeFirstResponder())
        text.insertText("航🙂")
        try await eventually { !editor.binding.hasPendingWork }
        editor.binding.format(.heading1, range: NSRange(location: 0, length: 0))
        try await eventually { !editor.binding.hasPendingWork }
        text.selectedRange = NSRange(location: 1, length: 2)
        try await eventually { editor.binding.selectionIsAnchored }
        let before: NativeCheckpoint = try await result { core.exportDocument(completion: $0) }
        let model = WorkspaceOutlineModel(workspace: workspace, projectID: project.id)
        let controller = BookOutlineViewController(model: model)
        controller.canNavigate = { !editor.binding.hasPendingWork }
        controller.loadViewIfNeeded()
        model.load(); try await eventually { model.entries.count == 3 }
        XCTAssertTrue(model.entries.allSatisfy { $0.kind == "chapter" && $0.actId == nil })
        model.updateActive(chapterID: chapters[1].id, outline: editor.binding.state!.projection.outline)
        model.toggle(chapters[1].id)
        let headings = model.rows.compactMap { $0.heading?.blockId }
        let act: WorkspaceAct = try await result { model.createAct(beforeChapterID: chapters[1].id, completion: $0) }
        XCTAssertFalse(act.name.isEmpty)
        XCTAssertEqual(model.entries.filter { $0.kind == "act" }.map(\.id), [act.id])
        XCTAssertNil(model.entries.first { $0.id == chapters[0].id }?.actId)
        XCTAssertEqual(model.entries.first { $0.id == chapters[1].id }?.actId, act.id)
        XCTAssertEqual(model.entries.first { $0.id == chapters[2].id }?.actId, act.id)
        let renamed: WorkspaceAct = try await result { model.renameAct(id: act.id, name: "中幕🙂", completion: $0) }
        XCTAssertEqual(renamed.id, act.id)
        XCTAssertEqual(model.entries.first { $0.id == act.id }?.title, "中幕🙂")
        XCTAssertTrue(model.expanded.contains(chapters[1].id))
        XCTAssertEqual(model.rows.compactMap { $0.heading?.blockId }, headings)
        let retained: LabCore = try await result { workspace.openChapter(projectID: project.id, chapterID: chapters[1].id, completion: $0) }
        XCTAssertTrue(retained === core)
        XCTAssertEqual(text.selectedRange, NSRange(location: 1, length: 2))
        let removed: WorkspaceAct = try await result { model.removeAct(id: act.id, completion: $0) }
        XCTAssertEqual(removed.id, act.id)
        XCTAssertEqual(model.entries.map(\.id), chapters.map(\.id))
        XCTAssertTrue(model.entries.allSatisfy { $0.actId == nil })
        XCTAssertTrue(model.expanded.contains(chapters[1].id))
        XCTAssertEqual(model.rows.compactMap { $0.heading?.blockId }, headings)
        let after: NativeCheckpoint = try await result { core.exportDocument(completion: $0) }
        XCTAssertEqual(before.update, after.update)
        XCTAssertEqual(text.text, "航🙂")
        XCTAssertEqual(text.selectedRange, NSRange(location: 1, length: 2))
        editor.binding.history(redo: false); try await eventually { !editor.binding.hasPendingWork }
        XCTAssertEqual(editor.binding.state?.projection.blocks.first?.kind, "paragraph", "Boundary edits must not add a prose undo unit")
        editor.binding.history(redo: true); try await eventually { !editor.binding.hasPendingWork }
        XCTAssertEqual(editor.binding.state?.projection.blocks.first?.kind, "heading")
        text.resignFirstResponder()
        XCTAssertTrue(editor.binding.detach())
        try await eventually { !self.workspace.hasPendingDocuments }
        let closed: Bool = try await result { workspace.close(completion: $0) }
        XCTAssertTrue(closed)
        let cold = LabWorkspaceCore(directory: directory)
        let _: [WorkspaceProject] = try await result { cold.projects(completion: $0) }
        let coldOutline: [WorkspaceOutlineEntry] = try await result { cold.outline(projectID: project.id, completion: $0) }
        XCTAssertEqual(coldOutline.map(\.id), chapters.map(\.id))
        let coldCore: LabCore = try await result { cold.openChapter(projectID: project.id, chapterID: chapters[1].id, completion: $0) }
        let saved: LabDocumentState = try await result { coldCore.document(completion: $0) }
        XCTAssertEqual(saved.projection.text, "航🙂")
        XCTAssertEqual(saved.projection.blocks.first?.kind, "heading")
        let coldClosed: Bool = try await result { cold.close(completion: $0) }
        XCTAssertTrue(coldClosed)
    }
}
