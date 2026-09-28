import AppKit
import PDFKit

/// 格式 commands (underline, strike, alignment, indent), URL links, the slash
/// menu, find and the @ picker through real editors in the tab host, the
/// shared input queue, the Rust workspace and SQLite. Menu commands go
/// through a menu built from the app's layout whose editor items target the
/// prose; keys through the menu's key equivalents and the text system's key
/// commands (`doCommand(by:)`). Nothing is shown on screen; every name, body
/// and address is synthetic.
extension BindingAcceptance {
    static func formatExtrasAcceptance() throws -> [String] {
        let saved = (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay, NativeDocumentView.openURL)
        defer { (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay, NativeDocumentView.openURL) = saved }
        DocumentStore.entityLinkDelay = 0.05
        MacChapterWorkspace.backlinkDelay = 0.05
        try formatCommandsAndRendering()
        try urlLinksThroughTheSheet()
        try slashMenu()
        try findInTheEditor()
        try mentionPicker()
        try printingFormattedPage()
        return [
            "AppKit 格式 下划线 (⌘U), 删除线, 左对齐/居中/右对齐 (⌘{ ⌘| ⌘}) and 增加缩进/减少缩进 through the menu, their keys, the toolbar and the prose context menu's 格式 submenu, with checkmarks for the selection's marks and alignment, as one undo unit each; an unchanged alignment writes nothing, marked text disables them, and both panes of the chapter restyle",
            "AppKit Tab and ⇧Tab indent the caret's paragraph or every selected paragraph without inserting a tab, up to eight levels, also when pressed while typed text is still on its way; the editors draw underline, strike, paragraph alignment and a whole-block shift of two em per level that keeps the first-line indent, and all of it survives a cold reopen",
            "AppKit 链接… (⌘K) sets a URL link on the selection prefilled from a selected address, replaces it, keeps an entity link on the same text, refuses a javascript: address in the sheet and in Rust in Chinese without writing, edits the link around the caret, removes it from the sheet, the menu and the caret as one undo unit each, opens it by ⌘-click and 打开链接 through the injected opener, and survives a cold reopen",
            "AppKit slash menu opens when / (or 、) is typed at the start of an empty paragraph or heading, filters as typed, moves with ↑ and ↓, and Return removes the “/query” through the input path and applies a heading level, 正文, 居中 or 右对齐 once that input lands; Esc, moving the caret away and a query without matches close it leaving the text, and / elsewhere opens nothing",
            "AppKit ⌘F shows the editor's find bar with incremental search highlighting every match and no 替换, ⌘E takes the selection as the search text, ⌘G and ⇧⌘G (查找下一个, 查找上一个) select the next and previous match without writing, and a 全书长卷 row offers no find",
            "AppKit @ picker lists element names, aliases and chapter titles but not the body's own, filters as typed, and Return inserts the chosen name through the input path where the link pass links it to its element or chapter; Esc leaves the text, and ＋ 新建设定「…」 creates the element in the chosen category, inserts and links it",
            "AppKit 打印 of a page sets its paragraph alignment, block indent, underline and URL links from the live projection, and the printed PDF centres and shifts those lines",
        ]
    }

    // MARK: Harness

    private static func fxSettled(_ host: MacChapterWorkspace, _ views: NativeDocumentView...) throws {
        try wait {
            !host.isBusy && views.allSatisfy {
                $0.binding.state != nil && !$0.binding.hasPendingWork && !$0.binding.store.hasScheduledLinks
                    && !$0.binding.store.isLinking && $0.deferredFormat == nil
            }
        }
    }

    private static func fxType(_ view: NativeDocumentView, _ text: String, at location: Int? = nil) {
        let at = location ?? (view.textView.string as NSString).length
        view.textView.setSelectedRange(NSRange(location: at, length: 0))
        view.textView.insertText(text, replacementRange: NSRange(location: at, length: 0))
    }

    private static func fxRange(_ text: String, in view: NativeDocumentView) throws -> NSRange {
        let found = (view.textView.string as NSString).range(of: text)
        try require(found.location != NSNotFound, "“\(text)” is not in the prose")
        return found
    }

    private static func fxSelect(_ view: NativeDocumentView, _ range: NSRange) {
        view.textView.setSelectedRange(range)
    }

    /// The app's menu, its editor commands aimed at this prose (as the
    /// responder chain would when it has the keyboard).
    private static func editorMenu(_ view: NativeDocumentView) -> NSMenu {
        let menu = MacMainMenu.build([:])
        for top in menu.items {
            for item in top.submenu?.items ?? [] {
                guard let command = MacMenuCommand(identifier: item.identifier), command != .quit, command.responderAction != nil else { continue }
                item.target = view.textView
            }
        }
        return menu
    }

    private static func menuItem(_ menu: NSMenu, _ command: MacMenuCommand) throws -> NSMenuItem {
        guard let item = MacMainMenu.item(command, in: menu) else { throw LabError.message("No menu item for \(command.rawValue)") }
        item.menu?.update()
        return item
    }

    private static func choose(_ menu: NSMenu, _ command: MacMenuCommand) throws {
        let item = try menuItem(menu, command)
        try require(item.isEnabled, "\(command.title) is disabled")
        guard let parent = item.menu else { throw LabError.message("\(command.title) has no menu") }
        parent.performActionForItem(at: parent.index(of: item))
    }

    private static func state(_ menu: NSMenu, _ command: MacMenuCommand) throws -> NSControl.StateValue {
        try menuItem(menu, command).state
    }

    private static func fxKey(_ characters: String, _ flags: NSEvent.ModifierFlags, code: UInt16) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                         windowNumber: 0, context: nil, characters: characters, charactersIgnoringModifiers: characters,
                         isARepeat: false, keyCode: code)!
    }

    private static func press(_ menu: NSMenu, _ characters: String, _ flags: NSEvent.ModifierFlags, code: UInt16) throws {
        try require(menu.performKeyEquivalent(with: fxKey(characters, flags, code: code)),
                    "The menu did not perform \(MenuShortcut(key: characters, flags: flags).display)")
    }

    private static func attribute(_ view: NativeDocumentView, _ key: NSAttributedString.Key, at index: Int) -> Any? {
        view.textView.textStorage?.attribute(key, at: index, effectiveRange: nil)
    }

    private static func paragraph(_ view: NativeDocumentView, at index: Int) throws -> NSParagraphStyle {
        guard let style = attribute(view, .paragraphStyle, at: index) as? NSParagraphStyle else {
            throw LabError.message("No paragraph style at \(index)")
        }
        return style
    }

    private static func block(_ core: LabCore, containing index: Int) throws -> NativeBlock {
        let projection = try read(core).projection
        guard let found = NativeLayout.index(index, blocks: projection.blocks) else { throw LabError.message("No block at \(index)") }
        return projection.blocks[found]
    }

    private static func run(_ core: LabCore, at index: Int) throws -> NativeMarks {
        guard let found = try read(core).projection.run(at: index) else { throw LabError.message("No run at \(index)") }
        return found.run.attributes
    }

    /// Stored prose rows: an unchanged command adds none.
    private static func proseRows(_ directory: URL) throws -> [Int64] {
        try ["yjs_updates", "yjs_document_revision_provenance"].map { table in
            guard case .integer(let value)? = try WorkspaceRemoteProseFixture.query(in: directory,
                sql: "SELECT COUNT(*) AS n FROM \(table)").first?["n"] else { throw LabError.message("Count of \(table) failed") }
            return value
        }
    }

    private static func contextMenu(_ view: NativeDocumentView, at index: Int) throws -> NSMenu {
        guard let window = view.window, let event = NSEvent.mouseEvent(with: .rightMouseDown, location: .zero, modifierFlags: [],
            timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1),
              let menu = view.textView(view.textView, menu: NSMenu(), for: event, at: index) else {
            throw LabError.message("Prose context menu was not built")
        }
        return menu
    }

    private static func commandClick(_ view: NativeDocumentView, at index: Int) throws -> NSEvent {
        guard let window = view.window else { throw LabError.message("Prose is not in a window") }
        window.contentView?.layoutSubtreeIfNeeded()
        let rect = view.textView.firstRect(forCharacterRange: NSRange(location: index, length: 1), actualRange: nil)
        let point = window.convertPoint(fromScreen: NSPoint(x: rect.midX, y: rect.midY))
        guard let event = NSEvent.mouseEvent(with: .leftMouseDown, location: point, modifierFlags: .command, timestamp: 0,
            windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else {
            throw LabError.message("Could not create a synthetic ⌘-click")
        }
        return event
    }

    private static func control<T: NSView>(_ root: NSView, _ identifier: String, as type: T.Type) throws -> T {
        if let match = root as? T, root.accessibilityIdentifier() == identifier { return match }
        for child in root.subviews {
            if let found = try? control(child, identifier, as: type) { return found }
        }
        throw LabError.message("No control \(identifier)")
    }

    /// A chapter with synthetic prose, open in a tab of the host.
    private struct Page {
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

    private static func page(_ text: String, setup: ((LabWorkspaceCore, WorkspaceProject) throws -> Void)? = nil) throws -> Page {
        let (directory, workspace, project, chapter) = try elementFixture()
        try setup?(workspace, project)
        let (window, host) = elementHost(workspace)
        host.elementsChanged(projectID: project.id)
        let view: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
        try fxSettled(host, view)
        try wait { host.linkDirectory(projectID: project.id) != nil && view.linkDirectory != nil }
        guard let core = host.activeCore else { throw LabError.message("The chapter has no owner") }
        if !text.isEmpty { fxType(view, text); try fxSettled(host, view) }
        return Page(directory: directory, workspace: workspace, project: project, chapter: chapter, window: window, host: host,
                    view: view, core: core)
    }

    // MARK: 格式 commands

    private static func formatCommandsAndRendering() throws {
        let text = "北岸灯塔的光扫过港口。\n潮水退去，礁石露出来。\n夜渡船靠岸。"
        let page = try page(text)
        defer { page.remove() }
        let (host, view, core) = (page.host, page.view, page.core)
        let twin: NativeDocumentView = try elementResult { host.split(completion: $0) }
        try fxSettled(host, view, twin)
        try require(twin.binding.store === view.binding.store && twin.textView.string == text, "The second pane does not share the chapter")
        let menu = editorMenu(view)
        let size = DocumentStyle.typography.size

        // 下划线 by ⌘U over 灯塔: one undo unit, both panes, checkmark.
        let lamp = try fxRange("灯塔", in: view)
        fxSelect(view, lamp)
        try require(try state(menu, .underline) == .off && (try menuItem(menu, .underline)).isEnabled, "下划线 is not offered on a selection")
        try press(menu, "u", .command, code: 32)
        try fxSettled(host, view, twin)
        try require(try run(core, at: lamp.location).underline && !(try run(core, at: 0).underline), "⌘U did not underline the selection only")
        for pane in [view, twin] {
            try require(attribute(pane, .underlineStyle, at: lamp.location) as? Int == NSUnderlineStyle.single.rawValue
                        && attribute(pane, .underlineStyle, at: 0) == nil, "A pane did not draw the underline")
        }
        try require(try state(menu, .underline) == .on && view.textView.selectedRange() == lamp, "The underline checkmark or selection is wrong")
        view.undoProse(); try fxSettled(host, view, twin)
        try require(!(try run(core, at: lamp.location).underline) && attribute(twin, .underlineStyle, at: lamp.location) == nil,
                    "One undo did not remove the underline")
        view.redoProse(); try fxSettled(host, view, twin)
        try require(try run(core, at: lamp.location).underline, "Redo did not restore the underline")

        // 删除线 from the menu; a wider selection reads as mixed.
        fxSelect(view, lamp)
        try choose(menu, .strike)
        try fxSettled(host, view, twin)
        try require(try run(core, at: lamp.location).strike
                    && attribute(twin, .strikethroughStyle, at: lamp.location) as? Int == NSUnderlineStyle.single.rawValue,
                    "删除线 did not strike the selection in both panes")
        fxSelect(view, NSRange(location: 0, length: 6))
        try require(try state(menu, .strike) == .mixed && (try state(menu, .underline)) == .mixed, "A partly marked selection is not mixed")
        // The toolbar's 下划线 toggles the same mark.
        fxSelect(view, lamp)
        try control(view, "format-underline", as: NSButton.self).performClick(nil)
        try fxSettled(host, view, twin)
        try require(!(try run(core, at: lamp.location).underline), "The toolbar's 下划线 did not toggle the mark off")
        view.undoProse(); try fxSettled(host, view, twin)
        try require(try run(core, at: lamp.location).underline, "Undo did not restore the toolbar's change")

        // Alignment by ⌘| ⌘} ⌘{ at a caret; a selection takes every block.
        let tide = try fxRange("潮水", in: view)
        fxSelect(view, NSRange(location: tide.location + 1, length: 0))
        try require(try state(menu, .alignLeft) == .on && (try state(menu, .alignCenter)) == .off, "Left is not the checked default")
        try press(menu, "|", [.command, .shift], code: 42)
        try fxSettled(host, view, twin)
        try require(try block(core, containing: tide.location).textAlign == "center" && (try block(core, containing: 0)).textAlign == nil,
                    "⌘| did not centre the caret's paragraph only")
        for pane in [view, twin] {
            try require(try paragraph(pane, at: tide.location).alignment == .center && (try paragraph(pane, at: 0)).alignment == .natural,
                        "A pane did not centre the paragraph")
        }
        try require(try state(menu, .alignCenter) == .on && (try state(menu, .alignLeft)) == .off, "The 居中 checkmark is wrong")
        try press(menu, "}", [.command, .shift], code: 30)
        try fxSettled(host, view, twin)
        try require(try block(core, containing: tide.location).textAlign == "right" && (try paragraph(twin, at: tide.location)).alignment == .right,
                    "⌘} did not right-align")
        view.undoProse(); try fxSettled(host, view, twin)
        try require(try block(core, containing: tide.location).textAlign == "center", "One undo did not restore the centring")
        try press(menu, "{", [.command, .shift], code: 33)
        try fxSettled(host, view, twin)
        try require(try block(core, containing: tide.location).textAlign == nil && (try paragraph(view, at: tide.location)).alignment == .natural,
                    "⌘{ did not return the paragraph to the left")
        // Already left: nothing is written, the revision stays.
        let rows = try proseRows(page.directory), revision = try read(core).projection.revision
        try choose(menu, .alignLeft)
        try fxSettled(host, view, twin)
        try require(try proseRows(page.directory) == rows && (try read(core).projection.revision) == revision,
                    "An unchanged alignment wrote to the document")
        // A selection across two paragraphs centres both in one unit.
        fxSelect(view, NSRange(location: 3, length: tide.location + 2 - 3))
        try choose(menu, .alignCenter)
        try fxSettled(host, view, twin)
        try require(try block(core, containing: 0).textAlign == "center" && (try block(core, containing: tide.location)).textAlign == "center"
                    && (try block(core, containing: (text as NSString).length - 1)).textAlign == nil, "A selection did not centre the blocks it touches")
        try require(try state(menu, .alignCenter) == .on, "Two centred paragraphs are not checked")
        view.undoProse(); try fxSettled(host, view, twin)
        try require(try block(core, containing: 0).textAlign == nil && (try block(core, containing: tide.location)).textAlign == nil,
                    "One undo did not restore both paragraphs")
        // The toolbar's alignment menu.
        fxSelect(view, NSRange(location: 1, length: 0))
        let alignMenu = try control(view, "format-align", as: NSPopUpButton.self)
        alignMenu.selectItem(withTitle: "右对齐")
        _ = alignMenu.target?.perform(alignMenu.action, with: alignMenu)
        try fxSettled(host, view, twin)
        try require(try block(core, containing: 0).textAlign == "right", "The toolbar's 右对齐 did not apply")
        view.undoProse(); try fxSettled(host, view, twin)

        // Tab and ⇧Tab indent the block; no tab character is typed.
        let ferry = try fxRange("夜渡", in: view)
        fxSelect(view, NSRange(location: ferry.location + 2, length: 0))
        view.textView.doCommand(by: #selector(NSResponder.insertTab(_:)))
        try fxSettled(host, view, twin)
        try require(try block(core, containing: ferry.location).indent == 1 && view.textView.string == text && twin.textView.string == text,
                    "Tab did not indent the paragraph or typed a tab")
        let indented = try paragraph(twin, at: ferry.location)
        try require(abs(indented.headIndent - 2 * size) < 0.01 && abs(indented.firstLineHeadIndent - 2 * size) < 0.01,
                    "One level is not a two-em shift: \(indented.headIndent)")
        view.textView.doCommand(by: #selector(NSResponder.insertTab(_:)))
        try fxSettled(host, view, twin)
        try require(try block(core, containing: ferry.location).indent == 2 && abs((try paragraph(view, at: ferry.location)).headIndent - 4 * size) < 0.01,
                    "A second Tab did not indent further")
        // The shift keeps 设置's first-line indent on top.
        let typography = DocumentStyle.typography
        var indentedTypography = typography
        indentedTypography.paragraphIndent = size * 2
        DocumentStyle.typography = indentedTypography
        let firstLine = try paragraph(view, at: ferry.location)
        DocumentStyle.typography = typography
        try require(abs(firstLine.headIndent - 4 * size) < 0.01 && abs(firstLine.firstLineHeadIndent - 6 * size) < 0.01,
                    "The block shift did not keep the first-line indent: \(firstLine.firstLineHeadIndent)")
        view.textView.doCommand(by: #selector(NSResponder.insertBacktab(_:)))
        try fxSettled(host, view, twin)
        try require(try block(core, containing: ferry.location).indent == 1, "⇧Tab did not outdent")
        try choose(menu, .indentIncrease)
        try fxSettled(host, view, twin)
        try require(try block(core, containing: ferry.location).indent == 2, "增加缩进 did not indent")
        try choose(menu, .indentDecrease)
        try fxSettled(host, view, twin)
        try require(try block(core, containing: ferry.location).indent == 1, "减少缩进 did not outdent")
        view.undoProse(); try fxSettled(host, view, twin)
        try require(try block(core, containing: ferry.location).indent == 2, "One undo did not restore the indent level")
        // Tab pressed while typed text is on its way indents once it lands.
        fxType(view, "橹", at: ferry.location + 2)
        try require(view.binding.hasPendingWork, "The typed text was not queued")
        view.textView.doCommand(by: #selector(NSResponder.insertTab(_:)))
        try fxSettled(host, view, twin)
        try require(try block(core, containing: ferry.location).indent == 3 && view.textView.string.contains("夜渡橹船"),
                    "Tab during queued input was lost: \(try block(core, containing: ferry.location).indent)")
        // Eight levels at most; a ninth Tab writes nothing.
        for _ in 0..<6 {
            view.textView.doCommand(by: #selector(NSResponder.insertTab(_:)))
            try fxSettled(host, view, twin)
        }
        let clamped = try proseRows(page.directory)
        try require(try block(core, containing: ferry.location).indent == 8, "Indent did not stop at eight")
        view.textView.doCommand(by: #selector(NSResponder.insertTab(_:)))
        try fxSettled(host, view, twin)
        try require(try proseRows(page.directory) == clamped && (try block(core, containing: ferry.location)).indent == 8,
                    "A Tab past eight levels wrote to the document")
        // A selection indents every paragraph it touches.
        fxSelect(view, NSRange(location: 2, length: tide.location - 2 + 1))
        view.textView.doCommand(by: #selector(NSResponder.insertTab(_:)))
        try fxSettled(host, view, twin)
        try require(try block(core, containing: 0).indent == 1 && (try block(core, containing: tide.location)).indent == 1,
                    "Tab did not indent every selected paragraph")

        // The context menu's 格式 submenu: the same commands, checked.
        fxSelect(view, lamp)
        let context = try contextMenu(view, at: lamp.location)
        guard let format = context.items.first(where: { $0.title == "格式" })?.submenu else { throw LabError.message("No 格式 submenu") }
        format.update()
        let titles = format.items.filter { !$0.isSeparatorItem }.map(\.title)
        try require(titles == ["加粗", "斜体", "下划线", "删除线", "正文", "标题 1", "标题 2", "标题 3", "左对齐", "居中", "右对齐",
                               "增加缩进", "减少缩进", "链接…", "移除链接"], "The 格式 submenu lists \(titles)")
        let item = { (title: String) in format.items.first { $0.title == title }! }
        try require(item("下划线").state == .on && item("删除线").state == .on && item("加粗").state == .off
                    && item("左对齐").state == .on && item("正文").state == .on && item("移除链接").isEnabled == false,
                    "The 格式 submenu's checkmarks are wrong")
        format.performActionForItem(at: format.index(of: item("居中")))
        try fxSettled(host, view, twin)
        try require(try block(core, containing: lamp.location).textAlign == "center", "The context menu's 居中 did not apply")

        // Marked text disables every new command in both panes.
        view.textView.setMarkedText("deng", selectedRange: NSRange(location: 4, length: 0), replacementRange: NSRange(location: 0, length: 0))
        for command in [MacMenuCommand.underline, .strike, .alignCenter, .indentIncrease, .link] {
            try require(!(try menuItem(menu, command)).isEnabled, "\(command.title) stayed enabled during composition")
        }
        try require(!twin.binding.canFormat(.alignRight, range: NSRange(location: 0, length: 0)), "Composition enabled alignment in the other pane")
        view.textView.insertText("", replacementRange: NSRange(location: NSNotFound, length: 0))
        try fxSettled(host, view, twin)

        // A heading keeps its alignment and indent.
        fxSelect(view, NSRange(location: 0, length: 0))
        try choose(menu, .heading2)
        try fxSettled(host, view, twin)
        let heading = try block(core, containing: 0)
        try require(heading.kind == "heading" && heading.textAlign == "center" && heading.indent == 1, "A heading lost its alignment or indent")

        // Cold reopen: attributes and marks are stored and drawn again.
        let expected = try read(core).projection
        try page.close()
        let cold = LabWorkspaceCore(directory: page.directory)
        let (coldWindow, coldHost) = elementHost(cold)
        defer { coldWindow.close() }
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let reopened: NativeDocumentView = try elementResult { coldHost.open(project: page.project, chapter: page.chapter, completion: $0) }
        try fxSettled(coldHost, reopened)
        let projection = reopened.binding.store.projection!
        try require(projection.text == expected.text && projection.blocks.map(\.textAlign) == expected.blocks.map(\.textAlign)
                    && projection.blocks.map(\.indent) == expected.blocks.map(\.indent) && projection.blocks.map(\.kind) == expected.blocks.map(\.kind),
                    "Alignment and indent did not survive a cold reopen")
        let ferryAt = try fxRange("夜渡", in: reopened).location
        let lampAt = try fxRange("灯塔", in: reopened).location
        try require(attribute(reopened, .underlineStyle, at: lampAt) as? Int == NSUnderlineStyle.single.rawValue
                    && attribute(reopened, .strikethroughStyle, at: lampAt) as? Int == NSUnderlineStyle.single.rawValue
                    && (try paragraph(reopened, at: 0)).alignment == .center
                    && abs((try paragraph(reopened, at: ferryAt)).headIndent - 16 * size) < 0.01,
                    "The reopened editor does not draw the stored formats")
        try requireStyleReference(reopened.textView.textStorage!, projection, "cold format extras", links: reopened.linkDirectory)
        let closed: Bool = try elementResult { coldHost.close(completion: $0) }
        try require(closed, "The cold workspace did not close")
    }

    // MARK: URL links

    private static func urlLinksThroughTheSheet() throws {
        var kai: WorkspaceElement?
        let text = "林凯在港口读到 https://example.invalid/tide 上的潮汐表和告示。"
        let page = try page(text) { workspace, project in
            let people: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
                workspace.createElementCategory(projectID: project.id, name: "人物", completion: $0)
            }
            let created: WorkspaceElementReply<WorkspaceElement> = try elementResult {
                workspace.createElement(projectID: project.id, categoryID: people.result!.id, name: "林凯", completion: $0)
            }
            kai = created.result
        }
        defer { page.remove() }
        let (host, view, core) = (page.host, page.view, page.core)
        try wait { view.linkTargets(at: 0).first?.id == kai?.id }
        try fxSettled(host, view)
        let menu = editorMenu(view)
        var opened: [URL] = []
        NativeDocumentView.openURL = { opened.append($0) }

        // A selected address prefills the sheet; 好 links it.
        let address = try fxRange("https://example.invalid/tide", in: view)
        fxSelect(view, address)
        try require(!(try menuItem(menu, .removeLink)).isEnabled, "移除链接 is enabled without a link")
        try press(menu, "k", .command, code: 40)
        guard let sheet = view.linkSheet else { throw LabError.message("⌘K did not open 链接…") }
        try require(sheet.address == "https://example.invalid/tide" && !sheet.hasLink, "The sheet was not prefilled from the address")
        sheet.submit()
        try fxSettled(host, view)
        try require(view.linkSheet == nil && (try run(core, at: address.location)).href == "https://example.invalid/tide",
                    "好 did not link the selection")
        try require(attribute(view, .foregroundColor, at: address.location) as? NSColor == .linkColor
                    && attribute(view, .underlineStyle, at: address.location) as? Int == NSUnderlineStyle.single.rawValue,
                    "The URL link is not drawn in the link colour, underlined")
        view.undoProse(); try fxSettled(host, view)
        try require(try run(core, at: address.location).href == nil, "One undo did not remove the new link")
        view.redoProse(); try fxSettled(host, view)
        try require(try run(core, at: address.location).href == "https://example.invalid/tide", "Redo did not restore the link")

        // The toolbar's 链接… on plain text: a bare domain means https.
        let notice = try fxRange("告示", in: view)
        fxSelect(view, notice)
        try control(view, "format-link", as: NSButton.self).performClick(nil)
        guard let second = view.linkSheet else { throw LabError.message("链接… did not open from the toolbar") }
        try require(second.address.isEmpty, "Plain text prefilled an address")
        // javascript: is refused in the sheet: nothing written, the text kept.
        let rows = try proseRows(page.directory), revision = try read(core).projection.revision
        second.address = "javascript:alert(1)"
        second.submit()
        try require(view.linkSheet === second && second.errorMessage.contains("链接地址需要以") && second.address == "javascript:alert(1)"
                    && (try proseRows(page.directory)) == rows && (try read(core).projection.revision) == revision,
                    "The sheet did not refuse javascript: in Chinese: \(second.errorMessage)")
        second.address = "example.invalid/notice"
        second.submit()
        try fxSettled(host, view)
        try require(try run(core, at: notice.location).href == "https://example.invalid/notice", "A bare domain did not become https")
        // Rust refuses one too, in Chinese, and the owner stays usable.
        var refusal: Error?
        view.binding.link(range: notice, href: "javascript:void(0)") { refusal = $0 }
        try wait { refusal != nil }
        try fxSettled(host, view)
        try require(refusal.map { $0.localizedDescription.contains("链接地址需要以") } == true && view.binding.canEdit
                    && (try run(core, at: notice.location)).href == "https://example.invalid/notice",
                    "Rust's refusal was not a kept, Chinese formatting refusal: \(String(describing: refusal))")

        // The same address again writes nothing; another replaces it.
        let before = try proseRows(page.directory)
        fxSelect(view, notice)
        try choose(menu, .link)
        try require(view.linkSheet?.address == "https://example.invalid/notice" && view.linkSheet?.hasLink == true,
                    "An existing link did not prefill the sheet")
        view.linkSheet?.submit()
        try fxSettled(host, view)
        try require(try proseRows(page.directory) == before && view.linkSheet == nil, "Setting the same address wrote to the document")
        // A caret inside the link: ⌘K selects the whole link to edit it.
        fxSelect(view, NSRange(location: notice.location + 1, length: 0))
        try press(menu, "k", .command, code: 40)
        try require(view.textView.selectedRange() == notice && view.linkSheet?.hasLink == true, "⌘K at a caret did not take the link around it")
        view.linkSheet?.address = "mailto:harbour@example.invalid"
        view.linkSheet?.submit()
        try fxSettled(host, view)
        try require(try run(core, at: notice.location).href == "mailto:harbour@example.invalid", "The edited address did not replace the link")

        // A URL link on an entity-linked name keeps the entity link.
        let name = try fxRange("林凯", in: view)
        fxSelect(view, name)
        try choose(menu, .link)
        view.linkSheet?.address = "https://example.invalid/kai"
        view.linkSheet?.submit()
        try fxSettled(host, view)
        let both = try run(core, at: name.location)
        try require(both.href == "https://example.invalid/kai" && both.links.map(\.id) == [kai!.id], "The URL link replaced the entity link")
        try require(view.linkTargets(at: name.location).first?.id == kai!.id
                    && attribute(view, .foregroundColor, at: name.location) as? NSColor != .linkColor, "The entity link lost its own style")
        let menuAtName = try contextMenu(view, at: name.location)
        try require(menuAtName.items.contains { $0.title == "打开「林凯」" } && menuAtName.items.contains { $0.title == "打开链接" },
                    "The context menu does not offer both links")

        // ⌘-click opens the address; the context menu's 打开链接 too.
        let unopened = try read(core).projection.revision
        fxSelect(view, NSRange(location: 0, length: 0))
        view.textView.mouseDown(with: try commandClick(view, at: address.location + 3))
        try require(opened == [URL(string: "https://example.invalid/tide")!] && view.textView.selectedRange() == NSRange(location: 0, length: 0),
                    "⌘-click did not open the address through the opener: \(opened)")
        let linkMenu = try contextMenu(view, at: address.location + 3)
        guard let open = linkMenu.items.first(where: { $0.title == "打开链接" }) else { throw LabError.message("No 打开链接") }
        linkMenu.performActionForItem(at: linkMenu.index(of: open))
        try require(opened.count == 2 && opened[1] == opened[0], "打开链接 did not open the address")
        try require(try read(core).projection.revision == unopened && view.textView.string == text, "Opening a link changed the prose")

        // 移除链接 at a caret removes the whole link, one undo unit.
        fxSelect(view, NSRange(location: address.location + 5, length: 0))
        try require(try menuItem(menu, .removeLink).isEnabled, "移除链接 is not offered inside a link")
        try choose(menu, .removeLink)
        try fxSettled(host, view)
        try require(try run(core, at: address.location).href == nil && (try run(core, at: NSMaxRange(address) - 1)).href == nil,
                    "移除链接 did not remove the whole link")
        view.undoProse(); try fxSettled(host, view)
        try require(try run(core, at: NSMaxRange(address) - 1).href == "https://example.invalid/tide", "One undo did not restore the link")
        // The sheet's 移除链接.
        fxSelect(view, notice)
        try choose(menu, .link)
        view.linkSheet?.removeLink()
        try fxSettled(host, view)
        try require(try run(core, at: notice.location).href == nil && view.linkSheet == nil, "The sheet's 移除链接 did not remove the link")

        // Cold reopen keeps the links.
        let expected = try read(core).projection.blocks.flatMap { $0.runs.map { $0.attributes.href } }
        try page.close()
        let cold = LabWorkspaceCore(directory: page.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let coldCore: LabCore = try elementResult { cold.openChapter(projectID: page.project.id, chapterID: page.chapter.id, completion: $0) }
        let stored = try read(coldCore).projection.blocks.flatMap { $0.runs.map { $0.attributes.href } }
        try require(stored == expected && stored.contains("https://example.invalid/tide") && stored.contains("https://example.invalid/kai"),
                    "URL links did not survive a cold reopen")
        let closed: Bool = try elementResult { cold.close(completion: $0) }
        try require(closed, "The cold workspace did not close")
    }

    // MARK: Slash menu

    private static func slashMenu() throws {
        let page = try page("第一段。")
        defer { page.remove() }
        let (host, view, core) = (page.host, page.view, page.core)
        func typeSlash(_ trigger: String = "/") throws {
            fxType(view, "\n")
            try fxSettled(host, view)
            fxType(view, trigger)
        }
        try typeSlash()
        guard let opened = view.picker, opened.kind == .slash else { throw LabError.message("/ did not open the slash menu") }
        try require(opened.items.map(\.title) == ["正文", "标题 1", "标题 2", "标题 3", "居中", "右对齐"] && !view.isPickerShown,
                    "The slash menu lists \(opened.items.map(\.title))")
        fxType(view, "标")
        try require(view.picker?.items.map(\.title) == ["标题 1", "标题 2", "标题 3"] && view.picker?.query == "标", "Typing did not filter the menu")
        view.textView.doCommand(by: #selector(NSResponder.moveDown(_:)))
        view.textView.doCommand(by: #selector(NSResponder.moveDown(_:)))
        view.textView.doCommand(by: #selector(NSResponder.moveUp(_:)))
        try require(view.picker?.selected == 1, "↑ and ↓ did not move the choice")
        view.textView.doCommand(by: #selector(NSResponder.insertNewline(_:)))
        try fxSettled(host, view)
        let chosen = try read(core).projection
        try require(view.picker == nil && chosen.text == "第一段。\n" && chosen.blocks[1].kind == "heading" && chosen.blocks[1].headingLevel == 2,
                    "Return did not remove /标 and apply 标题 2: \(chosen.text.debugDescription)")
        fxType(view, "港口夜话")
        try fxSettled(host, view)
        try require(try read(core).projection.blocks[1].kind == "heading", "Typing after the slash menu lost the heading")
        view.undoProse(); try fxSettled(host, view)
        view.undoProse(); try fxSettled(host, view)
        try require(try read(core).projection.blocks[1].kind == "paragraph" && (try read(core).projection.text) == "第一段。\n",
                    "Undo did not step back through the format")

        // A keyword: h1; the full-width 、 opens it too; 居中 and 右对齐.
        fxType(view, "、")
        try require(view.picker?.kind == .slash, "、 did not open the slash menu")
        fxType(view, "居")
        try require(view.picker?.items.map(\.title) == ["居中"], "居 did not filter to 居中")
        view.textView.doCommand(by: #selector(NSResponder.insertNewline(_:)))
        try fxSettled(host, view)
        try require(try read(core).projection.text == "第一段。\n" && (try read(core).projection.blocks[1]).textAlign == "center",
                    "居中 was not applied to the empty paragraph")
        // Enter carries the centring; the empty paragraph's separator draws it.
        fxType(view, "\n")
        try fxSettled(host, view)
        try require(try read(core).projection.blocks[2].textAlign == "center" && (try paragraph(view, at: 5)).alignment == .center,
                    "The empty centred paragraph does not draw its alignment")
        try typeSlash()
        fxType(view, "h1")
        try require(view.picker?.items.map(\.title) == ["标题 1"], "h1 did not find 标题 1")
        view.textView.doCommand(by: #selector(NSResponder.insertNewline(_:)))
        try fxSettled(host, view)
        let heading = try read(core).projection.blocks.last!
        try require(heading.kind == "heading" && heading.headingLevel == 1 && heading.textAlign == "center",
                    "标题 1 did not apply (keeping the centring Enter carried)")
        // In the empty heading: 正文 turns it back, 右对齐 aligns it.
        fxType(view, "/")
        try require(view.picker?.kind == .slash, "/ in an empty heading did not open the menu")
        fxType(view, "正")
        view.textView.doCommand(by: #selector(NSResponder.insertNewline(_:)))
        try fxSettled(host, view)
        try require(try read(core).projection.blocks.last!.kind == "paragraph" && !view.textView.string.hasSuffix("正"),
                    "正文 did not turn the heading back into a paragraph")
        fxType(view, "/")
        fxType(view, "右")
        try require(view.picker?.items.map(\.title) == ["右对齐"], "右 did not filter to 右对齐")
        view.textView.doCommand(by: #selector(NSResponder.insertNewline(_:)))
        try fxSettled(host, view)
        try require(try read(core).projection.blocks.last!.textAlign == "right" && view.textView.string.hasSuffix("\n"),
                    "右对齐 did not apply to the empty paragraph")

        // Esc leaves the text; moving away closes; no match closes.
        try typeSlash()
        try require(view.picker != nil, "The slash menu did not open again")
        view.textView.doCommand(by: #selector(NSResponder.cancelOperation(_:)))
        try fxSettled(host, view)
        try require(view.picker == nil && (try read(core).projection.text).hasSuffix("\n/"), "Esc did not close the menu leaving /")
        fxType(view, "正")
        try require(view.picker == nil, "Typing after Esc reopened the menu")
        try typeSlash()
        fxSelect(view, NSRange(location: 1, length: 0))
        try require(view.picker == nil && view.textView.string.hasSuffix("\n/"), "Moving the caret away did not close the menu")
        try typeSlash()
        fxType(view, "xyz")
        try require(view.picker == nil, "A query without matches kept the menu open")
        try fxSettled(host, view)
        // / inside text opens nothing.
        fxType(view, "/", at: 2)
        try require(view.picker == nil, "/ in the middle of a paragraph opened the menu")
        try fxSettled(host, view)
        try page.close()
    }

    // MARK: Find

    private static func findInTheEditor() throws {
        let text = "灯塔在北岸。\n灯塔的光扫过港口。\n港口也有一座灯塔。"
        let page = try page(text)
        defer { page.remove() }
        let (host, view, core) = (page.host, page.view, page.core)
        let findBoard = NSPasteboard(name: .find)
        let savedFind = findBoard.string(forType: .string)
        defer {
            findBoard.clearContents()
            if let savedFind { findBoard.setString(savedFind, forType: .string) }
        }
        let menu = editorMenu(view)
        guard let finder = view.textFinder, let scroll = view.textView.enclosingScrollView else { throw LabError.message("The editor has no find") }
        try require(finder.isIncrementalSearchingEnabled, "Incremental search is off")
        for action in [NSTextFinder.Action.showReplaceInterface, .replace, .replaceAll, .replaceAndFind, .replaceAllInSelection] {
            try require(!finder.validateAction(action), "The find bar offers 替换 (\(action.rawValue))")
        }
        try require(try menuItem(menu, .find).isEnabled, "查找… is disabled")
        try press(menu, "f", .command, code: 3)
        try require(scroll.isFindBarVisible && scroll.findBarView != nil, "⌘F did not show the find bar")
        let revision = try read(core).projection.revision, rows = try proseRows(page.directory)
        // ⌘E takes the selection; the open bar highlights every match.
        let matches = [NSRange(location: 0, length: 2), NSRange(location: 7, length: 2), NSRange(location: 23, length: 2)]
        try require(matches.allSatisfy { (text as NSString).substring(with: $0) == "灯塔" }, "Synthetic matches are misplaced")
        fxSelect(view, matches[0])
        try press(menu, "e", .command, code: 14)
        try require(findBoard.string(forType: .string) == "灯塔", "⌘E did not take the selection as the search text")
        try wait { finder.incrementalMatchRanges.map(\.rangeValue) == matches }
        // With the bar closed, ⌘G and ⇧⌘G select the next and previous match
        // (with it open, incremental search selects the match on closing).
        finder.performAction(.hideFindInterface)
        try require(!scroll.isFindBarVisible, "The find bar did not hide")
        fxSelect(view, matches[0])
        try press(menu, "g", .command, code: 5)
        try require(view.textView.selectedRange() == matches[1], "⌘G did not select the next match: \(view.textView.selectedRange())")
        try press(menu, "g", .command, code: 5)
        try require(view.textView.selectedRange() == matches[2], "⌘G did not continue")
        try press(menu, "G", [.command, .shift], code: 5)
        try require(view.textView.selectedRange() == matches[1], "⇧⌘G did not select the previous match")
        try choose(menu, .findNext)
        try require(view.textView.selectedRange() == matches[2], "查找下一个 did not select the next match")
        try choose(menu, .findPrevious)
        try require(view.textView.selectedRange() == matches[1], "查找上一个 did not select the previous match")
        try fxSettled(host, view)
        try require(try read(core).projection.revision == revision && (try proseRows(page.directory)) == rows && view.textView.string == text,
                    "Finding wrote to the document")
        // The selection a match leaves is the editor's own: formatting follows it.
        try choose(menu, .underline)
        try fxSettled(host, view)
        try require(try run(core, at: matches[1].location).underline && !(try run(core, at: matches[0].location)).underline,
                    "A found match is not the editor's selection")
        // A row of the 全书长卷 offers no find.
        let row = NativeDocumentView(core: core, minimumTextHeight: 48, growsWithText: true)
        row.binding.load()
        try wait { row.binding.state != nil && !row.binding.hasPendingWork }
        let rowMenu = editorMenu(row)
        try require(row.textFinder == nil && !(try menuItem(rowMenu, .find)).isEnabled && (try menuItem(rowMenu, .alignCenter)).isEnabled,
                    "The 全书长卷's row offers find or lacks the format commands")
        try require(row.binding.detach(), "The long page's row did not detach")
        try page.close()
    }

    // MARK: @ picker

    private static func mentionPicker() throws {
        var kai: WorkspaceElement?, mist: WorkspaceElement?, people: WorkspaceElementCategory?
        var places: WorkspaceElementCategory?, homecoming: WorkspaceChapter?
        let page = try page("") { workspace, project in
            let created: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
                workspace.createElementCategory(projectID: project.id, name: "人物", completion: $0)
            }
            people = created.result
            let other: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
                workspace.createElementCategory(projectID: project.id, name: "地点", completion: $0)
            }
            places = other.result
            let first: WorkspaceElementReply<WorkspaceElement> = try elementResult {
                workspace.createElement(projectID: project.id, categoryID: people!.id, name: "林凯", aliases: ["阿凯"], completion: $0)
            }
            kai = first.result
            let second: WorkspaceElementReply<WorkspaceElement> = try elementResult {
                workspace.createElement(projectID: project.id, categoryID: people!.id, name: "林雾", completion: $0)
            }
            mist = second.result
            homecoming = try elementResult { workspace.createChapter(projectID: project.id, title: "归航", completion: $0) }
        }
        defer { page.remove() }
        let (host, view, core) = (page.host, page.view, page.core)
        try wait { host.linkDirectory(projectID: page.project.id)?.elements[mist!.id] != nil }
        func links(_ name: String) throws -> [NativeEntityLink] {
            let at = try fxRange(name, in: view).location
            return try run(core, at: at).links
        }

        // Elements in the library's order (latest edited first), each name
        // before its aliases, then chapters in book order.
        let initial: WorkspaceElementLibrary = try elementResult { page.workspace.elementLibrary(projectID: page.project.id, completion: $0) }
        let elementNames = initial.elements.flatMap { [$0.name] + $0.aliases }
        try require(Set(elementNames) == ["林凯", "阿凯", "林雾"], "Unexpected fixture names \(elementNames)")
        // A picker opens when the trigger itself is typed.
        fxType(view, "他看见@")
        guard let opened = view.picker, opened.kind == .mention else { throw LabError.message("@ did not open the picker") }
        let names = opened.items.map(\.title)
        try require(names == elementNames + ["归航"] && !names.contains("雨夜"),
                    "The picker lists \(names) (the body's own chapter must be left out)")
        let detail = { (name: String) in opened.items.first { $0.title == name }?.detail }
        try require(detail("阿凯") == "「林凯」的别名" && detail("归航") == "章节" && detail("林凯") == "设定 · 人物",
                    "The rows do not say what they are")
        fxType(view, "林")
        let filtered = view.picker?.items ?? []
        try require(Set(filtered.prefix(2).map(\.title)) == ["林凯", "林雾"] && filtered.dropFirst(2).map(\.detail) == ["人物", "地点"]
                    && filtered.dropFirst(2).allSatisfy { $0.title == "＋ 新建设定「林」" }, "Typing did not filter: \(filtered.map(\.title))")
        guard let kaiRow = filtered.firstIndex(where: { $0.title == "林凯" }) else { throw LabError.message("林凯 is not offered") }
        view.textView.doCommand(by: #selector(NSResponder.moveDown(_:)))
        view.textView.doCommand(by: #selector(NSResponder.moveUp(_:)))
        try require(view.picker?.selected == 0, "↑ and ↓ did not move the choice")
        while view.picker?.selected != kaiRow { view.textView.doCommand(by: #selector(NSResponder.moveDown(_:))) }
        view.textView.doCommand(by: #selector(NSResponder.insertNewline(_:)))
        try fxSettled(host, view)
        try require(view.picker == nil && (try read(core).projection.text) == "他看见林凯", "Return did not insert the name")
        try wait { (try? links("林凯"))?.map(\.id) == [kai!.id] }
        try fxSettled(host, view)
        try require(try links("林凯") == [NativeEntityLink(kind: "element", id: kai!.id)] && view.linkTargets(at: 3).first?.id == kai!.id,
                    "The inserted name is not linked to its element")
        // One undo takes the insertion back to the typed text.
        view.undoProse(); try fxSettled(host, view)
        try require(try read(core).projection.text == "他看见@林", "One undo did not restore the typed @林")
        view.redoProse(); try fxSettled(host, view)
        try wait { (try? links("林凯"))?.isEmpty == false }

        // An alias, then a chapter title.
        fxType(view, "，@")
        fxType(view, "阿")
        try require(view.picker?.items.first?.title == "阿凯", "The alias was not offered")
        view.textView.doCommand(by: #selector(NSResponder.insertNewline(_:)))
        try fxSettled(host, view)
        try wait { (try? links("阿凯"))?.map(\.id) == [kai!.id] }
        fxType(view, "，想起@")
        fxType(view, "归")
        try require(view.picker?.items.map(\.title) == ["归航", "＋ 新建设定「归」", "＋ 新建设定「归」"], "The chapter was not offered")
        view.textView.doCommand(by: #selector(NSResponder.insertNewline(_:)))
        try fxSettled(host, view)
        try wait { (try? links("归航")) == [NativeEntityLink(kind: "node", id: homecoming!.id)] }

        // Esc leaves the typed text unlinked.
        fxType(view, "。@")
        fxType(view, "雾")
        try require(view.picker != nil, "The picker did not open")
        view.textView.doCommand(by: #selector(NSResponder.cancelOperation(_:)))
        try fxSettled(host, view)
        try require(view.picker == nil && view.textView.string.hasSuffix("。@雾"), "Esc did not leave the text")

        // An exact name offers no creation; a new one creates in the chosen category.
        fxType(view, "@")
        fxType(view, "林雾")
        try require(view.picker?.items.map(\.title) == ["林雾"], "An exact name still offered 新建设定")
        view.textView.doCommand(by: #selector(NSResponder.cancelOperation(_:)))
        try fxSettled(host, view)
        fxType(view, "@")
        fxType(view, "潮生")
        guard let create = view.picker?.items.firstIndex(where: { $0.detail == "地点" }) else {
            throw LabError.message("＋ 新建设定 was not offered for 地点")
        }
        while view.picker?.selected != create { view.textView.doCommand(by: #selector(NSResponder.moveDown(_:))) }
        view.textView.doCommand(by: #selector(NSResponder.insertNewline(_:)))
        try wait { view.textView.string.hasSuffix("林雾潮生") }
        try fxSettled(host, view)
        let library: WorkspaceElementLibrary = try elementResult { page.workspace.elementLibrary(projectID: page.project.id, completion: $0) }
        guard let tide = library.elements.first(where: { $0.name == "潮生" }) else { throw LabError.message("潮生 was not created") }
        try require(tide.categoryId == places!.id, "The new element is not in the chosen category")
        try wait { (try? links("潮生"))?.map(\.id) == [tide.id] }
        try require(host.linkDirectory(projectID: page.project.id)?.elements[tide.id] != nil, "The tab host did not adopt the new element")
        try page.close()
    }

    // MARK: 打印

    private static func printingFormattedPage() throws {
        let text = "潮汐表\n北岸灯塔的光扫过港口，也扫过停泊的渔船。\n见 港务公告 与 夜航须知。"
        let page = try page(text)
        defer { page.remove() }
        let (host, view, core) = (page.host, page.view, page.core)
        let menu = editorMenu(view)
        fxSelect(view, NSRange(location: 1, length: 0))
        try choose(menu, .alignCenter)
        try fxSettled(host, view)
        let body = try fxRange("北岸", in: view)
        fxSelect(view, NSRange(location: body.location, length: 0))
        view.textView.doCommand(by: #selector(NSResponder.insertTab(_:)))
        try fxSettled(host, view)
        view.textView.doCommand(by: #selector(NSResponder.insertTab(_:)))
        try fxSettled(host, view)
        let notice = try fxRange("港务公告", in: view)
        fxSelect(view, notice)
        try choose(menu, .link)
        view.linkSheet?.address = "https://example.invalid/notice"
        view.linkSheet?.submit()
        try fxSettled(host, view)
        let rules = try fxRange("夜航须知", in: view)
        fxSelect(view, rules)
        try choose(menu, .underline)
        try fxSettled(host, view)
        fxSelect(view, NSRange(location: rules.location, length: 0))
        try choose(menu, .alignRight)
        try fxSettled(host, view)
        try require(try block(core, containing: body.location).indent == 2, "The fixture was not indented")

        // The typesetter reads the live projection.
        let projection: WorkspaceBodyProjection = try elementResult {
            page.workspace.readProjection(projectID: page.project.id, kind: "chapter", id: page.chapter.id, completion: $0)
        }
        var typography = DocumentStyle.typography
        typography.paragraphIndent = 30
        let typeset = PrintTypesetter(typography: typography).body(projection.projection)
        let string = typeset.string as NSString
        func at(_ piece: String) -> [NSAttributedString.Key: Any] { typeset.attributes(at: string.range(of: piece).location, effectiveRange: nil) }
        func style(_ piece: String) -> NSParagraphStyle { at(piece)[.paragraphStyle] as! NSParagraphStyle }
        try require(style("潮汐表").alignment == .center && style("北岸").alignment == .natural && style("见").alignment == .right,
                    "Printed alignment does not follow the blocks")
        try require(abs(style("北岸").headIndent - 4 * typography.size) < 0.01 && abs(style("北岸").firstLineHeadIndent - 4 * typography.size - 30) < 0.01,
                    "The printed indent is not two em per level on top of the first-line indent")
        try require(at("港务公告")[.foregroundColor] as? NSColor == PrintTypesetter.linkColor
                    && at("港务公告")[.underlineStyle] as? Int == NSUnderlineStyle.single.rawValue
                    && at("夜航须知")[.underlineStyle] as? Int == NSUnderlineStyle.single.rawValue
                    && at("夜航须知")[.foregroundColor] as? NSColor == PrintTypesetter.ink, "Printed links and underline are wrong")

        // 打印 to a PDF: the centred line sits mid-page, the indented one shifted.
        let output = page.directory.deletingLastPathComponent().appendingPathComponent("print.pdf")
        let printing = MacPrintCoordinator(workspace: page.workspace)
        typography.paragraphIndent = 0
        printing.typography = { typography }
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
        guard pages >= 1, let document = PDFDocument(url: output), let first = document.page(at: 0) else {
            throw LabError.message("The page did not print to a PDF")
        }
        func bounds(_ piece: String) throws -> CGRect {
            guard let found = first.document?.findString(piece, withOptions: []).first else { throw LabError.message("“\(piece)” is not printed") }
            return found.bounds(for: first)
        }
        // Measured from the left-aligned page title, the content's left edge.
        let content = first.bounds(for: .mediaBox).width - 2 * PrintGeometry(paper: PrintPaper.a4.size).margin
        let left = try bounds(page.chapter.title).minX
        let centred = try bounds("潮汐表"), shifted = try bounds("北岸灯塔"), right = try bounds("夜航须知")
        try require(abs(centred.midX - (left + content / 2)) < 12, "The centred line printed at \(centred) from \(left)")
        try require(abs(shifted.minX - (left + 4 * typography.size)) < 3, "The indented line printed at \(shifted.minX) from \(left)")
        // The right-aligned line ends with 。 after 夜航须知, one character wide.
        try require(abs(right.maxX - (left + content - typography.size)) < 12, "The right-aligned line printed at \(right) from \(left)")
        try page.close()
    }
}
