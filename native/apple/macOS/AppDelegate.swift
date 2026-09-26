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

/// One workspace window owns the current chapter. Multi-window editing stays
/// out of this flow until each window has an explicit chapter scope.
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate {
    private var window: NSWindow!
    private let workspace = LabWorkspaceCore()
    private var projects: [WorkspaceProject] = []
    private var chapters: [WorkspaceChapter] = []
    private var selectedProject: WorkspaceProject?
    private var currentChapter: WorkspaceChapter?
    private var currentProject: WorkspaceProject?
    private var documentCore: LabCore?
    private var documentView: NativeDocumentView?
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
    private var saveButton: NSButton!
    private var reopenButton: NSButton!

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
        NSApp.mainMenu = menu
    }

    private func buildWorkspace() {
        createProjectButton = button("新建项目", id: "create-project", action: #selector(createProject))
        createChapterButton = button("新建章节", id: "create-chapter", action: #selector(createChapter))
        let projectScroll = table(projectTable, id: "project-list")
        let chapterScroll = table(chapterTable, id: "chapter-list")
        let sidebar = NSStackView(views: [heading("项目"), createProjectButton, projectScroll, projectEmpty,
            heading("章节"), createChapterButton, chapterScroll, chapterEmpty])
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
        let actions = NSStackView(views: [saveButton, reopenButton])
        actions.spacing = 10
        let subtitle = NSTextField(wrappingLabelWithString: "独立原生工作区 · 正文自动保存")
        subtitle.textColor = .secondaryLabelColor
        status.textColor = .secondaryLabelColor
        status.setAccessibilityIdentifier("workspace-status")
        emptyEditor.textColor = .secondaryLabelColor
        emptyEditor.alignment = .center
        emptyEditor.translatesAutoresizingMaskIntoConstraints = false
        editorHost.addSubview(emptyEditor)
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
        tableView === projectTable ? projects.count : chapters.count
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let title = tableView === projectTable ? projects[row].name : chapters[row].title
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
        } else if table === chapterTable, chapters.indices.contains(table.selectedRow), let selectedProject {
            openChapter(chapters[table.selectedRow], project: selectedProject)
        }
    }

    private func setLoading(_ value: Bool) {
        loading = value
        if value { window.makeFirstResponder(nil) }
        if let documentView {
            setControls(documentView, enabled: !value)
            if !value { documentView.binding.store.activity() }
        }
        documentView?.textView.isEditable = !value && documentView?.binding.canEdit == true
        updateControls()
    }

    private func setControls(_ view: NSView, enabled: Bool) {
        (view as? NSControl)?.isEnabled = enabled
        for child in view.subviews { setControls(child, enabled: enabled) }
    }

    private func updateControls() {
        let ready = !loading && documentView?.binding.hasPendingWork != true
        createProjectButton.isEnabled = ready
        createChapterButton.isEnabled = ready && selectedProject != nil
        saveButton.isEnabled = ready && documentView != nil
        reopenButton.isEnabled = ready && documentView != nil
    }

    private func canLeaveDocument() -> Bool {
        guard !loading else { return false }
        guard documentView?.binding.hasPendingWork != true, documentView?.textView.hasMarkedText() != true else {
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
        setLoading(true)
        workspace.chapters(projectID: project.id) { [weak self] result in
            guard let self else { return }
            self.setLoading(false)
            switch result {
            case .success(let chapters):
                self.selectedProject = project
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

    private func openChapter(_ chapter: WorkspaceChapter, project: WorkspaceProject) {
        guard canLeaveDocument() else { return }
        setLoading(true)
        workspace.openChapter(projectID: project.id, chapterID: chapter.id) { [weak self] result in
            self?.receiveDocument(result, chapter: chapter, project: project, message: "正文自动保存")
        }
    }

    private func receiveDocument(_ result: Result<LabCore, Error>, chapter: WorkspaceChapter,
                                 project: WorkspaceProject, message: String) {
        switch result {
        case .success(let core):
            // The bridge has atomically selected the new owner. Detach the old
            // view before mounting a fresh store; never load into the old view.
            documentView?.onActivity = nil
            documentView?.binding.detach()
            documentView?.removeFromSuperview()
            documentCore = core
            let view = NativeDocumentView(core: core)
            documentView = view
            currentChapter = chapter
            currentProject = project
            currentTitle.stringValue = "\(project.name) / \(chapter.title)"
            window.title = "\(chapter.title) — Drifting Native Lab"
            emptyEditor.isHidden = true
            view.translatesAutoresizingMaskIntoConstraints = false
            editorHost.addSubview(view)
            NSLayoutConstraint.activate([
                view.leadingAnchor.constraint(equalTo: editorHost.leadingAnchor),
                view.trailingAnchor.constraint(equalTo: editorHost.trailingAnchor),
                view.topAnchor.constraint(equalTo: editorHost.topAnchor),
                view.bottomAnchor.constraint(equalTo: editorHost.bottomAnchor),
            ])
            view.onActivity = { [weak self] _ in self?.updateControls() }
            setLoading(false)
            status.stringValue = message
            view.binding.load()
        case .failure(let error):
            setLoading(false)
            status.stringValue = error.localizedDescription
            updatingSelection = true
            if let currentChapter, let index = chapters.firstIndex(where: { $0.id == currentChapter.id }) {
                chapterTable.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
            } else { chapterTable.deselectAll(nil) }
            updatingSelection = false
        }
    }

    private func askName(project: Bool, completion: @escaping (String) -> Void) {
        guard canLeaveDocument() else { return }
        let alert = NSAlert()
        alert.messageText = project ? "新建项目" : "新建章节"
        alert.informativeText = project ? "给你的写作项目起个名字。" : "输入章节标题。"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 28))
        field.placeholderString = project ? "项目名称" : "章节标题"
        field.setAccessibilityIdentifier(project ? "new-project-name" : "new-chapter-name")
        alert.accessoryView = field
        let confirm = alert.addButton(withTitle: "创建")
        confirm.setAccessibilityIdentifier(project ? "confirm-create-project" : "confirm-create-chapter")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { response in
            guard response == .alertFirstButtonReturn else { return }
            let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { self.status.stringValue = "名称不能为空，请重新创建。"; return }
            completion(name)
        }
        alert.window.makeFirstResponder(field)
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
        guard canLeaveDocument(), let chapter = currentChapter, let project = currentProject else { return }
        setLoading(true)
        workspace.reopenChapter { [weak self] result in
            self?.receiveDocument(result, chapter: chapter, project: project, message: "已从磁盘重新打开，正文自动保存")
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool { canLeaveDocument() }
    func windowWillClose(_ notification: Notification) { documentView?.binding.detach() }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        canLeaveDocument() ? .terminateNow : .terminateCancel
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
