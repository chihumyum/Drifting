import AppKit

/// What deleting a project removes, counted before the author confirms.
struct ProjectDeletionSummary: Equatable {
    var chapters = 0
    var drifts = 0
    var elements = 0
    var categories = 0
    var storylines = 0
    var comments = 0
    var materials = 0

    /// “3 个章节、1 条漂流、2 个设定…”; kinds without content are left out.
    var text: String {
        let parts = [(chapters, "个章节"), (drifts, "条漂流"), (elements, "个设定"), (categories, "个分类"), (storylines, "条故事线"),
                     (comments, "条批注与待办"), (materials, "个素材（连同复制到本地素材库的文件）")]
            .filter { $0.0 > 0 }.map { "\($0.0) \($0.1)" }
        return parts.isEmpty ? "这个项目还没有章节或其他内容" : parts.joined(separator: "、")
    }

    /// Reads the counts one after another; a failed read leaves that count at zero.
    static func load(workspace: LabWorkspaceCore, projectID: String, completion: @escaping (ProjectDeletionSummary) -> Void) {
        var summary = ProjectDeletionSummary()
        workspace.chapters(projectID: projectID) { chapters in
            summary.chapters = (try? chapters.get().count) ?? 0
            workspace.driftLibrary(projectID: projectID) { drifts in
                summary.drifts = (try? drifts.get().drifts.count) ?? 0
                workspace.elementLibrary(projectID: projectID) { elements in
                    summary.elements = (try? elements.get().elements.count) ?? 0
                    summary.categories = (try? elements.get().categories.count) ?? 0
                    workspace.storylineLibrary(projectID: projectID) { storylines in
                        summary.storylines = (try? storylines.get().storylines.count) ?? 0
                        workspace.projectComments(projectID: projectID) { comments in
                            summary.comments = (try? comments.get().count) ?? 0
                            workspace.materialLibrary(projectID: projectID) { materials in
                                summary.materials = (try? materials.get().items.count) ?? 0
                                completion(summary)
                            }
                        }
                    }
                }
            }
        }
    }
}

/// 删除项目: first asks the project's panels whether they can let go (the
/// 全书长卷 cannot while input is in flight or an owner it could not close
/// is still open), then closes every tab of the project (each saves as
/// closing it does), then the panels that show the project, then deletes
/// the project in Rust and moves to another project, or to a new empty one
/// when none remain. A panel or tab that cannot close stops it with the
/// reason and nothing is deleted; a refusal before the panels close leaves
/// every panel and sheet (e.g. a draft being composed) as it was. After
/// Rust deletes the project, its writing-assistant turn stops and its
/// conversations, rules and usage are removed from disk.
final class ProjectDeletionCoordinator {
    struct Outcome {
        let deletion: WorkspaceProjectDeletion
        /// The projects after deletion, including one created to replace the last.
        let projects: [WorkspaceProject]
        /// The project to show next.
        let next: WorkspaceProject?
        /// The deleted project was the last; `next` was created for it.
        let created: Bool
    }

    /// The name of the project created when the last one is deleted.
    static let replacementName = "未命名项目"
    private let workspace: LabWorkspaceCore
    private weak var host: MacChapterWorkspace?
    /// Why a panel of the project cannot let go now; asked before anything
    /// closes. Nil lets deletion go on.
    var panelRefusal: ((String) -> String?)?
    /// Closes the panels showing the project (and only those); reports nil,
    /// or why one could not close.
    var closePanels: ((String, @escaping (String?) -> Void) -> Void)?
    /// Drops what the lab stores per project (settings.json).
    var forgetSettings: ((String) -> Void)?
    /// Stops the writing assistant's running turn in the project, if any.
    var stopAssistant: ((String) -> Void)?
    private(set) var isDeleting = false

    init(workspace: LabWorkspaceCore, host: MacChapterWorkspace) {
        self.workspace = workspace
        self.host = host
    }

    func delete(_ project: WorkspaceProject, completion: @escaping (Result<Outcome, Error>) -> Void) {
        guard !isDeleting, let host else { completion(.failure(LabError.message("正在删除项目，请稍候。"))); return }
        isDeleting = true
        let finish: (Result<Outcome, Error>) -> Void = { [weak self] result in
            self?.isDeleting = false
            completion(result)
        }
        let refuse: (String) -> Void = { reason in finish(.failure(LabError.message("\(reason) 项目未删除。"))) }
        if let reason = panelRefusal?(project.id) { refuse(reason); return }
        host.closeTabs(projectID: project.id) { [weak self] result in
            guard let self else { return }
            if case .failure(let error) = result { refuse(error.localizedDescription); return }
            guard let closePanels = self.closePanels else { self.remove(project, finish: finish); return }
            closePanels(project.id) { [weak self] reason in
                if let reason { refuse(reason) } else { self?.remove(project, finish: finish) }
            }
        }
    }

    private func remove(_ project: WorkspaceProject, finish: @escaping (Result<Outcome, Error>) -> Void) {
        workspace.deleteProject(projectID: project.id) { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error): finish(.failure(error))
            case .success(let reply):
                self.host?.forget(projectID: project.id)
                self.forgetSettings?(project.id)
                self.stopAssistant?(project.id)
                AgentConversationStore.removeProject(root: self.workspace.agentDirectory, projectID: project.id)
                if let next = reply.projects.first {
                    finish(.success(Outcome(deletion: reply.deleted, projects: reply.projects, next: next, created: false)))
                    return
                }
                self.workspace.createProject(name: Self.replacementName) { created in
                    switch created {
                    case .success(let project):
                        finish(.success(Outcome(deletion: reply.deleted, projects: [project], next: project, created: true)))
                    case .failure:
                        // The deletion stands; the author can create a project.
                        finish(.success(Outcome(deletion: reply.deleted, projects: [], next: nil, created: false)))
                    }
                }
            }
        }
    }
}

/// The confirmation: what is removed, and the project's name typed exactly
/// to enable 删除项目. A refusal keeps the sheet open with the reason.
final class ProjectDeletionSheet: NSObject, NSTextFieldDelegate {
    let project: WorkspaceProject
    let window: NSWindow
    let summaryLabel = NSTextField(wrappingLabelWithString: "正在统计项目内容…")
    let nameField = NSTextField(string: "")
    let deleteButton = NSButton(title: "删除项目", target: nil, action: nil)
    let cancelButton = NSButton(title: "取消", target: nil, action: nil)
    private let message = NSTextField(wrappingLabelWithString: "")
    private(set) var isDeleting = false
    /// Deletes; reports nil on success or the refusal.
    var onConfirm: ((@escaping (Error?) -> Void) -> Void)?
    var onFinish: (() -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }
    /// The typed name matches the project's name exactly.
    var nameMatches: Bool { nameField.stringValue == project.name }

    init(project: WorkspaceProject) {
        self.project = project
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "删除项目"
        super.init()
        let heading = NSTextField(wrappingLabelWithString: "删除项目“\(project.name)”？")
        heading.font = .systemFont(ofSize: 15, weight: .semibold)
        summaryLabel.textColor = .labelColor
        summaryLabel.setAccessibilityIdentifier("delete-project-summary")
        let closing = NSTextField(wrappingLabelWithString: "删除前会先保存并关闭这个项目打开的所有标签页和面板，写作助手在这个项目里的对话和作者规则也会一并删除。删除后无法恢复。")
        closing.textColor = .secondaryLabelColor
        closing.font = .systemFont(ofSize: 12)
        let prompt = NSTextField(wrappingLabelWithString: "请输入项目名称“\(project.name)”以确认：")
        prompt.font = .systemFont(ofSize: 12, weight: .medium)
        nameField.placeholderString = project.name
        nameField.delegate = self
        nameField.setAccessibilityIdentifier("delete-project-name")
        nameField.setAccessibilityLabel("项目名称")
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("delete-project-error")
        deleteButton.target = self; deleteButton.action = #selector(confirm)
        deleteButton.hasDestructiveAction = true
        deleteButton.isEnabled = false
        deleteButton.setAccessibilityIdentifier("confirm-delete-project")
        cancelButton.target = self; cancelButton.action = #selector(cancel)
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.setAccessibilityIdentifier("cancel-delete-project")
        let buttons = NSStackView(views: [NSView(), cancelButton, deleteButton])
        let stack = NSStackView(views: [heading, summaryLabel, closing, prompt, nameField, message, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.setCustomSpacing(16, after: closing)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            content.widthAnchor.constraint(equalToConstant: 440),
            heading.widthAnchor.constraint(equalTo: stack.widthAnchor),
            summaryLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
            closing.widthAnchor.constraint(equalTo: stack.widthAnchor),
            prompt.widthAnchor.constraint(equalTo: stack.widthAnchor),
            nameField.widthAnchor.constraint(equalTo: stack.widthAnchor),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        fit()
    }

    func show(_ summary: ProjectDeletionSummary) {
        summaryLabel.stringValue = "将永久删除：\(summary.text)，以及它们的关系、关联、回收站中的内容、历史版本和写作计划。"
        fit()
    }

    private func fit() {
        guard let content = window.contentView else { return }
        content.layoutSubtreeIfNeeded()
        window.setContentSize(content.fittingSize)
    }

    /// Types the name as the author would, e.g. for acceptance.
    func type(_ name: String) {
        nameField.stringValue = name
        controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: nameField))
    }

    func controlTextDidChange(_ obj: Notification) {
        deleteButton.isEnabled = nameMatches && !isDeleting
        if !isDeleting { show(nil) }
    }

    @objc func confirm() {
        guard !isDeleting else { return }
        guard nameMatches else { show("输入的名称与项目名称不一致，项目未删除。"); return }
        guard let onConfirm else { return }
        isDeleting = true; setEnabled(false); show(nil)
        onConfirm { [weak self] error in
            guard let self else { return }
            self.isDeleting = false; self.setEnabled(true)
            if let error { self.show(error.localizedDescription) } else { self.finish() }
        }
    }

    @objc func cancel() {
        guard !isDeleting else { return }
        finish()
    }

    private func setEnabled(_ enabled: Bool) {
        cancelButton.isEnabled = enabled
        nameField.isEditable = enabled
        deleteButton.isEnabled = enabled && nameMatches
    }

    private func show(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
        fit()
    }

    private func finish() {
        if let parent = window.sheetParent { parent.endSheet(window) }
        window.orderOut(nil)
        onFinish?()
    }
}
