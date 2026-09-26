import AppKit

/// Drifts, drift groups, drift pages and act notes through the real AppKit
/// panel, pages and outline over the Rust workspace. The wiring mirrors
/// AppDelegate; input is programmatic and the ⌘-click is a synthetic event
/// delivered to the text view, not desktop input.
extension BindingAcceptance {
    /// One project with chapters, the tab host in a sized window, the 漂流
    /// panel and the outline, connected as AppDelegate connects them.
    private final class DriftHarness {
        let directory: URL
        let workspace: LabWorkspaceCore
        let project: WorkspaceProject
        let chapters: [WorkspaceChapter]
        let window: NSWindow
        let host: MacChapterWorkspace
        let model: DriftLibraryModel
        let controller: MacDriftLibraryViewController
        let outline: WorkspaceOutlineModel
        let outlineController: BookOutlineViewController
        /// Answers the next alerts of the panel and the outline; nil cancels.
        var answer: ((NSAlert) -> NSApplication.ModalResponse)?
        private(set) var alerts: [NSAlert] = []
        var trashed: Result<WorkspaceDriftReply<WorkspaceDrift>, Error>?
        var bound: Result<WorkspaceAct, Error>?

        init(titles: [String]) throws {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                .appendingPathComponent("apple-native-lab")
            let workspace = LabWorkspaceCore(directory: directory)
            self.directory = directory
            self.workspace = workspace
            let initial: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(initial.isEmpty, "Drift fixture was not isolated")
            let project: WorkspaceProject = try BindingAcceptance.elementResult { workspace.createProject(name: "漂流合成项目", completion: $0) }
            self.project = project
            chapters = try titles.map { title in
                try BindingAcceptance.elementResult { workspace.createChapter(projectID: project.id, title: title, completion: $0) }
            }
            (window, host) = BindingAcceptance.elementHost(workspace)
            model = DriftLibraryModel(workspace: workspace, projectID: project.id)
            controller = MacDriftLibraryViewController(model: model)
            outline = WorkspaceOutlineModel(workspace: workspace, projectID: project.id)
            outlineController = BookOutlineViewController(model: outline)
            _ = controller.view
            _ = outlineController.view
            let (host, model, outline) = (self.host, self.model, self.outline)
            model.onLibrary = { library in
                host.applyDriftLibrary(projectID: project.id, library: library)
                outline.applyDrifts(library)
            }
            host.onDriftLibrary = { projectID, library in
                guard projectID == project.id else { return }
                model.apply(library, message: nil)
                outline.applyDrifts(library)
            }
            host.onOutline = { projectID, entries in if projectID == project.id { model.applyActs(entries) } }
            outline.onEntries = { entries in
                host.applyOutline(projectID: project.id, entries: entries)
                host.driftsChanged(projectID: project.id)
            }
            controller.canNavigate = { host.canNavigate }
            controller.onOpen = { drift in host.open(project: project, drift: drift) { _ in } }
            controller.onCreated = { drift in
                host.open(project: project, drift: drift) { result in
                    if case .success = result { host.focusActiveDriftTitle() }
                }
            }
            controller.onTrash = { [weak self] drift in
                host.trashDrift(projectID: project.id, driftID: drift.id) { result in
                    if case .success(let reply) = result { model.apply(reply.library, message: nil) }
                    self?.trashed = result
                }
            }
            let present: (NSAlert, @escaping (NSApplication.ModalResponse) -> Void) -> Void = { [weak self] alert, done in
                self?.alerts.append(alert)
                done(self?.answer?(alert) ?? .alertSecondButtonReturn)
            }
            controller.presentAlert = present
            outlineController.presentAlert = present
            outlineController.canNavigate = { host.canNavigate }
            outlineController.onBindDrift = { [weak self] entry, drift in
                model.bindAct(actID: entry.id, driftID: drift?.id) { result in
                    switch result {
                    case .success:
                        outline.showStatus(drift.map { "“\($0.title)”已绑定为“\(entry.title)”的幕笔记。" }
                            ?? "已解除“\(entry.title)”的幕笔记，漂流本身保留。")
                    case .failure(let error): outline.showStatus(error.localizedDescription)
                    }
                    self?.bound = result
                }
            }
            outlineController.onOpenDrift = { drift in host.open(project: project, drift: drift) { _ in } }
            model.load()
            host.actsChanged(projectID: project.id)
            try BindingAcceptance.wait { model.loaded && !model.busy }
            outline.load()
            try BindingAcceptance.wait { outline.entries.count == titles.count && outline.drifts != nil }
        }

        var lastAlert: NSAlert? { alerts.last }

        func close() throws {
            try BindingAcceptance.wait { self.host.canNavigate && !self.model.busy && !self.outline.busy }
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "Drift workspace failed to close")
            window.close()
        }

        func remove() { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }

        func page(_ drift: WorkspaceDrift, pane: Int = 0) -> MacDriftPageView? {
            host.retainedDriftPage(pane: pane, scope: DriftScope(projectID: project.id, driftID: drift.id))
        }

        func driftRow(_ id: String) throws -> DriftLibraryModel.Row {
            guard let row = controller.rows.first(where: { if case .drift(let drift, _) = $0 { return drift.id == id }; return false }) else {
                throw LabError.message("The panel lists no drift row \(id)")
            }
            return row
        }

        func groupRow(_ id: String) throws -> DriftLibraryModel.Row {
            guard let row = controller.rows.first(where: { $0.group?.id == id }) else { throw LabError.message("The panel lists no group row \(id)") }
            return row
        }

        func item(_ row: DriftLibraryModel.Row, _ identifier: String) throws -> LibraryMenuItem {
            guard let item = controller.menuItems(for: row).first(where: { $0.accessibilityIdentifier() == identifier }) as? LibraryMenuItem else {
                throw LabError.message("Panel row \(row.identifier) lacks \(identifier)")
            }
            return item
        }

        /// One item of an act row's outline 操作 menu.
        func actItem(_ actID: String, _ identifier: String) throws -> NSMenuItem {
            guard let item = outlineController.actionItems(entryID: actID).first(where: { $0.accessibilityIdentifier() == identifier }) else {
                throw LabError.message("Outline act row lacks \(identifier)")
            }
            return item
        }

        func send(_ item: NSMenuItem) throws {
            guard let action = item.action else { throw LabError.message("Menu item \(item.title) has no action") }
            NSApp.sendAction(action, to: item.target, from: item)
        }
    }

    private static func driftClick(_ button: NSButton) { button.sendAction(button.action, to: button.target) }

    /// Types into the prompt's field and confirms.
    private static func driftText(_ text: String) -> (NSAlert) -> NSApplication.ModalResponse {
        { alert in
            (alert.accessoryView as? NSTextField)?.stringValue = text
            return .alertFirstButtonReturn
        }
    }

    /// Chooses the picker entry with this identity and confirms.
    private static func driftChoice(_ id: String) -> (NSAlert) -> NSApplication.ModalResponse {
        { alert in
            guard let popup = alert.accessoryView as? NSPopUpButton,
                  let index = popup.itemArray.firstIndex(where: { $0.representedObject as? String == id }) else { return .alertSecondButtonReturn }
            popup.selectItem(at: index)
            return .alertFirstButtonReturn
        }
    }

    private static func driftPageSettled(_ page: MacDriftPageView, _ condition: () -> Bool) throws {
        try wait { !page.isCommitting && condition() }
    }

    private static func driftLinkSettled(_ host: MacChapterWorkspace, _ views: NativeDocumentView...) throws {
        try wait {
            !host.isBusy && views.allSatisfy {
                $0.binding.state != nil && !$0.binding.hasPendingWork && !$0.binding.store.hasScheduledLinks
            }
        }
    }

    private static func driftDescendant(_ view: NSView, _ identifier: String) -> NSView? {
        if view.accessibilityIdentifier() == identifier { return view }
        for child in view.subviews { if let found = driftDescendant(child, identifier) { return found } }
        return nil
    }

    /// A ⌘-mouse-down at the centre of a character's glyph, in window coordinates.
    private static func driftCommandClick(_ view: NativeDocumentView, at index: Int) throws -> NSEvent {
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

    static func driftAcceptance() throws -> [String] {
        try driftPanelGroupsAndDrifts()
        try driftPageBodyAndLinks()
        try driftActNotesTrashAndRestore()
        return [
            "AppKit drift panel creates groups, a subgroup and drifts, shows the one-level nesting refusal without writing, renames and moves drifts from the panel and page with titles unique across chapters, folds groups, and deleting groups lifts subgroups and drifts through cold reopen",
            "AppKit drift page body keeps its own owner and history and survives cold reopen, chapter prose links the drift title and retro-links a new drift, ⌘-click opens the drift page, and a trashed drift's link dims until restore",
            "AppKit act notes bound from the outline picker show on the act row and drift page and follow an act rename, a stale bind is refused, queued input blocks the trash, trash unbinds and closes the tab only after commit, restore returns it unbound, and unbinding or removing an act keeps the drift",
        ]
    }

    // MARK: (a) Panel, groups and drifts

    private static func driftPanelGroupsAndDrifts() throws {
        let harness = try DriftHarness(titles: ["启程", "航行"])
        defer { harness.remove() }
        let (model, controller, host) = (harness.model, harness.controller, harness.host)
        try require(model.rows == [.empty] && controller.createDriftButton.isEnabled && controller.createGroupButton.isEnabled
            && controller.statusText.contains("还没有漂流"), "A new project did not show an empty drift panel")

        // 新建分组 with a trimmed name.
        harness.answer = driftText("  线索 ")
        driftClick(controller.createGroupButton)
        try wait { model.library.groups.count == 1 && !model.busy }
        let clue = model.library.groups[0]
        try require(clue.name == "线索" && clue.parentGroupId == nil
            && model.rows == [.group(clue, depth: 0, count: 0, collapsed: false), .emptyGroup(groupID: clue.id, depth: 1)],
            "The first group was not created at the top level: \(model.rows)")

        // 新建子分组… with an empty name takes the default name.
        harness.answer = driftText("")
        try harness.item(harness.groupRow(clue.id), "create-drift-subgroup").press()
        try wait { model.library.groups.count == 2 && !model.busy }
        guard let sub = model.library.groups.first(where: { $0.id != clue.id }) else { throw LabError.message("Subgroup missing") }
        try require(sub.name == "新分组" && sub.parentGroupId == clue.id && model.library.isSubgroup(sub.id),
            "The subgroup did not take the default name inside its parent")

        // A subgroup cannot hold groups: its menu says so, and a stale request
        // is refused by Rust with the reason shown and nothing written.
        let nested = try harness.item(harness.groupRow(sub.id), "create-drift-subgroup")
        try require(!nested.isEnabled && nested.title.contains("最多嵌套一层"), "A subgroup offered 新建子分组…")
        let beforeNesting = try elementCount(harness.directory, "sync_change_set")
        harness.answer = driftText("更深")
        nested.press()
        try wait { !model.busy && controller.statusText == "分组最多嵌套一层：子分组中不能再建分组。" }
        try require(model.library.groups.count == 2 && elementCount(harness.directory, "sync_change_set") == beforeNesting,
            "The nesting refusal wrote a group or a journal row")

        // 新建漂流 inside 线索 opens its page with the title selected.
        harness.answer = driftText("")
        try harness.item(harness.groupRow(clue.id), "create-drift-in-group").press()
        try wait { model.library.drifts.count == 1 && !model.busy }
        let first = model.library.drifts[0]
        try require(first.title == "New Drift" && first.driftGroupId == clue.id && first.actId == nil
            && first.documentId == "node-content:\(first.id)", "The drift was not created in its group with the default title")
        try wait { harness.page(first) != nil && !host.isBusy }
        guard let firstPage = harness.page(first) else { throw LabError.message("Creating a drift did not open its page") }
        try elementSettled(host, firstPage.documentView)
        try require(host.activeDrift?.id == first.id && host.activeChapter == nil && host.activeChapterView == nil
            && host.tabTitles(pane: 0) == ["New Drift"] && !host.canReopenActive && firstPage.titleField.currentEditor() != nil
            && firstPage.text(of: .group) == clue.id && firstPage.actLabel.stringValue.contains("未绑定"),
            "The drift page did not become an active page tab with its title selected")

        // 新建漂流 outside any group; titles share one namespace with chapters.
        harness.answer = driftText("航行")
        driftClick(controller.createDriftButton)
        try wait { model.library.drifts.count == 2 && !model.busy }
        let log = model.library.drifts[1]
        try require(log.title == "航行 2" && log.driftGroupId == nil, "A drift took a chapter's title: \(log.title)")
        try wait { harness.page(log) != nil && !host.isBusy }
        try require(model.rows.contains(.ungroupedHeader(count: 1)) && model.rows.contains(.drift(log, depth: 0))
            && model.rows.contains(.drift(first, depth: 1)), "The panel did not place grouped and ungrouped drifts")

        // 重命名… in the panel reaches the page and the tab.
        harness.answer = driftText("灯塔日志")
        try harness.item(harness.driftRow(log.id), "rename-drift").press()
        try wait { model.library.drift(id: log.id)?.title == "灯塔日志" && !model.busy }
        try wait { host.tabTitles(pane: 0) == ["New Drift", "灯塔日志"] && harness.page(log)?.text(of: .title) == "灯塔日志" }

        // 移到分组… into the subgroup, which the picker names with its parent.
        harness.answer = driftChoice(sub.id)
        try harness.item(harness.driftRow(log.id), "move-drift").press()
        try require((harness.lastAlert?.accessoryView as? NSPopUpButton)?.itemArray.map(\.title) == ["未分组", "线索", "线索 / 新分组"],
            "The group picker did not list 未分组 and every group in order")
        try wait { model.library.drift(id: log.id)?.driftGroupId == sub.id && !model.busy }
        guard let clueNow = model.library.group(id: clue.id), let subNow = model.library.group(id: sub.id),
              let logNow = model.library.drift(id: log.id), let firstNow = model.library.drift(id: first.id) else {
            throw LabError.message("Groups or drifts disappeared")
        }
        try require(Array(model.rows.prefix(4)) == [.group(clueNow, depth: 0, count: 2, collapsed: false),
                                                     .group(subNow, depth: 1, count: 1, collapsed: false),
                                                     .drift(logNow, depth: 2), .drift(firstNow, depth: 1)],
            "The panel did not nest the subgroup and its drift: \(model.rows)")
        try wait { harness.page(log)?.text(of: .group) == sub.id }

        // The page's 分组 popup writes the same field, out of and into a group.
        func choose(_ id: String) throws {
            guard let index = firstPage.groupPopup.itemArray.firstIndex(where: { $0.representedObject as? String == id }) else {
                throw LabError.message("Page group popup lacks \(id)")
            }
            firstPage.groupPopup.selectItem(at: index)
            firstPage.groupPopup.sendAction(firstPage.groupPopup.action, to: firstPage.groupPopup.target)
        }
        try choose("")
        try driftPageSettled(firstPage) { firstPage.drift.driftGroupId == nil }
        try wait { model.library.drift(id: first.id)?.driftGroupId == nil && model.rows.contains(.ungroupedHeader(count: 1)) }
        try choose(clue.id)
        try driftPageSettled(firstPage) { firstPage.drift.driftGroupId == clue.id }
        try wait { model.library.drift(id: first.id)?.driftGroupId == clue.id && !model.rows.contains(.ungroupedHeader(count: 1)) }

        // Page titles are trimmed and unique with chapters; empty is refused.
        let shown: NativeDocumentView = try elementResult { host.open(project: harness.project, drift: first, completion: $0) }
        try elementSettled(host, shown)
        try require(shown === firstPage.documentView && host.activeDriftPage === firstPage, "The drift tab was not retained")
        try editHeader(harness.window, firstPage.titleField, "  启程 ")
        try driftPageSettled(firstPage) { firstPage.drift.title == "启程 2" }
        try require(firstPage.text(of: .title) == "启程 2" && firstPage.errorMessage == nil
            && host.tabTitles(pane: 0) == ["启程 2", "灯塔日志"] && model.library.drift(id: first.id)?.title == "启程 2",
            "The page rename did not store the unique suffixed title everywhere")
        try editHeader(harness.window, firstPage.titleField, "   ")
        try driftPageSettled(firstPage) { firstPage.errorMessage != nil && firstPage.text(of: .title) == "启程 2" }
        try editHeader(harness.window, firstPage.titleField, "潮汐", returnKey: true)
        try driftPageSettled(firstPage) { firstPage.drift.title == "潮汐" }
        try require(firstPage.errorMessage == nil && model.library.drift(id: first.id)?.title == "潮汐", "A valid title kept the refusal")

        // Group rename reaches the page pickers; a folded group hides its rows.
        harness.answer = driftText("暗线")
        try harness.item(harness.groupRow(sub.id), "rename-drift-group").press()
        try wait { model.library.group(id: sub.id)?.name == "暗线" && !model.busy }
        try wait { firstPage.groupPopup.itemArray.map(\.title) == ["未分组", "线索", "线索 / 暗线"] }
        guard let fold = driftDescendant(controller.cellView(try harness.groupRow(clue.id)), "drift-group-toggle-\(clue.id)") as? NSButton else {
            throw LabError.message("Group row lacks its disclosure")
        }
        driftClick(fold)
        try require(model.collapsed == [clue.id] && controller.rows.first?.group?.id == clue.id
            && !controller.rows.contains { $0.drift != nil || $0.group?.id == sub.id },
            "Folding the group did not hide its subgroup and drifts")
        guard let unfold = driftDescendant(controller.cellView(try harness.groupRow(clue.id)), "drift-group-toggle-\(clue.id)") as? NSButton else {
            throw LabError.message("Folded group row lacks its disclosure")
        }
        driftClick(unfold)
        try require(model.collapsed.isEmpty && controller.rows.contains { $0.drift?.id == log.id }, "Unfolding did not show the rows again")

        // Deleting 暗线 moves its drift up to 线索.
        harness.answer = driftText("支线")
        try harness.item(harness.groupRow(clue.id), "create-drift-subgroup").press()
        try wait { model.library.groups.count == 3 && !model.busy }
        guard let side = model.library.groups.first(where: { $0.name == "支线" }) else { throw LabError.message("Second subgroup missing") }
        harness.answer = { _ in .alertFirstButtonReturn }
        try harness.item(harness.groupRow(sub.id), "delete-drift-group").press()
        try require(harness.lastAlert?.informativeText == "其中的 1 条漂流会移到“线索”，不会删除任何漂流。",
            "Deleting a subgroup did not explain where its drift goes: \(harness.lastAlert?.informativeText ?? "none")")
        try wait { model.library.group(id: sub.id) == nil && !model.busy }
        try require(model.library.drift(id: log.id)?.driftGroupId == clue.id && model.library.drifts.count == 2
            && controller.statusText.contains("已移到“线索”"), "The subgroup's drift did not move up to its parent")
        try wait { harness.page(log)?.text(of: .group) == clue.id }

        // Cancelling writes nothing; deleting 线索 lifts 支线 and its drifts.
        let beforeDelete = try elementCount(harness.directory, "sync_change_set")
        harness.answer = { _ in .alertSecondButtonReturn }
        try harness.item(harness.groupRow(clue.id), "delete-drift-group").press()
        try require(model.library.group(id: clue.id) != nil && elementCount(harness.directory, "sync_change_set") == beforeDelete,
            "Cancelling the group deletion wrote a change")
        harness.answer = { _ in .alertFirstButtonReturn }
        try harness.item(harness.groupRow(clue.id), "delete-drift-group").press()
        try require(harness.lastAlert?.informativeText == "其中的 2 条漂流和 1 个子分组会移到上一级（未分组），不会删除任何漂流。",
            "Deleting a group did not explain the lift: \(harness.lastAlert?.informativeText ?? "none")")
        try wait { model.library.group(id: clue.id) == nil && !model.busy }
        guard let sideNow = model.library.group(id: side.id) else { throw LabError.message("The subgroup was lost with its parent") }
        try require(model.library.groups.map(\.id) == [side.id] && sideNow.parentGroupId == nil
            && model.library.drifts.map(\.id) == [first.id, log.id] && model.library.drifts.allSatisfy { $0.driftGroupId == nil },
            "Deleting a group did not lift its subgroup and drifts")
        try require(model.rows.first == .group(sideNow, depth: 0, count: 0, collapsed: false) && model.rows.contains(.ungroupedHeader(count: 2)),
            "The panel did not show the lifted subgroup at the top level")
        try wait { firstPage.text(of: .group) == "" && firstPage.groupPopup.itemArray.map(\.title) == ["未分组", "支线"] }

        try harness.close()
        let cold = LabWorkspaceCore(directory: harness.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let library: WorkspaceDriftLibrary = try elementResult { cold.driftLibrary(projectID: harness.project.id, completion: $0) }
        try require(library.drifts.map(\.title) == ["潮汐", "灯塔日志"] && library.drifts.allSatisfy { $0.driftGroupId == nil }
            && library.groups.map(\.name) == ["支线"] && library.groups[0].parentGroupId == nil && library.trashedDrifts.isEmpty,
            "Drift titles and groups did not survive cold reopen")
        let coldClosed: Bool = try elementResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }

    // MARK: (b) Page body and links

    private static func driftPageBodyAndLinks() throws {
        let linkDelay = DocumentStore.entityLinkDelay
        defer { DocumentStore.entityLinkDelay = linkDelay }
        DocumentStore.entityLinkDelay = 0.2
        let harness = try DriftHarness(titles: ["启程", "航行"])
        defer { harness.remove() }
        let (model, host, project, chapters) = (harness.model, harness.host, harness.project, harness.chapters)
        let tide: WorkspaceDrift = try elementResult { model.createDrift(title: "潮汐手记", groupID: nil, completion: $0) }

        // A chapter tab, then the drift page from the panel's 打开.
        let chapterView: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapters[0], completion: $0) }
        try driftLinkSettled(host, chapterView)
        let chapterCore = host.activeCore!
        try harness.item(harness.driftRow(tide.id), "open-drift").press()
        try wait { host.activeDrift?.id == tide.id && !host.isBusy }
        guard let page = harness.page(tide) else { throw LabError.message("打开 did not open the drift page") }
        let body = page.documentView
        try driftLinkSettled(host, body)
        let driftCore = host.activeCore!
        try require(driftCore !== chapterCore && !body.allowsComments && host.tabTitles(pane: 0) == ["启程", "潮汐手记"],
            "The drift page did not own its own body beside the chapter")

        // Body input has its own history.
        body.textView.insertText("月亮牵引潮水🙂", replacementRange: NSRange(location: 0, length: 0))
        try driftLinkSettled(host, body)
        body.undoProse(); try driftLinkSettled(host, body)
        try require(body.textView.string.isEmpty && chapterView.textView.string.isEmpty, "Drift undo did not stay in the drift body")
        body.redoProse(); try driftLinkSettled(host, body)
        try require(body.textView.string == "月亮牵引潮水🙂" && (try read(driftCore)).projection.text == "月亮牵引潮水🙂",
            "Drift redo did not restore the body")

        // Chapter prose that mentions the drift's title links it.
        let back: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapters[0], completion: $0) }
        try require(back === chapterView, "The chapter tab was not retained")
        chapterView.textView.insertText("今夜读完潮汐手记，又望北岸。", replacementRange: NSRange(location: 0, length: 0))
        try driftLinkSettled(host, chapterView)
        let node = { (id: String) in NativeEntityLink(kind: "node", id: id) }
        let linked = try read(chapterCore).projection
        try require(linkedRuns(linked).map(\.0) == ["潮汐手记"] && linkedRuns(linked).map(\.1) == [node(tide.id)],
            "The drift title was not linked in chapter prose: \(linkedRuns(linked))")
        try wait { host.linkDirectory(projectID: project.id)?.drifts[tide.id]?.name == "潮汐手记" }
        let tideAt = (chapterView.textView.string as NSString).range(of: "潮汐手记").location
        let style = chapterView.textView.textStorage!.attributes(at: tideAt, effectiveRange: nil)
        try require((style[.foregroundColor] as? NSColor)?.isEqual(NSColor.systemBlue) == true
            && style[.underlineStyle] as? Int == NSUnderlineStyle.single.rawValue, "The drift link is not drawn as a link: \(style)")
        try require(chapterView.showLinkPreview(at: tideAt) && chapterView.linkPreviewText == "漂流 · 潮汐手记", "Drift link preview is missing")
        chapterView.closeLinkPreview()

        // A drift created afterwards links the open chapter retroactively.
        let shore: WorkspaceDrift = try elementResult { model.createDrift(title: "北岸", groupID: nil, completion: $0) }
        try driftLinkSettled(host, chapterView)
        let relinked = try read(chapterCore).projection
        try require(linkedRuns(relinked).map(\.0) == ["潮汐手记", "北岸"] && linkedRuns(relinked).map(\.1) == [node(tide.id), node(shore.id)],
            "A new drift did not retro-link the open chapter: \(linkedRuns(relinked))")

        // ⌘-click opens the drift page in the pane that showed the link.
        let click = try driftCommandClick(chapterView, at: tideAt + 1)
        try require(chapterView.textView.linkIndex(for: click) == tideAt + 1, "⌘-click did not hit the linked glyph")
        chapterView.textView.mouseDown(with: click)
        try wait { !host.isBusy && host.activeDrift?.id == tide.id }
        try require(host.activePane == 0 && host.activeDriftPage === page && host.tabTitles(pane: 0) == ["启程", "潮汐手记"],
            "⌘-click did not open the drift page tab")

        // A trashed drift's link dims and cannot be opened; restore revives it.
        let _: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapters[0], completion: $0) }
        try driftLinkSettled(host, chapterView)
        let shoreAt = (chapterView.textView.string as NSString).range(of: "北岸").location
        let alertsBefore = harness.alerts.count
        let trash = try harness.item(harness.driftRow(shore.id), "trash-drift")
        try require(trash.title == "移到回收站", "An unbound drift asked for confirmation")
        trash.press()
        try wait { harness.trashed != nil && !host.isBusy }
        _ = try harness.trashed!.get()
        try require(harness.alerts.count == alertsBefore && host.linkDirectory(projectID: project.id)?.drifts[shore.id]?.trashed == true,
            "Trashing an unbound drift asked first or its link target stayed live")
        let dimmed = chapterView.textView.textStorage!.attributes(at: shoreAt, effectiveRange: nil)
        try require((dimmed[.foregroundColor] as? NSColor)?.isEqual(NSColor.secondaryLabelColor) == true && dimmed[.underlineStyle] == nil
            && !chapterView.openLink(at: shoreAt), "A trashed drift's link was not dimmed: \(dimmed)")
        let restored: WorkspaceDrift = try elementResult { model.restore(id: shore.id, completion: $0) }
        try driftLinkSettled(host, chapterView)
        try require(restored.id == shore.id && host.linkDirectory(projectID: project.id)?.drifts[shore.id]?.trashed == false
            && chapterView.openLink(at: shoreAt), "Restore did not revive the drift link")
        try wait { !host.isBusy && host.activeDrift?.id == shore.id }
        try driftLinkSettled(host, host.activeView!)

        try harness.close()
        // Cold reopen through the AppKit host: the page shows the stored body.
        let cold = LabWorkspaceCore(directory: harness.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let (window, coldHost) = elementHost(cold)
        defer { window.close() }
        let library: WorkspaceDriftLibrary = try elementResult { cold.driftLibrary(projectID: project.id, completion: $0) }
        guard let stored = library.drift(id: tide.id) else { throw LabError.message("The drift did not survive cold reopen") }
        let coldBody: NativeDocumentView = try elementResult { coldHost.open(project: project, drift: stored, completion: $0) }
        try driftLinkSettled(coldHost, coldBody)
        try require(coldBody.textView.string == "月亮牵引潮水🙂" && coldHost.activeDriftPage?.text(of: .title) == "潮汐手记"
            && coldBody.binding.state?.projection.canUndo == false, "The drift page body did not survive cold reopen")
        let coldChapter: NativeDocumentView = try elementResult { coldHost.open(project: project, chapter: chapters[0], completion: $0) }
        try driftLinkSettled(coldHost, coldChapter)
        try require(linkedRuns(coldChapter.binding.store.projection!).map(\.1) == [node(tide.id), node(shore.id)],
            "Drift links did not survive cold reopen")
        let coldClosed: Bool = try elementResult { coldHost.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }

    // MARK: (c) Act notes, trash and restore

    private static func driftActNotesTrashAndRestore() throws {
        let harness = try DriftHarness(titles: ["启程", "航行", "归岸"])
        defer { harness.remove() }
        let (model, host, project, chapters) = (harness.model, harness.host, harness.project, harness.chapters)
        let (outline, outlineController) = (harness.outline, harness.outlineController)
        let act1: WorkspaceAct = try elementResult { outline.createAct(beforeChapterID: chapters[0].id, completion: $0) }
        let act2: WorkspaceAct = try elementResult { outline.createAct(beforeChapterID: chapters[2].id, completion: $0) }
        try wait { model.actNames.count == 2 && !model.busy }
        let notes: WorkspaceDrift = try elementResult { model.createDrift(title: "幕一笔记", groupID: nil, completion: $0) }
        let spare: WorkspaceDrift = try elementResult { model.createDrift(title: "备用", groupID: nil, completion: $0) }
        try wait { outline.drifts?.drifts.count == 2 }
        guard let act1Entry = outline.entries.first(where: { $0.id == act1.id }),
              let act2Entry = outline.entries.first(where: { $0.id == act2.id }) else { throw LabError.message("Outline lacks the acts") }

        // 绑定幕笔记… offers unbound drifts; 解除幕笔记 waits for a binding.
        let bind = try harness.actItem(act1.id, "outline-bind-act-drift"), unbind = try harness.actItem(act1.id, "outline-unbind-act-drift")
        try require(bind.isEnabled && bind.title == "绑定幕笔记…" && !unbind.isEnabled && outlineController.actDriftButton(actID: act1.id) == nil,
            "An unbound act row did not offer 绑定幕笔记…")
        let beforePicker = try elementCount(harness.directory, "sync_change_set")
        harness.answer = { _ in .alertSecondButtonReturn }
        try harness.send(bind)
        try require((harness.lastAlert?.accessoryView as? NSPopUpButton)?.itemArray.map(\.title) == ["幕一笔记", "备用"]
            && harness.bound == nil && elementCount(harness.directory, "sync_change_set") == beforePicker,
            "The picker did not list unbound drifts, or cancelling wrote a change")
        harness.answer = driftChoice(notes.id)
        try harness.send(bind)
        try wait { harness.bound != nil && !model.busy }
        let boundAct = try harness.bound!.get()
        try require(boundAct.id == act1.id && boundAct.driftNodeId == notes.id && model.library.drift(id: notes.id)?.actId == act1.id,
            "Binding did not store the drift as the act's notes")
        try wait { outlineController.actDriftButton(actID: act1.id)?.title == "幕笔记 · 幕一笔记" }
        try require(outline.status == "“幕一笔记”已绑定为“\(act1Entry.title)”的幕笔记。"
            && (try harness.actItem(act1.id, "outline-unbind-act-drift")).isEnabled
            && (driftDescendant(harness.controller.cellView(try harness.driftRow(notes.id)), "drift-act-\(notes.id)") as? NSTextField)?
                .stringValue == "幕笔记 · \(act1Entry.title)", "The act row or the panel did not show the bound notes")

        // The second act's picker offers only the drift still unbound; a
        // stale choice of a bound drift is refused without writing.
        harness.answer = { _ in .alertSecondButtonReturn }
        try harness.send(try harness.actItem(act2.id, "outline-bind-act-drift"))
        try require((harness.lastAlert?.accessoryView as? NSPopUpButton)?.itemArray.map(\.title) == ["备用"],
            "The picker offered a drift bound to another act")
        let beforeStale = try elementCount(harness.directory, "sync_change_set")
        harness.bound = nil
        outlineController.onBindDrift?(act2Entry, model.library.drift(id: notes.id))
        try wait { harness.bound != nil && !model.busy }
        guard case .failure = harness.bound! else { throw LabError.message("A drift was bound to two acts") }
        try require(outline.status == "这条漂流已是另一幕的笔记，请先在那一幕解除。"
            && elementCount(harness.directory, "sync_change_set") == beforeStale && model.library.drift(id: notes.id)?.actId == act1.id,
            "A stale bind was not refused with its reason: \(outline.status)")

        // The act row's notes open the drift page, which names the act and
        // follows an act rename.
        guard let open = outlineController.actDriftButton(actID: act1.id) else { throw LabError.message("Act row lacks its notes") }
        driftClick(open)
        try wait { host.activeDrift?.id == notes.id && !host.isBusy }
        guard let page = harness.page(notes) else { throw LabError.message("The act notes did not open the drift page") }
        let body = page.documentView
        try elementSettled(host, body)
        try wait { page.actLabel.stringValue == act1Entry.title }
        let _: WorkspaceAct = try elementResult { outline.renameAct(id: act1.id, name: "潮起", completion: $0) }
        try wait { page.actLabel.stringValue == "潮起" && model.actName(of: model.library.drift(id: notes.id)!) == "潮起" && !model.busy }

        // Body text beside a chapter tab.
        body.textView.insertText("幕前备忘", replacementRange: NSRange(location: 0, length: 0))
        try elementSettled(host, body)
        let driftCore = host.activeCore!
        let chapterView: NativeDocumentView = try elementResult { host.open(project: project, chapter: chapters[1], completion: $0) }
        try elementSettled(host, chapterView)
        let chapterCore = host.activeCore!
        chapterView.textView.insertText("航", replacementRange: NSRange(location: 0, length: 0))
        try elementSettled(host, chapterView)
        let again: NativeDocumentView = try elementResult { host.open(project: project, drift: notes, completion: $0) }
        try elementSettled(host, again)
        try require(again === body && host.tabTitles(pane: 0) == ["幕一笔记", "航行"], "The drift tab was not retained")

        // Queued body input blocks the trash; tab, owner and binding remain.
        body.textView.insertText("续", replacementRange: NSRange(location: 4, length: 0))
        try require(body.binding.hasPendingWork, "Queued trash fixture was already idle")
        let _: String = try elementRefused({ host.trashDrift(projectID: project.id, driftID: notes.id, completion: $0) },
            "Trash discarded queued drift input")
        try elementSettled(host, body)
        try require(!driftCore.isClosed && harness.page(notes) === page && model.library.drift(id: notes.id)?.actId == act1.id
            && body.textView.string == "幕前备忘续", "A refused trash released the drift, its tab or its binding")

        // Trash explains the unbinding; the tab closes only after the commit.
        let trash = try harness.item(harness.driftRow(notes.id), "trash-drift")
        try require(trash.title == "移到回收站…", "A bound drift's trash did not ask first")
        harness.answer = { _ in .alertSecondButtonReturn }
        trash.press()
        try require(harness.lastAlert?.informativeText.contains("“潮起”的幕笔记") == true && harness.trashed == nil
            && harness.page(notes) === page, "Cancelling the trash did not keep everything or explain the unbinding")
        harness.answer = { _ in .alertFirstButtonReturn }
        try harness.item(harness.driftRow(notes.id), "trash-drift").press()
        try require(harness.trashed == nil && host.isBusy && harness.page(notes) === page && !driftCore.isClosed,
            "The drift tab closed before the trash committed")
        try wait { harness.trashed != nil && !host.isBusy }
        let reply = try harness.trashed!.get()
        try require(reply.result?.id == notes.id && reply.result?.actId == nil && reply.library.trashedDrifts.map(\.id) == [notes.id]
            && reply.library.drifts.map(\.id) == [spare.id], "Drift trash returned an incorrect library")
        try require(driftCore.isClosed && harness.page(notes) == nil && host.tabTitles(pane: 0) == ["航行"] && !chapterCore.isClosed
            && chapterView.textView.string == "航", "Drift trash closed the wrong tabs")
        try wait { outlineController.actDriftButton(actID: act1.id) == nil && outline.boundDrift(actID: act1.id) == nil }
        try require(model.rows.contains(.trashHeader(count: 1)) && model.rows.contains(.trashed(reply.library.trashedDrifts[0]))
            && driftDescendant(harness.controller.cellView(.trashed(reply.library.trashedDrifts[0])), "restore-drift-\(notes.id)") is NSButton,
            "The panel did not list the trashed drift with 恢复")

        // Restore brings it back unbound, with its body.
        guard let restore = harness.controller.menuItems(for: .trashed(reply.library.trashedDrifts[0])).first as? LibraryMenuItem else {
            throw LabError.message("Trashed drift lacks 恢复")
        }
        restore.press()
        try wait { model.library.trashedDrifts.isEmpty && model.library.drift(id: notes.id) != nil && !model.busy }
        guard let restored = model.library.drift(id: notes.id) else { throw LabError.message("Restored drift missing") }
        try require(restored.actId == nil && outline.boundDrift(actID: act1.id) == nil && harness.page(notes) == nil,
            "Restore bound the drift again or opened a page")
        try wait { (try? harness.actItem(act1.id, "outline-bind-act-drift"))?.isEnabled == true }
        let fresh: NativeDocumentView = try elementResult { host.open(project: project, drift: restored, completion: $0) }
        try elementSettled(host, fresh)
        guard let freshPage = harness.page(restored) else { throw LabError.message("Restored drift page missing") }
        try require(fresh !== body && fresh.textView.string == "幕前备忘续" && fresh.binding.state?.projection.canUndo == false
            && freshPage.actLabel.stringValue.contains("未绑定"), "Restore lost the body or kept the binding")

        // 解除幕笔记 releases a binding and keeps the drift.
        harness.answer = driftChoice(spare.id)
        try harness.send(try harness.actItem(act2.id, "outline-bind-act-drift"))
        try wait { model.library.drift(id: spare.id)?.actId == act2.id && !model.busy }
        try wait { outlineController.actDriftButton(actID: act2.id)?.title == "幕笔记 · 备用" }
        try harness.send(try harness.actItem(act2.id, "outline-unbind-act-drift"))
        try wait { model.library.drift(id: spare.id)?.actId == nil && !model.busy }
        try require(model.library.drift(id: spare.id) != nil && outlineController.actDriftButton(actID: act2.id) == nil
            && outline.status == "已解除“\(act2Entry.title)”的幕笔记，漂流本身保留。", "解除幕笔记 did not release only the binding")

        // Removing an act releases its notes: the page and panel follow.
        harness.answer = driftChoice(notes.id)
        try harness.send(try harness.actItem(act1.id, "outline-bind-act-drift"))
        try wait { freshPage.actLabel.stringValue == "潮起" && outlineController.actDriftButton(actID: act1.id) != nil && !model.busy }
        let _: WorkspaceAct = try elementResult { outline.removeAct(id: act1.id, completion: $0) }
        try wait { model.library.drift(id: notes.id)?.actId == nil && freshPage.actLabel.stringValue.contains("未绑定") && !model.busy }
        try require(model.library.drift(id: notes.id) != nil && outline.entries.filter { $0.kind == "act" }.map(\.id) == [act2.id],
            "Removing the act deleted its notes or kept the binding")

        fresh.textView.insertText("终", replacementRange: NSRange(location: 5, length: 0))
        try elementSettled(host, fresh)
        try harness.close()
        let cold = LabWorkspaceCore(directory: harness.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let library: WorkspaceDriftLibrary = try elementResult { cold.driftLibrary(projectID: project.id, completion: $0) }
        try require(library.drifts.map(\.id).sorted() == [notes.id, spare.id].sorted() && library.drifts.allSatisfy { $0.actId == nil }
            && library.trashedDrifts.isEmpty, "Drift bindings did not survive cold reopen")
        let coldBody: LabCore = try elementResult { cold.openDrift(projectID: project.id, driftID: notes.id, completion: $0) }
        try require(try read(coldBody).projection.text == "幕前备忘续终", "Drift body did not survive trash, restore and cold reopen")
        let coldChapter: LabCore = try elementResult { cold.openChapter(projectID: project.id, chapterID: chapters[1].id, completion: $0) }
        try require(try read(coldChapter).projection.text == "航", "Chapter body changed across drift commands")
        let coldClosed: Bool = try elementResult { cold.close(completion: $0) }
        try require(coldClosed, "Cold workspace failed to close")
    }
}
