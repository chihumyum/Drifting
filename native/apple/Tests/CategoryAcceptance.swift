import AppKit

/// Category pages (分类页) and element templates through the real 设定库
/// panel, tab host, category and element pages, the 新设定模版 sheet, 关系
/// sections, 历史版本 and the writing assistant's tools over the Rust
/// workspace. The wiring mirrors AppDelegate; input is programmatic and every
/// text is synthetic.
extension BindingAcceptance {
    private final class CategoryHarness {
        let directory: URL
        let workspace: LabWorkspaceCore
        let project: WorkspaceProject
        let chapter: WorkspaceChapter
        let window: NSWindow
        let host: MacChapterWorkspace
        let model: ElementLibraryModel
        let controller: MacElementLibraryViewController
        let journal: JournalProbe
        /// Answers the next alerts; nil cancels.
        var answer: ((NSAlert) -> NSApplication.ModalResponse)?
        private(set) var alerts: [NSAlert] = []
        /// Elements the panel created and opened, in order.
        private(set) var created: [WorkspaceElement] = []
        var trashed: Result<WorkspaceElementReply<WorkspaceElementCategory>, Error>?

        init() throws {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                .appendingPathComponent("apple-native-lab")
            self.directory = directory
            journal = JournalProbe(directory: directory)
            let workspace = LabWorkspaceCore(directory: directory)
            self.workspace = workspace
            let initial: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(initial.isEmpty, "Category fixture was not isolated")
            let project: WorkspaceProject = try BindingAcceptance.elementResult { workspace.createProject(name: "分类合成项目", completion: $0) }
            self.project = project
            chapter = try BindingAcceptance.elementResult { workspace.createChapter(projectID: project.id, title: "雨夜", completion: $0) }
            (window, host) = BindingAcceptance.elementHost(workspace)
            // Sheets stay programmatic: the window is never ordered on screen.
            host.relations.presentSheet = { _, _ in }
            model = ElementLibraryModel(workspace: workspace, projectID: project.id)
            controller = MacElementLibraryViewController(model: model)
            _ = controller.view
            let (host, model) = (self.host, self.model)
            model.onLibrary = { host.applyElementLibrary(projectID: project.id, library: $0) }
            host.onElementLibrary = { projectID, library in if projectID == project.id { model.apply(library, message: nil) } }
            controller.canNavigate = { host.canNavigate }
            controller.onOpen = { element in host.open(project: project, element: element) { _ in } }
            controller.onCreated = { [weak self] element in
                host.open(project: project, element: element) { if case .success = $0 { self?.created.append(element) } }
            }
            controller.onOpenCategory = { category in host.open(project: project, category: category) { _ in } }
            controller.onTrashCategory = { [weak self] category in
                host.trashCategory(projectID: project.id, categoryID: category.id) { result in
                    if case .success(let reply) = result { model.apply(reply.library, message: nil) }
                    self?.trashed = result
                }
            }
            controller.presentAlert = { [weak self] alert, done in
                self?.alerts.append(alert)
                done(self?.answer?(alert) ?? .alertSecondButtonReturn)
            }
            host.relations.presentAlert = controller.presentAlert
            model.load(); try BindingAcceptance.wait { model.loaded && !model.busy }
        }

        var lastAlert: NSAlert? { alerts.last }

        func category(_ id: String) -> WorkspaceElementCategory? { model.library.categories.first { $0.id == id } }

        func scope(_ category: WorkspaceElementCategory) -> DocumentScope {
            .category(CategoryScope(projectID: project.id, categoryID: category.id))
        }

        func page(_ category: WorkspaceElementCategory, pane: Int = 0) -> MacCategoryPageView? {
            host.retainedCategoryPage(pane: pane, scope: CategoryScope(projectID: project.id, categoryID: category.id))
        }

        func elementPage(_ element: WorkspaceElement, pane: Int = 0) -> MacElementPageView? {
            host.retainedElementPage(pane: pane, scope: ElementScope(projectID: project.id, elementID: element.id))
        }

        func row(_ category: WorkspaceElementCategory) throws -> Int {
            guard let index = controller.rows.firstIndex(where: {
                if case .category(let row, _) = $0 { return row.id == category.id }; return false
            }) else { throw LabError.message("The 设定库 lists no row for \(category.name)") }
            return index
        }

        func item(_ row: ElementLibraryModel.Row, _ identifier: String) throws -> LibraryMenuItem {
            guard let item = controller.menuItems(for: row).first(where: { $0.accessibilityIdentifier() == identifier }) as? LibraryMenuItem else {
                throw LabError.message("The 设定库 row lacks \(identifier)")
            }
            return item
        }

        func categoryItem(_ category: WorkspaceElementCategory, _ identifier: String) throws -> LibraryMenuItem {
            try item(controller.rows[try row(category)], identifier)
        }

        /// Opens the page through the 设定库 (double-click) and waits for its body.
        func openPage(_ category: WorkspaceElementCategory) throws -> MacCategoryPageView {
            try BindingAcceptance.wait { self.host.canNavigate && !self.model.busy }
            controller.openCategory(atRow: try row(category))
            try BindingAcceptance.wait { self.page(category) != nil && self.host.activeCategory?.id == category.id }
            guard let page = page(category) else { throw LabError.message("\(category.name) has no page") }
            try settle(page.documentView)
            try BindingAcceptance.wait { page.template != nil && page.elementCount != nil }
            return page
        }

        func settle(_ views: NativeDocumentView...) throws {
            try BindingAcceptance.wait {
                !self.host.isBusy && views.allSatisfy {
                    $0.binding.state != nil && !$0.binding.hasPendingWork && !$0.binding.store.hasScheduledLinks
                }
            }
        }

        func type(_ view: NativeDocumentView, _ text: String, at location: Int? = nil) throws {
            let at = location ?? (view.textView.string as NSString).length
            view.textView.insertText(text, replacementRange: NSRange(location: at, length: 0))
            try settle(view)
        }

        func stored(_ category: WorkspaceElementCategory) throws -> WorkspaceAgentProse {
            try BindingAcceptance.elementResult {
                workspace.agentReadProse(projectID: project.id, kind: "category", id: category.id, completion: $0)
            }
        }

        func close() throws {
            try BindingAcceptance.wait { self.host.canNavigate && !self.model.busy }
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "Category workspace failed to close")
            window.close()
        }

        func remove() { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
    }

    private static func categoryPress(_ button: NSButton) { button.sendAction(button.action, to: button.target) }

    private static func categoryPageSettled(_ page: MacCategoryPageView, _ condition: () -> Bool) throws {
        try wait { !page.isCommitting && condition() }
    }

    /// Types into a sheet row through its field editor, keeping the editor;
    /// with `at`, before that UTF-16 location instead of over the selection.
    private static func typeRow(_ sheet: ElementTemplateSheet, _ index: Int, _ text: String, at location: Int? = nil) throws -> NSTextView {
        let field = sheet.editor.rows[index].textField
        if field.currentEditor() == nil { try require(sheet.window.makeFirstResponder(field), "Template row refused keyboard focus") }
        guard let editor = field.currentEditor() as? NSTextView else { throw LabError.message("Template row has no field editor") }
        if let location { editor.setSelectedRange(NSRange(location: location, length: 0)) }
        editor.insertText(text, replacementRange: editor.selectedRange())
        return editor
    }

    private static func setLevel(_ sheet: ElementTemplateSheet, _ index: Int, _ level: Int) {
        let popup = sheet.editor.rows[index].kindPopup
        popup.selectItem(withTag: level)
        popup.sendAction(popup.action, to: popup.target)
    }

    private static func templateBlock(_ kind: BookImportBlock.Kind, _ level: Int?, _ text: String,
                                      _ marks: [BookImportMark] = []) -> BookImportBlock {
        BookImportBlock(kind: kind, level: level, text: text, marks: marks)
    }

    static func categoryAcceptance() throws -> [String] {
        // The template preview is checked in the default body typography;
        // an earlier suite may have left another one set.
        let typography = DocumentStyle.typography
        DocumentStyle.typography = .standard
        defer { DocumentStyle.typography = typography }
        try categoryPageFromLibrary()
        try categoryTemplateAndNewElements()
        try categoryRelationsHistoryAndAssistant()
        try categoryTrashAndRestore()
        return [
            "AppKit 设定库 opens a category page (分类页) by double-click and 打开分类页 as a tab beside chapter and element tabs, whose header renames and recolours with one field.set each, edits 模板字段 as ordered rows, follows the 设定库 and a second pane, and whose body keeps its own undo apart from the chapter and survives cold reopen",
            "AppKit 新设定模版 sheet on a category page edits headings and paragraphs with bold and italic on a selected range and Return adding a paragraph, previews how a new element starts, writes one field.set on 保存 and nothing when unchanged, shows Rust's range refusal in Chinese keeping the rows, elements created from the 设定库 and from the page open with the template body, and 清空模版 returns new elements to an empty body through cold reopen",
            "AppKit 关系 from an element page to a category names the category, its row opens the 分类页 in that pane whose 关系 lists the relation back, 历史版本 lists and restores the category body as one undoable edit, and the writing assistant reads the category and revises its open body on 接受",
            "AppKit category trash from the 设定库 after confirmation closes the category's tabs in both panes and its template sheet only after the commit while element and chapter tabs stay, restore lists it again and its page reopens with the body, 模板字段 and template through cold reopen",
        ]
    }

    // MARK: (a) The page from the 设定库

    private static func categoryPageFromLibrary() throws {
        let harness = try CategoryHarness()
        defer { harness.remove() }
        let (host, model, controller, window, journal) = (harness.host, harness.model, harness.controller, harness.window, harness.journal)
        let people: WorkspaceElementCategory = try elementResult { model.createCategory(name: "人物", completion: $0) }
        let lan: WorkspaceElement = try elementResult { model.createElement(categoryID: people.id, completion: $0) }
        let chapterView: NativeDocumentView = try elementResult { host.open(project: harness.project, chapter: harness.chapter, completion: $0) }
        try harness.settle(chapterView)
        try harness.type(chapterView, "雨夜。")
        let lanView: NativeDocumentView = try elementResult { host.open(project: harness.project, element: lan, completion: $0) }
        try harness.settle(lanView)

        // Double-click opens the page as a tab beside the others.
        try require(try harness.categoryItem(people, "open-element-category").title == "打开分类页"
            && controller.menuItems(for: controller.rows[try harness.row(people)]).first?.title == "打开分类页",
            "The category row menu does not start with 打开分类页")
        let page = try harness.openPage(people)
        try require(host.tabTitles(pane: 0) == ["雨夜", lan.name, "人物"] && host.activeChapter == nil && host.activeElement == nil
            && host.activeHistoryTarget == VersionHistoryTarget(projectID: harness.project.id, kind: "category", id: people.id, title: "人物")
            && !host.canReopenActive && !page.documentView.allowsComments,
            "The category page did not open as an active page tab: \(host.tabTitles(pane: 0))")
        try require(page.text(of: .name) == "人物" && page.text(of: .color) == people.color && page.countLabel.stringValue == "1 个设定"
            && page.factsEditor.rows.isEmpty && page.template == [] && page.templateView.detail.stringValue == "未设置"
            && page.templateView.preview.text.contains("空白段落"), "The page header or template section differs: \(page.countLabel.stringValue)")
        // 打开分类页 again selects the same tab and owner.
        let core = host.activeCore
        let back: NativeDocumentView = try elementResult { host.open(project: harness.project, element: lan, completion: $0) }
        try harness.settle(back)
        try harness.categoryItem(people, "open-element-category").press()
        try wait { host.activeCategory?.id == people.id && !host.isBusy }
        try require(host.activeCore === core && host.tabTitles(pane: 0).count == 3, "打开分类页 opened a second tab or owner")

        // Header edits: rename, recolour and 模板字段, one field.set each.
        var mark = try journal.mark()
        try editHeader(window, page.nameField, "  角色 ")
        try categoryPageSettled(page) { page.category.name == "角色" }
        try journal.expect([["field.set element-category"]], since: mark, "The page rename")
        try wait { harness.category(people.id)?.name == "角色" && host.tabTitles(pane: 0).last == "角色" && page.text(of: .name) == "角色" }
        try require(model.rows.contains { if case .category(let row, 1) = $0 { return row.name == "角色" }; return false },
            "The 设定库 did not follow the page rename")
        try editHeader(window, page.nameField, "   ")
        try categoryPageSettled(page) { page.errorMessage != nil && page.text(of: .name) == "角色" }
        try require(page.errorMessage == "名称不能为空，已恢复原名称。", "An empty name was not refused on the page")
        mark = try journal.mark()
        guard let green = page.colorPopup.itemArray.firstIndex(where: { $0.representedObject as? String == "#30A46C" }) else {
            throw LabError.message("The page colour popup lacks the palette")
        }
        page.colorPopup.selectItem(at: green)
        page.colorPopup.sendAction(page.colorPopup.action, to: page.colorPopup.target)
        try categoryPageSettled(page) { page.category.color == "#30A46C" }
        try journal.expect([["field.set element-category"]], since: mark, "The page recolour")
        try wait { harness.category(people.id)?.color == "#30A46C" }
        try require(harness.elementPage(lan)?.categoryPopup.selectedItem?.title == "角色", "The element page did not follow the rename")
        mark = try journal.mark()
        categoryPress(page.factsEditor.addButton)
        try editHeader(window, page.factsEditor.rows[0].keyField, "年龄")
        try editHeader(window, page.factsEditor.rows[0].valueField, " 未知 ", returnKey: true)
        try categoryPageSettled(page) { page.category.templateFacts == [WorkspaceFact(key: "年龄", value: " 未知 ")] }
        try require(harness.category(people.id)?.templateFacts == page.category.templateFacts && page.errorMessage == nil,
            "模板字段 were not stored exactly")
        try journal.expect([["entity.create kv-entry", "order.move kv-entry"], ["field.set kv-entry"]], since: mark,
            "模板字段 added and filled on the page")
        // A rename in the 设定库 reaches the page, the tab and the element page.
        let _: WorkspaceElementCategory = try elementResult { model.renameCategory(id: people.id, name: "人物角色", completion: $0) }
        try wait { page.text(of: .name) == "人物角色" && host.tabTitles(pane: 0).last == "人物角色"
            && harness.elementPage(lan)?.categoryPopup.selectedItem?.title == "人物角色" }

        // The body is the category's own owner with its own history.
        mark = try journal.mark()
        try harness.type(page.documentView, "人物的名字都是两个字。")
        try journal.expect([["yjs.update prose-document"]], since: mark, "Typing in the category body")
        page.documentView.undoProse(); try harness.settle(page.documentView)
        try require(page.documentView.textView.string.isEmpty && chapterView.textView.string == "雨夜。",
            "Category undo crossed into another body")
        page.documentView.redoProse(); try harness.settle(page.documentView)
        try require(page.documentView.textView.string == "人物的名字都是两个字。" && harness.stored(people).live, "Redo did not restore the body")
        chapterView.undoProse(); try harness.settle(chapterView)
        try require(chapterView.textView.string.isEmpty && page.documentView.textView.string == "人物的名字都是两个字。",
            "Chapter undo reached the category body")

        // A second pane shows the same owner; closing one keeps the other.
        let twin: NativeDocumentView = try elementResult { host.split(completion: $0) }
        try harness.settle(twin)
        guard let twinPage = harness.page(people, pane: 1) else { throw LabError.message("The split did not show the category page") }
        try harness.type(twin, "旧名不用。")
        try wait { page.documentView.textView.string == "人物的名字都是两个字。旧名不用。" }
        try require(twinPage.text(of: .name) == "人物角色" && twinPage.category.templateFacts == page.category.templateFacts,
            "The second category page differs")
        let closedTwin: Bool = try elementResult { host.closeSecondPane(completion: $0) }
        try require(closedTwin && harness.page(people) === page, "Closing the second pane closed the first page")

        try harness.close()
        let cold = LabWorkspaceCore(directory: harness.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let library: WorkspaceElementLibrary = try elementResult { cold.elementLibrary(projectID: harness.project.id, completion: $0) }
        guard let stored = library.categories.first(where: { $0.id == people.id }) else { throw LabError.message("The category was lost") }
        try require(stored.name == "人物角色" && stored.color == "#30A46C" && stored.templateFacts == [WorkspaceFact(key: "年龄", value: " 未知 ")],
            "Category fields did not survive cold reopen")
        let body: LabCore = try elementResult { cold.openCategory(projectID: harness.project.id, categoryID: people.id, completion: $0) }
        try require(try read(body).projection.text == "人物的名字都是两个字。旧名不用。", "The category body did not survive cold reopen")
        let coldClosed: Bool = try elementResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }

    // MARK: (b) 新设定模版 and new elements

    private static func categoryTemplateAndNewElements() throws {
        let harness = try CategoryHarness()
        defer { harness.remove() }
        let (host, model, journal, project) = (harness.host, harness.model, harness.journal, harness.project)
        let people: WorkspaceElementCategory = try elementResult { model.createCategory(name: "人物", completion: $0) }
        let page = try harness.openPage(people)

        // The sheet starts from the stored (empty) template.
        categoryPress(page.templateView.editButton)
        guard let sheet = page.templateSheet else { throw LabError.message("编辑模版… did not open the sheet") }
        try require(sheet.editor.rows.isEmpty && sheet.preview.text.contains("空白段落") && sheet.explanation.stringValue.contains("已有的设定不会改变"),
            "The template sheet did not start empty with its explanation")
        let start = try journal.mark()
        categoryPress(sheet.editor.addButton)
        try require(sheet.editor.rows.count == 1 && sheet.editor.rows[0].textField.currentEditor() != nil, "添加段落 did not take the keyboard")
        var editor = try typeRow(sheet, 0, "外貌")
        setLevel(sheet, 0, 2)
        // Return adds a paragraph below and moves the keyboard there.
        editor.doCommand(by: #selector(NSResponder.insertNewline(_:)))
        try require(sheet.editor.rows.count == 2 && sheet.editor.rows[1].textField.currentEditor() != nil
            && sheet.editor.blocks[0] == templateBlock(.heading, 2, "外貌"), "Return did not add a paragraph below the heading")
        editor = try typeRow(sheet, 1, "身高与衣着")
        editor.setSelectedRange(NSRange(location: 0, length: 2))
        categoryPress(sheet.editor.rows[1].boldButton)
        editor.setSelectedRange(NSRange(location: 3, length: 2))
        categoryPress(sheet.editor.rows[1].italicButton)
        try require(sheet.editor.rows[1].textField.currentEditor() === editor && editor.selectedRange() == NSRange(location: 3, length: 2),
            "B or I took the row's keyboard or selection")
        // Laying the row out substitutes CJK faces; the marks stay.
        if let manager = editor.layoutManager, let container = editor.textContainer { manager.ensureLayout(for: container) }
        try require(sheet.editor.blocks[1].marks == [BookImportMark(kind: .bold, location: 0, length: 2), BookImportMark(kind: .italic, location: 3, length: 2)]
            && (editor.textStorage?.attribute(.font, at: 3, effectiveRange: nil) as? NSFont)?.fontName.contains("PingFang") == true,
            "Face substitution in the row lost a mark: \(sheet.editor.blocks[1].marks)")
        categoryPress(sheet.editor.addButton)
        _ = try typeRow(sheet, 2, "动机")
        setLevel(sheet, 2, 3)
        categoryPress(sheet.editor.addButton)
        _ = try typeRow(sheet, 3, "删掉")
        categoryPress(sheet.editor.rows[3].deleteButton)
        // B on a row that is not being edited applies to the whole row.
        categoryPress(sheet.editor.addButton)
        _ = try typeRow(sheet, 3, "口头禅")
        try require(sheet.window.makeFirstResponder(nil), "The sheet row did not end editing")
        categoryPress(sheet.editor.rows[3].boldButton)
        try require(sheet.editor.blocks[3].marks == [BookImportMark(kind: .bold, location: 0, length: 3)],
            "B did not set a row that is not being edited")
        categoryPress(sheet.editor.rows[3].boldButton)
        categoryPress(sheet.editor.rows[3].upButton)
        let bold = BookImportMark(kind: .bold, location: 0, length: 2), italic = BookImportMark(kind: .italic, location: 3, length: 2)
        let expected = [templateBlock(.heading, 2, "外貌"), templateBlock(.paragraph, nil, "身高与衣着", [bold, italic]),
                        templateBlock(.paragraph, nil, "口头禅"), templateBlock(.heading, 3, "动机")]
        try require(sheet.editor.blocks == expected, "The sheet rows differ: \(sheet.editor.blocks)")
        // The preview sets the blocks as a new element's body starts. Its
        // attributes are read before the text system substitutes CJK faces.
        let preview = ElementTemplateStyle.preview(sheet.preview.blocks)
        try require(sheet.preview.text == "外貌\n身高与衣着\n口头禅\n动机" && sheet.preview.blocks == expected
            && ElementTemplateStyle.traits(preview.attribute(.font, at: 3, effectiveRange: nil) as? NSFont).bold
            && !ElementTemplateStyle.traits(preview.attribute(.font, at: 5, effectiveRange: nil) as? NSFont).bold
            && ElementTemplateStyle.traits(preview.attribute(.font, at: 6, effectiveRange: nil) as? NSFont).italic
            && ((preview.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize ?? 0)
                > ((preview.attribute(.font, at: 3, effectiveRange: nil) as? NSFont)?.pointSize ?? 0),
            "The preview did not set headings, bold and italic: \(sheet.preview.text)")
        try journal.expect([], since: start, "Editing the sheet before 保存")

        // 保存 writes one field.set; the page previews the stored template.
        categoryPress(sheet.saveButton)
        try wait { page.templateSheet == nil && page.template == expected }
        try journal.expect([["field.set element-category"]], since: start, "Saving the template")
        try require(page.templateView.preview.text == "外貌\n身高与衣着\n口头禅\n动机"
            && page.templateView.detail.stringValue.contains("2 个标题") && page.templateView.detail.stringValue.contains("2 个段落"),
            "The page did not preview the stored template: \(page.templateView.detail.stringValue)")
        let stored: [BookImportBlock] = try elementResult { harness.workspace.elementTemplate(projectID: project.id, categoryID: people.id, completion: $0) }
        try require(stored == expected, "The stored template differs: \(stored)")

        // Unchanged: 保存 writes nothing. Rust's range refusal keeps the rows.
        categoryPress(page.templateView.editButton)
        guard let again = page.templateSheet else { throw LabError.message("The template sheet did not reopen") }
        try require(again.editor.blocks == expected && again.editor.rows[1].textField.attributedStringValue.string == "身高与衣着",
            "The reopened sheet did not show the stored template")
        var mark = try journal.mark()
        categoryPress(again.saveButton)
        try wait { page.templateSheet == nil }
        try journal.expect([], since: mark, "Saving an unchanged template")
        categoryPress(page.templateView.editButton)
        guard let refused = page.templateSheet, let save = page.onSaveTemplate else { throw LabError.message("The template sheet did not reopen") }
        // Injected at the page's save seam: a bold range past its paragraph reaches Rust.
        page.onSaveTemplate = { blocks, done in
            var bad = blocks
            bad[0] = templateBlock(.heading, 2, bad[0].text, [BookImportMark(kind: .bold, location: 0, length: 9)])
            save(bad, done)
        }
        _ = try typeRow(refused, 2, "与", at: 0)
        mark = try journal.mark()
        categoryPress(refused.saveButton)
        try wait { refused.errorMessage != nil && refused.saveButton.isEnabled }
        try require(refused.errorMessage == "加粗或斜体的范围超出了所在段落的文字，模版未保存。请重新选择文字后再试。"
            && page.templateSheet === refused && refused.editor.blocks[2].text == "与口头禅" && page.template == expected,
            "The refusal was not shown in Chinese with the rows kept: \(refused.errorMessage ?? "none")")
        try journal.expect([], since: mark, "A refused template save")
        page.onSaveTemplate = save
        categoryPress(refused.cancelButton)
        try require(page.templateSheet == nil && page.template == expected, "取消 changed the template")
        try journal.expect([], since: mark, "Cancelling the sheet")

        // An element created from the 设定库 opens with the template body.
        mark = try journal.mark()
        try harness.categoryItem(people, "create-element").press()
        try wait { harness.created.count == 1 && !host.isBusy }
        let fresh = harness.created[0]
        guard let freshPage = harness.elementPage(fresh) else { throw LabError.message("The created element did not open") }
        try harness.settle(freshPage.documentView)
        let written = try journal.originals(since: mark)
        // One original creates the element with its empty seed; the fill
        // follows as the body's own Yjs revisions.
        try require(written.first == ["entity.create element", "yjs.update prose-document"]
            && written.dropFirst().allSatisfy { $0 == ["yjs.update prose-document"] } && written.count >= 2,
            "Creating from a template wrote \(written)")
        func matchesTemplate(_ view: NativeDocumentView) -> Bool {
            guard let projection = view.binding.state?.projection else { return false }
            let blocks = projection.blocks
            let boldRuns = blocks.count == 4 ? blocks[1].runs.filter(\.attributes.bold).map(\.range) : []
            let italicRuns = blocks.count == 4 ? blocks[1].runs.filter(\.attributes.italic).map(\.range) : []
            return projection.text == "外貌\n身高与衣着\n口头禅\n动机"
                && blocks.map(\.kind) == ["heading", "paragraph", "paragraph", "heading"]
                && blocks[0].headingLevel == 2 && blocks[3].headingLevel == 3
                && boldRuns.map(\.length) == [2] && boldRuns.first?.location == blocks[1].range.location
                && italicRuns.map(\.length) == [2] && italicRuns.first?.location == blocks[1].range.location + 3
        }
        try require(matchesTemplate(freshPage.documentView) && host.activeElement?.id == fresh.id
            && freshPage.element.facts.isEmpty, "The new element page did not show the template body")
        try wait { page.countLabel.stringValue == "1 个设定" }
        // Typing continues after the template in the element's own history.
        try harness.type(freshPage.documentView, "，爱穿灰色", at: ("外貌\n身高与衣着" as NSString).length)
        freshPage.documentView.undoProse(); try harness.settle(freshPage.documentView)
        try require(matchesTemplate(freshPage.documentView), "Undo in the new element did not return to the template body")
        try require(freshPage.documentView.binding.state?.projection.canUndo == false, "Undo went past the typed text")

        // 新建设定 on the page does the same and selects the new name.
        let back: NativeDocumentView = try elementResult { host.open(project: project, category: people, completion: $0) }
        try harness.settle(back)
        categoryPress(page.createElementButton)
        try wait { host.activeElement != nil && host.activeElement?.id != fresh.id && !host.isBusy }
        guard let second = host.activeElement, let secondPage = host.activeElementPage else { throw LabError.message("新建设定 did not open") }
        try harness.settle(secondPage.documentView)
        try require(second.categoryId == people.id && matchesTemplate(secondPage.documentView)
            && secondPage.window?.firstResponder === secondPage.nameField.currentEditor(),
            "新建设定 on the page did not open the element with the template and its name selected")
        try wait { page.countLabel.stringValue == "2 个设定" && model.library.elements.count == 2 }

        // 清空模版 then 保存 clears it; new elements start empty again.
        let clearedBack: NativeDocumentView = try elementResult { host.open(project: project, category: people, completion: $0) }
        try harness.settle(clearedBack)
        categoryPress(page.templateView.editButton)
        guard let clearing = page.templateSheet else { throw LabError.message("The template sheet did not reopen") }
        categoryPress(clearing.clearButton)
        try require(clearing.editor.rows.isEmpty && clearing.preview.text.contains("空白段落"), "清空模版 left rows or a preview")
        mark = try journal.mark()
        categoryPress(clearing.saveButton)
        try wait { page.templateSheet == nil && page.template == [] }
        try journal.expect([["field.set element-category"]], since: mark, "Clearing the template")
        try require(page.templateView.detail.stringValue == "未设置", "The page still showed a template")
        mark = try journal.mark()
        let empty: WorkspaceElement = try elementResult { model.createElement(categoryID: people.id, completion: $0) }
        try journal.expect([["entity.create element", "yjs.update prose-document"]], since: mark, "Creating without a template")
        let emptyBody: WorkspaceAgentProse = try elementResult {
            harness.workspace.agentReadProse(projectID: project.id, kind: "element", id: empty.id, completion: $0)
        }
        try require(emptyBody.text.isEmpty, "An element created after clearing was not empty: \(emptyBody.text)")

        try harness.close()
        let cold = LabWorkspaceCore(directory: harness.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let coldTemplate: [BookImportBlock] = try elementResult { cold.elementTemplate(projectID: project.id, categoryID: people.id, completion: $0) }
        try require(coldTemplate.isEmpty, "The cleared template came back after cold reopen")
        let coldBody: LabCore = try elementResult { cold.openElement(projectID: project.id, elementID: fresh.id, completion: $0) }
        let coldState = try read(coldBody)
        try require(coldState.projection.text == "外貌\n身高与衣着\n口头禅\n动机"
            && coldState.projection.blocks.map(\.kind) == ["heading", "paragraph", "paragraph", "heading"],
            "The templated element body did not survive cold reopen")
        let coldClosed: Bool = try elementResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }

    // MARK: (c) 关系, 历史版本 and the writing assistant

    private static func categoryRelationsHistoryAndAssistant() throws {
        let harness = try CategoryHarness()
        defer { harness.remove() }
        let (host, model, journal, project) = (harness.host, harness.model, harness.journal, harness.project)
        let people: WorkspaceElementCategory = try elementResult { model.createCategory(name: "人物", completion: $0) }
        let lan: WorkspaceElement = try elementResult { model.createElement(categoryID: people.id, completion: $0) }
        let relations = host.relations.model(projectID: project.id)
        try wait { relations.loaded && !relations.busy }
        let related: WorkspaceRelationType = try elementResult {
            relations.createType(RelationTypeDefinition(name: "归类", orientation: "directed", sourceRole: "成员", targetRole: "类别",
                                                        sourceKinds: ["element"], targetKinds: ["category"]), completion: $0)
        }

        // 添加关系… on the element page offers the category.
        let lanView: NativeDocumentView = try elementResult { host.open(project: project, element: lan, completion: $0) }
        try harness.settle(lanView)
        guard let lanPage = harness.elementPage(lan) else { throw LabError.message("The element page is missing") }
        try relationsLoaded(lanPage.relationsView)
        categoryPress(lanPage.relationsView.addButton)
        guard let sheet = host.relations.addSheet else { throw LabError.message("添加关系… did not open the sheet") }
        try wait { sheet.names.storylinesKnown }
        let end = RelationEndpoint(kind: "category", id: people.id)
        try require(sheet.candidates.contains { $0.endpoint == end && $0.name == "人物" }, "The add sheet did not list the category")
        sheet.choose(end)
        try require(sheet.typeOptions.map(\.id).contains(related.id), "The add sheet did not offer the element → category type")
        sheet.chooseType(related.id)
        try require(sheet.addButton.isEnabled, "添加 was disabled: \(sheet.errorMessage ?? "none")")
        var mark = try journal.mark()
        categoryPress(sheet.addButton)
        try wait { host.relations.addSheet == nil && !relations.busy }
        try journal.expect([["entity.create entity-relation"]], since: mark, "Relating the element to the category")
        try wait { lanPage.relationsView.rows.count == 1 }
        guard let row = lanPage.relationsView.rows.first else { throw LabError.message("The relation row is missing") }
        try require(row.kindLabel.stringValue == "分类" && row.nameButton.title == "人物" && row.nameButton.isEnabled,
            "The relation row did not name the category: \(row.entry.text)")

        // The row opens the 分类页 in that pane; its 关系 lists the relation back.
        categoryPress(row.nameButton)
        try wait { host.activeCategory?.id == people.id && !host.isBusy }
        guard let page = harness.page(people) else { throw LabError.message("The relation row did not open the category page") }
        try harness.settle(page.documentView)
        try relationsLoaded(page.relationsView)
        try wait { page.relationsView.entries.count == 1 }
        try require(page.relationsView.entries[0].other == RelationEndpoint(kind: "element", id: lan.id)
            && page.relationsView.rows[0].nameButton.title == lan.name && lanPage.relationsView.errorMessage == nil,
            "The category page did not list the relation back")
        try require(host.tabTitles(pane: 0) == [lan.name, "人物"], "The category page did not open beside the element")

        // 历史版本: closing captures a version; restore is one undoable edit.
        try harness.type(page.documentView, "第一稿。")
        let closed: Bool = try elementResult { host.closeTab(pane: 0, scope: harness.scope(people), completion: $0) }
        try require(closed && harness.page(people) == nil, "The category tab did not close")
        let reopened: NativeDocumentView = try elementResult { host.open(project: project, category: people, completion: $0) }
        try harness.settle(reopened)
        guard let reopenedPage = harness.page(people) else { throw LabError.message("The category page did not reopen") }
        try harness.type(reopened, "改写：", at: 0)
        guard let target = host.activeHistoryTarget, target.kind == "category", target.title == "人物", target.scope == harness.scope(people) else {
            throw LabError.message("The category page has no history target")
        }
        let historyModel = VersionHistoryModel(workspace: harness.workspace, target: target)
        var restored: [Bool] = []
        historyModel.onRestored = { live in restored.append(live); host.adoptRestoredVersion(target, live: live) }
        let history = VersionHistorySheet(model: historyModel)
        var confirmation: NSAlert?
        history.presentAlert = { alert, done in confirmation = alert; done(.alertFirstButtonReturn) }
        history.begin(in: nil)
        historyModel.load()
        try wait { historyModel.loaded && !historyModel.busy }
        guard let first = historyModel.entries.first(where: { $0.text == "第一稿。" }) else {
            throw LabError.message("历史版本 did not list the closed body: \(historyModel.entries.map(\.text))")
        }
        history.select(entryID: first.id)
        mark = try journal.mark()
        history.restoreButton.performClick(nil)
        try wait { historyModel.loaded && !historyModel.busy && restored == [true] }
        try harness.settle(reopened)
        try require(reopened.textView.string == "第一稿。" && confirmation != nil && (try harness.stored(people)).text == "第一稿。",
            "The open category page did not adopt the version: \(reopened.textView.string)")
        try journal.expect([["yjs.update prose-document"]], since: mark, "Restoring a category version")
        history.close()
        reopened.undoProse(); try harness.settle(reopened)
        try require(reopened.textView.string == "改写：第一稿。", "Undo did not return the text before the restore")
        reopened.redoProse(); try harness.settle(reopened)

        // The writing assistant reads the category and revises its open body.
        let tools = AgentWorkspaceTools(workspace: harness.workspace, projectID: project.id)
        func run(_ name: String, _ arguments: String) throws -> AgentToolOutcome {
            var outcome: AgentToolOutcome?
            tools.run(AgentToolCall(id: "call_\(name)", name: name, arguments: arguments), turnID: "turn_category") { outcome = $0 }
            try wait { outcome != nil }
            return outcome!
        }
        try require(AgentToolRegistry.definition("read_category") != nil && AgentToolRegistry.definition("revise_category") != nil,
            "The assistant lacks the category tools")
        let listing = try run("list_elements", "{}")
        try require(listing.ok && listing.content.contains("\"categories\"") && listing.content.contains(people.id), "list_elements did not list categories")
        let readOutcome = try run("read_category", #"{"name":"人物"}"#)
        try require(readOutcome.ok && readOutcome.content.contains("第一稿。") && readOutcome.content.contains("\"elementCount\":1")
            && readOutcome.activity == "读取分类「人物」", "read_category differs: \(readOutcome.content)")
        let unknown = try run("read_category", #"{"name":"地点"}"#)
        try require(!unknown.ok && unknown.content.contains("找不到名为「地点」的分类"), "An unknown category was not refused in Chinese")
        let revise = try run("revise_category", #"{"categoryId":"\#(people.id)","changes":[{"currentText":"第一稿","revisedText":"定稿"}]}"#)
        guard revise.ok, let proposal = revise.proposal else { throw LabError.message("revise_category made no proposal: \(revise.content)") }
        try require(proposal.targetKind == "category" && proposal.headline == "修改分类「人物」"
            && reopened.textView.string == "第一稿。", "The proposal wrote before 接受: \(proposal.headline)")
        mark = try journal.mark()
        var applied: Result<AgentApplyOutcome, AgentApplyRefusal>?
        tools.apply(proposal, sessionID: "session_category") { applied = $0 }
        try wait { applied != nil }
        guard case .success(.prose(1, true, false)) = applied! else { throw LabError.message("The revision was not applied live: \(applied!)") }
        try harness.settle(reopened)
        try require(reopened.textView.string == "定稿。" && reopenedPage.documentView === reopened, "The open page did not adopt the revision")
        try journal.expect([["yjs.update prose-document"]], since: mark, "Accepting the category revision")
        let appendOutcome = try run("append_to_body", #"{"kind":"category","name":"人物","text":"姓氏取自地名。"}"#)
        try require(appendOutcome.ok && appendOutcome.proposal?.targetKind == "category", "append_to_body refused a category: \(appendOutcome.content)")
        try require(host.agentContext(projectID: project.id) == "分类「人物」", "The runtime note did not name the category page")

        try harness.close()
        let cold = LabWorkspaceCore(directory: harness.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let coldBody: LabCore = try elementResult { cold.openCategory(projectID: project.id, categoryID: people.id, completion: $0) }
        try require(try read(coldBody).projection.text == "定稿。", "The revised category body did not survive cold reopen")
        let coldRelations: WorkspaceRelationLibrary = try elementResult { cold.relationLibrary(projectID: project.id, completion: $0) }
        try require(coldRelations.relations.contains { $0.to == RelationEndpoint(kind: "category", id: people.id) || $0.from == RelationEndpoint(kind: "category", id: people.id) },
            "The category relation did not survive cold reopen")
        let coldClosed: Bool = try elementResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }

    // MARK: (d) Trash and restore

    private static func categoryTrashAndRestore() throws {
        let harness = try CategoryHarness()
        defer { harness.remove() }
        let (host, model, journal, project, controller) = (harness.host, harness.model, harness.journal, harness.project, harness.controller)
        let people: WorkspaceElementCategory = try elementResult { model.createCategory(name: "人物", completion: $0) }
        let template = [templateBlock(.heading, 1, "来历")]
        let _: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            harness.workspace.setElementTemplate(projectID: project.id, categoryID: people.id, blocks: template, completion: $0)
        }
        let lan: WorkspaceElement = try elementResult { model.createElement(categoryID: people.id, completion: $0) }
        let chapterView: NativeDocumentView = try elementResult { host.open(project: project, chapter: harness.chapter, completion: $0) }
        try harness.settle(chapterView)
        try harness.type(chapterView, "潮声。")
        let lanView: NativeDocumentView = try elementResult { host.open(project: project, element: lan, completion: $0) }
        try harness.settle(lanView)
        let page = try harness.openPage(people)
        try require(page.template == template, "The page did not read the template")
        try harness.type(page.documentView, "命名札记。")
        let core = host.activeCore!
        let twin: NativeDocumentView = try elementResult { host.split(completion: $0) }
        try harness.settle(twin)
        try require(harness.page(people, pane: 1) != nil && twin.textView.string == "命名札记。", "The split did not show the category")
        categoryPress(page.templateView.editButton)
        guard let sheet = page.templateSheet else { throw LabError.message("The template sheet did not open") }
        let titles = host.tabTitles(pane: 0)

        // 取消 in the confirmation changes nothing.
        let mark = try journal.mark()
        try harness.categoryItem(people, "trash-element-category").press()
        try require(harness.lastAlert?.informativeText.contains("1 个设定会移到“未分类”") == true
            && harness.lastAlert?.informativeText.contains("打开的分类页会随之关闭") == true && harness.trashed == nil
            && harness.page(people) === page && page.templateSheet === sheet, "A cancelled trash changed something")
        try journal.expect([], since: mark, "A cancelled category trash")

        // The trash commits, then only the category's tabs and sheet close.
        harness.answer = { _ in .alertFirstButtonReturn }
        try harness.categoryItem(people, "trash-element-category").press()
        try wait { harness.trashed != nil && !host.isBusy }
        let reply = try harness.trashed!.get()
        try require(reply.result?.id == people.id && reply.library.trashedCategories.map(\.id) == [people.id], "The trash reply differs")
        try journal.expect([["entity.trash element-category"]], since: mark, "Trashing the category")
        try require(core.isClosed && harness.page(people) == nil && harness.page(people, pane: 1) == nil && page.templateSheet == nil
            && host.tabTitles(pane: 0) == titles.filter { $0 != "人物" } && host.tabTitles(pane: 1).isEmpty,
            "The trash did not close exactly the category's tabs: \(host.tabTitles(pane: 0)) / \(host.tabTitles(pane: 1))")
        try require(chapterView.textView.string == "潮声。" && lanView.textView.string == "来历"
            && harness.elementPage(lan)?.categoryPopup.titleOfSelectedItem == "未分类", "Chapter or element tabs changed")
        try require(model.rows.contains(.trashedCategory(reply.library.trashedCategories[0])), "The 设定库 did not list the trashed category")

        // Restore lists it again; its page reopens with the body, fields and template.
        guard let restore = controller.menuItems(for: .trashedCategory(reply.library.trashedCategories[0])).first as? LibraryMenuItem else {
            throw LabError.message("The trashed category lacks 恢复")
        }
        restore.press()
        try wait { model.library.trashedCategories.isEmpty && harness.category(people.id) != nil && !model.busy }
        let fresh = try harness.openPage(people)
        try require(fresh !== page && fresh.documentView.textView.string == "命名札记。" && fresh.template == template
            && fresh.documentView.binding.state?.projection.canUndo == false && fresh.countLabel.stringValue == "还没有设定",
            "The restored category page lost its body or template: \(fresh.countLabel.stringValue)")
        try harness.type(fresh.documentView, "续。")

        try harness.close()
        let cold = LabWorkspaceCore(directory: harness.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let library: WorkspaceElementLibrary = try elementResult { cold.elementLibrary(projectID: project.id, completion: $0) }
        try require(library.categories.map(\.id) == [people.id] && library.elements.first?.categoryId == nil,
            "Trash and restore did not survive cold reopen")
        let coldTemplate: [BookImportBlock] = try elementResult { cold.elementTemplate(projectID: project.id, categoryID: people.id, completion: $0) }
        try require(coldTemplate == template, "The template did not survive trash, restore and cold reopen")
        let coldBody: LabCore = try elementResult { cold.openCategory(projectID: project.id, categoryID: people.id, completion: $0) }
        try require(try read(coldBody).projection.text == "命名札记。续。", "The category body did not survive trash, restore and cold reopen")
        let coldClosed: Bool = try elementResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }
}
