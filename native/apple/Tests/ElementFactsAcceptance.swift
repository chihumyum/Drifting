import AppKit

/// Element facts, category template facts and category trash through the real
/// AppKit page, library panel and Rust workspace. Input is programmatic.
extension BindingAcceptance {
    private static func press(_ button: NSButton) {
        button.sendAction(button.action, to: button.target)
    }

    private static func fact(_ key: String, _ value: String) -> WorkspaceFact { WorkspaceFact(key: key, value: value) }

    private static func libraryItem(_ controller: MacElementLibraryViewController, _ row: ElementLibraryModel.Row,
                                    _ identifier: String) throws -> LibraryMenuItem {
        guard let item = controller.menuItems(for: row).first(where: { $0.accessibilityIdentifier() == identifier }) as? LibraryMenuItem else {
            throw LabError.message("Library row lacks \(identifier)")
        }
        return item
    }

    private static func categoryRow(_ controller: MacElementLibraryViewController, _ id: String) throws -> ElementLibraryModel.Row {
        guard let row = controller.rows.first(where: { if case .category(let category, _) = $0 { return category.id == id }; return false }) else {
            throw LabError.message("Library does not list category \(id)")
        }
        return row
    }

    static func elementFactsAcceptance() throws -> [String] {
        try elementFactsEditReorderAndFollow()
        try categoryTemplateFactsCloneIntoNewElements()
        try categoryTrashDetachesElementsAndRestores()
        return [
            "AppKit element page facts add edit reorder and delete rows as one ordered untrimmed list, keep typed rows on refusal, follow the other page and survive cold reopen",
            "AppKit category template facts edited in the library sheet clone into an element created through the panel while older elements and the template stay independent",
            "AppKit category trash moves its elements to 未分类 with open element tabs retained and category popups updated, refuses a stale template save and restore does not re-attach",
        ]
    }

    private static func elementFactsEditReorderAndFollow() throws {
        let (directory, workspace, project, chapter) = try elementFixture()
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let people: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: project.id, name: "人物", completion: $0)
        }
        let created: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: project.id, categoryID: people.result!.id, name: "林岚", completion: $0)
        }
        let element = created.result!
        try require(element.facts.isEmpty && people.result!.templateFacts.isEmpty && created.library.trashedCategories.isEmpty,
            "A new element or category carried facts")
        let scope = ElementScope(projectID: project.id, elementID: element.id)

        let (window, host) = elementHost(workspace)
        defer { window.close() }
        let chapterView: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
        try elementSettled(host, chapterView)
        let body: NativeDocumentView = try elementResult { host.open(project: project, element: element, completion: $0) }
        try elementSettled(host, body)
        let core = host.activeCore!
        guard let page = host.retainedElementPage(pane: 0, scope: scope) else { throw LabError.message("Element page was not retained") }
        body.textView.insertText("潮声", replacementRange: NSRange(location: 0, length: 0))
        try elementSettled(host, body)
        let editor = page.factsEditor
        try require(editor.rows.isEmpty && editor.facts.isEmpty, "A new element page listed facts")

        // A blank row is local until it has text; it takes the keyboard.
        let beforeBlank = try elementCount(directory, "sync_change_set")
        press(editor.addButton)
        try pageSettled(page) { true }
        try require(editor.rows.count == 1 && editor.rows[0].keyField.currentEditor() != nil && editor.isEditing,
            "Adding a fact row did not focus its key")
        try require(try elementCount(directory, "sync_change_set") == beforeBlank && page.element.facts.isEmpty, "A blank fact row was written")

        try editHeader(window, editor.rows[0].keyField, "年龄")
        try pageSettled(page) { page.element.facts == [fact("年龄", "")] }
        try editHeader(window, editor.rows[0].valueField, " 二十七 ", returnKey: true)
        try pageSettled(page) { page.element.facts == [fact("年龄", " 二十七 ")] }
        press(editor.addButton)
        try editHeader(window, editor.rows[1].keyField, "身份")
        try editHeader(window, editor.rows[1].valueField, "船医")
        press(editor.addButton)
        try editHeader(window, editor.rows[2].keyField, "口头禅")
        try editHeader(window, editor.rows[2].valueField, "再说吧🙂", returnKey: true)
        try pageSettled(page) { page.element.facts.count == 3 && page.element.facts[2].value == "再说吧🙂" }
        try require(page.element.facts == [fact("年龄", " 二十七 "), fact("身份", "船医"), fact("口头禅", "再说吧🙂")]
            && editor.facts == page.element.facts && page.errorMessage == nil, "Typed facts were not stored exactly and in order")
        try require(!editor.rows[0].upButton.isEnabled && editor.rows[1].upButton.isEnabled && !editor.rows[2].downButton.isEnabled,
            "Move buttons did not follow the row positions")

        press(editor.rows[2].upButton)
        try pageSettled(page) { page.element.facts.map(\.key) == ["年龄", "口头禅", "身份"] }
        press(editor.rows[0].downButton)
        try pageSettled(page) { page.element.facts.map(\.key) == ["口头禅", "年龄", "身份"] }
        try require(editor.facts == page.element.facts, "Reordered rows differ from the stored order")

        // Text still being typed is carried into a delete and written once with it.
        let beforeDelete = try elementCount(directory, "sync_change_set")
        try require(window.makeFirstResponder(editor.rows[2].valueField), "Fact value refused keyboard focus")
        guard let valueEditor = editor.rows[2].valueField.currentEditor() as? NSTextView else { throw LabError.message("Fact value has no field editor") }
        valueEditor.selectAll(nil)
        valueEditor.insertText("军医", replacementRange: valueEditor.selectedRange())
        press(editor.rows[0].deleteButton)
        try pageSettled(page) { page.element.facts == [fact("年龄", " 二十七 "), fact("身份", "军医")] }
        try require(editor.facts == page.element.facts && !editor.isEditing && elementCount(directory, "sync_change_set") == beforeDelete + 1,
            "Deleting a row while typing lost the typed value or wrote more than once")

        press(editor.addButton)
        try pageSettled(page) { true }
        try require(editor.facts == [fact("年龄", " 二十七 "), fact("身份", "军医"), fact("", "")]
            && elementCount(directory, "sync_change_set") == beforeDelete + 1, "A trailing blank row was written")

        // A refused write keeps every typed row and explains itself.
        let write = page.onCommitFacts
        page.onCommitFacts = { _, done in done(.failure(LabError.elementUnavailable(reason: "Element is not available in this project"))) }
        try editHeader(window, editor.rows[2].keyField, "籍贯")
        try pageSettled(page) { page.errorMessage != nil }
        try require(page.errorMessage == "这个设定已不可用，请刷新设定库。" && editor.facts.last == fact("籍贯", "")
            && page.element.facts.count == 2, "A refused facts write did not keep the typed rows: \(page.errorMessage ?? "none")")
        page.onCommitFacts = write
        try editHeader(window, editor.rows[2].valueField, "北港")
        try pageSettled(page) { page.element.facts.count == 3 }
        try require(page.errorMessage == nil && page.element.facts == [fact("年龄", " 二十七 "), fact("身份", "军医"), fact("籍贯", "北港")],
            "Retrying after a refusal did not store the typed rows")

        // A second page of the same element shows and follows the stored list.
        let twin: NativeDocumentView = try elementResult { host.split(completion: $0) }
        try elementSettled(host, twin)
        guard let twinPage = host.retainedElementPage(pane: 1, scope: scope) else { throw LabError.message("Split did not open the element page") }
        try require(twinPage.factsEditor.facts == page.element.facts, "Second page did not show the stored facts")
        try editHeader(window, twinPage.factsEditor.rows[1].valueField, "军医兼领航")
        try pageSettled(twinPage) { twinPage.element.facts[1].value == "军医兼领航" }
        try require(page.factsEditor.facts == twinPage.element.facts && page.element == twinPage.element,
            "The other page did not follow an edited fact")
        press(twinPage.factsEditor.rows[2].upButton)
        try pageSettled(twinPage) { twinPage.element.facts.map(\.key) == ["年龄", "籍贯", "身份"] }
        let final = [fact("年龄", " 二十七 "), fact("籍贯", "北港"), fact("身份", "军医兼领航")]
        try require(twinPage.element.facts == final && page.factsEditor.facts == final && page.element.facts == final,
            "The other page did not follow a reorder")

        // Facts are metadata: the body and its history are untouched.
        try require(try read(core).projection.text == "潮声" && read(core).projection.canUndo && chapterView.textView.string.isEmpty,
            "Facts edits changed a body or its history")
        body.undoProse(); try elementSettled(host, body, twin)
        try require(try read(core).projection.text == "" && page.element.facts == final, "Body undo touched the facts")
        body.redoProse(); try elementSettled(host, body, twin)

        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed, "Facts workspace failed to close")
        let cold = LabWorkspaceCore(directory: directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let library: WorkspaceElementLibrary = try elementResult { cold.elementLibrary(projectID: project.id, completion: $0) }
        try require(library.elements.first { $0.id == element.id }?.facts == final, "Ordered facts did not survive cold reopen")
        let coldBody: LabCore = try elementResult { cold.openElement(projectID: project.id, elementID: element.id, completion: $0) }
        try require(try read(coldBody).projection.text == "潮声", "Element body did not survive facts edits and cold reopen")
        let coldClosed: Bool = try elementResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }

    private static func categoryTemplateFactsCloneIntoNewElements() throws {
        let (directory, workspace, project, _) = try elementFixture()
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let (window, host) = elementHost(workspace)
        defer { window.close() }
        // Mirrors AppDelegate: library replies reach open pages; a created
        // element opens as a tab.
        let model = ElementLibraryModel(workspace: workspace, projectID: project.id)
        model.onLibrary = { host.applyElementLibrary(projectID: project.id, library: $0) }
        let controller = MacElementLibraryViewController(model: model)
        _ = controller.view
        controller.canNavigate = { host.canNavigate }
        var opened: WorkspaceElement?
        controller.onCreated = { element in
            host.open(project: project, element: element) { if case .success = $0 { opened = element } }
        }
        model.load(); try wait { model.loaded && !model.busy }
        let category: WorkspaceElementCategory = try elementResult { model.createCategory(name: "人物", completion: $0) }
        let older: WorkspaceElement = try elementResult { model.createElement(categoryID: category.id, completion: $0) }
        try require(older.facts.isEmpty, "An element created without a template carried facts")

        try libraryItem(controller, try categoryRow(controller, category.id), "edit-element-category-template").press()
        guard let sheet = controller.templateSheet else { throw LabError.message("模板字段… did not open the template sheet") }
        try require(sheet.category.id == category.id && sheet.editor.rows.isEmpty && sheet.explanation.stringValue.contains("新建的设定")
            && sheet.explanation.stringValue.contains("已有的设定不会改变"), "Template sheet did not explain that it applies to new elements")
        let beforeSheet = try elementCount(directory, "sync_change_set")
        press(sheet.editor.addButton)
        try require(sheet.editor.rows[0].keyField.currentEditor() != nil, "Template row did not take the keyboard")
        try editHeader(sheet.window, sheet.editor.rows[0].keyField, "年龄")
        press(sheet.editor.addButton)
        try editHeader(sheet.window, sheet.editor.rows[1].keyField, "阵营")
        try editHeader(sheet.window, sheet.editor.rows[1].valueField, "中立")
        press(sheet.editor.addButton)
        press(sheet.editor.rows[1].upButton)
        try require(sheet.window.makeFirstResponder(sheet.editor.rows[1].valueField), "Template value refused keyboard focus")
        guard let typing = sheet.editor.rows[1].valueField.currentEditor() as? NSTextView else { throw LabError.message("Template value has no field editor") }
        typing.insertText("二十", replacementRange: typing.selectedRange())
        try require(sheet.editor.facts == [fact("阵营", "中立"), fact("年龄", "二十"), fact("", "")]
            && elementCount(directory, "sync_change_set") == beforeSheet, "Template sheet wrote before 保存 or lost a row")

        press(sheet.saveButton)
        try wait { controller.templateSheet == nil && !model.busy }
        let template = [fact("阵营", "中立"), fact("年龄", "二十")]
        try require(model.library.categories.first { $0.id == category.id }?.templateFacts == template,
            "Saved template differs from the typed rows")
        try require(model.library.elements.first { $0.id == older.id }?.facts.isEmpty == true, "A template changed an existing element")

        // A new element created through the panel clones the template.
        try libraryItem(controller, try categoryRow(controller, category.id), "create-element").press()
        try wait { opened != nil && !host.isBusy }
        guard let fresh = opened, let freshPage = host.retainedElementPage(pane: 0, scope: ElementScope(projectID: project.id, elementID: fresh.id)) else {
            throw LabError.message("Created element did not open")
        }
        try elementSettled(host, freshPage.documentView)
        try require(fresh.name == "New Element 2" && fresh.facts == template && freshPage.factsEditor.facts == template
            && host.activeElement?.id == fresh.id, "The new element did not show the cloned template facts")
        // Cloned facts belong to the element: editing them leaves the template.
        try editHeader(window, freshPage.factsEditor.rows[1].valueField, "十九")
        try pageSettled(freshPage) { freshPage.element.facts == [fact("阵营", "中立"), fact("年龄", "十九")] }
        let stored: WorkspaceElementLibrary = try elementResult { workspace.elementLibrary(projectID: project.id, completion: $0) }
        try require(stored.categories.first { $0.id == category.id }?.templateFacts == template, "Editing a cloned fact changed the template")

        let olderView: NativeDocumentView = try elementResult { host.open(project: project, element: older, completion: $0) }
        try elementSettled(host, olderView)
        guard let olderPage = host.retainedElementPage(pane: 0, scope: ElementScope(projectID: project.id, elementID: older.id)) else {
            throw LabError.message("Older element page was not retained")
        }
        try require(olderPage.factsEditor.rows.isEmpty && olderPage.element.facts.isEmpty, "The older element gained template facts")

        // Reopening the sheet shows the stored template; 取消 writes nothing.
        try libraryItem(controller, try categoryRow(controller, category.id), "edit-element-category-template").press()
        guard let again = controller.templateSheet else { throw LabError.message("Template sheet did not reopen") }
        try require(again.editor.facts == template, "Reopened template sheet did not show the stored rows")
        let beforeCancel = try elementCount(directory, "sync_change_set")
        press(again.editor.rows[0].deleteButton)
        press(again.cancelButton)
        try require(controller.templateSheet == nil && elementCount(directory, "sync_change_set") == beforeCancel, "取消 wrote the template")

        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed, "Template workspace failed to close")
        let cold = LabWorkspaceCore(directory: directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let library: WorkspaceElementLibrary = try elementResult { cold.elementLibrary(projectID: project.id, completion: $0) }
        try require(library.categories.first { $0.id == category.id }?.templateFacts == template
            && library.elements.first { $0.id == fresh.id }?.facts == [fact("阵营", "中立"), fact("年龄", "十九")]
            && library.elements.first { $0.id == older.id }?.facts.isEmpty == true, "Template and cloned facts did not survive cold reopen")
        let coldClosed: Bool = try elementResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }

    private static func categoryTrashDetachesElementsAndRestores() throws {
        let (directory, workspace, project, chapter) = try elementFixture()
        defer { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
        let (window, host) = elementHost(workspace)
        defer { window.close() }
        let model = ElementLibraryModel(workspace: workspace, projectID: project.id)
        model.onLibrary = { host.applyElementLibrary(projectID: project.id, library: $0) }
        let controller = MacElementLibraryViewController(model: model)
        _ = controller.view
        controller.canNavigate = { host.canNavigate }
        var alerts: [NSAlert] = []
        var answer = NSApplication.ModalResponse.alertSecondButtonReturn
        controller.presentAlert = { alert, done in alerts.append(alert); done(answer) }
        model.load(); try wait { model.loaded && !model.busy }
        let people: WorkspaceElementCategory = try elementResult { model.createCategory(name: "人物", completion: $0) }
        let places: WorkspaceElementCategory = try elementResult { model.createCategory(name: "地点", completion: $0) }
        let lan: WorkspaceElement = try elementResult { model.createElement(categoryID: people.id, completion: $0) }
        let zhou: WorkspaceElement = try elementResult { model.createElement(categoryID: people.id, completion: $0) }
        let port: WorkspaceElement = try elementResult { model.createElement(categoryID: places.id, completion: $0) }

        let chapterView: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapter, completion: $0) }
        try elementSettled(host, chapterView)
        let lanView: NativeDocumentView = try elementResult { host.open(project: project, element: lan, completion: $0) }
        try elementSettled(host, lanView)
        let lanCore = host.activeCore!
        lanView.textView.insertText("灯塔", replacementRange: NSRange(location: 0, length: 0))
        try elementSettled(host, lanView)
        let lanTwin: NativeDocumentView = try elementResult { host.split(completion: $0) }
        try elementSettled(host, lanTwin)
        let zhouView: NativeDocumentView = try elementResult { host.open(project: project, element: zhou, in: 1, completion: $0) }
        try elementSettled(host, zhouView)
        let lanScope = ElementScope(projectID: project.id, elementID: lan.id)
        let zhouScope = ElementScope(projectID: project.id, elementID: zhou.id)
        guard let lanPage = host.retainedElementPage(pane: 0, scope: lanScope), let lanTwinPage = host.retainedElementPage(pane: 1, scope: lanScope),
              let zhouPage = host.retainedElementPage(pane: 1, scope: zhouScope) else { throw LabError.message("Element pages were not retained") }
        try require([lanPage, lanTwinPage, zhouPage].allSatisfy { $0.text(of: .category) == people.id && $0.categoryPopup.numberOfItems == 3 },
            "Pages did not show their category before the trash")
        let titles = (host.tabTitles(pane: 0), host.tabTitles(pane: 1))

        // A template sheet left open across the trash is refused on 保存.
        try libraryItem(controller, try categoryRow(controller, people.id), "edit-element-category-template").press()
        guard let sheet = controller.templateSheet else { throw LabError.message("Template sheet did not open") }
        press(sheet.editor.addButton)
        try editHeader(sheet.window, sheet.editor.rows[0].keyField, "年龄")

        // 取消 in the confirmation changes nothing.
        let beforeCancel = try elementCount(directory, "sync_change_set")
        try libraryItem(controller, try categoryRow(controller, people.id), "trash-element-category").press()
        try require(alerts.count == 1 && alerts[0].messageText == "将分类“人物”移到回收站？"
            && alerts[0].informativeText.contains("2 个设定会移到“未分类”") && alerts[0].informativeText.contains("不会自动移回"),
            "Category trash did not ask with the detach explanation: \(alerts.first?.informativeText ?? "none")")
        try require(!model.busy && model.library.categories.count == 2 && elementCount(directory, "sync_change_set") == beforeCancel,
            "A cancelled category trash wrote")

        answer = .alertFirstButtonReturn
        try libraryItem(controller, try categoryRow(controller, people.id), "trash-element-category").press()
        try wait { !model.busy && model.library.trashedCategories.count == 1 }
        let library = model.library
        try require(library.categories.map(\.id) == [places.id] && library.trashedCategories.map(\.id) == [people.id]
            && library.trashedElements.isEmpty, "Category trash returned an incorrect library")
        try require(library.elements.first { $0.id == lan.id }?.categoryId == nil && library.elements.first { $0.id == zhou.id }?.categoryId == nil
            && library.elements.first { $0.id == port.id }?.categoryId == places.id, "Category trash did not detach exactly its elements")
        let trashedPeople = library.trashedCategories[0]
        try require(model.rows.contains(.uncategorized(count: 2)) && model.rows.contains(.trashHeader(count: 1))
            && model.rows.contains(.trashPart(title: "已删除分类", identifier: "element-trash-categories"))
            && model.rows.contains(.trashedCategory(trashedPeople)) && model.status.contains("未分类"),
            "Library did not list the detached elements and the trashed category")

        // Elements are not trashed: every tab, owner, body and history stays.
        try require(host.retainedElementPage(pane: 0, scope: lanScope) === lanPage && host.retainedElementPage(pane: 1, scope: lanScope) === lanTwinPage
            && host.retainedElementPage(pane: 1, scope: zhouScope) === zhouPage && !lanCore.isClosed
            && host.tabTitles(pane: 0) == titles.0 && host.tabTitles(pane: 1) == titles.1 && lanTwin.textView.string == "灯塔",
            "Category trash closed or changed an element tab")
        for page in [lanPage, lanTwinPage, zhouPage] {
            let items = page.categoryPopup.itemArray.map(\.title)
            try require(page.element.categoryId == nil && page.text(of: .category) == "" && page.categoryPopup.titleOfSelectedItem == "未分类"
                && items == ["未分类", "地点"], "An open page's category popup did not move to 未分类: \(items)")
        }
        lanView.undoProse(); try elementSettled(host, lanView, lanTwin)
        try require(lanTwin.textView.string.isEmpty, "Element body history was lost across the category trash")
        lanView.redoProse(); try elementSettled(host, lanView, lanTwin)

        press(sheet.saveButton)
        try wait { !model.busy && sheet.errorMessage != nil }
        try require(sheet.errorMessage == "这个分类已不可用，请刷新设定库。" && controller.templateSheet === sheet
            && sheet.editor.facts == [fact("年龄", "")], "A stale template save was not refused with its rows kept: \(sheet.errorMessage ?? "none")")
        press(sheet.cancelButton)
        try require(controller.templateSheet == nil, "取消 did not close the template sheet")

        // Restore brings the category back; its former elements stay detached.
        try libraryItem(controller, .trashedCategory(trashedPeople), "restore-element-category").press()
        try wait { !model.busy && model.library.trashedCategories.isEmpty }
        try require(Set(model.library.categories.map(\.id)) == [people.id, places.id]
            && model.library.elements.filter { $0.categoryId == nil }.map(\.id).sorted() == [lan.id, zhou.id].sorted()
            && model.rows.contains(.uncategorized(count: 2)) && !model.rows.contains { if case .trashHeader = $0 { return true }; return false },
            "Restore did not bring the category back without re-attaching its elements")
        for page in [lanPage, lanTwinPage, zhouPage] {
            try require(page.categoryPopup.numberOfItems == 3 && page.text(of: .category) == "" && page.element.categoryId == nil,
                "An open page re-attached or did not list the restored category")
        }

        // Re-attaching is an explicit page edit, followed by the other view.
        guard let peopleIndex = lanPage.categoryPopup.itemArray.firstIndex(where: { $0.representedObject as? String == people.id }) else {
            throw LabError.message("Category popup lacks the restored category")
        }
        lanPage.categoryPopup.selectItem(at: peopleIndex)
        lanPage.categoryPopup.sendAction(lanPage.categoryPopup.action, to: lanPage.categoryPopup.target)
        try pageSettled(lanPage) { lanPage.element.categoryId == people.id }
        try require(lanTwinPage.text(of: .category) == people.id && zhouPage.text(of: .category) == "", "The other page did not follow re-attaching")

        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed, "Category trash workspace failed to close")
        let cold = LabWorkspaceCore(directory: directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let reopened: WorkspaceElementLibrary = try elementResult { cold.elementLibrary(projectID: project.id, completion: $0) }
        try require(Set(reopened.categories.map(\.id)) == [people.id, places.id] && reopened.trashedCategories.isEmpty
            && reopened.elements.first { $0.id == lan.id }?.categoryId == people.id && reopened.elements.first { $0.id == zhou.id }?.categoryId == nil
            && reopened.elements.first { $0.id == port.id }?.categoryId == places.id, "Category trash and restore did not survive cold reopen")
        let coldBody: LabCore = try elementResult { cold.openElement(projectID: project.id, elementID: lan.id, completion: $0) }
        try require(try read(coldBody).projection.text == "灯塔", "Element body changed across the category trash")
        let coldClosed: Bool = try elementResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }
}
