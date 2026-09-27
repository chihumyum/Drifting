import Foundation

/// A durable change an accepted proposal made; views that list or show it follow.
enum AgentWorkspaceEffect {
    /// A body was revised. `live` when its open owner adopted the revision.
    case prose(projectID: String, kind: String, id: String, live: Bool)
    case chapterCreated(projectID: String, chapter: WorkspaceChapter)
    case nodeMetadata(projectID: String, metadata: WorkspaceNodeMetadata)
    /// The complete library after an element or category write.
    case elements(projectID: String, library: WorkspaceElementLibrary)
    case storylines(projectID: String, library: WorkspaceStorylineLibrary)
    case drifts(projectID: String, library: WorkspaceDriftLibrary)
    /// Relations or relation types changed; relation views read them again.
    case relations(projectID: String)
    case comments(projectID: String, comments: [WorkspaceComment])
    /// One element's 设定补丁 changed.
    case patches(projectID: String, elementID: String)
    case chapterRenamed(projectID: String, chapter: WorkspaceChapter)
    /// A chapter moved to the trash; its tabs were closed by the tab host.
    case chapterTrashed(projectID: String, reply: WorkspaceChapterTrashReply)
    case project(projectID: String, details: WorkspaceProjectDetails)
}

enum AgentChange {
    /// The conversation list or the selection changed.
    case conversations
    /// The current conversation's messages or proposals changed.
    case transcript
    /// The streamed reply or the running activity changed.
    case streaming
    /// The project's 作者规则 changed.
    case rules
}

/// Retries of network failures, HTTP 429 and 5xx with exponential backoff;
/// a provider's `Retry-After` wins. 400, 401, 403 and 404 are never retried.
struct AgentRetryPolicy {
    var attempts = 3
    var baseDelay: TimeInterval = 2
    var maxDelay: TimeInterval = 30
    var maxRetryAfter: TimeInterval = 120

    static func retryable(_ failure: AgentFailure) -> Bool {
        switch failure.kind {
        case .network, .rateLimit, .server, .interrupted: return true
        default: return false
        }
    }

    /// Seconds before retry `attempt` (1-based).
    func delay(attempt: Int, retryAfter: TimeInterval?) -> TimeInterval {
        if let retryAfter { return min(retryAfter, maxRetryAfter) }
        return min(baseDelay * pow(2, Double(max(attempt, 1) - 1)), maxDelay)
    }
}

/// One project's writing assistant: its conversations, the model loop
/// (model → tool calls → results → model, bounded to `maxToolRounds`), the
/// author's review of proposals, the project's 作者规则 and each
/// conversation's working memory, task plan, compaction and usage. Main
/// thread only.
final class AgentChatController {
    static let maxToolRounds = 24
    /// Posted (object: the controller) when usage was recorded or removed.
    static let usageDidChange = Notification.Name("AgentChatController.usageDidChange")

    let projectID: String
    let projectName: String
    let store: AgentConversationStore
    let credentials: AgentCredentialStore
    let network: AgentNetwork
    let tools: AgentWorkspaceTools
    private let workspace: LabWorkspaceCore
    /// A short name of the page the author has open, e.g. 《启程》（章节）.
    var editorContext: (() -> String?)?
    var onChange: ((AgentChange) -> Void)?
    var onWorkspaceEffect: ((AgentWorkspaceEffect) -> Void)?

    private(set) var conversations: [AgentConversation] = []
    private(set) var currentID: String?
    /// The project's 作者规则, oldest first.
    private(set) var rules: [AgentAuthorRule] = []
    private(set) var isRunning = false
    private(set) var isStopping = false
    var retryPolicy = AgentRetryPolicy()
    /// How long a compaction summary may take before the trim fallback.
    var summaryTimeout: TimeInterval = 60
    /// The model's context window in tokens; the catalog's unless overridden.
    var contextWindow: ((AgentModelChoice) -> Int)?
    /// The seconds before the pending retry, while one waits.
    private(set) var retryDelay: TimeInterval?
    /// The reply being streamed, not yet in the transcript.
    private(set) var streamingText = ""
    private(set) var streamingThinking = ""
    /// 正在读取《启程》… while a tool runs; 正在思考… while waiting.
    private(set) var activity: String?
    /// Conversations shown but not yet written: new and still empty.
    private var drafts: Set<String> = []
    private var stream: AgentHTTPStream?
    private var summaryCall: AgentHTTPCall?
    private var retryWork: DispatchWorkItem?
    private var generation = 0
    private var runningID: String?
    /// The project details read at the start of the running turn.
    private var turnDetails: WorkspaceProjectDetails?

    var current: AgentConversation? { conversations.first { $0.id == currentID } }

    init(workspace: LabWorkspaceCore, projectID: String, projectName: String, credentials: AgentCredentialStore,
         network: AgentNetwork = AgentNetwork(), root: URL? = nil) {
        self.workspace = workspace
        self.projectID = projectID
        self.projectName = projectName
        self.credentials = credentials
        self.network = network
        store = AgentConversationStore(root: root ?? workspace.agentDirectory, projectID: projectID)
        tools = AgentWorkspaceTools(workspace: workspace, projectID: projectID)
        conversations = store.load()
        rules = store.loadRules()
        currentID = conversations.first?.id
    }

    private func notify(_ change: AgentChange) { onChange?(change) }

    private func index(_ id: String) -> Int? { conversations.firstIndex { $0.id == id } }

    private func update(_ id: String, save: Bool = true, _ change: (inout AgentConversation) -> Void) {
        guard let index = index(id) else { return }
        change(&conversations[index])
        if save, !drafts.contains(id) { store.save(conversations[index]) }
    }

    // MARK: Conversations

    /// A new, empty conversation keeps the current model choice. It is
    /// written once it has a message.
    @discardableResult
    func newConversation() -> AgentConversation? {
        guard !isRunning else { return nil }
        if let current, current.messages.isEmpty { return current }
        let conversation = AgentConversation(projectID: projectID, choice: current?.choice ?? .standard)
        conversations.insert(conversation, at: 0)
        drafts.insert(conversation.id)
        currentID = conversation.id
        notify(.conversations)
        return conversation
    }

    func select(_ id: String) {
        guard !isRunning, index(id) != nil, id != currentID else { return }
        // An empty draft left behind is dropped.
        if let current, drafts.contains(current.id), current.messages.isEmpty {
            conversations.removeAll { $0.id == current.id }; drafts.remove(current.id)
        }
        currentID = id
        notify(.conversations)
    }

    func rename(_ id: String, title: String) -> Bool {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, index(id) != nil else { return false }
        update(id) { $0.title = String(title.prefix(60)) }
        notify(.conversations)
        return true
    }

    /// Removes the conversation with its messages, memory, plan and usage.
    func delete(_ id: String) {
        guard !(isRunning && runningID == id), let index = index(id) else { return }
        let hadUsage = !conversations[index].usage.isEmpty
        conversations.remove(at: index)
        if drafts.remove(id) == nil { store.delete(id) }
        if currentID == id { currentID = conversations.first?.id }
        notify(.conversations)
        if hadUsage { NotificationCenter.default.post(name: Self.usageDidChange, object: self) }
    }

    /// Provider, model, thinking and effort of the current conversation.
    func setChoice(_ choice: AgentModelChoice) {
        guard !isRunning else { return }
        if current == nil { newConversation() }
        guard let id = currentID else { return }
        update(id) { $0.choice = choice.normalized() }
        notify(.conversations)
    }

    // MARK: Turns

    /// Sends the author's message and runs the loop. Returns false when
    /// nothing was sent (empty text or a turn already running).
    @discardableResult
    func send(_ text: String) -> Bool { start(text, note: nil) }

    /// 继续 is offered after the round limit stopped a turn whose plan still
    /// has unfinished steps. Nothing continues without the author.
    var canContinue: Bool {
        guard !isRunning, let conversation = current, let last = conversation.messages.last,
              last.role == .notice, last.continuable == true else { return false }
        return (conversation.plan?.unfinished ?? 0) > 0
    }

    /// A new turn that carries the plan on.
    @discardableResult
    func continueTask() -> Bool {
        guard canContinue else { return false }
        return start("继续", note: "作者点击了“继续”：请按任务计划接着完成未完成的步骤，完成或跳过的步骤不要重做。")
    }

    private func start(_ text: String, note: String?) -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isRunning, !text.isEmpty else { return false }
        if current == nil { newConversation() }
        guard let id = currentID, let conversation = current else { return false }
        let turnID = "turn-" + UUID().uuidString.lowercased()
        var message = AgentMessage(role: .user, turnID: turnID, text: text)
        var notes: [String] = []
        if let open = editorContext?(), !open.isEmpty { notes.append("作者当前打开：\(open)") }
        let outcomes = conversation.proposals.filter { !$0.reported && $0.outcome != nil }
        if !outcomes.isEmpty {
            notes.append("此前修改提案的处理结果：")
            notes += outcomes.compactMap(\.outcome).map { "- " + $0 }
        }
        let undone = conversation.messages.filter { $0.memory?.undone == true && $0.memory?.reported == false }
        if !undone.isEmpty {
            notes.append("作者撤销了你对作者规则的修改：")
            notes += undone.compactMap(\.memory?.undoneOutcome).map { "- " + $0 }
        }
        if let note { notes.append(note) }
        if !notes.isEmpty { message.context = "【运行提示】\n" + notes.joined(separator: "\n") }
        let reported = Set(outcomes.map(\.id)), told = Set(undone.map(\.id))
        drafts.remove(id)
        update(id) { conversation in
            conversation.messages.append(message)
            for index in conversation.proposals.indices where reported.contains(conversation.proposals[index].id) {
                conversation.proposals[index].reported = true
            }
            for index in conversation.messages.indices where told.contains(conversation.messages[index].id) {
                conversation.messages[index].memory?.reported = true
            }
            if conversation.title == AgentConversation.defaultTitle {
                let line = text.components(separatedBy: .newlines).first ?? text
                conversation.title = line.count > 20 ? String(line.prefix(20)) + "…" : line
            }
            conversation.updatedAt = Date()
        }
        // The newest conversation leads the list.
        if let index = index(id), index > 0 { conversations.insert(conversations.remove(at: index), at: 0) }
        generation += 1
        let run = generation
        isRunning = true; isStopping = false; runningID = id
        streamingText = ""; streamingThinking = ""; activity = "正在准备…"
        notify(.conversations)
        notify(.transcript)
        workspace.projectDetails(projectID: projectID) { [weak self] result in
            guard let self, run == self.generation else { return }
            self.turnDetails = try? result.get()
            self.round(id, turnID: turnID, number: 1, run: run)
        }
        return true
    }

    /// The system prompt of the next request: the policy and project, then
    /// the current rules, working memory and plan.
    func systemPrompt(for conversation: AgentConversation) -> String {
        AgentPrompt.system(projectName: projectName, details: turnDetails, rules: rules,
                           workingMemory: conversation.workingMemory, plan: conversation.plan)
    }

    /// Stops the running turn: a streamed reply keeps what arrived; a tool
    /// already running finishes, the rest are not run. A retry waiting for
    /// its backoff and a compaction summary stop at once.
    func stop() {
        guard isRunning, !isStopping else { return }
        isStopping = true
        activity = "正在停止…"
        notify(.streaming)
        if let retryWork, let id = runningID {
            retryWork.cancel(); self.retryWork = nil; retryDelay = nil
            finish(id, notice: "已停止。", error: false)
            return
        }
        if let summaryCall { summaryCall.cancel() }
        if let stream { stream.cancel() }
    }

    private func window(_ choice: AgentModelChoice) -> Int { contextWindow?(choice) ?? choice.option.contextWindowTokens }

    private func round(_ id: String, turnID: String, number: Int, run: Int, attempt: Int = 0, compacted: Bool = false) {
        guard run == generation, isRunning else { return }
        guard !isStopping else { finish(id, notice: "已停止。", error: false); return }
        guard number <= Self.maxToolRounds else { roundLimit(id); return }
        guard let conversation = conversations.first(where: { $0.id == id }) else { finish(id, notice: nil, error: false); return }
        let choice = conversation.choice.normalized()
        let key: String?
        do { key = try credentials.key(for: choice.provider) } catch {
            finish(id, notice: error.localizedDescription, error: true); return
        }
        guard let key, !key.isEmpty else { finish(id, notice: AgentErrors.missingKey(choice.provider).message, error: true); return }
        let request = AgentModelRequest(choice: choice, apiKey: key, system: systemPrompt(for: conversation), messages: conversation.messages,
                                        turnID: turnID, tools: AgentToolRegistry.all, sessionID: id)
        if !compacted, AgentContextBudget.estimate(request) > AgentContextBudget.limit(window: window(choice)),
           let plan = AgentCompactor.plan(conversation.messages) {
            compact(id, plan: plan, choice: choice, key: key, run: run) { [weak self] in
                self?.round(id, turnID: turnID, number: number, run: run, attempt: attempt, compacted: true)
            }
            return
        }
        streamingText = ""; streamingThinking = ""; activity = attempt > 0 ? "重试中（\(attempt)/\(retryPolicy.attempts)）…" : "正在思考…"
        notify(.streaming)
        stream = network.stream(request, onEvent: { [weak self] event in
            guard let self, run == self.generation else { return }
            switch event {
            case .text(let text): self.streamingText += text; self.activity = nil
            case .thinking(let text): self.streamingThinking += text; self.activity = "正在思考…"
            case .toolStart: self.activity = "正在准备工具调用…"
            }
            self.notify(.streaming)
        }, completion: { [weak self] result in
            guard let self, run == self.generation else { return }
            self.stream = nil
            switch result {
            case .success(let reply):
                self.recordUsage(id, choice: choice, usage: reply.usage, purpose: .reply)
                self.adopt(reply, id: id, turnID: turnID, provider: choice.provider, number: number, run: run)
            case .failure(let failure):
                if failure.responded { self.recordUsage(id, choice: choice, usage: nil, purpose: .reply) }
                if failure.kind != .cancelled, !self.isStopping, AgentRetryPolicy.retryable(failure), attempt < self.retryPolicy.attempts {
                    self.retry(id, turnID: turnID, number: number, run: run, attempt: attempt + 1, failure: failure)
                    return
                }
                self.keepPartial(id, turnID: turnID, stop: failure.kind == .cancelled ? "cancelled" : "error")
                self.finish(id, notice: failure.kind == .cancelled ? "已停止。" : failure.message, error: failure.kind != .cancelled)
            }
        })
    }

    /// Waits out the backoff, then sends the same request again. Nothing
    /// of the failed attempt was adopted, so no tool call runs twice.
    private func retry(_ id: String, turnID: String, number: Int, run: Int, attempt: Int, failure: AgentFailure) {
        let delay = retryPolicy.delay(attempt: attempt, retryAfter: failure.kind == .rateLimit || failure.kind == .server ? failure.retryAfter : nil)
        streamingText = ""; streamingThinking = ""
        retryDelay = delay
        let seconds = delay < 1 ? "片刻" : "\(Int(delay.rounded(.up))) 秒"
        activity = "重试中（\(attempt)/\(retryPolicy.attempts)）：\(failure.message) \(seconds)后重新请求…"
        notify(.streaming)
        let work = DispatchWorkItem { [weak self] in
            guard let self, run == self.generation else { return }
            self.retryWork = nil; self.retryDelay = nil
            self.round(id, turnID: turnID, number: number, run: run, attempt: attempt, compacted: true)
        }
        retryWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// The round limit: with unfinished plan steps the notice offers 继续.
    private func roundLimit(_ id: String) {
        let unfinished = conversations.first { $0.id == id }?.plan?.unfinished ?? 0
        if unfinished > 0 {
            finish(id, notice: "已连续调用工具 \(Self.maxToolRounds) 轮，本轮先停在这里。任务计划还有 \(unfinished) 步未完成，点击“继续”让写作助手接着做。",
                   error: false, continuable: true)
        } else {
            finish(id, notice: "已连续调用工具 \(Self.maxToolRounds) 轮，本轮先停在这里。可以发送“继续”让写作助手接着做。", error: false)
        }
    }

    /// Summarises the older turns with the same provider (no streaming, no
    /// tools); a failure or timeout falls back to the deterministic trim.
    private func compact(_ id: String, plan: AgentCompactor.Plan, choice: AgentModelChoice, key: String, run: Int,
                         then: @escaping () -> Void) {
        activity = "正在整理较早的对话…"
        notify(.streaming)
        let adopt = { [weak self] (summary: String?) in
            guard let self, run == self.generation, self.isRunning else { return }
            guard !self.isStopping else { self.finish(id, notice: "已停止。", error: false); return }
            let proposals = self.conversations.first { $0.id == id }?.proposals ?? []
            let compaction: AgentCompaction
            if let summary, !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                compaction = AgentCompaction(through: plan.through, summary: AgentCompactor.summarized(summary, proposals: proposals),
                                             method: .summary, messages: plan.count)
            } else {
                compaction = AgentCompaction(through: plan.through, summary: AgentCompactor.trimmed(plan, proposals: proposals),
                                             method: .trim, messages: plan.count)
            }
            var marker = AgentMessage(role: .notice, turnID: "", text: compaction.method == .summary
                ? "已压缩较早的对话：\(plan.count) 条消息整理成了摘要。"
                : "已压缩较早的对话：摘要没有生成，已按规则裁剪较早的 \(plan.count) 条消息。")
            marker.compaction = compaction
            self.update(id) { $0.messages.append(marker); $0.updatedAt = Date() }
            self.notify(.transcript)
            then()
        }
        let request: URLRequest
        do {
            request = try AgentDriver.summaryRequest(choice: choice, apiKey: key, system: AgentCompactor.summarySystem, prompt: AgentCompactor.prompt(plan))
        } catch { adopt(nil); return }
        summaryCall = network.complete(request, provider: choice.provider, timeout: summaryTimeout) { [weak self] result in
            guard let self, run == self.generation else { return }
            self.summaryCall = nil
            switch result {
            case .success(let reply):
                self.recordUsage(id, choice: choice, usage: reply.usage, purpose: .summary)
                adopt(reply.text)
            case .failure(let failure):
                if failure.responded { self.recordUsage(id, choice: choice, usage: nil, purpose: .summary) }
                adopt(nil)
            }
        }
    }

    /// One request's reported token counts; nil counts stay unknown.
    private func recordUsage(_ id: String, choice: AgentModelChoice, usage: AgentUsage?, purpose: AgentUsageRecord.Purpose) {
        let record = AgentUsageRecord(provider: choice.provider, model: choice.model, purpose: purpose, usage: usage)
        update(id) { $0.usage.append(record) }
        NotificationCenter.default.post(name: Self.usageDidChange, object: self)
    }

    /// A stopped or failed reply keeps the text that already arrived.
    private func keepPartial(_ id: String, turnID: String, stop: String) {
        guard !streamingText.isEmpty else { return }
        var message = AgentMessage(role: .assistant, turnID: turnID, text: streamingText)
        message.thinking = streamingThinking.isEmpty ? nil : streamingThinking
        message.stop = stop
        update(id) { $0.messages.append(message) }
    }

    private func adopt(_ reply: AgentModelResult, id: String, turnID: String, provider: AgentProviderID, number: Int, run: Int) {
        var message = AgentMessage(role: .assistant, turnID: turnID, text: reply.text)
        message.thinking = reply.thinking.isEmpty ? nil : reply.thinking
        message.toolCalls = reply.toolCalls.isEmpty ? nil : reply.toolCalls
        message.replay = reply.replay.map { AgentReplay(provider: provider, value: $0) }
        message.usage = reply.usage
        message.stop = reply.stop.rawValue
        streamingText = ""; streamingThinking = ""
        update(id) { $0.messages.append(message); $0.updatedAt = Date() }
        notify(.transcript)
        if !reply.toolCalls.isEmpty {
            runTools(reply.toolCalls, at: 0, id: id, turnID: turnID, number: number, run: run)
        } else if reply.stop == .maxTokens {
            finish(id, notice: "回复达到了长度上限，已被截断。", error: false)
        } else if reply.stop == .contentFilter {
            finish(id, notice: "回复被模型服务的内容策略拦截。", error: true)
        } else {
            finish(id, notice: nil, error: false)
        }
    }

    private func runTools(_ calls: [AgentToolCall], at position: Int, id: String, turnID: String, number: Int, run: Int) {
        guard run == generation, isRunning else { return }
        // Memory tools change only the assistant's memory, at once.
        if position < calls.count, !isStopping, AgentMemoryTools.names.contains(calls[position].name) {
            runMemoryTool(calls[position], id: id, turnID: turnID)
            runTools(calls, at: position + 1, id: id, turnID: turnID, number: number, run: run)
            return
        }
        guard position < calls.count else { round(id, turnID: turnID, number: number + 1, run: run); return }
        if isStopping {
            update(id) { conversation in
                for call in calls[position...] {
                    var result = AgentMessage(role: .tool, turnID: turnID, text: "作者停止了本轮，这个工具没有执行。")
                    result.callID = call.id; result.toolName = call.name; result.ok = false
                    conversation.messages.append(result)
                }
            }
            finish(id, notice: "已停止。", error: false)
            return
        }
        let call = calls[position]
        activity = AgentWorkspaceTools.progress(call)
        notify(.streaming)
        tools.run(call, turnID: turnID) { [weak self] outcome in
            guard let self, run == self.generation else { return }
            var result = AgentMessage(role: .tool, turnID: turnID, text: outcome.content)
            result.callID = call.id; result.toolName = call.name; result.ok = outcome.ok; result.activity = outcome.activity
            result.proposalID = outcome.proposal?.id
            self.update(id) { conversation in
                if let proposal = outcome.proposal { conversation.proposals.append(proposal) }
                conversation.messages.append(result)
                conversation.updatedAt = Date()
            }
            self.notify(.transcript)
            self.runTools(calls, at: position + 1, id: id, turnID: turnID, number: number, run: run)
        }
    }

    private func runMemoryTool(_ call: AgentToolCall, id: String, turnID: String) {
        var result: AgentMemoryTools.Result
        var rules = self.rules
        switch AgentWorkspaceTools.validated(call) {
        case .failure(let refusal): result = AgentMemoryTools.Result(outcome: refusal.outcome)
        case .success(let arguments):
            guard let index = index(id) else { return }
            var conversation = conversations[index]
            result = AgentMemoryTools.run(call, arguments, rules: &rules, conversation: &conversation)
            conversations[index].workingMemory = conversation.workingMemory
            conversations[index].workingMemoryUpdatedAt = conversation.workingMemoryUpdatedAt
            conversations[index].workingMemoryUpdatedBy = conversation.workingMemoryUpdatedBy
            conversations[index].plan = conversation.plan
        }
        var message = AgentMessage(role: .tool, turnID: turnID, text: result.outcome.content)
        message.callID = call.id; message.toolName = call.name; message.ok = result.outcome.ok; message.activity = result.outcome.activity
        message.memory = result.change
        update(id) { $0.messages.append(message); $0.updatedAt = Date() }
        if result.rulesChanged { setRules(rules) }
        notify(.transcript)
    }

    private func setRules(_ next: [AgentAuthorRule]) {
        rules = next
        store.saveRules(next)
        notify(.rules)
    }

    private func finish(_ id: String, notice: String?, error: Bool, continuable: Bool = false) {
        if let notice {
            var message = AgentMessage(role: .notice, turnID: "", text: notice)
            message.isError = error
            if continuable { message.continuable = true }
            update(id) { $0.messages.append(message); $0.updatedAt = Date() }
        }
        stream = nil; summaryCall = nil
        retryWork?.cancel(); retryWork = nil; retryDelay = nil
        isRunning = false; isStopping = false; runningID = nil
        streamingText = ""; streamingThinking = ""; activity = nil
        notify(.transcript)
        notify(.streaming)
    }

    // MARK: Review

    /// Applies a pending proposal through Rust. A transient refusal (the
    /// author is typing) leaves it pending with the reason.
    func accept(_ proposalID: String) {
        guard let id = currentID, let proposal = current?.proposal(proposalID), proposal.state == .pending else { return }
        setProposal(id, proposalID) { $0.state = .applying; $0.message = nil }
        tools.apply(proposal, sessionID: id) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let outcome):
                self.setProposal(id, proposalID) { proposal in
                    proposal.state = .accepted; proposal.message = outcome.message; proposal.decidedAt = Date(); proposal.reported = false
                    proposal.partial = outcome.partial ? true : nil
                    if case .chapter(let chapter, _, _) = outcome { proposal.targetID = chapter.id }
                    if case .domain(_, let created?, _, _) = outcome { proposal.targetID = created }
                }
                switch outcome {
                case .prose(_, let live, _):
                    self.onWorkspaceEffect?(.prose(projectID: self.projectID, kind: proposal.targetKind ?? "chapter",
                                                   id: proposal.targetID ?? "", live: live))
                case .chapter(let chapter, _, _): self.onWorkspaceEffect?(.chapterCreated(projectID: self.projectID, chapter: chapter))
                case .metadata(let metadata): self.onWorkspaceEffect?(.nodeMetadata(projectID: self.projectID, metadata: metadata))
                case .domain(_, _, _, let effects): effects.forEach { self.onWorkspaceEffect?($0) }
                }
            case .failure(let refusal) where refusal.transient:
                self.setProposal(id, proposalID) { $0.state = .pending; $0.message = refusal.message }
            case .failure(let refusal):
                self.setProposal(id, proposalID) { $0.state = .failed; $0.message = refusal.message; $0.decidedAt = Date(); $0.reported = false }
            }
        }
    }

    func reject(_ proposalID: String) {
        guard let id = currentID, current?.proposal(proposalID)?.state == .pending else { return }
        setProposal(id, proposalID) { $0.state = .rejected; $0.message = nil; $0.decidedAt = Date(); $0.reported = false }
    }

    private func setProposal(_ id: String, _ proposalID: String, _ change: (inout AgentProposal) -> Void) {
        update(id) { conversation in
            guard let index = conversation.proposals.firstIndex(where: { $0.id == proposalID }) else { return }
            change(&conversation.proposals[index])
        }
        notify(.transcript)
    }

    // MARK: Memory

    /// 撤销 on a rule card: the rule change is reverted and the model is told
    /// in the author's next turn.
    func undoMemory(_ messageID: String) {
        guard let id = currentID, let change = current?.messages.first(where: { $0.id == messageID })?.memory, change.undone != true else { return }
        var next = rules
        AgentMemoryTools.undo(change, rules: &next)
        update(id) { conversation in
            guard let index = conversation.messages.firstIndex(where: { $0.id == messageID }) else { return }
            conversation.messages[index].memory?.undone = true
            conversation.messages[index].memory?.reported = false
        }
        setRules(next)
        notify(.transcript)
    }

    /// The author adds a rule in the panel. Returns why it was refused.
    @discardableResult
    func addRule(kind: AgentAuthorRule.Kind, text: String) -> String? {
        let text = AgentAuthorRules.normalized(text)
        if let refusal = AgentAuthorRules.refusal(text, kind: kind, in: rules, except: nil) { return refusal }
        setRules(rules + [AgentAuthorRule(kind: kind, text: text, source: "author")])
        return nil
    }

    @discardableResult
    func updateRule(_ ruleID: String, kind: AgentAuthorRule.Kind, text: String) -> String? {
        guard let index = rules.firstIndex(where: { $0.id == ruleID }) else { return "这条规则已经不存在。" }
        let text = AgentAuthorRules.normalized(text)
        if let refusal = AgentAuthorRules.refusal(text, kind: kind, in: rules, except: ruleID) { return refusal }
        guard rules[index].kind != kind || rules[index].text != text else { return nil }
        var next = rules
        next[index].kind = kind; next[index].text = text; next[index].updatedAt = Date(); next[index].source = "author"
        setRules(next)
        return nil
    }

    func deleteRule(_ ruleID: String) {
        guard rules.contains(where: { $0.id == ruleID }) else { return }
        setRules(rules.filter { $0.id != ruleID })
    }

    /// The author replaces or clears the current conversation's working
    /// memory. Returns why it was refused.
    @discardableResult
    func setWorkingMemory(_ text: String) -> String? {
        guard let id = currentID else { return "请先选择一个对话。" }
        let text = AgentWorkingMemory.normalized(text)
        if let refusal = AgentWorkingMemory.refusal(text) { return refusal }
        update(id) { conversation in
            conversation.workingMemory = text
            conversation.workingMemoryUpdatedAt = Date(); conversation.workingMemoryUpdatedBy = "author"
        }
        notify(.transcript)
        return nil
    }
}
