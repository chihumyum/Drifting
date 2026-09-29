import AppKit
import UniformTypeIdentifiers

/// 设置 (⌘,): 外观, 编辑器, 语言, 快捷键, 模型服务, 写作助手 and Copilot（实验） as toolbar tabs, as Mac settings windows
/// are. Every control writes through `LabSettingsStore` at once, which saves
/// and applies it: open editors restyle in place and every window follows
/// the theme. Controls follow the store, so a refusal never leaves one
/// showing a value that is not in effect.
final class MacSettingsWindowController: NSWindowController, NSWindowDelegate {
    let store: LabSettingsStore
    let appearancePane: MacAppearanceSettingsViewController
    let editorPane: MacEditorSettingsViewController
    let languagePane: MacLanguageSettingsViewController
    let agentPane = MacAgentSettingsViewController()
    /// 写作助手 › MCP 扩展, shown as the second tab of the 写作助手 pane.
    let mcpPane: MacMcpSettingsViewController
    let copilotPane: MacCopilotSettingsViewController
    let shortcutPane: MacShortcutSettingsViewController
    /// Provider keys and 语音转写.
    let modelServicesPane = MacModelServicesSettingsViewController()
    private let tabs = NSTabViewController()

    init(store: LabSettingsStore) {
        self.store = store
        appearancePane = MacAppearanceSettingsViewController(store: store)
        editorPane = MacEditorSettingsViewController(store: store)
        languagePane = MacLanguageSettingsViewController(store: store)
        copilotPane = MacCopilotSettingsViewController(store: store)
        mcpPane = MacMcpSettingsViewController(store: store)
        shortcutPane = MacShortcutSettingsViewController(store: store)
        agentPane.mcpPane = mcpPane
        tabs.tabStyle = .toolbar
        for (controller, label, symbol) in [(appearancePane as NSViewController, "外观", "paintbrush"),
                                            (editorPane, "编辑器", "textformat"), (languagePane, "语言", "globe"),
                                            (shortcutPane, "快捷键", "keyboard"), (modelServicesPane, "模型服务", "key"),
                                            (agentPane, "写作助手", "text.bubble"), (copilotPane, "Copilot（实验）", "sparkles")] {
            let item = NSTabViewItem(viewController: controller)
            item.label = label
            item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
            tabs.addTabViewItem(item)
        }
        let window = NSWindow(contentViewController: tabs)
        window.styleMask = [.titled, .closable]
        window.toolbarStyle = .preference
        window.title = "设置"
        window.isReleasedWhenClosed = false
        window.setAccessibilityIdentifier("settings-window")
        super.init(window: window)
        window.delegate = self
        NotificationCenter.default.addObserver(self, selector: #selector(storeChanged), name: LabSettingsStore.didChange, object: store)
        refresh()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    @objc private func storeChanged() { refresh() }

    func refresh() {
        appearancePane.refresh(); editorPane.refresh(); languagePane.refresh(); agentPane.refresh(); copilotPane.refresh()
        mcpPane.refresh(); shortcutPane.refresh(); modelServicesPane.refresh()
    }

    /// Shows 模型服务 (provider keys and 语音转写).
    func showModelServicesPane() {
        tabs.selectedTabViewItemIndex = tabs.tabViewItems.firstIndex { $0.viewController === modelServicesPane } ?? 0
    }

    /// Shows the 快捷键 tab.
    func showShortcutPane() {
        tabs.selectedTabViewItemIndex = tabs.tabViewItems.firstIndex { $0.viewController === shortcutPane } ?? 0
    }

    /// Shows the 写作助手 tab.
    func showAgentPane() {
        tabs.selectedTabViewItemIndex = tabs.tabViewItems.firstIndex { $0.viewController === agentPane } ?? 0
    }

    /// Shows 写作助手 › MCP 扩展.
    func showMcpPane() {
        showAgentPane()
        agentPane.showMcp()
    }

    /// Shows the Copilot（实验） tab.
    func showCopilotPane() {
        tabs.selectedTabViewItemIndex = tabs.tabViewItems.firstIndex { $0.viewController === copilotPane } ?? 0
    }

    func windowWillClose(_ notification: Notification) {
        appearancePane.accentWell.deactivate()
        editorPane.deactivateWells()
        shortcutPane.endRecording()
    }
}

// MARK: Layout

/// Rows of a settings pane: a trailing-aligned label, then the control with
/// an optional explanation beneath. Sections are set apart by spacing and a
/// semibold heading only.
enum SettingsLayout {
    static let width: CGFloat = 540

    static func heading(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        return label
    }

    static func detail(_ text: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: 11)
        label.textColor = .secondaryLabelColor
        label.preferredMaxLayoutWidth = 360
        return label
    }

    static func grid(_ rows: [(String, [NSView])]) -> NSGridView {
        let grid = NSGridView(views: rows.map { title, views -> [NSView] in
            let label = NSTextField(labelWithString: title)
            label.alignment = .right
            let stack = NSStackView(views: views)
            stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 4
            return [label, stack]
        })
        grid.rowSpacing = 14; grid.columnSpacing = 12
        grid.column(at: 0).xPlacement = .trailing
        grid.column(at: 0).width = 110
        grid.rowAlignment = .firstBaseline
        return grid
    }

    static func line(_ views: [NSView]) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .horizontal; stack.spacing = 8; stack.alignment = .centerY
        return stack
    }

    static func page(_ sections: [NSView], spacing: [Int: CGFloat] = [:]) -> NSView {
        let stack = NSStackView(views: sections)
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        for (index, value) in spacing { stack.setCustomSpacing(value, after: sections[index]) }
        stack.translatesAutoresizingMaskIntoConstraints = false
        let view = NSView()
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -20),
            view.widthAnchor.constraint(equalToConstant: width),
        ])
        return view
    }

    /// Why 设置 could not be read or saved, in red; hidden otherwise.
    static func storage(_ label: NSTextField, _ store: LabSettingsStore) {
        label.stringValue = store.storageMessage ?? ""
        label.isHidden = store.storageMessage == nil
    }

    /// A read-only value beside a grid label.
    static func value(_ identifier: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: "")
        label.preferredMaxLayoutWidth = 360
        label.isSelectable = true
        label.setAccessibilityIdentifier(identifier)
        return label
    }

    /// A pane taller than `height` scrolls inside a window of that height,
    /// so the settings window fits a small screen.
    static func scrolling(_ page: NSView, height: CGFloat) -> NSView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.drawsBackground = false; scroll.borderType = .noBorder
        let document = AgentFlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        page.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(page)
        scroll.documentView = document
        scroll.translatesAutoresizingMaskIntoConstraints = false
        let container = NSView()
        container.addSubview(scroll)
        let fitted = min(height, ceil(page.fittingSize.height))
        NSLayoutConstraint.activate([
            page.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            page.topAnchor.constraint(equalTo: document.topAnchor),
            page.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            document.trailingAnchor.constraint(equalTo: page.trailingAnchor),
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: container.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            container.widthAnchor.constraint(equalToConstant: width + 16),
            container.heightAnchor.constraint(equalToConstant: max(fitted, 200)),
        ])
        return container
    }

    static func storageLabel() -> NSTextField {
        let label = detail("")
        label.textColor = .systemRed
        label.isHidden = true
        label.setAccessibilityIdentifier("settings-storage-message")
        return label
    }
}

// MARK: 外观

final class MacAppearanceSettingsViewController: NSViewController {
    let store: LabSettingsStore
    let themeControl = NSSegmentedControl(labels: ["浅色", "深色", "跟随系统"], trackingMode: .selectOne, target: nil, action: nil)
    let accentWell = NSColorWell(style: .minimal)
    let accentValue = NSTextField(labelWithString: "")
    let accentReset = NSButton(title: "恢复默认", target: nil, action: nil)
    private let storageMessage = SettingsLayout.storageLabel()

    init(store: LabSettingsStore) {
        self.store = store
        super.init(nibName: nil, bundle: nil)
        title = "外观"
        themeControl.target = self; themeControl.action = #selector(themeChanged)
        themeControl.setAccessibilityIdentifier("settings-theme")
        accentWell.target = self; accentWell.action = #selector(accentChanged)
        accentWell.setAccessibilityIdentifier("settings-accent")
        accentValue.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        accentValue.textColor = .secondaryLabelColor
        accentValue.setAccessibilityIdentifier("settings-accent-value")
        accentReset.bezelStyle = .rounded; accentReset.controlSize = .small
        accentReset.target = self; accentReset.action = #selector(resetAccent)
        accentReset.setAccessibilityIdentifier("settings-accent-reset")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        NSLayoutConstraint.activate([accentWell.widthAnchor.constraint(equalToConstant: 44), accentWell.heightAnchor.constraint(equalToConstant: 24)])
        let grid = SettingsLayout.grid([
            ("主题", [themeControl, SettingsLayout.detail("跟随系统时随 macOS 的浅色或深色外观切换。所有窗口与面板一同变化。")]),
            ("界面强调色", [SettingsLayout.line([accentWell, accentValue, accentReset]),
                       SettingsLayout.detail("用于选中的文字、当前标签与面板中的选中状态；正文光标默认也跟随它，可在“编辑器 › 光标颜色”中另选。")]),
        ])
        view = SettingsLayout.page([grid, storageMessage])
        refresh()
    }

    func refresh() {
        themeControl.selectedSegment = LabSettings.Theme.allCases.firstIndex(of: store.settings.theme) ?? 2
        if let hex = store.settings.accentColor, let color = DocumentStyle.linkColor(hex: hex) {
            if accentWell.color.usingColorSpace(.sRGB).map(Self.hex) != hex { accentWell.color = color }
            accentValue.stringValue = hex
            accentReset.isHidden = false
        } else {
            accentWell.color = .controlAccentColor
            accentValue.stringValue = "跟随系统"
            accentReset.isHidden = true
        }
        SettingsLayout.storage(storageMessage, store)
    }

    static func hex(_ color: NSColor) -> String {
        guard let rgb = color.usingColorSpace(.sRGB) else { return "#000000" }
        let value = { (component: CGFloat) in Int((min(max(component, 0), 1) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", value(rgb.redComponent), value(rgb.greenComponent), value(rgb.blueComponent))
    }

    @objc func themeChanged() {
        let themes = LabSettings.Theme.allCases
        guard themes.indices.contains(themeControl.selectedSegment) else { return }
        store.update { $0.theme = themes[themeControl.selectedSegment] }
    }
    @objc func accentChanged() {
        let hex = Self.hex(accentWell.color)
        store.update { $0.accentColor = hex }
    }
    @objc func resetAccent() { store.update { $0.accentColor = nil } }
}

// MARK: 编辑器

final class MacEditorSettingsViewController: NSViewController, NSComboBoxDelegate {
    let store: LabSettingsStore
    let preview = NSTextView()
    let fontPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let familyField = NSComboBox()
    let useFamilyButton = NSButton(title: "使用", target: nil, action: nil)
    let importButton = NSButton(title: "导入字体…", target: nil, action: nil)
    let removeFontButton = NSButton(title: "移除", target: nil, action: nil)
    let importedDetail = SettingsLayout.detail("")
    /// The font action's result or why the chosen font is not in use.
    let fontMessage = NSTextField(wrappingLabelWithString: "")
    let sizeSlider = NSSlider(value: 17, minValue: LabSettings.fontSizes.lowerBound, maxValue: LabSettings.fontSizes.upperBound,
                              target: nil, action: nil)
    let sizeValue = NSTextField(labelWithString: "")
    let lineHeightSlider = NSSlider(value: 1.5, minValue: LabSettings.lineHeights.lowerBound, maxValue: LabSettings.lineHeights.upperBound,
                                    target: nil, action: nil)
    let lineHeightValue = NSTextField(labelWithString: "")
    let indentControl = NSSegmentedControl(labels: ["无", "一字符", "两字符"], trackingMode: .selectOne, target: nil, action: nil)
    let resetButton = NSButton(title: "还原推荐样式", target: nil, action: nil)
    let paragraphSpacingSlider = NSSlider(value: 0.7, minValue: LabSettings.paragraphSpacings.lowerBound,
                                          maxValue: LabSettings.paragraphSpacings.upperBound, target: nil, action: nil)
    let paragraphSpacingValue = NSTextField(labelWithString: "")
    let columnWidthSlider = NSSlider(value: 760, minValue: LabSettings.columnWidths.lowerBound,
                                     maxValue: LabSettings.columnWidths.upperBound, target: nil, action: nil)
    let columnWidthValue = NSTextField(labelWithString: "")
    let typewriterCheckbox = NSButton(checkboxWithTitle: "打字机滚动", target: nil, action: nil)
    let typewriterPositionSlider = NSSlider(value: 40, minValue: LabSettings.typewriterPositions.lowerBound,
                                            maxValue: LabSettings.typewriterPositions.upperBound, target: nil, action: nil)
    let typewriterPositionValue = NSTextField(labelWithString: "")
    let autoLinkCheckbox = NSButton(checkboxWithTitle: "自动链接设定名称", target: nil, action: nil)
    let indentStepControl = NSSegmentedControl(labels: LabSettings.indentSteps.map { "\($0) 字符" }, trackingMode: .selectOne,
                                               target: nil, action: nil)
    let caretModeControl = NSSegmentedControl(labels: ["跟随强调色", "自定义"], trackingMode: .selectOne, target: nil, action: nil)
    let caretWell = NSColorWell(style: .minimal)
    let caretValue = NSTextField(labelWithString: "")
    let linkStyleControl = NSSegmentedControl(labels: ["按分类着色", "按类型着色", "仅悬停时显示", "不着色"], trackingMode: .selectOne,
                                              target: nil, action: nil)
    /// 按类型着色's colour of 设定, 章节 and 漂流 links.
    let linkColorWells = EntityLinkStyle.Kind.allCases.map { _ in NSColorWell(style: .minimal) }
    let linkColorValues = EntityLinkStyle.Kind.allCases.map { _ in NSTextField(labelWithString: "") }
    let linkColorReset = NSButton(title: "恢复默认颜色", target: nil, action: nil)
    /// The first caret colour 自定义 offers: the renderer's default caret.
    static let customCaretDefault = "#6B7FA6"
    static let linkKindNames: [EntityLinkStyle.Kind: String] = [.element: "设定", .chapter: "章节", .drift: "漂流"]
    let autosaveText = SettingsLayout.detail("每次输入提交后立即保存到本机，没有需要设置的间隔。历史版本在保存时最多每 15 分钟记录一次，关闭页面时也会记录。")
    private let storageMessage = SettingsLayout.storageLabel()
    /// The font rows; the message row shows only with a message.
    private var fontsGrid: NSGridView?
    /// The 书写 rows; 类型颜色 shows only with 按类型着色.
    private(set) var writingGrid: NSGridView?
    static let linkColorRow = 4
    /// Picks the font file to import; by default an open panel.
    var chooseFontFile: ((@escaping (URL?) -> Void) -> Void)?

    static let previewText = [
        "沉默在两人之间蔓延，像潮水漫过礁石。她终于开口，声音轻得几乎被海风吹散，落在他听不真切的地方。",
        "“你还会回来吗？”他没有立刻回答，只是望着那轮渐渐沉入海平线的夕阳，许久才轻轻点头。",
    ]

    init(store: LabSettingsStore) {
        self.store = store
        super.init(nibName: nil, bundle: nil)
        title = "编辑器"
        preview.isEditable = false; preview.isSelectable = false
        preview.isVerticallyResizable = false
        preview.drawsBackground = false
        preview.textContainerInset = NSSize(width: 4, height: 8)
        preview.setAccessibilityIdentifier("settings-preview")
        fontPopup.autoenablesItems = false
        for (title, source) in [("系统衬线", LabSettings.FontSource.systemSerif), ("系统无衬线", .systemSans), ("系统等宽", .systemMono),
                                ("系统字体", .systemCustom), ("导入字体", .imported)] {
            fontPopup.addItem(withTitle: title)
            fontPopup.lastItem?.representedObject = source.rawValue
            fontPopup.lastItem?.setAccessibilityIdentifier("settings-font-\(source.rawValue)")
        }
        fontPopup.target = self; fontPopup.action = #selector(fontSourceChanged)
        fontPopup.setAccessibilityIdentifier("settings-font-source")
        familyField.addItems(withObjectValues: NSFontManager.shared.availableFontFamilies.filter { !$0.hasPrefix(".") }.sorted())
        familyField.completes = true
        familyField.numberOfVisibleItems = 12
        familyField.placeholderString = "例如：霞鹜文楷"
        familyField.delegate = self
        familyField.target = self; familyField.action = #selector(useFamily)
        familyField.setAccessibilityIdentifier("settings-font-family")
        useFamilyButton.target = self; useFamilyButton.action = #selector(useFamily)
        useFamilyButton.setAccessibilityIdentifier("settings-use-font-family")
        importButton.target = self; importButton.action = #selector(importFont)
        importButton.setAccessibilityIdentifier("settings-import-font")
        removeFontButton.target = self; removeFontButton.action = #selector(removeFont)
        removeFontButton.setAccessibilityIdentifier("settings-remove-font")
        importedDetail.setAccessibilityIdentifier("settings-imported-font")
        fontMessage.font = .systemFont(ofSize: 12)
        fontMessage.preferredMaxLayoutWidth = 360
        fontMessage.isHidden = true
        fontMessage.setAccessibilityIdentifier("settings-font-message")
        sizeSlider.target = self; sizeSlider.action = #selector(sizeChanged)
        sizeSlider.setAccessibilityIdentifier("settings-font-size")
        lineHeightSlider.target = self; lineHeightSlider.action = #selector(lineHeightChanged)
        lineHeightSlider.setAccessibilityIdentifier("settings-line-height")
        paragraphSpacingSlider.target = self; paragraphSpacingSlider.action = #selector(paragraphSpacingChanged)
        paragraphSpacingSlider.setAccessibilityIdentifier("settings-paragraph-spacing")
        columnWidthSlider.target = self; columnWidthSlider.action = #selector(columnWidthChanged)
        columnWidthSlider.setAccessibilityIdentifier("settings-column-width")
        typewriterPositionSlider.target = self; typewriterPositionSlider.action = #selector(typewriterPositionChanged)
        typewriterPositionSlider.setAccessibilityIdentifier("settings-typewriter-position")
        autoLinkCheckbox.target = self; autoLinkCheckbox.action = #selector(autoLinkChanged)
        autoLinkCheckbox.setAccessibilityIdentifier("settings-auto-link")
        paragraphSpacingValue.setAccessibilityIdentifier("settings-paragraph-spacing-value")
        columnWidthValue.setAccessibilityIdentifier("settings-column-width-value")
        typewriterPositionValue.setAccessibilityIdentifier("settings-typewriter-position-value")
        for label in [sizeValue, lineHeightValue, paragraphSpacingValue, columnWidthValue, typewriterPositionValue] {
            label.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
            label.textColor = .secondaryLabelColor
        }
        sizeValue.setAccessibilityIdentifier("settings-font-size-value")
        lineHeightValue.setAccessibilityIdentifier("settings-line-height-value")
        indentControl.target = self; indentControl.action = #selector(indentChanged)
        indentControl.setAccessibilityIdentifier("settings-indent")
        resetButton.target = self; resetButton.action = #selector(resetTypesetting)
        resetButton.setAccessibilityIdentifier("settings-reset-typesetting")
        typewriterCheckbox.target = self; typewriterCheckbox.action = #selector(typewriterChanged)
        typewriterCheckbox.setAccessibilityIdentifier("settings-typewriter")
        autosaveText.setAccessibilityIdentifier("settings-autosave")
        indentStepControl.target = self; indentStepControl.action = #selector(indentStepChanged)
        indentStepControl.setAccessibilityIdentifier("settings-indent-step")
        caretModeControl.target = self; caretModeControl.action = #selector(caretModeChanged)
        caretModeControl.setAccessibilityIdentifier("settings-caret-mode")
        // Wells report once a colour is chosen, not on every colour-panel
        // tick: each report restyles every editor and saves settings.json.
        caretWell.isContinuous = false
        linkColorWells.forEach { $0.isContinuous = false }
        caretWell.target = self; caretWell.action = #selector(caretColorChanged)
        caretWell.setAccessibilityIdentifier("settings-caret-color")
        caretValue.setAccessibilityIdentifier("settings-caret-value")
        linkStyleControl.target = self; linkStyleControl.action = #selector(linkStyleChanged)
        linkStyleControl.setAccessibilityIdentifier("settings-link-style")
        for (index, kind) in EntityLinkStyle.Kind.allCases.enumerated() {
            linkColorWells[index].target = self; linkColorWells[index].action = #selector(linkColorChanged(_:))
            linkColorWells[index].setAccessibilityIdentifier("settings-link-color-\(kind.rawValue)")
            linkColorWells[index].setAccessibilityLabel("\(Self.linkKindNames[kind] ?? "")链接颜色")
            linkColorValues[index].setAccessibilityIdentifier("settings-link-color-value-\(kind.rawValue)")
        }
        linkColorReset.bezelStyle = .rounded; linkColorReset.controlSize = .small
        linkColorReset.target = self; linkColorReset.action = #selector(resetLinkColors)
        linkColorReset.setAccessibilityIdentifier("settings-link-color-reset")
        for label in [caretValue] + linkColorValues {
            label.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
            label.textColor = .secondaryLabelColor
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        preview.textContainer?.widthTracksTextView = true
        // The preview sits on a soft wash; it clips rather than scrolls.
        let wash = NSBox()
        wash.boxType = .custom; wash.borderWidth = 0; wash.cornerRadius = 8
        wash.fillColor = NSColor.secondaryLabelColor.withAlphaComponent(0.06)
        wash.contentViewMargins = NSSize(width: 8, height: 4)
        wash.contentView = preview
        wash.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            wash.widthAnchor.constraint(equalToConstant: SettingsLayout.width - 48),
            wash.heightAnchor.constraint(equalToConstant: 150),
            familyField.widthAnchor.constraint(equalToConstant: 240),
            sizeSlider.widthAnchor.constraint(equalToConstant: 200),
            lineHeightSlider.widthAnchor.constraint(equalToConstant: 200),
            paragraphSpacingSlider.widthAnchor.constraint(equalToConstant: 200),
            columnWidthSlider.widthAnchor.constraint(equalToConstant: 200),
            typewriterPositionSlider.widthAnchor.constraint(equalToConstant: 200),
            caretWell.widthAnchor.constraint(equalToConstant: 44), caretWell.heightAnchor.constraint(equalToConstant: 24),
        ] + linkColorWells.flatMap { [$0.widthAnchor.constraint(equalToConstant: 36), $0.heightAnchor.constraint(equalToConstant: 22)] })
        let fonts = SettingsLayout.grid([
            ("创作内容字体", [fontPopup, SettingsLayout.detail("作用于章节、设定、故事线与漂流的正文；界面始终使用系统字体。字体选择只保存在本机。")]),
            ("系统字体", [SettingsLayout.line([familyField, useFamilyButton]),
                      SettingsLayout.detail("从本机已安装的字体家族中选择，或输入家族名称后按“使用”。")]),
            ("导入字体", [SettingsLayout.line([importButton, removeFontButton]), importedDetail]),
            ("", [fontMessage]),
        ])
        fontsGrid = fonts
        let typesetting = SettingsLayout.grid([
            ("字号", [SettingsLayout.line([sizeSlider, sizeValue]), SettingsLayout.detail("只影响编辑视图；标题随正文字号缩放，导出稿件不受影响。")]),
            ("行距", [SettingsLayout.line([lineHeightSlider, lineHeightValue])]),
            ("段间距", [SettingsLayout.line([paragraphSpacingSlider, paragraphSpacingValue]),
                     SettingsLayout.detail("段落之间的距离，以字号为单位；只影响编辑视图、全书长卷和打印。")]),
            ("段首缩进", [indentControl, SettingsLayout.detail("只作用于正文段落；标题、引用与列表不缩进。")]),
            ("Tab 缩进", [indentStepControl, SettingsLayout.detail("按 Tab 给段落整体缩进一级的宽度，⇧Tab 退回一级；打印也按这个宽度。")]),
            ("版心宽度", [SettingsLayout.line([columnWidthSlider, columnWidthValue]),
                      SettingsLayout.detail("正文一栏最宽多少；窗口更宽时正文居中，更窄时随窗口收窄。全书长卷也按这个宽度排版。")]),
            ("", [resetButton]),
        ])
        let writing = SettingsLayout.grid([
            ("输入", [typewriterCheckbox,
                    SettingsLayout.detail("输入时让光标所在行停在编辑区的固定高度，所有正文编辑器和全书长卷都适用；手动滚动不受影响，下次输入时再回到这一高度。")]),
            ("打字机位置", [SettingsLayout.line([typewriterPositionSlider, typewriterPositionValue]),
                       SettingsLayout.detail("光标所在行距编辑区顶部的比例：25% 靠上，50% 居中，75% 靠下。打字机滚动打开时生效。")]),
            ("光标颜色", [SettingsLayout.line([caretModeControl, caretWell, caretValue]),
                      SettingsLayout.detail("正文输入光标的颜色。跟随强调色时随“外观 › 界面强调色”变化，未设置时为系统强调色。")]),
            ("链接样式", [linkStyleControl,
                      SettingsLayout.detail("正文里设定、章节和漂流链接的样子。按分类着色：设定用所属分类的颜色，其他用默认蓝色；按类型着色：每类链接一种颜色；仅悬停时显示：平时与正文相同，指针停在链接上时才显示颜色；不着色：正文颜色加灰色下划线。链接照常可以 ⌘-点按打开并显示悬停卡片。")]),
            ("类型颜色", [SettingsLayout.line(EntityLinkStyle.Kind.allCases.enumerated().flatMap { index, kind -> [NSView] in
                          [NSTextField(labelWithString: Self.linkKindNames[kind] ?? ""), linkColorWells[index], linkColorValues[index]]
                      } + [linkColorReset])]),
            ("设定链接", [autoLinkCheckbox,
                      SettingsLayout.detail("输入停下后，把正文中出现的设定名称、别名和章节标题自动链接到对应页面。关闭后不再新增链接（用 @ 插入的名称也不链接），已有的链接保留。")]),
        ])
        writingGrid = writing
        let saving = SettingsLayout.grid([("自动保存", [autosaveText])])
        let previewHeading = SettingsLayout.heading("预览"), fontHeading = SettingsLayout.heading("字体")
        let typesettingHeading = SettingsLayout.heading("排版"), savingHeading = SettingsLayout.heading("保存")
        let writingHeading = SettingsLayout.heading("书写")
        let sections: [NSView] = [previewHeading, wash, fontHeading, fonts, typesettingHeading, typesetting, writingHeading, writing,
                                  savingHeading, saving, storageMessage]
        // The pane is taller than a small screen: it scrolls.
        view = SettingsLayout.scrolling(SettingsLayout.page(sections, spacing: [1: 22, 3: 22, 5: 22, 7: 22]), height: 700)
        refresh()
    }

    /// The 光标颜色 and 类型颜色 wells let go of the colour panel.
    func deactivateWells() { ([caretWell] + linkColorWells).forEach { $0.deactivate() } }

    func refresh() {
        let settings = store.settings
        let sources = LabSettings.FontSource.allCases
        if let custom = fontPopup.item(at: sources.firstIndex(of: .systemCustom)!) {
            custom.title = settings.systemFontFamily.isEmpty ? "系统字体（尚未指定字体家族）" : "系统字体（\(settings.systemFontFamily)）"
            custom.isEnabled = !settings.systemFontFamily.isEmpty
        }
        if let imported = fontPopup.item(at: sources.firstIndex(of: .imported)!) {
            imported.title = settings.importedFont.map { "导入字体（\($0.fileName)）" } ?? "导入字体（尚未导入字体文件）"
            imported.isEnabled = settings.importedFont != nil
        }
        fontPopup.selectItem(at: sources.firstIndex(of: settings.fontSource) ?? 0)
        if familyField.currentEditor() == nil, !settings.systemFontFamily.isEmpty { familyField.stringValue = settings.systemFontFamily }
        importButton.title = settings.importedFont == nil ? "导入字体…" : "替换…"
        removeFontButton.isHidden = settings.importedFont == nil
        importedDetail.stringValue = settings.importedFont.map {
            "\($0.fileName) · \(ByteCountFormatter.string(fromByteCount: Int64($0.byteLength), countStyle: .file)) · \($0.family)"
        } ?? "支持 TTF 或 OTF，最大 64 MB。副本保存在本应用的数据目录中，只在本应用内使用。"
        // A refused action first, then why the chosen font is not in use.
        var message = store.fontNotice
        if message?.isError != true, let fallback = store.fontFallback { message = (fallback, true) }
        fontMessage.stringValue = message?.text ?? ""
        fontMessage.textColor = message?.isError == true ? .systemRed : .secondaryLabelColor
        fontMessage.isHidden = message == nil
        fontsGrid?.row(at: 3).isHidden = message == nil
        sizeSlider.doubleValue = settings.fontSize
        sizeValue.stringValue = "\(Int(settings.fontSize)) pt"
        lineHeightSlider.doubleValue = settings.lineHeight
        lineHeightValue.stringValue = String(format: "%.2f", settings.lineHeight)
        indentControl.selectedSegment = LabSettings.Indent.allCases.firstIndex(of: settings.paragraphIndent) ?? 0
        typewriterCheckbox.state = settings.typewriterScrolling ? .on : .off
        paragraphSpacingSlider.doubleValue = settings.paragraphSpacing
        paragraphSpacingValue.stringValue = String(format: "%.1f 倍字号", settings.paragraphSpacing)
        columnWidthSlider.doubleValue = settings.columnWidth
        columnWidthValue.stringValue = "\(Int(settings.columnWidth)) pt"
        typewriterPositionSlider.doubleValue = settings.typewriterPosition
        typewriterPositionValue.stringValue = "\(Int(settings.typewriterPosition))%"
        typewriterPositionSlider.isEnabled = settings.typewriterScrolling
        autoLinkCheckbox.state = settings.autoEntityLinks ? .on : .off
        indentStepControl.selectedSegment = settings.indentStep - LabSettings.indentSteps.lowerBound
        let caret = settings.caretColor
        caretModeControl.selectedSegment = caret == nil ? 0 : 1
        caretWell.isEnabled = caret != nil
        if let caret, let color = DocumentStyle.linkColor(hex: caret) {
            if MacAppearanceSettingsViewController.hex(caretWell.color) != caret { caretWell.color = color }
            caretValue.stringValue = caret
        } else {
            caretWell.color = MacEditorPreferences.caretColor ?? .labAccent
            caretValue.stringValue = settings.accentColor.map { "界面强调色 \($0)" } ?? "系统强调色"
        }
        linkStyleControl.selectedSegment = EntityLinkStyle.Mode.allCases.firstIndex(of: settings.entityLinkStyle) ?? 0
        let style = settings.linkStyle
        for (index, kind) in EntityLinkStyle.Kind.allCases.enumerated() {
            let hex = style.color(for: kind)
            if MacAppearanceSettingsViewController.hex(linkColorWells[index].color) != hex, let color = DocumentStyle.linkColor(hex: hex) {
                linkColorWells[index].color = color
            }
            linkColorValues[index].stringValue = hex
        }
        linkColorReset.isEnabled = !settings.entityLinkColors.isEmpty
        writingGrid?.row(at: Self.linkColorRow).isHidden = settings.entityLinkStyle != .kind
        preview.textStorage?.setAttributedString(NSAttributedString(string: Self.previewText.joined(separator: "\n"),
                                                                    attributes: DocumentStyle.bodyAttributes))
        SettingsLayout.storage(storageMessage, store)
    }

    @objc func fontSourceChanged() {
        guard let raw = fontPopup.selectedItem?.representedObject as? String, let source = LabSettings.FontSource(rawValue: raw) else { return }
        store.update { $0.fontSource = source }
        refresh()
    }
    @objc func useFamily() {
        store.useSystemFamily(familyField.stringValue)
    }
    func comboBoxSelectionDidChange(_ notification: Notification) {
        guard familyField.indexOfSelectedItem >= 0, let family = familyField.objectValueOfSelectedItem as? String else { return }
        familyField.stringValue = family
        store.useSystemFamily(family)
    }
    @objc func importFont() {
        let choose = chooseFontFile ?? { [weak self] done in
            let panel = NSOpenPanel()
            panel.allowedContentTypes = LabSettingsStore.fontExtensions.compactMap { UTType(filenameExtension: $0) }
            panel.message = "选择一个 TTF 或 OTF 字体文件。副本会保存在本应用的数据目录中，只在本应用内使用。"
            panel.prompt = "导入"
            if let window = self?.view.window {
                panel.beginSheetModal(for: window) { done($0 == .OK ? panel.url : nil) }
            } else {
                done(panel.runModal() == .OK ? panel.url : nil)
            }
        }
        choose { [weak self] url in
            guard let self, let url else { return }
            self.store.importFont(from: url)
        }
    }
    @objc func removeFont() { store.removeImportedFont() }
    @objc func typewriterChanged() {
        let on = typewriterCheckbox.state == .on
        store.update { $0.typewriterScrolling = on }
    }
    @objc func typewriterPositionChanged() {
        let value = typewriterPositionSlider.doubleValue.rounded()
        store.update { $0.typewriterPosition = value }
        refresh()
    }
    @objc func paragraphSpacingChanged() {
        let value = (paragraphSpacingSlider.doubleValue * 10).rounded() / 10
        store.update { $0.paragraphSpacing = value }
        refresh()
    }
    @objc func columnWidthChanged() {
        let value = (columnWidthSlider.doubleValue / 10).rounded() * 10
        store.update { $0.columnWidth = value }
        refresh()
    }
    @objc func autoLinkChanged() {
        let on = autoLinkCheckbox.state == .on
        store.update { $0.autoEntityLinks = on }
    }
    @objc func sizeChanged() {
        let value = sizeSlider.doubleValue.rounded()
        store.update { $0.fontSize = value }
        refresh()
    }
    @objc func lineHeightChanged() {
        let value = (lineHeightSlider.doubleValue * 20).rounded() / 20
        store.update { $0.lineHeight = value }
        refresh()
    }
    @objc func indentChanged() {
        let indents = LabSettings.Indent.allCases
        guard indents.indices.contains(indentControl.selectedSegment) else { return }
        store.update { $0.paragraphIndent = indents[indentControl.selectedSegment] }
    }
    @objc func resetTypesetting() { store.resetTypesetting() }
    @objc func indentStepChanged() {
        let step = indentStepControl.selectedSegment + LabSettings.indentSteps.lowerBound
        guard LabSettings.indentSteps.contains(step) else { return }
        store.update { $0.indentStep = step }
    }
    /// 自定义 starts from the renderer's default caret colour; 跟随强调色
    /// forgets the chosen one.
    @objc func caretModeChanged() {
        let custom = caretModeControl.selectedSegment == 1
        store.update { $0.caretColor = custom ? ($0.caretColor ?? Self.customCaretDefault) : nil }
        if !custom { caretWell.deactivate() }
    }
    @objc func caretColorChanged() {
        let hex = MacAppearanceSettingsViewController.hex(caretWell.color)
        store.update { $0.caretColor = hex }
    }
    @objc func linkStyleChanged() {
        let modes = EntityLinkStyle.Mode.allCases
        guard modes.indices.contains(linkStyleControl.selectedSegment) else { return }
        store.update { $0.entityLinkStyle = modes[linkStyleControl.selectedSegment] }
    }
    @objc func linkColorChanged(_ sender: NSColorWell) {
        guard let index = linkColorWells.firstIndex(of: sender) else { return }
        let kind = EntityLinkStyle.Kind.allCases[index]
        let hex = MacAppearanceSettingsViewController.hex(sender.color)
        store.update { $0.entityLinkColors[kind.rawValue] = hex }
    }
    @objc func resetLinkColors() { store.update { $0.entityLinkColors = [:] } }
}

// MARK: 语言

final class MacLanguageSettingsViewController: NSViewController {
    let store: LabSettingsStore
    let spellcheckSwitch = NSSwitch()
    let localePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let storageMessage = SettingsLayout.storageLabel()

    init(store: LabSettingsStore) {
        self.store = store
        super.init(nibName: nil, bundle: nil)
        title = "语言"
        spellcheckSwitch.target = self; spellcheckSwitch.action = #selector(spellcheckChanged)
        spellcheckSwitch.setAccessibilityIdentifier("settings-spellcheck")
        spellcheckSwitch.setAccessibilityLabel("拼写检查")
        for locale in LabSettings.locales {
            localePopup.addItem(withTitle: "\(locale.name) · \(locale.code)")
            localePopup.lastItem?.representedObject = locale.code
        }
        localePopup.target = self; localePopup.action = #selector(localeChanged)
        localePopup.setAccessibilityIdentifier("settings-manuscript-locale")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        let grid = SettingsLayout.grid([
            ("拼写检查", [spellcheckSwitch, SettingsLayout.detail("输入时用系统拼写检查标出拼错的词，主要针对英文等拼音文字。")]),
            ("手稿默认语言", [localePopup, SettingsLayout.detail("决定正文的字形、后备字体与断行，例如简体与繁体中文、日文汉字的字形差异。")]),
        ])
        view = SettingsLayout.page([grid, storageMessage])
        refresh()
    }

    func refresh() {
        spellcheckSwitch.state = store.settings.spellcheck ? .on : .off
        localePopup.selectItem(at: LabSettings.locales.firstIndex { $0.code == store.settings.manuscriptLocale } ?? 0)
        SettingsLayout.storage(storageMessage, store)
    }

    @objc func spellcheckChanged() {
        let on = spellcheckSwitch.state == .on
        store.update { $0.spellcheck = on }
    }
    @objc func localeChanged() {
        guard let code = localePopup.selectedItem?.representedObject as? String else { return }
        store.update { $0.manuscriptLocale = code }
    }
}

// MARK: 写作助手 › 用量

/// Token usage of the open project's writing assistant: today and the last
/// 30 days by provider and model, and each conversation's total. Numbers
/// are the providers' own usage fields; unreported ones count as unknown,
/// and no prices are shown.
final class MacAgentSettingsViewController: NSViewController {
    /// MCP 扩展, a second tab beside 用量 when set before the view loads.
    var mcpPane: MacMcpSettingsViewController?
    private(set) var sections: NSTabView?
    /// The project's name and conversations, or nil without a project.
    var source: (() -> (project: String, conversations: [AgentConversation])?)?
    var now: () -> Date = Date.init
    var onManageKeys: (() -> Void)?
    let projectLabel = NSTextField(labelWithString: "")
    let todayLabel = SettingsLayout.value("settings-agent-usage-today")
    let monthLabel = SettingsLayout.value("settings-agent-usage-month")
    let modelsStack = NSStackView()
    let conversationsStack = NSStackView()
    let keysButton = NSButton(title: "管理 API Key…", target: nil, action: nil)
    private(set) var report: AgentUsageReport?

    init() {
        super.init(nibName: nil, bundle: nil)
        title = "写作助手"
        projectLabel.setAccessibilityIdentifier("settings-agent-usage-project")
        for stack in [modelsStack, conversationsStack] {
            stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 6
        }
        modelsStack.setAccessibilityIdentifier("settings-agent-usage-models")
        conversationsStack.setAccessibilityIdentifier("settings-agent-usage-conversations")
        keysButton.target = self; keysButton.action = #selector(manageKeys)
        keysButton.setAccessibilityIdentifier("settings-agent-keys")
        NotificationCenter.default.addObserver(self, selector: #selector(usageChanged), name: AgentChatController.usageDidChange, object: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        let grid = SettingsLayout.grid([("今天", [todayLabel]), ("近 30 天", [monthLabel])])
        let usage = SettingsLayout.page([
            SettingsLayout.heading("用量"),
            SettingsLayout.detail("按模型服务在每次请求后报告的数字记录；没有报告的记为“未知”，不估算，也不计算费用。删除对话会一并删除它的用量。"),
            projectLabel, grid,
            SettingsLayout.heading("按模型（今天 / 近 30 天）"), modelsStack,
            SettingsLayout.heading("按对话（全部）"), conversationsStack,
            SettingsLayout.line([keysButton]),
        ], spacing: [1: 14, 3: 16, 5: 16, 7: 16])
        guard let mcpPane else { view = usage; refresh(); return }
        addChild(mcpPane)
        let tabs = NSTabView()
        tabs.setAccessibilityIdentifier("settings-agent-sections")
        let usageItem = NSTabViewItem(identifier: "usage")
        usageItem.label = "用量"
        usageItem.view = Self.scrolled(usage)
        let mcpItem = NSTabViewItem(identifier: "mcp")
        mcpItem.label = "MCP 扩展"
        mcpItem.view = Self.scrolled(mcpPane.view)
        tabs.addTabViewItem(usageItem)
        tabs.addTabViewItem(mcpItem)
        tabs.translatesAutoresizingMaskIntoConstraints = false
        let container = NSView()
        container.addSubview(tabs)
        NSLayoutConstraint.activate([
            tabs.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 8),
            tabs.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -8),
            tabs.topAnchor.constraint(equalTo: container.topAnchor, constant: 8),
            tabs.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -8),
            container.widthAnchor.constraint(equalToConstant: SettingsLayout.width + 60),
            container.heightAnchor.constraint(equalToConstant: 640),
        ])
        sections = tabs
        view = container
        refresh()
    }

    /// A fixed-width page in a scroll view that fills its tab, so a long
    /// list scrolls instead of growing the window.
    private static func scrolled(_ page: NSView) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.drawsBackground = false; scroll.borderType = .noBorder
        let document = AgentFlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        page.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(page)
        scroll.documentView = document
        let fill = document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor)
        fill.priority = .defaultHigh
        NSLayoutConstraint.activate([
            page.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            page.topAnchor.constraint(equalTo: document.topAnchor),
            page.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            document.trailingAnchor.constraint(greaterThanOrEqualTo: page.trailingAnchor),
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            fill,
        ])
        return scroll
    }

    /// Selects the MCP 扩展 tab.
    func showMcp() {
        _ = view
        sections?.selectTabViewItem(at: 1)
    }

    override func viewWillAppear() { super.viewWillAppear(); refresh(); mcpPane?.refresh() }

    @objc private func usageChanged() { if isViewLoaded { refresh() } }
    @objc private func manageKeys() { onManageKeys?() }

    private static func row(_ title: String, _ lines: [String], _ identifier: String) -> NSView {
        let name = NSTextField(labelWithString: title)
        name.font = .systemFont(ofSize: 12, weight: .semibold)
        var views: [NSView] = [name]
        for line in lines {
            let label = SettingsLayout.detail(line)
            label.textColor = .labelColor
            views.append(label)
        }
        let stack = NSStackView(views: views)
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 2
        stack.setAccessibilityIdentifier(identifier)
        stack.setAccessibilityElement(true)
        stack.setAccessibilityLabel(([title] + lines).joined(separator: "，"))
        return stack
    }

    func refresh() {
        guard isViewLoaded else { return }
        let found = source?()
        let report = found.map { AgentUsageReport(conversations: $0.conversations, now: now()) }
        self.report = report
        projectLabel.stringValue = found.map { "项目《\($0.project)》" } ?? "没有打开的项目。打开一个项目后，这里显示它的写作助手用量。"
        todayLabel.stringValue = report?.today.text ?? "—"
        monthLabel.stringValue = report?.month.text ?? "—"
        for stack in [modelsStack, conversationsStack] {
            for view in stack.arrangedSubviews { stack.removeArrangedSubview(view); view.removeFromSuperview() }
        }
        let models = report?.models ?? []
        if models.isEmpty { modelsStack.addArrangedSubview(SettingsLayout.detail("近 30 天没有请求。")) }
        for (index, row) in models.enumerated() {
            modelsStack.addArrangedSubview(Self.row(row.label, ["今天：\(row.today.text)", "近 30 天：\(row.month.text)"],
                                                    "settings-agent-usage-model-\(index)"))
        }
        let conversations = report?.conversations ?? []
        if conversations.isEmpty { conversationsStack.addArrangedSubview(SettingsLayout.detail("还没有用量记录。")) }
        for row in conversations {
            conversationsStack.addArrangedSubview(Self.row(row.title, [row.totals.text], "settings-agent-usage-conversation-\(row.id)"))
        }
    }
}
