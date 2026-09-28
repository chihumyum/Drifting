import AppKit

/// One storyline's page: 名称, 颜色, 简介 and 字段 on a wash in the storyline's
/// colour, then its chapters in book order (filtered by 全部, 已写 or 未起,
/// with 新建章节), 章节模版 and 关系, above the storyline's prose body.
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
    /// 章节模版: the stored template's preview and 编辑模版….
    let templateView = ElementTemplateSectionView(title: "章节模版", identifier: "chapter-template",
                                                  setDetail: "在这条故事线中新建的章节正文从这里开始",
                                                  editTooltip: "编辑在这条故事线中新建的章节正文从哪里开始")
    /// 关系, filled and driven by the tab host's relation coordinator.
    let relationsView = RelationsSectionView()
    /// 统计 of this page (视图 › 页面统计).
    let statsButton = MacPageStatsButton.make()
    private let message = NSTextField(wrappingLabelWithString: "")
    private let header = ElementHeaderWash()
    private(set) var storyline: WorkspaceStoryline
    private(set) var isCommitting = false
    private enum Pending: Equatable { case field(Field), facts }
    private var queued: [Pending] = []
    /// The stored 章节模版; nil until it was read.
    private(set) var template: [BookImportBlock]?
    /// The open 章节模版 sheet, if any.
    private(set) var templateSheet: ElementTemplateSheet?
    /// Saves the 章节模版; reports the template as stored, or the refusal.
    var onSaveTemplate: (([BookImportBlock], @escaping (Result<[BookImportBlock], Error>) -> Void) -> Void)?
    /// 新建章节 in this storyline.
    var onCreateChapter: (() -> Void)? {
        get { chaptersView.onCreate }
        set { chaptersView.onCreate = newValue }
    }
    /// The chapters' filter changed (全部, 已写 or 未起).
    var onFilterChange: ((String) -> Void)? {
        get { chaptersView.onFilterChange }
        set { chaptersView.onFilterChange = newValue }
    }
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
        templateView.onEdit = { [weak self] in self?.editTemplate() }
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
        let nameRow = NSStackView(views: [nameField, statsButton])
        nameRow.spacing = 8
        let headerStack = NSStackView(views: [nameRow, grid, message])
        headerStack.orientation = .vertical; headerStack.alignment = .leading; headerStack.spacing = 10
        headerStack.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(headerStack)
        chaptersView.translatesAutoresizingMaskIntoConstraints = false
        let chaptersRow = NSView()
        chaptersRow.addSubview(chaptersView)
        templateView.translatesAutoresizingMaskIntoConstraints = false
        let templateRow = NSView()
        templateRow.addSubview(templateView)
        let relationsRow = relationsView.inset()
        let stack = NSStackView(views: [header, chaptersRow, templateRow, relationsRow, documentView])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            header.widthAnchor.constraint(equalTo: stack.widthAnchor),
            chaptersRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            relationsRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            chaptersView.leadingAnchor.constraint(equalTo: chaptersRow.leadingAnchor, constant: 14),
            chaptersView.trailingAnchor.constraint(equalTo: chaptersRow.trailingAnchor, constant: -14),
            chaptersView.topAnchor.constraint(equalTo: chaptersRow.topAnchor, constant: 2),
            chaptersView.bottomAnchor.constraint(equalTo: chaptersRow.bottomAnchor, constant: -2),
            templateRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            templateView.leadingAnchor.constraint(equalTo: templateRow.leadingAnchor, constant: 14),
            templateView.trailingAnchor.constraint(equalTo: templateRow.trailingAnchor, constant: -14),
            templateView.topAnchor.constraint(equalTo: templateRow.topAnchor, constant: 2),
            templateView.bottomAnchor.constraint(equalTo: templateRow.bottomAnchor, constant: -2),
            documentView.widthAnchor.constraint(equalTo: stack.widthAnchor),
            headerStack.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 14),
            headerStack.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -14),
            headerStack.topAnchor.constraint(equalTo: header.topAnchor, constant: 12),
            headerStack.bottomAnchor.constraint(equalTo: header.bottomAnchor, constant: -12),
            nameRow.widthAnchor.constraint(equalTo: headerStack.widthAnchor),
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
    /// The fixed sections the 大纲轨道 lists above 正文.
    var railSections: [PageRailSection] {
        [PageRailSection(key: "overview", title: "概述", view: nameField, focus: nameField),
         PageRailSection(key: "facts", title: "字段", view: factsEditor, focus: nil),
         PageRailSection(key: "chapters", title: "章节", view: chaptersView, focus: nil),
         PageRailSection(key: "template", title: "章节模版", view: templateView, focus: nil),
         PageRailSection(key: "relations", title: "关系", view: relationsView, focus: nil)]
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

    // MARK: 章节模版

    /// Shows the stored template; the sheet, if open, keeps its rows.
    func showTemplate(_ blocks: [BookImportBlock]) {
        template = blocks
        templateView.show(blocks)
    }

    func showTemplateUnavailable(_ error: Error) {
        if let template { templateView.show(template) } else { templateView.showUnavailable(error.localizedDescription) }
    }

    /// 编辑模版… opens the sheet with the stored template.
    func editTemplate() {
        onFocus?()
        guard templateSheet == nil else { return }
        guard let template else { showMessage("模版还在读取，请稍后再编辑。"); return }
        let sheet = ElementTemplateSheet(texts: .storyline(storyline.name), blocks: template)
        templateSheet = sheet
        sheet.onCancel = { [weak self] in self?.endTemplateSheet() }
        sheet.onSave = { [weak self, weak sheet] blocks in
            guard let self, let sheet else { return }
            self.saveTemplate(blocks, from: sheet)
        }
        if let window, window.isVisible { window.beginSheet(sheet.window) }
        if let first = sheet.editor.rows.first { sheet.window.makeFirstResponder(first.textField) }
    }

    private func saveTemplate(_ blocks: [BookImportBlock], from sheet: ElementTemplateSheet) {
        guard let onSaveTemplate else { sheet.showError("故事线页面已关闭，模版未保存。"); return }
        sheet.showError(nil)
        sheet.setSaving(true)
        onSaveTemplate(blocks) { [weak self, weak sheet] result in
            sheet?.setSaving(false)
            switch result {
            case .success(let stored):
                self?.showTemplate(stored)
                if let self, sheet === self.templateSheet { self.endTemplateSheet() }
            // The typed rows stay in the sheet for another try.
            case .failure(let error): sheet?.showError(error.localizedDescription)
            }
        }
    }

    /// Closes the sheet without saving, e.g. when the page's tab closes.
    func endTemplateSheet() {
        guard let sheet = templateSheet else { return }
        templateSheet = nil
        if let parent = sheet.window.sheetParent { parent.endSheet(sheet.window) } else { sheet.window.orderOut(nil) }
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

    func showMessage(_ text: String?) {
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
/// a chapter whose 主线 is this storyline says so, and each shows its words
/// or 未起. 全部, 已写 and 未起 filter by the canonical word count (a chapter
/// with words is 已写, unless its body is still exactly the 章节模版); until
/// every listed chapter is counted and checked all are shown.
/// 新建章节 creates a chapter in this storyline. Typography and spacing only.
final class StorylineChaptersView: NSView {
    struct Entry: Equatable {
        let chapter: WorkspaceChapter
        let primary: Bool
        /// The canonical word count; nil while it is not known.
        var words: Int? = nil
        /// The body is still exactly the 章节模版 (normalised as category
        /// pages compare bodies); nil while it is being read.
        var atTemplate: Bool? = false
        /// 已写: words beyond an untouched template.
        var written: Bool { (words ?? 0) > 0 && atTemplate == false }
        static func == (lhs: Entry, rhs: Entry) -> Bool {
            lhs.chapter.id == rhs.chapter.id && lhs.chapter.title == rhs.chapter.title && lhs.primary == rhs.primary
                && lhs.words == rhs.words && lhs.atTemplate == rhs.atTemplate
        }
    }
    /// The filters in order, as `settings.json` keeps them.
    static let filters = [ListFilter.all, ListFilter.written, ListFilter.unwritten]
    private let title = NSTextField(labelWithString: "章节")
    let filterControl = NSSegmentedControl(labels: ["全部", "已写", "未起"], trackingMode: .selectOne, target: nil, action: nil)
    let createButton = NSButton(title: "新建章节", target: nil, action: nil)
    private let rows = NSStackView()
    private var entries: [Entry] = []
    private var loaded = false
    /// Long lists show this many chapters until expanded, so the body stays in view.
    static let collapsedCount = 8
    private(set) var expanded = false
    /// `all`, `written` or `unwritten`.
    private(set) var filter = ListFilter.all
    var onOpen: ((WorkspaceChapter) -> Void)?
    var onCreate: (() -> Void)?
    var onFilterChange: ((String) -> Void)?
    /// One button per shown chapter, in book order.
    private(set) var chapterButtons: [NSButton] = []
    /// Everything listed, in book order, including collapsed and filtered-out chapters.
    var listed: [Entry] { entries }
    /// The chapters the filter shows, in book order, including collapsed ones.
    var filtered: [Entry] {
        guard filter != ListFilter.all, countsReady else { return entries }
        return entries.filter { $0.written == (filter == ListFilter.written) }
    }
    /// Every listed chapter has a count and is checked against the template.
    var countsReady: Bool { entries.allSatisfy { $0.words != nil && $0.atTemplate != nil } }
    private(set) var mutedLines: [String] = []

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityIdentifier("storyline-chapters")
        title.font = .systemFont(ofSize: 12, weight: .semibold)
        title.textColor = .secondaryLabelColor
        filterControl.controlSize = .small
        filterControl.font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
        filterControl.selectedSegment = 0
        filterControl.target = self; filterControl.action = #selector(filterChosen)
        filterControl.setAccessibilityIdentifier("storyline-chapter-filter")
        filterControl.setAccessibilityLabel("章节筛选")
        createButton.bezelStyle = .rounded; createButton.controlSize = .small
        createButton.font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
        createButton.target = self; createButton.action = #selector(create)
        createButton.setAccessibilityIdentifier("storyline-create-chapter")
        createButton.toolTip = "在这条故事线中新建章节：它以这条故事线为主线，正文从章节模版开始"
        rows.orientation = .vertical; rows.alignment = .leading; rows.spacing = 2
        let header = NSStackView(views: [title, filterControl, NSView(), createButton])
        header.spacing = 8
        let stack = NSStackView(views: [header, rows])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            header.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        updateFilterLabels()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func showMessage(_ text: String) {
        clear(); entries = []; loaded = false
        updateFilterLabels()
        addMuted(text)
    }

    func show(_ entries: [Entry]) {
        clear(); self.entries = entries; loaded = true
        title.stringValue = entries.isEmpty ? "章节" : "章节 · \(entries.count)"
        updateFilterLabels()
        if entries.isEmpty { addMuted("还没有章节属于这条故事线。可以点“新建章节”，或在章节的“故事线…”中选择。"); return }
        let shownEntries = filtered
        if filter != ListFilter.all, !countsReady { addMuted("字数统计中，暂时显示全部章节。") }
        if shownEntries.isEmpty { addMuted(filter == ListFilter.written ? "这条故事线还没有写过的章节。" : "这条故事线的章节都已动笔。") }
        let shown = expanded ? shownEntries.count : min(shownEntries.count, Self.collapsedCount)
        for entry in shownEntries.prefix(shown) {
            let button = NSButton(title: "", target: self, action: #selector(open(_:)))
            button.isBordered = false; button.tag = entries.firstIndex(of: entry) ?? 0
            button.alignment = .left
            let text = NSMutableAttributedString(string: entry.chapter.title,
                attributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.labelColor])
            let secondary: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor]
            if entry.primary { text.append(NSAttributedString(string: "  主线", attributes: secondary)) }
            if let words = entry.words {
                text.append(NSAttributedString(string: entry.written ? "  \(WordCountText.full(words))" : "  未起", attributes: secondary))
            }
            button.attributedTitle = text
            button.setAccessibilityIdentifier("storyline-chapter-\(entry.chapter.id)")
            button.setAccessibilityLabel(entry.primary ? "\(entry.chapter.title)，主线" : entry.chapter.title)
            button.toolTip = entry.atTemplate == true ? "打开「\(entry.chapter.title)」（正文仍是章节模版）" : "打开「\(entry.chapter.title)」"
            rows.addArrangedSubview(button)
            chapterButtons.append(button)
        }
        if shownEntries.count > Self.collapsedCount {
            let more = shownEntries.count - Self.collapsedCount
            let toggle = NSButton(title: expanded ? "收起" : "显示其余 \(more) 章", target: self, action: #selector(toggleExpanded))
            toggle.isBordered = false
            toggle.contentTintColor = .secondaryLabelColor
            toggle.font = .systemFont(ofSize: 12)
            toggle.setAccessibilityIdentifier("storyline-chapters-toggle")
            rows.addArrangedSubview(toggle)
        }
    }

    /// Shows the chapters with a filter, e.g. the one remembered for the page.
    func setFilter(_ value: String) {
        let value = Self.filters.contains(value) ? value : ListFilter.all
        filter = value
        filterControl.selectedSegment = Self.filters.firstIndex(of: value) ?? 0
        if loaded { show(entries) } else { updateFilterLabels() }
    }

    /// 全部 3, 已写 1, 未起 2 once counts are known.
    private func updateFilterLabels() {
        let written = entries.filter(\.written).count
        let ready = loaded && countsReady
        let labels = ["全部" + (loaded ? " \(entries.count)" : ""), "已写" + (ready ? " \(written)" : ""),
                      "未起" + (ready ? " \(entries.count - written)" : "")]
        for (index, label) in labels.enumerated() {
            filterControl.setLabel(label, forSegment: index)
            filterControl.setWidth(0, forSegment: index)
        }
    }

    @objc private func filterChosen() {
        let index = filterControl.selectedSegment
        guard Self.filters.indices.contains(index), Self.filters[index] != filter else { return }
        expanded = false
        setFilter(Self.filters[index])
        onFilterChange?(filter)
    }

    @objc private func create() { onCreate?() }

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
