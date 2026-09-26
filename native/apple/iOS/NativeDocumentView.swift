import UIKit

private final class ProseUndoManager: UndoManager {
    var canPerformHistory: ((Bool) -> Bool)?
    var performHistory: ((Bool) -> Void)?
    override init() {
        super.init()
        super.disableUndoRegistration()
    }
    override var canUndo: Bool { canPerformHistory?(false) == true }
    override var canRedo: Bool { canPerformHistory?(true) == true }
    override var isUndoRegistrationEnabled: Bool { false }
    override func enableUndoRegistration() {}
    override func disableUndoRegistration() {}
    override func removeAllActions() {}
    override func undo() { if canUndo { performHistory?(false) } }
    override func redo() { if canRedo { performHistory?(true) } }
    override func undoNestedGroup() { undo() }
}

private final class ProseTextView: UITextView {
    // UIKit's gestures and command system get the CRDT history owner through
    // this adapter. Registration stays disabled; there is no second text stack.
    let history = ProseUndoManager()
    override var undoManager: UndoManager? { history }
    override var keyCommands: [UIKeyCommand]? {
        let undo = UIKeyCommand(title: "撤销", action: #selector(undo(_:)), input: "z", modifierFlags: .command)
        let redo = UIKeyCommand(title: "重做", action: #selector(redo(_:)), input: "z", modifierFlags: [.command, .shift])
        undo.wantsPriorityOverSystemBehavior = true; redo.wantsPriorityOverSystemBehavior = true
        return [undo, redo] + (super.keyCommands ?? [])
    }
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(undo(_:)) { return history.canUndo }
        if action == #selector(redo(_:)) { return history.canRedo }
        return super.canPerformAction(action, withSender: sender)
    }
    @objc func undo(_ sender: Any?) { history.undo() }
    @objc func redo(_ sender: Any?) { history.redo() }
    var allowsDelete: ((NSRange, Bool) -> Bool)?
    var prepareReplacement: ((NSRange, String, Bool) -> Bool)?
    var onInputCompleted: (() -> Void)?
    var onRejectedInput: (() -> Void)?
    private var inputDepth = 0
    var isPerformingInput: Bool { inputDepth > 0 }

    private func nativeRange(_ range: UITextRange) -> NSRange {
        NSRange(location: offset(from: beginningOfDocument, to: range.start),
            length: offset(from: range.start, to: range.end))
    }
    private var replacementRange: NSRange { markedTextRange.map(nativeRange) ?? selectedRange }
    private func beginReplacement(_ range: NSRange, text: String) -> Bool {
        if inputDepth == 0 && prepareReplacement?(range, text, markedTextRange != nil) == false { return false }
        inputDepth += 1
        return true
    }
    private func endReplacement() {
        inputDepth -= 1
        if inputDepth == 0 { onInputCompleted?() }
    }
    // UITextInput entry points do not consistently invoke shouldChangeTextIn.
    // Capture their exact range before UIKit moves the selection, and publish
    // only the final state after nested text/selection notifications finish.
    override func insertText(_ text: String) {
        guard beginReplacement(replacementRange, text: text) else { return }
        super.insertText(text)
        endReplacement()
    }
    override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
        guard beginReplacement(replacementRange, text: markedText ?? "") else { return }
        super.setMarkedText(markedText, selectedRange: selectedRange)
        endReplacement()
    }
    override func replace(_ range: UITextRange, withText text: String) {
        guard beginReplacement(nativeRange(range), text: text) else { return }
        super.replace(range, withText: text)
        endReplacement()
    }

    override func deleteBackward() {
        guard inputDepth == 0 else { super.deleteBackward(); return }
        let before = (text ?? "") as NSString
        let selection = selectedRange, marked = markedTextRange != nil
        guard selection.location != NSNotFound, NSMaxRange(selection) <= before.length else { return }
        // Permission checks use the largest grapheme deletion UIKit may make.
        // Actual deletion identity comes from UIKit's result and pre-input caret,
        // since deleteBackward need not call shouldChangeTextIn on every path.
        let permission = selection.length > 0 ? selection : selection.location == 0 ? selection
            : before.rangeOfComposedCharacterSequence(at: selection.location - 1)
        guard allowsDelete?(permission, marked) != false else { return }
        inputDepth += 1
        super.deleteBackward()
        inputDepth -= 1
        let after = text ?? "", removed = before.length - (after as NSString).length
        let actual = selection.length > 0 ? selection
            : NSRange(location: max(0, selection.location - removed), length: max(0, removed))
        if removed >= 0 && NSMaxRange(actual) <= before.length
            && NativeText.identical(before.replacingCharacters(in: actual, with: ""), after) {
            if removed > 0 && prepareReplacement?(actual, "", marked) == false {
                onRejectedInput?(); return
            }
            onInputCompleted?()
        } else {
            // Preserve unexpected system replacements instead of inferring a
            // deletion from equal repeated characters elsewhere in the document.
            onRejectedInput?()
        }
    }

    override func unmarkText() {
        inputDepth += 1
        super.unmarkText()
        inputDepth -= 1
        if inputDepth == 0 { onInputCompleted?() }
    }

    override func resignFirstResponder() -> Bool {
        inputDepth += 1
        let resigned = super.resignFirstResponder()
        if resigned && markedTextRange != nil { unmarkText() }
        inputDepth -= 1
        if inputDepth == 0 { onInputCompleted?() }
        return resigned
    }
}

final class NativeDocumentView: UIView, UITextViewDelegate {
    let binding: DocumentBinding
    private let textView = ProseTextView()
    private let status = UILabel()
    private let comments = UILabel()
    private let undoButton = UIButton(type: .system)
    private let redoButton = UIButton(type: .system)
    private let retryButton = UIButton(type: .system)
    private let discardButton = UIButton(type: .system)
    private let boldButton = UIButton(type: .system)
    private let italicButton = UIButton(type: .system)
    private let blockButton = UIButton(type: .system)
    private var displayedBlockFormat: NativeFormatAction?
    // A second binding can already adopt the shared document before the view
    // installs its projection callback. UIKit setup (including isEditable)
    // may resign its still-empty text view; that is not a user prose deletion.
    // The first projection render ends this initial callback suppression.
    private var rendering = true
    var onActivity: ((Bool) -> Void)?

    init(core: LabCore) {
        binding = DocumentBinding(core: core)
        super.init(frame: .zero)
        textView.delegate = self
        textView.history.canPerformHistory = { [weak self] in self?.canPerformHistory(redo: $0) == true }
        textView.history.performHistory = { [weak self] in self?.performHistory(redo: $0) }
        textView.allowsDelete = { [weak self] range, marked in
            self?.binding.allows(range, replacement: "", marked: marked) ?? false
        }
        textView.prepareReplacement = { [weak self] range, text, marked in
            self?.binding.prepareInput(range, replacement: text, marked: marked) ?? false
        }
        textView.onInputCompleted = { [weak self] in
            guard let self else { return }
            self.textViewDidChange(self.textView)
        }
        textView.onRejectedInput = { [weak self] in
            self?.binding.rejectInput("系统删除范围发生变化")
        }
        textView.isEditable = false
        textView.accessibilityIdentifier = "document-text"
        textView.accessibilityLabel = "正文"
        textView.backgroundColor = .secondarySystemBackground
        textView.layer.cornerRadius = 8
        textView.textContainerInset = UIEdgeInsets(top: 16, left: 12, bottom: 16, right: 12)
        textView.smartQuotesType = .no; textView.smartDashesType = .no
        textView.autocorrectionType = .no
        undoButton.setTitle("撤销", for: .normal); undoButton.addTarget(self, action: #selector(undoProse), for: .touchUpInside)
        redoButton.setTitle("重做", for: .normal); redoButton.addTarget(self, action: #selector(redoProse), for: .touchUpInside)
        undoButton.accessibilityIdentifier = "undo-prose"; redoButton.accessibilityIdentifier = "redo-prose"
        let done = UIButton(type: .system)
        done.setTitle("完成", for: .normal); done.addTarget(self, action: #selector(finishEditing), for: .touchUpInside)
        done.accessibilityIdentifier = "finish-prose"
        retryButton.setTitle("重试保存", for: .normal); retryButton.addTarget(self, action: #selector(retrySave), for: .touchUpInside)
        discardButton.setTitle("放弃窗口草稿", for: .normal); discardButton.isHidden = true
        discardButton.addTarget(self, action: #selector(discardDraft), for: .touchUpInside)
        discardButton.accessibilityIdentifier = "discard-prose-draft"
        let toolbar = UIStackView(arrangedSubviews: [undoButton, redoButton, retryButton, done])
        toolbar.distribution = .equalSpacing
        boldButton.setTitle("加粗", for: .normal); boldButton.addTarget(self, action: #selector(boldProse), for: .touchUpInside)
        italicButton.setTitle("斜体", for: .normal); italicButton.addTarget(self, action: #selector(italicProse), for: .touchUpInside)
        boldButton.accessibilityIdentifier = "format-bold"; italicButton.accessibilityIdentifier = "format-italic"
        blockButton.accessibilityIdentifier = "format-block"
        blockButton.showsMenuAsPrimaryAction = true
        let formatToolbar = UIStackView(arrangedSubviews: [boldButton, italicButton, blockButton])
        formatToolbar.distribution = .fillEqually
        status.text = "正在打开正文…"; status.numberOfLines = 0
        status.font = .preferredFont(forTextStyle: .footnote); status.textColor = .secondaryLabel
        status.accessibilityIdentifier = "document-status"
        comments.numberOfLines = 0; comments.font = .preferredFont(forTextStyle: .footnote)
        comments.textColor = .secondaryLabel; comments.accessibilityIdentifier = "document-comments"
        let stack = UIStackView(arrangedSubviews: [toolbar, formatToolbar, textView, comments, status, discardButton])
        stack.axis = .vertical; stack.spacing = 8; stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            toolbar.heightAnchor.constraint(equalToConstant: 44), formatToolbar.heightAnchor.constraint(equalToConstant: 36),
            textView.heightAnchor.constraint(greaterThanOrEqualToConstant: 100),
        ])
        binding.onProjection = { [weak self] in self?.render($0, changes: $1) }
        binding.onStatus = { [weak self] in self?.status.text = $0 }
        binding.onActivity = { [weak self] busy in
            guard let self else { return }
            self.undoButton.isEnabled = self.canPerformHistory(redo: false)
            self.redoButton.isEnabled = self.canPerformHistory(redo: true)
            self.updateFormatControls()
            self.discardButton.isHidden = !self.binding.hasFailedDraft
            self.discardButton.isEnabled = !self.binding.hasRemoteBlock
            self.retryButton.setTitle(self.binding.hasRemoteBlock ? "重试应用" : "重试保存", for: .normal)
            self.onActivity?(busy)
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    @discardableResult
    func reveal(blockId: String) -> Bool {
        guard binding.canEdit, !binding.hasPendingWork, textView.markedTextRange == nil,
              let projection = binding.store.projection,
              let item = projection.outline.first(where: { $0.blockId == blockId }) else { return false }
        let range = NSRange(location: item.range.location, length: 0)
        textView.selectedRange = range
        binding.selectionChanged(range, text: projection.text, marked: false)
        textView.scrollRangeToVisible(item.range.nsRange)
        return true
    }
    @discardableResult
    func reveal(range: NativeRange, revision: UInt64) -> Bool {
        guard binding.canEdit, !binding.hasPendingWork, textView.markedTextRange == nil,
              let projection = binding.store.projection, projection.revision == revision,
              NativeText.identical(textView.text, projection.text), range.location >= 0, range.length > 0,
              range.location <= textView.textStorage.length,
              range.length <= textView.textStorage.length - range.location else { return false }
        let units = Array(projection.text.utf16)
        func scalarBoundary(_ offset: Int) -> Bool {
            offset == 0 || offset == units.count || !(0xD800...0xDBFF).contains(units[offset - 1]) ||
                !(0xDC00...0xDFFF).contains(units[offset])
        }
        guard scalarBoundary(range.location), scalarBoundary(range.location + range.length) else { return false }
        textView.selectedRange = range.nsRange
        binding.selectionChanged(range.nsRange, text: projection.text, marked: false)
        textView.scrollRangeToVisible(range.nsRange)
        textView.becomeFirstResponder()
        return true
    }
    private func render(_ projection: NativeProjection, changes: [NativeTextChange]) {
        guard textView.markedTextRange == nil else { return }
        rendering = true
        var selection = textView.selectedRange
        let offset = textView.contentOffset
        if !NativeText.identical(textView.text, projection.text) {
            for change in changes { selection = change.mapSelection(selection) }
            textView.text = projection.text
        }
        DocumentStyle.apply(projection, to: textView.textStorage)
        comments.text = projection.comments.map(\.summary).joined(separator: "\n")
        if let anchored = binding.resolvedSelection(in: projection) { selection = anchored }
        let length = (projection.text as NSString).length, start = min(selection.location, (projection.text as NSString).length)
        textView.selectedRange = NSRange(location: start, length: min(selection.length, length - start))
        binding.displayedSelection(textView.selectedRange)
        textView.setContentOffset(offset, animated: false)
        textView.isEditable = binding.canEdit
        rendering = false
        updateFormatControls()
    }
    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
        if self.textView.isPerformingInput {
            return binding.allows(range, replacement: text, marked: textView.markedTextRange != nil)
        }
        return binding.prepareInput(range, replacement: text, marked: textView.markedTextRange != nil)
    }
    func textViewDidChange(_ textView: UITextView) {
        guard !rendering, !self.textView.isPerformingInput else { return }
        let text = textView.text ?? "", marked = textView.markedTextRange != nil
        binding.selectionChanged(textView.selectedRange, text: text, marked: marked)
        binding.changed(text, marked: marked)
    }
    func textViewDidChangeSelection(_ textView: UITextView) {
        guard !rendering, !self.textView.isPerformingInput else { return }
        let text = textView.text ?? "", marked = textView.markedTextRange != nil
        binding.selectionChanged(textView.selectedRange, text: text, marked: marked)
        binding.changed(text, marked: marked)
    }
    private func canPerformHistory(redo: Bool) -> Bool {
        guard binding.canEdit, !binding.hasPendingWork, textView.markedTextRange == nil,
              let projection = binding.state?.projection else { return false }
        return redo ? projection.canRedo : projection.canUndo
    }
    private func performHistory(redo: Bool) {
        guard canPerformHistory(redo: redo) else { return }
        binding.history(redo: redo)
    }
    private func canPerformFormat(_ action: NativeFormatAction) -> Bool {
        textView.markedTextRange == nil && binding.canFormat(action, range: textView.selectedRange)
    }
    private func updateFormatControls() {
        boldButton.isEnabled = canPerformFormat(.bold)
        italicButton.isEnabled = canPerformFormat(.italic)
        blockButton.isEnabled = canPerformFormat(.paragraph)
        let current = binding.blockFormat(at: textView.selectedRange)
        blockButton.setTitle(current?.title ?? "段落样式", for: .normal)
        guard blockButton.menu == nil || current != displayedBlockFormat else { return }
        displayedBlockFormat = current
        blockButton.menu = UIMenu(children: NativeFormatAction.blocks.map { action in
            let item = UIAction(title: action.title, state: current == action ? .on : .off) { [weak self] _ in
                self?.performFormat(action)
            }
            item.accessibilityIdentifier = action.accessibilityID
            return item
        })
    }
    private func performFormat(_ action: NativeFormatAction) {
        guard canPerformFormat(action) else { return }
        binding.format(action, range: textView.selectedRange)
    }
    @objc private func boldProse() { performFormat(.bold) }
    @objc private func italicProse() { performFormat(.italic) }
    @objc private func undoProse() { performHistory(redo: false) }
    @objc private func redoProse() { performHistory(redo: true) }
    @objc private func retrySave() { binding.retrySave() }
    @objc private func discardDraft() { binding.discardDraft() }
    @objc private func finishEditing() { _ = textView.resignFirstResponder() }
}
