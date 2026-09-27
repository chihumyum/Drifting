import Foundation

/// A durable change an accepted proposal made; views that list or show it follow.
enum AgentWorkspaceEffect {
    /// A body was revised. `live` when its open owner adopted the revision.
    case prose(projectID: String, kind: String, id: String, live: Bool)
    case chapterCreated(projectID: String, chapter: WorkspaceChapter)
    case nodeMetadata(projectID: String, metadata: WorkspaceNodeMetadata)
}

enum AgentChange {
    /// The conversation list or the selection changed.
    case conversations
    /// The current conversation's messages or proposals changed.
    case transcript
    /// The streamed reply or the running activity changed.
    case streaming
}

/// One project's writing assistant: its conversations, the model loop
/// (model → tool calls → results → model, bounded to `maxToolRounds`) and the
/// author's review of proposals. Main thread only.
final class AgentChatController {
    static let maxToolRounds = 24

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
    private(set) var isRunning = false
    private(set) var isStopping = false
    /// The reply being streamed, not yet in the transcript.
    private(set) var streamingText = ""
    private(set) var streamingThinking = ""
    /// 正在读取《启程》… while a tool runs; 正在思考… while waiting.
    private(set) var activity: String?
    /// Conversations shown but not yet written: new and still empty.
    private var drafts: Set<String> = []
    private var stream: AgentHTTPStream?
    private var generation = 0
    private var runningID: String?
    private var turnSystem = ""

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

    func delete(_ id: String) {
        guard !(isRunning && runningID == id), let index = index(id) else { return }
        conversations.remove(at: index)
        if drafts.remove(id) == nil { store.delete(id) }
        if currentID == id { currentID = conversations.first?.id }
        notify(.conversations)
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
    func send(_ text: String) -> Bool {
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
        if !notes.isEmpty { message.context = "【运行提示】\n" + notes.joined(separator: "\n") }
        let reported = Set(outcomes.map(\.id))
        drafts.remove(id)
        update(id) { conversation in
            conversation.messages.append(message)
            for index in conversation.proposals.indices where reported.contains(conversation.proposals[index].id) {
                conversation.proposals[index].reported = true
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
            self.turnSystem = AgentPrompt.system(projectName: self.projectName, details: try? result.get())
            self.round(id, turnID: turnID, number: 1, run: run)
        }
        return true
    }

    /// Stops the running turn: a streamed reply keeps what arrived; a tool
    /// already running finishes, the rest are not run.
    func stop() {
        guard isRunning, !isStopping else { return }
        isStopping = true
        activity = "正在停止…"
        notify(.streaming)
        if let stream { stream.cancel() }
    }

    private func round(_ id: String, turnID: String, number: Int, run: Int) {
        guard run == generation, isRunning else { return }
        guard !isStopping else { finish(id, notice: "已停止。", error: false); return }
        guard number <= Self.maxToolRounds else {
            finish(id, notice: "已连续调用工具 \(Self.maxToolRounds) 轮，本轮先停在这里。可以发送“继续”让写作助手接着做。", error: false)
            return
        }
        guard let conversation = conversations.first(where: { $0.id == id }) else { finish(id, notice: nil, error: false); return }
        let choice = conversation.choice.normalized()
        let key: String?
        do { key = try credentials.key(for: choice.provider) } catch {
            finish(id, notice: error.localizedDescription, error: true); return
        }
        guard let key, !key.isEmpty else { finish(id, notice: AgentErrors.missingKey(choice.provider).message, error: true); return }
        let request = AgentModelRequest(choice: choice, apiKey: key, system: turnSystem, messages: conversation.messages,
                                        turnID: turnID, tools: AgentToolRegistry.all, sessionID: id)
        streamingText = ""; streamingThinking = ""; activity = "正在思考…"
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
            case .success(let reply): self.adopt(reply, id: id, turnID: turnID, provider: choice.provider, number: number, run: run)
            case .failure(let failure):
                self.keepPartial(id, turnID: turnID, stop: failure.kind == .cancelled ? "cancelled" : "error")
                self.finish(id, notice: failure.kind == .cancelled ? "已停止。" : failure.message, error: failure.kind != .cancelled)
            }
        })
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

    private func finish(_ id: String, notice: String?, error: Bool) {
        if let notice {
            var message = AgentMessage(role: .notice, turnID: "", text: notice)
            message.isError = error
            update(id) { $0.messages.append(message); $0.updatedAt = Date() }
        }
        stream = nil
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
                }
                switch outcome {
                case .prose(_, let live, _):
                    self.onWorkspaceEffect?(.prose(projectID: self.projectID, kind: proposal.targetKind ?? "chapter",
                                                   id: proposal.targetID ?? "", live: live))
                case .chapter(let chapter, _, _): self.onWorkspaceEffect?(.chapterCreated(projectID: self.projectID, chapter: chapter))
                case .metadata(let metadata): self.onWorkspaceEffect?(.nodeMetadata(projectID: self.projectID, metadata: metadata))
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
}
