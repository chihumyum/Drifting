import AppKit

/// One file of an import of several files or a folder: parsed into blocks,
/// or skipped before Rust with the reason. After the import it says whether
/// its entity was created.
struct BulkImportItem: Equatable {
    enum Outcome: Equatable {
        case pending
        case created(title: String)
        case skipped(reason: String)
    }
    let fileName: String
    let document: BookImportDocument?
    var outcome: Outcome

    /// “北塔.md · Markdown · 3 段” before the import; its result after it.
    var line: String {
        switch outcome {
        case .pending:
            guard let document else { return fileName }
            return "\(fileName) · \(document.formatName) · \(document.blocks.count) 段"
        case .created(let title): return "\(fileName) · 已创建「\(title)」"
        case .skipped(let reason): return "\(fileName) · 跳过：\(reason)"
        }
    }
}

extension MacBookTransfer {
    /// What 导入… reads: Markdown, text and Word files.
    static let importExtensions: Set<String> = ["md", "markdown", "mdown", "mkd", "txt", "text", "docx"]

    static func isFolder(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
    }

    /// The chosen files and folders as items, sorted by name as the Finder
    /// sorts them: a folder gives its supported files (not its subfolders,
    /// hidden or other files, which are counted in `ignored`); a chosen file
    /// of another kind is skipped. Each supported file is parsed here.
    static func items(_ urls: [URL]) -> (items: [BulkImportItem], ignored: Int) {
        let byName: (URL, URL) -> Bool = { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
        var files: [URL] = []
        var ignored = 0
        for url in urls.sorted(by: byName) {
            if isFolder(url) {
                let children = (try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: [.isDirectoryKey],
                                                                             options: [.skipsHiddenFiles])) ?? []
                let supported = children.filter { !isFolder($0) && importExtensions.contains($0.pathExtension.lowercased()) }
                ignored += children.count - supported.count
                files += supported.sorted(by: byName)
            } else {
                files.append(url)
            }
        }
        let items = files.map { url -> BulkImportItem in
            guard importExtensions.contains(url.pathExtension.lowercased()) else {
                return BulkImportItem(fileName: url.lastPathComponent, document: nil,
                                      outcome: .skipped(reason: "不是 Markdown、纯文本或 Word（.docx）文件"))
            }
            do {
                return BulkImportItem(fileName: url.lastPathComponent, document: try read(url), outcome: .pending)
            } catch {
                return BulkImportItem(fileName: url.lastPathComponent, document: nil, outcome: .skipped(reason: error.localizedDescription))
            }
        }
        return (items, ignored)
    }

    /// The sheet for several files or a folder: one target for all of them.
    func presentBulk(_ read: (items: [BulkImportItem], ignored: Int), project: WorkspaceProject, window: NSWindow?) {
        guard !read.items.isEmpty else {
            onStatus?(read.ignored > 0 ? "所选文件夹中没有 Markdown、纯文本或 Word（.docx）文件。" : "没有可导入的文件。")
            return
        }
        let sheet = MacBulkImportSheet(items: read.items, ignored: read.ignored)
        bulkSheet = sheet
        importProjectID = project.id
        workspace.elementLibrary(projectID: project.id) { [weak sheet] result in
            switch result {
            case .success(let library): sheet?.setCategories(library.categories)
            case .failure(let error): sheet?.setCategories([]); sheet?.showError(error.localizedDescription)
            }
        }
        workspace.storylineLibrary(projectID: project.id) { [weak sheet] result in
            sheet?.setStorylines((try? result.get())?.storylines ?? [])
        }
        sheet.onCancel = { [weak self] in self?.endImport() }
        sheet.onImport = { [weak self, weak sheet] target, storylineID in
            guard let self, let sheet else { return }
            sheet.setImporting(true)
            self.importAll(sheet, from: 0, project: project, target: target, storylineID: storylineID, created: [])
        }
        if let window { window.beginSheet(sheet.window) }
    }

    /// One file after another through the single-file path, each with its
    /// guessed title; a refusal skips that file with Rust's reason. Lists
    /// learn about every new entity; no page opens.
    private func importAll(_ sheet: MacBulkImportSheet, from index: Int, project: WorkspaceProject, target: BookImportTarget,
                           storylineID: String?, created: [WorkspaceImportedEntity]) {
        guard index < sheet.items.count else {
            finishBulk(sheet, project: project, created: created)
            return
        }
        guard let document = sheet.items[index].document, sheet.items[index].outcome == .pending else {
            importAll(sheet, from: index + 1, project: project, target: target, storylineID: storylineID, created: created)
            return
        }
        importOne(project: project, title: document.title, target: target, storylineID: storylineID,
                  blocks: document.blocks) { [weak self, weak sheet] result in
            guard let self, let sheet else { return }
            var next = created
            switch result {
            case .success(let entity):
                sheet.setOutcome(.created(title: entity.title), at: index)
                self.onImported?(project, entity)
                next.append(entity)
            case .failure(let error):
                sheet.setOutcome(.skipped(reason: error.localizedDescription), at: index)
            }
            self.importAll(sheet, from: index + 1, project: project, target: target, storylineID: storylineID, created: next)
        }
    }

    private func finishBulk(_ sheet: MacBulkImportSheet, project: WorkspaceProject, created: [WorkspaceImportedEntity]) {
        if created.contains(where: { if case .chapter = $0 { return true }; return false }) { host.chaptersChanged(projectID: project.id) }
        if created.contains(where: { if case .drift = $0 { return true }; return false }) { host.driftsChanged(projectID: project.id) }
        if created.contains(where: { if case .element = $0 { return true }; return false }) { host.elementsChanged(projectID: project.id) }
        let skipped = sheet.items.filter { if case .skipped = $0.outcome { return true }; return false }.count
        let summary = "已创建 \(created.count) 个" + (skipped > 0 ? "，跳过 \(skipped) 个" : "") + "。"
        sheet.finish(summary: summary)
        onStatus?("导入完成：" + summary)
    }
}

/// 导入 of several files or a folder: every file with its format and block
/// count (or why it is skipped), one target for all of them — 章节 with an
/// optional 故事线, 设定 with its 分类, or 漂流 — then each file's result.
final class MacBulkImportSheet: NSObject {
    let window: NSWindow
    let targetPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let categoryPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let categoryLabel = NSTextField(labelWithString: "分类")
    let storylinePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let storylineLabel = NSTextField(labelWithString: "故事线")
    let list = NSTextView()
    let summary = NSTextField(wrappingLabelWithString: "")
    let importButton = NSButton(title: "导入", target: nil, action: nil)
    let cancelButton = NSButton(title: "取消", target: nil, action: nil)
    private let message = NSTextField(wrappingLabelWithString: "")
    private(set) var items: [BulkImportItem]
    private var categories: [WorkspaceElementCategory]?
    private(set) var finished = false
    var onImport: ((BookImportTarget, String?) -> Void)?
    var onCancel: (() -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }
    /// Each file's line as the list shows it.
    var lines: [String] { items.map(\.line) }

    init(items: [BulkImportItem], ignored: Int) {
        self.items = items
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 440), styleMask: [.titled],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "导入"
        super.init()
        let importable = items.filter { $0.document != nil }.count
        let heading = NSTextField(labelWithString: "导入 \(items.count) 个文件")
        heading.font = .systemFont(ofSize: 15, weight: .semibold)
        summary.stringValue = "\(importable) 个可以导入，按文件名排序；每个文件成为一个新条目，标题取自文件。"
            + (items.count > importable ? "\(items.count - importable) 个将跳过。" : "")
            + (ignored > 0 ? "文件夹中另有 \(ignored) 个其他文件或子文件夹未列出。" : "")
        summary.textColor = .secondaryLabelColor
        summary.setAccessibilityIdentifier("bulk-import-summary")
        for target in MacImportSheet.targets {
            targetPopup.addItem(withTitle: target.title)
            targetPopup.lastItem?.representedObject = target.kind
            targetPopup.lastItem?.setAccessibilityIdentifier("bulk-import-target-\(target.kind)")
        }
        targetPopup.target = self; targetPopup.action = #selector(targetChanged)
        targetPopup.setAccessibilityIdentifier("bulk-import-target")
        categoryPopup.addItem(withTitle: "正在读取分类…")
        categoryPopup.isEnabled = false
        categoryPopup.setAccessibilityIdentifier("bulk-import-category")
        storylinePopup.setAccessibilityIdentifier("bulk-import-storyline")
        MacImportSheet.fill(storylinePopup, with: [])
        for label in [categoryLabel, storylineLabel] { label.textColor = .secondaryLabelColor }
        list.isEditable = false; list.isSelectable = true
        list.font = .systemFont(ofSize: 12)
        list.textContainerInset = NSSize(width: 6, height: 6)
        list.isVerticallyResizable = true
        list.autoresizingMask = [.width]
        list.textContainer?.widthTracksTextView = true
        list.setAccessibilityIdentifier("bulk-import-files")
        let listScroll = NSScrollView()
        listScroll.hasVerticalScroller = true
        listScroll.borderType = .bezelBorder
        listScroll.documentView = list
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("bulk-import-error")
        importButton.target = self; importButton.action = #selector(confirm)
        importButton.keyEquivalent = "\r"
        importButton.setAccessibilityIdentifier("confirm-bulk-import")
        cancelButton.target = self; cancelButton.action = #selector(cancel)
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.setAccessibilityIdentifier("cancel-bulk-import")
        let targetRow = NSStackView(views: [NSTextField(labelWithString: "导入为"), targetPopup, categoryLabel, categoryPopup,
                                            storylineLabel, storylinePopup])
        targetRow.spacing = 8
        let buttons = NSStackView(views: [NSView(), cancelButton, importButton])
        let stack = NSStackView(views: [heading, summary, listScroll, targetRow, message, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.setCustomSpacing(4, after: heading)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
            content.widthAnchor.constraint(equalToConstant: 520),
            summary.widthAnchor.constraint(equalTo: stack.widthAnchor),
            listScroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            listScroll.heightAnchor.constraint(equalToConstant: 200),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        showLines()
        targetChanged()
        content.layoutSubtreeIfNeeded()
        window.setContentSize(content.fittingSize)
    }

    private func showLines() {
        let text = NSMutableAttributedString()
        for (index, item) in items.enumerated() {
            var color = NSColor.labelColor
            if case .skipped = item.outcome { color = .secondaryLabelColor }
            text.append(NSAttributedString(string: (index > 0 ? "\n" : "") + item.line,
                                           attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: color]))
        }
        list.textStorage?.setAttributedString(text)
    }

    var selectedKind: String { targetPopup.selectedItem?.representedObject as? String ?? "chapter" }

    func select(kind: String) {
        if let index = targetPopup.itemArray.firstIndex(where: { $0.representedObject as? String == kind }) {
            targetPopup.selectItem(at: index)
        }
        targetChanged()
    }

    func select(categoryID: String) {
        if let index = categoryPopup.itemArray.firstIndex(where: { $0.representedObject as? String == categoryID }) {
            categoryPopup.selectItem(at: index)
        }
    }

    func select(storylineID: String?) {
        let index = storylinePopup.itemArray.firstIndex { $0.representedObject as? String == storylineID } ?? 0
        storylinePopup.selectItem(at: index)
    }

    func setStorylines(_ storylines: [WorkspaceStoryline]) {
        MacImportSheet.fill(storylinePopup, with: storylines)
        targetChanged()
    }

    func setCategories(_ categories: [WorkspaceElementCategory]) {
        self.categories = categories
        categoryPopup.removeAllItems()
        if categories.isEmpty { categoryPopup.addItem(withTitle: "还没有分类") }
        for category in categories {
            categoryPopup.addItem(withTitle: category.name)
            categoryPopup.lastItem?.representedObject = category.id
            categoryPopup.lastItem?.image = ElementSwatch.image(for: category)
            categoryPopup.lastItem?.setAccessibilityIdentifier("bulk-import-category-\(category.id)")
        }
        targetChanged()
    }

    @objc private func targetChanged() {
        guard !finished else { return }
        let element = selectedKind == "element", chapter = selectedKind == "chapter"
        categoryLabel.isHidden = !element; categoryPopup.isHidden = !element
        storylineLabel.isHidden = !chapter; storylinePopup.isHidden = !chapter
        categoryPopup.isEnabled = element && categories?.isEmpty == false
        if element, categories?.isEmpty == true {
            showError("还没有设定分类。请先在设定库中新建一个分类，例如“人物”。")
        } else { showError(nil) }
        importButton.isEnabled = (!element || categories?.isEmpty == false) && items.contains { $0.document != nil }
    }

    func showError(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    func setImporting(_ importing: Bool) {
        importButton.isEnabled = !importing
        cancelButton.isEnabled = !importing
        targetPopup.isEnabled = !importing; categoryPopup.isEnabled = !importing; storylinePopup.isEnabled = !importing
        importButton.title = importing ? "正在导入…" : "导入"
    }

    func setOutcome(_ outcome: BulkImportItem.Outcome, at index: Int) {
        guard items.indices.contains(index) else { return }
        items[index].outcome = outcome
        showLines()
    }

    /// Every file has its result: the sheet stays with them and 完成 closes it.
    func finish(summary text: String) {
        finished = true
        summary.stringValue = text
        importButton.title = "完成"
        importButton.isEnabled = true
        importButton.action = #selector(cancel)
        cancelButton.isHidden = true
    }

    @objc func confirm() {
        let target: BookImportTarget
        switch selectedKind {
        case "element":
            guard let categoryID = categoryPopup.selectedItem?.representedObject as? String else {
                showError("请选择设定的分类。"); return
            }
            target = .element(categoryID: categoryID)
        case "drift": target = .drift
        default: target = .chapter
        }
        showError(nil)
        onImport?(target, selectedKind == "chapter" ? storylinePopup.selectedItem?.representedObject as? String : nil)
    }
    @objc func cancel() { onCancel?() }
}
