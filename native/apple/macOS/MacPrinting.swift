import AppKit
import UniformTypeIdentifiers

// MARK: Paper and typesetting

/// The two paper sizes the book PDF uses, portrait.
enum PrintPaper: String, CaseIterable {
    case a4, letter

    var size: NSSize {
        switch self {
        case .a4: return NSSize(width: 595.2756, height: 841.8898)
        case .letter: return NSSize(width: 612, height: 792)
        }
    }
    var name: String { self == .a4 ? "A4" : "Letter" }

    /// Letter when the print setup's paper is Letter (either way round), else A4.
    static func from(_ size: NSSize) -> PrintPaper {
        let (short, long) = (min(size.width, size.height), max(size.width, size.height))
        return abs(short - 612) < 3 && abs(long - 792) < 3 ? .letter : .a4
    }
}

/// A page: the paper, its margins and the header line above the text.
struct PrintGeometry: Equatable {
    let paper: NSSize
    var margin: CGFloat = 72

    var content: NSSize { NSSize(width: max(paper.width - 2 * margin, 72), height: max(paper.height - 2 * margin, 72)) }
    /// The header's baseline area, inside the top margin.
    var headerTop: CGFloat { max(margin - 34, 18) }
}

/// Prose set for paper in the editor's typography (设置's face, size, line
/// height, first-line indent and manuscript language) in black on white,
/// whatever the app's appearance. Headings, bold, italic, strike, code,
/// quotes, lists and links are styled; entity links are plain text and
/// comments are not marked.
final class PrintTypesetter {
    let typography: DocumentTypography
    /// Body headings are set this many levels lower: in the book PDF the
    /// chapter heading takes the first level.
    let headingShift: Int

    static let ink = NSColor(srgbRed: 0, green: 0, blue: 0, alpha: 1)
    static let muted = NSColor(srgbRed: 0.36, green: 0.36, blue: 0.36, alpha: 1)
    static let linkColor = NSColor(srgbRed: 0.1, green: 0.3, blue: 0.6, alpha: 1)
    static let codeWash = NSColor(srgbRed: 0.93, green: 0.93, blue: 0.93, alpha: 1)

    private struct FontKey: Hashable { let size: CGFloat; let weight: CGFloat; let italic: Bool; let mono: Bool }
    private var fonts: [FontKey: NSFont] = [:]

    init(typography: DocumentTypography = DocumentStyle.typography, headingShift: Int = 0) {
        self.typography = typography
        self.headingShift = headingShift
    }

    func font(size: CGFloat, weight: NSFont.Weight = .regular, italic: Bool = false, mono: Bool = false) -> NSFont {
        let key = FontKey(size: size, weight: weight.rawValue, italic: italic, mono: mono)
        if let font = fonts[key] { return font }
        let font = DocumentStyle.font(typography, size: size, weight: weight, italic: italic, monospaced: mono)
        fonts[key] = font
        return font
    }

    /// A body heading's size: the editor's 28/24/20 at 17 pt, one level
    /// lower per shift; a fourth level is a bold body line.
    func headingSize(_ level: Int) -> CGFloat {
        let shifted = min(max(level, 1), 3) + headingShift
        return shifted <= 3 ? typography.headingSize(shifted) : typography.size * 18 / 17
    }

    private func base(_ paragraph: NSParagraphStyle, font: NSFont, color: NSColor = ink) -> [NSAttributedString.Key: Any] {
        var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .paragraphStyle: paragraph]
        if let language = typography.language { attributes[DocumentStyle.languageKey] = language }
        return attributes
    }

    /// A title line: a chapter or page heading, an act or the book's name.
    func title(_ text: String, size: CGFloat, centered: Bool = false, after: CGFloat? = nil) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = centered ? .center : .natural
        paragraph.lineSpacing = typography.lineSpacing * 0.5
        paragraph.paragraphSpacing = after ?? size
        return NSAttributedString(string: text, attributes: base(paragraph, font: font(size: size, weight: .semibold)))
    }

    /// A centred line in the muted colour at body size (the book's summary).
    func note(_ text: String) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.lineSpacing = typography.lineSpacing
        paragraph.paragraphSpacing = typography.paragraphSpacing
        return NSAttributedString(string: text, attributes: base(paragraph, font: font(size: typography.size), color: Self.muted))
    }

    /// `next` as the paragraphs after `text`: the separating newline ends
    /// `text`'s last paragraph in its style. Nothing is added before the
    /// first paragraph or for an empty `next`.
    func following(_ next: NSAttributedString, after text: NSAttributedString) -> NSAttributedString {
        guard next.length > 0, text.length > 0 else { return next }
        let result = NSMutableAttributedString(string: "\n", attributes: text.attributes(at: text.length - 1, effectiveRange: nil))
        result.append(next)
        return result
    }

    /// One body: a paragraph per block in the projection's order.
    func body(_ projection: WorkspaceBodyProjection.Projection) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let text = projection.text as NSString
        var previousContainer: String?
        for block in projection.blocks {
            let range = block.range.nsRange
            guard range.location >= 0, range.length >= 0, NSMaxRange(range) <= text.length else { continue }
            let continues = previousContainer == block.container && block.depth > 0
            previousContainer = block.container
            guard let paragraph = self.block(block, text: text.substring(with: range), continues: continues) else { continue }
            result.append(following(paragraph, after: result))
        }
        return result
    }

    /// A quote's blocks sit at odd depths, a list item's at even ones (a
    /// list and its item are two levels). The projection names no container
    /// kind, so a quote inside a list item and a list inside a quote are
    /// told apart by depth alone, and every list is bulleted.
    private func block(_ block: WorkspaceBodyProjection.Block, text: String, continues: Bool) -> NSAttributedString? {
        let isText = ["paragraph", "heading", "codeBlock"].contains(block.kind)
        var content = text
        if !isText {
            guard block.kind == "horizontalRule" else { return nil }
            content = "＊　＊　＊"
        }
        let size = block.kind == "heading" ? headingSize(block.level ?? 1) : typography.size
        let weight: NSFont.Weight = block.kind == "heading" ? .semibold : .regular
        let mono = block.kind == "codeBlock"
        let bodyFont = mono ? font(size: typography.codeSize, mono: true) : font(size: size, weight: weight)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = typography.lineSpacing
        paragraph.paragraphSpacing = typography.paragraphSpacing
        var color = Self.ink
        var prefix = ""
        if block.kind == "heading" { paragraph.paragraphSpacingBefore = size * 0.5 }
        if block.kind == "horizontalRule" { paragraph.alignment = .center }
        if block.depth == 0 {
            if block.kind == "paragraph" { paragraph.firstLineHeadIndent = typography.paragraphIndent }
            if mono { paragraph.headIndent = typography.size; paragraph.firstLineHeadIndent = typography.size }
        } else if block.depth % 2 == 1 {
            // A quote: indented on both sides, in the muted colour.
            let indent = CGFloat((block.depth + 1) / 2) * typography.size * 2
            paragraph.headIndent = indent; paragraph.firstLineHeadIndent = indent; paragraph.tailIndent = -typography.size * 2
            color = Self.muted
        } else {
            // A list item: the bullet hangs before the text; further
            // paragraphs of the same item align with it.
            let level = block.depth / 2
            let indent = CGFloat(level) * typography.size * 1.6
            paragraph.headIndent = indent
            paragraph.tabStops = [NSTextTab(textAlignment: .natural, location: indent)]
            paragraph.defaultTabInterval = indent
            if continues {
                paragraph.firstLineHeadIndent = indent
            } else {
                paragraph.firstLineHeadIndent = max(0, indent - typography.size * 1.1)
                prefix = (level % 2 == 1 ? "•" : "◦") + "\t"
            }
        }
        let result = NSMutableAttributedString(string: prefix + content, attributes: base(paragraph, font: bodyFont, color: color))
        if mono { result.addAttribute(.backgroundColor, value: Self.codeWash, range: NSRange(location: 0, length: result.length)) }
        guard isText else { return result }
        let offset = (prefix as NSString).length, length = (content as NSString).length
        for run in block.runs {
            let start = run.range.location - block.range.location + offset
            let span = NSRange(location: start, length: run.range.length)
            guard span.location >= offset, span.length > 0, NSMaxRange(span) <= offset + length else { continue }
            let marks = run.attributes.names
            var attributes: [NSAttributedString.Key: Any] = [:]
            if marks.contains("code") {
                attributes[.font] = font(size: typography.codeSize, mono: true)
                attributes[.backgroundColor] = Self.codeWash
            } else if !mono, marks.contains("bold") || marks.contains("italic") {
                let bold = marks.contains("bold")
                attributes[.font] = font(size: size, weight: bold ? .bold : weight, italic: marks.contains("italic"))
            }
            if marks.contains("strike") { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if marks.contains("underline") { attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue }
            if marks.contains("link") {
                attributes[.foregroundColor] = Self.linkColor
                attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
            }
            if !attributes.isEmpty { result.addAttributes(attributes, range: span) }
        }
        return result
    }
}

// MARK: Pagination

/// What one run of pages holds: a title page, an act page or a chapter
/// (or the printed page). Every section starts on a new page.
struct PrintSection {
    let text: NSAttributedString
    /// The header's leading text on this section's pages; nil draws no
    /// header (the title page and act pages).
    let header: String?
    /// Space above the text on the first page, as a share of the content
    /// height: title and act pages set their text lower.
    var lead: CGFloat = 0
}

/// One section laid out a page at a time, one text container per page.
final class PrintSectionLayout {
    let section: PrintSection
    let geometry: PrintGeometry
    private let storage: NSTextStorage
    private let layoutManager = NSLayoutManager()
    private(set) var containers: [NSTextContainer] = []
    private(set) var isComplete = false

    init(_ section: PrintSection, geometry: PrintGeometry) {
        self.section = section
        self.geometry = geometry
        storage = NSTextStorage(attributedString: section.text)
        layoutManager.backgroundLayoutEnabled = false
        layoutManager.allowsNonContiguousLayout = false
        storage.addLayoutManager(layoutManager)
    }

    private var leadHeight: CGFloat { (geometry.content.height * section.lead).rounded() }

    /// Lays out one more page; false once the text is placed.
    @discardableResult
    func layoutPage() -> Bool {
        guard !isComplete else { return false }
        let height = geometry.content.height - (containers.isEmpty ? leadHeight : 0)
        let container = NSTextContainer(size: NSSize(width: geometry.content.width, height: height))
        container.lineFragmentPadding = 0
        layoutManager.addTextContainer(container)
        containers.append(container)
        let placed = layoutManager.glyphRange(for: container)
        // A page that takes nothing (a line taller than a page) ends it too.
        if NSMaxRange(placed) >= layoutManager.numberOfGlyphs || (placed.length == 0 && containers.count > 1) { isComplete = true }
        return true
    }

    func layoutAll() { while layoutPage() {} }

    /// Draws a page's text with its top-left paper corner at `origin` in
    /// the current, flipped graphics context.
    func draw(page index: Int, at origin: NSPoint) {
        guard containers.indices.contains(index) else { return }
        let range = layoutManager.glyphRange(for: containers[index])
        let point = NSPoint(x: origin.x + geometry.margin, y: origin.y + geometry.margin + (index == 0 ? leadHeight : 0))
        layoutManager.drawBackground(forGlyphRange: range, at: point)
        layoutManager.drawGlyphs(forGlyphRange: range, at: point)
    }

    /// The header: the section's title at the left, the page number at the right.
    static func drawHeader(_ title: String, number: Int, geometry: PrintGeometry, at origin: NSPoint) {
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 9), .foregroundColor: PrintTypesetter.muted]
        let numberText = NSAttributedString(string: "\(number)", attributes: attributes)
        let numberWidth = ceil(numberText.size().width)
        let right = origin.x + geometry.paper.width - geometry.margin
        numberText.draw(at: NSPoint(x: right - numberWidth, y: origin.y + geometry.headerTop))
        let titleRect = NSRect(x: origin.x + geometry.margin, y: origin.y + geometry.headerTop,
                               width: max(0, geometry.content.width - numberWidth - 24), height: 14)
        NSAttributedString(string: title, attributes: attributes)
            .draw(with: titleRect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }
}

/// Every page of a few sections, for the print panel: pages lay out again
/// when the panel's paper changes. Numbers count from the first page.
final class PrintPagesView: NSView {
    private let sections: [PrintSection]
    private(set) var geometry: PrintGeometry
    private var layouts: [PrintSectionLayout] = []
    private var pages: [(layout: PrintSectionLayout, index: Int)] = []

    init(sections: [PrintSection], paper: NSSize) {
        self.sections = sections
        geometry = PrintGeometry(paper: paper)
        super.init(frame: NSRect(origin: .zero, size: paper))
        paginate()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }
    var pageCount: Int { pages.count }

    private func paginate() {
        layouts = sections.map { PrintSectionLayout($0, geometry: geometry) }
        pages = []
        for layout in layouts {
            layout.layoutAll()
            pages += layout.containers.indices.map { (layout, $0) }
        }
        setFrameSize(NSSize(width: geometry.paper.width, height: geometry.paper.height * CGFloat(max(pages.count, 1))))
    }

    override func knowsPageRange(_ range: NSRangePointer) -> Bool {
        if let paper = NSPrintOperation.current?.printInfo.paperSize, paper.width > 0, paper.height > 0, paper != geometry.paper {
            geometry = PrintGeometry(paper: paper)
            paginate()
        }
        range.pointee = NSRange(location: 1, length: max(pages.count, 1))
        return true
    }

    override func rectForPage(_ page: Int) -> NSRect {
        NSRect(x: 0, y: CGFloat(page - 1) * geometry.paper.height, width: geometry.paper.width, height: geometry.paper.height)
    }

    override func draw(_ dirtyRect: NSRect) {
        let first = max(0, Int(floor(dirtyRect.minY / geometry.paper.height)))
        let last = min(pages.count - 1, Int(ceil(dirtyRect.maxY / geometry.paper.height)) - 1)
        guard first <= last else { return }
        NSAppearance(named: .aqua)?.performAsCurrentDrawingAppearance {
            for page in first...last {
                let origin = NSPoint(x: 0, y: CGFloat(page) * geometry.paper.height)
                let (layout, index) = pages[page]
                layout.draw(page: index, at: origin)
                if let header = layout.section.header {
                    PrintSectionLayout.drawHeader(header, number: page + 1, geometry: geometry, at: origin)
                }
            }
        }
    }
}

/// Pages written straight into a PDF file, one at a time.
final class PDFPageWriter {
    let paper: NSSize
    private let context: CGContext
    private(set) var pageCount = 0

    init(url: URL, paper: NSSize, title: String) throws {
        self.paper = paper
        var box = CGRect(origin: .zero, size: paper)
        let info = [kCGPDFContextTitle as String: title, kCGPDFContextCreator as String: "Drifting Native Lab"] as CFDictionary
        guard let context = CGContext(url as CFURL, mediaBox: &box, info) else {
            throw LabError.message("无法创建“\(url.lastPathComponent)”，请换一个位置再试。")
        }
        self.context = context
    }

    /// Draws one page in a flipped context with its top-left corner at the origin.
    func page(_ draw: () -> Void) {
        context.beginPDFPage(nil)
        context.saveGState()
        context.translateBy(x: 0, y: paper.height)
        context.scaleBy(x: 1, y: -1)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
        NSAppearance(named: .aqua)?.performAsCurrentDrawingAppearance(draw)
        NSGraphicsContext.restoreGraphicsState()
        context.restoreGState()
        context.endPDFPage()
        pageCount += 1
    }

    func close() { context.closePDF() }
}

// MARK: Printing and PDF export

/// Where a PDF export is.
struct PDFExportProgress: Equatable {
    enum Phase: Equatable { case reading, typesetting }
    let phase: Phase
    /// Chapters read, or sections set.
    let done: Int
    let total: Int
    /// Pages written so far.
    let pages: Int

    var fraction: Double {
        let share = total > 0 ? Double(done) / Double(total) : 1
        return phase == .reading ? 0.4 * share : 0.4 + 0.6 * share
    }
    var text: String {
        phase == .reading ? "正在读取正文：\(done) / \(total) 章" : "正在排版：已写入 \(pages) 页"
    }
}

struct PDFExportResult: Equatable {
    let url: URL
    let pages: Int
    let paper: PrintPaper
}

enum PrintError: LocalizedError, Equatable {
    case cancelled
    var errorDescription: String? { "已取消导出 PDF，没有写入文件。" }
}

/// 导出 PDF 的进度: what is being done, a bar and 取消.
final class MacPrintProgressSheet: NSObject {
    let window: NSWindow
    let label = NSTextField(labelWithString: "正在准备导出…")
    let bar = NSProgressIndicator()
    let cancelButton = NSButton(title: "取消", target: nil, action: nil)
    var onCancel: (() -> Void)?

    init(title: String) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 120), styleMask: [.titled], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        window.title = "导出 PDF"
        super.init()
        let heading = NSTextField(labelWithString: "正在导出《\(title)》")
        heading.font = .systemFont(ofSize: 13, weight: .semibold)
        heading.lineBreakMode = .byTruncatingMiddle
        label.textColor = .secondaryLabelColor
        label.setAccessibilityIdentifier("pdf-export-progress")
        bar.isIndeterminate = false
        bar.minValue = 0; bar.maxValue = 1
        bar.style = .bar
        cancelButton.target = self; cancelButton.action = #selector(cancel)
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.setAccessibilityIdentifier("pdf-export-cancel")
        let buttons = NSStackView(views: [NSView(), cancelButton])
        let stack = NSStackView(views: [heading, label, bar, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 18, left: 20, bottom: 16, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor), stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor), stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            bar.widthAnchor.constraint(equalToConstant: 340), buttons.widthAnchor.constraint(equalTo: bar.widthAnchor),
        ])
        window.contentView = content
    }

    func update(_ progress: PDFExportProgress) {
        label.stringValue = progress.text
        bar.doubleValue = progress.fraction
    }

    @objc func cancel() {
        cancelButton.isEnabled = false
        label.stringValue = "正在取消…"
        onCancel?()
    }
}

/// 文件 › 打印… (⌘P) prints the focused chapter, drift or page in the
/// editor's typography with page numbers through the standard print panel
/// (存储为 PDF included). 文件 › 导出 PDF… writes the whole book in reading
/// order: a title page, act pages, each chapter from a new page, with the
/// book's title and page numbers in the header, on A4 or Letter from the
/// print setup. Bodies come from `readProjection` (open owners give their
/// live text); no owner opens and nothing is written to the workspace.
final class MacPrintCoordinator {
    struct Target: Equatable {
        let projectID: String
        /// `chapter`, `drift`, `element`, `storyline` or `category`.
        let kind: String
        let id: String
        let title: String
    }

    private let workspace: LabWorkspaceCore
    var onStatus: ((String) -> Void)?
    /// Runs a print operation; nil shows the print panel (a sheet on the
    /// window). Acceptance runs it without panels.
    var runPrintOperation: ((NSPrintOperation, NSWindow?) -> Void)?
    /// Chooses the PDF's destination; nil uses a save panel. Acceptance answers here.
    var choosePDFDestination: ((NSWindow?, String, PrintPaper, @escaping (URL?) -> Void) -> Void)?
    /// Every progress step of an export, e.g. for acceptance to cancel it.
    var onProgress: ((PDFExportProgress) -> Void)?
    /// The paper setup the book PDF follows; 文件 › 页面设置… edits it.
    var printInfo: () -> NSPrintInfo = { NSPrintInfo.shared }
    /// How long input on its way to Rust may take before printing refuses.
    var inputWait: TimeInterval = 3
    /// The typography prose is set in; 设置's editor typography by default.
    var typography: () -> DocumentTypography = { DocumentStyle.typography }
    private(set) var isBusy = false
    private(set) var progressSheet: MacPrintProgressSheet?
    private var cancelled = false

    init(workspace: LabWorkspaceCore) { self.workspace = workspace }

    /// Runs once no view has input on its way to Rust (or refuses after `inputWait`).
    private func afterInput(_ purpose: String, deadline: Date? = nil, _ run: @escaping (Result<Void, Error>) -> Void) {
        let deadline = deadline ?? Date().addingTimeInterval(inputWait)
        if !workspace.hasQueuedInput && !workspace.isChangingOwners { run(.success(())); return }
        guard Date() < deadline else {
            run(.failure(LabError.message("正文还在保存，请结束输入后再\(purpose)。"))); return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.afterInput(purpose, deadline: deadline, run) }
    }

    // MARK: 打印…

    /// Prints a page's body under its title. The completion reports the
    /// number of pages laid out for the paper the operation started with.
    func print(_ target: Target, window: NSWindow?, completion: ((Result<Int, Error>) -> Void)? = nil) {
        guard !isBusy else { completion?(.failure(LabError.message("正在导出 PDF，请稍后再打印。"))); return }
        isBusy = true
        let finish: (Result<Int, Error>) -> Void = { [weak self] result in
            self?.isBusy = false
            if case .failure(let error) = result { self?.onStatus?(error.localizedDescription) }
            completion?(result)
        }
        afterInput("打印") { [weak self] ready in
            guard let self else { return }
            if case .failure(let error) = ready { finish(.failure(error)); return }
            self.workspace.readProjection(projectID: target.projectID, kind: target.kind, id: target.id) { [weak self] result in
                guard let self else { return }
                switch result {
                case .failure(let error): finish(.failure(error))
                case .success(let body):
                    let operation = self.printOperation(target, body: body.projection)
                    let pages = (operation.view as? PrintPagesView)?.pageCount ?? 0
                    self.isBusy = false
                    if let run = self.runPrintOperation { run(operation, window) }
                    else if let window { operation.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil) }
                    else { operation.run() }
                    completion?(.success(pages))
                }
            }
        }
    }

    /// The page's title and body on pages of the print setup's paper, the
    /// title and page number in each page's header.
    func printOperation(_ target: Target, body: WorkspaceBodyProjection.Projection) -> NSPrintOperation {
        let typesetter = PrintTypesetter(typography: typography())
        let text = NSMutableAttributedString(attributedString: typesetter.title(target.title, size: typesetter.headingSize(1) * 32 / 28))
        text.append(typesetter.following(typesetter.body(body), after: text))
        let info = (printInfo().copy() as? NSPrintInfo) ?? NSPrintInfo()
        info.topMargin = 0; info.bottomMargin = 0; info.leftMargin = 0; info.rightMargin = 0
        info.isHorizontallyCentered = false; info.isVerticallyCentered = false
        info.horizontalPagination = .clip; info.verticalPagination = .clip
        let view = PrintPagesView(sections: [PrintSection(text: text, header: target.title)], paper: info.paperSize)
        let operation = NSPrintOperation(view: view, printInfo: info)
        operation.jobTitle = target.title
        operation.showsPrintPanel = true
        operation.showsProgressPanel = true
        operation.printPanel.options.formUnion([.showsPaperSize, .showsOrientation, .showsScaling, .showsPreview])
        return operation
    }

    // MARK: 导出 PDF…

    /// Asks for a destination, then writes the book.
    func beginPDFExport(project: WorkspaceProject, window: NSWindow?, completion: ((Result<PDFExportResult, Error>) -> Void)? = nil) {
        guard !isBusy else { onStatus?("正在打印或导出 PDF，请等它完成。"); return }
        let paper = PrintPaper.from(printInfo().paperSize)
        let name = project.name.replacingOccurrences(of: "/", with: "／").replacingOccurrences(of: ":", with: "：")
        let finish: (URL?) -> Void = { [weak self] url in
            guard let self, let url else { return }
            self.exportPDF(project: project, to: url, paper: paper, window: window, completion: completion)
        }
        if let choosePDFDestination { choosePDFDestination(window, name, paper, finish); return }
        let panel = NSSavePanel()
        panel.title = "导出 PDF"
        panel.message = "按整书大纲的顺序导出书名页、幕和每一章，使用编辑器当前的字体与排版，纸张 \(paper.name)（可在“文件 › 页面设置…”中更改）。"
        panel.prompt = "导出"
        panel.canCreateDirectories = true
        panel.allowedContentTypes = [.pdf]
        panel.nameFieldStringValue = name + ".pdf"
        let done: (NSApplication.ModalResponse) -> Void = { response in finish(response == .OK ? panel.url : nil) }
        if let window { panel.beginSheetModal(for: window, completionHandler: done) } else { done(panel.runModal()) }
    }

    /// 取消 of the progress sheet: stops before the next read or page and
    /// leaves no file behind.
    func cancelExport() { if isBusy { cancelled = true } }

    /// Reads the project, its outline and every chapter's body, then sets
    /// and writes pages a few at a time, so the window stays responsive and
    /// 取消 is heard. The file appears at `url` only when complete.
    func exportPDF(project: WorkspaceProject, to url: URL, paper: PrintPaper, window: NSWindow?,
                   completion: ((Result<PDFExportResult, Error>) -> Void)? = nil) {
        guard !isBusy else { completion?(.failure(LabError.message("已有一个导出正在进行。"))); return }
        isBusy = true
        cancelled = false
        let sheet = MacPrintProgressSheet(title: project.name)
        progressSheet = sheet
        sheet.onCancel = { [weak self] in self?.cancelExport() }
        // A short export finishes before the sheet would show.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self, weak window] in
            guard let self, self.progressSheet === sheet, self.isBusy, let window, sheet.window.sheetParent == nil else { return }
            window.beginSheet(sheet.window)
        }
        let finish: (Result<PDFExportResult, Error>) -> Void = { [weak self] result in
            guard let self else { return }
            self.isBusy = false
            self.cancelled = false
            if let parent = sheet.window.sheetParent { parent.endSheet(sheet.window) }
            if self.progressSheet === sheet { self.progressSheet = nil }
            switch result {
            case .success(let exported): self.onStatus?("PDF 已导出：\(exported.url.lastPathComponent)（\(exported.pages) 页，\(exported.paper.name)）")
            case .failure(let error): self.onStatus?(error.localizedDescription)
            }
            completion?(result)
        }
        onStatus?("正在导出 PDF…")
        afterInput("导出 PDF") { [weak self] ready in
            guard let self else { return }
            if case .failure(let error) = ready { finish(.failure(error)); return }
            self.workspace.projectDetails(projectID: project.id) { [weak self] result in
                guard let self else { return }
                if self.cancelled { finish(.failure(PrintError.cancelled)); return }
                let details: WorkspaceProjectDetails
                switch result {
                case .success(let value): details = value
                case .failure(let error): finish(.failure(error)); return
                }
                self.workspace.outline(projectID: project.id) { [weak self] outline in
                    guard let self else { return }
                    if self.cancelled { finish(.failure(PrintError.cancelled)); return }
                    switch outline {
                    case .failure(let error): finish(.failure(error))
                    case .success(let rows):
                        self.read(rows, projectID: project.id, into: [:]) { [weak self] bodies in
                            guard let self else { return }
                            switch bodies {
                            case .failure(let error): finish(.failure(error))
                            case .success(let bodies):
                                self.write(details: details, rows: rows, bodies: bodies, to: url, paper: paper, completion: finish)
                            }
                        }
                    }
                }
            }
        }
    }

    private func report(_ progress: PDFExportProgress) {
        progressSheet?.update(progress)
        onProgress?(progress)
    }

    /// Reads chapter bodies one after another in book order.
    private func read(_ rows: [WorkspaceOutlineEntry], projectID: String, into bodies: [String: WorkspaceBodyProjection.Projection],
                      completion: @escaping (Result<[String: WorkspaceBodyProjection.Projection], Error>) -> Void) {
        let chapters = rows.filter { $0.kind == "chapter" }
        if bodies.isEmpty { report(PDFExportProgress(phase: .reading, done: 0, total: chapters.count, pages: 0)) }
        if cancelled { completion(.failure(PrintError.cancelled)); return }
        guard let next = chapters.first(where: { bodies[$0.id] == nil }) else { completion(.success(bodies)); return }
        workspace.readProjection(projectID: projectID, kind: "chapter", id: next.id) { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                completion(.failure(LabError.message("无法读取《\(next.title)》的正文：\(error.localizedDescription)")))
            case .success(let body):
                var bodies = bodies
                bodies[next.id] = body.projection
                self.report(PDFExportProgress(phase: .reading, done: bodies.count, total: chapters.count, pages: 0))
                self.read(rows, projectID: projectID, into: bodies, completion: completion)
            }
        }
    }

    /// The book's sections in reading order: the title page, then each act
    /// and chapter of the outline.
    static func bookSections(name: String, summary: String, rows: [WorkspaceOutlineEntry],
                             bodies: [String: WorkspaceBodyProjection.Projection],
                             typesetter: PrintTypesetter) -> [() -> PrintSection] {
        var sections: [() -> PrintSection] = [{
            let text = NSMutableAttributedString(attributedString: typesetter.title(name, size: typesetter.typography.size * 2.4,
                                                                                    centered: true, after: typesetter.typography.size * 2))
            let brief = summary.trimmingCharacters(in: .whitespacesAndNewlines)
            if !brief.isEmpty { text.append(typesetter.following(typesetter.note(brief), after: text)) }
            return PrintSection(text: text, header: nil, lead: 0.28)
        }]
        for row in rows {
            if row.kind == "act" {
                sections.append {
                    PrintSection(text: typesetter.title(row.title, size: typesetter.typography.size * 2, centered: true), header: nil, lead: 0.3)
                }
            } else if row.kind == "chapter" {
                let body = bodies[row.id]
                sections.append {
                    let text = NSMutableAttributedString(attributedString: typesetter.title(row.title, size: typesetter.typography.headingSize(1)))
                    if let body { text.append(typesetter.following(typesetter.body(body), after: text)) }
                    return PrintSection(text: text, header: name)
                }
            }
        }
        return sections
    }

    /// Sets and writes pages for about 25 ms per turn of the run loop into
    /// a temporary file, then moves it into place.
    private func write(details: WorkspaceProjectDetails, rows: [WorkspaceOutlineEntry],
                       bodies: [String: WorkspaceBodyProjection.Projection], to url: URL, paper: PrintPaper,
                       completion: @escaping (Result<PDFExportResult, Error>) -> Void) {
        let typesetter = PrintTypesetter(typography: typography(), headingShift: 1)
        let sections = Self.bookSections(name: details.name, summary: details.summary, rows: rows, bodies: bodies, typesetter: typesetter)
        let geometry = PrintGeometry(paper: paper.size)
        let folder: URL
        let writer: PDFPageWriter
        do {
            folder = (try? FileManager.default.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: url, create: true))
                ?? FileManager.default.temporaryDirectory.appendingPathComponent("drifting-pdf-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            writer = try PDFPageWriter(url: folder.appendingPathComponent(url.lastPathComponent), paper: paper.size, title: details.name)
        } catch {
            completion(.failure(error)); return
        }
        let temporary = folder.appendingPathComponent(url.lastPathComponent)
        let discard = { try? FileManager.default.removeItem(at: folder) }
        var index = 0
        var layout: PrintSectionLayout?
        var drawn = 0
        func step() {
            if cancelled {
                writer.close(); discard()
                completion(.failure(PrintError.cancelled)); return
            }
            let deadline = Date().addingTimeInterval(0.025)
            repeat {
                if layout == nil {
                    guard index < sections.count else {
                        writer.close()
                        do {
                            if FileManager.default.fileExists(atPath: url.path) {
                                _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary)
                            } else {
                                try FileManager.default.moveItem(at: temporary, to: url)
                            }
                            discard()
                            completion(.success(PDFExportResult(url: url, pages: writer.pageCount, paper: paper)))
                        } catch {
                            discard()
                            completion(.failure(LabError.message("无法写入“\(url.lastPathComponent)”，请换一个位置再试。")))
                        }
                        return
                    }
                    layout = PrintSectionLayout(sections[index](), geometry: geometry)
                    drawn = 0
                }
                guard let current = layout else { return }
                if drawn == current.containers.count, !current.layoutPage() {
                    layout = nil
                    index += 1
                    report(PDFExportProgress(phase: .typesetting, done: index, total: sections.count, pages: writer.pageCount))
                    continue
                }
                let number = writer.pageCount + 1
                writer.page {
                    current.draw(page: drawn, at: .zero)
                    if let header = current.section.header {
                        PrintSectionLayout.drawHeader(header, number: number, geometry: geometry, at: .zero)
                    }
                }
                drawn += 1
            } while Date() < deadline && !cancelled
            DispatchQueue.main.async(execute: step)
        }
        report(PDFExportProgress(phase: .typesetting, done: 0, total: sections.count, pages: 0))
        DispatchQueue.main.async(execute: step)
    }
}
