import AppKit
import PDFKit

/// 打印…, 导出 PDF… and 设置 › 快捷键 through the real print coordinator,
/// tab host, Rust workspace and SQLite, the real menu layout and settings
/// pane. PDFs go to a temporary folder and are read back with PDFKit; the
/// print panel is not shown and nothing reaches a printer. Every name, title
/// and body is synthetic.
extension BindingAcceptance {
    static func printKeysAcceptance() throws -> [String] {
        let saved = (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay)
        defer {
            (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay) = saved
            LabSettingsStore.restoreUnconfigured()
        }
        DocumentStore.entityLinkDelay = 0.05
        MacChapterWorkspace.backlinkDelay = 0.05
        try printTypesetting()
        try printFocusedPages()
        try pdfBookExport()
        try pdfExportProgressAndCancellation()
        try shortcutRecording()
        try shortcutPersistence()
        return [
            "AppKit print typesetting sets headings, bold and italic, strike, inline and block code, quotes by odd depth, bulleted lists by even depth with continuation paragraphs, links and a rule from a projection, entity links and unsupported blocks as plain text or nothing, in black whatever the appearance",
            "AppKit 打印 prints the focused drift and element page from readProjection in 设置's typography under the page title with the title and page number in every page's header through NSPrintOperation, lays out again for the operation's paper, reads an open owner's live text, opens no owner and writes no journal row",
            "AppKit 导出 PDF writes the whole book in reading order on A4 or Letter from the print setup: a title page with name and summary, act pages, every chapter from a new page, shifted body headings, bold and italic as font traits, entity links as plain text, the book title and page numbers in the header, 设置's font, size, line height and first-line indent, and an open chapter's unsaved text, with no journal row and no new owner",
            "AppKit 导出 PDF reports reading and typesetting progress, waits for queued input and includes it, 取消 while reading or typesetting leaves no file at or beside the destination and keeps an existing file untouched, and a finished export replaces it",
            "AppKit 设置 › 快捷键 lists the installed menu's commands by menu with ⇧⌘I for Copilot 分析 and ⌥⌘I for 项目资料, records a pressed combination into the menu item's key equivalent at once so the menu performs it, refuses a conflict, system-reserved and text-editing shortcuts and one without ⌘ or ⌃ while recording continues, cancels with Esc, removes with ⌫, and resets one (refusing a default another command now uses) and all",
            "AppKit 快捷键 persist in settings.json and apply to a new menu and the settings window at relaunch, while a hand-edited file's reserved, unreadable and conflicting entries fall back without losing the others or an unknown command's entry",
        ]
    }

    // MARK: Harness

    private final class PrintHarness {
        let root: URL
        let directory: URL
        let output: URL
        let journal: JournalProbe
        let workspace: LabWorkspaceCore
        let project: WorkspaceProject
        let window: NSWindow
        let host: MacChapterWorkspace
        let printing: MacPrintCoordinator
        let settings: LabSettingsStore

        init(name: String) throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            directory = root.appendingPathComponent("apple-native-lab")
            output = root.appendingPathComponent("exports", isDirectory: true)
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            journal = JournalProbe(directory: directory)
            let workspace = LabWorkspaceCore(directory: directory)
            self.workspace = workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(listed.isEmpty, "Print fixture was not isolated")
            project = try BindingAcceptance.elementResult { workspace.createProject(name: name, completion: $0) }
            (window, host) = BindingAcceptance.elementHost(workspace)
            printing = MacPrintCoordinator(workspace: workspace)
            // 设置 as the author left it: an installed family, 19 pt, 1.8, two-character indent.
            settings = LabSettingsStore(directory: root)
            let family = LabSettingsStore.fontExists(family: "Georgia") ? "Georgia" : "Times New Roman"
            settings.update {
                $0.fontSource = .systemCustom; $0.systemFontFamily = family
                $0.fontSize = 19; $0.lineHeight = 1.8; $0.paragraphIndent = .two
            }
        }

        var family: String { settings.settings.systemFontFamily }

        func cleanup() {
            if host.canNavigate { let _: Bool? = try? BindingAcceptance.elementResult { host.close(completion: $0) } }
            window.close()
            try? FileManager.default.removeItem(at: root)
        }

        @discardableResult
        func chapter(_ title: String, _ blocks: [BookImportBlock]) throws -> WorkspaceChapter {
            let entity: WorkspaceImportedEntity = try BindingAcceptance.elementResult {
                workspace.importBlocks(projectID: project.id, title: title, target: .chapter, blocks: blocks, completion: $0)
            }
            guard case .chapter(let chapter) = entity else { throw LabError.message("Import did not create a chapter") }
            return chapter
        }

        func act(at chapter: WorkspaceChapter, named name: String) throws {
            let act: WorkspaceAct = try BindingAcceptance.elementResult {
                workspace.createAct(projectID: project.id, chapterID: chapter.id, completion: $0)
            }
            let _: WorkspaceAct = try BindingAcceptance.elementResult {
                workspace.renameAct(projectID: project.id, actID: act.id, name: name, completion: $0)
            }
        }

        func settled(_ views: NativeDocumentView...) throws {
            try BindingAcceptance.wait {
                !self.host.isBusy && views.allSatisfy {
                    $0.binding.state != nil && !$0.binding.hasPendingWork && !$0.binding.store.hasScheduledLinks && !$0.binding.store.isLinking
                }
            }
        }

        func type(_ view: NativeDocumentView, _ text: String) {
            let end = (view.textView.string as NSString).length
            view.textView.setSelectedRange(NSRange(location: end, length: 0))
            view.textView.insertText(text, replacementRange: NSRange(location: end, length: 0))
        }

        func export(to url: URL, paper: PrintPaper = .a4) throws -> PDFExportResult {
            try BindingAcceptance.elementResult {
                printing.exportPDF(project: project, to: url, paper: paper, window: nil, completion: $0)
            }
        }
    }

    /// A PDF page's header (the top margin) and body text, NFKC-normalised:
    /// Quartz's text extraction maps glyphs CJK fonts share with Kangxi
    /// radicals to the radicals (Songti even reads 口 as ⼜), so the
    /// synthetic text avoids the characters NFKC cannot bring back.
    private struct PDFPageText {
        let header: String
        let body: String
        var bodyLines: [String] { body.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
        var firstLine: String { bodyLines.first ?? "" }
    }

    private static func normalized(_ text: String) -> String { (text as NSString).precomposedStringWithCompatibilityMapping }
    private static func squeezed(_ text: String) -> String { normalized(text).components(separatedBy: .whitespacesAndNewlines).joined() }

    private static func pdfPages(_ url: URL) throws -> (PDFDocument, [PDFPageText]) {
        guard let document = PDFDocument(url: url) else { throw LabError.message("PDFKit could not open \(url.lastPathComponent)") }
        let pages = (0..<document.pageCount).compactMap { document.page(at: $0) }.map { page -> PDFPageText in
            let box = page.bounds(for: .mediaBox)
            let header = page.selection(for: CGRect(x: 0, y: box.height - 62, width: box.width, height: 62))?.string ?? ""
            let body = page.selection(for: CGRect(x: 0, y: 0, width: box.width, height: box.height - 62))?.string ?? ""
            return PDFPageText(header: normalized(header).trimmingCharacters(in: .whitespacesAndNewlines), body: normalized(body))
        }
        return (document, pages)
    }

    /// The font PDFKit reads for the first occurrence of `text` below the header.
    private static func pdfFont(_ page: PDFPage, _ text: String) -> NSFont? {
        guard let attributed = page.attributedString else { return nil }
        let string = normalized(attributed.string) as NSString
        let top = page.bounds(for: .mediaBox).height - 62
        var from = 0
        while from < string.length {
            let found = string.range(of: text, range: NSRange(location: from, length: string.length - from))
            guard found.location != NSNotFound else { return nil }
            if let bounds = page.selection(for: found)?.bounds(for: page), bounds.maxY < top {
                return attributed.attribute(.font, at: found.location, effectiveRange: nil) as? NSFont
            }
            from = NSMaxRange(found)
        }
        return nil
    }

    private static func traits(_ font: NSFont?) -> NSFontTraitMask { font.map { NSFontManager.shared.traits(of: $0) } ?? [] }

    /// Each line's bounds, top first, from the first `start` to the last `end` after it.
    private static func pdfLineRects(_ page: PDFPage, from start: String, to end: String) throws -> [CGRect] {
        guard let string = page.string.map(normalized) as NSString? else { throw LabError.message("PDF page has no text") }
        let first = string.range(of: start), last = string.range(of: end, options: .backwards)
        try require(first.location != NSNotFound && last.location != NSNotFound && NSMaxRange(last) >= first.location,
                    "“\(start.prefix(24))” is not on the PDF page")
        let found = NSRange(location: first.location, length: NSMaxRange(last) - first.location)
        guard let selection = page.selection(for: found) else { throw LabError.message("No selection for “\(start.prefix(24))”") }
        return selection.selectionsByLine().map { $0.bounds(for: page) }.sorted { $0.minY > $1.minY }
    }

    private static func count(_ directory: URL, _ table: String) throws -> Int64 {
        guard case .integer(let value)? = try WorkspaceRemoteProseFixture.query(in: directory, sql: "SELECT COUNT(*) AS n FROM \(table)").first?["n"] else {
            throw LabError.message("Count query returned no row")
        }
        return value
    }

    // MARK: Typesetting

    private static func printTypesetting() throws {
        let typography = DocumentTypography(face: .systemSerif, size: 18, lineSpacing: 9, paragraphSpacing: 13, paragraphIndent: 36,
                                            language: "zh-Hans")
        // (kind, depth, container, text, runs as (substring, marks)).
        let blocks: [(String, Int, String, String, [(String, [String: Any])])] = [
            ("heading", 0, "doc", "雾中港口", [("港口", ["italic": [String: Any]()])]),
            ("paragraph", 0, "doc", "粗体与斜体混排的一段。", [("粗体", ["bold": [String: Any]()]), ("斜体", ["italic": [String: Any]()])]),
            ("paragraph", 1, "quote", "引用的一句话", []),
            ("paragraph", 2, "item-1", "第一项", []),
            ("paragraph", 2, "item-1", "第一项的续段", []),
            ("paragraph", 2, "item-2", "第二项", []),
            ("codeBlock", 0, "doc", "let tide = 1", []),
            ("horizontalRule", 0, "doc", "\u{fffc}", []),
            ("image", 0, "doc", "\u{fffc}", []),
            ("paragraph", 0, "doc", "删去 网址 灯塔守人 行内码", [
                ("删去", ["strike": [String: Any]()]), ("网址", ["link--abcd1234": ["href": "https://example.com/port"]]),
                ("灯塔守人", ["entityLink--12345678": ["targetId": "synthetic-element", "targetKind": "element"]]),
                ("行内码", ["code": [String: Any]()]),
            ]),
        ]
        var text = "", jsonBlocks: [[String: Any]] = []
        for (index, block) in blocks.enumerated() {
            if index > 0 { text += "\n" }
            let location = (text as NSString).length
            text += block.3
            let runs: [[String: Any]] = block.4.map { run in
                let at = (block.3 as NSString).range(of: run.0)
                return ["range": ["location": location + at.location, "length": at.length], "attributes": run.1]
            }
            var json: [String: Any] = ["kind": block.0, "depth": block.1, "container": block.2,
                                       "range": ["location": location, "length": (block.3 as NSString).length], "runs": runs]
            if block.0 == "heading" { json["attributes"] = ["id": "h", "level": 1.0] }
            jsonBlocks.append(json)
        }
        let data = try JSONSerialization.data(withJSONObject: ["text": text, "blocks": jsonBlocks])
        let projection = try JSONDecoder().decode(WorkspaceBodyProjection.Projection.self, from: data)
        try require(projection.blocks[0].level == 1 && projection.blocks[9].runs[1].attributes.href == "https://example.com/port"
                    && projection.blocks[9].runs[2].attributes.names == ["entityLink"], "The projection's marks and levels were not decoded")
        let dark = NSAppearance(named: .darkAqua)!
        var result = NSAttributedString()
        dark.performAsCurrentDrawingAppearance { result = PrintTypesetter(typography: typography, headingShift: 1).body(projection) }
        let string = result.string as NSString
        try require(result.string == "雾中港口\n粗体与斜体混排的一段。\n引用的一句话\n•\t第一项\n第一项的续段\n•\t第二项\nlet tide = 1\n＊　＊　＊\n删去 网址 灯塔守人 行内码",
                    "Typeset text was \(result.string.debugDescription)")
        // Containers name the structure: an ordered list numbers from its
        // start, a list inside a quote keeps the quote's indent.
        let orderedJSON: [String: Any] = ["text": "三\n四\n引中的点", "blocks": [
            ["kind": "paragraph", "depth": 2, "container": "a", "range": ["location": 0, "length": 1], "runs": [],
             "containers": ["orderedList", "listItem"], "listNumber": 3],
            ["kind": "paragraph", "depth": 2, "container": "b", "range": ["location": 2, "length": 1], "runs": [],
             "containers": ["orderedList", "listItem"], "listNumber": 4],
            ["kind": "paragraph", "depth": 3, "container": "c", "range": ["location": 4, "length": 4], "runs": [],
             "containers": ["blockquote", "bulletList", "listItem"]],
        ]]
        let ordered = try JSONDecoder().decode(WorkspaceBodyProjection.Projection.self,
                                               from: JSONSerialization.data(withJSONObject: orderedJSON))
        let numbered = PrintTypesetter(typography: typography, headingShift: 1).body(ordered)
        try require(numbered.string == "3.\t三\n4.\t四\n•\t引中的点", "Ordered and quoted lists typeset as \(numbered.string.debugDescription)")
        let quotedStyle = numbered.attribute(.paragraphStyle, at: (numbered.string as NSString).range(of: "引中").location,
                                             effectiveRange: nil) as! NSParagraphStyle
        try require(quotedStyle.headIndent > typography.size * 2 && quotedStyle.tailIndent < 0,
                    "A list inside a quote lost the quote's indent: \(quotedStyle)")
        func at(_ piece: String) throws -> [NSAttributedString.Key: Any] {
            let found = string.range(of: piece)
            try require(found.location != NSNotFound, "“\(piece)” was not typeset")
            return result.attributes(at: found.location, effectiveRange: nil)
        }
        func font(_ piece: String) throws -> NSFont { try at(piece)[.font] as! NSFont }
        func paragraph(_ piece: String) throws -> NSParagraphStyle { try at(piece)[.paragraphStyle] as! NSParagraphStyle }
        func color(_ piece: String) throws -> NSColor? { try at(piece)[.foregroundColor] as? NSColor }
        // A level-1 body heading is set at the second level below a chapter heading.
        let heading = try font("雾中"), weights = heading.fontDescriptor.object(forKey: .traits) as? [NSFontDescriptor.TraitKey: Any]
        try require(heading.pointSize == typography.headingSize(2) && ((weights?[.weight] as? CGFloat) ?? 0) > 0.2,
                    "Body heading is not the shifted semibold level: \(heading)")
        try require(try traits(font("粗体")).contains(.boldFontMask) && font("粗体").pointSize == 18, "Bold run lost its weight")
        try require(try traits(font("斜体")).contains(.italicFontMask) && font("港口").pointSize == heading.pointSize,
                    "Italic runs were not set apart")
        try require(try paragraph("粗体与").firstLineHeadIndent == 36 && (try paragraph("粗体与")).lineSpacing == 9,
                    "Body paragraphs lost 设置's indent or line spacing")
        try require(try color("引用") == PrintTypesetter.muted && (try paragraph("引用")).headIndent == 36 && (try paragraph("引用")).tailIndent < 0,
                    "The quote is not indented and muted")
        let first = try paragraph("第一项\n"), continued = try paragraph("第一项的续段"), second = try paragraph("第二项")
        try require(first.firstLineHeadIndent < first.headIndent && continued.firstLineHeadIndent == first.headIndent
                    && continued.headIndent == first.headIndent && second.headIndent == first.headIndent, "List items do not hang their bullets")
        try require((try font("let tide")).isFixedPitch && (try at("let tide"))[.backgroundColor] as? NSColor == PrintTypesetter.codeWash,
                    "The code block is not monospaced on a wash")
        try require((try paragraph("＊")).alignment == .center, "The rule is not centred")
        try require((try at("删去"))[.strikethroughStyle] as? Int == NSUnderlineStyle.single.rawValue, "Strike was lost")
        try require(try color("网址") == PrintTypesetter.linkColor && (try at("网址"))[.underlineStyle] as? Int == NSUnderlineStyle.single.rawValue,
                    "The link is not styled")
        try require(try color("灯塔守人") == PrintTypesetter.ink && (try at("灯塔守人"))[.underlineStyle] == nil,
                    "The entity link is not plain text")
        try require((try font("行内码")).isFixedPitch, "Inline code is not monospaced")
        try require((try at("删去"))[DocumentStyle.languageKey] as? String == "zh-Hans", "The manuscript language was not set")
        try require(try color("粗体") == PrintTypesetter.ink, "Dark appearance leaked into the printed ink")
    }

    // MARK: 打印…

    private static func printFocusedPages() throws {
        let harness = try PrintHarness(name: "雾港纪事")
        defer { harness.cleanup() }
        let paragraphs = (1...36).map { "漂流段落 \(String(format: "%02d", $0))：Harbour fog rolls over the quay while the bell answers the tide." }
        let entity: WorkspaceImportedEntity = try elementResult {
            harness.workspace.importBlocks(projectID: harness.project.id, title: "潮汐手记", target: .drift,
                                           blocks: paragraphs.map { BookImportBlock.paragraph($0) }, completion: $0)
        }
        guard case .drift(let drift) = entity else { throw LabError.message("Import did not create a drift") }
        let view: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, drift: drift, completion: $0) }
        try harness.settled(view)
        harness.type(view, "尚在窗前的尾句。")
        try harness.settled(view)
        guard let target = harness.host.activeHistoryTarget, target.kind == "drift", target.id == drift.id else {
            throw LabError.message("The focused page is not the drift")
        }
        let owners = harness.workspace.openDocumentCount, mark = try harness.journal.mark()
        let letter = NSPrintInfo()
        letter.paperSize = PrintPaper.letter.size
        harness.printing.printInfo = { letter }
        var operationView: PrintPagesView?
        var paperChange: NSSize?
        var saved: [URL] = []
        harness.printing.runPrintOperation = { operation, _ in
            let url = harness.output.appendingPathComponent("print-\(saved.count).pdf")
            if let paperChange { operation.printInfo.paperSize = paperChange }
            operation.printInfo.jobDisposition = .save
            operation.printInfo.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = url
            operation.showsPrintPanel = false
            operation.showsProgressPanel = false
            operationView = operation.view as? PrintPagesView
            if operation.run() { saved.append(url) }
        }
        let printTarget = MacPrintCoordinator.Target(projectID: target.projectID, kind: target.kind, id: target.id, title: target.title)
        let laidOut: Int = try elementResult { harness.printing.print(printTarget, window: nil, completion: $0) }
        try require(saved.count == 1, "The print operation did not save its PDF")
        let (document, pages) = try pdfPages(saved[0])
        try require(document.pageCount == laidOut && laidOut >= 2 && operationView?.pageCount == laidOut,
                    "The drift printed \(document.pageCount) pages, laid out \(laidOut)")
        try require(document.page(at: 0)!.bounds(for: .mediaBox).size == PrintPaper.letter.size, "The print did not use the chosen paper")
        try require(pages[0].firstLine == "潮汐手记", "The printed page does not start with its title: \(pages[0].firstLine)")
        for (index, page) in pages.enumerated() {
            try require(page.header.hasPrefix("潮汐手记") && page.header.hasSuffix("\(index + 1)"),
                        "Page \(index + 1)'s header is “\(page.header)”")
        }
        let printed = squeezed(pages.map(\.body).joined())
        var cursor = printed.startIndex
        for paragraph in paragraphs + ["尚在窗前的尾句。"] {
            guard let found = printed.range(of: squeezed(paragraph), range: cursor..<printed.endIndex) else {
                throw LabError.message("“\(paragraph)” is missing or out of order in the print")
            }
            cursor = found.upperBound
        }
        let firstPage = document.page(at: 0)!
        let titleFont = pdfFont(firstPage, "潮汐手记"), bodyFont = pdfFont(firstPage, "Harbour")
        try require(bodyFont?.familyName == harness.family && bodyFont?.pointSize == 19, "The print is not in 设置's font: \(String(describing: bodyFont))")
        try require(abs((titleFont?.pointSize ?? 0) - DocumentStyle.typography.headingSize(1) * 32 / 28) < 0.01,
                    "The printed title is \(String(describing: titleFont?.pointSize)) pt")
        // The panel's paper change lays the pages out again.
        paperChange = PrintPaper.a4.size
        let _: Int = try elementResult { harness.printing.print(printTarget, window: nil, completion: $0) }
        let (a4, _) = try pdfPages(saved[1])
        try require(PrintPaper.from(a4.page(at: 0)!.bounds(for: .mediaBox).size) == .a4 && operationView.map { PrintPaper.from($0.geometry.paper) } == .a4
                    && abs(a4.page(at: 0)!.bounds(for: .mediaBox).height - 842) < 1,
                    "The print did not lay out again for the panel's paper: \(a4.page(at: 0)!.bounds(for: .mediaBox)) \(String(describing: operationView?.geometry))")
        paperChange = nil
        // An element page prints the same way.
        let category: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            harness.workspace.createElementCategory(projectID: harness.project.id, name: "人物", completion: $0)
        }
        let made: WorkspaceImportedEntity = try elementResult {
            harness.workspace.importBlocks(projectID: harness.project.id, title: "守灯人", target: .element(categoryID: category.result!.id),
                                           blocks: [.heading("来历", level: 1), .paragraph("守灯人在北塔住了二十年。")], completion: $0)
        }
        guard case .element(let element) = made else { throw LabError.message("Import did not create an element") }
        let page: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, element: element, completion: $0) }
        try harness.settled(page)
        guard let elementTarget = harness.host.activeHistoryTarget, elementTarget.kind == "element" else {
            throw LabError.message("The focused page is not the element")
        }
        let elementOwners = harness.workspace.openDocumentCount, elementMark = try harness.journal.mark()
        let _: Int = try elementResult {
            harness.printing.print(.init(projectID: elementTarget.projectID, kind: "element", id: elementTarget.id, title: elementTarget.title),
                                   window: nil, completion: $0)
        }
        let (_, elementPages) = try pdfPages(saved[2])
        try require(elementPages.count == 1 && elementPages[0].bodyLines.prefix(3).map(squeezed) == ["守灯人", "来历", "守灯人在北塔住了二十年。"],
                    "The element page printed \(elementPages.map(\.bodyLines))")
        let after = try harness.journal.mark()
        try require(harness.workspace.openDocumentCount == elementOwners && elementOwners == owners + 1 && after == elementMark,
                    "Printing opened an owner or wrote the journal")
        try require(try harness.journal.originals(since: mark).allSatisfy { !$0.isEmpty }, "Journal rows are unreadable")
    }

    // MARK: 导出 PDF…

    private static func pdfBookExport() throws {
        let harness = try PrintHarness(name: "雾港纪事")
        defer { harness.cleanup() }
        let _: WorkspaceProjectDetails = try elementResult {
            harness.workspace.updateProject(projectID: harness.project.id, changes: WorkspaceProjectChanges(summary: "一座雾中港城的三段往事。"),
                                            completion: $0)
        }
        let measure = String(repeating: "Harbour fog drifts across the old quay and settles on the lamps. ", count: 6).trimmingCharacters(in: .whitespaces)
        let openingText = "开篇 boldword 与 italicword 以及北塔。" as NSString
        func mark(_ kind: BookImportMark.Kind, _ piece: String) -> BookImportMark {
            let found = openingText.range(of: piece)
            return BookImportMark(kind: kind, location: found.location, length: found.length)
        }
        let opening = try harness.chapter("序章", [
            .paragraph(openingText as String, marks: [mark(.bold, "boldword"), mark(.italic, "italicword"), mark(.bold, "北塔")]),
            .heading("细节", level: 1),
            .paragraph(measure),
        ])
        let long = (1...48).map { "段落 \(String(format: "%02d", $0))：雨夜里钟声响起，潮水一次次漫过石阶，守灯人数着浪。" }
        let rain = try harness.chapter("雨夜", long.map { BookImportBlock.paragraph($0) })
        let homecoming = try harness.chapter("归航", [.paragraph("船在灯塔守人的注视下靠岸。")])
        try harness.act(at: opening, named: "第一幕 雾起")
        try harness.act(at: homecoming, named: "第二幕 潮落")
        // 归航 is open in a tab and names an element, so its link pass marks it.
        let category: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            harness.workspace.createElementCategory(projectID: harness.project.id, name: "人物", completion: $0)
        }
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            harness.workspace.createElement(projectID: harness.project.id, categoryID: category.result!.id, name: "灯塔守人", completion: $0)
        }
        harness.host.loadNames(projectID: harness.project.id)
        let view: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, chapter: homecoming, completion: $0) }
        try harness.settled(view)
        try wait { view.binding.store.projection?.blocks.flatMap(\.runs).contains { $0.attributes.entityLink } == true }
        try harness.settled(view)
        let owners = harness.workspace.openDocumentCount, mark = try harness.journal.mark()
        let url = harness.output.appendingPathComponent("雾港纪事.pdf")
        let result = try harness.export(to: url)
        try require(result.pages > 0 && result.paper == .a4 && FileManager.default.fileExists(atPath: url.path), "The PDF was not written")
        let after = try harness.journal.mark()
        try require(harness.workspace.openDocumentCount == owners && after == mark, "Exporting opened an owner or wrote the journal")
        let (document, pages) = try pdfPages(url)
        try require(document.pageCount == result.pages && document.page(at: 0)!.bounds(for: .mediaBox).size == PrintPaper.a4.size,
                    "The PDF has \(document.pageCount) pages of the wrong paper")
        // Title page, then 幕 and chapters each on a new page.
        try require(pages[0].header.isEmpty && pages[0].bodyLines.map(squeezed) == ["雾港纪事", "一座雾中港城的三段往事。"],
                    "The title page reads \(pages[0].bodyLines) under “\(pages[0].header)”")
        try require(pages[1].header.isEmpty && pages[1].bodyLines.map(squeezed) == ["第一幕雾起"], "The first act page reads \(pages[1].bodyLines)")
        try require(pages[2].firstLine == "序章" && pages[3].firstLine == "雨夜", "Chapters do not start new pages: \(pages.map(\.firstLine))")
        guard let secondAct = pages.firstIndex(where: { $0.bodyLines.map(squeezed) == ["第二幕潮落"] }) else {
            throw LabError.message("The second act has no page: \(pages.map(\.bodyLines))")
        }
        try require(secondAct >= 5 && pages[secondAct].header.isEmpty && secondAct + 2 == pages.count && pages[secondAct + 1].firstLine == "归航",
                    "雨夜 did not continue onto more pages before 第二幕: \(pages.map(\.firstLine))")
        for index in 2..<pages.count where index != secondAct {
            try require(pages[index].header.hasPrefix("雾港纪事") && pages[index].header.hasSuffix("\(index + 1)"),
                        "Page \(index + 1)'s header is “\(pages[index].header)”")
        }
        for index in 4..<secondAct {
            try require(!["序章", "雨夜", "归航"].contains(pages[index].firstLine), "A continuation page starts with a heading")
        }
        // Body text in reading order, the linked name as plain prose.
        let book = squeezed(pages.map(\.body).joined())
        var cursor = book.startIndex
        for piece in ["开篇boldword与italicword以及北塔。", "细节", squeezed(measure)] + long.map(squeezed) + ["船在灯塔守人的注视下靠岸。"] {
            guard let found = book.range(of: piece, range: cursor..<book.endIndex) else {
                throw LabError.message("“\(piece.prefix(20))” is missing or out of order in the PDF")
            }
            cursor = found.upperBound
        }
        let typography = DocumentStyle.typography
        let openingPage = document.page(at: 2)!
        let bold = pdfFont(openingPage, "boldword"), italic = pdfFont(openingPage, "italicword"), plain = pdfFont(openingPage, "开篇")
        try require(traits(bold).contains(.boldFontMask) && bold?.familyName == harness.family, "Bold is not a bold face: \(String(describing: bold))")
        try require(traits(italic).contains(.italicFontMask) && italic?.familyName == harness.family, "Italic is not an italic face: \(String(describing: italic))")
        try require(traits(pdfFont(openingPage, "北塔")).contains(.boldFontMask), "Bold CJK is not a bold face")
        try require(!traits(plain).contains(.boldFontMask) && plain?.pointSize == typography.size, "Body text is not 设置's size")
        try require(abs((pdfFont(openingPage, "序章")?.pointSize ?? 0) - typography.headingSize(1)) < 0.01
                    && abs((pdfFont(openingPage, "细节")?.pointSize ?? 0) - typography.headingSize(2)) < 0.01, "Heading levels are not shifted")
        try require(abs((pdfFont(document.page(at: 0)!, "雾港纪事")?.pointSize ?? 0) - typography.size * 2.4) < 0.01, "The title page's name is not set large")
        // 设置's line height and two-character first-line indent.
        let lines = try pdfLineRects(openingPage, from: "Harbour fog drifts across", to: "settles on the lamps.")
        let heading = try pdfLineRects(openingPage, from: "序章", to: "序章")
        let body = DocumentStyle.font(typography, size: typography.size, weight: .regular, italic: false, monospaced: false)
        let pitch = NSLayoutManager().defaultLineHeight(for: body) + typography.lineSpacing
        try require(lines.count >= 3 && zip(lines, lines.dropFirst()).allSatisfy { abs(($0.minY - $1.minY) - pitch) < 1.5 },
                    "Lines are not \(pitch) pt apart: \(lines.map(\.minY))")
        try require(abs(lines[0].minX - heading[0].minX - typography.paragraphIndent) < 1.5 && abs(lines[1].minX - heading[0].minX) < 1.5,
                    "The first-line indent is not \(typography.paragraphIndent) pt")
        // An open chapter's unsaved text: its saves fail, the owner keeps it.
        try WorkspaceRemoteProseFixture.execute(in: harness.directory,
            sql: "CREATE TRIGGER fail_print_save BEFORE INSERT ON sync_change_set BEGIN SELECT RAISE(ABORT, 'synthetic save failure'); END")
        harness.type(view, "尚未保存的尾声。")
        try wait { view.binding.state?.saveError != nil && !view.binding.store.hasQueuedInput }
        let unsaved = harness.output.appendingPathComponent("未保存.pdf")
        let letter = try harness.export(to: unsaved, paper: .letter)
        let (unsavedDocument, unsavedPages) = try pdfPages(unsaved)
        try require(letter.paper == .letter && unsavedDocument.page(at: 0)!.bounds(for: .mediaBox).size == PrintPaper.letter.size
                    && squeezed(unsavedPages.last!.body).contains("船在灯塔守人的注视下靠岸。尚未保存的尾声。"),
                    "The open chapter's unsaved text is missing from the PDF")
        try WorkspaceRemoteProseFixture.execute(in: harness.directory, sql: "DROP TRIGGER fail_print_save")
        view.binding.retrySave()
        try harness.settled(view)
        _ = rain
    }

    private static func pdfExportProgressAndCancellation() throws {
        let harness = try PrintHarness(name: "潮声集")
        defer { harness.cleanup() }
        var chapters: [WorkspaceChapter] = []
        for number in 1...12 {
            chapters.append(try harness.chapter("第\(number)章", (1...30).map {
                .paragraph("第\(number)章第\($0)段：潮声在夜里一遍遍拍打着石岸，远处的灯一明一灭。")
            }))
        }
        try harness.act(at: chapters[0], named: "上卷")
        let url = harness.output.appendingPathComponent("潮声集.pdf")
        var progress: [PDFExportProgress] = []
        var cancelAt: ((PDFExportProgress) -> Bool)?
        harness.printing.onProgress = { step in
            progress.append(step)
            if cancelAt?(step) == true { harness.printing.progressSheet?.cancelButton.performClick(nil) }
        }
        func refused(_ step: String) throws {
            let error = try elementRefused({ (done: @escaping (Result<PDFExportResult, Error>) -> Void) in
                harness.printing.exportPDF(project: harness.project, to: url, paper: .a4, window: nil, completion: done)
            }, "\(step) was not cancelled")
            try require(error == PrintError.cancelled.localizedDescription, "\(step) failed instead: \(error)")
            let left = try FileManager.default.contentsOfDirectory(atPath: harness.output.path)
            try require(left.isEmpty || left == ["潮声集.pdf"], "\(step) left \(left)")
            try require(!harness.printing.isBusy && harness.printing.progressSheet == nil, "\(step) kept the export busy")
        }
        // 取消 while reading.
        cancelAt = { $0.phase == .reading && $0.done == 3 }
        try refused("Cancelling while reading")
        try require(!FileManager.default.fileExists(atPath: url.path), "Cancelling while reading wrote a file")
        try require(progress.last?.phase == .reading && progress.filter { $0.phase == .reading }.map(\.done) == [0, 1, 2, 3]
                    && progress.allSatisfy { $0.total == 12 }, "Reading progress was \(progress)")
        // 取消 while typesetting, with an earlier file at the destination.
        let earlier = Data("earlier export".utf8)
        try earlier.write(to: url)
        progress = []
        cancelAt = { $0.phase == .typesetting && $0.pages >= 4 }
        try refused("Cancelling while typesetting")
        try require(try Data(contentsOf: url) == earlier, "Cancelling replaced the earlier file")
        let typesetting = progress.filter { $0.phase == .typesetting }
        try require(progress.filter { $0.phase == .reading }.count == 13 && typesetting.count >= 2
                    && zip(typesetting, typesetting.dropFirst()).allSatisfy { $0.fraction <= $1.fraction && $0.pages <= $1.pages },
                    "Typesetting progress was \(typesetting)")
        // Queued input is waited for and printed; the finished export replaces the earlier file.
        cancelAt = nil
        let view: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, chapter: chapters[11], completion: $0) }
        try harness.settled(view)
        harness.type(view, "排队中的最后一句。")
        try require(harness.workspace.hasQueuedInput, "The typed text was not queued")
        let exported: PDFExportResult = try elementResult {
            harness.printing.exportPDF(project: harness.project, to: url, paper: .a4, window: nil, completion: $0)
        }
        let (document, pages) = try pdfPages(url)
        try require(document.pageCount == exported.pages && exported.pages > 12 + 2, "The finished export has \(exported.pages) pages")
        try require(squeezed(pages.last!.body).hasSuffix("排队中的最后一句。"), "Queued input was not waited for")
        try require(try FileManager.default.contentsOfDirectory(atPath: harness.output.path) == ["潮声集.pdf"],
                    "The finished export left temporary files")
    }

    // MARK: 快捷键

    private final class MenuProbe: NSObject {
        private(set) var fired: [String] = []
        @objc func fire(_ sender: NSMenuItem) { fired.append(sender.identifier?.rawValue ?? "") }
    }

    private static func key(_ characters: String, _ flags: NSEvent.ModifierFlags, code: UInt16, typed: String? = nil) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                         windowNumber: 0, context: nil, characters: typed ?? characters, charactersIgnoringModifiers: characters,
                         isARepeat: false, keyCode: code)!
    }

    private static func requireMenu(_ menu: NSMenu, _ command: MacMenuCommand, _ key: String, _ flags: NSEvent.ModifierFlags,
                                    _ context: String) throws {
        guard let item = MacMainMenu.item(command, in: menu) else { throw LabError.message("\(context): no menu item for \(command)") }
        let expected = MenuShortcut(key: key, flags: flags).menuKey
        try require(item.keyEquivalent == expected && (key.isEmpty || item.keyEquivalentModifierMask == flags),
                    "\(context): \(command.rawValue) is “\(item.keyEquivalent)” \(item.keyEquivalentModifierMask.rawValue)")
    }

    private static func shortcutRecording() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = LabSettingsStore(directory: root)
        let probe = MenuProbe()
        let menu = MacMainMenu.build(Dictionary(uniqueKeysWithValues: MacMenuCommand.allCases.filter { $0.responderAction == nil }
            .map { ($0, MacMainMenu.Action(#selector(MenuProbe.fire(_:)), probe)) }))
        let applier = MacShortcutApplier(store: store, menu: menu)
        // Defaults: the current menu's shortcuts, none shared.
        let defaults = MacMenuCommand.allCases.map(\.defaultShortcut).filter { !$0.isNone }
        try require(Set(defaults).count == defaults.count, "Two commands share a default shortcut")
        try requireMenu(menu, .copilot, "i", [.command, .shift], "Default")
        try requireMenu(menu, .fileProfile, "i", [.command, .option], "Default")
        try requireMenu(menu, .italic, "i", .command, "Default")
        try requireMenu(menu, .print, "p", .command, "Default")
        try requireMenu(menu, .shelf, "p", [.command, .shift], "Default")
        try requireMenu(menu, .pageSetup, "", [], "Default")
        try require(MacMainMenu.item(.exportPDF, in: menu)?.title == "导出 PDF…", "The file menu has no 导出 PDF…")
        let pane = MacShortcutSettingsViewController(store: store)
        pane.menuSource = { menu }
        _ = pane.view
        try require(pane.listed.map(\.title) == ["应用", "文件", "项目", "编辑", "格式", "视图", "帮助"],
                    "Groups are \(pane.listed.map(\.title))")
        for (group, (title, commands)) in zip(MacMainMenu.layout, pane.listed) {
            let items = MacMainMenu.submenu(group.title, in: menu)?.items.filter { !$0.isSeparatorItem } ?? []
            try require(commands.map(\.command) == group.items.compactMap { $0 } && commands.map(\.title) == items.map(\.title),
                        "\(title) lists \(commands.map(\.title)) for \(items.map(\.title))")
        }
        try require(pane.shortcutButtons[.copilot]?.title == "⇧⌘I" && pane.shortcutButtons[.fileProfile]?.title == "⌥⌘I"
                    && pane.shortcutButtons[.pageSetup]?.title == "无" && pane.shortcutButtons[.copy]?.isEnabled == false,
                    "The pane shows the wrong shortcuts")
        // Record ⌥⌘P for 打印… by clicking its shortcut and pressing it.
        pane.shortcutButtons[.print]!.performClick(nil)
        try require(pane.recording == .print && pane.shortcutButtons[.print]?.title == "请按下快捷键…", "Clicking did not start recording")
        let optionP = key("p", [.command, .option], code: 35, typed: "π")
        try require(pane.record(optionP) && pane.recording == nil, "The press was not recorded")
        try requireMenu(menu, .print, "p", [.command, .option], "Recorded")
        try require(store.settings.shortcuts["file.print"] == MenuShortcut(key: "p", flags: [.command, .option])
                    && pane.shortcutButtons[.print]?.title == "⌥⌘P", "The recorded shortcut was not saved or shown")
        try require(menu.performKeyEquivalent(with: optionP) && probe.fired == ["menu.file.print"], "The menu did not perform the new shortcut")
        let oldPerformed = menu.performKeyEquivalent(with: key("p", .command, code: 35))
        try require(!oldPerformed && probe.fired.count == 1, "The old shortcut still prints: \(oldPerformed) \(probe.fired)")
        // ⇧⌘P stays the 项目书架's: a shifted letter is matched as uppercase.
        try require(menu.performKeyEquivalent(with: key("P", [.command, .shift], code: 35)) && probe.fired.last == "menu.project.shelf",
                    "⇧⌘P did not open the 项目书架: \(probe.fired)")
        // Refusals keep recording and change nothing.
        let before = store.settings.shortcuts
        pane.beginRecording(.fileProfile)
        for (event, expected) in [
            (key("i", [.command, .shift], code: 34), "编辑 › Copilot 分析"), (key("q", .command, code: 12), "由系统保留"),
            (key("w", .command, code: 13), "由系统保留"), (key("\t", .command, code: 48), "由系统保留"), (key("h", .command, code: 4), "由系统保留"),
            (key("c", .command, code: 8), "文本编辑快捷键（复制）"), (key("z", [.command, .shift], code: 6), "文本编辑快捷键（重做）"),
            (key("k", [], code: 40), "需要包含 ⌘ 或 ⌃"), (key("k", [.option], code: 40, typed: "˚"), "需要包含 ⌘ 或 ⌃"),
            (key("p", [.command, .option], code: 35), "文件 › 打印…"),
        ] {
            try require(pane.record(event) && pane.recording == .fileProfile && pane.message.stringValue.contains(expected)
                        && pane.message.textColor == .systemRed, "Refusal “\(expected)” read “\(pane.message.stringValue)”")
        }
        try require(store.settings.shortcuts == before, "A refusal changed the stored shortcuts")
        try requireMenu(menu, .fileProfile, "i", [.command, .option], "Refused")
        try require(pane.record(key("\u{1b}", [], code: 53)) && pane.recording == nil && store.settings.shortcuts == before, "Esc did not cancel")
        pane.beginRecording(.copy)
        try require(pane.recording == nil && pane.message.stringValue.contains("系统命令"), "A system command started recording")
        // ⌫ removes Copilot's shortcut; 项目资料 may then take ⇧⌘I.
        pane.beginRecording(.copilot)
        try require(pane.record(key("\u{7f}", [], code: 51)), "⌫ was not handled")
        try requireMenu(menu, .copilot, "", [], "Removed")
        try require(pane.shortcutButtons[.copilot]?.title == "无" && store.settings.shortcuts["edit.copilot"] == MenuShortcut.unassigned,
                    "The removal was not saved")
        pane.beginRecording(.fileProfile)
        try require(pane.record(key("i", [.command, .shift], code: 34)) && pane.recording == nil, "The freed shortcut was refused")
        try requireMenu(menu, .fileProfile, "i", [.command, .shift], "Moved")
        pane.reset(.copilot)
        try require(pane.message.stringValue.contains("无法还原") && pane.message.stringValue.contains("文件 › 项目资料…"),
                    "Resetting onto a used default read “\(pane.message.stringValue)”")
        try requireMenu(menu, .copilot, "", [], "Refused reset")
        pane.reset(.fileProfile)
        pane.reset(.copilot)
        try requireMenu(menu, .fileProfile, "i", [.command, .option], "Reset")
        try requireMenu(menu, .copilot, "i", [.command, .shift], "Reset")
        try require(pane.resetButtons[.copilot]?.isHidden == true && pane.resetButtons[.print]?.isHidden == false, "Reset buttons are wrong")
        // ⌃⌘K is taken; 全部还原 restores every default.
        pane.beginRecording(.storylines)
        try require(pane.record(key("k", [.command, .control], code: 40)), "⌃⌘K was not recorded")
        try requireMenu(menu, .storylines, "k", [.command, .control], "Control")
        let file = try String(contentsOf: store.fileURL, encoding: .utf8)
        try require(file.contains("\"shortcuts\"") && file.contains("edit.storylines") && file.contains("file.print"), "settings.json lacks the shortcuts")
        pane.resetAllButton.performClick(nil)
        try require(store.settings.shortcuts.isEmpty && pane.resetAllButton.isEnabled == false, "全部还原 kept overrides")
        for command in MacMenuCommand.allCases {
            try requireMenu(menu, command, command.defaultShortcut.key, command.defaultShortcut.flags, "Reset all")
        }
        withExtendedLifetime(applier) {}
    }

    private static func shortcutPersistence() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let first = LabSettingsStore(directory: root)
        first.update { $0.fontSize = 21 }
        first.setShortcut(MenuShortcut(key: "p", flags: [.command, .option]), for: .print)
        first.setShortcut(.unassigned, for: .copilot)
        first.setShortcut(MenuShortcut(key: "i", flags: [.command, .shift]), for: .fileProfile)
        first.setShortcut(MenuShortcut(key: "p", flags: .command), for: .pageSetup)
        // Relaunch: a new store, the menu AppDelegate installs and its applier.
        let second = LabSettingsStore(directory: root)
        try require(second.settings.shortcuts == first.settings.shortcuts && second.settings.fontSize == 21
                    && second.settings.shortcuts["edit.copilot"] == .unassigned, "Shortcuts did not survive relaunch")
        let menu = MacMainMenu.build([:])
        let applier = MacShortcutApplier(store: second, menu: menu)
        try requireMenu(menu, .print, "p", [.command, .option], "Relaunch")
        try requireMenu(menu, .pageSetup, "p", .command, "Relaunch")
        try requireMenu(menu, .copilot, "", [], "Relaunch")
        try requireMenu(menu, .fileProfile, "i", [.command, .shift], "Relaunch")
        // The settings window lists the installed main menu.
        let previousMenu = NSApp.mainMenu
        NSApp.mainMenu = menu
        defer { NSApp.mainMenu = previousMenu }
        let window = MacSettingsWindowController(store: second)
        window.showShortcutPane()
        _ = window.shortcutPane.view
        window.shortcutPane.refresh()
        try require(window.shortcutPane.title == "快捷键" && window.shortcutPane.shortcutButtons[.print]?.title == "⌥⌘P"
                    && window.shortcutPane.listed.count == MacMainMenu.layout.count, "The settings window does not list the menu")
        window.close()
        // A hand-edited file: reserved, unreadable and conflicting entries fall back one by one.
        var json = try JSONSerialization.jsonObject(with: Data(contentsOf: second.fileURL)) as! [String: Any]
        json["shortcuts"] = [
            "file.print": ["key": "q", "modifiers": ["command"]],
            "edit.search": ["key": 5],
            "view.review": ["key": "b", "modifiers": ["shift", "command"]],
            "view.agent": ["key": "j", "modifiers": ["command", "control"]],
            "future.command": ["key": "j", "modifiers": ["command", "option"]],
        ]
        try JSONSerialization.data(withJSONObject: json).write(to: second.fileURL)
        let edited = LabSettingsStore(directory: root)
        try require(edited.settings.shortcuts.keys.sorted() == ["future.command", "view.agent", "view.review"] && edited.settings.fontSize == 21,
                    "The hand-edited file read as \(edited.settings.shortcuts)")
        let editedMenu = MacMainMenu.build([:])
        let editedApplier = MacShortcutApplier(store: edited, menu: editedMenu)
        try requireMenu(editedMenu, .print, "p", .command, "Reserved entry")
        try requireMenu(editedMenu, .search, "f", [.command, .shift], "Unreadable entry")
        try requireMenu(editedMenu, .agent, "j", [.command, .control], "Valid entry")
        try requireMenu(editedMenu, .review, "b", [.command, .shift], "Conflicting entry")
        try requireMenu(editedMenu, .wholeBook, "", [], "Conflicting default")
        edited.setShortcut(MenuShortcut(key: "k", flags: [.command, .control]), for: .agent)
        let saved = try String(contentsOf: edited.fileURL, encoding: .utf8)
        try require(saved.contains("future.command") && !saved.contains("edit.search"), "Saving lost an unknown command's entry")
        edited.resetAllShortcuts()
        try require(edited.settings.shortcuts.keys.sorted() == ["future.command"], "全部还原 dropped an unknown command's entry")
        try requireMenu(editedMenu, .wholeBook, "b", [.command, .shift], "Reset all")
        withExtendedLifetime((applier, editedApplier)) {}
    }
}
