import AppKit

/// 历史版本… for one chapter, drift, element or storyline body: versions
/// newest first with their relative time, the title at that time, why they
/// were kept and their word count, a read-only preview of the selected
/// version with its formatting (Rust's projection of it), marked against the
/// current text, and 恢复此版本 after a confirmation. Refusals stay in the sheet.
final class VersionHistorySheet: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    let model: VersionHistoryModel
    let window: NSWindow
    let table = NSTableView()
    /// Draws list markers as the editor does.
    let previewView = ListMarkerTextView()
    let diffCheckbox = NSButton(checkboxWithTitle: "标出与当前正文的差异", target: nil, action: nil)
    let legend = NSTextField(wrappingLabelWithString: "")
    let message = NSTextField(wrappingLabelWithString: "")
    let restoreButton = NSButton(title: "恢复此版本…", target: nil, action: nil)
    let closeButton = NSButton(title: "关闭", target: nil, action: nil)
    private let previewTitle = NSTextField(labelWithString: "")
    private(set) var entries: [WorkspaceHistoryEntry] = []
    /// Presents the restore confirmation. Nil uses a sheet on this sheet;
    /// acceptance answers here without a window.
    var presentAlert: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
    /// Called once the sheet ends.
    var onFinish: (() -> Void)?
    /// The project's link targets: the preview draws entity links as the
    /// editors do, in 设置's 链接样式. Without one they keep the default style.
    var linkDirectory: EntityLinkDirectory? { didSet { if linkDirectory != oldValue { showPreview() } } }

    var errorMessage: String? { model.statusIsError ? model.status : nil }

    init(model: VersionHistoryModel) {
        self.model = model
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 780, height: 520), styleMask: [.titled, .resizable],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "历史版本"
        window.minSize = NSSize(width: 640, height: 420)
        super.init()
        let target = model.target
        let title = NSTextField(labelWithString: "历史版本 · \(target.kindName)“\(target.title)”")
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.lineBreakMode = .byTruncatingTail
        title.setAccessibilityIdentifier("history-title")
        let explanation = NSTextField(wrappingLabelWithString:
            "正文编辑后约每 15 分钟、关闭页面时和恢复之前会自动留存一个版本，只保存在这台设备上，保留 30 天。恢复只替换正文，标题、摘要等资料不变。")
        explanation.textColor = .secondaryLabelColor
        explanation.font = .systemFont(ofSize: 12)

        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("version")))
        table.headerView = nil
        table.rowHeight = 54
        table.style = .plain
        table.usesAutomaticRowHeights = false
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.dataSource = self; table.delegate = self
        table.setAccessibilityIdentifier("history-list")
        let listScroll = NSScrollView()
        listScroll.hasVerticalScroller = true
        listScroll.borderType = .bezelBorder
        listScroll.documentView = table

        previewTitle.font = .systemFont(ofSize: 12, weight: .medium)
        previewTitle.textColor = .secondaryLabelColor
        previewTitle.lineBreakMode = .byTruncatingTail
        previewTitle.setAccessibilityIdentifier("history-preview-title")
        previewView.isEditable = false
        previewView.isSelectable = true
        previewView.isRichText = true
        previewView.textContainerInset = NSSize(width: 10, height: 10)
        previewView.isVerticallyResizable = true
        previewView.autoresizingMask = [.width]
        previewView.textContainer?.widthTracksTextView = true
        previewView.drawsBackground = true
        previewView.backgroundColor = .textBackgroundColor
        previewView.setAccessibilityIdentifier("history-preview")
        previewView.setAccessibilityLabel("所选版本的正文（只读）")
        let previewScroll = NSScrollView()
        previewScroll.hasVerticalScroller = true
        previewScroll.borderType = .bezelBorder
        previewScroll.documentView = previewView
        diffCheckbox.state = .on
        diffCheckbox.target = self; diffCheckbox.action = #selector(diffToggled)
        diffCheckbox.setAccessibilityIdentifier("history-show-diff")
        legend.font = .systemFont(ofSize: 11)
        legend.textColor = .secondaryLabelColor
        legend.setAccessibilityIdentifier("history-legend")
        let previewStack = NSStackView(views: [previewTitle, previewScroll, diffCheckbox, legend])
        previewStack.orientation = .vertical; previewStack.alignment = .leading; previewStack.spacing = 6

        let columns = NSStackView(views: [listScroll, previewStack])
        columns.orientation = .horizontal; columns.alignment = .top; columns.spacing = 14
        message.font = .systemFont(ofSize: 12)
        message.setAccessibilityIdentifier("history-message")
        restoreButton.target = self; restoreButton.action = #selector(restoreSelected)
        restoreButton.setAccessibilityIdentifier("history-restore")
        restoreButton.toolTip = "把正文替换为所选版本；当前正文会先存为一个版本，恢复后可以撤销"
        closeButton.target = self; closeButton.action = #selector(close)
        closeButton.keyEquivalent = "\u{1b}"
        closeButton.setAccessibilityIdentifier("history-close")
        let buttons = NSStackView(views: [NSView(), closeButton, restoreButton])
        let stack = NSStackView(views: [title, explanation, columns, message, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.setCustomSpacing(4, after: title)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            title.widthAnchor.constraint(equalTo: stack.widthAnchor),
            explanation.widthAnchor.constraint(equalTo: stack.widthAnchor),
            columns.widthAnchor.constraint(equalTo: stack.widthAnchor),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
            listScroll.widthAnchor.constraint(equalToConstant: 270),
            listScroll.heightAnchor.constraint(equalTo: previewStack.heightAnchor),
            previewScroll.widthAnchor.constraint(equalTo: previewStack.widthAnchor),
            legend.widthAnchor.constraint(equalTo: previewStack.widthAnchor),
            previewScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 240),
        ])
        model.onChange = { [weak self] in self?.reload() }
        NotificationCenter.default.addObserver(self, selector: #selector(linkStyleChanged), name: DocumentStyle.linkStyleDidChange, object: nil)
        reload()
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    /// 设置's 链接样式 changed: the preview is set again.
    @objc private func linkStyleChanged() { showPreview() }

    /// Presents the sheet on a window; without one it stays ready for
    /// programmatic use (acceptance).
    func begin(in parent: NSWindow?) {
        if let parent { parent.beginSheet(window) }
    }

    func reload() {
        let selected = model.selectedID
        if entries != model.entries {
            entries = model.entries
            table.reloadData()
        }
        if let selected, let row = entries.firstIndex(where: { $0.id == selected }), table.selectedRow != row {
            table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        }
        message.stringValue = model.status
        message.textColor = model.statusIsError ? .systemRed : .secondaryLabelColor
        restoreButton.isEnabled = !model.busy && model.selected != nil
        showPreview()
    }

    // MARK: Rows

    func numberOfRows(in tableView: NSTableView) -> Int { entries.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        rowView(entries[row])
    }

    /// The row's details after the time: the title then, the status then,
    /// why the version was kept (自动保存, 关闭时, 恢复前) and its word count.
    static func details(_ entry: WorkspaceHistoryEntry) -> String {
        var details: [String] = []
        if let name = entry.meta?.displayName { details.append(name) }
        if let status = entry.meta?.writingStatus, !status.isEmpty { details.append(WritingStatus.label(status)) }
        if let reason = entry.meta?.reasonLabel { details.append(reason) }
        if let words = entry.meta?.wordCountText { details.append(words) }
        return details.joined(separator: " · ")
    }

    /// One version's row: its time, the title then, why it was kept, its
    /// word count and the first words.
    func rowView(_ entry: WorkspaceHistoryEntry) -> NSView {
        let time = NSTextField(labelWithString: VersionHistoryTime.label(entry.createdAt))
        time.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        time.toolTip = VersionHistoryTime.exact(entry.createdAt)
        time.setContentHuggingPriority(.required, for: .horizontal)
        let details = [Self.details(entry)].filter { !$0.isEmpty }
        let meta = NSTextField(labelWithString: details.joined(separator: " · "))
        meta.font = .systemFont(ofSize: 11)
        meta.textColor = .secondaryLabelColor
        meta.lineBreakMode = .byTruncatingTail
        meta.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        let first = NSStackView(views: [time, meta])
        first.spacing = 8
        let flat = entry.text.split(whereSeparator: \.isNewline).joined(separator: " ")
        let excerpt = NSTextField(labelWithString: flat.isEmpty ? "（空白正文）" : String(flat.prefix(80)))
        excerpt.font = .systemFont(ofSize: 11)
        excerpt.textColor = .tertiaryLabelColor
        excerpt.lineBreakMode = .byTruncatingTail
        excerpt.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        let stack = NSStackView(views: [first, excerpt])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 3
        stack.edgeInsets = NSEdgeInsets(top: 6, left: 6, bottom: 6, right: 6)
        stack.setAccessibilityIdentifier("history-row-\(entry.id)")
        stack.setAccessibilityElement(true)
        stack.setAccessibilityRole(.row)
        stack.setAccessibilityLabel("\(time.stringValue) \(meta.stringValue)")
        return stack
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard entries.indices.contains(table.selectedRow) else { return }
        model.selectedID = entries[table.selectedRow].id
    }

    func select(entryID: String) {
        guard let row = entries.firstIndex(where: { $0.id == entryID }) else { return }
        table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        model.selectedID = entryID
    }

    // MARK: Preview

    @objc private func diffToggled() { showPreview() }

    private func showPreview() {
        guard let entry = model.selected else {
            previewTitle.stringValue = model.loaded ? "没有可预览的版本" : "正在读取…"
            previewView.textStorage?.setAttributedString(NSAttributedString())
            legend.stringValue = ""
            return
        }
        previewTitle.stringValue = "\(VersionHistoryTime.exact(entry.createdAt)) 的版本" + (entry.meta?.displayName.map { " · \($0)" } ?? "")
            + (entry.meta?.reasonLabel.map { " · \($0)" } ?? "") + (entry.meta?.wordCountText.map { " · \($0)" } ?? "")
        let segments = diffCheckbox.state == .on ? model.segments(of: entry) : nil
        if let projection = model.preview(of: entry),
           let styled = Self.attributed(projection: projection, segments: segments, links: linkDirectory) {
            previewView.textStorage?.setAttributedString(styled)
        } else {
            previewView.textStorage?.setAttributedString(Self.attributed(segments: segments, version: entry.text))
        }
        if diffCheckbox.state == .off {
            legend.stringValue = "只显示这个版本的正文。"
        } else if let segments {
            legend.stringValue = segments.allSatisfy({ $0.kind == .same })
                ? "这个版本与当前正文相同。"
                : "绿色底：这个版本有、当前正文没有的文字，恢复后会回来。删除线：当前正文有、这个版本没有的文字，恢复后会移除。"
        } else {
            legend.stringValue = "正在读取当前正文，稍后标出差异。"
        }
    }

    /// The version set as editors set it (headings, bold, italic, underline,
    /// strike, links, alignment and indent from its projection), then with
    /// segments marked against the current text: text the current body lacks
    /// on a green wash, and text the version lacks inserted struck through in
    /// the style around it. Nil when the segments do not spell the projection.
    static func attributed(projection: NativeProjection, segments: [ProseDiff.Segment]?,
                           links: EntityLinkDirectory? = nil) -> NSAttributedString? {
        // Styled as an editor's storage is: fonts are fixed lazily when the
        // preview lays out, so the runs keep the fonts DocumentStyle chose.
        let styled = LazyStyledText(text: projection.text)
        DocumentStyle.apply(projection, to: styled, links: links)
        // Comment highlights are not part of a version's comparison.
        styled.removeAttribute(.backgroundColor, range: NSRange(location: 0, length: styled.length))
        guard let segments else { return styled }
        let result = NSMutableAttributedString()
        var cursor = 0
        for segment in segments {
            let length = (segment.text as NSString).length
            switch segment.kind {
            case .same, .added:
                guard cursor + length <= styled.length else { return nil }
                let piece = NSMutableAttributedString(attributedString: styled.attributedSubstring(from: NSRange(location: cursor, length: length)))
                if segment.kind == .added {
                    piece.addAttribute(.backgroundColor, value: NSColor.systemGreen.withAlphaComponent(0.22),
                                       range: NSRange(location: 0, length: piece.length))
                }
                result.append(piece)
                cursor += length
            case .removed:
                var attributes = styled.length == 0 ? DocumentStyle.bodyAttributes
                    : styled.attributes(at: min(cursor, styled.length - 1), effectiveRange: nil)
                attributes[.underlineStyle] = nil
                // Removed text is not a list item's first character.
                attributes[DocumentStyle.listMarkerKey] = nil
                attributes[DocumentStyle.trailingListMarkerKey] = nil
                attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
                attributes[.strikethroughColor] = NSColor.systemRed
                attributes[.foregroundColor] = NSColor.secondaryLabelColor
                attributes[.backgroundColor] = NSColor.systemRed.withAlphaComponent(0.1)
                result.append(NSAttributedString(string: segment.text, attributes: attributes))
            }
        }
        return cursor == styled.length ? result : nil
    }

    /// The version as plain text, or with segments the version marked against
    /// the current text: added text on a green wash, removed text struck through.
    static func attributed(segments: [ProseDiff.Segment]?, version: String) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 4
        paragraph.paragraphSpacing = 6
        let base: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.labelColor,
                                                   .paragraphStyle: paragraph]
        guard let segments else { return NSAttributedString(string: version, attributes: base) }
        let result = NSMutableAttributedString()
        for segment in segments {
            var attributes = base
            switch segment.kind {
            case .same: break
            case .added:
                attributes[.backgroundColor] = NSColor.systemGreen.withAlphaComponent(0.22)
            case .removed:
                attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
                attributes[.strikethroughColor] = NSColor.systemRed
                attributes[.foregroundColor] = NSColor.secondaryLabelColor
                attributes[.backgroundColor] = NSColor.systemRed.withAlphaComponent(0.1)
            }
            result.append(NSAttributedString(string: segment.text, attributes: attributes))
        }
        return result
    }

    // MARK: Restore

    @objc private func restoreSelected() {
        guard let entry = model.selected else { return }
        restore(snapshotID: entry.id)
    }

    /// Confirms, then restores. The sheet stays open and shows the result.
    func restore(snapshotID: String) {
        guard !model.busy else { return }
        let entry = model.entries.first { $0.id == snapshotID }
        let alert = NSAlert()
        alert.messageText = entry.map { "恢复到“\(VersionHistoryTime.label($0.createdAt))”的版本？" } ?? "恢复这个版本？"
        alert.informativeText = "当前正文会先自动存为一个历史版本，然后正文替换为所选版本。标题、摘要等资料保持不变。"
            + "恢复算作一次编辑，可以在编辑器中用“撤销”（⌘Z）撤回。"
        alert.addButton(withTitle: "恢复").setAccessibilityIdentifier("confirm-history-restore")
        alert.addButton(withTitle: "取消")
        present(alert) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self else { return }
            self.model.restore(snapshotID: snapshotID)
        }
    }

    private func present(_ alert: NSAlert, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        if let presentAlert { presentAlert(alert, completion); return }
        if window.isVisible { alert.beginSheetModal(for: window, completionHandler: completion) }
        else { completion(alert.runModal()) }
    }

    @objc func close() {
        if let parent = window.sheetParent { parent.endSheet(window) } else { window.orderOut(nil) }
        onFinish?()
    }
}

/// Text styled with `DocumentStyle.apply` without fixing its fonts at once
/// (a standalone storage would replace a CJK run's italic face on
/// `endEditing`); the text view showing it fixes them for drawing.
private final class LazyStyledText: NSTextStorage {
    private let backing = NSMutableAttributedString()
    override init() { super.init() }
    convenience init(text: String) {
        self.init()
        backing.append(NSAttributedString(string: text))
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    required init?(pasteboardPropertyList propertyList: Any, ofType type: NSPasteboard.PasteboardType) {
        fatalError("init(pasteboardPropertyList:ofType:) has not been implemented")
    }
    override var fixesAttributesLazily: Bool { true }
    override var string: String { backing.string }
    override func attributes(at location: Int, effectiveRange range: NSRangePointer?) -> [NSAttributedString.Key: Any] {
        backing.attributes(at: location, effectiveRange: range)
    }
    override func replaceCharacters(in range: NSRange, with str: String) {
        beginEditing()
        backing.replaceCharacters(in: range, with: str)
        edited(.editedCharacters, range: range, changeInLength: (str as NSString).length - range.length)
        endEditing()
    }
    override func setAttributes(_ attrs: [NSAttributedString.Key: Any]?, range: NSRange) {
        beginEditing()
        backing.setAttributes(attrs, range: range)
        edited(.editedAttributes, range: range, changeInLength: 0)
        endEditing()
    }
}
