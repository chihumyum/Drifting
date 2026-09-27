import AppKit

/// One element's page: its 肖像, editable fields and ordered facts, then 关系 (curated
/// relations), 补丁 (设定补丁) and 被引用 (the chapters and pages that link it), above the element's
/// prose body. Each field commits
/// on end-editing or Return through `onCommit`; the facts list commits as a
/// whole through `onCommitFacts`. A refusal keeps the typed text and rows and
/// shows the reason. The body is an ordinary native editor bound to the
/// element's own document owner.
final class MacElementPageView: NSView, NSTextFieldDelegate, NSTextViewDelegate {
    enum Field: CaseIterable { case name, aliases, summary, group, category }

    let documentView: NativeDocumentView
    let nameField = NSTextField()
    let aliasesField = NSTextField()
    let groupField = NSTextField()
    let summaryView = NSTextView()
    let categoryPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let factsEditor = ElementFactsEditor(prefix: "element-fact", emptyText: "还没有字段。可以添加“年龄”“身份”这类要点。")
    /// 肖像: the stored image or the name's initial; set, replaced by a drop
    /// and removed through `onSetPortrait`.
    let portraitView = ElementPortraitView()
    private let message = NSTextField(wrappingLabelWithString: "")
    private let header = ElementHeaderWash()
    let backlinksView = ElementBacklinksView()
    /// 关系, filled and driven by the tab host's relation coordinator.
    let relationsView = RelationsSectionView()
    /// 补丁, filled and driven by the tab host's patch coordinator.
    let patchesView = ElementPatchesView()
    /// The last backlinks read; nil until the first read completes.
    private(set) var backlinks: WorkspaceElementBacklinks?
    private var backlinkGeneration = 0
    /// Reads this element's backlinks; set by the tab owner.
    var onLoadBacklinks: ((@escaping (Result<WorkspaceElementBacklinks, Error>) -> Void) -> Void)?
    /// Opens a listed chapter at its first link.
    var onOpenBacklink: ((WorkspaceElementBacklinks.Chapter) -> Void)?
    /// Opens a listed drift, element, category or storyline page at its first link.
    var onOpenBacklinkSource: ((WorkspaceElementBacklinks.Source) -> Void)?
    private(set) var element: WorkspaceElement
    private(set) var categories: [WorkspaceElementCategory]
    private(set) var isCommitting = false
    private enum Pending: Equatable { case field(Field), facts }
    private var queued: [Pending] = []
    /// Receives one field's changes; reports the stored element or the refusal.
    var onCommit: ((WorkspaceElementChanges, @escaping (Result<WorkspaceElement, Error>) -> Void) -> Void)?
    /// Receives the complete ordered facts list exactly as typed.
    var onCommitFacts: (([WorkspaceFact], @escaping (Result<WorkspaceElement, Error>) -> Void) -> Void)?
    /// Imports an image as the portrait, or clears it with nil; reports the
    /// stored portrait's path or the refusal.
    var onSetPortrait: ((URL?, @escaping (Result<String?, Error>) -> Void) -> Void)?
    var onFocus: (() -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }

    init(element: WorkspaceElement, categories: [WorkspaceElementCategory], core: LabCore) {
        self.element = element
        self.categories = categories
        documentView = NativeDocumentView(core: core, allowsComments: false, minimumTextHeight: 150)
        super.init(frame: .zero)
        setAccessibilityIdentifier("element-page-\(element.id)")

        nameField.font = .systemFont(ofSize: 18, weight: .semibold)
        nameField.placeholderString = "设定名称"
        nameField.isBordered = false; nameField.drawsBackground = false; nameField.focusRingType = .none
        nameField.lineBreakMode = .byTruncatingTail
        nameField.setAccessibilityIdentifier("element-name"); nameField.setAccessibilityLabel("名称")
        aliasesField.placeholderString = "用逗号分隔，例如 阿岚，岚姐"
        aliasesField.setAccessibilityIdentifier("element-aliases"); aliasesField.setAccessibilityLabel("别名")
        groupField.placeholderString = "未分组"
        groupField.setAccessibilityIdentifier("element-group"); groupField.setAccessibilityLabel("分组")
        for field in [nameField, aliasesField, groupField] {
            field.delegate = self
            field.cell?.isScrollable = true; field.cell?.wraps = false
        }
        summaryView.isRichText = false
        summaryView.allowsUndo = true
        summaryView.font = .systemFont(ofSize: 13)
        summaryView.isVerticallyResizable = true
        summaryView.autoresizingMask = [.width]
        summaryView.textContainer?.widthTracksTextView = true
        summaryView.textContainerInset = NSSize(width: 2, height: 4)
        summaryView.delegate = self
        summaryView.setAccessibilityIdentifier("element-summary"); summaryView.setAccessibilityLabel("简介")
        let summaryScroll = NSScrollView()
        summaryScroll.hasVerticalScroller = true; summaryScroll.borderType = .bezelBorder
        summaryScroll.documentView = summaryView
        categoryPopup.target = self; categoryPopup.action = #selector(categoryChosen)
        categoryPopup.setAccessibilityIdentifier("element-category"); categoryPopup.setAccessibilityLabel("分类")
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("element-page-error")
        factsEditor.onCommit = { [weak self] in self?.commitFacts() }
        factsEditor.onFocus = { [weak self] in self?.onFocus?() }
        let factsLabel = label("字段")

        let grid = NSGridView(views: [
            [label("别名"), aliasesField],
            [label("分组"), NSStackView(views: [groupField, label("分类"), categoryPopup])],
            [label("简介"), summaryScroll],
            [factsLabel, factsEditor],
        ])
        grid.rowSpacing = 8; grid.columnSpacing = 10
        grid.column(at: 0).xPlacement = .trailing
        grid.row(at: 2).yPlacement = .top
        grid.row(at: 3).yPlacement = .top
        grid.row(at: 3).topPadding = 4
        grid.cell(for: factsEditor)?.xPlacement = .fill
        let fieldsStack = NSStackView(views: [nameField, grid, message])
        fieldsStack.orientation = .vertical; fieldsStack.alignment = .leading; fieldsStack.spacing = 10
        portraitView.onChange = { [weak self] url in self?.setPortrait(url) }
        let headerStack = NSStackView(views: [portraitView, fieldsStack])
        headerStack.orientation = .horizontal; headerStack.alignment = .top; headerStack.spacing = 16
        headerStack.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(headerStack)
        backlinksView.onOpen = { [weak self] in self?.onOpenBacklink?($0) }
        backlinksView.onOpenSource = { [weak self] in self?.onOpenBacklinkSource?($0) }
        backlinksView.translatesAutoresizingMaskIntoConstraints = false
        let backlinksRow = NSView()
        backlinksRow.addSubview(backlinksView)
        let relationsRow = relationsView.inset()
        let patchesRow = patchesView.inset()
        patchesView.onFocus = { [weak self] in self?.onFocus?() }
        let stack = NSStackView(views: [header, relationsRow, patchesRow, backlinksRow, documentView])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            header.widthAnchor.constraint(equalTo: stack.widthAnchor),
            backlinksRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            relationsRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            patchesRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            backlinksView.leadingAnchor.constraint(equalTo: backlinksRow.leadingAnchor, constant: 14),
            backlinksView.trailingAnchor.constraint(equalTo: backlinksRow.trailingAnchor, constant: -14),
            backlinksView.topAnchor.constraint(equalTo: backlinksRow.topAnchor, constant: 2),
            backlinksView.bottomAnchor.constraint(equalTo: backlinksRow.bottomAnchor, constant: -2),
            documentView.widthAnchor.constraint(equalTo: stack.widthAnchor),
            headerStack.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 14),
            headerStack.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -14),
            headerStack.topAnchor.constraint(equalTo: header.topAnchor, constant: 12),
            headerStack.bottomAnchor.constraint(equalTo: header.bottomAnchor, constant: -12),
            nameField.widthAnchor.constraint(equalTo: fieldsStack.widthAnchor),
            grid.widthAnchor.constraint(equalTo: fieldsStack.widthAnchor),
            message.widthAnchor.constraint(equalTo: fieldsStack.widthAnchor),
            fieldsStack.trailingAnchor.constraint(equalTo: headerStack.trailingAnchor),
            summaryScroll.heightAnchor.constraint(equalToConstant: 48),
            groupField.widthAnchor.constraint(greaterThanOrEqualToConstant: 120),
            factsLabel.topAnchor.constraint(equalTo: factsEditor.topAnchor, constant: 3),
        ])
        rebuildCategories(selecting: element.categoryId)
        for field in Field.allCases { show(display(field, of: element), in: field) }
        factsEditor.show(element.facts)
        portraitView.show(path: nil, name: element.name)
        updateWash()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    // MARK: Portrait

    /// Shows the stored portrait, or the placeholder for nil.
    func showPortrait(path: String?) {
        guard portraitView.shownPath != path || !portraitLoaded else { return }
        portraitLoaded = true
        portraitView.show(path: path, name: element.name)
    }
    /// False until the library was first read; the placeholder shows meanwhile.
    private(set) var portraitLoaded = false

    /// The host and Rust read the file; a refusal keeps the current portrait.
    private func setPortrait(_ url: URL?) {
        guard let onSetPortrait, !portraitView.isBusy else { return }
        onFocus?()
        portraitView.isBusy = true
        showMessage(nil)
        onSetPortrait(url) { [weak self] result in
            guard let self else { return }
            self.portraitView.isBusy = false
            switch result {
            case .success(let path): self.portraitLoaded = true; self.portraitView.show(path: path, name: self.element.name)
            case .failure(let error): self.showMessage(error.localizedDescription)
            }
        }
    }

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
        case .aliases: return aliasesField.currentEditor()?.string ?? aliasesField.stringValue
        case .group: return groupField.currentEditor()?.string ?? groupField.stringValue
        case .summary: return summaryView.string
        case .category: return selectedCategoryID ?? ""
        }
    }

    private func display(_ field: Field, of element: WorkspaceElement) -> String {
        switch field {
        case .name: return element.name
        case .aliases: return ElementText.display(aliases: element.aliases)
        case .group: return element.groupName ?? ""
        case .summary: return element.summary
        case .category: return element.categoryId ?? ""
        }
    }

    private var selectedCategoryID: String? { categoryPopup.selectedItem?.representedObject as? String }

    private func show(_ value: String, in field: Field) {
        func replace(_ control: NSTextField) {
            // Keep an active editing session: its text becomes the field's
            // value when editing ends, so no end-editing is simulated here.
            if let editor = control.currentEditor() {
                if editor.string != value { editor.string = value }
            } else if control.stringValue != value { control.stringValue = value }
        }
        switch field {
        case .name: replace(nameField)
        case .aliases: replace(aliasesField)
        case .group: replace(groupField)
        case .summary: if summaryView.string != value { summaryView.string = value }
        case .category: selectCategory(value.isEmpty ? nil : value)
        }
    }

    private func selectCategory(_ id: String?) {
        let index = categoryPopup.itemArray.firstIndex { ($0.representedObject as? String) == id }
        categoryPopup.selectItem(at: index ?? 0)
    }

    private func rebuildCategories(selecting selected: String?) {
        categoryPopup.removeAllItems()
        categoryPopup.addItem(withTitle: "未分类")
        categoryPopup.lastItem?.setAccessibilityIdentifier("element-category-none")
        for category in categories {
            categoryPopup.addItem(withTitle: category.name)
            categoryPopup.lastItem?.representedObject = category.id
            categoryPopup.lastItem?.image = ElementSwatch.image(for: category)
            categoryPopup.lastItem?.setAccessibilityIdentifier("element-category-\(category.id)")
        }
        // A trashed or unknown category still shows as the stored identity.
        if let selected, !categories.contains(where: { $0.id == selected }) {
            categoryPopup.addItem(withTitle: "不可用的分类")
            categoryPopup.lastItem?.representedObject = selected
        }
        selectCategory(selected)
    }

    private func updateWash() {
        header.tint = categories.first { $0.id == element.categoryId }.flatMap(ElementSwatch.color(for:))
    }

    /// Adopt a newer stored element, e.g. after another view of the same
    /// element saved or its category was trashed. Fields and facts with
    /// uncommitted text keep it.
    func apply(element updated: WorkspaceElement, categories updatedCategories: [WorkspaceElementCategory]? = nil) {
        let previous = element
        let clean = Field.allCases.filter { text(of: $0) == display($0, of: previous) }
        let typedFacts = ElementText.stored(facts: factsEditor.facts)
        element = updated
        if let updatedCategories, updatedCategories != categories {
            categories = updatedCategories
            // A clean popup follows the stored category, so a detached
            // element shows 未分类 rather than a stale entry.
            rebuildCategories(selecting: clean.contains(.category) ? updated.categoryId : selectedCategoryID)
        }
        for field in clean { show(display(field, of: updated), in: field) }
        // Rows already equal to the stored list stay as they are, including a
        // blank row the author has just added.
        if typedFacts == previous.facts, typedFacts != updated.facts { factsEditor.show(updated.facts) }
        // The placeholder shows the stored name's initial.
        if updated.name != previous.name { portraitView.show(path: portraitView.shownPath, name: updated.name) }
        updateWash()
    }

    // MARK: Commit

    /// The changes this field would write, or nil when it matches the stored value.
    private func changes(for field: Field) -> WorkspaceElementChanges? {
        var changes = WorkspaceElementChanges()
        let value = text(of: field)
        switch field {
        case .name:
            let name = ElementText.trimmed(value)
            guard !name.isEmpty else { showMessage("名称不能为空，已恢复原名称。"); return nil }
            guard name != element.name else { return nil }
            changes.name = name
        case .aliases:
            let aliases = ElementText.aliases(from: value)
            guard aliases != element.aliases else { return nil }
            changes.aliases = aliases
        case .summary:
            guard value != element.summary else { return nil }
            changes.summary = value
        case .group:
            let group = ElementText.trimmed(value)
            let next: String? = group.isEmpty ? nil : group
            guard next != element.groupName else { return nil }
            changes.groupName = .some(next)
        case .category:
            guard selectedCategoryID != element.categoryId else { return nil }
            changes.categoryID = .some(selectedCategoryID)
        }
        return changes
    }

    /// Writes one field. Commands run one at a time in the order requested.
    func commit(_ field: Field) {
        guard !isCommitting else {
            if !queued.contains(.field(field)) { queued.append(.field(field)) }
            return
        }
        // Sent now, so a following close or quit is ordered after this write.
        let submitted = text(of: field)
        guard let changes = changes(for: field), let onCommit else {
            // Nothing to write: show the stored form (an empty name restored,
            // spacing trimmed) once end-editing has stored the typed text.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.text(of: field) == submitted else { return }
                self.show(self.display(field, of: self.element), in: field)
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
                self.apply(element: stored)
                // Show the stored form (trimmed, normalized aliases) unless
                // the author has typed on since this command was sent.
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
        guard ElementText.stored(facts: submitted) != element.facts, let onCommitFacts else { commitNext(); return }
        isCommitting = true
        onCommitFacts(submitted) { [weak self] result in
            guard let self else { return }
            self.isCommitting = false
            switch result {
            case .success(let stored):
                self.showMessage(nil)
                self.apply(element: stored)
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

    /// Reads 被引用 again. Only the newest read is shown; a failure keeps the
    /// last list visible with a note.
    func reloadBacklinks() {
        guard let onLoadBacklinks else { return }
        backlinkGeneration += 1
        let generation = backlinkGeneration
        if backlinks == nil { backlinksView.showMessage("正在读取引用…") }
        onLoadBacklinks { [weak self] result in
            guard let self, generation == self.backlinkGeneration else { return }
            switch result {
            case .success(let value):
                self.backlinks = value
                self.backlinksView.show(value)
            case .failure:
                if let backlinks = self.backlinks { self.backlinksView.show(backlinks, note: "引用暂时无法刷新，显示的是上次读取的结果。") }
                else { self.backlinksView.showMessage("引用暂时无法读取，稍后会自动重试。") }
            }
        }
    }

    func focusName() {
        window?.makeFirstResponder(nameField)
        nameField.currentEditor()?.selectAll(nil)
    }

    private func showMessage(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    private func field(for control: Any?) -> Field? {
        let object = control as AnyObject?
        if object === nameField { return .name }
        if object === aliasesField { return .aliases }
        if object === groupField { return .group }
        return nil
    }

    func controlTextDidBeginEditing(_ notification: Notification) { onFocus?() }
    func controlTextDidEndEditing(_ notification: Notification) {
        if let field = field(for: notification.object) { commit(field) }
    }
    func textDidBeginEditing(_ notification: Notification) { onFocus?() }
    func textDidEndEditing(_ notification: Notification) {
        if notification.object as AnyObject? === summaryView { commit(.summary) }
    }
    @objc private func categoryChosen() { onFocus?(); commit(.category) }
}

/// 被引用: each chapter that links the element as a row, “N 处 · M 次”
/// (blocks · links), opening the chapter at its first link; then the drift,
/// element, category and storyline pages that link it, opening each page at
/// its first link. Bodies that could not be read are listed muted.
/// Typography and spacing only.
final class ElementBacklinksView: NSView {
    private let title = NSTextField(labelWithString: "被引用")
    private let rows = NSStackView()
    private var chapters: [WorkspaceElementBacklinks.Chapter] = []
    private var sources: [WorkspaceElementBacklinks.Source] = []
    private var current: (backlinks: WorkspaceElementBacklinks, note: String?)?
    /// Long lists show this many chapters until the author expands them, so
    /// the body editor stays in view.
    static let collapsedCount = 6
    private(set) var expanded = false
    var onOpen: ((WorkspaceElementBacklinks.Chapter) -> Void)?
    /// Opens a listed page at its first link.
    var onOpenSource: ((WorkspaceElementBacklinks.Source) -> Void)?
    /// One button per listed chapter, in book order.
    private(set) var chapterButtons: [NSButton] = []
    /// One button per listed page, after the chapters.
    private(set) var sourceButtons: [NSButton] = []
    /// Muted rows for chapters that could not be read, and any note.
    private(set) var mutedLines: [String] = []

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityIdentifier("element-backlinks")
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

    static func countText(_ chapter: WorkspaceElementBacklinks.Chapter) -> String { "\(chapter.blocks) 处 · \(chapter.spans) 次" }
    static func countText(_ source: WorkspaceElementBacklinks.Source) -> String { "\(source.blocks) 处 · \(source.spans) 次" }

    func showMessage(_ text: String) {
        clear(); current = nil
        addMuted(text)
    }

    func show(_ backlinks: WorkspaceElementBacklinks, note: String? = nil) {
        if current?.backlinks.elementId != backlinks.elementId { expanded = false }
        clear(); current = (backlinks, note)
        chapters = backlinks.chapters
        sources = backlinks.sources
        var counts: [String] = []
        if !backlinks.chapters.isEmpty { counts.append("\(backlinks.chapters.count) 章") }
        if !backlinks.sources.isEmpty { counts.append("\(backlinks.sources.count) 个页面") }
        title.stringValue = (["被引用"] + counts).joined(separator: " · ")
        if backlinks.chapters.isEmpty && backlinks.unavailable.isEmpty && backlinks.sources.isEmpty && backlinks.unavailableSources.isEmpty {
            addMuted("还没有章节引用这个设定。")
        }
        let shown = expanded ? backlinks.chapters.count : min(backlinks.chapters.count, Self.collapsedCount)
        for (index, chapter) in backlinks.chapters.prefix(shown).enumerated() {
            let button = NSButton(title: "", target: self, action: #selector(open(_:)))
            button.isBordered = false; button.tag = index
            button.alignment = .left
            let text = NSMutableAttributedString(string: chapter.chapterTitle,
                attributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.labelColor])
            text.append(NSAttributedString(string: "  " + Self.countText(chapter),
                attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor]))
            button.attributedTitle = text
            button.setAccessibilityIdentifier("element-backlink-\(chapter.chapterId)")
            button.setAccessibilityLabel("\(chapter.chapterTitle)，\(Self.countText(chapter))")
            button.toolTip = "打开「\(chapter.chapterTitle)」并定位第一处引用"
            rows.addArrangedSubview(button)
            chapterButtons.append(button)
        }
        if backlinks.chapters.count > Self.collapsedCount {
            let more = backlinks.chapters.count - Self.collapsedCount
            let toggle = NSButton(title: expanded ? "收起" : "显示其余 \(more) 章", target: self, action: #selector(toggleExpanded))
            toggle.isBordered = false
            toggle.contentTintColor = .secondaryLabelColor
            toggle.font = .systemFont(ofSize: 12)
            toggle.setAccessibilityIdentifier("element-backlinks-toggle")
            rows.addArrangedSubview(toggle)
        }
        for missing in backlinks.unavailable { addMuted("\(missing.chapterTitle) · 暂时无法读取") }
        for (index, source) in backlinks.sources.enumerated() {
            let button = NSButton(title: "", target: self, action: #selector(openSource(_:)))
            button.isBordered = false; button.tag = index
            button.alignment = .left
            let text = NSMutableAttributedString(string: "\(source.kindLabel) · ",
                attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor])
            text.append(NSAttributedString(string: source.title,
                attributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor.labelColor]))
            text.append(NSAttributedString(string: "  " + Self.countText(source),
                attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor]))
            button.attributedTitle = text
            button.setAccessibilityIdentifier("element-backlink-\(source.kind)-\(source.id)")
            button.setAccessibilityLabel("\(source.kindLabel)「\(source.title)」，\(Self.countText(source))")
            button.toolTip = "打开\(source.kindLabel)「\(source.title)」并定位第一处引用"
            rows.addArrangedSubview(button)
            sourceButtons.append(button)
        }
        for missing in backlinks.unavailableSources { addMuted("\(missing.kindLabel)「\(missing.title)」 · 暂时无法读取") }
        if let note { addMuted(note) }
    }

    @objc private func toggleExpanded() {
        expanded.toggle()
        if let current { show(current.backlinks, note: current.note) }
    }

    private func clear() {
        for row in rows.arrangedSubviews { rows.removeArrangedSubview(row); row.removeFromSuperview() }
        chapters = []; sources = []; chapterButtons = []; sourceButtons = []; mutedLines = []
        title.stringValue = "被引用"
    }

    private func addMuted(_ text: String) {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: 12)
        label.textColor = .secondaryLabelColor
        rows.addArrangedSubview(label)
        mutedLines.append(text)
    }

    @objc private func open(_ sender: NSButton) {
        guard chapters.indices.contains(sender.tag) else { return }
        onOpen?(chapters[sender.tag])
    }

    @objc private func openSource(_ sender: NSButton) {
        guard sources.indices.contains(sender.tag) else { return }
        onOpenSource?(sources[sender.tag])
    }
}

/// The header's soft wash takes the category (or storyline) colour; no edge accent.
final class ElementHeaderWash: NSView {
    var tint: NSColor? { didSet { needsDisplay = true } }
    override init(frame: NSRect) { super.init(frame: frame); wantsLayer = true }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var wantsUpdateLayer: Bool { true }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    override func updateLayer() {
        layer?.cornerRadius = 8
        layer?.backgroundColor = (tint?.withAlphaComponent(0.12) ?? NSColor.secondaryLabelColor.withAlphaComponent(0.06)).cgColor
    }
}

enum ElementSwatch {
    static func color(for category: WorkspaceElementCategory) -> NSColor? {
        category.rgb.map { NSColor(srgbRed: $0.red, green: $0.green, blue: $0.blue, alpha: 1) }
    }
    static func color(hex: String) -> NSColor? {
        WorkspaceElementCategory.rgb(hex: hex).map { NSColor(srgbRed: $0.red, green: $0.green, blue: $0.blue, alpha: 1) }
    }
    static func image(for category: WorkspaceElementCategory) -> NSImage { image(color: color(for: category)) }
    static func image(color: NSColor?) -> NSImage {
        NSImage(size: NSSize(width: 12, height: 12), flipped: false) { rect in
            (color ?? .secondaryLabelColor).setFill()
            NSBezierPath(roundedRect: rect.insetBy(dx: 1, dy: 1), xRadius: 3, yRadius: 3).fill()
            return true
        }
    }
}
