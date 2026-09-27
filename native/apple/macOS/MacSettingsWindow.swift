import AppKit
import UniformTypeIdentifiers

/// 设置 (⌘,): 外观, 编辑器 and 语言 as toolbar tabs, as Mac settings windows
/// are. Every control writes through `LabSettingsStore` at once, which saves
/// and applies it: open editors restyle in place and every window follows
/// the theme. Controls follow the store, so a refusal never leaves one
/// showing a value that is not in effect.
final class MacSettingsWindowController: NSWindowController, NSWindowDelegate {
    let store: LabSettingsStore
    let appearancePane: MacAppearanceSettingsViewController
    let editorPane: MacEditorSettingsViewController
    let languagePane: MacLanguageSettingsViewController
    private let tabs = NSTabViewController()

    init(store: LabSettingsStore) {
        self.store = store
        appearancePane = MacAppearanceSettingsViewController(store: store)
        editorPane = MacEditorSettingsViewController(store: store)
        languagePane = MacLanguageSettingsViewController(store: store)
        tabs.tabStyle = .toolbar
        for (controller, label, symbol) in [(appearancePane as NSViewController, "外观", "paintbrush"),
                                            (editorPane, "编辑器", "textformat"), (languagePane, "语言", "globe")] {
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
        appearancePane.refresh(); editorPane.refresh(); languagePane.refresh()
    }

    func windowWillClose(_ notification: Notification) {
        appearancePane.accentWell.deactivate()
    }
}

// MARK: Layout

/// Rows of a settings pane: a trailing-aligned label, then the control with
/// an optional explanation beneath. Sections are set apart by spacing and a
/// semibold heading only.
private enum SettingsLayout {
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
                       SettingsLayout.detail("用于选中的文字、当前标签与面板中的选中状态，不影响正文光标颜色。")]),
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
    let typewriterCheckbox = NSButton(checkboxWithTitle: "打字机滚动", target: nil, action: nil)
    let autosaveText = SettingsLayout.detail("每次输入提交后立即保存到本机，没有需要设置的间隔。历史版本在保存时最多每 15 分钟记录一次，关闭页面时也会记录。")
    private let storageMessage = SettingsLayout.storageLabel()
    /// The font rows; the message row shows only with a message.
    private var fontsGrid: NSGridView?
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
        for label in [sizeValue, lineHeightValue] {
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
        ])
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
            ("段首缩进", [indentControl, SettingsLayout.detail("只作用于正文段落；标题、引用与列表不缩进。")]),
            ("", [resetButton]),
        ])
        let writing = SettingsLayout.grid([
            ("输入", [typewriterCheckbox,
                    SettingsLayout.detail("输入时让光标所在行停在编辑区约 40% 的高度，所有正文编辑器都适用；手动滚动不受影响，下次输入时再回到这一高度。")]),
        ])
        let saving = SettingsLayout.grid([("自动保存", [autosaveText])])
        let previewHeading = SettingsLayout.heading("预览"), fontHeading = SettingsLayout.heading("字体")
        let typesettingHeading = SettingsLayout.heading("排版"), savingHeading = SettingsLayout.heading("保存")
        let writingHeading = SettingsLayout.heading("书写")
        let sections: [NSView] = [previewHeading, wash, fontHeading, fonts, typesettingHeading, typesetting, writingHeading, writing,
                                  savingHeading, saving, storageMessage]
        view = SettingsLayout.page(sections, spacing: [1: 22, 3: 22, 5: 22, 7: 22])
        refresh()
    }

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
