import AppKit

/// Present fields of a category header edit; absent ones stay unchanged.
struct WorkspaceCategoryChanges: Equatable {
    var name: String?
    var color: String?
}

/// One category's page (分类页): 名称, 颜色, its element count with 新建设定 and
/// 模板字段 on a wash in the category's colour, then its 设定 (filtered by
/// 全部, 已填写 or 未填写), 关系 and 新设定模版 (a
/// preview of how new elements' bodies start, edited in a sheet), above the
/// category's own prose body. Header fields commit on end-editing, Return or
/// a colour choice through `onCommit`; 模板字段 commit as one ordered list
/// through `onCommitFacts`, as on the 设定库's sheet. A refusal keeps the
/// typed text and rows and shows the reason. The body is an ordinary native
/// editor bound to the category's own document owner.
final class MacCategoryPageView: NSView, NSTextFieldDelegate {
    enum Field: CaseIterable { case name, color }

    let documentView: NativeDocumentView
    let nameField = NSTextField()
    let colorPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let countLabel = NSTextField(labelWithString: "")
    let createElementButton = NSButton(title: "新建设定", target: nil, action: nil)
    let factsEditor = ElementFactsEditor(prefix: "category-template-fact",
                                         emptyText: "还没有模板字段。新建的设定会带上这里的字段，例如“年龄”“身份”。", maximumHeight: 120)
    /// The category's 设定, each opening its page.
    let elementsView = CategoryElementsView()
    /// 关系, filled and driven by the tab host's relation coordinator.
    let relationsView = RelationsSectionView()
    /// 新设定模版: the stored template's preview and 编辑模版….
    let templateView = ElementTemplateSectionView()
    /// 统计 of this page (视图 › 页面统计).
    let statsButton = MacPageStatsButton.make()
    private let message = NSTextField(wrappingLabelWithString: "")
    private let header = ElementHeaderWash()
    private(set) var category: WorkspaceElementCategory
    /// Live elements in the category; nil until the library was read.
    private(set) var elementCount: Int?
    /// The stored element template; nil until it was read.
    private(set) var template: [BookImportBlock]?
    private(set) var isCommitting = false
    private enum Pending: Equatable { case field(Field), facts }
    private var queued: [Pending] = []
    /// The open 新设定模版 sheet, if any.
    private(set) var templateSheet: ElementTemplateSheet?
    /// Receives one field's changes; reports the stored category or the refusal.
    var onCommit: ((WorkspaceCategoryChanges, @escaping (Result<WorkspaceElementCategory, Error>) -> Void) -> Void)?
    /// Receives the complete ordered 模板字段 list exactly as typed.
    var onCommitFacts: (([WorkspaceFact], @escaping (Result<WorkspaceElementCategory, Error>) -> Void) -> Void)?
    /// Saves the template; reports the template as stored, or the refusal.
    var onSaveTemplate: (([BookImportBlock], @escaping (Result<[BookImportBlock], Error>) -> Void) -> Void)?
    /// 新建设定 in this category.
    var onCreateElement: (() -> Void)?
    /// Opens a listed element in this page's pane.
    var onOpenElement: ((WorkspaceElement) -> Void)? {
        get { elementsView.onOpen }
        set { elementsView.onOpen = newValue }
    }
    /// The elements' filter changed (全部, 已填写 or 未填写).
    var onFilterChange: ((String) -> Void)? {
        get { elementsView.onFilterChange }
        set { elementsView.onFilterChange = newValue }
    }
    var onFocus: (() -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }

    init(category: WorkspaceElementCategory, core: LabCore) {
        self.category = category
        documentView = NativeDocumentView(core: core, allowsComments: false, minimumTextHeight: 150)
        super.init(frame: .zero)
        setAccessibilityIdentifier("category-page-\(category.id)")

        nameField.font = .systemFont(ofSize: 18, weight: .semibold)
        nameField.placeholderString = "分类名称"
        nameField.isBordered = false; nameField.drawsBackground = false; nameField.focusRingType = .none
        nameField.lineBreakMode = .byTruncatingTail
        nameField.delegate = self
        nameField.cell?.isScrollable = true; nameField.cell?.wraps = false
        nameField.setAccessibilityIdentifier("category-name"); nameField.setAccessibilityLabel("名称")
        colorPopup.target = self; colorPopup.action = #selector(colorChosen)
        colorPopup.setAccessibilityIdentifier("category-color"); colorPopup.setAccessibilityLabel("颜色")
        countLabel.textColor = .secondaryLabelColor
        countLabel.setAccessibilityIdentifier("category-element-count")
        createElementButton.bezelStyle = .rounded; createElementButton.controlSize = .small
        createElementButton.font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
        createElementButton.target = self; createElementButton.action = #selector(createElement)
        createElementButton.setAccessibilityIdentifier("category-create-element")
        createElementButton.toolTip = "在这个分类中新建设定；正文从新设定模版开始"
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("category-page-error")
        factsEditor.onCommit = { [weak self] in self?.commitFacts() }
        factsEditor.onFocus = { [weak self] in self?.onFocus?() }
        templateView.onEdit = { [weak self] in self?.editTemplate() }
        let factsLabel = label("模板字段")
        factsLabel.toolTip = "新建的设定会带上这些字段和内容；已有的设定不会改变"

        let colorRow = NSStackView(views: [colorPopup, countLabel, NSView(), createElementButton])
        colorRow.spacing = 10
        let grid = NSGridView(views: [
            [label("颜色"), colorRow],
            [factsLabel, factsEditor],
        ])
        grid.rowSpacing = 8; grid.columnSpacing = 10
        grid.column(at: 0).xPlacement = .trailing
        grid.cell(for: colorRow)?.xPlacement = .fill
        grid.row(at: 1).yPlacement = .top
        grid.row(at: 1).topPadding = 4
        grid.cell(for: factsEditor)?.xPlacement = .fill
        let nameRow = NSStackView(views: [nameField, statsButton])
        nameRow.spacing = 8
        let headerStack = NSStackView(views: [nameRow, grid, message])
        headerStack.orientation = .vertical; headerStack.alignment = .leading; headerStack.spacing = 10
        headerStack.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(headerStack)
        templateView.translatesAutoresizingMaskIntoConstraints = false
        let templateRow = NSView()
        templateRow.addSubview(templateView)
        elementsView.translatesAutoresizingMaskIntoConstraints = false
        let elementsRow = NSView()
        elementsRow.addSubview(elementsView)
        let relationsRow = relationsView.inset()
        let stack = NSStackView(views: [header, elementsRow, relationsRow, templateRow, documentView])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            header.widthAnchor.constraint(equalTo: stack.widthAnchor),
            relationsRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            elementsRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            elementsView.leadingAnchor.constraint(equalTo: elementsRow.leadingAnchor, constant: 14),
            elementsView.trailingAnchor.constraint(equalTo: elementsRow.trailingAnchor, constant: -14),
            elementsView.topAnchor.constraint(equalTo: elementsRow.topAnchor, constant: 2),
            elementsView.bottomAnchor.constraint(equalTo: elementsRow.bottomAnchor, constant: -2),
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
            factsLabel.topAnchor.constraint(equalTo: factsEditor.topAnchor, constant: 3),
        ])
        rebuildColors(selecting: category.color)
        for field in Field.allCases { show(display(field, of: category), in: field) }
        factsEditor.show(category.templateFacts)
        showCount(nil)
        updateWash()
    }
    /// The fixed sections the 大纲轨道 lists above 正文.
    var railSections: [PageRailSection] {
        [PageRailSection(key: "overview", title: "概述", view: nameField, focus: nameField),
         PageRailSection(key: "facts", title: "模板字段", view: factsEditor, focus: nil),
         PageRailSection(key: "elements", title: "设定", view: elementsView, focus: nil),
         PageRailSection(key: "relations", title: "关系", view: relationsView, focus: nil),
         PageRailSection(key: "template", title: "模版", view: templateView, focus: nil)]
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
        case .color: return (colorPopup.selectedItem?.representedObject as? String) ?? category.color
        }
    }

    private func display(_ field: Field, of category: WorkspaceElementCategory) -> String {
        switch field {
        case .name: return category.name
        case .color: return category.color
        }
    }

    private func show(_ value: String, in field: Field) {
        switch field {
        case .name:
            // Keep an active editing session: its text becomes the field's
            // value when editing ends.
            if let editor = nameField.currentEditor() {
                if editor.string != value { editor.string = value }
            } else if nameField.stringValue != value { nameField.stringValue = value }
        case .color: rebuildColors(selecting: value)
        }
    }

    /// The shared palette, plus the stored colour when it is not one of them
    /// (Rust picks a random colour for a new category).
    private func rebuildColors(selecting hex: String) {
        colorPopup.removeAllItems()
        let palette = MacElementLibraryViewController.palette
        if !palette.contains(where: { $0.hex.caseInsensitiveCompare(hex) == .orderedSame }) {
            colorPopup.addItem(withTitle: "当前颜色 \(hex.uppercased())")
            colorPopup.lastItem?.representedObject = hex
            colorPopup.lastItem?.image = ElementSwatch.image(color: ElementSwatch.color(hex: hex))
            colorPopup.lastItem?.setAccessibilityIdentifier("category-color-current")
        }
        for entry in palette {
            colorPopup.addItem(withTitle: entry.name)
            colorPopup.lastItem?.representedObject = entry.hex
            colorPopup.lastItem?.image = ElementSwatch.image(color: ElementSwatch.color(hex: entry.hex))
            colorPopup.lastItem?.setAccessibilityIdentifier("category-color-\(entry.hex)")
        }
        let index = colorPopup.itemArray.firstIndex {
            ($0.representedObject as? String)?.caseInsensitiveCompare(hex) == .orderedSame
        }
        colorPopup.selectItem(at: index ?? 0)
    }

    private func updateWash() { header.tint = ElementSwatch.color(for: category) }

    private func showCount(_ count: Int?) {
        elementCount = count
        countLabel.stringValue = count.map { $0 == 0 ? "还没有设定" : "\($0) 个设定" } ?? "正在读取设定…"
    }

    /// Adopt a newer stored category and its element count, e.g. after the
    /// 设定库 or another view of the same category saved. Fields and rows
    /// with uncommitted text keep it.
    func apply(category updated: WorkspaceElementCategory, elementCount: Int? = nil) {
        let previous = category
        let clean = Field.allCases.filter { text(of: $0) == display($0, of: previous) }
        let typedFacts = ElementText.stored(facts: factsEditor.facts)
        category = updated
        for field in clean { show(display(field, of: updated), in: field) }
        if typedFacts == previous.templateFacts, typedFacts != updated.templateFacts { factsEditor.show(updated.templateFacts) }
        if let elementCount { showCount(elementCount) }
        updateWash()
    }

    // MARK: Element template

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
        let sheet = ElementTemplateSheet(category: category, blocks: template)
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
        guard let onSaveTemplate else { sheet.showError("分类页面已关闭，模版未保存。"); return }
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
    private func changes(for field: Field) -> WorkspaceCategoryChanges? {
        var changes = WorkspaceCategoryChanges()
        let value = text(of: field)
        switch field {
        case .name:
            let name = ElementText.trimmed(value)
            guard !name.isEmpty else { showMessage("名称不能为空，已恢复原名称。"); return nil }
            guard name != category.name else { return nil }
            changes.name = name
        case .color:
            guard value.caseInsensitiveCompare(category.color) != .orderedSame else { return nil }
            changes.color = value
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
            // Nothing to write: show the stored form once end-editing has
            // stored the typed text.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.text(of: field) == submitted else { return }
                self.show(self.display(field, of: self.category), in: field)
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
                self.apply(category: stored)
                if self.text(of: field) == submitted { self.show(self.display(field, of: stored), in: field) }
            case .failure(let error):
                self.showMessage(error.localizedDescription)
            }
            self.commitNext()
        }
    }

    /// Writes the whole 模板字段 list after a row ended editing or was added,
    /// removed or moved. Queued behind any header field command.
    func commitFacts() {
        guard !isCommitting else {
            if !queued.contains(.facts) { queued.append(.facts) }
            return
        }
        let submitted = factsEditor.facts
        guard ElementText.stored(facts: submitted) != category.templateFacts, let onCommitFacts else { commitNext(); return }
        isCommitting = true
        onCommitFacts(submitted) { [weak self] result in
            guard let self else { return }
            self.isCommitting = false
            switch result {
            case .success(let stored):
                self.showMessage(nil)
                self.apply(category: stored)
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
    @objc private func colorChosen() { onFocus?(); commit(.color) }
    @objc private func createElement() { onFocus?(); onCreateElement?() }
}


/// A category page's 设定 in library order, each opening its page. 全部,
/// 已填写 and 未填写 filter them by what an element page shows: an element is
/// 已填写 when its 简介 has text, a 字段 has a value other than the one the
/// category's 模板字段 gave it, or its body has text other than the
/// category's 新设定模版 (lines compared without surrounding spaces and blank
/// lines); otherwise 未填写. Until every body was read all are shown.
/// Typography and spacing only.
final class CategoryElementsView: NSView {
    struct Entry: Equatable {
        let element: WorkspaceElement
        /// Nil while the element's body is being read.
        var filled: Bool?
        static func == (lhs: Entry, rhs: Entry) -> Bool {
            lhs.element.id == rhs.element.id && lhs.element.name == rhs.element.name
                && lhs.element.summary == rhs.element.summary && lhs.filled == rhs.filled
        }
    }
    static let filters = [ListFilter.all, ListFilter.filled, ListFilter.unfilled]
    private let title = NSTextField(labelWithString: "设定")
    let filterControl = NSSegmentedControl(labels: ["全部", "已填写", "未填写"], trackingMode: .selectOne, target: nil, action: nil)
    private let rows = NSStackView()
    private var entries: [Entry] = []
    private var loaded = false
    static let collapsedCount = 8
    private(set) var expanded = false
    private(set) var filter = ListFilter.all
    var onOpen: ((WorkspaceElement) -> Void)?
    var onFilterChange: ((String) -> Void)?
    private(set) var elementButtons: [NSButton] = []
    private(set) var mutedLines: [String] = []
    var listed: [Entry] { entries }
    var filtered: [Entry] {
        guard filter != ListFilter.all, ready else { return entries }
        return entries.filter { $0.filled == (filter == ListFilter.filled) }
    }
    /// Every listed element's body was read.
    var ready: Bool { entries.allSatisfy { $0.filled != nil } }

    /// 已填写 from what the element page shows: 简介, 字段 values beyond the
    /// 模板字段 and the body's text beyond the 新设定模版.
    static func isFilled(_ element: WorkspaceElement, bodyText: String, templateText: String,
                         templateFacts: [WorkspaceFact]) -> Bool {
        if !ElementText.trimmed(element.summary).isEmpty { return true }
        let given = Dictionary(templateFacts.map { (ElementText.trimmed($0.key), ElementText.trimmed($0.value)) },
                               uniquingKeysWith: { first, _ in first })
        if element.facts.contains(where: { fact in
            let value = ElementText.trimmed(fact.value)
            return !value.isEmpty && given[ElementText.trimmed(fact.key)] != value
        }) { return true }
        let body = normalized(bodyText)
        return !body.isEmpty && body != normalized(templateText)
    }

    static func normalized(_ text: String) -> String {
        text.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            .joined(separator: "\n")
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityIdentifier("category-elements")
        title.font = .systemFont(ofSize: 12, weight: .semibold)
        title.textColor = .secondaryLabelColor
        filterControl.controlSize = .small
        filterControl.font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
        filterControl.selectedSegment = 0
        filterControl.target = self; filterControl.action = #selector(filterChosen)
        filterControl.setAccessibilityIdentifier("category-element-filter")
        filterControl.setAccessibilityLabel("设定筛选")
        filterControl.toolTip = "已填写：简介或字段有内容，或正文写了新设定模版以外的文字"
        rows.orientation = .vertical; rows.alignment = .leading; rows.spacing = 2
        let header = NSStackView(views: [title, filterControl, NSView()])
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
        showMessage("正在读取设定…")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func showMessage(_ text: String) {
        clear(); entries = []; loaded = false
        updateFilterLabels()
        addMuted(text)
    }

    func show(_ entries: [Entry]) {
        clear(); self.entries = entries; loaded = true
        title.stringValue = entries.isEmpty ? "设定" : "设定 · \(entries.count)"
        updateFilterLabels()
        if entries.isEmpty { addMuted("这个分类还没有设定。点“新建设定”开始。"); return }
        let shownEntries = filtered
        if filter != ListFilter.all, !ready { addMuted("正在读取正文，暂时显示全部设定。") }
        if shownEntries.isEmpty { addMuted(filter == ListFilter.filled ? "还没有填写过的设定。" : "这个分类的设定都已填写。") }
        let shown = expanded ? shownEntries.count : min(shownEntries.count, Self.collapsedCount)
        for entry in shownEntries.prefix(shown) {
            let button = NSButton(title: "", target: self, action: #selector(open(_:)))
            button.isBordered = false; button.tag = entries.firstIndex(of: entry) ?? 0
            button.alignment = .left
            let text = NSMutableAttributedString(string: entry.element.name,
                attributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.labelColor])
            let secondary: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor]
            let summary = ElementText.trimmed(entry.element.summary).split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
            if !summary.isEmpty { text.append(NSAttributedString(string: "  \(summary.prefix(40))", attributes: secondary)) }
            if entry.filled == false { text.append(NSAttributedString(string: "  未填写", attributes: secondary)) }
            button.attributedTitle = text
            button.lineBreakMode = .byTruncatingTail
            button.setAccessibilityIdentifier("category-element-\(entry.element.id)")
            button.setAccessibilityLabel(entry.filled == false ? "\(entry.element.name)，未填写" : entry.element.name)
            button.toolTip = "打开「\(entry.element.name)」"
            rows.addArrangedSubview(button)
            elementButtons.append(button)
        }
        if shownEntries.count > Self.collapsedCount {
            let more = shownEntries.count - Self.collapsedCount
            let toggle = NSButton(title: expanded ? "收起" : "显示其余 \(more) 个", target: self, action: #selector(toggleExpanded))
            toggle.isBordered = false
            toggle.contentTintColor = .secondaryLabelColor
            toggle.font = .systemFont(ofSize: 12)
            toggle.setAccessibilityIdentifier("category-elements-toggle")
            rows.addArrangedSubview(toggle)
        }
    }

    func setFilter(_ value: String) {
        let value = Self.filters.contains(value) ? value : ListFilter.all
        filter = value
        filterControl.selectedSegment = Self.filters.firstIndex(of: value) ?? 0
        if loaded { show(entries) } else { updateFilterLabels() }
    }

    private func updateFilterLabels() {
        let filled = entries.filter { $0.filled == true }.count
        let ready = loaded && self.ready
        let labels = ["全部" + (loaded ? " \(entries.count)" : ""), "已填写" + (ready ? " \(filled)" : ""),
                      "未填写" + (ready ? " \(entries.count - filled)" : "")]
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

    @objc private func toggleExpanded() {
        expanded.toggle()
        show(entries)
    }

    private func clear() {
        for row in rows.arrangedSubviews { rows.removeArrangedSubview(row); row.removeFromSuperview() }
        elementButtons = []; mutedLines = []
        title.stringValue = "设定"
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
        onOpen?(entries[sender.tag].element)
    }
}
