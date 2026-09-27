import AppKit

/// 补丁 on an element page: the element's 设定补丁 in order, each with its
/// title and body edited in place (committed at the end of editing), its
/// source chapter as a link, the anchored text and 已失效 while that text is
/// gone from the chapter. 新建补丁… adds a floating patch; rows reorder by
/// dragging their handle or through their menu (编辑…, 上移, 下移, 删除…).
/// The tab host's `PatchCoordinator` fills it and routes its actions.
final class ElementPatchesView: NSView {
    let addButton = NSButton(title: "新建补丁…", target: nil, action: nil)
    private let title = NSTextField(labelWithString: "补丁")
    private let rowsStack = NSStackView()
    private let document = PatchesDocumentView()
    private let scroll = NSScrollView()
    private let message = NSTextField(wrappingLabelWithString: "")
    private let empty = NSTextField(wrappingLabelWithString: "")
    private let dropLine = StoryGraphBand()
    private var scrollHeight: NSLayoutConstraint!
    /// Rows scroll inside the section beyond this height, so the body stays in view.
    static let maximumHeight: CGFloat = 230
    static let emptyText = "还没有补丁。在章节里选中文字，右键“新建补丁…”可以把变化锚定到原文；也可以用“新建补丁…”写一条不属于任何章节的补丁。"
    /// The patches shown, in order; nil while they are being read.
    private(set) var patches: [WorkspacePatch]?
    /// One row per patch, in order.
    private(set) var rows: [PatchRowView] = []
    private var dragging: (row: PatchRowView, start: NSPoint, moved: Bool, target: Int)?

    var onAdd: (() -> Void)?
    /// An inline title or body edit; reports nil or the refusal.
    var onCommit: ((WorkspacePatch, WorkspacePatchChanges, @escaping (Error?) -> Void) -> Void)?
    var onEdit: ((WorkspacePatch) -> Void)?
    /// Moves a patch before another (nil: last).
    var onMove: ((WorkspacePatch, String?) -> Void)?
    var onDelete: ((WorkspacePatch) -> Void)?
    var onOpenSource: ((WorkspacePatch) -> Void)?
    var onFocus: (() -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }
    var emptyLine: String? { empty.isHidden ? nil : empty.stringValue }

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityIdentifier("element-patches")
        title.font = .systemFont(ofSize: 12, weight: .semibold)
        title.textColor = .secondaryLabelColor
        addButton.bezelStyle = .recessed
        addButton.controlSize = .small
        addButton.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        addButton.target = self; addButton.action = #selector(add)
        addButton.setAccessibilityIdentifier("element-patch-add")
        addButton.toolTip = "写一条不属于任何章节的补丁；从章节里选中文字右键可锚定到原文"
        let header = NSStackView(views: [title, NSView(), addButton])
        rowsStack.orientation = .vertical; rowsStack.alignment = .leading; rowsStack.spacing = 6
        rowsStack.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(rowsStack)
        dropLine.tint = .labAccent; dropLine.alpha = 0.9
        dropLine.isHidden = true
        dropLine.setAccessibilityIdentifier("element-patch-drop-line")
        document.addSubview(dropLine)
        scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        scroll.drawsBackground = false; scroll.borderType = .noBorder
        scroll.documentView = document
        document.translatesAutoresizingMaskIntoConstraints = false
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("element-patches-error")
        empty.textColor = .secondaryLabelColor
        empty.font = .systemFont(ofSize: 12)
        empty.setAccessibilityIdentifier("element-patches-empty")
        let stack = NSStackView(views: [header, empty, scroll, message])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        scrollHeight = scroll.heightAnchor.constraint(equalToConstant: 0)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            header.widthAnchor.constraint(equalTo: stack.widthAnchor),
            empty.widthAnchor.constraint(equalTo: stack.widthAnchor),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scrollHeight,
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            rowsStack.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            rowsStack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            rowsStack.topAnchor.constraint(equalTo: document.topAnchor),
            rowsStack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
        ])
        show(nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Insets the section like the page's other sections.
    func inset() -> NSView {
        let row = NSView()
        translatesAutoresizingMaskIntoConstraints = false
        row.addSubview(self)
        NSLayoutConstraint.activate([
            leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 14),
            trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -14),
            topAnchor.constraint(equalTo: row.topAnchor, constant: 2),
            bottomAnchor.constraint(equalTo: row.bottomAnchor, constant: -2),
        ])
        return row
    }

    // MARK: Showing

    /// The element's patches in order; nil while they are read. Rows are kept
    /// by patch identity, and a field the author is typing in keeps its text.
    func show(_ patches: [WorkspacePatch]?) {
        self.patches = patches
        guard let patches else {
            title.stringValue = "补丁"
            empty.stringValue = "正在读取补丁…"; empty.isHidden = false
            for row in rows { rowsStack.removeArrangedSubview(row); row.removeFromSuperview() }
            rows = []
            updateHeight(); return
        }
        let invalid = patches.filter(\.isInvalid).count
        title.stringValue = patches.isEmpty ? "补丁" : "补丁 · \(patches.count)" + (invalid > 0 ? " · \(invalid) 条已失效" : "")
        empty.stringValue = Self.emptyText
        empty.isHidden = !patches.isEmpty
        var byID = Dictionary(rows.map { ($0.patch.id, $0) }, uniquingKeysWith: { first, _ in first })
        var next: [PatchRowView] = []
        for patch in patches {
            let row = byID.removeValue(forKey: patch.id) ?? makeRow(patch)
            row.apply(patch)
            next.append(row)
        }
        for row in byID.values { rowsStack.removeArrangedSubview(row); row.removeFromSuperview() }
        if next.map(ObjectIdentifier.init) != rowsStack.arrangedSubviews.map(ObjectIdentifier.init) {
            for (index, row) in next.enumerated() {
                if rowsStack.arrangedSubviews.firstIndex(of: row) != index {
                    rowsStack.removeArrangedSubview(row)
                    rowsStack.insertArrangedSubview(row, at: index)
                }
            }
        }
        rows = next
        updateHeight()
    }

    /// The last list stays with a note when a read fails.
    func showUnavailable(_ reason: String) {
        if patches == nil { empty.stringValue = "补丁暂时无法读取：\(reason)"; empty.isHidden = false }
        else { showMessage("补丁暂时无法刷新，显示的是上次读取的结果。") }
    }

    func showMessage(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    func row(patchID: String) -> PatchRowView? { rows.first { $0.patch.id == patchID } }

    private func makeRow(_ patch: WorkspacePatch) -> PatchRowView {
        let row = PatchRowView(patch: patch)
        row.translatesAutoresizingMaskIntoConstraints = false
        row.onCommit = { [weak self] patch, changes, done in
            guard let self, let onCommit = self.onCommit else { done(LabError.message("设定页面已关闭，补丁未保存。")); return }
            onCommit(patch, changes, done)
        }
        row.onOpenSource = { [weak self] patch in self?.showMessage(nil); self?.onOpenSource?(patch) }
        row.onFocus = { [weak self] in self?.onFocus?() }
        row.menuItemsProvider = { [weak self] patch in self?.menuItems(patchID: patch.id) ?? [] }
        row.handle.onMouse = { [weak self, weak row] phase, event in
            guard let self, let row else { return }
            self.drag(row, phase: phase, event: event)
        }
        rowsStack.addArrangedSubview(row)
        row.widthAnchor.constraint(equalTo: rowsStack.widthAnchor).isActive = true
        return row
    }

    private func updateHeight() {
        rowsStack.layoutSubtreeIfNeeded()
        let height = rows.isEmpty ? 0 : min(rowsStack.fittingSize.height, Self.maximumHeight)
        scrollHeight.constant = height
        scroll.isHidden = rows.isEmpty
    }

    @objc private func add() { showMessage(nil); onFocus?(); onAdd?() }

    // MARK: Menu

    /// A row's 编辑…, 上移, 下移 and 删除… items, as its menu shows them.
    func menuItems(patchID: String) -> [NSMenuItem] {
        guard let index = rows.firstIndex(where: { $0.patch.id == patchID }) else { return [] }
        let patch = rows[index].patch
        let edit = LibraryMenuItem(title: "编辑…", identifier: "element-patch-edit") { [weak self] in self?.onEdit?(patch) }
        let up = LibraryMenuItem(title: "上移", identifier: "element-patch-up") { [weak self] in
            guard let self, index > 0 else { return }
            self.onMove?(patch, self.rows[index - 1].patch.id)
        }
        up.isEnabled = index > 0
        let down = LibraryMenuItem(title: "下移", identifier: "element-patch-down") { [weak self] in
            guard let self, index + 1 < self.rows.count else { return }
            self.onMove?(patch, index + 2 < self.rows.count ? self.rows[index + 2].patch.id : nil)
        }
        down.isEnabled = index + 1 < rows.count
        let delete = LibraryMenuItem(title: "删除…", identifier: "element-patch-delete") { [weak self] in self?.onDelete?(patch) }
        return [edit, up, down, .separator(), delete]
    }

    // MARK: Dragging

    /// The row's handle drags it; the drop line shows where it would go, and
    /// the drop sends one move (none when the order is unchanged).
    private func drag(_ row: PatchRowView, phase: PatchDragHandle.Phase, event: NSEvent) {
        let point = document.convert(event.locationInWindow, from: nil)
        switch phase {
        case .down:
            onFocus?()
            dragging = (row, point, false, rows.firstIndex(of: row) ?? 0)
        case .dragged:
            guard var current = dragging, current.row === row else { return }
            if !current.moved {
                guard abs(point.y - current.start.y) >= 3 else { return }
                current.moved = true
            }
            let others = rows.filter { $0 !== row }.map { ($0, $0.convert($0.bounds, to: document)) }
            current.target = others.filter { $0.1.midY < point.y }.count
            dragging = current
            let y = current.target < others.count ? others[current.target].1.minY - 3
                : (others.last.map { $0.1.maxY + 3 } ?? 0)
            dropLine.frame = NSRect(x: 0, y: max(0, y - 1), width: document.bounds.width, height: 2)
            dropLine.isHidden = false
            document.autoscroll(with: event)
        case .up:
            guard let current = dragging, current.row === row else { return }
            dragging = nil
            dropLine.isHidden = true
            guard current.moved, let index = rows.firstIndex(of: row) else { return }
            let others = rows.filter { $0 !== row }
            guard current.target != index else { return }
            onMove?(row.patch, current.target < others.count ? others[current.target].patch.id : nil)
        }
    }
}

private final class PatchesDocumentView: NSView {
    override var isFlipped: Bool { true }
}

/// The drag handle at a row's leading edge.
final class PatchDragHandle: NSView {
    enum Phase { case down, dragged, up }
    var onMouse: ((Phase, NSEvent) -> Void)?
    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityElement(true)
        setAccessibilityRole(.handle)
        setAccessibilityLabel("拖动调整补丁顺序")
        toolTip = "拖动调整补丁顺序"
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var intrinsicContentSize: NSSize { NSSize(width: 14, height: 18) }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.tertiaryLabelColor.setFill()
        for row in 0..<3 {
            for column in 0..<2 {
                NSBezierPath(ovalIn: NSRect(x: 3 + CGFloat(column) * 5, y: 4 + CGFloat(row) * 4.5, width: 2.4, height: 2.4)).fill()
            }
        }
    }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { onMouse?(.down, event) }
    override func mouseDragged(with event: NSEvent) { onMouse?(.dragged, event) }
    override func mouseUp(with event: NSEvent) { onMouse?(.up, event) }
}

/// One patch: handle, title field, 已失效, menu; the source chapter link and
/// the anchored text; the body. Title and body commit when editing ends; a
/// refusal keeps the typed text.
final class PatchRowView: NSView, NSTextFieldDelegate, NSTextViewDelegate {
    private(set) var patch: WorkspacePatch
    let handle = PatchDragHandle()
    let titleField = NSTextField()
    let invalidBadge = NSTextField(labelWithString: "已失效")
    let sourceButton = NSButton(title: "", target: nil, action: nil)
    let quoteLabel = NSTextField(labelWithString: "")
    let bodyView = NSTextView()
    let menuButton = NSPopUpButton(frame: .zero, pullsDown: true)
    private let bodyScroll = NSScrollView()
    var onCommit: ((WorkspacePatch, WorkspacePatchChanges, @escaping (Error?) -> Void) -> Void)?
    var onOpenSource: ((WorkspacePatch) -> Void)?
    var onFocus: (() -> Void)?
    var menuItemsProvider: ((WorkspacePatch) -> [NSMenuItem])?
    private(set) var isCommitting = false
    private var queued: [Field] = []
    private enum Field { case title, body }

    init(patch: WorkspacePatch) {
        self.patch = patch
        super.init(frame: .zero)
        wantsLayer = true
        setAccessibilityIdentifier("element-patch-\(patch.id)")
        titleField.placeholderString = "补丁标题（可选）"
        titleField.font = .systemFont(ofSize: 13, weight: .medium)
        titleField.isBordered = false; titleField.drawsBackground = false; titleField.focusRingType = .none
        titleField.lineBreakMode = .byTruncatingTail
        titleField.cell?.isScrollable = true; titleField.cell?.wraps = false
        titleField.delegate = self
        titleField.setAccessibilityIdentifier("element-patch-title-\(patch.id)")
        titleField.setAccessibilityLabel("补丁标题")
        titleField.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        invalidBadge.font = .systemFont(ofSize: 11, weight: .medium)
        invalidBadge.textColor = .systemRed
        invalidBadge.toolTip = "锚定的原文已从章节中删除，此补丁已失效；原文回来后会自动恢复。"
        invalidBadge.setAccessibilityIdentifier("element-patch-invalid-\(patch.id)")
        invalidBadge.setContentHuggingPriority(.required, for: .horizontal)
        menuButton.addItem(withTitle: "⋯")
        menuButton.isBordered = false
        menuButton.setAccessibilityIdentifier("element-patch-menu-\(patch.id)")
        menuButton.setAccessibilityLabel("补丁操作")
        menuButton.setContentHuggingPriority(.required, for: .horizontal)
        menuButton.menu?.delegate = self
        sourceButton.isBordered = false
        sourceButton.target = self; sourceButton.action = #selector(openSource)
        sourceButton.setAccessibilityIdentifier("element-patch-source-\(patch.id)")
        sourceButton.setContentHuggingPriority(.required, for: .horizontal)
        quoteLabel.font = .systemFont(ofSize: 11.5)
        quoteLabel.textColor = .secondaryLabelColor
        quoteLabel.lineBreakMode = .byTruncatingTail
        quoteLabel.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        quoteLabel.setAccessibilityIdentifier("element-patch-quote-\(patch.id)")
        bodyView.isRichText = false
        bodyView.allowsUndo = true
        bodyView.font = .systemFont(ofSize: 12.5)
        bodyView.isVerticallyResizable = true
        bodyView.autoresizingMask = [.width]
        bodyView.textContainer?.widthTracksTextView = true
        bodyView.textContainerInset = NSSize(width: 2, height: 3)
        bodyView.delegate = self
        bodyView.setAccessibilityIdentifier("element-patch-body-\(patch.id)")
        bodyView.setAccessibilityLabel("补丁内容")
        bodyScroll.hasVerticalScroller = true; bodyScroll.borderType = .bezelBorder
        bodyScroll.documentView = bodyView
        let top = NSStackView(views: [handle, titleField, invalidBadge, menuButton])
        top.spacing = 6
        let source = NSStackView(views: [sourceButton, quoteLabel])
        source.spacing = 6
        let stack = NSStackView(views: [top, source, bodyScroll])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 3
        stack.edgeInsets = NSEdgeInsets(top: 5, left: 6, bottom: 6, right: 6)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            top.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -12),
            source.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor, constant: -12),
            bodyScroll.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -12),
            bodyScroll.heightAnchor.constraint(equalToConstant: 46),
        ])
        show(patch, fields: [.title, .body])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }
    override var wantsUpdateLayer: Bool { true }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    /// A soft wash, tinted while the patch is invalid; no edge accent.
    override func updateLayer() {
        layer?.cornerRadius = 6
        layer?.backgroundColor = (patch.isInvalid ? NSColor.systemRed.withAlphaComponent(0.07)
            : NSColor.secondaryLabelColor.withAlphaComponent(0.05)).cgColor
    }

    /// The title as typed, including an active field editor.
    var typedTitle: String { titleField.currentEditor()?.string ?? titleField.stringValue }
    var typedBody: String { bodyView.string }

    /// Adopts a newer stored patch; a field whose text differs from the
    /// previous stored value (still being typed, or refused) keeps it.
    func apply(_ updated: WorkspacePatch) {
        let previous = patch
        var clean: [Field] = []
        if typedTitle == (previous.title ?? "") { clean.append(.title) }
        if typedBody == previous.body { clean.append(.body) }
        patch = updated
        show(updated, fields: clean)
    }

    private func show(_ patch: WorkspacePatch, fields: [Field]) {
        if fields.contains(.title) {
            let value = patch.title ?? ""
            if let editor = titleField.currentEditor() { if editor.string != value { editor.string = value } }
            else if titleField.stringValue != value { titleField.stringValue = value }
        }
        if fields.contains(.body), bodyView.string != patch.body { bodyView.string = patch.body }
        invalidBadge.isHidden = !patch.isInvalid
        needsDisplay = true
        if patch.sourceNodeId != nil {
            let name = patch.sourceNodeTitle.map { "来自“\($0.isEmpty ? "未命名章节" : $0)”" } ?? "来源章节已删除"
            sourceButton.attributedTitle = NSAttributedString(string: name, attributes: [
                .font: NSFont.systemFont(ofSize: 11.5),
                .foregroundColor: patch.sourceNodeTitle == nil ? NSColor.tertiaryLabelColor : NSColor.linkColor])
            sourceButton.isEnabled = patch.sourceNodeTitle != nil
            sourceButton.toolTip = patch.sourceNodeTitle == nil ? "来源章节已在回收站或已删除" : patch.isInvalid
                ? "打开章节。锚定的原文已删除，无法选中。" : "打开章节并选中锚定的原文"
            sourceButton.setAccessibilityLabel(name)
        } else {
            sourceButton.attributedTitle = NSAttributedString(string: "无章节归属", attributes: [
                .font: NSFont.systemFont(ofSize: 11.5), .foregroundColor: NSColor.tertiaryLabelColor])
            sourceButton.isEnabled = false
            sourceButton.toolTip = "这条补丁不属于任何章节"
        }
        if let anchor = patch.anchorText, !anchor.isEmpty {
            let flat = anchor.replacingOccurrences(of: "\n", with: " ")
            quoteLabel.stringValue = "“\(flat)”"
            quoteLabel.toolTip = patch.isInvalid ? "原文快照（已从章节删除）：\(flat)" : flat
            quoteLabel.isHidden = false
        } else { quoteLabel.isHidden = true }
        setAccessibilityLabel("补丁 \(patch.title ?? "")\(patch.isInvalid ? "，已失效" : "")")
    }

    @objc private func openSource() { onFocus?(); onOpenSource?(patch) }

    // MARK: Commit

    private func changes(for field: Field) -> WorkspacePatchChanges? {
        switch field {
        case .title:
            let title = PatchText.title(typedTitle)
            guard title != patch.title else { return nil }
            return WorkspacePatchChanges(title: .some(title))
        case .body:
            guard PatchText.body(typedBody) != patch.body else { return nil }
            return WorkspacePatchChanges(body: typedBody)
        }
    }

    /// Writes one field; commands run one at a time in the order asked.
    private func commit(_ field: Field) {
        guard !isCommitting else { if !queued.contains(field) { queued.append(field) }; return }
        let submitted = field == .title ? typedTitle : typedBody
        guard let changes = changes(for: field), let onCommit else {
            // Nothing to write: show the stored form once editing stored the text.
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if field == .title, self.typedTitle == submitted { self.show(self.patch, fields: [.title]) }
                if field == .body, self.typedBody == submitted { self.show(self.patch, fields: [.body]) }
            }
            commitNext(); return
        }
        isCommitting = true
        onCommit(patch, changes) { [weak self] error in
            guard let self else { return }
            self.isCommitting = false
            if error == nil {
                // Show the stored form unless the author typed on meanwhile.
                if field == .title, self.typedTitle == submitted { self.show(self.patch, fields: [.title]) }
                if field == .body, self.typedBody == submitted { self.show(self.patch, fields: [.body]) }
            }
            self.commitNext()
        }
    }

    private func commitNext() {
        guard !isCommitting, !queued.isEmpty else { return }
        commit(queued.removeFirst())
    }

    /// Ends an active edit so its end-editing commit is sent now.
    func endEditing() {
        guard let window, let responder = window.firstResponder as? NSView, responder.isDescendant(of: self) else { return }
        window.makeFirstResponder(nil)
    }

    func controlTextDidBeginEditing(_ notification: Notification) { onFocus?() }
    func controlTextDidEndEditing(_ notification: Notification) {
        if notification.object as AnyObject? === titleField { commit(.title) }
    }
    func textDidBeginEditing(_ notification: Notification) { onFocus?() }
    func textDidEndEditing(_ notification: Notification) {
        if notification.object as AnyObject? === bodyView { commit(.body) }
    }
}

extension PatchRowView: NSMenuDelegate {
    /// The pull-down lists the section's items for this row.
    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === menuButton.menu else { return }
        while menu.items.count > 1 { menu.removeItem(at: 1) }
        for item in menuItemsProvider?(patch) ?? [] { menu.addItem(item) }
        menu.autoenablesItems = false
    }
}

/// Every element page's 补丁 through one coordinator per tab host: reads,
/// inline edits, the 新建补丁…/编辑… prompt, moves and deletions after a
/// confirmation, and 新建补丁… from a chapter or drift selection with its
/// element picker. Each reply lists the element's patches; every section of
/// that element shows them. After a chapter or drift body is saved, Rust has
/// rechecked anchored patches, so open sections read theirs again.
final class PatchCoordinator {
    private final class Binding {
        weak var section: ElementPatchesView?
        let projectID: String
        let elementID: String
        init(section: ElementPatchesView, projectID: String, elementID: String) {
            self.section = section; self.projectID = projectID; self.elementID = elementID
        }
    }
    private let workspace: LabWorkspaceCore
    private var bindings: [Binding] = []
    private var rechecks: [String: DispatchWorkItem] = [:]
    /// Debounce before open sections read again after body saves.
    static var recheckDelay: TimeInterval = 0.3
    /// Reads sent, for acceptance.
    private(set) var reads = 0
    /// The project's element library, for the picker; set by the tab host.
    var library: ((String) -> WorkspaceElementLibrary?)?
    /// An element created in the picker returned the complete library.
    var onElementLibrary: ((String, WorkspaceElementLibrary) -> Void)?
    /// A source link was chosen in a section.
    var onOpenSource: ((String, WorkspacePatch, ElementPatchesView) -> Void)?
    /// A patch was created from a selection.
    var onCreated: ((String, WorkspacePatch) -> Void)?
    /// Presents the 新建补丁…/编辑… prompt and confirmations. Nil uses a sheet
    /// on the section's window; acceptance answers here without one.
    var presentAlert: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
    /// Presents the picker sheet over a parent. Nil begins a sheet on it.
    var presentSheet: ((NSWindow, NSWindow?) -> Void)?
    /// The open 新建补丁 sheet, if any.
    private(set) var createSheet: MacPatchCreateSheet?

    init(workspace: LabWorkspaceCore) { self.workspace = workspace }

    func attach(_ section: ElementPatchesView, projectID: String, elementID: String) {
        bindings.removeAll { $0.section == nil || $0.section === section }
        bindings.append(Binding(section: section, projectID: projectID, elementID: elementID))
        section.onAdd = { [weak self, weak section] in
            if let self, let section { self.promptPatch(nil, projectID: projectID, elementID: elementID, from: section) }
        }
        section.onEdit = { [weak self, weak section] patch in
            if let self, let section { self.promptPatch(patch, projectID: projectID, elementID: elementID, from: section) }
        }
        section.onCommit = { [weak self, weak section] patch, changes, done in
            guard let self, let section else { done(LabError.message("设定页面已关闭，补丁未保存。")); return }
            self.update(patch, changes: changes, projectID: projectID, from: section, done: done)
        }
        section.onMove = { [weak self, weak section] patch, before in
            guard let self, let section else { return }
            self.command(projectID: projectID, elementID: elementID, from: section) {
                self.workspace.movePatch(projectID: projectID, patchID: patch.id, before: before, completion: $0)
            }
        }
        section.onDelete = { [weak self, weak section] patch in
            if let self, let section { self.confirmDelete(patch, projectID: projectID, elementID: elementID, from: section) }
        }
        section.onOpenSource = { [weak self, weak section] patch in
            if let self, let section { self.onOpenSource?(projectID, patch, section) }
        }
        if let known = bindings.first(where: { $0.section !== section && $0.projectID == projectID && $0.elementID == elementID })?
            .section?.patches {
            section.show(known)
        }
        read(projectID: projectID, elementID: elementID)
    }

    func detach(_ section: ElementPatchesView) {
        section.rows.forEach { $0.endEditing() }
        bindings.removeAll { $0.section == nil || $0.section === section }
        section.onAdd = nil; section.onEdit = nil; section.onCommit = nil; section.onMove = nil
        section.onDelete = nil; section.onOpenSource = nil
    }

    func forget(projectID: String) {
        rechecks.removeValue(forKey: projectID)?.cancel()
        bindings.removeAll { $0.section == nil || $0.projectID == projectID }
        if createSheet?.projectID == projectID { createSheet?.cancel() }
    }

    /// Every section of the project reads its element's patches again, e.g.
    /// after source chapters were renamed, trashed or restored.
    func reload(projectID: String) {
        let elements = Set(bindings.filter { $0.section != nil && $0.projectID == projectID }.map(\.elementID))
        for element in elements { read(projectID: projectID, elementID: element) }
    }

    /// A chapter or drift body of the project was saved: Rust rechecked its
    /// anchored patches, so open sections read theirs again shortly.
    func bodySaved(projectID: String) {
        guard bindings.contains(where: { $0.section != nil && $0.projectID == projectID }) else { return }
        rechecks[projectID]?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.rechecks[projectID] = nil
            self?.reload(projectID: projectID)
        }
        rechecks[projectID] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.recheckDelay, execute: work)
    }

    private func sections(_ projectID: String, _ elementID: String) -> [ElementPatchesView] {
        bindings.filter { $0.projectID == projectID && $0.elementID == elementID }.compactMap(\.section)
    }

    private func read(projectID: String, elementID: String) {
        reads += 1
        workspace.elementPatches(projectID: projectID, elementID: elementID) { [weak self] result in
            guard let self else { return }
            for section in self.sections(projectID, elementID) {
                switch result {
                case .success(let patches): section.show(patches)
                case .failure(let error): section.showUnavailable(error.localizedDescription)
                }
            }
        }
    }

    /// One command; its reply's list reaches every section of the element,
    /// and a refusal is shown on the section that asked.
    private func command<Value>(projectID: String, elementID: String, from section: ElementPatchesView?,
                                done: ((Result<WorkspacePatchReply<Value>, Error>) -> Void)? = nil,
                                operation: (@escaping (Result<WorkspacePatchReply<Value>, Error>) -> Void) -> Void) {
        section?.showMessage(nil)
        operation { [weak self, weak section] result in
            guard let self else { return }
            switch result {
            case .success(let reply):
                for shown in self.sections(projectID, elementID) { shown.show(reply.patches) }
            case .failure(let error):
                section?.showMessage(error.localizedDescription)
            }
            done?(result)
        }
    }

    private func update(_ patch: WorkspacePatch, changes: WorkspacePatchChanges, projectID: String,
                        from section: ElementPatchesView, done: @escaping (Error?) -> Void) {
        command(projectID: projectID, elementID: patch.elementId, from: section, done: { (result: Result<WorkspacePatchReply<WorkspacePatch>, Error>) in
            if case .failure(let error) = result { done(error) } else { done(nil) }
        }) {
            self.workspace.updatePatch(projectID: projectID, patchID: patch.id, changes: changes, completion: $0)
        }
    }

    // MARK: Prompts

    /// 新建补丁… (nil) or 编辑…: a title field and a body box. A refusal keeps
    /// the prompt's text and asks again.
    private func promptPatch(_ patch: WorkspacePatch?, projectID: String, elementID: String, from section: ElementPatchesView,
                             title typedTitle: String? = nil, body typedBody: String? = nil, refusal: String? = nil) {
        let alert = NSAlert()
        alert.messageText = patch == nil ? "新建补丁" : "编辑补丁"
        alert.informativeText = refusal ?? (patch == nil
            ? "记下这个设定从故事的某处起发生的变化。这条补丁不属于任何章节。"
            : "标题可以留空，但标题和内容不能都为空。")
        let editor = PatchEditorFields(title: typedTitle ?? patch?.title ?? "", body: typedBody ?? patch?.body ?? "")
        alert.accessoryView = editor
        alert.addButton(withTitle: patch == nil ? "创建" : "保存").setAccessibilityIdentifier("confirm-element-patch")
        alert.addButton(withTitle: "取消")
        present(alert, from: section) { [weak self, weak section] response in
            guard let self, let section, response == .alertFirstButtonReturn else { return }
            let title = editor.titleField.stringValue, body = editor.bodyView.string
            let retry: (Error) -> Void = { [weak self, weak section] error in
                guard let self, let section else { return }
                section.showMessage(error.localizedDescription)
                self.promptPatch(patch, projectID: projectID, elementID: elementID, from: section, title: title, body: body,
                                 refusal: error.localizedDescription)
            }
            if let patch {
                var changes = WorkspacePatchChanges()
                if PatchText.title(title) != patch.title { changes.title = .some(PatchText.title(title)) }
                if PatchText.body(body) != patch.body { changes.body = body }
                guard !changes.isEmpty else { return }
                self.command(projectID: projectID, elementID: elementID, from: section, done: { (result: Result<WorkspacePatchReply<WorkspacePatch>, Error>) in
                    if case .failure(let error) = result { retry(error) }
                }) {
                    self.workspace.updatePatch(projectID: projectID, patchID: patch.id, changes: changes, completion: $0)
                }
            } else {
                self.command(projectID: projectID, elementID: elementID, from: section, done: { (result: Result<WorkspacePatchReply<WorkspacePatch>, Error>) in
                    if case .failure(let error) = result { retry(error) }
                }) {
                    self.workspace.createPatch(projectID: projectID, elementID: elementID, title: PatchText.title(title), body: body,
                                               source: nil, completion: $0)
                }
            }
        }
        alert.window.makeFirstResponder(editor.titleField)
    }

    private func confirmDelete(_ patch: WorkspacePatch, projectID: String, elementID: String, from section: ElementPatchesView) {
        let alert = NSAlert()
        let name = patch.title.map { "“\($0)”" } ?? "这条补丁"
        alert.messageText = "删除\(name)？"
        alert.informativeText = "补丁的标题和内容会一起删除，章节正文不受影响。"
        alert.addButton(withTitle: "删除").setAccessibilityIdentifier("confirm-delete-element-patch")
        alert.addButton(withTitle: "取消")
        present(alert, from: section) { [weak self, weak section] response in
            guard let self, response == .alertFirstButtonReturn else { return }
            self.command(projectID: projectID, elementID: elementID, from: section) { (done: @escaping (Result<WorkspacePatchReply<WorkspacePatch>, Error>) -> Void) in
                self.workspace.deletePatch(projectID: projectID, patchID: patch.id, completion: done)
            }
        }
    }

    private func present(_ alert: NSAlert, from section: ElementPatchesView,
                         completion: @escaping (NSApplication.ModalResponse) -> Void) {
        if let presentAlert { presentAlert(alert, completion); return }
        if let window = section.window { alert.beginSheetModal(for: window, completionHandler: completion) }
    }

    // MARK: From a selection

    /// 新建补丁… on a chapter or drift selection: the picker sheet over the
    /// window. The patch records the chapter, the block, its text and the
    /// selected text.
    func beginCreate(projectID: String, source: WorkspacePatchSource, from window: NSWindow?) {
        guard createSheet == nil, presentSheet != nil || window != nil else { return }
        let sheet = MacPatchCreateSheet(projectID: projectID, source: source,
                                        library: library?(projectID) ?? .empty)
        createSheet = sheet
        sheet.onCreateElement = { [weak self, weak sheet] name, categoryID, done in
            guard let self else { return }
            self.workspace.createElement(projectID: projectID, categoryID: categoryID, name: name) { [weak self, weak sheet] result in
                switch result {
                case .success(let reply):
                    self?.onElementLibrary?(projectID, reply.library)
                    sheet?.reload(library: reply.library)
                    done(reply.result.map { .success($0) } ?? .failure(LabError.message("设定结果缺失")))
                case .failure(let error): done(.failure(error))
                }
            }
        }
        sheet.onSubmit = { [weak self] elementID, title, body, done in
            guard let self else { done(LabError.message("编辑栏已关闭，补丁未创建。")); return }
            self.command(projectID: projectID, elementID: elementID, from: nil, done: { [weak self] (result: Result<WorkspacePatchReply<WorkspacePatch>, Error>) in
                switch result {
                case .success(let reply):
                    if let patch = reply.result { self?.onCreated?(projectID, patch) }
                    done(nil)
                case .failure(let error): done(error)
                }
            }) {
                self.workspace.createPatch(projectID: projectID, elementID: elementID, title: title, body: body, source: source,
                                           completion: $0)
            }
        }
        sheet.onFinish = { [weak self, weak sheet] in
            if let self, let sheet, self.createSheet === sheet { self.createSheet = nil }
        }
        if let presentSheet { presentSheet(sheet.window, window) } else { window?.beginSheet(sheet.window) }
    }
}

/// The 新建补丁/编辑补丁 prompt's fields: a title and a body box.
final class PatchEditorFields: NSView {
    let titleField = NSTextField()
    let bodyView = NSTextView()

    init(title: String, body: String) {
        super.init(frame: NSRect(x: 0, y: 0, width: 340, height: 150))
        titleField.stringValue = title
        titleField.placeholderString = "标题（可选），例如 失去左臂"
        titleField.setAccessibilityIdentifier("element-patch-prompt-title")
        titleField.frame = NSRect(x: 0, y: 124, width: 340, height: 24)
        bodyView.string = body
        bodyView.isRichText = false
        bodyView.allowsUndo = true
        bodyView.font = .systemFont(ofSize: 13)
        bodyView.isVerticallyResizable = true
        bodyView.autoresizingMask = [.width]
        bodyView.textContainer?.widthTracksTextView = true
        bodyView.setAccessibilityIdentifier("element-patch-prompt-body")
        bodyView.setAccessibilityLabel("补丁内容")
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 340, height: 116))
        scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        scroll.documentView = bodyView
        bodyView.frame = NSRect(x: 0, y: 0, width: scroll.contentSize.width, height: scroll.contentSize.height)
        addSubview(titleField); addSubview(scroll)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

/// 新建补丁 from a selection: the selected text, the element it changes
/// (searched by name and alias, or created by name in a chosen category),
/// an optional title and the body. Nothing is written until 创建补丁 (an
/// element created here is written at once); a refusal keeps every field.
final class MacPatchCreateSheet: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
    enum Candidate: Equatable {
        case element(WorkspaceElement)
        /// 创建设定「name」.
        case create(String)
    }
    let projectID: String
    let source: WorkspacePatchSource
    let window: NSWindow
    let quoteLabel = NSTextField(wrappingLabelWithString: "")
    let searchField = NSSearchField()
    let table = NSTableView()
    let chosenLabel = NSTextField(labelWithString: "")
    let categoryPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let titleField = NSTextField()
    let bodyView = NSTextView()
    let createButton = NSButton(title: "创建补丁", target: nil, action: nil)
    let cancelButton = NSButton(title: "取消", target: nil, action: nil)
    private let message = NSTextField(wrappingLabelWithString: "")
    private(set) var library: WorkspaceElementLibrary
    private(set) var candidates: [Candidate] = []
    private(set) var element: WorkspaceElement?
    private(set) var isSaving = false
    private var updatingSelection = false
    /// Creates an element by name in a category; reports it or the refusal.
    var onCreateElement: ((String, String, @escaping (Result<WorkspaceElement, Error>) -> Void) -> Void)?
    /// Receives the element, the title (nil when empty) and the body; reports nil or the refusal.
    var onSubmit: ((String, String?, String, @escaping (Error?) -> Void) -> Void)?
    var onFinish: (() -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }

    init(projectID: String, source: WorkspacePatchSource, library: WorkspaceElementLibrary) {
        self.projectID = projectID
        self.source = source
        self.library = library
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 520), styleMask: [.titled],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "新建补丁"
        super.init()
        let heading = NSTextField(labelWithString: "新建设定补丁")
        heading.font = .systemFont(ofSize: 15, weight: .semibold)
        let explanation = NSTextField(wrappingLabelWithString: "记下这个设定从这里起发生的变化。选中的原文被删除后，补丁会标为已失效。")
        explanation.textColor = .secondaryLabelColor
        let flat = (source.anchorText ?? "").replacingOccurrences(of: "\n", with: " ")
        quoteLabel.stringValue = "“\(flat)”"
        quoteLabel.textColor = .secondaryLabelColor
        quoteLabel.maximumNumberOfLines = 3
        quoteLabel.lineBreakMode = .byTruncatingTail
        quoteLabel.setAccessibilityIdentifier("patch-create-quote")
        let label = { (text: String) -> NSTextField in
            let value = NSTextField(labelWithString: text)
            value.textColor = .secondaryLabelColor
            return value
        }
        searchField.placeholderString = "搜索设定名称或别名"
        searchField.delegate = self
        searchField.target = self; searchField.action = #selector(filterChanged)
        searchField.setAccessibilityIdentifier("patch-create-search")
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("candidate")))
        table.headerView = nil
        table.rowHeight = 22
        table.dataSource = self; table.delegate = self
        table.setAccessibilityIdentifier("patch-create-candidates")
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        scroll.documentView = table
        chosenLabel.lineBreakMode = .byTruncatingTail
        chosenLabel.setAccessibilityIdentifier("patch-create-element")
        categoryPopup.setAccessibilityIdentifier("patch-create-category")
        categoryPopup.toolTip = "新建设定时放进的分类"
        let categoryRow = NSStackView(views: [label("新设定的分类"), categoryPopup])
        titleField.placeholderString = "一句话概括这次变化（可选）"
        titleField.setAccessibilityIdentifier("patch-create-title")
        bodyView.isRichText = false
        bodyView.allowsUndo = true
        bodyView.font = .systemFont(ofSize: 13)
        bodyView.isVerticallyResizable = true
        bodyView.autoresizingMask = [.width]
        bodyView.textContainer?.widthTracksTextView = true
        bodyView.textContainerInset = NSSize(width: 4, height: 5)
        bodyView.setAccessibilityIdentifier("patch-create-body")
        bodyView.setAccessibilityLabel("补丁内容")
        let bodyScroll = NSScrollView()
        bodyScroll.hasVerticalScroller = true; bodyScroll.borderType = .bezelBorder
        bodyScroll.documentView = bodyView
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("patch-create-error")
        createButton.target = self; createButton.action = #selector(submit)
        createButton.keyEquivalent = "\r"; createButton.keyEquivalentModifierMask = [.command]
        createButton.setAccessibilityIdentifier("confirm-create-patch")
        cancelButton.target = self; cancelButton.action = #selector(cancel)
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.setAccessibilityIdentifier("cancel-create-patch")
        let buttons = NSStackView(views: [NSView(), cancelButton, createButton])
        let stack = NSStackView(views: [heading, explanation, quoteLabel, label("设定"), searchField, scroll, chosenLabel, categoryRow,
                                        label("标题（可选）"), titleField, label("补丁内容"), bodyScroll, message, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            content.widthAnchor.constraint(equalToConstant: 460),
            explanation.widthAnchor.constraint(equalTo: stack.widthAnchor),
            quoteLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
            searchField.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(equalToConstant: 132),
            chosenLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
            titleField.widthAnchor.constraint(equalTo: stack.widthAnchor),
            bodyScroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            bodyScroll.heightAnchor.constraint(equalToConstant: 96),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        reload(library: library)
        content.layoutSubtreeIfNeeded()
        window.setContentSize(content.fittingSize)
        window.initialFirstResponder = searchField
    }

    /// Adopt a newer library: candidates, categories and the chosen element follow.
    func reload(library: WorkspaceElementLibrary) {
        self.library = library
        if let chosen = element { element = library.elements.first { $0.id == chosen.id } }
        let selected = categoryPopup.selectedItem?.representedObject as? String
        categoryPopup.removeAllItems()
        for category in library.categories {
            categoryPopup.addItem(withTitle: category.name)
            categoryPopup.lastItem?.representedObject = category.id
            categoryPopup.lastItem?.image = ElementSwatch.image(for: category)
            categoryPopup.lastItem?.setAccessibilityIdentifier("patch-create-category-\(category.id)")
        }
        if let selected, let index = library.categories.firstIndex(where: { $0.id == selected }) { categoryPopup.selectItem(at: index) }
        if library.categories.isEmpty { categoryPopup.addItem(withTitle: "还没有分类"); categoryPopup.isEnabled = false }
        else { categoryPopup.isEnabled = true }
        filter()
        update()
    }

    // MARK: Candidates

    private func filter() {
        let query = searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let matches = library.elements.filter { element in
            query.isEmpty || element.name.localizedCaseInsensitiveContains(query)
                || element.aliases.contains { $0.localizedCaseInsensitiveContains(query) }
        }
        candidates = matches.prefix(50).map { .element($0) }
        // A name or alias already taken is chosen, not created again.
        let exact = library.elements.contains { element in
            ([element.name] + element.aliases).contains { $0.compare(query, options: .caseInsensitive) == .orderedSame }
        }
        if !query.isEmpty, !exact { candidates.append(.create(query)) }
        updatingSelection = true
        table.reloadData()
        if let element, let index = candidates.firstIndex(of: .element(element)) {
            table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
        } else { table.deselectAll(nil) }
        updatingSelection = false
    }

    /// Types a query as the search field would.
    func search(_ query: String) {
        searchField.stringValue = query
        filter()
    }

    /// Chooses a listed element, as a click would.
    func choose(elementID: String) {
        guard let index = candidates.firstIndex(where: { if case .element(let element) = $0 { return element.id == elementID }; return false }) else { return }
        table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
    }

    /// Chooses the category a created element goes into.
    func chooseCategory(_ id: String) {
        guard let index = library.categories.firstIndex(where: { $0.id == id }) else { return }
        categoryPopup.selectItem(at: index)
    }

    /// 创建设定「名称」: creates the searched name in the chosen category and
    /// chooses it.
    func createElement() {
        guard !isSaving, let name = candidates.compactMap({ if case .create(let name) = $0 { return name }; return nil }).first else { return }
        guard let categoryID = categoryPopup.selectedItem?.representedObject as? String else {
            showError("设定库里还没有分类。请先在设定库中新建一个分类，再创建设定。"); return
        }
        guard let onCreateElement else { return }
        isSaving = true; update(); showError(nil)
        onCreateElement(name, categoryID) { [weak self] result in
            guard let self else { return }
            self.isSaving = false
            switch result {
            case .success(let created):
                self.element = self.library.elements.first { $0.id == created.id } ?? created
                self.searchField.stringValue = ""
                self.filter()
            case .failure(let error): self.showError(error.localizedDescription)
            }
            self.update()
        }
    }

    func numberOfRows(in tableView: NSTableView) -> Int { candidates.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        switch candidates[row] {
        case .element(let element):
            let category = library.categories.first { $0.id == element.categoryId }
            let kind = NSTextField(labelWithString: category?.name ?? "未分类")
            kind.font = .systemFont(ofSize: 11)
            kind.textColor = .tertiaryLabelColor
            kind.setContentHuggingPriority(.required, for: .horizontal)
            let name = NSTextField(labelWithString: element.name)
            name.lineBreakMode = .byTruncatingTail
            let stack = NSStackView(views: [kind, name])
            stack.spacing = 8
            stack.setAccessibilityIdentifier("patch-create-candidate-\(element.id)")
            return stack
        case .create(let name):
            let label = NSTextField(labelWithString: "创建设定「\(name)」")
            label.textColor = .linkColor
            label.setAccessibilityIdentifier("patch-create-new-element")
            return label
        }
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !updatingSelection, candidates.indices.contains(table.selectedRow) else { return }
        switch candidates[table.selectedRow] {
        case .element(let chosen): element = chosen; showError(nil); update()
        case .create: createElement()
        }
    }

    func controlTextDidChange(_ notification: Notification) { filter() }
    @objc private func filterChanged() { filter() }

    private func update() {
        chosenLabel.stringValue = element.map { "设定：\($0.name)" } ?? "先在上方选择一个设定，或输入名称新建"
        chosenLabel.textColor = element == nil ? .tertiaryLabelColor : .labelColor
        createButton.isEnabled = element != nil && !isSaving
        cancelButton.isEnabled = !isSaving
        searchField.isEnabled = !isSaving
    }

    private func showError(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    // MARK: Finishing

    @objc func submit() {
        guard !isSaving, let element, let onSubmit else { return }
        let title = PatchText.title(titleField.stringValue), body = bodyView.string
        guard title != nil || !PatchText.trim(body).isEmpty else { showError("补丁的标题和内容不能都为空。"); return }
        isSaving = true; update(); showError(nil)
        onSubmit(element.id, title, body) { [weak self] error in
            guard let self else { return }
            self.isSaving = false; self.update()
            if let error { self.showError(error.localizedDescription) } else { self.finish() }
        }
    }

    @objc func cancel() {
        guard !isSaving else { return }
        finish()
    }

    private func finish() {
        if let parent = window.sheetParent { parent.endSheet(window) }
        window.orderOut(nil)
        onFinish?()
    }
}
