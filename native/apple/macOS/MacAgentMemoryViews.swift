import AppKit

/// 作者规则, 工作记忆 and 任务计划 in the 写作助手 panel: collapsible
/// sections above the transcript, set apart by spacing and type weight only.
final class AgentMemorySectionsView: NSView {
    weak var controller: AgentChatController?
    /// Alerts go through the panel so acceptance can answer them.
    var present: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?

    let rules = AgentPanelSection(identifier: "agent-rules", title: "作者规则")
    let memory = AgentPanelSection(identifier: "agent-working-memory", title: "工作记忆")
    let plan = AgentPanelSection(identifier: "agent-plan", title: "任务计划")
    let addRuleButton = AgentPanelSection.button("添加…", "agent-rule-add")
    let editMemoryButton = AgentPanelSection.button("编辑…", "agent-memory-edit")
    let clearMemoryButton = AgentPanelSection.button("清空", "agent-memory-clear")
    /// Why the last rule or memory edit was refused, in red.
    let ruleMessage = AgentPanelSection.message("agent-rule-message")
    let memoryMessage = AgentPanelSection.message("agent-memory-message")
    private(set) var ruleRows: [String: NSView] = [:]

    override init(frame: NSRect) {
        super.init(frame: frame)
        rules.actions = [addRuleButton]
        memory.actions = [editMemoryButton, clearMemoryButton]
        addRuleButton.target = self; addRuleButton.action = #selector(addRule)
        editMemoryButton.target = self; editMemoryButton.action = #selector(editMemory)
        clearMemoryButton.target = self; clearMemoryButton.action = #selector(clearMemory)
        plan.isExpanded = true
        let stack = NSStackView(views: [rules, memory, plan])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 4
        stack.detachesHiddenViews = true
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        for section in [rules, memory, plan] { section.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        reload()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func reload() {
        reloadRules()
        reloadConversation()
    }

    /// The current conversation's working memory and plan.
    func reloadConversation() {
        reloadMemory()
        reloadPlan()
    }

    // MARK: 作者规则

    func reloadRules() {
        let list = controller?.rules ?? []
        rules.title = list.isEmpty ? "作者规则" : "作者规则（\(list.count)）"
        addRuleButton.isEnabled = controller != nil
        ruleRows = [:]
        var views: [NSView] = []
        if list.isEmpty {
            views.append(AgentPanelSection.detail("还没有作者规则。你表达长期的偏好、否决或指令时，写作助手会记下；你也可以自己添加。", "agent-rules-empty"))
        }
        for rule in list {
            let text = AgentPanelSection.detail("【\(rule.kind.label)】\(rule.text)", "agent-rule-text-\(rule.id)")
            text.textColor = .labelColor
            let edit = AgentPanelSection.button("编辑…", "agent-rule-edit-\(rule.id)") { [weak self] in self?.editRule(rule.id) }
            let delete = AgentPanelSection.button("删除", "agent-rule-delete-\(rule.id)") { [weak self] in self?.deleteRule(rule.id) }
            let buttons = NSStackView(views: [NSView(), edit, delete])
            buttons.spacing = 4
            let row = NSStackView(views: [text, buttons])
            row.orientation = .vertical; row.alignment = .leading; row.spacing = 2
            row.setAccessibilityIdentifier("agent-rule-\(rule.id)")
            text.widthAnchor.constraint(equalTo: row.widthAnchor).isActive = true
            buttons.widthAnchor.constraint(equalTo: row.widthAnchor).isActive = true
            ruleRows[rule.id] = row
            views.append(row)
        }
        views.append(ruleMessage)
        rules.setContent(views)
    }

    /// The kind popup and text field of the add and edit alerts.
    private func ruleForm(kind: AgentAuthorRule.Kind, text: String) -> (NSView, NSPopUpButton, NSTextField) {
        let popup = NSPopUpButton()
        for option in AgentAuthorRule.Kind.allCases {
            popup.addItem(withTitle: option.label)
            popup.lastItem?.representedObject = option.rawValue
        }
        popup.selectItem(at: AgentAuthorRule.Kind.allCases.firstIndex(of: kind) ?? 0)
        popup.setAccessibilityIdentifier("agent-rule-kind")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 48))
        field.stringValue = text
        field.placeholderString = "一句不依赖上下文也能看懂的规则"
        field.setAccessibilityIdentifier("agent-rule-field")
        field.cell?.wraps = true; field.cell?.isScrollable = false
        let stack = NSStackView(views: [popup, field])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 6
        stack.frame = NSRect(x: 0, y: 0, width: 300, height: 82)
        field.widthAnchor.constraint(equalToConstant: 300).isActive = true
        field.heightAnchor.constraint(equalToConstant: 48).isActive = true
        return (stack, popup, field)
    }

    private static func kind(_ popup: NSPopUpButton) -> AgentAuthorRule.Kind {
        (popup.selectedItem?.representedObject as? String).flatMap(AgentAuthorRule.Kind.init(rawValue:)) ?? .preference
    }

    private func show(_ label: NSTextField, _ text: String?) {
        label.stringValue = text ?? ""
        label.isHidden = text == nil
    }

    @objc func addRule() {
        guard controller != nil else { return }
        let (form, popup, field) = ruleForm(kind: .preference, text: "")
        let alert = NSAlert()
        alert.messageText = "添加作者规则"
        alert.informativeText = "偏好：你希望怎样写；否决：你明确不要的做法；指令：要一直遵守的要求。规则每轮都会告诉写作助手，不会写入作品。"
        alert.accessoryView = form
        alert.addButton(withTitle: "添加"); alert.addButton(withTitle: "取消")
        alert.window.initialFirstResponder = field
        present?(alert) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn else { return }
            self.show(self.ruleMessage, self.controller?.addRule(kind: Self.kind(popup), text: field.stringValue))
        }
    }

    func editRule(_ id: String) {
        guard let rule = controller?.rules.first(where: { $0.id == id }) else { return }
        let (form, popup, field) = ruleForm(kind: rule.kind, text: rule.text)
        let alert = NSAlert()
        alert.messageText = "编辑作者规则"
        alert.accessoryView = form
        alert.addButton(withTitle: "保存"); alert.addButton(withTitle: "取消")
        alert.window.initialFirstResponder = field
        present?(alert) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn else { return }
            self.show(self.ruleMessage, self.controller?.updateRule(id, kind: Self.kind(popup), text: field.stringValue))
        }
    }

    func deleteRule(_ id: String) {
        guard let rule = controller?.rules.first(where: { $0.id == id }) else { return }
        let alert = NSAlert()
        alert.messageText = "删除这条作者规则？"
        alert.informativeText = rule.line
        alert.alertStyle = .warning
        alert.addButton(withTitle: "删除"); alert.addButton(withTitle: "取消")
        present?(alert) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn else { return }
            self.controller?.deleteRule(id)
            self.show(self.ruleMessage, nil)
        }
    }

    // MARK: 工作记忆

    private func reloadMemory() {
        let conversation = controller?.current
        let text = conversation?.workingMemory ?? ""
        memory.title = text.isEmpty ? "工作记忆（空）" : "工作记忆（\(text.count) 字）"
        editMemoryButton.isEnabled = conversation != nil
        clearMemoryButton.isEnabled = !text.isEmpty
        let body = AgentPanelSection.detail(text.isEmpty ? "本对话还没有工作记忆。写作助手会在长任务中记下进度和结论；你也可以编辑。" : text,
                                            "agent-memory-text")
        if !text.isEmpty { body.textColor = .labelColor; body.font = .systemFont(ofSize: 12) }
        var views: [NSView] = [body]
        if let by = conversation?.workingMemoryUpdatedBy, !text.isEmpty {
            views.append(AgentPanelSection.detail(by == "author" ? "上次由你编辑" : "上次由写作助手更新", "agent-memory-updated"))
        }
        views.append(memoryMessage)
        memory.setContent(views)
    }

    @objc func editMemory() {
        guard let conversation = controller?.current else { return }
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 360, height: 220))
        scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        let editor = NSTextView(frame: NSRect(x: 0, y: 0, width: 360, height: 220))
        editor.isRichText = false; editor.allowsUndo = true
        editor.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        editor.string = conversation.workingMemory
        editor.isVerticallyResizable = true; editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = true
        editor.setAccessibilityIdentifier("agent-memory-editor")
        scroll.documentView = editor
        let alert = NSAlert()
        alert.messageText = "编辑工作记忆"
        alert.informativeText = "本对话的笔记（Markdown，最多 \(AgentWorkingMemory.limit) 字），每轮都会告诉写作助手。"
        alert.accessoryView = scroll
        alert.addButton(withTitle: "保存"); alert.addButton(withTitle: "取消")
        alert.window.initialFirstResponder = editor
        present?(alert) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn else { return }
            self.show(self.memoryMessage, self.controller?.setWorkingMemory(editor.string))
        }
    }

    @objc func clearMemory() {
        guard controller?.current?.workingMemory.isEmpty == false else { return }
        let alert = NSAlert()
        alert.messageText = "清空本对话的工作记忆？"
        alert.informativeText = "写作助手记下的进度和结论会删除，作品内容不受影响。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "清空"); alert.addButton(withTitle: "取消")
        present?(alert) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn else { return }
            self.show(self.memoryMessage, self.controller?.setWorkingMemory(""))
        }
    }

    // MARK: 任务计划

    private func reloadPlan() {
        guard let current = controller?.current?.plan else {
            plan.isHidden = true
            plan.setContent([])
            return
        }
        plan.isHidden = false
        plan.title = "任务计划（\(current.finished)/\(current.steps.count) 完成）"
        let goal = AgentPanelSection.detail("目标：\(current.goal)", "agent-plan-goal")
        goal.textColor = .labelColor
        var views: [NSView] = [goal]
        for (index, step) in current.steps.enumerated() {
            let note = step.note.map { "（\($0)）" } ?? ""
            let row = AgentPanelSection.detail("\(step.status.mark) \(index + 1). \(step.title)\(note)", "agent-plan-step-\(index + 1)")
            row.textColor = step.status == .done || step.status == .skipped ? .secondaryLabelColor : .labelColor
            row.setAccessibilityLabel("第 \(index + 1) 步，\(step.status.label)：\(step.title)\(note)")
            views.append(row)
        }
        if !current.constraints.isEmpty {
            views.append(AgentPanelSection.detail("限制：" + current.constraints.map(\.text).joined(separator: "；"), "agent-plan-constraints"))
        }
        plan.setContent(views)
    }

    /// The plan's checklist lines as shown.
    var planLines: [String] {
        plan.isHidden ? [] : plan.contentViews.compactMap { ($0 as? NSTextField)?.stringValue }
    }
}

/// A titled section with a disclosure triangle; its content scrolls past a
/// maximum height.
final class AgentPanelSection: NSView {
    let toggle = NSButton()
    let titleLabel = NSTextField(labelWithString: "")
    private let header = NSStackView()
    private let scroll = NSScrollView()
    private let document = AgentFlippedView()
    private let content = NSStackView()
    private var height: NSLayoutConstraint!
    static let maxHeight: CGFloat = 150
    static let textWidth: CGFloat = 290

    var title: String {
        get { titleLabel.stringValue }
        set { titleLabel.stringValue = newValue; toggle.setAccessibilityLabel(newValue) }
    }
    var actions: [NSButton] = [] {
        didSet { for view in actions { header.addArrangedSubview(view) } }
    }
    var isExpanded = false {
        didSet { toggle.state = isExpanded ? .on : .off; scroll.isHidden = !isExpanded; fit() }
    }
    var contentViews: [NSView] { content.arrangedSubviews }

    init(identifier: String, title: String) {
        super.init(frame: .zero)
        setAccessibilityIdentifier(identifier)
        toggle.bezelStyle = .disclosure
        toggle.setButtonType(.pushOnPushOff)
        toggle.title = ""
        toggle.target = self; toggle.action = #selector(toggled)
        toggle.setAccessibilityIdentifier(identifier + "-toggle")
        titleLabel.font = .systemFont(ofSize: 12, weight: .semibold)
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        titleLabel.setAccessibilityIdentifier(identifier + "-title")
        header.setViews([toggle, titleLabel, NSView()], in: .leading)
        header.spacing = 4
        content.orientation = .vertical; content.alignment = .leading; content.spacing = 5
        content.detachesHiddenViews = true
        content.translatesAutoresizingMaskIntoConstraints = false
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(content)
        scroll.documentView = document
        scroll.hasVerticalScroller = true; scroll.drawsBackground = false; scroll.borderType = .noBorder
        scroll.isHidden = true
        let stack = NSStackView(views: [header, scroll])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 3
        stack.detachesHiddenViews = true
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        height = scroll.heightAnchor.constraint(equalToConstant: 0)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            header.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor), height,
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            content.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 18),
            content.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -4),
            content.topAnchor.constraint(equalTo: document.topAnchor),
            content.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -2),
        ])
        self.title = title
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func setContent(_ views: [NSView]) {
        for child in content.arrangedSubviews { content.removeArrangedSubview(child); child.removeFromSuperview() }
        for view in views {
            content.addArrangedSubview(view)
            view.widthAnchor.constraint(lessThanOrEqualTo: content.widthAnchor).isActive = true
        }
        fit()
    }

    private func fit() {
        guard isExpanded else { height.constant = 0; return }
        content.layoutSubtreeIfNeeded()
        height.constant = min(content.fittingSize.height + 2, Self.maxHeight)
    }

    @objc private func toggled() { isExpanded = toggle.state == .on }

    static func button(_ title: String, _ identifier: String, pressed: (() -> Void)? = nil) -> NSButton {
        let button = pressed.map { AgentClosureButton(title: title, pressed: $0) } ?? NSButton(title: title, target: nil, action: nil)
        button.bezelStyle = .rounded; button.controlSize = .mini
        button.font = .systemFont(ofSize: NSFont.systemFontSize(for: .mini))
        button.setAccessibilityIdentifier(identifier)
        return button
    }

    static func detail(_ text: String, _ identifier: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: 11)
        label.textColor = .secondaryLabelColor
        label.isSelectable = true
        label.preferredMaxLayoutWidth = textWidth
        label.setAccessibilityIdentifier(identifier)
        return label
    }

    static func message(_ identifier: String) -> NSTextField {
        let label = detail("", identifier)
        label.textColor = .systemRed
        label.isHidden = true
        return label
    }
}

final class AgentClosureButton: NSButton {
    private let pressed: () -> Void
    init(title: String, pressed: @escaping () -> Void) {
        self.pressed = pressed
        super.init(frame: .zero)
        self.title = title
        target = self; action = #selector(press)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    @objc private func press() { pressed() }
}

/// “已记住：…” in the conversation after a rule tool, with 撤销.
final class AgentMemoryCard: NSView, AgentTranscriptRow {
    let label = NSTextField(wrappingLabelWithString: "")
    let undoButton: NSButton
    let change: AgentMemoryChange
    private(set) var plainText = ""

    init(messageID: String, change: AgentMemoryChange, undo: @escaping () -> Void) {
        self.change = change
        undoButton = AgentPanelSection.button("撤销", "agent-memory-undo-\(messageID)", pressed: undo)
        super.init(frame: .zero)
        wantsLayer = true
        setAccessibilityIdentifier("agent-memory-\(messageID)")
        plainText = change.headline
        label.stringValue = change.headline
        label.font = .systemFont(ofSize: 12)
        label.textColor = change.undone == true ? .secondaryLabelColor : .labelColor
        label.isSelectable = true
        label.setAccessibilityIdentifier("agent-memory-text-\(messageID)")
        undoButton.isHidden = change.undone == true
        undoButton.toolTip = "撤销这次对作者规则的修改"
        let stack = NSStackView(views: [label, undoButton])
        stack.orientation = .horizontal; stack.alignment = .firstBaseline; stack.spacing = 6
        stack.detachesHiddenViews = true
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 5),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -5),
        ])
        label.setContentCompressionResistancePriority(.init(1), for: .horizontal)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() {
        layer?.cornerRadius = 6
        layer?.backgroundColor = NSColor.secondaryLabelColor.withAlphaComponent(0.07).cgColor
    }
}
