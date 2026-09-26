import Foundation
import DriftingCoreFFI

struct LabState: Decodable {
    let handle: UInt64
    let projectId: String
    let name: String
}

private struct CoreReply<Payload: Decodable>: Decodable {
    let abiVersion: Int
    let ok: Bool
    let value: Payload?
    let error: String?
}

enum LabError: LocalizedError {
    case message(String)
    case pendingRemoteUpdate(reason: String)
    case historyUnavailable(reason: String)
    case formattingUnavailable(reason: String)
    case commentUnavailable(reason: String)

    /// Keep the core's exact reason available to diagnostics without exposing
    /// CRDT identities in the shared macOS/iOS error presentation.
    var diagnosticDescription: String {
        switch self {
        case .message(let text), .pendingRemoteUpdate(let text), .historyUnavailable(let text), .formattingUnavailable(let text),
             .commentUnavailable(let text): return text
        }
    }
    var errorDescription: String? {
        switch self {
        case .message(let text): return text
        case .pendingRemoteUpdate:
            return "有已保存但尚未应用的远端更新。原始数据已保留，当前暂不打开文档。"
        case .historyUnavailable:
            return "远端修改影响了这次操作，暂时无法撤销或重做。当前文字已保留，可以继续编辑。"
        case .formattingUnavailable:
            return "当前选区暂时无法应用这种格式。正文和选区已保留，可以继续编辑。"
        case .commentUnavailable(let reason): return LabError.commentMessage(reason)
        }
    }

    /// Comment refusals happen before any row, anchor or prose changes. Known
    /// core reasons get specific guidance; the exact text stays diagnostic.
    private static func commentMessage(_ reason: String) -> String {
        let known: [(String, String)] = [
            ("Document changed", "正文已变化，请重新选择要批注的文字。"),
            ("active drafts", "请先完成输入，再添加批注。"),
            ("pending save", "正文尚未保存，请先重试保存。"),
            ("Select text", "请先选中要批注的文字。"),
            ("body is empty", "批注内容不能为空。"),
            ("editable text blocks", "所选内容包含暂不支持批注的段落，请缩小选区。"),
            ("No text block", "请先选中要批注的文字。"),
            ("converted suggestion", "已转化的建议不能解决或重新打开。"),
            ("not on this chapter", "这条批注已不在当前章节，请刷新批注列表。"),
            ("not live", "这条批注已被删除，请刷新批注列表。"),
            ("Chapter is not available", "这一章已不可用，请重新打开章节。"),
        ]
        return known.first { reason.contains($0.0) }?.1 ?? "批注操作未能完成。正文和已有批注均未改变，可以稍后重试。"
    }
}

/// Sole Swift owner of one Rust handle. UI clients use this serial queue;
/// no blocking SQLite work runs on the main thread.
struct NativeInputReply: Decodable { let input: NativeProjection; let state: LabDocumentState }
struct NativeCheckpoint: Decodable { let update: String; let stateVector: String }
struct DraftSelection { let viewID: String; let epoch: UInt64; let range: NSRange }

final class LabCore {
    private let queue: DispatchQueue
    private var handle: UInt64?
    private let directory: URL
    private weak var sharedDocument: DocumentStore?
    private var pendingDocument: DocumentStore?
    private let closesOwnHandle: Bool
    private(set) var isSuspended = false
    private(set) var isClosed = false

    fileprivate var hasPendingDocumentWork: Bool {
        precondition(Thread.isMainThread)
        return sharedDocument?.hasPendingWork == true
    }

    func retainPendingDocument(_ store: DocumentStore, needed: Bool) {
        pendingDocument = needed ? store : nil
    }

    /// All views of this handle share one main-thread queue and undo owner.
    /// Weak caching lets the last view release the store without a retain cycle.
    func documentStore() -> DocumentStore {
        precondition(Thread.isMainThread)
        if let sharedDocument { return sharedDocument }
        let store = DocumentStore(core: self)
        sharedDocument = store
        return store
    }

    init(directory: URL? = nil) {
        queue = DispatchQueue(label: "cc.drifting.native-lab.core")
        closesOwnHandle = true
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "cc.drifting.native-lab")
            .appendingPathComponent("apple-native-lab", isDirectory: true)
    }

    fileprivate init(handle: UInt64, directory: URL, queue: DispatchQueue) {
        self.queue = queue
        closesOwnHandle = false
        self.handle = handle
        self.directory = directory
    }

    fileprivate func suspend(_ value: Bool) {
        precondition(Thread.isMainThread)
        isSuspended = value
        sharedDocument?.activity()
    }

    fileprivate func receiveReconciledState(_ state: LabDocumentState) {
        precondition(Thread.isMainThread)
        guard !isClosed else { return }
        // A chapter without views needs no new store. Its next view will load
        // the already-reconciled owner; retained drafts keep their existing one.
        sharedDocument?.receiveReconciledState(state)
    }

    fileprivate func invalidate() {
        precondition(Thread.isMainThread)
        isClosed = true
        queue.async { self.handle = nil }
        sharedDocument?.activity()
    }

    fileprivate var documentViewCount: Int { sharedDocument?.viewCount ?? 0 }

    fileprivate static func call<Payload: Decodable>(_ request: [String: Any]) throws -> Payload? {
        let data = try JSONSerialization.data(withJSONObject: request)
        guard let input = String(data: data, encoding: .utf8) else { throw LabError.message("无法编码请求") }
        let pointer = input.withCString { drifting_lab_call($0) }
        guard let pointer else { throw LabError.message("无法连接文档核心") }
        defer { drifting_lab_free(pointer) }
        let reply = try JSONDecoder().decode(CoreReply<Payload>.self, from: Data(String(cString: pointer).utf8))
        guard reply.abiVersion == 1 else { throw LabError.message("核心版本不匹配") }
        guard reply.ok else {
            let reason = reply.error ?? "核心操作失败"
            if ["documentUndo", "documentRedo"].contains(request["operation"] as? String ?? ""),
               reason.hasPrefix("NATIVE_HISTORY_UNAVAILABLE:") {
                throw LabError.historyUnavailable(reason: reason)
            }
            if request["operation"] as? String == "documentFormat",
               reason.hasPrefix("NATIVE_FORMATTING_UNAVAILABLE:") {
                throw LabError.formattingUnavailable(reason: reason)
            }
            if ["documentComments", "documentCreateComment", "documentUpdateCommentBody", "documentSetCommentResolved"]
                .contains(request["operation"] as? String ?? "") {
                throw LabError.commentUnavailable(reason: reason)
            }
            if ["open", "workspaceOpenChapter", "workspaceReopenChapter"].contains(request["operation"] as? String ?? ""),
               reason.contains("REMOTE_TEXT_RETENTION_REQUIRED:") {
                throw LabError.pendingRemoteUpdate(reason: reason)
            }
            throw LabError.message(reason)
        }
        return reply.value
    }

    func open(completion: @escaping (Result<LabState, Error>) -> Void) {
        perform(completion) {
            let state: LabState? = try LabCore.call(self.handle.map { ["operation": "read", "handle": $0] }
                ?? ["operation": "open", "directory": self.directory.path])
            guard let state else { throw LabError.message("项目没有返回") }
            self.handle = state.handle
            return state
        }
    }

    func rename(_ name: String, completion: @escaping (Result<LabState, Error>) -> Void) {
        perform(completion) {
            guard let handle = self.handle else { throw LabError.message("请先打开项目") }
            guard let state: LabState = try LabCore.call(["operation": "rename", "handle": handle, "name": name]) else {
                throw LabError.message("保存结果缺失")
            }
            return state
        }
    }

    func reopen(completion: @escaping (Result<LabState, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard sharedDocument?.hasPendingWork != true else {
            completion(.failure(LabError.message("仍有未完成的输入或待恢复草稿，请先保存或处理草稿"))); return
        }
        perform(completion) {
            if let handle = self.handle { let _: LabState? = try LabCore.call(["operation": "close", "handle": handle]); self.handle = nil }
            guard let state: LabState = try LabCore.call(["operation": "open", "directory": self.directory.path]) else {
                throw LabError.message("项目没有返回")
            }
            self.handle = state.handle
            return state
        }
    }

    func document(_ operation: String = "documentRead", edit: [String: Any]? = nil,
                  completion: @escaping (Result<LabDocumentState, Error>) -> Void) {
        documentRequest(operation, fields: edit.map { ["edit": $0] } ?? [:], completion: completion)
    }

    private func documentRequest(_ operation: String, fields: [String: Any],
                                 completion: @escaping (Result<LabDocumentState, Error>) -> Void) {
        perform(completion) {
            guard let handle = self.handle else { throw LabError.message("请先打开项目") }
            var request = fields; request["operation"] = operation; request["handle"] = handle
            guard let state: LabDocumentState = try LabCore.call(request) else { throw LabError.message("正文没有返回") }
            return state
        }
    }

    /// Direct comments on this workspace chapter, in the renderer's order.
    func comments(completion: @escaping (Result<[WorkspaceComment], Error>) -> Void) {
        documentValue("documentComments", fields: [:]) { (result: Result<WorkspaceCommentList, Error>) in
            completion(result.map(\.comments))
        }
    }

    /// Callers route this through DocumentStore so queued input, marked text
    /// and the projection revision are checked before the core is asked.
    func createComment(revision: UInt64, range: NSRange, body: String,
                       completion: @escaping (Result<WorkspaceCommentCreation, Error>) -> Void) {
        documentValue("documentCreateComment", fields: ["revision": revision,
            "range": ["location": range.location, "length": range.length], "body": body], completion: completion)
    }

    func updateCommentBody(id: String, body: String, completion: @escaping (Result<WorkspaceComment, Error>) -> Void) {
        documentValue("documentUpdateCommentBody", fields: ["commentId": id, "body": body]) { (result: Result<WorkspaceCommentReply, Error>) in
            completion(result.map(\.comment))
        }
    }

    func setCommentResolved(id: String, resolved: Bool, completion: @escaping (Result<WorkspaceComment, Error>) -> Void) {
        documentValue("documentSetCommentResolved", fields: ["commentId": id, "resolved": resolved]) { (result: Result<WorkspaceCommentReply, Error>) in
            completion(result.map(\.comment))
        }
    }

    private func documentValue<Payload: Decodable>(_ operation: String, fields: [String: Any],
                                                   completion: @escaping (Result<Payload, Error>) -> Void) {
        perform(completion) {
            guard let handle = self.handle else { throw LabError.message("请先打开项目") }
            var request = fields; request["operation"] = operation; request["handle"] = handle
            guard let value: Payload = try LabCore.call(request) else { throw LabError.message("批注结果没有返回") }
            return value
        }
    }

    func exportDocument(completion: @escaping (Result<NativeCheckpoint, Error>) -> Void) {
        perform(completion) {
            guard let handle = self.handle else { throw LabError.message("请先打开项目") }
            guard let value: NativeCheckpoint = try LabCore.call(["operation": "documentExport", "handle": handle]) else {
                throw LabError.message("文档状态没有返回")
            }
            return value
        }
    }

    /// Fixture transport only; production reducer/acknowledgement is a P4 gate.
    /// Native views must route this through the shared input queue before use;
    /// direct calls currently belong to transport acceptance only.
    func applyRemote(_ update: String, encoding: UInt8 = 1,
                     completion: @escaping (Result<LabDocumentState, Error>) -> Void) {
        documentRequest("documentApplyRemote", fields: ["update": update, "encoding": encoding], completion: completion)
    }

    func beginDraft(key: String, revision: UInt64, range: NSRange,
                    completion: @escaping (Result<Bool, Error>) -> Void) {
        perform(completion) {
            guard let handle = self.handle else { throw LabError.message("请先打开项目") }
            let _: LabState? = try LabCore.call(["operation": "documentBeginDraft", "handle": handle,
                "start": ["key": key, "revision": revision, "range": ["location": range.location, "length": range.length]]])
            return true
        }
    }

    func commitDraft(key: String, text: String, selection: DraftSelection? = nil,
                     completion: @escaping (Result<LabDocumentState, Error>) -> Void) {
        var commit: [String: Any] = ["key": key, "text": text]
        if let selection {
            commit["selection"] = ["viewId": selection.viewID, "epoch": selection.epoch,
                "range": ["location": selection.range.location, "length": selection.range.length]]
        }
        documentRequest("documentCommitDraft", fields: ["commit": commit], completion: completion)
    }

    func cancelDraft(key: String, completion: @escaping (Result<Bool, Error>) -> Void) {
        perform(completion) {
            guard let handle = self.handle else { throw LabError.message("请先打开项目") }
            let _: LabState? = try LabCore.call(["operation": "documentCancelDraft", "handle": handle, "key": key])
            return true
        }
    }

    func inputFork(key: String, source: String? = nil, completion: @escaping (Result<NativeInputReply, Error>) -> Void) {
        inputRequest("documentInputFork", fields: ["key": key, "source": source.map { $0 as Any } ?? NSNull()], completion: completion)
    }

    func inputReplace(key: String, sequence: UInt64, change: NativeTextChange, selection: DraftSelection?,
                      completion: @escaping (Result<NativeInputReply, Error>) -> Void) {
        var edit: [String: Any] = ["key": key, "sequence": sequence,
            "range": ["location": change.range.location, "length": change.range.length], "text": change.text]
        if let selection { edit["selection"] = ["viewId": selection.viewID, "epoch": selection.epoch,
            "range": ["location": selection.range.location, "length": selection.range.length]] }
        inputRequest("documentInputReplace", fields: ["edit": edit], completion: completion)
    }

    private func inputRequest(_ operation: String, fields: [String: Any],
                              completion: @escaping (Result<NativeInputReply, Error>) -> Void) {
        perform(completion) {
            guard let handle = self.handle else { throw LabError.message("请先打开项目") }
            var request = fields; request["operation"] = operation; request["handle"] = handle
            guard let value: NativeInputReply = try LabCore.call(request) else { throw LabError.message("输入状态没有返回") }
            return value
        }
    }

    func inputDrop(key: String) {
        perform({ (_: Result<Bool, Error>) in }) {
            guard let handle = self.handle else { return true }
            let _: LabState? = try LabCore.call(["operation": "documentInputDrop", "handle": handle, "key": key])
            return true
        }
    }

    func selection(viewID: String, epoch: UInt64, revision: UInt64, range: NSRange,
                   completion: @escaping (Result<NativeSelectionCapture, Error>) -> Void) {
        perform(completion) {
            guard let handle = self.handle else { throw LabError.message("请先打开项目") }
            guard let value: NativeSelectionCapture = try LabCore.call(["operation": "documentSelect", "handle": handle,
                "selection": ["viewId": viewID, "epoch": epoch, "revision": revision,
                    "range": ["location": range.location, "length": range.length]]]) else {
                throw LabError.message("选区没有返回")
            }
            return value
        }
    }

    func dropSelection(viewID: String) {
        perform({ (_: Result<Bool, Error>) in }) {
            guard let handle = self.handle else { return true }
            let _: LabState? = try LabCore.call(["operation": "documentDropSelection", "handle": handle, "viewId": viewID])
            return true
        }
    }

    private func perform<Payload>(_ completion: @escaping (Result<Payload, Error>) -> Void, _ operation: @escaping () throws -> Payload) {
        queue.async {
            let result = Result { try operation() }
            DispatchQueue.main.async { completion(result) }
        }
    }

    deinit {
        // Enqueued operations retain self, so deinit only runs after they finish.
        if closesOwnHandle, let handle {
            queue.async { let _: LabState? = try? LabCore.call(["operation": "close", "handle": handle]) }
        }
    }
}

struct WorkspaceProject: Decodable {
    let id: String
    let name: String
}

struct WorkspaceChapter: Decodable {
    let id: String
    let title: String
}
struct WorkspaceAct: Decodable {
    let id: String
    let projectId: String
    let name: String
    let color: String?
    let startOrder: Double?
    let driftNodeId: String?
    let createdAt: String
    let updatedAt: String
}

struct ChapterScope: Hashable {
    let projectID: String
    let chapterID: String
}
struct WorkspaceOutlineEntry: Decodable {
    let kind: String
    let id: String
    let title: String
    let actId: String?
}

private struct WorkspaceState: Decodable {
    let handle: UInt64
    let projects: [WorkspaceProject]
}

struct WorkspaceDocumentReply: Decodable {
    let handle: UInt64
    let projectId: String
    let chapterId: String
    let document: LabDocumentState
}

struct RemoteChangeOriginal: Codable {
    let projectId: String
    let projectSyncId: String
    let syncGenerationId: String
    let changeSetId: String
    let originalEnvelopeSha256: String
}

private protocol WorkspaceRemoteDeliveryReply: Decodable {
    var documents: [WorkspaceDocumentReply] { get }
}

struct WorkspaceRemoteProseReply: WorkspaceRemoteDeliveryReply {
    let changeSetId: String
    let alreadyApplied: Bool
    let affectedDocuments: [String]
    let documents: [WorkspaceDocumentReply]
}

struct WorkspaceRemoteChangesReply: WorkspaceRemoteDeliveryReply {
    let changeSetId: String
    let alreadyApplied: Bool
    let affectedDocuments: [String]
    let documents: [WorkspaceDocumentReply]
    let projectId: String
    let projects: [WorkspaceProject]
    let chapters: [WorkspaceChapter]
}

struct WorkspaceChapterTrashReply: Decodable {
    let projectId: String
    let chapterId: String
    let chapters: [WorkspaceChapter]
    let trashedChapters: [WorkspaceChapter]
}

/// Registry of Swift wrappers for Rust's chapter owners. Cache changes belong
/// to the main thread; the workspace queue owns only FFI requests and its handle.
final class LabWorkspaceCore {
    private let queue = DispatchQueue(label: "cc.drifting.native-lab.workspace")
    private let directory: URL
    private var handle: UInt64?
    private struct Owner { let handle: UInt64; let core: LabCore }
    private var owners: [ChapterScope: Owner] = [:]
    private var remoteDeliveryInFlight = 0
    private(set) var isChangingOwners = false
    var hasPendingDocuments: Bool { owners.values.contains { $0.core.hasPendingDocumentWork } }

    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "cc.drifting.native-lab")
            .appendingPathComponent("apple-native-lab", isDirectory: true)
    }

    func projects(completion: @escaping (Result<[WorkspaceProject], Error>) -> Void) {
        perform(completion) {
            if self.handle != nil { return try self.request("workspaceProjects") }
            guard let state: WorkspaceState = try LabCore.call([
                "operation": "workspaceOpen", "directory": self.directory.path,
            ]) else { throw LabError.message("工作区没有返回") }
            self.handle = state.handle
            return state.projects
        }
    }

    func createProject(name: String, completion: @escaping (Result<WorkspaceProject, Error>) -> Void) {
        perform(completion) { try self.request("workspaceCreateProject", fields: ["name": name]) }
    }

    func renameProject(projectID: String, name: String,
                       completion: @escaping (Result<WorkspaceProject, Error>) -> Void) {
        updateMetadata("workspaceRenameProject", fields: ["projectId": projectID, "name": name], completion: completion)
    }

    func chapters(projectID: String, completion: @escaping (Result<[WorkspaceChapter], Error>) -> Void) {
        perform(completion) { try self.request("workspaceChapters", fields: ["projectId": projectID]) }
    }

    func trashedChapters(projectID: String, completion: @escaping (Result<[WorkspaceChapter], Error>) -> Void) {
        perform(completion) { try self.request("workspaceTrashedChapters", fields: ["projectId": projectID]) }
    }

    func trashChapter(projectID: String, chapterID: String,
                      completion: @escaping (Result<WorkspaceChapterTrashReply, Error>) -> Void) {
        changeChapterLifecycle("workspaceTrashChapter", projectID: projectID, chapterID: chapterID,
                               closesOwner: true, completion: completion)
    }

    func restoreChapter(projectID: String, chapterID: String,
                        completion: @escaping (Result<WorkspaceChapterTrashReply, Error>) -> Void) {
        changeChapterLifecycle("workspaceRestoreChapter", projectID: projectID, chapterID: chapterID,
                               closesOwner: false, completion: completion)
    }

    private func changeChapterLifecycle(_ operation: String, projectID: String, chapterID: String,
                                        closesOwner: Bool,
                                        completion: @escaping (Result<WorkspaceChapterTrashReply, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard beginOwnerChange() else {
            completion(.failure(LabError.message("请先完成输入，并保存或处理所有待恢复草稿"))); return
        }
        let scope = ChapterScope(projectID: projectID, chapterID: chapterID)
        perform({ (result: Result<WorkspaceChapterTrashReply, Error>) in
            // Rust saves the live owner before changing its lifecycle. A failed
            // transaction keeps every wrapper and view; a restored chapter is
            // left closed until its new incarnation is opened normally.
            if closesOwner, case .success = result {
                self.owners.removeValue(forKey: scope)?.core.invalidate()
            }
            self.endOwnerChange()
            completion(result)
        }) {
            try self.request(operation, fields: ["projectId": projectID, "chapterId": chapterID])
        }
    }

    func outline(projectID: String, completion: @escaping (Result<[WorkspaceOutlineEntry], Error>) -> Void) {
        perform(completion) { try self.request("workspaceOutline", fields: ["projectId": projectID]) }
    }

    func createAct(projectID: String, chapterID: String,
                   completion: @escaping (Result<WorkspaceAct, Error>) -> Void) {
        updateMetadata("workspaceCreateAct", fields: ["projectId": projectID, "chapterId": chapterID], completion: completion)
    }

    func renameAct(projectID: String, actID: String, name: String,
                   completion: @escaping (Result<WorkspaceAct, Error>) -> Void) {
        updateMetadata("workspaceRenameAct", fields: ["projectId": projectID, "actId": actID, "name": name], completion: completion)
    }

    func removeAct(projectID: String, actID: String,
                   completion: @escaping (Result<WorkspaceAct, Error>) -> Void) {
        updateMetadata("workspaceRemoveAct", fields: ["projectId": projectID, "actId": actID], completion: completion)
    }

    func chapterOutline(projectID: String, chapterID: String,
                        completion: @escaping (Result<[NativeOutlineItem], Error>) -> Void) {
        perform(completion) {
            try self.request("workspaceChapterOutline", fields: ["projectId": projectID, "chapterId": chapterID])
        }
    }

    func search(projectID: String, query: String, completion: @escaping (Result<WorkspaceSearchResult, Error>) -> Void) {
        perform(completion) { try self.request("workspaceSearch", fields: ["projectId": projectID, "query": query]) }
    }

    func resolveSearchHit(_ hit: WorkspaceSearchHit, completion: @escaping (Result<WorkspaceSearchLocation, Error>) -> Void) {
        perform(completion) {
            let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(hit))
            return try self.request("workspaceResolveSearchHit", fields: ["hit": payload])
        }
    }

    /// Completion reports durable acceptance and dispatch to existing stores.
    /// Queued input and marked drafts can keep individual views on their old
    /// input basis until DocumentStore's normal refresh can safely adopt it.
    func receiveProse(original: RemoteChangeOriginal, envelope: Data,
                      completion: @escaping (Result<WorkspaceRemoteProseReply, Error>) -> Void) {
        receiveOriginal("workspaceReceiveProse", original: original, envelope: envelope, completion: completion)
    }

    /// The caller receives fresh project and chapter lists only after the
    /// complete original succeeds. Existing editor owners stay in place.
    func receiveChanges(original: RemoteChangeOriginal, envelope: Data,
                        completion: @escaping (Result<WorkspaceRemoteChangesReply, Error>) -> Void) {
        receiveOriginal("workspaceReceiveChanges", original: original, envelope: envelope, completion: completion)
    }

    private func receiveOriginal<Reply: WorkspaceRemoteDeliveryReply>(_ operation: String,
            original: RemoteChangeOriginal, envelope: Data,
            completion: @escaping (Result<Reply, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard !isChangingOwners else {
            completion(.failure(LabError.message("正在切换章节，请稍后重试接收更改"))); return
        }
        let fields: [String: Any]
        do {
            // Own immutable request values before entering the asynchronous
            // queue; callers may reuse the original Data after this returns.
            fields = ["original": try JSONSerialization.jsonObject(with: JSONEncoder().encode(original)),
                      "envelope": envelope.base64EncodedString()]
        } catch { completion(.failure(error)); return }
        remoteDeliveryInFlight += 1
        perform({ (result: Result<Reply, Error>) in
            if case .success(let reply) = result { self.routeReconciledDocuments(reply.documents) }
            self.remoteDeliveryInFlight -= 1
            completion(result)
        }) {
            try self.request(operation, fields: fields)
        }
    }

    func reconcileProse(projectID: String, completion: @escaping (Result<Bool, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard !isChangingOwners else {
            completion(.failure(LabError.message("正在切换章节，请稍后重试恢复正文"))); return
        }
        remoteDeliveryInFlight += 1
        perform({ (result: Result<[WorkspaceDocumentReply], Error>) in
            if case .success(let documents) = result { self.routeReconciledDocuments(documents) }
            self.remoteDeliveryInFlight -= 1
            completion(result.map { _ in true })
        }) {
            try self.request("workspaceReconcileProse", fields: ["projectId": projectID])
        }
    }

    private func routeReconciledDocuments(_ documents: [WorkspaceDocumentReply]) {
        precondition(Thread.isMainThread)
        for document in documents {
            let scope = ChapterScope(projectID: document.projectId, chapterID: document.chapterId)
            guard let owner = owners[scope], owner.handle == document.handle, !owner.core.isClosed else { continue }
            owner.core.receiveReconciledState(document.document)
        }
    }

    func createChapter(projectID: String, title: String,
                       completion: @escaping (Result<WorkspaceChapter, Error>) -> Void) {
        perform(completion) {
            try self.request("workspaceCreateChapter", fields: ["projectId": projectID, "title": title])
        }
    }

    func renameChapter(projectID: String, chapterID: String, title: String,
                       completion: @escaping (Result<WorkspaceChapter, Error>) -> Void) {
        updateMetadata("workspaceRenameChapter", fields: ["projectId": projectID, "chapterId": chapterID, "title": title], completion: completion)
    }

    func moveChapter(projectID: String, chapterID: String, beforeChapterID: String?,
                     completion: @escaping (Result<[WorkspaceChapter], Error>) -> Void) {
        updateMetadata("workspaceMoveChapter", fields: ["projectId": projectID, "chapterId": chapterID,
            "beforeChapterId": beforeChapterID.map { $0 as Any } ?? NSNull()], completion: completion)
    }

    private func updateMetadata<Payload: Decodable>(_ operation: String, fields: [String: Any],
                                                    completion: @escaping (Result<Payload, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard !isChangingOwners, !hasPendingDocuments else {
            completion(.failure(LabError.message("请先完成输入，并等待正文保存后再操作")))
            return
        }
        // Metadata changes deliberately retain the current document and store.
        perform(completion) { try self.request(operation, fields: fields) }
    }

    func openChapter(projectID: String, chapterID: String, completion: @escaping (Result<LabCore, Error>) -> Void) {
        openDocument("workspaceOpenChapter", scope: ChapterScope(projectID: projectID, chapterID: chapterID), completion: completion)
    }

    func reopenChapter(projectID: String, chapterID: String, completion: @escaping (Result<LabCore, Error>) -> Void) {
        let scope = ChapterScope(projectID: projectID, chapterID: chapterID)
        guard (owners[scope]?.core.documentViewCount ?? 0) <= 1 else {
            completion(.failure(LabError.message("请先关闭这个章节的另一处显示，再重新打开"))); return
        }
        openDocument("workspaceReopenChapter", scope: scope, completion: completion)
    }

    private func openDocument(_ operation: String, scope: ChapterScope,
                              completion: @escaping (Result<LabCore, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard beginOwnerChange() else {
            completion(.failure(LabError.message("请先完成输入，并等待正文保存后再切换章节")))
            return
        }
        perform({ (result: Result<WorkspaceDocumentReply, Error>) in
            let result = result.map { reply -> LabCore in
                if let owner = self.owners[scope], owner.handle == reply.handle { return owner.core }
                // Only a successful explicit reopen invalidates this scope.
                self.owners[scope]?.core.invalidate()
                let core = LabCore(handle: reply.handle, directory: self.directory, queue: self.queue)
                self.owners[scope] = Owner(handle: reply.handle, core: core)
                return core
            }
            self.endOwnerChange()
            completion(result)
        }) {
            try self.request(operation, fields: ["projectId": scope.projectID, "chapterId": scope.chapterID])
        }
    }

    func closeChapter(projectID: String, chapterID: String, completion: @escaping (Result<Bool, Error>) -> Void) {
        precondition(Thread.isMainThread)
        let scope = ChapterScope(projectID: projectID, chapterID: chapterID)
        guard (owners[scope]?.core.documentViewCount ?? 0) <= 1, beginOwnerChange() else {
            completion(.failure(LabError.message("请先完成输入、处理草稿，并关闭这个章节的另一处显示"))); return
        }
        perform({ (result: Result<Bool, Error>) in
            if case .success = result { self.owners.removeValue(forKey: scope)?.core.invalidate() }
            self.endOwnerChange()
            completion(result)
        }) {
            try self.emptyRequest("workspaceCloseChapter", fields: ["projectId": projectID, "chapterId": chapterID])
        }
    }

    func close(completion: @escaping (Result<Bool, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard beginOwnerChange() else {
            completion(.failure(LabError.message("仍有未完成输入或待恢复草稿，请先保存所有章节"))); return
        }
        perform({ (result: Result<Bool, Error>) in
            if case .success = result {
                self.owners.values.forEach { $0.core.invalidate() }
                self.owners.removeAll()
            }
            self.endOwnerChange()
            completion(result)
        }) {
            guard self.handle != nil else { return true }
            _ = try self.emptyRequest("workspaceClose")
            self.handle = nil
            return true
        }
    }

    private func beginOwnerChange() -> Bool {
        guard !isChangingOwners, remoteDeliveryInFlight == 0, !hasPendingDocuments else { return false }
        isChangingOwners = true
        owners.values.forEach { $0.core.suspend(true) }
        return true
    }
    private func endOwnerChange() {
        isChangingOwners = false
        owners.values.forEach { $0.core.suspend(false) }
    }
    private func emptyRequest(_ operation: String, fields: [String: Any] = [:]) throws -> Bool {
        guard let handle else { throw LabError.message("请先打开工作区") }
        var request = fields; request["operation"] = operation; request["handle"] = handle
        let _: LabState? = try LabCore.call(request)
        return true
    }

    private func request<Payload: Decodable>(_ operation: String, fields: [String: Any] = [:]) throws -> Payload {
        guard let handle else { throw LabError.message("请先打开工作区") }
        var request = fields
        request["operation"] = operation
        request["handle"] = handle
        guard let result: Payload = try LabCore.call(request) else { throw LabError.message("工作区结果缺失") }
        return result
    }

    private func perform<Payload>(_ completion: @escaping (Result<Payload, Error>) -> Void,
                                  _ operation: @escaping () throws -> Payload) {
        queue.async {
            let result = Result { try operation() }
            DispatchQueue.main.async { completion(result) }
        }
    }

    deinit {
        if let handle {
            queue.async { let _: LabState? = try? LabCore.call(["operation": "workspaceClose", "handle": handle]) }
        }
    }
}
