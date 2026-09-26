import AppKit

/// Storylines, chapter membership and storyline pages through the real AppKit
/// panel, outline, sheet and pages over the Rust workspace. The wiring mirrors
/// AppDelegate; input is programmatic.
extension BindingAcceptance {
    /// One project with chapters, the tab host in a sized window, the 故事线
    /// panel and the outline, connected as AppDelegate connects them.
    private final class StorylineHarness {
        let directory: URL
        let workspace: LabWorkspaceCore
        let project: WorkspaceProject
        let chapters: [WorkspaceChapter]
        let window: NSWindow
        let host: MacChapterWorkspace
        let model: StorylineLibraryModel
        let controller: MacStorylineLibraryViewController
        let outline: WorkspaceOutlineModel
        let outlineController: BookOutlineViewController
        /// Answers the next alerts; nil cancels.
        var answer: ((NSAlert) -> NSApplication.ModalResponse)?
        private(set) var alerts: [NSAlert] = []
        var trashed: Result<WorkspaceStorylineReply<WorkspaceStoryline>, Error>?
        var sheet: ChapterStorylinesSheet?
        var sheetSaved: Bool?

        init(titles: [String]) throws {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                .appendingPathComponent("apple-native-lab")
            let workspace = LabWorkspaceCore(directory: directory)
            self.directory = directory
            self.workspace = workspace
            let initial: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(initial.isEmpty, "Storyline fixture was not isolated")
            let project: WorkspaceProject = try BindingAcceptance.elementResult { workspace.createProject(name: "故事线合成项目", completion: $0) }
            self.project = project
            chapters = try titles.map { title in
                try BindingAcceptance.elementResult { workspace.createChapter(projectID: project.id, title: title, completion: $0) }
            }
            (window, host) = BindingAcceptance.elementHost(workspace)
            model = StorylineLibraryModel(workspace: workspace, projectID: project.id)
            controller = MacStorylineLibraryViewController(model: model)
            outline = WorkspaceOutlineModel(workspace: workspace, projectID: project.id)
            outlineController = BookOutlineViewController(model: outline)
            _ = controller.view
            _ = outlineController.view
            let (host, model, outline, controller) = (self.host, self.model, self.outline, self.controller)
            model.onLibrary = { library in
                host.applyStorylineLibrary(projectID: project.id, library: library)
                outline.applyStorylines(library)
            }
            host.onStorylineLibrary = { projectID, library in
                guard projectID == project.id else { return }
                model.apply(library, message: nil)
                outline.applyStorylines(library)
            }
            controller.canNavigate = { host.canNavigate }
            let open: (WorkspaceStoryline) -> Void = { storyline in
                host.open(project: project, storyline: storyline) { _ in }
            }
            controller.onOpen = open
            controller.onCreated = open
            controller.onTrash = { [weak self] storyline in
                host.trashStoryline(projectID: project.id, storylineID: storyline.id) { result in
                    if case .success(let reply) = result { model.apply(reply.library, message: nil) }
                    self?.trashed = result
                }
            }
            controller.presentAlert = { [weak self] alert, done in
                self?.alerts.append(alert)
                done(self?.answer?(alert) ?? .alertSecondButtonReturn)
            }
            outlineController.canNavigate = { host.canNavigate }
            outlineController.onEditStorylines = { [weak self] entry in
                guard let self else { return }
                let sheet = ChapterStorylinesSheet(chapter: WorkspaceChapter(id: entry.id, title: entry.title), model: model)
                sheet.onFinish = { [weak self] saved in self?.sheetSaved = saved; self?.sheet = nil }
                self.sheetSaved = nil
                self.sheet = sheet
                sheet.begin(in: nil)
            }
            model.load(); try BindingAcceptance.wait { model.loaded && !model.busy }
            outline.load(); try BindingAcceptance.wait { outline.entries.count == titles.count && outline.storylines != nil }
        }

        var lastAlert: NSAlert? { alerts.last }

        func close() throws {
            sheet = nil
            // Link passes after library or chapter changes settle first.
            try BindingAcceptance.wait { self.host.canNavigate && !self.model.busy }
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "Storyline workspace failed to close")
            window.close()
        }

        func remove() { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }

        func storyline(named name: String) -> WorkspaceStoryline? { model.library.storylines.first { $0.name == name } }

        func page(_ storyline: WorkspaceStoryline, pane: Int = 0) -> MacStorylinePageView? {
            host.retainedStorylinePage(pane: pane, scope: StorylineScope(projectID: project.id, storylineID: storyline.id))
        }

        func rowItem(_ storyline: WorkspaceStoryline, _ identifier: String) throws -> LibraryMenuItem {
            guard let row = controller.rows.first(where: { $0.storyline?.id == storyline.id }),
                  let item = controller.menuItems(for: row).first(where: { $0.accessibilityIdentifier() == identifier }) as? LibraryMenuItem else {
                throw LabError.message("Storyline row lacks \(identifier)")
            }
            return item
        }

        func paletteItem(_ storyline: WorkspaceStoryline, _ hex: String) throws -> LibraryMenuItem {
            guard let row = controller.rows.first(where: { $0.storyline?.id == storyline.id }),
                  let colors = controller.menuItems(for: row).first(where: { $0.title == "更改颜色" })?.submenu,
                  let item = colors.items.first(where: { $0.accessibilityIdentifier() == "storyline-color-\(hex)" }) as? LibraryMenuItem else {
                throw LabError.message("Storyline row lacks colour \(hex)")
            }
            return item
        }

        /// Opens a chapter's 故事线… sheet from its outline 操作 menu.
        func openSheet(_ chapter: WorkspaceChapter) throws -> ChapterStorylinesSheet {
            guard let item = outlineController.actionItems(entryID: chapter.id)
                    .first(where: { $0.accessibilityIdentifier() == "outline-chapter-storylines" }), let action = item.action else {
                throw LabError.message("Outline chapter row lacks 故事线…")
            }
            try BindingAcceptance.require(item.isEnabled, "Outline 故事线… was disabled")
            NSApp.sendAction(action, to: item.target, from: item)
            guard let sheet else { throw LabError.message("故事线… did not open the chapter sheet") }
            return sheet
        }

        /// The outline's 主线 dot of a chapter: storyline name or 未归属, and colour.
        func chip(_ chapter: WorkspaceChapter) -> (text: String, color: String?)? {
            outlineController.storylineChip(chapterID: chapter.id).map { ($0.text, $0.colorHex) }
        }

        func membership(_ chapter: WorkspaceChapter) -> (ids: Set<String>, primary: String?)? {
            model.library.membership(chapterID: chapter.id).map { (Set($0.storylineIds), $0.primary) }
        }
    }

    private static func click(_ button: NSButton) { button.sendAction(button.action, to: button.target) }

    private static func setChecked(_ button: NSButton, _ on: Bool) {
        button.state = on ? .on : .off
        click(button)
    }

    private static func storylinePageSettled(_ page: MacStorylinePageView, _ condition: () -> Bool) throws {
        try wait { !page.isCommitting && condition() }
    }

    /// The page's listed chapters as (title, 主线) pairs in book order.
    private static func listed(_ page: MacStorylinePageView?) -> [String] {
        page?.chaptersView.listed.map { $0.primary ? "\($0.chapter.title)*" : $0.chapter.title } ?? []
    }

    static func storylineAcceptance() throws -> [String] {
        try storylinePanelCreateRenameReorder()
        try chapterStorylinesSheetMembership()
        try storylineTrashRestoreAndChapterTrash()
        return [
            "AppKit first storyline created in the panel becomes every chapter's 主线 with its colour in the outline, and a second storyline, suffixed renames, recolour, summary and drag or menu reorders follow in the panel, pages and tabs",
            "AppKit chapter 故事线 sheet from the outline adds and removes storylines and moves 主线, reflected in outline dots and storyline page chapter lists in book order, and survives cold reopen",
            "AppKit storyline trash after confirmation clears chapters whose 主线 it was and removes it elsewhere, restore keeps chapters unlinked, chapter trash and restore keep storylines, a stale sheet is refused, and page facts and body survive cold reopen",
        ]
    }

    private static func storylinePanelCreateRenameReorder() throws {
        let harness = try StorylineHarness(titles: ["启程", "航行", "归岸"])
        defer { harness.remove() }
        let (model, controller, host, chapters) = (harness.model, harness.controller, harness.host, harness.chapters)
        try require(model.rows == [.empty] && model.library.memberships.map(\.chapterId) == chapters.map(\.id)
            && model.library.memberships.allSatisfy { $0.storylineIds.isEmpty && $0.primary == nil },
            "A new project listed storylines or chapter memberships out of book order")
        try require(chapters.allSatisfy { harness.chip($0)?.text == "未归属" && harness.chip($0)?.color == nil },
            "Outline rows did not read 未归属 before any storyline exists")

        // 新建故事线 through the panel: the first one is every chapter's 主线.
        harness.answer = { alert in
            (alert.accessoryView as? NSTextField)?.stringValue = "  Sea Chart "
            return .alertFirstButtonReturn
        }
        try require(controller.createButton.isEnabled, "新建故事线 was disabled for a loaded library")
        click(controller.createButton)
        try require(harness.lastAlert?.informativeText.contains("所有章节的主线") == true, "The first storyline's prompt did not explain the 主线 rule")
        try wait { model.library.storylines.count == 1 && !model.busy }
        let first = model.library.storylines[0]
        try require(first.name == "Sea Chart" && first.documentId == "storyline:\(first.id)" && first.summary.isEmpty && first.facts.isEmpty
            && first.color.range(of: "^#[0-9A-Fa-f]{6}$", options: .regularExpression) != nil,
            "The first storyline was not created with a trimmed name, colour and body document")
        try require(chapters.allSatisfy { harness.membership($0)?.ids == [first.id] && harness.membership($0)?.primary == first.id },
            "The first storyline did not become every chapter's 主线")
        try wait { chapters.allSatisfy { harness.chip($0)?.text == "Sea Chart" && harness.chip($0)?.color == first.color } }
        try require(model.rows == [.storyline(first, chapters: 3, primaries: 3)]
            && MacStorylineLibraryViewController.countText(chapters: 3, primaries: 3) == "3 章 · 均为主线",
            "The panel did not count the storyline's chapters")

        // The created storyline opened as a page listing its chapters in book order.
        try wait { harness.page(first) != nil && !host.isBusy }
        guard let firstPage = harness.page(first) else { throw LabError.message("Creating a storyline did not open its page") }
        try elementSettled(host, firstPage.documentView)
        try wait { listed(firstPage) == ["启程*", "航行*", "归岸*"] }
        try require(host.activeStoryline?.id == first.id && host.activeChapter == nil && host.activeChapterView == nil
            && host.tabTitles(pane: 0) == ["Sea Chart"] && firstPage.text(of: .name) == "Sea Chart" && !host.canReopenActive,
            "The storyline page did not become an active page tab")

        // A second storyline with the default name leaves memberships alone.
        harness.answer = { _ in .alertFirstButtonReturn }
        click(controller.createButton)
        try wait { model.library.storylines.count == 2 && !model.busy }
        guard let second = model.library.storylines.first(where: { $0.id != first.id }) else { throw LabError.message("Second storyline missing") }
        try require(second.name == "New Storyline" && model.library.storylines.map(\.id) == [first.id, second.id],
            "The second storyline did not take the default name at the end")
        try require(chapters.allSatisfy { harness.membership($0)?.ids == [first.id] && harness.membership($0)?.primary == first.id },
            "A second storyline changed chapter memberships")
        try wait { harness.page(second) != nil && !host.isBusy }
        try require(host.tabTitles(pane: 0) == ["Sea Chart", "New Storyline"], "The second storyline page did not open beside the first")
        try wait { listed(harness.page(second)) == [] && harness.page(second)?.chaptersView.mutedLines.first?.contains("还没有章节") == true }

        // 重命名… keeps names unique case-insensitively with a suffix.
        harness.answer = { alert in
            (alert.accessoryView as? NSTextField)?.stringValue = "sea chart"
            return .alertFirstButtonReturn
        }
        try harness.rowItem(second, "rename-storyline").press()
        try wait { model.library.storyline(id: second.id)?.name == "sea chart 2" && !model.busy }
        try wait { host.tabTitles(pane: 0) == ["Sea Chart", "sea chart 2"] && harness.page(second)?.text(of: .name) == "sea chart 2" }

        // A page rename takes the same authority and shows the stored form.
        guard let secondPage = harness.page(second) else { throw LabError.message("Second storyline page missing") }
        try editHeader(harness.window, secondPage.nameField, "  SEA CHART ")
        try storylinePageSettled(secondPage) { secondPage.storyline.name == "SEA CHART 2" }
        try require(secondPage.text(of: .name) == "SEA CHART 2" && secondPage.errorMessage == nil
            && host.tabTitles(pane: 0) == ["Sea Chart", "SEA CHART 2"] && model.library.storyline(id: second.id)?.name == "SEA CHART 2",
            "The page rename did not store the unique suffixed name everywhere")
        try editHeader(harness.window, secondPage.nameField, "   ")
        try storylinePageSettled(secondPage) { secondPage.errorMessage != nil && secondPage.text(of: .name) == "SEA CHART 2" }
        try editHeader(harness.window, secondPage.nameField, "Harbour Night", returnKey: true)
        try storylinePageSettled(secondPage) { secondPage.storyline.name == "Harbour Night" }
        try require(secondPage.errorMessage == nil, "A valid rename kept the earlier refusal")

        // Drag and 上移/下移 reorder through moveStoryline.
        try require(controller.drop(storylineID: second.id, above: 0), "Dragging the second storyline to the top was refused")
        try wait { model.library.storylines.map(\.id) == [second.id, first.id] && !model.busy }
        try require(controller.rows.compactMap(\.storyline).map(\.id) == [second.id, first.id]
            && !controller.drop(storylineID: first.id, above: 2) && !controller.drop(storylineID: second.id, above: 1),
            "A drop in place was not refused or the panel order differs")
        let up = try harness.rowItem(second, "move-storyline-up"), down = try harness.rowItem(second, "move-storyline-down")
        try require(!up.isEnabled && down.isEnabled, "上移/下移 availability did not follow the position")
        down.press()
        try wait { model.library.storylines.map(\.id) == [first.id, second.id] && !model.busy }
        try harness.rowItem(second, "move-storyline-up").press()
        try wait { model.library.storylines.map(\.id) == [second.id, first.id] && !model.busy }
        try require(chapters.allSatisfy { harness.membership($0)?.primary == first.id }, "Reordering changed chapter 主线")

        // 更改颜色 and 编辑简介… from the panel reach the page and the outline.
        try harness.paletteItem(first, "#30A46C").press()
        try wait { model.library.storyline(id: first.id)?.color == "#30A46C" && !model.busy }
        try wait { chapters.allSatisfy { harness.chip($0)?.color == "#30A46C" } && firstPage.text(of: .color) == "#30A46C" }
        try require(try harness.paletteItem(first, "#30A46C").state == .on, "The palette did not mark the stored colour")
        harness.answer = { alert in
            ((alert.accessoryView as? NSScrollView)?.documentView as? NSTextView)?.string = "寻找旧海图。\n跨越三季。"
            return .alertFirstButtonReturn
        }
        try harness.rowItem(first, "edit-storyline-summary").press()
        try wait { model.library.storyline(id: first.id)?.summary == "寻找旧海图。\n跨越三季。" && !model.busy }
        try wait { firstPage.text(of: .summary) == "寻找旧海图。\n跨越三季。" }
        // The page's colour choice writes the same field.
        guard let blue = firstPage.colorPopup.itemArray.firstIndex(where: { $0.representedObject as? String == "#0090FF" }) else {
            throw LabError.message("Page colour popup lacks the palette")
        }
        firstPage.colorPopup.selectItem(at: blue)
        firstPage.colorPopup.sendAction(firstPage.colorPopup.action, to: firstPage.colorPopup.target)
        try storylinePageSettled(firstPage) { firstPage.storyline.color == "#0090FF" }
        try wait { model.library.storyline(id: first.id)?.color == "#0090FF" && harness.chip(chapters[1])?.color == "#0090FF" }

        try harness.close()
        let cold = LabWorkspaceCore(directory: harness.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let library: WorkspaceStorylineLibrary = try elementResult { cold.storylineLibrary(projectID: harness.project.id, completion: $0) }
        try require(library.storylines.map(\.name) == ["Harbour Night", "Sea Chart"] && library.storylines[1].color == "#0090FF"
            && library.storylines[1].summary == "寻找旧海图。\n跨越三季。" && library.trashedStorylines.isEmpty
            && library.memberships.allSatisfy { $0.primary == first.id && $0.storylineIds == [first.id] },
            "Storyline names, order, colour, summary or memberships did not survive cold reopen")
        let coldClosed: Bool = try elementResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }

    private static func chapterStorylinesSheetMembership() throws {
        let harness = try StorylineHarness(titles: ["启程", "航行", "归岸"])
        defer { harness.remove() }
        let (model, host, chapters) = (harness.model, harness.host, harness.chapters)
        let a: WorkspaceStoryline = try elementResult { model.create(name: "寻父", completion: $0) }
        let b: WorkspaceStoryline = try elementResult { model.create(name: "航海", completion: $0) }
        try require(chapters.allSatisfy { harness.membership($0)?.primary == a.id }, "Fixture did not assign the first storyline")

        // Pages of both storylines stay open (one hidden) while the sheet edits.
        let aBody: NativeDocumentView = try elementResult { host.open(project: harness.project, storyline: a, completion: $0) }
        try elementSettled(host, aBody)
        let bBody: NativeDocumentView = try elementResult { host.open(project: harness.project, storyline: b, completion: $0) }
        try elementSettled(host, bBody)
        let aPage = harness.page(a), bPage = harness.page(b)
        try wait { listed(aPage) == ["启程*", "航行*", "归岸*"] && listed(bPage) == [] }

        // 航行: add 航海, move 主线 to it, then drop 寻父.
        var sheet = try harness.openSheet(chapters[1])
        guard let aRow = sheet.row(for: a.id), let bRow = sheet.row(for: b.id) else { throw LabError.message("Sheet lacks a storyline row") }
        try require(sheet.rows.map(\.storyline.id) == [a.id, b.id] && aRow.checkbox.state == .on && aRow.primaryButton.state == .on
            && bRow.checkbox.state == .off && !bRow.primaryButton.isEnabled && sheet.saveButton.isEnabled,
            "The sheet did not show the chapter's storylines and 主线")
        setChecked(bRow.checkbox, true)
        try require(sheet.selection.checked == [a.id, b.id] && sheet.selection.primary == a.id && bRow.primaryButton.isEnabled,
            "Checking a second storyline moved 主线 or left its choice disabled")
        setChecked(bRow.primaryButton, true)
        try require(sheet.selection.primary == b.id && aRow.primaryButton.state == .off && bRow.primaryButton.state == .on,
            "The 主线 choice did not move")
        setChecked(aRow.checkbox, false)
        try require(sheet.selection.checked == [b.id] && sheet.selection.primary == b.id && !aRow.primaryButton.isEnabled,
            "Unchecking a storyline did not keep the chosen 主线")
        click(sheet.saveButton)
        try wait { harness.sheetSaved == true && !model.busy }
        try require(harness.membership(chapters[1])?.ids == [b.id] && harness.membership(chapters[1])?.primary == b.id,
            "The sheet did not replace the chapter's storylines")
        try wait { harness.chip(chapters[1])?.text == "航海" && harness.chip(chapters[1])?.color == b.color
            && harness.chip(chapters[0])?.text == "寻父" && harness.chip(chapters[2])?.text == "寻父" }
        try wait { listed(aPage) == ["启程*", "归岸*"] && listed(bPage) == ["航行*"] }

        // 归岸: unchecking the 主线 passes it to the remaining storyline.
        sheet = try harness.openSheet(chapters[2])
        setChecked(sheet.row(for: b.id)!.checkbox, true)
        setChecked(sheet.row(for: a.id)!.checkbox, false)
        try require(sheet.selection.checked == [b.id] && sheet.selection.primary == b.id, "主线 did not pass to the remaining storyline")
        setChecked(sheet.row(for: a.id)!.checkbox, true)
        try require(sheet.selection.checked == [a.id, b.id] && sheet.selection.primary == b.id, "Re-checking a storyline took 主线 back")
        click(sheet.saveButton)
        try wait { harness.sheetSaved == true && !model.busy }
        try require(harness.membership(chapters[2])?.ids == [a.id, b.id] && harness.membership(chapters[2])?.primary == b.id,
            "The chapter did not keep both storylines with the chosen 主线")
        try wait { listed(aPage) == ["启程*", "归岸"] && listed(bPage) == ["航行*", "归岸*"] && harness.chip(chapters[2])?.text == "航海" }

        // 启程: clearing every storyline reads 未归属; cancel writes nothing.
        let changeSets = try elementCount(harness.directory, "sync_change_set")
        sheet = try harness.openSheet(chapters[0])
        setChecked(sheet.row(for: a.id)!.checkbox, false)
        click(sheet.cancelButton)
        try require(harness.sheetSaved == false && harness.membership(chapters[0])?.primary == a.id
            && elementCount(harness.directory, "sync_change_set") == changeSets, "Cancelling the sheet wrote a change")
        sheet = try harness.openSheet(chapters[0])
        setChecked(sheet.row(for: a.id)!.checkbox, false)
        try require(sheet.selection.checked.isEmpty && sheet.selection.primary == nil, "Clearing the sheet kept a 主线")
        click(sheet.saveButton)
        try wait { harness.sheetSaved == true && !model.busy }
        try require(harness.membership(chapters[0])?.ids == [] && harness.membership(chapters[0])?.primary == nil,
            "Clearing the sheet did not leave the chapter 未归属")
        try wait { harness.chip(chapters[0])?.text == "未归属" && harness.chip(chapters[0])?.color == nil
            && listed(aPage) == ["归岸"] && listed(bPage) == ["航行*", "归岸*"] }
        try require(harness.model.rows.first == .storyline(model.library.storylines[0], chapters: 1, primaries: 0)
            && MacStorylineLibraryViewController.countText(chapters: 2, primaries: 2) == "2 章 · 均为主线",
            "Panel counts did not follow memberships")

        // A chapter row of a storyline page opens that chapter in its pane.
        guard let button = bPage?.chaptersView.chapterButtons.first else { throw LabError.message("Storyline page lists no chapter") }
        click(button)
        try wait { host.activeChapter?.id == chapters[1].id && !host.isBusy }
        try require(host.tabTitles(pane: 0) == ["寻父", "航海", "航行"], "The chapter did not open beside the storyline pages")

        let expected = model.library.memberships
        try harness.close()
        let cold = LabWorkspaceCore(directory: harness.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let coldModel = StorylineLibraryModel(workspace: cold, projectID: harness.project.id)
        let coldOutline = WorkspaceOutlineModel(workspace: cold, projectID: harness.project.id)
        let coldController = BookOutlineViewController(model: coldOutline)
        _ = coldController.view
        coldModel.onLibrary = { coldOutline.applyStorylines($0) }
        coldModel.load(); coldOutline.load()
        try wait { coldModel.loaded && coldOutline.entries.count == 3 && coldOutline.storylines != nil }
        try require(coldModel.library.memberships == expected, "Chapter memberships did not survive cold reopen")
        try require(coldController.storylineChip(chapterID: chapters[0].id)?.text == "未归属"
            && coldController.storylineChip(chapterID: chapters[1].id)?.colorHex == b.color
            && coldController.storylineChip(chapterID: chapters[2].id)?.text == "航海",
            "The cold outline did not show each chapter's 主线")
        let coldClosed: Bool = try elementResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }

    private static func storylineTrashRestoreAndChapterTrash() throws {
        let harness = try StorylineHarness(titles: ["启程", "航行", "归岸"])
        defer { harness.remove() }
        let (model, host, chapters, project) = (harness.model, harness.host, harness.chapters, harness.project)
        let a: WorkspaceStoryline = try elementResult { model.create(name: "寻父", completion: $0) }
        let b: WorkspaceStoryline = try elementResult { model.create(name: "航海", completion: $0) }
        let _: WorkspaceChapterStorylines = try elementResult {
            model.setChapterStorylines(chapterID: chapters[1].id, storylineIDs: [a.id, b.id], primary: b.id, completion: $0)
        }
        let _: WorkspaceChapterStorylines = try elementResult {
            model.setChapterStorylines(chapterID: chapters[2].id, storylineIDs: [a.id, b.id], primary: a.id, completion: $0)
        }

        // A chapter tab and the storyline's page, with body text and facts.
        let chapterView: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapters[0], completion: $0) }
        try elementSettled(host, chapterView)
        let chapterCore = host.activeCore!
        chapterView.textView.insertText("出港", replacementRange: NSRange(location: 0, length: 0))
        try elementSettled(host, chapterView)
        let body: NativeDocumentView = try elementResult { host.open(project: project, storyline: b, completion: $0) }
        try elementSettled(host, body)
        let bCore = host.activeCore!
        guard let page = harness.page(b) else { throw LabError.message("Storyline page was not retained") }
        try require(page.documentView === body && !body.allowsComments && bCore !== chapterCore,
            "The storyline page did not own its own body")
        body.textView.insertText("潮线🙂", replacementRange: NSRange(location: 0, length: 0))
        try elementSettled(host, body)
        body.undoProse(); try elementSettled(host, body)
        try require(body.textView.string.isEmpty && chapterView.textView.string == "出港", "Storyline undo crossed into chapter history")
        body.redoProse(); try elementSettled(host, body)
        let editor = page.factsEditor
        click(editor.addButton)
        try editHeader(harness.window, editor.rows[0].keyField, "主题")
        try editHeader(harness.window, editor.rows[0].valueField, " 归乡 ", returnKey: true)
        try storylinePageSettled(page) { page.storyline.facts == [WorkspaceFact(key: "主题", value: " 归乡 ")] }
        try require(model.library.storyline(id: b.id)?.facts == page.storyline.facts && page.errorMessage == nil,
            "Page facts were not stored exactly")

        // Trash explains the 主线 rule and closes only that page after commit.
        harness.answer = { _ in .alertSecondButtonReturn }
        try harness.rowItem(b, "trash-storyline").press()
        try require(harness.lastAlert?.informativeText.contains("1 个章节以它为主线") == true
            && harness.lastAlert?.informativeText.contains("1 个章节只会移除这条故事线") == true
            && harness.trashed == nil && harness.page(b) != nil, "Cancelling the trash did not keep everything or explain the rule")
        harness.answer = { _ in .alertFirstButtonReturn }
        try harness.rowItem(b, "trash-storyline").press()
        try wait { harness.trashed != nil && !host.isBusy }
        let reply = try harness.trashed!.get()
        try require(reply.result?.id == b.id && reply.library.trashedStorylines.map(\.id) == [b.id]
            && reply.library.storylines.map(\.id) == [a.id], "Storyline trash returned an incorrect library")
        try require(bCore.isClosed && harness.page(b) == nil && host.tabTitles(pane: 0) == ["启程"] && !chapterCore.isClosed
            && chapterView.textView.string == "出港", "Storyline trash closed the wrong tabs")
        try require(harness.membership(chapters[0])?.ids == [a.id] && harness.membership(chapters[0])?.primary == a.id
            && harness.membership(chapters[1])?.ids == [] && harness.membership(chapters[1])?.primary == nil
            && harness.membership(chapters[2])?.ids == [a.id] && harness.membership(chapters[2])?.primary == a.id,
            "Storyline trash did not apply the 主线 rule")
        try wait { harness.chip(chapters[1])?.text == "未归属" && harness.chip(chapters[2])?.text == "寻父" }
        try require(model.rows.contains(.trashHeader(count: 1)) && model.rows.contains { $0 == .trashed(reply.library.trashedStorylines[0]) },
            "The panel did not list the trashed storyline")

        // Restore brings the storyline back without linking chapters again.
        guard let restore = harness.controller.menuItems(for: .trashed(reply.library.trashedStorylines[0])).first as? LibraryMenuItem else {
            throw LabError.message("Trashed storyline lacks 恢复")
        }
        restore.press()
        try wait { model.library.trashedStorylines.isEmpty && model.library.storyline(id: b.id) != nil && !model.busy }
        try require(model.library.chapters(storylineID: b.id).isEmpty && harness.membership(chapters[1])?.ids == []
            && harness.membership(chapters[2])?.ids == [a.id] && harness.page(b) == nil, "Restore linked chapters again or opened a page")
        guard let restored = model.library.storyline(id: b.id) else { throw LabError.message("Restored storyline missing") }
        let fresh: NativeDocumentView = try elementResult { host.open(project: project, storyline: restored, completion: $0) }
        try elementSettled(host, fresh)
        guard let freshPage = harness.page(restored) else { throw LabError.message("Restored storyline page missing") }
        try require(fresh !== body && fresh.textView.string == "潮线🙂" && fresh.binding.state?.projection.canUndo == false
            && freshPage.factsEditor.facts == [WorkspaceFact(key: "主题", value: " 归乡 ")], "Restore lost the body or facts")
        try wait { listed(freshPage) == [] }

        // Chapter trash keeps its storylines; a stale sheet is refused.
        let _: WorkspaceChapterStorylines = try elementResult {
            model.setChapterStorylines(chapterID: chapters[2].id, storylineIDs: [a.id, b.id], primary: b.id, completion: $0)
        }
        try wait { listed(freshPage) == ["归岸*"] && harness.chip(chapters[2])?.text == "航海" }
        let sheet = try harness.openSheet(chapters[2])
        setChecked(sheet.row(for: a.id)!.checkbox, false)
        var chapterTrash: Result<WorkspaceChapterTrashReply, Error>?
        host.trash(projectID: project.id, chapterID: chapters[2].id) { result in
            if case .success(let reply) = result { host.applyChapters(projectID: project.id, chapters: reply.chapters, trashed: reply.trashedChapters) }
            chapterTrash = result
        }
        try wait { chapterTrash != nil }
        _ = try chapterTrash!.get()
        try wait { model.library.membership(chapterID: chapters[2].id) == nil && listed(freshPage) == [] && !model.busy }
        let changeSets = try elementCount(harness.directory, "sync_change_set")
        click(sheet.saveButton)
        try wait { sheet.errorMessage != nil && !model.busy }
        try require(sheet.errorMessage == "这一章已不可用，请刷新章节列表。" && harness.sheetSaved == nil && harness.sheet === sheet
            && sheet.selection.checked == [b.id] && elementCount(harness.directory, "sync_change_set") == changeSets,
            "A stale sheet save was not refused with its choice kept: \(sheet.errorMessage ?? "none")")
        click(sheet.cancelButton)
        var chapterRestore: Result<WorkspaceChapterTrashReply, Error>?
        harness.workspace.restoreChapter(projectID: project.id, chapterID: chapters[2].id) { result in
            if case .success(let reply) = result { host.applyChapters(projectID: project.id, chapters: reply.chapters, trashed: reply.trashedChapters) }
            chapterRestore = result
        }
        try wait { chapterRestore != nil }
        _ = try chapterRestore!.get()
        try wait { harness.membership(chapters[2])?.ids == [a.id, b.id] && harness.membership(chapters[2])?.primary == b.id && !model.busy }
        try require(model.library.memberships.map(\.chapterId) == chapters.map(\.id), "Restored chapter memberships left book order")
        harness.outline.load()
        try wait { harness.chip(chapters[2])?.text == "航海" && listed(freshPage) == ["归岸*"] }

        // Body edits and facts persist through cold reopen.
        fresh.textView.insertText("续", replacementRange: NSRange(location: 4, length: 0))
        try elementSettled(host, fresh)
        try harness.close()
        let cold = LabWorkspaceCore(directory: harness.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let library: WorkspaceStorylineLibrary = try elementResult { cold.storylineLibrary(projectID: project.id, completion: $0) }
        try require(library.storyline(id: b.id)?.facts == [WorkspaceFact(key: "主题", value: " 归乡 ")]
            && library.membership(chapterID: chapters[1].id)?.storylineIds == []
            && library.membership(chapterID: chapters[2].id)?.primary == b.id, "Storyline facts or memberships did not survive cold reopen")
        let coldBody: LabCore = try elementResult { cold.openStoryline(projectID: project.id, storylineID: b.id, completion: $0) }
        try require(try read(coldBody).projection.text == "潮线🙂续", "Storyline body did not survive trash, restore and cold reopen")
        let coldChapter: LabCore = try elementResult { cold.openChapter(projectID: project.id, chapterID: chapters[0].id, completion: $0) }
        try require(try read(coldChapter).projection.text == "出港", "Chapter body changed across storyline commands")
        let coldClosed: Bool = try elementResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }

}
