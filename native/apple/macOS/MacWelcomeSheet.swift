import AppKit

/// What opens when the workspace opens: the project selected last with its
/// tabs, else 欢迎使用 while the lab has no projects (until 不再显示), else
/// the 项目书架.
enum MacLaunchChoice: Equatable {
    case project(WorkspaceProject)
    case welcome
    case shelf

    /// `last` is the project that opens at launch, if it is still listed.
    static func choose(projects: [WorkspaceProject], last: WorkspaceProject?, store: LabSettingsStore) -> MacLaunchChoice {
        if let last, projects.contains(where: { $0.id == last.id }) { return .project(last) }
        if MacWelcomeSheet.shouldShow(projects: projects, store: store) { return .welcome }
        return .shelf
    }
}

/// 欢迎使用: a first-run sheet on the main window while the lab has no
/// projects. It says what Drifting is and where it keeps the book, and
/// offers 新建项目 and 导入…; 不再显示 is kept in `settings.json`
/// (`welcomeHidden`) at once. Nothing is created until a button is chosen.
final class MacWelcomeSheet: NSObject {
    let store: LabSettingsStore
    let window: NSWindow
    let titleLabel = NSTextField(labelWithString: "欢迎使用 Drifting")
    /// The paragraphs about Drifting, in order.
    let paragraphs: [NSTextField]
    let createButton = NSButton(title: "新建项目", target: nil, action: nil)
    let importButton = NSButton(title: "导入…", target: nil, action: nil)
    let laterButton = NSButton(title: "稍后", target: nil, action: nil)
    let hideCheckbox = NSButton(checkboxWithTitle: "不再显示", target: nil, action: nil)
    /// 新建项目 and 导入… run once the sheet has ended.
    var onCreate: (() -> Void)?
    var onImport: (() -> Void)?
    /// The sheet ended, by any button.
    var onFinish: (() -> Void)?
    private(set) var isFinished = false

    static let text = [
        "Drifting 是写长篇小说的工具：正文按章节写，人物、地点等设定放进设定库，用故事线、漂流和情节规划格安排情节；正文里出现的设定名称和章节标题会自动链接到对应页面。",
        "项目、正文、历史版本和回收站都保存在这台 Mac 上本应用的数据目录里，无需账号，每次输入后立即保存。",
        "写作助手与 Copilot 是实验功能，只使用你自己的模型服务 API Key；Key 保存在系统钥匙串中，请求、费用与留存由你选择的服务商决定。",
        "新建一个项目开始写作，或导入已有的 Markdown、纯文本或 Word 文件，作为新项目的章节、设定或漂流。",
    ]

    /// Shown only while there is no project, until 不再显示.
    static func shouldShow(projects: [WorkspaceProject], store: LabSettingsStore) -> Bool {
        projects.isEmpty && !store.settings.welcomeHidden
    }

    init(store: LabSettingsStore) {
        self.store = store
        paragraphs = Self.text.map { NSTextField(wrappingLabelWithString: $0) }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 360), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "欢迎使用"
        super.init()
        window.setAccessibilityIdentifier("welcome-sheet")
        titleLabel.font = .systemFont(ofSize: 20, weight: .semibold)
        titleLabel.setAccessibilityIdentifier("welcome-title")
        for (index, paragraph) in paragraphs.enumerated() {
            paragraph.font = .systemFont(ofSize: 13)
            paragraph.textColor = index == paragraphs.count - 1 ? .labelColor : .secondaryLabelColor
            paragraph.preferredMaxLayoutWidth = 472
            paragraph.setAccessibilityIdentifier("welcome-text-\(index)")
        }
        createButton.target = self; createButton.action = #selector(create)
        createButton.keyEquivalent = "\r"
        createButton.setAccessibilityIdentifier("welcome-create-project")
        importButton.target = self; importButton.action = #selector(importFiles)
        importButton.setAccessibilityIdentifier("welcome-import")
        importButton.toolTip = "先为导入的文件新建一个项目，再选择 Markdown、纯文本或 Word 文件，或一个文件夹"
        laterButton.target = self; laterButton.action = #selector(later)
        laterButton.keyEquivalent = "\u{1b}"
        laterButton.setAccessibilityIdentifier("welcome-later")
        hideCheckbox.target = self; hideCheckbox.action = #selector(hideChanged)
        hideCheckbox.state = store.settings.welcomeHidden ? .on : .off
        hideCheckbox.setAccessibilityIdentifier("welcome-hide")
        hideCheckbox.toolTip = "以后打开时不再显示欢迎页；没有项目时改为打开项目书架"
        let buttons = NSStackView(views: [hideCheckbox, NSView(), laterButton, importButton, createButton])
        buttons.spacing = 10
        let stack = NSStackView(views: [titleLabel] + paragraphs + [buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.setCustomSpacing(14, after: titleLabel)
        stack.setCustomSpacing(20, after: paragraphs[paragraphs.count - 1])
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 22),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -18),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
            content.widthAnchor.constraint(equalToConstant: 520),
        ])
    }

    /// Presents the sheet on a window; without one it stays ready for
    /// programmatic use (acceptance).
    func begin(in parent: NSWindow?) {
        if let parent { parent.beginSheet(window) }
    }

    /// 不再显示 is saved at once, and unchecking it shows the sheet again.
    @objc func hideChanged() { store.setWelcomeHidden(hideCheckbox.state == .on) }

    @objc func create() { finish(then: onCreate) }
    @objc func importFiles() { finish(then: onImport) }
    @objc func later() { finish(then: nil) }

    /// Ends the sheet, then runs the choice once the parent can show its
    /// own sheet (a name prompt).
    private func finish(then action: (() -> Void)?) {
        guard !isFinished else { return }
        isFinished = true
        if let parent = window.sheetParent { parent.endSheet(window) } else { window.orderOut(nil) }
        onFinish?()
        if let action { DispatchQueue.main.async(execute: action) }
    }
}
