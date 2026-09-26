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
    var canPerformComment: (() -> Bool)?
    var performComment: (() -> Void)?
    /// Opens the first live link target at a character; false when none.
    var openLink: ((Int) -> Bool)?
    /// Whether a character carries a link mark.
    var hasLink: ((Int) -> Bool)?
    /// The linked character under a resting or moving mouse, or nil.
    var onHover: ((Int?) -> Void)?
    private var hoverArea: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverArea { removeTrackingArea(hoverArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
                                  owner: self, userInfo: nil)
        addTrackingArea(area); hoverArea = area
    }
    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        onHover?(linkIndex(for: event))
    }
    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        onHover?(nil)
    }

    /// ⌘-click on a live link opens its target instead of moving the caret.
    override func mouseDown(with event: NSEvent) {
        onHover?(nil)
        if event.modifierFlags.contains(.command), let index = linkIndex(for: event), openLink?(index) == true { return }
        super.mouseDown(with: event)
    }

    /// The linked character under a mouse event, if any. The insertion index
    /// names the gap nearest the point; the glyph on either side is hit-tested.
    func linkIndex(for event: NSEvent) -> Int? {
        guard let window = event.window ?? self.window else { return nil }
        let point = convert(event.locationInWindow, from: nil)
        let screen = window.convertPoint(toScreen: event.locationInWindow)
        let gap = characterIndexForInsertion(at: point)
        let length = (string as NSString).length
        for index in [gap, gap - 1] where index >= 0 && index < length && hasLink?(index) == true {
            let rect = firstRect(forCharacterRange: NSRange(location: index, length: 1), actualRange: nil)
            if rect.insetBy(dx: -1, dy: -1).contains(screen) { return index }
        }
        return nil
    }

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
    @objc func addProseComment(_ sender: Any?) {
        guard canPerformComment?() == true else { return }
        performComment?()
    }
    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(undo(_:)) { return canPerformHistory?(false) == true }
        if item.action == #selector(redo(_:)) { return canPerformHistory?(true) == true }
        if item.action == #selector(boldProse(_:)) { return canPerformFormat?(.bold) == true }
        if item.action == #selector(italicProse(_:)) { return canPerformFormat?(.italic) == true }
        if item.action == #selector(addProseComment(_:)) { return canPerformComment?() == true }
        return super.validateUserInterfaceItem(item)
    }
    override func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(undo(_:)) { return canPerformHistory?(false) == true }
        if item.action == #selector(redo(_:)) { return canPerformHistory?(true) == true }
        if item.action == #selector(boldProse(_:)) { return canPerformFormat?(.bold) == true }
        if item.action == #selector(italicProse(_:)) { return canPerformFormat?(.italic) == true }
        if item.action == #selector(addProseComment(_:)) { return canPerformComment?() == true }
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
    private var reportedComments: [NativeComment]?
    private(set) var lastStyleUpdate = DocumentStyle.Update.full
    var onStyleUpdate: ((DocumentStyle.Update) -> Void)?
    var onActivity: ((Bool) -> Void)?
    var onFocus: (() -> Void)?
    /// Fired when this view renders different comment anchor views.
    var onComments: (() -> Void)?
    var onCommentCreated: ((WorkspaceComment) -> Void)?
    /// Opens a live link target (⌘-click or 打开「名称」).
    var onOpenLink: ((EntityLinkTarget) -> Void)?
    /// A background link pass added links to this owner's prose.
    var onEntityLinks: (() -> Void)?
    /// The workspace's elements and chapters. Without one, links keep the
    /// default style and cannot be opened. A change restyles the prose only.
    var linkDirectory: EntityLinkDirectory? {
        didSet { if linkDirectory != oldValue { closeLinkPreview(); restyleLinks() } }
    }
    /// Hover delay before a link's preview opens, as in the renderer.
    static var linkPreviewDelay: TimeInterval = 0.22
    private var hoverTimer: DispatchWorkItem?
    private var hoverRange: NSRange?
    private let linkPreview = NSPopover()
    /// The target whose preview is open, and its text. Set even when the
    /// window is not on screen, where no popover can be shown.
    private(set) var previewedLink: EntityLinkTarget?
    var linkPreviewText: String? { previewedLink?.preview }
    var isInteractionLocked = false {
        didSet {
            updateEditability()
            updateActions()
        }
    }
    /// Comments are a chapter feature. Element bodies never offer or send one.
    let allowsComments: Bool

    init(core: LabCore, allowsComments: Bool = true, minimumTextHeight: CGFloat = 220) {
        binding = DocumentBinding(core: core)
        self.allowsComments = allowsComments
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
        textView.canPerformComment = { [weak self] in self?.canAddComment == true }
        textView.performComment = { [weak self] in self?.beginComment() }
        textView.openLink = { [weak self] in self?.openLink(at: $0) == true }
        textView.hasLink = { [weak self] in self?.links(at: $0).isEmpty == false }
        textView.onHover = { [weak self] in self?.hover(at: $0) }
        linkPreview.behavior = .semitransient
        linkPreview.animates = false
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
        comments.isHidden = !allowsComments
        let stack = NSStackView(views: [toolbar, formats, scroll, comments, status])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor), status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            comments.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: minimumTextHeight),
        ])
        binding.onProjection = { [weak self] in self?.render($0, changes: $1) }
        binding.onStatus = { [weak self] in self?.status.stringValue = $0 }
        binding.onEntityLinks = { [weak self] in self?.onEntityLinks?() }
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

    @discardableResult
    func reveal(range: NativeRange, revision: UInt64) -> Bool {
        guard !isInteractionLocked, binding.canEdit, !binding.hasPendingWork, !textView.hasMarkedText(),
              let projection = binding.store.projection, projection.revision == revision,
              NativeText.identical(textView.string, projection.text),
              range.location >= 0, range.length > 0,
              range.location <= (projection.text as NSString).length,
              range.length <= (projection.text as NSString).length - range.location else { return false }
        textView.setSelectedRange(range.nsRange)
        binding.selectionChanged(range.nsRange, text: projection.text, marked: false)
        textView.scrollRangeToVisible(range.nsRange)
        focus()
        return true
    }

    private func render(_ projection: NativeProjection, changes: [NativeTextChange]) {
        guard !textView.hasMarkedText() else { styledProjection = nil; return }
        if !changes.isEmpty { closeLinkPreview() }
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
                localChange: changes.count == 1 ? changes[0] : nil, to: storage, links: linkDirectory)
            styledProjection = projection
            onStyleUpdate?(lastStyleUpdate)
        }
        comments.stringValue = projection.comments.map(\.summary).joined(separator: "\n")
        if reportedComments != projection.comments { reportedComments = projection.comments; onComments?() }
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
    // MARK: Entity links

    /// Restyle the displayed prose after the directory changed. Marked text
    /// keeps its temporary styling; the next render after commit is full.
    private func restyleLinks() {
        guard let projection = styledProjection, let storage = textView.textStorage else { return }
        guard !textView.hasMarkedText(), NativeText.identical(textView.string, projection.text) else { styledProjection = nil; return }
        DocumentStyle.apply(projection, to: storage, links: linkDirectory)
        lastStyleUpdate = .full
        onStyleUpdate?(.full)
    }

    /// The displayed run holding a UTF-16 index.
    private func run(at index: Int) -> NativeRun? {
        guard let projection = styledProjection, NativeText.identical(textView.string, projection.text),
              let block = projection.blocks.first(where: { $0.range.location <= index && index < NSMaxRange($0.range.nsRange) }) else { return nil }
        return block.runs.first { $0.range.location <= index && index < NSMaxRange($0.range.nsRange) }
    }

    /// The link marks on the displayed character at a UTF-16 index.
    func links(at index: Int) -> [NativeEntityLink] { run(at: index)?.attributes.links ?? [] }

    /// Resolved targets at a character, live and trashed, in mark order.
    func linkTargets(at index: Int) -> [EntityLinkTarget] {
        guard let linkDirectory else { return [] }
        return links(at: index).compactMap { linkDirectory.target(for: $0).flatMap { $0 } }
    }

    private func linkRange(at index: Int) -> NSRange? { run(at: index)?.range.nsRange }

    /// Resting on a link opens its preview after `linkPreviewDelay`; leaving
    /// it closes the preview at once. Composition never shows one.
    private func hover(at index: Int?) {
        guard let index, !textView.hasMarkedText(), linkTargets(at: index).first != nil, let range = linkRange(at: index) else {
            closeLinkPreview(); return
        }
        guard range != hoverRange else { return }
        closeLinkPreview()
        hoverRange = range
        let timer = DispatchWorkItem { [weak self] in
            guard let self, self.hoverRange == range else { return }
            self.hoverTimer = nil
            self.showLinkPreview(at: index)
        }
        hoverTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.linkPreviewDelay, execute: timer)
    }

    /// Opens the preview of the first target at a character now: name and
    /// category, up to three aliases and the summary, or its trash state.
    @discardableResult
    func showLinkPreview(at index: Int) -> Bool {
        guard !textView.hasMarkedText(), let target = linkTargets(at: index).first, let range = linkRange(at: index) else {
            closeLinkPreview(); return false
        }
        hoverTimer?.cancel(); hoverTimer = nil
        hoverRange = range; previewedLink = target
        linkPreview.contentViewController = LinkPreviewController(target: target)
        if let window = textView.window, window.isVisible {
            let screen = textView.firstRect(forCharacterRange: range, actualRange: nil)
            let rect = textView.convert(window.convertFromScreen(screen), from: nil)
            linkPreview.show(relativeTo: rect, of: textView, preferredEdge: .maxY)
        }
        return true
    }

    func closeLinkPreview() {
        hoverTimer?.cancel(); hoverTimer = nil; hoverRange = nil
        previewedLink = nil
        if linkPreview.isShown { linkPreview.performClose(nil) }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { closeLinkPreview() }
    }

    @discardableResult
    func openLink(at index: Int) -> Bool {
        guard !isInteractionLocked, !textView.hasMarkedText(),
              let target = linkTargets(at: index).first(where: { !$0.trashed }), let onOpenLink else { return false }
        onOpenLink(target)
        return true
    }

    private func linkMenuItems(at index: Int) -> [NSMenuItem] {
        linkTargets(at: index).map { target in
            if target.trashed {
                let item = NSMenuItem(title: "「\(target.name)」已在回收站", action: nil, keyEquivalent: "")
                item.isEnabled = false
                item.setAccessibilityIdentifier("context-trashed-link-\(target.id)")
                return item
            }
            let item = NSMenuItem(title: "打开「\(target.name)」", action: #selector(openLinkItem(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = target
            item.setAccessibilityIdentifier("context-open-link-\(target.id)")
            return item
        }
    }

    @objc private func openLinkItem(_ sender: NSMenuItem) {
        guard !isInteractionLocked, let chosen = sender.representedObject as? EntityLinkTarget, let linkDirectory else { return }
        // Resolve again: the target may have been trashed while the menu was open.
        guard let target = linkDirectory.current(chosen), !target.trashed else { return }
        onOpenLink?(target)
    }

    // MARK: Comments

    var canAddComment: Bool {
        allowsComments && !isInteractionLocked && !textView.hasMarkedText() && binding.canComment(range: textView.selectedRange())
    }

    /// Opens the composer for the current selection. The range and revision
    /// are captured now; if the prose changes first, the core refuses and the
    /// composer keeps the typed text with the reason.
    func beginComment() {
        guard canAddComment, let projection = binding.store.projection, let window else { return }
        let range = textView.selectedRange(), revision = projection.revision
        focus()
        let composer = MacCommentComposerViewController(title: "添加批注", confirmTitle: "添加",
            quote: (projection.text as NSString).substring(with: range))
        composer.onSubmit = { [weak self] body, done in
            guard let self else { done(LabError.message("编辑栏已关闭，批注未添加。")); return }
            self.addComment(body, range: range, revision: revision) { result in
                switch result {
                case .success: done(nil)
                case .failure(let error): done(error)
                }
            }
        }
        composer.onFinish = { [weak self] in self?.focus() }
        composer.present(on: window)
    }

    func addComment(_ body: String, range: NSRange, revision: UInt64,
                    completion: @escaping (Result<WorkspaceComment, Error>) -> Void) {
        guard allowsComments else { completion(.failure(LabError.message("设定正文不支持批注。"))); return }
        guard !isInteractionLocked, !textView.hasMarkedText() else {
            completion(.failure(LabError.message("请先完成输入，再添加批注。"))); return
        }
        binding.addComment(body, range: range, revision: revision) { [weak self] result in
            if case .success(let comment) = result { self?.onCommentCreated?(comment) }
            completion(result)
        }
    }

    /// Selects the comment's current anchor in this view only. Returns the
    /// reason when it cannot, leaving the selection unchanged.
    func locateComment(id: String) -> String? {
        guard allowsComments else { return "设定正文不支持批注。" }
        guard !isInteractionLocked, binding.canEdit, !binding.hasPendingWork, !textView.hasMarkedText(),
              let projection = binding.store.projection else { return "请先完成输入，并等待正文保存后再定位批注。" }
        guard let anchor = projection.comments.first(where: { $0.id == id }) else { return "这条批注已不在当前正文中，请刷新批注列表。" }
        guard let range = anchor.locatableRange else {
            return anchor.anchorStatus == .collapsed ? "批注的原文已删除，无法定位。" : "未能在正文中找到这条批注的原文。"
        }
        return reveal(range: range, revision: projection.revision) ? nil : "正文已变化，请稍后再定位这条批注。"
    }

    func textView(_ view: NSTextView, menu: NSMenu, for event: NSEvent, at charIndex: Int) -> NSMenu? {
        var leading: [NSMenuItem] = linkMenuItems(at: charIndex)
        if allowsComments, !menu.items.contains(where: { $0.action == #selector(ProseTextView.addProseComment(_:)) }) {
            let item = NSMenuItem(title: "添加批注…", action: #selector(ProseTextView.addProseComment(_:)), keyEquivalent: "")
            item.target = textView
            item.setAccessibilityIdentifier("context-add-comment")
            leading.append(item)
        }
        guard !leading.isEmpty else { return menu }
        for (offset, item) in (leading + [.separator()]).enumerated() { menu.insertItem(item, at: offset) }
        return menu
    }

    func textView(_ textView: NSTextView, shouldChangeTextIn affectedCharRange: NSRange, replacementString: String?) -> Bool {
        guard !isInteractionLocked, let replacementString else { return false }
        return binding.prepareInput(affectedCharRange, replacement: replacementString, marked: textView.hasMarkedText())
    }
    func textDidChange(_ notification: Notification) {
        guard !rendering else { return }
        closeLinkPreview()
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

/// A link's hover preview: the name, then category and aliases, then the
/// summary. Plain typography on the popover's own background.
private final class LinkPreviewController: NSViewController {
    private let target: EntityLinkTarget
    init(target: EntityLinkTarget) { self.target = target; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        let lines = target.preview.components(separatedBy: "\n")
        let title = NSTextField(labelWithString: lines.first ?? target.name)
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        var views: [NSView] = [title]
        for (index, line) in lines.dropFirst().enumerated() {
            let label = NSTextField(wrappingLabelWithString: line)
            label.font = .systemFont(ofSize: 12)
            // Aliases read as metadata; the summary as body text.
            label.textColor = index == 0 && line.hasPrefix("别名") ? .secondaryLabelColor : .labelColor
            label.maximumNumberOfLines = 4
            label.preferredMaxLayoutWidth = 260
            views.append(label)
        }
        let stack = NSStackView(views: views)
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 4
        stack.edgeInsets = NSEdgeInsets(top: 10, left: 12, bottom: 10, right: 12)
        stack.setAccessibilityIdentifier("entity-link-preview")
        view = stack
    }
}
