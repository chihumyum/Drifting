import XCTest
import UIKit
@testable import DriftingNativeIOS

/// Two synthetic SQLite replicas exchange the canonical originals produced by
/// real native commands. UITextInput composition here is programmatic UIKit
/// coverage; it does not claim physical keyboard or operating-system IME input.
@MainActor
final class WorkspaceRemoteProseAcceptance: XCTestCase {
    private typealias Fixture = WorkspaceRemoteProseFixture
    private typealias Rows = [[String: Fixture.SQLValue]]
    private struct Editor {
        let core: LabCore
        let view: NativeDocumentView
        let text: UITextView
    }

    private let baselineA = "起点🙂终点"
    private let baselineB = "旁章🙂内容"
    private var directory: URL!
    private var receiverDirectory: URL!
    private var producerDirectory: URL!
    private var workspace: LabWorkspaceCore!
    private var producer: LabWorkspaceCore!
    private var project: WorkspaceProject!
    private var chapters: [WorkspaceChapter] = []
    private var editors: [Editor] = []
    private var primary: Editor!
    private var passive: Editor!
    private var window: UIWindow!
    private var stack: UIStackView!
    private weak var previousWindow: UIWindow?

    private func result<T>(_ operation: (@escaping (Result<T, Error>) -> Void) -> Void) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            operation { continuation.resume(with: $0) }
        }
    }

    private func eventually(_ context: String, _ ready: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(10)
        while !ready() && Date() < deadline { try await Task.sleep(nanoseconds: 5_000_000) }
        guard ready() else {
            let states = editors.map {
                "text=\($0.text.text ?? ""), pending=\($0.view.binding.hasPendingWork), "
                    + "draft=\($0.view.binding.hasUnsubmittedDraft), failed=\($0.view.binding.hasFailedDraft), "
                    + "saved=\($0.view.binding.state?.saved.description ?? "nil"), "
                    + "error=\($0.view.binding.state?.saveError ?? "none")"
            }.joined(separator: " | ")
            throw LabError.message("Workspace remote prose did not settle (\(context)): \(states)")
        }
    }

    private func settle(_ editor: Editor, _ context: String) async throws {
        try await eventually(context) {
            editor.view.binding.state != nil && !editor.view.binding.hasPendingWork
        }
    }

    private func read(_ core: LabCore) async throws -> LabDocumentState {
        try await result { core.document(completion: $0) }
    }

    private func replace(_ core: LabCore, at location: Int, length: Int = 0,
                         with text: String) async throws -> LabDocumentState {
        let before = try await read(core)
        return try await result {
            core.document("documentReplace", edit: ["revision": before.projection.revision,
                "range": ["location": location, "length": length], "text": text], completion: $0)
        }
    }

    private func open(_ workspace: LabWorkspaceCore, chapter index: Int) async throws -> LabCore {
        try await result {
            workspace.openChapter(projectID: project.id, chapterID: chapters[index].id, completion: $0)
        }
    }

    private func documentID(_ index: Int = 0) -> String { "node-content:" + chapters[index].id }

    private func findText(_ view: UIView) -> UITextView? {
        if let text = view as? UITextView { return text }
        return view.subviews.lazy.compactMap { self.findText($0) }.first
    }

    private func mount(_ core: LabCore, visible: Bool = true) async throws -> Editor {
        let view = NativeDocumentView(core: core)
        let editor = Editor(core: core, view: view, text: try XCTUnwrap(findText(view)))
        editors.append(editor)
        if visible { stack.addArrangedSubview(view) }
        view.binding.load()
        try await settle(editor, "mount chapter")
        window.layoutIfNeeded()
        return editor
    }

    private func prepare() async throws {
        continueAfterFailure = false
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        receiverDirectory = directory.appendingPathComponent("receiver/apple-native-lab")
        producerDirectory = directory.appendingPathComponent("producer/apple-native-lab")
        let baselineDirectory = directory.appendingPathComponent("baseline/apple-native-lab")
        let baseline = LabWorkspaceCore(directory: baselineDirectory)
        let initial: [WorkspaceProject] = try await result { baseline.projects(completion: $0) }
        XCTAssertTrue(initial.isEmpty)
        project = try await result { baseline.createProject(name: "UIKit 合成同步项目", completion: $0) }
        for (title, text) in [("合成首章", baselineA), ("合成次章", baselineB)] {
            let chapter: WorkspaceChapter = try await result {
                baseline.createChapter(projectID: project.id, title: title, completion: $0)
            }
            chapters.append(chapter)
            let core: LabCore = try await result {
                baseline.openChapter(projectID: project.id, chapterID: chapter.id, completion: $0)
            }
            let seeded = try await replace(core, at: 0, with: text)
            XCTAssertTrue(seeded.saved)
        }
        let baselineClosed: Bool = try await result { baseline.close(completion: $0) }
        XCTAssertTrue(baselineClosed)
        try Fixture.copyClosedBaseline(from: baselineDirectory, to: [receiverDirectory, producerDirectory])
        workspace = LabWorkspaceCore(directory: receiverDirectory)
        producer = LabWorkspaceCore(directory: producerDirectory)
        let _: [WorkspaceProject] = try await result { workspace.projects(completion: $0) }
        let _: [WorkspaceProject] = try await result { producer.projects(completion: $0) }

        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        previousWindow = scene.windows.first { $0.isKeyWindow }
        window = UIWindow(windowScene: scene)
        let controller = UIViewController()
        stack = UIStackView()
        stack.axis = .vertical
        stack.distribution = .fillEqually
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        controller.view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: controller.view.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: controller.view.trailingAnchor),
            stack.topAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: controller.view.bottomAnchor),
        ])
        window.rootViewController = controller
        window.makeKeyAndVisible()
        let core = try await open(workspace, chapter: 0)
        primary = try await mount(core)
        passive = try await mount(core)
        XCTAssertTrue(primary.text.becomeFirstResponder())
        XCTAssertFalse(passive.text.isFirstResponder)
        assertText(primary.text, baselineA)
        assertText(passive.text, baselineA)
    }

    private func packet(chapter index: Int = 0, at location: Int = 0,
                        text: String) async throws -> RemoteProseTestPacket {
        let prior = try Fixture.localPackets(in: producerDirectory, documentID: documentID(index))
        let core = try await open(producer, chapter: index)
        let saved = try await replace(core, at: location, with: text)
        XCTAssertTrue(saved.saved)
        let packets = try Fixture.localPackets(in: producerDirectory, documentID: documentID(index),
            excluding: Set(prior.map { $0.original.changeSetId }))
        XCTAssertEqual(packets.count, 1, "One real native command must produce one canonical original")
        return try XCTUnwrap(packets.first)
    }

    private func receive(_ packet: RemoteProseTestPacket) async throws -> WorkspaceRemoteProseReply {
        try await result { workspace.receiveProse(original: packet.original, envelope: packet.envelope, completion: $0) }
    }

    private func assertText(_ text: UITextView, _ expected: String,
                            file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(Array((text.text ?? "").utf16), Array(expected.utf16), file: file, line: line)
        XCTAssertEqual(text.textStorage.length, expected.utf16.count, file: file, line: line)
    }

    private func assertConverged(_ expected: String, _ context: String) async throws {
        try await settle(primary, context)
        try await eventually(context + " passive view") { NativeText.identical(self.passive.text.text, expected) }
        let saved = try await read(primary.core)
        XCTAssertTrue(saved.saved, context)
        XCTAssertNil(saved.saveError, context)
        XCTAssertNil(saved.remoteBlock, context)
        XCTAssertEqual(Array(saved.projection.text.utf16), Array(expected.utf16), context)
        assertText(primary.text, expected)
        assertText(passive.text, expected)
    }

    private func selected(_ text: UITextView) -> String {
        (text.text as NSString).substring(with: text.selectedRange)
    }

    private func retainedRows() throws -> [String: Rows] {
        var rows: [String: Rows] = [:]
        for table in ["sync_change_set", "sync_mutation", "sync_apply_receipt",
                      "sync_yjs_materialization_receipt", "sync_generation_writer_state", "yjs_updates",
                      "yjs_snapshots", "yjs_document_revision", "yjs_document_revision_provenance", "node_content"] {
            rows[table] = try Fixture.query(in: receiverDirectory, sql: "SELECT * FROM \(table) ORDER BY rowid")
        }
        return rows
    }

    private func receiptRows(_ packet: RemoteProseTestPacket) throws -> [String: Rows] {
        var rows: [String: Rows] = [:]
        for table in ["sync_change_set", "sync_mutation", "sync_apply_receipt", "sync_yjs_materialization_receipt"] {
            rows[table] = try Fixture.query(in: receiverDirectory,
                sql: "SELECT * FROM \(table) WHERE change_set_id = ? ORDER BY rowid",
                parameters: [.text(packet.original.changeSetId)])
        }
        return rows
    }

    private func detachEditors() async throws {
        for editor in editors {
            editor.text.resignFirstResponder()
            XCTAssertTrue(editor.view.binding.detach())
            editor.view.removeFromSuperview()
        }
        editors.removeAll()
        try await eventually("detach input queues") { !self.workspace.hasPendingDocuments }
    }

    private func finish() async throws {
        try await detachEditors()
        let closed: Bool = try await result { workspace.close(completion: $0) }
        let producerClosed: Bool = try await result { producer.close(completion: $0) }
        XCTAssertTrue(closed && producerClosed)
    }

    override func tearDown() {
        window?.isHidden = true
        window?.rootViewController = nil
        previousWindow?.makeKey()
        editors.removeAll()
        primary = nil; passive = nil; stack = nil; window = nil
        workspace = nil; producer = nil
        if let directory { try? FileManager.default.removeItem(at: directory) }
        super.tearDown()
    }

    func testWorkspaceRemoteProseQueuesUnicodeAndDeduplicatesWithoutUndoingRemote() async throws {
        try await prepare()
        let incoming = try await packet(text: "远🙂")
        passive.text.selectedRange = (baselineA as NSString).range(of: "终点")
        try await eventually("passive original item selection") { self.passive.view.binding.selectionIsAnchored }
        primary.text.selectedRange = NSRange(location: baselineA.utf16.count, length: 0)

        // No yield: both UITextInput commands name the old visible branch while
        // the real canonical receive is already ahead of them on the ABI queue.
        var delivered: Result<WorkspaceRemoteProseReply, Error>?
        workspace.receiveProse(original: incoming.original, envelope: incoming.envelope) { delivered = $0 }
        primary.text.insertText("e\u{301}🙂")
        primary.text.insertText("续")
        try await eventually("queued canonical receipt") { delivered != nil }
        let accepted = try XCTUnwrap(delivered).get()
        XCTAssertFalse(accepted.alreadyApplied)
        let expected = "远🙂" + baselineA + "e\u{301}🙂续"
        try await assertConverged(expected, "Unicode queue")
        try await eventually("shifted passive selection") { self.passive.view.binding.selectionIsAnchored }
        XCTAssertEqual(selected(passive.text), "终点")
        XCTAssertEqual(passive.text.selectedRange, NSRange(location: 7, length: 2))
        let counts = try Fixture.durableCounts(in: receiverDirectory, documentID: documentID())
        let duplicate = try await receive(incoming)
        XCTAssertTrue(duplicate.alreadyApplied)
        try await assertConverged(expected, "duplicate original")
        XCTAssertEqual(try Fixture.durableCounts(in: receiverDirectory, documentID: documentID()), counts)

        let history = try XCTUnwrap(primary.text.undoManager)
        XCTAssertTrue(history.canUndo)
        history.undo()
        try await assertConverged("远🙂" + baselineA + "e\u{301}🙂", "undo second local command")
        history.undo()
        try await assertConverged("远🙂" + baselineA, "undo first local command")
        history.redo(); try await settle(primary, "redo first local command")
        history.redo(); try await assertConverged(expected, "redo local commands")
        try await finish()
    }

    func testWorkspaceRemoteProsePreservesMarkedAndFailedInputBranches() async throws {
        try await prepare()
        let first = try await packet(text: "远🙂")
        primary.text.selectedRange = NSRange(location: baselineA.utf16.count, length: 0)
        primary.text.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0))
        XCTAssertNotNil(primary.text.markedTextRange)
        let marked = primary.text.text ?? ""
        let markedSelection = primary.text.selectedRange
        let key = primary.view.binding.inputKey
        let firstReply = try await receive(first)
        XCTAssertFalse(firstReply.alreadyApplied)
        try await eventually("remote while marked") {
            !self.primary.view.binding.store.hasPendingCommits
                && NativeText.identical(self.passive.text.text, "远🙂" + self.baselineA)
        }
        assertText(primary.text, marked)
        XCTAssertEqual(primary.text.selectedRange, markedSelection)
        XCTAssertEqual(primary.view.binding.inputKey, key)
        XCTAssertTrue(primary.view.binding.hasUnsubmittedDraft)
        XCTAssertNotNil(primary.text.markedTextRange)
        primary.text.insertText("中文🙂")
        try await assertConverged("远🙂" + baselineA + "中文🙂", "marked commit")

        let second = try await packet(text: "再")
        primary.text.setMarkedText("cancel", selectedRange: NSRange(location: 6, length: 0))
        let canceled = primary.text.text ?? ""
        _ = try await receive(second)
        try await eventually("second marked delivery") { !self.primary.view.binding.store.hasPendingCommits }
        assertText(primary.text, canceled)
        primary.text.setMarkedText("", selectedRange: NSRange(location: 0, length: 0))
        primary.text.unmarkText()
        try await assertConverged("再远🙂" + baselineA + "中文🙂", "marked cancellation")

        let third = try await packet(text: "三")
        primary.text.setMarkedText("草稿", selectedRange: NSRange(location: 2, length: 0))
        try await eventually("draft fork before injected failure") { !self.primary.view.binding.store.hasPendingCommits }
        // Only the failure is injected. The retained text came from UITextInput;
        // the next remote update still traverses the real journal and receiver.
        primary.view.binding.rejectInput("synthetic retained draft")
        primary.text.unmarkText()
        let retained = primary.text.text ?? ""
        let retainedKey = primary.view.binding.inputKey
        let retainedSelection = primary.text.selectedRange
        _ = try await receive(third)
        let authoritative = "三再远🙂" + baselineA + "中文🙂"
        try await eventually("failed draft passive delivery") {
            !self.primary.view.binding.store.hasPendingCommits
                && NativeText.identical(self.passive.text.text, authoritative)
        }
        assertText(primary.text, retained)
        XCTAssertEqual(primary.text.selectedRange, retainedSelection)
        XCTAssertEqual(primary.view.binding.inputKey, retainedKey)
        XCTAssertTrue(primary.view.binding.hasFailedDraft)
        XCTAssertFalse(primary.view.binding.detach(), "A failed draft must retain its owner")
        primary.view.binding.discardDraft()
        try await assertConverged(authoritative, "explicit failed-draft discard")
        try await finish()
    }

    func testWorkspaceRemoteProseReconcilesHiddenChaptersWithoutRewritingReceipts() async throws {
        try await prepare()
        let hiddenCore = try await open(workspace, chapter: 1)
        let hidden = try await mount(hiddenCore, visible: false)
        let a = try await packet(text: "甲")
        let b = try await packet(chapter: 1, text: "乙🙂")
        _ = try await receive(a)
        _ = try await receive(b)
        try await assertConverged("甲" + baselineA, "visible chapter delivery")
        try await settle(hidden, "hidden chapter delivery")
        assertText(hidden.text, "乙🙂" + baselineB)

        // A direct core command really commits but deliberately omits the Swift
        // store notification. This is a stale view-cache injection; Rust's
        // separate acceptance covers a missed remote commit notification.
        let direct = try await replace(hiddenCore, at: 0, with: "隐")
        XCTAssertTrue(direct.saved)
        assertText(hidden.text, "乙🙂" + baselineB)
        let beforeDuplicate = try Fixture.durableCounts(in: receiverDirectory, documentID: documentID(1))
        let duplicate = try await receive(a)
        XCTAssertTrue(duplicate.alreadyApplied)
        try await settle(hidden, "duplicate refreshes another chapter")
        assertText(hidden.text, "隐乙🙂" + baselineB)
        XCTAssertEqual(try Fixture.durableCounts(in: receiverDirectory, documentID: documentID(1)), beforeDuplicate)

        let second = try await replace(hiddenCore, at: 0, with: "再")
        XCTAssertTrue(second.saved)
        assertText(hidden.text, "隐乙🙂" + baselineB)
        let beforeReconcile = try Fixture.durableCounts(in: receiverDirectory, documentID: documentID(1))
        let reconciled: Bool = try await result { workspace.reconcileProse(projectID: project.id, completion: $0) }
        XCTAssertTrue(reconciled)
        try await settle(hidden, "explicit all-owner reconciliation")
        assertText(hidden.text, "再隐乙🙂" + baselineB)
        XCTAssertEqual(try Fixture.durableCounts(in: receiverDirectory, documentID: documentID(1)), beforeReconcile)
        try await assertConverged("甲" + baselineA, "other owner retained")
        let reused = try await open(workspace, chapter: 1)
        XCTAssertTrue(reused === hiddenCore)
        try await finish()
    }

    func testWorkspaceRemoteProseRejectsAtomicallyAndRetainsCommittedSaveFailure() async throws {
        try await prepare()
        let incoming = try await packet(text: "远🙂")
        primary.text.selectedRange = NSRange(location: baselineA.utf16.count, length: 0)
        primary.text.setMarkedText("cao", selectedRange: NSRange(location: 3, length: 0))
        try await eventually("retained composition fork") { !self.primary.view.binding.store.hasPendingCommits }
        let draft = primary.text.text ?? ""
        let inputKey = primary.view.binding.inputKey
        let before = try retainedRows()
        let wrong = RemoteProseOriginal(projectId: incoming.original.projectId,
            projectSyncId: "wrong-synthetic-scope", syncGenerationId: incoming.original.syncGenerationId,
            changeSetId: incoming.original.changeSetId, originalEnvelopeSha256: incoming.original.originalEnvelopeSha256)
        do {
            let _: WorkspaceRemoteProseReply = try await result {
                workspace.receiveProse(original: wrong, envelope: incoming.envelope, completion: $0)
            }
            XCTFail("Wrong original scope was accepted")
        } catch { XCTAssertFalse(error.localizedDescription.isEmpty) }
        XCTAssertEqual(try retainedRows(), before)
        assertText(primary.text, draft)
        XCTAssertEqual(primary.view.binding.inputKey, inputKey)

        try Fixture.execute(in: receiverDirectory, sql: """
            CREATE TRIGGER fail_uikit_remote_receipt BEFORE INSERT ON sync_apply_receipt
            BEGIN SELECT RAISE(ABORT, 'synthetic UIKit receipt fault'); END
            """)
        do {
            _ = try await receive(incoming)
            XCTFail("Receipt failure was accepted")
        } catch { XCTAssertTrue(error.localizedDescription.contains("synthetic UIKit receipt fault")) }
        XCTAssertEqual(try retainedRows(), before, "Receipt failure must roll back the complete receive transaction")
        assertText(primary.text, draft)
        XCTAssertNotNil(primary.text.markedTextRange)
        try Fixture.execute(in: receiverDirectory, sql: "DROP TRIGGER fail_uikit_remote_receipt")

        // The original commits first; only the subsequent live-owner checkpoint
        // fails. Its receipt remains durable while the marked branch survives.
        try Fixture.execute(in: receiverDirectory, sql: """
            CREATE TRIGGER fail_uikit_remote_checkpoint BEFORE UPDATE ON yjs_snapshots
            BEGIN SELECT RAISE(ABORT, 'synthetic UIKit checkpoint fault'); END
            """)
        let accepted = try await receive(incoming)
        XCTAssertFalse(accepted.alreadyApplied)
        try await eventually("committed remote with failed owner save") { self.primary.view.binding.state?.saved == false }
        XCTAssertTrue(primary.view.binding.state?.saveError?.contains("synthetic UIKit checkpoint fault") == true)
        XCTAssertFalse(primary.view.binding.canEdit)
        XCTAssertFalse(passive.view.binding.canEdit)
        assertText(primary.text, draft)
        XCTAssertEqual(primary.view.binding.inputKey, inputKey)
        XCTAssertNotNil(primary.text.markedTextRange)
        let acceptedRows = try receiptRows(incoming)
        XCTAssertEqual(acceptedRows["sync_change_set"]?.count, 1)
        XCTAssertEqual(acceptedRows["sync_apply_receipt"]?.count, 1)
        XCTAssertEqual(acceptedRows["sync_yjs_materialization_receipt"]?.count, 1)
        do {
            let _: Bool = try await result { workspace.close(completion: $0) }
            XCTFail("Workspace close discarded an unsaved marked owner")
        } catch { XCTAssertFalse(error.localizedDescription.isEmpty) }
        XCTAssertFalse(primary.core.isClosed)
        try Fixture.execute(in: receiverDirectory, sql: "DROP TRIGGER fail_uikit_remote_checkpoint")
        primary.view.binding.retrySave()
        try await eventually("retry committed remote checkpoint") {
            self.primary.view.binding.state?.saved == true && !self.primary.view.binding.store.hasPendingCommits
        }
        assertText(primary.text, draft)
        assertText(passive.text, "远🙂" + baselineA)
        XCTAssertEqual(try receiptRows(incoming), acceptedRows, "Retry must not rewrite the accepted remote original")
        primary.text.insertText("草稿🙂")
        let expected = "远🙂" + baselineA + "草稿🙂"
        try await assertConverged(expected, "retained composition after retry")
        let duplicate = try await receive(incoming)
        XCTAssertTrue(duplicate.alreadyApplied)
        try await assertConverged(expected, "duplicate after retry")
        XCTAssertEqual(try receiptRows(incoming), acceptedRows)

        try await detachEditors()
        let closed: Bool = try await result { workspace.close(completion: $0) }
        XCTAssertTrue(closed)
        workspace = LabWorkspaceCore(directory: receiverDirectory)
        let _: [WorkspaceProject] = try await result { workspace.projects(completion: $0) }
        let reopened = try await open(workspace, chapter: 0)
        let saved = try await read(reopened)
        XCTAssertTrue(saved.saved)
        XCTAssertEqual(Array(saved.projection.text.utf16), Array(expected.utf16), "Cold SQLite reopen lost the retained input")
        XCTAssertEqual(try receiptRows(incoming), acceptedRows)
        try await finish()
    }
}
