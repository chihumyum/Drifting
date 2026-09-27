import AppKit

/// 设定补丁 through the real element page, patch coordinator, tab host,
/// picker sheet, Rust workspace and SQLite, wired as the window wires them.
/// Typing, selections, menus and drags are programmatic; every name and line
/// of prose is synthetic.
extension BindingAcceptance {
    static func patchAcceptance() throws -> [String] {
        let saved = (PatchCoordinator.recheckDelay, MacChapterWorkspace.backlinkDelay)
        defer { (PatchCoordinator.recheckDelay, MacChapterWorkspace.backlinkDelay) = saved }
        PatchCoordinator.recheckDelay = 0.05
        MacChapterWorkspace.backlinkDelay = 0.05
        try patchesOnThePage()
        try patchesFromASelection()
        try patchValidityFollowsTheChapter()
        return [
            "AppKit element page 补丁 creates floating patches through 新建补丁…, edits titles and bodies in place and through 编辑… with one field.set each, writes nothing for unchanged edits, refuses clearing both title and body in Chinese keeping the typed text, reorders by dragging the handle and through 上移/下移 with order originals, deletes only after confirmation, follows in a second pane and survives a cold relaunch",
            "AppKit 新建补丁… on a chapter selection opens the picker with the selected text, finds elements by name and alias, creates an element by name in the chosen category that reaches the 设定库, and creates one patch recording the chapter, the block, its text and the selected text, listed on the element page with its source; a drift selection anchors to the drift, an empty patch is refused and 取消 writes nothing",
            "AppKit patch validity follows the chapter: deleting the anchored text marks the patch 已失效 on the open element page after the save, undo clears it, each transition is one field.set, the source link opens the chapter and selects the anchored text while it is there and only opens it once it is gone, and the state survives a cold relaunch",
        ]
    }

    // MARK: Harness

    private final class PatchHarness {
        let directory: URL
        private(set) var workspace: LabWorkspaceCore
        let project: WorkspaceProject
        let journal: JournalProbe
        private(set) var window: NSWindow
        private(set) var host: MacChapterWorkspace
        let people: WorkspaceElementCategory
        let places: WorkspaceElementCategory
        let lan: WorkspaceElement
        let tower: WorkspaceElement
        let chapter: WorkspaceChapter
        /// Answers the coordinator's prompts; nil cancels.
        var answer: ((NSAlert) -> NSApplication.ModalResponse)?
        var alerts: [String] = []
        var sheets: [NSWindow] = []
        var libraries: [WorkspaceElementLibrary] = []

        init() throws {
            directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                .appendingPathComponent("apple-native-lab")
            journal = JournalProbe(directory: directory)
            let workspace = LabWorkspaceCore(directory: directory)
            self.workspace = workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(listed.isEmpty, "Patch fixture was not isolated")
            project = try BindingAcceptance.elementResult { workspace.createProject(name: "补丁合成项目", completion: $0) }
            let projectID = project.id
            let people: WorkspaceElementReply<WorkspaceElementCategory> = try BindingAcceptance.elementResult {
                workspace.createElementCategory(projectID: projectID, name: "人物", completion: $0)
            }
            let places: WorkspaceElementReply<WorkspaceElementCategory> = try BindingAcceptance.elementResult {
                workspace.createElementCategory(projectID: projectID, name: "地点", completion: $0)
            }
            self.people = people.result!; self.places = places.result!
            let peopleID = self.people.id, placesID = self.places.id
            let lan: WorkspaceElementReply<WorkspaceElement> = try BindingAcceptance.elementResult {
                workspace.createElement(projectID: projectID, categoryID: peopleID, name: "林岚", completion: $0)
            }
            let aliased: WorkspaceElementReply<WorkspaceElement> = try BindingAcceptance.elementResult {
                workspace.updateElement(projectID: projectID, elementID: lan.result!.id,
                                        changes: WorkspaceElementChanges(aliases: ["阿岚"]), completion: $0)
            }
            self.lan = aliased.result!
            let tower: WorkspaceElementReply<WorkspaceElement> = try BindingAcceptance.elementResult {
                workspace.createElement(projectID: projectID, categoryID: placesID, name: "北塔", completion: $0)
            }
            self.tower = tower.result!
            chapter = try BindingAcceptance.elementResult { workspace.createChapter(projectID: projectID, title: "雨夜", completion: $0) }
            (window, host) = BindingAcceptance.elementHost(workspace)
            wire()
        }

        private func wire() {
            host.patches.presentAlert = { [weak self] alert, done in
                alert.layout()
                self?.alerts.append(alert.messageText)
                done(self?.answer?(alert) ?? .alertSecondButtonReturn)
            }
            host.patches.presentSheet = { [weak self] sheet, _ in self?.sheets.append(sheet) }
            host.onElementLibrary = { [weak self] _, library in self?.libraries.append(library) }
        }

        func openChapter(_ chapter: WorkspaceChapter? = nil, pane: Int? = nil) throws -> NativeDocumentView {
            let target = chapter ?? self.chapter
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let view: NativeDocumentView = try BindingAcceptance.elementResult { host.open(project: project, chapter: target, in: pane, completion: $0) }
            try BindingAcceptance.elementSettled(host, view)
            // The picker lists the library the tab host has read.
            let projectID = project.id
            try BindingAcceptance.wait { self.host.linkDirectory(projectID: projectID) != nil }
            return view
        }

        func openElement(_ element: WorkspaceElement, pane: Int? = nil) throws -> MacElementPageView {
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let view: NativeDocumentView = try BindingAcceptance.elementResult { host.open(project: project, element: element, in: pane, completion: $0) }
            try BindingAcceptance.elementSettled(host, view)
            guard let page = host.retainedElementPage(pane: pane ?? host.activePane, scope: ElementScope(projectID: project.id, elementID: element.id)) else {
                throw LabError.message("No page for \(element.name)")
            }
            try BindingAcceptance.wait { page.patchesView.patches != nil }
            return page
        }

        func split(_ element: WorkspaceElement) throws -> MacElementPageView {
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let view: NativeDocumentView = try BindingAcceptance.elementResult { host.split(completion: $0) }
            try BindingAcceptance.elementSettled(host, view)
            guard let page = host.retainedElementPage(pane: 1, scope: ElementScope(projectID: project.id, elementID: element.id)) else {
                throw LabError.message("No second page for \(element.name)")
            }
            try BindingAcceptance.wait { page.patchesView.patches != nil }
            return page
        }

        /// Adds the second pane with the active tab, as 在另一栏打开 does.
        func splitPane() throws {
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let view: NativeDocumentView = try BindingAcceptance.elementResult { host.split(completion: $0) }
            try BindingAcceptance.elementSettled(host, view)
        }

        func expect(journal expected: [[String]], since: Int64, _ step: String) throws {
            try journal.expect(expected, since: since, step)
        }

        func stored(_ element: WorkspaceElement) throws -> [WorkspacePatch] {
            let workspace = self.workspace, projectID = project.id
            return try BindingAcceptance.elementResult { workspace.elementPatches(projectID: projectID, elementID: element.id, completion: $0) }
        }

        func nodePatches(_ nodeID: String) throws -> [WorkspacePatch] {
            let workspace = self.workspace, projectID = project.id
            return try BindingAcceptance.elementResult { workspace.nodePatches(projectID: projectID, nodeID: nodeID, completion: $0) }
        }

        /// The chapter's prose context menu at a character.
        func contextMenu(_ view: NativeDocumentView, at index: Int) throws -> NSMenu {
            guard let window = view.window, let event = NSEvent.mouseEvent(with: .rightMouseDown, location: .zero, modifierFlags: [],
                timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1),
                  let menu = view.textView(view.textView, menu: NSMenu(), for: event, at: index) else {
                throw LabError.message("Prose context menu was not built")
            }
            return menu
        }

        /// Selects `text` in the view and chooses 新建补丁… from its context menu.
        func beginPatch(_ view: NativeDocumentView, selecting text: String) throws -> MacPatchCreateSheet {
            let range = (view.textView.string as NSString).range(of: text)
            try BindingAcceptance.require(range.location != NSNotFound, "The prose lacks \(text)")
            view.textView.setSelectedRange(range)
            let menu = try contextMenu(view, at: range.location)
            guard let item = menu.items.first(where: { $0.accessibilityIdentifier() == "context-create-patch" }), let action = item.action else {
                throw LabError.message("The context menu lacks 新建补丁…")
            }
            try BindingAcceptance.require(item.title == "新建补丁…", "The patch item is misnamed")
            NSApp.sendAction(action, to: item.target, from: item)
            guard let sheet = host.patches.createSheet else { throw LabError.message("新建补丁… opened no sheet") }
            return sheet
        }

        func settleSheet(_ sheet: MacPatchCreateSheet) throws {
            try BindingAcceptance.wait { !sheet.isSaving }
        }

        func coldReopen() throws {
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "Patch workspace failed to close")
            window.close()
            let reopened = LabWorkspaceCore(directory: directory)
            workspace = reopened
            let projects: [WorkspaceProject] = try BindingAcceptance.elementResult { reopened.projects(completion: $0) }
            try BindingAcceptance.require(projects.map(\.id) == [project.id], "Cold reopen lost the project")
            (window, host) = BindingAcceptance.elementHost(reopened)
            wire()
        }

        func close() throws {
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "Patch workspace failed to close")
            window.close()
        }

        func remove() { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
    }

    private static func patchPress(_ button: NSButton) { button.sendAction(button.action, to: button.target) }

    /// Answers the 新建补丁/编辑补丁 prompt with a title and a body.
    private static func patchPrompt(title: String, body: String) -> (NSAlert) -> NSApplication.ModalResponse {
        { alert in
            guard let fields = alert.accessoryView as? PatchEditorFields else { return .alertSecondButtonReturn }
            fields.titleField.stringValue = title
            fields.bodyView.string = body
            return .alertFirstButtonReturn
        }
    }

    private static func patchMenu(_ section: ElementPatchesView, _ patchID: String, _ identifier: String) throws {
        guard let item = section.menuItems(patchID: patchID).first(where: { $0.accessibilityIdentifier() == identifier }) as? LibraryMenuItem else {
            throw LabError.message("The patch menu lacks \(identifier)")
        }
        try require(item.isEnabled, "\(identifier) is disabled")
        item.press()
    }

    private static func titles(_ section: ElementPatchesView) -> [String] { section.rows.map { $0.patch.title ?? "" } }

    /// Types into a row's body box, then moves the keyboard away.
    private static func editPatchBody(_ window: NSWindow, _ row: PatchRowView, _ text: String) throws {
        try require(window.makeFirstResponder(row.bodyView), "The patch body refused keyboard focus")
        row.bodyView.selectAll(nil)
        row.bodyView.insertText(text, replacementRange: row.bodyView.selectedRange())
        try require(window.makeFirstResponder(nil), "The patch body did not end editing")
    }

    /// Drags a row's handle so the pointer lands on `point` (window coordinates).
    private static func dragPatch(_ row: PatchRowView, to point: NSPoint, window: NSWindow) {
        let start = row.handle.convert(NSPoint(x: row.handle.bounds.midX, y: row.handle.bounds.midY), to: nil)
        func event(_ type: NSEvent.EventType, _ location: NSPoint) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: location, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                               windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
                               pressure: type == .leftMouseUp ? 0 : 1)!
        }
        row.handle.mouseDown(with: event(.leftMouseDown, start))
        for step in 1...4 {
            let t = CGFloat(step) / 4
            row.handle.mouseDragged(with: event(.leftMouseDragged, NSPoint(x: start.x, y: start.y + (point.y - start.y) * t)))
        }
        row.handle.mouseUp(with: event(.leftMouseUp, point))
    }

    // MARK: (a) On the page

    private static func patchesOnThePage() throws {
        let harness = try PatchHarness()
        defer { harness.remove() }
        let page = try harness.openElement(harness.lan)
        let section = page.patchesView
        try require(section.rows.isEmpty && section.emptyLine == ElementPatchesView.emptyText, "A new element listed patches")

        // 新建补丁…: cancel writes nothing; confirm creates a floating patch.
        var mark = try harness.journal.mark()
        patchPress(section.addButton)
        try harness.expect(journal: [], since: mark, "A cancelled 新建补丁…")
        harness.answer = patchPrompt(title: " 旧伤 ", body: "左臂有一道疤。\n\n雨天会痛。")
        patchPress(section.addButton)
        try wait { section.rows.count == 1 }
        harness.answer = patchPrompt(title: "", body: "改名为岚。")
        patchPress(section.addButton)
        try wait { section.rows.count == 2 }
        harness.answer = patchPrompt(title: "升任船长", body: "")
        patchPress(section.addButton)
        try wait { section.rows.count == 3 }
        try harness.expect(journal: [["entity.create element-patch", "order.move element-patch"],
                                     ["entity.create element-patch", "order.move element-patch"],
                                     ["entity.create element-patch", "order.move element-patch"]], since: mark, "Three floating patches")
        try require(titles(section) == ["旧伤", "", "升任船长"], "Patches are not in creation order: \(titles(section))")
        let scar = section.rows[0].patch, rename = section.rows[1].patch, captain = section.rows[2].patch
        try require(scar.body == "左臂有一道疤。\n\n雨天会痛。" && scar.sourceNodeId == nil && !scar.isInvalid,
            "The floating patch differs: \(scar)")
        try require(section.rows[0].sourceButton.title == "无章节归属" && section.rows[0].quoteLabel.isHidden
            && section.rows[0].invalidBadge.isHidden && section.emptyLine == nil, "A floating row shows a source or a badge")
        // An empty patch is refused by Rust in Chinese and asks again with the text kept.
        mark = try harness.journal.mark()
        var asked = 0
        harness.answer = { alert in
            asked += 1
            guard asked == 1, let fields = alert.accessoryView as? PatchEditorFields else {
                if asked == 2 { harness.alerts.append("retry:" + alert.informativeText) }
                return .alertSecondButtonReturn
            }
            fields.titleField.stringValue = "  "; fields.bodyView.string = "\n"
            return .alertFirstButtonReturn
        }
        patchPress(section.addButton)
        try wait { asked == 2 }
        try require(section.errorMessage == "补丁的标题和内容不能都为空" && harness.alerts.last == "retry:补丁的标题和内容不能都为空",
            "The empty patch was not refused in Chinese: \(section.errorMessage ?? "none")")
        try harness.expect(journal: [], since: mark, "The refused empty patch")

        // Inline edits: one field.set each; unchanged text writes nothing.
        let window = harness.window
        mark = try harness.journal.mark()
        try editHeader(window, section.rows[1].titleField, "改名")
        try wait { section.rows[1].patch.title == "改名" && !section.rows[1].isCommitting }
        try editPatchBody(window, section.rows[1], "  改名为岚，\n旧名不再用。 ")
        try wait { section.rows[1].patch.body == "改名为岚， 旧名不再用。" && !section.rows[1].isCommitting }
        try require(section.rows[1].bodyView.string == "改名为岚， 旧名不再用。", "The body does not show its stored form")
        try editHeader(window, section.rows[1].titleField, "改名")
        try editPatchBody(window, section.rows[1], "改名为岚，\n旧名不再用。")
        try wait { !section.rows[1].isCommitting }
        try harness.expect(journal: [["field.set element-patch"], ["field.set element-patch"]], since: mark, "Two inline edits")
        // Clearing the only title of a body-less patch is refused; the typed text stays.
        mark = try harness.journal.mark()
        try editHeader(window, section.rows[2].titleField, "")
        try wait { section.errorMessage != nil && !section.rows[2].isCommitting }
        try require(section.errorMessage == "补丁的标题和内容不能都为空" && section.rows[2].typedTitle == ""
            && section.rows[2].patch.title == "升任船长", "Clearing both was not refused keeping the typed text")
        try harness.expect(journal: [], since: mark, "The refused inline edit")
        try editHeader(window, section.rows[2].titleField, "升任船长")
        try wait { !section.rows[2].isCommitting }
        // 编辑… changes both fields in one prompt; the title clears with null.
        mark = try harness.journal.mark()
        harness.answer = patchPrompt(title: "", body: "从此是船长。")
        try patchMenu(section, captain.id, "element-patch-edit")
        try wait { section.rows[2].patch.title == nil && section.rows[2].patch.body == "从此是船长。" }
        try harness.expect(journal: [["field.set element-patch", "field.set element-patch"]], since: mark, "编辑…")
        try require(section.rows[2].titleField.stringValue == "" && section.rows[2].bodyView.string == "从此是船长。",
            "The row did not follow 编辑…")

        // A second view of the element follows every reply.
        let twin = try harness.split(harness.lan)
        try require(titles(twin.patchesView) == ["旧伤", "改名", ""], "The second page lists \(titles(twin.patchesView))")
        // Reorder by dragging the handle: 升任船长 (last) before 旧伤.
        mark = try harness.journal.mark()
        let first = section.rows[0]
        let top = first.convert(NSPoint(x: first.bounds.midX, y: 2), to: nil)
        dragPatch(section.rows[2], to: top, window: window)
        try wait { section.rows.map(\.patch.id) == [captain.id, scar.id, rename.id] }
        try require(twin.patchesView.rows.map(\.patch.id) == [captain.id, scar.id, rename.id], "The second page did not follow the drag")
        // A drag back onto its own place writes nothing.
        let own = section.rows[0].convert(NSPoint(x: 10, y: section.rows[0].bounds.midY), to: nil)
        dragPatch(section.rows[0], to: own, window: window)
        // 上移 and 下移.
        try patchMenu(section, rename.id, "element-patch-up")
        try wait { section.rows.map(\.patch.id) == [captain.id, rename.id, scar.id] }
        try patchMenu(section, captain.id, "element-patch-down")
        try wait { section.rows.map(\.patch.id) == [rename.id, captain.id, scar.id] }
        let moves = try harness.journal.originals(since: mark)
        try require(moves.count == 3 && moves.allSatisfy { !$0.isEmpty && $0.allSatisfy { $0.hasSuffix(" element-patch") && $0.hasPrefix("order.") } },
            "Moves wrote \(moves)")
        try require(section.menuItems(patchID: rename.id).first { $0.accessibilityIdentifier() == "element-patch-up" }?.isEnabled == false,
            "上移 is enabled on the first patch")
        try require(try harness.stored(harness.lan).map(\.id) == [rename.id, captain.id, scar.id], "The stored order differs")

        // Delete: cancel keeps it; confirm removes it from both pages.
        mark = try harness.journal.mark()
        harness.answer = nil
        try patchMenu(section, captain.id, "element-patch-delete")
        try require(section.rows.count == 3 && harness.alerts.last == "删除这条补丁？",
            "The deletion was not confirmed first: \(harness.alerts.last ?? "")")
        try harness.expect(journal: [], since: mark, "A cancelled deletion")
        harness.answer = { _ in .alertFirstButtonReturn }
        try patchMenu(section, captain.id, "element-patch-delete")
        try wait { section.rows.count == 2 && twin.patchesView.rows.count == 2 }
        try harness.expect(journal: [["entity.trash element-patch"]], since: mark, "The deletion")

        // Cold relaunch: the order, titles and bodies come back.
        try harness.coldReopen()
        let reopened = try harness.openElement(harness.lan)
        try require(reopened.patchesView.rows.map(\.patch.id) == [rename.id, scar.id]
            && titles(reopened.patchesView) == ["改名", "旧伤"]
            && reopened.patchesView.rows[1].bodyView.string == "左臂有一道疤。\n\n雨天会痛。", "Patches differ after a cold relaunch")
        try harness.close()
    }

    // MARK: (b) From a selection

    private static func patchesFromASelection() throws {
        let harness = try PatchHarness()
        defer { harness.remove() }
        let view = try harness.openChapter()
        view.textView.insertText("林岚在雨夜登上白塔。\n她看见北塔的灯。", replacementRange: NSRange(location: 0, length: 0))
        try elementSettled(harness.host, view)
        guard let projection = view.binding.store.projection, projection.blocks.count == 2 else {
            throw LabError.message("The chapter does not have two paragraphs")
        }
        // No item without a selection.
        view.textView.setSelectedRange(NSRange(location: 2, length: 0))
        try require(!(try harness.contextMenu(view, at: 2)).items.contains { $0.accessibilityIdentifier() == "context-create-patch" },
            "新建补丁… is offered without a selection")

        // Cancel writes nothing.
        var mark = try harness.journal.mark()
        let cancelled = try harness.beginPatch(view, selecting: "登上白塔")
        cancelled.cancel()
        try require(harness.host.patches.createSheet == nil, "取消 left the sheet open")
        try harness.expect(journal: [], since: mark, "A cancelled sheet")

        // Search by name and alias, then create 白塔 in 地点.
        let sheet = try harness.beginPatch(view, selecting: "登上白塔")
        try require(sheet.quoteLabel.stringValue == "“登上白塔”" && !sheet.createButton.isEnabled, "The sheet does not quote the selection")
        sheet.search("阿岚")
        try require(sheet.candidates == [.element(harness.lan)], "An alias does not find its element: \(sheet.candidates)")
        sheet.search("塔")
        try require(sheet.candidates.first == .element(harness.tower) && sheet.candidates.last == .create("塔"),
            "Searching 塔 lists \(sheet.candidates)")
        sheet.search("白塔")
        try require(sheet.candidates == [.create("白塔")], "An unknown name does not offer creation")
        mark = try harness.journal.mark()
        sheet.chooseCategory(harness.places.id)
        sheet.createElement()
        try harness.settleSheet(sheet)
        guard let white = sheet.element, white.name == "白塔", white.categoryId == harness.places.id else {
            throw LabError.message("创建设定 did not choose the new element: \(String(describing: sheet.element)) \(sheet.errorMessage ?? "")")
        }
        try require(harness.libraries.last?.elements.contains { $0.id == white.id } == true
            && sheet.chosenLabel.stringValue == "设定：白塔" && sheet.createButton.isEnabled, "The new element did not reach the 设定库")
        try require(try harness.journal.originals(since: mark).count == 1, "Creating the element wrote more than one original")
        // An empty patch is refused in the sheet without writing.
        mark = try harness.journal.mark()
        sheet.submit()
        try require(sheet.errorMessage == "补丁的标题和内容不能都为空。" && harness.host.patches.createSheet === sheet,
            "An empty patch was not refused in the sheet")
        sheet.titleField.stringValue = "初次登塔"
        sheet.bodyView.string = "白塔第一次有人登上。"
        sheet.submit()
        try harness.settleSheet(sheet)
        try require(harness.host.patches.createSheet == nil && sheet.errorMessage == nil, "The sheet did not close: \(sheet.errorMessage ?? "")")
        // The new name also links 白塔 in the chapter (a prose original of its own).
        let written = try harness.journal.originals(since: mark).filter { $0.contains { $0.hasSuffix(" element-patch") } }
        try require(written == [["entity.create element-patch", "order.move element-patch"]], "The anchored patch wrote \(written)")
        guard let anchored = try harness.stored(white).first else { throw LabError.message("No patch on 白塔") }
        try require(anchored.sourceNodeId == harness.chapter.id && anchored.sourceBlockId == projection.blocks[0].id
            && anchored.sourceBlockText == "林岚在雨夜登上白塔。" && anchored.anchorText == "登上白塔"
            && anchored.title == "初次登塔" && anchored.body == "白塔第一次有人登上。" && anchored.sourceNodeTitle == "雨夜",
            "The anchored patch differs: \(anchored)")
        try require(try harness.nodePatches(harness.chapter.id).map(\.id) == [anchored.id], "The chapter does not list its patch")
        // The element page lists it with its source and quote.
        let page = try harness.openElement(white)
        guard let row = page.patchesView.rows.first else { throw LabError.message("白塔's page lists no patch") }
        try require(row.sourceButton.title == "来自“雨夜”" && row.sourceButton.isEnabled && row.quoteLabel.stringValue == "“登上白塔”"
            && row.invalidBadge.isHidden, "The row's source differs: \(row.sourceButton.title) \(row.quoteLabel.stringValue)")

        // An existing element from the second paragraph.
        _ = try harness.openChapter()
        let second = try harness.beginPatch(view, selecting: "北塔的灯")
        second.search("北塔")
        second.choose(elementID: harness.tower.id)
        second.bodyView.string = "北塔的灯重新亮了。"
        second.submit()
        try harness.settleSheet(second)
        guard let lamp = try harness.stored(harness.tower).first else { throw LabError.message("No patch on 北塔") }
        try require(lamp.title == nil && lamp.sourceBlockId == projection.blocks[1].id && lamp.anchorText == "北塔的灯",
            "The second patch differs: \(lamp)")

        // A drift selection anchors to the drift.
        let projectID = harness.project.id, workspace = harness.workspace
        let driftReply: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
            workspace.createDrift(projectID: projectID, title: "塔下札记", groupID: nil, completion: $0)
        }
        guard let drift = driftReply.result else { throw LabError.message("No drift") }
        try wait { harness.host.canNavigate && !harness.host.isBusy }
        let driftView: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, drift: drift, completion: $0) }
        try elementSettled(harness.host, driftView)
        driftView.textView.insertText("林岚把旧信烧了。", replacementRange: NSRange(location: 0, length: 0))
        try elementSettled(harness.host, driftView)
        let fromDrift = try harness.beginPatch(driftView, selecting: "旧信烧了")
        fromDrift.choose(elementID: harness.lan.id)
        fromDrift.titleField.stringValue = "烧信"
        fromDrift.submit()
        try harness.settleSheet(fromDrift)
        guard let burned = try harness.stored(harness.lan).first else { throw LabError.message("No drift patch") }
        try require(burned.sourceNodeId == drift.id && burned.sourceNodeTitle == "塔下札记" && burned.anchorText == "旧信烧了",
            "The drift patch differs: \(burned)")
        try require(try harness.nodePatches(drift.id).map(\.id) == [burned.id], "The drift does not list its patch")
        try harness.close()
    }

    // MARK: (c) Validity

    private static func patchValidityFollowsTheChapter() throws {
        let harness = try PatchHarness()
        defer { harness.remove() }
        let view = try harness.openChapter()
        view.textView.insertText("林岚失去了左臂。她在北塔。", replacementRange: NSRange(location: 0, length: 0))
        try elementSettled(harness.host, view)
        let sheet = try harness.beginPatch(view, selecting: "失去了左臂")
        sheet.choose(elementID: harness.lan.id)
        sheet.titleField.stringValue = "断臂"
        sheet.bodyView.string = "此后只剩右臂。"
        sheet.submit()
        try harness.settleSheet(sheet)
        // The element page beside the chapter.
        try harness.splitPane()
        let page = try harness.openElement(harness.lan, pane: 1)
        let section = page.patchesView
        guard let row = section.rows.first, row.patch.title == "断臂", row.invalidBadge.isHidden else {
            throw LabError.message("The page does not list the valid patch")
        }

        // The source link opens the chapter in that pane and selects the text.
        patchPress(row.sourceButton)
        try wait { harness.host.activePane == 1 && harness.host.activeChapter?.id == harness.chapter.id }
        guard let opened = harness.host.activeView else { throw LabError.message("The source link opened nothing") }
        try elementSettled(harness.host, opened)
        try wait { opened.textView.selectedRange() == NSRange(location: 2, length: 5) }
        let shared = opened

        // Deleting the anchored text marks the patch invalid after the save.
        var mark = try harness.journal.mark()
        view.textView.insertText("", replacementRange: NSRange(location: 2, length: 5))
        try elementSettled(harness.host, view)
        try wait { harness.host.canNavigate && !harness.host.isBusy }
        let _: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, element: harness.lan, in: 1, completion: $0) }
        try wait { section.rows.first?.patch.isInvalid == true }
        try require(!row.invalidBadge.isHidden && section.rows.count == 1, "The page does not show 已失效")
        let invalidated = try harness.journal.originals(since: mark).filter { $0.contains { $0.hasSuffix(" element-patch") } }
        try require(invalidated == [["field.set element-patch"]], "Invalidation wrote \(invalidated)")
        try require(try harness.nodePatches(harness.chapter.id).first?.invalidatedAt != nil, "Rust did not store the invalidation")
        // Once gone, the link opens the chapter without selecting anything.
        shared.textView.setSelectedRange(NSRange(location: 1, length: 0))
        patchPress(row.sourceButton)
        try wait { harness.host.activeChapter?.id == harness.chapter.id }
        try elementSettled(harness.host, shared)
        try require(shared.textView.selectedRange() == NSRange(location: 1, length: 0), "An invalid patch still selected text")

        // Undo brings the text back and the patch is valid again.
        try wait { harness.host.canNavigate && !harness.host.isBusy }
        let _: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, element: harness.lan, in: 1, completion: $0) }
        mark = try harness.journal.mark()
        view.undoProse()
        try elementSettled(harness.host, view)
        try require(view.textView.string == "林岚失去了左臂。她在北塔。", "Undo did not restore the text")
        try wait { section.rows.first?.patch.isInvalid == false }
        try require(row.invalidBadge.isHidden, "The badge stayed after undo")
        let revalidated = try harness.journal.originals(since: mark).filter { $0.contains { $0.hasSuffix(" element-patch") } }
        try require(revalidated == [["field.set element-patch"]], "Revalidation wrote \(revalidated)")

        // Invalid again, then a cold relaunch keeps the state.
        view.textView.insertText("", replacementRange: NSRange(location: 2, length: 5))
        try elementSettled(harness.host, view)
        try wait { section.rows.first?.patch.isInvalid == true }
        try harness.coldReopen()
        let reopened = try harness.openElement(harness.lan)
        try require(reopened.patchesView.rows.first?.patch.isInvalid == true
            && reopened.patchesView.rows.first?.invalidBadge.isHidden == false, "已失效 was lost after a cold relaunch")
        try harness.close()
    }
}
