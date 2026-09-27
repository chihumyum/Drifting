import AppKit

/// 写作助手: the right-side panel of the window. A conversation picker, the
/// provider/model/thinking picker, the streamed transcript with tool
/// activity and proposal cards, and a composer (⌘↩ sends) with a stop
/// button. Sections are set apart by wash, spacing and type weight only.
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
    /// The running activity, or how to send.
    let statusLabel = NSTextField(labelWithString: "")
    private let emptyLabel = NSTextField(wrappingLabelWithString: "")
    private let transcript = NSStackView()
    private let scroll = NSScrollView()
    private let documentView = AgentFlippedView()
    private var streamingRow: AgentMessageRow?
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
                                     (stopButton, "agent-stop", #selector(stop))] {
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
        let footer = NSStackView(views: [statusLabel, NSView(), stopButton, sendButton])
        footer.spacing = 6

        let stack = NSStackView(views: [header, conversationRow, manageRow, modelRow, reasoningRow, scroll, composerScroll, footer])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.setCustomSpacing(14, after: reasoningRow)
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
        controller?.onChange = { [weak self] change in
            guard let self else { return }
            switch change {
            case .conversations, .transcript: self.reload()
            case .streaming: self.updateStreaming()
            }
        }
        reload()
    }

    // MARK: Rendering

    func reload() {
        reloadConversations()
        reloadChoice()
        for child in transcript.arrangedSubviews { transcript.removeArrangedSubview(child); child.removeFromSuperview() }
        streamingRow = nil
        guard let controller else {
            emptyLabel.stringValue = "选择一个项目后，写作助手会在这里工作。"
            add(emptyLabel)
            updateControls()
            return
        }
        let conversation = controller.current
        let messages = conversation?.messages ?? []
        if messages.isEmpty {
            emptyLabel.stringValue = "向写作助手提问，或请它修改正文。它提出的每处修改都会先显示在这里，由你接受或拒绝。"
            add(emptyLabel)
        }
        var shownProposals = Set<String>()
        for message in messages {
            switch message.role {
            case .user:
                add(AgentMessageRow(identifier: "agent-message-\(message.id)", heading: "你", text: message.text, markdown: false, wash: true))
            case .assistant:
                if !message.text.isEmpty {
                    add(AgentMessageRow(identifier: "agent-message-\(message.id)", heading: nil, text: message.text, markdown: true, wash: false))
                }
            case .tool:
                if let activity = message.activity {
                    add(AgentActivityRow(identifier: "agent-activity-\(message.callID ?? message.id)", text: activity, failed: message.ok == false))
                }
                if let id = message.proposalID, let proposal = conversation?.proposal(id), shownProposals.insert(id).inserted {
                    add(AgentProposalCard(proposal: proposal, accept: { [weak self] in self?.controller?.accept(id) },
                                          reject: { [weak self] in self?.controller?.reject(id) }))
                }
            case .notice:
                add(AgentActivityRow(identifier: "agent-notice-\(message.id)", text: message.text, failed: message.isError == true))
            }
        }
        if controller.isRunning {
            let row = AgentMessageRow(identifier: "agent-streaming", heading: nil, text: "", markdown: true, wash: false)
            streamingRow = row
            add(row)
        }
        updateStreaming()
        scrollToEnd()
    }

    private func add(_ view: NSView) {
        transcript.addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: transcript.widthAnchor).isActive = true
    }

    /// Only the streamed row and the status line change per delta.
    func updateStreaming() {
        if let controller, let row = streamingRow {
            let text = controller.streamingText
            row.show(text.isEmpty ? (controller.streamingThinking.isEmpty ? "" : "（正在思考…）") : text, markdown: true)
            row.isHidden = text.isEmpty && controller.streamingThinking.isEmpty
        }
        updateControls()
        scrollToEnd()
    }

    private func updateControls() {
        let running = controller?.isRunning == true
        let hasProject = controller != nil
        statusLabel.stringValue = controller?.activity ?? (running ? "正在回复…" : hasProject ? "⌘↩ 发送" : "")
        stopButton.isHidden = !running
        stopButton.isEnabled = running && controller?.isStopping != true
        sendButton.isEnabled = hasProject && !running && !composer.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        composer.isEditable = hasProject
        for control in [conversationPopup, newButton, providerPopup, modelPopup] as [NSControl] { control.isEnabled = hasProject && !running }
        renameButton.isEnabled = hasProject && controller?.current?.messages.isEmpty == false
        deleteButton.isEnabled = hasProject && !running && controller?.current?.messages.isEmpty == false
        let model = controller?.current?.choice.option ?? AgentModelChoice.standard.option
        thinkingPopup.isEnabled = hasProject && !running && model.reasoning.thinkingModes.count > 1
        effortPopup.isEnabled = hasProject && !running && !model.reasoning.efforts.isEmpty
        settingsButton.isEnabled = true
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

    @objc func send() {
        guard let controller, controller.send(composer.string) else { return }
        composer.string = ""
        updateControls()
    }

    @objc func stop() { controller?.stop() }

    @objc private func pickConversation() {
        guard let id = conversationPopup.selectedItem?.representedObject as? String else { return }
        controller?.select(id)
    }

    @objc func newConversation() { controller?.newConversation() }

    private func present(_ alert: NSAlert, _ done: @escaping (NSApplication.ModalResponse) -> Void) {
        if let presentAlert { presentAlert(alert, done); return }
        if let window = window ?? NSApp.mainWindow { alert.beginSheetModal(for: window, completionHandler: done) }
        else { done(alert.runModal()) }
    }

    @objc func renameConversation() {
        guard let conversation = controller?.current else { return }
        let alert = NSAlert()
        alert.messageText = "重命名对话"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = conversation.title
        field.setAccessibilityIdentifier("agent-rename-field")
        alert.accessoryView = field
        alert.addButton(withTitle: "保存")
        alert.addButton(withTitle: "取消")
        alert.window.initialFirstResponder = field
        present(alert) { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            _ = self?.controller?.rename(conversation.id, title: field.stringValue)
        }
    }

    @objc func deleteConversation() {
        guard let conversation = controller?.current else { return }
        let alert = NSAlert()
        alert.messageText = "删除对话“\(conversation.title)”？"
        alert.informativeText = "对话记录会从这台 Mac 上删除，无法恢复。已经接受并写入的修改不受影响。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "删除")
        alert.addButton(withTitle: "取消")
        present(alert) { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            self?.controller?.delete(conversation.id)
        }
    }

    @objc private func openSettings() { onOpenSettings?() }

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

    /// An accepted proposal: open owners already adopted a revision; counts,
    /// chapter lists and summaries follow here.
    func adoptAgentEffect(_ effect: AgentWorkspaceEffect) {
        switch effect {
        case .prose(let projectID, let kind, let id, let live):
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
        }
    }
}
