import AppKit

/// One storyline's page: 名称, 颜色, 简介 and 字段 on a wash in the storyline's
/// colour, then its chapters in book order, above the storyline's prose body.
/// Each field commits on end-editing, Return or a colour choice through
/// `onCommit`; facts commit as one ordered list through `onCommitFacts`. A
/// refusal keeps the typed text and rows and shows the reason. The body is an
/// ordinary native editor bound to the storyline's own document owner.
final class MacStorylinePageView: NSView, NSTextFieldDelegate, NSTextViewDelegate {
    enum Field: CaseIterable { case name, color, summary }

    let documentView: NativeDocumentView
    let nameField = NSTextField()
    let colorPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let summaryView = NSTextView()
    let factsEditor = ElementFactsEditor(prefix: "storyline-fact", emptyText: "还没有字段。可以添加“主题”“时间跨度”这类要点。")
    let chaptersView = StorylineChaptersView()
    private let message = NSTextField(wrappingLabelWithString: "")
    private let header = ElementHeaderWash()
    private(set) var storyline: WorkspaceStoryline
    private(set) var isCommitting = false
    private enum Pending: Equatable { case field(Field), facts }
    private var queued: [Pending] = []
    /// Receives one field's changes; reports the stored storyline or the refusal.
    var onCommit: ((WorkspaceStorylineChanges, @escaping (Result<WorkspaceStoryline, Error>) -> Void) -> Void)?
    /// Receives the complete ordered facts list exactly as typed.
    var onCommitFacts: (([WorkspaceFact], @escaping (Result<WorkspaceStoryline, Error>) -> Void) -> Void)?
    /// Opens a listed chapter in this page's pane.
    var onOpenChapter: ((WorkspaceChapter) -> Void)? {
        get { chaptersView.onOpen }
        set { chaptersView.onOpen = newValue }
    }
    var onFocus: (() -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }

    init(storyline: WorkspaceStoryline, core: LabCore) {
        self.storyline = storyline
        documentView = NativeDocumentView(core: core, allowsComments: false, minimumTextHeight: 150)
        super.init(frame: .zero)
        setAccessibilityIdentifier("storyline-page-\(storyline.id)")

        nameField.font = .systemFont(ofSize: 18, weight: .semibold)
        nameField.placeholderString = "故事线名称"
        nameField.isBordered = false; nameField.drawsBackground = false; nameField.focusRingType = .none
        nameField.lineBreakMode = .byTruncatingTail
        nameField.delegate = self
        nameField.cell?.isScrollable = true; nameField.cell?.wraps = false
        nameField.setAccessibilityIdentifier("storyline-name"); nameField.setAccessibilityLabel("名称")
        colorPopup.target = self; colorPopup.action = #selector(colorChosen)
        colorPopup.setAccessibilityIdentifier("storyline-color"); colorPopup.setAccessibilityLabel("颜色")
        summaryView.isRichText = false
        summaryView.allowsUndo = true
        summaryView.font = .systemFont(ofSize: 13)
        summaryView.isVerticallyResizable = true
        summaryView.autoresizingMask = [.width]
        summaryView.textContainer?.widthTracksTextView = true
        summaryView.textContainerInset = NSSize(width: 2, height: 4)
        summaryView.delegate = self
        summaryView.setAccessibilityIdentifier("storyline-summary"); summaryView.setAccessibilityLabel("简介")
        let summaryScroll = NSScrollView()
        summaryScroll.hasVerticalScroller = true; summaryScroll.borderType = .bezelBorder
        summaryScroll.documentView = summaryView
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("storyline-page-error")
        factsEditor.onCommit = { [weak self] in self?.commitFacts() }
        factsEditor.onFocus = { [weak self] in self?.onFocus?() }
        let factsLabel = label("字段")

        let grid = NSGridView(views: [
            [label("颜色"), colorPopup],
            [label("简介"), summaryScroll],
            [factsLabel, factsEditor],
        ])
        grid.rowSpacing = 8; grid.columnSpacing = 10
        grid.column(at: 0).xPlacement = .trailing
        grid.cell(for: colorPopup)?.xPlacement = .leading
        grid.row(at: 1).yPlacement = .top
        grid.row(at: 2).yPlacement = .top
        grid.row(at: 2).topPadding = 4
        grid.cell(for: factsEditor)?.xPlacement = .fill
        let headerStack = NSStackView(views: [nameField, grid, message])
        headerStack.orientation = .vertical; headerStack.alignment = .leading; headerStack.spacing = 10
        headerStack.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(headerStack)
        chaptersView.translatesAutoresizingMaskIntoConstraints = false
        let chaptersRow = NSView()
        chaptersRow.addSubview(chaptersView)
        let stack = NSStackView(views: [header, chaptersRow, documentView])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            header.widthAnchor.constraint(equalTo: stack.widthAnchor),
            chaptersRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            chaptersView.leadingAnchor.constraint(equalTo: chaptersRow.leadingAnchor, constant: 14),
            chaptersView.trailingAnchor.constraint(equalTo: chaptersRow.trailingAnchor, constant: -14),
            chaptersView.topAnchor.constraint(equalTo: chaptersRow.topAnchor, constant: 2),
            chaptersView.bottomAnchor.constraint(equalTo: chaptersRow.bottomAnchor, constant: -2),
            documentView.widthAnchor.constraint(equalTo: stack.widthAnchor),
            headerStack.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 14),
            headerStack.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -14),
            headerStack.topAnchor.constraint(equalTo: header.topAnchor, constant: 12),
            headerStack.bottomAnchor.constraint(equalTo: header.bottomAnchor, constant: -12),
            nameField.widthAnchor.constraint(equalTo: headerStack.widthAnchor),
            grid.widthAnchor.constraint(equalTo: headerStack.widthAnchor),
            message.widthAnchor.constraint(equalTo: headerStack.widthAnchor),
            summaryScroll.heightAnchor.constraint(equalToConstant: 48),
            factsLabel.topAnchor.constraint(equalTo: factsEditor.topAnchor, constant: 3),
        ])
        rebuildColors(selecting: storyline.color)
        for field in Field.allCases { show(display(field, of: storyline), in: field) }
        factsEditor.show(storyline.facts)
        chaptersView.showMessage("正在读取章节…")
        updateWash()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func label(_ text: String) -> NSTextField {
        let value = NSTextField(labelWithString: text)
        value.textColor = .secondaryLabelColor
        return value
    }

    // MARK: Values

    /// The field's current text, including an active field editor.
    func text(of field: Field) -> String {
        switch field {
        case .name: return nameField.currentEditor()?.string ?? nameField.stringValue
        case .color: return (colorPopup.selectedItem?.representedObject as? String) ?? storyline.color
        case .summary: return summaryView.string
        }
    }

    private func display(_ field: Field, of storyline: WorkspaceStoryline) -> String {
        switch field {
        case .name: return storyline.name
        case .color: return storyline.color
        case .summary: return storyline.summary
        }
    }

    private func show(_ value: String, in field: Field) {
        switch field {
        case .name:
            // Keep an active editing session: its text becomes the field's
            // value when editing ends, so no end-editing is simulated here.
            if let editor = nameField.currentEditor() {
                if editor.string != value { editor.string = value }
            } else if nameField.stringValue != value { nameField.stringValue = value }
        case .color: rebuildColors(selecting: value)
        case .summary: if summaryView.string != value { summaryView.string = value }
        }
    }

    /// The shared palette, plus the stored colour when it is not one of them
    /// (Rust picks a random colour for a new storyline).
    private func rebuildColors(selecting hex: String) {
        colorPopup.removeAllItems()
        let palette = MacElementLibraryViewController.palette
        if !palette.contains(where: { $0.hex.caseInsensitiveCompare(hex) == .orderedSame }) {
            colorPopup.addItem(withTitle: "当前颜色 \(hex.uppercased())")
            colorPopup.lastItem?.representedObject = hex
            colorPopup.lastItem?.image = ElementSwatch.image(color: ElementSwatch.color(hex: hex))
            colorPopup.lastItem?.setAccessibilityIdentifier("storyline-color-current")
        }
        for entry in palette {
            colorPopup.addItem(withTitle: entry.name)
            colorPopup.lastItem?.representedObject = entry.hex
            colorPopup.lastItem?.image = ElementSwatch.image(color: ElementSwatch.color(hex: entry.hex))
            colorPopup.lastItem?.setAccessibilityIdentifier("storyline-color-\(entry.hex)")
        }
        let index = colorPopup.itemArray.firstIndex {
            ($0.representedObject as? String)?.caseInsensitiveCompare(hex) == .orderedSame
        }
        colorPopup.selectItem(at: index ?? 0)
    }

    private func updateWash() { header.tint = ElementSwatch.color(hex: storyline.color) }

    /// Adopt a newer stored storyline, e.g. after the panel or another view
    /// of the same storyline saved. Fields and facts with uncommitted text
    /// keep it.
    func apply(storyline updated: WorkspaceStoryline) {
        let previous = storyline
        let clean = Field.allCases.filter { text(of: $0) == display($0, of: previous) }
        let typedFacts = ElementText.stored(facts: factsEditor.facts)
        storyline = updated
        for field in clean { show(display(field, of: updated), in: field) }
        if typedFacts == previous.facts, typedFacts != updated.facts { factsEditor.show(updated.facts) }
        updateWash()
    }

    /// The storyline's chapters in book order, each marked when this
    /// storyline is its 主线. Nil while chapters are still being read.
    func showChapters(_ chapters: [StorylineChaptersView.Entry]?) {
        if let chapters { chaptersView.show(chapters) } else { chaptersView.showMessage("正在读取章节…") }
    }

    // MARK: Commit

    /// The changes this field would write, or nil when it matches the stored value.
    private func changes(for field: Field) -> WorkspaceStorylineChanges? {
        var changes = WorkspaceStorylineChanges()
        let value = text(of: field)
        switch field {
        case .name:
            let name = ElementText.trimmed(value)
            guard !name.isEmpty else { showMessage("名称不能为空，已恢复原名称。"); return nil }
            guard name != storyline.name else { return nil }
            changes.name = name
        case .color:
            guard value != storyline.color else { return nil }
            changes.color = value
        case .summary:
            guard value != storyline.summary else { return nil }
            changes.summary = value
        }
        return changes
    }

    /// Writes one field. Commands run one at a time in the order requested.
    func commit(_ field: Field) {
        guard !isCommitting else {
            if !queued.contains(.field(field)) { queued.append(.field(field)) }
            return
        }
        let submitted = text(of: field)
        guard let changes = changes(for: field), let onCommit else {
            // Nothing to write: show the stored form (an empty name restored,
            // spacing trimmed) once end-editing has stored the typed text.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.text(of: field) == submitted else { return }
                self.show(self.display(field, of: self.storyline), in: field)
            }
            commitNext(); return
        }
        isCommitting = true
        onCommit(changes) { [weak self] result in
            guard let self else { return }
            self.isCommitting = false
            switch result {
            case .success(let stored):
                self.showMessage(nil)
                self.apply(storyline: stored)
                // Show the stored form (a trimmed or suffixed unique name)
                // unless the author has typed on since this command was sent.
                if self.text(of: field) == submitted { self.show(self.display(field, of: stored), in: field) }
            case .failure(let error):
                self.showMessage(error.localizedDescription)
            }
            self.commitNext()
        }
    }

    /// Writes the whole facts list after a row ended editing or was added,
    /// removed or moved. Queued behind any header field command.
    func commitFacts() {
        guard !isCommitting else {
            if !queued.contains(.facts) { queued.append(.facts) }
            return
        }
        let submitted = factsEditor.facts
        guard ElementText.stored(facts: submitted) != storyline.facts, let onCommitFacts else { commitNext(); return }
        isCommitting = true
        onCommitFacts(submitted) { [weak self] result in
            guard let self else { return }
            self.isCommitting = false
            switch result {
            case .success(let stored):
                self.showMessage(nil)
                self.apply(storyline: stored)
            case .failure(let error):
                self.showMessage(error.localizedDescription)
            }
            self.commitNext()
        }
    }

    private func commitNext() {
        guard !isCommitting, !queued.isEmpty else { return }
        switch queued.removeFirst() {
        case .field(let field): commit(field)
        case .facts: commitFacts()
        }
    }

    /// Ends an active header edit so its end-editing commit is sent now.
    func endEditing() {
        guard let window, let responder = window.firstResponder as? NSView,
              responder !== documentView.textView, responder.isDescendant(of: self) else { return }
        window.makeFirstResponder(nil)
    }

    func focusName() {
        window?.makeFirstResponder(nameField)
        nameField.currentEditor()?.selectAll(nil)
    }

    private func showMessage(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    func controlTextDidBeginEditing(_ notification: Notification) { onFocus?() }
    func controlTextDidEndEditing(_ notification: Notification) {
        if notification.object as AnyObject? === nameField { commit(.name) }
    }
    func textDidBeginEditing(_ notification: Notification) { onFocus?() }
    func textDidEndEditing(_ notification: Notification) {
        if notification.object as AnyObject? === summaryView { commit(.summary) }
    }
    @objc private func colorChosen() { onFocus?(); commit(.color) }
}

/// 章节: the storyline's chapters in book order, each opening the chapter;
/// a chapter whose 主线 is this storyline says so. Typography and spacing only.
final class StorylineChaptersView: NSView {
    struct Entry: Equatable {
        let chapter: WorkspaceChapter
        let primary: Bool
        static func == (lhs: Entry, rhs: Entry) -> Bool {
            lhs.chapter.id == rhs.chapter.id && lhs.chapter.title == rhs.chapter.title && lhs.primary == rhs.primary
        }
    }
    private let title = NSTextField(labelWithString: "章节")
    private let rows = NSStackView()
    private var entries: [Entry] = []
    /// Long lists show this many chapters until expanded, so the body stays in view.
    static let collapsedCount = 8
    private(set) var expanded = false
    var onOpen: ((WorkspaceChapter) -> Void)?
    /// One button per listed chapter, in book order.
    private(set) var chapterButtons: [NSButton] = []
    /// Everything listed, in book order, including collapsed chapters.
    var listed: [Entry] { entries }
    private(set) var mutedLines: [String] = []

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityIdentifier("storyline-chapters")
        title.font = .systemFont(ofSize: 12, weight: .semibold)
        title.textColor = .secondaryLabelColor
        rows.orientation = .vertical; rows.alignment = .leading; rows.spacing = 2
        let stack = NSStackView(views: [title, rows])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func showMessage(_ text: String) {
        clear(); entries = []
        addMuted(text)
    }

    func show(_ entries: [Entry]) {
        clear(); self.entries = entries
        title.stringValue = entries.isEmpty ? "章节" : "章节 · \(entries.count)"
        if entries.isEmpty { addMuted("还没有章节属于这条故事线。可以在章节的“故事线…”中选择。") }
        let shown = expanded ? entries.count : min(entries.count, Self.collapsedCount)
        for (index, entry) in entries.prefix(shown).enumerated() {
            let button = NSButton(title: "", target: self, action: #selector(open(_:)))
            button.isBordered = false; button.tag = index
            button.alignment = .left
            let text = NSMutableAttributedString(string: entry.chapter.title,
                attributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.labelColor])
            if entry.primary {
                text.append(NSAttributedString(string: "  主线",
                    attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor]))
            }
            button.attributedTitle = text
            button.setAccessibilityIdentifier("storyline-chapter-\(entry.chapter.id)")
            button.setAccessibilityLabel(entry.primary ? "\(entry.chapter.title)，主线" : entry.chapter.title)
            button.toolTip = "打开「\(entry.chapter.title)」"
            rows.addArrangedSubview(button)
            chapterButtons.append(button)
        }
        if entries.count > Self.collapsedCount {
            let more = entries.count - Self.collapsedCount
            let toggle = NSButton(title: expanded ? "收起" : "显示其余 \(more) 章", target: self, action: #selector(toggleExpanded))
            toggle.isBordered = false
            toggle.contentTintColor = .secondaryLabelColor
            toggle.font = .systemFont(ofSize: 12)
            toggle.setAccessibilityIdentifier("storyline-chapters-toggle")
            rows.addArrangedSubview(toggle)
        }
    }

    @objc private func toggleExpanded() {
        expanded.toggle()
        show(entries)
    }

    private func clear() {
        for row in rows.arrangedSubviews { rows.removeArrangedSubview(row); row.removeFromSuperview() }
        chapterButtons = []; mutedLines = []
        title.stringValue = "章节"
    }

    private func addMuted(_ text: String) {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: 12)
        label.textColor = .secondaryLabelColor
        rows.addArrangedSubview(label)
        mutedLines.append(text)
    }

    @objc private func open(_ sender: NSButton) {
        guard entries.indices.contains(sender.tag) else { return }
        onOpen?(entries[sender.tag].chapter)
    }
}
