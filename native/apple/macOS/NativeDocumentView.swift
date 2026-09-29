import AppKit

final class ProseTextView: ListMarkerTextView {
    /// The text starts this far down; a taller container inset only adds
    /// room below the text (打字机滚动's tail).
    static let topInset: CGFloat = 20
    override var textContainerOrigin: NSPoint { NSPoint(x: textContainerInset.width, y: Self.topInset) }
    var onFocus: (() -> Void)?
    /// The prose lost the keyboard (an open picker closes).
    var onResign: (() -> Void)?
    /// A click in the prose, before the text system moves the caret.
    var onMouseDown: (() -> Void)?
    /// The prose was resized, e.g. with its pane (the 版心宽度 column follows).
    var onResize: (() -> Void)?
    override func setFrameSize(_ newSize: NSSize) {
        let widthChanged = abs(newSize.width - frame.width) >= 0.5
        super.setFrameSize(newSize)
        if widthChanged { onResize?() }
    }
    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { onFocus?() }
        return accepted
    }
    override func resignFirstResponder() -> Bool {
        let accepted = super.resignFirstResponder()
        if accepted { onResign?() }
        return accepted
    }
    var canPerformHistory: ((Bool) -> Bool)?
    var performHistory: ((Bool) -> Void)?
    var canPerformFormat: ((NativeFormatAction) -> Bool)?
    var performFormat: ((NativeFormatAction) -> Void)?
    /// The selection's state for a format's checkmark.
    var formatState: ((NativeFormatAction) -> NativeFormatState)?
    var canPerformComment: (() -> Bool)?
    var performComment: (() -> Void)?
    /// 链接… (⌘K) and 移除链接.
    var canEditLink: (() -> Bool)?
    var performEditLink: (() -> Void)?
    var canRemoveLink: (() -> Bool)?
    var performRemoveLink: (() -> Void)?
    /// 格式 › 插入分隔线.
    var canInsertRule: (() -> Bool)?
    var performInsertRule: (() -> Void)?
    /// 编辑 › Copilot 分析 (⇧⌘I) on this body.
    var canPerformCopilot: (() -> Bool)?
    var performCopilot: (() -> Void)?
    /// 编辑 › Copilot 修改 (⌃⌘I) on this body.
    var canPerformCopilotInline: (() -> Bool)?
    var performCopilotInline: (() -> Void)?
    /// The find bar of this editor; nil where find is not offered (the
    /// 全书长卷's rows).
    weak var textFinder: NSTextFinder?
    /// Opens the first live link target at a character, or its URL link;
    /// false when none.
    var openLink: ((Int) -> Bool)?
    /// Whether a character carries an entity or URL link.
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

    /// ⌘-click on a live link opens its target (or a URL link's address in
    /// the browser) instead of moving the caret; a plain click edits.
    override func mouseDown(with event: NSEvent) {
        onHover?(nil)
        onMouseDown?()
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

    /// The menu and toolbar format commands, by action.
    static let formatSelectors: [Selector: NativeFormatAction] = [
        #selector(boldProse(_:)): .bold, #selector(italicProse(_:)): .italic, #selector(underlineProse(_:)): .underline,
        #selector(strikeProse(_:)): .strike, #selector(bodyTextProse(_:)): .paragraph, #selector(heading1Prose(_:)): .heading1,
        #selector(heading2Prose(_:)): .heading2, #selector(heading3Prose(_:)): .heading3,
        #selector(alignLeftProse(_:)): .alignLeft, #selector(alignCenterProse(_:)): .alignCenter,
        #selector(alignRightProse(_:)): .alignRight, #selector(indentProse(_:)): .indentIncrease,
        #selector(outdentProse(_:)): .indentDecrease, #selector(blockquoteProse(_:)): .blockquote,
        #selector(bulletListProse(_:)): .bulletList, #selector(orderedListProse(_:)): .orderedList,
        // AppKit's own rich-text actions reach the same commands, never the storage.
        #selector(NSText.underline(_:)): .underline, #selector(NSText.alignLeft(_:)): .alignLeft,
        #selector(NSText.alignCenter(_:)): .alignCenter, #selector(NSText.alignRight(_:)): .alignRight,
    ]

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
    private func format(_ action: NativeFormatAction) {
        guard canPerformFormat?(action) == true else { return }
        performFormat?(action)
    }
    @objc func boldProse(_ sender: Any?) { format(.bold) }
    @objc func italicProse(_ sender: Any?) { format(.italic) }
    @objc func underlineProse(_ sender: Any?) { format(.underline) }
    @objc func strikeProse(_ sender: Any?) { format(.strike) }
    @objc func bodyTextProse(_ sender: Any?) { format(.paragraph) }
    @objc func heading1Prose(_ sender: Any?) { format(.heading1) }
    @objc func heading2Prose(_ sender: Any?) { format(.heading2) }
    @objc func heading3Prose(_ sender: Any?) { format(.heading3) }
    @objc func alignLeftProse(_ sender: Any?) { format(.alignLeft) }
    @objc func alignCenterProse(_ sender: Any?) { format(.alignCenter) }
    @objc func alignRightProse(_ sender: Any?) { format(.alignRight) }
    @objc func indentProse(_ sender: Any?) { format(.indentIncrease) }
    @objc func outdentProse(_ sender: Any?) { format(.indentDecrease) }
    @objc func blockquoteProse(_ sender: Any?) { format(.blockquote) }
    @objc func bulletListProse(_ sender: Any?) { format(.bulletList) }
    @objc func orderedListProse(_ sender: Any?) { format(.orderedList) }
    override func underline(_ sender: Any?) { format(.underline) }
    override func alignLeft(_ sender: Any?) { format(.alignLeft) }
    override func alignCenter(_ sender: Any?) { format(.alignCenter) }
    override func alignRight(_ sender: Any?) { format(.alignRight) }
    /// Justified text is not a stored alignment.
    override func alignJustified(_ sender: Any?) {}
    @objc func editProseLink(_ sender: Any?) {
        guard canEditLink?() == true else { return }
        performEditLink?()
    }
    @objc func removeProseLink(_ sender: Any?) {
        guard canRemoveLink?() == true else { return }
        performRemoveLink?()
    }
    @objc func addProseComment(_ sender: Any?) {
        guard canPerformComment?() == true else { return }
        performComment?()
    }
    @objc func insertRuleProse(_ sender: Any?) {
        guard canInsertRule?() == true else { return }
        performInsertRule?()
    }
    @objc func copilotAnalyze(_ sender: Any?) {
        guard canPerformCopilot?() == true else { return }
        performCopilot?()
    }
    @objc func copilotInlineEdit(_ sender: Any?) {
        guard canPerformCopilotInline?() == true else { return }
        performCopilotInline?()
    }
    /// 查找…, 查找下一个, 查找上一个 and 用所选内容查找 name their action by tag.
    override func performTextFinderAction(_ sender: Any?) {
        guard let finder = textFinder, let tag = (sender as? NSValidatedUserInterfaceItem)?.tag,
              let action = NSTextFinder.Action(rawValue: tag), finder.validateAction(action) else { return }
        finder.performAction(action)
    }

    private func validate(_ item: NSValidatedUserInterfaceItem) -> Bool? {
        guard let action = item.action else { return nil }
        if action == #selector(undo(_:)) { return canPerformHistory?(false) == true }
        if action == #selector(redo(_:)) { return canPerformHistory?(true) == true }
        if let format = Self.formatSelectors[action] {
            if let menuItem = item as? NSMenuItem {
                switch formatState?(format) ?? .off {
                case .on: menuItem.state = .on
                case .mixed: menuItem.state = .mixed
                case .off: menuItem.state = .off
                }
            }
            return canPerformFormat?(format) == true
        }
        if action == #selector(alignJustified(_:)) { return false }
        if action == #selector(editProseLink(_:)) { return canEditLink?() == true }
        if action == #selector(removeProseLink(_:)) { return canRemoveLink?() == true }
        if action == #selector(addProseComment(_:)) { return canPerformComment?() == true }
        if action == #selector(insertRuleProse(_:)) { return canInsertRule?() == true }
        if action == #selector(copilotAnalyze(_:)) { return canPerformCopilot?() == true }
        if action == #selector(copilotInlineEdit(_:)) { return canPerformCopilotInline?() == true }
        if action == #selector(performTextFinderAction(_:)) {
            guard let finder = textFinder, let finderAction = NSTextFinder.Action(rawValue: item.tag) else { return false }
            return finder.validateAction(finderAction)
        }
        return nil
    }
    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        validate(item) ?? super.validateUserInterfaceItem(item)
    }
    override func validateMenuItem(_ item: NSMenuItem) -> Bool {
        validate(item) ?? super.validateMenuItem(item)
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

/// An editor's controls: 撤销, 重做, 重试保存 and 放弃窗口草稿, then the format
/// row (加粗 … 链接…). Each tab's editor has its own above its prose; the
/// 全书长卷 has one for the chapter being edited. Every control acts on
/// `target` through the commands the 格式 menu uses and shows its state;
/// without a target every control is off.
final class ProseFormatControls: NSObject {
    weak var target: NativeDocumentView? { didSet { if target !== oldValue { refresh() } } }
    let undoButton = NSButton(title: "撤销", target: nil, action: nil)
    let redoButton = NSButton(title: "重做", target: nil, action: nil)
    let retryButton = NSButton(title: "重试保存", target: nil, action: nil)
    let discardButton = NSButton(title: "放弃窗口草稿", target: nil, action: nil)
    let boldButton = NSButton(title: "加粗", target: nil, action: nil)
    let italicButton = NSButton(title: "斜体", target: nil, action: nil)
    let underlineButton = NSButton(title: "下划线", target: nil, action: nil)
    let strikeButton = NSButton(title: "删除线", target: nil, action: nil)
    let blockMenu = NSPopUpButton(frame: .zero, pullsDown: false)
    let alignMenu = NSPopUpButton(frame: .zero, pullsDown: false)
    let outdentButton = NSButton(title: "减少缩进", target: nil, action: nil)
    let indentButton = NSButton(title: "增加缩进", target: nil, action: nil)
    let linkButton = NSButton(title: "链接…", target: nil, action: nil)
    /// 引用, 无序列表 and 有序列表: on while every touched block is in one.
    let containerButtons = NativeFormatAction.containers.map { NSButton(title: $0.title, target: nil, action: nil) }
    /// 撤销, 重做, 重试保存 and 放弃窗口草稿.
    let historyRow: NSStackView
    /// The format commands; a narrow row drops its last controls first.
    let formatsRow: NSStackView
    /// Refreshes, for acceptance.
    private(set) var refreshes = 0

    /// `prefix` sets the controls apart from an editor's own (the 全书长卷's
    /// “whole-book-format-bold”).
    init(identifierPrefix prefix: String = "") {
        historyRow = NSStackView(views: [undoButton, redoButton, retryButton, discardButton])
        historyRow.spacing = 8
        formatsRow = NSStackView(views: [boldButton, italicButton, underlineButton, strikeButton, blockMenu, alignMenu,
                                         outdentButton, indentButton] + containerButtons + [linkButton])
        formatsRow.spacing = 8
        super.init()
        undoButton.target = self; undoButton.action = #selector(undo)
        redoButton.target = self; redoButton.action = #selector(redo)
        undoButton.setAccessibilityIdentifier("\(prefix)undo-prose")
        redoButton.setAccessibilityIdentifier("\(prefix)redo-prose")
        retryButton.target = self; retryButton.action = #selector(retry)
        retryButton.setAccessibilityIdentifier("\(prefix)retry-prose")
        discardButton.target = self; discardButton.action = #selector(discard); discardButton.isHidden = true
        discardButton.setAccessibilityIdentifier("\(prefix)discard-prose-draft")
        for (button, action) in [(boldButton, NativeFormatAction.bold), (italicButton, .italic), (underlineButton, .underline),
                                 (strikeButton, .strike), (outdentButton, .indentDecrease), (indentButton, .indentIncrease)] {
            button.target = self; button.action = #selector(format(_:))
            button.setAccessibilityIdentifier("\(prefix)format-\(action.rawValue)")
        }
        alignMenu.addItems(withTitles: NativeFormatAction.alignments.map(\.title))
        alignMenu.setAccessibilityIdentifier("\(prefix)format-align")
        alignMenu.setAccessibilityLabel("对齐")
        for (index, action) in NativeFormatAction.alignments.enumerated() {
            alignMenu.item(at: index)?.setAccessibilityIdentifier(prefix + action.accessibilityID)
        }
        alignMenu.target = self; alignMenu.action = #selector(alignBlock)
        outdentButton.toolTip = "减少所在段落的缩进（⇧Tab）"
        indentButton.toolTip = "增加所在段落的缩进（Tab）"
        linkButton.target = self; linkButton.action = #selector(editLink)
        linkButton.setAccessibilityIdentifier("\(prefix)format-link")
        linkButton.toolTip = "为选中的文字添加或修改网址链接（⌘K）"
        for (button, action) in zip(containerButtons, NativeFormatAction.containers) {
            button.setButtonType(.pushOnPushOff)
            button.target = self; button.action = #selector(toggleContainer(_:))
            button.setAccessibilityIdentifier(prefix + action.accessibilityID)
        }
        containerButtons[0].toolTip = "把所在段落设为引用，或取消引用（也可在段首输入“> ”）"
        containerButtons[1].toolTip = "把所在段落设为无序列表，或取消列表（也可在段首输入“- ”）"
        containerButtons[2].toolTip = "把所在段落设为有序列表，或取消列表（也可在段首输入“1. ”）"
        blockMenu.addItems(withTitles: NativeFormatAction.blocks.map(\.title))
        blockMenu.setAccessibilityIdentifier("\(prefix)format-block")
        blockMenu.setAccessibilityLabel("段落样式")
        for (index, action) in NativeFormatAction.blocks.enumerated() {
            blockMenu.item(at: index)?.setAccessibilityIdentifier(prefix + action.accessibilityID)
        }
        blockMenu.target = self; blockMenu.action = #selector(formatBlock)
        // A narrow pane drops the last controls first; the 格式 menu and the
        // context menu keep every command.
        formatsRow.setClippingResistancePriority(.defaultLow, for: .horizontal)
        let priorities = [(underlineButton, 700), (strikeButton, 700), (alignMenu, 600), (outdentButton, 500),
                          (indentButton, 500), (linkButton, 400)] as [(NSView, Float)] + containerButtons.map({ ($0 as NSView, Float(450)) })
        for (control, priority) in priorities {
            formatsRow.setVisibilityPriority(NSStackView.VisibilityPriority(rawValue: priority), for: control)
        }
        refresh()
    }

    /// Every control follows the target's selection, history and save state.
    func refresh() {
        refreshes += 1
        guard let view = target else {
            for control in [undoButton, redoButton, retryButton, boldButton, italicButton, underlineButton, strikeButton,
                            outdentButton, indentButton, linkButton] + containerButtons as [NSControl] + [blockMenu, alignMenu] {
                control.isEnabled = false
            }
            for button in containerButtons { button.state = .off }
            discardButton.isHidden = true
            retryButton.title = "重试保存"
            blockMenu.select(nil); blockMenu.title = "段落样式"
            alignMenu.select(nil); alignMenu.title = "对齐"
            return
        }
        undoButton.isEnabled = view.canPerformHistory(redo: false)
        redoButton.isEnabled = view.canPerformHistory(redo: true)
        boldButton.isEnabled = view.canPerformFormat(.bold)
        italicButton.isEnabled = view.canPerformFormat(.italic)
        underlineButton.isEnabled = view.canPerformFormat(.underline)
        strikeButton.isEnabled = view.canPerformFormat(.strike)
        blockMenu.isEnabled = view.canPerformFormat(.paragraph)
        if let action = view.selectedBlockFormat {
            blockMenu.selectItem(withTitle: action.title)
        } else {
            blockMenu.select(nil)
            blockMenu.title = "段落样式"
        }
        alignMenu.isEnabled = view.canPerformFormat(.alignLeft)
        if let current = NativeFormatAction.alignments.first(where: { view.formatState($0) == .on }) {
            alignMenu.selectItem(withTitle: current.title)
        } else {
            alignMenu.select(nil)
            alignMenu.title = "对齐"
        }
        outdentButton.isEnabled = view.canPerformFormat(.indentDecrease)
        indentButton.isEnabled = view.canPerformFormat(.indentIncrease)
        for (button, action) in zip(containerButtons, NativeFormatAction.containers) {
            button.isEnabled = view.canPerformFormat(action)
            button.state = view.formatState(action) == .on ? .on : .off
        }
        linkButton.isEnabled = view.canEditLink
        discardButton.isHidden = !view.binding.hasFailedDraft
        discardButton.isEnabled = !view.isInteractionLocked && !view.binding.hasRemoteBlock
        retryButton.isEnabled = !view.isInteractionLocked
        retryButton.title = view.binding.hasRemoteBlock ? "重试应用" : "重试保存"
    }

    @objc private func undo() { target?.undoProse() }
    @objc private func redo() { target?.redoProse() }
    @objc private func retry() { target?.retrySave() }
    @objc private func discard() { target?.discardDraft() }
    @objc private func editLink() { target?.beginLink() }
    @objc private func format(_ sender: NSButton) {
        let action: NativeFormatAction?
        switch sender {
        case boldButton: action = .bold
        case italicButton: action = .italic
        case underlineButton: action = .underline
        case strikeButton: action = .strike
        case outdentButton: action = .indentDecrease
        case indentButton: action = .indentIncrease
        default: action = nil
        }
        guard let action else { return }
        target?.performFormat(action)
    }
    @objc private func toggleContainer(_ sender: NSButton) {
        guard let index = containerButtons.firstIndex(of: sender) else { return }
        target?.performFormat(NativeFormatAction.containers[index])
        refresh()
    }
    @objc private func alignBlock() {
        guard NativeFormatAction.alignments.indices.contains(alignMenu.indexOfSelectedItem) else { return }
        target?.performFormat(NativeFormatAction.alignments[alignMenu.indexOfSelectedItem])
    }
    @objc private func formatBlock() {
        guard NativeFormatAction.blocks.indices.contains(blockMenu.indexOfSelectedItem) else { return }
        target?.performFormat(NativeFormatAction.blocks[blockMenu.indexOfSelectedItem])
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
    /// This editor's own 撤销 … 链接… rows above the prose; none in a body
    /// that grows with its text (the 全书长卷 has one set for all its rows).
    private(set) var controls: ProseFormatControls?
    /// The editor's history, save state or the selection's formats may
    /// have changed: controls outside it (the 全书长卷's) read them again.
    var onControlsChanged: (() -> Void)?
    /// ⌘F in this editor: the find bar with incremental search, ⌘G, ⇧⌘G and
    /// ⌘E; no 替换. Nil in the 全书长卷's rows, where find is not offered.
    private(set) var textFinder: NSTextFinder?
    private var finderClient: ProseFinderClient?
    /// Opens a URL link's address: the default browser (or mail app).
    /// Acceptance replaces it.
    static var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }
    /// 链接… while it is open.
    private(set) var linkSheet: MacLinkSheetController?
    /// The slash menu or @ picker while open, and whether its popover shows
    /// (never in a window that is not on screen).
    private(set) var picker: ProsePickerSession?
    private let pickerPopover = NSPopover()
    private let pickerController = ProsePickerController()
    var isPickerShown: Bool { pickerPopover.isShown }
    /// The @ picker's names: set by the tab host; without one only the
    /// slash menu opens.
    var mentionSource: (() -> ProseMentionSource)?
    /// ＋ 新建设定「…」: creates an element with the name in the category.
    var onCreateElement: ((_ name: String, _ categoryID: String, _ done: @escaping (Result<WorkspaceElement, Error>) -> Void) -> Void)?
    /// A block command (Tab, a slash row) waiting for queued input to land,
    /// and the blocks it was given for.
    private(set) var deferredFormat: DeferredBlockFormat?
    /// Return in a non-empty list item: once its new paragraph lands, it
    /// becomes the next item (`splitListItem`).
    private var splitsAfterNewline = false
    /// Where the caret goes once the reply of a rule edit renders, and the
    /// revision that reply has.
    private var pendingRuleCaret: (caret: Int, revision: UInt64)?
    /// The text an allowed input is about to insert, for opening a picker.
    private var pendingReplacement: String?
    private var rendering = false
    /// The text system's own selection colours, used without an accent.
    private lazy var defaultSelection = textView.selectedTextAttributes
    /// The text system's own insertion point colour, used without settings.
    private lazy var defaultCaret = textView.insertionPointColor
    /// 仅悬停时显示: the link drawn in its colour under the pointer, and the
    /// attributes that range had before.
    private var hoverHighlight: (range: NSRange, saved: NSAttributedString)?
    /// The link range drawn in its colour under the pointer, for acceptance.
    var hoverHighlightRange: NSRange? { hoverHighlight?.range }
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
    /// Copilot 修改 at the selection (or the caret's paragraph). Set by the
    /// tab host for chapter and drift bodies.
    var onCopilotInline: ((NSRange) -> Void)?
    var canCopilotInline: (() -> Bool)?
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

    // MARK: Reading aids

    /// The prose was scrolled (the 大纲轨道 follows the heading in view).
    var onScroll: (() -> Void)?
    /// A projection was rendered: headings may have changed.
    var onRendered: (() -> Void)?
    /// Ticks for comments, open TODOs and pending proposals beside the
    /// prose; none in a body that grows with its text (the 全书长卷).
    private(set) var markerStrip: ProseMarkerStrip?
    /// The rows of this body's comments, set by the tab host: a tick shows
    /// open notes and TODOs (resolved and decided ones leave). An anchor
    /// without a row yet shows as a note.
    var markerComments: [String: WorkspaceComment] = [:] {
        didSet { if markerComments != oldValue { scheduleMarkers() } }
    }
    /// The writing assistant's pending revisions of this body.
    var markerProposals: [ProseProposalAnchor] = [] {
        didSet { if markerProposals != oldValue { scheduleMarkers() } }
    }
    /// The ticks shown, in the order of their anchors.
    var markers: [ProseMarker] { markerStrip?.markers ?? [] }
    private var markerWork: DispatchWorkItem?
    /// Markers are placed shortly after the prose settles.
    var hasScheduledMarkers: Bool { markerWork != nil }
    static var markerDelay: TimeInterval = 0.3
    /// The last measured tick positions, reused while only typing changed
    /// the text: which ticks, the strip and prose widths, the text length
    /// then, and each tick's fraction. Measuring lays the text out.
    private var markerLayout: (signature: [String], size: NSSize, width: CGFloat, length: Int, fractions: [CGFloat])?
    /// Measurements of tick positions, for acceptance.
    private(set) var markerLayouts = 0

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
        textView.formatState = { [weak self] in self?.formatState($0) ?? .off }
        textView.canEditLink = { [weak self] in self?.canEditLink == true }
        textView.performEditLink = { [weak self] in self?.beginLink() }
        textView.canRemoveLink = { [weak self] in self?.canRemoveLink == true }
        textView.performRemoveLink = { [weak self] in self?.removeLink() }
        textView.onResign = { [weak self] in self?.closePicker() }
        textView.onMouseDown = { [weak self] in self?.deferredFormat = nil }
        textView.onResize = { [weak self] in self?.updateTextInsets() }
        textView.canPerformComment = { [weak self] in self?.canAddComment == true }
        textView.performComment = { [weak self] in self?.beginComment() }
        textView.canInsertRule = { [weak self] in self?.canInsertRule == true }
        textView.performInsertRule = { [weak self] in self?.insertRule() }
        textView.canPerformCopilot = { [weak self] in self?.canRequestCopilot == true }
        textView.performCopilot = { [weak self] in self?.requestCopilot() }
        textView.canPerformCopilotInline = { [weak self] in self?.canRequestCopilotInline == true }
        textView.performCopilotInline = { [weak self] in self?.requestCopilotInline() }
        textView.openLink = { [weak self] index in
            guard let self else { return false }
            return self.openLink(at: index) || self.openURLLink(at: index)
        }
        textView.hasLink = { [weak self] in self?.links(at: $0).isEmpty == false || self?.urlLink(at: $0) != nil }
        textView.onHover = { [weak self] in self?.hover(at: $0) }
        linkPreview.behavior = .semitransient
        linkPreview.animates = false
        scroll.documentView = textView
        status.textColor = .secondaryLabelColor
        status.setAccessibilityIdentifier("document-status")
        comments.textColor = .secondaryLabelColor
        comments.setAccessibilityIdentifier("document-comments")
        comments.isHidden = !allowsComments
        if !growsWithText { controls = ProseFormatControls() }
        let stack = NSStackView(views: (controls.map { [$0.historyRow, $0.formatsRow] } ?? []) + [scroll, comments, status])
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
        if !growsWithText {
            let strip = ProseMarkerStrip()
            strip.onClick = { [weak self] in self?.revealMarker($0) }
            addSubview(strip)
            markerStrip = strip
            scroll.contentView.postsBoundsChangedNotifications = true
            NotificationCenter.default.addObserver(self, selector: #selector(proseScrolled),
                                                   name: NSView.boundsDidChangeNotification, object: scroll.contentView)
        }
        if !growsWithText {
            let client = ProseFinderClient(textView: textView)
            let finder = NSTextFinder()
            finder.client = client
            finder.findBarContainer = scroll
            finder.isIncrementalSearchingEnabled = true
            finder.incrementalSearchingShouldDimContentView = true
            finderClient = client; textFinder = finder
            textView.textFinder = finder
        }
        pickerPopover.behavior = .applicationDefined
        pickerPopover.animates = false
        pickerPopover.contentViewController = pickerController
        pickerController.onChoose = { [weak self] in self?.choosePickerItem($0) }
        NotificationCenter.default.addObserver(self, selector: #selector(typographyChanged),
                                               name: DocumentStyle.typographyDidChange, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(editorPreferencesChanged),
                                               name: MacEditorPreferences.didChange, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(linkStyleChanged),
                                               name: DocumentStyle.linkStyleDidChange, object: nil)
        controls?.target = self
        binding.onProjection = { [weak self] in self?.render($0, changes: $1) }
        binding.onStatus = { [weak self] in self?.status.stringValue = $0 }
        binding.onEntityLinks = { [weak self] in self?.onEntityLinks?() }
        binding.onActivity = { [weak self] busy in
            guard let self else { return }
            self.updateEditability()
            self.updateActions()
            self.onActivity?(busy)
            self.runDeferredFormat()
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
        // The highlighted link's attributes come back before the text changes.
        clearHoverHighlight()
        if !changes.isEmpty { closeLinkPreview() }
        rendering = true
        var selection = textView.selectedRange()
        let scroll = textView.enclosingScrollView?.contentView.bounds.origin
        let replacedText = !NativeText.identical(textView.string, projection.text)
        if replacedText {
            for change in changes { selection = change.mapSelection(selection) }
            // Other input, undo, a remote or Agent write: an open picker's
            // range no longer names what the author typed.
            closePicker()
            textFinder?.noteClientStringWillChange()
            textView.string = projection.text
        }
        if let deferred = deferredFormat {
            deferredFormat = deferred.following(changes, replaced: replacedText, blocks: projection.blocks)
        }
        if let storage = textView.textStorage {
            lastStyleUpdate = DocumentStyle.update(projection, previous: replacedText ? nil : styledProjection,
                localChange: changes.count == 1 ? changes[0] : nil, to: storage, links: linkDirectory)
            styledProjection = projection
            onStyleUpdate?(lastStyleUpdate)
        }
        // A text that is one empty list item has no character to carry its marker.
        textView.emptyTextMarker = projection.text.isEmpty ? DocumentStyle.trailingMarker(projection) : nil
        comments.stringValue = projection.comments.map(\.summary).joined(separator: "\n")
        if reportedComments != projection.comments { reportedComments = projection.comments; onComments?() }
        if let anchored = binding.resolvedSelection(in: projection) { selection = anchored }
        var placedRuleCaret = false
        if let pending = pendingRuleCaret, projection.revision >= pending.revision {
            pendingRuleCaret = nil
            // Only the render of the rule reply itself places Rust's caret. A
            // later revision already holds typed input, whose mapped
            // selection is where the author is; the reply's caret is stale.
            if projection.revision == pending.revision {
                selection = NSRange(location: pending.caret, length: 0)
                placedRuleCaret = true
            }
        }
        let length = (projection.text as NSString).length
        let start = min(selection.location, length)
        textView.setSelectedRange(NSRange(location: start, length: min(selection.length, length - start)))
        binding.displayedSelection(textView.selectedRange())
        if let scroll { textView.enclosingScrollView?.contentView.scroll(to: scroll) }
        updateEditability()
        rendering = false
        if placedRuleCaret {
            // The caret follows the rule edit, and Rust learns this view's selection.
            binding.selectionChanged(textView.selectedRange(), text: textView.string, marked: false)
            textView.scrollRangeToVisible(textView.selectedRange())
        }
        updateFormatControls()
        fitTextHeight()
        if alignAfterRender || typewriterFollowsInput { alignAfterRender = false; scheduleTypewriterAlignment() }
        scheduleMarkers()
        onRendered?()
    }

    // MARK: Growing with the text

    override func layout() {
        super.layout()
        fitTextHeight()
        updateTextInsets()
        placeMarkerStrip()
    }

    // MARK: Markers and headings

    /// The strip runs down the prose's trailing edge, over the text
    /// container's inset, left of a scroller that takes room.
    private func placeMarkerStrip() {
        guard let strip = markerStrip, let superview = scroll.superview else { return }
        let frame = convert(scroll.frame, from: superview)
        let scroller = scroll.scrollerStyle == .legacy && scroll.hasVerticalScroller
            ? NSScroller.scrollerWidth(for: .regular, scrollerStyle: .legacy) : 0
        let border: CGFloat = scroll.borderType == .noBorder ? 0 : 1
        let placed = NSRect(x: frame.maxX - border - scroller - ProseMarkerStrip.width - 2, y: frame.minY + border + 4,
                            width: ProseMarkerStrip.width, height: max(0, frame.height - border * 2 - 8))
        if strip.frame != placed {
            strip.frame = placed
            scheduleMarkers()
        }
    }

    @objc private func proseScrolled() { onScroll?() }

    /// Places the ticks once the prose settles (layout is measured then).
    func scheduleMarkers() {
        guard markerStrip != nil else { return }
        markerWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.markerWork = nil
            self?.updateMarkers()
        }
        markerWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.markerDelay, execute: work)
    }

    /// The ticks of the displayed prose: open notes and TODOs at their
    /// anchors, and each pending proposal at the text it would replace.
    func updateMarkers() {
        markerWork?.cancel(); markerWork = nil
        guard let strip = markerStrip else { return }
        guard let projection = styledProjection, NativeText.identical(textView.string, projection.text), !textView.hasMarkedText() else {
            return
        }
        let text = projection.text as NSString
        var found: [(ProseMarker.Kind, String, NSRange, String)] = []
        for comment in projection.comments {
            let row = markerComments[comment.id]
            if let row {
                guard row.review == .open, !row.isCopilot || row.isOpenSuggestion else { continue }
            }
            guard let range = comment.ranges.first(where: { $0.length > 0 && NSMaxRange($0.nsRange) <= text.length })?.nsRange else { continue }
            let todo = row?.kind == "todo"
            let quote = comment.quote.isEmpty ? text.substring(with: range) : comment.quote
            let excerpt = quote.count > 24 ? String(quote.prefix(24)) + "…" : quote
            found.append((todo ? .todo : .comment, comment.id, range, "\(todo ? "待办" : "批注")「\(excerpt)」"))
        }
        for anchor in markerProposals where !anchor.text.isEmpty {
            var searched = NSRange(location: 0, length: text.length)
            while searched.length > 0 {
                let hit = text.range(of: anchor.text, options: .literal, range: searched)
                guard hit.location != NSNotFound else { break }
                found.append((.proposal, anchor.id, hit, anchor.label))
                guard anchor.all else { break }
                searched = NSRange(location: NSMaxRange(hit), length: text.length - NSMaxRange(hit))
            }
        }
        found.sort { ($0.2.location, $0.1) < ($1.2.location, $1.1) }
        guard !found.isEmpty else { strip.markers = []; markerLayout = nil; return }
        // Typing alone moves anchors little: the measured positions stay
        // until the ticks, the widths or much of the text change, so a
        // typing pause never lays out the whole text.
        let signature = found.map { "\($0.0.rawValue):\($0.1)" }
        let width = textView.textContainer?.size.width ?? textView.bounds.width
        if let layout = markerLayout, layout.signature == signature, layout.size == strip.frame.size, layout.width == width,
           abs(layout.length - text.length) <= max(200, layout.length / 20) {
            strip.markers = zip(found, layout.fractions).map { entry, fraction in
                ProseMarker(kind: entry.0, id: entry.1, range: entry.2, fraction: fraction, label: entry.3)
            }
            return
        }
        markerLayouts += 1
        let height = textView.proseDocumentHeight()
        let markers = found.map { kind, id, range, label in
            let top = textView.proseLineTop(at: range.location) ?? 0
            return ProseMarker(kind: kind, id: id, range: range, fraction: height > 0 ? min(1, max(0, top / height)) : 0, label: label)
        }
        markerLayout = (signature, strip.frame.size, width, text.length, markers.map(\.fraction))
        strip.markers = markers
    }

    /// A tick's click: its anchor is selected and scrolled into view.
    @discardableResult
    func revealMarker(_ marker: ProseMarker) -> Bool {
        guard !isInteractionLocked, !textView.hasMarkedText(), let projection = styledProjection,
              NativeText.identical(textView.string, projection.text),
              NSMaxRange(marker.range) <= (projection.text as NSString).length else { return false }
        textView.setSelectedRange(marker.range)
        binding.selectionChanged(marker.range, text: projection.text, marked: false)
        textView.scrollRangeToVisible(marker.range)
        focus()
        return true
    }

    /// The body's headings as the prose shows them: identity (nil while a
    /// heading being typed has none), UTF-16 location, level and text.
    func headings() -> [(id: String?, location: Int, level: Int, title: String)] {
        let text = binding.displayedText as NSString
        return binding.displayedBlocks.compactMap { block in
            guard block.kind == "heading", block.editable, NSMaxRange(block.range.nsRange) <= text.length else { return nil }
            let title = text.substring(with: block.range.nsRange).trimmingCharacters(in: .whitespacesAndNewlines)
            return (block.id, block.range.location, block.headingLevel, title)
        }
    }

    /// The first character at the top of the visible prose.
    var firstVisibleLocation: Int { textView.proseFirstVisibleLocation() }

    /// The character at the bottom of the visible prose once it is scrolled
    /// to its end (a heading in the last screenful cannot reach the top);
    /// nil while there is more below or the prose does not scroll.
    var endVisibleLocation: Int? {
        let clip = scroll.contentView
        guard textView.frame.height > clip.bounds.height + 1, clip.bounds.maxY >= textView.frame.height - 1 else { return nil }
        let visible = textView.visibleRect
        return textView.characterIndexForInsertion(at: NSPoint(x: textView.textContainerOrigin.x + 1, y: visible.maxY - 4))
    }

    /// Scrolls the line holding a location to the top of the visible prose
    /// and puts the caret there (a heading of the 大纲轨道).
    @discardableResult
    func scrollToLine(at location: Int, focusing: Bool = true) -> Bool {
        let length = (textView.string as NSString).length
        guard location >= 0, location <= length, !textView.hasMarkedText() else { return false }
        if focusing, !isInteractionLocked {
            let caret = NSRange(location: location, length: 0)
            textView.setSelectedRange(caret)
            binding.selectionChanged(caret, text: textView.string, marked: false)
        }
        guard let top = textView.proseLineTop(at: location) else { return false }
        // The whole text is laid out first, so the scroll is not held to an
        // estimated height (TextKit 2 lays out lazily).
        _ = textView.proseDocumentHeight()
        textView.sizeToFit()
        let clip = scroll.contentView
        // The line sits just above the reading line, so it reads as current.
        let y = max(0, top - (NSTextView.proseReadingLine - 4))
        let target = clip.constrainBoundsRect(NSRect(origin: NSPoint(x: clip.bounds.origin.x, y: y), size: clip.bounds.size)).origin
        clip.scroll(to: target)
        scroll.reflectScrolledClipView(clip)
        if focusing { focus() }
        return true
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
        // New typography moves every line: the ticks are measured again.
        markerLayout = nil
        scheduleMarkers()
    }

    @objc private func editorPreferencesChanged() { applyEditorPreferences() }

    /// 设置 › 编辑器 › 链接样式 changed: the prose restyles in place.
    @objc private func linkStyleChanged() { restyleLinks() }

    /// Spelling, the selection wash and the caret colour follow 设置.
    private func applyEditorPreferences() {
        if let spelling = MacEditorPreferences.spellChecking, textView.isContinuousSpellCheckingEnabled != spelling {
            textView.isContinuousSpellCheckingEnabled = spelling
        }
        var selected = defaultSelection
        if let accent = MacEditorPreferences.accentColor { selected[.backgroundColor] = accent.withAlphaComponent(0.28) }
        textView.selectedTextAttributes = selected
        let caret = MacEditorPreferences.caretColor ?? defaultCaret
        if textView.insertionPointColor != caret { textView.insertionPointColor = caret }
        updateTextInsets()
    }

    // MARK: 打字机滚动

    /// Where the middle of the caret line sits, from the top of the visible
    /// prose: 设置's 打字机位置, else 40%.
    static var typewriterPosition: CGFloat { min(max(MacEditorPreferences.typewriterPosition ?? 0.4, 0.05), 0.95) }
    var typewriterEnabled: Bool { MacEditorPreferences.typewriterScrolling == true }

    /// The scroll view that follows the caret: the prose's own, or the long
    /// scroll a growing body sits in (the 全书长卷).
    private var typewriterScroll: NSScrollView? { growsWithText ? enclosingScrollView : scroll }

    /// The side inset that centres a 版心宽度 column in the prose; at least
    /// 20 points. A growing body (the 全书长卷) is laid out at its column already.
    var columnInset: CGFloat {
        guard !growsWithText, let column = MacEditorPreferences.columnWidth else { return 20 }
        let width = textView.frame.width
        guard width > 1 else { return 20 }
        return max(20, ((width - column) / 2).rounded(.down))
    }

    /// The width of the prose's text column, in points.
    var textColumnWidth: CGFloat { textView.textContainer?.size.width ?? 0 }

    /// The container inset: the 版心宽度 column centred at the sides, and
    /// room below the text so the last line can reach the typewriter height
    /// (the container grows while the text keeps its top origin). Not a
    /// scroll view inset, which the text system would treat as covered and
    /// scroll the caret out of. A growing body leaves its long scroll alone.
    private func updateTextInsets() {
        let tail = !growsWithText && typewriterEnabled ? ceil(scroll.contentView.bounds.height * (1 - Self.typewriterPosition)) : 0
        let inset = NSSize(width: columnInset, height: ProseTextView.topInset + tail / 2)
        guard textView.textContainerInset != inset else { return }
        let widthChanged = textView.textContainerInset.width != inset.width
        textView.textContainerInset = inset
        // The container follows the view's width only when that changes.
        if widthChanged, let container = textView.textContainer, textView.bounds.width > 1 {
            container.containerSize = NSSize(width: max(1, textView.bounds.width - inset.width * 2), height: container.containerSize.height)
        }
        if growsWithText { fitTextHeight() } else { textView.sizeToFit() }
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
        clearHoverHighlight()
        guard let projection = styledProjection, let storage = textView.textStorage else { return }
        guard !textView.hasMarkedText(), NativeText.identical(textView.string, projection.text) else { styledProjection = nil; return }
        DocumentStyle.apply(projection, to: storage, links: linkDirectory)
        textView.emptyTextMarker = projection.text.isEmpty ? DocumentStyle.trailingMarker(projection) : nil
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
        updateHoverHighlight(at: index)
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

    /// 仅悬停时显示: the link under the pointer is drawn as 按分类着色 draws
    /// it, the whole link across its runs; leaving it restores the prose.
    /// Only while the prose is settled: nothing queued or marked, the text
    /// as last styled. Any edit restores it first (`clearHoverHighlight`).
    private func updateHoverHighlight(at index: Int?) {
        guard DocumentStyle.linkStyle.mode == .hover, let index, !textView.hasMarkedText(), !binding.hasPendingWork,
              let projection = styledProjection, NativeText.identical(textView.string, projection.text),
              let storage = textView.textStorage, let (range, links) = entityLinkRange(at: index, in: projection),
              let attributes = DocumentStyle.hoverLinkAttributes(links, directory: linkDirectory),
              NSMaxRange(range) <= storage.length else { clearHoverHighlight(); return }
        guard hoverHighlight?.range != range else { return }
        clearHoverHighlight()
        hoverHighlight = (range, storage.attributedSubstring(from: range))
        storage.addAttributes(attributes, range: range)
    }

    /// Puts back the attributes the highlighted link had. Called before any
    /// text change, so the range still holds the same text.
    private func clearHoverHighlight() {
        guard let (range, saved) = hoverHighlight else { return }
        hoverHighlight = nil
        guard let storage = textView.textStorage, NSMaxRange(range) <= storage.length,
              storage.attributedSubstring(from: range).string == saved.string else {
            // The next render styles everything again.
            styledProjection = nil; return
        }
        storage.beginEditing()
        saved.enumerateAttributes(in: NSRange(location: 0, length: saved.length)) { attributes, part, _ in
            storage.setAttributes(attributes, range: NSRange(location: range.location + part.location, length: part.length))
        }
        storage.endEditing()
    }

    /// The whole entity link around a character: the adjacent runs of its
    /// block that carry the same link marks.
    private func entityLinkRange(at index: Int, in projection: NativeProjection) -> (NSRange, [NativeEntityLink])? {
        guard let block = projection.blocks.first(where: { $0.range.location <= index && index < NSMaxRange($0.range.nsRange) }),
              let at = block.runs.firstIndex(where: { $0.range.location <= index && index < NSMaxRange($0.range.nsRange) }) else { return nil }
        let links = block.runs[at].attributes.links
        guard !links.isEmpty else { return nil }
        var first = at, last = at
        while first > 0, block.runs[first - 1].attributes.links == links,
              NSMaxRange(block.runs[first - 1].range.nsRange) == block.runs[first].range.location { first -= 1 }
        while last + 1 < block.runs.count, block.runs[last + 1].attributes.links == links,
              block.runs[last + 1].range.location == NSMaxRange(block.runs[last].range.nsRange) { last += 1 }
        let start = block.runs[first].range.location
        return (NSRange(location: start, length: NSMaxRange(block.runs[last].range.nsRange) - start), links)
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
        if window == nil { closeLinkPreview(); closePicker() }
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

    // MARK: URL links

    /// The URL link address on the displayed character at a UTF-16 index.
    func urlLink(at index: Int) -> String? { run(at: index)?.attributes.href }

    /// ⌘-click or 打开链接: opens a URL link's http, https or mailto address
    /// through `openURL`; the caret and the prose stay as they are.
    @discardableResult
    func openURLLink(at index: Int) -> Bool {
        guard !textView.hasMarkedText(), let href = urlLink(at: index) else { return false }
        guard let url = ProseLinkAddress.openable(href) else { status.stringValue = "无法打开这个链接地址：\(href)"; return false }
        Self.openURL(url)
        return true
    }

    @objc private func openURLItem(_ sender: NSMenuItem) {
        guard let href = sender.representedObject as? String, let url = ProseLinkAddress.openable(href) else { return }
        Self.openURL(url)
    }

    /// 链接…: a selection, or a caret inside a URL link (which selects it).
    var canEditLink: Bool {
        guard !isInteractionLocked, !textView.hasMarkedText() else { return false }
        let range = textView.selectedRange()
        return binding.canLink(range: range) || (range.length == 0 && binding.canRemoveLink(range: range))
    }
    var canRemoveLink: Bool {
        !isInteractionLocked && !textView.hasMarkedText() && binding.canRemoveLink(range: textView.selectedRange())
    }

    /// Opens 链接… for the selection, prefilled from its link or a selected
    /// address. The range and revision are captured now; if the prose changes
    /// first, the command is refused and the sheet keeps the typed address.
    @objc func beginLink() {
        guard canEditLink, linkSheet == nil, let projection = binding.store.projection else { return }
        var range = textView.selectedRange()
        if range.length == 0, let around = projection.urlLinkRange(around: range.location) {
            range = around
            textView.setSelectedRange(range)
            binding.selectionChanged(range, text: textView.string, marked: false)
        }
        guard range.length > 0 else { return }
        let revision = projection.revision
        let existing = projection.urlLink(in: range)
        let selected = (projection.text as NSString).substring(with: range)
        let prefill = existing ?? (ProseLinkAddress.looksLikeAddress(selected) ? selected.trimmingCharacters(in: .whitespacesAndNewlines) : "")
        let sheet = MacLinkSheetController(address: prefill, hasLink: existing != nil, quote: selected)
        sheet.onSubmit = { [weak self] href, done in
            guard let self else { done(LabError.message("编辑栏已关闭，链接未设置。")); return }
            guard self.binding.store.projection?.revision == revision else {
                done(LabError.message("正文已变化，请重新选择要加链接的文字。")); return
            }
            self.binding.link(range: range, href: href) { done($0) }
        }
        sheet.onFinish = { [weak self] in
            guard let self else { return }
            self.linkSheet = nil
            self.focus()
        }
        linkSheet = sheet
        if let window, window.isVisible { sheet.present(on: window) }
    }

    /// 移除链接: the URL links of the selection, or the whole link around the caret.
    @objc func removeLink() {
        guard canRemoveLink else { return }
        let range = textView.selectedRange()
        focus()
        binding.link(range: range, href: nil)
    }

    // MARK: Slash menu and @ picker

    /// After committed input or a caret move: open a picker when its
    /// trigger was just typed, else follow or close the open one.
    private func updatePicker(typed: String?) {
        guard !textView.hasMarkedText() else { return }
        let text = textView.string as NSString
        let selection = textView.selectedRange()
        guard var session = picker else {
            guard let typed, selection.length == 0, selection.location >= 1, !isInteractionLocked else { return }
            let trigger = selection.location - 1
            let character = text.substring(with: NSRange(location: trigger, length: 1))
            guard typed.hasSuffix(character) else { return }
            if ProsePickers.slashTriggers.contains(character), slashAllowed(trigger: trigger, caret: selection.location) {
                picker = ProsePickerSession(kind: .slash, trigger: trigger, triggerCharacter: character, query: "", items: [], selected: 0)
            } else if ProsePickers.mentionTriggers.contains(character), mentionSource != nil,
                      ProsePickers.opensMention(after: trigger > 0 ? text.character(at: trigger - 1) : nil) {
                picker = ProsePickerSession(kind: .mention, trigger: trigger, triggerCharacter: character, query: "", items: [], selected: 0)
            } else { return }
            updatePicker(typed: nil)
            return
        }
        // The caret stays right after the trigger and the query typed since.
        let caret = selection.location
        guard selection.length == 0, session.trigger < text.length, caret > session.trigger,
              text.substring(with: NSRange(location: session.trigger, length: 1)) == session.triggerCharacter else { closePicker(); return }
        let query = text.substring(with: NSRange(location: session.trigger + 1, length: caret - session.trigger - 1))
        guard query.rangeOfCharacter(from: ProsePickers.queryEnds) == nil, (query as NSString).length <= ProsePickers.maximumQuery,
              session.kind == .mention || slashAllowed(trigger: session.trigger, caret: caret) else { closePicker(); return }
        let items = session.kind == .slash
            ? ProsePickers.slashItems(query: query, blocks: binding.displayedBlocks,
                                      at: NativeLayout.index(session.trigger, blocks: binding.displayedBlocks))
            : ProsePickers.mentionItems(query: query, source: mentionSource?() ?? .empty, canCreate: onCreateElement != nil)
        if query != session.query || items != session.items { session.selected = 0; session.navigated = false }
        session.query = query; session.items = items
        session.selected = max(0, min(session.selected, items.count - 1))
        guard !items.isEmpty else {
            // The slash menu closes. The @ picker goes inert: hidden, keys
            // left to the text, shown again when ⌫ brings back a query
            // that names something.
            if session.kind == .slash { closePicker(); return }
            picker = session
            if pickerPopover.isShown { pickerPopover.performClose(nil) }
            return
        }
        picker = session
        showPicker()
    }

    /// An open picker with rows (not an inert @ session).
    var isPickerActive: Bool { picker?.items.isEmpty == false }

    /// The slash menu opens only at the start of an otherwise empty
    /// paragraph or heading, with the caret at its end.
    private func slashAllowed(trigger: Int, caret: Int) -> Bool {
        let text = textView.string as NSString
        guard trigger == 0 || text.character(at: trigger - 1) == 10 else { return false }
        guard caret == text.length || text.character(at: caret) == 10 else { return false }
        let blocks = binding.displayedBlocks
        guard NativeText.identical(binding.displayedText, textView.string), let index = NativeLayout.index(trigger, blocks: blocks) else {
            return false
        }
        let block = blocks[index]
        return block.editable && (block.kind == "paragraph" || block.kind == "heading")
    }

    private func showPicker() {
        guard let picker else { return }
        pickerController.show(picker.items, selected: picker.selected)
        guard let window = textView.window, window.isVisible else { return }
        pickerPopover.contentSize = pickerController.preferredContentSize
        guard !pickerPopover.isShown else { return }
        let screen = textView.firstRect(forCharacterRange: NSRange(location: picker.trigger, length: 1), actualRange: nil)
        let rect = textView.convert(window.convertFromScreen(screen), from: nil)
        pickerPopover.show(relativeTo: rect, of: textView, preferredEdge: .maxY)
    }

    /// Esc, a caret moved away or lost focus: the typed text stays.
    func closePicker() {
        picker = nil
        if pickerPopover.isShown { pickerPopover.performClose(nil) }
    }

    /// ↑ and ↓ move through the rows, Return chooses, Esc closes; other
    /// keys go to the text. With marked text the input method keeps them.
    /// Return takes a ＋ 新建设定 row only once ↑ or ↓ moved to it; otherwise
    /// it closes the picker and types a new line.
    private func pickerCommand(_ selector: Selector) -> Bool {
        guard var session = picker, !session.items.isEmpty else { return false }
        switch selector {
        case #selector(NSResponder.moveDown(_:)):
            session.selected = (session.selected + 1) % session.items.count
            session.navigated = true
        case #selector(NSResponder.moveUp(_:)):
            session.selected = (session.selected - 1 + session.items.count) % session.items.count
            session.navigated = true
        case #selector(NSResponder.insertNewline(_:)):
            if case .createElement = session.items[session.selected].action, !session.navigated { closePicker(); return false }
            choosePickerItem(session.selected); return true
        case #selector(NSResponder.cancelOperation(_:)):
            closePicker(); return true
        default: return false
        }
        picker = session
        showPicker()
        return true
    }

    /// Choosing replaces the trigger and query through the normal input
    /// path: a format then applies once that input lands; a name is linked
    /// by the link pass, as typed names are. Only while the trigger and the
    /// query are still in place with the caret after them; otherwise the
    /// picker closes and nothing is edited.
    func choosePickerItem(_ index: Int) {
        guard let session = picker, session.items.indices.contains(index) else { return }
        closePicker()
        let text = textView.string as NSString
        guard NSMaxRange(session.range) <= text.length,
              text.substring(with: session.range) == session.triggerCharacter + session.query,
              textView.selectedRange() == NSRange(location: NSMaxRange(session.range), length: 0) else { return }
        switch session.items[index].action {
        case .format(let action):
            // The typed “/query” stays when the format cannot apply here.
            let blocks = binding.displayedBlocks
            guard let block = NativeLayout.index(session.trigger, blocks: blocks),
                  ProsePickers.formatApplies(action, at: block, in: blocks) else {
                status.stringValue = "这里不能设为\(action.title)，输入的文字已保留。"
                return
            }
            guard replaceThroughInput(session.range, with: "") else { return }
            formatWhenIdle(action)
        case .rule:
            guard replaceThroughInput(session.range, with: "") else { return }
            commandWhenIdle(.insertRule)
        case .mention(let name, _, _):
            guard replaceThroughInput(session.range, with: name) else { return }
            binding.store.requestEntityLinks()
        case .createElement(let name, let categoryID):
            guard let onCreateElement else { return }
            let range = session.range
            let typed = (textView.string as NSString).substring(with: range)
            onCreateElement(name, categoryID) { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(let element):
                    let text = self.textView.string as NSString
                    // Inserted only while the typed query is still in place,
                    // leaving the author's caret or selection where it is now.
                    if NSMaxRange(range) <= text.length, text.substring(with: range) == typed,
                       self.replaceThroughInput(range, with: element.name, keepingSelection: true) {
                        self.binding.store.requestEntityLinks()
                    }
                case .failure(let error):
                    self.status.stringValue = error.localizedDescription
                }
            }
        }
    }

    /// Replaces text as typing does: the text system asks the binding, then
    /// the change is submitted as one input event. The caret goes after the
    /// replacement, or with `keepingSelection` (a reply that arrives later)
    /// the selection stays where the author left it, shifted when it lies
    /// after the range; only a caret still at the range's end follows it.
    @discardableResult
    private func replaceThroughInput(_ range: NSRange, with replacement: String, keepingSelection: Bool = false) -> Bool {
        guard !isInteractionLocked, textView.isEditable, !textView.hasMarkedText(),
              NSMaxRange(range) <= (textView.string as NSString).length,
              textView.shouldChangeText(in: range, replacementString: replacement) else { return false }
        let inserted = (replacement as NSString).length
        var selection = NSRange(location: range.location + inserted, length: 0)
        if keepingSelection {
            let before = textView.selectedRange()
            func map(_ point: Int) -> Int {
                if point >= NSMaxRange(range) { return point + inserted - range.length }
                return point <= range.location ? point : range.location + inserted
            }
            let start = map(before.location)
            selection = NSRange(location: start, length: max(0, map(NSMaxRange(before)) - start))
        }
        textView.replaceCharacters(in: range, with: replacement)
        textView.setSelectedRange(selection)
        textView.didChangeText()
        return true
    }

    /// A block command that waits for queued input (Tab typed right after
    /// text, a slash row, the split after Return in a list item, a rule):
    /// it runs once the owner is idle, only on the blocks the selection
    /// touched when it was given. Any later input or key command, a click in
    /// the prose, a failed draft or save, and a render that removed one of
    /// those blocks drop it. False when it neither ran nor waits.
    @discardableResult
    private func formatWhenIdle(_ action: NativeFormatAction) -> Bool { commandWhenIdle(.format(action)) }

    @discardableResult
    private func commandWhenIdle(_ command: DeferredBlockFormat.Command) -> Bool {
        if canPerform(command) { perform(command); return true }
        deferredFormat = nil
        guard binding.store.hasQueuedInput, binding.canEdit, !binding.hasFailedDraft,
              NativeText.identical(binding.displayedText, textView.string) else { return false }
        deferredFormat = DeferredBlockFormat(command: command, selection: textView.selectedRange(), blocks: binding.displayedBlocks)
        return deferredFormat != nil
    }

    private func canPerform(_ command: DeferredBlockFormat.Command) -> Bool {
        switch command {
        case .format(let action): return canPerformFormat(action)
        case .insertRule: return canInsertRule
        case .removeRule(let forward): return removableRuleBeside(forward: forward) != nil
        }
    }

    private func perform(_ command: DeferredBlockFormat.Command) {
        switch command {
        case .format(let action): performFormat(action)
        case .insertRule: insertRule()
        case .removeRule(let forward):
            guard let rule = removableRuleBeside(forward: forward) else { return }
            // ⌦ removes what lies after the caret, so the caret stays put.
            removeRule(at: rule.range.location, keepCaret: forward ? textView.selectedRange().location : nil)
        }
    }

    private func runDeferredFormat() {
        guard let deferred = deferredFormat else { return }
        if binding.hasFailedDraft || !binding.canEdit { deferredFormat = nil; return }
        guard !binding.hasPendingWork else { return }
        deferredFormat = nil
        guard let projection = binding.store.projection, NativeText.identical(textView.string, projection.text),
              deferred.applies(to: projection.blocks, selection: textView.selectedRange()), canPerform(deferred.command) else { return }
        perform(deferred.command)
    }

    // MARK: Horizontal rules

    /// 插入分隔线: after the caret's top-level block, or before an empty
    /// top-level paragraph (the caret stays in it).
    var canInsertRule: Bool {
        !isInteractionLocked && !textView.hasMarkedText() && binding.canInsertRule(range: textView.selectedRange())
    }

    func insertRule() {
        guard canInsertRule else { return }
        let range = textView.selectedRange()
        focus()
        binding.insertRule(range: range) { [weak self] result in self?.ruleEdited(result) }
    }

    /// 删除分隔线 (a rule's context menu), ⌫ right after a rule and ⌦ right
    /// before one. The caret follows Rust's reply.
    /// `keepCaret`: ⌦ keeps the caret, which lies before the removed rule.
    func removeRule(at location: Int, keepCaret: Int? = nil) {
        guard !isInteractionLocked, !textView.hasMarkedText(), binding.removableRule(at: location) != nil else { return }
        focus()
        binding.removeRule(at: location) { [weak self] result in self?.ruleEdited(result, keepCaret: keepCaret) }
    }

    private func ruleEdited(_ result: Result<Int, Error>, keepCaret: Int? = nil) {
        guard case .success(let caret) = result else { return }
        pendingRuleCaret = (keepCaret ?? caret, binding.state?.projection.revision ?? 0)
    }

    /// The rule ⌫ or ⌦ would remove at the caret, on the idle owner's projection.
    private func removableRuleBeside(forward: Bool) -> NativeBlock? {
        guard !isInteractionLocked, !textView.hasMarkedText(), binding.canEdit, !binding.hasPendingWork,
              let projection = binding.store.projection, NativeText.identical(textView.string, projection.text) else { return nil }
        return projection.ruleBeside(caret: textView.selectedRange(), forward: forward)
    }

    /// Whether ⌫ or ⌦ at the displayed caret meets a rule (also while typed
    /// text is still on its way).
    private func displayedRuleBeside(forward: Bool) -> Bool {
        guard !textView.hasMarkedText(), !isInteractionLocked, textView.isEditable, binding.canEdit, !binding.hasFailedDraft,
              NativeText.identical(binding.displayedText, textView.string) else { return false }
        let blocks = binding.displayedBlocks, selection = textView.selectedRange()
        guard selection.length == 0, let index = NativeLayout.index(selection.location, blocks: blocks) else { return false }
        let block = blocks[index]
        if block.kind == "horizontalRule" { return true }
        if forward {
            return selection.location == NSMaxRange(block.range.nsRange) && blocks.indices.contains(index + 1)
                && blocks[index + 1].kind == "horizontalRule"
        }
        return selection.location == block.range.location && index > 0 && blocks[index - 1].kind == "horizontalRule"
    }

    @objc private func removeRuleItem(_ sender: NSMenuItem) {
        guard let location = sender.representedObject as? Int else { return }
        removeRule(at: location)
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

    var canRequestCopilotInline: Bool {
        onCopilotInline != nil && !isInteractionLocked && !textView.hasMarkedText() && canCopilotInline?() == true
    }

    /// Copilot 修改: the tab host opens its popover at the selection.
    @objc func requestCopilotInline() {
        guard canRequestCopilotInline else { return }
        onCopilotInline?(textView.selectedRange())
    }

    /// A message in the editor's status line.
    func showStatus(_ text: String) { status.stringValue = text }

    /// The prose context menu's 格式 submenu: the 格式 menu's commands on
    /// this editor, validated and checked against the selection.
    private func formatMenuItem() -> NSMenuItem {
        let submenu = NSMenu(title: "格式")
        let groups: [[MacMenuCommand]] = [[.bold, .italic, .underline, .strike], [.bodyText, .heading1, .heading2, .heading3],
                                          [.blockquote, .bulletList, .orderedList, .insertRule], [.alignLeft, .alignCenter, .alignRight],
                                          [.indentIncrease, .indentDecrease], [.link, .removeLink]]
        for (index, group) in groups.enumerated() {
            if index > 0 { submenu.addItem(.separator()) }
            for command in group {
                let item = NSMenuItem(title: command.title, action: command.responderAction, keyEquivalent: "")
                item.target = textView
                item.setAccessibilityIdentifier("context-\(command.rawValue)")
                submenu.addItem(item)
            }
        }
        let item = NSMenuItem(title: "格式", action: nil, keyEquivalent: "")
        item.submenu = submenu
        item.setAccessibilityIdentifier("context-format")
        return item
    }

    func textView(_ view: NSTextView, menu: NSMenu, for event: NSEvent, at charIndex: Int) -> NSMenu? {
        closePicker()
        var leading: [NSMenuItem] = linkMenuItems(at: charIndex)
        if let href = urlLink(at: charIndex) {
            let item = NSMenuItem(title: "打开链接", action: #selector(openURLItem(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = href
            item.toolTip = href
            item.isEnabled = ProseLinkAddress.openable(href) != nil
            item.setAccessibilityIdentifier("context-open-url")
            leading.append(item)
        }
        if let rule = binding.store.projection?.rule(at: charIndex), NativeText.identical(textView.string, binding.displayedText) {
            let item = NSMenuItem(title: "删除分隔线", action: #selector(removeRuleItem(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = rule.range.location
            item.isEnabled = binding.removableRule(at: rule.range.location) != nil && !isInteractionLocked
            item.setAccessibilityIdentifier("context-remove-rule")
            leading.append(item)
        }
        leading.append(formatMenuItem())
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
        if canRequestCopilotInline {
            let item = NSMenuItem(title: "Copilot 修改…", action: #selector(requestCopilotInline), keyEquivalent: "")
            item.target = self
            item.setAccessibilityIdentifier("context-copilot-inline")
            item.toolTip = "让 Copilot 局部修改选中的文字（或光标所在段落），就它提问，或生成摘要（⌃⌘I）"
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
        clearHoverHighlight()
        let allowed = binding.prepareInput(affectedCharRange, replacement: replacementString, marked: textView.hasMarkedText())
        if allowed {
            textFinder?.noteClientStringWillChange(); pendingReplacement = replacementString
            // Typing on in the block a waiting command was given for (also
            // an input method's marked text) keeps it; a new line or an edit
            // elsewhere drops it.
            if let deferred = deferredFormat,
               !deferred.survives(affectedCharRange, replacement: replacementString, in: textView.string, blocks: binding.displayedBlocks) {
                deferredFormat = nil
            }
        }
        return allowed
    }

    /// Tab and ⇧Tab indent the block (never a tab character), as in the
    /// renderer; ↑, ↓, Return and Esc drive an open picker. Return on an
    /// empty last quote paragraph or list item, and ⌫ at the start of a
    /// quote's first paragraph or of the first or last list item, take the
    /// block out of its quote or list.
    func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if !textView.hasMarkedText(), pickerCommand(commandSelector) { return true }
        switch commandSelector {
        case #selector(NSResponder.insertTab(_:)), #selector(NSResponder.insertBacktab(_:)):
            guard textView.isEditable else { return false }
            if !textView.hasMarkedText(), !isInteractionLocked {
                formatWhenIdle(commandSelector == #selector(NSResponder.insertTab(_:)) ? .indentIncrease : .indentDecrease)
            }
            return true
        case #selector(NSResponder.insertNewline(_:)):
            if let action = containerExit(onReturn: true), formatWhenIdle(action) { return true }
            deferredFormat = nil
            // In a non-empty list item the new paragraph becomes the next item.
            splitsAfterNewline = splitsListItemOnReturn()
            return false
        case #selector(NSResponder.deleteBackward(_:)):
            if let action = containerExit(onReturn: false), formatWhenIdle(action) { return true }
            if displayedRuleBeside(forward: false), commandWhenIdle(.removeRule(forward: false)) { return true }
            deferredFormat = nil
            return false
        case #selector(NSResponder.deleteForward(_:)):
            if displayedRuleBeside(forward: true), commandWhenIdle(.removeRule(forward: true)) { return true }
            deferredFormat = nil
            return false
        default:
            // Every other key command moves the caret or edits: a block
            // command still waiting for input no longer applies.
            deferredFormat = nil
            return false
        }
    }

    /// The quote or list a key takes the caret's block out of, if any.
    /// Return: an empty paragraph that is the last of its quote (lifted), or
    /// an empty paragraph that is the last of a list's last item, also in an
    /// item of several paragraphs (`exitList`: it goes after the list, with
    /// its item when that is left empty). ⌫ at the start of a quote's first
    /// paragraph, or of a list item's only paragraph when the item is its
    /// list's first or last. Rust decides; a block in a nested quote or
    /// list, or with a selection, keeps the ordinary key.
    private func containerExit(onReturn: Bool) -> NativeFormatAction? {
        guard !textView.hasMarkedText(), !isInteractionLocked, textView.isEditable, binding.canEdit, !binding.hasFailedDraft,
              NativeText.identical(binding.displayedText, textView.string) else { return nil }
        let selection = textView.selectedRange()
        let blocks = binding.displayedBlocks
        guard selection.length == 0, let index = NativeLayout.index(selection.location, blocks: blocks) else { return nil }
        let block = blocks[index]
        guard block.acceptsBlockAttributes, let kind = block.rootContainer,
              onReturn ? block.range.length == 0 : selection.location == block.range.location else { return nil }
        let previous = index > 0 ? blocks[index - 1] : nil
        let next = blocks.indices.contains(index + 1) ? blocks[index + 1] : nil
        let action: NativeFormatAction = kind == "blockquote" ? .blockquote : (kind == "orderedList" ? .orderedList : .bulletList)
        if kind == "blockquote" {
            return onReturn ? (next?.container == block.container ? nil : action) : (previous?.container == block.container ? nil : action)
        }
        // Return: the empty last paragraph of the list's last item.
        if onReturn { return NativeLayout.lastOfList(blocks, at: index) ? .exitList : nil }
        // ⌫: a list item's only paragraph, in the first or the last item
        // (the block before or after is not an item of this shape).
        guard previous?.container != block.container, next?.container != block.container else { return nil }
        let last = next?.containers != block.containers, first = previous?.containers != block.containers
        return last || first ? action : nil
    }

    /// Return in a non-empty list item whose paragraph is its item's last:
    /// once the new paragraph lands it becomes the next item. An empty item
    /// keeps the ordinary Return (its list ends when it is the last).
    private func splitsListItemOnReturn() -> Bool {
        guard !textView.hasMarkedText(), !isInteractionLocked, textView.isEditable, binding.canEdit, !binding.hasFailedDraft,
              NativeText.identical(binding.displayedText, textView.string) else { return false }
        let selection = textView.selectedRange(), blocks = binding.displayedBlocks
        guard let index = NativeLayout.index(selection.location, blocks: blocks),
              NativeLayout.index(NSMaxRange(selection), blocks: blocks) == index else { return false }
        let block = blocks[index]
        guard block.acceptsBlockAttributes, block.range.length > 0,
              block.rootContainer == "bulletList" || block.rootContainer == "orderedList" else { return false }
        // Not its item's last child (a nested list follows inside the item):
        // Return keeps the ordinary new line.
        return NativeLayout.lastInItem(blocks, at: index)
    }

    /// Markdown-style starts, as in the renderer: “> ”, “- ” (“+ ”, “* ”)
    /// or “1. ” typed as the whole text before the caret in a root
    /// paragraph removes the marker through the input path, then applies
    /// 引用 or the list once that input lands (two undo units), as a slash
    /// row does. Checked once the keystroke has finished.
    private func scheduleMarkdownStart(typed: String) {
        guard let space = typed.last, ProseMarkdownStarts.spaces.contains(space), !textView.hasMarkedText(), !isInteractionLocked,
              NativeText.identical(binding.displayedText, textView.string) else { return }
        let selection = textView.selectedRange()
        let blocks = binding.displayedBlocks
        guard selection.length == 0, let index = NativeLayout.index(selection.location, blocks: blocks) else { return }
        let block = blocks[index]
        guard block.editable, block.kind == "paragraph", block.containers.isEmpty, block.depth == 0,
              selection.location > block.range.location else { return }
        let marker = NSRange(location: block.range.location, length: selection.location - block.range.location)
        let snapshot = textView.string
        guard let action = ProseMarkdownStarts.action(for: (snapshot as NSString).substring(with: marker)) else { return }
        pendingMarkdownStarts += 1
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.pendingMarkdownStarts -= 1
            // Only while the marker and the caret after it are as typed, and
            // only when the format applies there: otherwise the marker stays.
            let blocks = self.binding.displayedBlocks
            guard NativeText.identical(self.textView.string, snapshot), self.textView.selectedRange() == selection,
                  !self.textView.hasMarkedText(), let at = NativeLayout.index(marker.location, blocks: blocks),
                  ProsePickers.formatApplies(action, at: at, in: blocks),
                  self.replaceThroughInput(marker, with: "") else { return }
            self.formatWhenIdle(action)
        }
    }
    /// Markdown starts typed but not yet checked, for acceptance.
    private(set) var pendingMarkdownStarts = 0

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
        let typed = marked ? nil : pendingReplacement
        if !marked { pendingReplacement = nil }
        let splits = splitsAfterNewline
        splitsAfterNewline = false
        if splits, typed == "\n" { commandWhenIdle(.format(.splitListItem)) }
        updatePicker(typed: typed)
        if let typed { scheduleMarkdownStart(typed: typed) }
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
        if picker != nil { updatePicker(typed: nil) }
        // The controls follow the caret; typed text refreshes them with its reply.
        if !marked, !binding.hasPendingWork { updateFormatControls() }
    }
    func canPerformHistory(redo: Bool) -> Bool {
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
    func canPerformFormat(_ action: NativeFormatAction) -> Bool {
        !isInteractionLocked && !textView.hasMarkedText() && binding.canFormat(action, range: textView.selectedRange())
    }
    /// The controls follow history, drafts, saves and the selection.
    private func updateActions() { updateFormatControls() }
    private func updateEditability() {
        // AppKit cancels marked text when isEditable becomes false. A retained
        // remote block must preserve that native draft; input delegates still
        // consult the binding/interaction guards before any prose submission.
        guard !textView.hasMarkedText() else { return }
        textView.isEditable = !isInteractionLocked && binding.canEdit
    }
    private func focus() { onFocus?(); window?.makeFirstResponder(textView) }
    /// How much of the selection has the format, for checkmarks and buttons.
    func formatState(_ action: NativeFormatAction) -> NativeFormatState {
        binding.formatState(action, range: textView.selectedRange())
    }
    /// The block style of the selection's first block (正文, 标题 1–3), if any.
    var selectedBlockFormat: NativeFormatAction? { binding.blockFormat(at: textView.selectedRange()) }
    private func updateFormatControls() {
        controls?.refresh()
        onControlsChanged?()
    }
    func performFormat(_ action: NativeFormatAction) {
        guard canPerformFormat(action) else { return }
        let range = textView.selectedRange()
        focus()
        binding.format(action, range: range)
    }
    @objc func undoProse() { performHistory(redo: false) }
    @objc func redoProse() { performHistory(redo: true) }
    @objc func retrySave() { guard !isInteractionLocked else { return }; focus(); binding.retrySave() }
    @objc func discardDraft() { guard !isInteractionLocked else { return }; focus(); binding.discardDraft() }
}

/// A block command (Tab, ⇧Tab, a slash row) given while typed text was still
/// on its way, and the first and last blocks its selection touched: by ID,
/// or, for a block the queued input creates (it has none until its reply),
/// by its displayed range, which the reply then names. It applies only to
/// those blocks, and only while the selection still touches exactly them.
struct DeferredBlockFormat {
    struct Target: Equatable {
        var id: String?
        var range: NSRange
    }
    /// What waits: a format (also the list-item split after Return), or
    /// inserting or removing a horizontal rule at the caret.
    enum Command: Equatable {
        case format(NativeFormatAction)
        case insertRule
        /// ⌫ (backward) or ⌦ (forward) beside a rule.
        case removeRule(forward: Bool)
    }
    let command: Command
    /// The format that waits, if it is one.
    var action: NativeFormatAction? { if case .format(let action) = command { return action }; return nil }
    private(set) var targets: [Target]

    init?(command: Command, selection: NSRange, blocks: [NativeBlock]) {
        guard let touched = Self.touched(selection, blocks) else { return nil }
        self.command = command
        targets = touched.map { Target(id: blocks[$0].id, range: blocks[$0].range.nsRange) }
    }

    /// The first and last blocks a selection touches, as Rust counts them.
    private static func touched(_ selection: NSRange, _ blocks: [NativeBlock]) -> [Int]? {
        guard selection.location >= 0, selection.length >= 0, let first = NativeLayout.index(selection.location, blocks: blocks) else { return nil }
        guard selection.length > 0 else { return [first] }
        guard let last = blocks.lastIndex(where: { $0.range.location < NSMaxRange(selection) }), last >= first else { return nil }
        return last == first ? [first] : [first, last]
    }

    /// After a render: a named block must still exist. Other input moves an
    /// unnamed block's range and drops the command when it touches that
    /// block; this view's own input (already in its text) moves or resizes
    /// it; a render of the same text (the reply) names it. Nil when the
    /// command no longer applies.
    func following(_ changes: [NativeTextChange], replaced: Bool, blocks: [NativeBlock]) -> DeferredBlockFormat? {
        var next = self
        for index in next.targets.indices {
            var target = next.targets[index]
            if let id = target.id {
                guard blocks.contains(where: { $0.id == id }) else { return nil }
            } else if replaced {
                guard !changes.isEmpty else { return nil }
                for change in changes {
                    guard NSMaxRange(change.range) < target.range.location || change.range.location > NSMaxRange(target.range) else { return nil }
                    target.range = change.mapSelection(target.range)
                }
            } else {
                for change in changes { target.range = Self.moved(target.range, by: change) }
                if let found = NativeLayout.index(target.range.location, blocks: blocks), blocks[found].range.nsRange == target.range {
                    target.id = blocks[found].id
                }
            }
            next.targets[index] = target
        }
        return next
    }

    /// A block's range after an edit: one inside it (its ends included)
    /// resizes it, one before it moves it.
    private static func moved(_ range: NSRange, by change: NativeTextChange) -> NSRange {
        let delta = (change.text as NSString).length - change.range.length
        if change.range.location > NSMaxRange(range) { return range }
        if change.range.location < range.location { return NSRange(location: max(0, range.location + delta), length: range.length) }
        return NSRange(location: range.location, length: max(0, range.length + delta))
    }

    /// Whether the command still applies after an edit of the text: the
    /// edit neither adds nor removes a line break, and it lies in a block
    /// from the first to the last it was given for.
    func survives(_ range: NSRange, replacement: String, in text: String, blocks: [NativeBlock]) -> Bool {
        let string = text as NSString
        guard !replacement.contains("\n"), range.location >= 0, NSMaxRange(range) <= string.length,
              !string.substring(with: range).contains("\n") else { return false }
        var start = range.location
        while start > 0, string.character(at: start - 1) != 10 { start -= 1 }
        let starts = targets.compactMap { target in
            target.id.map { id in blocks.first { $0.id == id }?.range.location } ?? target.range.location
        }
        guard let first = starts.min(), let last = starts.max() else { return false }
        return start >= first && start <= last
    }

    /// Whether the selection touches exactly the blocks the command was given for.
    func applies(to blocks: [NativeBlock], selection: NSRange) -> Bool {
        guard let touched = Self.touched(selection, blocks), touched.count == targets.count else { return false }
        return zip(touched, targets).allSatisfy { index, target in
            target.id.map { $0 == blocks[index].id } ?? (blocks[index].range.nsRange == target.range)
        }
    }
}
