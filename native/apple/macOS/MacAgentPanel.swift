import AppKit

/// 写作助手: the right-side panel of the window. A conversation picker, the
/// provider/model/thinking picker, 作者规则, 工作记忆 and 任务计划, the
/// streamed transcript with tool activity, proposal and memory cards, and a
/// composer (⌘↩ sends) with 停止 and 继续. Sections are set apart by wash,
/// spacing and type weight only.
final class MacAgentPanelView: NSView {
    private(set) var controller: AgentChatController?
    let conversationPopup = NSPopUpButton()
    let newButton = NSButton(title: "新对话", target: nil, action: nil)
    let renameButton = NSButton(title: "重命名…", target: nil, action: nil)
    let deleteButton = NSButton(title: "删除…", target: nil, action: nil)
    let settingsButton = NSButton(title: "设置…", target: nil, action: nil)
    let providerPopup = NSPopUpButton()
    let modelPopup = NSPopUpButton()
    let thinkingPopup = NSPopUpButton()
    let effortPopup = NSPopUpButton()
    let composer = AgentComposerTextView()
    let sendButton = NSButton(title: "发送", target: nil, action: nil)
    let stopButton = NSButton(title: "停止", target: nil, action: nil)
    /// Ends the turn once the running tool returns.
    let stopAfterToolButton = NSButton(title: "在当前工具后停止", target: nil, action: nil)
    /// Tokens the latest request used against the model's context window.
    let contextLabel = NSTextField(labelWithString: "")
    /// Max · 1M 上下文 for models that declare a 1M window.
    let maxContextCheckbox = NSButton(checkboxWithTitle: "Max · 1M 上下文", target: nil, action: nil)
    /// 听写: records, transcribes and inserts into the composer.
    let micButton = NSButton(title: "听写", target: nil, action: nil)
    let dictationLabel = NSTextField(labelWithString: "")
    let dictationRetryButton = NSButton(title: "重试", target: nil, action: nil)
    /// 放弃: gives up the pieces kept for 重试.
    let dictationDiscardButton = NSButton(title: "放弃", target: nil, action: nil)
    let dictationSetupButton = NSButton(title: "设置…", target: nil, action: nil)
    private let dictationRow = NSStackView()
    /// The composer's dictation, set by the owner; nil hides the button.
    var dictation: VoiceDictation? { didSet { bindDictation() } }
    /// Opens 设置 › 模型服务 (the transcription key).
    var onOpenSpeechSettings: (() -> Void)?
    /// Shown after the round limit stopped a turn with unfinished plan steps.
    let continueButton = NSButton(title: "继续", target: nil, action: nil)
    let memorySections = AgentMemorySectionsView()
    /// The running activity, or how to send.
    let statusLabel = NSTextField(labelWithString: "")
    private let emptyLabel = NSTextField(wrappingLabelWithString: "")
    private let transcript = NSStackView()
    private let scroll = NSScrollView()
    private let documentView = AgentFlippedView()
    private var streamingRow: AgentMessageRow?
    /// 补充 queued for the model's next call, after the streamed row.
    private var queuedRows: [NSView] = []
    /// What the transcript shows: its conversation, messages in order and
    /// each shown proposal as drawn. Appends and proposal changes update
    /// only the rows they touch.
    private var rendered: Rendered?
    private struct Rendered {
        let conversation: String
        let messages: [String]
        var proposals: [String: AgentProposal]
        /// Rule cards by message, as drawn.
        var memories: [String: AgentMemoryChange]
        /// MCP and memory approval cards by message, as drawn, and whether
        /// each could still be answered.
        var approvals: [String: ApprovalDrawn]
        /// Question cards by message, as drawn.
        var questions: [String: QuestionDrawn]
    }
    private struct QuestionDrawn: Equatable {
        let question: AgentQuestion
        let answerable: Bool
    }
    private struct ApprovalDrawn: Equatable {
        let invocation: AgentMcpInvocation?
        let memory: AgentMemoryApproval?
        let answerable: Bool
    }
    /// Alerts are sheets on the window by default; acceptance answers them directly.
    var presentAlert: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
    var onOpenSettings: (() -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        setAccessibilityIdentifier("agent-panel")
        setAccessibilityLabel("写作助手")
        build()
        reload()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func build() {
        let title = NSTextField(labelWithString: "写作助手")
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        conversationPopup.target = self; conversationPopup.action = #selector(pickConversation)
        conversationPopup.setAccessibilityIdentifier("agent-conversations")
        conversationPopup.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        for (button, id, action) in [(newButton, "agent-new-conversation", #selector(newConversation)),
                                     (renameButton, "agent-rename-conversation", #selector(renameConversation)),
                                     (deleteButton, "agent-delete-conversation", #selector(deleteConversation)),
                                     (settingsButton, "agent-settings", #selector(openSettings)),
                                     (sendButton, "agent-send", #selector(send)),
                                     (stopButton, "agent-stop", #selector(stop)),
                                     (stopAfterToolButton, "agent-stop-after-tool", #selector(stopAfterTool)),
                                     (micButton, "agent-dictation", #selector(toggleDictation)),
                                     (dictationRetryButton, "agent-dictation-retry", #selector(retryDictation)),
                                     (dictationDiscardButton, "agent-dictation-discard", #selector(discardDictationPieces)),
                                     (dictationSetupButton, "agent-dictation-setup", #selector(openSpeechSettings)),
                                     (continueButton, "agent-continue", #selector(continueTask))] {
            button.target = self; button.action = action
            button.setAccessibilityIdentifier(id)
            button.bezelStyle = .rounded; button.controlSize = .small
            button.font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
        }
        for (popup, id, action) in [(providerPopup, "agent-provider", #selector(pickProvider)), (modelPopup, "agent-model", #selector(pickModel)),
                                    (thinkingPopup, "agent-thinking", #selector(pickThinking)), (effortPopup, "agent-effort", #selector(pickEffort))] {
            popup.target = self; popup.action = action
            popup.setAccessibilityIdentifier(id)
            popup.controlSize = .small; popup.font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
        }
        providerPopup.toolTip = "模型服务"; modelPopup.toolTip = "模型"; thinkingPopup.toolTip = "思考"; effortPopup.toolTip = "思考强度"
        // Thinking modes a model lacks stay listed but disabled.
        thinkingPopup.autoenablesItems = false
        let header = NSStackView(views: [title, NSView(), settingsButton])
        let conversationRow = NSStackView(views: [conversationPopup, newButton])
        conversationRow.spacing = 6
        let manageRow = NSStackView(views: [renameButton, deleteButton])
        manageRow.spacing = 6
        let modelRow = NSStackView(views: [providerPopup, modelPopup])
        modelRow.spacing = 6
        let reasoningRow = NSStackView(views: [thinkingPopup, effortPopup])
        reasoningRow.spacing = 6
        contextLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        contextLabel.textColor = .secondaryLabelColor
        contextLabel.lineBreakMode = .byTruncatingTail
        contextLabel.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        contextLabel.setAccessibilityIdentifier("agent-context")
        maxContextCheckbox.target = self; maxContextCheckbox.action = #selector(pickMaxContext)
        maxContextCheckbox.controlSize = .small
        maxContextCheckbox.font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
        maxContextCheckbox.setAccessibilityIdentifier("agent-max-context")
        let contextRow = NSStackView(views: [contextLabel, NSView(), maxContextCheckbox])
        contextRow.spacing = 6

        transcript.orientation = .vertical; transcript.alignment = .leading; transcript.spacing = 10
        transcript.translatesAutoresizingMaskIntoConstraints = false
        transcript.setAccessibilityIdentifier("agent-transcript")
        documentView.translatesAutoresizingMaskIntoConstraints = false
        documentView.addSubview(transcript)
        scroll.hasVerticalScroller = true; scroll.drawsBackground = false; scroll.borderType = .noBorder
        scroll.documentView = documentView
        emptyLabel.textColor = .secondaryLabelColor
        emptyLabel.font = .systemFont(ofSize: 12)

        composer.isRichText = false
        composer.allowsUndo = true
        composer.font = .systemFont(ofSize: 13)
        composer.isVerticallyResizable = true
        composer.autoresizingMask = [.width]
        composer.textContainer?.widthTracksTextView = true
        composer.textContainerInset = NSSize(width: 4, height: 6)
        composer.minSize = NSSize(width: 0, height: 72)
        composer.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        composer.setAccessibilityIdentifier("agent-composer")
        composer.setAccessibilityLabel("给写作助手的消息")
        composer.onSubmit = { [weak self] in self?.send() }
        composer.onChange = { [weak self] in self?.updateControls() }
        let composerScroll = NSScrollView()
        composerScroll.hasVerticalScroller = true; composerScroll.borderType = .bezelBorder
        composerScroll.documentView = composer
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.font = .systemFont(ofSize: 11)
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        statusLabel.setAccessibilityIdentifier("agent-status")
        sendButton.keyEquivalent = ""
        continueButton.toolTip = "按任务计划开始新的一轮"
        continueButton.isHidden = true
        stopButton.toolTip = "立即停止：正在生成的回复保留已收到的部分，正在运行的工具完成后其余工具不再执行"
        stopAfterToolButton.toolTip = "让正在运行的工具安全完成后结束本轮，不再调用模型或其他工具"
        stopAfterToolButton.isHidden = true
        micButton.image = NSImage(systemSymbolName: "mic", accessibilityDescription: "听写")
        micButton.imagePosition = .imageLeading
        micButton.toolTip = "听写：录音后转写到输入框，并按本项目的设定名校正专有名词"
        micButton.isHidden = true
        dictationLabel.font = .systemFont(ofSize: 11)
        dictationLabel.textColor = .secondaryLabelColor
        dictationLabel.lineBreakMode = .byTruncatingTail
        dictationLabel.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        dictationLabel.setAccessibilityIdentifier("agent-dictation-status")
        for view in [dictationLabel, NSView(), dictationRetryButton, dictationDiscardButton, dictationSetupButton] { dictationRow.addArrangedSubview(view) }
        dictationRow.spacing = 6
        dictationRow.isHidden = true
        memorySections.present = { [weak self] alert, done in self?.present(alert, done) }
        let footer = NSStackView(views: [micButton, statusLabel, NSView(), stopAfterToolButton, stopButton, continueButton, sendButton])
        footer.spacing = 6

        let stack = NSStackView(views: [header, conversationRow, manageRow, modelRow, reasoningRow, contextRow, memorySections, scroll,
                                        composerScroll, dictationRow, footer])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.setCustomSpacing(6, after: reasoningRow)
        stack.setCustomSpacing(12, after: contextRow)
        stack.setCustomSpacing(12, after: memorySections)
        stack.setCustomSpacing(10, after: scroll)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
            header.widthAnchor.constraint(equalTo: stack.widthAnchor),
            conversationRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            modelRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            reasoningRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            contextRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            dictationRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            memorySections.widthAnchor.constraint(equalTo: stack.widthAnchor),
            providerPopup.widthAnchor.constraint(equalToConstant: 104),
            thinkingPopup.widthAnchor.constraint(equalToConstant: 118),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 180),
            composerScroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            composerScroll.heightAnchor.constraint(equalToConstant: 76),
            footer.widthAnchor.constraint(equalTo: stack.widthAnchor),
            documentView.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            documentView.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
            documentView.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            transcript.leadingAnchor.constraint(equalTo: documentView.leadingAnchor),
            transcript.trailingAnchor.constraint(equalTo: documentView.trailingAnchor, constant: -4),
            transcript.topAnchor.constraint(equalTo: documentView.topAnchor),
            transcript.bottomAnchor.constraint(equalTo: documentView.bottomAnchor, constant: -4),
        ])
    }

    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        // A quiet wash sets the panel apart from the editor.
        layer?.backgroundColor = NSColor.secondaryLabelColor.withAlphaComponent(0.05).cgColor
        layer?.cornerRadius = 10
    }

    /// Shows one project's assistant, or nothing without a project.
    func bind(_ controller: AgentChatController?) {
        self.controller?.onChange = nil
        self.controller = controller
        memorySections.controller = controller
        controller?.onChange = { [weak self] change in
            guard let self else { return }
            switch change {
            case .conversations, .transcript: self.reload()
            case .streaming: self.updateStreaming()
            case .rules: self.memorySections.reloadRules()
            }
        }
        memorySections.reloadRules()
        reload()
    }

    // MARK: Rendering

    func reload() {
        reloadConversations()
        reloadChoice()
        updateContext()
        memorySections.reloadConversation()
        if let controller, let conversation = controller.current, let rendered, rendered.conversation == conversation.id,
           !rendered.messages.isEmpty, conversation.messages.count >= rendered.messages.count,
           zip(rendered.messages, conversation.messages).allSatisfy({ $0 == $1.id }) {
            update(conversation, from: rendered)
        } else {
            rebuild()
        }
        updateStreaming()
        scrollToEnd()
    }

    private func rebuild() {
        for child in transcript.arrangedSubviews { transcript.removeArrangedSubview(child); child.removeFromSuperview() }
        streamingRow = nil
        queuedRows = []
        rendered = nil
        guard let controller else {
            emptyLabel.stringValue = "选择一个项目后，写作助手会在这里工作。"
            add(emptyLabel)
            return
        }
        let conversation = controller.current
        let messages = conversation?.messages ?? []
        if messages.isEmpty {
            emptyLabel.stringValue = "向写作助手提问，或请它修改正文。它提出的每处修改都会先显示在这里，由你接受或拒绝。"
            add(emptyLabel)
        }
        var shown: [String: AgentProposal] = [:]
        if let conversation {
            for message in messages { rows(for: message, in: conversation, shown: &shown).forEach(add) }
            rendered = Rendered(conversation: conversation.id, messages: messages.map(\.id), proposals: shown,
                                memories: Self.memories(conversation.messages), approvals: approvals(conversation.messages),
                                questions: questions(conversation.messages))
        }
        addStreamingRow()
    }

    private func questions(_ messages: [AgentMessage]) -> [String: QuestionDrawn] {
        Dictionary(messages.compactMap { message in
            message.question.map { (message.id, QuestionDrawn(question: $0, answerable: controller?.waitingQuestion == message.id)) }
        }, uniquingKeysWith: { first, _ in first })
    }

    private func questionCard(_ messageID: String, _ question: AgentQuestion) -> AgentQuestionCard {
        let answerable = controller?.waitingQuestion == messageID && question.state == .waiting
        return AgentQuestionCard(messageID: messageID, question: question, answerable: answerable) { [weak self] answer in
            self?.controller?.answerQuestion(messageID, answer: answer)
        }
    }

    private func approvals(_ messages: [AgentMessage]) -> [String: ApprovalDrawn] {
        Dictionary(messages.compactMap { message in
            guard message.mcp != nil || message.memoryApproval != nil else { return nil }
            return (message.id, ApprovalDrawn(invocation: message.mcp, memory: message.memoryApproval,
                                              answerable: controller?.waitingApproval == message.id))
        }, uniquingKeysWith: { first, _ in first })
    }

    private static func memories(_ messages: [AgentMessage]) -> [String: AgentMemoryChange] {
        Dictionary(messages.compactMap { message in message.memory.map { (message.id, $0) } }, uniquingKeysWith: { first, _ in first })
    }

    private func replace(_ identifier: String, with view: NSView) {
        guard let old = transcript.arrangedSubviews.first(where: { $0.accessibilityIdentifier() == identifier }),
              let index = transcript.arrangedSubviews.firstIndex(of: old) else { return }
        transcript.insertArrangedSubview(view, at: index)
        view.widthAnchor.constraint(equalTo: transcript.widthAnchor).isActive = true
        transcript.removeArrangedSubview(old); old.removeFromSuperview()
    }

    /// Appends rows for new messages and redraws proposals and rule cards
    /// that changed.
    private func update(_ conversation: AgentConversation, from previous: Rendered) {
        var shown = previous.proposals
        for (id, drawn) in previous.proposals {
            guard let proposal = conversation.proposal(id), proposal != drawn else { continue }
            replace("agent-proposal-\(id)", with: card(proposal))
            shown[id] = proposal
        }
        for message in conversation.messages.prefix(previous.messages.count) {
            guard let change = message.memory, previous.memories[message.id] != change else { continue }
            replace("agent-memory-\(message.id)", with: memoryCard(message.id, change))
        }
        let drawn = approvals(conversation.messages)
        for (id, approval) in drawn where previous.approvals[id] != nil && previous.approvals[id] != approval {
            if let invocation = approval.invocation { replace("agent-mcp-approval-\(id)", with: approvalCard(id, invocation)) }
            if let memory = approval.memory { replace("agent-memory-approval-\(id)", with: memoryApprovalCard(id, memory)) }
        }
        let asked = questions(conversation.messages)
        for (id, drawnQuestion) in asked where previous.questions[id] != nil && previous.questions[id] != drawnQuestion {
            replace("agent-question-\(id)", with: questionCard(id, drawnQuestion.question))
        }
        removeQueuedRows()
        if let streamingRow { transcript.removeArrangedSubview(streamingRow); streamingRow.removeFromSuperview(); self.streamingRow = nil }
        for message in conversation.messages.dropFirst(previous.messages.count) {
            rows(for: message, in: conversation, shown: &shown).forEach(add)
        }
        rendered = Rendered(conversation: conversation.id, messages: conversation.messages.map(\.id), proposals: shown,
                            memories: Self.memories(conversation.messages), approvals: drawn, questions: asked)
        addStreamingRow()
    }

    private func memoryCard(_ messageID: String, _ change: AgentMemoryChange) -> AgentMemoryCard {
        AgentMemoryCard(messageID: messageID, change: change) { [weak self] in self?.controller?.undoMemory(messageID) }
    }

    private func approvalCard(_ messageID: String, _ invocation: AgentMcpInvocation) -> AgentMcpApprovalCard {
        let answerable = controller?.waitingApproval == messageID && invocation.state == .waiting
        return AgentMcpApprovalCard(messageID: messageID, invocation: invocation, answerable: answerable,
                                    allow: { [weak self] in self?.controller?.decideApproval(messageID, allow: true) },
                                    deny: { [weak self] in self?.controller?.decideApproval(messageID, allow: false) })
    }

    private func memoryApprovalCard(_ messageID: String, _ request: AgentMemoryApproval) -> AgentMemoryApprovalCard {
        let answerable = controller?.waitingApproval == messageID && request.state == .waiting
        return AgentMemoryApprovalCard(messageID: messageID, request: request, answerable: answerable,
                                       allow: { [weak self] in self?.controller?.decideApproval(messageID, allow: true) },
                                       deny: { [weak self] in self?.controller?.decideApproval(messageID, allow: false) })
    }

    private func rows(for message: AgentMessage, in conversation: AgentConversation, shown: inout [String: AgentProposal]) -> [NSView] {
        switch message.role {
        case .user:
            return [AgentMessageRow(identifier: "agent-message-\(message.id)", heading: message.steer == true ? "你（补充）" : "你",
                                    text: message.text, markdown: false, wash: true)]
        case .assistant:
            guard !message.text.isEmpty else { return [] }
            return [AgentMessageRow(identifier: "agent-message-\(message.id)", heading: nil, text: message.text, markdown: true, wash: false)]
        case .tool:
            if let change = message.memory { return [memoryCard(message.id, change)] }
            var views: [NSView] = []
            if let activity = message.activity {
                views.append(AgentActivityRow(identifier: "agent-activity-\(message.callID ?? message.id)", text: activity, failed: message.ok == false))
            }
            if let id = message.proposalID, let proposal = conversation.proposal(id), shown[id] == nil {
                shown[id] = proposal
                views.append(card(proposal))
            }
            return views
        case .notice:
            if let question = message.question { return [questionCard(message.id, question)] }
            if let invocation = message.mcp { return [approvalCard(message.id, invocation)] }
            if let request = message.memoryApproval { return [memoryApprovalCard(message.id, request)] }
            if let compaction = message.compaction {
                let row = AgentActivityRow(identifier: "agent-compaction-\(message.id)", text: message.text, failed: false)
                row.toolTip = compaction.summary
                return [row]
            }
            return [AgentActivityRow(identifier: "agent-notice-\(message.id)", text: message.text, failed: message.isError == true)]
        }
    }

    private func card(_ proposal: AgentProposal) -> AgentProposalCard {
        let id = proposal.id
        return AgentProposalCard(proposal: proposal, accept: { [weak self] in self?.controller?.accept(id) },
                                 reject: { [weak self] in self?.controller?.reject(id) })
    }

    private func addStreamingRow() {
        guard controller?.isRunning == true else { return }
        let row = AgentMessageRow(identifier: "agent-streaming", heading: nil, text: "", markdown: true, wash: false)
        streamingRow = row
        add(row)
    }

    private func add(_ view: NSView) {
        transcript.addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: transcript.widthAnchor).isActive = true
    }

    /// Only the streamed row, the queued 补充 and the status line change per delta.
    func updateStreaming() {
        if let controller, let row = streamingRow {
            let text = controller.streamingText
            row.show(text.isEmpty ? (controller.streamingThinking.isEmpty ? "" : "（正在思考…）") : text, markdown: true)
            row.isHidden = text.isEmpty && controller.streamingThinking.isEmpty
        }
        showQueuedSteers()
        // 补充 a turn did not deliver go back into the composer.
        if let unsent = controller?.takeUnsentSteers() {
            let current = composer.string.trimmingCharacters(in: .whitespacesAndNewlines)
            composer.string = current.isEmpty ? unsent : composer.string + "\n" + unsent
        }
        updateControls()
        scrollToEnd()
    }

    private func removeQueuedRows() {
        for row in queuedRows { transcript.removeArrangedSubview(row); row.removeFromSuperview() }
        queuedRows = []
    }

    /// 补充 waiting for the model's next call, below the streamed row.
    private func showQueuedSteers() {
        let steers = controller?.queuedSteers ?? []
        if queuedRows.count == steers.count, zip(queuedRows, steers).allSatisfy({ ($0 as? AgentMessageRow)?.plainText == $1 }) { return }
        removeQueuedRows()
        for (index, text) in steers.enumerated() {
            let row = AgentMessageRow(identifier: "agent-steer-queued-\(index)", heading: "你（补充，等待送达）", text: text, markdown: false, wash: true)
            row.alphaValue = 0.7
            queuedRows.append(row)
            add(row)
        }
    }

    /// The context indicator: the latest request's tokens against the window.
    private func updateContext() {
        let choice = controller?.current?.choice.normalized() ?? .standard
        maxContextCheckbox.state = choice.maxContext ? .on : .off
        maxContextCheckbox.toolTip = choice.offersMaxContext
            ? "开启后按当前模型声明的完整上下文窗口（最高约 100 万 token）计算，较晚才压缩较早的对话；关闭时按 20 万 token 标准窗口。只影响之后的请求。"
            : "当前模型不支持 100 万 token 上下文。"
        guard let usage = controller?.contextUsage(estimate: controller?.isRunning != true) else {
            contextLabel.stringValue = controller == nil ? "" : "上下文 —"
            contextLabel.toolTip = nil
            return
        }
        contextLabel.stringValue = usage.text
        contextLabel.toolTip = usage.detail.joined(separator: "\n")
        contextLabel.textColor = usage.fraction >= 0.9 ? .systemRed : usage.fraction >= 0.7 ? .systemOrange : .secondaryLabelColor
    }

    private func updateControls() {
        let running = controller?.isRunning == true
        let hasProject = controller != nil
        let asking = controller?.waitingQuestion != nil
        if controller?.isStoppingAfterTool == true {
            statusLabel.stringValue = "将在当前工具完成后停止…"
        } else {
            statusLabel.stringValue = controller?.activity ?? (running ? "正在回复…" : hasProject ? "⌘↩ 发送" : "")
        }
        sendButton.title = asking ? "回答" : running ? "补充" : "发送"
        sendButton.toolTip = asking ? "把输入框里的文字作为对写作助手问题的回答"
            : running ? "把补充或纠正加入当前任务，在写作助手下一次调用模型时送达" : nil
        composer.setAccessibilityLabel(asking ? "回答写作助手的问题" : running ? "补充或纠正正在执行的任务" : "给写作助手的消息")
        stopButton.isHidden = !running
        stopButton.isEnabled = running && controller?.isStopping != true
        stopAfterToolButton.isHidden = !running
        stopAfterToolButton.isEnabled = running && controller?.isStopping != true && controller?.isStoppingAfterTool != true
        continueButton.isHidden = controller?.canContinue != true
        let typed = !composer.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let steerable = running && controller?.isStopping != true && controller?.isStoppingAfterTool != true
        sendButton.isEnabled = hasProject && typed && (!running || asking || steerable)
        composer.isEditable = hasProject
        for control in [conversationPopup, newButton, providerPopup, modelPopup] as [NSControl] { control.isEnabled = hasProject && !running }
        // A conversation is renamed or deleted once it is written (a
        // message, or a note the author wrote in it).
        let written = controller?.current.map { !controller!.isDraft($0.id) || !$0.messages.isEmpty } ?? false
        renameButton.isEnabled = hasProject && written
        deleteButton.isEnabled = hasProject && !running && written
        let model = controller?.current?.choice.option ?? AgentModelChoice.standard.option
        thinkingPopup.isEnabled = hasProject && !running && model.reasoning.thinkingModes.count > 1
        effortPopup.isEnabled = hasProject && !running && !model.reasoning.efforts.isEmpty
        maxContextCheckbox.isEnabled = hasProject && !running && AgentModelChoice.offersMaxContext(model)
        settingsButton.isEnabled = true
        updateDictationControls()
    }

    private func reloadConversations() {
        conversationPopup.removeAllItems()
        let conversations = controller?.conversations ?? []
        guard let controller, !conversations.isEmpty else {
            conversationPopup.addItem(withTitle: AgentConversation.defaultTitle)
            return
        }
        for conversation in conversations {
            // Items are added through the menu so equal titles stay distinct.
            let item = NSMenuItem(title: conversation.title, action: nil, keyEquivalent: "")
            item.representedObject = conversation.id
            conversationPopup.menu?.addItem(item)
        }
        if let index = conversations.firstIndex(where: { $0.id == controller.currentID }) { conversationPopup.selectItem(at: index) }
    }

    private func reloadChoice() {
        let choice = controller?.current?.choice ?? .standard
        providerPopup.removeAllItems()
        for provider in AgentProviderID.allCases {
            providerPopup.addItem(withTitle: provider.label)
            providerPopup.lastItem?.representedObject = provider.rawValue
        }
        providerPopup.selectItem(at: AgentProviderID.allCases.firstIndex(of: choice.provider) ?? 0)
        modelPopup.removeAllItems()
        let models = AgentProviderCatalog.option(choice.provider).models
        for model in models {
            modelPopup.addItem(withTitle: model.label)
            modelPopup.lastItem?.representedObject = model.value
        }
        modelPopup.selectItem(at: models.firstIndex { $0.value == choice.model } ?? 0)
        let reasoning = choice.option.reasoning
        thinkingPopup.removeAllItems()
        for mode in AgentThinking.allCases {
            thinkingPopup.addItem(withTitle: mode.label)
            thinkingPopup.lastItem?.representedObject = mode.rawValue
            thinkingPopup.lastItem?.isEnabled = reasoning.thinkingModes.contains(mode)
        }
        thinkingPopup.selectItem(at: AgentThinking.allCases.firstIndex(of: choice.thinking) ?? 0)
        effortPopup.removeAllItems()
        for effort in reasoning.efforts {
            effortPopup.addItem(withTitle: "强度：\(effort.label)")
            effortPopup.lastItem?.representedObject = effort.rawValue
        }
        if reasoning.efforts.isEmpty { effortPopup.addItem(withTitle: "强度：不适用") }
        effortPopup.selectItem(at: reasoning.efforts.firstIndex(of: choice.effort) ?? 0)
    }

    private func scrollToEnd() {
        layoutSubtreeIfNeeded()
        let height = documentView.frame.height - scroll.contentView.bounds.height
        if height > 0 { documentView.scroll(NSPoint(x: 0, y: height)) }
    }

    // MARK: Actions

    /// 发送 starts a turn; while one runs it is 补充 (queued for the next
    /// call), and while a question waits it is 回答.
    @objc func send() {
        guard let controller else { return }
        let text = composer.string
        if let waiting = controller.waitingQuestion {
            if let refusal = controller.answerQuestion(waiting, answer: text) { statusLabel.stringValue = refusal; return }
        } else if controller.isRunning {
            guard controller.steer(text) else { return }
        } else {
            guard controller.send(text) else { return }
        }
        composer.string = ""
        updateControls()
    }

    @objc func stop() { controller?.stop() }

    @objc func stopAfterTool() { controller?.stopAfterTool() }

    @objc private func pickMaxContext() {
        var next = choice; next.maxContext = maxContextCheckbox.state == .on
        controller?.setChoice(next)
    }

    @objc func continueTask() {
        guard let controller, controller.continueTask() else { return }
        updateControls()
    }

    @objc private func pickConversation() {
        guard let id = conversationPopup.selectedItem?.representedObject as? String else { return }
        controller?.select(id)
    }

    @objc func newConversation() { controller?.newConversation() }

    func present(_ alert: NSAlert, _ done: @escaping (NSApplication.ModalResponse) -> Void) {
        if let presentAlert { presentAlert(alert, done); return }
        if let window = window ?? NSApp.mainWindow { alert.beginSheetModal(for: window, completionHandler: done) }
        else { done(alert.runModal()) }
    }

    @objc func renameConversation() {
        guard let controller, let conversation = controller.current else { return }
        let alert = NSAlert()
        alert.messageText = "重命名对话"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = conversation.title
        field.setAccessibilityIdentifier("agent-rename-field")
        alert.accessoryView = field
        alert.addButton(withTitle: "保存")
        alert.addButton(withTitle: "取消")
        alert.window.initialFirstResponder = field
        present(alert) { response in
            guard response == .alertFirstButtonReturn else { return }
            _ = controller.rename(conversation.id, title: field.stringValue)
        }
    }

    @objc func deleteConversation() {
        guard let controller, let conversation = controller.current else { return }
        let alert = NSAlert()
        alert.messageText = "删除对话“\(conversation.title)”？"
        alert.informativeText = "对话记录连同它的工作记忆、任务计划和用量记录会从这台 Mac 上删除，无法恢复。已经接受并写入的修改和作者规则不受影响。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "删除")
        alert.addButton(withTitle: "取消")
        present(alert) { response in
            guard response == .alertFirstButtonReturn else { return }
            controller.delete(conversation.id)
        }
    }

    @objc private func openSettings() { onOpenSettings?() }

    // MARK: Dictation

    private var dictationTimer: Timer?

    private func bindDictation() {
        dictation?.onInsert = { [weak self] text in self?.insertDictated(text) }
        dictation?.onChange = { [weak self] in self?.updateDictationControls() }
        dictation?.explainPermission = { [weak self] proceed in self?.explainMicrophone(proceed) }
        updateDictationControls()
    }

    /// Dictated text goes at the end of the composer, on its own line.
    private func insertDictated(_ text: String) {
        let current = composer.string
        composer.string = current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? text
            : current.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression) + "\n" + text
        composer.didChangeText()
        updateControls()
    }

    /// Asked once, before macOS's own prompt: why the microphone is needed.
    private func explainMicrophone(_ proceed: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "允许写作助手使用麦克风？"
        alert.informativeText = "听写会用麦克风录下你说的话，转写成文字放进写作助手的输入框，由你核对后再发送。录音只在转写时发送到你在 设置 › 模型服务 › 语音转写 中填写 Key 的阿里云百炼（DashScope），同时附上本项目的设定名、故事线、章节和灵感标题以校正专有名词；录音不会保存在这台 Mac 上。接下来 macOS 会请你确认。"
        alert.addButton(withTitle: "继续")
        alert.addButton(withTitle: "取消")
        present(alert) { response in proceed(response == .alertFirstButtonReturn) }
    }

    func updateDictationControls() {
        guard let dictation else {
            micButton.isHidden = true; dictationRow.isHidden = true
            dictationTimer?.invalidate(); dictationTimer = nil
            return
        }
        micButton.isHidden = false
        micButton.isEnabled = controller != nil && dictation.phase != .transcribing
        micButton.title = dictation.phase == .recording ? "停止" : "听写"
        micButton.image = NSImage(systemSymbolName: dictation.phase == .recording ? "stop.circle" : "mic",
                                  accessibilityDescription: dictation.phase == .recording ? "停止录音" : "听写")
        let status = dictation.statusText
        dictationLabel.stringValue = status ?? ""
        dictationLabel.textColor = dictation.error != nil ? .systemRed : .secondaryLabelColor
        dictationRetryButton.isHidden = dictation.failedPieces == 0
        dictationRetryButton.isEnabled = dictation.phase == .idle
        dictationDiscardButton.isHidden = dictation.failedPieces == 0
        dictationDiscardButton.isEnabled = dictation.phase == .idle
        dictationSetupButton.isHidden = !dictation.needsSetup
        dictationRow.isHidden = status == nil && dictation.failedPieces == 0 && !dictation.needsSetup
        if dictation.phase == .recording, dictationTimer == nil {
            let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.updateDictationControls() }
            RunLoop.main.add(timer, forMode: .common)
            dictationTimer = timer
        } else if dictation.phase != .recording {
            dictationTimer?.invalidate(); dictationTimer = nil
        }
    }

    @objc func toggleDictation() {
        guard let dictation, controller != nil else { return }
        if dictation.phase == .recording { dictation.stop() }
        else if dictation.phase == .idle, dictation.failedPieces > 0 { askAboutFailedPieces(dictation) }
        else { dictation.start() }
        updateDictationControls()
    }

    /// Pieces wait for 重试: a new recording would wait behind them, so the
    /// mic asks first. 重试 transcribes them; 放弃并录音 drops them and records.
    private func askAboutFailedPieces(_ dictation: VoiceDictation) {
        let alert = NSAlert()
        alert.messageText = "先处理等待重试的录音？"
        alert.informativeText = "还有 \(dictation.failedPieces) 段录音没有转写成功。重试会先转写它们并按说话顺序插入；放弃会丢弃它们，然后开始新的录音。"
        alert.addButton(withTitle: "重试")
        alert.addButton(withTitle: "放弃并录音")
        alert.addButton(withTitle: "取消")
        present(alert) { [weak self, weak dictation] response in
            guard let dictation else { return }
            switch response {
            case .alertFirstButtonReturn: dictation.retry()
            case .alertSecondButtonReturn: dictation.discardFailed(); dictation.start()
            default: break
            }
            self?.updateDictationControls()
        }
    }

    @objc func retryDictation() { dictation?.retry(); updateDictationControls() }
    @objc func discardDictationPieces() { dictation?.discardFailed(); updateDictationControls() }

    /// Before the app quits (or its window closes, which quits it): asks
    /// while dictation is recording, transcribing or keeps pieces for 重试.
    /// 取消 keeps everything as it is; 退出 lets the caller close, and the
    /// audio is dropped (`discardDictation`) only once the close succeeded,
    /// so a refused close keeps it. Answers at once when nothing would be lost.
    func confirmQuitDuringDictation(_ decide: @escaping (Bool) -> Void) {
        guard let dictation, let warning = dictation.quitWarning else { decide(true); return }
        let alert = NSAlert()
        alert.messageText = "退出并丢弃听写录音？"
        alert.informativeText = warning
        alert.alertStyle = .warning
        alert.addButton(withTitle: "退出")
        alert.addButton(withTitle: "取消")
        present(alert) { response in decide(response == .alertFirstButtonReturn) }
    }

    /// The workspace closed after 退出: the recording and every piece not
    /// yet transcribed are dropped.
    func discardDictation() { dictation?.cancel() }

    @objc private func openSpeechSettings() { onOpenSpeechSettings?() }

    private var choice: AgentModelChoice { controller?.current?.choice ?? .standard }

    @objc private func pickProvider() {
        guard let raw = providerPopup.selectedItem?.representedObject as? String, let provider = AgentProviderID(rawValue: raw) else { return }
        controller?.setChoice(choice.with(provider: provider))
    }

    @objc private func pickModel() {
        guard let model = modelPopup.selectedItem?.representedObject as? String else { return }
        controller?.setChoice(choice.with(model: model))
    }

    @objc private func pickThinking() {
        guard let raw = thinkingPopup.selectedItem?.representedObject as? String, let thinking = AgentThinking(rawValue: raw) else { return }
        var next = choice; next.thinking = thinking
        controller?.setChoice(next)
    }

    @objc private func pickEffort() {
        guard let raw = effortPopup.selectedItem?.representedObject as? String, let effort = AgentEffort(rawValue: raw) else { return }
        var next = choice; next.effort = effort
        controller?.setChoice(next)
    }

    // MARK: Inspection

    /// The first descendant with this accessibility identifier.
    func element(_ identifier: String) -> NSView? { Self.find(identifier, in: self) }

    private static func find(_ identifier: String, in view: NSView) -> NSView? {
        if view.accessibilityIdentifier() == identifier { return view }
        for child in view.subviews { if let found = find(identifier, in: child) { return found } }
        return nil
    }

    /// Visible transcript rows, as the author reads them.
    var transcriptTexts: [String] {
        transcript.arrangedSubviews.filter { !$0.isHidden }.map { row in
            (row as? AgentTranscriptRow)?.plainText ?? (row as? NSTextField)?.stringValue ?? ""
        }
    }
}

protocol AgentTranscriptRow { var plainText: String { get } }

final class AgentFlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// ⌘↩ sends while the composer has the keyboard; plain ↩ is a new line.
final class AgentComposerTextView: NSTextView {
    var onSubmit: (() -> Void)?
    var onChange: (() -> Void)?

    private func isSubmit(_ event: NSEvent) -> Bool {
        event.type == .keyDown && event.modifierFlags.intersection(.deviceIndependentFlagsMask).contains(.command)
            && (event.keyCode == 36 || event.keyCode == 76)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if isSubmit(event), window?.firstResponder === self { onSubmit?(); return true }
        return super.performKeyEquivalent(with: event)
    }

    override func keyDown(with event: NSEvent) {
        if isSubmit(event) { onSubmit?(); return }
        super.keyDown(with: event)
    }

    override func didChangeText() {
        super.didChangeText()
        onChange?()
    }
}

/// A message: the author's on a soft wash, the assistant's as plain text.
final class AgentMessageRow: NSView, AgentTranscriptRow {
    private let label = NSTextField(wrappingLabelWithString: "")
    private let wash: Bool
    private(set) var plainText = ""

    init(identifier: String, heading: String?, text: String, markdown: Bool, wash: Bool) {
        self.wash = wash
        super.init(frame: .zero)
        wantsLayer = true
        setAccessibilityIdentifier(identifier)
        label.isSelectable = true
        // Selecting keeps the Markdown-light attributes.
        label.allowsEditingTextAttributes = true
        label.setAccessibilityIdentifier(identifier + "-text")
        var views: [NSView] = []
        if let heading {
            let title = NSTextField(labelWithString: heading)
            title.font = .systemFont(ofSize: 11, weight: .semibold)
            title.textColor = .secondaryLabelColor
            views.append(title)
        }
        views.append(label)
        let stack = NSStackView(views: views)
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 3
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        let inset: CGFloat = wash ? 9 : 2
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: inset),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -inset),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: wash ? 7 : 1),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: wash ? -7 : -1),
            label.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        show(text, markdown: markdown)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func show(_ text: String, markdown: Bool) {
        plainText = text
        if markdown { label.attributedStringValue = AgentMarkdown.attributed(text) }
        else { label.font = .systemFont(ofSize: 13); label.stringValue = text }
    }

    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        layer?.cornerRadius = 8
        layer?.backgroundColor = wash ? NSColor.labAccent.withAlphaComponent(0.10).cgColor : NSColor.clear.cgColor
    }
}

/// A tool activity line (读取《启程》) or a notice (已停止, an error).
final class AgentActivityRow: NSTextField, AgentTranscriptRow {
    init(identifier: String, text: String, failed: Bool) {
        super.init(frame: .zero)
        isEditable = false; isSelectable = true; isBordered = false; drawsBackground = false
        lineBreakMode = .byWordWrapping
        maximumNumberOfLines = 0
        cell?.wraps = true
        font = .systemFont(ofSize: 11)
        textColor = failed ? .systemRed : .secondaryLabelColor
        stringValue = text
        setAccessibilityIdentifier(identifier)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    var plainText: String { stringValue }
}

/// A pending or decided proposal: what would change, its state, and
/// 接受 / 拒绝 while it waits for the author.
final class AgentProposalCard: NSView, AgentTranscriptRow {
    let proposal: AgentProposal
    let acceptButton = NSButton(title: "接受", target: nil, action: nil)
    let rejectButton = NSButton(title: "拒绝", target: nil, action: nil)
    let stateLabel = NSTextField(labelWithString: "")
    let messageLabel = NSTextField(wrappingLabelWithString: "")
    private let accept: () -> Void
    private let reject: () -> Void
    private(set) var plainText = ""

    init(proposal: AgentProposal, accept: @escaping () -> Void, reject: @escaping () -> Void) {
        self.proposal = proposal; self.accept = accept; self.reject = reject
        super.init(frame: .zero)
        wantsLayer = true
        let id = proposal.id
        setAccessibilityIdentifier("agent-proposal-\(id)")
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("修改提案：\(proposal.headline)")
        let title = NSTextField(labelWithString: proposal.headline)
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        title.lineBreakMode = .byTruncatingTail
        stateLabel.stringValue = proposal.stateLabel
        stateLabel.font = .systemFont(ofSize: 11, weight: .medium)
        let partial = proposal.partial == true
        stateLabel.textColor = proposal.state == .failed ? .systemRed : partial ? .systemOrange
            : proposal.state == .accepted ? .systemGreen : .secondaryLabelColor
        stateLabel.setAccessibilityIdentifier("agent-proposal-state-\(id)")
        var views: [NSView] = [title, stateLabel]
        var lines = [proposal.headline, proposal.stateLabel]
        switch proposal.kind {
        case .revise:
            for (index, change) in proposal.changes.enumerated() {
                views.append(Self.block(change.currentText, removed: true, identifier: "agent-proposal-before-\(id)-\(index)"))
                views.append(Self.block(change.revisedText, removed: false, identifier: "agent-proposal-after-\(id)-\(index)"))
                lines += [change.currentText, change.revisedText]
            }
        case .append:
            let text = proposal.changes.first?.revisedText ?? ""
            let note = Self.note("追加在正文末尾，每行成为一个新段落：", identifier: "agent-proposal-note-\(id)")
            views += [note, Self.block(text, removed: false, identifier: "agent-proposal-after-\(id)-0")]
            lines += [note.stringValue, text]
        case .createChapter:
            let text = proposal.initialText ?? ""
            let note = Self.note(text.isEmpty ? "在书末新建章节《\(proposal.targetTitle)》，正文为空。"
                                              : "在书末新建章节《\(proposal.targetTitle)》，并写入初始正文：",
                                 identifier: "agent-proposal-note-\(id)")
            views.append(note); lines.append(note.stringValue)
            if !text.isEmpty {
                views.append(Self.block(text, removed: false, identifier: "agent-proposal-after-\(id)-0"))
                lines.append(text)
            }
        case .chapterSummary:
            if let previous = proposal.previousSummary, !previous.isEmpty {
                views.append(Self.block(previous, removed: true, identifier: "agent-proposal-before-\(id)-0"))
                lines.append(previous)
            }
            let summary = proposal.summary ?? ""
            views.append(Self.block(summary.isEmpty ? "（清空摘要）" : summary, removed: false, identifier: "agent-proposal-after-\(id)-0"))
            lines.append(summary)
        case .domain:
            // Each field: its name, the value before (struck) and after.
            if let text = proposal.note, !text.isEmpty {
                let note = Self.note(text, identifier: "agent-proposal-note-\(id)")
                views.append(note); lines.append(text)
            }
            for (index, field) in (proposal.fields ?? []).enumerated() {
                let label = NSTextField(labelWithString: field.label)
                label.font = .systemFont(ofSize: 11, weight: .semibold)
                label.textColor = .secondaryLabelColor
                label.setAccessibilityIdentifier("agent-proposal-field-\(id)-\(index)")
                views.append(label); lines.append(field.label)
                if let before = field.before, !before.isEmpty {
                    views.append(Self.block(before, removed: true, identifier: "agent-proposal-before-\(id)-\(index)"))
                    lines.append(before)
                }
                let after = field.after.isEmpty ? "（清空）" : field.after
                views.append(Self.block(after, removed: false, identifier: "agent-proposal-after-\(id)-\(index)"))
                lines.append(after)
            }
        }
        if let message = proposal.message, !message.isEmpty {
            messageLabel.stringValue = message
            messageLabel.font = .systemFont(ofSize: 12)
            messageLabel.textColor = proposal.state == .failed ? .systemRed
                : proposal.state == .pending || partial ? .systemOrange : .secondaryLabelColor
            messageLabel.setAccessibilityIdentifier("agent-proposal-message-\(id)")
            views.append(messageLabel); lines.append(message)
        }
        if proposal.state == .pending || proposal.state == .applying {
            for (button, name, action) in [(acceptButton, "accept", #selector(pressAccept)), (rejectButton, "reject", #selector(pressReject))] {
                button.target = self; button.action = action
                button.bezelStyle = .rounded; button.controlSize = .small
                button.font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
                button.setAccessibilityIdentifier("agent-proposal-\(name)-\(id)")
                button.isEnabled = proposal.state == .pending
            }
            let buttons = NSStackView(views: [acceptButton, rejectButton])
            buttons.spacing = 6
            views.append(buttons)
        }
        plainText = lines.joined(separator: "\n")
        let stack = NSStackView(views: views)
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 6
        stack.setCustomSpacing(8, after: stateLabel)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 9),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -9),
            title.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor),
        ])
        for view in views where view is AgentDiffBlock || view === messageLabel {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private static func note(_ text: String, identifier: String) -> NSTextField {
        let note = NSTextField(wrappingLabelWithString: text)
        note.font = .systemFont(ofSize: 12)
        note.textColor = .secondaryLabelColor
        note.setAccessibilityIdentifier(identifier)
        return note
    }

    private static func block(_ text: String, removed: Bool, identifier: String) -> AgentDiffBlock {
        AgentDiffBlock(text: text, removed: removed, identifier: identifier)
    }

    @objc private func pressAccept() { accept() }
    @objc private func pressReject() { reject() }

    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        layer?.cornerRadius = 8
        layer?.backgroundColor = NSColor.secondaryLabelColor.withAlphaComponent(proposal.state == .pending ? 0.10 : 0.06).cgColor
    }
}

/// 每次询问: an MCP call waiting for the author, with the tool, its server
/// and the complete arguments (monospaced and scrollable, never cut), and
/// 允许一次 / 拒绝 while the turn waits for it. 未执行 says why when the
/// server changed before 允许一次.
final class AgentMcpApprovalCard: NSView, AgentTranscriptRow {
    let allowButton = NSButton(title: "允许一次", target: nil, action: nil)
    let denyButton = NSButton(title: "拒绝", target: nil, action: nil)
    let stateLabel = NSTextField(labelWithString: "")
    let invocation: AgentMcpInvocation
    /// The complete arguments.
    let argumentsView: AgentScrollingText
    private let allow: () -> Void
    private let deny: () -> Void
    private(set) var plainText = ""

    init(messageID: String, invocation: AgentMcpInvocation, answerable: Bool, allow: @escaping () -> Void, deny: @escaping () -> Void) {
        self.invocation = invocation; self.allow = allow; self.deny = deny
        argumentsView = AgentScrollingText(text: invocation.arguments, identifier: "agent-mcp-arguments-\(messageID)")
        super.init(frame: .zero)
        wantsLayer = true
        setAccessibilityIdentifier("agent-mcp-approval-\(messageID)")
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        let heading = "允许调用 MCP 工具？"
        setAccessibilityLabel(heading)
        let title = NSTextField(labelWithString: heading)
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        let state = invocation.state == .cancelled ? invocation.stateLabel + (invocation.reason.map { "：\($0)" } ?? "") : invocation.stateLabel
        stateLabel.stringValue = state
        stateLabel.font = .systemFont(ofSize: 11, weight: .medium)
        stateLabel.textColor = invocation.state == .allowed ? .systemGreen : invocation.state == .denied ? .systemRed : .secondaryLabelColor
        stateLabel.lineBreakMode = .byWordWrapping
        stateLabel.maximumNumberOfLines = 0
        stateLabel.setAccessibilityIdentifier("agent-mcp-state-\(messageID)")
        let tool = AgentApprovalText.field("工具：\(invocation.tool)", "agent-mcp-tool-\(messageID)")
        let server = AgentApprovalText.field("服务器：\(invocation.serverName)", "agent-mcp-server-\(messageID)")
        let empty = invocation.arguments == "（无参数）"
        let note = AgentApprovalText.field(empty ? "参数：" : "参数（共 \(invocation.arguments.count) 字，完整显示）：", "agent-mcp-arguments-title-\(messageID)")
        var views: [NSView] = [title, stateLabel, tool, server, note, argumentsView]
        plainText = [heading, state, tool.stringValue, server.stringValue, "参数：", invocation.arguments].joined(separator: "\n")
        if invocation.state == .waiting {
            views.append(AgentApprovalText.buttons([(allowButton, "allow", #selector(pressAllow)), (denyButton, "deny", #selector(pressDeny))],
                                                   target: self, prefix: "agent-mcp", messageID: messageID, enabled: answerable))
        }
        AgentApprovalText.install(views, in: self, after: stateLabel, fill: [argumentsView, stateLabel])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    @objc private func pressAllow() { allow() }
    @objc private func pressDeny() { deny() }

    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        layer?.cornerRadius = 8
        layer?.backgroundColor = NSColor.secondaryLabelColor.withAlphaComponent(invocation.state == .waiting ? 0.10 : 0.06).cgColor
    }
}

/// A rule, working-memory or task-plan write asked for after an MCP result
/// in the same turn: what it would change in full, and 允许 / 拒绝 while the
/// turn waits.
final class AgentMemoryApprovalCard: NSView, AgentTranscriptRow {
    let allowButton = NSButton(title: "允许", target: nil, action: nil)
    let denyButton = NSButton(title: "拒绝", target: nil, action: nil)
    let stateLabel = NSTextField(labelWithString: "")
    let request: AgentMemoryApproval
    /// The complete change.
    let detailView: AgentScrollingText
    private let allow: () -> Void
    private let deny: () -> Void
    private(set) var plainText = ""

    static let reason = "本轮已收到 MCP 工具的结果。为防止外部内容借写作助手改动作者规则、工作记忆或任务计划，这次修改要你确认。"

    init(messageID: String, request: AgentMemoryApproval, answerable: Bool, allow: @escaping () -> Void, deny: @escaping () -> Void) {
        self.request = request; self.allow = allow; self.deny = deny
        detailView = AgentScrollingText(text: request.detail, identifier: "agent-memory-approval-detail-\(messageID)")
        super.init(frame: .zero)
        wantsLayer = true
        setAccessibilityIdentifier("agent-memory-approval-\(messageID)")
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        let heading = "允许修改写作助手的记忆？"
        setAccessibilityLabel(heading)
        let title = NSTextField(labelWithString: heading)
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        stateLabel.stringValue = request.stateLabel
        stateLabel.font = .systemFont(ofSize: 11, weight: .medium)
        stateLabel.textColor = request.state == .allowed ? .systemGreen : request.state == .denied ? .systemRed : .secondaryLabelColor
        stateLabel.setAccessibilityIdentifier("agent-memory-approval-state-\(messageID)")
        let why = AgentApprovalText.field(Self.reason, "agent-memory-approval-reason-\(messageID)")
        why.textColor = .secondaryLabelColor
        let action = AgentApprovalText.field(request.action + "：", "agent-memory-approval-action-\(messageID)")
        var views: [NSView] = [title, stateLabel, why, action, detailView]
        plainText = [heading, request.stateLabel, Self.reason, action.stringValue, request.detail].joined(separator: "\n")
        if request.state == .waiting {
            views.append(AgentApprovalText.buttons([(allowButton, "allow", #selector(pressAllow)), (denyButton, "deny", #selector(pressDeny))],
                                                   target: self, prefix: "agent-memory-approval", messageID: messageID, enabled: answerable))
        }
        AgentApprovalText.install(views, in: self, after: stateLabel, fill: [detailView, why])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    @objc private func pressAllow() { allow() }
    @objc private func pressDeny() { deny() }

    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        layer?.cornerRadius = 8
        layer?.backgroundColor = NSColor.secondaryLabelColor.withAlphaComponent(request.state == .waiting ? 0.10 : 0.06).cgColor
    }
}

/// `ask_user`: the model's question with its choices, an answer field and
/// 回答 while the turn waits for it; afterwards the answer, or 未回答 when
/// the turn was stopped first.
final class AgentQuestionCard: NSView, AgentTranscriptRow {
    let question: AgentQuestion
    let answerField = NSTextField()
    let answerButton = NSButton(title: "回答", target: nil, action: nil)
    let stateLabel = NSTextField(labelWithString: "")
    private(set) var choiceButtons: [NSButton] = []
    private let answer: (String) -> String?
    private(set) var plainText = ""
    let messageLabel = NSTextField(wrappingLabelWithString: "")

    init(messageID: String, question: AgentQuestion, answerable: Bool, answer: @escaping (String) -> String?) {
        self.question = question; self.answer = answer
        super.init(frame: .zero)
        wantsLayer = true
        setAccessibilityIdentifier("agent-question-\(messageID)")
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        let heading = "写作助手的问题"
        setAccessibilityLabel(heading)
        let title = NSTextField(labelWithString: heading)
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        stateLabel.stringValue = question.stateLabel
        stateLabel.font = .systemFont(ofSize: 11, weight: .medium)
        stateLabel.textColor = question.state == .answered ? .systemGreen : question.state == .unanswered ? .secondaryLabelColor : .systemOrange
        stateLabel.setAccessibilityIdentifier("agent-question-state-\(messageID)")
        let text = AgentApprovalText.field(question.question, "agent-question-text-\(messageID)")
        text.isSelectable = true
        var views: [NSView] = [title, stateLabel, text]
        var lines = [heading, question.stateLabel, question.question]
        if question.state == .waiting {
            if !question.choices.isEmpty {
                let choices = NSStackView()
                choices.orientation = .vertical; choices.alignment = .leading; choices.spacing = 4
                for (index, choice) in question.choices.enumerated() {
                    let button = NSButton(title: choice, target: self, action: #selector(pressChoice(_:)))
                    button.bezelStyle = .rounded; button.controlSize = .small
                    button.font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
                    button.tag = index
                    button.isEnabled = answerable
                    button.setAccessibilityIdentifier("agent-question-choice-\(messageID)-\(index)")
                    choiceButtons.append(button)
                    choices.addArrangedSubview(button)
                }
                views.append(choices)
                lines += question.choices.map { "· " + $0 }
            }
            answerField.placeholderString = question.choices.isEmpty ? "写下你的回答" : "或者写下你的回答"
            answerField.isEnabled = answerable
            answerField.setAccessibilityIdentifier("agent-question-field-\(messageID)")
            answerField.target = self; answerField.action = #selector(pressAnswer)
            answerButton.target = self; answerButton.action = #selector(pressAnswer)
            answerButton.bezelStyle = .rounded; answerButton.controlSize = .small
            answerButton.font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
            answerButton.isEnabled = answerable
            answerButton.setAccessibilityIdentifier("agent-question-answer-\(messageID)")
            let row = NSStackView(views: [answerField, answerButton])
            row.spacing = 6
            views.append(row)
            answerField.widthAnchor.constraint(greaterThanOrEqualToConstant: 160).isActive = true
        } else if let given = question.answer {
            let answered = AgentApprovalText.field("你的回答：\(given)", "agent-question-answered-\(messageID)")
            answered.isSelectable = true
            views.append(answered); lines.append(answered.stringValue)
        } else if question.state == .unanswered {
            let note = AgentApprovalText.field("本轮已停止，这个问题没有回答。", "agent-question-unanswered-\(messageID)")
            note.textColor = .secondaryLabelColor
            views.append(note); lines.append(note.stringValue)
        }
        messageLabel.font = .systemFont(ofSize: 11)
        messageLabel.textColor = .systemRed
        messageLabel.isHidden = true
        messageLabel.setAccessibilityIdentifier("agent-question-message-\(messageID)")
        views.append(messageLabel)
        plainText = lines.joined(separator: "\n")
        AgentApprovalText.install(views, in: self, after: stateLabel, fill: [text, messageLabel])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func submit(_ text: String) {
        if let refusal = answer(text) {
            messageLabel.stringValue = refusal
            messageLabel.isHidden = false
        }
    }

    @objc func pressAnswer() { submit(answerField.stringValue) }
    @objc private func pressChoice(_ sender: NSButton) {
        guard question.choices.indices.contains(sender.tag) else { return }
        submit(question.choices[sender.tag])
    }

    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        layer?.cornerRadius = 8
        layer?.backgroundColor = NSColor.secondaryLabelColor.withAlphaComponent(question.state == .waiting ? 0.10 : 0.06).cgColor
    }
}

/// Shared pieces of the approval cards.
enum AgentApprovalText {
    static func field(_ text: String, _ identifier: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: 12)
        label.setAccessibilityIdentifier(identifier)
        return label
    }

    static func buttons(_ items: [(NSButton, String, Selector)], target: AnyObject, prefix: String, messageID: String, enabled: Bool) -> NSStackView {
        for (button, name, action) in items {
            button.target = target; button.action = action
            button.bezelStyle = .rounded; button.controlSize = .small
            button.font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
            button.setAccessibilityIdentifier("\(prefix)-\(name)-\(messageID)")
            button.isEnabled = enabled
        }
        let row = NSStackView(views: items.map(\.0))
        row.spacing = 6
        return row
    }

    static func install(_ views: [NSView], in card: NSView, after state: NSView, fill: [NSView]) {
        let stack = NSStackView(views: views)
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 5
        stack.setCustomSpacing(8, after: state)
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 10),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -10),
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 9),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -9),
        ])
        for view in fill { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
    }
}

/// Read-only monospaced text in its own scroll view: as tall as the text up
/// to `maxHeight`, then scrollable. Nothing is cut.
final class AgentScrollingText: NSScrollView {
    static let maxHeight: CGFloat = 180
    let textView = NSTextView()
    private var height: NSLayoutConstraint!

    init(text: String, identifier: String) {
        super.init(frame: NSRect(x: 0, y: 0, width: 300, height: 40))
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.drawsBackground = false
        textView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        textView.textContainerInset = NSSize(width: 3, height: 4)
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.string = text
        textView.setAccessibilityIdentifier(identifier)
        setAccessibilityIdentifier(identifier + "-scroll")
        hasVerticalScroller = true
        autohidesScrollers = true
        borderType = .noBorder
        drawsBackground = false
        documentView = textView
        translatesAutoresizingMaskIntoConstraints = false
        // Long text starts at the full height without laying all of it out.
        height = heightAnchor.constraint(equalToConstant: text.utf16.count > 4_000 ? Self.maxHeight : 40)
        height.isActive = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    var text: String { textView.string }

    override func layout() {
        super.layout()
        guard height.constant < Self.maxHeight, let manager = textView.layoutManager, let container = textView.textContainer else { return }
        manager.ensureLayout(for: container)
        let needed = min(Self.maxHeight, ceil(manager.usedRect(for: container).height + textView.textContainerInset.height * 2))
        if abs(height.constant - needed) > 0.5 { height.constant = needed }
    }
}

/// One side of a change: removed text struck through on a red wash, the
/// replacement on a green wash.
final class AgentDiffBlock: NSView {
    let label = NSTextField(wrappingLabelWithString: "")
    private let removed: Bool

    init(text: String, removed: Bool, identifier: String) {
        self.removed = removed
        super.init(frame: .zero)
        wantsLayer = true
        setAccessibilityIdentifier(identifier)
        let attributes: [NSAttributedString.Key: Any] = removed
            ? [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor,
               .strikethroughStyle: NSUnderlineStyle.single.rawValue]
            : [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.labelColor]
        label.attributedStringValue = NSAttributedString(string: text.isEmpty ? "（删除）" : text, attributes: attributes)
        label.isSelectable = true
        label.setAccessibilityLabel((removed ? "原文：" : "改为：") + text)
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 7),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -7),
            label.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4),
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    var text: String { label.stringValue }

    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        layer?.cornerRadius = 5
        layer?.backgroundColor = (removed ? NSColor.systemRed.withAlphaComponent(0.10) : NSColor.systemGreen.withAlphaComponent(0.13)).cgColor
    }
}

/// Markdown-light: headings, list items, **bold** and `code`. Other syntax
/// stays as typed.
enum AgentMarkdown {
    static func attributed(_ text: String, size: CGFloat = 13) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let body = NSFont.systemFont(ofSize: size)
        let lines = text.components(separatedBy: "\n")
        for (index, raw) in lines.enumerated() {
            var line = raw
            var font = body
            if let match = line.range(of: "^#{1,6} ", options: .regularExpression) {
                line.removeSubrange(match)
                font = .systemFont(ofSize: size + 1, weight: .semibold)
            } else if let match = line.range(of: "^\\s*[-*] ", options: .regularExpression) {
                let indent = line[match].prefix { $0 == " " }.count
                line.replaceSubrange(match, with: String(repeating: "  ", count: indent / 2) + "• ")
            }
            result.append(inline(line, font: font))
            if index < lines.count - 1 { result.append(NSAttributedString(string: "\n", attributes: [.font: body])) }
        }
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 2
        result.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: result.length))
        result.addAttribute(.foregroundColor, value: NSColor.labelColor, range: NSRange(location: 0, length: result.length))
        return result
    }

    private static func inline(_ line: String, font: NSFont) -> NSAttributedString {
        let result = NSMutableAttributedString()
        var rest = Substring(line)
        let bold = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask)
        let code = NSFont.monospacedSystemFont(ofSize: font.pointSize - 1, weight: .regular)
        while !rest.isEmpty {
            if rest.hasPrefix("**"), let end = rest.dropFirst(2).range(of: "**") {
                result.append(NSAttributedString(string: String(rest[rest.index(rest.startIndex, offsetBy: 2)..<end.lowerBound]), attributes: [.font: bold]))
                rest = rest[end.upperBound...]
            } else if rest.hasPrefix("`"), let end = rest.dropFirst().firstIndex(of: "`") {
                result.append(NSAttributedString(string: String(rest[rest.index(after: rest.startIndex)..<end]), attributes: [.font: code]))
                rest = rest[rest.index(after: end)...]
            } else {
                let next = rest.dropFirst().firstIndex { $0 == "*" || $0 == "`" } ?? rest.endIndex
                result.append(NSAttributedString(string: String(rest[rest.startIndex..<next]), attributes: [.font: font]))
                rest = rest[next...]
            }
        }
        return result
    }
}

// MARK: - API keys

/// 写作助手设置: each provider's API key, stored in or cleared from the
/// credential store. Only the masked tail of a stored key is ever shown;
/// the field is emptied once a key is saved.
final class MacAgentSettingsSheet: NSObject {
    let window: NSWindow
    let credentials: AgentCredentialStore
    private(set) var fields: [AgentProviderID: NSSecureTextField] = [:]
    private(set) var states: [AgentProviderID: NSTextField] = [:]
    let message = NSTextField(wrappingLabelWithString: "")
    let doneButton = NSButton(title: "完成", target: nil, action: nil)
    var onFinish: (() -> Void)?

    init(credentials: AgentCredentialStore) {
        self.credentials = credentials
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 360), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "写作助手设置"
        super.init()
        let title = NSTextField(labelWithString: "模型服务的 API Key")
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        let note = NSTextField(wrappingLabelWithString:
            "API Key 只保存在这台 Mac 的钥匙串里（Drifting Native Lab），不会写进对话记录，也不会显示完整内容。ChatGPT 订阅登录暂未提供。")
        note.textColor = .secondaryLabelColor
        note.font = .systemFont(ofSize: 12)
        var views: [NSView] = [title, note]
        for provider in AgentProviderID.allCases {
            let name = NSTextField(labelWithString: provider.label)
            name.font = .systemFont(ofSize: 13, weight: .semibold)
            let state = NSTextField(labelWithString: "")
            state.textColor = .secondaryLabelColor
            state.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
            state.setAccessibilityIdentifier("agent-key-status-\(provider.rawValue)")
            let field = NSSecureTextField()
            field.placeholderString = "粘贴新的 \(provider.label) API Key"
            field.setAccessibilityIdentifier("agent-key-field-\(provider.rawValue)")
            let save = SettingsButton(title: "保存", identifier: "agent-key-save-\(provider.rawValue)") { [weak self] in self?.save(provider) }
            let clear = SettingsButton(title: "清除", identifier: "agent-key-clear-\(provider.rawValue)") { [weak self] in self?.clear(provider) }
            let heading = NSStackView(views: [name, state])
            heading.spacing = 8
            let row = NSStackView(views: [field, save, clear])
            row.spacing = 6
            fields[provider] = field; states[provider] = state
            views += [heading, row]
            field.widthAnchor.constraint(greaterThanOrEqualToConstant: 260).isActive = true
        }
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("agent-settings-message")
        doneButton.target = self; doneButton.action = #selector(done)
        doneButton.keyEquivalent = "\r"
        doneButton.setAccessibilityIdentifier("agent-settings-done")
        views += [message, NSStackView(views: [NSView(), doneButton])]
        let stack = NSStackView(views: views)
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.setCustomSpacing(16, after: note)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            content.widthAnchor.constraint(equalToConstant: 460),
            note.widthAnchor.constraint(equalTo: stack.widthAnchor),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        refresh()
        content.layoutSubtreeIfNeeded()
        window.setContentSize(content.fittingSize)
    }

    func begin(in parent: NSWindow?) {
        refresh()
        parent?.beginSheet(window) { _ in }
    }

    func refresh() {
        for provider in AgentProviderID.allCases {
            states[provider]?.stringValue = credentials.maskedKey(for: provider) ?? "未设置"
        }
    }

    func save(_ provider: AgentProviderID) {
        guard let field = fields[provider] else { return }
        do {
            try credentials.setKey(field.stringValue, for: provider)
            field.stringValue = ""
            show(nil)
        } catch { show(error.localizedDescription) }
        refresh()
    }

    func clear(_ provider: AgentProviderID) {
        do { try credentials.removeKey(for: provider); show(nil) } catch { show(error.localizedDescription) }
        fields[provider]?.stringValue = ""
        refresh()
    }

    private func show(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    @objc func done() {
        for field in fields.values { field.stringValue = "" }
        if let parent = window.sheetParent { parent.endSheet(window) }
        window.orderOut(nil)
        onFinish?()
    }
}

private final class SettingsButton: NSButton {
    private let pressed: () -> Void
    init(title: String, identifier: String, pressed: @escaping () -> Void) {
        self.pressed = pressed
        super.init(frame: .zero)
        self.title = title
        bezelStyle = .rounded; controlSize = .small
        font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
        target = self; action = #selector(press)
        setAccessibilityIdentifier(identifier)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    @objc private func press() { pressed() }
}

// MARK: - Workspace wiring

extension MacChapterWorkspace {
    /// 《启程》（章节） for the page the author has open in this project.
    func agentContext(projectID: String) -> String? {
        guard activeProject?.id == projectID else { return nil }
        if let chapter = activeChapter { return "《\(chapter.title)》（章节）" }
        if let element = activeElement { return "设定「\(element.name)」" }
        if let drift = activeDrift { return "漂流「\(drift.title)」" }
        if let storyline = activeStoryline { return "故事线「\(storyline.name)」" }
        if let category = activeCategory { return "分类「\(category.name)」" }
        return nil
    }

    /// Trash from the writing assistant goes through the tab host, so the
    /// page's tabs close once Rust commits, as they do for the author's trash.
    func agentLifecycle(projectID: String) -> AgentPageLifecycle {
        AgentPageLifecycle(
            trashChapter: { [weak self] id, done in
                guard let self else { done(.failure(LabError.message("窗口已关闭。"))); return }
                self.trash(projectID: projectID, chapterID: id, completion: done)
            },
            trashElement: { [weak self] id, done in
                guard let self else { done(.failure(LabError.message("窗口已关闭。"))); return }
                self.trashElement(projectID: projectID, elementID: id, completion: done)
            })
    }

    /// An accepted proposal: open owners already adopted a revision; counts,
    /// chapter lists, libraries and summaries follow here.
    func adoptAgentEffect(_ effect: AgentWorkspaceEffect) {
        switch effect {
        case .prose(let projectID, let kind, let id, let live):
            // 统计, 章节模版 checks and category fill states follow the body.
            bodyChangedElsewhere(projectID: projectID, kind: kind, id: id)
            if live {
                // The open owner adopted the revision; its new text links
                // entity names like typed text, and is counted once it settles.
                let scope: DocumentScope?
                switch kind {
                case "chapter": scope = .chapter(ChapterScope(projectID: projectID, chapterID: id))
                case "element": scope = .element(ElementScope(projectID: projectID, elementID: id))
                case "drift": scope = .drift(DriftScope(projectID: projectID, driftID: id))
                case "storyline": scope = .storyline(StorylineScope(projectID: projectID, storylineID: id))
                case "category": scope = .category(CategoryScope(projectID: projectID, categoryID: id))
                default: scope = nil
                }
                if let scope { openView(scope: scope)?.binding.store.requestEntityLinks() }
            } else if kind == "chapter" || kind == "drift" {
                wordCounts(projectID: projectID, refresh: true)
            }
        case .chapterCreated(let projectID, _):
            chaptersChanged(projectID: projectID)
        case .nodeMetadata(let projectID, let metadata):
            applyNodeMetadata(projectID: projectID, metadata: metadata)
            onNodeMetadata?(projectID, metadata)
            if metadata.kind == "drift" { driftsChanged(projectID: projectID) }
        case .elements(let projectID, let library):
            applyElementLibrary(projectID: projectID, library: library)
            onElementLibrary?(projectID, library)
        case .storylines(let projectID, let library):
            applyStorylineLibrary(projectID: projectID, library: library)
            onStorylineLibrary?(projectID, library)
        case .drifts(let projectID, let library):
            applyDriftLibrary(projectID: projectID, library: library)
            onDriftLibrary?(projectID, library)
        case .relations(let projectID):
            relations.reload(projectID: projectID)
        case .comments:
            break
        case .patches(let projectID, _):
            patches.reload(projectID: projectID)
        case .chapterRenamed(let projectID, let chapter):
            rename(chapter: chapter, projectID: projectID)
        case .chapterTrashed(let projectID, let reply):
            applyChapters(projectID: projectID, chapters: reply.chapters, trashed: reply.trashedChapters)
        case .project:
            break
        }
    }
}
