import AppKit

/// One element's page: editable fields above the element's prose body. Each
/// field commits on end-editing or Return through `onCommit`; a refusal keeps
/// the typed text and shows the reason. The body is an ordinary native editor
/// bound to the element's own document owner.
final class MacElementPageView: NSView, NSTextFieldDelegate, NSTextViewDelegate {
    enum Field: CaseIterable { case name, aliases, summary, group, category }

    let documentView: NativeDocumentView
    let nameField = NSTextField()
    let aliasesField = NSTextField()
    let groupField = NSTextField()
    let summaryView = NSTextView()
    let categoryPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let message = NSTextField(wrappingLabelWithString: "")
    private let header = ElementHeaderWash()
    private(set) var element: WorkspaceElement
    private(set) var categories: [WorkspaceElementCategory]
    private(set) var isCommitting = false
    private var queued: [Field] = []
    /// Receives one field's changes; reports the stored element or the refusal.
    var onCommit: ((WorkspaceElementChanges, @escaping (Result<WorkspaceElement, Error>) -> Void) -> Void)?
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

        let grid = NSGridView(views: [
            [label("别名"), aliasesField],
            [label("分组"), NSStackView(views: [groupField, label("分类"), categoryPopup])],
            [label("简介"), summaryScroll],
        ])
        grid.rowSpacing = 8; grid.columnSpacing = 10
        grid.column(at: 0).xPlacement = .trailing
        grid.row(at: 2).yPlacement = .top
        let headerStack = NSStackView(views: [nameField, grid, message])
        headerStack.orientation = .vertical; headerStack.alignment = .leading; headerStack.spacing = 10
        headerStack.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(headerStack)
        let stack = NSStackView(views: [header, documentView])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            header.widthAnchor.constraint(equalTo: stack.widthAnchor),
            documentView.widthAnchor.constraint(equalTo: stack.widthAnchor),
            headerStack.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 14),
            headerStack.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -14),
            headerStack.topAnchor.constraint(equalTo: header.topAnchor, constant: 12),
            headerStack.bottomAnchor.constraint(equalTo: header.bottomAnchor, constant: -12),
            nameField.widthAnchor.constraint(equalTo: headerStack.widthAnchor),
            grid.widthAnchor.constraint(equalTo: headerStack.widthAnchor),
            message.widthAnchor.constraint(equalTo: headerStack.widthAnchor),
            summaryScroll.heightAnchor.constraint(equalToConstant: 48),
            groupField.widthAnchor.constraint(greaterThanOrEqualToConstant: 120),
        ])
        rebuildCategories()
        for field in Field.allCases { show(display(field, of: element), in: field) }
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

    private func rebuildCategories() {
        let selected = categoryPopup.numberOfItems == 0 ? element.categoryId : selectedCategoryID
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
    /// element saved. Fields with uncommitted text keep it.
    func apply(element updated: WorkspaceElement, categories updatedCategories: [WorkspaceElementCategory]? = nil) {
        let previous = element
        let clean = Field.allCases.filter { text(of: $0) == display($0, of: previous) }
        element = updated
        if let updatedCategories, updatedCategories != categories {
            categories = updatedCategories
            rebuildCategories()
        }
        for field in clean { show(display(field, of: updated), in: field) }
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
            if !queued.contains(field) { queued.append(field) }
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

    private func commitNext() {
        guard !isCommitting, !queued.isEmpty else { return }
        commit(queued.removeFirst())
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

/// The header's soft wash takes the category colour; no edge accent.
private final class ElementHeaderWash: NSView {
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
        color(for: WorkspaceElementCategory(id: "", projectId: "", name: "", color: hex, documentId: "", createdAt: "", updatedAt: ""))
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
