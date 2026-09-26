import AppKit

final class ProseTextView: NSTextView {
    var onFocus: (() -> Void)?
    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { onFocus?() }
        return accepted
    }
    var canPerformHistory: ((Bool) -> Bool)?
    var performHistory: ((Bool) -> Void)?
    var canPerformFormat: ((NativeFormatAction) -> Bool)?
    var performFormat: ((NativeFormatAction) -> Void)?

    // Standard responder actions also cover text-system key bindings. Never
    // let NSTextView's independent undo stack replay a CRDT-owned operation.
    @objc func undo(_ sender: Any?) {
        guard canPerformHistory?(false) == true else { return }
        performHistory?(false)
    }
    @objc func redo(_ sender: Any?) {
        guard canPerformHistory?(true) == true else { return }
        performHistory?(true)
    }
    @objc func boldProse(_ sender: Any?) {
        guard canPerformFormat?(.bold) == true else { return }
        performFormat?(.bold)
    }
    @objc func italicProse(_ sender: Any?) {
        guard canPerformFormat?(.italic) == true else { return }
        performFormat?(.italic)
    }
    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(undo(_:)) { return canPerformHistory?(false) == true }
        if item.action == #selector(redo(_:)) { return canPerformHistory?(true) == true }
        if item.action == #selector(boldProse(_:)) { return canPerformFormat?(.bold) == true }
        if item.action == #selector(italicProse(_:)) { return canPerformFormat?(.italic) == true }
        return super.validateUserInterfaceItem(item)
    }
    override func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(undo(_:)) { return canPerformHistory?(false) == true }
        if item.action == #selector(redo(_:)) { return canPerformHistory?(true) == true }
        if item.action == #selector(boldProse(_:)) { return canPerformFormat?(.bold) == true }
        if item.action == #selector(italicProse(_:)) { return canPerformFormat?(.italic) == true }
        return super.validateMenuItem(item)
    }
}

final class NativeDocumentView: NSView, NSTextViewDelegate {
    let binding: DocumentBinding
    let textView = ProseTextView()
    private let status = NSTextField(wrappingLabelWithString: "正在打开正文…")
    private let comments = NSTextField(wrappingLabelWithString: "")
    private let undoButton = NSButton(title: "撤销", target: nil, action: nil)
    private let redoButton = NSButton(title: "重做", target: nil, action: nil)
    private let retryButton = NSButton(title: "重试保存", target: nil, action: nil)
    private let discardButton = NSButton(title: "放弃窗口草稿", target: nil, action: nil)
    private let boldButton = NSButton(title: "加粗", target: nil, action: nil)
    private let italicButton = NSButton(title: "斜体", target: nil, action: nil)
    private let blockMenu = NSPopUpButton(frame: .zero, pullsDown: false)
    private var rendering = false
    private var styledProjection: NativeProjection?
    private(set) var lastStyleUpdate = DocumentStyle.Update.full
    var onStyleUpdate: ((DocumentStyle.Update) -> Void)?
    var onActivity: ((Bool) -> Void)?
    var onFocus: (() -> Void)?
    var isInteractionLocked = false {
        didSet {
            updateEditability()
            updateActions()
        }
    }

    init(core: LabCore) {
        binding = DocumentBinding(core: core)
        super.init(frame: .zero)
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        textView.isRichText = false
        textView.allowsUndo = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isEditable = false
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainerInset = NSSize(width: 20, height: 20)
        textView.setAccessibilityIdentifier("document-text")
        textView.setAccessibilityLabel("正文")
        textView.delegate = self
        textView.onFocus = { [weak self] in self?.onFocus?() }
        textView.canPerformHistory = { [weak self] in self?.canPerformHistory(redo: $0) == true }
        textView.performHistory = { [weak self] in self?.performHistory(redo: $0) }
        textView.canPerformFormat = { [weak self] in self?.canPerformFormat($0) == true }
        textView.performFormat = { [weak self] in self?.performFormat($0) }
        scroll.documentView = textView
        undoButton.target = self; undoButton.action = #selector(undoProse)
        redoButton.target = self; redoButton.action = #selector(redoProse)
        undoButton.setAccessibilityIdentifier("undo-prose")
        redoButton.setAccessibilityIdentifier("redo-prose")
        retryButton.target = self; retryButton.action = #selector(retrySave)
        discardButton.target = self; discardButton.action = #selector(discardDraft); discardButton.isHidden = true
        discardButton.setAccessibilityIdentifier("discard-prose-draft")
        boldButton.target = self; boldButton.action = #selector(boldProse)
        italicButton.target = self; italicButton.action = #selector(italicProse)
        boldButton.setAccessibilityIdentifier("format-bold")
        italicButton.setAccessibilityIdentifier("format-italic")
        blockMenu.addItems(withTitles: NativeFormatAction.blocks.map(\.title))
        blockMenu.setAccessibilityIdentifier("format-block")
        blockMenu.setAccessibilityLabel("段落样式")
        for (index, action) in NativeFormatAction.blocks.enumerated() {
            blockMenu.item(at: index)?.setAccessibilityIdentifier(action.accessibilityID)
        }
        blockMenu.target = self; blockMenu.action = #selector(formatBlock)
        let toolbar = NSStackView(views: [undoButton, redoButton, retryButton, discardButton])
        toolbar.spacing = 8
        let formats = NSStackView(views: [boldButton, italicButton, blockMenu])
        formats.spacing = 8
        status.textColor = .secondaryLabelColor
        status.setAccessibilityIdentifier("document-status")
        comments.textColor = .secondaryLabelColor
        comments.setAccessibilityIdentifier("document-comments")
        let stack = NSStackView(views: [toolbar, formats, scroll, comments, status])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor), status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            comments.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 220),
        ])
        binding.onProjection = { [weak self] in self?.render($0, changes: $1) }
        binding.onStatus = { [weak self] in self?.status.stringValue = $0 }
        binding.onActivity = { [weak self] busy in
            guard let self else { return }
            self.updateEditability()
            self.updateActions()
            self.onActivity?(busy)
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    @discardableResult
    func reveal(blockId: String) -> Bool {
        guard !isInteractionLocked, binding.canEdit, !binding.hasPendingWork, !textView.hasMarkedText(),
              let projection = binding.store.projection,
              let item = projection.outline.first(where: { $0.blockId == blockId }) else { return false }
        // Resolve the identity again here; a panel's earlier range may be stale.
        let range = NSRange(location: item.range.location, length: 0)
        textView.setSelectedRange(range)
        binding.selectionChanged(range, text: projection.text, marked: false)
        textView.scrollRangeToVisible(item.range.nsRange)
        window?.makeFirstResponder(textView)
        return true
    }

    private func render(_ projection: NativeProjection, changes: [NativeTextChange]) {
        guard !textView.hasMarkedText() else { styledProjection = nil; return }
        rendering = true
        var selection = textView.selectedRange()
        let scroll = textView.enclosingScrollView?.contentView.bounds.origin
        let replacedText = !NativeText.identical(textView.string, projection.text)
        if replacedText {
            for change in changes { selection = change.mapSelection(selection) }
            textView.string = projection.text
        }
        if let storage = textView.textStorage {
            lastStyleUpdate = DocumentStyle.update(projection, previous: replacedText ? nil : styledProjection,
                localChange: changes.count == 1 ? changes[0] : nil, to: storage)
            styledProjection = projection
            onStyleUpdate?(lastStyleUpdate)
        }
        comments.stringValue = projection.comments.map(\.summary).joined(separator: "\n")
        if let anchored = binding.resolvedSelection(in: projection) { selection = anchored }
        let length = (projection.text as NSString).length
        let start = min(selection.location, length)
        textView.setSelectedRange(NSRange(location: start, length: min(selection.length, length - start)))
        binding.displayedSelection(textView.selectedRange())
        if let scroll { textView.enclosingScrollView?.contentView.scroll(to: scroll) }
        updateEditability()
        rendering = false
        updateFormatControls()
    }
    func textView(_ textView: NSTextView, shouldChangeTextIn affectedCharRange: NSRange, replacementString: String?) -> Bool {
        guard !isInteractionLocked, let replacementString else { return false }
        return binding.prepareInput(affectedCharRange, replacement: replacementString, marked: textView.hasMarkedText())
    }
    func textDidChange(_ notification: Notification) {
        guard !rendering else { return }
        let text = textView.string, marked = textView.hasMarkedText()
        if marked { styledProjection = nil }
        binding.selectionChanged(textView.selectedRange(), text: text, marked: marked)
        binding.changed(text, marked: marked)
    }
    func textViewDidChangeSelection(_ notification: Notification) {
        guard !rendering else { return }
        let text = textView.string, marked = textView.hasMarkedText()
        if marked { styledProjection = nil }
        binding.selectionChanged(textView.selectedRange(), text: text, marked: marked)
        binding.changed(text, marked: marked)
    }
    private func canPerformHistory(redo: Bool) -> Bool {
        guard !isInteractionLocked, binding.canEdit, !binding.hasPendingWork, !textView.hasMarkedText(),
              let projection = binding.state?.projection else { return false }
        return redo ? projection.canRedo : projection.canUndo
    }
    private func performHistory(redo: Bool) {
        guard canPerformHistory(redo: redo) else { return }
        focus()
        binding.history(redo: redo)
    }
    private func canPerformFormat(_ action: NativeFormatAction) -> Bool {
        !isInteractionLocked && !textView.hasMarkedText() && binding.canFormat(action, range: textView.selectedRange())
    }
    private func updateActions() {
        undoButton.isEnabled = canPerformHistory(redo: false)
        redoButton.isEnabled = canPerformHistory(redo: true)
        updateFormatControls()
        discardButton.isHidden = !binding.hasFailedDraft
        discardButton.isEnabled = !isInteractionLocked && !binding.hasRemoteBlock
        retryButton.isEnabled = !isInteractionLocked
        retryButton.title = binding.hasRemoteBlock ? "重试应用" : "重试保存"
    }
    private func updateEditability() {
        // AppKit cancels marked text when isEditable becomes false. A retained
        // remote block must preserve that native draft; input delegates still
        // consult the binding/interaction guards before any prose submission.
        guard !textView.hasMarkedText() else { return }
        textView.isEditable = !isInteractionLocked && binding.canEdit
    }
    private func focus() { onFocus?(); window?.makeFirstResponder(textView) }
    private func updateFormatControls() {
        boldButton.isEnabled = canPerformFormat(.bold)
        italicButton.isEnabled = canPerformFormat(.italic)
        blockMenu.isEnabled = canPerformFormat(.paragraph)
        if let action = binding.blockFormat(at: textView.selectedRange()) {
            blockMenu.selectItem(withTitle: action.title)
        } else {
            blockMenu.select(nil)
            blockMenu.title = "段落样式"
        }
    }
    private func performFormat(_ action: NativeFormatAction) {
        guard canPerformFormat(action) else { return }
        let range = textView.selectedRange()
        focus()
        binding.format(action, range: range)
    }
    @objc private func boldProse() { performFormat(.bold) }
    @objc private func italicProse() { performFormat(.italic) }
    @objc private func formatBlock() {
        guard NativeFormatAction.blocks.indices.contains(blockMenu.indexOfSelectedItem) else { return }
        performFormat(NativeFormatAction.blocks[blockMenu.indexOfSelectedItem])
    }
    @objc func undoProse() { performHistory(redo: false) }
    @objc func redoProse() { performHistory(redo: true) }
    @objc private func retrySave() { guard !isInteractionLocked else { return }; focus(); binding.retrySave() }
    @objc private func discardDraft() { guard !isInteractionLocked else { return }; focus(); binding.discardDraft() }
}
