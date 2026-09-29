import AppKit
import PDFKit

/// 引用, 无序列表 and 有序列表 through real editors in the tab host, the shared
/// input queue, the Rust workspace and SQLite: the 格式 menu, an assigned
/// shortcut, the toolbar, the context submenu, the slash menu and
/// Markdown-style starts; Rust's refusals; Return and ⌫ at the ends of
/// quotes and lists; the drawn indents and list markers in both panes, the
/// 全书长卷, printing and the 历史版本 preview; and a cold reopen. Nothing is
/// shown on screen; every name and body is synthetic.
extension BindingAcceptance {
    static let quotesListsCases = [
        "AppKit 引用, 无序列表 and 有序列表 toggle through the 格式 menu, shortcuts assigned in 设置 › 快捷键, the toolbar, the prose context menu's 格式 submenu and the slash menu, checked for the caret's block, each as one undo unit that keeps the text, block IDs and a comment anchored on the wrapped paragraph, with both panes drawing the quote indent and the numbered and bulleted markers, and all of it survives a cold reopen",
        "AppKit typing “> ”, “- ”, “* ” or “1. ” as the whole text before the caret in a root paragraph (also an empty chapter, and with text after the caret) removes the marker through the input path and then quotes or lists the paragraph as two undo units, also when typing goes on at once, while “3. ”, a marker inside a sentence and a marker in a quote change nothing",
        "AppKit Rust's quote and list refusals (the middle of a quote or list, the other list kind, a quote around a list item, a list inside a quote, a mixed selection, an item of two paragraphs) show Chinese guidance and write nothing, and deleting across list items is refused before input is queued, leaving no failed draft",
        "AppKit Return in a non-empty list item starts the next item once its new paragraph lands (at an item's end, in its middle and while typing goes on at once), and Return on that empty last item ends the list, one undo unit each; Return in a quote adds a paragraph to the quote, Return on an empty last quote paragraph, also typed while input is queued, and ⌫ at the start of a quote's first paragraph or of the first or last list item take the block out as one undo unit each, while ⌫ at a middle item is refused before input is queued",
        "AppKit 打印 and the PDF export set quotes muted and indented and list items with their numbers and bullets from the live projection; the 全书长卷's editor rows and read-only previews and the 历史版本 preview draw the same markers",
        "AppKit 分隔线 goes in from 格式 › 插入分隔线 after the caret's block (the caret in the new paragraph) and from the slash menu before an empty paragraph, and out through 删除分隔线 in its context menu, ⌫ at the start of the paragraph after it (also while typed text is on its way) and ⌦ at the end of the one before it, each one undo unit with the caret where Rust puts it; typing over it is refused, and it is drawn as a centred thin line, never the placeholder, in both panes, the 全书长卷's editor rows and previews, the 历史版本 preview and print, and survives a cold reopen",
        "AppKit the slash menu in a list item or a quote offers only the formats that apply there, a slash row whose format stopped applying before it was chosen keeps the typed “/”, and the list-marker drawing log stays bounded",
        quotesListsJoinCase,
        quotesListsReviewCase,
        quotesListsExitCase,
    ]

    static let quotesListsExitCase = "AppKit Return on an empty last paragraph of a list's last item ends the list in one step with exitList, one undo unit that keeps the item's other paragraphs in place: in an item of three paragraphs, in a lone empty item (an emptied list goes with it), and pressed twice after an item's text while the first Return is still queued (the waiting exit replaces the split); Return in an empty last paragraph of a middle item keeps the ordinary new line without a refusal, a list in a quote right after an item does not read as nested in it, and the result survives a cold reopen"

    static let quotesListsReviewCase = "AppKit rule and list review fixes: ⌫ removing a rule with typing right after it keeps the typed text in order and the caret after it (a stale rule caret is dropped), ⌦ before a rule keeps the caret where it was, a format refusal over read-only content no longer reads as a rule refusal, and Return after an item's paragraph followed by a nested list keeps the ordinary new line instead of splitting the item"

    static let quotesListsJoinCase = "AppKit a list built one paragraph at a time joins the list right before it (one list numbered 1–3, one undo unit each) and a paragraph right before a list joins it at the start; ⌫ in the empty paragraph a Return left after the list and ⌦ at the end of the list's last item remove that paragraph as one undo unit with the caret at the item's end; a heading made a list is refused with Chinese guidance writing nothing (the slash menu does not offer lists there) while 引用 still takes it; and the undo refusal over another writer's text reads in Chinese"

    static func quotesListsAcceptance() throws -> [String] {
        let saved = (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay)
        defer { (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay) = saved }
        DocumentStore.entityLinkDelay = 0.05
        MacChapterWorkspace.backlinkDelay = 0.05
        try qlToggles()
        try qlMarkdownStarts()
        try qlRefusals()
        try qlEnterAndBackspace()
        try qlPrintingAndPreviews()
        try qlListItemSplits()
        try qlRules()
        try qlSlashContext()
        try qlJoinsAndExit()
        try qlReviewFixes()
        try qlExitList()
        return quotesListsCases
    }

    // MARK: Harness

    private struct QLPage {
        let directory: URL
        let workspace: LabWorkspaceCore
        let project: WorkspaceProject
        let chapter: WorkspaceChapter
        let window: NSWindow
        let host: MacChapterWorkspace
        let view: NativeDocumentView
        let core: LabCore

        func close() throws {
            if host.canNavigate {
                let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
                try BindingAcceptance.require(closed, "The workspace did not close")
            }
            window.close()
        }
        func remove() { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
    }

    private static func qlPage(_ text: String) throws -> QLPage {
        let (directory, workspace, project, chapter) = try elementFixture()
        let (window, host) = elementHost(workspace)
        host.elementsChanged(projectID: project.id)
        let view: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
        try qlSettled(host, view)
        guard let core = host.activeCore else { throw LabError.message("The chapter has no owner") }
        if !text.isEmpty { qlType(view, text); try qlSettled(host, view) }
        return QLPage(directory: directory, workspace: workspace, project: project, chapter: chapter, window: window, host: host,
                      view: view, core: core)
    }

    private static func qlSettled(_ host: MacChapterWorkspace, _ views: NativeDocumentView...) throws {
        try wait {
            !host.isBusy && views.allSatisfy {
                $0.binding.state != nil && !$0.binding.hasPendingWork && !$0.binding.store.hasScheduledLinks
                    && !$0.binding.store.isLinking && $0.deferredFormat == nil && $0.pendingMarkdownStarts == 0
            }
        }
    }

    private static func qlType(_ view: NativeDocumentView, _ text: String, at location: Int? = nil) {
        let at = location ?? (view.textView.string as NSString).length
        view.textView.setSelectedRange(NSRange(location: at, length: 0))
        view.textView.insertText(text, replacementRange: NSRange(location: at, length: 0))
    }

    private static func qlAt(_ text: String, in view: NativeDocumentView) throws -> Int {
        let found = (view.textView.string as NSString).range(of: text)
        try require(found.location != NSNotFound, "“\(text)” is not in the prose: \(view.textView.string.debugDescription)")
        return found.location
    }

    private static func qlCaret(_ view: NativeDocumentView, _ location: Int, length: Int = 0) {
        view.textView.setSelectedRange(NSRange(location: location, length: length))
    }

    private static func qlKey(_ view: NativeDocumentView, _ selector: Selector) {
        view.textView.doCommand(by: selector)
    }

    /// Each block's text, containers and number.
    private static func qlShape(_ core: LabCore) throws -> [(text: String, containers: [String], number: Int?)] {
        let projection = try read(core).projection
        let text = projection.text as NSString
        return projection.blocks.map { (text.substring(with: $0.range.nsRange), $0.containers, $0.listNumber) }
    }

    private static func qlDescribe(_ core: LabCore) -> String {
        ((try? qlShape(core)) ?? []).map { "\($0.text)\($0.containers.isEmpty ? "" : "[\($0.containers.joined(separator: ">"))\($0.number.map { " \($0)" } ?? "")]")" }
            .joined(separator: " | ")
    }

    private static func qlBlock(_ core: LabCore, containing text: String) throws -> NativeBlock {
        let projection = try read(core).projection
        let range = (projection.text as NSString).range(of: text)
        guard range.location != NSNotFound, let index = NativeLayout.index(range.location, blocks: projection.blocks) else {
            throw LabError.message("No block holds “\(text)”")
        }
        return projection.blocks[index]
    }

    /// The app's menu, its editor commands aimed at this prose.
    private static func qlMenu(_ view: NativeDocumentView) -> NSMenu {
        let menu = MacMainMenu.build([:])
        for top in menu.items {
            for item in top.submenu?.items ?? [] {
                guard let command = MacMenuCommand(identifier: item.identifier), command != .quit, command.responderAction != nil else { continue }
                item.target = view.textView
            }
        }
        return menu
    }

    private static func qlItem(_ menu: NSMenu, _ command: MacMenuCommand) throws -> NSMenuItem {
        guard let item = MacMainMenu.item(command, in: menu) else { throw LabError.message("No menu item for \(command.rawValue)") }
        item.menu?.update()
        return item
    }

    private static func qlChoose(_ menu: NSMenu, _ command: MacMenuCommand) throws {
        let item = try qlItem(menu, command)
        try require(item.isEnabled, "\(command.title) is disabled")
        guard let parent = item.menu else { throw LabError.message("\(command.title) has no menu") }
        parent.performActionForItem(at: parent.index(of: item))
    }

    private static func qlPress(_ menu: NSMenu, _ characters: String, _ flags: NSEvent.ModifierFlags, code: UInt16) throws {
        let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                     windowNumber: 0, context: nil, characters: characters, charactersIgnoringModifiers: characters,
                                     isARepeat: false, keyCode: code)!
        try require(menu.performKeyEquivalent(with: event), "The menu did not perform \(MenuShortcut(key: characters, flags: flags).display)")
    }

    private static func qlControl<T: NSView>(_ root: NSView, _ identifier: String, as type: T.Type) throws -> T {
        if let match = root as? T, root.accessibilityIdentifier() == identifier { return match }
        for child in root.subviews {
            if let found = try? qlControl(child, identifier, as: type) { return found }
        }
        throw LabError.message("No control \(identifier)")
    }

    private static func qlStatus(_ view: NativeDocumentView) throws -> String {
        try qlControl(view, "document-status", as: NSTextField.self).stringValue
    }

    private static func qlParagraph(_ view: NativeDocumentView, at index: Int) throws -> NSParagraphStyle {
        guard let style = view.textView.textStorage?.attribute(.paragraphStyle, at: index, effectiveRange: nil) as? NSParagraphStyle else {
            throw LabError.message("No paragraph style at \(index)")
        }
        return style
    }

    /// Draws the text view off screen and returns the list markers its
    /// layout manager drew, top to bottom.
    private static func qlDrawnMarkers(_ textView: NSTextView) throws -> [String] {
        guard let view = textView as? ListMarkerTextView else { throw LabError.message("The text view does not draw list markers") }
        view.drawnMarkers = []
        let bounds = view.bounds
        guard bounds.width > 1, bounds.height > 1, let rep = view.bitmapImageRepForCachingDisplay(in: bounds) else {
            throw LabError.message("The text view has no area to draw: \(bounds)")
        }
        view.cacheDisplay(in: bounds, to: rep)
        return view.drawnMarkers
    }

    /// Stored prose rows: an unchanged or refused command adds none.
    private static func qlRows(_ directory: URL) throws -> [Int64] {
        try ["yjs_updates", "yjs_document_revision_provenance"].map { table in
            guard case .integer(let value)? = try WorkspaceRemoteProseFixture.query(in: directory,
                sql: "SELECT COUNT(*) AS n FROM \(table)").first?["n"] else { throw LabError.message("Count of \(table) failed") }
            return value
        }
    }

    private static func qlContextFormat(_ view: NativeDocumentView, at index: Int) throws -> NSMenu {
        guard let window = view.window, let event = NSEvent.mouseEvent(with: .rightMouseDown, location: .zero, modifierFlags: [],
            timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1),
              let menu = view.textView(view.textView, menu: NSMenu(), for: event, at: index),
              let format = menu.items.first(where: { $0.title == "格式" })?.submenu else {
            throw LabError.message("No prose context menu with 格式")
        }
        format.update()
        return format
    }

    // MARK: Toggles

    private static func qlToggles() throws {
        let text = "序言在前。\n北岸的灯塔亮了。\n潮水退去。\n夜渡船靠岸。\n尾声。"
        let page = try qlPage(text)
        defer { page.remove() }
        let (host, view, core) = (page.host, page.view, page.core)
        let twin: NativeDocumentView = try elementResult { host.split(completion: $0) }
        try qlSettled(host, view, twin)
        let menu = qlMenu(view)
        let size = DocumentStyle.typography.size
        let ids = try read(core).projection.blocks.map(\.id)

        // The 格式 menu and 设置 › 快捷键 list the three commands without defaults.
        guard let formatGroup = MacMainMenu.groups(of: menu).first(where: { $0.title == "格式" }) else { throw LabError.message("No 格式 menu") }
        let listed = formatGroup.commands.map(\.title)
        try require(listed.contains("引用") && listed.contains("无序列表") && listed.contains("有序列表")
                    && [MacMenuCommand.blockquote, .bulletList, .orderedList].allSatisfy { $0.defaultShortcut.isNone },
                    "The 格式 menu lists \(listed)")
        let settingsRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: settingsRoot) }
        let settings = LabSettingsStore(directory: settingsRoot)
        let pane = MacShortcutSettingsViewController(store: settings)
        pane.menuSource = { menu }
        _ = pane.view
        try require(pane.listed.first(where: { $0.title == "格式" })?.commands.map(\.command).contains(.orderedList) == true
                    && pane.shortcutButtons[.blockquote]?.title == "无", "设置 › 快捷键 does not list the quote and list commands")
        // Shortcuts the author assigns: ⌃⌘Y 引用, ⌃⌘U 无序列表, ⌃⌘O 有序列表.
        settings.setShortcut(MenuShortcut(key: "y", flags: [.command, .control]), for: .blockquote)
        settings.setShortcut(MenuShortcut(key: "u", flags: [.command, .control]), for: .bulletList)
        settings.setShortcut(MenuShortcut(key: "o", flags: [.command, .control]), for: .orderedList)
        let applier = MacShortcutApplier(store: settings, menu: menu)
        defer { withExtendedLifetime(applier) {} }

        // A comment on 灯塔 before the paragraph is quoted.
        let lamp = try qlAt("灯塔", in: view)
        let revision = try read(core).projection.revision
        let comment: WorkspaceComment = try elementResult { done in
            view.addComment("灯塔的光（合成批注）", range: NSRange(location: lamp, length: 2), revision: revision, completion: done)
        }
        try qlSettled(host, view, twin)

        // 引用 from the menu over 北岸… and 潮水…: one quote, one undo unit.
        let north = try qlAt("北岸", in: view), tide = try qlAt("潮水", in: view)
        qlCaret(view, north + 1, length: tide + 1 - north - 1)
        try require((try qlItem(menu, .blockquote)).state == .off && (try qlItem(menu, .blockquote)).isEnabled, "引用 is not offered")
        try qlChoose(menu, .blockquote)
        try qlSettled(host, view, twin)
        var shape = try qlShape(core)
        try require(shape.map(\.containers) == [[], ["blockquote"], ["blockquote"], [], []] && shape.map(\.text) == text.components(separatedBy: "\n")
                    && (try read(core).projection.blocks.map(\.id)) == ids, "引用 did not quote the two paragraphs: \(qlDescribe(core))")
        for pane in [view, twin] {
            let style = try qlParagraph(pane, at: north)
            try require(abs(style.headIndent - 2 * size) < 0.01 && style.tailIndent < 0 && (try qlParagraph(pane, at: 0)).headIndent == 0
                        && pane.textView.textStorage?.attribute(.foregroundColor, at: north, effectiveRange: nil) as? NSColor == .secondaryLabelColor,
                        "A pane does not draw the quote indented and muted")
        }
        try require((try qlItem(menu, .blockquote)).state == .on, "引用 is not checked for the quote")
        qlCaret(view, 1)
        try require((try qlItem(menu, .blockquote)).state == .off, "引用 is checked outside the quote")
        qlCaret(view, 1, length: north + 1)
        try require((try qlItem(menu, .blockquote)).state == .mixed, "A half-quoted selection is not mixed")
        // The comment stays anchored on 灯塔, highlighted in both panes.
        let anchored = try read(core).projection.comments.first { $0.id == comment.id }
        try require(anchored?.status == "anchored" && anchored?.ranges.first?.nsRange == NSRange(location: lamp, length: 2)
                    && twin.textView.textStorage?.attribute(.backgroundColor, at: lamp, effectiveRange: nil) != nil,
                    "The comment lost its anchor: \(String(describing: anchored))")
        view.undoProse(); try qlSettled(host, view, twin)
        try require(try qlShape(core).allSatisfy { $0.containers.isEmpty } && (try read(core).projection.blocks.map(\.id)) == ids,
                    "One undo did not remove the quote: \(qlDescribe(core))")
        view.redoProse(); try qlSettled(host, view, twin)
        try require(try qlShape(core)[1].containers == ["blockquote"], "Redo did not restore the quote")

        // The toolbar's 引用 at a caret in the first quoted paragraph lifts it
        // before the quote; the context submenu's 引用 lifts the rest.
        qlCaret(view, north + 2)
        let quoteButton = try qlControl(view, "format-blockquote", as: NSButton.self)
        try require(quoteButton.isEnabled && quoteButton.state == .on, "The toolbar's 引用 is not on in the quote")
        quoteButton.performClick(nil)
        try qlSettled(host, view, twin)
        try require(try qlShape(core).map(\.containers) == [[], [], ["blockquote"], [], []], "The toolbar did not lift the first paragraph: \(qlDescribe(core))")
        let context = try qlContextFormat(view, at: tide)
        qlCaret(view, tide)
        context.update()
        guard let contextQuote = context.items.first(where: { $0.title == "引用" }) else { throw LabError.message("The 格式 submenu has no 引用") }
        try require(context.items.contains { $0.title == "无序列表" } && context.items.contains { $0.title == "有序列表" }, "The 格式 submenu lacks the lists")
        context.performActionForItem(at: context.index(of: contextQuote))
        try qlSettled(host, view, twin)
        try require(try qlShape(core).allSatisfy { $0.containers.isEmpty }, "The context 引用 did not lift the quote: \(qlDescribe(core))")

        // 有序列表 by its assigned shortcut over 潮水… and 夜渡…: numbered 1 and 2.
        let ferry = try qlAt("夜渡", in: view)
        qlCaret(view, tide + 1, length: ferry + 1 - tide - 1)
        try qlPress(menu, "o", [.command, .control], code: 31)
        try qlSettled(host, view, twin)
        shape = try qlShape(core)
        try require(shape[2].containers == ["orderedList", "listItem"] && shape[2].number == 1 && shape[3].number == 2
                    && shape[1].containers.isEmpty && shape[4].containers.isEmpty, "⌃⌘O did not number the two paragraphs: \(qlDescribe(core))")
        for pane in [view, twin] {
            try require(try qlDrawnMarkers(pane.textView) == ["1.", "2."], "A pane drew \(try qlDrawnMarkers(pane.textView))")
            let item = try qlParagraph(pane, at: tide)
            try require(abs(item.headIndent - 2 * size) < 0.01 && abs(item.firstLineHeadIndent - 2 * size) < 0.01,
                        "A list item is not indented two em: \(item.headIndent)")
        }
        try require((try qlItem(menu, .orderedList)).state == .on && (try qlItem(menu, .bulletList)).state == .off,
                    "The list checkmarks are wrong")
        view.undoProse(); try qlSettled(host, view, twin)
        try require(try qlShape(core).allSatisfy { $0.containers.isEmpty } && (try qlDrawnMarkers(twin.textView)).isEmpty,
                    "One undo did not remove the list")
        view.redoProse(); try qlSettled(host, view, twin)

        // ⌃⌘Y quotes 北岸…; ⌃⌘U makes 尾声 a bullet item.
        qlCaret(view, north)
        try qlPress(menu, "y", [.command, .control], code: 16)
        try qlSettled(host, view, twin)
        let end = try qlAt("尾声", in: view)
        qlCaret(view, end + 1)
        try qlPress(menu, "u", [.command, .control], code: 32)
        try qlSettled(host, view, twin)
        shape = try qlShape(core)
        try require(shape.map(\.containers) == [[], ["blockquote"], ["orderedList", "listItem"], ["orderedList", "listItem"], ["bulletList", "listItem"]],
                    "The shortcuts did not quote and list: \(qlDescribe(core))")
        try require(try qlDrawnMarkers(twin.textView) == ["1.", "2.", "•"], "The bullet is not drawn: \(try qlDrawnMarkers(twin.textView))")

        // The slash menu: 引用 on a new empty paragraph, then typed text stays quoted.
        qlType(view, "\n")
        try qlSettled(host, view, twin)
        try require(try qlShape(core).last?.containers == ["bulletList", "listItem"], "Return in the bullet item left the item")
        view.textView.doCommand(by: #selector(NSResponder.deleteBackward(_:)))
        try qlSettled(host, view, twin)
        qlCaret(view, 0)
        qlType(view, "\n", at: 0)
        try qlSettled(host, view, twin)
        qlType(view, "/", at: 0)
        qlType(view, "引", at: 1)
        try require(view.picker?.items.map(\.title) == ["引用"], "/引 lists \(view.picker?.items.map(\.title) ?? [])")
        qlKey(view, #selector(NSResponder.insertNewline(_:)))
        qlType(view, "题记", at: 0)
        try qlSettled(host, view, twin)
        shape = try qlShape(core)
        try require(shape.first?.text == "题记" && shape.first?.containers == ["blockquote"], "The slash row did not quote the paragraph: \(qlDescribe(core))")
        // The list rows filter by name and keyword.
        try require(ProsePickers.slashItems(query: "列表").map(\.title) == ["无序列表", "有序列表"]
                    && ProsePickers.slashItems(query: "ol").map(\.title) == ["有序列表"] && ProsePickers.slashItems(query: "quote").map(\.title) == ["引用"],
                    "The slash rows do not filter the lists")

        // Cold reopen: the containers, numbers, markers and the comment return.
        let expected = try read(core).projection
        try page.close()
        let cold = LabWorkspaceCore(directory: page.directory)
        let (coldWindow, coldHost) = elementHost(cold)
        defer { coldWindow.close() }
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let reopened: NativeDocumentView = try elementResult { coldHost.open(project: page.project, chapter: page.chapter, completion: $0) }
        try qlSettled(coldHost, reopened)
        guard let projection = reopened.binding.store.projection else { throw LabError.message("The reopened chapter has no projection") }
        try require(projection.text == expected.text && projection.blocks.map(\.containers) == expected.blocks.map(\.containers)
                    && projection.blocks.map(\.listNumber) == expected.blocks.map(\.listNumber) && projection.blocks.map(\.id) == expected.blocks.map(\.id),
                    "Quotes and lists did not survive a cold reopen")
        try require(projection.comments.first { $0.id == comment.id }?.status == "anchored", "The comment lost its anchor after reopening")
        try requireStyleReference(reopened.textView.textStorage!, projection, "cold quotes and lists", links: reopened.linkDirectory)
        try require(try qlDrawnMarkers(reopened.textView) == ["1.", "2.", "•"], "The reopened editor draws \(try qlDrawnMarkers(reopened.textView))")
        let closed: Bool = try elementResult { coldHost.close(completion: $0) }
        try require(closed, "The cold workspace did not close")
    }

    // MARK: Markdown starts

    private static func qlMarkdownStarts() throws {
        // An empty chapter: “- ” leaves one empty bullet item, marker drawn.
        let blank = try qlPage("")
        defer { blank.remove() }
        do {
            let (host, view, core) = (blank.host, blank.view, blank.core)
            qlType(view, "-")
            qlType(view, " ")
            try require(view.pendingMarkdownStarts == 1, "“- ” was not taken as a start")
            try qlSettled(host, view)
            try require(try qlShape(core).map(\.containers) == [["bulletList", "listItem"]] && view.textView.string.isEmpty,
                        "“- ” did not make an empty bullet item: \(qlDescribe(core))")
            try require(try qlDrawnMarkers(view.textView) == ["•"], "The empty item's marker is not drawn: \(try qlDrawnMarkers(view.textView))")
            // Two undo units: the list, then the typed marker.
            view.undoProse(); try qlSettled(host, view)
            try require(try qlShape(core).map(\.containers) == [[]] && view.textView.string.isEmpty, "One undo did not remove the list")
            view.undoProse(); try qlSettled(host, view)
            try require(view.textView.string == "- ", "A second undo did not bring back “- ”: \(view.textView.string.debugDescription)")
            view.redoProse(); try qlSettled(host, view)
            view.redoProse(); try qlSettled(host, view)
            try require(try qlShape(core).map(\.containers) == [["bulletList", "listItem"]], "Redo did not restore the list")
            qlType(view, "苹果")
            try qlSettled(host, view)
            try require(try qlDrawnMarkers(view.textView) == ["•"] && (try qlShape(core)).first?.text == "苹果", "The item's text lost its marker")
            try blank.close()
        }

        let page = try qlPage("第一段\n第二段\n第三段\n第四段\n第五段")
        defer { page.remove() }
        let (host, view, core) = (page.host, page.view, page.core)
        // Before existing text: “> ”, “1. ”, “* ” with the ideographic space, “＞ ”.
        for (paragraph, keys, kind) in [("第二段", [">", " "], "blockquote"), ("第三段", ["1", ".", " "], "orderedList"),
                                         ("第四段", ["*", "\u{3000}"], "bulletList"), ("第五段", ["＞", " "], "blockquote")] {
            var at = try qlAt(paragraph, in: view)
            for key in keys { qlType(view, key, at: at); at += (key as NSString).length }
            try qlSettled(host, view)
            let block = try qlBlock(core, containing: paragraph)
            try require(block.containers.first == kind && block.range.location == (try qlAt(paragraph, in: view))
                        && !view.textView.string.contains(keys.joined()), "“\(keys.joined())” did not start a \(kind): \(qlDescribe(core))")
        }
        try require(try qlBlock(core, containing: "第三段").listNumber == 1, "“1. ” did not number the paragraph")
        // Typing on at once, while the marker's removal is still queued.
        qlType(view, "-", at: 0)
        qlType(view, " ", at: 1)
        try require(view.pendingMarkdownStarts == 1, "“- ” was not taken as a start")
        try wait { view.pendingMarkdownStarts == 0 }
        try require(view.binding.hasPendingWork && view.deferredFormat?.action == .bulletList, "The list did not wait for the marker's removal")
        qlType(view, "新", at: 0)
        try require(view.deferredFormat != nil, "Typing on dropped the waiting list")
        try qlSettled(host, view)
        let first = try qlBlock(core, containing: "新第一段")
        try require(first.containers == ["bulletList", "listItem"], "Typing on lost the list: \(qlDescribe(core))")
        try require(try qlDrawnMarkers(view.textView) == ["•", "1.", "•"], "The editor drew \(try qlDrawnMarkers(view.textView))")

        // Nothing starts from “3. ”, a marker inside a sentence or in a quote.
        let shape = try qlShape(core).map(\.containers)
        let end = (view.textView.string as NSString).length
        qlType(view, "\n", at: end)
        try qlSettled(host, view)
        qlKey(view, #selector(NSResponder.insertNewline(_:)))
        try qlSettled(host, view)
        try require(try qlShape(core).last?.containers.isEmpty == true, "Return on the empty quote paragraph did not end the quote")
        for key in ["3", ".", " "] { qlType(view, key) }
        try require(view.pendingMarkdownStarts == 0, "“3. ” was taken as a start")
        for key in ["说", "-", " "] { qlType(view, key) }
        try require(view.pendingMarkdownStarts == 0, "A marker inside a sentence was taken as a start")
        let quoted = try qlAt("第二段", in: view)
        qlType(view, "-", at: quoted)
        qlType(view, " ", at: quoted + 1)
        try require(view.pendingMarkdownStarts == 0, "A marker in a quote was taken as a start")
        try qlSettled(host, view)
        try require(try qlShape(core).map(\.containers) == shape + [[]], "A non-start changed the structure: \(qlDescribe(core))")
        try require(view.textView.string.hasSuffix("\n3. 说- ") && view.textView.string.contains("- 第二段"), "The typed markers did not stay as text")
        try page.close()
    }

    // MARK: Refusals

    private static func qlRefusals() throws {
        let page = try qlPage("序。\n甲一。\n甲二。\n甲三。\n乙一。\n乙二。\n乙三。\n丙。")
        defer { page.remove() }
        let (host, view, core) = (page.host, page.view, page.core)
        let menu = qlMenu(view)
        func span(_ from: String, _ to: String) throws -> NSRange {
            let start = try qlAt(from, in: view), end = try qlAt(to, in: view)
            return NSRange(location: start, length: end + 1 - start)
        }
        view.textView.setSelectedRange(try span("甲一", "甲三"))
        try qlChoose(menu, .blockquote)
        try qlSettled(host, view)
        view.textView.setSelectedRange(try span("乙一", "乙三"))
        try qlChoose(menu, .orderedList)
        try qlSettled(host, view)
        try require(try qlShape(core).map(\.containers.count) == [0, 1, 1, 1, 2, 2, 2, 0], "The fixture was not set up: \(qlDescribe(core))")

        func refused(_ command: MacMenuCommand, at text: String, length: Int = 0, _ expected: String) throws {
            let rows = try qlRows(page.directory), revision = try read(core).projection.revision
            let shape = qlDescribe(core)
            qlCaret(view, try qlAt(text, in: view) + 1, length: length)
            try qlChoose(menu, command)
            try qlSettled(host, view)
            let message = view.binding.store.lastFormatRefusal ?? ""
            try require(message.contains(expected) && (try qlStatus(view)).contains(expected),
                        "\(command.title) at “\(text)” read “\(message)” / “\(try qlStatus(view))”")
            try require(try qlRows(page.directory) == rows && (try read(core).projection.revision) == revision && qlDescribe(core) == shape
                        && view.binding.canEdit && !view.binding.hasFailedDraft, "\(command.title) at “\(text)” wrote or left a failed draft")
        }
        try refused(.blockquote, at: "甲二", "只能取消引用开头或结尾的段落，或整段引用")
        try refused(.orderedList, at: "乙二", "只能取消列表开头或结尾的项目")
        try refused(.bulletList, at: "乙一", "请先取消列表再切换列表类型")
        try refused(.blockquote, at: "乙三", "列表项不能直接设为引用")
        try refused(.orderedList, at: "甲一", "引用中的段落不能直接设为列表")
        let mixed = try span("序", "甲一")
        try refused(.blockquote, at: "序", length: mixed.length - 1, "有的在引用或列表里，有的不在")

        // Return after an item's text starts the next item; undoing that one
        // unit leaves the new paragraph in the item, which then has two
        // paragraphs and cannot leave its list.
        let third = try qlAt("乙三", in: view)
        qlCaret(view, third + 3)
        qlKey(view, #selector(NSResponder.insertNewline(_:)))
        try qlSettled(host, view)
        let started = try read(core).projection.blocks.first { $0.range.location == third + 4 }
        try require(started?.containers == ["orderedList", "listItem"] && started?.listNumber == 4
                    && started?.container != (try qlBlock(core, containing: "乙三")).container,
                    "Return in the item did not start the next item: \(qlDescribe(core))")
        view.undoProse(); try qlSettled(host, view)
        qlType(view, "续", at: third + 4)
        try qlSettled(host, view)
        let item = try qlBlock(core, containing: "续")
        try require(item.containers == ["orderedList", "listItem"] && item.container == (try qlBlock(core, containing: "乙三")).container,
                    "Undoing the split did not keep the paragraph in its item: \(qlDescribe(core))")
        try refused(.orderedList, at: "续", "这个列表项有不止一段")

        // Deleting across list items is refused before any input is queued.
        let second = try qlAt("乙二", in: view)
        let rows = try qlRows(page.directory), text = view.textView.string
        qlCaret(view, second)
        view.textView.doCommand(by: #selector(NSResponder.deleteBackward(_:)))
        try require(view.textView.string == text && !view.binding.hasPendingWork && !view.binding.hasFailedDraft
                    && (try qlStatus(view)).contains("列表项之间不能合并"), "⌫ between items read “\(try qlStatus(view))”")
        view.textView.setSelectedRange(NSRange(location: second - 2, length: 4))
        view.textView.insertText("换", replacementRange: NSRange(location: second - 2, length: 4))
        try require(view.textView.string == text && !view.binding.hasPendingWork && !view.binding.hasFailedDraft,
                    "Typing over two items was not refused")
        try qlSettled(host, view)
        try require(try qlRows(page.directory) == rows, "A refused deletion wrote to the document")
        try page.close()
    }

    // MARK: Joining lists, leaving them, headings

    private static func qlJoinsAndExit() throws {
        let page = try qlPage("零。\n甲。\n乙。\n丙。\n标题。\n尾。")
        defer { page.remove() }
        let (host, view, core) = (page.host, page.view, page.core)
        let menu = qlMenu(view)
        // One paragraph at a time: each joins the list right before it.
        for text in ["甲", "乙", "丙"] {
            qlCaret(view, try qlAt(text, in: view) + 1)
            try qlChoose(menu, .orderedList)
            try qlSettled(host, view)
        }
        try require(try qlShape(core).map(\.number) == [nil, 1, 2, 3, nil, nil]
                    && Set((try qlShape(core))[1...3].map(\.containers)) == [["orderedList", "listItem"]],
                    "Lists built one at a time are not one list: \(qlDescribe(core))")
        try require(try qlDrawnMarkers(view.textView) == ["1.", "2.", "3."], "The joined list does not draw 1–3")
        view.undoProse(); try qlSettled(host, view)
        try require(try qlShape(core).map(\.number) == [nil, 1, 2, nil, nil, nil], "One undo did not take only 丙 out: \(qlDescribe(core))")
        view.redoProse(); try qlSettled(host, view)
        // A paragraph right before the list joins it at the start.
        qlCaret(view, try qlAt("零", in: view) + 1)
        try qlChoose(menu, .orderedList)
        try qlSettled(host, view)
        try require(try qlShape(core).map(\.number) == [1, 2, 3, 4, nil, nil], "零 did not join the list at its start: \(qlDescribe(core))")
        let text = view.textView.string

        // Return after 丙 starts item 5; Return on it ends the list; ⌫ in the
        // empty paragraph left after the list removes it.
        let end = try qlAt("丙", in: view) + 2
        qlCaret(view, end)
        qlKey(view, #selector(NSResponder.insertNewline(_:)))
        try qlSettled(host, view)
        qlKey(view, #selector(NSResponder.insertNewline(_:)))
        try qlSettled(host, view)
        try require(try qlShape(core).map(\.containers.count) == [2, 2, 2, 2, 0, 0, 0] && (try qlShape(core))[4].text.isEmpty,
                    "Return twice did not leave an empty paragraph after the list: \(qlDescribe(core))")
        let rows = try qlRows(page.directory)
        qlKey(view, #selector(NSResponder.deleteBackward(_:)))
        try require(!view.binding.hasFailedDraft && !(try qlStatus(view)).contains("列表项之间不能合并"),
                    "⌫ after the list was refused: \(try qlStatus(view))")
        try qlSettled(host, view)
        try require(view.textView.string == text && (try qlShape(core)).map(\.number) == [1, 2, 3, 4, nil, nil]
                    && view.textView.selectedRange() == NSRange(location: end, length: 0) && (try qlRows(page.directory)) != rows,
                    "⌫ after the list did not remove the empty paragraph: \(qlDescribe(core)) caret \(view.textView.selectedRange())")
        view.undoProse(); try qlSettled(host, view)
        try require(try qlShape(core).map(\.containers.count) == [2, 2, 2, 2, 0, 0, 0], "One undo did not bring the empty paragraph back")
        // ⌦ at the end of the last item removes it too.
        qlCaret(view, end)
        qlKey(view, #selector(NSResponder.deleteForward(_:)))
        try qlSettled(host, view)
        try require(view.textView.string == text && (try qlShape(core)).map(\.number) == [1, 2, 3, 4, nil, nil]
                    && view.textView.selectedRange() == NSRange(location: end, length: 0),
                    "⌦ at the list's end did not remove the empty paragraph: \(qlDescribe(core))")

        // A heading is never made a list item; 引用 still takes it.
        let heading = try qlAt("标题", in: view)
        qlCaret(view, heading + 1)
        try qlChoose(menu, .heading1)
        try qlSettled(host, view)
        let blocks = try read(core).projection.blocks
        guard let headingIndex = NativeLayout.index(heading + 1, blocks: blocks), blocks[headingIndex].kind == "heading" else {
            throw LabError.message("标题 did not become a heading")
        }
        try require(!ProsePickers.slashItems(query: "", blocks: blocks, at: headingIndex).contains { ["有序列表", "无序列表"].contains($0.title) }
                    && ProsePickers.slashItems(query: "", blocks: blocks, at: headingIndex).contains { $0.title == "引用" },
                    "The slash menu offers a list on a heading")
        let before = try qlRows(page.directory), shape = qlDescribe(core)
        qlCaret(view, heading + 1)
        try qlChoose(menu, .bulletList)
        try qlSettled(host, view)
        let refusal = view.binding.store.lastFormatRefusal ?? ""
        try require(refusal.contains("标题不能设为列表项") && (try qlStatus(view)).contains("标题不能设为列表项")
                    && (try qlRows(page.directory)) == before && qlDescribe(core) == shape && !view.binding.hasFailedDraft,
                    "A heading made a list was not refused: \(refusal)")
        try qlChoose(menu, .blockquote)
        try qlSettled(host, view)
        try require(try qlBlock(core, containing: "标题").containers == ["blockquote"], "引用 did not take the heading")
        try require(LabError.historyUnavailable(reason: "NATIVE_HISTORY_UNAVAILABLE: another writer's text is in the blocks this undo would rebuild")
                        .errorDescription?.contains("撤销会让段落重复") == true, "The undo refusal is not in Chinese")
        try page.close()
    }

    // MARK: Ending a list from any last item

    /// Return on the empty last paragraph of a list's last item: `exitList`.
    private static func qlExitList() throws {
        let page = try qlPage("前文。\n甲\n乙\n丙\n后文。")
        defer { page.remove() }
        let (host, view, core) = (page.host, page.view, page.core)
        let first = try qlAt("甲", in: view), third = try qlAt("丙", in: view)
        view.binding.format(.bulletList, range: NSRange(location: first, length: third + 1 - first))
        try qlSettled(host, view)
        try require(try qlShape(core).map(\.containers.count) == [0, 2, 2, 2, 0], "The list was not set up: \(qlDescribe(core))")
        func returnKey() { qlKey(view, #selector(NSResponder.insertNewline(_:))) }
        func container(_ text: String) throws -> String { try qlBlock(core, containing: text).container }

        // An item of three paragraphs: undone splits leave 丙, 丙二 and an
        // empty paragraph in the last item.
        qlCaret(view, third + 1)
        returnKey(); try qlSettled(host, view)
        view.undoProse(); try qlSettled(host, view)
        let emptyAfterThird = third + 2
        qlType(view, "丙二", at: emptyAfterThird)
        try qlSettled(host, view)
        qlCaret(view, emptyAfterThird + 2)
        returnKey(); try qlSettled(host, view)
        view.undoProse(); try qlSettled(host, view)
        var blocks = try read(core).projection.blocks
        let item = try container("丙")
        try require(blocks.count == 7 && blocks[3].container == item && blocks[4].container == item && blocks[5].container == item
                    && blocks[5].range.length == 0, "The last item does not hold three paragraphs: \(qlDescribe(core))")
        let text = view.textView.string, empty = blocks[5].range.location
        var rows = try qlRows(page.directory)
        let revision = try read(core).projection.revision
        qlCaret(view, empty)
        returnKey()
        try require(view.deferredFormat == nil, "Return on an idle list waited instead of ending it")
        try qlSettled(host, view)
        var shape = try qlShape(core)
        try require(shape.map(\.containers.count) == [0, 2, 2, 2, 2, 0, 0] && shape[5].text.isEmpty && view.textView.string == text
                    && (try container("丙")) == item && (try container("丙二")) == item,
                    "Return on the empty last paragraph did not leave the list: \(qlDescribe(core))")
        let exited = try read(core).projection.revision
        try require(exited > revision && (try qlRows(page.directory)) != rows && view.binding.store.lastFormatRefusal == nil,
                    "The exit was not saved: revision \(revision) → \(exited), refusal \(view.binding.store.lastFormatRefusal ?? "none")")
        try require(view.textView.selectedRange() == NSRange(location: empty, length: 0), "The caret moved to \(view.textView.selectedRange())")
        try require(try qlDrawnMarkers(view.textView) == ["•", "•", "•"], "The list draws \(try qlDrawnMarkers(view.textView))")
        view.undoProse(); try qlSettled(host, view)
        blocks = try read(core).projection.blocks
        try require(blocks[5].container == item && blocks[5].range.length == 0 && view.textView.string == text,
                    "One undo did not put the paragraph back in its item: \(qlDescribe(core))")
        view.redoProse(); try qlSettled(host, view)
        try require(try qlShape(core).map(\.containers.count) == [0, 2, 2, 2, 2, 0, 0], "Redo did not end the list again")
        qlType(view, "尾段", at: empty)
        try qlSettled(host, view)
        try require(try qlBlock(core, containing: "尾段").containers.isEmpty, "Text typed after the list went into it")

        // Return twice after 丙二's text, the second while the first is still
        // queued: the waiting exit replaces the split and the new paragraph
        // leaves the list.
        let second = try qlAt("丙二", in: view) + 2
        rows = try qlRows(page.directory)
        qlCaret(view, second)
        returnKey()
        try require(view.deferredFormat?.action == .splitListItem, "The first Return did not wait to split")
        returnKey()
        try require(view.deferredFormat?.action == .exitList, "The second Return did not wait to end the list")
        try qlSettled(host, view)
        shape = try qlShape(core)
        try require(shape.map(\.text) == ["前文。", "甲", "乙", "丙", "丙二", "", "尾段", "后文。"]
                    && shape.map(\.containers.count) == [0, 2, 2, 2, 2, 0, 0, 0] && (try container("丙二")) == item,
                    "Return twice did not end the list: \(qlDescribe(core))")
        try require((try qlStatus(view)) == "正文已保存" && view.binding.store.lastFormatRefusal == nil && (try qlRows(page.directory)) != rows,
                    "Return twice read \(try qlStatus(view))")
        view.undoProse(); try qlSettled(host, view)
        try require(try qlShape(core).map(\.containers.count) == [0, 2, 2, 2, 2, 2, 0, 0], "Undo did not put the queued Return's paragraph back")
        view.redoProse(); try qlSettled(host, view)

        // A middle item keeps the ordinary Return: 甲's empty last paragraph
        // (an undone split) gains another and no refusal is shown.
        qlCaret(view, try qlAt("甲", in: view) + 1)
        returnKey(); try qlSettled(host, view)
        view.undoProse(); try qlSettled(host, view)
        let itemOne = try container("甲")
        let middle = try qlAt("甲", in: view) + 2
        try require(try read(core).projection.blocks[2].container == itemOne, "甲's item does not hold an empty paragraph")
        qlCaret(view, middle)
        returnKey()
        try require(view.deferredFormat == nil, "Return in a middle item waited")
        try qlSettled(host, view)
        blocks = try read(core).projection.blocks
        try require(blocks[1...3].allSatisfy { $0.container == itemOne } && view.binding.store.lastFormatRefusal == nil
                    && (try qlStatus(view)) == "正文已保存", "Return in a middle item did not add a paragraph to it: \(qlDescribe(core))")
        let expected = try read(core).projection

        // Layout: a paragraph before a nested list, or followed by another
        // item of the list, is not the list's last.
        func block(_ location: Int, _ length: Int, _ container: String, _ containers: [String]) -> NativeBlock {
            NativeBlock(id: nil, kind: "paragraph", depth: containers.count, container: container, structuralAttributes: [:],
                        range: NativeRange(location: location, length: length), editable: true, runs: [], containers: containers)
        }
        let bullet = ["bulletList", "listItem"], nested = ["bulletList", "listItem", "bulletList", "listItem"]
        let sample = [block(0, 1, "a", bullet), block(2, 0, "a", bullet), block(3, 1, "b", nested), block(5, 0, "c", bullet),
                      block(6, 0, "d", ["orderedList", "listItem"]), block(7, 1, "root", [])]
        try require(!NativeLayout.lastOfList(sample, at: 0) && !NativeLayout.lastOfList(sample, at: 1) && NativeLayout.lastOfList(sample, at: 3)
                    && NativeLayout.lastOfList(sample, at: 4) && !NativeLayout.lastOfList(sample, at: 5),
                    "The list's last paragraph is misread")
        // A list in a quote right after an item is not nested in it: the
        // item's paragraph is its last and the list's last.
        let quoted = [block(0, 1, "a", bullet), block(2, 1, "q", ["blockquote", "bulletList", "listItem"])]
        try require(NativeLayout.lastInItem(quoted, at: 0) && NativeLayout.lastOfList(quoted, at: 0),
                    "A quoted list after an item reads as nested in it")
        try page.close()

        // Cold reopen keeps the exits.
        let cold = LabWorkspaceCore(directory: page.directory)
        let (coldWindow, coldHost) = elementHost(cold)
        defer { coldWindow.close() }
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let reopened: NativeDocumentView = try elementResult { coldHost.open(project: page.project, chapter: page.chapter, completion: $0) }
        try qlSettled(coldHost, reopened)
        guard let projection = reopened.binding.store.projection else { throw LabError.message("The reopened chapter has no projection") }
        try require(projection.text == expected.text && projection.blocks.map(\.containers) == expected.blocks.map(\.containers)
                    && projection.blocks.map(\.id) == expected.blocks.map(\.id), "The ended list did not survive a cold reopen")
        let closed: Bool = try elementResult { coldHost.close(completion: $0) }
        try require(closed, "The cold workspace did not close")

        // A lone empty item: the list goes with it.
        let blank = try qlPage("")
        defer { blank.remove() }
        qlType(blank.view, "-")
        qlType(blank.view, " ")
        try qlSettled(blank.host, blank.view)
        try require(try qlShape(blank.core).map(\.containers) == [["bulletList", "listItem"]], "“- ” did not start a list")
        qlKey(blank.view, #selector(NSResponder.insertNewline(_:)))
        try qlSettled(blank.host, blank.view)
        try require(try qlShape(blank.core).map(\.containers) == [[]] && blank.view.textView.string.isEmpty
                    && (try qlDrawnMarkers(blank.view.textView)).isEmpty, "Return on a lone empty item did not remove the list: \(qlDescribe(blank.core))")
        blank.view.undoProse(); try qlSettled(blank.host, blank.view)
        try require(try qlShape(blank.core).map(\.containers) == [["bulletList", "listItem"]], "One undo did not bring the list back")
        try blank.close()
    }

    // MARK: Review fixes

    private static func qlReviewFixes() throws {
        let page = try qlPage("甲。\n乙。")
        defer { page.remove() }
        let (host, view, core) = (page.host, page.view, page.core)
        let menu = qlMenu(view)
        // A rule after 甲, the caret in the empty paragraph after it.
        qlCaret(view, 1)
        try qlChoose(menu, .insertRule)
        try qlSettled(host, view)
        try require(try read(core).projection.text == "甲。\n\u{fffc}\n\n乙。", "The rule was not inserted: \(qlDescribe(core))")
        // ⌫ removes the rule; “x” and “y” typed at once land in order and
        // the caret stays after them.
        let empty = try read(core).projection.blocks[2].range.location
        qlCaret(view, empty)
        qlKey(view, #selector(NSResponder.deleteBackward(_:)))
        view.textView.insertText("x", replacementRange: view.textView.selectedRange())
        view.textView.insertText("y", replacementRange: view.textView.selectedRange())
        try qlSettled(host, view)
        try require(try read(core).projection.text == "甲。\nxy\n乙。" && view.textView.selectedRange() == NSRange(location: 5, length: 0),
                    "Typing after ⌫ on a rule reads \(view.textView.string.debugDescription) with the caret at \(view.textView.selectedRange())")
        view.textView.insertText("z", replacementRange: view.textView.selectedRange())
        try qlSettled(host, view)
        try require(try read(core).projection.text == "甲。\nxyz\n乙。", "The next key went elsewhere: \(view.textView.string.debugDescription)")
        // ⌦ at the end of 甲 before a rule keeps the caret at 甲's end.
        qlCaret(view, 1)
        try qlChoose(menu, .insertRule)
        try qlSettled(host, view)
        qlCaret(view, 2)
        qlKey(view, #selector(NSResponder.deleteForward(_:)))
        try qlSettled(host, view)
        try require(!(try read(core).projection.text).contains("\u{fffc}") && view.textView.selectedRange() == NSRange(location: 2, length: 0),
                    "⌦ moved the caret to \(view.textView.selectedRange()): \(view.textView.string.debugDescription)")
        // Read-only refusals: only a rule command reads as one.
        let format = LabError.formattingUnavailable(reason: "NATIVE_FORMATTING_UNAVAILABLE: Unsupported block is preserved read-only").errorDescription ?? ""
        let rule = LabError.formattingUnavailable(reason: "documentRule NATIVE_FORMATTING_UNAVAILABLE: Unsupported block is preserved read-only")
            .errorDescription ?? ""
        try require(!format.contains("分隔线") || format.contains("例如分隔线"), "A format refusal reads as a rule refusal: \(format)")
        try require(format.contains("不能在这里设置格式或链接") && rule.contains("不能插入分隔线"), "The read-only refusals differ: \(format) / \(rule)")
        // An item's paragraph followed by a nested list (as imported) is not
        // its item's last child: Return does not split the item there.
        func block(_ location: Int, _ length: Int, _ container: String, _ containers: [String]) -> NativeBlock {
            NativeBlock(id: nil, kind: "paragraph", depth: containers.count, container: container, structuralAttributes: [:],
                        range: NativeRange(location: location, length: length), editable: true, runs: [], containers: containers)
        }
        let item = ["bulletList", "listItem"], nested = ["bulletList", "listItem", "bulletList", "listItem"]
        let blocks = [block(0, 1, "a", item), block(2, 0, "a", item), block(3, 1, "b", nested), block(5, 1, "c", item), block(7, 1, "root", [])]
        let projection = NativeProjection(revision: 1, text: "一\n\n二\n三\n尾", blocks: blocks, comments: [], selections: [], canUndo: false, canRedo: false)
        try require(!NativeLayout.lastInItem(blocks, at: 0) && !NativeLayout.lastInItem(blocks, at: 1) && NativeLayout.lastInItem(blocks, at: 2)
                    && NativeLayout.lastInItem(blocks, at: 3) && !projection.canSplitListItem(in: NSRange(location: 2, length: 0))
                    && !projection.canSplitListItem(in: NSRange(location: 0, length: 0)), "A paragraph before a nested list counts as its item's last")
        try page.close()
    }

    // MARK: Return and ⌫

    private static func qlEnterAndBackspace() throws {
        let page = try qlPage("前文。\n甲\n乙\n丙\n\n后文。")
        defer { page.remove() }
        let (host, view, core) = (page.host, page.view, page.core)
        let menu = qlMenu(view)
        let first = try qlAt("甲", in: view), empty = try qlAt("丙", in: view) + 2
        // Up to the empty paragraph's line break, so the selection enters it.
        view.textView.setSelectedRange(NSRange(location: first, length: empty + 1 - first))
        try qlChoose(menu, .orderedList)
        try qlSettled(host, view)
        try require(try qlShape(core).map(\.number) == [nil, 1, 2, 3, 4, nil], "The list was not set up: \(qlDescribe(core))")
        try require(try qlDrawnMarkers(view.textView) == ["1.", "2.", "3.", "4."], "The empty item's marker is not drawn")
        let text = view.textView.string

        // Return on the empty last item takes it out after the list: one unit.
        qlCaret(view, empty)
        qlKey(view, #selector(NSResponder.insertNewline(_:)))
        try qlSettled(host, view)
        try require(try qlShape(core).map(\.containers.count) == [0, 2, 2, 2, 0, 0] && view.textView.string == text,
                    "Return on the empty last item did not end the list: \(qlDescribe(core))")
        view.undoProse(); try qlSettled(host, view)
        try require(try qlShape(core).map(\.containers.count) == [0, 2, 2, 2, 2, 0], "One undo did not put the item back")
        view.redoProse(); try qlSettled(host, view)

        // Return at the end of a non-empty item starts the next item once the
        // new paragraph lands; Return on that empty last item ends the list.
        let third = try qlAt("丙", in: view)
        let rowsBefore = try qlRows(page.directory)
        qlCaret(view, third + 1)
        qlKey(view, #selector(NSResponder.insertNewline(_:)))
        try require(view.deferredFormat?.action == .splitListItem, "Return did not wait to start the next item")
        try qlSettled(host, view)
        let added = try read(core).projection.blocks[4]
        let thirdBlock = try qlBlock(core, containing: "丙")
        try require(added.range.length == 0 && added.containers == ["orderedList", "listItem"] && added.listNumber == 4
                    && added.container != thirdBlock.container, "Return in 丙 did not start item 4: \(qlDescribe(core))")
        try require(try qlDrawnMarkers(view.textView) == ["1.", "2.", "3.", "4."], "The new item does not draw its number")
        try require((try qlStatus(view)) == "正文已保存" && (try qlRows(page.directory)) != rowsBefore,
                    "Return and the split were not saved: \(try qlStatus(view))")
        qlKey(view, #selector(NSResponder.insertNewline(_:)))
        try qlSettled(host, view)
        try require(try qlShape(core).map(\.containers.count) == [0, 2, 2, 2, 0, 0, 0] && view.textView.string == text.replacingOccurrences(of: "丙\n", with: "丙\n\n"),
                    "Return on the new empty item did not end the list: \(qlDescribe(core))")
        // Each step is one undo unit: the lift, the split, then the Return.
        view.undoProse(); try qlSettled(host, view)
        try require(try qlShape(core).map(\.number) == [nil, 1, 2, 3, 4, nil, nil], "Undo did not put item 4 back: \(qlDescribe(core))")
        view.undoProse(); try qlSettled(host, view)
        let joined = try read(core).projection.blocks[4]
        try require(joined.container == (try qlBlock(core, containing: "丙")).container, "Undo did not rejoin the paragraph to item 3")
        view.undoProse(); try qlSettled(host, view)
        try require(try qlShape(core).map(\.containers.count) == [0, 2, 2, 2, 0, 0] && view.textView.string == text,
                    "Three undos did not restore the list: \(qlDescribe(core))")

        // ⌫ at the start of the first item takes it out before the list; at
        // the start of the last one after it; at a middle one it is refused
        // before any input is queued.
        qlCaret(view, try qlAt("甲", in: view))
        qlKey(view, #selector(NSResponder.deleteBackward(_:)))
        try qlSettled(host, view)
        var shape = try qlShape(core)
        try require(shape[1].text == "甲" && shape[1].containers.isEmpty && shape[2].number == 1 && view.textView.string == text,
                    "⌫ at the first item did not lift it: \(qlDescribe(core))")
        view.undoProse(); try qlSettled(host, view)
        try require(try qlShape(core)[1].containers.count == 2, "One undo did not put the first item back")
        qlCaret(view, try qlAt("丙", in: view))
        qlKey(view, #selector(NSResponder.deleteBackward(_:)))
        try qlSettled(host, view)
        try require(try qlShape(core).map(\.containers.count) == [0, 2, 2, 0, 0, 0] && view.textView.string == text,
                    "⌫ at the last item did not lift it: \(qlDescribe(core))")
        view.undoProse(); try qlSettled(host, view)
        let rows = try qlRows(page.directory)
        qlCaret(view, try qlAt("乙", in: view))
        qlKey(view, #selector(NSResponder.deleteBackward(_:)))
        try require(view.textView.string == text && !view.binding.hasPendingWork && !view.binding.hasFailedDraft
                    && (try qlStatus(view)).contains("列表项之间不能合并"), "⌫ at a middle item read “\(try qlStatus(view))”")
        try qlSettled(host, view)
        try require(try qlRows(page.directory) == rows && (try qlShape(core)).map(\.containers.count) == [0, 2, 2, 2, 0, 0],
                    "⌫ at a middle item wrote")

        // Quotes: Return twice after a quoted paragraph, the second pressed
        // while the first is still queued, ends the quote.
        let after = try qlAt("后文", in: view)
        qlCaret(view, after)
        try qlChoose(menu, .blockquote)
        try qlSettled(host, view)
        qlCaret(view, after + 3)
        qlKey(view, #selector(NSResponder.insertNewline(_:)))
        try require(view.binding.hasPendingWork, "The first Return was not queued")
        try require(view.binding.displayedBlocks.last?.containers == ["blockquote"] && view.binding.displayedBlocks.last?.range.length == 0,
                    "The new paragraph is not shown in the quote")
        qlKey(view, #selector(NSResponder.insertNewline(_:)))
        try require(view.deferredFormat?.action == .blockquote, "The second Return did not wait to end the quote")
        try qlSettled(host, view)
        shape = try qlShape(core)
        try require(shape.suffix(2).map(\.containers) == [["blockquote"], []] && shape.last?.text == "" && view.textView.string.hasSuffix("后文。\n"),
                    "Return twice did not end the quote: \(qlDescribe(core))")
        view.undoProse(); try qlSettled(host, view)
        try require(try qlShape(core).last?.containers == ["blockquote"], "One undo did not put the paragraph back in the quote")
        view.redoProse(); try qlSettled(host, view)
        // ⌫ at the start of the quote's first paragraph lifts it, keeping its
        // text apart from the paragraph before.
        let quoted = try qlAt("后文", in: view)
        let before = view.textView.string
        qlCaret(view, quoted)
        qlKey(view, #selector(NSResponder.deleteBackward(_:)))
        try qlSettled(host, view)
        try require(try qlBlock(core, containing: "后文").containers.isEmpty && view.textView.string == before,
                    "⌫ at the quote's start did not lift the paragraph: \(qlDescribe(core))")
        view.undoProse(); try qlSettled(host, view)
        try require(try qlBlock(core, containing: "后文").containers == ["blockquote"], "One undo did not put the paragraph back in the quote")
        try page.close()
    }

    // MARK: Printing and previews

    private static func qlPrintingAndPreviews() throws {
        let page = try qlPage("潮汐表\n引一段旧话。\n第一步\n第二步\n绳结\n港口")
        defer { page.remove() }
        let (host, view, core) = (page.host, page.view, page.core)
        func format(_ action: NativeFormatAction, _ from: String, _ to: String? = nil) throws {
            let start = try qlAt(from, in: view)
            let end = try to.map { try qlAt($0, in: view) + 1 } ?? start
            view.binding.format(action, range: NSRange(location: start, length: end - start))
            try qlSettled(host, view)
        }
        try format(.blockquote, "引一段")
        try format(.orderedList, "第一步", "第二步")
        try format(.bulletList, "绳结", "港口")
        try require(try qlShape(core).map(\.containers.count) == [0, 1, 2, 2, 2, 2], "The fixture was not set up: \(qlDescribe(core))")

        // The typesetter reads the live projection.
        let projection: WorkspaceBodyProjection = try elementResult {
            page.workspace.readProjection(projectID: page.project.id, kind: "chapter", id: page.chapter.id, completion: $0)
        }
        let typeset = PrintTypesetter().body(projection.projection)
        let string = typeset.string as NSString
        try require(string.contains("1.\t第一步") && string.contains("2.\t第二步") && string.contains("•\t绳结") && string.contains("•\t港口"),
                    "The printed lists read \(typeset.string.debugDescription)")
        let quote = typeset.attributes(at: string.range(of: "引一段").location, effectiveRange: nil)
        try require(quote[.foregroundColor] as? NSColor == PrintTypesetter.muted
                    && ((quote[.paragraphStyle] as? NSParagraphStyle)?.headIndent ?? 0) > 0, "The printed quote is not muted and indented")
        // 打印 to a PDF.
        let output = page.directory.deletingLastPathComponent().appendingPathComponent("quotes-lists.pdf")
        let printing = MacPrintCoordinator(workspace: page.workspace)
        let a4 = NSPrintInfo()
        a4.paperSize = PrintPaper.a4.size
        printing.printInfo = { a4 }
        printing.runPrintOperation = { operation, _ in
            operation.printInfo.jobDisposition = .save
            operation.printInfo.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = output
            operation.showsPrintPanel = false
            operation.showsProgressPanel = false
            operation.run()
        }
        guard let target = host.activeHistoryTarget else { throw LabError.message("No focused page to print") }
        let pages: Int = try elementResult {
            printing.print(MacPrintCoordinator.Target(projectID: target.projectID, kind: target.kind, id: target.id, title: target.title),
                           window: nil, completion: $0)
        }
        guard pages >= 1, let document = PDFDocument(url: output), let printed = document.string else {
            throw LabError.message("The page did not print to a PDF")
        }
        // PDF text extraction may return CJK radicals for some ideographs (⼀ for 一).
        try require(printed.contains("1. ") && printed.contains("2. ") && printed.contains("• ") && printed.contains("旧话"),
                    "The PDF reads \(printed.debugDescription)")

        // The 全书长卷: an editor row and a read-only preview.
        let row = NativeDocumentView(core: core, minimumTextHeight: 48, growsWithText: true)
        row.frame = NSRect(x: 0, y: 0, width: 640, height: 400)
        row.binding.load()
        try wait { row.binding.state != nil && !row.binding.hasPendingWork && row.textView.string == view.textView.string }
        row.layoutSubtreeIfNeeded()
        try require(try qlDrawnMarkers(row.textView) == ["1.", "2.", "•", "•"], "The long page's editor row drew \(try qlDrawnMarkers(row.textView))")
        try require(row.binding.detach(), "The long page's row did not detach")
        let preview = WholeBookPreviewText(frame: NSRect(x: 0, y: 0, width: 640, height: 400))
        let styled = NSTextStorage(string: view.textView.string)
        DocumentStyle.apply(try read(core).projection, to: styled)
        preview.show(styled)
        preview.prepare(width: 640)
        preview.layoutSubtreeIfNeeded()
        try require(try qlDrawnMarkers(preview.textView) == ["1.", "2.", "•", "•"], "The long page's preview drew \(try qlDrawnMarkers(preview.textView))")

        // The 历史版本 preview of the version kept on close.
        let closed: Bool = try elementResult {
            host.closeTab(pane: 0, scope: .chapter(ChapterScope(projectID: page.project.id, chapterID: page.chapter.id)), completion: $0)
        }
        try require(closed, "The chapter did not close")
        let historyTarget = VersionHistoryTarget(projectID: page.project.id, kind: "chapter", id: page.chapter.id, title: page.chapter.title)
        let model = VersionHistoryModel(workspace: page.workspace, target: historyTarget)
        let sheet = VersionHistorySheet(model: model)
        sheet.begin(in: nil)
        model.load()
        try wait { model.loaded && !model.busy }
        guard let version = model.entries.first else { throw LabError.message("No version was kept on close") }
        sheet.select(entryID: version.id)
        try wait { model.preview(of: version) != nil }
        sheet.diffCheckbox.state = .off
        sheet.reload()
        sheet.previewView.frame = NSRect(x: 0, y: 0, width: 640, height: 400)
        try require(model.preview(of: version)?.blocks.map(\.containers.count) == [0, 1, 2, 2, 2, 2]
                    && (try qlDrawnMarkers(sheet.previewView)) == ["1.", "2.", "•", "•"],
                    "The 历史版本 preview drew \(try qlDrawnMarkers(sheet.previewView))")
        let shown = sheet.previewView.string as NSString
        try require(sheet.previewView.textStorage?.attribute(.foregroundColor, at: shown.range(of: "引一段").location, effectiveRange: nil) as? NSColor
                    == .secondaryLabelColor, "The preview's quote is not muted")
        sheet.close()
        try page.close()
    }


    // MARK: List items

    /// Return in the middle of an item and with typing going on at once.
    private static func qlListItemSplits() throws {
        let page = try qlPage("清单\n苹果梨子\n橙")
        defer { page.remove() }
        let (host, view, core) = (page.host, page.view, page.core)
        let first = try qlAt("苹果", in: view), orange = try qlAt("橙", in: view)
        view.binding.format(.bulletList, range: NSRange(location: first, length: orange + 1 - first))
        try qlSettled(host, view)
        try require(try qlShape(core).map(\.containers.count) == [0, 2, 2], "The list was not set up: \(qlDescribe(core))")
        // In the middle: the rest of the item becomes the next item.
        qlCaret(view, first + 2)
        qlKey(view, #selector(NSResponder.insertNewline(_:)))
        try qlSettled(host, view)
        var shape = try qlShape(core)
        try require(shape.map(\.text) == ["清单", "苹果", "梨子", "橙"] && shape.dropFirst().allSatisfy { $0.containers.count == 2 }
                    && Set(try read(core).projection.blocks.dropFirst().map(\.container)).count == 3,
                    "Return in the middle did not split the item: \(qlDescribe(core))")
        // At the end, with typing going on at once: the waiting split keeps
        // to its paragraph, and the typed text lands in the new item.
        let end = try qlAt("橙", in: view) + 1
        qlCaret(view, end)
        qlKey(view, #selector(NSResponder.insertNewline(_:)))
        qlType(view, "桃", at: end + 1)
        try require(view.deferredFormat?.action == .splitListItem, "Typing dropped the waiting split")
        try qlSettled(host, view)
        shape = try qlShape(core)
        let blocks = try read(core).projection.blocks
        try require(shape.last?.text == "桃" && blocks.last?.container != blocks[blocks.count - 2].container && shape.last?.containers.count == 2,
                    "Typing at once lost the new item: \(qlDescribe(core))")
        try require(try qlDrawnMarkers(view.textView) == ["•", "•", "•", "•"], "The items draw \(try qlDrawnMarkers(view.textView))")
        // A middle paragraph of an item with two (an undone split) does not
        // split, and says nothing.
        qlCaret(view, try qlAt("梨子", in: view) + 2)
        qlKey(view, #selector(NSResponder.insertNewline(_:)))
        try qlSettled(host, view)
        view.undoProse(); try qlSettled(host, view)
        let pear = try qlBlock(core, containing: "梨子")
        let beforeSplit = try read(core).projection.blocks
        let emptyIndex = beforeSplit.firstIndex { $0.range.location == NSMaxRange(pear.range.nsRange) + 1 }
        try require(emptyIndex.map { beforeSplit[$0].container == pear.container } == true, "Undo did not leave two paragraphs in 梨子's item")
        qlCaret(view, try qlAt("梨子", in: view) + 1)
        let status = try qlStatus(view)
        qlKey(view, #selector(NSResponder.insertNewline(_:)))
        try require(view.deferredFormat == nil, "A middle paragraph waited to split")
        try qlSettled(host, view)
        try require((try qlStatus(view)) == "正文已保存" && status == "正文已保存" && view.binding.store.lastFormatRefusal == nil,
                    "Return in a middle paragraph showed \(try qlStatus(view))")
        try page.close()
    }

    // MARK: Rules

    private static func qlRuleLocation(_ core: LabCore, _ nth: Int = 0) throws -> Int {
        let rules = try read(core).projection.blocks.filter { $0.kind == "horizontalRule" }
        guard rules.indices.contains(nth) else { throw LabError.message("No rule \(nth) in \(qlDescribe(core))") }
        return rules[nth].range.location
    }

    /// Draws the text view off screen and returns the rules it drew.
    private static func qlDrawnRules(_ textView: NSTextView) throws -> [(location: Int, rect: NSRect)] {
        guard let view = textView as? ListMarkerTextView else { throw LabError.message("The text view does not draw rules") }
        view.drawnRules = []
        let bounds = view.bounds
        guard bounds.width > 1, bounds.height > 1, let rep = view.bitmapImageRepForCachingDisplay(in: bounds) else {
            throw LabError.message("The text view has no area to draw: \(bounds)")
        }
        view.cacheDisplay(in: bounds, to: rep)
        return view.drawnRules
    }

    /// A rule is a thin line centred in the text column, over an invisible character.
    private static func qlRequireRuleDrawn(_ textView: NSTextView, at location: Int, _ label: String) throws {
        let drawn = try qlDrawnRules(textView)
        let column = (textView.textContainer?.size.width ?? 0) - 2 * (textView.textContainer?.lineFragmentPadding ?? 0)
        let middle = textView.textContainerOrigin.x + (textView.textContainer?.lineFragmentPadding ?? 0) + column / 2
        guard let rule = drawn.first(where: { $0.location == location }) else {
            throw LabError.message("\(label) drew no rule at \(location): \(drawn)")
        }
        try require(rule.rect.height <= 1.5 && rule.rect.width >= 48 && rule.rect.width <= column && abs(rule.rect.midX - middle) <= 1,
                    "\(label) drew the rule off centre: \(rule.rect) in a column of \(column)")
        let color = textView.textStorage?.attribute(.foregroundColor, at: location, effectiveRange: nil) as? NSColor
        try require(color == .clear && textView.textStorage?.attribute(DocumentStyle.ruleKey, at: location, effectiveRange: nil) != nil,
                    "\(label) shows the rule's character: \(String(describing: color))")
    }

    private static func qlRules() throws {
        let text = "开篇。\n潮汐。\n夜航。"
        let page = try qlPage(text)
        defer { page.remove() }
        let (host, view, core) = (page.host, page.view, page.core)
        let twin: NativeDocumentView = try elementResult { host.split(completion: $0) }
        try qlSettled(host, view, twin)
        let menu = qlMenu(view)
        guard let formatGroup = MacMainMenu.groups(of: menu).first(where: { $0.title == "格式" }) else { throw LabError.message("No 格式 menu") }
        try require(formatGroup.commands.map(\.title).contains("插入分隔线") && MacMenuCommand.insertRule.defaultShortcut.isNone,
                    "The 格式 menu lacks 插入分隔线")

        // 格式 › 插入分隔线 after 潮汐: the rule, then an empty paragraph with the caret.
        let tide = try qlAt("潮汐", in: view)
        var rows = try qlRows(page.directory)
        qlCaret(view, tide + 1)
        try qlChoose(menu, .insertRule)
        try qlSettled(host, view, twin)
        var projection = try read(core).projection
        try require(projection.text == "开篇。\n潮汐。\n\u{fffc}\n\n夜航。" && projection.blocks[2].kind == "horizontalRule"
                    && !projection.blocks[2].editable && projection.blocks[2].id != nil, "插入分隔线 wrote \(qlDescribe(core))")
        try require(view.textView.selectedRange() == NSRange(location: projection.blocks[3].range.location, length: 0),
                    "The caret is at \(view.textView.selectedRange()), not in the new paragraph")
        try require((try qlRows(page.directory)) != rows && (try qlStatus(view)) == "正文已保存", "The rule was not saved")
        for pane in [view, twin] { try qlRequireRuleDrawn(pane.textView, at: projection.blocks[2].range.location, "A pane") }
        try require((try qlDrawnMarkers(view.textView)).isEmpty, "The rule drew a list marker")
        view.undoProse(); try qlSettled(host, view, twin)
        try require(try read(core).projection.text == text, "One undo did not remove the rule")
        view.redoProse(); try qlSettled(host, view, twin)
        try require(try read(core).projection.text == "开篇。\n潮汐。\n\u{fffc}\n\n夜航。", "Redo did not bring the rule back")

        // The slash menu's 分隔线 in the empty paragraph: a rule before it,
        // the caret stays in it (two undo units: the “/hr”, then the rule).
        let empty = try read(core).projection.blocks[3].range.location
        qlType(view, "/", at: empty)
        qlType(view, "hr", at: empty + 1)
        try require(view.picker?.items.map(\.title) == ["分隔线"], "/hr lists \(view.picker?.items.map(\.title) ?? [])")
        qlKey(view, #selector(NSResponder.insertNewline(_:)))
        try qlSettled(host, view, twin)
        projection = try read(core).projection
        try require(projection.text == "开篇。\n潮汐。\n\u{fffc}\n\u{fffc}\n\n夜航。" && projection.blocks[3].kind == "horizontalRule",
                    "The slash row did not put a rule before the empty paragraph: \(qlDescribe(core))")
        try require(view.textView.selectedRange() == NSRange(location: projection.blocks[4].range.location, length: 0),
                    "The caret left the empty paragraph: \(view.textView.selectedRange())")
        try require(ProsePickers.slashItems(query: "").last?.title == "分隔线" && ProsePickers.slashItems(query: "分").map(\.title) == ["分隔线"],
                    "The slash menu does not list 分隔线 last")

        // 删除分隔线 from the second rule's context menu; the caret follows.
        let second = try qlRuleLocation(core, 1)
        guard let window = view.window, let event = NSEvent.mouseEvent(with: .rightMouseDown, location: .zero, modifierFlags: [],
            timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1),
              let context = view.textView(view.textView, menu: NSMenu(), for: event, at: second),
              let remove = context.items.first(where: { $0.title == "删除分隔线" }) else {
            throw LabError.message("The rule's context menu has no 删除分隔线")
        }
        guard let plainEvent = NSEvent.mouseEvent(with: .rightMouseDown, location: .zero, modifierFlags: [], timestamp: 0,
                                                  windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1),
              let plain = view.textView(view.textView, menu: NSMenu(), for: plainEvent, at: tide) else { throw LabError.message("No prose menu") }
        try require(!plain.items.contains { $0.title == "删除分隔线" }, "Prose offers 删除分隔线")
        context.performActionForItem(at: context.index(of: remove))
        try qlSettled(host, view, twin)
        projection = try read(core).projection
        try require(projection.text == "开篇。\n潮汐。\n\u{fffc}\n\n夜航。", "删除分隔线 left \(qlDescribe(core))")
        try require(view.textView.selectedRange().location == second, "The caret did not follow: \(view.textView.selectedRange())")

        // ⌫ at the start of the paragraph right after the rule removes it.
        let afterRule = projection.blocks[3].range.location
        qlCaret(view, afterRule)
        rows = try qlRows(page.directory)
        qlKey(view, #selector(NSResponder.deleteBackward(_:)))
        try qlSettled(host, view, twin)
        try require(try read(core).projection.text == "开篇。\n潮汐。\n\n夜航。" && (try qlRows(page.directory)) != rows,
                    "⌫ after the rule left \(qlDescribe(core))")
        view.undoProse(); try qlSettled(host, view, twin)
        try require(try read(core).projection.text == "开篇。\n潮汐。\n\u{fffc}\n\n夜航。", "One undo did not bring the rule back")
        // ⌦ at the end of the paragraph right before it.
        qlCaret(view, try qlAt("潮汐。", in: view) + 3)
        qlKey(view, #selector(NSResponder.deleteForward(_:)))
        try qlSettled(host, view, twin)
        try require(try read(core).projection.text == "开篇。\n潮汐。\n\n夜航。", "⌦ before the rule left \(qlDescribe(core))")
        view.undoProse(); try qlSettled(host, view, twin)
        // ⌫ given while typed text is still on its way waits for it.
        let paragraph = try read(core).projection.blocks[3].range.location
        qlType(view, "雾", at: paragraph)
        qlKey(view, #selector(NSResponder.deleteBackward(_:)))
        qlKey(view, #selector(NSResponder.deleteBackward(_:)))
        try require(view.deferredFormat?.command == .removeRule(forward: false), "⌫ at the paragraph's start did not wait for the typed text")
        try qlSettled(host, view, twin)
        try require(try read(core).projection.text == "开篇。\n潮汐。\n\n夜航。", "The waiting ⌫ left \(qlDescribe(core))")
        view.undoProse(); try qlSettled(host, view, twin)
        try require(try read(core).projection.text == "开篇。\n潮汐。\n\u{fffc}\n\n夜航。", "Undo did not bring the rule back")

        // Typing over the rule is refused before anything is queued.
        let rule = try qlRuleLocation(core)
        let current = view.textView.string
        view.textView.setSelectedRange(NSRange(location: rule - 2, length: 4))
        view.textView.insertText("换", replacementRange: NSRange(location: rule - 2, length: 4))
        try require(view.textView.string == current && !view.binding.hasPendingWork && !view.binding.hasFailedDraft
                    && (try qlStatus(view)).contains("分隔线不能和文字一起改写"), "Typing over the rule read “\(try qlStatus(view))”")

        // Printing: a centred thin line, not text.
        let stored: WorkspaceBodyProjection = try elementResult {
            page.workspace.readProjection(projectID: page.project.id, kind: "chapter", id: page.chapter.id, completion: $0)
        }
        let typeset = PrintTypesetter().body(stored.projection)
        let at = (typeset.string as NSString).range(of: "\u{fffc}").location
        guard at != NSNotFound, let attachment = typeset.attribute(.attachment, at: at, effectiveRange: nil) as? NSTextAttachment,
              attachment.attachmentCell is PrintRuleCell else { throw LabError.message("The printed rule is not a line: \(typeset.string.debugDescription)") }
        try require((typeset.attribute(.paragraphStyle, at: at, effectiveRange: nil) as? NSParagraphStyle)?.alignment == .center
                    && !typeset.string.contains("＊"), "The printed rule is not centred")
        let output = page.directory.deletingLastPathComponent().appendingPathComponent("rules.pdf")
        let printing = MacPrintCoordinator(workspace: page.workspace)
        let a4 = NSPrintInfo()
        a4.paperSize = PrintPaper.a4.size
        printing.printInfo = { a4 }
        printing.runPrintOperation = { operation, _ in
            operation.printInfo.jobDisposition = .save
            operation.printInfo.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = output
            operation.showsPrintPanel = false
            operation.showsProgressPanel = false
            operation.run()
        }
        guard let target = host.activeHistoryTarget else { throw LabError.message("No focused page to print") }
        let drawnBefore = PrintRuleCell.drawn
        let pages: Int = try elementResult {
            printing.print(MacPrintCoordinator.Target(projectID: target.projectID, kind: target.kind, id: target.id, title: target.title),
                           window: nil, completion: $0)
        }
        try require(pages >= 1 && PrintRuleCell.drawn > drawnBefore && PDFDocument(url: output) != nil, "Printing drew no rule")

        // The 全书长卷's editor row and read-only preview.
        let row = NativeDocumentView(core: core, minimumTextHeight: 48, growsWithText: true)
        row.frame = NSRect(x: 0, y: 0, width: 640, height: 400)
        row.binding.load()
        try wait { row.binding.state != nil && !row.binding.hasPendingWork && row.textView.string == view.textView.string }
        row.layoutSubtreeIfNeeded()
        try qlRequireRuleDrawn(row.textView, at: rule, "The long page's editor row")
        try require(row.markerStrip == nil, "The long page's row has scrollbar markers")
        try require(row.binding.detach(), "The long page's row did not detach")
        let preview = WholeBookPreviewText(frame: NSRect(x: 0, y: 0, width: 640, height: 400))
        let styled = NSTextStorage(string: view.textView.string)
        DocumentStyle.apply(try read(core).projection, to: styled)
        preview.show(styled)
        preview.prepare(width: 640)
        preview.layoutSubtreeIfNeeded()
        try qlRequireRuleDrawn(preview.textView, at: rule, "The long page's preview")

        // Cold reopen keeps the rule; the 历史版本 preview draws it.
        let expected = try read(core).projection
        try page.close()
        let cold = LabWorkspaceCore(directory: page.directory)
        let (coldWindow, coldHost) = elementHost(cold)
        defer { coldWindow.close() }
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let reopened: NativeDocumentView = try elementResult { coldHost.open(project: page.project, chapter: page.chapter, completion: $0) }
        try qlSettled(coldHost, reopened)
        guard let coldProjection = reopened.binding.store.projection else { throw LabError.message("The reopened chapter has no projection") }
        try require(coldProjection.text == expected.text && coldProjection.blocks.map(\.id) == expected.blocks.map(\.id)
                    && coldProjection.blocks.map(\.kind) == expected.blocks.map(\.kind), "The rule did not survive a cold reopen")
        try qlRequireRuleDrawn(reopened.textView, at: rule, "The reopened editor")
        let closed: Bool = try elementResult {
            coldHost.closeTab(pane: 0, scope: .chapter(ChapterScope(projectID: page.project.id, chapterID: page.chapter.id)), completion: $0)
        }
        try require(closed, "The chapter did not close")
        let historyTarget = VersionHistoryTarget(projectID: page.project.id, kind: "chapter", id: page.chapter.id, title: page.chapter.title)
        let model = VersionHistoryModel(workspace: cold, target: historyTarget)
        let sheet = VersionHistorySheet(model: model)
        sheet.begin(in: nil)
        model.load()
        try wait { model.loaded && !model.busy }
        guard let version = model.entries.first else { throw LabError.message("No version was kept on close") }
        sheet.select(entryID: version.id)
        try wait { model.preview(of: version) != nil }
        sheet.diffCheckbox.state = .off
        sheet.reload()
        sheet.previewView.frame = NSRect(x: 0, y: 0, width: 640, height: 400)
        try qlRequireRuleDrawn(sheet.previewView, at: rule, "The 历史版本 preview")
        sheet.close()
        let shut: Bool = try elementResult { coldHost.close(completion: $0) }
        try require(shut, "The cold workspace did not close")
    }

    // MARK: Slash rows by place, and bounded drawing logs

    private static func qlSlashContext() throws {
        let page = try qlPage("开头\n甲\n乙\n\n引\n尾")
        defer { page.remove() }
        let (host, view, core) = (page.host, page.view, page.core)
        let twin: NativeDocumentView = try elementResult { host.split(completion: $0) }
        try qlSettled(host, view, twin)
        let first = try qlAt("甲", in: view), second = try qlAt("乙", in: view)
        view.binding.format(.orderedList, range: NSRange(location: first, length: second + 1 - first))
        try qlSettled(host, view)
        view.binding.format(.blockquote, range: NSRange(location: try qlAt("引", in: view), length: 0))
        try qlSettled(host, view)
        // A new empty last item: only its own list kind (which ends it),
        // alignment and 分隔线 are offered.
        let end = try qlAt("乙", in: view) + 1
        qlCaret(view, end)
        qlKey(view, #selector(NSResponder.insertNewline(_:)))
        try qlSettled(host, view)
        let item = try read(core).projection.blocks.firstIndex { $0.range.location == end + 1 }
        try require(item.map { (try? read(core).projection.blocks[$0].listNumber) == 3 } == true, "No empty item 3: \(qlDescribe(core))")
        qlType(view, "/", at: end + 1)
        try require(view.picker?.items.map(\.title) == ["有序列表", "居中", "右对齐", "分隔线"], "A list item's slash menu lists \(view.picker?.items.map(\.title) ?? [])")
        view.closePicker()
        qlKey(view, #selector(NSResponder.deleteBackward(_:)))
        try qlSettled(host, view)
        // In the quote: headings, alignment, 引用 (it is the quote's only paragraph) and 分隔线.
        let quote = try qlAt("引", in: view)
        qlCaret(view, quote + 1)
        qlKey(view, #selector(NSResponder.insertNewline(_:)))
        try qlSettled(host, view)
        qlType(view, "/", at: quote + 2)
        try require(view.picker?.items.map(\.title) == ["标题 1", "标题 2", "标题 3", "引用", "居中", "右对齐", "分隔线"],
                    "A quote's slash menu lists \(view.picker?.items.map(\.title) ?? [])")
        view.closePicker()
        qlKey(view, #selector(NSResponder.deleteBackward(_:)))
        try qlSettled(host, view)
        // A row whose format stopped applying before it was chosen keeps “/”.
        let tail = try qlAt("尾", in: view) + 1
        qlCaret(view, tail)
        qlKey(view, #selector(NSResponder.insertNewline(_:)))
        try qlSettled(host, view)
        let slash = tail + 1
        qlType(view, "/", at: slash)
        try require(view.picker?.items.contains { $0.title == "标题 1" } == true, "A root paragraph does not offer 标题 1")
        try qlSettled(host, view)
        // The other pane's owner makes the paragraph a list item meanwhile.
        twin.binding.format(.bulletList, range: NSRange(location: slash, length: 0))
        try qlSettled(host, view, twin)
        try require(view.picker != nil && view.textView.selectedRange() == NSRange(location: slash + 1, length: 0),
                    "The slash menu closed when the other pane listed its paragraph")
        let rows = try qlRows(page.directory)
        guard let heading = view.picker?.items.firstIndex(where: { $0.title == "标题 1" }) else { throw LabError.message("The picker closed") }
        view.choosePickerItem(heading)
        let refusal = try qlStatus(view)
        try qlSettled(host, view)
        try require((view.textView.string as NSString).substring(with: NSRange(location: slash, length: 1)) == "/"
                    && (try qlRows(page.directory)) == rows && refusal.contains("这里不能设为标题 1"),
                    "A row that no longer applies removed “/”: \(qlDescribe(core)) / \(refusal)")
        // Rows are filtered by place for any caller that names the block.
        let blocks = try read(core).projection.blocks
        let rootIndex = blocks.firstIndex { $0.containers.isEmpty && $0.editable }!
        try require(ProsePickers.slashItems(query: "", blocks: blocks, at: rootIndex).count == 10, "A root paragraph does not offer every row")
        // The drawing logs keep only the last entries.
        guard let text = view.textView as? ListMarkerTextView else { throw LabError.message("No marker view") }
        text.drawnMarkers = Array(repeating: "x", count: ListMarkerTextView.drawLogLimit + 40)
        let bounds = text.bounds
        if let rep = text.bitmapImageRepForCachingDisplay(in: bounds) { text.cacheDisplay(in: bounds, to: rep) }
        try require(text.drawnMarkers.count <= ListMarkerTextView.drawLogLimit && text.drawnMarkers.last == "•",
                    "The marker log grew to \(text.drawnMarkers.count)")
        try page.close()
    }
}
