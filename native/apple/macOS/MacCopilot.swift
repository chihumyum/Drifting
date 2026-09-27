import AppKit

// MARK: 设置 › Copilot（实验）

/// Copilot's settings: off by default, the writing assistant's providers and
/// Keychain keys, the two tasks, when it runs, its output language and
/// drifts. Every control writes through `LabSettingsStore.setCopilot` at once.
final class MacCopilotSettingsViewController: NSViewController {
    let store: LabSettingsStore
    /// The writing assistant's keys; only a masked tail is shown.
    var credentials: AgentCredentialStore? { didSet { if isViewLoaded { refresh() } } }
    var onManageKeys: (() -> Void)?
    let enabledCheckbox = NSButton(checkboxWithTitle: "启用 Copilot（实验）", target: nil, action: nil)
    let providerPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let modelPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let keyLabel = NSTextField(labelWithString: "")
    let keysButton = NSButton(title: "管理 API Key…", target: nil, action: nil)
    let extractCheckbox = NSButton(checkboxWithTitle: "设定抽取", target: nil, action: nil)
    let patchCheckbox = NSButton(checkboxWithTitle: "补丁建议", target: nil, action: nil)
    let triggerControl = NSSegmentedControl(labels: ["停笔后自动", "仅手动"], trackingMode: .selectOne, target: nil, action: nil)
    let secondsStepper = NSStepper()
    let secondsLabel = NSTextField(labelWithString: "")
    let languagePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let driftCheckbox = NSButton(checkboxWithTitle: "在灵感中启用", target: nil, action: nil)
    let privacyText = SettingsLayout.detail("""
        Copilot 会把要分析的段落（新写或改过的段落，或你选中的段落），连同设定库里的名称、分类和相关设定的已有补丁标题，发送给所选的模型服务。\
        费用、隐私、数据留存和训练条款都由该服务决定。它不会修改正文，每条建议都要你接受或拒绝。
        """)
    private let storageMessage = SettingsLayout.storageLabel()

    init(store: LabSettingsStore) {
        self.store = store
        super.init(nibName: nil, bundle: nil)
        title = "Copilot（实验）"
        enabledCheckbox.target = self; enabledCheckbox.action = #selector(enabledChanged)
        enabledCheckbox.setAccessibilityIdentifier("settings-copilot-enabled")
        for provider in AgentProviderCatalog.providers {
            providerPopup.addItem(withTitle: provider.id.label)
            providerPopup.lastItem?.representedObject = provider.id.rawValue
        }
        providerPopup.target = self; providerPopup.action = #selector(providerChanged)
        providerPopup.setAccessibilityIdentifier("settings-copilot-provider")
        modelPopup.target = self; modelPopup.action = #selector(modelChanged)
        modelPopup.setAccessibilityIdentifier("settings-copilot-model")
        keyLabel.textColor = .secondaryLabelColor
        keyLabel.setAccessibilityIdentifier("settings-copilot-key")
        keysButton.target = self; keysButton.action = #selector(manageKeys)
        keysButton.setAccessibilityIdentifier("settings-copilot-keys")
        extractCheckbox.target = self; extractCheckbox.action = #selector(tasksChanged)
        extractCheckbox.setAccessibilityIdentifier("settings-copilot-extract")
        patchCheckbox.target = self; patchCheckbox.action = #selector(tasksChanged)
        patchCheckbox.setAccessibilityIdentifier("settings-copilot-patches")
        triggerControl.target = self; triggerControl.action = #selector(triggerChanged)
        triggerControl.setAccessibilityIdentifier("settings-copilot-trigger")
        secondsStepper.minValue = CopilotSettings.idleRange.lowerBound
        secondsStepper.maxValue = CopilotSettings.idleRange.upperBound
        secondsStepper.increment = 5
        secondsStepper.valueWraps = false
        secondsStepper.target = self; secondsStepper.action = #selector(secondsChanged)
        secondsStepper.setAccessibilityIdentifier("settings-copilot-seconds")
        secondsLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        secondsLabel.setAccessibilityIdentifier("settings-copilot-seconds-value")
        for language in CopilotSettings.languages {
            languagePopup.addItem(withTitle: language.label)
            languagePopup.lastItem?.representedObject = language.code
        }
        languagePopup.target = self; languagePopup.action = #selector(languageChanged)
        languagePopup.setAccessibilityIdentifier("settings-copilot-language")
        driftCheckbox.target = self; driftCheckbox.action = #selector(driftChanged)
        driftCheckbox.setAccessibilityIdentifier("settings-copilot-drifts")
        privacyText.setAccessibilityIdentifier("settings-copilot-privacy")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        let grid = SettingsLayout.grid([
            ("Copilot", [enabledCheckbox, SettingsLayout.detail("默认关闭。开启后，Copilot 在你写作时安静地读新写的段落，把新出现的设定和设定的状态变化作为建议放进 审阅。")]),
            ("模型服务", [SettingsLayout.line([providerPopup, modelPopup])]),
            ("API Key", [SettingsLayout.line([keyLabel, keysButton]),
                         SettingsLayout.detail("与写作助手共用钥匙串中的同一把 Key，这里不另外保存。")]),
            ("任务", [extractCheckbox, SettingsLayout.detail("从新段落中找出设定库里还没有的人物、地点和物件，建议新建设定。"),
                     patchCheckbox, SettingsLayout.detail("为段落里提到的已有设定找出伤势、身份、关系、所在等状态变化，建议添加设定补丁。")]),
            ("触发", [triggerControl, SettingsLayout.line([secondsStepper, secondsLabel]),
                     SettingsLayout.detail("随时可以用 编辑 › Copilot 分析（⇧⌘I）或正文的右键菜单手动运行。每个项目同时只发一个请求，关闭页面会停止正在进行的分析。")]),
            ("输出语言", [languagePopup, SettingsLayout.detail("建议的简介、补丁标题和内容所用的语言。")]),
            ("灵感", [driftCheckbox, SettingsLayout.detail("灵感用于自由记录，默认不打扰。开启后，漂流正文也会被分析。")]),
        ])
        view = SettingsLayout.page([grid, SettingsLayout.heading("隐私与费用"), privacyText, storageMessage], spacing: [0: 18])
        refresh()
    }

    override func viewWillAppear() { super.viewWillAppear(); refresh() }

    func refresh() {
        guard isViewLoaded else { return }
        let settings = store.settings.copilot
        enabledCheckbox.state = settings.enabled ? .on : .off
        providerPopup.selectItem(at: AgentProviderCatalog.providers.firstIndex { $0.id == settings.provider } ?? 0)
        modelPopup.removeAllItems()
        for model in AgentProviderCatalog.option(settings.provider).models {
            modelPopup.addItem(withTitle: model.label)
            modelPopup.lastItem?.representedObject = model.value
        }
        modelPopup.selectItem(at: AgentProviderCatalog.option(settings.provider).models.firstIndex { $0.value == settings.model } ?? 0)
        keyLabel.stringValue = credentials?.maskedKey(for: settings.provider) ?? "尚未设置 \(settings.provider.label) 的 API Key"
        extractCheckbox.state = settings.extractElements ? .on : .off
        patchCheckbox.state = settings.suggestPatches ? .on : .off
        triggerControl.selectedSegment = settings.trigger == .idle ? 0 : 1
        secondsStepper.doubleValue = settings.idleSeconds
        secondsStepper.isEnabled = settings.trigger == .idle
        secondsLabel.stringValue = "停笔 \(Int(settings.idleSeconds)) 秒后"
        secondsLabel.textColor = settings.trigger == .idle ? .labelColor : .tertiaryLabelColor
        languagePopup.selectItem(at: CopilotSettings.languages.firstIndex { $0.code == settings.language } ?? 0)
        driftCheckbox.state = settings.inDrifts ? .on : .off
        SettingsLayout.storage(storageMessage, store)
    }

    /// Stores a change and shows the stored settings at once, also outside
    /// the settings window (which refreshes every pane as well).
    private func change(_ change: (inout CopilotSettings) -> Void) {
        store.setCopilot(change)
        refresh()
    }

    @objc func enabledChanged() { let on = enabledCheckbox.state == .on; change { $0.enabled = on } }
    @objc func providerChanged() {
        guard let raw = providerPopup.selectedItem?.representedObject as? String, let provider = AgentProviderID(rawValue: raw) else { return }
        change { settings in
            guard settings.provider != provider else { return }
            settings.provider = provider
            settings.model = AgentProviderCatalog.option(provider).models[0].value
        }
    }
    @objc func modelChanged() {
        guard let model = modelPopup.selectedItem?.representedObject as? String else { return }
        change { $0.model = model }
    }
    @objc func tasksChanged() {
        let extract = extractCheckbox.state == .on, patches = patchCheckbox.state == .on
        change { $0.extractElements = extract; $0.suggestPatches = patches }
    }
    @objc func triggerChanged() {
        let trigger: CopilotSettings.Trigger = triggerControl.selectedSegment == 1 ? .manual : .idle
        change { $0.trigger = trigger }
    }
    @objc func secondsChanged() {
        let seconds = secondsStepper.doubleValue
        change { $0.idleSeconds = seconds }
    }
    @objc func languageChanged() {
        guard let code = languagePopup.selectedItem?.representedObject as? String else { return }
        change { $0.language = code }
    }
    @objc func driftChanged() { let on = driftCheckbox.state == .on; change { $0.inDrifts = on } }
    @objc private func manageKeys() { onManageKeys?() }
}

// MARK: 接受 and 拒绝

/// 接受 and 拒绝 of open Copilot suggestions, shared by the 审阅 cards and
/// the chapter's 批注 panel. Both go through the project's Copilot.
final class CopilotSuggestionCommands {
    let controller: () -> CopilotController?
    /// The project's element library, for the categories 接受 may choose.
    let library: () -> WorkspaceElementLibrary?

    init(controller: @escaping () -> CopilotController?, library: @escaping () -> WorkspaceElementLibrary?) {
        self.controller = controller
        self.library = library
    }

    /// Why the last 接受 or 拒绝 of this suggestion failed.
    func failure(_ commentID: String) -> String? { controller()?.failures[commentID] }
    func isDeciding(_ commentID: String) -> Bool { controller()?.deciding.contains(commentID) == true }

    func accept(_ comment: WorkspaceComment, categoryID: String? = nil) { controller()?.accept(comment, categoryID: categoryID) }
    func reject(_ comment: WorkspaceComment) { controller()?.reject(comment) }

    /// 接受到分类 when the suggestion's category is not in the library (or
    /// is 未分类): one item per live category. Nil when 接受 needs no choice.
    func acceptMenu(for comment: WorkspaceComment, prefix: String) -> NSMenu? {
        guard let choices = CopilotController.categoryChoices(for: comment, library: library()), !choices.isEmpty else { return nil }
        let menu = NSMenu(title: "接受到分类")
        menu.autoenablesItems = false
        let heading = NSMenuItem(title: "接受到分类", action: nil, keyEquivalent: "")
        heading.isEnabled = false
        menu.addItem(heading)
        for category in choices {
            menu.addItem(LibraryMenuItem(title: category.name, identifier: "\(prefix)-accept-category-\(category.id)") { [weak self] in
                self?.accept(comment, categoryID: category.id)
            })
        }
        return menu
    }

    /// 接受 pressed: a category menu below the button when one must be
    /// chosen, else the suggestion is accepted at once.
    func pressAccept(_ comment: WorkspaceComment, from button: NSView, prefix: String) {
        if let menu = acceptMenu(for: comment, prefix: prefix) {
            menu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.height + 4), in: button)
        } else {
            accept(comment)
        }
    }
}

// MARK: Tab host

extension MacChapterWorkspace {
    /// The open owner of a chapter or drift body, if a tab or the 全书长卷 shows it.
    func copilotStore(projectID: String, kind: CopilotBodyKind, id: String) -> DocumentStore? {
        let scope: DocumentScope = kind == .chapter ? .chapter(ChapterScope(projectID: projectID, chapterID: id))
            : .drift(DriftScope(projectID: projectID, driftID: id))
        return openView(scope: scope)?.binding.store
    }
}
