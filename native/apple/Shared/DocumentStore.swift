import Foundation

/// One ordered queue owns live prose and persistence. Each visible input basis
/// has an ephemeral CRDT branch: replies may merge remote text without changing
/// the meaning of keystrokes already queued against the previous display.
final class DocumentStore {
    private enum Job {
        case fork(String, String)
        case replace(String, UInt64, NativeTextChange, DraftSelection?)
        case drop(String)
        case remote(String, UInt8)
        var key: String? {
            switch self {
            case .fork(let key, _), .replace(let key, _, _, _), .drop(let key): return key
            case .remote: return nil
            }
        }
    }
    private let core: LabCore
    private let bindings = NSHashTable<DocumentBinding>.weakObjects()
    private(set) var state: LabDocumentState?
    private(set) var projection: NativeProjection?
    private var defaultKey: String?
    private var inputs: [String: NativeProjection] = [:]
    private var sequences: [String: UInt64] = [:]
    private var pending: [Job] = []
    private var sending = false
    private var needsRefresh = false
    private var failure: String?
    private var failedInputs: [String: String] = [:]
    /// Entity links (workspace bodies only). A pass runs when this owner is
    /// idle: at once after it opens or when names change, and `entityLinkDelay`
    /// after committed local input settles. It is never an undo step and never
    /// counts as pending input, so navigation and typing are not held for it;
    /// later commands queue behind it on the same serial core queue.
    static var entityLinkDelay: TimeInterval = 0.5
    private var linkNow = false
    private var linkAfterInput = false
    private var linkTimer: DispatchWorkItem?
    private(set) var isLinking = false
    /// A link pass is requested, waiting for its delay or in flight.
    var hasScheduledLinks: Bool { linkNow || linkAfterInput || isLinking }
    var remoteBlock: NativeRemoteBlock? { state?.remoteBlock }
    var remoteBlockStatus: String? {
        remoteBlock.map { "远端更新已保存，但尚未应用：\($0.userMessage)。正文提交已暂停；窗口中的输入仍保留，尚未提交的内容请先复制以便恢复。" }
    }
    var hasPendingCommits: Bool {
        sending || !pending.isEmpty || needsRefresh || failure != nil || state?.saved == false || remoteBlock != nil
    }
    var hasPendingWork: Bool { hasPendingCommits || !failedInputs.isEmpty || bindings.allObjects.contains { $0.hasUnsubmittedDraft } }
    /// Input on its way to Rust: queued, being sent, or still composing. A
    /// failed save or a failed draft is not: Rust's owner has what it applied.
    var hasQueuedInput: Bool { sending || !pending.isEmpty || bindings.allObjects.contains { $0.isComposing } }
    var canEdit: Bool { !core.isSuspended && !core.isClosed && state != nil && failure == nil && state?.saved == true && remoteBlock == nil }
    var viewCount: Int { bindings.allObjects.count }

    init(core: LabCore) {
        self.core = core
        // Link once the first projection of a newly opened body settles.
        linkNow = core.linksEntities
    }
    func attach(_ binding: DocumentBinding) {
        precondition(Thread.isMainThread)
        bindings.add(binding)
        if let orphan = failedInputs.first(where: { entry in !bindings.allObjects.contains { $0.inputKey == entry.key } }),
           let projection = inputs[orphan.key] {
            binding.adopt(orphan.key, projection: projection); binding.rejectInput(orphan.value)
        } else if let projection, let defaultKey { binding.adopt(defaultKey, projection: projection) }
    }
    func detach(_ binding: DocumentBinding) {
        bindings.remove(binding); core.dropSelection(viewID: binding.viewID); cleanup(); activity()
    }
    func captureSelection(viewID: String, epoch: UInt64, revision: UInt64, range: NSRange,
                          completion: @escaping (Result<NativeSelectionCapture, Error>) -> Void) {
        core.selection(viewID: viewID, epoch: epoch, revision: revision, range: range, completion: completion)
    }
    func load() {
        guard !hasPendingWork else { activity(); return }
        refresh()
    }

    func beginComposition(_ origin: DocumentBinding) -> String? {
        guard canEdit, let source = origin.inputKey, let current = inputs[source] else { return nil }
        let key = UUID().uuidString
        inputs[key] = current; sequences[key] = 0
        pending.append(.fork(key, source))
        origin.useInput(key)
        cancelLinkTimer()
        pump()
        return source
    }

    func cancelComposition(_ origin: DocumentBinding, parent: String?) {
        let discarded = origin.inputKey
        if let parent, let current = inputs[parent] { origin.adopt(parent, projection: current) }
        else if let defaultKey, let projection { origin.adopt(defaultKey, projection: projection) }
        if let discarded { pending.append(.drop(discarded)) }
        needsRefresh = true
        pump()
    }

    @discardableResult
    func submit(_ proposed: NativeTextChange, origin: DocumentBinding, selection: DraftSelection) -> Bool {
        guard canEdit, let key = origin.inputKey, let current = inputs[key] else { return false }
        if let error = NativeLayout.rejection(blocks: current.blocks, range: proposed.range, text: proposed.text) {
            origin.showStatus(error + "。窗口草稿仍然保留"); return false
        }
        let target = (current.text as NSString).replacingCharacters(in: proposed.range, with: proposed.text)
        let change = NativeTextChange(range: proposed.range, text: proposed.text, target: target)
        let next = NativeLayout.replacing(current, with: change)
        let sequence = sequences[key] ?? 0
        sequences[key] = sequence + 1
        let endpoints = [selection.range.location, NSMaxRange(selection.range)]
        let anchored = endpoints.allSatisfy { at in
            NativeLayout.index(at, blocks: next.blocks).map { next.blocks[$0].editable } ?? false
        } ? selection : nil
        pending.append(.replace(key, sequence, change, anchored)); inputs[key] = next
        if key == defaultKey { projection = next }
        // Typing restarts the debounce; the pass waits until input settles.
        if core.linksEntities { linkAfterInput = true; cancelLinkTimer() }
        for binding in bindings.allObjects where binding.inputKey == key {
            binding.receive(next, changes: [change], authoritative: false)
        }
        pump()
        return true
    }

    /// Fixture transport seam; production durable replay/ack is a separate gate.
    func applyRemote(_ update: String, encoding: UInt8 = 1) {
        guard state != nil, failure == nil else { return }
        pending.append(.remote(update, encoding)); pump()
    }

    /// A workspace receipt has already reconciled this same Rust owner. Only
    /// record its state here: queued keystrokes still name their original input
    /// branches, and refresh() alone may install a new default display basis.
    func receiveReconciledState(_ value: LabDocumentState) {
        precondition(Thread.isMainThread)
        acceptRemoteState(value)
        pump()
    }

    private func acceptRemoteState(_ value: LabDocumentState) {
        let releasedBlock = remoteBlock != nil && value.remoteBlock == nil
        state = value; needsRefresh = true; reportSave(value)
        if releasedBlock {
            for binding in bindings.allObjects where binding.hasUnsubmittedDraft {
                binding.showStatus(value.saved
                    ? "远端更新已恢复应用。窗口草稿仍保留，尚未提交。"
                    : "正文尚未保存：\(value.saveError ?? "未知错误")。窗口草稿仍保留，请重试保存。")
            }
        }
    }

    private func pump() {
        guard !sending, state != nil, failure == nil else { activity(); return }
        let nextIndex: Int
        if remoteBlock != nil {
            // A durable dependency may release a retained remote row. Leave
            // queued local input and composition forks untouched until then.
            guard let remoteIndex = pending.firstIndex(where: {
                if case .remote = $0 { return true }; return false
            }) else { activity(); return }
            nextIndex = remoteIndex
        } else {
            guard canEdit else { activity(); return }
            nextIndex = 0
        }
        guard pending.indices.contains(nextIndex) else {
            if needsRefresh { refresh() } else { cleanup(); linkWhenIdle(); activity() }
            return
        }
        let next = pending[nextIndex]
        sending = true; status("正在保存正文…"); activity()
        switch next {
        case .fork(let key, let source):
            core.inputFork(key: key, source: source) { [weak self] result in
                guard let self else { return }
                switch result {
                case .success: self.completed()
                case .failure(let error): self.reject(key, message: error.localizedDescription)
                }
            }
        case .drop(let key):
            core.inputDrop(key: key)
            inputs.removeValue(forKey: key); sequences.removeValue(forKey: key)
            completed()
        case .replace(let key, let sequence, let change, let selection):
            core.inputReplace(key: key, sequence: sequence, change: change, selection: selection) { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(let value):
                    guard NativeText.identical(value.input.text, change.target) else { self.fail("输入副本版本不一致，窗口草稿已保留"); return }
                    self.state = value.state; self.needsRefresh = true
                    if let selection, !self.bindings.allObjects.contains(where: { $0.viewID == selection.viewID }) {
                        self.core.dropSelection(viewID: selection.viewID)
                    }
                    self.reportSave(value.state); self.completed()
                case .failure(let error): self.reject(key, message: error.localizedDescription)
                }
            }
        case .remote(let update, let encoding):
            core.applyRemote(update, encoding: encoding) { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(let value):
                    self.acceptRemoteState(value)
                    self.completed(at: nextIndex)
                case .failure(let error): self.fail(error.localizedDescription)
                }
            }
        }
    }
    private func completed(at index: Int = 0) { sending = false; pending.remove(at: index); pump() }
    private func reject(_ key: String, message: String) {
        sending = false
        var rejected = Set([key])
        // A composition fork may have been queued after an optimistic edit that
        // was rejected. Its visible basis includes that edit, so it cannot run.
        for job in pending {
            if case .fork(let child, let source) = job, rejected.contains(source) { rejected.insert(child) }
        }
        pending.removeAll { $0.key.map { rejected.contains($0) } ?? false }
        for key in rejected { failedInputs[key] = message }
        for binding in bindings.allObjects where binding.inputKey.map({ rejected.contains($0) }) == true {
            binding.rejectInput(message)
        }
        needsRefresh = true
        pump()
    }

    /// The fork and projection are captured atomically in Rust. If more input
    /// arrives before this reply, discard the fork and drain those events first;
    /// never replace their visible basis with an earlier merged response.
    private func refresh() {
        sending = true; activity()
        let key = UUID().uuidString
        core.inputFork(key: key) { [weak self] result in
            guard let self else { return }
            self.sending = false
            switch result {
            case .success(let value):
                self.state = value.state
                if self.pending.isEmpty {
                    self.defaultKey = key; self.inputs[key] = value.state.projection; self.sequences[key] = 0
                    self.projection = value.state.projection; self.needsRefresh = false
                    for binding in self.bindings.allObjects where !binding.hasUnsubmittedDraft {
                        binding.adopt(key, projection: value.state.projection)
                    }
                    self.cleanup()
                } else { self.core.inputDrop(key: key) }
                self.reportSave(value.state); self.pump()
            case .failure(let error): self.fail(error.localizedDescription)
            }
        }
    }
    private func cleanup() {
        var used = Set(bindings.allObjects.compactMap(\.inputKey))
        used.formUnion(bindings.allObjects.compactMap(\.compositionParent))
        used.formUnion(failedInputs.keys)
        if let defaultKey { used.insert(defaultKey) }
        for job in pending {
            if let key = job.key { used.insert(key) }
            if case .fork(_, let source) = job { used.insert(source) }
        }
        for key in inputs.keys.filter({ !used.contains($0) }) {
            core.inputDrop(key: key); inputs.removeValue(forKey: key); sequences.removeValue(forKey: key)
        }
    }
    func history(redo: Bool) {
        guard !hasPendingWork, state != nil else { return }
        sending = true; activity()
        core.document(redo ? "documentRedo" : "documentUndo") { [weak self] result in
            guard let self else { return }; self.sending = false
            switch result {
            case .success(let value):
                // Restored text is linked again once it settles, like typing.
                if self.core.linksEntities { self.linkAfterInput = true; self.cancelLinkTimer() }
                self.state = value; self.needsRefresh = true; self.reportSave(value); self.pump()
            case .failure(let error):
                if let lab = error as? LabError, case .historyUnavailable = lab {
                    // The core rejected before mutation. Keep the same input
                    // bases usable instead of trapping the owner in save retry.
                    self.status(error.localizedDescription); self.activity()
                } else { self.fail(error.localizedDescription) }
            }
        }
    }
    func format(_ action: NativeFormatAction, range: NSRange, revision: UInt64) {
        guard !hasPendingWork, canEdit, projection?.revision == revision else { return }
        sending = true; activity()
        core.document("documentFormat", edit: ["revision": revision,
            "range": ["location": range.location, "length": range.length], "action": action.rawValue]) { [weak self] result in
            guard let self else { return }; self.sending = false
            switch result {
            case .success(let value): self.state = value; self.needsRefresh = true; self.reportSave(value); self.pump()
            case .failure(let error):
                if let lab = error as? LabError, case .formattingUnavailable = lab {
                    // Rejected before mutation: keep the existing input bases.
                    self.status(error.localizedDescription); self.pump()
                } else { self.fail(error.localizedDescription) }
            }
        }
    }
    /// Comment rows live in SQLite beside this owner. Listing is a read on the
    /// same serial core queue, ordered after any command already sent.
    func comments(completion: @escaping (Result<[WorkspaceComment], Error>) -> Void) {
        core.comments(completion: completion)
    }

    /// The range must come from the current projection revision. Like
    /// formatting, commenting waits for queued input and marked drafts; the
    /// returned state is adopted so every view of this chapter highlights it.
    /// `suggestion` makes it a Copilot suggestion (`{metadata, priority?}`);
    /// it anchors and waits exactly like the author's note.
    func createComment(range: NSRange, revision: UInt64, body: String, suggestion: [String: Any]? = nil,
                       completion: @escaping (Result<WorkspaceComment, Error>) -> Void) {
        if let refusal = commentRefusal(revision: revision) { completion(.failure(refusal)); return }
        sending = true; activity()
        core.createComment(revision: revision, range: range, body: body, suggestion: suggestion) { [weak self] result in
            guard let self else { completion(result.map(\.comment)); return }
            self.sending = false
            switch result {
            case .success(let reply):
                self.state = reply.state; self.needsRefresh = true; self.reportSave(reply.state); self.pump()
                completion(.success(reply.comment))
            case .failure(let error):
                // The core refused, or rolled the row back before tracking an
                // anchor. Keep the existing input bases and selections.
                self.pump()
                completion(.failure(error))
            }
        }
    }

    /// Body and review state never change prose, anchors or history; they
    /// still wait behind queued input so commands keep one visible order.
    func updateCommentBody(id: String, body: String, completion: @escaping (Result<WorkspaceComment, Error>) -> Void) {
        commentCommand(completion) { $0.updateCommentBody(id: id, body: body, completion: $1) }
    }

    func setCommentResolved(id: String, resolved: Bool, completion: @escaping (Result<WorkspaceComment, Error>) -> Void) {
        commentCommand(completion) { $0.setCommentResolved(id: id, resolved: resolved, completion: $1) }
    }

    private func commentCommand(_ completion: @escaping (Result<WorkspaceComment, Error>) -> Void,
                                _ run: (LabCore, @escaping (Result<WorkspaceComment, Error>) -> Void) -> Void) {
        if let refusal = commentRefusal() { completion(.failure(refusal)); return }
        sending = true; activity()
        run(core) { [weak self] result in
            if let self { self.sending = false; self.pump() }
            completion(result)
        }
    }

    private func commentRefusal(revision: UInt64? = nil) -> Error? {
        if let message = remoteBlockStatus { return LabError.message(message) }
        if failure != nil || state?.saved == false { return LabError.message("正文尚未保存，请先重试保存，再操作批注。") }
        if hasPendingWork { return LabError.message("请先完成输入，并等待正文保存后再操作批注。") }
        guard canEdit, let projection else { return LabError.message("正文暂时不可编辑，请稍后再操作批注。") }
        if let revision, projection.revision != revision { return LabError.commentUnavailable(reason: "Document changed") }
        return nil
    }

    func retrySave() {
        guard !sending, failure == nil else { return }
        sending = true; activity()
        core.document("documentSave") { [weak self] result in
            guard let self else { return }; self.sending = false
            switch result {
            case .success(let value): self.state = value; self.needsRefresh = true; self.reportSave(value); self.pump()
            case .failure(let error): self.fail(error.localizedDescription)
            }
        }
    }
    func discardDraft(_ origin: DocumentBinding) {
        guard remoteBlock == nil else { activity(); return }
        let key = origin.inputKey
        if let defaultKey, let projection { origin.adopt(defaultKey, projection: projection) }
        if let key, !bindings.allObjects.contains(where: { $0.inputKey == key }) {
            failedInputs.removeValue(forKey: key); pending.append(.drop(key))
        }
        needsRefresh = true; pump()
    }
    private func reportSave(_ value: LabDocumentState) {
        status(value.saved ? "正文已保存" : "正文尚未保存：\(value.saveError ?? "未知错误")。请重试保存。")
    }
    private func status(_ message: String) {
        for binding in bindings.allObjects where remoteBlock != nil || !binding.hasUnsubmittedDraft {
            binding.showStatus(message)
        }
    }
    func activity() {
        core.retainPendingDocument(self, needed: hasPendingCommits || !failedInputs.isEmpty)
        // The block belongs to the shared owner, including views with marked
        // or failed drafts. Reporting it must not replace their visible text.
        if let message = remoteBlockStatus { status(message) }
        for binding in bindings.allObjects {
            binding.onActivity?(hasPendingWork)
            binding.captureSelection()
        }
    }
    private func fail(_ message: String) { sending = false; failure = message; status(message); activity() }

    // MARK: Entity links

    /// Retroactive linking after element or chapter names change: link as
    /// soon as this owner is idle. Composition, queued input, failed drafts,
    /// save failures and remote blocks defer it; nothing is interrupted.
    func requestEntityLinks() {
        guard core.linksEntities, !core.isClosed else { return }
        linkNow = true
        linkWhenIdle()
    }

    /// The owner change that suspended this store finished. Adopt a link
    /// reply that arrived meanwhile and resume any deferred pass.
    func resumed() {
        if !sending, needsRefresh || !pending.isEmpty { pump() } else { linkWhenIdle(); activity() }
    }

    private var isIdleForLinks: Bool {
        !sending && pending.isEmpty && !needsRefresh && !hasPendingWork && canEdit && !core.isSuspended
    }

    private func cancelLinkTimer() { linkTimer?.cancel(); linkTimer = nil }

    private func linkWhenIdle() {
        guard core.linksEntities, !core.isClosed, !isLinking, linkNow || linkAfterInput, isIdleForLinks else { return }
        if linkNow { cancelLinkTimer(); sendLinks(); return }
        guard linkTimer == nil else { return }
        // The pass runs only if input stayed settled for the whole delay;
        // otherwise the next idle moment starts the delay again.
        let timer = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.linkTimer = nil
            if self.isIdleForLinks { self.linkNow = true; self.linkWhenIdle() }
        }
        linkTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.entityLinkDelay, execute: timer)
    }

    private func sendLinks() {
        linkNow = false; linkAfterInput = false; isLinking = true
        core.linkEntities { [weak self] result in
            guard let self else { return }
            self.isLinking = false
            guard !self.core.isClosed else { return }
            // Rust linked nothing, or refused before mutation: a background
            // pass never fails the owner; the next change requests another.
            if case .success(let reply) = result, reply.linked > 0 {
                // The core queue ran this pass before any later command, so
                // its state precedes every reply still outstanding.
                self.state = reply.state; self.needsRefresh = true; self.reportSave(reply.state)
                for binding in self.bindings.allObjects { binding.onEntityLinks?() }
            }
            if self.sending { self.activity() } else { self.pump() }
        }
    }
}

extension NativeTextChange {
    /// Rebase disjoint input without overwriting another author's insertion.
    /// Overlapping replacements need CRDT item-level reconciliation; retain the
    /// marked draft instead of guessing which text to delete.
    func rebased(over other: NativeTextChange, insertAfter: Bool) -> NativeTextChange? {
        let end = NSMaxRange(range), otherEnd = NSMaxRange(other.range)
        let delta = (other.text as NSString).length - other.range.length
        let start: Int
        if otherEnd < range.location || (otherEnd == range.location
            && (other.range.length > 0 || range.length > 0 || insertAfter)) {
            start = range.location + delta
        } else if end <= other.range.location {
            start = range.location
        } else { return nil }
        return NativeTextChange(range: NSRange(location: start, length: range.length), text: text, target: target)
    }

    func mapSelection(_ selection: NSRange) -> NSRange {
        func point(_ value: Int, after: Bool) -> Int {
            let end = NSMaxRange(range), inserted = (text as NSString).length
            if value < range.location { return value }
            if value > end { return value + inserted - range.length }
            if value == end && range.length > 0 { return range.location + inserted }
            return range.location + (after ? inserted : 0)
        }
        let start = point(selection.location, after: true)
        let end = selection.length == 0 ? start : point(NSMaxRange(selection), after: false)
        // A selection wholly deleted by another edit collapses. Reversing the
        // endpoints would unexpectedly select that editor's replacement text.
        return NSRange(location: start, length: max(0, end - start))
    }
}

/// Layout is optimistic display state only. Identity, XML marks and structural
/// validation remain Rust-owned; the acknowledged projection replaces hints.
enum NativeLayout {
    static func index(_ at: Int, blocks: [NativeBlock]) -> Int? {
        blocks.firstIndex { $0.range.location <= at && at <= NSMaxRange($0.range.nsRange) }
    }
    static func rejection(blocks: [NativeBlock], range: NSRange, text: String) -> String? {
        guard range.location >= 0, range.length >= 0, range.location <= Int.max - range.length,
              let first = index(range.location, blocks: blocks), let last = index(NSMaxRange(range), blocks: blocks), first <= last else {
            return "此处涉及段落结构或未支持的内容，暂时保留只读"
        }
        let selected = Array(blocks[first...last])
        guard selected.allSatisfy(\.editable) else { return "未支持的内容已保留，只读区域不能改写" }
        if first != last || (selected[0].kind != "codeBlock" && text.contains("\n")) {
            guard selected.allSatisfy({ ["paragraph", "heading"].contains($0.kind) }) else {
                return "此操作涉及尚未支持的结构，已保留原文"
            }
            var merged: [String: String] = [:]
            for block in selected {
                for (key, value) in block.structuralAttributes {
                    if let old = merged[key], old != value { return "段落的扩展信息冲突，已保留原文" }
                    merged[key] = value
                }
            }
        }
        if text.contains("\r") || text.contains("\u{2029}") { return "请使用标准换行符" }
        return nil
    }

    static func replacing(_ projection: NativeProjection, with change: NativeTextChange) -> NativeProjection {
        var blocks = projection.blocks
        let firstIndex = index(change.range.location, blocks: blocks)!, lastIndex = index(NSMaxRange(change.range), blocks: blocks)!
        let first = blocks[firstIndex], last = blocks[lastIndex]
        let delta = (change.text as NSString).length - change.range.length
        let structural = firstIndex != lastIndex || (first.kind != "codeBlock" && change.text.contains("\n"))
        if !structural {
            blocks[firstIndex].range.length += delta
        } else {
            let prefix = change.range.location - first.range.location
            let tail = NSMaxRange(last.range.nsRange) - NSMaxRange(change.range)
            let parts = change.text.components(separatedBy: "\n")
            // Cross-container fitting depends on ancestor siblings, which the
            // flattened display does not own. Keep a display-only first-block
            // hint until Rust returns the authoritative identities and depth.
            let keepLast = firstIndex != lastIndex && first.container == last.container && prefix == 0 && (change.text.isEmpty || change.text == "\n")
            let survivor = keepLast ? last : first
            // A root quote with one paragraph can delete into the next quote
            // while retaining nonempty text on both sides and the right suffix.
            // Separator-only joins also retain the existing empty-right case.
            // Keep the public left block ID and the suffix's display parent
            // while the Rust reply is pending.
            // Flattened ancestry is only a hint; Rust validates the XML shape.
            let separatorJoin = first.range.length > 0 && change.range.length == 1
                && change.range.location == NSMaxRange(first.range.nsRange)
                && NSMaxRange(change.range) == last.range.location
            let rightParentHint = lastIndex == firstIndex + 1 && first.depth == 1 && last.depth == 1
                && first.kind == "paragraph" && last.kind == "paragraph" && first.container != last.container
                && (separatorJoin || (prefix > 0 && tail > 0)) && change.text.isEmpty
                && blocks.filter({ $0.container == first.container }).count == 1
                && blocks.firstIndex(where: { $0.container == last.container }) == lastIndex
                && blocks.filter({ $0.container == last.container }).count > 1
            let headingStart = change.text == "\n" && survivor.kind == "heading" && prefix == 0 && tail > 0
            var merged = survivor.structuralAttributes
            for block in blocks[firstIndex...lastIndex] { merged.merge(block.structuralAttributes) { left, _ in left } }
            var inserted: [NativeBlock] = [], at = first.range.location
            for (index, part) in parts.enumerated() {
                let length = (part as NSString).length + (index == 0 ? prefix : 0) + (index == parts.count - 1 ? tail : 0)
                let kind = index == 0 ? (headingStart ? "paragraph" : survivor.kind)
                    : (change.text == "\n" && survivor.kind == "heading" && tail > 0 ? "heading" : "paragraph")
                let id = headingStart ? (index == 1 ? survivor.id : nil) : (index == 0 ? survivor.id : nil)
                inserted.append(NativeBlock(id: id, kind: kind, depth: survivor.depth, container: rightParentHint ? last.container : survivor.container,
                    structuralAttributes: merged, range: NativeRange(location: at, length: length), editable: true, runs: [],
                    attributes: kind == "heading" ? survivor.attributes : nil))
                at += length + 1
            }
            blocks.replaceSubrange(firstIndex...lastIndex, with: inserted)
        }
        let next = structural ? firstIndex + change.text.components(separatedBy: "\n").count : lastIndex + 1
        if next < blocks.count { for index in next..<blocks.count { blocks[index].range.location += delta } }
        // Preserve runs that can be projected safely while the core is busy.
        // Newly created/moved structure gets its exact marks with the reply.
        blocks = blocks.map { block in
            var result = block
            result.runs = block.runs.compactMap { run in
                let mapped = change.mapSelection(run.range.nsRange)
                guard mapped.location >= block.range.location && NSMaxRange(mapped) <= NSMaxRange(block.range.nsRange) else { return nil }
                return NativeRun(range: NativeRange(location: mapped.location, length: mapped.length), attributes: run.attributes)
            }
            return result
        }
        let comments = projection.comments.map { comment in
            NativeComment(id: comment.id, quote: comment.quote, status: comment.status, ranges: comment.ranges.map {
                let mapped = change.mapSelection($0.nsRange)
                return NativeRange(location: mapped.location, length: mapped.length)
            })
        }
        return NativeProjection(revision: projection.revision, text: change.target, blocks: blocks, comments: comments, selections: [], canUndo: true, canRedo: false)
    }
}
