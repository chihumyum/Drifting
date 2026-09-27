import AppKit
import UniformTypeIdentifiers

/// Word documents through AppKit's Office Open XML reader. Each paragraph
/// becomes a block; only a short paragraph set clearly larger than the body
/// text becomes a heading.
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

    static func parse(_ text: NSAttributedString, fileName: String) -> BookImportDocument {
        let string = text.string as NSString
        var paragraphs: [(text: String, size: CGFloat, level: Int)] = []
        var sizes: [CGFloat: Int] = [:]
        var location = 0
        while location < string.length {
            var end = 0, contentsEnd = 0
            string.getParagraphStart(nil, end: &end, contentsEnd: &contentsEnd, for: NSRange(location: location, length: 0))
            let range = NSRange(location: location, length: contentsEnd - location)
            location = max(end, location + 1)
            let value = BookImportParser.trim(string.substring(with: range)
                .replacingOccurrences(of: "\u{2028}", with: " ").replacingOccurrences(of: "\u{FFFC}", with: ""))
            guard !value.isEmpty else { continue }
            var largest: CGFloat = 0, level = 0
            text.enumerateAttributes(in: range) { attributes, span, _ in
                guard !(string.substring(with: span).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) else { return }
                let size = (attributes[.font] as? NSFont)?.pointSize ?? 12
                largest = max(largest, size)
                sizes[size.rounded(), default: 0] += span.length
                if let style = attributes[.paragraphStyle] as? NSParagraphStyle, style.headerLevel > 0 { level = style.headerLevel }
            }
            paragraphs.append((value, largest, level))
        }
        // The body size carries the most characters.
        let body = sizes.max { $0.value < $1.value }?.key ?? 12
        let blocks: [BookImportBlock] = paragraphs.map { paragraph in
            let short = paragraph.text.count <= 60 && !"。．.！!？?；;，,：:".contains(paragraph.text.last!)
            if paragraph.level > 0, short { return .heading(paragraph.text, level: paragraph.level) }
            let ratio = paragraph.size / max(body, 1)
            guard short, ratio >= 1.25 else { return .paragraph(paragraph.text) }
            return .heading(paragraph.text, level: ratio >= 1.75 ? 1 : ratio >= 1.45 ? 2 : 3)
        }
        return BookImportDocument(format: .docx, fileName: fileName, title: BookImportParser.stem(fileName), blocks: blocks)
    }
}

/// 导入: the guessed title (editable), the target — 章节, 设定 with its
/// 分类, or 漂流 — and a short preview of the parsed blocks.
final class MacImportSheet: NSObject {
    let document: BookImportDocument
    let window: NSWindow
    let titleField = NSTextField()
    let targetPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let categoryPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let categoryLabel = NSTextField(labelWithString: "分类")
    let preview = NSTextField(wrappingLabelWithString: "")
    let summary = NSTextField(labelWithString: "")
    let importButton = NSButton(title: "导入", target: nil, action: nil)
    let cancelButton = NSButton(title: "取消", target: nil, action: nil)
    private let message = NSTextField(wrappingLabelWithString: "")
    private var categories: [WorkspaceElementCategory]?
    var onImport: ((String, BookImportTarget) -> Void)?
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
        let targetRow = NSStackView(views: [targetPopup, categoryLabel, categoryPopup])
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
        categoryPopup.isEnabled = element && categories?.isEmpty == false
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
        importButton.isEnabled = !importing
        cancelButton.isEnabled = !importing
        importButton.title = importing ? "正在导入…" : "导入"
    }

    @objc func confirm() {
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
        onImport?(title, target)
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

/// 文件 › 导入… and 导出全书…. Import parses the file on the host, lets the
/// author confirm title and target, creates the entity with its body in
/// Rust and opens its page. Export writes Rust's text as UTF-8.
final class MacBookTransfer {
    private let workspace: LabWorkspaceCore
    private let host: MacChapterWorkspace
    /// Chooses a source file; nil uses an open panel. Acceptance answers here.
    var chooseImportFile: ((NSWindow?, @escaping (URL?) -> Void) -> Void)?
    /// Chooses a destination and format; nil uses a save panel with a
    /// format popup. Acceptance answers here.
    var chooseExportDestination: ((NSWindow?, String, @escaping ((URL, BookExportFormat)?) -> Void) -> Void)?
    var onStatus: ((String) -> Void)?
    /// A new chapter, drift or element, before its page opens: the caller
    /// updates its lists. Workspace libraries are read again here.
    var onImported: ((WorkspaceProject, WorkspaceImportedEntity) -> Void)?
    private(set) var importSheet: MacImportSheet?
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

    func beginImport(project: WorkspaceProject, window: NSWindow?) {
        guard importSheet == nil else { importSheet?.window.makeKeyAndOrderFront(nil); return }
        let finish: (URL?) -> Void = { [weak self] url in
            guard let self, let url else { return }
            do { self.present(try Self.read(url), project: project, window: window) }
            catch { self.onStatus?(error.localizedDescription) }
        }
        if let chooseImportFile { chooseImportFile(window, finish); return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = Self.importTypes
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.message = "选择 Markdown、纯文本或 Word（.docx）文件，导入为新的章节、设定或漂流。"
        panel.prompt = "选择"
        if let window { panel.beginSheetModal(for: window) { if $0 == .OK { finish(panel.url) } } }
        else if panel.runModal() == .OK { finish(panel.url) }
    }

    private func present(_ document: BookImportDocument, project: WorkspaceProject, window: NSWindow?) {
        let sheet = MacImportSheet(document: document)
        importSheet = sheet
        workspace.elementLibrary(projectID: project.id) { [weak sheet] result in
            switch result {
            case .success(let library): sheet?.setCategories(library.categories)
            case .failure(let error): sheet?.setCategories([]); sheet?.showError(error.localizedDescription)
            }
        }
        sheet.onCancel = { [weak self] in self?.endImport() }
        sheet.onImport = { [weak self, weak sheet] title, target in
            guard let self, let sheet else { return }
            sheet.setImporting(true)
            self.workspace.importBlocks(projectID: project.id, title: title, target: target, blocks: document.blocks) { [weak self, weak sheet] result in
                guard let self else { return }
                sheet?.setImporting(false)
                switch result {
                case .success(let entity):
                    self.endImport()
                    self.adopt(entity, project: project)
                case .failure(let error):
                    // The sheet stays with the typed title for another try.
                    sheet?.showError(error.localizedDescription)
                }
            }
        }
        if let window { window.beginSheet(sheet.window) }
        sheet.window.makeFirstResponder(sheet.titleField)
    }

    /// Lists learn about the new entity and its page opens once every open
    /// body is idle (a link pass may still be settling); then the libraries
    /// that name it are read again.
    private func adopt(_ entity: WorkspaceImportedEntity, project: WorkspaceProject, attempt: Int = 0) {
        if attempt == 0 { onImported?(project, entity) }
        guard host.canNavigate || attempt >= 50 else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                self?.adopt(entity, project: project, attempt: attempt + 1)
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
            switch result {
            case .success: self.onStatus?("已导入“\(entity.title)”，正文自动保存。")
            case .failure(let error): self.onStatus?("已导入“\(entity.title)”，但页面未能打开：\(error.localizedDescription)")
            }
        }
        switch entity {
        case .chapter(let chapter): host.open(project: project, chapter: chapter, completion: opened)
        case .drift(let drift): host.open(project: project, drift: drift, completion: opened)
        case .element(let element): host.open(project: project, element: element, completion: opened)
        }
    }

    func endImport() {
        guard let sheet = importSheet else { return }
        importSheet = nil
        if let parent = sheet.window.sheetParent { parent.endSheet(sheet.window) } else { sheet.window.orderOut(nil) }
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
