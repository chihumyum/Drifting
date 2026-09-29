import AppKit

/// 编辑 › Copilot 修改 (⌃⌘I): a popover at the selection or caret of a
/// chapter or drift body with 局部修改, 问 and 生成章节摘要. It shows the
/// session's state in plain AppKit controls; the session owns the requests
/// and the writes (`CopilotInlineSession`).
final class MacCopilotInlineController: NSViewController {
    let session: CopilotInlineSession
    let modeControl: NSSegmentedControl
    let targetLabel = NSTextField(labelWithString: "")
    let inputField = NSTextField()
    let goButton = NSButton(title: "修改", target: nil, action: nil)
    let statusLabel = NSTextField(wrappingLabelWithString: "")
    /// Removed text struck on a red wash, added text on a green wash.
    let previewLabel = NSTextField(wrappingLabelWithString: "")
    let reasonLabel = NSTextField(wrappingLabelWithString: "")
    let answerLabel = NSTextField(wrappingLabelWithString: "")
    let summaryBeforeLabel = NSTextField(wrappingLabelWithString: "")
    let summaryAfterLabel = NSTextField(wrappingLabelWithString: "")
    let acceptButton = NSButton(title: "接受", target: nil, action: nil)
    let rewriteButton = NSButton(title: "重写", target: nil, action: nil)
    let discardButton = NSButton(title: "放弃", target: nil, action: nil)
    let closeButton = NSButton(title: "关闭", target: nil, action: nil)
    private var popover: NSPopover?
    var onClose: (() -> Void)?
    private static let width: CGFloat = 420

    init(session: CopilotInlineSession) {
        self.session = session
        modeControl = NSSegmentedControl(labels: ["局部修改", "问", session.target.kind == .chapter ? "生成章节摘要" : "生成摘要"],
                                         trackingMode: .selectOne, target: nil, action: nil)
        super.init(nibName: nil, bundle: nil)
        session.onChange = { [weak self] in self?.refresh() }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        let title = NSTextField(labelWithString: "Copilot 修改")
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        modeControl.target = self; modeControl.action = #selector(modeChanged)
        modeControl.selectedSegment = 0
        modeControl.setAccessibilityIdentifier("copilot-inline-mode")
        targetLabel.textColor = .secondaryLabelColor
        targetLabel.font = .systemFont(ofSize: 11)
        targetLabel.setAccessibilityIdentifier("copilot-inline-target")
        inputField.setAccessibilityIdentifier("copilot-inline-input")
        inputField.target = self; inputField.action = #selector(go)
        for (button, id, action) in [(goButton, "copilot-inline-go", #selector(go)), (acceptButton, "copilot-inline-accept", #selector(accept)),
                                     (rewriteButton, "copilot-inline-rewrite", #selector(rewrite)),
                                     (discardButton, "copilot-inline-discard", #selector(discard)),
                                     (closeButton, "copilot-inline-close", #selector(closePopover))] {
            button.target = self; button.action = action
            button.bezelStyle = .rounded; button.controlSize = .small
            button.font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
            button.setAccessibilityIdentifier(id)
        }
        for (label, id) in [(statusLabel, "copilot-inline-status"), (previewLabel, "copilot-inline-preview"), (reasonLabel, "copilot-inline-reason"),
                            (answerLabel, "copilot-inline-answer"), (summaryBeforeLabel, "copilot-inline-summary-before"),
                            (summaryAfterLabel, "copilot-inline-summary-after")] {
            label.font = .systemFont(ofSize: 12)
            label.isSelectable = true
            label.preferredMaxLayoutWidth = Self.width - 28
            label.setAccessibilityIdentifier(id)
        }
        statusLabel.font = .systemFont(ofSize: 11)
        reasonLabel.textColor = .secondaryLabelColor
        reasonLabel.font = .systemFont(ofSize: 11)
        let inputRow = NSStackView(views: [inputField, goButton])
        inputRow.spacing = 6
        let buttons = NSStackView(views: [acceptButton, rewriteButton, discardButton, NSView(), closeButton])
        buttons.spacing = 6
        let stack = NSStackView(views: [title, modeControl, targetLabel, inputRow, statusLabel, previewLabel, reasonLabel, answerLabel,
                                        summaryBeforeLabel, summaryAfterLabel, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        let view = NSView()
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -14),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -12),
            view.widthAnchor.constraint(equalToConstant: Self.width),
            inputRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        for label in [statusLabel, previewLabel, reasonLabel, answerLabel, summaryBeforeLabel, summaryAfterLabel] {
            label.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        self.view = view
        refresh()
    }

    /// Shows the popover at the target's first line when the editor is on
    /// screen; offscreen (acceptance) the controller works without it.
    func present(from textView: NSTextView, range: NSRange) {
        _ = view
        guard let window = textView.window, window.isVisible else { return }
        var rect = textView.firstRect(forCharacterRange: NSRange(location: range.location, length: 0), actualRange: nil)
        rect = window.convertFromScreen(rect)
        rect = textView.convert(rect, from: nil)
        let popover = NSPopover()
        popover.behavior = .semitransient
        popover.animates = false
        popover.contentViewController = self
        popover.show(relativeTo: rect.insetBy(dx: -1, dy: -1), of: textView, preferredEdge: .maxY)
        self.popover = popover
        view.window?.makeFirstResponder(inputField)
    }

    func close() {
        session.cancel()
        popover?.close(); popover = nil
        onClose?()
    }

    // MARK: State

    private static func diff(_ original: String, _ edited: String) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let font = NSFont.systemFont(ofSize: 12)
        for segment in CopilotTextDiff.segments(original, edited) {
            var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.labelColor]
            switch segment.kind {
            case .kept: break
            case .removed:
                attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
                attributes[.foregroundColor] = NSColor.secondaryLabelColor
                attributes[.backgroundColor] = NSColor.systemRed.withAlphaComponent(0.15)
            case .added:
                attributes[.backgroundColor] = NSColor.systemGreen.withAlphaComponent(0.22)
            }
            result.append(NSAttributedString(string: segment.text, attributes: attributes))
        }
        return result
    }

    func refresh() {
        guard isViewLoaded else { return }
        let mode = session.mode
        modeControl.selectedSegment = CopilotInlineSession.Mode.allCases.firstIndex(of: mode) ?? 0
        targetLabel.stringValue = mode == .summary ? "根据整个\(session.target.kind == .chapter ? "章节" : "灵感")正文生成摘要"
            : (mode == .edit ? "修改" : "讨论") + session.target.label
        inputField.isHidden = mode == .summary
        inputField.placeholderString = mode == .edit ? "输入修改要求，例如：收紧节奏、换个更准的动词" : "问一个关于这段文字的问题"
        goButton.title = mode == .edit ? "修改" : mode == .ask ? "问" : "生成"
        let working = session.isWorking
        goButton.isEnabled = !working
        inputField.isEnabled = !working
        modeControl.isEnabled = !working
        for view in [previewLabel, reasonLabel, answerLabel, summaryBeforeLabel, summaryAfterLabel, acceptButton, rewriteButton, discardButton] {
            view.isHidden = true
        }
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.stringValue = ""
        switch session.phase {
        case .ready:
            statusLabel.stringValue = mode == .ask ? "只回答，不修改正文。" : mode == .summary ? "接受后才会写入摘要。" : "接受后才会写入正文，可以撤销。"
        case .working(let text):
            statusLabel.stringValue = text
        case .edited(let original, let edited, let reason):
            previewLabel.attributedStringValue = Self.diff(original, edited)
            previewLabel.isHidden = false
            reasonLabel.stringValue = reason.isEmpty ? "" : "说明：\(reason)"
            reasonLabel.isHidden = reason.isEmpty
            acceptButton.isHidden = false; rewriteButton.isHidden = false; discardButton.isHidden = false
            statusLabel.stringValue = session.acceptRefusal ?? "改动预览：删去的文字带删除线，新增的文字带底色。"
            if session.acceptRefusal != nil { statusLabel.textColor = .systemOrange }
        case .refused(let message):
            statusLabel.stringValue = "未执行：\(message)"
            statusLabel.textColor = .systemOrange
        case .answered:
            answerLabel.stringValue = session.turns.map { "你：\($0.question)\nCopilot：\($0.answer)" }.joined(separator: "\n\n")
            answerLabel.isHidden = false
            statusLabel.stringValue = "可以继续追问。"
            if !working { inputField.stringValue = "" }
        case .summary(let before, let after):
            summaryBeforeLabel.attributedStringValue = NSAttributedString(string: before.isEmpty ? "原摘要：（空）" : "原摘要：\(before)", attributes: [
                .font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor,
                .strikethroughStyle: before.isEmpty ? 0 : NSUnderlineStyle.single.rawValue])
            summaryAfterLabel.attributedStringValue = NSAttributedString(string: "新摘要：\(after)", attributes: [
                .font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.labelColor,
                .backgroundColor: NSColor.systemGreen.withAlphaComponent(0.18)])
            summaryBeforeLabel.isHidden = false; summaryAfterLabel.isHidden = false
            acceptButton.isHidden = false; discardButton.isHidden = false
            statusLabel.stringValue = session.acceptRefusal ?? "接受后写入摘要；放弃不写入任何内容。"
            if session.acceptRefusal != nil { statusLabel.textColor = .systemOrange }
        case .applied(let message):
            statusLabel.stringValue = message
        case .failed(let message):
            statusLabel.stringValue = message
            statusLabel.textColor = .systemRed
            rewriteButton.isHidden = !(mode == .edit && session.instruction != nil)
        }
        if case .answered = session.phase {} else if mode == .ask, !session.turns.isEmpty {
            answerLabel.stringValue = session.turns.map { "你：\($0.question)\nCopilot：\($0.answer)" }.joined(separator: "\n\n")
            answerLabel.isHidden = false
        }
        view.layoutSubtreeIfNeeded()
        popover?.contentSize = view.fittingSize
    }

    // MARK: Actions

    @objc private func modeChanged() {
        let modes = CopilotInlineSession.Mode.allCases
        guard modes.indices.contains(modeControl.selectedSegment) else { return }
        session.select(modes[modeControl.selectedSegment])
        refresh()
    }

    /// 修改, 问 or 生成 for the selected mode.
    @objc func go() {
        switch session.mode {
        case .edit: session.edit(inputField.stringValue)
        case .ask: session.ask(inputField.stringValue)
        case .summary: session.proposeSummary()
        }
    }

    @objc func accept() { session.accept() }
    @objc func rewrite() { session.rewrite() }
    @objc func discard() { session.discard() }
    @objc func closePopover() { close() }
}

// MARK: Tab host

extension MacChapterWorkspace {
    /// Opens Copilot 修改 on a chapter or drift body at the selection (or
    /// the caret's paragraph). One popover at a time.
    func beginCopilotInline(view: NativeDocumentView, projectID: String, kind: CopilotBodyKind, id: String, title: String, selection: NSRange) {
        guard let copilot = copilot?(projectID), copilot.allowsInline else { return }
        copilotInline?.close()
        guard let target = CopilotInlineTarget.make(kind: kind, id: id, text: view.binding.displayedText,
                                                    blocks: view.binding.displayedBlocks, selection: selection) else {
            view.showStatus("请选中文字，或把光标放在有文字的段落里，再使用 Copilot 修改。")
            return
        }
        let session = CopilotInlineSession(workspace: workspaceCore, copilot: copilot, projectID: projectID, target: target, title: title)
        session.onWorkspaceEffect = { [weak self, weak copilot] effect in
            if let adopt = copilot?.onWorkspaceEffect { adopt(effect) } else { self?.adoptAgentEffect(effect) }
        }
        let controller = MacCopilotInlineController(session: session)
        controller.onClose = { [weak self, weak controller] in
            if let self, self.copilotInline === controller { self.copilotInline = nil }
        }
        copilotInline = controller
        controller.present(from: view.textView, range: target.range)
    }
}
