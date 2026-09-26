import AppKit

extension BindingAcceptance {
    static func elementResult<T>(_ run: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
        var result: Result<T, Error>?
        run { result = $0 }
        try wait { result != nil }
        return try result!.get()
    }

    static func elementRefused<T>(_ run: (@escaping (Result<T, Error>) -> Void) -> Void, _ message: String) throws -> String {
        var result: Result<T, Error>?
        run { result = $0 }
        try wait { result != nil }
        guard case .failure(let error) = result! else { throw LabError.message(message) }
        return error.localizedDescription
    }

    static func elementSettled(_ host: MacChapterWorkspace, _ views: NativeDocumentView...) throws {
        try wait { !host.isBusy && views.allSatisfy { $0.binding.state != nil && !$0.binding.hasPendingWork } }
    }

    static func elementFixture() throws -> (URL, LabWorkspaceCore, WorkspaceProject, WorkspaceChapter) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("apple-native-lab")
        let workspace = LabWorkspaceCore(directory: directory)
        let initial: [WorkspaceProject] = try elementResult { workspace.projects(completion: $0) }
        try require(initial.isEmpty, "Element library fixture was not isolated")
        let project: WorkspaceProject = try elementResult { workspace.createProject(name: "设定库合成项目", completion: $0) }
        let chapter: WorkspaceChapter = try elementResult { workspace.createChapter(projectID: project.id, title: "雨夜", completion: $0) }
        return (directory, workspace, project, chapter)
    }

    /// A sized window gives header fields a real field editor and both panes
    /// a usable layout; it is never ordered on screen.
    static func elementHost(_ workspace: LabWorkspaceCore) -> (NSWindow, MacChapterWorkspace) {
        let host = MacChapterWorkspace(workspace: workspace)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 760),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        return (window, host)
    }

    static func elementCount(_ directory: URL, _ table: String) throws -> Int64 {
        guard case .integer(let count)? = try WorkspaceRemoteProseFixture.query(in: directory,
            sql: "SELECT COUNT(*) AS n FROM \(table)").first?["n"] else {
            throw LabError.message("Element count query returned no row")
        }
        return count
    }

    /// Types into a header field through its real field editor, then ends
    /// editing by Return or by moving the keyboard away.
    static func editHeader(_ window: NSWindow, _ field: NSTextField, _ text: String, returnKey: Bool = false) throws {
        try require(window.makeFirstResponder(field), "Header field refused keyboard focus")
        guard let editor = field.currentEditor() as? NSTextView else { throw LabError.message("Header field has no field editor") }
        editor.selectAll(nil)
        editor.insertText(text, replacementRange: editor.selectedRange())
        if returnKey { editor.insertNewline(nil) } else { try require(window.makeFirstResponder(nil), "Header field did not end editing") }
    }

    static func pageSettled(_ page: MacElementPageView, _ condition: () -> Bool) throws {
        try wait { !page.isCommitting && condition() }
    }

    static func elementLibraryAcceptance() throws -> [String] {
        try elementTabsKeepIndependentOwners()
        try elementHeaderEditsAndConflicts()
        try elementTrashClosesOnlyItsTabs()
        return [
            "AppKit element page tabs beside chapter tabs and in the second pane keep independent owners text selections and history through cold reopen",
            "AppKit element page header edits name aliases summary group and category, refuses conflicts without writing and keeps typed text while tabs follow renames",
            "AppKit element trash closes only that element's tabs after commit and restore reopens its body while chapter tabs stay untouched",
        ]
    }

    private static func elementTabsKeepIndependentOwners() throws {
        let (directory, workspace, project, chapter) = try elementFixture()
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        // Create through the library panel's model, as the 设定库 does.
        let model = ElementLibraryModel(workspace: workspace, projectID: project.id)
        model.load(); try wait { model.loaded && !model.busy }
        try require(model.rows.isEmpty && model.library == .empty, "A new project listed elements")
        let category: WorkspaceElementCategory = try elementResult { model.createCategory(name: "人物", completion: $0) }
        try require(category.color.range(of: "^#[0-9A-F]{6}$", options: .regularExpression) != nil && category.documentId == "category:\(category.id)",
            "Category was not created with an uppercase colour and body document")
        let element: WorkspaceElement = try elementResult { model.createElement(categoryID: category.id, completion: $0) }
        let second: WorkspaceElement = try elementResult { model.createElement(categoryID: category.id, completion: $0) }
        try require(element.name == "New Element" && second.name == "New Element 2" && element.documentId == "element:\(element.id)"
            && element.categoryId == category.id && element.aliases.isEmpty && element.groupName == nil,
            "Default element names or fields differ from the renderer contract")
        try require(model.rows == [.category(category, count: 2), .element(element, grouped: false), .element(second, grouped: false)],
            "Library rows did not list the category and its elements")

        let (window, host) = elementHost(workspace)
        defer { window.close() }
        let chapterView: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
        try elementSettled(host, chapterView)
        let chapterCore = host.activeCore!
        chapterView.textView.insertText("雨🙂夜", replacementRange: NSRange(location: 0, length: 0))
        try elementSettled(host, chapterView)
        chapterView.textView.setSelectedRange(NSRange(location: 1, length: 2))
        try wait { chapterView.binding.selectionIsAnchored }

        let scope = ElementScope(projectID: project.id, elementID: element.id)
        let elementView: NativeDocumentView = try elementResult { host.open(project: project, element: element, completion: $0) }
        try elementSettled(host, elementView)
        let elementCore = host.activeCore!
        guard let page = host.retainedElementPage(pane: 0, scope: scope) else { throw LabError.message("Element page was not retained") }
        try require(page.documentView === elementView && host.activeElement?.id == element.id && host.activeChapter == nil
            && host.activeChapterView == nil && page.window === window,
            "Element tab did not become the active page")
        try require(elementCore !== chapterCore && elementView.binding.store !== chapterView.binding.store,
            "Element and chapter tabs shared a document owner")
        try require(host.tabTitles(pane: 0) == ["雨夜", "New Element"] && page.nameField.stringValue == "New Element"
            && elementView.textView.string.isEmpty, "Element page did not show its title fields and empty body")

        elementView.textView.insertText("林🙂岚", replacementRange: NSRange(location: 0, length: 0))
        try elementSettled(host, elementView)
        elementView.textView.setSelectedRange(NSRange(location: 0, length: 3))
        try wait { elementView.binding.selectionIsAnchored }
        // Comments are a chapter feature and are never sent for an element body.
        let comment = NSMenuItem(title: "添加批注…", action: #selector(ProseTextView.addProseComment(_:)), keyEquivalent: "")
        try require(!elementView.canAddComment && !elementView.textView.validateMenuItem(comment) && chapterView.canAddComment,
            "Element body offered a chapter comment")
        let refusal: String = try elementRefused({ (done: @escaping (Result<WorkspaceComment, Error>) -> Void) in
            elementView.addComment("备注", range: NSRange(location: 0, length: 3), revision: elementView.binding.store.projection!.revision,
                                   completion: done)
        }, "Element body accepted a comment")
        try require(refusal.contains("不支持批注") && elementView.locateComment(id: "missing") != nil, "Element comment refusal was not explained")

        elementView.undoProse(); try elementSettled(host, elementView)
        try require(try read(elementCore).projection.text == "" && read(chapterCore).projection.text == "雨🙂夜",
            "Element undo crossed into chapter history")
        elementView.redoProse(); try elementSettled(host, elementView)
        try require(try read(elementCore).projection.text == "林🙂岚", "Element redo did not restore its body")
        elementView.textView.setSelectedRange(NSRange(location: 0, length: 3))
        try wait { elementView.binding.selectionIsAnchored }

        let backToChapter: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
        try elementSettled(host, backToChapter)
        try require(backToChapter === chapterView && host.activeCore === chapterCore && host.activeElement == nil
            && chapterView.textView.selectedRange() == NSRange(location: 1, length: 2),
            "Switching back to the chapter recreated it or lost its selection")
        chapterView.undoProse(); try elementSettled(host, chapterView)
        try require(try read(chapterCore).projection.text == "" && read(elementCore).projection.text == "林🙂岚",
            "Chapter undo crossed into element history")
        chapterView.redoProse(); try elementSettled(host, chapterView)

        let backToElement: NativeDocumentView = try elementResult { host.open(project: project, element: element, completion: $0) }
        try elementSettled(host, backToElement)
        try require(backToElement === elementView && host.retainedElementPage(pane: 0, scope: scope) === page
            && host.activeCore === elementCore && elementView.textView.selectedRange() == NSRange(location: 0, length: 3),
            "Switching back to the element recreated its page or lost its selection")

        let twin: NativeDocumentView = try elementResult { host.split(completion: $0) }
        try elementSettled(host, twin, elementView)
        guard let twinPage = host.retainedElementPage(pane: 1, scope: scope) else { throw LabError.message("Split did not open the element page") }
        try require(host.paneCount == 2 && twin !== elementView && twinPage !== page && twinPage.documentView === twin
            && twin.binding.store === elementView.binding.store && twin.textView.string == "林🙂岚" && host.activeCore === elementCore,
            "Split did not show a second view of the same element owner")
        host.layoutSubtreeIfNeeded()
        try require(page.visibleRect.width >= 300 && twinPage.visibleRect.width >= 300 && twin.visibleRect.height >= 150,
            "Element pages lack a usable split layout: \(page.visibleRect) / \(twinPage.visibleRect) / \(twin.visibleRect)")
        twin.textView.setSelectedRange(NSRange(location: 4, length: 0))
        try wait { twin.binding.selectionIsAnchored }
        twin.textView.insertText("笔", replacementRange: NSRange(location: 4, length: 0))
        try elementSettled(host, twin, elementView)
        try require(elementView.textView.string == "林🙂岚笔" && elementView.textView.selectedRange() == NSRange(location: 0, length: 3),
            "Passive element pane lost the shared text or its own selection")
        elementView.undoProse(); try elementSettled(host, twin, elementView)
        try require(twin.textView.string == "林🙂岚" && read(chapterCore).projection.text == "雨🙂夜", "Shared element history crossed documents")
        elementView.redoProse(); try elementSettled(host, twin, elementView)

        let chapterTwin: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, in: 1, completion: $0) }
        try elementSettled(host, chapterTwin)
        chapterTwin.textView.insertText("续", replacementRange: NSRange(location: 4, length: 0))
        try elementSettled(host, chapterTwin, chapterView)
        try require(try read(chapterCore).projection.text == "雨🙂夜续" && read(elementCore).projection.text == "林🙂岚笔"
            && host.tabTitles(pane: 1) == ["New Element", "雨夜"], "Second pane mixed chapter and element documents")
        let closedPane: Bool = try elementResult { host.closeSecondPane(completion: $0) }
        try require(closedPane && host.paneCount == 1 && host.retainedElementPage(pane: 0, scope: scope) === page
            && elementView.binding.store.viewCount == 1 && !elementCore.isClosed, "Closing the second pane released the element owner")
        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed && elementCore.isClosed && chapterCore.isClosed, "Element workspace did not close its owners")

        let cold = LabWorkspaceCore(directory: directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let library: WorkspaceElementLibrary = try elementResult { cold.elementLibrary(projectID: project.id, completion: $0) }
        try require(library.categories == [category] && Set(library.elements.map(\.name)) == ["New Element", "New Element 2"]
            && library.trashedElements.isEmpty, "Cold library differs from the created rows")
        let coldElement: LabCore = try elementResult { cold.openElement(projectID: project.id, elementID: element.id, completion: $0) }
        let coldBody = try read(coldElement)
        try require(coldBody.projection.text == "林🙂岚笔" && !coldBody.projection.canUndo, "Element body did not survive cold reopen")
        let coldChapter: LabCore = try elementResult { cold.openChapter(projectID: project.id, chapterID: chapter.id, completion: $0) }
        try require(try read(coldChapter).projection.text == "雨🙂夜续" && read(coldElement).projection.text == "林🙂岚笔",
            "Opening the chapter changed the element owner or chapter text")
        let coldClosed: Bool = try elementResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }

    private static func elementHeaderEditsAndConflicts() throws {
        let (directory, workspace, project, chapter) = try elementFixture()
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let people: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: project.id, name: "人物", completion: $0)
        }
        let places: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: project.id, name: "地点", completion: $0)
        }
        let person = people.result!, place = places.result!
        let lan: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: project.id, categoryID: person.id, name: "林岚", completion: $0)
        }
        let zhou: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: project.id, categoryID: person.id, name: "沈舟", groupName: "配角", completion: $0)
        }
        var changes = WorkspaceElementChanges(); changes.aliases = ["Boat"]
        let boat: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.updateElement(projectID: project.id, elementID: zhou.result!.id, changes: changes, completion: $0)
        }
        try require(boat.result?.aliases == ["Boat"] && boat.result?.groupName == "配角", "Fixture alias was not stored")
        let element = lan.result!
        let scope = ElementScope(projectID: project.id, elementID: element.id)

        let (window, host) = elementHost(workspace)
        defer { window.close() }
        let chapterView: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
        try elementSettled(host, chapterView)
        let body: NativeDocumentView = try elementResult { host.open(project: project, element: element, completion: $0) }
        try elementSettled(host, body)
        let core = host.activeCore!
        guard let page = host.retainedElementPage(pane: 0, scope: scope) else { throw LabError.message("Element page was not retained") }
        host.applyElementLibrary(projectID: project.id, library: boat.library)
        try require(page.categoryPopup.numberOfItems == 3 && page.text(of: .category) == person.id,
            "Category popup did not list 未分类 and both categories")
        body.textView.insertText("旧港🙂", replacementRange: NSRange(location: 0, length: 0))
        try elementSettled(host, body)

        try editHeader(window, page.nameField, "林岚岚")
        try pageSettled(page) { page.element.name == "林岚岚" }
        try require(host.tabTitles(pane: 0) == ["雨夜", "林岚岚"] && page.errorMessage == nil && page.text(of: .name) == "林岚岚",
            "Tab title did not follow the rename")
        try editHeader(window, page.aliasesField, " 阿岚, lan ，岚姐 ", returnKey: true)
        try pageSettled(page) { page.element.aliases == ["lan", "岚姐", "阿岚"] }
        try require(page.text(of: .aliases) == "lan，岚姐，阿岚", "Alias field did not show the stored normalized aliases")
        try require(window.makeFirstResponder(page.summaryView), "Summary refused keyboard focus")
        page.summaryView.insertText("港口出身。\n擅长夜航。", replacementRange: page.summaryView.selectedRange())
        try require(window.makeFirstResponder(nil), "Summary did not end editing")
        try pageSettled(page) { page.element.summary == "港口出身。\n擅长夜航。" }
        try editHeader(window, page.groupField, "  主角 ", returnKey: true)
        try pageSettled(page) { page.element.groupName == "主角" }
        try require(page.text(of: .group) == "主角", "Group field did not show the trimmed stored group")
        guard let placeIndex = page.categoryPopup.itemArray.firstIndex(where: { $0.representedObject as? String == place.id }) else {
            throw LabError.message("Category popup lacks the second category")
        }
        page.categoryPopup.selectItem(at: placeIndex)
        page.categoryPopup.sendAction(page.categoryPopup.action, to: page.categoryPopup.target)
        try pageSettled(page) { page.element.categoryId == place.id }
        let edited = page.element
        try require(host.activeElement == edited && page.errorMessage == nil, "Tab did not adopt the stored element")

        // Header writes are metadata only: the body keeps its own history.
        try require(try read(core).projection.canUndo, "Header edits cleared the body history")
        body.undoProse(); try elementSettled(host, body)
        try require(try read(core).projection.text == "" && page.element == edited, "Body undo touched the element fields")
        body.redoProse(); try elementSettled(host, body)

        // An empty name is restored locally; nothing is sent.
        let changeSets = try elementCount(directory, "sync_change_set"), mutations = try elementCount(directory, "sync_mutation")
        try editHeader(window, page.nameField, "   ")
        try pageSettled(page) { page.errorMessage != nil && page.text(of: .name) == "林岚岚" }
        try require(page.errorMessage == "名称不能为空，已恢复原名称。", "Empty name was not restored")

        // Conflicts are refused before any row or journal change and keep the typed text.
        try editHeader(window, page.nameField, "沈舟")
        try pageSettled(page) { page.errorMessage?.contains("沈舟") == true }
        try require(page.errorMessage == "“沈舟”已被设定“沈舟”使用，请换一个名称或别名。" && page.text(of: .name) == "沈舟"
            && page.element.name == "林岚岚" && host.tabTitles(pane: 0) == ["雨夜", "林岚岚"],
            "Name conflict did not keep the typed text and the stored title: \(page.errorMessage ?? "none")")
        try editHeader(window, page.aliasesField, "阿岚，BOAT")
        try pageSettled(page) { page.errorMessage?.contains("Boat") == true }
        try require(page.errorMessage == "“Boat”已被设定“沈舟”使用，请换一个名称或别名。" && page.text(of: .aliases) == "阿岚，BOAT"
            && page.text(of: .name) == "沈舟" && page.element.aliases == ["lan", "岚姐", "阿岚"],
            "Case-insensitive alias conflict did not keep both typed fields: \(page.errorMessage ?? "none")")
        try require(try elementCount(directory, "sync_change_set") == changeSets && elementCount(directory, "sync_mutation") == mutations,
            "A refused header edit wrote a journal row")
        let stored: WorkspaceElementLibrary = try elementResult { workspace.elementLibrary(projectID: project.id, completion: $0) }
        try require(stored.elements.first { $0.id == element.id } == edited, "A refused header edit changed the stored element")

        try editHeader(window, page.nameField, "林岚")
        try pageSettled(page) { page.element.name == "林岚" }
        try require(page.errorMessage == nil && host.tabTitles(pane: 0) == ["雨夜", "林岚"] && page.text(of: .aliases) == "阿岚，BOAT",
            "Correcting the name did not clear the refusal or kept the wrong title")
        try editHeader(window, page.aliasesField, "阿岚", returnKey: true)
        try pageSettled(page) { page.element.aliases == ["阿岚"] }

        // A second page of the same element follows saved fields it has not edited.
        let twin: NativeDocumentView = try elementResult { host.split(completion: $0) }
        try elementSettled(host, twin)
        guard let twinPage = host.retainedElementPage(pane: 1, scope: scope) else { throw LabError.message("Split did not open the element page") }
        try require(twinPage.text(of: .name) == "林岚" && twinPage.text(of: .summary) == "港口出身。\n擅长夜航。"
            && twinPage.text(of: .category) == place.id && twin.textView.string == "旧港🙂", "Second page did not show the stored fields")
        try editHeader(window, twinPage.groupField, "配角", returnKey: true)
        try pageSettled(twinPage) { twinPage.element.groupName == "配角" }
        try require(page.element.groupName == "配角" && page.text(of: .group) == "配角", "The other page did not follow a saved field")
        try require(try read(core).projection.text == "旧港🙂" && chapterView.textView.string.isEmpty, "Header edits changed a body")

        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed, "Header workspace failed to close")
        let cold = LabWorkspaceCore(directory: directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let library: WorkspaceElementLibrary = try elementResult { cold.elementLibrary(projectID: project.id, completion: $0) }
        let reopened = library.elements.first { $0.id == element.id }
        try require(reopened?.name == "林岚" && reopened?.aliases == ["阿岚"] && reopened?.summary == "港口出身。\n擅长夜航。"
            && reopened?.groupName == "配角" && reopened?.categoryId == place.id, "Header fields did not survive cold reopen")
        let coldBody: LabCore = try elementResult { cold.openElement(projectID: project.id, elementID: element.id, completion: $0) }
        try require(try read(coldBody).projection.text == "旧港🙂", "Element body did not survive header edits and cold reopen")
        let coldClosed: Bool = try elementResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }

    private static func elementTrashClosesOnlyItsTabs() throws {
        let (directory, workspace, project, chapter) = try elementFixture()
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let model = ElementLibraryModel(workspace: workspace, projectID: project.id)
        model.load(); try wait { model.loaded && !model.busy }
        let category: WorkspaceElementCategory = try elementResult { model.createCategory(name: "地点", completion: $0) }
        let chart: WorkspaceElement = try elementResult { model.createElement(categoryID: category.id, completion: $0) }
        let lamp: WorkspaceElement = try elementResult { model.createElement(categoryID: category.id, completion: $0) }
        let (window, host) = elementHost(workspace)
        defer { window.close() }
        // Mirrors AppDelegate: the panel's trash goes through the tab owner.
        let controller = MacElementLibraryViewController(model: model)
        _ = controller.view
        controller.canNavigate = { host.canNavigate }
        var trashed: Result<WorkspaceElementReply<WorkspaceElement>, Error>?
        controller.onTrash = { element in
            host.trashElement(projectID: project.id, elementID: element.id) { result in
                if case .success(let reply) = result { model.apply(reply.library, message: nil) }
                trashed = result
            }
        }

        let chapterView: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
        try elementSettled(host, chapterView)
        let chapterCore = host.activeCore!
        chapterView.textView.insertText("潮🙂", replacementRange: NSRange(location: 0, length: 0))
        try elementSettled(host, chapterView)
        chapterView.textView.setSelectedRange(NSRange(location: 1, length: 2))
        try wait { chapterView.binding.selectionIsAnchored }
        let chartScope = ElementScope(projectID: project.id, elementID: chart.id)
        let chartView: NativeDocumentView = try elementResult { host.open(project: project, element: chart, completion: $0) }
        try elementSettled(host, chartView)
        let chartCore = host.activeCore!
        chartView.textView.insertText("旧梦🙂", replacementRange: NSRange(location: 0, length: 0))
        try elementSettled(host, chartView)
        let chartTwin: NativeDocumentView = try elementResult { host.split(completion: $0) }
        try elementSettled(host, chartTwin)
        let lampView: NativeDocumentView = try elementResult { host.open(project: project, element: lamp, in: 1, completion: $0) }
        try elementSettled(host, lampView)
        let lampCore = host.activeCore!
        lampView.textView.insertText("光", replacementRange: NSRange(location: 0, length: 0))
        try elementSettled(host, lampView)
        let chapterTwin: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, in: 1, completion: $0) }
        try elementSettled(host, chapterTwin)

        // Queued body input blocks the trash; every tab and the owner remain.
        let active: NativeDocumentView = try elementResult { host.open(project: project, element: chart, in: 0, completion: $0) }
        try elementSettled(host, active)
        try require(active === chartView, "Element tab was not retained")
        chartView.textView.insertText("续", replacementRange: NSRange(location: 4, length: 0))
        try require(chartView.binding.hasPendingWork, "Queued trash fixture was already idle")
        let _: String = try elementRefused({ host.trashElement(projectID: project.id, elementID: chart.id, completion: $0) },
            "Trash discarded queued element input")
        try elementSettled(host, chartView, chartTwin)
        try require(!chartCore.isClosed && host.retainedElementPage(pane: 0, scope: chartScope)?.documentView === chartView
            && host.retainedElementPage(pane: 1, scope: chartScope)?.documentView === chartTwin && chartTwin.textView.string == "旧梦🙂续",
            "Refused trash released the element or its tabs")

        guard let row = controller.rows.first(where: { $0.element?.id == chart.id }),
              let trashItem = controller.menuItems(for: row).first(where: { $0.accessibilityIdentifier() == "trash-element" }) as? LibraryMenuItem else {
            throw LabError.message("Element row lacks its 移到回收站 action")
        }
        trashItem.press()
        try wait { trashed != nil }
        let reply = try trashed!.get()
        try require(reply.result?.id == chart.id && reply.library.trashedElements.map(\.id) == [chart.id]
            && reply.library.elements.map(\.id) == [lamp.id], "Trash returned an incorrect library")
        try require(chartCore.isClosed && host.retainedElementPage(pane: 0, scope: chartScope) == nil
            && host.retainedElementPage(pane: 1, scope: chartScope) == nil, "Trash retained a display of the old element")
        try require(host.retainedView(pane: 0, scope: ChapterScope(projectID: project.id, chapterID: chapter.id)) === chapterView
            && host.retainedView(pane: 1, scope: ChapterScope(projectID: project.id, chapterID: chapter.id)) === chapterTwin
            && !chapterCore.isClosed && chapterView.textView.string == "潮🙂" && chapterView.textView.selectedRange() == NSRange(location: 1, length: 2)
            && host.tabTitles(pane: 0) == ["雨夜"] && host.tabTitles(pane: 1) == ["New Element 2", "雨夜"],
            "Trash changed chapter tabs or another element: \(host.tabTitles(pane: 0)) \(host.tabTitles(pane: 1))")
        try require(!lampCore.isClosed && host.retainedElementPage(pane: 1, scope: ElementScope(projectID: project.id, elementID: lamp.id))?
            .documentView === lampView && lampView.textView.string == "光", "Trash closed another element")
        try require(model.rows.contains(.trashHeader(count: 1)) && model.rows.contains { $0 == .trashed(reply.library.trashedElements[0]) }
            && reply.library.trashedElements[0].id == chart.id, "Library did not list the trashed element")

        let restoreItem = controller.menuItems(for: .trashed(reply.library.trashedElements[0])).first as? LibraryMenuItem
        restoreItem?.press()
        try wait { !model.busy && model.library.trashedElements.isEmpty }
        guard let restored = model.library.elements.first(where: { $0.id == chart.id }) else {
            throw LabError.message("Restore did not return the element to the library")
        }
        try require(host.retainedElementPage(pane: 0, scope: chartScope) == nil, "Restore opened an editor")
        let fresh: NativeDocumentView = try elementResult { host.open(project: project, element: restored, in: 0, completion: $0) }
        try elementSettled(host, fresh)
        try require(fresh !== chartView && host.activeCore !== chartCore && fresh.textView.string == "旧梦🙂续"
            && fresh.binding.state?.projection.canUndo == false, "Restore reused the old owner or lost the body")
        fresh.textView.insertText("归", replacementRange: NSRange(location: 5, length: 0))
        try elementSettled(host, fresh)
        chapterView.undoProse(); try elementSettled(host, chapterView, chapterTwin)
        try require(chapterView.textView.string.isEmpty && chapterTwin.textView.string.isEmpty, "Trash and restore changed chapter history")
        chapterView.redoProse(); try elementSettled(host, chapterView, chapterTwin)

        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed, "Restored element workspace failed to close")
        let cold = LabWorkspaceCore(directory: directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let coldElement: LabCore = try elementResult { cold.openElement(projectID: project.id, elementID: chart.id, completion: $0) }
        try require(try read(coldElement).projection.text == "旧梦🙂续归", "Restored element body did not survive cold reopen")
        let coldChapter: LabCore = try elementResult { cold.openChapter(projectID: project.id, chapterID: chapter.id, completion: $0) }
        try require(try read(coldChapter).projection.text == "潮🙂", "Chapter changed across element trash")
        let coldClosed: Bool = try elementResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }
}
