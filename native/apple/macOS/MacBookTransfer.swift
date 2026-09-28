import AppKit
import UniformTypeIdentifiers

/// Word documents through AppKit's Office Open XML reader. Each paragraph
/// becomes a block keeping its bold and italic runs; only a short paragraph
/// set clearly larger than the body text becomes a heading.
enum MacDocxImport {
    static func read(_ url: URL) throws -> BookImportDocument {
        let text: NSAttributedString
        do {
            text = try NSAttributedString(url: url, options: [.documentType: NSAttributedString.DocumentType.officeOpenXML],
                                          documentAttributes: nil)
        } catch {
            throw LabError.message("无法读取 Word 文档“\(url.lastPathComponent)”，请确认它是 .docx 格式。")
        }
        return parse(text, fileName: url.lastPathComponent)
    }

    /// Bold and italic come from the run's font traits, or from the stroke
    /// and obliqueness AppKit uses for faces without them.
    static func marks(_ attributes: [NSAttributedString.Key: Any]) -> [BookImportMark.Kind] {
        let traits = (attributes[.font] as? NSFont).map { NSFontManager.shared.traits(of: $0) } ?? []
        var kinds: [BookImportMark.Kind] = []
        if traits.contains(.boldFontMask) || ((attributes[.strokeWidth] as? NSNumber)?.doubleValue ?? 0) < 0 { kinds.append(.bold) }
        if traits.contains(.italicFontMask) || ((attributes[.obliqueness] as? NSNumber)?.doubleValue ?? 0) > 0 { kinds.append(.italic) }
        return kinds
    }

    static func parse(_ text: NSAttributedString, fileName: String) -> BookImportDocument {
        let string = text.string as NSString
        var paragraphs: [(text: MarkedText, size: CGFloat, level: Int)] = []
        var sizes: [CGFloat: Int] = [:]
        var location = 0
        while location < string.length {
            var end = 0, contentsEnd = 0
            string.getParagraphStart(nil, end: &end, contentsEnd: &contentsEnd, for: NSRange(location: location, length: 0))
            let range = NSRange(location: location, length: contentsEnd - location)
            location = max(end, location + 1)
            var value = MarkedText(text: string.substring(with: range).replacingOccurrences(of: "\u{2028}", with: " "))
            var largest: CGFloat = 0, level = 0
            text.enumerateAttributes(in: range) { attributes, span, _ in
                guard !(string.substring(with: span).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) else { return }
                let size = (attributes[.font] as? NSFont)?.pointSize ?? 12
                largest = max(largest, size)
                sizes[size.rounded(), default: 0] += span.length
                if let style = attributes[.paragraphStyle] as? NSParagraphStyle, style.headerLevel > 0 { level = style.headerLevel }
                value.marks += marks(attributes).map { BookImportMark(kind: $0, location: span.location - range.location, length: span.length) }
            }
            value.replace("\u{FFFC}", keep: [])
            value = value.trimmed()
            guard !value.text.isEmpty else { continue }
            paragraphs.append((value, largest, level))
        }
        // The body size carries the most characters.
        let body = sizes.max { $0.value < $1.value }?.key ?? 12
        let blocks: [BookImportBlock] = paragraphs.map { paragraph in
            let text = paragraph.text.text
            let short = text.count <= 60 && !"。．.！!？?；;，,：:".contains(text.last!)
            // A heading's own bold or italic across its whole text is its
            // style, not emphasis.
            let length = (text as NSString).length
            let heading = MarkedText(text: text, marks: BookImportMark.normalized(paragraph.text.marks, length: length)
                .filter { $0.location > 0 || $0.length < length })
            if paragraph.level > 0, short { return .heading(heading, level: paragraph.level) }
            let ratio = paragraph.size / max(body, 1)
            guard short, ratio >= 1.25 else { return .paragraph(paragraph.text) }
            return .heading(heading, level: ratio >= 1.75 ? 1 : ratio >= 1.45 ? 2 : 3)
        }
        return BookImportDocument(format: .docx, fileName: fileName, title: BookImportParser.stem(fileName), blocks: blocks)
    }
}

/// 导入: the guessed title (editable), the target — 章节 with an optional
/// 故事线, 设定 with its 分类, or 漂流 — and a short preview of the parsed blocks.
final class MacImportSheet: NSObject {
    let document: BookImportDocument
    let window: NSWindow
    let titleField = NSTextField()
    let targetPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let categoryPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let categoryLabel = NSTextField(labelWithString: "分类")
    /// 故事线 for 章节: none, or a live storyline the chapter joins as 主线.
    let storylinePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let storylineLabel = NSTextField(labelWithString: "故事线")
    let preview = NSTextField(wrappingLabelWithString: "")
    let summary = NSTextField(labelWithString: "")
    let importButton = NSButton(title: "导入", target: nil, action: nil)
    let cancelButton = NSButton(title: "取消", target: nil, action: nil)
    private let message = NSTextField(wrappingLabelWithString: "")
    private var categories: [WorkspaceElementCategory]?
    /// An import is running: 导入 and the popups stay disabled, and Return
    /// or a late library reply cannot start a second one.
    private(set) var importing = false
    /// The title, the target and, for a chapter, the storyline it joins.
    var onImport: ((String, BookImportTarget, String?) -> Void)?
    var onCancel: (() -> Void)?

    var errorMessage: String? { message.isHidden ? nil : message.stringValue }
    static let targets: [(kind: String, title: String)] = [("chapter", "章节"), ("element", "设定"), ("drift", "漂流")]

    init(document: BookImportDocument) {
        self.document = document
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 360), styleMask: [.titled],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "导入"
        super.init()
        let heading = NSTextField(labelWithString: "导入“\(document.fileName)”")
        heading.font = .systemFont(ofSize: 15, weight: .semibold)
        heading.lineBreakMode = .byTruncatingMiddle
        let headings = document.blocks.filter { $0.kind == .heading }.count
        summary.stringValue = "\(document.formatName) · \(document.blocks.count) 段" + (headings > 0 ? "，其中 \(headings) 个标题" : "")
        summary.textColor = .secondaryLabelColor
        summary.setAccessibilityIdentifier("import-summary")
        titleField.stringValue = document.title
        titleField.placeholderString = "标题"
        titleField.setAccessibilityIdentifier("import-title")
        for target in Self.targets {
            targetPopup.addItem(withTitle: target.title)
            targetPopup.lastItem?.representedObject = target.kind
            targetPopup.lastItem?.setAccessibilityIdentifier("import-target-\(target.kind)")
        }
        targetPopup.target = self; targetPopup.action = #selector(targetChanged)
        targetPopup.setAccessibilityIdentifier("import-target")
        categoryPopup.setAccessibilityIdentifier("import-category")
        categoryPopup.addItem(withTitle: "正在读取分类…")
        categoryPopup.isEnabled = false
        categoryLabel.textColor = .secondaryLabelColor
        storylineLabel.textColor = .secondaryLabelColor
        storylinePopup.setAccessibilityIdentifier("import-storyline")
        MacImportSheet.fill(storylinePopup, with: [])
        preview.font = .systemFont(ofSize: 12)
        preview.textColor = .secondaryLabelColor
        preview.maximumNumberOfLines = 9
        preview.lineBreakMode = .byTruncatingTail
        preview.stringValue = Self.previewText(document.blocks)
        preview.setAccessibilityIdentifier("import-preview")
        let previewWash = ImportPreviewWash()
        preview.translatesAutoresizingMaskIntoConstraints = false
        previewWash.addSubview(preview)
        message.textColor = .systemRed
        message.isHidden = true
        message.setAccessibilityIdentifier("import-error")
        importButton.target = self; importButton.action = #selector(confirm)
        importButton.keyEquivalent = "\r"
        importButton.setAccessibilityIdentifier("confirm-import")
        cancelButton.target = self; cancelButton.action = #selector(cancel)
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.setAccessibilityIdentifier("cancel-import")
        let targetRow = NSStackView(views: [targetPopup, categoryLabel, categoryPopup, storylineLabel, storylinePopup])
        targetRow.spacing = 8
        let grid = NSGridView(views: [[label("标题"), titleField], [label("导入为"), targetRow]])
        grid.rowSpacing = 10; grid.columnSpacing = 10
        grid.rowAlignment = .firstBaseline
        grid.column(at: 0).xPlacement = .trailing
        let buttons = NSStackView(views: [NSView(), cancelButton, importButton])
        let stack = NSStackView(views: [heading, summary, grid, previewWash, message, buttons])
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
            content.widthAnchor.constraint(equalToConstant: 480),
            heading.widthAnchor.constraint(equalTo: stack.widthAnchor),
            grid.widthAnchor.constraint(equalTo: stack.widthAnchor),
            titleField.widthAnchor.constraint(greaterThanOrEqualToConstant: 320),
            previewWash.widthAnchor.constraint(equalTo: stack.widthAnchor),
            preview.leadingAnchor.constraint(equalTo: previewWash.leadingAnchor, constant: 12),
            preview.trailingAnchor.constraint(equalTo: previewWash.trailingAnchor, constant: -12),
            preview.topAnchor.constraint(equalTo: previewWash.topAnchor, constant: 10),
            preview.bottomAnchor.constraint(equalTo: previewWash.bottomAnchor, constant: -10),
            message.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        targetChanged()
        content.layoutSubtreeIfNeeded()
        window.setContentSize(content.fittingSize)
    }

    private func label(_ text: String) -> NSTextField {
        let value = NSTextField(labelWithString: text)
        value.textColor = .secondaryLabelColor
        return value
    }

    /// The first blocks as they will read: headings marked by level.
    static func previewText(_ blocks: [BookImportBlock]) -> String {
        let shown = blocks.prefix(8).map { block -> String in
            let text = block.text.count > 90 ? String(block.text.prefix(90)) + "…" : block.text
            return block.kind == .heading ? "\(String(repeating: "#", count: block.level ?? 1)) \(text)" : text
        }
        return shown.joined(separator: "\n") + (blocks.count > 8 ? "\n……" : "")
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

    /// 不加入故事线, then live storylines in their order.
    static func fill(_ popup: NSPopUpButton, with storylines: [WorkspaceStoryline]) {
        let selected = popup.selectedItem?.representedObject as? String
        popup.removeAllItems()
        popup.addItem(withTitle: "不加入故事线")
        popup.lastItem?.setAccessibilityIdentifier("import-storyline-none")
        for storyline in storylines {
            popup.addItem(withTitle: storyline.name)
            popup.lastItem?.representedObject = storyline.id
            popup.lastItem?.image = ElementSwatch.image(color: ElementSwatch.color(hex: storyline.color))
            popup.lastItem?.setAccessibilityIdentifier("import-storyline-\(storyline.id)")
        }
        if let selected, let index = popup.itemArray.firstIndex(where: { $0.representedObject as? String == selected }) {
            popup.selectItem(at: index)
        }
    }

    /// Live storylines a chapter may join.
    func setStorylines(_ storylines: [WorkspaceStoryline]) {
        Self.fill(storylinePopup, with: storylines)
        targetChanged()
    }

    func select(storylineID: String?) {
        let index = storylinePopup.itemArray.firstIndex { $0.representedObject as? String == storylineID } ?? 0
        storylinePopup.selectItem(at: index)
    }

    /// The storyline a chapter joins; nil for none.
    var selectedStorylineID: String? { selectedKind == "chapter" ? storylinePopup.selectedItem?.representedObject as? String : nil }

    /// Live categories for the 设定 target, in library order.
    func setCategories(_ categories: [WorkspaceElementCategory]) {
        self.categories = categories
        categoryPopup.removeAllItems()
        if categories.isEmpty { categoryPopup.addItem(withTitle: "还没有分类") }
        for category in categories {
            categoryPopup.addItem(withTitle: category.name)
            categoryPopup.lastItem?.representedObject = category.id
            categoryPopup.lastItem?.image = ElementSwatch.image(for: category)
            categoryPopup.lastItem?.setAccessibilityIdentifier("import-category-\(category.id)")
        }
        targetChanged()
    }

    @objc private func targetChanged() {
        let element = selectedKind == "element"
        categoryLabel.isHidden = !element
        categoryPopup.isHidden = !element
        let chapter = selectedKind == "chapter"
        storylineLabel.isHidden = !chapter
        storylinePopup.isHidden = !chapter
        categoryPopup.isEnabled = element && categories?.isEmpty == false && !importing
        if importing { return }
        if element, categories?.isEmpty == true {
            showError("还没有设定分类。请先在设定库中新建一个分类，例如“人物”。")
        } else { showError(nil) }
        importButton.isEnabled = !element || categories?.isEmpty == false
    }

    func showError(_ text: String?) {
        message.stringValue = text ?? ""
        message.isHidden = text == nil
    }

    func setImporting(_ importing: Bool) {
        self.importing = importing
        importButton.isEnabled = !importing
        cancelButton.isEnabled = !importing
        targetPopup.isEnabled = !importing; storylinePopup.isEnabled = !importing
        titleField.isEnabled = !importing
        importButton.title = importing ? "正在导入…" : "导入"
        if !importing { targetChanged() } else { categoryPopup.isEnabled = false }
    }

    @objc func confirm() {
        guard !importing else { return }
        let title = BookImportParser.trim(titleField.currentEditor()?.string ?? titleField.stringValue)
        guard !title.isEmpty else { showError("标题不能为空。"); return }
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
        onImport?(title, target, selectedStorylineID)
    }
    @objc func cancel() { onCancel?() }
}

private final class ImportPreviewWash: NSView {
    override init(frame: NSRect) { super.init(frame: frame); wantsLayer = true }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var wantsUpdateLayer: Bool { true }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    override func updateLayer() {
        layer?.cornerRadius = 8
        layer?.backgroundColor = NSColor.secondaryLabelColor.withAlphaComponent(0.06).cgColor
    }
}

/// An imported entity, and why its chapter did not join the chosen 故事线
/// (nil when it joined or none was chosen).
struct BookImportResult {
    let entity: WorkspaceImportedEntity
    let joinFailure: String?
}

/// 文件 › 导入… and 导出全书…. Import parses the file on the host, lets the
/// author confirm title and target, creates the entity with its body in
/// Rust and opens its page. Export writes Rust's text as UTF-8.
final class MacBookTransfer {
    let workspace: LabWorkspaceCore
    let host: MacChapterWorkspace
    /// Chooses one source file; acceptance answers here. Without it (and
    /// `chooseImportFiles`) an open panel takes several files or a folder.
    var chooseImportFile: ((NSWindow?, @escaping (URL?) -> Void) -> Void)?
    /// Chooses several files and folders; acceptance answers here.
    var chooseImportFiles: ((NSWindow?, @escaping ([URL]) -> Void) -> Void)?
    /// Chooses a destination and format; nil uses a save panel with a
    /// format popup. Acceptance answers here.
    var chooseExportDestination: ((NSWindow?, String, @escaping ((URL, BookExportFormat)?) -> Void) -> Void)?
    var onStatus: ((String) -> Void)?
    /// A new chapter, drift or element, before its page opens: the caller
    /// updates its lists. Workspace libraries are read again here.
    var onImported: ((WorkspaceProject, WorkspaceImportedEntity) -> Void)?
    private(set) var importSheet: MacImportSheet?
    /// The sheet for several files or a folder.
    var bulkSheet: MacBulkImportSheet?
    /// The project the open import sheet writes into.
    var importProjectID: String?
    private(set) var isExporting = false

    static let importTypes: [UTType] = [UTType(filenameExtension: "md"), UTType(filenameExtension: "markdown"), .plainText,
                                        UTType(filenameExtension: "docx")].compactMap { $0 }

    init(workspace: LabWorkspaceCore, host: MacChapterWorkspace) {
        self.workspace = workspace
        self.host = host
    }

    /// Reads a Markdown, text or Word file into blocks.
    static func read(_ url: URL) throws -> BookImportDocument {
        let document = url.pathExtension.lowercased() == "docx" ? try MacDocxImport.read(url) : try BookImportParser.read(url)
        guard !document.blocks.isEmpty else {
            throw LabError.message("“\(url.lastPathComponent)”中没有可导入的文字。")
        }
        return document
    }

    /// One file opens the single-file sheet; several files or a folder open
    /// the sheet that imports them all.
    func beginImport(project: WorkspaceProject, window: NSWindow?) {
        if let sheet = importSheet { sheet.window.makeKeyAndOrderFront(nil); return }
        if let sheet = bulkSheet { sheet.window.makeKeyAndOrderFront(nil); return }
        let finish: ([URL]) -> Void = { [weak self] urls in
            guard let self, !urls.isEmpty else { return }
            if urls.count == 1, !Self.isFolder(urls[0]) {
                do { self.present(try Self.read(urls[0]), project: project, window: window) }
                catch { self.onStatus?(error.localizedDescription) }
            } else {
                self.presentBulk(urls, project: project, window: window)
            }
        }
        if let chooseImportFile { chooseImportFile(window) { finish($0.map { [$0] } ?? []) }; return }
        if let chooseImportFiles { chooseImportFiles(window, finish); return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = Self.importTypes
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = true
        panel.message = "选择一个或多个 Markdown、纯文本或 Word（.docx）文件，或一个文件夹，导入为新的章节、设定或漂流。"
        panel.prompt = "选择"
        if let window { panel.beginSheetModal(for: window) { if $0 == .OK { finish(panel.urls) } } }
        else if panel.runModal() == .OK { finish(panel.urls) }
    }

    private func present(_ document: BookImportDocument, project: WorkspaceProject, window: NSWindow?) {
        let sheet = MacImportSheet(document: document)
        importSheet = sheet
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
        sheet.onImport = { [weak self, weak sheet] title, target, storylineID in
            guard let self, let sheet, !sheet.importing else { return }
            sheet.setImporting(true)
            self.importOne(project: project, title: title, target: target, storylineID: storylineID,
                           blocks: document.blocks) { [weak self, weak sheet] result in
                guard let self else { return }
                sheet?.setImporting(false)
                switch result {
                case .success(let imported):
                    self.endImport()
                    self.adopt(imported.entity, project: project, joinFailure: imported.joinFailure)
                case .failure(let error):
                    // The sheet stays with the typed title for another try.
                    sheet?.showError(error.localizedDescription)
                }
            }
        }
        if let window { window.beginSheet(sheet.window) }
        sheet.window.makeFirstResponder(sheet.titleField)
    }

    /// The single-file path every import takes: Rust creates the entity with
    /// its body; a chapter then joins the storyline as its 主线. A failed join
    /// keeps the chapter and comes back with it (`joinFailure`), for the
    /// caller to show.
    func importOne(project: WorkspaceProject, title: String, target: BookImportTarget, storylineID: String?,
                   blocks: [BookImportBlock], completion: @escaping (Result<BookImportResult, Error>) -> Void) {
        workspace.importBlocks(projectID: project.id, title: title, target: target, blocks: blocks) { [weak self] result in
            switch result {
            case .failure(let error): completion(.failure(error))
            case .success(let entity):
                guard let self, case .chapter(let chapter) = entity, let storylineID else {
                    completion(.success(BookImportResult(entity: entity, joinFailure: nil))); return
                }
                self.workspace.setChapterStorylines(projectID: project.id, chapterID: chapter.id, storylineIDs: [storylineID],
                                                    primary: storylineID) { [weak self] joined in
                    var failure: String?
                    if case .failure(let error) = joined { failure = error.localizedDescription }
                    self?.host.storylinesChanged(projectID: project.id)
                    completion(.success(BookImportResult(entity: entity, joinFailure: failure)))
                }
            }
        }
    }

    /// Lists learn about the new entity and its page opens once every open
    /// body is idle (a link pass may still be settling); then the libraries
    /// that name it are read again.
    private func adopt(_ entity: WorkspaceImportedEntity, project: WorkspaceProject, joinFailure: String?, attempt: Int = 0) {
        if attempt == 0 { onImported?(project, entity) }
        guard host.canNavigate || attempt >= 50 else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                self?.adopt(entity, project: project, joinFailure: joinFailure, attempt: attempt + 1)
            }
            return
        }
        let opened: (Result<NativeDocumentView, Error>) -> Void = { [weak self] result in
            guard let self else { return }
            switch entity {
            case .chapter: self.host.chaptersChanged(projectID: project.id)
            case .drift: self.host.driftsChanged(projectID: project.id)
            case .element: self.host.elementsChanged(projectID: project.id)
            }
            // A failed 故事线 join stays in the final status.
            let join = joinFailure.map { "但未能加入故事线：\($0)" }
            switch result {
            case .success: self.onStatus?("已导入“\(entity.title)”" + (join.map { "，\($0)。正文自动保存。" } ?? "，正文自动保存。"))
            case .failure(let error):
                self.onStatus?("已导入“\(entity.title)”" + (join.map { "，\($0)" } ?? "") + "，但页面未能打开：\(error.localizedDescription)")
            }
        }
        switch entity {
        case .chapter(let chapter): host.open(project: project, chapter: chapter, completion: opened)
        case .drift(let drift): host.open(project: project, drift: drift, completion: opened)
        case .element(let element): host.open(project: project, element: element, completion: opened)
        }
    }

    /// Closes the import sheet; with a project, only a sheet importing into it.
    func endImport(projectID: String? = nil) {
        guard projectID == nil || projectID == importProjectID else { return }
        let window = importSheet?.window ?? bulkSheet?.window
        bulkSheet?.close()
        importSheet = nil; bulkSheet = nil; importProjectID = nil
        guard let window else { return }
        if let parent = window.sheetParent { parent.endSheet(window) } else { window.orderOut(nil) }
    }

    /// Asks for a destination and format, then writes the book.
    func beginExport(project: WorkspaceProject, window: NSWindow?, completion: ((Result<URL, Error>) -> Void)? = nil) {
        guard !isExporting else { return }
        let name = project.name.replacingOccurrences(of: "/", with: "／").replacingOccurrences(of: ":", with: "：")
        let finish: ((URL, BookExportFormat)?) -> Void = { [weak self] choice in
            guard let self, let choice else { return }
            self.export(project: project, format: choice.1, to: choice.0, completion: completion)
        }
        if let chooseExportDestination { chooseExportDestination(window, name, finish); return }
        let panel = NSSavePanel()
        panel.title = "导出全书"
        panel.message = "按整书大纲的顺序导出书名、简介、幕和每一章的正文。"
        panel.prompt = "导出"
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false
        let popup = NSPopUpButton(frame: .zero, pullsDown: false)
        for format in BookExportFormat.allCases {
            popup.addItem(withTitle: format.label)
            popup.lastItem?.representedObject = format.rawValue
        }
        let accessory = NSStackView(views: [NSTextField(labelWithString: "格式："), popup])
        accessory.edgeInsets = NSEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        panel.accessoryView = accessory
        let chosen = { BookExportFormat(rawValue: popup.selectedItem?.representedObject as? String ?? "") ?? .markdown }
        let apply = {
            let format = chosen()
            panel.allowedContentTypes = [UTType(filenameExtension: format.fileExtension) ?? .plainText]
            let stem = (panel.nameFieldStringValue as NSString).deletingPathExtension
            panel.nameFieldStringValue = (stem.isEmpty ? name : stem) + "." + format.fileExtension
        }
        let observer = PopupObserver(apply)
        popup.target = observer; popup.action = #selector(PopupObserver.changed)
        panel.nameFieldStringValue = name
        apply()
        let done: (NSApplication.ModalResponse) -> Void = { response in
            withExtendedLifetime(observer) {}
            guard response == .OK, let url = panel.url else { return }
            finish((url, chosen()))
        }
        if let window { panel.beginSheetModal(for: window, completionHandler: done) } else { done(panel.runModal()) }
    }

    private func export(project: WorkspaceProject, format: BookExportFormat, to url: URL,
                        completion: ((Result<URL, Error>) -> Void)?) {
        isExporting = true
        onStatus?("正在导出全书…")
        workspace.exportBook(projectID: project.id, format: format) { [weak self] result in
            guard let self else { return }
            self.isExporting = false
            let written = result.flatMap { text in
                Result<URL, Error> {
                    do { try Data(text.utf8).write(to: url, options: .atomic) } catch {
                        throw LabError.message("无法写入“\(url.lastPathComponent)”，请换一个位置再试。")
                    }
                    return url
                }
            }
            switch written {
            case .success: self.onStatus?("全书已导出为\(format == .markdown ? " Markdown" : "纯文本")：\(url.lastPathComponent)")
            case .failure(let error): self.onStatus?(error.localizedDescription)
            }
            completion?(written)
        }
    }
}

private final class PopupObserver: NSObject {
    private let action: () -> Void
    init(_ action: @escaping () -> Void) { self.action = action }
    @objc func changed() { action() }
}
