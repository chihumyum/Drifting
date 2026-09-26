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

    /// Keep the core's exact reason available to diagnostics without exposing
    /// CRDT identities in the shared macOS/iOS error presentation.
    var diagnosticDescription: String {
        switch self {
        case .message(let text), .pendingRemoteUpdate(let text), .historyUnavailable(let text): return text
        }
    }
    var errorDescription: String? {
        switch self {
        case .message(let text): return text
        case .pendingRemoteUpdate:
            return "有已保存但尚未应用的远端更新。原始数据已保留，当前暂不打开文档。"
        case .historyUnavailable:
            return "远端修改影响了这次操作，暂时无法撤销或重做。当前文字已保留，可以继续编辑。"
        }
    }
}

/// Sole Swift owner of one Rust handle. UI clients use this serial queue;
/// no blocking SQLite work runs on the main thread.
struct NativeInputReply: Decodable { let input: NativeProjection; let state: LabDocumentState }
struct NativeCheckpoint: Decodable { let update: String; let stateVector: String }
struct DraftSelection { let viewID: String; let epoch: UInt64; let range: NSRange }

final class LabCore {
    private let queue = DispatchQueue(label: "cc.drifting.native-lab.core")
    private var handle: UInt64?
    private let directory: URL
    private weak var sharedDocument: DocumentStore?
    private var pendingDocument: DocumentStore?

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
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "cc.drifting.native-lab")
            .appendingPathComponent("apple-native-lab", isDirectory: true)
    }

    fileprivate init(handle: UInt64, directory: URL) {
        self.handle = handle
        self.directory = directory
    }

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
        if let handle {
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

private struct WorkspaceState: Decodable {
    let handle: UInt64
    let projects: [WorkspaceProject]
}

private struct WorkspaceDocumentReply: Decodable {
    let handle: UInt64
    let projectId: String
    let chapterId: String
    let document: LabDocumentState
}

/// Workspace commands and chapter switching belong to Rust. A successful
/// switch returns a new document owner, never a repurposed Swift store: old
/// selections, input branches and undo projections cannot cross chapters.
final class LabWorkspaceCore {
    private let queue = DispatchQueue(label: "cc.drifting.native-lab.workspace")
    private let directory: URL
    private var handle: UInt64?
    // A list screen may have no editor view. Keep the bridge's current owner
    // alive until a successful replacement or workspace shutdown.
    private var currentDocument: LabCore?
    private var switchingDocument = false

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
        rename("workspaceRenameProject", fields: ["projectId": projectID, "name": name], completion: completion)
    }

    func chapters(projectID: String, completion: @escaping (Result<[WorkspaceChapter], Error>) -> Void) {
        perform(completion) { try self.request("workspaceChapters", fields: ["projectId": projectID]) }
    }

    func createChapter(projectID: String, title: String,
                       completion: @escaping (Result<WorkspaceChapter, Error>) -> Void) {
        perform(completion) {
            try self.request("workspaceCreateChapter", fields: ["projectId": projectID, "title": title])
        }
    }

    func renameChapter(projectID: String, chapterID: String, title: String,
                       completion: @escaping (Result<WorkspaceChapter, Error>) -> Void) {
        rename("workspaceRenameChapter", fields: ["projectId": projectID, "chapterId": chapterID, "title": title], completion: completion)
    }

    private func rename<Payload: Decodable>(_ operation: String, fields: [String: Any],
                                            completion: @escaping (Result<Payload, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard !switchingDocument, currentDocument?.hasPendingDocumentWork != true else {
            completion(.failure(LabError.message("请先完成输入，并等待正文保存后再重命名")))
            return
        }
        // Metadata changes deliberately retain the current document and store.
        perform(completion) { try self.request(operation, fields: fields) }
    }

    func openChapter(projectID: String, chapterID: String, completion: @escaping (Result<LabCore, Error>) -> Void) {
        openDocument("workspaceOpenChapter", fields: ["projectId": projectID, "chapterId": chapterID], completion: completion)
    }

    func reopenChapter(completion: @escaping (Result<LabCore, Error>) -> Void) {
        openDocument("workspaceReopenChapter", fields: [:], completion: completion)
    }

    private func openDocument(_ operation: String, fields: [String: Any],
                              completion: @escaping (Result<LabCore, Error>) -> Void) {
        precondition(Thread.isMainThread)
        guard !switchingDocument, currentDocument?.hasPendingDocumentWork != true else {
            completion(.failure(LabError.message("请先完成输入，并等待正文保存后再切换章节")))
            return
        }
        switchingDocument = true
        perform({ (result: Result<LabCore, Error>) in
            self.switchingDocument = false
            if case .success(let core) = result { self.currentDocument = core }
            completion(result)
        }) {
            let opened: WorkspaceDocumentReply = try self.request(operation, fields: fields)
            return LabCore(handle: opened.handle, directory: self.directory)
        }
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
