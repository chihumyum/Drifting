import AppKit

/// 设置 › 模型服务: the writing assistant's provider keys (masked status;
/// 管理 API Key… opens the key sheet) and 语音转写, the DashScope key the
/// composer's 听写 uses. Keys live only in the lab's Keychain service
/// (`Drifting Native Lab`); a stored key shows only its last four characters.
final class MacModelServicesSettingsViewController: NSViewController {
    var credentials: AgentCredentialStore? { didSet { refresh() } }
    var secrets: AgentSecretStore? { didSet { refresh() } }
    var onManageKeys: (() -> Void)?
    private(set) var providerLabels: [AgentProviderID: NSTextField] = [:]
    let keysButton = NSButton(title: "管理 API Key…", target: nil, action: nil)
    let speechStatus = NSTextField(labelWithString: "")
    let speechField = NSSecureTextField()
    let speechSaveButton = NSButton(title: "保存", target: nil, action: nil)
    let speechClearButton = NSButton(title: "清除", target: nil, action: nil)
    let speechMessage = NSTextField(wrappingLabelWithString: "")

    static let speechNote = """
        写作助手输入框旁的“听写”用阿里云百炼（DashScope）的 Qwen3-ASR 把录音转写成文字，与上方对话模型的 Key 相互独立。\
        转写时，这段录音（16 kHz 单声道）连同本项目的设定名称、别名和分类，故事线、章节和灵感的标题（最多 6000 字）会从这台 Mac 直接发送到百炼，\
        用来识别和校正专有名词；录音不会保存在这台 Mac 上。费用、隐私、数据留存和训练条款都由百炼决定。\
        第一次听写时 macOS 会请你允许使用麦克风。
        """

    init() {
        super.init(nibName: nil, bundle: nil)
        title = "模型服务"
        keysButton.target = self; keysButton.action = #selector(manageKeys)
        keysButton.setAccessibilityIdentifier("settings-models-keys")
        speechStatus.textColor = .secondaryLabelColor
        speechStatus.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        speechStatus.setAccessibilityIdentifier("settings-speech-status")
        speechField.placeholderString = "粘贴新的 DashScope API Key"
        speechField.setAccessibilityIdentifier("settings-speech-field")
        speechSaveButton.target = self; speechSaveButton.action = #selector(saveSpeechKey)
        speechSaveButton.setAccessibilityIdentifier("settings-speech-save")
        speechClearButton.target = self; speechClearButton.action = #selector(clearSpeechKey)
        speechClearButton.setAccessibilityIdentifier("settings-speech-clear")
        speechMessage.font = .systemFont(ofSize: 11)
        speechMessage.isHidden = true
        speechMessage.setAccessibilityIdentifier("settings-speech-message")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        var rows: [(String, [NSView])] = []
        for provider in AgentProviderID.allCases {
            let label = SettingsLayout.value("settings-models-key-\(provider.rawValue)")
            providerLabels[provider] = label
            rows.append((provider.label, [label]))
        }
        rows.append(("", [keysButton, SettingsLayout.detail("写作助手和 Copilot 共用这些 Key，只保存在这台 Mac 的钥匙串里。")]))
        let models = SettingsLayout.grid(rows)
        speechField.widthAnchor.constraint(greaterThanOrEqualToConstant: 240).isActive = true
        let speech = SettingsLayout.grid([
            ("服务", [NSTextField(labelWithString: "阿里云百炼（DashScope）· Qwen3-ASR")]),
            ("API Key", [speechStatus, SettingsLayout.line([speechField, speechSaveButton, speechClearButton]), speechMessage]),
        ])
        view = SettingsLayout.page([SettingsLayout.heading("对话模型"), models, SettingsLayout.heading("语音转写"), speech,
                                    SettingsLayout.detail(Self.speechNote)], spacing: [1: 20])
        refresh()
    }

    override func viewWillAppear() { super.viewWillAppear(); refresh() }

    func refresh() {
        guard isViewLoaded else { return }
        for (provider, label) in providerLabels {
            label.stringValue = credentials?.maskedKey(for: provider) ?? "未设置"
        }
        speechStatus.stringValue = secrets.flatMap(SpeechCredentials.masked) ?? "未设置"
        speechClearButton.isEnabled = secrets.flatMap(SpeechCredentials.masked) != nil
    }

    private func show(_ text: String?, error: Bool) {
        speechMessage.stringValue = text ?? ""
        speechMessage.textColor = error ? .systemRed : .secondaryLabelColor
        speechMessage.isHidden = text == nil
    }

    @objc func saveSpeechKey() {
        guard let secrets else { return }
        do {
            try SpeechCredentials.save(speechField.stringValue, in: secrets)
            speechField.stringValue = ""
            show("已保存语音转写的 Key。", error: false)
        } catch { show(error.localizedDescription, error: true) }
        refresh()
    }

    @objc func clearSpeechKey() {
        guard let secrets else { return }
        do {
            try secrets.removeSecret(account: SpeechCredentials.account)
            show("已清除语音转写的 Key。", error: false)
        } catch { show(error.localizedDescription, error: true) }
        speechField.stringValue = ""
        refresh()
    }

    @objc private func manageKeys() { onManageKeys?() }
}
