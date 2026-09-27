import AppKit

final class ReviewPanel: NSPanel {
    var onClose: (() -> Void)?
    /// The panel became key again, e.g. after edits in the main window.
    var onBecomeKey: (() -> Void)?
    override func close() { super.close(); onClose?() }
    override func becomeKey() { super.becomeKey(); onBecomeKey?() }
}

/// The actions of one note or TODO, shared by the 审阅 panel and the
/// 备忘与素材 board: the ⋯ menu, the compose and edit sheets and the delete
/// confirmation. Every command goes through the project's review model.
final class ReviewCommands {
    let model: ReviewModel
    /// 定位: open the page, and select a passage note's anchor.
    var onLocate: ((WorkspaceComment) -> Void)?
    /// Opens an associated entity.
    var onOpen: ((RelationEndpoint) -> Void)?
    /// Presents a confirmation. Nil uses a sheet on `window`; acceptance
    /// answers here without one.
    var presentAlert: ((NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void)?
    /// Presents a sheet window. Nil begins it on `window`.
    var presentSheet: ((NSWindow) -> Void)?
    /// The window sheets and alerts attach to.
    var window: () -> NSWindow? = { nil }
    /// The open 新建 sheet or 编辑 composer, if any.
    private(set) var composeSheet: ReviewComposeSheet?
    private(set) var editor: MacCommentComposerViewController?

    init(model: ReviewModel) { self.model = model }

    // MARK: Menu

    /// ⋯ of a card: 优先级, 批注 ↔ 待办, 关联, 编辑 and 删除.
    func menuItems(for comment: WorkspaceComment) -> [NSMenuItem] {
        var items: [NSMenuItem] = []
        let priority = NSMenuItem(title: "优先级", action: nil, keyEquivalent: "")
        priority.setAccessibilityIdentifier("review-priority")
        let levels = NSMenu(title: "优先级")
        levels.autoenablesItems = false
        let options: [(CommentPriority?, String)] = [(nil, "无")] + CommentPriority.allCases.map { ($0, $0.label) }
        for (level, title) in options {
            let item = LibraryMenuItem(title: title, identifier: "review-priority-\(level?.rawValue ?? "none")") { [weak self] in
                guard comment.priorityLevel != level else { return }
                self?.model.setPriority(id: comment.id, level)
            }
            item.state = comment.priorityLevel == level ? .on : .off
            levels.addItem(item)
        }
        priority.submenu = levels
        items.append(priority)
        let convert = LibraryMenuItem(title: comment.isTodo ? "转为批注" : "转为待办", identifier: "review-convert") { [weak self] in
            self?.model.convert(id: comment.id)
        }
        if comment.isTodo, comment.isFloating {
            convert.isEnabled = false
            convert.toolTip = "浮动的待办不能转为批注。可以先关联到页面，或在页面上写批注。"
        }
        items.append(convert)
        items.append(.separator())
        let associate = NSMenuItem(title: "关联", action: nil, keyEquivalent: "")
        associate.setAccessibilityIdentifier("review-associate")
        associate.submenu = AssociationMenu.make(candidates: model.associations.candidates(for: comment.endpoint, excluding: comment.target.map { [$0] } ?? []),
                                                 prefix: "review-associate") { [weak self] target in
            self?.model.associate(id: comment.id, with: target)
        }
        items.append(associate)
        let existing = model.associations.entries(of: comment.endpoint)
        if !existing.isEmpty {
            let remove = NSMenuItem(title: "移除关联", action: nil, keyEquivalent: "")
            remove.setAccessibilityIdentifier("review-dissociate")
            let submenu = NSMenu(title: "移除关联")
            for entry in existing {
                submenu.addItem(LibraryMenuItem(title: entry.label, identifier: "review-dissociate-\(entry.target.kind)-\(entry.target.id)") {
                    [weak self] in self?.model.dissociate(id: comment.id, from: entry.target)
                })
            }
            remove.submenu = submenu
            items.append(remove)
        }
        items.append(.separator())
        let edit = LibraryMenuItem(title: "编辑…", identifier: "review-edit") { [weak self] in self?.edit(comment) }
        edit.isEnabled = comment.canEditBody
        items.append(edit)
        items.append(LibraryMenuItem(title: "删除…", identifier: "review-delete") { [weak self] in self?.confirmDelete(comment) })
        for item in items where model.busy { item.isEnabled = false }
        return items
    }

    // MARK: Sheets

    /// 新建批注 or 新建待办: on the focused page, or a floating TODO.
    func compose(kind: String) {
        // A sheet needs a window; one left unshown would block later sheets.
        guard composeSheet == nil, editor == nil, presentSheet != nil || window() != nil else { return }
        let sheet = ReviewComposeSheet(kind: kind, focus: model.focus, associations: model.associations)
        composeSheet = sheet
        sheet.onSubmit = { [weak self] draft, done in
            guard let self else { done(LabError.message("审阅已关闭。")); return }
            self.model.create(kind: draft.kind, onFocus: draft.onFocus, body: draft.body, priority: draft.priority,
                              associate: draft.associations) { result in
                switch result {
                case .success: done(nil)
                case .failure(let error): done(error)
                }
            }
        }
        sheet.onFinish = { [weak self, weak sheet] in
            guard let self, let sheet, self.composeSheet === sheet else { return }
            self.composeSheet = nil
            if let parent = sheet.window.sheetParent { parent.endSheet(sheet.window) } else { sheet.window.orderOut(nil) }
        }
        present(sheet.window)
        sheet.focusBody()
    }

    /// 编辑: the body in the comment composer; a refusal keeps the typed text.
    func edit(_ comment: WorkspaceComment) {
        guard comment.canEditBody, composeSheet == nil, editor == nil, presentSheet != nil || window() != nil else { return }
        let composer = MacCommentComposerViewController(title: comment.isTodo ? "编辑待办" : "编辑批注", confirmTitle: "保存",
                                                        quote: comment.selectedText, text: comment.bodyText)
        editor = composer
        composer.onSubmit = { [weak self] body, done in
            guard let self else { done(LabError.message("审阅已关闭。")); return }
            self.model.updateBody(id: comment.id, body: body) { result in
                switch result {
                case .success: done(nil)
                case .failure(let error): done(error)
                }
            }
        }
        composer.onFinish = { [weak self, weak composer] in
            if let self, self.editor === composer { self.editor = nil }
        }
        if let presentSheet {
            let sheet = NSWindow(contentViewController: composer)
            sheet.styleMask = [.titled]
            presentSheet(sheet)
        } else if let window = window() { composer.present(on: window) }
    }

    /// 删除…: after confirmation, the row and its 关联 go; prose is untouched.
    func confirmDelete(_ comment: WorkspaceComment) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "删除这条\(comment.kindLabel)？"
        alert.informativeText = "删除后无法恢复。它的关联会一并移除，正文不受影响。"
            + (comment.isBlock ? "正文中的批注高亮也会随之消失。" : "")
        alert.addButton(withTitle: "删除").setAccessibilityIdentifier("confirm-delete-review-item")
        alert.addButton(withTitle: "取消")
        let finish: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard response == .alertFirstButtonReturn else { return }
            self?.model.delete(id: comment.id)
        }
        if let presentAlert { presentAlert(alert, finish) }
        else if let window = window() { alert.beginSheetModal(for: window, completionHandler: finish) }
    }

    func endSheets() {
        composeSheet?.cancel()
        if let editor, let sheet = editor.view.window, let parent = sheet.sheetParent { parent.endSheet(sheet) }
        editor = nil
    }

    private func present(_ sheet: NSWindow) {
        if let presentSheet { presentSheet(sheet) } else if let window = window() { window.beginSheet(sheet) }
    }
}

/// 审阅: the project's notes and TODOs. 全部/批注/待办 filter the kind; 当前
/// lists those on the focused page (whole page first, then its passages,
/// then associated ones) and 全书 every one. Open items come first; resolved
/// ones wait under 已解决. Selection notes are still written in the editor
/// (⌥⌘M); the chapter's 批注 panel shows their anchors.
final class MacReviewViewController: NSViewController {
    let model: ReviewModel
    let commands: ReviewCommands
    /// The live anchor of a passage note whose chapter is open.
    var anchor: ((WorkspaceComment) -> NativeComment?)?
    /// 本章批注…: the active chapter's comment panel.
    var onShowChapterComments: (() -> Void)?
    /// 看板…: the 备忘与素材 board.
    var onShowBoard: (() -> Void)?
    var onClose: (() -> Void)?
    let filterControl = NSSegmentedControl(labels: ReviewFilter.allCases.map(\.label), trackingMode: .selectOne, target: nil, action: nil)
    let scopeControl = NSSegmentedControl(labels: ["当前", "全书"], trackingMode: .selectOne, target: nil, action: nil)
    let newNoteButton = NSButton(title: "新建批注…", target: nil, action: nil)
    let newTodoButton = NSButton(title: "新建待办…", target: nil, action: nil)
    let chapterCommentsButton = NSButton(title: "本章批注…", target: nil, action: nil)
    let boardButton = NSButton(title: "看板…", target: nil, action: nil)
    let resolvedToggle = NSButton(title: "", target: nil, action: nil)
    let focusLabel = NSTextField(labelWithString: "")
    let statusLabel = NSTextField(wrappingLabelWithString: "")
    private let list = NSStackView()
    private let resolvedList = NSStackView()
    private let empty = NSTextField(wrappingLabelWithString: "")
    private(set) var cards: [String: ReviewCardView] = [:]
    private(set) var renderedIDs: [String] = []
    private(set) var renderedResolvedIDs: [String] = []
    var showsResolved = false { didSet { if oldValue != showsResolved { reload() } } }

    init(model: ReviewModel) {
        self.model = model
        commands = ReviewCommands(model: model)
        super.init(nibName: nil, bundle: nil)
        commands.window = { [weak self] in self?.view.window }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        view = NSView()
        filterControl.target = self; filterControl.action = #selector(filterChanged)
        filterControl.setAccessibilityIdentifier("review-filter")
        filterControl.selectedSegment = 0
        scopeControl.target = self; scopeControl.action = #selector(scopeChanged)
        scopeControl.setAccessibilityIdentifier("review-scope")
        scopeControl.toolTip = "当前：焦点标签页上的和关联到它的批注与待办；全书：项目里的全部"
        for (button, id, action) in [(newNoteButton, "review-new-note", #selector(newNote)),
                                     (newTodoButton, "review-new-todo", #selector(newTodo)),
                                     (chapterCommentsButton, "review-chapter-comments", #selector(chapterComments)),
                                     (boardButton, "review-show-board", #selector(showBoard))] {
            button.target = self; button.action = action
            button.setAccessibilityIdentifier(id)
        }
        chapterCommentsButton.toolTip = "当前章节的批注，含原文定位状态"
        boardButton.toolTip = "备忘与素材：待办和素材卡片"
        focusLabel.textColor = .secondaryLabelColor
        focusLabel.lineBreakMode = .byTruncatingTail
        focusLabel.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        focusLabel.setAccessibilityIdentifier("review-focus")
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.setAccessibilityIdentifier("review-status")
        list.orientation = .vertical; list.alignment = .leading; list.spacing = 10
        list.setAccessibilityIdentifier("review-list")
        resolvedList.orientation = .vertical; resolvedList.alignment = .leading; resolvedList.spacing = 8
        resolvedList.setAccessibilityIdentifier("review-resolved-list")
        resolvedToggle.isBordered = false
        resolvedToggle.font = .systemFont(ofSize: 12, weight: .medium)
        resolvedToggle.contentTintColor = .secondaryLabelColor
        resolvedToggle.target = self; resolvedToggle.action = #selector(toggleResolved)
        resolvedToggle.setAccessibilityIdentifier("review-toggle-resolved")
        empty.textColor = .secondaryLabelColor
        let content = NSStackView(views: [list, resolvedToggle, resolvedList])
        content.orientation = .vertical; content.alignment = .leading; content.spacing = 12
        content.translatesAutoresizingMaskIntoConstraints = false
        let document = ReviewFlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(content)
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        scroll.documentView = document
        let close = NSButton(title: "关闭", target: self, action: #selector(closeReview))
        close.setAccessibilityIdentifier("close-review")
        let filters = NSStackView(views: [filterControl, scopeControl, NSView(), newNoteButton, newTodoButton])
        filters.spacing = 8
        let focusRow = NSStackView(views: [focusLabel, NSView(), chapterCommentsButton, boardButton, close])
        focusRow.spacing = 8
        let stack = NSStackView(views: [filters, focusRow, statusLabel, scroll])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 14),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -14),
            filters.widthAnchor.constraint(equalTo: stack.widthAnchor),
            focusRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            statusLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 240),
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            content.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            content.topAnchor.constraint(equalTo: document.topAnchor),
            content.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            list.widthAnchor.constraint(equalTo: content.widthAnchor),
            resolvedList.widthAnchor.constraint(equalTo: content.widthAnchor),
        ])
        model.observe(self) { [weak self] in self?.reload() }
        reload()
    }

    /// Rebuilds the toolbar state and every card from the model.
    func reload() {
        guard isViewLoaded else { return }
        filterControl.selectedSegment = ReviewFilter.allCases.firstIndex(of: model.filter) ?? 0
        scopeControl.selectedSegment = model.effectiveScope == .current ? 0 : 1
        scopeControl.setEnabled(model.focus != nil, forSegment: 0)
        focusLabel.stringValue = model.focus.map { "当前：\($0.label)" } ?? "未打开页面 · 显示全书"
        statusLabel.stringValue = model.status
        for button in [newNoteButton, newTodoButton] { button.isEnabled = model.loaded && !model.busy }
        newNoteButton.toolTip = model.focus == nil ? "请先打开一个页面，再写批注" : "在\(model.focus!.label)上写批注"
        chapterCommentsButton.isHidden = model.focus?.endpoint.kind != "node" || onShowChapterComments == nil
        boardButton.isHidden = onShowBoard == nil
        for view in list.arrangedSubviews + resolvedList.arrangedSubviews { view.removeFromSuperview() }
        cards = [:]
        let open = model.openItems, resolved = model.resolvedItems
        renderedIDs = open.map(\.comment.id)
        renderedResolvedIDs = showsResolved ? resolved.map(\.comment.id) : []
        if open.isEmpty {
            empty.stringValue = !model.loaded ? "" : model.effectiveScope == .current
                ? "此范围内没有未解决的批注或待办。可以新建一条，或切换到全书。" : "项目里没有未解决的批注或待办。"
            list.addArrangedSubview(empty)
            empty.widthAnchor.constraint(equalTo: list.widthAnchor).isActive = true
        }
        for item in open { add(item.comment, to: list) }
        resolvedToggle.title = "\(showsResolved ? "▾" : "▸") 已解决（\(resolved.count)）"
        resolvedToggle.isHidden = resolved.isEmpty
        resolvedList.isHidden = !showsResolved
        if showsResolved { for item in resolved { add(item.comment, to: resolvedList) } }
        anchorSignature = anchorSignatureNow()
    }

    private func add(_ comment: WorkspaceComment, to stack: NSStackView) {
        let card = ReviewCardView(comment: comment, presentation: .panel, targetName: targetName(of: comment),
                                  anchor: comment.isBlock ? anchor?(comment) : nil,
                                  associations: model.associations.entries(of: comment.endpoint),
                                  menu: { [weak self] in self?.commands.menuItems(for: comment) ?? [] },
                                  actions: actions(for: comment))
        stack.addArrangedSubview(card)
        card.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        cards[comment.id] = card
    }

    func card(commentID: String) -> ReviewCardView? { cards[commentID] }

    private var anchorSignature = ""

    /// An open chapter rendered different anchors: passage cards whose
    /// placement or quote changed are shown again. Typing alone that only
    /// shifts ranges changes nothing here.
    func refreshAnchors() {
        guard isViewLoaded else { return }
        let signature = anchorSignatureNow()
        guard signature != anchorSignature else { return }
        reload()
    }

    private func anchorSignatureNow() -> String {
        (renderedIDs + renderedResolvedIDs).compactMap { id -> String? in
            guard let comment = model.comment(id: id), comment.isBlock else { return nil }
            let live = anchor?(comment)
            return "\(id)|\(live?.status ?? "-")|\(live?.quote ?? "")"
        }.joined(separator: "\n")
    }

    fileprivate func targetName(of comment: WorkspaceComment) -> String {
        guard let target = comment.target else { return "浮动" }
        let name = model.associations.names().name(of: target)
        return "\(name.kindLabel)「\(name.name)」"
    }

    private func actions(for comment: WorkspaceComment) -> ReviewCardView.Actions {
        ReviewCardView.Actions(
            locate: { [weak self] in self?.commands.onLocate?(comment) },
            edit: { [weak self] in self?.commands.edit(comment) },
            resolve: { [weak self] in self?.model.setResolved(id: comment.id, resolved: comment.review != .resolved) },
            open: { [weak self] entry in self?.commands.onOpen?(entry.target) },
            dissociate: { [weak self] entry in self?.model.dissociate(id: comment.id, from: entry.target) })
    }

    @objc private func filterChanged() { model.filter = ReviewFilter.allCases[max(0, filterControl.selectedSegment)] }
    @objc private func scopeChanged() { model.scope = scopeControl.selectedSegment == 0 ? .current : .project }
    @objc private func toggleResolved() { showsResolved.toggle() }
    @objc func newNote() { commands.compose(kind: "note") }
    @objc func newTodo() { commands.compose(kind: "todo") }
    @objc private func chapterComments() { onShowChapterComments?() }
    @objc private func showBoard() { onShowBoard?() }
    @objc private func closeReview() { commands.endSheets(); onClose?() }

    override func viewDidDisappear() {
        super.viewDidDisappear()
        commands.endSheets()
    }
}

final class ReviewFlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// One note or TODO on a soft wash: kind, priority, where it is written
/// and its state, a passage's quote, the body, 关联 chips and actions. No
/// edge accent.
final class ReviewCardView: NSView {
    enum Presentation { case panel, board }
    struct Actions {
        let locate: () -> Void
        let edit: () -> Void
        let resolve: () -> Void
        let open: (AssociationEntry) -> Void
        let dissociate: (AssociationEntry) -> Void
    }

    let comment: WorkspaceComment
    let headerLabel = NSTextField(labelWithString: "")
    let quoteLabel = NSTextField(wrappingLabelWithString: "")
    let bodyLabel = NSTextField(wrappingLabelWithString: "")
    let chips: AssociationChipsView
    let locateButton: ChipButton
    let editButton: ChipButton
    let resolveButton: ChipButton
    let actionsButton = NSPopUpButton(frame: .zero, pullsDown: true)
    private let menuItems: () -> [NSMenuItem]
    private let settled: Bool
    private let isTodo: Bool

    init(comment: WorkspaceComment, presentation: Presentation, targetName: String, anchor: NativeComment?,
         associations: [AssociationEntry], menu: @escaping () -> [NSMenuItem], actions: Actions) {
        self.comment = comment
        menuItems = menu
        settled = comment.review != .open
        isTodo = comment.isTodo
        chips = AssociationChipsView(prefix: "review-association-\(comment.id)")
        locateButton = ChipButton(title: "定位", pressed: actions.locate)
        editButton = ChipButton(title: "编辑", pressed: actions.edit)
        resolveButton = ChipButton(title: comment.review == .resolved ? "重新打开" : (presentation == .board ? "完成" : "解决"),
                                   pressed: actions.resolve)
        super.init(frame: .zero)
        wantsLayer = true
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityIdentifier("review-card-\(comment.id)")

        var facts = [comment.kindLabel]
        if let priority = comment.priorityLevel { facts.append("优先级\(priority.label)") }
        if presentation == .panel || comment.target != nil { facts.append(targetName) }
        if comment.isBlock { facts.append(anchor?.anchorStatus.label ?? "段落批注") }
        if comment.review == .resolved { facts.append("已解决") }
        if comment.isByAssistant { facts.append("写作助手") }
        else if comment.source != "manual" { facts.append(comment.source == "copilot" ? "来自 Copilot" : "外部来源") }
        headerLabel.stringValue = facts.joined(separator: " · ")
        headerLabel.font = .systemFont(ofSize: 11, weight: .medium)
        headerLabel.textColor = anchor.map { $0.anchorStatus == .anchored || $0.anchorStatus == .wholeBlock } == false
            ? .systemOrange : .secondaryLabelColor
        headerLabel.lineBreakMode = .byTruncatingTail
        headerLabel.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        headerLabel.setAccessibilityIdentifier("review-header-\(comment.id)")
        let quote = anchor.map { $0.quote.isEmpty ? comment.selectedText : $0.quote } ?? comment.selectedText
        quoteLabel.stringValue = "「\(MacChapterCommentsViewController.flatten(quote))」"
        quoteLabel.isHidden = !comment.isBlock || quote.isEmpty
        quoteLabel.font = .systemFont(ofSize: 12)
        quoteLabel.textColor = .secondaryLabelColor
        quoteLabel.maximumNumberOfLines = 2
        quoteLabel.lineBreakMode = .byTruncatingTail
        quoteLabel.setAccessibilityIdentifier("review-quote-\(comment.id)")
        let body = comment.bodyText
        bodyLabel.stringValue = body.isEmpty ? "（空）" : body
        bodyLabel.font = .systemFont(ofSize: 13)
        bodyLabel.textColor = settled ? .secondaryLabelColor : .labelColor
        bodyLabel.maximumNumberOfLines = presentation == .board ? 6 : 0
        bodyLabel.setAccessibilityIdentifier("review-body-\(comment.id)")
        chips.show(associations)
        chips.onOpen = actions.open
        chips.onRemove = actions.dissociate
        locateButton.isEnabled = comment.target != nil
        locateButton.toolTip = comment.target == nil ? "浮动待办没有所在的页面" : comment.isBlock ? "打开章节并选中批注的原文" : "打开所在页面"
        locateButton.setAccessibilityIdentifier("locate-review-\(comment.id)")
        editButton.isHidden = !comment.canEditBody
        editButton.setAccessibilityIdentifier("edit-review-\(comment.id)")
        resolveButton.isHidden = !comment.canChangeResolution
        resolveButton.setAccessibilityIdentifier("resolve-review-\(comment.id)")
        for button in [locateButton, editButton, resolveButton] {
            button.font = .systemFont(ofSize: 12)
            button.contentTintColor = .controlAccentColor
        }
        actionsButton.addItem(withTitle: "⋯")
        actionsButton.isBordered = false
        actionsButton.setAccessibilityIdentifier("review-actions-\(comment.id)")
        actionsButton.setAccessibilityLabel("更多操作")
        actionsButton.menu?.delegate = self
        let buttons = NSStackView(views: [locateButton, editButton, resolveButton, NSView(), actionsButton])
        buttons.spacing = 10
        let stack = NSStackView(views: [headerLabel, quoteLabel, bodyLabel, chips, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 5
        stack.detachesHiddenViews = true
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            headerLabel.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor),
            quoteLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
            bodyLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
            chips.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        setAccessibilityLabel("\(headerLabel.stringValue)：\(body)")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// The ⋯ menu's items as a click builds them.
    var actionItems: [NSMenuItem] { menuItems() }

    override var wantsUpdateLayer: Bool { true }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    override func updateLayer() {
        layer?.cornerRadius = 8
        // Open notes share the editor's highlight hue, TODOs the accent;
        // settled ones recede.
        let wash: NSColor = settled ? NSColor.secondaryLabelColor.withAlphaComponent(0.07)
            : isTodo ? NSColor.labAccent.withAlphaComponent(0.10) : NSColor.systemYellow.withAlphaComponent(0.14)
        layer?.backgroundColor = wash.cgColor
    }
}

extension ReviewCardView: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === actionsButton.menu else { return }
        while menu.items.count > 1 { menu.removeItem(at: 1) }
        for item in menuItems() { menu.addItem(item) }
    }
}

/// 新建批注 / 新建待办: the kind, where it is written (the focused page, or
/// floating for a TODO), a priority, 关联 and the body. Nothing is written
/// until 创建; a refusal keeps everything typed.
final class ReviewComposeSheet: NSObject {
    struct Draft {
        let kind: String
        let onFocus: Bool
        let priority: CommentPriority?
        let body: String
        let associations: [RelationEndpoint]
    }

    let window: NSWindow
    let focus: ReviewFocus?
    let kindControl = NSSegmentedControl(labels: ["批注", "待办"], trackingMode: .selectOne, target: nil, action: nil)
    let placePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let priorityPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let chips = AssociationChipsView(prefix: "review-compose-association")
    let associateButton = NSPopUpButton(frame: .zero, pullsDown: true)
    let bodyView: NSTextView
    let createButton = NSButton(title: "创建", target: nil, action: nil)
    let cancelButton = NSButton(title: "取消", target: nil, action: nil)
    private let heading = NSTextField(labelWithString: "")
    private let message = NSTextField(wrappingLabelWithString: "")
    private let bodyScroll = NSTextView.scrollableTextView()
    private let associations: AssociationModel
    private(set) var associated: [RelationEndpoint] = []
    private(set) var isSubmitting = false
    var onSubmit: ((Draft, @escaping (Error?) -> Void) -> Void)?
    var onFinish: (() -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }
    var kind: String { kindControl.selectedSegment == 1 ? "todo" : "note" }
    var onFocus: Bool { placePopup.indexOfSelectedItem == 0 }

    init(kind: String, focus: ReviewFocus?, associations: AssociationModel) {
        self.focus = focus
        self.associations = associations
        bodyView = bodyScroll.documentView as! NSTextView
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 360), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        super.init()
        heading.font = .systemFont(ofSize: 15, weight: .semibold)
        kindControl.target = self; kindControl.action = #selector(kindChanged)
        kindControl.setAccessibilityIdentifier("review-compose-kind")
        placePopup.addItems(withTitles: [focus.map { "当前：\($0.label)" } ?? "当前：未打开页面", "浮动（不挂在页面上）"])
        placePopup.autoenablesItems = false
        placePopup.item(at: 0)?.isEnabled = focus != nil
        placePopup.setAccessibilityIdentifier("review-compose-place")
        priorityPopup.addItems(withTitles: ["无"] + CommentPriority.allCases.map(\.label))
        priorityPopup.setAccessibilityIdentifier("review-compose-priority")
        associateButton.addItem(withTitle: "添加关联")
        associateButton.setAccessibilityIdentifier("review-compose-associate")
        associateButton.menu?.delegate = self
        chips.onRemove = { [weak self] entry in self?.removeAssociation(entry.target) }
        bodyView.isRichText = false
        bodyView.allowsUndo = true
        bodyView.font = .systemFont(ofSize: 13)
        bodyView.textContainerInset = NSSize(width: 2, height: 4)
        bodyView.setAccessibilityIdentifier("review-compose-body")
        bodyScroll.borderType = .bezelBorder
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("review-compose-error")
        createButton.target = self; createButton.action = #selector(submit)
        createButton.keyEquivalent = "\r"; createButton.keyEquivalentModifierMask = .command
        createButton.setAccessibilityIdentifier("review-compose-create")
        cancelButton.target = self; cancelButton.action = #selector(cancel)
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.setAccessibilityIdentifier("review-compose-cancel")
        let label = { (text: String) -> NSTextField in
            let value = NSTextField(labelWithString: text); value.textColor = .secondaryLabelColor; return value
        }
        let grid = NSGridView(views: [[label("类型"), kindControl], [label("位置"), placePopup], [label("优先级"), priorityPopup],
                                      [label("关联"), NSStackView(views: [chips, associateButton])], [label("内容"), bodyScroll]])
        grid.rowSpacing = 10; grid.columnSpacing = 10
        grid.column(at: 0).xPlacement = .trailing
        for index in 0..<grid.numberOfRows { grid.row(at: index).yPlacement = index == 4 ? .top : .center }
        let hint = NSTextField(labelWithString: "⌘↩ 创建 · 空一行分段")
        hint.textColor = .tertiaryLabelColor; hint.font = .systemFont(ofSize: 11)
        let buttons = NSStackView(views: [hint, NSView(), cancelButton, createButton])
        let stack = NSStackView(views: [heading, grid, message, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 14
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
            grid.widthAnchor.constraint(equalTo: stack.widthAnchor),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
            bodyScroll.heightAnchor.constraint(equalToConstant: 120),
            bodyScroll.widthAnchor.constraint(equalToConstant: 340),
        ])
        setKind(kind)
        // A new TODO floats, associated with the focused page as the renderer
        // pre-fills it; a note is written on the page itself.
        if kind == "todo", let focus { associated = [focus.endpoint] }
        showAssociations()
        associations.observe(self) { [weak self] in self?.showAssociations() }
        content.layoutSubtreeIfNeeded()
        window.setContentSize(content.fittingSize)
    }

    /// 批注 goes on the focused page; a 待办 may float.
    func setKind(_ kind: String) {
        kindControl.selectedSegment = kind == "todo" ? 1 : 0
        heading.stringValue = kind == "todo" ? "新建待办" : "新建批注"
        window.title = heading.stringValue
        placePopup.item(at: 1)?.isEnabled = kind == "todo"
        placePopup.selectItem(at: kind == "todo" ? 1 : 0)
    }

    @objc private func kindChanged() { setKind(kind) }

    func addAssociation(_ endpoint: RelationEndpoint) {
        guard !associated.contains(endpoint) else { return }
        associated.append(endpoint)
        showAssociations()
    }

    func removeAssociation(_ endpoint: RelationEndpoint) {
        associated.removeAll { $0 == endpoint }
        showAssociations()
    }

    private func showAssociations() {
        let names = associations.names()
        chips.show(associated.map { endpoint in
            AssociationEntry(relation: WorkspaceRelation(id: "draft-\(endpoint.key)", projectId: associations.projectID, fromKind: "comment",
                                                         fromId: "draft", toKind: endpoint.kind, toId: endpoint.id,
                                                         relationTypeId: associations.typeID, createdAt: "", updatedAt: ""),
                             target: endpoint, name: names.name(of: endpoint))
        })
    }

    /// The candidates 添加关联 offers, as its menu shows them.
    func associationMenu() -> NSMenu {
        AssociationMenu.make(candidates: associations.candidates(for: nil, excluding: associated), prefix: "review-compose-associate") {
            [weak self] endpoint in self?.addAssociation(endpoint)
        }
    }

    func focusBody() { window.makeFirstResponder(bodyView) }

    @objc func submit() {
        guard !isSubmitting else { return }
        let body = bodyView.string
        guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { show("请输入内容。"); return }
        if kind == "note", focus == nil { show("批注需要写在一个页面上。请先打开章节、漂流、设定、分类或故事线，或改为浮动待办。"); return }
        let priority = priorityPopup.indexOfSelectedItem > 0 ? CommentPriority.allCases[priorityPopup.indexOfSelectedItem - 1] : nil
        let draft = Draft(kind: kind, onFocus: kind == "note" || onFocus, priority: priority, body: body, associations: associated)
        guard let onSubmit else { return }
        isSubmitting = true; setEnabled(false); show(nil)
        onSubmit(draft) { [weak self] error in
            guard let self else { return }
            self.isSubmitting = false; self.setEnabled(true)
            if let error { self.show(error.localizedDescription) } else { self.onFinish?() }
        }
    }

    @objc func cancel() {
        guard !isSubmitting else { return }
        onFinish?()
    }

    private func setEnabled(_ enabled: Bool) {
        createButton.isEnabled = enabled; cancelButton.isEnabled = enabled
        bodyView.isEditable = enabled
    }

    private func show(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }
}

extension ReviewComposeSheet: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === associateButton.menu else { return }
        while menu.items.count > 1 { menu.removeItem(at: 1) }
        let built = associationMenu()
        for item in built.items { built.removeItem(item); menu.addItem(item) }
    }
}
