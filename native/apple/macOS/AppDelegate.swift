import AppKit

@main
struct NativeMacMain {
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}

/// One window owns a chapter workspace with retained tabs and at most two panes.
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate, NSMenuDelegate {
    private var window: NSWindow!
    private let workspace = LabWorkspaceCore()
    private var projects: [WorkspaceProject] = []
    private var chapters: [WorkspaceChapter] = []
    private var trashedChapters: [WorkspaceChapter] = []
    private var showingTrash = false
    private var displayedChapters: [WorkspaceChapter] { showingTrash ? trashedChapters : chapters }
    private var trashButton: NSButton!
    private var trashListButton: NSButton!
    private var selectedProject: WorkspaceProject?
    private var currentChapter: WorkspaceChapter? { chapterWorkspace.activeChapter }
    private var currentProject: WorkspaceProject? { chapterWorkspace.activeProject }
    private lazy var chapterWorkspace = MacChapterWorkspace(workspace: workspace)
    private var documentCore: LabCore? { chapterWorkspace.activeCore }
    private var documentView: NativeDocumentView? { chapterWorkspace.activeView }
    private var loading = false
    private var updatingSelection = false
    private let projectTable = NSTableView()
    private let chapterTable = NSTableView()
    private let projectEmpty = NSTextField(wrappingLabelWithString: "还没有项目，先新建一个项目。")
    private let chapterEmpty = NSTextField(wrappingLabelWithString: "选择项目后，在这里管理章节。")
    private let currentTitle = NSTextField(labelWithString: "开始写作")
    private let status = NSTextField(wrappingLabelWithString: "正在打开工作区…")
    /// The renderer's bottom status line: the active page's count and the book total.
    private let wordStatus = NSTextField(labelWithString: "")
    private let editorHost = NSView()
    private let emptyEditor = NSTextField(wrappingLabelWithString: "新建或选择一个章节，开始写作。\n正文会自动保存。")
    private var createProjectButton: NSButton!
    private var createChapterButton: NSButton!
    private var renameProjectButton: NSButton!
    private var renameChapterButton: NSButton!
    private var moveUpButton: NSButton!
    private var moveDownButton: NSButton!
    private var saveButton: NSButton!
    private var reopenButton: NSButton!
    private var outlineButton: NSButton!
    private var outlinePanel: NSPanel?
    private var outlineController: BookOutlineViewController?
    private var pendingReveal: String?
    private var splitButton: NSButton!
    private var closePaneButton: NSButton!
    private var workspaceClosed = false
    private var closingWorkspace = false
    private var searchButton: NSButton!
    private var searchPanel: WorkspaceSearchPanel?
    private var searchController: MacWorkspaceSearchViewController?
    private var pendingSearch: (hit: WorkspaceSearchHit, view: NativeDocumentView)?
    private var resolvingSearch = false
    private var commentsButton: NSButton!
    private var commentsPanel: ChapterCommentsPanel?
    private var commentsController: MacChapterCommentsViewController?
    private var elementsButton: NSButton!
    private var elementsPanel: ElementLibraryPanel?
    private var elementsController: MacElementLibraryViewController?
    private var storylinesButton: NSButton!
    private var storylinesPanel: StorylineLibraryPanel?
    private var storylinesController: MacStorylineLibraryViewController?
    /// One project's storylines and memberships, kept while its panel is
    /// closed: chapter rows and the outline show each chapter's 主线.
    private var storylineModel: StorylineLibraryModel?
    private var storylineSheet: ChapterStorylinesSheet?
    private var driftsButton: NSButton!
    private var driftsPanel: DriftLibraryPanel?
    private var driftsController: MacDriftLibraryViewController?
    /// One project's drifts and groups, kept while its panel is closed: the
    /// outline names each act's notes.
    private var driftModel: DriftLibraryModel?
    private var profileButton: NSButton!
    private var profileSheet: ProjectProfileSheet?
    private var relationTypesPanel: RelationTypesPanel?
    private var relationTypesController: MacRelationTypesViewController?
    /// 写作助手: a right-side panel beside the editor, one controller per project.
    private let agentPanel = MacAgentPanelView()
    private let agentCredentials = AgentKeychainCredentialStore()
    private var agentController: AgentChatController?
    private var agentSettings: MacAgentSettingsSheet?
    private var agentButton: NSButton!
    private var agentMenuItem: NSMenuItem!
    private var editorTrailing: NSLayoutConstraint!
    private var editorBesideAgent: NSLayoutConstraint!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        installMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1020, height: 740),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Drifting Native Lab"
        window.minSize = NSSize(width: 820, height: 620)
        window.delegate = self
        window.isReleasedWhenClosed = false
        buildWorkspace()
        reloadProjects()
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func installMenu() {
        let menu = NSMenu(), appItem = NSMenuItem(), appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出 Drifting Native Lab", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let file = NSMenuItem(title: "文件", action: nil, keyEquivalent: ""), fileMenu = NSMenu(title: "文件")
        let save = fileMenu.addItem(withTitle: "保存正文", action: #selector(saveDocument), keyEquivalent: "s")
        save.target = self
        fileMenu.addItem(.separator())
        let profile = fileMenu.addItem(withTitle: "项目资料…", action: #selector(showProjectProfile), keyEquivalent: "i")
        profile.keyEquivalentModifierMask = [.command, .shift]
        profile.target = self
        file.submenu = fileMenu
        menu.addItem(file)
        let edit = NSMenuItem(title: "编辑", action: nil, keyEquivalent: ""), editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: #selector(ProseTextView.undo(_:)), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "重做", action: #selector(ProseTextView.redo(_:)), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        for (title, action, key) in [("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        edit.submenu = editMenu
        menu.addItem(edit)
        let search = editMenu.addItem(withTitle: "项目搜索", action: #selector(showSearch), keyEquivalent: "f")
        search.keyEquivalentModifierMask = [.command, .shift]
        search.target = self
        let elements = editMenu.addItem(withTitle: "设定库", action: #selector(showElements), keyEquivalent: "e")
        elements.keyEquivalentModifierMask = [.command, .shift]
        elements.target = self
        let storylines = editMenu.addItem(withTitle: "故事线", action: #selector(showStorylines), keyEquivalent: "l")
        storylines.keyEquivalentModifierMask = [.command, .shift]
        storylines.target = self
        let drifts = editMenu.addItem(withTitle: "漂流", action: #selector(showDrifts), keyEquivalent: "d")
        drifts.keyEquivalentModifierMask = [.command, .shift]
        drifts.target = self
        let relationTypes = editMenu.addItem(withTitle: "关系类型…", action: #selector(showRelationTypes), keyEquivalent: "r")
        relationTypes.keyEquivalentModifierMask = [.command, .shift]
        relationTypes.target = self
        editMenu.addItem(.separator())
        // Nil-targeted: the focused editor pane validates its own selection.
        let addComment = editMenu.addItem(withTitle: "添加批注…", action: #selector(ProseTextView.addProseComment(_:)), keyEquivalent: "m")
        addComment.keyEquivalentModifierMask = [.command, .option]
        let comments = editMenu.addItem(withTitle: "批注列表", action: #selector(showComments), keyEquivalent: "")
        comments.target = self
        let format = NSMenuItem(title: "格式", action: nil, keyEquivalent: ""), formatMenu = NSMenu(title: "格式")
        formatMenu.addItem(withTitle: "加粗", action: #selector(ProseTextView.boldProse(_:)), keyEquivalent: "b")
        formatMenu.addItem(withTitle: "斜体", action: #selector(ProseTextView.italicProse(_:)), keyEquivalent: "i")
        format.submenu = formatMenu
        menu.addItem(format)
        let view = NSMenuItem(title: "视图", action: nil, keyEquivalent: ""), viewMenu = NSMenu(title: "视图")
        let agent = viewMenu.addItem(withTitle: "写作助手", action: #selector(toggleAgent), keyEquivalent: "a")
        agent.keyEquivalentModifierMask = [.command, .option]
        agent.target = self
        agentMenuItem = agent
        view.submenu = viewMenu
        menu.addItem(view)
        NSApp.mainMenu = menu
    }

    private func buildWorkspace() {
        createProjectButton = button("新建项目", id: "create-project", action: #selector(createProject))
        createChapterButton = button("新建章节", id: "create-chapter", action: #selector(createChapter))
        renameProjectButton = button("重命名", id: "rename-project", action: #selector(renameProject))
        profileButton = button("资料", id: "show-project-profile", action: #selector(showProjectProfile))
        profileButton.toolTip = "本书简介、本书字段和故事线字段模版"
        renameChapterButton = button("重命名", id: "rename-chapter", action: #selector(renameChapter))
        moveUpButton = button("上移", id: "move-chapter-up", action: #selector(moveChapterUp))
        moveDownButton = button("下移", id: "move-chapter-down", action: #selector(moveChapterDown))
        let projectActions = NSStackView(views: [createProjectButton, renameProjectButton, profileButton])
        let chapterActions = NSStackView(views: [createChapterButton, renameChapterButton])
        let orderActions = NSStackView(views: [moveUpButton, moveDownButton])
        trashButton = button("移入回收站", id: "trash-chapter", action: #selector(changeChapterTrash))
        trashListButton = button("回收站", id: "show-trash", action: #selector(toggleTrash))
        let trashActions = NSStackView(views: [trashButton, trashListButton])
        let projectScroll = table(projectTable, id: "project-list")
        let chapterScroll = table(chapterTable, id: "chapter-list")
        let chapterMenu = NSMenu()
        chapterMenu.delegate = self
        chapterTable.menu = chapterMenu
        let sidebar = NSStackView(views: [heading("项目"), projectActions, projectScroll, projectEmpty,
            heading("章节"), chapterActions, orderActions, trashActions, chapterScroll, chapterEmpty])
        sidebar.orientation = .vertical
        sidebar.alignment = .leading
        sidebar.spacing = 10
        sidebar.translatesAutoresizingMaskIntoConstraints = false
        projectEmpty.textColor = .secondaryLabelColor
        chapterEmpty.textColor = .secondaryLabelColor
        projectEmpty.setAccessibilityIdentifier("project-empty")
        chapterEmpty.setAccessibilityIdentifier("chapter-empty")
        currentTitle.font = .systemFont(ofSize: 20, weight: .semibold)
        currentTitle.lineBreakMode = .byTruncatingTail
        currentTitle.setAccessibilityIdentifier("current-chapter")
        saveButton = button("保存", id: "save-document", action: #selector(saveDocument))
        reopenButton = button("重新打开", id: "reopen-document", action: #selector(reopenDocument))
        outlineButton = button("整书大纲", id: "show-outline", action: #selector(showOutline))
        searchButton = button("搜索", id: "show-search", action: #selector(showSearch))
        commentsButton = button("批注", id: "show-comments", action: #selector(showComments))
        elementsButton = button("设定库", id: "show-elements", action: #selector(showElements))
        storylinesButton = button("故事线", id: "show-storylines", action: #selector(showStorylines))
        driftsButton = button("漂流", id: "show-drifts", action: #selector(showDrifts))
        splitButton = button("在另一栏打开", id: "split-editor", action: #selector(splitEditor))
        closePaneButton = button("关闭分栏", id: "close-editor-pane", action: #selector(closeEditorPane))
        agentButton = button("写作助手", id: "toggle-agent", action: #selector(toggleAgent))
        agentButton.setButtonType(.pushOnPushOff)
        agentButton.toolTip = "显示或隐藏写作助手（⌥⌘A）"
        let actions = NSStackView(views: [saveButton, reopenButton, outlineButton, searchButton, commentsButton, elementsButton,
                                          storylinesButton, driftsButton, splitButton, closePaneButton, agentButton])
        actions.spacing = 10
        let subtitle = NSTextField(wrappingLabelWithString: "独立原生工作区 · 正文自动保存")
        subtitle.textColor = .secondaryLabelColor
        status.textColor = .secondaryLabelColor
        status.setAccessibilityIdentifier("workspace-status")
        emptyEditor.textColor = .secondaryLabelColor
        emptyEditor.alignment = .center
        emptyEditor.translatesAutoresizingMaskIntoConstraints = false
        editorHost.addSubview(emptyEditor)
        chapterWorkspace.translatesAutoresizingMaskIntoConstraints = false
        editorHost.addSubview(chapterWorkspace)
        chapterWorkspace.onChange = { [weak self] in self?.activeChapterChanged() }
        chapterWorkspace.onActivity = { [weak self] busy in self?.documentActivity(busy) }
        chapterWorkspace.onError = { [weak self] error in self?.status.stringValue = error.localizedDescription }
        chapterWorkspace.onComments = { [weak self] view in
            self?.commentsController?.model.updateAnchors(from: view.binding.store)
        }
        chapterWorkspace.onCommentCreated = { [weak self] view, _ in
            guard let self else { return }
            self.status.stringValue = "批注已添加"
            if let model = self.commentsController?.model, model.store === view.binding.store { model.reload(after: "批注已添加。") }
        }
        chapterWorkspace.onElementLibrary = { [weak self] projectID, library in
            guard let model = self?.elementsController?.model, model.projectID == projectID else { return }
            model.apply(library, message: nil)
        }
        chapterWorkspace.onStorylineLibrary = { [weak self] projectID, library in
            self?.adoptStorylines(projectID: projectID, library: library, fromWorkspace: true)
        }
        chapterWorkspace.onDriftLibrary = { [weak self] projectID, library in
            self?.adoptDrifts(projectID: projectID, library: library, fromWorkspace: true)
        }
        chapterWorkspace.onOutline = { [weak self] projectID, entries in
            if let model = self?.driftModel, model.projectID == projectID { model.applyActs(entries) }
        }
        chapterWorkspace.onNodeMetadata = { [weak self] projectID, metadata in
            self?.adoptNodeMetadata(projectID: projectID, metadata: metadata)
        }
        chapterWorkspace.onWordCounts = { [weak self] projectID, library in
            self?.adoptWordCounts(projectID: projectID, library: library)
        }
        chapterWorkspace.onManageRelationTypes = { [weak self] project in self?.openRelationTypes(project: project) }
        // Categories have no page: a 关系 row opens the 设定库 at the category.
        chapterWorkspace.onOpenCategory = { [weak self] project, categoryID in
            guard let self else { return }
            self.showElements()
            if self.elementsController?.model.projectID == project.id { self.elementsController?.reveal(categoryID: categoryID) }
        }
        NSLayoutConstraint.activate([
            chapterWorkspace.leadingAnchor.constraint(equalTo: editorHost.leadingAnchor),
            chapterWorkspace.trailingAnchor.constraint(equalTo: editorHost.trailingAnchor),
            chapterWorkspace.topAnchor.constraint(equalTo: editorHost.topAnchor),
            chapterWorkspace.bottomAnchor.constraint(equalTo: editorHost.bottomAnchor),
        ])
        NSLayoutConstraint.activate([
            emptyEditor.centerXAnchor.constraint(equalTo: editorHost.centerXAnchor),
            emptyEditor.centerYAnchor.constraint(equalTo: editorHost.centerYAnchor),
            emptyEditor.leadingAnchor.constraint(greaterThanOrEqualTo: editorHost.leadingAnchor, constant: 20),
        ])
        wordStatus.textColor = .secondaryLabelColor
        wordStatus.font = .monospacedDigitSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        wordStatus.lineBreakMode = .byTruncatingHead
        wordStatus.setContentHuggingPriority(.required, for: .horizontal)
        wordStatus.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        wordStatus.setAccessibilityIdentifier("word-count-status")
        status.setContentHuggingPriority(.defaultLow, for: .horizontal)
        status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        // Messages fill the line; the counts sit quietly at its trailing edge.
        let footer = NSStackView(views: [status, wordStatus])
        footer.distribution = .fill
        footer.alignment = .firstBaseline
        footer.spacing = 16
        let editor = NSStackView(views: [currentTitle, subtitle, actions, editorHost, footer])
        editor.orientation = .vertical
        editor.alignment = .leading
        editor.spacing = 12
        editor.translatesAutoresizingMaskIntoConstraints = false
        let content = window.contentView!
        content.addSubview(sidebar)
        content.addSubview(editor)
        agentPanel.translatesAutoresizingMaskIntoConstraints = false
        agentPanel.isHidden = true
        agentPanel.onOpenSettings = { [weak self] in self?.showAgentSettings() }
        content.addSubview(agentPanel)
        // The panel takes the trailing edge only while shown; the editor
        // (and its split panes) keeps the remaining width.
        editorTrailing = editor.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24)
        editorBesideAgent = editor.trailingAnchor.constraint(equalTo: agentPanel.leadingAnchor, constant: -16)
        NSLayoutConstraint.activate([
            agentPanel.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
            agentPanel.topAnchor.constraint(equalTo: sidebar.topAnchor, constant: -8),
            agentPanel.bottomAnchor.constraint(equalTo: sidebar.bottomAnchor, constant: 8),
            agentPanel.widthAnchor.constraint(equalToConstant: 340),
            editorTrailing,
        ])
        NSLayoutConstraint.activate([
            sidebar.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            sidebar.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            sidebar.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -24),
            sidebar.widthAnchor.constraint(equalToConstant: 230),
            projectScroll.widthAnchor.constraint(equalTo: sidebar.widthAnchor),
            projectScroll.heightAnchor.constraint(equalToConstant: 170),
            chapterScroll.widthAnchor.constraint(equalTo: sidebar.widthAnchor),
            chapterScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 120),
            projectEmpty.widthAnchor.constraint(equalTo: sidebar.widthAnchor),
            chapterEmpty.widthAnchor.constraint(equalTo: sidebar.widthAnchor),
            editor.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: 24),
            editor.topAnchor.constraint(equalTo: sidebar.topAnchor),
            editor.bottomAnchor.constraint(equalTo: sidebar.bottomAnchor),
            currentTitle.widthAnchor.constraint(equalTo: editor.widthAnchor),
            editorHost.widthAnchor.constraint(equalTo: editor.widthAnchor),
            editorHost.heightAnchor.constraint(greaterThanOrEqualToConstant: 360),
            footer.widthAnchor.constraint(equalTo: editor.widthAnchor),
        ])
    }

    private func heading(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 15, weight: .semibold)
        return label
    }

    private func button(_ title: String, id: String, action: Selector) -> NSButton {
        let value = NSButton(title: title, target: self, action: action)
        value.setAccessibilityIdentifier(id)
        return value
    }

    private func table(_ table: NSTableView, id: String) -> NSScrollView {
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name"))
        table.addTableColumn(column)
        table.headerView = nil
        table.rowHeight = 36
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.dataSource = self
        table.delegate = self
        table.setAccessibilityIdentifier(id)
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.documentView = table
        return scroll
    }

    func numberOfRows(in tableView: NSTableView) -> Int {
        tableView === projectTable ? projects.count : displayedChapters.count
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let title = tableView === projectTable ? projects[row].name : displayedChapters[row].title
        let label = NSTextField(labelWithString: title)
        label.lineBreakMode = .byTruncatingTail
        label.setAccessibilityLabel(title)
        guard tableView === chapterTable, !showingTrash else { return label }
        // Live chapters lead with their 主线 dot once memberships are read,
        // and end with their word count once counted.
        let chapter = displayedChapters[row]
        var leading: [NSView] = [label]
        if let library = sidebarStorylines {
            let chip = StorylineChip(storyline: library.primary(chapterID: chapter.id), showsName: false)
            chip.setAccessibilityIdentifier("chapter-row-storyline-\(chapter.id)")
            leading.insert(chip, at: 0)
        }
        let words = MacWordCount.rowLabel(sidebarWordCounts?.count(nodeID: chapter.id), identifier: "chapter-row-words-\(chapter.id)")
        guard leading.count > 1 || words != nil else { return label }
        label.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        let stack = NSStackView()
        stack.spacing = 6
        stack.setViews(leading, in: .leading)
        if let words { stack.setViews([words], in: .trailing) }
        return stack
    }

    /// The selected project's word counts, once read.
    private var sidebarWordCounts: WordCountLibrary? {
        selectedProject.flatMap { chapterWorkspace.wordCountLibrary(projectID: $0.id) }
    }

    /// The selected project's storyline library, once read.
    private var sidebarStorylines: WorkspaceStorylineLibrary? {
        guard let model = storylineModel, model.loaded, model.projectID == selectedProject?.id else { return nil }
        return model.library
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let row = chapterTable.clickedRow
        guard menu === chapterTable.menu, !showingTrash, chapters.indices.contains(row), let project = selectedProject else { return }
        let chapter = chapters[row]
        let item = LibraryMenuItem(title: "故事线…", identifier: "chapter-storylines") { [weak self] in
            self?.editStorylines(of: chapter, project: project, from: self?.window)
        }
        menu.addItem(item)
        // 写作状态: the current status is checked; choosing it writes nothing.
        menu.addItem(.separator())
        menu.addItem(withTitle: "写作状态", action: nil, keyEquivalent: "")
        for status in WritingStatus.chapter {
            let choice = LibraryMenuItem(title: status.label, identifier: "chapter-menu-status-\(status.rawValue)") { [weak self] in
                guard let self, chapter.writingStatus != status.rawValue, !self.loading else { return }
                self.chapterWorkspace.setNodeStatus(projectID: project.id, nodeID: chapter.id, status: status.rawValue) { [weak self] result in
                    self?.status.stringValue = Self.statusMessage(result, title: chapter.title)
                }
            }
            choice.state = chapter.writingStatus == status.rawValue ? .on : .off
            menu.addItem(choice)
        }
    }

    private static func statusMessage(_ result: Result<WorkspaceNodeMetadata, Error>, title: String) -> String {
        switch result {
        case .success(let metadata): return "“\(title)”已设为\(WritingStatus.label(metadata.writingStatus))。"
        case .failure(let error): return error.localizedDescription
        }
    }

    /// Every written 摘要 or 状态 reaches the chapter list, the outline and the
    /// drift panel; open pages already follow through the tab host.
    private func adoptNodeMetadata(projectID: String, metadata: WorkspaceNodeMetadata) {
        if metadata.kind == "chapter", selectedProject?.id == projectID,
           let index = chapters.firstIndex(where: { $0.id == metadata.id }) {
            chapters[index].writingStatus = metadata.writingStatus
        }
        if let outline = outlineController?.model, outline.projectID == projectID { outline.applyNodeMetadata(metadata) }
        if let model = driftModel, model.projectID == projectID { model.applyNodeMetadata(metadata) }
    }

    // MARK: Word counts

    /// Every count change reaches the chapter list, the outline, the 漂流
    /// panel, the project sheet and the status line; open pages already
    /// follow through the tab host.
    private func adoptWordCounts(projectID: String, library: WordCountLibrary) {
        if selectedProject?.id == projectID, !showingTrash { reloadChapterRows() }
        if let outline = outlineController?.model, outline.projectID == projectID { outline.applyWordCounts(library) }
        if let model = driftModel, model.projectID == projectID { model.applyWordCounts(library) }
        if let profile = profileSheet?.model, profile.projectID == projectID { profile.applyWordCounts(library) }
        updateWordStatus()
    }

    /// Redraws chapter rows and keeps the selection.
    private func reloadChapterRows() {
        updatingSelection = true
        let selected = chapterTable.selectedRowIndexes
        chapterTable.reloadData()
        chapterTable.selectRowIndexes(selected, byExtendingSelection: false)
        updatingSelection = false
    }

    /// “当前 1,234 字 · 全书 5,678 字” for the active chapter or drift page, the
    /// storyline's chapters on a storyline page, otherwise the book alone.
    private func updateWordStatus() {
        guard let project = currentProject ?? selectedProject else { wordStatus.stringValue = ""; return }
        var focus = WordCountFocus.none
        if currentProject?.id == project.id {
            if let id = currentChapter?.id ?? chapterWorkspace.activeDrift?.id {
                focus = .node(id)
            } else if let storyline = chapterWorkspace.activeStoryline,
                      let memberships = chapterWorkspace.storylineLibrary(projectID: project.id) {
                focus = .storyline(memberships.chapters(storylineID: storyline.id).map(\.chapterId))
            }
        }
        wordStatus.stringValue = WordCountText.statusLine(chapterWorkspace.wordCountLibrary(projectID: project.id), focus: focus)
    }

    // MARK: Writing assistant

    /// ⌥⌘A or 写作助手: shows or hides the panel beside the editor.
    @objc private func toggleAgent() {
        let show = agentPanel.isHidden
        if show, let project = currentProject ?? selectedProject { ensureAgent(project) }
        agentPanel.isHidden = !show
        editorTrailing.isActive = !show
        editorBesideAgent.isActive = show
        agentButton.state = show ? .on : .off
        agentMenuItem.state = show ? .on : .off
        activeChapterChanged()
        if show { window.makeFirstResponder(agentPanel.composer) }
    }

    /// One assistant per project; a turn still running in another project stops.
    private func ensureAgent(_ project: WorkspaceProject) {
        guard agentController?.projectID != project.id else { return }
        agentController?.stop()
        let controller = AgentChatController(workspace: workspace, projectID: project.id, projectName: project.name,
                                             credentials: agentCredentials)
        controller.editorContext = { [weak self] in self?.chapterWorkspace.agentContext(projectID: project.id) }
        controller.onWorkspaceEffect = { [weak self] effect in self?.adoptAgentEffect(effect) }
        agentController = controller
        agentPanel.bind(controller)
    }

    /// An accepted proposal reaches open pages, counts and the chapter list.
    private func adoptAgentEffect(_ effect: AgentWorkspaceEffect) {
        chapterWorkspace.adoptAgentEffect(effect)
        switch effect {
        case .prose: status.stringValue = "写作助手的修改已写入正文，可以撤销。"
        case .chapterCreated(let projectID, let chapter):
            if selectedProject?.id == projectID, !chapters.contains(where: { $0.id == chapter.id }) {
                chapters.append(chapter)
                if !showingTrash { reloadChapterRows() }
                chapterEmpty.isHidden = !displayedChapters.isEmpty
            }
            status.stringValue = "写作助手新建了章节《\(chapter.title)》"
        case .nodeMetadata: status.stringValue = "写作助手的摘要修改已保存"
        }
    }

    private func showAgentSettings() {
        guard agentSettings == nil else { return }
        let sheet = MacAgentSettingsSheet(credentials: agentCredentials)
        agentSettings = sheet
        sheet.onFinish = { [weak self] in self?.agentSettings = nil }
        sheet.begin(in: window)
    }

    // MARK: Project profile

    /// 项目资料: a sheet over the window; each part saves as it is edited.
    @objc private func showProjectProfile() {
        guard !loading, profileSheet == nil, let project = currentProject ?? selectedProject else { return }
        let name = projects.first { $0.id == project.id }?.name ?? project.name
        let profile = ProjectProfileModel(workspace: workspace, projectID: project.id)
        if let counts = chapterWorkspace.wordCounts(projectID: project.id).library { profile.applyWordCounts(counts) }
        let sheet = ProjectProfileSheet(model: profile, projectName: name)
        profileSheet = sheet
        sheet.onFinish = { [weak self] in
            self?.profileSheet = nil
            self?.status.stringValue = "项目资料已保存"
        }
        sheet.begin(in: window)
    }

    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        canLeaveDocument()
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !updatingSelection, !loading, let table = notification.object as? NSTableView else { return }
        if table === projectTable, projects.indices.contains(table.selectedRow) {
            selectProject(projects[table.selectedRow])
        } else if table === chapterTable {
            updateControls()
            if !showingTrash, chapters.indices.contains(table.selectedRow), let selectedProject {
                openChapter(chapters[table.selectedRow], project: selectedProject)
            }
        }
    }

    private func setLoading(_ value: Bool) {
        loading = value
        if value { window.makeFirstResponder(nil) }
        chapterWorkspace.lockViews(value)
        updateControls()
    }

    private func updateControls() {
        let ready = !loading && chapterWorkspace.canNavigate
        createProjectButton.isEnabled = ready
        createChapterButton.isEnabled = ready && selectedProject != nil
        renameProjectButton.isEnabled = ready && selectedProject != nil
        profileButton.isEnabled = !loading && (currentProject != nil || selectedProject != nil)
        renameChapterButton.isEnabled = ready && !showingTrash && chapters.indices.contains(chapterTable.selectedRow)
        let chapterIndex = chapterTable.selectedRow
        moveUpButton.isEnabled = ready && !showingTrash && chapters.indices.contains(chapterIndex) && chapterIndex > 0
        moveDownButton.isEnabled = ready && !showingTrash && chapters.indices.contains(chapterIndex) && chapterIndex + 1 < chapters.count
        trashListButton.isEnabled = ready && selectedProject != nil
        trashButton.isEnabled = ready && displayedChapters.indices.contains(chapterTable.selectedRow)
        trashButton.title = showingTrash ? "恢复章节" : "移入回收站"
        trashButton.setAccessibilityIdentifier(showingTrash ? "restore-chapter" : "trash-chapter")
        trashListButton.title = showingTrash ? "返回章节" : "回收站"
        saveButton.isEnabled = ready && documentView != nil
        reopenButton.isEnabled = ready && chapterWorkspace.canReopenActive
        outlineButton.isEnabled = ready && (currentProject != nil || selectedProject != nil)
        searchButton.isEnabled = ready && (currentProject != nil || selectedProject != nil)
        commentsButton.isEnabled = !loading && chapterWorkspace.activeChapterView != nil
        elementsButton.isEnabled = ready && (currentProject != nil || selectedProject != nil)
        storylinesButton.isEnabled = ready && (currentProject != nil || selectedProject != nil)
        driftsButton.isEnabled = ready && (currentProject != nil || selectedProject != nil)
        splitButton.isEnabled = ready && documentView != nil
        closePaneButton.isHidden = chapterWorkspace.paneCount == 1
        closePaneButton.isEnabled = ready && chapterWorkspace.paneCount == 2
    }

    private func canLeaveDocument() -> Bool {
        guard !loading else { return false }
        guard chapterWorkspace.canNavigate else {
            status.stringValue = "请先完成输入，并等待正文保存。保存失败时可在编辑器中重试。"
            return false
        }
        return true
    }

    private func reloadProjects() {
        setLoading(true)
        workspace.projects { [weak self] result in
            guard let self else { return }
            self.setLoading(false)
            switch result {
            case .success(let projects):
                self.projects = projects
                self.projectTable.reloadData()
                self.projectEmpty.isHidden = !projects.isEmpty
                self.status.stringValue = "选择项目，或新建一个项目。"
            case .failure(let error): self.status.stringValue = error.localizedDescription
            }
        }
    }

    private func selectProject(_ project: WorkspaceProject) {
        guard canLeaveDocument() else { return }
        closeOutline()
        closeSearch()
        if elementsController?.model.projectID != project.id { closeElements() }
        if storylinesController?.model.projectID != project.id { closeStorylines() }
        if driftsController?.model.projectID != project.id { closeDrifts() }
        if relationTypesController?.model.projectID != project.id { closeRelationTypes() }
        setLoading(true)
        workspace.chapters(projectID: project.id) { [weak self] result in
            guard let self else { return }
            self.setLoading(false)
            switch result {
            case .success(let chapters):
                self.selectedProject = project
                self.showingTrash = false
                self.chapterTable.setAccessibilityIdentifier("chapter-list")
                self.trashedChapters = []
                self.chapters = chapters
                self.updatingSelection = true
                self.chapterTable.reloadData()
                self.chapterTable.deselectAll(nil)
                self.updatingSelection = false
                self.chapterEmpty.stringValue = "还没有章节，点击“新建章节”开始写作。"
                self.chapterEmpty.isHidden = !chapters.isEmpty
                self.status.stringValue = "\(project.name) · \(chapters.count) 个章节"
                self.ensureStorylineModel(project)
                self.ensureDriftModel(project)
                self.ensureAgent(project)
                // Opening a project reconciles its counts once per session.
                self.chapterWorkspace.wordCounts(projectID: project.id, refresh: true)
                self.updateWordStatus()
                self.updateControls()
            case .failure(let error):
                self.status.stringValue = error.localizedDescription
                self.updatingSelection = true
                if let selected = self.selectedProject,
                   let index = self.projects.firstIndex(where: { $0.id == selected.id }) {
                    self.projectTable.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
                } else { self.projectTable.deselectAll(nil) }
                self.updatingSelection = false
            }
        }
    }

    private func openChapter(_ chapter: WorkspaceChapter, project: WorkspaceProject, revealBlockID: String? = nil) {
        guard canLeaveDocument() else { return }
        chapterWorkspace.open(project: project, chapter: chapter) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.pendingReveal = revealBlockID
                self.status.stringValue = "正文自动保存"
                if revealBlockID == nil { self.closeOutline() }
                self.documentActivity(!self.chapterWorkspace.canNavigate)
            case .failure(let error):
                self.status.stringValue = error.localizedDescription
                self.outlineController?.model.showStatus(error.localizedDescription)
                self.activeChapterChanged()
            }
        }
    }

    private func activeChapterChanged() {
        emptyEditor.isHidden = documentView != nil
        updateCurrentTitle()
        if documentView == nil { currentTitle.stringValue = "开始写作"; window.title = "Drifting Native Lab" }
        updatingSelection = true
        if !showingTrash, currentProject?.id == selectedProject?.id, let chapter = currentChapter,
           let index = chapters.firstIndex(where: { $0.id == chapter.id }) {
            chapterTable.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
        } else { chapterTable.deselectAll(nil) }
        updatingSelection = false
        updateComments()
        updateWordStatus()
        let minWidth: CGFloat = (chapterWorkspace.paneCount == 2 ? 1100 : 820) + (agentPanel.isHidden ? 0 : 360)
        window.minSize = NSSize(width: minWidth, height: 660)
        if window.frame.width < minWidth {
            var frame = window.frame; frame.size.width = minWidth
            window.setFrame(frame, display: true)
        }
        updateControls()
    }

    private func documentActivity(_ busy: Bool) {
        updateControls()
        // Mounting can emit idle before the first load begins. Keep the target
        // until the new owner has supplied and rendered an editable projection.
        guard !busy, let documentView, documentView.binding.canEdit,
              let projection = documentView.binding.store.projection,
              let chapter = currentChapter else { return }
        if outlineController?.model.projectID == currentProject?.id {
            outlineController?.model.updateActive(chapterID: chapter.id, outline: projection.outline)
        }
        if let blockID = pendingReveal {
            pendingReveal = nil
            if documentView.reveal(blockId: blockID) { closeOutline() }
            else { outlineController?.model.showStatus("标题已变化，请重新选择大纲位置。") }
        }
        resolvePendingSearch()
    }

    @objc private func showSearch() {
        guard canLeaveDocument(), let project = currentProject ?? selectedProject else { return }
        if let searchPanel, searchPanel.isVisible, searchController?.model.projectID == project.id {
            searchPanel.makeKeyAndOrderFront(nil); searchController?.focusQuery(); return
        }
        closeSearch()
        let model = WorkspaceSearchModel(workspace: workspace, projectID: project.id)
        let controller = MacWorkspaceSearchViewController(model: model)
        let panel = WorkspaceSearchPanel(contentRect: NSRect(x: 0, y: 0, width: 430, height: 580),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = "\(project.name) · 搜索"
        panel.minSize = NSSize(width: 340, height: 320)
        panel.isReleasedWhenClosed = false; panel.contentViewController = controller
        searchPanel = panel; searchController = controller
        panel.onClose = { [weak self] in
            self?.searchPanel = nil; self?.searchController = nil; self?.pendingSearch = nil
        }
        controller.onClose = { [weak self] in self?.closeSearch() }
        controller.canNavigate = { [weak self] in self?.canLeaveDocument() == true }
        controller.onNavigate = { [weak self] hit in
            guard let self, self.canLeaveDocument() else { return }
            self.chapterWorkspace.open(project: project,
                chapter: WorkspaceChapter(id: hit.chapterId, title: hit.chapterTitle)) { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(let view):
                    self.pendingSearch = (hit, view)
                    self.resolvePendingSearch()
                case .failure(let error): model.showStatus(error.localizedDescription)
                }
            }
        }
        window.addChildWindow(panel, ordered: .above)
        panel.center(); panel.makeKeyAndOrderFront(nil); controller.focusQuery()
    }

    private func resolvePendingSearch() {
        guard !resolvingSearch, !loading, let pending = pendingSearch,
              chapterWorkspace.canNavigate, pending.view.binding.canEdit,
              pending.view.binding.store.projection != nil else { return }
        pendingSearch = nil
        guard documentView === pending.view else {
            searchController?.model.showStatus("当前编辑栏已变化，请重新选择搜索结果。"); return
        }
        resolvingSearch = true
        setLoading(true)
        workspace.resolveSearchHit(pending.hit) { [weak self] result in
            guard let self else { return }
            self.setLoading(false)
            self.resolvingSearch = false
            switch result {
            case .success(let location):
                guard self.documentView === pending.view else {
                    self.searchController?.model.showStatus("当前编辑栏已变化，请重新选择搜索结果。"); return
                }
                if let range = location.range {
                    guard pending.view.reveal(range: range, revision: location.revision) else {
                        self.searchController?.model.showStatus("正文已变化，请重新搜索后再定位。"); return
                    }
                }
                self.closeSearch()
                self.status.stringValue = "已打开搜索结果"
                self.window.makeKeyAndOrderFront(nil)
            case .failure:
                self.searchController?.model.showStatus("这条结果已无法定位，请重新搜索。")
            }
        }
    }

    @objc private func showComments() {
        guard chapterWorkspace.activeChapterView != nil else { return }
        if let commentsPanel, commentsPanel.isVisible {
            updateComments(); commentsPanel.makeKeyAndOrderFront(nil); return
        }
        closeComments()
        let model = ChapterCommentsModel()
        let controller = MacChapterCommentsViewController(model: model)
        let panel = ChapterCommentsPanel(contentRect: NSRect(x: 0, y: 0, width: 400, height: 560),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.minSize = NSSize(width: 320, height: 320)
        panel.isReleasedWhenClosed = false; panel.contentViewController = controller
        commentsPanel = panel; commentsController = controller
        panel.onClose = { [weak self] in self?.commentsPanel = nil; self?.commentsController = nil }
        controller.onClose = { [weak self] in self?.closeComments() }
        controller.onLocate = { [weak self] id in self?.locateComment(id) }
        window.addChildWindow(panel, ordered: .above)
        // Beside the text rather than over it, so a located passage stays visible.
        let frame = window.frame
        panel.setFrameTopLeftPoint(NSPoint(x: max(frame.minX, frame.maxX - panel.frame.width - 24), y: frame.maxY - 90))
        panel.makeKeyAndOrderFront(nil)
        updateComments()
    }

    /// The panel follows the active pane: a split of the same chapter keeps
    /// its rows, another chapter reloads them.
    private func updateComments() {
        guard let commentsPanel, let model = commentsController?.model else { return }
        commentsPanel.title = currentChapter.map { "批注 · \($0.title)" } ?? "批注"
        // Element pages have no comments; the panel waits for a chapter.
        model.bind(chapterWorkspace.activeChapterView?.binding.store)
    }

    private func locateComment(_ id: String) {
        guard let model = commentsController?.model else { return }
        guard let documentView = chapterWorkspace.activeChapterView, documentView.binding.store === model.store else {
            model.showStatus("当前编辑栏已变化，请重新选择批注。"); return
        }
        if let refusal = documentView.locateComment(id: id) { model.showStatus(refusal); return }
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(documentView.textView)
        status.stringValue = "已定位批注"
    }

    private func closeComments() {
        let panel = commentsPanel
        commentsPanel = nil; commentsController = nil
        if let panel { window.removeChildWindow(panel); panel.close() }
    }

    @objc private func showElements() {
        guard let project = currentProject ?? selectedProject else { return }
        if let elementsPanel, elementsPanel.isVisible, elementsController?.model.projectID == project.id {
            elementsPanel.makeKeyAndOrderFront(nil); return
        }
        closeElements()
        let model = ElementLibraryModel(workspace: workspace, projectID: project.id)
        let controller = MacElementLibraryViewController(model: model)
        let panel = ElementLibraryPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 600),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = "\(project.name) · 设定库"
        panel.minSize = NSSize(width: 300, height: 360)
        panel.isReleasedWhenClosed = false; panel.contentViewController = controller
        elementsPanel = panel; elementsController = controller
        panel.onClose = { [weak self] in self?.elementsPanel = nil; self?.elementsController = nil }
        model.onLibrary = { [weak self] library in
            self?.chapterWorkspace.applyElementLibrary(projectID: project.id, library: library)
        }
        controller.onClose = { [weak self] in self?.closeElements() }
        controller.canNavigate = { [weak self] in self?.canLeaveDocument() == true }
        controller.onOpen = { [weak self] element in self?.openElement(element, project: project, focusName: false) }
        controller.onCreated = { [weak self] element in self?.openElement(element, project: project, focusName: true) }
        controller.onTrash = { [weak self] element in self?.trashElement(element, project: project) }
        window.addChildWindow(panel, ordered: .above)
        // Beside the editor's leading edge, clear of the text column.
        let frame = window.frame
        panel.setFrameTopLeftPoint(NSPoint(x: frame.minX + 24, y: frame.maxY - 90))
        panel.makeKeyAndOrderFront(nil)
        model.load()
    }

    private func openElement(_ element: WorkspaceElement, project: WorkspaceProject, focusName: Bool) {
        guard canLeaveDocument() else {
            elementsController?.model.showStatus("请先完成输入，并等待正文保存后再打开设定。"); return
        }
        chapterWorkspace.open(project: project, element: element) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.status.stringValue = "设定正文自动保存"
                self.window.makeKeyAndOrderFront(nil)
                if focusName { self.chapterWorkspace.focusActiveElementName() }
                self.documentActivity(!self.chapterWorkspace.canNavigate)
            case .failure(let error):
                self.status.stringValue = error.localizedDescription
                self.elementsController?.model.showStatus(error.localizedDescription)
                self.activeChapterChanged()
            }
        }
    }

    private func trashElement(_ element: WorkspaceElement, project: WorkspaceProject) {
        guard canLeaveDocument() else { return }
        chapterWorkspace.trashElement(projectID: project.id, elementID: element.id) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let reply):
                self.elementsController?.model.apply(reply.library, message: "“\(element.name)”已移到回收站，可以随时恢复。")
                self.status.stringValue = "设定已移到回收站"
                self.activeChapterChanged()
            case .failure(let error):
                self.status.stringValue = error.localizedDescription
                self.elementsController?.model.showStatus(error.localizedDescription)
            }
        }
    }

    private func closeElements() {
        let panel = elementsPanel
        elementsPanel = nil; elementsController = nil
        if let panel { window.removeChildWindow(panel); panel.close() }
    }

    // MARK: Storylines

    /// Keeps one storyline model for the project whose chapters are shown.
    @discardableResult
    private func ensureStorylineModel(_ project: WorkspaceProject) -> StorylineLibraryModel {
        if let storylineModel, storylineModel.projectID == project.id { return storylineModel }
        let model = StorylineLibraryModel(workspace: workspace, projectID: project.id)
        storylineModel = model
        model.onLibrary = { [weak self] library in
            self?.adoptStorylines(projectID: project.id, library: library, fromWorkspace: false)
        }
        model.load()
        return model
    }

    /// Every storyline reply reaches the panel, open pages, the outline and
    /// the chapter list; the source is not told again.
    private func adoptStorylines(projectID: String, library: WorkspaceStorylineLibrary, fromWorkspace: Bool) {
        if fromWorkspace {
            if let model = storylineModel, model.projectID == projectID { model.apply(library, message: nil) }
        } else {
            chapterWorkspace.applyStorylineLibrary(projectID: projectID, library: library)
        }
        if let outline = outlineController?.model, outline.projectID == projectID { outline.applyStorylines(library) }
        if selectedProject?.id == projectID, !showingTrash { reloadChapterRows() }
        // A storyline page counts its chapters.
        updateWordStatus()
    }

    @objc private func showStorylines() {
        guard let project = currentProject ?? selectedProject else { return }
        if let storylinesPanel, storylinesPanel.isVisible, storylinesController?.model.projectID == project.id {
            storylinesPanel.makeKeyAndOrderFront(nil); return
        }
        closeStorylines()
        let model = ensureStorylineModel(project)
        let controller = MacStorylineLibraryViewController(model: model)
        let panel = StorylineLibraryPanel(contentRect: NSRect(x: 0, y: 0, width: 340, height: 520),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = "\(project.name) · 故事线"
        panel.minSize = NSSize(width: 280, height: 320)
        panel.isReleasedWhenClosed = false; panel.contentViewController = controller
        storylinesPanel = panel; storylinesController = controller
        panel.onClose = { [weak self] in self?.storylinesPanel = nil; self?.storylinesController = nil }
        controller.onClose = { [weak self] in self?.closeStorylines() }
        controller.canNavigate = { [weak self] in self?.canLeaveDocument() == true }
        controller.onOpen = { [weak self] storyline in self?.openStoryline(storyline, project: project, focusName: false) }
        controller.onCreated = { [weak self] storyline in self?.openStoryline(storyline, project: project, focusName: true) }
        controller.onTrash = { [weak self] storyline in self?.trashStoryline(storyline, project: project) }
        window.addChildWindow(panel, ordered: .above)
        let frame = window.frame
        panel.setFrameTopLeftPoint(NSPoint(x: frame.minX + 48, y: frame.maxY - 110))
        panel.makeKeyAndOrderFront(nil)
        model.load()
    }

    private func openStoryline(_ storyline: WorkspaceStoryline, project: WorkspaceProject, focusName: Bool) {
        guard canLeaveDocument() else {
            storylinesController?.model.showStatus("请先完成输入，并等待正文保存后再打开故事线。"); return
        }
        chapterWorkspace.open(project: project, storyline: storyline) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.status.stringValue = "故事线正文自动保存"
                self.window.makeKeyAndOrderFront(nil)
                if focusName { self.chapterWorkspace.focusActiveStorylineName() }
                self.documentActivity(!self.chapterWorkspace.canNavigate)
            case .failure(let error):
                self.status.stringValue = error.localizedDescription
                self.storylinesController?.model.showStatus(error.localizedDescription)
                self.activeChapterChanged()
            }
        }
    }

    private func trashStoryline(_ storyline: WorkspaceStoryline, project: WorkspaceProject) {
        guard canLeaveDocument() else { return }
        chapterWorkspace.trashStoryline(projectID: project.id, storylineID: storyline.id) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let reply):
                if let model = self.storylineModel, model.projectID == project.id {
                    model.apply(reply.library, message: "“\(storyline.name)”已移到回收站，可以随时恢复。")
                }
                self.status.stringValue = "故事线已移到回收站"
                self.activeChapterChanged()
            case .failure(let error):
                self.status.stringValue = error.localizedDescription
                self.storylinesController?.model.showStatus(error.localizedDescription)
            }
        }
    }

    /// “故事线…” on a chapter: a sheet over the window that asked for it.
    private func editStorylines(of chapter: WorkspaceChapter, project: WorkspaceProject, from parent: NSWindow?) {
        guard storylineSheet == nil else { return }
        let model = ensureStorylineModel(project)
        guard model.loaded, !model.busy else {
            status.stringValue = "正在读取故事线，请稍后再试。"; return
        }
        let sheet = ChapterStorylinesSheet(chapter: chapter, model: model)
        storylineSheet = sheet
        sheet.onFinish = { [weak self] saved in
            self?.storylineSheet = nil
            if saved { self?.status.stringValue = "“\(chapter.title)”的故事线已保存" }
        }
        sheet.begin(in: parent ?? window)
    }

    private func closeStorylines() {
        let panel = storylinesPanel
        storylinesPanel = nil; storylinesController = nil
        if let panel { window.removeChildWindow(panel); panel.close() }
    }

    // MARK: Drifts

    /// Keeps one drift model for the project whose chapters are shown.
    @discardableResult
    private func ensureDriftModel(_ project: WorkspaceProject) -> DriftLibraryModel {
        if let driftModel, driftModel.projectID == project.id { return driftModel }
        let model = DriftLibraryModel(workspace: workspace, projectID: project.id)
        driftModel = model
        model.onLibrary = { [weak self] library in
            self?.adoptDrifts(projectID: project.id, library: library, fromWorkspace: false)
        }
        if let counts = chapterWorkspace.wordCountLibrary(projectID: project.id) { model.applyWordCounts(counts) }
        model.load()
        // Act names for bound notes in the panel.
        chapterWorkspace.actsChanged(projectID: project.id)
        return model
    }

    /// Every drift reply reaches the panel, open pages, links and the
    /// outline; the source is not told again.
    private func adoptDrifts(projectID: String, library: WorkspaceDriftLibrary, fromWorkspace: Bool) {
        if fromWorkspace {
            if let model = driftModel, model.projectID == projectID { model.apply(library, message: nil) }
        } else {
            chapterWorkspace.applyDriftLibrary(projectID: projectID, library: library)
        }
        if let outline = outlineController?.model, outline.projectID == projectID { outline.applyDrifts(library) }
    }

    @objc private func showDrifts() {
        guard let project = currentProject ?? selectedProject else { return }
        if let driftsPanel, driftsPanel.isVisible, driftsController?.model.projectID == project.id {
            driftsPanel.makeKeyAndOrderFront(nil); return
        }
        closeDrifts()
        let model = ensureDriftModel(project)
        let controller = MacDriftLibraryViewController(model: model)
        let panel = DriftLibraryPanel(contentRect: NSRect(x: 0, y: 0, width: 340, height: 540),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = "\(project.name) · 漂流"
        panel.minSize = NSSize(width: 280, height: 320)
        panel.isReleasedWhenClosed = false; panel.contentViewController = controller
        driftsPanel = panel; driftsController = controller
        panel.onClose = { [weak self] in self?.driftsPanel = nil; self?.driftsController = nil }
        controller.onClose = { [weak self] in self?.closeDrifts() }
        controller.canNavigate = { [weak self] in self?.canLeaveDocument() == true }
        controller.onOpen = { [weak self] drift in self?.openDrift(drift, project: project, focusTitle: false) }
        controller.onCreated = { [weak self] drift in self?.openDrift(drift, project: project, focusTitle: true) }
        controller.onTrash = { [weak self] drift in self?.trashDrift(drift, project: project) }
        controller.onSetStatus = { [weak self] drift, status in
            self?.chapterWorkspace.setNodeStatus(projectID: project.id, nodeID: drift.id, status: status) { result in
                model.showStatus(Self.statusMessage(result, title: drift.title))
            }
        }
        window.addChildWindow(panel, ordered: .above)
        let frame = window.frame
        panel.setFrameTopLeftPoint(NSPoint(x: frame.minX + 72, y: frame.maxY - 130))
        panel.makeKeyAndOrderFront(nil)
        model.load()
    }

    private func openDrift(_ drift: WorkspaceDrift, project: WorkspaceProject, focusTitle: Bool,
                           completion: ((Bool) -> Void)? = nil) {
        guard canLeaveDocument() else {
            driftsController?.model.showStatus("请先完成输入，并等待正文保存后再打开漂流。"); completion?(false); return
        }
        chapterWorkspace.open(project: project, drift: drift) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.status.stringValue = "漂流正文自动保存"
                self.window.makeKeyAndOrderFront(nil)
                if focusTitle { self.chapterWorkspace.focusActiveDriftTitle() }
                self.documentActivity(!self.chapterWorkspace.canNavigate)
                completion?(true)
            case .failure(let error):
                self.status.stringValue = error.localizedDescription
                self.driftsController?.model.showStatus(error.localizedDescription)
                self.activeChapterChanged()
                completion?(false)
            }
        }
    }

    private func trashDrift(_ drift: WorkspaceDrift, project: WorkspaceProject) {
        guard canLeaveDocument() else { return }
        chapterWorkspace.trashDrift(projectID: project.id, driftID: drift.id) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let reply):
                if let model = self.driftModel, model.projectID == project.id {
                    model.apply(reply.library, message: "“\(drift.title)”已移到回收站，可以随时恢复。")
                }
                self.status.stringValue = "漂流已移到回收站"
                self.activeChapterChanged()
            case .failure(let error):
                self.status.stringValue = error.localizedDescription
                self.driftsController?.model.showStatus(error.localizedDescription)
            }
        }
    }

    private func closeDrifts() {
        let panel = driftsPanel
        driftsPanel = nil; driftsController = nil
        if let panel { window.removeChildWindow(panel); panel.close() }
    }

    // MARK: Relation types

    @objc private func showRelationTypes() {
        guard let project = currentProject ?? selectedProject else { return }
        openRelationTypes(project: project)
    }

    /// 关系类型: a panel over the window, sharing the project's relation
    /// library with every page's 关系 section.
    private func openRelationTypes(project: WorkspaceProject) {
        if let relationTypesPanel, relationTypesPanel.isVisible, relationTypesController?.model.projectID == project.id {
            relationTypesPanel.makeKeyAndOrderFront(nil); return
        }
        closeRelationTypes()
        let name = projects.first { $0.id == project.id }?.name ?? project.name
        let controller = MacRelationTypesViewController(model: chapterWorkspace.relations.model(projectID: project.id))
        let panel = RelationTypesPanel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 480),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = "\(name) · 关系类型"
        panel.minSize = NSSize(width: 320, height: 300)
        panel.isReleasedWhenClosed = false; panel.contentViewController = controller
        relationTypesPanel = panel; relationTypesController = controller
        panel.onClose = { [weak self] in self?.relationTypesPanel = nil; self?.relationTypesController = nil }
        controller.onClose = { [weak self] in self?.closeRelationTypes() }
        window.addChildWindow(panel, ordered: .above)
        let frame = window.frame
        panel.setFrameTopLeftPoint(NSPoint(x: frame.minX + 96, y: frame.maxY - 150))
        panel.makeKeyAndOrderFront(nil)
    }

    private func closeRelationTypes() {
        let panel = relationTypesPanel
        relationTypesPanel = nil; relationTypesController = nil
        if let panel { window.removeChildWindow(panel); panel.close() }
    }

    private func closeSearch() {
        let panel = searchPanel
        searchPanel = nil; searchController = nil; pendingSearch = nil
        if let panel { window.removeChildWindow(panel); panel.close() }
    }

    @objc private func showOutline() {
        guard canLeaveDocument(), let project = currentProject ?? selectedProject else { return }
        if let outlinePanel, outlinePanel.isVisible { outlinePanel.makeKeyAndOrderFront(nil); return }
        closeOutline()
        let model = WorkspaceOutlineModel(workspace: workspace, projectID: project.id)
        if currentProject?.id == project.id, let chapter = currentChapter,
           let projection = documentView?.binding.store.projection {
            model.updateActive(chapterID: chapter.id, outline: projection.outline)
        }
        if let storylines = storylineModel, storylines.projectID == project.id, storylines.loaded {
            model.applyStorylines(storylines.library)
        }
        let drifts = ensureDriftModel(project)
        if drifts.loaded { model.applyDrifts(drifts.library) }
        if let counts = chapterWorkspace.wordCounts(projectID: project.id).library { model.applyWordCounts(counts) }
        // Act rows name drift pages and the panel; removing an act releases
        // its notes, so drifts are read again after act changes.
        model.onEntries = { [weak self] entries in
            self?.chapterWorkspace.applyOutline(projectID: project.id, entries: entries)
            self?.chapterWorkspace.driftsChanged(projectID: project.id)
        }
        let controller = BookOutlineViewController(model: model)
        controller.onBindDrift = { [weak model] entry, drift in
            drifts.bindAct(actID: entry.id, driftID: drift?.id) { result in
                switch result {
                case .success:
                    model?.showStatus(drift.map { "“\($0.title)”已绑定为“\(entry.title)”的幕笔记。" }
                        ?? "已解除“\(entry.title)”的幕笔记，漂流本身保留。")
                case .failure(let error): model?.showStatus(error.localizedDescription)
                }
            }
        }
        controller.onOpenDrift = { [weak self] drift in
            self?.openDrift(drift, project: project, focusTitle: false) { opened in
                if opened { self?.closeOutline() }
            }
        }
        controller.onSetChapterStatus = { [weak self, weak model] entry, status in
            self?.chapterWorkspace.setNodeStatus(projectID: project.id, nodeID: entry.id, status: status) { result in
                model?.showStatus(Self.statusMessage(result, title: entry.title))
            }
        }
        controller.onEditStorylines = { [weak self, weak controller] entry in
            self?.editStorylines(of: WorkspaceChapter(id: entry.id, title: entry.title), project: project,
                                 from: controller?.view.window)
        }
        let panel = BookOutlinePanel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 570),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = "\(project.name) · 整书大纲"
        panel.minSize = NSSize(width: 300, height: 320)
        panel.isReleasedWhenClosed = false
        panel.contentViewController = controller
        outlinePanel = panel; outlineController = controller
        panel.onClose = { [weak self] in self?.outlinePanel = nil; self?.outlineController = nil }
        controller.canNavigate = { [weak self] in self?.canLeaveDocument() == true }
        controller.onClose = { [weak self] in self?.closeOutline() }
        controller.onNavigate = { [weak self] entry, blockID in
            guard let self, self.canLeaveDocument() else { return }
            if self.currentProject?.id == project.id, self.currentChapter?.id == entry.id {
                if let blockID, self.documentView?.reveal(blockId: blockID) != true {
                    model.showStatus("标题已变化，请重新选择大纲位置。")
                } else { self.closeOutline(); self.window.makeKeyAndOrderFront(nil) }
                return
            }
            self.openChapter(WorkspaceChapter(id: entry.id, title: entry.title), project: project, revealBlockID: blockID)
        }
        window.addChildWindow(panel, ordered: .above)
        panel.center(); panel.makeKeyAndOrderFront(nil)
        model.load()
    }

    private func closeOutline() {
        let panel = outlinePanel
        outlinePanel = nil; outlineController = nil
        if let panel { window.removeChildWindow(panel); panel.close() }
    }

    private func askName(project: Bool, currentName: String? = nil, completion: @escaping (String) -> Void) {
        guard canLeaveDocument() else { return }
        let alert = NSAlert()
        let renaming = currentName != nil
        let kind = project ? "project" : "chapter"
        alert.messageText = renaming ? (project ? "重命名项目" : "重命名章节") : (project ? "新建项目" : "新建章节")
        alert.informativeText = project ? "给你的写作项目起个名字。" : "输入章节标题。"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 28))
        field.stringValue = currentName ?? ""
        field.placeholderString = project ? "项目名称" : "章节标题"
        field.setAccessibilityIdentifier("\(renaming ? "rename" : "new")-\(kind)-name")
        alert.accessoryView = field
        let confirm = alert.addButton(withTitle: renaming ? "保存" : "创建")
        confirm.setAccessibilityIdentifier("confirm-\(renaming ? "rename" : "create")-\(kind)")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { response in
            guard response == .alertFirstButtonReturn else { return }
            let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { self.status.stringValue = "名称不能为空，请重新输入。"; return }
            completion(name)
        }
        alert.window.makeFirstResponder(field)
    }

    @objc private func renameProject() {
        guard let project = selectedProject else { return }
        askName(project: true, currentName: project.name) { [weak self] name in
            guard let self, self.canLeaveDocument() else { return }
            self.setLoading(true)
            self.workspace.renameProject(projectID: project.id, name: name) { [weak self] result in
                guard let self else { return }
                self.setLoading(false)
                switch result {
                case .success(let updated):
                    self.closeOutline()
                    self.closeSearch()
                    self.elementsPanel?.title = "\(updated.name) · 设定库"
                    self.storylinesPanel?.title = "\(updated.name) · 故事线"
                    self.driftsPanel?.title = "\(updated.name) · 漂流"
                    self.relationTypesPanel?.title = "\(updated.name) · 关系类型"
                    if let index = self.projects.firstIndex(where: { $0.id == updated.id }) { self.projects[index] = updated }
                    self.selectedProject = updated
                    self.chapterWorkspace.rename(project: updated)
                    self.updatingSelection = true
                    self.projectTable.reloadData()
                    if let index = self.projects.firstIndex(where: { $0.id == updated.id }) {
                        self.projectTable.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
                    }
                    self.updatingSelection = false
                    self.updateControls()
                    self.updateCurrentTitle()
                    self.status.stringValue = "项目名称已保存"
                case .failure(let error): self.status.stringValue = error.localizedDescription
                }
            }
        }
    }

    @objc private func renameChapter() {
        guard let project = selectedProject, chapters.indices.contains(chapterTable.selectedRow) else { return }
        let chapter = chapters[chapterTable.selectedRow]
        askName(project: false, currentName: chapter.title) { [weak self] title in
            guard let self, self.canLeaveDocument() else { return }
            self.setLoading(true)
            self.workspace.renameChapter(projectID: project.id, chapterID: chapter.id, title: title) { [weak self] result in
                guard let self else { return }
                self.setLoading(false)
                switch result {
                case .success(let updated):
                    self.closeOutline()
                    self.closeSearch()
                    if let index = self.chapters.firstIndex(where: { $0.id == updated.id }) { self.chapters[index] = updated }
                    self.chapterWorkspace.rename(chapter: updated, projectID: project.id)
                    self.updatingSelection = true
                    self.chapterTable.reloadData()
                    if let index = self.chapters.firstIndex(where: { $0.id == updated.id }) {
                        self.chapterTable.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
                    }
                    self.updatingSelection = false
                    self.updateControls()
                    self.updateCurrentTitle()
                    self.status.stringValue = "章节标题已保存"
                case .failure(let error): self.status.stringValue = error.localizedDescription
                }
            }
        }
    }

    private func updateCurrentTitle() {
        guard let project = currentProject else { return }
        if let chapter = currentChapter {
            currentTitle.stringValue = "\(project.name) / \(chapter.title)"
            window.title = "\(chapter.title) — Drifting Native Lab"
        } else if let element = chapterWorkspace.activeElement {
            currentTitle.stringValue = "\(project.name) / 设定 · \(element.name)"
            window.title = "\(element.name) — Drifting Native Lab"
        } else if let storyline = chapterWorkspace.activeStoryline {
            currentTitle.stringValue = "\(project.name) / 故事线 · \(storyline.name)"
            window.title = "\(storyline.name) — Drifting Native Lab"
        } else if let drift = chapterWorkspace.activeDrift {
            currentTitle.stringValue = "\(project.name) / 漂流 · \(drift.title)"
            window.title = "\(drift.title) — Drifting Native Lab"
        }
    }

    @objc private func moveChapterUp() { moveChapter(up: true) }
    @objc private func moveChapterDown() { moveChapter(up: false) }

    private func moveChapter(up: Bool) {
        guard canLeaveDocument(), let project = selectedProject else { return }
        let index = chapterTable.selectedRow
        guard chapters.indices.contains(index), up ? index > 0 : index + 1 < chapters.count else { return }
        let chapter = chapters[index]
        // Only choose a destination identity. Fractional order and journal
        // effects are calculated by the shared command, not by this view.
        let before = up ? chapters[index - 1].id : (index + 2 < chapters.count ? chapters[index + 2].id : nil)
        status.stringValue = "正在保存章节顺序…"
        setLoading(true)
        workspace.moveChapter(projectID: project.id, chapterID: chapter.id, beforeChapterID: before) { [weak self] result in
            guard let self else { return }
            self.setLoading(false)
            switch result {
            case .success(let chapters):
                self.closeOutline()
                self.chapters = chapters
                // Memberships follow book order.
                self.chapterWorkspace.applyChapters(projectID: project.id, chapters: chapters, trashed: nil)
                self.updatingSelection = true
                self.chapterTable.reloadData()
                if let index = chapters.firstIndex(where: { $0.id == chapter.id }) {
                    self.chapterTable.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
                }
                self.updatingSelection = false
                self.updateControls()
                self.status.stringValue = "章节顺序已保存"
            case .failure(let error): self.status.stringValue = error.localizedDescription
            }
        }
    }

    private func refreshChapterList() {
        updatingSelection = true
        chapterTable.reloadData()
        chapterTable.deselectAll(nil)
        updatingSelection = false
        chapterTable.setAccessibilityIdentifier(showingTrash ? "trash-list" : "chapter-list")
        chapterEmpty.stringValue = showingTrash ? "回收站为空。移入回收站的章节可以在这里恢复。" : "还没有章节，点击“新建章节”开始写作。"
        chapterEmpty.isHidden = !displayedChapters.isEmpty
        updateControls()
    }

    @objc private func toggleTrash() {
        guard canLeaveDocument(), let project = selectedProject else { return }
        if showingTrash {
            showingTrash = false
            refreshChapterList()
            return
        }
        setLoading(true)
        workspace.trashedChapters(projectID: project.id) { [weak self] result in
            guard let self else { return }
            self.setLoading(false)
            switch result {
            case .success(let chapters):
                self.trashedChapters = chapters
                self.showingTrash = true
                self.refreshChapterList()
                self.status.stringValue = "回收站 · 选择章节后恢复"
            case .failure(let error): self.status.stringValue = error.localizedDescription
            }
        }
    }

    @objc private func changeChapterTrash() {
        guard canLeaveDocument(), let project = selectedProject,
              displayedChapters.indices.contains(chapterTable.selectedRow) else { return }
        let chapter = displayedChapters[chapterTable.selectedRow]
        let restoring = showingTrash
        let completed: (Result<WorkspaceChapterTrashReply, Error>) -> Void = { [weak self] result in
            guard let self else { return }
            if restoring { self.setLoading(false) }
            switch result {
            case .success(let reply):
                self.closeOutline(); self.closeSearch()
                self.chapters = reply.chapters
                self.trashedChapters = reply.trashedChapters
                self.chapterWorkspace.applyChapters(projectID: project.id, chapters: reply.chapters, trashed: reply.trashedChapters)
                self.refreshChapterList()
                self.activeChapterChanged()
                self.status.stringValue = restoring ? "章节已恢复，返回章节列表即可打开。" : "章节已移入回收站，可以随时恢复。"
            case .failure(let error): self.status.stringValue = error.localizedDescription
            }
        }
        if restoring {
            setLoading(true)
            workspace.restoreChapter(projectID: project.id, chapterID: chapter.id, completion: completed)
        } else {
            chapterWorkspace.trash(projectID: project.id, chapterID: chapter.id, completion: completed)
        }
    }

    @objc private func createProject() {
        askName(project: true) { [weak self] name in
            guard let self else { return }
            self.setLoading(true)
            self.workspace.createProject(name: name) { [weak self] result in
                guard let self else { return }
                self.setLoading(false)
                switch result {
                case .success(let project):
                    self.projects.append(project)
                    self.projectEmpty.isHidden = true
                    self.updatingSelection = true
                    self.projectTable.reloadData()
                    self.projectTable.selectRowIndexes(IndexSet(integer: self.projects.count - 1), byExtendingSelection: false)
                    self.updatingSelection = false
                    self.selectProject(project)
                case .failure(let error): self.status.stringValue = error.localizedDescription
                }
            }
        }
    }

    @objc private func createChapter() {
        guard let project = selectedProject else { return }
        askName(project: false) { [weak self] title in
            guard let self else { return }
            self.setLoading(true)
            self.workspace.createChapter(projectID: project.id, title: title) { [weak self] result in
                guard let self else { return }
                self.setLoading(false)
                switch result {
                case .success(let chapter):
                    self.closeOutline()
                    self.showingTrash = false
                    self.chapterTable.setAccessibilityIdentifier("chapter-list")
                    self.chapters.append(chapter)
                    self.chapterWorkspace.chaptersChanged(projectID: project.id)
                    self.chapterEmpty.isHidden = true
                    self.updatingSelection = true
                    self.chapterTable.reloadData()
                    self.chapterTable.selectRowIndexes(IndexSet(integer: self.chapters.count - 1), byExtendingSelection: false)
                    self.updatingSelection = false
                    self.openChapter(chapter, project: project)
                case .failure(let error): self.status.stringValue = error.localizedDescription
                }
            }
        }
    }

    @objc private func saveDocument() {
        guard canLeaveDocument(), let documentView else { return }
        guard window.makeFirstResponder(nil) else { return }
        documentView.binding.retrySave()
    }

    @objc private func reopenDocument() {
        guard canLeaveDocument(), chapterWorkspace.canReopenActive else { return }
        chapterWorkspace.reopenActive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success: self.status.stringValue = "已从磁盘重新打开，正文自动保存"
            case .failure(let error): self.status.stringValue = error.localizedDescription
            }
        }
    }

    @objc private func splitEditor() {
        guard canLeaveDocument() else { return }
        chapterWorkspace.split { [weak self] result in
            if case .failure(let error) = result { self?.status.stringValue = error.localizedDescription }
        }
    }
    @objc private func closeEditorPane() {
        guard canLeaveDocument() else { return }
        chapterWorkspace.closeSecondPane { [weak self] result in
            if case .failure(let error) = result { self?.status.stringValue = error.localizedDescription }
        }
    }

    private func closeWorkspace(completion: @escaping (Bool) -> Void) {
        guard !closingWorkspace, canLeaveDocument() else { completion(false); return }
        closingWorkspace = true
        chapterWorkspace.close { [weak self] result in
            guard let self else { return }
            self.closingWorkspace = false
            switch result {
            case .success:
                self.agentController?.stop()
                self.workspaceClosed = true; self.closeOutline(); self.closeSearch(); self.closeComments(); self.closeElements()
                self.closeStorylines(); self.closeDrifts(); self.closeRelationTypes()
                completion(true)
            case .failure(let error): self.status.stringValue = error.localizedDescription; completion(false)
            }
        }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if workspaceClosed { return true }
        closeWorkspace { [weak self] success in if success { self?.window.performClose(nil) } }
        return false
    }
    func windowWillClose(_ notification: Notification) {
        guard notification.object as? NSWindow === window else { return }
        closeOutline()
        closeSearch()
        closeComments()
        closeElements()
        closeStorylines()
        closeDrifts()
        closeRelationTypes()
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if workspaceClosed { return .terminateNow }
        guard !closingWorkspace, canLeaveDocument() else { return .terminateCancel }
        closeWorkspace { success in sender.reply(toApplicationShouldTerminate: success) }
        return .terminateLater
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
