import AppKit

/// 项目资料: one project's 本书简介, 本书字段 and 故事线字段模版 in a sheet, with its
/// chapters counted by status and the book's word total, and its 写作计划
/// (target and daily goal, kept in the lab's settings.json) with the book's
/// progress towards the target. Each part is written on its own, as page
/// fields are: the summary (trimmed) on end-editing when it changed, and each
/// facts list after a row ended editing or was added, removed or moved.
/// Commands run one at a time. A refusal keeps the typed text and rows and
/// shows the reason. 完成 writes what is still being edited, then closes; a
/// refusal keeps the sheet open.
final class ProjectProfileSheet: NSObject, NSTextViewDelegate, NSTextFieldDelegate {
    enum Part { case summary, facts, template }

    let model: ProjectProfileModel
    let window: NSWindow
    let summaryView = NSTextView()
    let factsEditor = ElementFactsEditor(prefix: "project-fact", emptyText: "暂无字段。", maximumHeight: 176)
    let templateEditor = ElementFactsEditor(prefix: "storyline-template-fact",
                                            emptyText: "尚未定义模版字段。可加 视角 / 主角 / 时间线 等。", maximumHeight: 120)
    let doneButton = NSButton(title: "完成", target: nil, action: nil)
    /// 删除项目…: finishes the sheet, then asks to delete (the typed-name sheet).
    let deleteButton = NSButton(title: "删除项目…", target: nil, action: nil)
    var onDeleteProject: (() -> Void)?
    /// “共 3 章 · 草稿 1 · 已完成 2”.
    let chaptersLabel = NSTextField(labelWithString: "正在统计章节…")
    /// “全书 1,234 字”, or 统计中… until every chapter is counted.
    let wordsLabel = NSTextField(labelWithString: WordCountText.pending)
    private let message = NSTextField(wrappingLabelWithString: "")
    /// 写作计划: the target and daily goal as typed, the progress towards the
    /// target, and 节奏统计… (only with a settings store).
    let plans: LabSettingsStore?
    let targetField = NSTextField(string: "")
    let dailyField = NSTextField(string: "")
    let planLabel = NSTextField(labelWithString: "")
    let planBar = BookProgressBar()
    let planMessage = NSTextField(wrappingLabelWithString: "")
    let statsButton = NSButton(title: "节奏统计…", target: nil, action: nil)
    /// 节奏统计… shows the book's 统计 beside the button.
    var onShowStats: ((NSButton) -> Void)?
    private(set) var stored: WorkspaceProjectDetails?
    private(set) var isCommitting = false
    private var queued: [Part] = []
    private var finishing = false
    /// Writes one part's changes; by default through the model.
    var onCommit: ((WorkspaceProjectChanges, @escaping (Result<WorkspaceProjectDetails, Error>) -> Void) -> Void)?
    var onFinish: (() -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }
    private var isEditingSummary: Bool { window.firstResponder === summaryView }

    init(model: ProjectProfileModel, projectName: String, plans: LabSettingsStore? = nil) {
        self.model = model
        self.plans = plans
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 560), styleMask: [.titled],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "项目资料"
        super.init()
        onCommit = { model.update($0, completion: $1) }

        let title = NSTextField(labelWithString: "“\(projectName)”的项目资料")
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.lineBreakMode = .byTruncatingTail
        chaptersLabel.textColor = .secondaryLabelColor
        chaptersLabel.font = .systemFont(ofSize: 12)
        chaptersLabel.setAccessibilityIdentifier("project-chapter-counts")
        wordsLabel.textColor = .secondaryLabelColor
        wordsLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        wordsLabel.setAccessibilityIdentifier("project-word-count")
        summaryView.isRichText = false
        summaryView.allowsUndo = true
        summaryView.font = .systemFont(ofSize: 13)
        summaryView.isVerticallyResizable = true
        summaryView.autoresizingMask = [.width]
        summaryView.textContainer?.widthTracksTextView = true
        summaryView.textContainerInset = NSSize(width: 2, height: 4)
        summaryView.isEditable = false
        summaryView.delegate = self
        summaryView.toolTip = "写下项目简介、核心命题或故事梗概"
        summaryView.setAccessibilityIdentifier("project-summary"); summaryView.setAccessibilityLabel("本书简介")
        let summaryScroll = NSScrollView()
        summaryScroll.hasVerticalScroller = true; summaryScroll.borderType = .bezelBorder
        summaryScroll.documentView = summaryView
        let templateHint = NSTextField(wrappingLabelWithString:
            "之后新建的故事线会自动带上这些字段，内容也会一并复制。已有的故事线不会改变。")
        templateHint.textColor = .secondaryLabelColor
        templateHint.font = .systemFont(ofSize: 12)
        templateHint.setAccessibilityIdentifier("storyline-template-explanation")
        factsEditor.onCommit = { [weak self] in self?.commit(.facts) }
        templateEditor.onCommit = { [weak self] in self?.commit(.template) }
        for editor in [factsEditor, templateEditor] { editor.addButton.isEnabled = false }
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("project-profile-error")
        doneButton.target = self; doneButton.action = #selector(done)
        doneButton.setAccessibilityIdentifier("finish-project-profile")
        deleteButton.target = self; deleteButton.action = #selector(deleteProject)
        deleteButton.bezelStyle = .rounded
        deleteButton.contentTintColor = .systemRed
        deleteButton.setAccessibilityIdentifier("delete-project-from-profile")
        deleteButton.toolTip = "永久删除这个项目及其全部内容；需要输入项目名称确认"
        let buttons = NSStackView(views: [deleteButton, NSView(), doneButton])

        let summaryHeading = heading("本书简介"), factsHeading = heading("本书字段"), templateHeading = heading("故事线字段模版")
        let planSection = makePlanSection()
        let stack = NSStackView(views: [title, chaptersLabel, wordsLabel, planSection, summaryHeading, summaryScroll, factsHeading, factsEditor,
                                        templateHeading, templateHint, templateEditor, message, buttons])
        planSection.isHidden = plans == nil
        stack.setCustomSpacing(18, after: planSection)
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.setCustomSpacing(4, after: title)
        stack.setCustomSpacing(2, after: chaptersLabel)
        // Sections are set apart by spacing and weight only.
        for view in [wordsLabel, summaryScroll, factsEditor, templateEditor] { stack.setCustomSpacing(18, after: view) }
        stack.setCustomSpacing(4, after: templateHeading)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            content.widthAnchor.constraint(equalToConstant: 520),
            title.widthAnchor.constraint(equalTo: stack.widthAnchor),
            chaptersLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
            wordsLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
            summaryScroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            summaryScroll.heightAnchor.constraint(equalToConstant: 72),
            factsEditor.widthAnchor.constraint(equalTo: stack.widthAnchor),
            templateHint.widthAnchor.constraint(equalTo: stack.widthAnchor),
            templateEditor.widthAnchor.constraint(equalTo: stack.widthAnchor),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
            planSection.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        model.onChange = { [weak self] in self?.refresh() }
        if plans != nil {
            NotificationCenter.default.addObserver(self, selector: #selector(planStored(_:)), name: LabSettingsStore.writingPlanDidChange, object: plans)
            showPlan()
        }
        refresh()
        fit()
    }

    private func heading(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        return label
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    // MARK: Writing plan

    private func makePlanSection() -> NSStackView {
        func unit(_ text: String) -> NSTextField {
            let label = NSTextField(labelWithString: text)
            label.textColor = .secondaryLabelColor
            label.font = .systemFont(ofSize: 12)
            return label
        }
        for (field, id, tip) in [(targetField, "writing-plan-target", "全书目标字数；0 表示不设目标。也可以写“12万”"),
                                 (dailyField, "writing-plan-daily", "每日目标字数；0 表示不设目标")] {
            field.alignment = .right
            field.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
            field.delegate = self
            field.toolTip = tip
            field.setAccessibilityIdentifier(id)
            field.widthAnchor.constraint(equalToConstant: 96).isActive = true
        }
        targetField.setAccessibilityLabel("目标总字数"); dailyField.setAccessibilityLabel("每日目标")
        let fields = NSStackView(views: [unit("目标总字数"), targetField, unit("字"), NSView(), unit("每日目标"), dailyField, unit("字")])
        fields.spacing = 6
        planLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        planLabel.textColor = .secondaryLabelColor
        planLabel.setAccessibilityIdentifier("writing-plan-progress")
        planBar.setAccessibilityIdentifier("writing-plan-bar")
        planMessage.textColor = .systemRed
        planMessage.font = .systemFont(ofSize: 12)
        planMessage.isHidden = true
        planMessage.setAccessibilityIdentifier("writing-plan-error")
        statsButton.target = self; statsButton.action = #selector(showStats)
        statsButton.bezelStyle = .recessed
        statsButton.controlSize = .small
        statsButton.setAccessibilityIdentifier("show-book-stats")
        statsButton.toolTip = "全书概览、幕节奏和章节长度节奏"
        let progress = NSStackView(views: [planLabel, NSView(), statsButton])
        progress.spacing = 8
        let section = NSStackView(views: [heading("写作计划"), fields, progress, planBar, planMessage])
        section.orientation = .vertical; section.alignment = .leading; section.spacing = 6
        NSLayoutConstraint.activate([
            fields.widthAnchor.constraint(equalTo: section.widthAnchor), progress.widthAnchor.constraint(equalTo: section.widthAnchor),
            planBar.widthAnchor.constraint(equalTo: section.widthAnchor), planMessage.widthAnchor.constraint(equalTo: section.widthAnchor),
        ])
        return section
    }

    /// The stored plan in both fields, and the progress towards its target.
    private func showPlan() {
        guard let plans else { return }
        let plan = plans.writingPlan(projectID: model.projectID)
        targetField.stringValue = WordCountText.grouped(plan.projectWordTarget)
        dailyField.stringValue = WordCountText.grouped(plan.dailyWordGoal)
        refreshPlanProgress()
    }

    /// “已写 12,345 / 120,000 字 · 10%”, 统计中… until every chapter is counted.
    private func refreshPlanProgress() {
        guard let plans else { return }
        let plan = plans.writingPlan(projectID: model.projectID)
        guard plan.projectWordTarget > 0 else { planLabel.stringValue = "未设目标"; planBar.isHidden = true; return }
        guard let counts = model.wordCounts, counts.ready else {
            planLabel.stringValue = "已写 \(WordCountText.counting) / \(WordCountText.full(plan.projectWordTarget))"
            planBar.isHidden = true; return
        }
        let fraction = min(1, Double(counts.chapterTotal) / Double(plan.projectWordTarget))
        planLabel.stringValue = "已写 \(WordCountText.grouped(counts.chapterTotal)) / \(WordCountText.full(plan.projectWordTarget)) · \(Int((fraction * 100).rounded(.down)))%"
        planBar.fraction = fraction
        planBar.isHidden = false
    }

    /// Writes both fields when they parse; otherwise keeps the typed text and
    /// says why, leaving the stored plan unchanged.
    func commitPlan() {
        guard let plans else { return }
        guard let target = WritingPlan.parse(targetField.stringValue), let daily = WritingPlan.parse(dailyField.stringValue) else {
            showPlanMessage("字数须为 0 到 99,999,999 之间的整数，也可以写“12万”。计划未保存。"); return
        }
        let plan = WritingPlan(projectWordTarget: target, dailyWordGoal: daily)
        if plan != plans.writingPlan(projectID: model.projectID) {
            plans.setWritingPlan(plan, projectID: model.projectID)
            if let problem = plans.storageMessage { showPlanMessage(problem); return }
        }
        showPlanMessage(nil)
        showPlan()
    }

    private func showPlanMessage(_ text: String?) {
        planMessage.stringValue = text ?? ""
        planMessage.isHidden = text == nil
    }

    @objc private func planStored(_ notification: Notification) {
        guard notification.userInfo?["projectID"] as? String == model.projectID else { return }
        // Fields being edited keep their text.
        let editing = [targetField, dailyField].contains { $0.currentEditor() != nil }
        if editing { refreshPlanProgress() } else { showPlan() }
    }

    @objc private func deleteProject() {
        guard onDeleteProject != nil else { return }
        deleteAfterFinishing = true
        done()
    }
    private var deleteAfterFinishing = false

    @objc private func showStats() {
        window.makeFirstResponder(nil)
        onShowStats?(statsButton)
    }

    func controlTextDidEndEditing(_ obj: Notification) {
        guard let field = obj.object as? NSTextField, field === targetField || field === dailyField else { return }
        commitPlan()
    }

    private func fit() {
        guard let content = window.contentView else { return }
        content.layoutSubtreeIfNeeded()
        window.setContentSize(content.fittingSize)
    }

    /// Reads the details and shows the sheet over `parent`, if any.
    func begin(in parent: NSWindow?) {
        model.load()
        parent?.beginSheet(window) { _ in }
    }

    /// The first read fills every part; later model changes only update the
    /// chapter and word counts, since each commit adopts its own reply.
    private func refresh() {
        chaptersLabel.stringValue = model.chapterSummary ?? (model.loading ? "正在统计章节…" : "")
        wordsLabel.stringValue = model.wordSummary
        refreshPlanProgress()
        if stored == nil, let details = model.details {
            apply(details)
            summaryView.isEditable = true
            for editor in [factsEditor, templateEditor] { editor.addButton.isEnabled = true }
            fit()
        } else if stored == nil, let error = model.loadError {
            showMessage(error)
        }
    }

    /// Adopt stored details. Parts with uncommitted text or rows keep them.
    private func apply(_ details: WorkspaceProjectDetails) {
        let previous = stored
        stored = details
        guard let previous else {
            summaryView.string = details.summary
            factsEditor.show(details.facts)
            templateEditor.show(details.storylineTemplate)
            return
        }
        if summaryView.string == previous.summary, summaryView.string != details.summary { summaryView.string = details.summary }
        for (editor, before, after) in [(factsEditor, previous.facts, details.facts),
                                        (templateEditor, previous.storylineTemplate, details.storylineTemplate)] {
            let typed = ElementText.stored(facts: editor.facts)
            if typed == before, typed != after { editor.show(after) }
        }
    }

    // MARK: Commit

    /// The changes this part would write, or nil when it matches the stored value.
    func changes(for part: Part) -> WorkspaceProjectChanges? {
        guard let stored else { return nil }
        switch part {
        case .summary:
            let summary = ElementText.trimmed(summaryView.string)
            return summary == stored.summary ? nil : WorkspaceProjectChanges(summary: summary)
        case .facts:
            let facts = factsEditor.facts
            return ElementText.stored(facts: facts) == stored.facts ? nil : WorkspaceProjectChanges(facts: facts)
        case .template:
            let facts = templateEditor.facts
            return ElementText.stored(facts: facts) == stored.storylineTemplate ? nil : WorkspaceProjectChanges(storylineTemplate: facts)
        }
    }

    /// Writes one part. Commands run one at a time in the order requested.
    func commit(_ part: Part) {
        guard !isCommitting else {
            if !queued.contains(part) { queued.append(part) }
            return
        }
        let submitted = summaryView.string
        guard let changes = changes(for: part), let onCommit else {
            if part == .summary {
                // Nothing to write: show the stored form (spacing trimmed)
                // once the text view has finished ending its edit.
                DispatchQueue.main.async { [weak self] in
                    guard let self, let stored = self.stored, self.summaryView.string == submitted, !self.isEditingSummary else { return }
                    self.summaryView.string = stored.summary
                }
            }
            commitNext(); return
        }
        isCommitting = true
        onCommit(changes) { [weak self] result in
            guard let self else { return }
            self.isCommitting = false
            switch result {
            case .success(let details):
                self.showMessage(nil)
                self.apply(details)
                if part == .summary, self.summaryView.string == submitted, !self.isEditingSummary {
                    self.summaryView.string = details.summary
                }
            case .failure(let error):
                self.showMessage(error.localizedDescription)
            }
            self.commitNext()
        }
    }

    private func commitNext() {
        guard !isCommitting else { return }
        guard !queued.isEmpty else { finishIfIdle(); return }
        commit(queued.removeFirst())
    }

    /// Ends any edit, writes every part that still differs (e.g. one refused
    /// earlier), then closes once all were stored.
    @objc func done() {
        finishing = true
        window.makeFirstResponder(nil)
        for part in [Part.summary, .facts, .template] where changes(for: part) != nil { commit(part) }
        finishIfIdle()
    }

    private func finishIfIdle() {
        guard finishing, !isCommitting, queued.isEmpty else { return }
        finishing = false
        // A refusal keeps the sheet and the typed text for another try.
        guard errorMessage == nil || stored == nil else { deleteAfterFinishing = false; return }
        if let parent = window.sheetParent { parent.endSheet(window) }
        window.orderOut(nil)
        onFinish?()
        if deleteAfterFinishing { deleteAfterFinishing = false; onDeleteProject?() }
    }

    private func showMessage(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    func textDidEndEditing(_ notification: Notification) { commit(.summary) }
    func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        guard selector == #selector(NSResponder.cancelOperation(_:)), let stored else { return false }
        // Escape restores the stored summary without writing.
        summaryView.string = stored.summary
        window.makeFirstResponder(nil)
        return true
    }
}
