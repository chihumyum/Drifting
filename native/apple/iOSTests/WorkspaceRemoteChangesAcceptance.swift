import XCTest
import UIKit
@testable import DriftingNativeIOS

/// Real local journals cross two synthetic SQLite replicas through the shared
/// receive API. This is hosted UIKit input, not provider or physical IME testing.
@MainActor
final class WorkspaceRemoteChangesAcceptance: XCTestCase {
    private typealias Fixture = WorkspaceRemoteProseFixture
    private var directory: URL!
    private var sourceDirectory: URL!
    private var receiverDirectory: URL!
    private var source: LabWorkspaceCore!
    private var workspace: LabWorkspaceCore!
    private var project: WorkspaceProject!
    private var chapters: [WorkspaceChapter] = []
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
        guard ready() else { throw LabError.message("Remote metadata did not settle: " + context) }
    }

    private func settle() async throws {
        try await eventually("editor") { self.editor.binding.state != nil && !self.editor.binding.hasPendingWork }
    }

    private func prepare() async throws {
        continueAfterFailure = false
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        sourceDirectory = directory.appendingPathComponent("source/apple-native-lab")
        receiverDirectory = directory.appendingPathComponent("receiver/apple-native-lab")
        source = LabWorkspaceCore(directory: sourceDirectory)
        workspace = LabWorkspaceCore(directory: receiverDirectory)
        let _: [WorkspaceProject] = try await result { source.projects(completion: $0) }
        project = try await result { source.createProject(name: "UIKit 元数据合成项目", completion: $0) }
        for title in ["首章", "次章"] {
            let chapter: WorkspaceChapter = try await result {
                source.createChapter(projectID: project.id, title: title, completion: $0)
            }
            chapters.append(chapter)
        }
        let closed: Bool = try await result { source.close(completion: $0) }
        XCTAssertTrue(closed)
        try Fixture.copyClosedBaseline(from: sourceDirectory, to: [receiverDirectory])
        let _: [WorkspaceProject] = try await result { source.projects(completion: $0) }
        let _: [WorkspaceProject] = try await result { workspace.projects(completion: $0) }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        previousWindow = scene.windows.first { $0.isKeyWindow }
        window = UIWindow(windowScene: scene)
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible()
    }

    private func originals() throws -> [[String: Fixture.SQLValue]] {
        try Fixture.query(in: sourceDirectory, sql: """
            SELECT project_id, project_sync_id, sync_generation_id, change_set_id, payload_sha256, encoded_bytes
            FROM sync_change_set WHERE origin = 'local' AND apply_state = 'applied' ORDER BY rowid
            """)
    }

    private func author<T>(_ operation: (@escaping (Result<T, Error>) -> Void) -> Void) async throws -> (T, RemoteProseTestPacket) {
        let before = try originals().compactMap { row -> String? in
            if case .text(let id) = row["change_set_id"] { return id }; return nil
        }
        let value = try await result(operation)
        let rows = try originals().filter { row in
            if case .text(let id) = row["change_set_id"] { return !before.contains(id) }; return false
        }
        XCTAssertEqual(rows.count, 1, "One metadata command must author one actual canonical original")
        let row = try XCTUnwrap(rows.first)
        guard case .text(let projectID) = row["project_id"],
              case .text(let projectSyncID) = row["project_sync_id"],
              case .text(let generationID) = row["sync_generation_id"],
              case .text(let changeSetID) = row["change_set_id"],
              case .text(let envelopeHash) = row["payload_sha256"],
              case .blob(let envelope) = row["encoded_bytes"] else {
            throw LabError.message("Metadata original fixture is malformed")
        }
        return (value, RemoteProseTestPacket(original: RemoteChangeOriginal(projectId: projectID,
            projectSyncId: projectSyncID, syncGenerationId: generationID, changeSetId: changeSetID,
            originalEnvelopeSha256: envelopeHash), envelope: envelope))
    }

    private func receive(_ packet: RemoteProseTestPacket) async throws -> WorkspaceRemoteChangesReply {
        try await result { workspace.receiveChanges(original: packet.original, envelope: packet.envelope, completion: $0) }
    }

    private func mount(_ chapter: WorkspaceChapter) async throws {
        core = try await result { workspace.openChapter(projectID: project.id, chapterID: chapter.id, completion: $0) }
        editor = NativeDocumentView(core: core)
        window.rootViewController?.view = editor
        func findText(_ view: UIView) -> UITextView? {
            if let text = view as? UITextView { return text }
            return view.subviews.lazy.compactMap { findText($0) }.first
        }
        text = try XCTUnwrap(findText(editor))
        editor.binding.load(); try await settle()
        window.layoutIfNeeded()
        XCTAssertTrue(text.becomeFirstResponder())
    }

    private func closeReceiver() async throws {
        XCTAssertTrue(editor.binding.detach())
        try await eventually("detached owner") { !self.workspace.hasPendingDocuments }
        let closed: Bool = try await result { workspace.close(completion: $0) }
        XCTAssertTrue(closed)
    }

    private func finish() async throws {
        try await closeReceiver()
        let closed: Bool = try await result { source.close(completion: $0) }
        XCTAssertTrue(closed)
    }

    override func tearDown() {
        text?.resignFirstResponder()
        window?.isHidden = true
        window?.rootViewController = nil
        previousWindow?.makeKey()
        text = nil; editor = nil; core = nil; window = nil; workspace = nil; source = nil
        if let directory { try? FileManager.default.removeItem(at: directory) }
        super.tearDown()
    }

    func testRemoteChapterCreationRefreshesListsAndEditsThroughColdReopen() async throws {
        try await prepare()
        let (chapter, packet): (WorkspaceChapter, RemoteProseTestPacket) = try await author {
            source.createChapter(projectID: project.id, title: "远端新章🙂", completion: $0)
        }
        let reply = try await receive(packet)
        XCTAssertFalse(reply.alreadyApplied)
        XCTAssertEqual(reply.projectId, project.id)
        XCTAssertTrue(reply.projects.contains { $0.id == project.id })
        XCTAssertTrue(reply.chapters.contains { $0.id == chapter.id && $0.title == chapter.title })
        XCTAssertTrue(reply.affectedDocuments.contains("node-content:" + chapter.id))
        let listed: [WorkspaceChapter] = try await result { workspace.chapters(projectID: project.id, completion: $0) }
        XCTAssertEqual(listed.map(\.id), reply.chapters.map(\.id))
        try await mount(chapter)
        XCTAssertEqual(text.text, "")
        text.insertText("新章正文🙂"); try await settle()
        let saved: LabDocumentState = try await result { core.document(completion: $0) }
        XCTAssertTrue(saved.saved)
        XCTAssertEqual(saved.projection.text, "新章正文🙂")
        let previousCore = try XCTUnwrap(core)
        try await closeReceiver()
        let _: [WorkspaceProject] = try await result { workspace.projects(completion: $0) }
        try await mount(chapter)
        XCTAssertFalse(core === previousCore)
        XCTAssertTrue(previousCore.isClosed)
        XCTAssertEqual(text.text, "新章正文🙂")
        try await finish()
    }

    func testRemoteMetadataKeepsOwnerSelectionHistoryAndRejectsInvalidOriginal() async throws {
        try await prepare(); try await mount(chapters[0])
        text.insertText("正文🙂"); try await settle()
        text.selectedRange = NSRange(location: 2, length: 2)
        try await eventually("selection") { self.editor.binding.selectionIsAnchored }
        let before: NativeCheckpoint = try await result { core.exportDocument(completion: $0) }
        let (renamedProject, projectPacket): (WorkspaceProject, RemoteProseTestPacket) = try await author {
            source.renameProject(projectID: project.id, name: "远端项目名", completion: $0)
        }
        let projectReply = try await receive(projectPacket); try await settle()
        XCTAssertTrue(projectReply.projects.contains { $0.id == renamedProject.id && $0.name == renamedProject.name })
        let (chapter, chapterPacket): (WorkspaceChapter, RemoteProseTestPacket) = try await author {
            source.renameChapter(projectID: project.id, chapterID: chapters[0].id, title: "远端首章", completion: $0)
        }
        let chapterReply = try await receive(chapterPacket); try await settle()
        XCTAssertTrue(chapterReply.chapters.contains { $0.id == chapter.id && $0.title == chapter.title })
        let (_, movePacket): ([WorkspaceChapter], RemoteProseTestPacket) = try await author {
            source.moveChapter(projectID: project.id, chapterID: chapters[1].id, beforeChapterID: chapters[0].id, completion: $0)
        }
        let moved = try await receive(movePacket); try await settle()
        XCTAssertEqual(moved.chapters.map(\.id), [chapters[1].id, chapters[0].id])
        let retained: LabCore = try await result { workspace.openChapter(projectID: project.id, chapterID: chapter.id, completion: $0) }
        let after: NativeCheckpoint = try await result { core.exportDocument(completion: $0) }
        XCTAssertTrue(retained === core)
        XCTAssertEqual(before.update, after.update)
        XCTAssertEqual(text.text, "正文🙂")
        XCTAssertEqual(text.selectedRange, NSRange(location: 2, length: 2))
        XCTAssertEqual(editor.binding.state?.projection.canUndo, true)
        let counts = try Fixture.durableCounts(in: receiverDirectory, documentID: "node-content:" + chapter.id)
        let original = movePacket.original
        let invalid = RemoteChangeOriginal(projectId: original.projectId, projectSyncId: "wrong-scope",
            syncGenerationId: original.syncGenerationId, changeSetId: original.changeSetId, originalEnvelopeSha256: original.originalEnvelopeSha256)
        var rejected = false
        do {
            let _: WorkspaceRemoteChangesReply = try await result {
                workspace.receiveChanges(original: invalid, envelope: movePacket.envelope, completion: $0)
            }
        } catch { rejected = true }
        XCTAssertTrue(rejected, "Invalid whole original returned a workspace refresh")
        let stillListed: [WorkspaceChapter] = try await result { workspace.chapters(projectID: project.id, completion: $0) }
        XCTAssertEqual(stillListed.map(\.id), moved.chapters.map(\.id))
        XCTAssertEqual(try Fixture.durableCounts(in: receiverDirectory, documentID: "node-content:" + chapter.id), counts)
        XCTAssertEqual(text.text, "正文🙂")
        XCTAssertEqual(text.selectedRange, NSRange(location: 2, length: 2))
        editor.binding.history(redo: false); try await settle()
        XCTAssertEqual(text.text, "", "Metadata reception must not add a prose undo unit")
        editor.binding.history(redo: true); try await settle()
        XCTAssertEqual(text.text, "正文🙂")
        try await finish()
    }
}
