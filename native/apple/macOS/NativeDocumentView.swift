import AppKit

final class ProseTextView: NSTextView {
    /// The text starts this far down; a taller container inset only adds
    /// room below the text (打字机滚动's tail).
    static let topInset: CGFloat = 20
    override var textContainerOrigin: NSPoint { NSPoint(x: textContainerInset.width, y: Self.topInset) }
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
    /// 编辑 › Copilot 分析 (⇧⌘I) on this body.
    var canPerformCopilot: (() -> Bool)?
    var performCopilot: (() -> Void)?
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
    @objc func copilotAnalyze(_ sender: Any?) {
        guard canPerformCopilot?() == true else { return }
        performCopilot?()
    }
    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(undo(_:)) { return canPerformHistory?(false) == true }
        if item.action == #selector(redo(_:)) { return canPerformHistory?(true) == true }
        if item.action == #selector(boldProse(_:)) { return canPerformFormat?(.bold) == true }
        if item.action == #selector(italicProse(_:)) { return canPerformFormat?(.italic) == true }
        if item.action == #selector(addProseComment(_:)) { return canPerformComment?() == true }
        if item.action == #selector(copilotAnalyze(_:)) { return canPerformCopilot?() == true }
        return super.validateUserInterfaceItem(item)
    }
    override func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(undo(_:)) { return canPerformHistory?(false) == true }
        if item.action == #selector(redo(_:)) { return canPerformHistory?(true) == true }
        if item.action == #selector(boldProse(_:)) { return canPerformFormat?(.bold) == true }
        if item.action == #selector(italicProse(_:)) { return canPerformFormat?(.italic) == true }
        if item.action == #selector(addProseComment(_:)) { return canPerformComment?() == true }
        if item.action == #selector(copilotAnalyze(_:)) { return canPerformCopilot?() == true }
        return super.validateMenuItem(item)
    }
}

/// The prose scroll view. In a long scroll (the 全书长卷) it is exactly as
/// tall as its text, and the wheel scrolls the enclosing view instead.
private final class ProseScrollView: NSScrollView {
    var forwardsScrollWheel = false
    override func scrollWheel(with event: NSEvent) {
        if forwardsScrollWheel, let next = nextResponder { next.scrollWheel(with: event) } else { super.scrollWheel(with: event) }
    }
}

final class NativeDocumentView: NSView, NSTextViewDelegate {
    let binding: DocumentBinding
    let textView = ProseTextView()
    private let scroll = ProseScrollView()
    /// The body grows with its text instead of scrolling (a row of the
    /// 全书长卷); `onHeightChange` reports each new height.
    let growsWithText: Bool
    private var textHeight: NSLayoutConstraint?
    var onHeightChange: (() -> Void)?
    /// The author changed the text in this view (not a render of a reply).
    var onEdited: (() -> Void)?
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
    /// The text system's own selection colours, used without an accent.
    private lazy var defaultSelection = textView.selectedTextAttributes
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
    /// 新建补丁… from a chapter or drift selection: the chapter, the block
    /// holding the selection, its text and the selected text. Set by the tab
    /// host for chapter and drift bodies only, with `patchNodeID`.
    var onCreatePatch: ((WorkspacePatchSource) -> Void)?
    var patchNodeID: String?
    /// Copilot 分析 of the paragraphs changed since its last run, else those
    /// the selection touches. Set by the tab host for chapter and drift bodies.
    var onCopilotAnalyze: ((NSRange) -> Void)?
    /// Whether Copilot works in this body now (on, allowed here, idle).
    var canCopilotAnalyze: (() -> Bool)?
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
    /// Reads a live link's 悬停卡片 (patches, backlinks, status, words); set by
    /// the tab host. Without one the card shows what the directory knows.
    var hoverCardSource: ((EntityLinkTarget, @escaping (EntityHoverCardContent) -> Void) -> Void)?
    /// The card shown for `previewedLink`, once its reads arrived.
    private(set) var linkCard: EntityHoverCardContent?
    private(set) var linkCardController: EntityHoverCardController?
    /// Scrolls that keep the caret line at the typewriter height, for acceptance.
    private(set) var typewriterAlignments = 0
    private var alignAfterRender = false
    /// Typed input is on its way through the binding: its reply's restyle
    /// may move the caret line, so the render aligns once more.
    private var typewriterFollowsInput = false
    private var typewriterScheduled = false
    /// An alignment waits for the text system to finish the current event.
    var hasScheduledTypewriterAlignment: Bool { typewriterScheduled }
    var isInteractionLocked = false {
        didSet {
            updateEditability()
            updateActions()
        }
    }
    /// Comments are a chapter feature. Element bodies never offer or send one.
    let allowsComments: Bool

    init(core: LabCore, allowsComments: Bool = true, minimumTextHeight: CGFloat = 220, growsWithText: Bool = false) {
        binding = DocumentBinding(core: core)
        self.allowsComments = allowsComments
        self.growsWithText = growsWithText
        super.init(frame: .zero)
        scroll.hasVerticalScroller = !growsWithText
        scroll.borderType = growsWithText ? .noBorder : .bezelBorder
        if growsWithText {
            // Prose sits on the page of the long scroll, like its read-only rows.
            scroll.forwardsScrollWheel = true
            scroll.verticalScrollElasticity = .none
            scroll.drawsBackground = false
            textView.drawsBackground = false
        }
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
        textView.textContainerInset = NSSize(width: 20, height: ProseTextView.topInset)
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
        textView.canPerformCopilot = { [weak self] in self?.canRequestCopilot == true }
        textView.performCopilot = { [weak self] in self?.requestCopilot() }
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
        if growsWithText {
            let height = scroll.heightAnchor.constraint(equalToConstant: minimumTextHeight)
            height.priority = .init(999)
            height.isActive = true
            textHeight = height
        }
        applyEditorPreferences()
        NotificationCenter.default.addObserver(self, selector: #selector(typographyChanged),
                                               name: DocumentStyle.typographyDidChange, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(editorPreferencesChanged),
                                               name: MacEditorPreferences.didChange, object: nil)
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
        fitTextHeight()
        if alignAfterRender || typewriterFollowsInput { alignAfterRender = false; scheduleTypewriterAlignment() }
    }

    // MARK: Growing with the text

    override func layout() {
        super.layout()
        fitTextHeight()
        updateTypewriterTail()
    }

    /// Sizes the prose to its laid-out text at the current width, so a long
    /// scroll shows it whole; reports a changed height.
    private func fitTextHeight() {
        guard let textHeight, let manager = textView.layoutManager, let container = textView.textContainer,
              textView.frame.width > 1 else { return }
        manager.ensureLayout(for: container)
        let height = ceil(manager.usedRect(for: container).height + textView.textContainerInset.height * 2)
        guard abs(height - textHeight.constant) >= 0.5 else { return }
        textHeight.constant = height
        // The prose never scrolls inside its own clip view.
        if scroll.contentView.bounds.origin != .zero { scroll.contentView.scroll(to: .zero); scroll.reflectScrolledClipView(scroll.contentView) }
        onHeightChange?()
    }
    // MARK: Settings

    /// 设置 changed the typography: restyle the displayed prose in place.
    /// Text, selection, history and the binding are untouched.
    @objc private func typographyChanged() {
        restyleLinks()
        if !textView.hasMarkedText() { textView.typingAttributes = DocumentStyle.bodyAttributes }
        fitTextHeight()
    }

    @objc private func editorPreferencesChanged() { applyEditorPreferences() }

    /// Spelling and the selection wash follow 设置.
    private func applyEditorPreferences() {
        if let spelling = MacEditorPreferences.spellChecking, textView.isContinuousSpellCheckingEnabled != spelling {
            textView.isContinuousSpellCheckingEnabled = spelling
        }
        var selected = defaultSelection
        if let accent = MacEditorPreferences.accentColor { selected[.backgroundColor] = accent.withAlphaComponent(0.28) }
        textView.selectedTextAttributes = selected
        updateTypewriterTail()
    }

    // MARK: 打字机滚动

    /// Where the middle of the caret line sits, from the top of the visible prose.
    static let typewriterPosition: CGFloat = 0.4
    var typewriterEnabled: Bool { MacEditorPreferences.typewriterScrolling == true }

    /// The scroll view that follows the caret: the prose's own, or the long
    /// scroll a growing body sits in (the 全书长卷).
    private var typewriterScroll: NSScrollView? { growsWithText ? enclosingScrollView : scroll }

    /// Room below the text so the last line can reach the typewriter height:
    /// the container inset grows while the text keeps its top origin. Not a
    /// scroll view inset, which the text system would treat as covered and
    /// scroll the caret out of. A growing body leaves its long scroll alone.
    private func updateTypewriterTail() {
        guard !growsWithText else { return }
        let tail = typewriterEnabled ? ceil(scroll.contentView.bounds.height * (1 - Self.typewriterPosition)) : 0
        let inset = NSSize(width: 20, height: ProseTextView.topInset + tail / 2)
        guard textView.textContainerInset != inset else { return }
        textView.textContainerInset = inset
        textView.sizeToFit()
    }

    /// The room below the text for 打字机滚动, in points.
    var typewriterTail: CGFloat { (textView.textContainerInset.height - ProseTextView.topInset) * 2 }

    /// The caret line's rectangle in text view coordinates.
    func caretLineRect() -> NSRect? {
        guard let manager = textView.layoutManager, let container = textView.textContainer else { return nil }
        let text = textView.string as NSString
        let location = min(textView.selectedRange().location, text.length)
        var rect: NSRect
        if text.length == 0 || (location == text.length && text.character(at: text.length - 1) == 0x0A) {
            manager.ensureLayout(for: container)
            rect = manager.extraLineFragmentRect
            if rect.height <= 0, manager.numberOfGlyphs > 0 {
                rect = manager.lineFragmentRect(forGlyphAt: manager.numberOfGlyphs - 1, effectiveRange: nil)
            }
        } else {
            rect = manager.lineFragmentRect(forGlyphAt: manager.glyphIndexForCharacter(at: min(location, text.length - 1)),
                                            effectiveRange: nil)
        }
        guard rect.height > 0 else { return nil }
        let origin = textView.textContainerOrigin
        return rect.offsetBy(dx: origin.x, dy: origin.y)
    }

    /// Where the caret line's middle sits in the visible prose, 0 at the top
    /// and 1 at the bottom; nil when it cannot be measured.
    var caretLinePosition: CGFloat? {
        guard let target = typewriterScroll, let caret = caretLineRect() else { return nil }
        let clip = target.contentView
        let line = clip.convert(caret, from: textView)
        let bounds = clip.bounds
        guard bounds.height > 1 else { return nil }
        return clip.isFlipped ? (line.midY - bounds.minY) / bounds.height : (bounds.maxY - line.midY) / bounds.height
    }

    /// Aligns once the text system has finished its own work for the event
    /// (it scrolls an insertion into view after notifying the delegate).
    private func scheduleTypewriterAlignment() {
        guard typewriterEnabled, !typewriterScheduled else { return }
        typewriterScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.typewriterScheduled = false
            self.alignTypewriter()
            if !self.binding.hasPendingWork { self.typewriterFollowsInput = false }
        }
    }

    /// 打字机滚动: scrolls so the caret line sits at `typewriterPosition` of
    /// the visible height. Only the scroll position changes; text,
    /// selection, marked text and history are untouched, and scrolling by
    /// hand is left alone until the next keystroke.
    @discardableResult
    func alignTypewriter() -> Bool {
        guard typewriterEnabled, textView.selectedRange().length == 0 || textView.hasMarkedText(),
              let target = typewriterScroll, let caret = caretLineRect() else { return false }
        let clip = target.contentView
        let line = clip.convert(caret, from: textView)
        let height = clip.bounds.height
        guard height > 1 else { return false }
        var origin = clip.bounds.origin
        origin.y = clip.isFlipped ? line.midY - height * Self.typewriterPosition : line.midY - height * (1 - Self.typewriterPosition)
        let constrained = clip.constrainBoundsRect(NSRect(origin: origin, size: clip.bounds.size)).origin
        guard abs(constrained.y - clip.bounds.origin.y) >= 0.5 else { return false }
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: constrained.y))
        target.reflectScrolledClipView(clip)
        typewriterAlignments += 1
        return true
    }

    // MARK: Entity links

    /// Restyle the displayed prose after the directory or the typography
    /// changed. Marked text keeps its temporary styling; the next render
    /// after commit is full.
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
        linkCard = nil; linkCardController = nil
        guard !target.trashed, let hoverCardSource else { presentLinkCard(EntityHoverCardContent(target: target), range: range); return true }
        hoverCardSource(target) { [weak self] content in
            guard let self, self.previewedLink == target, self.hoverRange == range else { return }
            self.presentLinkCard(content, range: range)
        }
        return true
    }

    /// Shows the card beside the link without taking the keyboard: the
    /// caret, selection and marked text stay as they are.
    private func presentLinkCard(_ content: EntityHoverCardContent, range: NSRange) {
        let controller = EntityHoverCardController(content: content)
        if !content.trashed { controller.onOpen = { [weak self] in self?.openPreviewedLink() } }
        linkCard = content; linkCardController = controller
        linkPreview.contentViewController = controller
        if let window = textView.window, window.isVisible {
            let screen = textView.firstRect(forCharacterRange: range, actualRange: nil)
            let rect = textView.convert(window.convertFromScreen(screen), from: nil)
            linkPreview.show(relativeTo: rect, of: textView, preferredEdge: .maxY)
        }
    }

    /// A click on the card: its target's page opens as ⌘-click opens it,
    /// while this editor keeps its caret and selection.
    @discardableResult
    func openPreviewedLink() -> Bool {
        guard let shown = previewedLink, !isInteractionLocked, let linkDirectory,
              let target = linkDirectory.current(shown), !target.trashed, let onOpenLink else { return false }
        closeLinkPreview()
        onOpenLink(target)
        return true
    }

    func closeLinkPreview() {
        hoverTimer?.cancel(); hoverTimer = nil; hoverRange = nil
        previewedLink = nil; linkCard = nil; linkCardController = nil
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

    // MARK: Patches

    /// The selection a patch would be made from, or nil when there is no
    /// settled, non-empty selection.
    var patchSource: WorkspacePatchSource? {
        guard onCreatePatch != nil, let patchNodeID, !isInteractionLocked, !textView.hasMarkedText(),
              let projection = binding.store.projection else { return nil }
        return PatchText.source(nodeID: patchNodeID, projection: projection, shown: textView.string, range: textView.selectedRange())
    }

    /// 新建补丁…: hands the current selection to the tab host's sheet.
    @objc func createPatchFromSelection() {
        guard let source = patchSource else { return }
        focus()
        onCreatePatch?(source)
    }

    // MARK: Copilot

    var canRequestCopilot: Bool {
        onCopilotAnalyze != nil && !isInteractionLocked && !textView.hasMarkedText() && canCopilotAnalyze?() == true
    }

    /// Copilot 分析: reads nothing itself; the tab host asks the project's Copilot.
    @objc func requestCopilot() {
        guard canRequestCopilot else { return }
        onCopilotAnalyze?(textView.selectedRange())
    }

    func textView(_ view: NSTextView, menu: NSMenu, for event: NSEvent, at charIndex: Int) -> NSMenu? {
        var leading: [NSMenuItem] = linkMenuItems(at: charIndex)
        if allowsComments, !menu.items.contains(where: { $0.action == #selector(ProseTextView.addProseComment(_:)) }) {
            let item = NSMenuItem(title: "添加批注…", action: #selector(ProseTextView.addProseComment(_:)), keyEquivalent: "")
            item.target = textView
            item.setAccessibilityIdentifier("context-add-comment")
            leading.append(item)
        }
        if patchSource != nil {
            let item = NSMenuItem(title: "新建补丁…", action: #selector(createPatchFromSelection), keyEquivalent: "")
            item.target = self
            item.setAccessibilityIdentifier("context-create-patch")
            item.toolTip = "把选中的文字锚定为一个设定的变化"
            leading.append(item)
        }
        if canRequestCopilot {
            let item = NSMenuItem(title: "Copilot 分析", action: #selector(requestCopilot), keyEquivalent: "")
            item.target = self
            item.setAccessibilityIdentifier("context-copilot-analyze")
            item.toolTip = "让 Copilot 读一读新写的段落（没有新段落时读选中的段落），提出设定和补丁建议（⇧⌘I）"
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
        fitTextHeight()
        typewriterFollowsInput = typewriterEnabled
        scheduleTypewriterAlignment()
        onEdited?()
    }
    func textViewDidChangeSelection(_ notification: Notification) {
        guard !rendering else { return }
        let text = textView.string, marked = textView.hasMarkedText()
        if marked { styledProjection = nil }
        binding.selectionChanged(textView.selectedRange(), text: text, marked: marked)
        binding.changed(text, marked: marked)
        // Keyboard caret moves follow the typewriter line; clicks do not.
        if NSApp.currentEvent?.type == .keyDown { scheduleTypewriterAlignment() }
    }
    private func canPerformHistory(redo: Bool) -> Bool {
        guard !isInteractionLocked, binding.canEdit, !binding.hasPendingWork, !textView.hasMarkedText(),
              let projection = binding.state?.projection else { return false }
        return redo ? projection.canRedo : projection.canUndo
    }
    private func performHistory(redo: Bool) {
        guard canPerformHistory(redo: redo) else { return }
        focus()
        alignAfterRender = typewriterEnabled
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
