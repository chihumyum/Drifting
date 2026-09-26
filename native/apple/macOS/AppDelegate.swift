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
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate {
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
        let format = NSMenuItem(title: "格式", action: nil, keyEquivalent: ""), formatMenu = NSMenu(title: "格式")
        formatMenu.addItem(withTitle: "加粗", action: #selector(ProseTextView.boldProse(_:)), keyEquivalent: "b")
        formatMenu.addItem(withTitle: "斜体", action: #selector(ProseTextView.italicProse(_:)), keyEquivalent: "i")
        format.submenu = formatMenu
        menu.addItem(format)
        NSApp.mainMenu = menu
    }

    private func buildWorkspace() {
        createProjectButton = button("新建项目", id: "create-project", action: #selector(createProject))
        createChapterButton = button("新建章节", id: "create-chapter", action: #selector(createChapter))
        renameProjectButton = button("重命名", id: "rename-project", action: #selector(renameProject))
        renameChapterButton = button("重命名", id: "rename-chapter", action: #selector(renameChapter))
        moveUpButton = button("上移", id: "move-chapter-up", action: #selector(moveChapterUp))
        moveDownButton = button("下移", id: "move-chapter-down", action: #selector(moveChapterDown))
        let projectActions = NSStackView(views: [createProjectButton, renameProjectButton])
        let chapterActions = NSStackView(views: [createChapterButton, renameChapterButton])
        let orderActions = NSStackView(views: [moveUpButton, moveDownButton])
        trashButton = button("移入回收站", id: "trash-chapter", action: #selector(changeChapterTrash))
        trashListButton = button("回收站", id: "show-trash", action: #selector(toggleTrash))
        let trashActions = NSStackView(views: [trashButton, trashListButton])
        let projectScroll = table(projectTable, id: "project-list")
        let chapterScroll = table(chapterTable, id: "chapter-list")
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
        splitButton = button("在另一栏打开", id: "split-editor", action: #selector(splitEditor))
        closePaneButton = button("关闭分栏", id: "close-editor-pane", action: #selector(closeEditorPane))
        let actions = NSStackView(views: [saveButton, reopenButton, outlineButton, searchButton, splitButton, closePaneButton])
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
        let editor = NSStackView(views: [currentTitle, subtitle, actions, editorHost, status])
        editor.orientation = .vertical
        editor.alignment = .leading
        editor.spacing = 12
        editor.translatesAutoresizingMaskIntoConstraints = false
        let content = window.contentView!
        content.addSubview(sidebar)
        content.addSubview(editor)
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
            editor.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            editor.topAnchor.constraint(equalTo: sidebar.topAnchor),
            editor.bottomAnchor.constraint(equalTo: sidebar.bottomAnchor),
            currentTitle.widthAnchor.constraint(equalTo: editor.widthAnchor),
            editorHost.widthAnchor.constraint(equalTo: editor.widthAnchor),
            editorHost.heightAnchor.constraint(greaterThanOrEqualToConstant: 360),
            status.widthAnchor.constraint(equalTo: editor.widthAnchor),
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
        return label
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
        let minWidth: CGFloat = chapterWorkspace.paneCount == 2 ? 1100 : 820
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
        let controller = BookOutlineViewController(model: model)
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
        guard let project = currentProject, let chapter = currentChapter else { return }
        currentTitle.stringValue = "\(project.name) / \(chapter.title)"
        window.title = "\(chapter.title) — Drifting Native Lab"
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
                self.workspaceClosed = true; self.closeOutline(); self.closeSearch(); completion(true)
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
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if workspaceClosed { return .terminateNow }
        guard !closingWorkspace, canLeaveDocument() else { return .terminateCancel }
        closeWorkspace { success in sender.reply(toApplicationShouldTerminate: success) }
        return .terminateLater
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
