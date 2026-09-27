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
    private var reviewButton: NSButton!
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
    private var materialsButton: NSButton!
    private var materialsPanel: MaterialLibraryPanel?
    private var materialsController: MacMaterialLibraryViewController?
    /// One project's 素材库, kept while its panel is closed.
    private var materialModel: MaterialLibraryModel?
    /// 故事图谱: lanes, story time, markers and drift cards of one project.
    private var graphButton: NSButton!
    private var graphPanel: StoryGraphPanel?
    private var graphController: MacStoryGraphViewController?
    /// The axis last shown per project, kept while the panel is closed.
    private var graphAxes: [String: StoryGraphModel.Axis] = [:]
    /// 全书长卷: every chapter of one project in one scroll, over the editor.
    private var wholeBookButton: NSButton!
    private var wholeBookPanel: WholeBookPanel?
    private var wholeBookController: MacWholeBookViewController?
    /// 设定总览: categories around the chapter band, element cards and relation edges.
    private var overviewPanel: ElementOverviewPanel?
    private var overviewController: MacElementOverviewViewController?
    /// 统计 opened from 项目资料.
    private var profileStats: (popover: NSPopover, controller: MacBookStatsViewController)?
    /// 历史版本… of the active page's body.
    private var historySheet: VersionHistorySheet?
    /// 审阅 and the 备忘与素材 board share one model per project.
    private var reviewPanel: ReviewPanel?
    private var reviewController: MacReviewViewController?
    private var reviewModels: [String: ReviewModel] = [:]
    private var boardPanel: MemoBoardPanel?
    private var boardController: MacMemoBoardViewController?
    private var deletionSheet: ProjectDeletionSheet?
    private lazy var projectDeletion = ProjectDeletionCoordinator(workspace: workspace, host: chapterWorkspace)
    /// 文件 › 导入… and 导出全书….
    private lazy var transfer = MacBookTransfer(workspace: workspace, host: chapterWorkspace)
    /// 写作助手: a right-side panel beside the editor, one controller per project.
    private let agentPanel = MacAgentPanelView()
    private let agentCredentials = AgentKeychainCredentialStore()
    private var agentController: AgentChatController?
    private var agentSettings: MacAgentSettingsSheet?
    private var agentButton: NSButton!
    private var agentMenuItem: NSMenuItem!
    private var editorTrailing: NSLayoutConstraint!
    private var editorBesideAgent: NSLayoutConstraint!
    /// 设置: stored in the lab's own data directory, applied before any editor opens.
    private lazy var settingsStore = LabSettingsStore(directory: workspace.dataDirectory)
    private var settingsWindow: MacSettingsWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        settingsStore.apply()
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
        let settings = appMenu.addItem(withTitle: "设置…", action: #selector(showSettings), keyEquivalent: ",")
        settings.target = self
        appMenu.addItem(.separator())
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
        let deleteProject = fileMenu.addItem(withTitle: "删除项目…", action: #selector(deleteSelectedProject), keyEquivalent: "")
        deleteProject.target = self
        fileMenu.addItem(.separator())
        let importItem = fileMenu.addItem(withTitle: "导入…", action: #selector(importFile), keyEquivalent: "o")
        importItem.keyEquivalentModifierMask = [.command, .shift]
        importItem.target = self
        let exportItem = fileMenu.addItem(withTitle: "导出全书…", action: #selector(exportBook), keyEquivalent: "")
        exportItem.target = self
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
        editMenu.addItem(.separator())
        let history = editMenu.addItem(withTitle: "历史版本…", action: #selector(showHistory), keyEquivalent: "y")
        history.keyEquivalentModifierMask = [.command, .option]
        history.target = self
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
        let materials = viewMenu.addItem(withTitle: "素材库", action: #selector(showMaterials), keyEquivalent: "m")
        materials.keyEquivalentModifierMask = [.command, .shift]
        materials.target = self
        let review = viewMenu.addItem(withTitle: "审阅", action: #selector(showReview), keyEquivalent: "r")
        review.keyEquivalentModifierMask = [.command, .option]
        review.target = self
        let board = viewMenu.addItem(withTitle: "备忘与素材", action: #selector(showBoard), keyEquivalent: "t")
        board.keyEquivalentModifierMask = [.command, .option]
        board.target = self
        let graph = viewMenu.addItem(withTitle: "故事图谱", action: #selector(showStoryGraph), keyEquivalent: "g")
        graph.keyEquivalentModifierMask = [.command, .shift]
        graph.target = self
        let wholeBook = viewMenu.addItem(withTitle: "全书长卷", action: #selector(showWholeBook), keyEquivalent: "b")
        wholeBook.keyEquivalentModifierMask = [.command, .shift]
        wholeBook.target = self
        let overview = viewMenu.addItem(withTitle: "设定总览", action: #selector(showElementOverview), keyEquivalent: "e")
        overview.keyEquivalentModifierMask = [.command, .option]
        overview.target = self
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
        graphButton = button("故事图谱", id: "show-story-graph", action: #selector(showStoryGraph))
        graphButton.toolTip = "按成书顺序或故事时间，在故事线轨道上排列章节（⇧⌘G）"
        wholeBookButton = button("长卷", id: "show-whole-book", action: #selector(showWholeBook))
        wholeBookButton.toolTip = "全书长卷：按成书顺序连续阅读和编辑全部章节（⇧⌘B）"
        let projectActions = NSStackView(views: [createProjectButton, renameProjectButton, profileButton])
        let chapterActions = NSStackView(views: [createChapterButton, renameChapterButton, wholeBookButton])
        let orderActions = NSStackView(views: [moveUpButton, moveDownButton, graphButton])
        trashButton = button("移入回收站", id: "trash-chapter", action: #selector(changeChapterTrash))
        trashListButton = button("回收站", id: "show-trash", action: #selector(toggleTrash))
        let trashActions = NSStackView(views: [trashButton, trashListButton])
        let projectScroll = table(projectTable, id: "project-list")
        let chapterScroll = table(chapterTable, id: "chapter-list")
        let chapterMenu = NSMenu()
        chapterMenu.delegate = self
        chapterTable.menu = chapterMenu
        let projectMenu = NSMenu()
        projectMenu.delegate = self
        projectTable.menu = projectMenu
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
        reviewButton = button("审阅", id: "show-review", action: #selector(showReview))
        reviewButton.toolTip = "批注和待办：当前页面或全书（⌥⌘R）"
        elementsButton = button("设定库", id: "show-elements", action: #selector(showElements))
        storylinesButton = button("故事线", id: "show-storylines", action: #selector(showStorylines))
        driftsButton = button("漂流", id: "show-drifts", action: #selector(showDrifts))
        materialsButton = button("素材库", id: "show-materials", action: #selector(showMaterials))
        materialsButton.toolTip = "图片、PDF、链接和笔记（⇧⌘M）"
        splitButton = button("在另一栏打开", id: "split-editor", action: #selector(splitEditor))
        closePaneButton = button("关闭分栏", id: "close-editor-pane", action: #selector(closeEditorPane))
        agentButton = button("写作助手", id: "toggle-agent", action: #selector(toggleAgent))
        agentButton.setButtonType(.pushOnPushOff)
        agentButton.toolTip = "显示或隐藏写作助手（⌥⌘A）"
        let actions = NSStackView(views: [saveButton, reopenButton, outlineButton, searchButton, reviewButton, elementsButton,
                                          storylinesButton, driftsButton, materialsButton, splitButton, closePaneButton, agentButton])
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
            self?.reviewController?.refreshAnchors()
        }
        chapterWorkspace.onCommentCreated = { [weak self] view, comment in
            guard let self else { return }
            self.status.stringValue = "批注已添加"
            if let model = self.commentsController?.model, model.store === view.binding.store { model.reload(after: "批注已添加。") }
            // A selection note is written through the owner; 审阅 reads it.
            self.reviewModels[comment.projectId]?.load()
        }
        chapterWorkspace.onElementLibrary = { [weak self] projectID, library in
            if let overview = self?.overviewController?.model, overview.projectID == projectID { overview.applyElementLibrary(library) }
            guard let model = self?.elementsController?.model, model.projectID == projectID else { return }
            model.apply(library, message: nil)
        }
        chapterWorkspace.onRemoteOriginal = { [weak self] projectID in
            if let overview = self?.overviewController?.model, overview.projectID == projectID { overview.refresh() }
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
        chapterWorkspace.onShowHistory = { [weak self] in self?.showHistory() }
        chapterWorkspace.onMaterialLibrary = { [weak self] projectID, library in
            self?.adoptMaterials(projectID: projectID, library: library, fromWorkspace: true)
        }
        transfer.onStatus = { [weak self] message in self?.status.stringValue = message }
        transfer.onImported = { [weak self] project, entity in self?.adoptImported(entity, project: project) }
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
        if menu === projectTable.menu {
            let row = projectTable.clickedRow
            guard projects.indices.contains(row) else { return }
            let project = projects[row]
            let delete = LibraryMenuItem(title: "删除项目…", identifier: "project-menu-delete") { [weak self] in
                self?.confirmDeleteProject(project)
            }
            delete.isEnabled = !loading && deletionSheet == nil
            menu.addItem(delete)
            return
        }
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
        if let graph = graphController?.model, graph.projectID == projectID { graph.applyNodeMetadata(metadata) }
        if let book = wholeBookController, book.project.id == projectID { book.applyNodeMetadata(metadata) }
        if let overview = overviewController?.model, overview.projectID == projectID { overview.applyNodeMetadata(metadata) }
        if let stats = profileStats?.controller, stats.model.projectID == projectID { stats.model.applyNodeMetadata(metadata) }
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
        if let graph = graphController?.model, graph.projectID == projectID { graph.applyWordCounts(library) }
        if let book = wholeBookController, book.project.id == projectID { book.applyWordCounts(library) }
        if let stats = profileStats?.controller, stats.model.projectID == projectID { stats.reload() }
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
            graphChaptersChanged(projectID: projectID)
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
        let sheet = ProjectProfileSheet(model: profile, projectName: name, plans: settingsStore)
        profileSheet = sheet
        sheet.onShowStats = { [weak self] button in self?.showProfileStats(project: project, from: button) }
        sheet.onDeleteProject = { [weak self] in self?.confirmDeleteProject(WorkspaceProject(id: project.id, name: name)) }
        sheet.onFinish = { [weak self] in
            self?.profileStats?.popover.close(); self?.profileStats = nil
            self?.profileSheet = nil
            self?.status.stringValue = "项目资料已保存"
        }
        sheet.begin(in: window)
    }

    /// 节奏统计… in 项目资料: 统计 beside the button. A chapter bar opens the
    /// chapter, or scrolls the 全书长卷 to it when that is open.
    private func showProfileStats(project: WorkspaceProject, from button: NSButton) {
        if let current = profileStats, current.popover.isShown { current.popover.performClose(nil); return }
        let model = WholeBookModel(workspace: workspace, projectID: project.id)
        let controller = MacBookStatsViewController(model: model)
        controller.counts = { [weak self] in self?.chapterWorkspace.wordCountLibrary(projectID: project.id) }
        controller.plan = { [weak self] in self?.settingsStore.writingPlan(projectID: project.id) ?? WritingPlan() }
        controller.onSelectChapter = { [weak self] chapter in self?.openFromStats(chapterID: chapter.id, title: chapter.title, project: project) }
        controller.onSelectAct = { [weak self, weak model] act in
            guard let first = act.chapterIDs.first, let chapter = model?.layout.chapter(id: first) else { return }
            self?.openFromStats(chapterID: chapter.id, title: chapter.title, project: project)
        }
        let popover = NSPopover()
        popover.behavior = .transient
        popover.animates = false
        popover.contentViewController = controller
        profileStats = (popover, controller)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .maxY)
        chapterWorkspace.wordCounts(projectID: project.id)
        model.load()
    }

    private func openFromStats(chapterID: String, title: String, project: WorkspaceProject) {
        profileStats?.popover.performClose(nil)
        profileSheet?.done()
        if let book = wholeBookController, wholeBookPanel?.isVisible == true, book.project.id == project.id {
            book.scroll(toChapter: chapterID)
            wholeBookPanel?.makeKeyAndOrderFront(nil)
        } else {
            openChapter(WorkspaceChapter(id: chapterID, title: title), project: project)
        }
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
                // With the 全书长卷 open, a chapter row scrolls it there.
                if let book = wholeBookController, wholeBookPanel?.isVisible == true, book.project.id == selectedProject.id {
                    book.scroll(toChapter: chapters[table.selectedRow].id)
                    wholeBookPanel?.orderFront(nil)
                } else {
                    openChapter(chapters[table.selectedRow], project: selectedProject)
                }
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
        reviewButton.isEnabled = !loading && (currentProject != nil || selectedProject != nil)
        elementsButton.isEnabled = ready && (currentProject != nil || selectedProject != nil)
        storylinesButton.isEnabled = ready && (currentProject != nil || selectedProject != nil)
        driftsButton.isEnabled = ready && (currentProject != nil || selectedProject != nil)
        materialsButton.isEnabled = !loading && (currentProject != nil || selectedProject != nil)
        graphButton.isEnabled = !loading && (currentProject != nil || selectedProject != nil)
        wholeBookButton.isEnabled = !loading && (currentProject != nil || selectedProject != nil)
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
                // A chosen font that could not be used says so once at launch.
                self.status.stringValue = self.settingsStore.fontFallback ?? "选择项目，或新建一个项目。"
            case .failure(let error): self.status.stringValue = error.localizedDescription
            }
        }
    }

    private func selectProject(_ project: WorkspaceProject, message: String? = nil) {
        guard canLeaveDocument() else { return }
        // The 全书长卷 shows one project; typing there must settle first.
        if wholeBookController.map({ $0.project.id != project.id }) == true, !closeWholeBook() { return }
        closeOutline()
        closeSearch()
        if elementsController?.model.projectID != project.id { closeElements() }
        if storylinesController?.model.projectID != project.id { closeStorylines() }
        if driftsController?.model.projectID != project.id { closeDrifts() }
        if relationTypesController?.model.projectID != project.id { closeRelationTypes() }
        if materialsController?.model.projectID != project.id { closeMaterials() }
        if graphController?.model.projectID != project.id { closeStoryGraph() }
        if overviewController?.model.projectID != project.id { closeElementOverview() }
        if reviewController?.model.projectID != project.id { closeReview() }
        if boardController?.review.projectID != project.id { closeBoard() }
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
                self.status.stringValue = message ?? "\(project.name) · \(chapters.count) 个章节"
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
        updateReviewFocus()
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
        // Body and resolution changes here reach 审阅.
        model.onCommitted = { [weak self] comment in self?.reviewModels[comment.projectId]?.load() }
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
            if let overview = self?.overviewController?.model, overview.projectID == project.id { overview.applyElementLibrary(library) }
        }
        controller.onClose = { [weak self] in self?.closeElements() }
        controller.onShowOverview = { [weak self] in self?.showElementOverview() }
        controller.canNavigate = { [weak self] in self?.canLeaveDocument() == true }
        controller.onOpen = { [weak self] element in self?.openElement(element, project: project, focusName: false) }
        controller.onCreated = { [weak self] element in self?.openElement(element, project: project, focusName: true) }
        controller.onTrash = { [weak self] element in self?.trashElement(element, project: project) }
        controller.onOpenCategory = { [weak self] category in self?.openCategory(category, project: project) }
        controller.onTrashCategory = { [weak self] category in self?.trashCategory(category, project: project) }
        // Rows show small portraits once the 素材库 has been read.
        controller.portraitPath = { [weak self] id in
            self?.chapterWorkspace.materialLibrary(projectID: project.id)?.portrait(elementID: id)?.assetPath
        }
        if chapterWorkspace.materialLibrary(projectID: project.id) == nil { chapterWorkspace.materialsChanged(projectID: project.id) }
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

    private func openCategory(_ category: WorkspaceElementCategory, project: WorkspaceProject) {
        guard canLeaveDocument() else {
            elementsController?.model.showStatus("请先完成输入，并等待正文保存后再打开分类页。"); return
        }
        chapterWorkspace.open(project: project, category: category) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.status.stringValue = "分类正文自动保存"
                self.window.makeKeyAndOrderFront(nil)
                self.documentActivity(!self.chapterWorkspace.canNavigate)
            case .failure(let error):
                self.status.stringValue = error.localizedDescription
                self.elementsController?.model.showStatus(error.localizedDescription)
                self.activeChapterChanged()
            }
        }
    }

    /// The trash commits first; the category's page then closes. Its
    /// elements move to 未分类 and their pages stay open.
    private func trashCategory(_ category: WorkspaceElementCategory, project: WorkspaceProject) {
        guard canLeaveDocument() else {
            elementsController?.model.showStatus("请先完成输入，并等待正文保存后再修改设定库。"); return
        }
        chapterWorkspace.trashCategory(projectID: project.id, categoryID: category.id) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let reply):
                self.elementsController?.model.apply(reply.library, message: "“\(category.name)”已移到回收站，其中的设定已移到“未分类”。")
                self.status.stringValue = "分类已移到回收站"
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
        if let graph = graphController?.model, graph.projectID == projectID { graph.applyStorylines(library) }
        if let overview = overviewController?.model, overview.projectID == projectID { overview.applyStorylines(library) }
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
        if let graph = graphController?.model, graph.projectID == projectID { graph.applyDrifts(library) }
        if let overview = overviewController?.model, overview.projectID == projectID { overview.applyDrifts(library) }
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

    // MARK: Materials library

    /// Keeps one 素材库 model for the project whose panel is shown.
    @discardableResult
    private func ensureMaterialModel(_ project: WorkspaceProject) -> MaterialLibraryModel {
        if let materialModel, materialModel.projectID == project.id { return materialModel }
        let model = MaterialLibraryModel(workspace: workspace, projectID: project.id)
        materialModel = model
        model.onLibrary = { [weak self] library in
            self?.adoptMaterials(projectID: project.id, library: library, fromWorkspace: false)
        }
        if let library = chapterWorkspace.materialLibrary(projectID: project.id) { model.apply(library, message: nil) }
        model.load()
        return model
    }

    /// Every 素材库 reply reaches the panel, element pages and the 设定库
    /// rows' portraits; the source is not told again.
    private func adoptMaterials(projectID: String, library: WorkspaceMaterialLibrary, fromWorkspace: Bool) {
        if fromWorkspace {
            if let model = materialModel, model.projectID == projectID, !model.busy { model.apply(library, message: nil) }
        } else {
            chapterWorkspace.applyMaterialLibrary(projectID: projectID, library: library)
        }
        if let elements = elementsController, elements.model.projectID == projectID { elements.reload() }
    }

    /// 素材库 (action row and 视图 › 素材库, ⇧⌘M): a panel beside the editor.
    @objc private func showMaterials() {
        guard let project = currentProject ?? selectedProject else { return }
        if let materialsPanel, materialsPanel.isVisible, materialsController?.model.projectID == project.id {
            materialsPanel.makeKeyAndOrderFront(nil); return
        }
        closeMaterials()
        let model = ensureMaterialModel(project)
        let controller = MacMaterialLibraryViewController(model: model)
        // 关联 chips and menus; a chip opens its page as a tab.
        chapterWorkspace.loadNames(projectID: project.id)
        controller.associations = chapterWorkspace.relations.associations(projectID: project.id)
        controller.onOpenAssociation = { [weak self] endpoint in
            guard let self, self.canLeaveDocument() else { return }
            self.chapterWorkspace.open(endpoint: endpoint, project: self.namedProject(project)) { [weak self] result in
                if case .failure(let error) = result { self?.status.stringValue = error.localizedDescription }
                else { self?.window.makeKeyAndOrderFront(nil) }
            }
        }
        let panel = MaterialLibraryPanel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 600),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = "\(project.name) · 素材库"
        panel.minSize = NSSize(width: 320, height: 360)
        panel.isReleasedWhenClosed = false; panel.contentViewController = controller
        materialsPanel = panel; materialsController = controller
        panel.onClose = { [weak self] in self?.materialsPanel = nil; self?.materialsController = nil }
        controller.onClose = { [weak self] in self?.closeMaterials() }
        window.addChildWindow(panel, ordered: .above)
        // At the trailing edge, clear of the text column.
        let frame = window.frame
        panel.setFrameTopLeftPoint(NSPoint(x: max(frame.minX, frame.maxX - panel.frame.width - 24), y: frame.maxY - 90))
        panel.makeKeyAndOrderFront(nil)
        if !model.busy { model.load() }
    }

    private func closeMaterials() {
        let panel = materialsPanel
        materialsPanel = nil; materialsController = nil
        if let panel { window.removeChildWindow(panel); panel.close() }
    }

    // MARK: Story graph

    /// 故事图谱 (sidebar and 视图 › 故事图谱, ⇧⌘G): a large panel over the
    /// window. Book moves, lane changes and statuses reach the chapter list,
    /// pages and the outline; it reads everything again when it becomes key.
    @objc private func showStoryGraph() {
        guard !loading, let project = currentProject ?? selectedProject else { return }
        if let graphPanel, graphPanel.isVisible, graphController?.model.projectID == project.id {
            graphPanel.makeKeyAndOrderFront(nil); return
        }
        closeStoryGraph()
        let name = projects.first { $0.id == project.id }?.name ?? project.name
        let model = StoryGraphModel(workspace: workspace, projectID: project.id)
        model.axis = graphAxes[project.id] ?? .book
        if let counts = chapterWorkspace.wordCounts(projectID: project.id).library { model.applyWordCounts(counts) }
        model.onChapters = { [weak self] chapters in self?.adoptGraphChapters(chapters, projectID: project.id) }
        model.onStorylineLibrary = { [weak self] library in
            guard let self else { return }
            if let storylines = self.storylineModel, storylines.projectID == project.id { storylines.apply(library, message: nil) }
            self.adoptStorylines(projectID: project.id, library: library, fromWorkspace: false)
        }
        let controller = MacStoryGraphViewController(model: model)
        // Opening a page closes the panel, which sits over the editor.
        controller.onOpenChapter = { [weak self, weak model] chapter in
            guard let self else { return }
            guard self.canLeaveDocument() else { model?.showStatus("请先完成输入，并等待正文保存后再打开章节。"); return }
            self.closeStoryGraph()
            self.openChapter(chapter, project: project)
            self.window.makeKeyAndOrderFront(nil)
        }
        controller.onOpenDrift = { [weak self, weak model] drift in
            self?.openDrift(drift, project: project, focusTitle: false) { opened in
                if opened { self?.closeStoryGraph() }
                else { model?.showStatus("请先完成输入，并等待正文保存后再打开漂流。") }
            }
        }
        controller.onSetStatus = { [weak self, weak model] chapter, status in
            self?.chapterWorkspace.setNodeStatus(projectID: project.id, nodeID: chapter.id, status: status) { result in
                model?.showStatus(Self.statusMessage(result, title: chapter.title))
            }
        }
        controller.onClose = { [weak self] in self?.closeStoryGraph() }
        let panel = StoryGraphPanel(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 640),
            styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        panel.title = "\(name) · 故事图谱"
        panel.minSize = NSSize(width: 640, height: 420)
        panel.isReleasedWhenClosed = false; panel.contentViewController = controller
        panel.setContentSize(NSSize(width: 1000, height: 640))
        graphPanel = panel; graphController = controller
        panel.onClose = { [weak self, weak model] in
            if let model { self?.graphAxes[model.projectID] = model.axis }
            self?.graphPanel = nil; self?.graphController = nil
        }
        window.addChildWindow(panel, ordered: .above)
        panel.center(); panel.makeKeyAndOrderFront(nil)
        // Edits made in the window meanwhile are read when it is key again.
        panel.onBecomeKey = { [weak model] in if model?.loaded == true { model?.refresh() } }
        model.load()
    }

    /// A book move in the graph reorders the chapter list and the outline.
    private func adoptGraphChapters(_ chapters: [WorkspaceChapter], projectID: String) {
        chapterWorkspace.applyChapters(projectID: projectID, chapters: chapters, trashed: nil)
        wholeBookChanged(projectID: projectID)
        overviewChaptersChanged(projectID: projectID)
        if let outline = outlineController?.model, outline.projectID == projectID { outline.load() }
        guard selectedProject?.id == projectID else { return }
        self.chapters = chapters
        guard !showingTrash else { return }
        updatingSelection = true
        chapterTable.reloadData()
        if currentProject?.id == projectID, let chapter = currentChapter, let index = chapters.firstIndex(where: { $0.id == chapter.id }) {
            chapterTable.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
        } else { chapterTable.deselectAll(nil) }
        updatingSelection = false
        updateControls()
    }

    /// Chapters were created, renamed, moved, trashed or restored elsewhere.
    private func graphChaptersChanged(projectID: String) {
        if let model = graphController?.model, model.projectID == projectID { model.refresh() }
        wholeBookChanged(projectID: projectID)
        overviewChaptersChanged(projectID: projectID)
    }

    /// Chapters or acts changed: the 设定总览's band reads them again.
    private func overviewChaptersChanged(projectID: String) {
        if let overview = overviewController?.model, overview.projectID == projectID { overview.chaptersChanged() }
    }

    /// Chapters or acts changed: the 全书长卷 reads the book again.
    private func wholeBookChanged(projectID: String) {
        if let book = wholeBookController, book.project.id == projectID { book.model.load() }
    }

    private func closeStoryGraph() {
        if let model = graphController?.model { graphAxes[model.projectID] = model.axis }
        let panel = graphPanel
        graphPanel = nil; graphController = nil
        if let panel { window.removeChildWindow(panel); panel.close() }
    }

    // MARK: Element overview

    /// 设定总览 (视图 › 设定总览, ⌥⌘E, or 总览 in the 设定库): a large panel over
    /// the window. Opening a page closes it, as the 故事图谱 does; the viewport
    /// is remembered per project in settings.json. It reads everything again
    /// when it becomes key.
    @objc private func showElementOverview() {
        guard !loading, let project = currentProject ?? selectedProject else { return }
        if let overviewPanel, overviewPanel.isVisible, overviewController?.model.projectID == project.id {
            overviewPanel.makeKeyAndOrderFront(nil); return
        }
        closeElementOverview()
        let name = projects.first { $0.id == project.id }?.name ?? project.name
        let model = ElementOverviewModel(workspace: workspace, projectID: project.id,
                                         relations: chapterWorkspace.relations.model(projectID: project.id))
        let viewport = settingsStore.elementOverviewViewport(projectID: project.id)
        model.showsDrifts = viewport?.showsDrifts ?? false
        // A pin's reply reaches open pages and the 设定库.
        model.onElementLibrary = { [weak self] library in
            guard let self else { return }
            self.chapterWorkspace.applyElementLibrary(projectID: project.id, library: library)
            if let elements = self.elementsController?.model, elements.projectID == project.id { elements.apply(library, message: nil) }
        }
        let controller = MacElementOverviewViewController(model: model)
        controller.initialViewport = viewport
        func leave(_ open: @escaping () -> Void) -> Bool {
            guard canLeaveDocument() else { return false }
            closeElementOverview()
            open()
            return true
        }
        controller.onOpenElement = { [weak self, weak controller] element in
            guard let self else { return }
            if !leave({ self.openElement(element, project: project, focusName: false) }) {
                controller?.showStatus("请先完成输入，并等待正文保存后再打开设定。")
            }
        }
        controller.onOpenCategory = { [weak self, weak controller] category in
            guard let self else { return }
            if !leave({ self.openCategory(category, project: project) }) {
                controller?.showStatus("请先完成输入，并等待正文保存后再打开分类页。")
            }
        }
        controller.onOpenChapter = { [weak self, weak controller] chapter in
            guard let self else { return }
            if !leave({ self.openChapter(chapter, project: project); self.window.makeKeyAndOrderFront(nil) }) {
                controller?.showStatus("请先完成输入，并等待正文保存后再打开章节。")
            }
        }
        controller.onOpenDrift = { [weak self, weak controller] drift in
            guard let self else { return }
            if !leave({ self.openDrift(drift, project: project, focusTitle: false) }) {
                controller?.showStatus("请先完成输入，并等待正文保存后再打开漂流。")
            }
        }
        controller.onTrashElement = { [weak self] element in self?.trashElement(element, project: project) }
        controller.onClose = { [weak self] in self?.closeElementOverview() }
        let panel = ElementOverviewPanel(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 700),
            styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        panel.title = "\(name) · 设定总览"
        panel.minSize = NSSize(width: 640, height: 420)
        panel.isReleasedWhenClosed = false; panel.contentViewController = controller
        panel.setContentSize(NSSize(width: 1100, height: 700))
        overviewPanel = panel; overviewController = controller
        panel.onClose = { [weak self, weak panel, weak controller] in
            guard let self, self.overviewPanel === panel else { return }
            if let controller { self.settingsStore.setElementOverviewViewport(controller.viewport, projectID: controller.model.projectID) }
            self.overviewPanel = nil; self.overviewController = nil
        }
        window.addChildWindow(panel, ordered: .above)
        panel.center(); panel.makeKeyAndOrderFront(nil)
        // Edits made in the window meanwhile are read when it is key again.
        panel.onBecomeKey = { [weak model] in if model?.loaded == true { model?.refresh() } }
        model.load()
    }

    /// Remembers the viewport, then closes the panel.
    private func closeElementOverview() {
        if let controller = overviewController {
            settingsStore.setElementOverviewViewport(controller.viewport, projectID: controller.model.projectID)
            controller.endRelationSheet()
        }
        let panel = overviewPanel
        overviewPanel = nil; overviewController = nil
        if let panel { window.removeChildWindow(panel); panel.close() }
    }

    // MARK: Whole book

    /// 全书长卷 (sidebar 长卷 and 视图 › 全书长卷, ⇧⌘B): every chapter in reading
    /// order in a large panel over the editor, beside the chapter list. Chapter
    /// rows and the outline scroll it while it is open.
    @objc private func showWholeBook() {
        guard !loading, let project = currentProject ?? selectedProject else { return }
        if let wholeBookPanel, wholeBookPanel.isVisible, wholeBookController?.project.id == project.id {
            wholeBookPanel.makeKeyAndOrderFront(nil); return
        }
        guard closeWholeBook(completion: { [weak self] in self?.openWholeBook(project) }) else { return }
    }

    private func openWholeBook(_ project: WorkspaceProject) {
        guard wholeBookController == nil else { return }
        let name = projects.first { $0.id == project.id }?.name ?? project.name
        let named = WorkspaceProject(id: project.id, name: name)
        let model = WholeBookModel(workspace: workspace, projectID: project.id)
        let controller = MacWholeBookViewController(project: named, model: model, workspace: workspace, host: chapterWorkspace)
        controller.plan = { [weak self] in self?.settingsStore.writingPlan(projectID: project.id) ?? WritingPlan() }
        controller.onClose = { [weak self] in self?.closeWholeBook() }
        // A linked page opens as a tab in the window under the panel.
        controller.onOpenLink = { [weak self] target in
            guard let self else { return }
            _ = self.closeWholeBook { [weak self] in
                guard let self else { return }
                self.chapterWorkspace.openLink(target, project: named)
                self.window.makeKeyAndOrderFront(nil)
            }
        }
        controller.onSetStatus = { [weak self, weak model] chapter, status in
            self?.chapterWorkspace.setNodeStatus(projectID: project.id, nodeID: chapter.id, status: status) { result in
                model?.showStatus(Self.statusMessage(result, title: chapter.title))
            }
        }
        controller.onActColorChanged = { [weak self] in self?.actColorsChanged(projectID: project.id, fromWholeBook: true) }
        let panel = WholeBookPanel(contentRect: NSRect(x: 0, y: 0, width: 820, height: 640),
            styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        panel.title = "\(name) · 全书长卷"
        panel.minSize = NSSize(width: 560, height: 420)
        panel.isReleasedWhenClosed = false; panel.contentViewController = controller
        // Over the editor area, leaving the chapter list beside it.
        let area = window.convertToScreen(editorHost.convert(editorHost.bounds, to: nil))
        panel.setFrame(NSRect(x: area.minX, y: area.minY, width: max(area.width, 560), height: max(area.height + 60, 420)), display: false)
        wholeBookPanel = panel; wholeBookController = controller
        panel.shouldClose = { [weak self] in self?.closeWholeBook(); return false }
        panel.onClose = { [weak self, weak panel] in
            guard let self, self.wholeBookPanel === panel else { return }
            self.wholeBookPanel = nil; self.wholeBookController = nil
        }
        window.addChildWindow(panel, ordered: .above)
        panel.makeKeyAndOrderFront(nil)
        // Edits made in the window meanwhile are read when it is key again.
        panel.onBecomeKey = { [weak model] in if model?.loaded == true { model?.load() } }
        chapterWorkspace.wordCounts(projectID: project.id)
        model.load()
    }

    /// Releases the 全书长卷's editors and closes the panel; `completion` runs
    /// once the owners no tab shows are closed. False, keeping the panel,
    /// while one of its editors has input in flight.
    @discardableResult
    private func closeWholeBook(completion: (() -> Void)? = nil) -> Bool {
        guard let controller = wholeBookController else { completion?(); return true }
        guard controller.shutdown(completion: completion) else {
            let message = "请先完成全书长卷中的输入，并等待正文保存后再关闭。"
            status.stringValue = message
            controller.model.showStatus(message)
            return false
        }
        let panel = wholeBookPanel
        wholeBookPanel = nil; wholeBookController = nil
        if let panel { window.removeChildWindow(panel); panel.close() }
        return true
    }

    // MARK: Act colours

    /// 幕颜色 was stored: the outline, the 设定总览's act strip and 统计 follow.
    private func actColorsChanged(projectID: String, fromWholeBook: Bool) {
        if let outline = outlineController?.model, outline.projectID == projectID, !outline.busy { outline.load() }
        overviewChaptersChanged(projectID: projectID)
        if !fromWholeBook { wholeBookChanged(projectID: projectID) }
        if let stats = profileStats?.controller, stats.model.projectID == projectID { stats.model.load() }
    }

    // MARK: 审阅

    /// The project's notes and TODOs, read once and shared by 审阅 and the board.
    @discardableResult
    private func ensureReviewModel(_ project: WorkspaceProject) -> ReviewModel {
        if let model = reviewModels[project.id] { return model }
        chapterWorkspace.loadNames(projectID: project.id)
        let model = ReviewModel(workspace: workspace, projectID: project.id,
                                associations: chapterWorkspace.relations.associations(projectID: project.id))
        model.ownerBusy = { [weak self] chapterID in
            guard let view = self?.chapterWorkspace.openView(scope: .chapter(ChapterScope(projectID: project.id, chapterID: chapterID))) else {
                return false
            }
            return view.binding.hasPendingWork || view.textView.hasMarkedText()
        }
        model.onChanged = { [weak self] change in
            guard let self else { return }
            // A deleted passage note leaves the open chapter's highlights.
            self.chapterWorkspace.commentsChanged(change, projectID: project.id)
            if let comments = self.commentsController?.model, comments.store != nil,
               comments.store === self.chapterWorkspace.activeChapterView?.binding.store,
               self.currentChapter?.id == change.comment.targetId {
                comments.reload()
            }
        }
        reviewModels[project.id] = model
        model.load()
        return model
    }

    private func namedProject(_ project: WorkspaceProject) -> WorkspaceProject {
        WorkspaceProject(id: project.id, name: projects.first { $0.id == project.id }?.name ?? project.name)
    }

    /// 审阅 (action row and 视图 › 审阅, ⌥⌘R): a panel beside the editor.
    @objc private func showReview() {
        guard let project = currentProject ?? selectedProject else { return }
        if let reviewPanel, reviewPanel.isVisible, reviewController?.model.projectID == project.id {
            updateReviewFocus(); reviewPanel.makeKeyAndOrderFront(nil); return
        }
        closeReview()
        let named = namedProject(project)
        let model = ensureReviewModel(named)
        let controller = MacReviewViewController(model: model)
        wireReviewCommands(controller.commands, project: named)
        controller.anchor = { [weak self] comment in self?.liveAnchor(comment, projectID: named.id) }
        controller.onShowChapterComments = { [weak self] in self?.showComments() }
        controller.onShowBoard = { [weak self] in self?.showBoard() }
        controller.onClose = { [weak self] in self?.closeReview() }
        let panel = ReviewPanel(contentRect: NSRect(x: 0, y: 0, width: 440, height: 620),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = "\(named.name) · 审阅"
        panel.minSize = NSSize(width: 380, height: 360)
        panel.isReleasedWhenClosed = false; panel.contentViewController = controller
        reviewPanel = panel; reviewController = controller
        panel.onClose = { [weak self, weak panel] in
            guard let self, self.reviewPanel === panel else { return }
            self.reviewPanel = nil; self.reviewController = nil
        }
        // Selection notes written meanwhile are read when it is key again.
        panel.onBecomeKey = { [weak model] in if model?.loaded == true, model?.busy == false { model?.load() } }
        window.addChildWindow(panel, ordered: .above)
        let frame = window.frame
        panel.setFrameTopLeftPoint(NSPoint(x: max(frame.minX, frame.maxX - panel.frame.width - 24), y: frame.maxY - 90))
        panel.makeKeyAndOrderFront(nil)
        updateReviewFocus()
    }

    /// 定位 opens the page as a tab (a passage note selects its text) and a
    /// chip opens its entity, in the window under the panel.
    private func wireReviewCommands(_ commands: ReviewCommands, project: WorkspaceProject) {
        commands.onLocate = { [weak self, weak commands] comment in
            guard let self else { return }
            guard self.canLeaveDocument() else { commands?.model.showStatus("请先完成输入，并等待正文保存后再定位。"); return }
            self.chapterWorkspace.locate(comment: comment, project: project) { [weak self, weak commands] refusal in
                if let refusal { commands?.model.showStatus(refusal); return }
                self?.window.makeKeyAndOrderFront(nil)
                self?.status.stringValue = "已定位\(comment.kindLabel)"
            }
        }
        commands.onOpen = { [weak self, weak commands] endpoint in
            guard let self else { return }
            guard self.canLeaveDocument() else { commands?.model.showStatus("请先完成输入，并等待正文保存后再打开。"); return }
            self.chapterWorkspace.open(endpoint: endpoint, project: project) { [weak self, weak commands] result in
                if case .failure(let error) = result { commands?.model.showStatus(error.localizedDescription) }
                else { self?.window.makeKeyAndOrderFront(nil) }
            }
        }
    }

    /// A passage note's live anchor, when its chapter is open.
    private func liveAnchor(_ comment: WorkspaceComment, projectID: String) -> NativeComment? {
        guard comment.targetKind == "node", let chapter = comment.targetId,
              let view = chapterWorkspace.openView(scope: .chapter(ChapterScope(projectID: projectID, chapterID: chapter))) else { return nil }
        return view.binding.store.projection?.comments.first { $0.id == comment.id }
    }

    /// 审阅's 当前 follows its project's active tab.
    private func updateReviewFocus() {
        for model in reviewModels.values {
            model.setFocus(currentProject?.id == model.projectID ? chapterWorkspace.activeFocus : nil)
        }
    }

    private func closeReview() {
        let panel = reviewPanel
        reviewController?.commands.endSheets()
        reviewPanel = nil; reviewController = nil
        if let panel { window.removeChildWindow(panel); panel.close() }
    }

    // MARK: 备忘与素材

    /// 备忘与素材 (视图 › 备忘与素材, ⌥⌘T, or 看板… in 审阅): TODO cards beside
    /// the 素材库's cards in a large panel over the window.
    @objc private func showBoard() {
        guard !loading, let project = currentProject ?? selectedProject else { return }
        if let boardPanel, boardPanel.isVisible, boardController?.review.projectID == project.id {
            boardPanel.makeKeyAndOrderFront(nil); return
        }
        closeBoard()
        let named = namedProject(project)
        let review = ensureReviewModel(named)
        let materials = ensureMaterialModel(named)
        let controller = MacMemoBoardViewController(review: review, materials: materials)
        wireReviewCommands(controller.commands, project: named)
        controller.library.onOpenAssociation = { [weak commands = controller.commands] endpoint in commands?.onOpen?(endpoint) }
        controller.onClose = { [weak self] in self?.closeBoard() }
        let panel = MemoBoardPanel(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 640),
            styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        panel.title = "\(named.name) · 备忘与素材"
        panel.minSize = NSSize(width: 760, height: 420)
        panel.isReleasedWhenClosed = false; panel.contentViewController = controller
        panel.setContentSize(NSSize(width: 1000, height: 640))
        boardPanel = panel; boardController = controller
        panel.onClose = { [weak self, weak panel] in
            guard let self, self.boardPanel === panel else { return }
            self.boardPanel = nil; self.boardController = nil
        }
        panel.onBecomeKey = { [weak review] in if review?.loaded == true, review?.busy == false { review?.load() } }
        window.addChildWindow(panel, ordered: .above)
        panel.center(); panel.makeKeyAndOrderFront(nil)
        updateReviewFocus()
        if !materials.busy { materials.load() }
    }

    private func closeBoard() {
        let panel = boardPanel
        boardController?.commands.endSheets()
        boardPanel = nil; boardController = nil
        if let panel { window.removeChildWindow(panel); panel.close() }
    }

    // MARK: Project deletion

    @objc private func deleteSelectedProject() {
        guard let project = selectedProject ?? currentProject else { return }
        confirmDeleteProject(project)
    }

    /// 删除项目… (project list menu, 文件 and 项目资料): the typed-name sheet,
    /// then closing the project's panels and tabs, deletion and the switch.
    private func confirmDeleteProject(_ project: WorkspaceProject) {
        guard deletionSheet == nil, !loading, window.attachedSheet == nil else { return }
        let named = namedProject(project)
        let sheet = ProjectDeletionSheet(project: named)
        deletionSheet = sheet
        projectDeletion.closePanels = { [weak self] projectID, done in
            guard let self else { done(nil); return }
            self.closePanels(of: projectID, completion: done)
        }
        projectDeletion.forgetSettings = { [weak self] projectID in self?.settingsStore.forgetProject(projectID) }
        sheet.onConfirm = { [weak self] done in
            guard let self else { done(LabError.message("窗口已关闭，项目未删除。")); return }
            self.status.stringValue = "正在关闭“\(named.name)”的标签页和面板…"
            self.projectDeletion.delete(named) { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(let outcome):
                    done(nil)
                    self.adoptDeletion(outcome, deleted: named)
                case .failure(let error):
                    self.status.stringValue = error.localizedDescription
                    done(error)
                }
            }
        }
        sheet.onFinish = { [weak self, weak sheet] in
            if let self, self.deletionSheet === sheet { self.deletionSheet = nil }
        }
        window.beginSheet(sheet.window)
        sheet.window.makeFirstResponder(sheet.nameField)
        ProjectDeletionSummary.load(workspace: workspace, projectID: named.id) { [weak sheet] summary in sheet?.show(summary) }
    }

    /// Closes every panel showing the project. The 全书长卷 first lets go of
    /// its editors; it reports why when input is still in flight there.
    private func closePanels(of projectID: String, completion: @escaping (String?) -> Void) {
        closeOutline(); closeSearch(); closeComments()
        profileStats?.popover.close(); profileStats = nil
        if reviewController?.model.projectID == projectID { closeReview() }
        if boardController?.review.projectID == projectID { closeBoard() }
        if elementsController?.model.projectID == projectID { closeElements() }
        if storylinesController?.model.projectID == projectID { closeStorylines() }
        if driftsController?.model.projectID == projectID { closeDrifts() }
        if relationTypesController?.model.projectID == projectID { closeRelationTypes() }
        if materialsController?.model.projectID == projectID { closeMaterials() }
        if graphController?.model.projectID == projectID { closeStoryGraph() }
        if overviewController?.model.projectID == projectID { closeElementOverview() }
        if agentController?.projectID == projectID { agentController?.stop() }
        transfer.endImport()
        guard wholeBookController?.project.id == projectID else { completion(nil); return }
        if !closeWholeBook(completion: { completion(nil) }) {
            completion("全书长卷中还有未完成的输入，请等待正文保存后再删除。")
        }
    }

    /// The project is gone: models of it are dropped and the list shows the
    /// remaining projects, then the next one (or the new empty one) opens.
    private func adoptDeletion(_ outcome: ProjectDeletionCoordinator.Outcome, deleted: WorkspaceProject) {
        reviewModels.removeValue(forKey: deleted.id)
        if storylineModel?.projectID == deleted.id { storylineModel = nil }
        if driftModel?.projectID == deleted.id { driftModel = nil }
        if materialModel?.projectID == deleted.id { materialModel = nil }
        graphAxes.removeValue(forKey: deleted.id)
        if agentController?.projectID == deleted.id { agentController = nil }
        projects = outcome.projects
        if selectedProject?.id == deleted.id {
            selectedProject = nil
            chapters = []; trashedChapters = []; showingTrash = false
            chapterTable.reloadData()
            chapterEmpty.stringValue = "选择项目后，在这里管理章节。"
            chapterEmpty.isHidden = false
        }
        updatingSelection = true
        projectTable.reloadData()
        projectTable.deselectAll(nil)
        updatingSelection = false
        projectEmpty.isHidden = !projects.isEmpty
        activeChapterChanged()
        let message = "项目“\(deleted.name)”已删除。" + (outcome.created ? "已新建空项目“\(ProjectDeletionCoordinator.replacementName)”。" : "")
        status.stringValue = message
        // Another project stays shown; deleting the shown one opens the next.
        if let shown = selectedProject, let index = projects.firstIndex(where: { $0.id == shown.id }) {
            updatingSelection = true
            projectTable.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
            updatingSelection = false
            return
        }
        guard let next = outcome.next, let index = projects.firstIndex(where: { $0.id == next.id }) else { return }
        updatingSelection = true
        projectTable.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
        updatingSelection = false
        selectProject(next, message: message)
    }

    // MARK: Version history

    /// 历史版本… (a pane's header and 编辑 › 历史版本…, ⌥⌘Y): a sheet listing the
    /// active page's versions with a preview and 恢复此版本.
    @objc private func showHistory() {
        guard historySheet == nil, !loading else { return }
        guard let target = chapterWorkspace.activeHistoryTarget else {
            status.stringValue = "请先打开一个章节、漂流、设定或故事线页面，再查看历史版本。"; return
        }
        guard canLeaveDocument() else { return }
        let model = VersionHistoryModel(workspace: workspace, target: target)
        model.onRestored = { [weak self] live in
            self?.chapterWorkspace.adoptRestoredVersion(target, live: live)
            self?.status.stringValue = "已恢复“\(target.title)”的历史版本。恢复前的正文已存为新版本，可以撤销。"
        }
        let sheet = VersionHistorySheet(model: model)
        historySheet = sheet
        sheet.onFinish = { [weak self] in self?.historySheet = nil }
        sheet.begin(in: window)
        model.load()
    }

    // MARK: Import and export

    /// 文件 › 导入…: a Markdown, text or Word file becomes a new chapter,
    /// element or drift of the current project.
    @objc private func importFile() {
        guard !loading, let project = currentProject ?? selectedProject else {
            status.stringValue = "请先选择一个项目，再导入文件。"; return
        }
        transfer.beginImport(project: project, window: window)
    }

    /// 文件 › 导出全书…: Markdown or plain text through a save panel.
    @objc private func exportBook() {
        guard canLeaveDocument(), let project = currentProject ?? selectedProject else {
            if currentProject == nil && selectedProject == nil { status.stringValue = "请先选择一个项目，再导出。" }
            return
        }
        let name = projects.first { $0.id == project.id }?.name ?? project.name
        transfer.beginExport(project: WorkspaceProject(id: project.id, name: name), window: window)
    }

    /// An imported chapter joins the chapter list before its page opens.
    private func adoptImported(_ entity: WorkspaceImportedEntity, project: WorkspaceProject) {
        graphChaptersChanged(projectID: project.id)
        guard case .chapter(let chapter) = entity, selectedProject?.id == project.id,
              !chapters.contains(where: { $0.id == chapter.id }) else { return }
        chapters.append(chapter)
        if !showingTrash { reloadChapterRows() }
        chapterEmpty.isHidden = !displayedChapters.isEmpty
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
            // Acts may have changed: the 设定总览's act strip follows.
            self?.overviewChaptersChanged(projectID: project.id)
            // Act boundaries may have moved: the 全书长卷's separators follow.
            let acts = entries.filter { $0.kind == "act" }
            if let book = self?.wholeBookController, book.project.id == project.id, book.model.layout.acts.map(\.id) != acts.map(\.id)
                || book.model.layout.acts.map(\.title) != acts.map(\.title) || book.model.layout.acts.map(\.color) != acts.map(\.color) {
                book.model.load()
            }
            // 幕颜色 also colours 统计 opened from 项目资料.
            if let stats = self?.profileStats?.controller, stats.model.projectID == project.id { stats.model.load() }
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
            guard let self else { return }
            // With the 全书长卷 open, a chapter or heading scrolls it there.
            if let book = self.wholeBookController, self.wholeBookPanel?.isVisible == true, book.project.id == project.id {
                book.scroll(toChapter: entry.id, blockID: blockID)
                self.wholeBookPanel?.orderFront(nil)
                return
            }
            guard self.canLeaveDocument() else { return }
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
                    self.materialsPanel?.title = "\(updated.name) · 素材库"
                    self.graphPanel?.title = "\(updated.name) · 故事图谱"
                    self.wholeBookPanel?.title = "\(updated.name) · 全书长卷"
                    self.overviewPanel?.title = "\(updated.name) · 设定总览"
                    self.reviewPanel?.title = "\(updated.name) · 审阅"
                    self.boardPanel?.title = "\(updated.name) · 备忘与素材"
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
                    self.graphChaptersChanged(projectID: project.id)
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
        } else if let category = chapterWorkspace.activeCategory {
            currentTitle.stringValue = "\(project.name) / 分类 · \(category.name)"
            window.title = "\(category.name) — Drifting Native Lab"
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
                self.graphChaptersChanged(projectID: project.id)
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
                self.graphChaptersChanged(projectID: project.id)
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
                    self.graphChaptersChanged(projectID: project.id)
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

    // MARK: Settings

    @objc private func showSettings() {
        let controller = settingsWindow ?? MacSettingsWindowController(store: settingsStore)
        settingsWindow = controller
        if controller.window?.isVisible != true { controller.window?.center() }
        controller.showWindow(nil)
        controller.window?.makeKeyAndOrderFront(nil)
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
        // The 全书长卷 lets go of its owners before the workspace closes.
        guard closeWholeBook(completion: { [weak self] in self?.closeWorkspaceOwners(completion: completion) }) else {
            closingWorkspace = false; completion(false); return
        }
    }

    private func closeWorkspaceOwners(completion: @escaping (Bool) -> Void) {
        chapterWorkspace.close { [weak self] result in
            guard let self else { return }
            self.closingWorkspace = false
            switch result {
            case .success:
                self.agentController?.stop()
                self.workspaceClosed = true; self.closeOutline(); self.closeSearch(); self.closeComments(); self.closeElements()
                self.closeStorylines(); self.closeDrifts(); self.closeRelationTypes(); self.closeMaterials()
                self.closeStoryGraph()
                self.closeElementOverview()
                self.closeReview(); self.closeBoard()
                self.transfer.endImport()
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
        closeMaterials()
        closeStoryGraph()
        closeElementOverview()
        closeReview()
        closeBoard()
        closeWholeBook()
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if workspaceClosed { return .terminateNow }
        guard !closingWorkspace, canLeaveDocument() else { return .terminateCancel }
        closeWorkspace { success in sender.reply(toApplicationShouldTerminate: success) }
        return .terminateLater
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
