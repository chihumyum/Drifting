import AppKit

/// Automatic entity links, their presentation, navigation and the element
/// page's 被引用 through real AppKit views, the shared input queue and the
/// Rust workspace. Input is programmatic; the ⌘-click is a synthetic event
/// delivered to the text view, not desktop input.
extension BindingAcceptance {
    static func entityLinkAcceptance() throws -> [String] {
        let linkDelay = DocumentStore.entityLinkDelay, backlinkDelay = MacChapterWorkspace.backlinkDelay
        defer { DocumentStore.entityLinkDelay = linkDelay; MacChapterWorkspace.backlinkDelay = backlinkDelay }
        // Short enough to keep the suite quick, long enough to observe that
        // settled input is not linked on the typing path.
        DocumentStore.entityLinkDelay = 0.2
        MacChapterWorkspace.backlinkDelay = 0.05
        try typedNamesLinkAfterSettling()
        try retroactiveLinksNavigationAndTargetStates()
        try backlinksListAndNavigate()
        return [
            "AppKit typed element names link after the input debounce in the category colour with a delayed hover preview, keep the caret, wait for composition, and one undo reverts only the typed text",
            "AppKit element creation, rename, aliases and chapter rename retro-link open chapters; ⌘-click and 打开 open the target, trashed targets dim, restored targets recolour and missing targets read as prose",
            "AppKit element page 被引用 lists open and closed chapters with block and link counts, follows edits and selects the first link only while it is still linked",
        ]
    }

    /// Every run and each target it links, as (text, target) pairs.
    static func linkedRuns(_ projection: NativeProjection) -> [(String, NativeEntityLink)] {
        let text = projection.text as NSString
        return projection.blocks.flatMap(\.runs).flatMap { run in
            run.attributes.links.map { (text.substring(with: run.range.nsRange), $0) }
        }
    }

    private static func linkSettled(_ host: MacChapterWorkspace, _ views: NativeDocumentView...) throws {
        try wait {
            !host.isBusy && views.allSatisfy {
                $0.binding.state != nil && !$0.binding.hasPendingWork && !$0.binding.store.hasScheduledLinks
            }
        }
    }

    private static func press(_ button: NSButton) { button.sendAction(button.action, to: button.target) }

    private static func element(_ id: String) -> NativeEntityLink { NativeEntityLink(kind: "element", id: id) }

    private static func linkAttributes(_ view: NativeDocumentView, at index: Int) -> [NSAttributedString.Key: Any] {
        view.textView.textStorage!.attributes(at: index, effectiveRange: nil)
    }

    private static func requireLinkStyle(_ view: NativeDocumentView, at index: Int, colour: NSColor, _ context: String) throws {
        let attributes = linkAttributes(view, at: index)
        try require((attributes[.foregroundColor] as? NSColor)?.isEqual(colour) == true
            && attributes[.underlineStyle] as? Int == NSUnderlineStyle.single.rawValue,
            "\(context): link at \(index) is not drawn in \(colour) with an underline: \(attributes)")
    }

    private static func requireViewStyle(_ host: MacChapterWorkspace, _ view: NativeDocumentView,
                                         _ projectID: String, _ context: String) throws {
        guard let projection = view.binding.store.projection else { throw LabError.message("\(context): no projection") }
        try require(view.linkDirectory == host.linkDirectory(projectID: projectID), "\(context): view uses a stale link directory")
        try requireStyleReference(view.textView.textStorage!, projection, context, links: view.linkDirectory)
    }

    private static func range(of text: String, in view: NativeDocumentView, from start: Int = 0) throws -> NSRange {
        let whole = view.textView.string as NSString
        let found = whole.range(of: text, range: NSRange(location: start, length: whole.length - start))
        try require(found.location != NSNotFound, "“\(text)” is not in the displayed prose")
        return found
    }

    /// A ⌘-mouse-down at the centre of a character's glyph, in window coordinates.
    private static func commandClick(_ view: NativeDocumentView, at index: Int) throws -> NSEvent {
        guard let window = view.window else { throw LabError.message("Link view is not in a window") }
        window.contentView?.layoutSubtreeIfNeeded()
        let rect = view.textView.firstRect(forCharacterRange: NSRange(location: index, length: 1), actualRange: nil)
        let point = window.convertPoint(fromScreen: NSPoint(x: rect.midX, y: rect.midY))
        guard let event = NSEvent.mouseEvent(with: .leftMouseDown, location: point, modifierFlags: .command, timestamp: 0,
            windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else {
            throw LabError.message("Could not create a synthetic ⌘-click")
        }
        return event
    }

    private static func contextMenu(_ view: NativeDocumentView, at index: Int) throws -> NSMenu {
        guard let window = view.window else { throw LabError.message("Prose view is not in a window") }
        guard let event = NSEvent.mouseEvent(with: .rightMouseDown, location: .zero, modifierFlags: [],
            timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else {
            throw LabError.message("Could not create a synthetic right click")
        }
        guard let menu = view.textView(view.textView, menu: NSMenu(), for: event, at: index) else {
            throw LabError.message("Prose context menu was not built")
        }
        return menu
    }

    private static func typedNamesLinkAfterSettling() throws {
        let (directory, workspace, project, chapter) = try elementFixture()
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let people: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: project.id, name: "人物", completion: $0)
        }
        let created: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: project.id, categoryID: people.result!.id, name: "林凯", completion: $0)
        }
        let kai = created.result!
        let colour = DocumentStyle.linkColor(hex: people.result!.color)!
        let (window, host) = elementHost(workspace)
        defer { window.close() }
        let view: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
        try linkSettled(host, view)
        try wait { host.linkDirectory(projectID: project.id) != nil && view.linkDirectory != nil }
        let core = host.activeCore!, store = view.binding.store

        view.textView.setSelectedRange(NSRange(location: 0, length: 0))
        view.textView.insertText("林凯来了", replacementRange: NSRange(location: 0, length: 0))
        try wait { !view.binding.hasPendingWork }
        // Settled input waits for the debounce; nothing is linked on the typing path.
        try require(store.hasScheduledLinks && !store.isLinking && linkedRuns(try read(core).projection).isEmpty,
            "Typed input was linked before the debounce")
        try linkSettled(host, view)
        let linked = try read(core).projection
        try require(linkedRuns(linked).map(\.0) == ["林凯"] && linkedRuns(linked).map(\.1) == [element(kai.id)],
            "The typed name was not linked to its element: \(linkedRuns(linked))")
        try require(view.textView.string == "林凯来了" && view.textView.selectedRange() == NSRange(location: 4, length: 0),
            "Adopting the link moved the caret")
        try requireLinkStyle(view, at: 0, colour: colour, "Typed element link")
        // Resting on the link opens its preview after the renderer's delay.
        let hovered = Date()
        view.textView.onHover?(1)
        try require(view.previewedLink == nil, "The link preview opened without the hover delay")
        try wait { view.previewedLink?.id == kai.id }
        try require(Date().timeIntervalSince(hovered) >= NativeDocumentView.linkPreviewDelay - 0.02
            && view.linkPreviewText == "林凯 · 人物", "The link preview ignored its delay or lacks the name and category")
        view.textView.onHover?(2)
        try require(view.previewedLink == nil, "Leaving the link did not close its preview")
        try requireViewStyle(host, view, project.id, "debounced element link")

        // A requested pass never interrupts composition; it runs after commit.
        view.textView.setSelectedRange(NSRange(location: 4, length: 0))
        view.textView.setMarkedText("林凯", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: 4, length: 0))
        store.requestEntityLinks()
        try require(!store.isLinking && store.hasScheduledLinks && view.textView.hasMarkedText(),
            "A link pass started during composition")
        view.textView.insertText("林凯", replacementRange: NSRange(location: NSNotFound, length: 0))
        try linkSettled(host, view)
        let composed = try read(core).projection
        try require(composed.text == "林凯来了林凯" && linkedRuns(composed).map(\.0) == ["林凯", "林凯"],
            "The committed composition was not linked: \(linkedRuns(composed))")
        try require(view.textView.selectedRange() == NSRange(location: 6, length: 0), "Linking after composition moved the caret")
        try requireLinkStyle(view, at: 4, colour: colour, "Composed element link")
        try requireViewStyle(host, view, project.id, "composition link")

        // Links are not undo steps: each undo reverts exactly one typed event.
        view.undoProse(); try linkSettled(host, view)
        let first = try read(core).projection
        try require(first.text == "林凯来了" && first.canUndo && linkedRuns(first).count == 1, "Undo did not revert only the composition")
        view.undoProse(); try linkSettled(host, view)
        let empty = try read(core).projection
        try require(empty.text.isEmpty && !empty.canUndo, "A link pass left an extra undo step")
        view.redoProse(); try linkSettled(host, view)
        let redone = try read(core).projection
        try require(redone.text == "林凯来了" && linkedRuns(redone).map(\.1) == [element(kai.id)], "Redone text was not linked again")
        try requireViewStyle(host, view, project.id, "redo link")

        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed, "Link workspace failed to close")
        let cold = LabWorkspaceCore(directory: directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let coldCore: LabCore = try elementResult { cold.openChapter(projectID: project.id, chapterID: chapter.id, completion: $0) }
        try require(linkedRuns(try read(coldCore).projection).map(\.1) == [element(kai.id)], "Links did not survive a cold reopen")
        let coldClosed: Bool = try elementResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }

    private static func retroactiveLinksNavigationAndTargetStates() throws {
        let (directory, workspace, project, chapter) = try elementFixture()
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let second: WorkspaceChapter = try elementResult { workspace.createChapter(projectID: project.id, title: "次章", completion: $0) }
        let model = ElementLibraryModel(workspace: workspace, projectID: project.id)
        model.load(); try wait { model.loaded && !model.busy }
        let people: WorkspaceElementCategory = try elementResult { model.createCategory(name: "人物", completion: $0) }
        let places: WorkspaceElementCategory = try elementResult { model.createCategory(name: "地点", completion: $0) }
        var changes = WorkspaceElementChanges(); changes.summary = "港口守夜人"
        let kaiCreated: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: project.id, categoryID: people.id, name: "林凯", completion: $0)
        }
        let kai = kaiCreated.result!
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.updateElement(projectID: project.id, elementID: kai.id, changes: changes, completion: $0)
        }
        let (window, host) = elementHost(workspace)
        defer { window.close() }
        // Mirrors AppDelegate: every library reply reaches the open tabs.
        model.onLibrary = { host.applyElementLibrary(projectID: project.id, library: $0) }
        let view: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
        try linkSettled(host, view)
        try wait { view.linkDirectory != nil }
        let core = host.activeCore!
        view.textView.insertText("北塔下，阿凯守着灯塔，想起归航", replacementRange: NSRange(location: 0, length: 0))
        try linkSettled(host, view)
        try require(linkedRuns(try read(core).projection).isEmpty, "Prose linked names that do not exist yet")
        view.textView.setSelectedRange(NSRange(location: 2, length: 3))
        try wait { view.binding.selectionIsAnchored }
        let selection = NSRange(location: 2, length: 3)

        // Creating an element through the panel's model, then naming it, as
        // the page does; each library reply links every open body again.
        let lamp: WorkspaceElement = try elementResult { model.createElement(categoryID: places.id, completion: $0) }
        try linkSettled(host, view)
        var rename = WorkspaceElementChanges(); rename.name = "灯塔"
        let renamed: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.updateElement(projectID: project.id, elementID: lamp.id, changes: rename, completion: $0)
        }
        host.applyElementLibrary(projectID: project.id, library: renamed.library)
        try linkSettled(host, view)
        try require(linkedRuns(try read(core).projection).map(\.0) == ["灯塔"], "Renaming an element did not retro-link it")
        var aliases = WorkspaceElementChanges(); aliases.aliases = ["阿凯", "凯哥", "小林", "老凯"]
        let aliased: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.updateElement(projectID: project.id, elementID: kai.id, changes: aliases, completion: $0)
        }
        host.applyElementLibrary(projectID: project.id, library: aliased.library)
        try linkSettled(host, view)
        let towerCreated: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: project.id, categoryID: places.id, name: "北塔", completion: $0)
        }
        let tower = towerCreated.result!
        host.applyElementLibrary(projectID: project.id, library: towerCreated.library)
        try linkSettled(host, view)
        let renamedChapter: WorkspaceChapter = try elementResult {
            workspace.renameChapter(projectID: project.id, chapterID: second.id, title: "归航", completion: $0)
        }
        host.rename(chapter: renamedChapter, projectID: project.id)
        try wait { host.linkDirectory(projectID: project.id)?.chapters[second.id]?.name == "归航" }
        try linkSettled(host, view)
        let linked = try read(core).projection
        try require(linkedRuns(linked).map(\.0) == ["北塔", "阿凯", "灯塔", "归航"]
            && linkedRuns(linked).map(\.1) == [element(tower.id), element(kai.id), element(lamp.id), NativeEntityLink(kind: "node", id: second.id)],
            "Open prose was not retro-linked: \(linkedRuns(linked))")
        try require(view.textView.selectedRange() == selection && linked.canUndo, "Retroactive linking moved the selection or history")

        let personColour = DocumentStyle.linkColor(hex: people.color)!, placeColour = DocumentStyle.linkColor(hex: places.color)!
        let towerAt = try range(of: "北塔", in: view).location, kaiAt = try range(of: "阿凯", in: view).location
        let lampAt = try range(of: "灯塔", in: view).location, chapterAt = try range(of: "归航", in: view).location
        try requireLinkStyle(view, at: towerAt, colour: placeColour, "New element link")
        try requireLinkStyle(view, at: kaiAt, colour: personColour, "Alias link")
        try requireLinkStyle(view, at: lampAt + 1, colour: placeColour, "Renamed element link")
        try requireLinkStyle(view, at: chapterAt, colour: .systemBlue, "Chapter link")
        let stored = aliased.result!.aliases
        try require(stored.count == 4 && view.showLinkPreview(at: kaiAt)
            && view.linkPreviewText == "林凯 · 人物\n别名：\(stored.prefix(3).joined(separator: "、")) 等 4 个\n港口守夜人",
            "Element preview lacks its category, three aliases or summary: \(view.linkPreviewText ?? "none")")
        try require(view.showLinkPreview(at: chapterAt) && view.linkPreviewText == "章节 · 归航", "Chapter link preview is missing")
        view.closeLinkPreview()
        try requireViewStyle(host, view, project.id, "retroactive links")

        // ⌘-click opens the element page in the pane that showed the link.
        let click = try commandClick(view, at: towerAt + 1)
        try require(view.textView.linkIndex(for: click) == towerAt + 1, "⌘-click did not hit the linked glyph")
        view.textView.mouseDown(with: click)
        try wait { !host.isBusy && host.activeElement?.id == tower.id }
        try linkSettled(host, host.activeView!)
        try require(host.activePane == 0 && host.tabTitles(pane: 0) == ["雨夜", "北塔"], "⌘-click did not open the element page tab")
        let back: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
        try require(back === view && view.textView.selectedRange() == selection, "Returning to the chapter lost its selection")

        // 打开「林凯」 in the prose context menu opens the aliased element.
        let chapterMenu = try contextMenu(view, at: chapterAt)
        try require(chapterMenu.items.first?.title == "打开「归航」", "Chapter link lacks its open item")
        let menu = try contextMenu(view, at: kaiAt)
        guard let open = menu.items.first(where: { $0.accessibilityIdentifier() == "context-open-link-\(kai.id)" }),
              let action = open.action else { throw LabError.message("Context menu lacks 打开「林凯」") }
        try require(open.title == "打开「林凯」" && menu.items.first === open, "Open item is not first or misnamed")
        NSApp.sendAction(action, to: open.target, from: open)
        try wait { !host.isBusy && host.activeElement?.id == kai.id }
        try linkSettled(host, host.activeView!)
        let _: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
        try linkSettled(host, view)

        // A trashed target dims without an underline and cannot be opened.
        let trashed: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            host.trashElement(projectID: project.id, elementID: tower.id, completion: $0)
        }
        model.apply(trashed.library, message: nil)
        try require(host.tabTitles(pane: 0) == ["雨夜", "林凯"], "Trash did not close the element tab")
        let dimmed = linkAttributes(view, at: towerAt)
        try require((dimmed[.foregroundColor] as? NSColor)?.isEqual(NSColor.secondaryLabelColor) == true && dimmed[.underlineStyle] == nil
            && view.showLinkPreview(at: towerAt) && view.linkPreviewText == "北塔（已在回收站）", "Trashed link was not dimmed: \(dimmed)")
        view.closeLinkPreview()
        let trashedMenu = try contextMenu(view, at: towerAt)
        try require(trashedMenu.items.first?.accessibilityIdentifier() == "context-trashed-link-\(tower.id)"
            && trashedMenu.items.first?.isEnabled == false && !view.openLink(at: towerAt), "Trashed link could still be opened")
        try requireViewStyle(host, view, project.id, "trashed target")

        // Restoring through the library recolours it; the link was kept.
        let restored: WorkspaceElement = try elementResult { model.restore(elementID: tower.id, completion: $0) }
        try linkSettled(host, view)
        try require(restored.id == tower.id, "Restore returned another element")
        try requireLinkStyle(view, at: towerAt, colour: placeColour, "Restored element link")
        try requireViewStyle(host, view, project.id, "restored target")

        // A target missing from the workspace reads as plain prose.
        guard let full = view.linkDirectory else { throw LabError.message("Link directory disappeared") }
        let missing = EntityLinkDirectory(targets: Array(full.elements.values.filter { $0.id != tower.id }) + Array(full.chapters.values))
        view.linkDirectory = missing
        let plain = linkAttributes(view, at: towerAt)
        try require(plain[.underlineStyle] == nil && !view.showLinkPreview(at: towerAt)
            && (plain[.foregroundColor] as? NSColor)?.isEqual(NSColor.labelColor) == true && !view.openLink(at: towerAt),
            "A missing target still looked like a link: \(plain)")
        try requireStyleReference(view.textView.textStorage!, view.binding.store.projection!, "missing target", links: missing)
        view.linkDirectory = host.linkDirectory(projectID: project.id)
        try requireViewStyle(host, view, project.id, "directory restored")

        // Every link pass left history alone: one undo reverts the typing.
        view.undoProse(); try linkSettled(host, view)
        try require(try read(core).projection.text.isEmpty && !read(core).projection.canUndo, "Link passes added undo steps")
        view.redoProse(); try linkSettled(host, view)
        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed, "Link workspace failed to close")
    }

    private static func backlinksListAndNavigate() throws {
        let (directory, workspace, project, chapter) = try elementFixture()
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let away: WorkspaceChapter = try elementResult { workspace.createChapter(projectID: project.id, title: "归途", completion: $0) }
        let people: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: project.id, name: "人物", completion: $0)
        }
        let created: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: project.id, categoryID: people.result!.id, name: "林凯", completion: $0)
        }
        var aliases = WorkspaceElementChanges(); aliases.aliases = ["阿凯"]
        let aliased: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.updateElement(projectID: project.id, elementID: created.result!.id, changes: aliases, completion: $0)
        }
        let kai = aliased.result!
        let (window, host) = elementHost(workspace)
        defer { window.close() }

        // The second chapter is linked, then closed: it is read cold.
        let awayView: NativeDocumentView = try elementResult { host.open(project: project, chapter: away, completion: $0) }
        try linkSettled(host, awayView)
        awayView.textView.insertText("林凯回来了", replacementRange: NSRange(location: 0, length: 0))
        try linkSettled(host, awayView)
        let awayCore = host.activeCore!
        let closedTab: Bool = try elementResult {
            host.closeTab(pane: 0, scope: ChapterScope(projectID: project.id, chapterID: away.id), completion: $0)
        }
        try require(closedTab && awayCore.isClosed, "The second chapter did not close")

        let view: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
        try linkSettled(host, view)
        view.textView.insertText("林凯在北岸。\n阿凯想起林凯", replacementRange: NSRange(location: 0, length: 0))
        try linkSettled(host, view)
        try require(linkedRuns(view.binding.store.projection!).count == 3, "Open chapter fixture was not linked")
        view.textView.setSelectedRange(NSRange(location: 8, length: 0))
        try wait { view.binding.selectionIsAnchored }

        // The page's 被引用 lists both chapters in book order when opened.
        let body: NativeDocumentView = try elementResult { host.open(project: project, element: kai, completion: $0) }
        try linkSettled(host, body)
        guard let page = host.retainedElementPage(pane: 0, scope: ElementScope(projectID: project.id, elementID: kai.id)) else {
            throw LabError.message("Element page was not retained")
        }
        try wait { page.backlinks?.chapters.count == 2 }
        let listed = page.backlinks!
        try require(listed.unavailable.isEmpty && listed.chapters.map(\.chapterId) == [chapter.id, away.id]
            && listed.chapters.map(\.spans) == [3, 1] && listed.chapters.map(\.blocks) == [2, 1]
            && listed.chapters.allSatisfy { $0.first == NativeRange(location: 0, length: 2) },
            "Backlinks differ from the linked chapters: \(listed)")
        try require(page.backlinksView.chapterButtons.map { $0.accessibilityLabel() ?? "" } == ["雨夜，2 处 · 3 次", "归途，1 处 · 1 次"]
            && page.backlinksView.mutedLines.isEmpty, "被引用 rows are missing or miscounted")

        // A chapter that could not be read is listed as a muted line.
        page.backlinksView.show(WorkspaceElementBacklinks(elementId: kai.id, chapters: listed.chapters,
            unavailable: [.init(chapterId: "unreadable", chapterTitle: "远章")]))
        try require(page.backlinksView.chapterButtons.count == 2 && page.backlinksView.mutedLines == ["远章 · 暂时无法读取"],
            "An unreadable chapter was not listed muted")
        page.backlinksView.show(listed)

        // An open chapter: the row selects its first link.
        press(page.backlinksView.chapterButtons[0])
        try wait { !host.isBusy && host.activeChapter?.id == chapter.id && view.textView.selectedRange() == NSRange(location: 0, length: 2) }
        try require(host.activeView === view && view.binding.store.projection?.canUndo == true, "Backlink navigation replaced the chapter")

        // A closed chapter opens fresh, then its first link is selected.
        let _: NativeDocumentView = try elementResult { host.open(project: project, element: kai, completion: $0) }
        try wait { page.backlinks?.chapters.count == 2 && !host.isBusy }
        press(page.backlinksView.chapterButtons[1])
        try wait { !host.isBusy && host.activeChapter?.id == away.id && host.activeView?.binding.store.projection != nil
            && host.activeView?.textView.selectedRange() == NSRange(location: 0, length: 2) }
        guard let reopened = host.activeView else { throw LabError.message("Closed chapter did not open") }
        try require(reopened !== awayView && reopened.textView.string == "林凯回来了", "Closed chapter opened with the wrong owner")

        // With the page beside the prose, edits refresh its counts.
        let _: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
        let twin: NativeDocumentView = try elementResult { host.split(completion: $0) }
        try linkSettled(host, twin, view)
        let _: NativeDocumentView = try elementResult { host.open(project: project, element: kai, in: 1, completion: $0) }
        guard let besidePage = host.retainedElementPage(pane: 1, scope: ElementScope(projectID: project.id, elementID: kai.id)) else {
            throw LabError.message("Element page did not open beside the chapter")
        }
        try wait { besidePage.backlinks?.chapters.first?.spans == 3 }
        let end = (view.textView.string as NSString).length
        view.textView.setSelectedRange(NSRange(location: end, length: 0))
        view.textView.insertText("。林凯", replacementRange: NSRange(location: end, length: 0))
        try linkSettled(host, view)
        try wait { besidePage.backlinks?.chapters.first?.spans == 4 && besidePage.backlinks?.chapters.first?.blocks == 2 }

        // Once the first link is edited away, its row only opens the chapter.
        let stale = besidePage.backlinks!.chapters[0]
        view.textView.insertText("", replacementRange: NSRange(location: 0, length: 2))
        try linkSettled(host, view, twin)
        try wait { besidePage.backlinks?.chapters.first?.spans == 3 && besidePage.backlinks?.chapters.first?.blocks == 1 }
        twin.textView.setSelectedRange(NSRange(location: 3, length: 0))
        try wait { twin.binding.selectionIsAnchored }
        besidePage.onOpenBacklink?(stale)
        try wait { !host.isBusy && host.activeChapter?.id == chapter.id && host.activeView === twin }
        try require(host.activePane == 1 && twin.textView.selectedRange() == NSRange(location: 3, length: 0),
            "A stale first link was selected instead of only opening the chapter")

        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed, "Backlink workspace failed to close")
    }
}
