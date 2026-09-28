import AppKit

/// The 全书长卷 panel. Its close button asks first, since editors with input
/// in flight keep it open.
final class WholeBookPanel: NSPanel {
    var onClose: (() -> Void)?
    /// Asked before the title bar's close button closes the panel.
    var shouldClose: (() -> Bool)?
    /// The panel became key again, e.g. after edits in the main window.
    var onBecomeKey: (() -> Void)?
    override func performClose(_ sender: Any?) {
        if let shouldClose, !shouldClose() { return }
        super.performClose(sender)
    }
    override func close() { super.close(); onClose?() }
    override func becomeKey() { super.becomeKey(); onBecomeKey?() }
}

/// The long page: rows in reading order on the text background. Rows are
/// placed by frame, one after another, so a row changing height moves the
/// rows below it without solving constraints across the book.
final class WholeBookDocumentView: NSView {
    override var isFlipped: Bool { true }
    override init(frame: NSRect) { super.init(frame: frame); wantsLayer = true }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() { layer?.backgroundColor = NSColor.textBackgroundColor.cgColor }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
}

/// A row of the long page. Its content uses constraints inside the row only;
/// the page sets its frame from `fit(width:)`.
class WholeBookRow: NSView {
    override var isFlipped: Bool { true }
    /// `act:<id>` or `chapter:<id>`, as `BookLayout.Item.key`.
    var key: String { "" }
    /// The height the row needs at `width`, laid out at that width.
    func fit(width: CGFloat) -> CGFloat { 0 }
    /// Lays the row out at `width`; twice, since a body sizing itself to its
    /// text changes its own constraints while it is laid out.
    fileprivate func layout(width: CGFloat) {
        if abs(frame.width - width) >= 0.5 { setFrameSize(NSSize(width: width, height: max(frame.height, 1))) }
        layoutSubtreeIfNeeded()
        layoutSubtreeIfNeeded()
    }
}

/// An act separator: the act's name on a wash in its colour, with its
/// chapter count. No edge accent.
final class WholeBookActRow: WholeBookRow {
    private(set) var act: BookAct
    let titleLabel = NSTextField(labelWithString: "")
    let detailLabel = NSTextField(labelWithString: "")
    let wash = ElementHeaderWash()
    /// The separator's context menu (幕颜色).
    var onMenu: ((WholeBookActRow) -> NSMenu?)?

    init(act: BookAct) {
        self.act = act
        super.init(frame: .zero)
        titleLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        detailLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.setContentHuggingPriority(.required, for: .horizontal)
        let line = NSStackView(views: [titleLabel, NSView(), detailLabel])
        line.spacing = 10
        line.translatesAutoresizingMaskIntoConstraints = false
        wash.translatesAutoresizingMaskIntoConstraints = false
        addSubview(wash)
        wash.addSubview(line)
        NSLayoutConstraint.activate([
            wash.leadingAnchor.constraint(equalTo: leadingAnchor), wash.trailingAnchor.constraint(equalTo: trailingAnchor),
            wash.topAnchor.constraint(equalTo: topAnchor, constant: 18),
            line.leadingAnchor.constraint(equalTo: wash.leadingAnchor, constant: 16),
            line.trailingAnchor.constraint(equalTo: wash.trailingAnchor, constant: -16),
            line.topAnchor.constraint(equalTo: wash.topAnchor, constant: 12),
            line.bottomAnchor.constraint(equalTo: wash.bottomAnchor, constant: -12),
        ])
        apply(act)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func apply(_ act: BookAct) {
        self.act = act
        titleLabel.stringValue = act.title
        detailLabel.stringValue = act.chapterIDs.isEmpty ? "尚无章节" : "\(act.chapterIDs.count) 章"
        wash.tint = ElementSwatch.color(hex: act.hex)
        setAccessibilityIdentifier("whole-book-act-\(act.id)")
        setAccessibilityLabel("幕 \(act.title)")
    }

    override var key: String { "act:\(act.id)" }

    override func menu(for event: NSEvent) -> NSMenu? { onMenu?(self) ?? super.menu(for: event) }

    /// A separator's height, the same for every act; read once.
    fileprivate(set) static var standardHeight: CGFloat?

    override func fit(width: CGFloat) -> CGFloat {
        layout(width: width)
        let height = ceil(wash.frame.maxY + 14)
        Self.standardHeight = Self.standardHeight ?? height
        return height
    }
}

/// A read-only body: the chapter's prose styled as the editor styles it,
/// sized to its text at the row's width. A click asks for the editor there.
final class WholeBookPreviewText: NSView {
    let textView = NSTextView()
    private var measuredWidth: CGFloat = -1
    private(set) var textHeight: CGFloat = 0
    private var heightConstraint: NSLayoutConstraint!
    var onClick: ((Int) -> Void)?
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        textView.isEditable = false
        textView.isSelectable = false
        textView.drawsBackground = false
        textView.isVerticallyResizable = false
        textView.isHorizontallyResizable = false
        textView.textContainerInset = NSSize(width: 20, height: 20)
        textView.textContainer?.widthTracksTextView = true
        textView.setAccessibilityLabel("正文预览")
        addSubview(textView)
        heightConstraint = heightAnchor.constraint(equalToConstant: 0)
        heightConstraint.isActive = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    var string: String { textView.string }

    func show(_ text: NSAttributedString) {
        textView.textStorage?.setAttributedString(text)
        measuredWidth = -1
    }

    /// Measures the text at `width` and takes that height.
    func prepare(width: CGFloat) {
        guard width > 40, abs(width - measuredWidth) >= 0.5 else { return }
        measuredWidth = width
        textView.frame = NSRect(x: 0, y: 0, width: width, height: max(textHeight, 1))
        guard let manager = textView.layoutManager, let container = textView.textContainer else { return }
        container.containerSize = NSSize(width: max(1, width - textView.textContainerInset.width * 2), height: .greatestFiniteMagnitude)
        manager.ensureLayout(for: container)
        textHeight = ceil(manager.usedRect(for: container).height + textView.textContainerInset.height * 2)
        heightConstraint.constant = textHeight
    }

    override func layout() {
        super.layout()
        textView.frame = NSRect(x: 0, y: 0, width: bounds.width, height: max(textHeight, bounds.height))
    }

    override func mouseDown(with event: NSEvent) {
        let point = textView.convert(event.locationInWindow, from: nil)
        onClick?(textView.characterIndexForInsertion(at: point))
    }
}

/// A body not yet read: faint lines where the prose will be, as tall as the
/// chapter's word count suggests (or as its text last measured).
final class WholeBookPlaceholder: NSView {
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        let line = DocumentStyle.typography.size * 1.2 + DocumentStyle.typography.lineSpacing
        NSColor.quaternaryLabelColor.withAlphaComponent(0.35).setFill()
        var index = max(0, Int(floor((dirtyRect.minY - 20) / line)))
        var y = 20 + CGFloat(index) * line
        while y < min(dirtyRect.maxY, bounds.height - 20) {
            let width = (bounds.width - 40) * (index % 7 == 6 ? 0.45 : 1)
            NSBezierPath(roundedRect: NSRect(x: 20, y: y + line * 0.3, width: width, height: line * 0.35), xRadius: 3, yRadius: 3).fill()
            y += line; index += 1
        }
    }
}

/// One chapter: its title, status and word count, then its body, which is a
/// placeholder, a read-only preview or the chapter's editor.
final class WholeBookChapterRow: WholeBookRow {
    enum Body: Equatable { case placeholder, preview, editor }

    private(set) var chapter: BookChapter
    let projectID: String
    let titleLabel = NSTextField(labelWithString: "")
    let statusLabel = NSTextField(labelWithString: "")
    let wordsLabel = MacWordCount.headerLabel(identifier: "")
    let body = NSView()
    let placeholder = WholeBookPlaceholder()
    let preview = WholeBookPreviewText()
    private var placeholderHeight: NSLayoutConstraint!
    private(set) var shown: Body = .placeholder
    private(set) var editor: NativeDocumentView?
    fileprivate(set) var core: LabCore?
    fileprivate var opening = false
    fileprivate var openFailed: Date?
    /// The body's height the last time it showed text, and at which width.
    fileprivate var measured: (width: CGFloat, height: CGFloat)?
    var onStatusMenu: ((WholeBookChapterRow) -> NSMenu?)?

    var isAttached: Bool { editor != nil }
    var isFocused: Bool { editor.map { $0.window?.firstResponder === $0.textView } ?? false }
    var scope: DocumentScope { .chapter(ChapterScope(projectID: projectID, chapterID: chapter.id)) }

    init(chapter: BookChapter, projectID: String) {
        self.chapter = chapter
        self.projectID = projectID
        super.init(frame: .zero)
        titleLabel.font = .systemFont(ofSize: 20, weight: .semibold)
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        statusLabel.font = .systemFont(ofSize: 12)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.setContentHuggingPriority(.required, for: .horizontal)
        let header = NSStackView(views: [titleLabel, NSView(), statusLabel, wordsLabel])
        header.spacing = 10
        header.alignment = .firstBaseline
        header.translatesAutoresizingMaskIntoConstraints = false
        body.translatesAutoresizingMaskIntoConstraints = false
        addSubview(header); addSubview(body)
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        placeholderHeight = placeholder.heightAnchor.constraint(equalToConstant: 160)
        placeholderHeight.isActive = true
        // The body is as tall as its content; the page reads it in `fit`.
        NSLayoutConstraint.activate([
            header.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
            header.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
            header.topAnchor.constraint(equalTo: topAnchor, constant: 22),
            body.leadingAnchor.constraint(equalTo: leadingAnchor), body.trailingAnchor.constraint(equalTo: trailingAnchor),
            body.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 8),
        ])
        install(placeholder)
        apply(chapter)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func apply(_ chapter: BookChapter) {
        self.chapter = chapter
        titleLabel.stringValue = chapter.title
        titleLabel.setAccessibilityIdentifier("whole-book-title-\(chapter.id)")
        statusLabel.stringValue = chapter.writingStatus.map(WritingStatus.label) ?? ""
        statusLabel.isHidden = chapter.writingStatus == nil
        statusLabel.textColor = chapter.writingStatus == WritingStatus.finished.rawValue ? .labelColor : .secondaryLabelColor
        statusLabel.setAccessibilityIdentifier("whole-book-status-\(chapter.id)")
        wordsLabel.setAccessibilityIdentifier("whole-book-words-\(chapter.id)")
        setAccessibilityIdentifier("whole-book-chapter-\(chapter.id)")
    }

    func showWords(_ count: Int?, loaded: Bool) { MacWordCount.show(count, loaded: loaded, in: wordsLabel) }

    override var key: String { "chapter:\(chapter.id)" }

    /// The header's height, the same for every chapter; read once.
    fileprivate(set) static var headerHeight: CGFloat?
    /// A chapter row's height around a body of `body` points.
    static func height(body: CGFloat) -> CGFloat { ceil(22 + (headerHeight ?? 27) + 8 + body + 10) }

    override func fit(width: CGFloat) -> CGFloat {
        // A placeholder's height is known without laying the row out.
        if shown == .placeholder, Self.headerHeight != nil {
            if abs(frame.width - width) >= 0.5 { setFrameSize(NSSize(width: width, height: max(frame.height, 1))) }
            return Self.height(body: placeholderHeight.constant)
        }
        if shown == .preview { preview.prepare(width: width) }
        layout(width: width)
        if Self.headerHeight == nil, body.frame.minY > 30 { Self.headerHeight = body.frame.minY - 30 }
        let height = ceil(body.frame.maxY + 10)
        if shown != .placeholder, body.frame.width > 40 { measured = (body.frame.width, body.frame.height) }
        return height
    }

    private func install(_ content: NSView) {
        for child in body.subviews { child.removeFromSuperview() }
        content.translatesAutoresizingMaskIntoConstraints = false
        body.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: body.leadingAnchor), content.trailingAnchor.constraint(equalTo: body.trailingAnchor),
            content.topAnchor.constraint(equalTo: body.topAnchor), content.bottomAnchor.constraint(equalTo: body.bottomAnchor),
        ])
    }

    /// A body leaving the screen keeps the height its text had at this width.
    fileprivate func showPlaceholder(height: CGFloat) {
        if shown != .placeholder, let measured, abs(measured.width - body.frame.width) < 1 { placeholderHeight.constant = measured.height }
        else { placeholderHeight.constant = height }
        guard shown != .placeholder else { return }
        shown = .placeholder
        install(placeholder)
    }

    fileprivate func showPreview(_ text: NSAttributedString) {
        preview.show(text)
        guard shown != .preview else { return }
        shown = .preview
        install(preview)
    }

    fileprivate func showEditor(_ view: NativeDocumentView, core: LabCore) {
        editor = view; self.core = core
        shown = .editor
        install(view)
    }

    /// The editor leaves the row; the caller shows a preview or placeholder.
    fileprivate func removeEditor() { editor = nil; core = nil }

    override func menu(for event: NSEvent) -> NSMenu? { onStatusMenu?(self) ?? super.menu(for: event) }
}

/// 全书长卷: every live chapter in reading order in one scroll, with act
/// separators. Every row has a slot with its frame; only rows near the
/// viewport have a view, and only chapters nearer still have an editor,
/// each backed by the chapter's document owner as a tab's is. The rest
/// show read-only text, placeholders sized from their word count, or
/// nothing at all. An owner is released only when its view has no input in
/// flight, and closed only when no view shows it. The owner of a chapter
/// edited in this session stays open while it has undo history (the most
/// recently edited `keptOwnerLimit`), so ⌘Z works when the chapter returns.
/// An owner whose close fails stays tracked and is closed again later.
final class MacWholeBookViewController: NSViewController {
    /// Editors near the viewport; the one being written in may stay beyond.
    static var maximumAttached = 6
    /// Viewport heights above and below where editors attach.
    static var attachMargin: CGFloat = 0.75
    /// Viewport heights above and below where rows have views and read-only text.
    static var previewMargin: CGFloat = 2.5
    /// Read-only texts kept for chapters without an editor.
    static var previewLimit = 60
    /// Owner changes suspend every editor briefly, so they wait for a pause in typing.
    static var typingPause: TimeInterval = 0.6
    static var retryDelay: TimeInterval = 0.15
    /// Owners of edited chapters kept for undo after their editor left.
    static var keptOwnerLimit = 12
    /// How long a failed close waits before the next attempt.
    static var closeRetryDelay: TimeInterval = 2
    static let columnWidth: CGFloat = 760
    static let topInset: CGFloat = 12

    /// One row of the book: its place, and its view while near the viewport.
    private final class Slot {
        let key: String
        var item: BookLayout.Item
        var frame = NSRect.zero
        /// The fitted height at the laid-out width; nil until fitted.
        var height: CGFloat?
        var row: WholeBookRow?
        init(item: BookLayout.Item) { self.item = item; key = item.key }
        var isShown: Bool { row?.superview != nil }
        var chapterRow: WholeBookChapterRow? { row as? WholeBookChapterRow }
    }

    let model: WholeBookModel
    let project: WorkspaceProject
    private let workspace: LabWorkspaceCore
    private weak var host: MacChapterWorkspace?
    /// The project's 写作计划, for 统计.
    var plan: () -> WritingPlan = { WritingPlan() }
    /// 统计's 今日 row: this device's net words today; nil hides it.
    var todayWords: () -> Int? = { nil }
    var onClose: (() -> Void)?
    /// ⌘-click or 打开「名称」 in a chapter; nil opens it in the host's active pane.
    var onOpenLink: ((EntityLinkTarget) -> Void)?
    /// 写作状态 chosen in a chapter's menu.
    var onSetStatus: ((BookChapter, String) -> Void)?
    /// An act separator's 幕颜色 was stored; views that colour acts follow.
    var onActColorChanged: (() -> Void)?

    let jumpButton = NSPopUpButton(frame: .zero, pullsDown: true)
    let statsButton = NSButton(title: "统计", target: nil, action: nil)
    let statusLabel = NSTextField(wrappingLabelWithString: "")
    let scrollView = NSScrollView()
    let documentView = WholeBookDocumentView()
    private let statsPopover = NSPopover()
    private(set) var statsController: MacBookStatsViewController?

    private var slots: [Slot] = []
    private var slotsByKey: [String: Slot] = [:]
    private var slotIndex: [String: Int] = [:]
    private var chapterSlots: [Slot] = []
    private var laidOutWidth: CGFloat = 0
    private var laidOutClip = NSSize.zero
    private var placingRows = false
    private var keysToFit: Set<String> = []
    private var fitScheduled = false
    /// Rows whose chapter left the book while their editor had input in flight.
    private var retired: [WholeBookChapterRow] = []
    private var counts: WordCountLibrary?
    private var ownersToClose: [DocumentScope: LabCore] = [:]
    /// Owners closed without success: the chapter's title, the reason and
    /// when. They stay in `ownersToClose` and are tried again after a pause.
    private var closeFailures: [DocumentScope: (title: String, reason: String, at: Date)] = [:]
    /// Owners of chapters edited in this session that left their editor with
    /// undo history, least recently edited first.
    private var keptOwners: [(scope: DocumentScope, core: LabCore)] = []
    /// The order of each chapter's last edit in this session.
    private var edits: [String: Int] = [:]
    private var editCount = 0
    /// Closes a chapter's owner; acceptance replaces it to make closes fail.
    var closeChapterOwner: ((ChapterScope, @escaping (Result<Bool, Error>) -> Void) -> Void)?
    private var ownerOperation = false
    private var previewLoading: String?
    private var previews: [String: NSAttributedString] = [:]
    private var previewOrder: [String] = []
    private var anchor: (key: String, offset: CGFloat)?
    private var restoringAnchor = false
    private var passScheduled = false
    private var retryScheduled = false
    private var lastEdit: Date?
    private var pendingReveal: (chapterID: String, blockID: String)?
    private var pendingFocus: (chapterID: String, location: Int)?
    private var shuttingDown = false
    private(set) var isShutDown = false
    private var drained: [(String?) -> Void] = []
    /// Kept alive while owners close after the panel is gone.
    private var closingSelf: MacWholeBookViewController?

    init(project: WorkspaceProject, model: WholeBookModel, workspace: LabWorkspaceCore, host: MacChapterWorkspace) {
        self.project = project
        self.model = model
        self.workspace = workspace
        self.host = host
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit { NotificationCenter.default.removeObserver(self) }

    // MARK: Inspection

    /// Rows in reading order: `act:<id>` and `chapter:<id>`.
    var rowOrder: [String] { slots.map(\.key) }
    /// The chapter's row view, once it has been near the viewport.
    func chapterRow(_ id: String) -> WholeBookChapterRow? { slotsByKey["chapter:\(id)"]?.chapterRow }
    func actRow(_ id: String) -> WholeBookActRow? { slotsByKey["act:\(id)"]?.row as? WholeBookActRow }
    /// Where the chapter's row is in the long page, shown or not.
    func frame(ofChapter id: String) -> NSRect? { slotsByKey["chapter:\(id)"]?.frame }
    /// Chapters with an editor, in reading order.
    var attachedChapterIDs: [String] { attachedRows.map(\.chapter.id) }
    /// The chapter whose editor has the keyboard focus, e.g. for 打印….
    var focusedChapter: BookChapter? { attachedRows.first { $0.isFocused }?.chapter }
    /// Chapters whose owner is kept for undo without an editor, least recently edited first.
    var keptChapterIDs: [String] { keptOwners.compactMap { if case .chapter(let chapter) = $0.scope { return chapter.chapterID }; return nil } }
    /// Titles of chapters whose owner could not be closed and is tried again later.
    var unclosedChapterTitles: [String] { closeFailures.values.sorted { $0.at < $1.at }.map(\.title) }
    /// An editor has queued input, a failed or marked draft.
    var hasInputInFlight: Bool {
        (attachedRows + retired).contains { row in
            row.editor.map { $0.binding.hasPendingWork || $0.binding.hasUnsubmittedDraft || $0.textView.hasMarkedText() } ?? false
        }
    }
    /// Why the project cannot be deleted yet, or nil: input in flight, or
    /// an owner this panel could not close, named by chapter title.
    var deletionRefusal: String? {
        if hasInputInFlight { return "全书长卷中还有未完成的输入，请等待正文保存后再删除。" }
        return closeFailureText
    }
    /// 全书长卷中“长卷章节 003”的正文未能关闭：…。稍后空闲时会再试。, or nil.
    var closeFailureText: String? {
        let failures = closeFailures.values.sorted { $0.at < $1.at }
        guard let last = failures.last else { return nil }
        let titles = failures.map { "“\($0.title)”" }.joined(separator: "、")
        let reason = last.reason.hasSuffix("。") ? last.reason : last.reason + "。"
        return "全书长卷中\(titles)的正文未能关闭：\(reason)稍后空闲时会再试。"
    }
    /// Row views in the long page.
    var shownRowCount: Int { documentView.subviews.count }
    /// No owner change, read, reveal, row fit or row view is waiting.
    var isSettled: Bool {
        // Owners waiting after a failed close do not count: they are tried later.
        guard !passScheduled, !fitScheduled, !ownerOperation, previewLoading == nil,
              ownersToClose.keys.allSatisfy({ closeFailures[$0] != nil }), pendingReveal == nil else { return false }
        guard attachedRows.allSatisfy({ !$0.opening && ($0.editor.map { !$0.binding.hasPendingWork && $0.binding.state != nil } ?? true) }) else {
            return false
        }
        return slots(in: bands.preview).allSatisfy(\.isShown)
            && wanted().allSatisfy { row in row.isAttached || row.openFailed != nil }
    }

    private var shownChapterRows: [WholeBookChapterRow] { chapterSlots.compactMap { $0.isShown ? $0.chapterRow : nil } }
    private var attachedRows: [WholeBookChapterRow] { chapterSlots.compactMap { $0.chapterRow.flatMap { $0.isAttached ? $0 : nil } } }

    // MARK: View

    override func loadView() {
        view = NSView()
        jumpButton.addItem(withTitle: "跳到…")
        jumpButton.setAccessibilityIdentifier("whole-book-jump")
        jumpButton.toolTip = "跳到一幕或一章"
        statsButton.target = self; statsButton.action = #selector(toggleStats)
        statsButton.setAccessibilityIdentifier("whole-book-stats")
        statsButton.toolTip = "全书概览、写作计划进度、幕节奏和章节长度节奏"
        let close = NSButton(title: "关闭", target: self, action: #selector(closePressed))
        close.setAccessibilityIdentifier("close-whole-book")
        let title = NSTextField(labelWithString: "\(project.name) · 全书长卷")
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        let toolbar = NSStackView(views: [title, NSView(), jumpButton, statsButton, close])
        toolbar.spacing = 10
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.setAccessibilityIdentifier("whole-book-status")
        scrollView.hasVerticalScroller = true
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = true
        scrollView.backgroundColor = .textBackgroundColor
        scrollView.setAccessibilityIdentifier("whole-book-scroll")
        documentView.setAccessibilityIdentifier("whole-book-document")
        scrollView.documentView = documentView
        let stack = NSStackView(views: [toolbar, statusLabel, scrollView])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            toolbar.leadingAnchor.constraint(equalTo: stack.leadingAnchor, constant: 16),
            toolbar.trailingAnchor.constraint(equalTo: stack.trailingAnchor, constant: -16),
            statusLabel.leadingAnchor.constraint(equalTo: stack.leadingAnchor, constant: 16),
            statusLabel.trailingAnchor.constraint(equalTo: stack.trailingAnchor, constant: -16),
            scrollView.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        let clip = scrollView.contentView
        clip.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification, object: clip)
        NotificationCenter.default.addObserver(self, selector: #selector(typographyChanged), name: DocumentStyle.typographyDidChange, object: nil)
        statsPopover.behavior = .transient
        statsPopover.animates = false
        model.observe(self) { [weak self] in self?.modelChanged() }
        counts = host?.wordCounts(projectID: project.id).library
        modelChanged()
    }

    /// A resized panel places every row again at the new width.
    override func viewDidLayout() {
        super.viewDidLayout()
        if scrollView.contentSize != laidOutClip { placeRows() }
        schedulePass()
    }

    // MARK: Timing

    /// The longest pass or row placement on the main thread, in seconds.
    private(set) static var slowestStep: TimeInterval = 0
    static func resetSlowest() { slowestStep = 0 }
    private func timed(_ work: () -> Void) {
        let start = Date()
        work()
        Self.slowestStep = max(Self.slowestStep, Date().timeIntervalSince(start))
    }

    // MARK: Slots and rows

    private func modelChanged() { timed { applyModel() } }

    private func applyModel() {
        showStatus()
        guard model.loaded else { return }
        rebuildSlots()
        rebuildJumpMenu()
        statsController?.reload()
        schedulePass()
    }

    /// The status line: an owner that could not be closed, then the model's status.
    private func showStatus() {
        let text = [closeFailureText, model.status.isEmpty ? nil : model.status].compactMap { $0 }.joined(separator: " ")
        statusLabel.stringValue = text
        statusLabel.isHidden = text.isEmpty
    }

    /// Slots follow the layout. Existing rows are kept with their bodies, so
    /// editors of chapters still in the book stay attached.
    private func rebuildSlots() {
        var next: [Slot] = [], byKey: [String: Slot] = [:]
        for item in model.layout.items {
            let slot = slotsByKey[item.key] ?? Slot(item: item)
            if slot.item != item {
                slot.item = item
                slot.height = nil
                switch (item, slot.row) {
                case (.act(let act), let row as WholeBookActRow): row.apply(act)
                case (.chapter(let chapter), let row as WholeBookChapterRow): row.apply(chapter)
                default: break
                }
            }
            next.append(slot); byKey[item.key] = slot
        }
        // Chapters that left the book (trash, a remote delete) let go of their editors.
        for slot in slots where byKey[slot.key] == nil {
            slot.row?.removeFromSuperview()
            if let row = slot.chapterRow, row.isAttached, !release(row) { retired.append(row) }
        }
        slots = next; slotsByKey = byKey
        slotIndex = Dictionary(uniqueKeysWithValues: slots.enumerated().map { ($1.key, $0) })
        chapterSlots = slots.filter { if case .chapter = $0.item { return true }; return false }
        let loaded = counts != nil
        for row in chapterSlots.compactMap(\.chapterRow) { row.showWords(counts?.count(nodeID: row.chapter.id), loaded: loaded) }
        placeRows()
    }

    private func makeRow(_ slot: Slot) -> WholeBookRow {
        switch slot.item {
        case .act(let act):
            let row = WholeBookActRow(act: act)
            row.onMenu = { [weak self] row in self?.actMenu(for: row) }
            return row
        case .chapter(let chapter):
            let row = WholeBookChapterRow(chapter: chapter, projectID: project.id)
            row.preview.onClick = { [weak self, weak row] location in
                guard let self, let row else { return }
                self.pendingFocus = (row.chapter.id, location)
                self.schedulePass()
            }
            row.onStatusMenu = { [weak self] row in self?.statusMenu(for: row) }
            row.showWords(counts?.count(nodeID: chapter.id), loaded: counts != nil)
            row.showPlaceholder(height: estimatedBodyHeight(chapterID: chapter.id, row: nil))
            return row
        }
    }

    /// Gives slots near the viewport their row views; views of far rows leave
    /// the page (and drop their read-only text), keeping their height.
    private func updateShownRows(near band: NSRect, keep: NSRect) {
        var first: Int?
        for slot in slots(in: band) where !slot.isShown {
            let row = slot.row ?? makeRow(slot)
            slot.row = row
            documentView.addSubview(row)
            slot.height = nil
            first = min(first ?? .max, slotIndex[slot.key] ?? 0)
        }
        for slot in slots where slot.isShown && !slot.frame.intersects(keep) {
            if let row = slot.chapterRow {
                guard !row.isAttached, !row.opening, pendingFocus?.chapterID != row.chapter.id,
                      pendingReveal?.chapterID != row.chapter.id else { continue }
                if row.shown == .preview { row.showPlaceholder(height: estimatedBodyHeight(chapterID: row.chapter.id, row: row)) }
            }
            slot.row?.removeFromSuperview()
        }
        if let first { placeRows(from: first) }
    }

    /// 幕颜色 on an act separator: the palette and 恢复默认. The book is read
    /// again after the colour is stored.
    func actMenu(for row: WholeBookActRow) -> NSMenu {
        let menu = NSMenu()
        let header = NSMenuItem(title: "幕颜色", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        let act = row.act
        let choices = ActColorMenu.make(stored: act.color, prefix: "whole-book-act-color") { [weak self] color in
            self?.model.setActColor(actID: act.id, color: color) { [weak self] result in
                if case .success = result { self?.onActColorChanged?() }
            }
        }
        for item in choices.items { choices.removeItem(item); menu.addItem(item) }
        menu.autoenablesItems = false
        return menu
    }

    private func statusMenu(for row: WholeBookChapterRow) -> NSMenu? {
        guard onSetStatus != nil else { return nil }
        let menu = NSMenu()
        let header = NSMenuItem(title: "写作状态", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        for status in WritingStatus.chapter {
            let item = LibraryMenuItem(title: status.label, identifier: "whole-book-status-\(status.rawValue)") { [weak self, weak row] in
                guard let self, let row, row.chapter.writingStatus != status.rawValue else { return }
                self.onSetStatus?(row.chapter, status.rawValue)
            }
            item.state = row.chapter.writingStatus == status.rawValue ? .on : .off
            menu.addItem(item)
        }
        return menu
    }

    /// The reading column: centred, at most `columnWidth` wide.
    private var columnWidth: CGFloat { min(Self.columnWidth, max(320, scrollView.contentSize.width - 64)) }

    /// A body not shown yet: its last measured height at this width, else an
    /// estimate from its word count at the current typography.
    private func estimatedBodyHeight(chapterID: String, row: WholeBookChapterRow?) -> CGFloat {
        let width = columnWidth
        if let measured = row?.measured, abs(measured.width - width) < 1 { return measured.height }
        let size = DocumentStyle.typography.size
        let line = size * 1.25 + DocumentStyle.typography.lineSpacing
        let perLine = max(8, floor((width - 40) / size))
        let words = Double(counts?.count(nodeID: chapterID) ?? 600)
        let paragraphs = max(1, ceil(words / 160))
        let lines = ceil(words / perLine) + paragraphs * 0.5
        return max(80, (40 + lines * line + paragraphs * DocumentStyle.typography.paragraphSpacing).rounded())
    }

    /// A slot without a view: an act's separator height, or a chapter's
    /// header around its estimated body.
    private func estimatedHeight(_ slot: Slot) -> CGFloat {
        switch slot.item {
        case .act: return WholeBookActRow.standardHeight ?? 78
        case .chapter(let chapter): return WholeBookChapterRow.height(body: estimatedBodyHeight(chapterID: chapter.id, row: slot.chapterRow))
        }
    }

    private func setPlaceholder(_ row: WholeBookChapterRow) {
        row.showPlaceholder(height: estimatedBodyHeight(chapterID: row.chapter.id, row: row))
        slotsByKey[row.key]?.height = nil
    }

    private func placeRows(from start: Int = 0) { timed { place(from: start) } }

    /// Places slots one after another from `start`, fitting shown rows whose
    /// height is unknown, and keeps the reading position.
    private func place(from start: Int) {
        // Before the panel is laid out the width is unknown; it places then.
        guard isViewLoaded, scrollView.contentSize.width >= 100 else { return }
        var start = start
        let clip = scrollView.contentSize
        let width = columnWidth
        if abs(width - laidOutWidth) >= 0.5 {
            // A new width: shown rows are fitted again, estimates follow it.
            start = 0
            laidOutWidth = width
            for slot in slots {
                slot.height = nil
                if let row = slot.chapterRow, row.shown == .placeholder { row.showPlaceholder(height: estimatedBodyHeight(chapterID: row.chapter.id, row: row)) }
            }
        }
        laidOutClip = clip
        let x = max(16, ((clip.width - width) / 2).rounded())
        placingRows = true
        var y: CGFloat = start > 0 && slots.indices.contains(start - 1) ? slots[start - 1].frame.maxY : 8
        for slot in slots[min(start, slots.count)...] {
            let height: CGFloat
            if let known = slot.height { height = known }
            else if let row = slot.row, slot.isShown { height = row.fit(width: width); slot.height = height }
            else { height = estimatedHeight(slot) }
            slot.frame = NSRect(x: x, y: y, width: width, height: height)
            if let row = slot.row, slot.isShown, row.frame != slot.frame { row.frame = slot.frame }
            y += height
        }
        let size = NSSize(width: clip.width, height: max(y + 40, clip.height))
        if documentView.frame.size != size { documentView.setFrameSize(size) }
        placingRows = false
        restoreAnchor()
    }

    /// A row's content changed height: fit it again and move the rows below.
    private func rowChanged(_ row: WholeBookRow) {
        slotsByKey[row.key]?.height = nil
        keysToFit.insert(row.key)
        guard !fitScheduled else { return }
        fitScheduled = true
        // Outside AppKit's layout pass: an editor reports while laid out.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.fitScheduled = false
            let first = self.keysToFit.compactMap { self.slotIndex[$0] }.min()
            self.keysToFit.removeAll()
            if let first { self.placeRows(from: first) }
            self.schedulePass()
        }
    }

    private func rebuildJumpMenu() {
        jumpButton.removeAllItems()
        jumpButton.addItem(withTitle: "跳到…")
        guard let menu = jumpButton.menu else { return }
        for item in model.layout.items {
            let entry: NSMenuItem
            switch item {
            case .act(let act):
                entry = LibraryMenuItem(title: act.title, identifier: "whole-book-jump-act-\(act.id)") { [weak self] in
                    self?.scroll(toAct: act.id)
                }
                entry.attributedTitle = NSAttributedString(string: act.title,
                                                           attributes: [.font: NSFont.systemFont(ofSize: NSFont.systemFontSize, weight: .semibold)])
            case .chapter(let chapter):
                entry = LibraryMenuItem(title: "\(chapter.number). \(chapter.title)", identifier: "whole-book-jump-chapter-\(chapter.id)") { [weak self] in
                    self?.scroll(toChapter: chapter.id)
                }
                entry.indentationLevel = chapter.actID == nil ? 0 : 1
            }
            menu.addItem(entry)
        }
    }

    /// 设置 changed the typography: read-only text is styled again from the
    /// chapters, and every row is measured again; editors restyle themselves.
    @objc private func typographyChanged() {
        previews.removeAll(); previewOrder.removeAll()
        for slot in chapterSlots {
            slot.height = nil
            if let row = slot.chapterRow, !row.isAttached {
                row.measured = nil
                row.showPlaceholder(height: estimatedBodyHeight(chapterID: row.chapter.id, row: row))
            }
        }
        for slot in slots { slot.height = nil }
        placeRows()
        schedulePass()
    }

    // MARK: Word counts and statuses

    /// The project's counts changed: headers, estimates and 统计 follow.
    func applyWordCounts(_ library: WordCountLibrary) {
        guard counts != library else { return }
        let changed = Set(library.nodes.filter { counts?.count(nodeID: $0.nodeId) != $0.wordCount }.map(\.nodeId))
        counts = library
        var first: Int?
        for slot in chapterSlots {
            guard case .chapter(let chapter) = slot.item else { continue }
            slot.chapterRow?.showWords(library.count(nodeID: chapter.id), loaded: true)
            guard changed.contains(chapter.id) else { continue }
            // Another view saved this body: its read-only text is stale.
            if slot.chapterRow?.isAttached != true { forgetPreview(chapter.id) }
            if let row = slot.chapterRow, row.shown == .placeholder { setPlaceholder(row) }
            if slot.height == nil || slot.row == nil { first = min(first ?? .max, slotIndex[slot.key] ?? 0) }
        }
        if let first { placeRows(from: first) }
        statsController?.reload()
        schedulePass()
    }

    /// Statuses written elsewhere (a page, the outline, the chapter list).
    func applyNodeMetadata(_ metadata: WorkspaceNodeMetadata) { model.applyNodeMetadata(metadata) }

    // MARK: Navigation

    /// Scrolls so the chapter's title is at the top; its editor attaches
    /// there. With a heading, the caret moves to it once the editor is ready.
    func scroll(toChapter id: String, blockID: String? = nil) {
        guard slotsByKey["chapter:\(id)"] != nil else { return }
        if let blockID { pendingReveal = (id, blockID) }
        scroll(toKey: "chapter:\(id)", offset: -Self.topInset)
    }

    func scroll(toAct id: String) { scroll(toKey: "act:\(id)", offset: 0) }

    private func scroll(toKey key: String, offset: CGFloat) {
        guard slotsByKey[key] != nil else { return }
        anchor = (key, offset)
        restoreAnchor()
        schedulePass()
    }

    /// Scrolls the long page to a point, as the scroll wheel does.
    func scrollDocument(toY y: CGFloat) {
        let clip = scrollView.contentView
        let maximum = max(0, documentView.frame.height - clip.bounds.height)
        clip.scroll(to: NSPoint(x: 0, y: min(max(0, y), maximum)))
        scrollView.reflectScrolledClipView(clip)
    }

    @objc private func scrolled() {
        if !restoringAnchor, !placingRows { recordAnchor() }
        schedulePass()
    }

    /// The first row at the top of the viewport and how far into it the top is.
    private func recordAnchor() {
        let top = scrollView.contentView.bounds.minY
        guard let slot = slots(in: NSRect(x: 0, y: top, width: 1, height: 1)).first ?? slots.last(where: { $0.frame.minY <= top }) else {
            anchor = nil; return
        }
        anchor = (slot.key, top - slot.frame.minY)
    }

    /// Rows above the reading position changed height: keep it in place.
    private func restoreAnchor() {
        guard let anchor, let slot = slotsByKey[anchor.key] else { return }
        let clip = scrollView.contentView
        let maximum = max(0, documentView.frame.height - clip.bounds.height)
        let target = min(max(0, slot.frame.minY + anchor.offset), maximum)
        guard abs(target - clip.bounds.minY) >= 0.5 else { return }
        restoringAnchor = true
        clip.scroll(to: NSPoint(x: clip.bounds.minX, y: target))
        scrollView.reflectScrolledClipView(clip)
        restoringAnchor = false
    }

    // MARK: Virtualization

    private func schedulePass() {
        guard !passScheduled, !isShutDown else { return }
        passScheduled = true
        DispatchQueue.main.async { [weak self] in self?.runPass() }
    }

    private func scheduleRetry(after delay: TimeInterval = MacWholeBookViewController.retryDelay) {
        guard !retryScheduled, !isShutDown else { return }
        retryScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.retryScheduled = false
            self?.schedulePass()
        }
    }

    private var bands: (visible: NSRect, attach: NSRect, keep: NSRect, preview: NSRect) {
        let visible = scrollView.contentView.bounds
        let span = max(visible.height, 240)
        return (visible, visible.insetBy(dx: 0, dy: -span * Self.attachMargin),
                visible.insetBy(dx: 0, dy: -span * (Self.attachMargin + 0.5)), visible.insetBy(dx: 0, dy: -span * Self.previewMargin))
    }

    /// Slots whose frames meet `rect`, found by bisection.
    private func slots(in rect: NSRect, from list: [Slot]? = nil) -> ArraySlice<Slot> {
        let list = list ?? slots
        var low = 0, high = list.count
        while low < high {
            let middle = (low + high) / 2
            if list[middle].frame.maxY <= rect.minY { low = middle + 1 } else { high = middle }
        }
        var end = low
        while end < list.count, list[end].frame.minY < rect.maxY { end += 1 }
        return list[low..<end]
    }

    /// Chapters that should have an editor: those in the attach band nearest
    /// the viewport's centre, and a chapter asked for by a jump or a click.
    private func wanted() -> [WholeBookChapterRow] {
        guard !shuttingDown, !isShutDown else { return [] }
        let (visible, attach, _, _) = bands
        let center = visible.midY
        func distance(_ frame: NSRect) -> CGFloat {
            frame.minY > center ? frame.minY - center : (frame.maxY < center ? center - frame.maxY : 0)
        }
        var near = slots(in: attach, from: chapterSlots).sorted { distance($0.frame) < distance($1.frame) }.compactMap(\.chapterRow)
        for id in [pendingReveal?.chapterID, pendingFocus?.chapterID].compactMap({ $0 }) {
            if let row = chapterRow(id), !near.prefix(Self.maximumAttached).contains(where: { $0 === row }) { near.insert(row, at: 0) }
        }
        return Array(near.prefix(Self.maximumAttached))
    }

    /// Owner changes suspend every editor: they wait while any body has input
    /// in flight, while another owner change runs and for a pause in typing.
    private var canChangeOwners: Bool {
        !ownerOperation && !workspace.isChangingOwners && !workspace.hasPendingDocuments
            && (lastEdit.map { Date().timeIntervalSince($0) >= Self.typingPause } ?? true)
    }

    private func runPass() { timed { pass() } }

    private func pass() {
        passScheduled = false
        guard !isShutDown else { return }
        if shuttingDown, ownersToClose.isEmpty, !ownerOperation, retired.isEmpty { finishShutdown(); return }
        guard isViewLoaded, laidOutWidth > 0 else { return }
        var (visible, _, keepBand, previewBand) = bands
        if !shuttingDown {
            updateShownRows(near: previewBand, keep: previewBand.insetBy(dx: 0, dy: -visible.height * 0.5))
            (visible, _, keepBand, previewBand) = bands
        }
        var blocked = false
        // A retired owner (trash, workspace close) leaves its editor unusable.
        for row in attachedRows + retired where row.core?.isClosed == true { dropClosed(row) }
        retired.removeAll { row in !row.isAttached || release(row) }
        // A kept owner closed elsewhere is gone; one whose chapter left the book closes.
        keptOwners.removeAll { $0.core.isClosed }
        for entry in keptOwners {
            guard case .chapter(let chapter) = entry.scope, slotsByKey["chapter:\(chapter.chapterID)"] == nil else { continue }
            keptOwners.removeAll { $0.scope == entry.scope }
            ownersToClose[entry.scope] = entry.core
        }
        let wanted = wanted()
        let wantedIDs = Set(wanted.map { ObjectIdentifier($0) })
        let unwanted = attachedRows.filter { !wantedIDs.contains(ObjectIdentifier($0)) }
        // The chapter being written in stays while it is nearby, beyond the bound.
        let exempt = unwanted.filter { $0.isFocused && $0.frame.intersects(previewBand) && !shuttingDown }
        let others = unwanted.filter { row in !exempt.contains { $0 === row } }
            .sorted { abs($0.frame.midY - visible.midY) > abs($1.frame.midY - visible.midY) }
        var surplus = attachedRows.count - exempt.count + wanted.filter { !$0.isAttached }.count - Self.maximumAttached
        for row in others where surplus > 0 || !row.frame.intersects(keepBand) || shuttingDown {
            if release(row) { surplus -= 1 } else { blocked = true }
        }
        if !retired.isEmpty { blocked = true }
        // An owner whose close failed waits a while before the next attempt.
        let waiting = ownersToClose.keys.compactMap { closeFailures[$0].map { Self.closeRetryDelay - Date().timeIntervalSince($0.at) } }
        let closable = ownersToClose.first { entry in closeFailures[entry.key].map { Date().timeIntervalSince($0.at) >= Self.closeRetryDelay } ?? true }
        if canChangeOwners {
            if let entry = closable {
                closeOwner(entry.key, entry.value)
            } else {
                let busy = chapterSlots.compactMap(\.chapterRow).filter { $0.isAttached || $0.opening }.count - exempt.count
                if busy < Self.maximumAttached,
                   let next = wanted.first(where: { !$0.isAttached && !$0.opening && !recentlyFailed($0) }) {
                    attach(next)
                }
            }
        } else if closable != nil || wanted.contains(where: { !$0.isAttached && !recentlyFailed($0) }) {
            blocked = true
        }
        showPreviews(in: previewBand, skipping: wantedIDs)
        resolvePending()
        if blocked || wanted.contains(where: { recentlyFailed($0) }) { scheduleRetry() }
        else if let wait = waiting.min(), closable == nil { scheduleRetry(after: max(Self.retryDelay, wait)) }
        if shuttingDown, ownersToClose.isEmpty, !ownerOperation, retired.isEmpty { finishShutdown() }
    }

    private func recentlyFailed(_ row: WholeBookChapterRow) -> Bool {
        guard let failed = row.openFailed else { return false }
        if Date().timeIntervalSince(failed) > 2 { row.openFailed = nil; return false }
        return true
    }

    private func attach(_ row: WholeBookChapterRow) {
        let chapterID = row.chapter.id, scope = row.scope
        ownerOperation = true
        row.opening = true
        workspace.openChapter(projectID: project.id, chapterID: chapterID) { [weak self, weak row] result in
            guard let self else { return }
            self.ownerOperation = false
            row?.opening = false
            switch result {
            case .success(let core):
                self.ownersToClose.removeValue(forKey: scope)
                self.keptOwners.removeAll { $0.scope == scope }
                if self.closeFailures.removeValue(forKey: scope) != nil { self.showStatus() }
                if let row, self.chapterRow(chapterID) === row, row.superview != nil, !self.shuttingDown, !self.isShutDown {
                    row.openFailed = nil
                    self.install(core, in: row)
                } else if self.host?.hasTab(scope) != true {
                    self.ownersToClose[scope] = core
                }
            case .failure(let error):
                row?.openFailed = Date()
                self.statusLabel.stringValue = error.localizedDescription
                self.statusLabel.isHidden = false
            }
            self.schedulePass()
        }
    }

    /// The chapter's editor, backed by its owner as a tab's is.
    private func install(_ core: LabCore, in row: WholeBookChapterRow) {
        let view = NativeDocumentView(core: core, allowsComments: true, minimumTextHeight: 48, growsWithText: true)
        view.setAccessibilityIdentifier("whole-book-editor-\(row.chapter.id)")
        host?.adoptExternal(view, project: project, chapterID: row.chapter.id)
        view.onOpenLink = { [weak self] target in
            guard let self else { return }
            if let onOpenLink = self.onOpenLink { onOpenLink(target) } else { self.host?.openLink(target, project: self.project) }
        }
        view.onActivity = { [weak self, weak view] busy in
            guard let self else { return }
            if !busy, let view { self.host?.externalBodySettled(view) }
            self.schedulePass()
        }
        view.onHeightChange = { [weak self, weak row] in if let self, let row { self.rowChanged(row) } }
        view.onEdited = { [weak self, weak view, weak row] in
            self?.lastEdit = Date()
            if let self, let row { self.editCount += 1; self.edits[row.chapter.id] = self.editCount }
            DispatchQueue.main.async { if let view { self?.keepCaretVisible(view) } }
        }
        row.showEditor(view, core: core)
        view.binding.load()
        rowChanged(row)
    }

    private func disconnect(_ view: NativeDocumentView) {
        host?.releaseExternal(view)
        view.onOpenLink = nil; view.onActivity = nil; view.onEdited = nil; view.onHeightChange = nil
    }

    /// Detaches an editor with nothing in flight; its owner is closed later
    /// when no tab shows the chapter. False, changing nothing, otherwise.
    @discardableResult
    private func release(_ row: WholeBookChapterRow) -> Bool {
        guard let view = row.editor, let core = row.core else { return true }
        let binding = view.binding
        guard !binding.hasPendingWork, !binding.hasUnsubmittedDraft, !view.textView.hasMarkedText() else { return false }
        let focused = view.window?.firstResponder === view.textView
        let projection = binding.store.projection
        guard binding.detach() else { return false }
        disconnect(view)
        if focused { view.window?.makeFirstResponder(nil) }
        row.removeEditor()
        if let projection {
            let text = styled(projection)
            remember(text, for: row.chapter.id)
            row.showPreview(text)
        } else {
            row.showPlaceholder(height: estimatedBodyHeight(chapterID: row.chapter.id, row: row))
        }
        rowChanged(row)
        if !core.isClosed, host?.hasTab(row.scope) != true {
            // Edited here and still undoable: the owner stays for ⌘Z on return.
            if !shuttingDown, edits[row.chapter.id] != nil, projection.map({ $0.canUndo || $0.canRedo }) == true {
                keep(row.scope, core)
            } else {
                ownersToClose[row.scope] = core
            }
        }
        return true
    }

    /// Keeps an edited chapter's owner open without an editor. Beyond the
    /// limit, the least recently edited one is closed and loses its undo.
    private func keep(_ scope: DocumentScope, _ core: LabCore) {
        func order(_ scope: DocumentScope) -> Int {
            if case .chapter(let chapter) = scope { return edits[chapter.chapterID] ?? 0 }
            return 0
        }
        keptOwners.removeAll { $0.scope == scope }
        keptOwners.append((scope, core))
        keptOwners.sort { order($0.scope) < order($1.scope) }
        while keptOwners.count > Self.keptOwnerLimit {
            let oldest = keptOwners.removeFirst()
            ownersToClose[oldest.scope] = oldest.core
        }
    }

    /// The owner was retired elsewhere: its editor can no longer edit.
    private func dropClosed(_ row: WholeBookChapterRow) {
        guard let view = row.editor else { return }
        _ = view.binding.detach()
        disconnect(view)
        row.removeEditor()
        forgetPreview(row.chapter.id)
        row.showPlaceholder(height: estimatedBodyHeight(chapterID: row.chapter.id, row: row))
        rowChanged(row)
    }

    private func closeOwner(_ scope: DocumentScope, _ core: LabCore) {
        // A tab or another view opened the chapter meanwhile, or the owner was retired.
        guard !core.isClosed, host?.hasTab(scope) != true, !core.hasDocumentViews, case .chapter(let chapter) = scope,
              chapterRow(chapter.chapterID)?.isAttached != true else {
            ownersToClose.removeValue(forKey: scope)
            if closeFailures.removeValue(forKey: scope) != nil { showStatus() }
            schedulePass(); return
        }
        ownerOperation = true
        let done: (Result<Bool, Error>) -> Void = { [weak self] result in
            guard let self else { return }
            self.ownerOperation = false
            switch result {
            case .success:
                self.ownersToClose.removeValue(forKey: scope)
                if self.closeFailures.removeValue(forKey: scope) != nil { self.showStatus() }
            case .failure(let error):
                // Still tracked, named in the status line and tried again
                // after a pause; a shutdown waiting on it hears why.
                let title = self.slotsByKey["chapter:\(chapter.chapterID)"].flatMap { slot -> String? in
                    if case .chapter(let item) = slot.item { return item.title }; return nil
                } ?? self.closeFailures[scope]?.title ?? "章节"
                self.closeFailures[scope] = (title, error.localizedDescription, Date())
                self.showStatus()
                self.reportShutdownFailure()
            }
            self.schedulePass()
        }
        if let closeChapterOwner { closeChapterOwner(chapter, done) }
        else { workspace.closeChapter(projectID: chapter.projectID, chapterID: chapter.chapterID, completion: done) }
    }

    // MARK: Read-only text

    /// Shown rows without an editor show read-only text once read; the
    /// nearest missing one is read next.
    private func showPreviews(in band: NSRect, skipping wanted: Set<ObjectIdentifier>) {
        let near = slots(in: band, from: chapterSlots).compactMap { $0.isShown ? $0.chapterRow : nil }
        for row in near where !row.isAttached && row.shown == .placeholder {
            if let text = previews[row.chapter.id] { row.showPreview(text); rowChanged(row) }
        }
        guard previewLoading == nil, !shuttingDown else { return }
        let center = bands.visible.midY
        let missing = near.filter {
            !$0.isAttached && !$0.opening && !wanted.contains(ObjectIdentifier($0)) && previews[$0.chapter.id] == nil
        }.min { abs($0.frame.midY - center) < abs($1.frame.midY - center) }
        guard let row = missing else { return }
        let chapterID = row.chapter.id
        previewLoading = chapterID
        workspace.agentReadProse(projectID: project.id, kind: "chapter", id: chapterID) { [weak self] result in
            guard let self else { return }
            self.previewLoading = nil
            if case .success(let prose) = result {
                self.remember(NSAttributedString(string: prose.text, attributes: DocumentStyle.bodyAttributes), for: chapterID)
            } else {
                // Unreadable: keep a line saying so and do not ask again this session.
                self.remember(NSAttributedString(string: "（正文暂时无法读取）", attributes: DocumentStyle.bodyAttributes), for: chapterID)
            }
            self.schedulePass()
        }
    }

    private func styled(_ projection: NativeProjection) -> NSAttributedString {
        let storage = NSTextStorage(string: projection.text)
        DocumentStyle.apply(projection, to: storage, links: host?.linkDirectory(projectID: project.id))
        return storage
    }

    private func remember(_ text: NSAttributedString, for chapterID: String) {
        previews[chapterID] = text
        previewOrder.removeAll { $0 == chapterID }
        previewOrder.append(chapterID)
        while previewOrder.count > Self.previewLimit {
            let old = previewOrder.removeFirst()
            previews.removeValue(forKey: old)
        }
    }

    private func forgetPreview(_ chapterID: String) {
        previews.removeValue(forKey: chapterID)
        previewOrder.removeAll { $0 == chapterID }
    }

    // MARK: Focus and reveal

    private func ready(_ row: WholeBookChapterRow) -> NativeDocumentView? {
        guard let view = row.editor, view.binding.canEdit, !view.binding.hasPendingWork,
              let projection = view.binding.store.projection, NativeText.identical(view.textView.string, projection.text) else { return nil }
        return view
    }

    /// A heading from the outline, or a click on read-only text, once the
    /// chapter's editor is ready and placed.
    private func resolvePending() {
        guard !fitScheduled else { return }
        if let reveal = pendingReveal {
            if let row = chapterRow(reveal.chapterID) {
                if let view = ready(row) {
                    pendingReveal = nil
                    if view.reveal(blockId: reveal.blockID), let rect = caretRect(view) {
                        anchor = ("chapter:\(reveal.chapterID)", rect.minY - row.frame.minY - 24)
                        restoreAnchor()
                    } else {
                        statusLabel.stringValue = "标题已变化，请重新选择大纲位置。"; statusLabel.isHidden = false
                    }
                }
            } else if slotsByKey["chapter:\(reveal.chapterID)"] == nil { pendingReveal = nil }
        }
        if let focus = pendingFocus {
            if let row = chapterRow(focus.chapterID) {
                if let view = ready(row) {
                    pendingFocus = nil
                    let length = (view.textView.string as NSString).length
                    view.window?.makeFirstResponder(view.textView)
                    view.textView.setSelectedRange(NSRange(location: min(max(0, focus.location), length), length: 0))
                }
            } else if slotsByKey["chapter:\(focus.chapterID)"] == nil { pendingFocus = nil }
        }
    }

    /// The caret's rectangle in the long page.
    private func caretRect(_ view: NativeDocumentView) -> NSRect? {
        let text = view.textView
        guard let manager = text.layoutManager, let container = text.textContainer else { return nil }
        let location = min(text.selectedRange().location, (text.string as NSString).length)
        let glyphs = manager.glyphRange(forCharacterRange: NSRange(location: location, length: 0), actualCharacterRange: nil)
        var rect = manager.boundingRect(forGlyphRange: glyphs, in: container)
        if rect.height < 1 { rect = manager.extraLineFragmentRect }
        rect.origin.x += text.textContainerOrigin.x; rect.origin.y += text.textContainerOrigin.y
        rect.size.width = max(rect.width, 2)
        return text.convert(rect, to: documentView)
    }

    /// Typing near the bottom of the viewport keeps the caret in view.
    private func keepCaretVisible(_ view: NativeDocumentView) {
        guard view.window?.firstResponder === view.textView, let rect = caretRect(view) else { return }
        _ = documentView.scrollToVisible(rect.insetBy(dx: 0, dy: -28))
    }

    // MARK: 统计

    @objc private func toggleStats() {
        if statsPopover.isShown { statsPopover.performClose(nil); return }
        showStats()
    }

    /// Opens 统计 under its button (or builds it when the panel is not on screen).
    func showStats() {
        let controller = statsController ?? makeStats()
        controller.reload()
        if statsButton.window?.isVisible == true {
            statsPopover.contentViewController = controller
            statsPopover.show(relativeTo: statsButton.bounds, of: statsButton, preferredEdge: .maxY)
        } else {
            _ = controller.view
        }
    }

    private func makeStats() -> MacBookStatsViewController {
        let controller = MacBookStatsViewController(model: model)
        controller.counts = { [weak self] in self?.counts }
        controller.plan = { [weak self] in self?.plan() ?? WritingPlan() }
        controller.today = { [weak self] in self?.todayWords() }
        controller.onSelectChapter = { [weak self] chapter in
            self?.statsPopover.performClose(nil)
            self?.scroll(toChapter: chapter.id)
        }
        controller.onSelectAct = { [weak self] act in
            self?.statsPopover.performClose(nil)
            self?.scroll(toAct: act.id)
        }
        statsController = controller
        return controller
    }

    // MARK: Closing

    @objc private func closePressed() { onClose?() }

    /// Releases every editor and closes the owners no tab shows (kept ones
    /// too), one at a time; `completion` runs with nil once they are closed,
    /// or with the reason as soon as one fails to close. That owner stays
    /// tracked and is closed again later. False, changing nothing, while an
    /// editor has input in flight.
    @discardableResult
    func shutdown(completion: ((String?) -> Void)? = nil) -> Bool {
        if isShutDown { completion?(nil); return true }
        guard !hasInputInFlight else { return false }
        let attached = attachedRows + retired
        shuttingDown = true
        pendingReveal = nil; pendingFocus = nil
        statsPopover.close()
        for row in attached where !release(row) { dropClosed(row) }
        retired.removeAll()
        for entry in keptOwners { ownersToClose[entry.scope] = entry.core }
        keptOwners.removeAll()
        if let completion { drained.append(completion) }
        closingSelf = self
        passScheduled = false
        // An owner that already failed to close is reported at once.
        if !closeFailures.isEmpty { reportShutdownFailure() }
        schedulePass()
        return true
    }

    /// A shutdown waiting for owners hears that one could not be closed.
    private func reportShutdownFailure() {
        guard shuttingDown, let text = closeFailureText, !drained.isEmpty else { return }
        let callbacks = drained
        drained = []
        callbacks.forEach { $0(text) }
    }

    private func finishShutdown() {
        guard !isShutDown else { return }
        isShutDown = true
        let callbacks = drained
        drained = []
        callbacks.forEach { $0(nil) }
        closingSelf = nil
    }
}

/// Which 全书长卷 is open, and every one whose panel closed while its
/// owners still close (each keeps itself alive until it has shut down).
/// Closing detaches the open one first, so a shutdown that completes at
/// once (an owner-less or already shut-down book) finds the presenter free
/// and a reopen in its completion is never skipped.
final class WholeBookPresenter {
    private(set) var controller: MacWholeBookViewController?
    private(set) var panel: NSWindow?
    private let closing = NSHashTable<MacWholeBookViewController>.weakObjects()

    /// Books whose panels closed and whose owners are still closing.
    var closingControllers: [MacWholeBookViewController] { closing.allObjects.filter { !$0.isShutDown } }

    /// The open book and every closing one, e.g. for 删除项目 to ask.
    var all: [MacWholeBookViewController] { [controller].compactMap { $0 } + closingControllers }

    func present(_ controller: MacWholeBookViewController, panel: NSWindow?) {
        self.controller = controller
        self.panel = panel
    }

    /// The panel closed by itself: nothing is open any longer.
    func panelClosed(_ panel: NSWindow) {
        guard self.panel === panel else { return }
        self.panel = nil
        controller = nil
    }

    /// Releases the open book's editors and detaches its panel; `completion`
    /// runs once its owners are closed, or with the reason one could not be
    /// closed (it keeps trying). False, keeping everything, while one of its
    /// editors has input in flight.
    @discardableResult
    func close(detach: (NSWindow) -> Void, completion: ((String?) -> Void)? = nil) -> Bool {
        guard let controller else { completion?(nil); return true }
        guard !controller.hasInputInFlight else { return false }
        let panel = self.panel
        self.controller = nil
        self.panel = nil
        if let panel { detach(panel) }
        if !controller.isShutDown { closing.add(controller) }
        // Nothing is in flight, so the shutdown is accepted; its completion
        // may run before this returns.
        _ = controller.shutdown(completion: completion)
        return true
    }
}
