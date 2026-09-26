import AppKit

/// An ordered list of key/value rows with add, delete, move up/down and inline
/// editing. The owner decides when the whole list is written: `onCommit` runs
/// after a field ends editing and after a row is added, removed or moved. Text
/// is never trimmed here; Rust drops rows whose key and value are both blank.
final class ElementFactsEditor: NSView, NSTextFieldDelegate {
    final class Row {
        let root = NSStackView()
        let keyField = NSTextField()
        let valueField = NSTextField()
        let upButton: NSButton
        let downButton: NSButton
        let deleteButton: NSButton

        init(upButton: NSButton, downButton: NSButton, deleteButton: NSButton) {
            self.upButton = upButton; self.downButton = downButton; self.deleteButton = deleteButton
        }
    }

    private static let ringInset: CGFloat = 4
    private let prefix: String
    private let rowsStack = NSStackView()
    private let scroll = NSScrollView()
    private let emptyLabel: NSTextField
    let addButton = NSButton(title: "添加字段", target: nil, action: nil)
    private(set) var rows: [Row] = []
    /// Programmatic changes never report a commit of their own.
    private var isApplying = false
    var onCommit: (() -> Void)?
    var onFocus: (() -> Void)?

    /// `prefix` scopes accessibility identifiers, e.g. `element-fact-key-0`.
    init(prefix: String, emptyText: String, maximumHeight: CGFloat = 164) {
        self.prefix = prefix
        emptyLabel = NSTextField(wrappingLabelWithString: emptyText)
        super.init(frame: .zero)
        setAccessibilityIdentifier("\(prefix)-list")

        rowsStack.orientation = .vertical; rowsStack.alignment = .leading; rowsStack.spacing = 4
        // Room for bezels and focus rings inside the clip view; the outer
        // stack is widened by the same amount so fields align with the page.
        rowsStack.edgeInsets = NSEdgeInsets(top: 3, left: Self.ringInset, bottom: 3, right: Self.ringInset)
        rowsStack.translatesAutoresizingMaskIntoConstraints = false
        let document = FactsDocumentView()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(rowsStack)
        scroll.drawsBackground = false; scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        scroll.documentView = document
        emptyLabel.textColor = .tertiaryLabelColor
        emptyLabel.font = .systemFont(ofSize: 12)
        emptyLabel.setAccessibilityIdentifier("\(prefix)-empty")
        addButton.bezelStyle = .rounded; addButton.controlSize = .small
        addButton.font = .systemFont(ofSize: NSFont.systemFontSize(for: .small))
        addButton.image = NSImage(systemSymbolName: "plus", accessibilityDescription: nil)
        addButton.imagePosition = .imageLeading
        addButton.target = self; addButton.action = #selector(addPressed)
        addButton.setAccessibilityIdentifier("\(prefix)-add")
        let footer = NSStackView(views: [addButton, emptyLabel])
        footer.spacing = 10
        footer.edgeInsets = NSEdgeInsets(top: 0, left: Self.ringInset, bottom: 0, right: Self.ringInset)
        let stack = NSStackView(views: [scroll, footer])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        // The owner decides the width; rows stretch to it.
        for view in [stack, footer, rowsStack] { view.setHuggingPriority(.init(1), for: .horizontal) }
        addSubview(stack)
        let fitContent = scroll.heightAnchor.constraint(equalTo: document.heightAnchor)
        fitContent.priority = .defaultHigh
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: -Self.ringInset),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: Self.ringInset),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: -3), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            footer.widthAnchor.constraint(equalTo: stack.widthAnchor),
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            rowsStack.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            rowsStack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            rowsStack.topAnchor.constraint(equalTo: document.topAnchor),
            rowsStack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            fitContent,
            scroll.heightAnchor.constraint(lessThanOrEqualToConstant: maximumHeight),
        ])
        refreshState()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    // MARK: Values

    /// The rows as typed, including an active field editor and blank rows.
    var facts: [WorkspaceFact] {
        rows.map { WorkspaceFact(key: Self.text(of: $0.keyField), value: Self.text(of: $0.valueField)) }
    }

    private static func text(of field: NSTextField) -> String { field.currentEditor()?.string ?? field.stringValue }

    /// Shows exactly these rows. Existing row views and an active field editor
    /// are reused in place, so replacing values keeps the keyboard where it is.
    func show(_ facts: [WorkspaceFact]) {
        isApplying = true
        defer { isApplying = false }
        while rows.count > facts.count {
            let row = rows.removeLast()
            if let window, let responder = window.firstResponder as? NSView, responder.isDescendant(of: row.root) {
                window.makeFirstResponder(nil)
            }
            rowsStack.removeArrangedSubview(row.root); row.root.removeFromSuperview()
        }
        while rows.count < facts.count { appendRow() }
        for (row, fact) in zip(rows, facts) {
            Self.replace(row.keyField, with: fact.key)
            Self.replace(row.valueField, with: fact.value)
        }
        refreshState()
    }

    private static func replace(_ field: NSTextField, with value: String) {
        if let editor = field.currentEditor() {
            if editor.string != value { editor.string = value }
        } else if field.stringValue != value { field.stringValue = value }
    }

    var isEditing: Bool {
        guard let window, let responder = window.firstResponder as? NSView else { return false }
        return responder.isDescendant(of: self)
    }

    // MARK: Row actions

    /// Appends a blank row and moves the keyboard to its key.
    func addRow() {
        var next = facts
        next.append(WorkspaceFact(key: "", value: ""))
        change(to: next)
        if let row = rows.last {
            window?.makeFirstResponder(row.keyField)
        }
    }

    func removeRow(at index: Int) {
        guard rows.indices.contains(index) else { return }
        var next = facts
        next.remove(at: index)
        change(to: next)
    }

    func moveRow(at index: Int, by offset: Int) {
        let target = index + offset
        guard rows.indices.contains(index), rows.indices.contains(target) else { return }
        var next = facts
        next.swapAt(index, target)
        change(to: next)
    }

    /// A structural change reads the typed text first, so an active edit is
    /// carried into the new order and written once with it.
    private func change(to next: [WorkspaceFact]) {
        isApplying = true
        if isEditing { window?.makeFirstResponder(nil) }
        isApplying = false
        show(next)
        onCommit?()
    }

    @objc private func addPressed() { onFocus?(); addRow() }

    private func index(of button: NSButton, in keyPath: KeyPath<Row, NSButton>) -> Int? {
        rows.firstIndex { $0[keyPath: keyPath] === button }
    }
    @objc private func upPressed(_ sender: NSButton) {
        onFocus?(); if let index = index(of: sender, in: \.upButton) { moveRow(at: index, by: -1) }
    }
    @objc private func downPressed(_ sender: NSButton) {
        onFocus?(); if let index = index(of: sender, in: \.downButton) { moveRow(at: index, by: 1) }
    }
    @objc private func deletePressed(_ sender: NSButton) {
        onFocus?(); if let index = index(of: sender, in: \.deleteButton) { removeRow(at: index) }
    }

    // MARK: Row views

    private func symbolButton(_ symbol: String, label: String, action: Selector) -> NSButton {
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label) ?? NSImage()
        let button = NSButton(image: image, target: self, action: action)
        button.isBordered = false
        button.contentTintColor = .secondaryLabelColor
        button.toolTip = label
        button.setAccessibilityLabel(label)
        button.widthAnchor.constraint(equalToConstant: 20).isActive = true
        return button
    }

    private func appendRow() {
        let row = Row(upButton: symbolButton("chevron.up", label: "上移", action: #selector(upPressed(_:))),
                      downButton: symbolButton("chevron.down", label: "下移", action: #selector(downPressed(_:))),
                      deleteButton: symbolButton("minus.circle", label: "删除字段", action: #selector(deletePressed(_:))))
        row.keyField.placeholderString = "字段名"
        row.valueField.placeholderString = "内容"
        for field in [row.keyField, row.valueField] {
            field.delegate = self
            field.cell?.isScrollable = true; field.cell?.wraps = false
            field.lineBreakMode = .byTruncatingTail
        }
        row.keyField.font = .systemFont(ofSize: 13, weight: .medium)
        row.root.setViews([row.keyField, row.valueField, row.upButton, row.downButton, row.deleteButton], in: .leading)
        row.root.spacing = 6
        row.root.distribution = .fill
        row.root.setHuggingPriority(.init(1), for: .horizontal)
        rowsStack.addArrangedSubview(row.root)
        NSLayoutConstraint.activate([
            row.root.widthAnchor.constraint(equalTo: rowsStack.widthAnchor, constant: -2 * Self.ringInset),
            row.keyField.widthAnchor.constraint(equalToConstant: 112),
            row.valueField.widthAnchor.constraint(greaterThanOrEqualToConstant: 80),
        ])
        // Only the value stretches with the page.
        row.valueField.setContentHuggingPriority(.init(1), for: .horizontal)
        for button in [row.upButton, row.downButton, row.deleteButton] { button.setContentHuggingPriority(.required, for: .horizontal) }
        rows.append(row)
    }

    /// Identifiers and labels follow the row's position; the first row cannot
    /// move up and the last cannot move down.
    private func refreshState() {
        for (index, row) in rows.enumerated() {
            row.root.setAccessibilityIdentifier("\(prefix)-row-\(index)")
            row.keyField.setAccessibilityIdentifier("\(prefix)-key-\(index)")
            row.keyField.setAccessibilityLabel("字段名 \(index + 1)")
            row.valueField.setAccessibilityIdentifier("\(prefix)-value-\(index)")
            row.valueField.setAccessibilityLabel("内容 \(index + 1)")
            row.upButton.setAccessibilityIdentifier("\(prefix)-up-\(index)")
            row.downButton.setAccessibilityIdentifier("\(prefix)-down-\(index)")
            row.deleteButton.setAccessibilityIdentifier("\(prefix)-delete-\(index)")
            row.upButton.isEnabled = index > 0
            row.downButton.isEnabled = index < rows.count - 1
        }
        scroll.isHidden = rows.isEmpty
        emptyLabel.isHidden = !rows.isEmpty
    }

    func controlTextDidBeginEditing(_ notification: Notification) { onFocus?() }
    func controlTextDidEndEditing(_ notification: Notification) {
        guard !isApplying else { return }
        onCommit?()
    }
}

/// Rows start at the top of the scroll view.
private final class FactsDocumentView: NSView {
    override var isFlipped: Bool { true }
}

/// Edits one category's template facts in a sheet. Nothing is written until
/// 保存; a refusal keeps the rows and shows the reason.
final class CategoryTemplateSheet: NSObject {
    let category: WorkspaceElementCategory
    let window: NSWindow
    let editor = ElementFactsEditor(prefix: "template-fact", emptyText: "还没有模板字段。", maximumHeight: 240)
    let saveButton = NSButton(title: "保存", target: nil, action: nil)
    let cancelButton = NSButton(title: "取消", target: nil, action: nil)
    let explanation: NSTextField
    private let message = NSTextField(wrappingLabelWithString: "")
    var onSave: (([WorkspaceFact]) -> Void)?
    var onCancel: (() -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }

    init(category: WorkspaceElementCategory) {
        self.category = category
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 240), styleMask: [.titled],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "模板字段"
        explanation = NSTextField(wrappingLabelWithString:
            "之后在“\(category.name)”中新建的设定会自动带上这些字段，内容也会一并复制。已有的设定不会改变。")
        super.init()
        let title = NSTextField(labelWithString: "“\(category.name)”的模板字段")
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.lineBreakMode = .byTruncatingTail
        explanation.textColor = .secondaryLabelColor
        explanation.setAccessibilityIdentifier("template-fact-explanation")
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("template-fact-error")
        editor.show(category.templateFacts)
        saveButton.target = self; saveButton.action = #selector(save)
        saveButton.keyEquivalent = "\r"
        saveButton.setAccessibilityIdentifier("save-category-template")
        cancelButton.target = self; cancelButton.action = #selector(cancel)
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.setAccessibilityIdentifier("cancel-category-template")
        let buttons = NSStackView(views: [NSView(), cancelButton, saveButton])
        let stack = NSStackView(views: [title, explanation, editor, message, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.setCustomSpacing(6, after: title)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            content.widthAnchor.constraint(equalToConstant: 480),
            title.widthAnchor.constraint(equalTo: stack.widthAnchor),
            explanation.widthAnchor.constraint(equalTo: stack.widthAnchor),
            editor.widthAnchor.constraint(equalTo: stack.widthAnchor),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        content.layoutSubtreeIfNeeded()
        window.setContentSize(content.fittingSize)
    }

    func showError(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    func setSaving(_ saving: Bool) {
        saveButton.isEnabled = !saving
        editor.addButton.isEnabled = !saving
    }

    @objc private func save() { onSave?(editor.facts) }
    @objc private func cancel() { onCancel?() }
}
