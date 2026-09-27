import AppKit

final class MemoBoardPanel: NSPanel {
    var onClose: (() -> Void)?
    /// The panel became key again, e.g. after edits in the main window.
    var onBecomeKey: (() -> Void)?
    override func close() { super.close(); onClose?() }
    override func becomeKey() { super.becomeKey(); onBecomeKey?() }
}

/// 备忘与素材: the project's open TODOs beside the 素材库's cards, with kind
/// chips (待办, 图片, PDF, 链接, 文字) that show or hide each kind, 关联 on
/// both, drag reordering of library items and the finished TODOs under
/// 已完成. The TODO column shares the 审阅 model and actions; the library
/// is the 素材库's own list, so Quick Look, import and editing are the same.
final class MacMemoBoardViewController: NSViewController {
    /// The chips in the renderer's order: TODOs first, then library kinds.
    static let kinds: [(kind: String, label: String)] = [("todo", "待办"), ("image", "图片"), ("pdf", "PDF"), ("url", "链接"), ("text", "文字")]

    let review: ReviewModel
    let commands: ReviewCommands
    let library: MacMaterialLibraryViewController
    var onClose: (() -> Void)?
    private(set) var kindButtons: [String: NSButton] = [:]
    let newTodoButton = NSButton(title: "新建待办…", target: nil, action: nil)
    let todoStatus = NSTextField(wrappingLabelWithString: "")
    let archiveToggle = NSButton(title: "", target: nil, action: nil)
    private let todoColumn = NSStackView()
    private let todoList = NSStackView()
    private let archiveList = NSStackView()
    private let todoEmpty = NSTextField(wrappingLabelWithString: "")
    private(set) var todoCards: [String: ReviewCardView] = [:]
    private(set) var renderedTodoIDs: [String] = []
    private(set) var renderedArchiveIDs: [String] = []
    private(set) var hiddenKinds: Set<String> = []
    /// The TODO column is shown (the 待办 chip is on).
    var showsTodoColumn: Bool { !todoColumn.isHidden }
    var showsArchive = false { didSet { if oldValue != showsArchive { reloadTodos() } } }

    init(review: ReviewModel, materials: MaterialLibraryModel) {
        self.review = review
        commands = ReviewCommands(model: review)
        library = MacMaterialLibraryViewController(model: materials)
        library.showsCloseButton = false
        library.associations = review.associations
        super.init(nibName: nil, bundle: nil)
        commands.window = { [weak self] in self?.view.window }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        view = NSView()
        let title = NSTextField(labelWithString: "备忘与素材")
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        var chips: [NSView] = []
        for entry in Self.kinds {
            let button = NSButton(title: entry.label, target: self, action: #selector(kindToggled(_:)))
            button.setButtonType(.pushOnPushOff)
            button.bezelStyle = .recessed
            button.state = .on
            button.identifier = NSUserInterfaceItemIdentifier(entry.kind)
            button.setAccessibilityIdentifier("board-kind-\(entry.kind)")
            button.toolTip = "显示或隐藏\(entry.label)"
            kindButtons[entry.kind] = button
            chips.append(button)
        }
        newTodoButton.target = self; newTodoButton.action = #selector(newTodo)
        newTodoButton.setAccessibilityIdentifier("board-new-todo")
        let close = NSButton(title: "关闭", target: self, action: #selector(closeBoard))
        close.setAccessibilityIdentifier("close-board")
        let kindLabel = NSTextField(labelWithString: "类型")
        kindLabel.textColor = .secondaryLabelColor
        let toolbar = NSStackView(views: [title, kindLabel] + chips + [NSView(), newTodoButton, close])
        toolbar.spacing = 8
        toolbar.setCustomSpacing(18, after: title)

        let todoHeading = NSTextField(labelWithString: "待办")
        todoHeading.font = .systemFont(ofSize: 13, weight: .semibold)
        todoStatus.textColor = .secondaryLabelColor
        todoStatus.font = .systemFont(ofSize: 11)
        todoStatus.setAccessibilityIdentifier("board-todo-status")
        todoList.orientation = .vertical; todoList.alignment = .leading; todoList.spacing = 8
        todoList.setAccessibilityIdentifier("board-todo-list")
        archiveList.orientation = .vertical; archiveList.alignment = .leading; archiveList.spacing = 4
        archiveList.setAccessibilityIdentifier("board-archive-list")
        archiveToggle.isBordered = false
        archiveToggle.font = .systemFont(ofSize: 12, weight: .medium)
        archiveToggle.contentTintColor = .secondaryLabelColor
        archiveToggle.target = self; archiveToggle.action = #selector(toggleArchive)
        archiveToggle.setAccessibilityIdentifier("board-toggle-archive")
        todoEmpty.textColor = .secondaryLabelColor
        let todoContent = NSStackView(views: [todoList, archiveToggle, archiveList])
        todoContent.orientation = .vertical; todoContent.alignment = .leading; todoContent.spacing = 12
        todoContent.translatesAutoresizingMaskIntoConstraints = false
        let document = ReviewFlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(todoContent)
        let todoScroll = NSScrollView()
        todoScroll.hasVerticalScroller = true; todoScroll.drawsBackground = false
        todoScroll.documentView = document
        todoColumn.setViews([todoHeading, todoStatus, todoScroll], in: .leading)
        todoColumn.orientation = .vertical; todoColumn.alignment = .leading; todoColumn.spacing = 8
        todoColumn.setAccessibilityIdentifier("board-todo-column")

        addChild(library)
        let libraryView = library.view
        let columns = NSStackView(views: [todoColumn, libraryView])
        columns.orientation = .horizontal; columns.alignment = .top; columns.spacing = 16
        columns.distribution = .fill
        let stack = NSStackView(views: [toolbar, columns])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 14),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -14),
            toolbar.widthAnchor.constraint(equalTo: stack.widthAnchor),
            columns.widthAnchor.constraint(equalTo: stack.widthAnchor),
            todoColumn.widthAnchor.constraint(equalToConstant: 300),
            todoColumn.heightAnchor.constraint(equalTo: columns.heightAnchor),
            libraryView.heightAnchor.constraint(equalTo: columns.heightAnchor),
            todoScroll.widthAnchor.constraint(equalTo: todoColumn.widthAnchor),
            todoStatus.widthAnchor.constraint(equalTo: todoColumn.widthAnchor),
            document.leadingAnchor.constraint(equalTo: todoScroll.contentView.leadingAnchor),
            document.trailingAnchor.constraint(equalTo: todoScroll.contentView.trailingAnchor),
            document.topAnchor.constraint(equalTo: todoScroll.contentView.topAnchor),
            todoContent.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            todoContent.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            todoContent.topAnchor.constraint(equalTo: document.topAnchor),
            todoContent.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            todoList.widthAnchor.constraint(equalTo: todoContent.widthAnchor),
            archiveList.widthAnchor.constraint(equalTo: todoContent.widthAnchor),
        ])
        review.observe(self) { [weak self] in self?.reloadTodos() }
        library.model.observe(self) { [weak self] in self?.reloadCounts() }
        reloadTodos()
    }

    // MARK: Kinds

    /// Shows or hides one kind, as its chip does.
    func setKind(_ kind: String, shown: Bool) {
        if shown { hiddenKinds.remove(kind) } else { hiddenKinds.insert(kind) }
        kindButtons[kind]?.state = shown ? .on : .off
        todoColumn.isHidden = hiddenKinds.contains("todo")
        library.hiddenKinds = hiddenKinds.subtracting(["todo"])
    }

    @objc private func kindToggled(_ sender: NSButton) {
        guard let kind = sender.identifier?.rawValue else { return }
        setKind(kind, shown: sender.state == .on)
    }

    /// Each chip names its kind with the project's count.
    private func reloadCounts() {
        guard isViewLoaded else { return }
        let items = library.model.items
        for entry in Self.kinds {
            let count = entry.kind == "todo" ? review.openTodos.count : items.filter { $0.kind == entry.kind }.count
            kindButtons[entry.kind]?.title = "\(entry.label) \(count)"
        }
    }

    // MARK: TODOs

    func reloadTodos() {
        guard isViewLoaded else { return }
        reloadCounts()
        let summary = review.openTodos.isEmpty && review.resolvedTodos.isEmpty ? ""
            : "\(review.openTodos.count) 条待办" + (review.resolvedTodos.isEmpty ? "" : "，\(review.resolvedTodos.count) 条已完成")
        todoStatus.stringValue = [review.message ?? "", summary].filter { !$0.isEmpty }.joined(separator: "\n")
        newTodoButton.isEnabled = review.loaded && !review.busy
        for view in todoList.arrangedSubviews + archiveList.arrangedSubviews { view.removeFromSuperview() }
        todoCards = [:]
        let open = review.openTodos, done = review.resolvedTodos
        renderedTodoIDs = open.map(\.id)
        renderedArchiveIDs = showsArchive ? done.map(\.id) : []
        if open.isEmpty {
            todoEmpty.stringValue = review.loaded ? "还没有待办。点“新建待办…”，或在审阅中把批注转为待办。" : ""
            todoList.addArrangedSubview(todoEmpty)
            todoEmpty.widthAnchor.constraint(equalTo: todoList.widthAnchor).isActive = true
        }
        for todo in open {
            let card = ReviewCardView(comment: todo, presentation: .board, targetName: targetName(of: todo), anchor: nil,
                                      associations: review.associations.entries(of: todo.endpoint),
                                      menu: { [weak self] in self?.commands.menuItems(for: todo) ?? [] },
                                      actions: ReviewCardView.Actions(
                                        locate: { [weak self] in self?.commands.onLocate?(todo) },
                                        edit: { [weak self] in self?.commands.edit(todo) },
                                        resolve: { [weak self] in self?.review.setResolved(id: todo.id, resolved: true) },
                                        open: { [weak self] entry in self?.commands.onOpen?(entry.target) },
                                        dissociate: { [weak self] entry in self?.review.dissociate(id: todo.id, from: entry.target) }))
            todoList.addArrangedSubview(card)
            card.widthAnchor.constraint(equalTo: todoList.widthAnchor).isActive = true
            todoCards[todo.id] = card
        }
        archiveToggle.title = "\(showsArchive ? "▾" : "▸") 已完成（\(done.count)）"
        archiveToggle.isHidden = done.isEmpty
        archiveList.isHidden = !showsArchive
        if showsArchive { for todo in done { archiveList.addArrangedSubview(archiveRow(todo)) } }
    }

    private func targetName(of comment: WorkspaceComment) -> String {
        guard let target = comment.target else { return "浮动" }
        let name = review.associations.names().name(of: target)
        return "\(name.kindLabel)「\(name.name)」"
    }

    /// A finished TODO: its text struck through, 重新打开 and 删除….
    private func archiveRow(_ todo: WorkspaceComment) -> NSView {
        let text = NSTextField(wrappingLabelWithString: "")
        text.attributedStringValue = NSAttributedString(string: todo.bodyText.isEmpty ? "（空待办）" : todo.bodyText, attributes: [
            .strikethroughStyle: NSUnderlineStyle.single.rawValue, .foregroundColor: NSColor.secondaryLabelColor,
            .font: NSFont.systemFont(ofSize: 12)])
        text.maximumNumberOfLines = 3
        text.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        text.setAccessibilityIdentifier("board-archive-body-\(todo.id)")
        let reopen = ChipButton(title: "重新打开") { [weak self] in self?.review.setResolved(id: todo.id, resolved: false) }
        reopen.setAccessibilityIdentifier("board-reopen-\(todo.id)")
        let delete = ChipButton(title: "删除…") { [weak self] in self?.commands.confirmDelete(todo) }
        delete.setAccessibilityIdentifier("board-delete-\(todo.id)")
        for button in [reopen, delete] {
            button.font = .systemFont(ofSize: 11)
            button.contentTintColor = .secondaryLabelColor
            button.setContentHuggingPriority(.required, for: .horizontal)
        }
        let row = NSStackView(views: [text, reopen, delete])
        row.alignment = .firstBaseline; row.spacing = 8
        row.setAccessibilityIdentifier("board-archive-\(todo.id)")
        return row
    }

    @objc private func toggleArchive() { showsArchive.toggle() }
    @objc func newTodo() { commands.compose(kind: "todo") }
    @objc private func closeBoard() { commands.endSheets(); onClose?() }

    override func viewDidDisappear() {
        super.viewDidDisappear()
        commands.endSheets()
    }
}
