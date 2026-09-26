import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Native Lab", sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UINavigationController(rootViewController: ProjectViewController())
        self.window = window
        window.makeKeyAndVisible()
    }
}

private func requestName(from controller: UIViewController, project: Bool, currentName: String? = nil,
                         completion: @escaping (String) -> Void) {
    let renaming = currentName != nil
    let kind = project ? "project" : "chapter"
    let title = renaming ? (project ? "重命名项目" : "重命名章节") : (project ? "新建项目" : "新建章节")
    let alert = UIAlertController(title: title,
        message: project ? "给你的写作项目起个名字。" : "输入章节标题。", preferredStyle: .alert)
    alert.addTextField { field in
        field.placeholder = project ? "项目名称" : "章节标题"
        field.text = currentName
        field.accessibilityIdentifier = "\(renaming ? "rename" : "new")-\(kind)-name"
        field.clearButtonMode = .whileEditing
    }
    alert.addAction(UIAlertAction(title: "取消", style: .cancel))
    let create = UIAlertAction(title: renaming ? "保存" : "创建", style: .default) { _ in
        completion((alert.textFields?.first?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
    }
    create.accessibilityIdentifier = "confirm-\(renaming ? "rename" : "create")-\(kind)"
    alert.addAction(create)
    controller.present(alert, animated: true)
}

/// A plain native list is also the cold-launch entry point. Selection is not
/// silently restored: the author chooses which durable chapter to open.
final class ProjectViewController: UITableViewController {
    private let workspace = LabWorkspaceCore()
    private var projects: [WorkspaceProject] = []
    private var loading = false
    private let status = UILabel()
    private let empty = UILabel()

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setToolbarHidden(true, animated: animated)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "项目"
        tableView.accessibilityIdentifier = "project-list"
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "project")
        tableView.rowHeight = 56
        status.numberOfLines = 0
        status.font = .preferredFont(forTextStyle: .footnote)
        status.textColor = .secondaryLabel
        status.accessibilityIdentifier = "workspace-status"
        status.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: 64)
        status.textAlignment = .center
        tableView.tableHeaderView = status
        empty.numberOfLines = 0
        empty.textAlignment = .center
        empty.textColor = .secondaryLabel
        empty.text = "还没有项目\n点击右上角“新建项目”开始。"
        empty.accessibilityIdentifier = "project-empty"
        let create = UIBarButtonItem(title: "新建项目", style: .plain, target: self, action: #selector(createProject))
        create.accessibilityIdentifier = "create-project"
        navigationItem.rightBarButtonItem = create
        setLoading(true)
        status.text = "正在打开工作区…"
        workspace.projects { [weak self] result in
            guard let self else { return }
            self.setLoading(false)
            switch result {
            case .success(let projects):
                self.projects = projects
                self.status.text = "独立原生工作区 · 选择项目开始写作"
                self.refreshList()
            case .failure(let error): self.status.text = error.localizedDescription
            }
        }
    }

    private func setLoading(_ value: Bool) {
        loading = value
        navigationItem.rightBarButtonItem?.isEnabled = !value
        tableView.isUserInteractionEnabled = !value
    }
    private func refreshList() {
        tableView.backgroundView = projects.isEmpty ? empty : nil
        tableView.reloadData()
    }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { projects.count }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "project", for: indexPath)
        var content = cell.defaultContentConfiguration()
        content.text = projects[indexPath.row].name
        cell.contentConfiguration = content
        cell.accessoryType = .disclosureIndicator
        cell.accessibilityLabel = projects[indexPath.row].name
        return cell
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard !loading else { return }
        showProject(projects[indexPath.row])
    }
    private func showProject(_ project: WorkspaceProject) {
        let chapters = ChaptersViewController(workspace: workspace, project: project)
        chapters.onProjectRenamed = { [weak self] updated in
            guard let self else { return }
            if let index = self.projects.firstIndex(where: { $0.id == updated.id }) { self.projects[index] = updated }
            self.refreshList()
        }
        navigationController?.pushViewController(chapters, animated: true)
    }
    @objc private func createProject() {
        guard !loading else { return }
        requestName(from: self, project: true) { [weak self] name in
            guard let self else { return }
            guard !name.isEmpty else { self.status.text = "名称不能为空，请重新创建。"; return }
            self.setLoading(true)
            self.workspace.createProject(name: name) { [weak self] result in
                guard let self else { return }
                self.setLoading(false)
                switch result {
                case .success(let project):
                    self.projects.append(project)
                    self.refreshList()
                    self.status.text = "项目已创建"
                    self.showProject(project)
                case .failure(let error): self.status.text = error.localizedDescription
                }
            }
        }
    }
}

final class ChaptersViewController: UITableViewController {
    private let workspace: LabWorkspaceCore
    private var project: WorkspaceProject
    var onProjectRenamed: ((WorkspaceProject) -> Void)?
    private var chapters: [WorkspaceChapter] = []
    private var loading = false
    private let status = UILabel()
    private let empty = UILabel()

    init(workspace: LabWorkspaceCore, project: WorkspaceProject) {
        self.workspace = workspace
        self.project = project
        super.init(style: .plain)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setToolbarHidden(false, animated: animated)
    }
    override func viewDidLoad() {
        super.viewDidLoad()
        title = project.name
        tableView.accessibilityIdentifier = "chapter-list"
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "chapter")
        tableView.rowHeight = 56
        status.numberOfLines = 0
        status.font = .preferredFont(forTextStyle: .footnote)
        status.textColor = .secondaryLabel
        status.accessibilityIdentifier = "workspace-status"
        status.textAlignment = .center
        status.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: 64)
        tableView.tableHeaderView = status
        empty.numberOfLines = 0
        empty.textAlignment = .center
        empty.textColor = .secondaryLabel
        empty.text = "还没有章节\n点击右上角“新建章节”开始写作。"
        empty.accessibilityIdentifier = "chapter-empty"
        let create = UIBarButtonItem(title: "新建章节", style: .plain, target: self, action: #selector(createChapter))
        create.accessibilityIdentifier = "create-chapter"
        let rename = UIBarButtonItem(title: "重命名", style: .plain, target: self, action: #selector(renameProject))
        rename.accessibilityIdentifier = "rename-project"
        navigationItem.rightBarButtonItems = [create, rename]
        let back = UIBarButtonItem(title: "项目", style: .plain, target: self, action: #selector(backToProjects))
        back.accessibilityIdentifier = "back-to-projects"
        navigationItem.leftBarButtonItem = back
        let outline = UIBarButtonItem(title: "整书大纲", style: .plain, target: self, action: #selector(showOutline))
        outline.accessibilityIdentifier = "show-outline"
        toolbarItems = [UIBarButtonItem(systemItem: .flexibleSpace), outline, UIBarButtonItem(systemItem: .flexibleSpace)]
        setLoading(true)
        status.text = "正在读取章节…"
        workspace.chapters(projectID: project.id) { [weak self] result in
            guard let self else { return }
            self.setLoading(false)
            switch result {
            case .success(let chapters):
                self.chapters = chapters
                self.status.text = "选择章节，正文自动保存。"
                self.refreshList()
            case .failure(let error): self.status.text = error.localizedDescription
            }
        }
    }
    private func setLoading(_ value: Bool) {
        loading = value
        navigationItem.rightBarButtonItems?.forEach { $0.isEnabled = !value }
        navigationItem.leftBarButtonItem?.isEnabled = !value
        tableView.isUserInteractionEnabled = !value
        toolbarItems?.forEach { $0.isEnabled = !value }
    }
    private func refreshList() {
        tableView.backgroundView = chapters.isEmpty ? empty : nil
        tableView.reloadData()
    }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { chapters.count }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "chapter", for: indexPath)
        var content = cell.defaultContentConfiguration()
        content.text = chapters[indexPath.row].title
        cell.contentConfiguration = content
        cell.accessoryType = .disclosureIndicator
        cell.accessibilityLabel = chapters[indexPath.row].title
        return cell
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard !loading else { return }
        openChapter(chapters[indexPath.row])
    }
    private func openChapter(_ chapter: WorkspaceChapter, revealBlockID: String? = nil) {
        setLoading(true)
        workspace.openChapter(projectID: project.id, chapterID: chapter.id) { [weak self] result in
            guard let self else { return }
            self.setLoading(false)
            switch result {
            case .success(let core):
                let editor = ChapterEditorViewController(workspace: self.workspace, core: core,
                    project: self.project, chapter: chapter, chapters: self.chapters, revealBlockID: revealBlockID)
                editor.onChapterRenamed = { [weak self] updated in
                    guard let self else { return }
                    if let index = self.chapters.firstIndex(where: { $0.id == updated.id }) { self.chapters[index] = updated }
                    self.refreshList()
                }
                editor.onChapterOrderChanged = { [weak self] chapters in
                    guard let self else { return }
                    self.chapters = chapters
                    self.refreshList()
                }
                self.navigationController?.pushViewController(editor, animated: true)
            case .failure(let error): self.status.text = error.localizedDescription
            }
        }
    }
    @objc private func showOutline() {
        guard !loading else { return }
        let model = WorkspaceOutlineModel(workspace: workspace, projectID: project.id)
        let controller = BookOutlineViewController(model: model)
        controller.canNavigate = { [weak self] in self?.loading == false }
        controller.onNavigate = { [weak self, weak controller] entry, blockID in
            guard let self, !self.loading else { return }
            controller?.dismiss(animated: true) {
                self.openChapter(WorkspaceChapter(id: entry.id, title: entry.title), revealBlockID: blockID)
            }
        }
        present(UINavigationController(rootViewController: controller), animated: true)
        model.load()
    }
    @objc private func createChapter() {
        guard !loading else { return }
        requestName(from: self, project: false) { [weak self] title in
            guard let self else { return }
            guard !title.isEmpty else { self.status.text = "标题不能为空，请重新创建。"; return }
            self.setLoading(true)
            self.workspace.createChapter(projectID: self.project.id, title: title) { [weak self] result in
                guard let self else { return }
                self.setLoading(false)
                switch result {
                case .success(let chapter):
                    self.chapters.append(chapter)
                    self.refreshList()
                    self.openChapter(chapter)
                case .failure(let error): self.status.text = error.localizedDescription
                }
            }
        }
    }
    @objc private func renameProject() {
        guard !loading else { return }
        requestName(from: self, project: true, currentName: project.name) { [weak self] name in
            guard let self, !self.loading else { return }
            guard !name.isEmpty else { self.status.text = "名称不能为空，请重新输入。"; return }
            self.setLoading(true)
            self.workspace.renameProject(projectID: self.project.id, name: name) { [weak self] result in
                guard let self else { return }
                self.setLoading(false)
                switch result {
                case .success(let project):
                    self.project = project
                    self.title = project.name
                    self.onProjectRenamed?(project)
                    self.status.text = "项目名称已保存"
                case .failure(let error): self.status.text = error.localizedDescription
                }
            }
        }
    }
    @objc private func backToProjects() {
        guard !loading else { return }
        navigationController?.popViewController(animated: true)
    }
}

final class ChapterEditorViewController: UIViewController {
    private let workspace: LabWorkspaceCore
    private var core: LabCore
    private let project: WorkspaceProject
    private var chapter: WorkspaceChapter
    private var chapters: [WorkspaceChapter]
    var onChapterRenamed: ((WorkspaceChapter) -> Void)?
    var onChapterOrderChanged: (([WorkspaceChapter]) -> Void)?
    private var documentView: NativeDocumentView!
    private let editorHost = UIView()
    private let status = UILabel()
    private let heading = UILabel()
    private let saveButton = UIButton(type: .system)
    private let reopenButton = UIButton(type: .system)
    private let outlineButton = UIButton(type: .system)
    private weak var outlineController: BookOutlineViewController?
    private var pendingReveal: String?
    private var orderButton: UIBarButtonItem!
    private var loading = false

    init(workspace: LabWorkspaceCore, core: LabCore, project: WorkspaceProject,
         chapter: WorkspaceChapter, chapters: [WorkspaceChapter], revealBlockID: String? = nil) {
        self.workspace = workspace
        self.core = core
        self.project = project
        self.chapter = chapter
        self.chapters = chapters
        pendingReveal = revealBlockID
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func viewDidLoad() {
        super.viewDidLoad()
        title = project.name
        view.backgroundColor = .systemBackground
        let back = UIBarButtonItem(title: "章节", style: .plain, target: self, action: #selector(backToChapters))
        back.accessibilityIdentifier = "back-to-chapters"
        navigationItem.leftBarButtonItem = back
        let rename = UIBarButtonItem(title: "重命名", style: .plain, target: self, action: #selector(renameChapter))
        rename.accessibilityIdentifier = "rename-chapter"
        orderButton = UIBarButtonItem(title: "排序", image: nil, primaryAction: nil, menu: UIMenu(children: []))
        orderButton.accessibilityIdentifier = "chapter-order"
        navigationItem.rightBarButtonItems = [rename, orderButton]
        updateOrderMenu()
        heading.text = chapter.title
        heading.font = .preferredFont(forTextStyle: .title2)
        heading.adjustsFontForContentSizeCategory = true
        heading.numberOfLines = 2
        heading.accessibilityIdentifier = "current-chapter"
        saveButton.setTitle("保存", for: .normal)
        saveButton.accessibilityIdentifier = "save-document"
        saveButton.addTarget(self, action: #selector(saveDocument), for: .touchUpInside)
        reopenButton.setTitle("重新打开", for: .normal)
        reopenButton.accessibilityIdentifier = "reopen-document"
        reopenButton.addTarget(self, action: #selector(reopenDocument), for: .touchUpInside)
        outlineButton.setTitle("整书大纲", for: .normal)
        outlineButton.accessibilityIdentifier = "show-outline"
        outlineButton.addTarget(self, action: #selector(showOutline), for: .touchUpInside)
        let actions = UIStackView(arrangedSubviews: [saveButton, reopenButton, outlineButton])
        actions.distribution = .fillEqually
        status.text = "正文自动保存"
        status.numberOfLines = 0
        status.font = .preferredFont(forTextStyle: .footnote)
        status.textColor = .secondaryLabel
        status.accessibilityIdentifier = "workspace-status"
        let stack = UIStackView(arrangedSubviews: [heading, actions, editorHost, status])
        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -8),
            actions.heightAnchor.constraint(equalToConstant: 44),
        ])
        mountDocument(core)
    }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Interactive pop bypasses the draft guard; chapter navigation uses the
        // explicit button until a cancellable interactive transition is owned.
        navigationController?.interactivePopGestureRecognizer?.isEnabled = false
        navigationController?.setToolbarHidden(true, animated: animated)
    }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        navigationController?.interactivePopGestureRecognizer?.isEnabled = true
    }

    private func mountDocument(_ core: LabCore) {
        documentView?.onActivity = nil
        documentView?.binding.detach()
        documentView?.removeFromSuperview()
        self.core = core
        let document = NativeDocumentView(core: core)
        documentView = document
        document.isUserInteractionEnabled = !loading
        document.translatesAutoresizingMaskIntoConstraints = false
        editorHost.addSubview(document)
        NSLayoutConstraint.activate([
            document.leadingAnchor.constraint(equalTo: editorHost.leadingAnchor),
            document.trailingAnchor.constraint(equalTo: editorHost.trailingAnchor),
            document.topAnchor.constraint(equalTo: editorHost.topAnchor),
            document.bottomAnchor.constraint(equalTo: editorHost.bottomAnchor),
        ])
        document.onActivity = { [weak self] busy in self?.documentActivity(busy) }
        document.binding.load()
    }
    private func updateControls() {
        let ready = !loading && documentView?.binding.hasPendingWork != true
        saveButton.isEnabled = ready
        reopenButton.isEnabled = ready
        outlineButton.isEnabled = ready
        navigationItem.leftBarButtonItem?.isEnabled = ready
        navigationItem.rightBarButtonItems?.forEach { $0.isEnabled = ready }
        orderButton.isEnabled = ready && chapters.count > 1
    }
    private func canLeaveDocument() -> Bool {
        guard !loading else { return false }
        guard documentView?.binding.hasPendingWork != true else {
            status.text = "请先完成输入，并等待正文保存。保存失败时可在编辑器中重试。"
            return false
        }
        return true
    }
    private func setLoading(_ value: Bool) {
        loading = value
        documentView?.isUserInteractionEnabled = !value
        updateControls()
    }
    private func documentActivity(_ busy: Bool) {
        updateControls()
        guard !busy, let documentView, documentView.binding.canEdit,
              let projection = documentView.binding.store.projection else { return }
        outlineController?.model.updateActive(chapterID: chapter.id, outline: projection.outline)
        if let blockID = pendingReveal {
            pendingReveal = nil
            if !documentView.reveal(blockId: blockID) { status.text = "标题已变化，请重新选择大纲位置。" }
        }
    }

    @objc private func showOutline() {
        guard canLeaveDocument() else { return }
        view.endEditing(true)
        guard canLeaveDocument() else { return }
        let model = WorkspaceOutlineModel(workspace: workspace, projectID: project.id)
        if let projection = documentView.binding.store.projection {
            model.updateActive(chapterID: chapter.id, outline: projection.outline)
        }
        let controller = BookOutlineViewController(model: model)
        outlineController = controller
        controller.canNavigate = { [weak self] in self?.canLeaveDocument() == true }
        controller.onNavigate = { [weak self, weak controller] entry, blockID in
            guard let self, self.canLeaveDocument() else { return }
            if entry.id == self.chapter.id {
                controller?.dismiss(animated: true) {
                    if let blockID, !self.documentView.reveal(blockId: blockID) {
                        self.status.text = "标题已变化，请重新选择大纲位置。"
                    }
                    self.outlineController = nil
                }
                return
            }
            self.setLoading(true)
            self.workspace.openChapter(projectID: self.project.id, chapterID: entry.id) { [weak self, weak controller] result in
                guard let self else { return }
                switch result {
                case .success(let core):
                    // The bridge has replaced the handle. Mount immediately;
                    // dismissal animation must never re-enable the old owner.
                    self.outlineController = nil
                    self.chapter = WorkspaceChapter(id: entry.id, title: entry.title)
                    self.heading.text = entry.title
                    self.pendingReveal = blockID
                    self.mountDocument(core)
                    self.updateOrderMenu()
                    self.setLoading(false)
                    self.status.text = "正文自动保存"
                    controller?.dismiss(animated: true)
                case .failure(let error):
                    self.setLoading(false)
                    model.showStatus(error.localizedDescription)
                }
            }
        }
        present(UINavigationController(rootViewController: controller), animated: true)
        model.load()
    }
    @objc private func saveDocument() {
        guard canLeaveDocument() else { return }
        view.endEditing(true)
        guard canLeaveDocument() else { return }
        documentView.binding.retrySave()
    }
    @objc private func renameChapter() {
        guard canLeaveDocument() else { return }
        requestName(from: self, project: false, currentName: chapter.title) { [weak self] title in
            guard let self, self.canLeaveDocument() else { return }
            guard !title.isEmpty else { self.status.text = "标题不能为空，请重新输入。"; return }
            self.setLoading(true)
            self.workspace.renameChapter(projectID: self.project.id, chapterID: self.chapter.id, title: title) { [weak self] result in
                guard let self else { return }
                self.setLoading(false)
                switch result {
                case .success(let chapter):
                    self.chapter = chapter
                    if let index = self.chapters.firstIndex(where: { $0.id == chapter.id }) { self.chapters[index] = chapter }
                    self.heading.text = chapter.title
                    self.onChapterRenamed?(chapter)
                    self.status.text = "章节标题已保存"
                case .failure(let error): self.status.text = error.localizedDescription
                }
            }
        }
    }
    private func updateOrderMenu() {
        let index = chapters.firstIndex(where: { $0.id == chapter.id })
        let up = UIAction(title: "上移", image: UIImage(systemName: "arrow.up")) { [weak self] _ in
            self?.moveChapter(up: true)
        }
        let down = UIAction(title: "下移", image: UIImage(systemName: "arrow.down")) { [weak self] _ in
            self?.moveChapter(up: false)
        }
        up.accessibilityIdentifier = "move-chapter-up"
        down.accessibilityIdentifier = "move-chapter-down"
        if index == nil || index == 0 { up.attributes = .disabled }
        if index == nil || index == chapters.count - 1 { down.attributes = .disabled }
        orderButton.menu = UIMenu(children: [up, down])
    }

    private func moveChapter(up: Bool) {
        guard canLeaveDocument(), let index = chapters.firstIndex(where: { $0.id == chapter.id }),
              up ? index > 0 : index + 1 < chapters.count else { return }
        view.endEditing(true)
        guard canLeaveDocument() else { return }
        let before = up ? chapters[index - 1].id : (index + 2 < chapters.count ? chapters[index + 2].id : nil)
        status.text = "正在保存章节顺序…"
        setLoading(true)
        workspace.moveChapter(projectID: project.id, chapterID: chapter.id, beforeChapterID: before) { [weak self] result in
            guard let self else { return }
            self.setLoading(false)
            switch result {
            case .success(let chapters):
                self.chapters = chapters
                self.onChapterOrderChanged?(chapters)
                self.updateOrderMenu()
                self.updateControls()
                self.status.text = "章节顺序已保存"
            case .failure(let error): self.status.text = error.localizedDescription
            }
        }
    }
    @objc private func reopenDocument() {
        guard canLeaveDocument() else { return }
        view.endEditing(true)
        guard canLeaveDocument() else { return }
        setLoading(true)
        workspace.reopenChapter { [weak self] result in
            guard let self else { return }
            self.setLoading(false)
            switch result {
            case .success(let core):
                self.mountDocument(core)
                self.status.text = "已从磁盘重新打开，正文自动保存"
            case .failure(let error): self.status.text = error.localizedDescription
            }
        }
    }
    @objc private func backToChapters() {
        guard canLeaveDocument() else { return }
        view.endEditing(true)
        guard canLeaveDocument(), documentView.binding.detach() else { return }
        documentView.onActivity = nil
        navigationController?.popViewController(animated: true)
    }
}
