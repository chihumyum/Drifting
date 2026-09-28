import AppKit

/// One file of an import of several files or a folder: parsed into blocks,
/// or skipped before Rust with the reason. After the import it says whether
/// its entity was created.
struct BulkImportItem: Equatable {
    enum Outcome: Equatable {
        /// Not read yet: files are read one after another off the main thread.
        case reading
        case pending
        /// `joinFailure`: why the chapter did not join the chosen 故事线.
        case created(title: String, joinFailure: String? = nil)
        case skipped(reason: String)
    }
    let fileName: String
    var url: URL? = nil
    var document: BookImportDocument?
    var outcome: Outcome

    /// “北塔.md · Markdown · 3 段” before the import; its result after it.
    var line: String {
        switch outcome {
        case .reading: return "\(fileName) · 正在读取…"
        case .pending:
            guard let document else { return fileName }
            return "\(fileName) · \(document.formatName) · \(document.blocks.count) 段"
        case .created(let title, nil): return "\(fileName) · 已创建「\(title)」"
        case .created(let title, let failure?): return "\(fileName) · 已创建「\(title)」，但未能加入故事线：\(failure)"
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

    /// Files larger than this are skipped with a reason, never read.
    static var maximumImportBytes = 200 * 1024 * 1024

    /// The chosen files and folders as items, sorted by name as the Finder
    /// sorts them: a folder gives its supported files (not its subfolders,
    /// hidden or other files, which are counted in `ignored`); a chosen file
    /// of another kind is skipped. Supported files wait to be read
    /// (`read(_:)`, off the main thread).
    static func candidates(_ urls: [URL]) -> (items: [BulkImportItem], ignored: Int) {
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
                return BulkImportItem(fileName: url.lastPathComponent, url: url, document: nil,
                                      outcome: .skipped(reason: "不是 Markdown、纯文本或 Word（.docx）文件"))
            }
            return BulkImportItem(fileName: url.lastPathComponent, url: url, document: nil, outcome: .reading)
        }
        return (items, ignored)
    }

    /// One supported file read and parsed: any thread. A file above
    /// `maximumImportBytes` is skipped unread.
    static func readItem(_ item: BulkImportItem) -> BulkImportItem {
        guard let url = item.url else { return item }
        var next = item
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        if size > maximumImportBytes {
            next.outcome = .skipped(reason: "文件超过 \(maximumImportBytes / 1024 / 1024) MB，未读取")
            return next
        }
        do {
            next.document = try read(url); next.outcome = .pending
        } catch {
            next.outcome = .skipped(reason: error.localizedDescription)
        }
        return next
    }

    /// The sheet for several files or a folder: one target for all of them.
    /// It shows at once; the files are read one after another off the main
    /// thread, and 取消 stops between them.
    func presentBulk(_ urls: [URL], project: WorkspaceProject, window: NSWindow?) {
        let read = Self.candidates(urls)
        guard !read.items.isEmpty else {
            onStatus?(read.ignored > 0 ? "所选文件夹中没有 Markdown、纯文本或 Word（.docx）文件。" : "没有可导入的文件。")
            return
        }
        let sheet = MacBulkImportSheet(items: read.items, ignored: read.ignored)
        bulkSheet = sheet
        importProjectID = project.id
        readFiles(sheet, from: 0)
        workspace.elementLibrary(projectID: project.id) { [weak sheet] result in
            switch result {
            case .success(let library): sheet?.setCategories(library.categories)
            case .failure(let error): sheet?.setCategories([]); sheet?.showError(error.localizedDescription)
            }
        }
        workspace.storylineLibrary(projectID: project.id) { [weak sheet] result in
            sheet?.setStorylines((try? result.get())?.storylines ?? [])
        }
        sheet.onCancel = { [weak self, weak sheet] in
            // While files are imported 取消 stops before the next one;
            // otherwise it closes the sheet (reading stops with it).
            guard let sheet, sheet.importing else { self?.endImport(); return }
            sheet.requestStop()
        }
        sheet.onImport = { [weak self, weak sheet] target, storylineID in
            guard let self, let sheet, !sheet.importing, !sheet.isReading else { return }
            sheet.setImporting(true)
            self.importAll(sheet, from: 0, project: project, target: target, storylineID: storylineID, created: [])
        }
        if let window { window.beginSheet(sheet.window) }
    }

    /// Reads the sheet's files in order on a background queue, one at a
    /// time; each result is shown as it arrives. A closed sheet stops it.
    private func readFiles(_ sheet: MacBulkImportSheet, from index: Int) {
        guard bulkSheet === sheet, !sheet.isClosed else { return }
        guard let next = sheet.items[index...].firstIndex(where: { $0.outcome == .reading }) else {
            sheet.finishReading(); return
        }
        let item = sheet.items[next]
        DispatchQueue.global(qos: .userInitiated).async { [weak self, weak sheet] in
            let read = Self.readItem(item)
            DispatchQueue.main.async {
                guard let self, let sheet, self.bulkSheet === sheet, !sheet.isClosed else { return }
                sheet.setItem(read, at: next)
                self.readFiles(sheet, from: next + 1)
            }
        }
    }

    /// One file after another through the single-file path, each with its
    /// guessed title; a refusal skips that file with Rust's reason. Lists
    /// learn about every new entity; no page opens.
    private func importAll(_ sheet: MacBulkImportSheet, from index: Int, project: WorkspaceProject, target: BookImportTarget,
                           storylineID: String?, created: [WorkspaceImportedEntity]) {
        guard index < sheet.items.count, !sheet.stopRequested else {
            if sheet.stopRequested {
                // 取消 while importing: the files not reached stay unimported.
                for at in index..<sheet.items.count where sheet.items[at].outcome == .pending {
                    sheet.setOutcome(.skipped(reason: "已取消"), at: at)
                }
            }
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
            case .success(let imported):
                sheet.setOutcome(.created(title: imported.entity.title, joinFailure: imported.joinFailure), at: index)
                self.onImported?(project, imported.entity)
                next.append(imported.entity)
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
        let unjoined = sheet.items.filter { if case .created(_, _?) = $0.outcome { return true }; return false }.count
        let summary = "已创建 \(created.count) 个" + (unjoined > 0 ? "（其中 \(unjoined) 个未能加入故事线）" : "")
            + (skipped > 0 ? "，跳过 \(skipped) 个" : "") + "。" + (sheet.stopRequested ? "导入已取消。" : "")
        sheet.finish(summary: summary)
        onStatus?((sheet.stopRequested ? "导入已停止：" : "导入完成：") + summary)
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
    private let ignored: Int
    /// Files are still being read; 导入 waits for them.
    private(set) var isReading = true
    /// Files are being imported: 导入 and the popups stay disabled and
    /// Return cannot start a second import.
    private(set) var importing = false
    /// 取消 during the import: it stops before the next file.
    private(set) var stopRequested = false
    /// The sheet was closed; reading stops.
    private(set) var isClosed = false
    var onImport: ((BookImportTarget, String?) -> Void)?
    var onCancel: (() -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }
    /// Each file's line as the list shows it.
    var lines: [String] { items.map(\.line) }

    init(items: [BulkImportItem], ignored: Int) {
        self.items = items
        self.ignored = ignored
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 440), styleMask: [.titled],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "导入"
        super.init()
        let heading = NSTextField(labelWithString: "导入 \(items.count) 个文件")
        heading.font = .systemFont(ofSize: 15, weight: .semibold)
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
        showSummary()
        targetChanged()
        content.layoutSubtreeIfNeeded()
        window.setContentSize(content.fittingSize)
    }

    private func showSummary() {
        guard !finished else { return }
        let reading = items.filter { $0.outcome == .reading }.count
        if reading > 0 {
            summary.stringValue = "正在读取文件（还剩 \(reading) 个）…按文件名排序；每个文件成为一个新条目，标题取自文件。"
            return
        }
        let importable = items.filter { $0.document != nil }.count
        summary.stringValue = "\(importable) 个可以导入，按文件名排序；每个文件成为一个新条目，标题取自文件。"
            + (items.count > importable ? "\(items.count - importable) 个将跳过。" : "")
            + (ignored > 0 ? "文件夹中另有 \(ignored) 个其他文件或子文件夹未列出。" : "")
    }

    /// A file was read (or skipped).
    func setItem(_ item: BulkImportItem, at index: Int) {
        guard items.indices.contains(index) else { return }
        items[index] = item
        showLines(); showSummary()
    }

    /// Every file was read: 导入 can start.
    func finishReading() {
        isReading = false
        showSummary(); targetChanged()
    }

    /// 取消 while importing: the file being imported finishes, the rest wait.
    func requestStop() {
        guard importing, !stopRequested else { return }
        stopRequested = true
        cancelButton.isEnabled = false
        cancelButton.title = "正在停止…"
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
        // A running import keeps everything disabled, whatever arrives.
        guard !importing else {
            importButton.isEnabled = false
            targetPopup.isEnabled = false; categoryPopup.isEnabled = false; storylinePopup.isEnabled = false
            return
        }
        categoryPopup.isEnabled = element && categories?.isEmpty == false
        if element, categories?.isEmpty == true {
            showError("还没有设定分类。请先在设定库中新建一个分类，例如“人物”。")
        } else { showError(nil) }
        importButton.isEnabled = !isReading && (!element || categories?.isEmpty == false) && items.contains { $0.document != nil }
    }

    func showError(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    /// 取消 stays enabled while importing: it stops before the next file.
    func setImporting(_ importing: Bool) {
        self.importing = importing
        importButton.title = importing ? "正在导入…" : "导入"
        targetChanged()
    }

    func setOutcome(_ outcome: BulkImportItem.Outcome, at index: Int) {
        guard items.indices.contains(index) else { return }
        items[index].outcome = outcome
        showLines()
    }

    /// Every file has its result: the sheet stays with them and 完成 closes it.
    func finish(summary text: String) {
        finished = true
        importing = false
        summary.stringValue = text
        importButton.title = "完成"
        importButton.isEnabled = true
        importButton.action = #selector(cancel)
        cancelButton.isHidden = true
    }

    @objc func confirm() {
        guard !importing, !isReading, !finished else { return }
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

    /// The sheet left the screen: reading stops.
    func close() { isClosed = true }
}
