import AppKit

/// 情节规划格 below a chapter's or drift's prose: a header with 添加行,
/// 添加列, the cell size and 隐藏, then the grid. The dock's top edge drags
/// to resize it. It edits only the node's grid through `PlotGridModel`; the
/// prose, its history and word counts are never touched. Every dock of the
/// same page shares one model, so two panes follow each other.
final class MacPlotPlannerDock: NSView {
    let model: PlotGridModel
    let canvas: PlotGridCanvas
    let addRowButton = NSButton(title: "添加行", target: nil, action: nil)
    let addColumnButton = NSButton(title: "添加列", target: nil, action: nil)
    let widthSlider = NSSlider(value: WorkspacePlotGrid.defaultWidth, minValue: WorkspacePlotGrid.widths.lowerBound,
                               maxValue: WorkspacePlotGrid.widths.upperBound, target: nil, action: nil)
    let heightSlider = NSSlider(value: WorkspacePlotGrid.defaultHeight, minValue: WorkspacePlotGrid.heights.lowerBound,
                                maxValue: WorkspacePlotGrid.heights.upperBound, target: nil, action: nil)
    let sizeLabel = NSTextField(labelWithString: "")
    let hideButton = NSButton(title: "隐藏", target: nil, action: nil)
    let resizeHandle = PlotPlannerResizeHandle()
    private let message = NSTextField(wrappingLabelWithString: "")
    private let hint = NSTextField(labelWithString: "")
    private var heightConstraint: NSLayoutConstraint!
    private(set) var height: CGFloat
    /// 隐藏 was pressed.
    var onHide: (() -> Void)?
    /// A drag of the top edge ended at this height.
    var onResized: ((CGFloat) -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }
    var hintText: String { hint.stringValue }

    init(model: PlotGridModel, height: CGFloat) {
        self.model = model
        canvas = PlotGridCanvas(model: model)
        self.height = CGFloat(PlotPlannerSetting.clamped(Double(height)))
        super.init(frame: .zero)
        setAccessibilityIdentifier("plot-planner-\(model.nodeID)")
        let title = NSTextField(labelWithString: "情节规划格")
        title.font = .systemFont(ofSize: 12, weight: .semibold)
        for (button, identifier, action) in [(addRowButton, "plot-add-row", #selector(addRow)),
                                             (addColumnButton, "plot-add-column", #selector(addColumn)),
                                             (hideButton, "plot-hide", #selector(hide))] {
            button.controlSize = .small
            button.bezelStyle = .rounded
            button.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
            button.target = self; button.action = action
            button.setAccessibilityIdentifier(identifier)
        }
        addRowButton.toolTip = "在选中的行之后添加一行，没有选中时加在最后"
        addColumnButton.toolTip = "在选中的列之后添加一列，没有选中时加在最后"
        for (slider, identifier, label) in [(widthSlider, "plot-cell-width", "格子宽度"), (heightSlider, "plot-cell-height", "格子高度")] {
            slider.controlSize = .small
            slider.isContinuous = false
            slider.target = self; slider.action = #selector(sizeChosen)
            slider.setAccessibilityIdentifier(identifier); slider.setAccessibilityLabel(label)
            slider.widthAnchor.constraint(equalToConstant: 90).isActive = true
        }
        sizeLabel.font = .monospacedDigitSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        sizeLabel.textColor = .secondaryLabelColor
        sizeLabel.setAccessibilityIdentifier("plot-cell-size")
        hint.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        hint.textColor = .tertiaryLabelColor
        hint.lineBreakMode = .byTruncatingTail
        hint.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        message.textColor = .systemRed
        message.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        message.isHidden = true
        message.setAccessibilityIdentifier("plot-planner-error")
        let widthLabel = NSTextField(labelWithString: "宽"), heightLabel = NSTextField(labelWithString: "高")
        for label in [widthLabel, heightLabel] { label.textColor = .secondaryLabelColor; label.font = .systemFont(ofSize: NSFont.smallSystemFontSize) }
        let header = NSStackView(views: [title, addRowButton, addColumnButton, hint, NSView(), widthLabel, widthSlider, heightLabel, heightSlider,
                                         sizeLabel, hideButton])
        header.spacing = 8
        header.setCustomSpacing(14, after: title)
        let scroll = NSScrollView()
        scroll.contentView = PlotFlippedClipView()
        scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = true; scroll.autohidesScrollers = true
        scroll.borderType = .bezelBorder
        scroll.documentView = canvas
        let stack = NSStackView(views: [resizeHandle, header, message, scroll])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        heightConstraint = heightAnchor.constraint(equalToConstant: self.height)
        heightConstraint.priority = .init(740)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            resizeHandle.widthAnchor.constraint(equalTo: stack.widthAnchor), resizeHandle.heightAnchor.constraint(equalToConstant: 7),
            header.widthAnchor.constraint(equalTo: stack.widthAnchor), message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            heightConstraint,
        ])
        setContentHuggingPriority(.init(740), for: .vertical)
        resizeHandle.onDrag = { [weak self] delta, ended in self?.drag(by: delta, ended: ended) }
        canvas.onAlert = { [weak self] alert, done in self?.present(alert, completion: done) }
        model.observe(self) { [weak self] in self?.reload() }
        reload()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Presents the grid's confirmations; nil uses a sheet on the window.
    var presentAlert: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
    var onFocus: (() -> Void)? {
        get { canvas.onFocus }
        set { canvas.onFocus = newValue }
    }

    /// The grid, the refusal and the size as the model has them now.
    func reload() {
        let grid = model.grid
        canvas.show(grid)
        message.stringValue = model.message ?? ""
        message.isHidden = model.message == nil
        // Nothing is edited until the first read replies.
        if !model.loaded { hint.stringValue = model.message == nil ? "正在读取…" : "" }
        else { hint.stringValue = model.stored == nil ? "空白规划格，写下内容后保存" : "" }
        for control in [addRowButton, addColumnButton, widthSlider, heightSlider] as [NSControl] { control.isEnabled = model.loaded }
        if widthSlider.doubleValue != grid.cellWidth { widthSlider.doubleValue = grid.cellWidth }
        if heightSlider.doubleValue != grid.cellHeight { heightSlider.doubleValue = grid.cellHeight }
        sizeLabel.stringValue = "\(Int(grid.cellWidth.rounded())) × \(Int(grid.cellHeight.rounded()))"
    }

    /// Sets the dock's height within `PlotPlannerSetting.heights`.
    func setHeight(_ value: CGFloat) {
        height = CGFloat(PlotPlannerSetting.clamped(Double(value)))
        heightConstraint.constant = height
    }

    private var dragStart: CGFloat?
    private func drag(by delta: CGFloat, ended: Bool) {
        let start = dragStart ?? height
        dragStart = start
        setHeight(start + delta)
        if ended { dragStart = nil; onResized?(height) }
    }

    @objc private func addRow() { canvas.addAxis(.row) }
    @objc private func addColumn() { canvas.addAxis(.column) }
    @objc private func hide() { canvas.commitEditing(); onHide?() }

    /// One gesture: both dimensions, rounded, within Rust's limits.
    @objc private func sizeChosen() {
        let width = min(max(widthSlider.doubleValue.rounded(), WorkspacePlotGrid.widths.lowerBound), WorkspacePlotGrid.widths.upperBound)
        let height = min(max(heightSlider.doubleValue.rounded(), WorkspacePlotGrid.heights.lowerBound), WorkspacePlotGrid.heights.upperBound)
        if !model.perform([.setSize(width: width, height: height)]) { reload() }
    }

    private func present(_ alert: NSAlert, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        if let presentAlert { presentAlert(alert, completion) }
        else if let window { alert.beginSheetModal(for: window, completionHandler: completion) }
        else { completion(alert.runModal()) }
    }
}

/// The dock's top edge: dragging it up makes the dock taller.
final class PlotPlannerResizeHandle: NSView {
    /// The vertical distance dragged so far (up is positive); true on release.
    var onDrag: ((CGFloat, Bool) -> Void)?
    private var start: NSPoint?

    override func resetCursorRects() { addCursorRect(bounds, cursor: .resizeUpDown) }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.separatorColor.setFill()
        NSRect(x: bounds.midX - 18, y: bounds.midY - 1, width: 36, height: 2).fill()
    }
    override func mouseDown(with event: NSEvent) { start = event.locationInWindow }
    override func mouseDragged(with event: NSEvent) {
        guard let start else { return }
        onDrag?(event.locationInWindow.y - start.y, false)
    }
    override func mouseUp(with event: NSEvent) {
        guard let start else { return }
        self.start = nil
        onDrag?(event.locationInWindow.y - start.y, true)
    }
}

/// Keeps a small grid at the top of its scroll view.
final class PlotFlippedClipView: NSClipView {
    override var isFlipped: Bool { true }
}

/// The in-place editor of one cell or header. Return commits, ⌥Return
/// starts a new line in a cell, Tab and ⇧Tab commit and move, Esc cancels.
/// Pasting tab- or line-separated text fills cells from the edited one.
final class PlotCellEditor: NSTextView {
    /// A pasted block; true when the grid took it.
    var onPasteBlock: ((String) -> Bool)?
    var onResign: (() -> Void)?
    /// Where blocks are read from; the general pasteboard by default.
    var pasteboard = NSPasteboard.general

    override func paste(_ sender: Any?) {
        if let text = pasteboard.string(forType: .string), text.contains("\t") || text.contains("\n") || text.contains("\r"),
           onPasteBlock?(text) == true { return }
        super.paste(sender)
    }
    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { onResign?() }
        return resigned
    }
}

/// The grid itself: row headers down the leading edge, column headers along
/// the top and text cells, drawn by this view. A click edits a cell; a
/// click selects a header, a double-click renames it and a drag reorders
/// it. With the grid focused, arrows, Tab and ⇧Tab move, Return edits,
/// Delete clears a cell and ⌘V pastes a block. Each gesture is one call.
final class PlotGridCanvas: NSView, NSTextViewDelegate, NSMenuDelegate, NSMenuItemValidation {
    enum Target: Equatable {
        case cell(row: String, column: String)
        case row(String)
        case column(String)
    }
    enum Metrics {
        static let rowHeader: CGFloat = 104
        static let columnHeader: CGFloat = 28
        static let padding: CGFloat = 6
    }

    let model: PlotGridModel
    let editor = PlotCellEditor()
    private let editorScroll = NSScrollView()
    private(set) var grid: WorkspacePlotGrid
    private(set) var selection: Target?
    private(set) var editing: Target?
    /// A header being dragged: where it started and the gap it would drop at.
    private var headerDrag: (target: Target, start: NSPoint, gap: Int?)?
    var onFocus: (() -> Void)?
    var onAlert: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
    /// Copy and paste use the general pasteboard unless told otherwise.
    var pasteboard = NSPasteboard.general { didSet { editor.pasteboard = pasteboard } }

    init(model: PlotGridModel) {
        self.model = model
        grid = model.grid
        super.init(frame: .zero)
        setAccessibilityIdentifier("plot-grid-\(model.nodeID)")
        setAccessibilityLabel("情节规划格")
        editor.isRichText = false
        editor.allowsUndo = false
        editor.font = .systemFont(ofSize: 12)
        editor.textContainerInset = NSSize(width: 2, height: 3)
        editor.isVerticallyResizable = true
        editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = true
        editor.delegate = self
        editor.setAccessibilityIdentifier("plot-cell-editor")
        editor.onPasteBlock = { [weak self] text in self?.pasteIntoEditedCell(text) ?? false }
        editor.onResign = { [weak self] in self?.editorResigned() }
        editorScroll.documentView = editor
        editorScroll.hasVerticalScroller = true; editorScroll.autohidesScrollers = true
        editorScroll.borderType = .noBorder
        let menu = NSMenu()
        menu.delegate = self
        self.menu = menu
        layoutGrid()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func becomeFirstResponder() -> Bool { onFocus?(); return true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    // MARK: Showing

    /// Adopts the model's grid. A selection whose row or column is gone is
    /// dropped; an edit of a vanished row, column or cell is cancelled, any
    /// other edit keeps its text.
    func show(_ updated: WorkspacePlotGrid) {
        grid = updated
        if let selection, !exists(selection) { self.selection = nil }
        if let editing {
            if exists(editing) { editorScroll.frame = editorFrame(editing) } else { endEditor() }
        }
        layoutGrid()
    }

    private func layoutGrid() {
        let size = NSSize(width: Metrics.rowHeader + CGFloat(grid.columns.count) * CGFloat(grid.cellWidth) + 1,
                          height: Metrics.columnHeader + CGFloat(grid.rows.count) * CGFloat(grid.cellHeight) + 1)
        if frame.size != size { setFrameSize(size) }
        needsDisplay = true
    }

    func exists(_ target: Target) -> Bool {
        switch target {
        case .cell(let row, let column): return grid.index(.row, of: row) != nil && grid.index(.column, of: column) != nil
        case .row(let id): return grid.index(.row, of: id) != nil
        case .column(let id): return grid.index(.column, of: id) != nil
        }
    }

    func rect(of target: Target) -> NSRect {
        let width = CGFloat(grid.cellWidth), height = CGFloat(grid.cellHeight)
        switch target {
        case .cell(let row, let column):
            let r = grid.index(.row, of: row) ?? 0, c = grid.index(.column, of: column) ?? 0
            return NSRect(x: Metrics.rowHeader + CGFloat(c) * width, y: Metrics.columnHeader + CGFloat(r) * height, width: width, height: height)
        case .row(let id):
            let r = grid.index(.row, of: id) ?? 0
            return NSRect(x: 0, y: Metrics.columnHeader + CGFloat(r) * height, width: Metrics.rowHeader, height: height)
        case .column(let id):
            let c = grid.index(.column, of: id) ?? 0
            return NSRect(x: Metrics.rowHeader + CGFloat(c) * width, y: 0, width: width, height: Metrics.columnHeader)
        }
    }

    /// What lies under a point in this view's coordinates.
    func target(at point: NSPoint) -> Target? {
        let width = CGFloat(grid.cellWidth), height = CGFloat(grid.cellHeight)
        let column = point.x < Metrics.rowHeader ? nil : Int((point.x - Metrics.rowHeader) / width)
        let row = point.y < Metrics.columnHeader ? nil : Int((point.y - Metrics.columnHeader) / height)
        switch (row, column) {
        case (nil, nil): return nil
        case (nil, let c?): return grid.columns.indices.contains(c) ? .column(grid.columns[c].id) : nil
        case (let r?, nil): return grid.rows.indices.contains(r) ? .row(grid.rows[r].id) : nil
        case (let r?, let c?):
            guard grid.rows.indices.contains(r), grid.columns.indices.contains(c) else { return nil }
            return .cell(row: grid.rows[r].id, column: grid.columns[c].id)
        }
    }

    func text(of target: Target) -> String {
        switch target {
        case .cell(let row, let column): return grid.value(row: row, column: column)
        case .row(let id): return grid.label(.row, id) ?? ""
        case .column(let id): return grid.label(.column, id) ?? ""
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        let width = CGFloat(grid.cellWidth), height = CGFloat(grid.cellHeight)
        let contentWidth = Metrics.rowHeader + CGFloat(grid.columns.count) * width
        let contentHeight = Metrics.columnHeader + CGFloat(grid.rows.count) * height
        NSColor.textBackgroundColor.setFill()
        NSRect(x: 0, y: 0, width: contentWidth, height: contentHeight).fill()
        NSColor.windowBackgroundColor.setFill()
        NSRect(x: 0, y: 0, width: contentWidth, height: Metrics.columnHeader).fill()
        NSRect(x: 0, y: 0, width: Metrics.rowHeader, height: contentHeight).fill()
        if let selection {
            let wash = selection == editing ? NSColor.clear : NSColor.selectedContentBackgroundColor.withAlphaComponent(0.16)
            wash.setFill()
            rect(of: selection).fill()
        }
        NSColor.separatorColor.setFill()
        for index in 0...grid.columns.count {
            NSRect(x: Metrics.rowHeader + CGFloat(index) * width, y: 0, width: 1, height: contentHeight).fill()
        }
        for index in 0...grid.rows.count {
            NSRect(x: 0, y: Metrics.columnHeader + CGFloat(index) * height, width: contentWidth, height: 1).fill()
        }
        NSRect(x: 0, y: 0, width: contentWidth, height: 1).fill()
        NSRect(x: 0, y: 0, width: 1, height: contentHeight).fill()
        for (index, row) in grid.rows.enumerated() {
            drawText(row.label, placeholder: "行 \(index + 1)", in: rect(of: .row(row.id)), header: true)
        }
        for (index, column) in grid.columns.enumerated() {
            drawText(column.label, placeholder: "列 \(index + 1)", in: rect(of: .column(column.id)), header: true)
        }
        for cell in grid.cells where editing != .cell(row: cell.rowId, column: cell.columnId) {
            drawText(cell.value, placeholder: "", in: rect(of: .cell(row: cell.rowId, column: cell.columnId)), header: false)
        }
        if let selection, selection != editing {
            NSColor.keyboardFocusIndicatorColor.setStroke()
            let path = NSBezierPath(rect: rect(of: selection).insetBy(dx: 1, dy: 1))
            path.lineWidth = 2
            path.stroke()
        }
        if let drag = headerDrag, let gap = drag.gap {
            NSColor.controlAccentColor.setFill()
            switch drag.target {
            case .row: NSRect(x: 0, y: Metrics.columnHeader + CGFloat(gap) * height - 1, width: contentWidth, height: 3).fill()
            case .column: NSRect(x: Metrics.rowHeader + CGFloat(gap) * width - 1, y: 0, width: 3, height: contentHeight).fill()
            case .cell: break
            }
        }
    }

    private func drawText(_ text: String, placeholder: String, in rect: NSRect, header: Bool) {
        guard !(text.isEmpty && placeholder.isEmpty) else { return }
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = header ? .byTruncatingTail : .byWordWrapping
        let attributes: [NSAttributedString.Key: Any] = [
            .font: header ? NSFont.systemFont(ofSize: 12, weight: .medium) : NSFont.systemFont(ofSize: 12),
            .foregroundColor: text.isEmpty ? NSColor.placeholderTextColor : NSColor.labelColor,
            .paragraphStyle: style,
        ]
        let inset = rect.insetBy(dx: Metrics.padding, dy: header ? 6 : Metrics.padding)
        NSAttributedString(string: text.isEmpty ? placeholder : text, attributes: attributes)
            .draw(with: inset, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }

    // MARK: Selection and editing

    func select(_ target: Target?) {
        if let editing, editing != target { commitEditing() }
        selection = target
        if let target { scrollToVisible(rect(of: target)) }
        needsDisplay = true
    }

    private func editorFrame(_ target: Target) -> NSRect { rect(of: target).insetBy(dx: 1, dy: 1).offsetBy(dx: 0.5, dy: 0.5) }

    /// Opens the editor over a cell or header with its text (or `replacing`
    /// it), caret at the end. An edit elsewhere is committed first.
    func beginEditing(_ target: Target, replacing text: String? = nil) {
        guard model.loaded, exists(target) else { return }
        if let editing, editing != target { commitEditing() }
        selection = target
        editing = target
        editor.string = text ?? self.text(of: target)
        editorScroll.frame = editorFrame(target)
        if editorScroll.superview !== self { addSubview(editorScroll) }
        let content = editorScroll.contentSize
        editor.minSize = NSSize(width: 0, height: content.height)
        editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        editor.textContainer?.containerSize = NSSize(width: content.width, height: CGFloat.greatestFiniteMagnitude)
        editor.frame = NSRect(origin: .zero, size: content)
        scrollToVisible(rect(of: target))
        window?.makeFirstResponder(editor)
        editor.setSelectedRange(NSRange(location: (editor.string as NSString).length, length: 0))
        needsDisplay = true
    }

    /// Ends the edit and writes it as one gesture; unchanged text writes
    /// nothing. Returns whether a change was sent.
    @discardableResult
    func commitEditing() -> Bool {
        guard let target = editing else { return false }
        let typed = editor.string
        endEditor()
        switch target {
        case .cell(let row, let column): return model.perform([.setCell(row: row, column: column, value: typed)])
        case .row(let id): return model.perform([.setLabel(.row, id: id, label: ElementText.trimmed(typed))])
        case .column(let id): return model.perform([.setLabel(.column, id: id, label: ElementText.trimmed(typed))])
        }
    }

    /// Esc: the stored text stays and nothing is written.
    func cancelEditing() { endEditor() }

    private func endEditor() {
        guard editing != nil else { return }
        editing = nil
        let focused = window?.firstResponder === editor
        editorScroll.removeFromSuperview()
        if focused { window?.makeFirstResponder(self) }
        needsDisplay = true
    }

    /// Focus left the editor (a click elsewhere): the edit is committed.
    private func editorResigned() {
        guard let target = editing else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.editing == target, self.window?.firstResponder !== self.editor else { return }
            self.commitEditing()
        }
    }

    func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        guard let target = editing else { return false }
        switch selector {
        case #selector(NSResponder.insertNewline(_:)):
            commitEditing(); return true
        case #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)):
            // A new line inside a cell; headers are one line.
            if case .cell = target { return false }
            commitEditing(); return true
        case #selector(NSResponder.insertTab(_:)):
            commitEditing(); move(.next, from: target, edit: true); return true
        case #selector(NSResponder.insertBacktab(_:)):
            commitEditing(); move(.previous, from: target, edit: true); return true
        case #selector(NSResponder.cancelOperation(_:)):
            cancelEditing(); return true
        default: return false
        }
    }

    private enum Step { case up, down, left, right, next, previous }

    /// The neighbour of a cell (Tab and ⇧Tab wrap to the next or previous
    /// row), of a header along its axis, or nil at the edge.
    private func neighbour(_ step: Step, of target: Target) -> Target? {
        switch target {
        case .cell(let row, let column):
            guard var r = grid.index(.row, of: row), var c = grid.index(.column, of: column) else { return nil }
            switch step {
            case .up: if r == 0 { return .column(column) }; r -= 1
            case .down: r += 1
            case .left: if c == 0 { return .row(row) }; c -= 1
            case .right: c += 1
            case .next:
                c += 1
                if c == grid.columns.count { c = 0; r += 1 }
            case .previous:
                c -= 1
                if c < 0 { c = grid.columns.count - 1; r -= 1 }
            }
            guard grid.rows.indices.contains(r), grid.columns.indices.contains(c) else { return nil }
            return .cell(row: grid.rows[r].id, column: grid.columns[c].id)
        case .row(let id):
            guard let r = grid.index(.row, of: id) else { return nil }
            switch step {
            case .up, .previous: return r > 0 ? .row(grid.rows[r - 1].id) : nil
            case .down, .next: return r + 1 < grid.rows.count ? .row(grid.rows[r + 1].id) : nil
            case .right: return grid.columns.first.map { .cell(row: id, column: $0.id) }
            case .left: return nil
            }
        case .column(let id):
            guard let c = grid.index(.column, of: id) else { return nil }
            switch step {
            case .left, .previous: return c > 0 ? .column(grid.columns[c - 1].id) : nil
            case .right, .next: return c + 1 < grid.columns.count ? .column(grid.columns[c + 1].id) : nil
            case .down: return grid.rows.first.map { .cell(row: $0.id, column: id) }
            case .up: return nil
            }
        }
    }

    private func move(_ step: Step, from target: Target, edit: Bool) {
        guard let next = neighbour(step, of: target) else { select(target); return }
        if edit { beginEditing(next) } else { select(next) }
    }

    /// The first cell when nothing is selected.
    private var current: Target? {
        selection ?? grid.rows.first.flatMap { row in grid.columns.first.map { .cell(row: row.id, column: $0.id) } }
    }

    // MARK: Keyboard

    override func keyDown(with event: NSEvent) {
        let shift = event.modifierFlags.contains(.shift)
        let commandLike = !event.modifierFlags.intersection([.command, .control, .option]).isEmpty
        switch Int(event.keyCode) {
        case 126: moveSelection(.up)
        case 125: moveSelection(.down)
        case 123: moveSelection(.left)
        case 124: moveSelection(.right)
        case 48: moveSelection(shift ? .previous : .next)
        case 36, 76: if let current { beginEditing(current) }
        case 53: select(nil)
        case 51, 117: clearSelectedCell()
        default:
            // Typing on a cell starts editing it with what was typed.
            if !commandLike, let characters = event.characters, !characters.isEmpty,
               characters.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) && $0.value < 0xF700 }),
               case .cell? = current, let current {
                beginEditing(current, replacing: "")
                editor.insertText(characters, replacementRange: editor.selectedRange())
            } else {
                super.keyDown(with: event)
            }
        }
    }

    private func moveSelection(_ step: Step) {
        guard let current else { return }
        guard selection != nil else { select(current); return }
        move(step, from: current, edit: false)
    }

    private func clearSelectedCell() {
        guard case .cell(let row, let column)? = selection else { return }
        model.perform([.setCell(row: row, column: column, value: "")])
    }

    // MARK: Copy and paste

    @objc func copy(_ sender: Any?) {
        guard let selection else { return }
        pasteboard.clearContents()
        pasteboard.setString(text(of: selection), forType: .string)
    }

    /// ⌘V on the grid: a block fills cells from the selected one (the
    /// first cell of a selected row or column header).
    @objc func paste(_ sender: Any?) {
        guard let text = pasteboard.string(forType: .string), let anchor = pasteAnchor else { return }
        pasteBlock(text, row: anchor.row, column: anchor.column)
    }

    private var pasteAnchor: (row: String, column: String)? {
        switch current {
        case .cell(let row, let column)?: return (row, column)
        case .row(let id)?: return grid.columns.first.map { (id, $0.id) }
        case .column(let id)?: return grid.rows.first.map { ($0.id, id) }
        case nil: return nil
        }
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(paste(_:)) { return pasteAnchor != nil && pasteboard.string(forType: .string) != nil }
        if item.action == #selector(copy(_:)) { return selection != nil }
        return true
    }

    private func pasteIntoEditedCell(_ text: String) -> Bool {
        guard case .cell(let row, let column)? = editing else { return false }
        cancelEditing()
        pasteBlock(text, row: row, column: column)
        return true
    }

    /// Tab-separated columns and line-separated rows, from a cell onward:
    /// rows and columns are added at the end as needed, and everything is
    /// one gesture. Returns whether anything changed.
    @discardableResult
    func pasteBlock(_ text: String, row: String, column: String) -> Bool {
        guard let startRow = grid.index(.row, of: row), let startColumn = grid.index(.column, of: column) else { return false }
        var lines = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
        if lines.count > 1, lines.last == "" { lines.removeLast() }
        let matrix = lines.map { $0.components(separatedBy: "\t") }
        let widest = matrix.map(\.count).max() ?? 0
        var rows = grid.rows.map(\.id), columns = grid.columns.map(\.id), ops: [PlotGridOp] = []
        while rows.count < startRow + matrix.count {
            let id = WorkspacePlotGrid.newID(.row)
            ops.append(.addAxis(.row, id: id, label: "", after: rows.last)); rows.append(id)
        }
        while columns.count < startColumn + widest {
            let id = WorkspacePlotGrid.newID(.column)
            ops.append(.addAxis(.column, id: id, label: "", after: columns.last)); columns.append(id)
        }
        for (dr, line) in matrix.enumerated() {
            for (dc, value) in line.enumerated() {
                ops.append(.setCell(row: rows[startRow + dr], column: columns[startColumn + dc], value: value))
            }
        }
        let changed = model.perform(ops)
        select(.cell(row: row, column: column))
        return changed
    }

    // MARK: Rows and columns

    /// 添加行 / 添加列: after the selected row or column, else at the end;
    /// the new header is then edited.
    func addAxis(_ axis: PlotGridAxis) {
        let selected: String?
        switch (axis, selection) {
        case (.row, .cell(let row, _)?), (.row, .row(let row)?): selected = row
        case (.column, .cell(_, let column)?), (.column, .column(let column)?): selected = column
        default: selected = nil
        }
        insert(axis, after: selected ?? grid.axes(axis).last?.id)
    }

    /// 在上方插入一行 / 在左侧插入一列 and the like.
    func insert(_ axis: PlotGridAxis, beside id: String, before: Bool) {
        guard let index = grid.index(axis, of: id) else { return }
        insert(axis, after: before ? (index > 0 ? grid.axes(axis)[index - 1].id : nil) : id)
    }

    private func insert(_ axis: PlotGridAxis, after: String?) {
        if editing != nil { commitEditing() }
        let id = WorkspacePlotGrid.newID(axis)
        guard model.perform([.addAxis(axis, id: id, label: "", after: after)]) else { return }
        beginEditing(axis == .row ? .row(id) : .column(id))
    }

    /// 上移 / 下移 / 左移 / 右移 by one place.
    func move(_ axis: PlotGridAxis, _ id: String, by delta: Int) {
        let ids = grid.axes(axis).map(\.id)
        guard let from = ids.firstIndex(of: id), ids.indices.contains(from + delta) else { return }
        moveAxis(axis, id, toGap: delta > 0 ? from + 2 : from - 1)
    }

    /// Moves a row or column to the gap before position `gap` (0 is first,
    /// `count` is last); its own place writes nothing.
    func moveAxis(_ axis: PlotGridAxis, _ id: String, toGap gap: Int) {
        let ids = grid.axes(axis).map(\.id)
        guard let from = ids.firstIndex(of: id), gap != from, gap != from + 1, (0...ids.count).contains(gap) else { return }
        model.perform([.moveAxis(axis, id: id, after: gap == 0 ? nil : ids[gap - 1])])
    }

    /// 删除此行… / 删除此列…: asks first when it holds text. The last row or
    /// column stays.
    func remove(_ axis: PlotGridAxis, _ id: String) {
        guard grid.axes(axis).count > 1, let index = grid.index(axis, of: id) else { return }
        let filled = grid.filledCells(axis, id)
        guard filled > 0 else { removeNow(axis, id); return }
        let label = grid.label(axis, id).flatMap { $0.isEmpty ? nil : "“\($0)”" } ?? "第 \(index + 1) \(axis.name)"
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "删除这一\(axis.name)？"
        alert.informativeText = "\(label)有 \(filled) 格文字，删除后这些文字也会删除。正文不受影响。"
        alert.addButton(withTitle: "删除").setAccessibilityIdentifier("confirm-plot-remove")
        alert.addButton(withTitle: "取消")
        let done: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            self?.removeNow(axis, id)
        }
        if let onAlert { onAlert(alert, done) } else if let window { alert.beginSheetModal(for: window, completionHandler: done) }
    }

    private func removeNow(_ axis: PlotGridAxis, _ id: String) {
        if let editing, editing != .row(id), editing != .column(id) { commitEditing() } else { cancelEditing() }
        model.perform([.removeAxis(axis, id: id)])
    }

    // MARK: Mouse

    private func point(_ event: NSEvent) -> NSPoint { convert(event.locationInWindow, from: nil) }

    override func mouseDown(with event: NSEvent) {
        if window?.firstResponder !== self, editing == nil { window?.makeFirstResponder(self) }
        let point = point(event)
        guard let target = target(at: point) else { select(nil); return }
        switch target {
        case .cell:
            beginEditing(target)
        case .row, .column:
            if event.clickCount >= 2 { beginEditing(target); return }
            select(target)
            if window?.firstResponder !== self { window?.makeFirstResponder(self) }
            headerDrag = (target, point, nil)
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard var drag = headerDrag else { return }
        let point = point(event)
        guard abs(point.x - drag.start.x) > 3 || abs(point.y - drag.start.y) > 3 || drag.gap != nil else { return }
        switch drag.target {
        case .row: drag.gap = min(max(Int(((point.y - Metrics.columnHeader) / CGFloat(grid.cellHeight)).rounded()), 0), grid.rows.count)
        case .column: drag.gap = min(max(Int(((point.x - Metrics.rowHeader) / CGFloat(grid.cellWidth)).rounded()), 0), grid.columns.count)
        case .cell: return
        }
        headerDrag = drag
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        guard let drag = headerDrag else { return }
        headerDrag = nil
        needsDisplay = true
        guard let gap = drag.gap else { return }
        switch drag.target {
        case .row(let id): moveAxis(.row, id, toGap: gap)
        case .column(let id): moveAxis(.column, id, toGap: gap)
        case .cell: break
        }
    }

    // MARK: Menus

    private var menuTarget: Target?

    override func menu(for event: NSEvent) -> NSMenu? {
        menuTarget = target(at: point(event))
        if let menuTarget { select(menuTarget) }
        return super.menu(for: event)
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        guard let menuTarget else { return }
        for item in menuItems(for: menuTarget) { menu.addItem(item) }
    }

    /// A cell's or header's context actions, also used by acceptance.
    func menuItems(for target: Target) -> [NSMenuItem] {
        switch target {
        case .cell(let row, let column):
            let edit = LibraryMenuItem(title: "编辑", identifier: "plot-cell-edit") { [weak self] in self?.beginEditing(target) }
            let clear = LibraryMenuItem(title: "清空", identifier: "plot-cell-clear") { [weak self] in
                self?.model.perform([.setCell(row: row, column: column, value: "")])
            }
            clear.isEnabled = !grid.value(row: row, column: column).isEmpty
            return [edit, clear]
        case .row(let id): return axisItems(.row, id)
        case .column(let id): return axisItems(.column, id)
        }
    }

    private func axisItems(_ axis: PlotGridAxis, _ id: String) -> [NSMenuItem] {
        let prefix = axis == .row ? "plot-row" : "plot-column"
        let index = grid.index(axis, of: id) ?? 0, count = grid.axes(axis).count
        let target: Target = axis == .row ? .row(id) : .column(id)
        let rename = LibraryMenuItem(title: "重命名", identifier: "\(prefix)-rename") { [weak self] in self?.beginEditing(target) }
        let back = LibraryMenuItem(title: axis == .row ? "上移" : "左移", identifier: "\(prefix)-move-back") { [weak self] in
            self?.move(axis, id, by: -1)
        }
        back.isEnabled = index > 0
        let forward = LibraryMenuItem(title: axis == .row ? "下移" : "右移", identifier: "\(prefix)-move-forward") { [weak self] in
            self?.move(axis, id, by: 1)
        }
        forward.isEnabled = index + 1 < count
        let before = LibraryMenuItem(title: axis == .row ? "在上方插入一行" : "在左侧插入一列", identifier: "\(prefix)-insert-before") { [weak self] in
            self?.insert(axis, beside: id, before: true)
        }
        let after = LibraryMenuItem(title: axis == .row ? "在下方插入一行" : "在右侧插入一列", identifier: "\(prefix)-insert-after") { [weak self] in
            self?.insert(axis, beside: id, before: false)
        }
        let filled = grid.filledCells(axis, id)
        let delete = LibraryMenuItem(title: "删除此\(axis.name)\(filled > 0 ? "…" : "")", identifier: "\(prefix)-delete") { [weak self] in
            self?.remove(axis, id)
        }
        delete.isEnabled = count > 1
        if count <= 1 { delete.toolTip = "至少保留一行一列" }
        return [rename, .separator(), back, forward, .separator(), before, after, .separator(), delete]
    }
}

/// 情节规划格 in a chapter's or drift's page header: on while the dock shows.
final class PlotPlannerToggle: NSButton {
    var onToggle: (() -> Void)?

    init() {
        super.init(frame: .zero)
        title = "情节规划格"
        setButtonType(.pushOnPushOff)
        bezelStyle = .rounded
        controlSize = .small
        font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        toolTip = "在正文下方显示或隐藏这一页的情节规划格（⌥⌘G）"
        setAccessibilityIdentifier("toggle-plot-planner")
        target = self; action = #selector(pressed)
        setContentHuggingPriority(.required, for: .horizontal)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    @objc private func pressed() {
        // The host decides; the state follows the dock.
        state = state == .on ? .off : .on
        onToggle?()
    }

    /// Puts `dock` at the end of a page's stack in place of `current`.
    static func place(_ dock: MacPlotPlannerDock?, replacing current: MacPlotPlannerDock?, in stack: NSStackView) -> MacPlotPlannerDock? {
        if let current, current !== dock {
            // A cell being edited was committed by whoever hid the dock.
            current.canvas.cancelEditing()
            stack.removeArrangedSubview(current)
            current.removeFromSuperview()
        }
        guard let dock else { return nil }
        if dock.superview !== stack {
            stack.addArrangedSubview(dock)
            dock.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        return dock
    }
}
