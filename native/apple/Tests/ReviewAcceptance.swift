import AppKit

/// 审阅, TODOs, 关联, the 备忘与素材 board, 幕颜色 and 删除项目 through the real
/// AppKit controllers, the tab host, the Rust workspace and SQLite, wired
/// as AppDelegate wires them. Sheets and alerts are answered here without
/// windows on screen; every title, body and file is synthetic.
extension BindingAcceptance {
    static func reviewAcceptance() throws -> [String] {
        let saved = (DocumentStore.entityLinkDelay, WordCountModel.refreshDelay, MacWholeBookViewController.typingPause,
                     MacWholeBookViewController.retryDelay)
        defer {
            (DocumentStore.entityLinkDelay, WordCountModel.refreshDelay, MacWholeBookViewController.typingPause,
             MacWholeBookViewController.retryDelay) = saved
        }
        DocumentStore.entityLinkDelay = 0.05
        WordCountModel.refreshDelay = 0.05
        MacWholeBookViewController.typingPause = 0.2
        MacWholeBookViewController.retryDelay = 0.05
        try reviewComposeFiltersAndRanking()
        try reviewPriorityResolveConvertAndEdit()
        try reviewDeleteAndLocate()
        try reviewAssociations()
        try reviewBoardFiltersAndReorder()
        try reviewActColours()
        try reviewProjectDeletion()
        return [
            "AppKit 审阅 composes a note on the focused chapter, a TODO on it with a priority and a floating TODO associated with it, lists 全部/批注/待办 and 当前 (whole page first, then passage notes, then associated items, each newest first) or 全书, follows the focused tab, and refuses an empty body, a note without a page and Rust's floating note in Chinese without writing",
            "AppKit 审阅 sets and clears a priority with one field.set each and none for the current one, resolves and reopens under 已解决 and from the board's 已完成 archive, converts a passage note to a TODO and back keeping its anchor, refuses making a floating TODO a note in Chinese without writing, and edits a body through the composer writing nothing when unchanged",
            "AppKit 审阅 定位 opens a note's page as a tab and selects a passage note's anchored text, deletes only after confirmation, refuses while the chapter has marked input, removes a passage note with its highlight from both open views and the chapter's comment panel while typing continues and saves through cold reopen, and deletes an associated TODO with its relations in one original",
            "AppKit 关联 of TODOs and library items with chapters, drifts, elements, categories and storylines through menus and chips writes one entity-relation original each, stays out of pages' 关系 sections, follows a rename and survives a cold relaunch",
            "AppKit 备忘与素材 board shows open TODO cards beside the library's cards with kind chips and counts that hide and show 待办, 图片, PDF, 链接 and 文字, reorders library items by drag with one order original also while a kind is hidden, writes nothing for a drop in place, and keeps the order through a cold relaunch",
            "AppKit 幕颜色 from the 整书大纲 and a 全书长卷 separator stores one field.set per change and nothing for the current colour, the separator wash, 统计 strip, act rows and chapter bars follow while other acts keep the hue cycle, 恢复默认 clears it, and colours survive a cold relaunch",
            "AppKit 删除项目 names what is removed, enables 删除项目 only for the exact typed name, refuses in Chinese with nothing written while a tab has marked input or an owner outside the tabs is open, closes the 全书长卷 and every tab of the project first, deletes with one sync-generation purge and the asset bytes, switches to the remaining project, is gone after a cold relaunch, and deleting the last project opens a new empty one",
        ]
    }

    // MARK: Harness

    private final class ReviewHarness {
        let root: URL
        let directory: URL
        let journal: JournalProbe
        private(set) var workspace: LabWorkspaceCore
        let project: WorkspaceProject
        private(set) var chapters: [WorkspaceChapter] = []
        private(set) var drift: WorkspaceDrift!
        private(set) var category: WorkspaceElementCategory!
        private(set) var element: WorkspaceElement!
        private(set) var storyline: WorkspaceStoryline!
        private(set) var window: NSWindow
        private(set) var host: MacChapterWorkspace
        private(set) var model: ReviewModel!
        private(set) var controller: MacReviewViewController!
        private(set) var panelWindow: NSWindow!
        /// Answers alerts; nil cancels.
        var answer: ((NSAlert) -> NSApplication.ModalResponse)?
        var located: [String?] = []
        var chapterComments: ChapterCommentsModel?

        init(name: String, chapterTitles: [String] = ["雨夜", "钟楼"], entities: Bool = true) throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            directory = root.appendingPathComponent("apple-native-lab")
            journal = JournalProbe(directory: directory)
            let workspace = LabWorkspaceCore(directory: directory)
            self.workspace = workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(listed.isEmpty, "Review fixture was not isolated")
            project = try BindingAcceptance.elementResult { workspace.createProject(name: name, completion: $0) }
            let projectID = project.id
            for title in chapterTitles {
                chapters.append(try BindingAcceptance.elementResult { workspace.createChapter(projectID: projectID, title: title, completion: $0) })
            }
            if entities {
                drift = try BindingAcceptance.elementResult { (done: @escaping (Result<WorkspaceDriftReply<WorkspaceDrift>, Error>) -> Void) in
                    workspace.createDrift(projectID: projectID, title: "旧信", groupID: nil, completion: done)
                }.result
                category = try BindingAcceptance.elementResult { (done: @escaping (Result<WorkspaceElementReply<WorkspaceElementCategory>, Error>) -> Void) in
                    workspace.createElementCategory(projectID: projectID, name: "人物", completion: done)
                }.result
                let categoryID = category.id
                element = try BindingAcceptance.elementResult { (done: @escaping (Result<WorkspaceElementReply<WorkspaceElement>, Error>) -> Void) in
                    workspace.createElement(projectID: projectID, categoryID: categoryID, name: "老周", completion: done)
                }.result
                storyline = try BindingAcceptance.elementResult { (done: @escaping (Result<WorkspaceStorylineReply<WorkspaceStoryline>, Error>) -> Void) in
                    workspace.createStoryline(projectID: projectID, name: "主线", completion: done)
                }.result
            }
            (window, host) = BindingAcceptance.elementHost(workspace)
            host.loadNames(projectID: projectID)
            try BindingAcceptance.wait { self.host.relationNames(projectID: projectID).loaded && self.host.relationNames(projectID: projectID).storylinesKnown }
        }

        func cleanup() {
            panelWindow?.close()
            try? FileManager.default.removeItem(at: root)
        }

        var associations: AssociationModel { host.relations.associations(projectID: project.id) }

        /// The 审阅 panel as AppDelegate.showReview builds it.
        func openReview() throws {
            panelWindow?.close()
            let host = self.host, project = self.project
            let model = ReviewModel(workspace: workspace, projectID: project.id, associations: host.relations.associations(projectID: project.id))
            model.ownerBusy = { chapterID in
                guard let view = host.openView(scope: .chapter(ChapterScope(projectID: project.id, chapterID: chapterID))) else { return false }
                return view.binding.hasPendingWork || view.textView.hasMarkedText()
            }
            model.onChanged = { [weak self] change in
                host.commentsChanged(change, projectID: project.id)
                if let comments = self?.chapterComments, change.comment.targetKind == "node" { comments.reload() }
            }
            let controller = MacReviewViewController(model: model)
            wire(controller.commands)
            controller.anchor = { comment in
                guard comment.targetKind == "node", let chapter = comment.targetId,
                      let view = host.openView(scope: .chapter(ChapterScope(projectID: project.id, chapterID: chapter))) else { return nil }
                return view.binding.store.projection?.comments.first { $0.id == comment.id }
            }
            host.onChange = { [weak model] in model?.setFocus(host.activeFocus) }
            host.onComments = { [weak controller] _ in controller?.refreshAnchors() }
            host.onCommentCreated = { [weak model] _, _ in model?.load() }
            let panelWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 720), styleMask: [.titled, .resizable],
                                       backing: .buffered, defer: false)
            panelWindow.isReleasedWhenClosed = false
            panelWindow.contentViewController = controller
            controller.view.layoutSubtreeIfNeeded()
            self.model = model; self.controller = controller; self.panelWindow = panelWindow
            model.setFocus(host.activeFocus)
            model.load()
            try settle()
        }

        /// Sheets and alerts answered here, 定位 and chips through the tab host.
        func wire(_ commands: ReviewCommands) {
            let host = self.host, project = self.project
            commands.presentAlert = { [weak self] alert, done in
                alert.layout()
                done(self?.answer?(alert) ?? .alertSecondButtonReturn)
            }
            commands.presentSheet = { _ in }
            commands.onLocate = { [weak self] comment in
                host.locate(comment: comment, project: project) { self?.located.append($0) }
            }
            commands.onOpen = { endpoint in host.open(endpoint: endpoint, project: project) { _ in } }
        }

        func settle(file: String = #fileID, line: Int = #line) throws {
            try BindingAcceptance.wait(file: file, line: line) {
                !self.host.isBusy && self.host.canNavigate && self.model.loaded && !self.model.busy && !self.model.isReading
                    && !self.associations.relations.busy && self.associations.relations.loaded
            }
            controller.view.layoutSubtreeIfNeeded()
        }

        func openChapter(_ chapter: WorkspaceChapter, pane: Int? = nil) throws -> NativeDocumentView {
            let view: NativeDocumentView = try BindingAcceptance.elementResult { host.open(project: project, chapter: chapter, in: pane, completion: $0) }
            try BindingAcceptance.elementSettled(host, view)
            return view
        }

        func type(_ view: NativeDocumentView, _ text: String, at location: Int = 0) throws {
            view.textView.insertText(text, replacementRange: NSRange(location: location, length: 0))
            try BindingAcceptance.elementSettled(host, view)
        }

        /// ⌥⌘M on a selection: a passage note written through the owner.
        func selectionNote(_ view: NativeDocumentView, range: NSRange, body: String) throws -> WorkspaceComment {
            view.textView.setSelectedRange(range)
            try BindingAcceptance.wait { view.binding.selectionIsAnchored }
            let comment: WorkspaceComment = try BindingAcceptance.elementResult {
                view.addComment(body, range: range, revision: view.binding.store.projection!.revision, completion: $0)
            }
            try BindingAcceptance.elementSettled(host, view)
            try BindingAcceptance.wait { self.model.comment(id: comment.id) != nil && !self.model.busy }
            return comment
        }

        /// 新建批注 / 新建待办 through the sheet; returns the new row.
        func compose(kind: String, body: String, configure: (ReviewComposeSheet) throws -> Void = { _ in }) throws -> WorkspaceComment {
            let before = Set(model.comments.map(\.id))
            if kind == "note" { controller.newNote() } else { controller.newTodo() }
            guard let sheet = controller.commands.composeSheet else { throw LabError.message("No compose sheet") }
            sheet.bodyView.string = body
            try configure(sheet)
            sheet.submit()
            try BindingAcceptance.wait { self.controller.commands.composeSheet == nil && !self.model.busy && !self.associations.relations.busy }
            guard let created = model.comments.first(where: { !before.contains($0.id) }) else {
                throw LabError.message("The sheet created nothing: \(sheet.errorMessage ?? model.status)")
            }
            controller.view.layoutSubtreeIfNeeded()
            return created
        }

        func card(_ comment: WorkspaceComment) throws -> ReviewCardView {
            guard let card = controller.card(commentID: comment.id) else { throw LabError.message("No card for \(comment.bodyText)") }
            return card
        }

        func comment(_ id: String) throws -> WorkspaceComment {
            guard let comment = model.comment(id: id) else { throw LabError.message("No comment \(id)") }
            return comment
        }

        func endpoint(_ chapter: WorkspaceChapter) -> RelationEndpoint { RelationEndpoint(kind: "node", id: chapter.id) }
    }

    /// A menu item by identifier, looking into submenus.
    fileprivate static func reviewItem(_ items: [NSMenuItem], _ identifier: String) throws -> NSMenuItem {
        func find(_ items: [NSMenuItem]) -> NSMenuItem? {
            for item in items {
                if item.accessibilityIdentifier() == identifier { return item }
                if let found = item.submenu.flatMap({ find($0.items) }) { return found }
            }
            return nil
        }
        guard let item = find(items) else { throw LabError.message("No menu item \(identifier)") }
        return item
    }

    fileprivate static func reviewPress(_ item: NSMenuItem) throws {
        try require(item.isEnabled, "\(item.title) was disabled")
        if let item = item as? LibraryMenuItem { item.press(); return }
        guard let action = item.action else { throw LabError.message("Menu item \(item.title) has no action") }
        NSApp.sendAction(action, to: item.target, from: item)
    }

    fileprivate static func reviewHighlighted(_ view: NativeDocumentView, at location: Int) -> Bool {
        view.textView.textStorage?.attribute(.backgroundColor, at: location, effectiveRange: nil) != nil
    }

    fileprivate static func reviewSegment(_ control: NSSegmentedControl, _ index: Int) {
        control.selectedSegment = index
        control.sendAction(control.action, to: control.target)
    }

    // MARK: Compose, filters and scope

    private static func reviewComposeFiltersAndRanking() throws {
        let harness = try ReviewHarness(name: "审阅合成项目")
        defer { harness.cleanup() }
        let chapter = harness.chapters[0]
        let view = try harness.openChapter(chapter)
        try harness.type(view, "钟声在雨夜里响起。北塔的灯还亮着。")
        try harness.openReview()
        let controller = harness.controller!, model = harness.model!
        try require(model.focus?.label == "章节「雨夜」" && controller.focusLabel.stringValue == "当前：章节「雨夜」"
            && model.effectiveScope == .current, "审阅 did not follow the focused chapter: \(controller.focusLabel.stringValue)")
        let passage = try harness.selectionNote(view, range: NSRange(location: 0, length: 2), body: "钟声要更具体")
        try harness.settle()
        try require(passage.isBlock && passage.targetId == chapter.id && model.comments.count == 1, "The selection note did not reach 审阅")

        var mark = try harness.journal.mark()
        let note = try harness.compose(kind: "note", body: "本章节奏偏慢") { sheet in
            try require(sheet.kind == "note" && sheet.placePopup.indexOfSelectedItem == 0 && sheet.placePopup.item(at: 1)?.isEnabled == false
                && sheet.placePopup.titleOfSelectedItem == "当前：章节「雨夜」", "A new note was not placed on the focused page")
        }
        try harness.journal.expect([["entity.create comment"]], since: mark, "A note on the chapter")
        try require(note.kind == "note" && note.targetKind == "node" && note.targetId == chapter.id && note.targetBlockId == nil
            && note.priority == nil && note.source == "manual", "The note is not on the whole chapter")

        mark = try harness.journal.mark()
        let todo = try harness.compose(kind: "todo", body: "核对钟楼的高度") { sheet in
            try require(sheet.placePopup.indexOfSelectedItem == 1 && sheet.associated == [harness.endpoint(chapter)],
                "A new TODO did not float with the focused page associated")
            sheet.placePopup.selectItem(at: 0)
            sheet.removeAssociation(harness.endpoint(chapter))
            sheet.priorityPopup.selectItem(at: 3)
        }
        try harness.journal.expect([["entity.create comment"]], since: mark, "A TODO on the chapter")
        try require(todo.kind == "todo" && todo.targetId == chapter.id && todo.priority == "high", "The TODO is not on the chapter with 高")

        mark = try harness.journal.mark()
        let floating = try harness.compose(kind: "todo", body: "补一场雨夜戏")
        try harness.journal.expect([["entity.create comment"], ["entity.create entity-relation"]], since: mark, "A floating TODO")
        try require(floating.isFloating && harness.associations.entries(of: floating.endpoint).map(\.target) == [harness.endpoint(chapter)],
            "The floating TODO was not associated with the chapter")

        let elementEndpoint = RelationEndpoint(kind: "element", id: harness.element.id)
        let elsewhere = try harness.compose(kind: "todo", body: "老周的口音") { sheet in
            sheet.removeAssociation(harness.endpoint(chapter))
            guard let item = AssociationMenu.item(sheet.associationMenu(), elementEndpoint) else { throw LabError.message("No 老周 to associate") }
            item.press()
            try require(sheet.chips.labels == ["设定 · 老周"], "The sheet's chips read \(sheet.chips.labels)")
        }
        try require(harness.associations.entries(of: elsewhere.endpoint).map(\.target) == [elementEndpoint], "The TODO was not associated with 老周")

        // 当前: the whole page (newest first), its passages, then associated items.
        try require(controller.renderedIDs == [todo.id, note.id, passage.id, floating.id],
            "当前 lists \(controller.renderedIDs.map { try? harness.comment($0).bodyText })")
        let todoCard = try harness.card(todo), passageCard = try harness.card(passage)
        try require(todoCard.headerLabel.stringValue == "待办 · 优先级高 · 章节「雨夜」"
            && passageCard.headerLabel.stringValue == "批注 · 章节「雨夜」 · 已定位" && passageCard.quoteLabel.stringValue == "「钟声」"
            && !passageCard.quoteLabel.isHidden && (try harness.card(floating)).headerLabel.stringValue == "待办 · 浮动"
            && (try harness.card(floating)).chips.labels == ["章节 · 雨夜"] && !(try harness.card(floating)).locateButton.isEnabled,
            "Cards read \(todoCard.headerLabel.stringValue) / \(passageCard.headerLabel.stringValue)")
        reviewSegment(controller.filterControl, 1)
        try require(controller.renderedIDs == [note.id, passage.id], "批注 lists \(controller.renderedIDs)")
        reviewSegment(controller.filterControl, 2)
        try require(controller.renderedIDs == [todo.id, floating.id], "待办 lists \(controller.renderedIDs)")
        reviewSegment(controller.filterControl, 0)
        reviewSegment(controller.scopeControl, 1)
        try require(model.effectiveScope == .project && controller.renderedIDs == [todo.id, note.id, passage.id, floating.id, elsewhere.id],
            "全书 lists \(controller.renderedIDs)")
        reviewSegment(controller.scopeControl, 0)

        // The focused tab decides 当前: the element page lists its TODO.
        let _: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, element: harness.element, completion: $0) }
        try harness.settle()
        try require(model.focus?.endpoint == elementEndpoint && controller.focusLabel.stringValue == "当前：设定「老周」"
            && controller.renderedIDs == [elsewhere.id], "当前 did not follow the element tab: \(controller.renderedIDs)")
        let _: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, chapter: chapter, completion: $0) }
        try harness.settle()

        // Refusals keep the sheet and write nothing.
        mark = try harness.journal.mark()
        controller.newTodo()
        guard let empty = controller.commands.composeSheet else { throw LabError.message("No compose sheet") }
        empty.bodyView.string = "   "
        empty.submit()
        try require(empty.errorMessage == "请输入内容。" && controller.commands.composeSheet === empty, "An empty TODO was not refused in the sheet")
        empty.cancel()
        try require(controller.commands.composeSheet == nil, "取消 did not close the sheet")
        model.setFocus(nil)
        try require(controller.renderedIDs == [elsewhere.id, floating.id, todo.id, note.id, passage.id]
            && controller.focusLabel.stringValue == "未打开页面 · 显示全书" && !controller.scopeControl.isEnabled(forSegment: 0),
            "Without a page 审阅 did not show the whole book")
        controller.newNote()
        guard let pageless = controller.commands.composeSheet else { throw LabError.message("No compose sheet") }
        pageless.bodyView.string = "无处可写"
        pageless.submit()
        try require(pageless.errorMessage?.hasPrefix("批注需要写在一个页面上") == true && pageless.placePopup.item(at: 0)?.isEnabled == false,
            "A note without a page was not refused: \(pageless.errorMessage ?? "")")
        pageless.cancel()
        let refusal = try elementRefused({ (done: @escaping (Result<WorkspaceComment, Error>) -> Void) in
            model.create(kind: "note", onFocus: false, body: "浮动批注", priority: nil, completion: done)
        }, "Rust accepted a floating note")
        try harness.settle()
        try require(refusal == "浮动的只能是待办" && model.status == refusal, "Rust's refusal read \(refusal)")
        try harness.journal.expect([], since: mark, "Refused compositions")
        try require(model.comments.count == 5, "A refusal changed the rows")
    }

    // MARK: Priority, resolve, convert, edit

    private static func reviewPriorityResolveConvertAndEdit() throws {
        let harness = try ReviewHarness(name: "审阅状态项目")
        defer { harness.cleanup() }
        let chapter = harness.chapters[0]
        let view = try harness.openChapter(chapter)
        try harness.type(view, "钟声在雨夜里响起。")
        try harness.openReview()
        let controller = harness.controller!, model = harness.model!
        let passage = try harness.selectionNote(view, range: NSRange(location: 3, length: 2), body: "雨夜")
        let todo = try harness.compose(kind: "todo", body: "核对钟楼") { $0.placePopup.selectItem(at: 0); $0.removeAssociation(harness.endpoint(chapter)) }
        let floating = try harness.compose(kind: "todo", body: "浮动待办")

        // 优先级: one field.set per change, none for the current one, 无 clears.
        var mark = try harness.journal.mark()
        try reviewPress(try reviewItem(try harness.card(todo).actionItems, "review-priority-med"))
        try harness.settle()
        try harness.journal.expect([["field.set comment"]], since: mark, "Priority 中")
        try require(try harness.comment(todo.id).priority == "med"
            && (try harness.card(todo)).headerLabel.stringValue.contains("优先级中"), "The card does not show 中")
        mark = try harness.journal.mark()
        let current = try reviewItem(try harness.card(todo).actionItems, "review-priority-med")
        try require(current.state == .on, "The current priority is not checked")
        try reviewPress(current)
        try harness.settle()
        try harness.journal.expect([], since: mark, "The current priority")
        try reviewPress(try reviewItem(try harness.card(todo).actionItems, "review-priority-none"))
        try harness.settle()
        try harness.journal.expect([["field.set comment"]], since: mark, "Clearing the priority")
        try require(try harness.comment(todo.id).priority == nil, "无 did not clear the priority")

        // 解决 and 重新打开 under 已解决.
        mark = try harness.journal.mark()
        (try harness.card(todo)).resolveButton.press()
        try harness.settle()
        try harness.journal.expect([["field.set comment", "field.set comment"]], since: mark, "Resolving")
        try require(!controller.renderedIDs.contains(todo.id) && controller.resolvedToggle.title == "▸ 已解决（1）"
            && !controller.resolvedToggle.isHidden && controller.renderedResolvedIDs.isEmpty, "The resolved TODO did not move under 已解决")
        controller.resolvedToggle.performClick(nil)
        try require(controller.renderedResolvedIDs == [todo.id] && (try harness.card(todo)).resolveButton.title == "重新打开"
            && (try harness.card(todo)).headerLabel.stringValue.hasSuffix("已解决"), "已解决 did not list the TODO")
        (try harness.card(todo)).resolveButton.press()
        try harness.settle()
        try require(controller.renderedIDs.contains(todo.id) && controller.resolvedToggle.isHidden, "重新打开 did not return the TODO")

        // The board's 已完成 archive: 完成, then 重新打开 there.
        let materials = MaterialLibraryModel(workspace: harness.workspace, projectID: harness.project.id)
        let board = MacMemoBoardViewController(review: model, materials: materials)
        harness.wire(board.commands)
        let boardWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 640), styleMask: [.titled], backing: .buffered, defer: false)
        boardWindow.isReleasedWhenClosed = false
        boardWindow.contentViewController = board
        defer { boardWindow.close() }
        materials.load()
        try wait { materials.loaded && !materials.busy }
        try require(board.renderedTodoIDs == [todo.id, floating.id], "The board lists \(board.renderedTodoIDs)")
        guard let boardCard = board.todoCards[floating.id] else { throw LabError.message("No board card") }
        try require(boardCard.resolveButton.title == "完成", "The board's card has no 完成")
        boardCard.resolveButton.press()
        try harness.settle()
        try require(board.renderedTodoIDs == [todo.id] && board.archiveToggle.title == "▸ 已完成（1）", "完成 did not archive the TODO")
        board.archiveToggle.performClick(nil)
        try require(board.renderedArchiveIDs == [floating.id], "已完成 does not list the TODO")
        guard let reopen = BindingAcceptance.reviewDescendant(board.view, "board-reopen-\(floating.id)") as? ChipButton else {
            throw LabError.message("No 重新打开 in the archive")
        }
        reopen.press()
        try harness.settle()
        try require(board.renderedTodoIDs == [todo.id, floating.id] && board.renderedArchiveIDs.isEmpty, "The archive did not reopen the TODO")

        // 批注 ↔ 待办 keeps a passage's anchor; a floating TODO stays a TODO.
        mark = try harness.journal.mark()
        try reviewPress(try reviewItem(try harness.card(passage).actionItems, "review-convert"))
        try harness.settle()
        try harness.journal.expect([["field.set comment"]], since: mark, "Converting to a TODO")
        let converted = try harness.comment(passage.id)
        try require(converted.isTodo && converted.targetBlockId == passage.targetBlockId
            && view.binding.store.projection?.comments.first(where: { $0.id == passage.id })?.anchorStatus == .anchored
            && reviewHighlighted(view, at: 3), "Converting lost the anchor")
        try require((try reviewItem(try harness.card(converted).actionItems, "review-convert")).title == "转为批注", "The menu does not offer 转为批注")
        try reviewPress(try reviewItem(try harness.card(converted).actionItems, "review-convert"))
        try harness.settle()
        try require(try harness.comment(passage.id).kind == "note", "转为批注 did not convert back")
        mark = try harness.journal.mark()
        let stay = try reviewItem(try harness.card(floating).actionItems, "review-convert")
        try require(!stay.isEnabled && stay.toolTip?.contains("浮动的待办不能转为批注") == true, "A floating TODO offered 转为批注")
        let refusal = try elementRefused({ (done: @escaping (Result<WorkspaceComment, Error>) -> Void) in
            model.convert(id: floating.id, completion: done)
        }, "Rust made a floating TODO a note")
        try harness.settle()
        try require(refusal == "浮动的待办不能转为批注" && model.status == refusal, "The refusal read \(refusal)")
        try harness.journal.expect([], since: mark, "Refused conversion")

        // 编辑 through the composer; an unchanged body writes nothing.
        mark = try harness.journal.mark()
        controller.commands.edit(try harness.comment(todo.id))
        guard let editor = controller.commands.editor else { throw LabError.message("No editor") }
        try require(editor.text == "核对钟楼", "The editor did not start from the body")
        editor.text = "核对钟楼的高度\n\n和钟声的方向"
        editor.submit()
        try wait { controller.commands.editor == nil && !model.busy }
        try harness.journal.expect([["field.set comment"]], since: mark, "Editing a body")
        try require(try harness.comment(todo.id).bodyText == "核对钟楼的高度\n\n和钟声的方向"
            && (try harness.card(todo)).bodyLabel.stringValue == "核对钟楼的高度\n\n和钟声的方向", "The body was not stored")
        mark = try harness.journal.mark()
        controller.commands.edit(try harness.comment(todo.id))
        controller.commands.editor?.submit()
        try wait { controller.commands.editor == nil && !model.busy }
        try harness.journal.expect([], since: mark, "An unchanged body")
    }

    fileprivate static func reviewDescendant(_ view: NSView, _ identifier: String) -> NSView? {
        if view.accessibilityIdentifier() == identifier { return view }
        for child in view.subviews { if let found = reviewDescendant(child, identifier) { return found } }
        return nil
    }

    // MARK: Delete and locate

    private static func reviewDeleteAndLocate() throws {
        let harness = try ReviewHarness(name: "审阅删除项目")
        defer { harness.cleanup() }
        let chapter = harness.chapters[0], other = harness.chapters[1]
        let view = try harness.openChapter(chapter)
        try harness.type(view, "钟声在雨夜里响起。北塔的灯还亮着。")
        let second: NativeDocumentView = try elementResult { harness.host.split(completion: $0) }
        try elementSettled(harness.host, view, second)
        try require(second.binding.store === view.binding.store, "The split did not share the owner")
        try harness.openReview()
        let controller = harness.controller!, model = harness.model!
        harness.host.activate(pane: 0)
        let passage = try harness.selectionNote(view, range: NSRange(location: 9, length: 2), body: "北塔在哪")
        try require(reviewHighlighted(view, at: 9) && reviewHighlighted(second, at: 9), "The passage note is not highlighted in both views")
        let chapterComments = ChapterCommentsModel()
        chapterComments.bind(view.binding.store)
        try wait { !chapterComments.busy && chapterComments.comments.count == 1 }
        harness.chapterComments = chapterComments
        let pageNote = try harness.compose(kind: "note", body: "整章的批注")
        let elementEndpoint = RelationEndpoint(kind: "element", id: harness.element.id)
        let associated = try harness.compose(kind: "todo", body: "关联到老周") { sheet in
            sheet.removeAssociation(harness.endpoint(chapter))
            AssociationMenu.item(sheet.associationMenu(), elementEndpoint)?.press()
        }

        // 定位 from another tab (全书 lists the note): the chapter's tab, with the passage selected.
        reviewSegment(controller.scopeControl, 1)
        let otherView = try harness.openChapter(other, pane: 0)
        try require(harness.host.activeView === otherView, "The other chapter is not active")
        (try harness.card(passage)).locateButton.press()
        try wait { harness.located.count == 1 }
        try elementSettled(harness.host, view)
        try require(harness.located == [nil] && harness.host.activeChapter?.id == chapter.id && harness.host.activeView === view
            && view.textView.selectedRange() == NSRange(location: 9, length: 2)
            && (view.textView.string as NSString).substring(with: view.textView.selectedRange()) == "北塔",
            "定位 did not select the passage: \(harness.located) \(view.textView.selectedRange())")
        (try harness.card(pageNote)).locateButton.press()
        try wait { harness.located.count == 2 }
        try require(harness.located.last == .some(nil) && harness.host.activeChapter?.id == chapter.id, "定位 of a page note did not open its chapter")
        var reason: String?? = nil
        harness.host.locate(comment: try harness.comment(associated.id), project: harness.project) { reason = .some($0) }
        try wait { reason != nil }
        try require(reason == .some("浮动待办没有所在的页面。") && !(try harness.card(associated)).locateButton.isEnabled,
            "A floating TODO was locatable")

        // Marked input in the chapter holds the deletion; nothing is written.
        var mark = try harness.journal.mark()
        view.textView.setSelectedRange(NSRange(location: 0, length: 0))
        view.textView.setMarkedText("yuan", selectedRange: NSRange(location: 4, length: 0), replacementRange: NSRange(location: 0, length: 0))
        harness.answer = { _ in .alertFirstButtonReturn }
        controller.commands.confirmDelete(try harness.comment(passage.id))
        try require(model.status == "请先完成输入，并等待正文保存后再删除这条批注。" && model.comment(id: passage.id) != nil,
            "Deletion during marked input was not refused: \(model.status)")
        try harness.journal.expect([], since: mark, "Refused deletion")
        view.textView.insertText("远", replacementRange: NSRange(location: NSNotFound, length: 0))
        try elementSettled(harness.host, view, second)
        mark = try harness.journal.mark()

        // 取消 writes nothing; 删除 removes the note, its highlight and its row.
        harness.answer = { _ in .alertSecondButtonReturn }
        controller.commands.confirmDelete(try harness.comment(passage.id))
        try harness.settle()
        try harness.journal.expect([], since: mark, "Cancelled deletion")
        var asked = ""
        harness.answer = { alert in asked = alert.messageText + alert.informativeText; return .alertFirstButtonReturn }
        controller.commands.confirmDelete(try harness.comment(passage.id))
        try harness.settle()
        try require(asked.hasPrefix("删除这条批注？") && asked.contains("批注高亮也会随之消失"), "The confirmation read \(asked)")
        try harness.journal.expect([["entity.purge comment"]], since: mark, "Deleting a passage note")
        try wait { view.binding.store.projection?.comments.isEmpty == true && !view.binding.hasPendingWork }
        try elementSettled(harness.host, view, second)
        try require(!reviewHighlighted(view, at: 10) && !reviewHighlighted(second, at: 10) && model.comment(id: passage.id) == nil
            && !controller.renderedIDs.contains(passage.id), "The deleted note stayed highlighted or listed")
        try wait { !chapterComments.busy && chapterComments.comments.map(\.id) == [pageNote.id] }

        // Typing continues and saves.
        try harness.type(view, "夜深了。", at: 0)
        try require(view.binding.state?.saved == true && view.textView.string == "夜深了。远钟声在雨夜里响起。北塔的灯还亮着。",
            "Typing after the deletion did not save: \(view.textView.string)")

        // An associated TODO goes with its relation in one original.
        mark = try harness.journal.mark()
        harness.answer = { _ in .alertFirstButtonReturn }
        controller.commands.confirmDelete(try harness.comment(associated.id))
        try harness.settle()
        try harness.journal.expect([["entity.purge entity-relation", "entity.purge comment"]], since: mark, "Deleting an associated TODO")
        try require(harness.associations.entries(of: associated.endpoint).isEmpty, "The association outlived its TODO")

        // Cold reopen: the text is saved and only the page note remains.
        let closed: Bool = try elementResult { harness.host.close(completion: $0) }
        try require(closed, "The workspace did not close")
        let cold = LabWorkspaceCore(directory: harness.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let core: LabCore = try elementResult { cold.openChapter(projectID: harness.project.id, chapterID: chapter.id, completion: $0) }
        let coldView = NativeDocumentView(core: core)
        coldView.binding.load(); try wait { coldView.binding.state != nil && !coldView.binding.hasPendingWork }
        let comments: [WorkspaceComment] = try elementResult { cold.projectComments(projectID: harness.project.id, completion: $0) }
        let coldAnchors = coldView.binding.state?.projection.comments ?? []
        try require(coldView.textView.string == "夜深了。远钟声在雨夜里响起。北塔的灯还亮着。" && !coldAnchors.contains { $0.id == passage.id }
            && coldAnchors.allSatisfy { $0.locatableRange == nil } && !reviewHighlighted(coldView, at: 10)
            && comments.map(\.id) == [pageNote.id], "Cold reopen differs: \(coldView.textView.string) \(comments.map(\.bodyText)) \(coldAnchors)")
        try require(coldView.binding.detach(), "The cold view did not detach")
        try wait { !cold.hasPendingDocuments }
        let _: Bool = try elementResult { cold.close(completion: $0) }
    }

    // MARK: 关联

    private static func reviewAssociations() throws {
        let harness = try ReviewHarness(name: "关联合成项目")
        defer { harness.cleanup() }
        let chapter = harness.chapters[0]
        try harness.openReview()
        try require(harness.model.focus == nil && harness.model.effectiveScope == .project, "No tab should mean 全书")
        let todo = try harness.compose(kind: "todo", body: "整理伏笔")
        try require(todo.isFloating && harness.associations.entries(of: todo.endpoint).isEmpty, "A TODO without a page was associated")
        let targets = [harness.endpoint(chapter), RelationEndpoint(kind: "node", id: harness.drift.id),
                       RelationEndpoint(kind: "element", id: harness.element.id), RelationEndpoint(kind: "category", id: harness.category.id),
                       RelationEndpoint(kind: "storyline", id: harness.storyline.id)]
        for target in targets {
            let mark = try harness.journal.mark()
            try reviewPress(try reviewItem(try harness.card(todo).actionItems, "review-associate-\(target.kind)-\(target.id)"))
            try harness.settle()
            try harness.journal.expect([["entity.create entity-relation"]], since: mark, "Associating \(target.kind)")
        }
        try require((try harness.card(todo)).chips.labels == ["章节 · 雨夜", "漂流 · 旧信", "设定 · 老周", "分类 · 人物", "故事线 · 主线"],
            "The chips read \((try harness.card(todo)).chips.labels)")
        try require((try? reviewItem(try harness.card(todo).actionItems, "review-associate-node-\(chapter.id)")) == nil
            && (try? reviewItem(try harness.card(todo).actionItems, "review-associate-node-\(harness.chapters[1].id)")) != nil,
            "关联 still offers an associated chapter or lost the other one")
        var mark = try harness.journal.mark()
        guard let chip = (try harness.card(todo)).chips.chip(targets[4]) else { throw LabError.message("No storyline chip") }
        chip.removeButton.press()
        try harness.settle()
        try harness.journal.expect([["entity.purge entity-relation"]], since: mark, "Removing an association")
        try require((try harness.card(todo)).chips.labels.count == 4, "The chip did not leave")

        // A library item: 关联 from its menu, chips on its card.
        let materials = MaterialLibraryModel(workspace: harness.workspace, projectID: harness.project.id)
        let library = MacMaterialLibraryViewController(model: materials)
        library.associations = harness.associations
        let libraryWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 640), styleMask: [.titled], backing: .buffered, defer: false)
        libraryWindow.isReleasedWhenClosed = false
        libraryWindow.contentViewController = library
        defer { libraryWindow.close() }
        materials.load()
        try wait { materials.loaded && !materials.busy }
        var note: WorkspaceMaterialItem?
        materials.createText(title: "雨声素材", body: "屋檐\n石阶") { note = try? $0.get() }
        try wait { note != nil && !materials.busy }
        library.view.layoutSubtreeIfNeeded()
        let item = note!
        mark = try harness.journal.mark()
        try reviewPress(try reviewItem(library.menuItems(for: item), "associate-material-element-\(harness.element.id)"))
        try harness.settle()
        try harness.journal.expect([["entity.create entity-relation"]], since: mark, "Associating a library item")
        library.view.layoutSubtreeIfNeeded()
        guard let card = library.card(itemID: item.id) else { throw LabError.message("No material card") }
        try require(card.chips.labels == ["设定 · 老周"] && !card.chips.isHidden
            && library.tableView(library.table, heightOfRow: 0) == MacMaterialLibraryViewController.cardHeight + MaterialCardView.chipsHeight,
            "The material card does not show its association")

        // Pages' 关系 sections leave 关联 out.
        let _: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, element: harness.element, completion: $0) }
        try elementSettled(harness.host)
        guard let page = harness.host.retainedElementPage(pane: 0, scope: ElementScope(projectID: harness.project.id, elementID: harness.element.id)) else {
            throw LabError.message("No element page")
        }
        try wait { harness.associations.relations.loaded && !harness.associations.relations.busy }
        try require(page.relationsView.entries.isEmpty && harness.associations.relations.library.relations.filter { $0.to.key == "element:\(harness.element.id)" }.count == 2,
            "The element's 关系 section lists 关联")

        // Names follow a rename.
        let renamed = try elementResult { (done: @escaping (Result<WorkspaceElementReply<WorkspaceElement>, Error>) -> Void) in
            harness.workspace.updateElement(projectID: harness.project.id, elementID: harness.element.id,
                                            changes: WorkspaceElementChanges(name: "周叔"), completion: done)
        }
        harness.host.applyElementLibrary(projectID: harness.project.id, library: renamed.library)
        try harness.settle()
        library.view.layoutSubtreeIfNeeded()
        try require((try harness.card(todo)).chips.labels.contains("设定 · 周叔") && library.card(itemID: item.id)?.chips.labels == ["设定 · 周叔"],
            "Chips did not follow the rename")

        // Cold relaunch: associations stay.
        let closed: Bool = try elementResult { harness.host.close(completion: $0) }
        try require(closed, "The workspace did not close")
        let cold = LabWorkspaceCore(directory: harness.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let relations: WorkspaceRelationLibrary = try elementResult { cold.relationLibrary(projectID: harness.project.id, completion: $0) }
        let associationType = relations.types.first { $0.systemKey == "generic-association" }?.id
        let kept = relations.relations.filter { $0.relationTypeId == associationType }
        try require(kept.filter { $0.from == todo.endpoint }.map(\.to) == Array(targets.prefix(4))
            && kept.filter { $0.fromKind == "library_item" }.map(\.to) == [RelationEndpoint(kind: "element", id: harness.element.id)],
            "关联 did not survive the relaunch: \(kept.map { "\($0.from.key)→\($0.to.key)" })")
        let _: Bool = try elementResult { cold.close(completion: $0) }
    }

    // MARK: 备忘与素材

    private static func reviewBoardFiltersAndReorder() throws {
        let harness = try ReviewHarness(name: "看板合成项目", entities: false)
        defer { harness.cleanup() }
        try harness.openReview()
        let model = harness.model!
        let materials = MaterialLibraryModel(workspace: harness.workspace, projectID: harness.project.id)
        let board = MacMemoBoardViewController(review: model, materials: materials)
        harness.wire(board.commands)
        let boardWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 640), styleMask: [.titled, .resizable],
                                   backing: .buffered, defer: false)
        boardWindow.isReleasedWhenClosed = false
        boardWindow.contentViewController = board
        defer { boardWindow.close() }
        materials.load()
        try wait { materials.loaded && !materials.busy }
        func settled() throws {
            try wait { !materials.busy && !model.busy }
            board.view.layoutSubtreeIfNeeded()
        }
        var created: WorkspaceMaterialItem?
        for title in ["甲", "乙"] {
            created = nil
            materials.createText(title: title, body: "\(title)的片段") { created = try? $0.get() }
            try wait { created != nil && !materials.busy }
        }
        created = nil
        materials.createLink(title: "丙", url: "https://example.org/rain") { created = try? $0.get() }
        try wait { created != nil && !materials.busy }
        let sources = harness.root.appendingPathComponent("sources", isDirectory: true)
        try FileManager.default.createDirectory(at: sources, withIntermediateDirectories: true)
        let png = sources.appendingPathComponent("丁.png")
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 24, pixelsHigh: 16, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        try rep.representation(using: .png, properties: [:])!.write(to: png)
        let pdf = sources.appendingPathComponent("戊.pdf")
        var box = CGRect(x: 0, y: 0, width: 200, height: 200)
        guard let context = CGContext(pdf as CFURL, mediaBox: &box, nil) else { throw LabError.message("No PDF context") }
        context.beginPDFPage(nil); context.fill(CGRect(x: 20, y: 20, width: 40, height: 40)); context.endPDFPage(); context.closePDF()
        var imported: [WorkspaceMaterialItem]?
        materials.importFiles([png, pdf]) { imported = $0 }
        try wait { imported != nil && !materials.busy }
        try require(imported?.count == 2, "The image and PDF were not imported")
        for body in ["整理北塔线索", "补齐时间线"] {
            let _: WorkspaceComment = try elementResult { model.create(kind: "todo", onFocus: false, body: body, priority: nil, completion: $0) }
        }
        try settled()
        let titles = { materials.items.map(\.title) }
        try require(titles() == ["甲", "乙", "丙", "丁", "戊"], "The library order is \(titles())")
        let chipTitles = MacMemoBoardViewController.kinds.map { board.kindButtons[$0.kind]?.title ?? "" }
        try require(chipTitles == ["待办 2", "图片 1", "PDF 1", "链接 1", "文字 2"] && board.renderedTodoIDs.count == 2
            && board.library.items.map(\.title) == titles() && board.showsTodoColumn, "The board chips read \(chipTitles)")

        // Kind chips hide and show kinds.
        func toggle(_ kind: String) {
            guard let button = board.kindButtons[kind] else { return }
            button.state = button.state == .on ? .off : .on
            button.sendAction(button.action, to: button.target)
        }
        toggle("url"); toggle("todo")
        try require(board.library.items.map(\.title) == ["甲", "乙", "丁", "戊"] && !board.showsTodoColumn
            && board.kindButtons["url"]?.state == .off, "Hiding 链接 and 待办 did not filter")
        toggle("todo")
        try require(board.showsTodoColumn, "待办 did not show again")

        // A drag in the filtered list places the item among all items.
        var mark = try harness.journal.mark()
        guard let dragged = board.library.dragPasteboard(row: 3) else { throw LabError.message("No drag for 戊") }
        try require(board.library.dropReorder(from: dragged, row: 0), "The drop was refused")
        try settled()
        let written = try harness.journal.originals(since: mark)
        try require(written.count == 1 && !written[0].isEmpty && written[0].allSatisfy { $0.hasPrefix("order.") && $0.hasSuffix(" library-item") },
            "The move wrote \(written)")
        try require(titles() == ["戊", "甲", "乙", "丙", "丁"] && board.library.items.map(\.title) == ["戊", "甲", "乙", "丁"],
            "The drag moved to \(titles())")
        // A drop in its own place writes nothing.
        mark = try harness.journal.mark()
        guard let still = board.library.dragPasteboard(row: 1) else { throw LabError.message("No drag for 甲") }
        board.library.dropReorder(from: still, row: 2)
        try settled()
        try harness.journal.expect([], since: mark, "A drop in place")
        // To the end of the filtered list: after the last shown card.
        guard let toEnd = board.library.dragPasteboard(row: 1) else { throw LabError.message("No drag for 甲") }
        board.library.dropReorder(from: toEnd, row: 4)
        try settled()
        try require(titles() == ["戊", "乙", "丙", "丁", "甲"], "The drag to the end moved to \(titles())")
        toggle("url")
        try require(board.library.items.map(\.title) == titles(), "链接 did not come back in its place")

        // Cold relaunch keeps the order.
        let closed: Bool = try elementResult { harness.host.close(completion: $0) }
        try require(closed, "The workspace did not close")
        let cold = LabWorkspaceCore(directory: harness.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let library: WorkspaceMaterialLibrary = try elementResult { cold.materialLibrary(projectID: harness.project.id, completion: $0) }
        try require(library.items.map(\.title) == ["戊", "乙", "丙", "丁", "甲"] && library.items.map(\.orderKey) == [0, 1, 2, 3, 4],
            "The order did not survive: \(library.items.map(\.title))")
        let _: Bool = try elementResult { cold.close(completion: $0) }
    }

    // MARK: 幕颜色

    private static func reviewActColours() throws {
        let harness = try ReviewHarness(name: "幕颜色合成项目", chapterTitles: [], entities: false)
        defer { harness.cleanup() }
        let workspace = harness.workspace, projectID = harness.project.id, host = harness.host
        var chapters: [WorkspaceChapter] = []
        for (index, words) in [120, 200, 300, 400].enumerated() {
            let imported: WorkspaceImportedEntity = try elementResult {
                workspace.importBlocks(projectID: projectID, title: "颜色章节 \(index + 1)", target: .chapter,
                                       blocks: [.paragraph(String(repeating: "雨", count: words))], completion: $0)
            }
            guard case .chapter(let chapter) = imported else { throw LabError.message("Import did not create a chapter") }
            chapters.append(chapter)
        }
        let first: WorkspaceAct = try elementResult { workspace.createAct(projectID: projectID, chapterID: chapters[1].id, completion: $0) }
        let second: WorkspaceAct = try elementResult { workspace.createAct(projectID: projectID, chapterID: chapters[3].id, completion: $0) }

        // The 整书大纲 and 全书长卷 wired as AppDelegate wires them.
        let outline = WorkspaceOutlineModel(workspace: workspace, projectID: projectID)
        let outlineController = BookOutlineViewController(model: outline)
        let outlineWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 560), styleMask: [.titled], backing: .buffered, defer: false)
        outlineWindow.isReleasedWhenClosed = false
        outlineWindow.contentViewController = outlineController
        defer { outlineWindow.close() }
        let book = WholeBookModel(workspace: workspace, projectID: projectID)
        let bookController = MacWholeBookViewController(project: harness.project, model: book, workspace: workspace, host: host)
        var colourChanges = 0
        bookController.onActColorChanged = { colourChanges += 1; outline.load() }
        host.onWordCounts = { [weak bookController] id, library in if id == projectID { bookController?.applyWordCounts(library) } }
        outline.onEntries = { entries in
            let acts = entries.filter { $0.kind == "act" }
            if book.layout.acts.map(\.color) != acts.map(\.color) { book.load() }
        }
        let bookWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 720), styleMask: [.titled, .resizable],
                                  backing: .buffered, defer: false)
        bookWindow.isReleasedWhenClosed = false
        bookWindow.contentViewController = bookController
        defer { bookWindow.close() }
        host.wordCounts(projectID: projectID)
        outline.load(); book.load()
        func settled() throws {
            try wait {
                !outline.busy && book.loaded && !book.loading && bookController.isSettled && host.wordCounts(projectID: projectID).isIdle
                    && host.wordCountLibrary(projectID: projectID) != nil && !outline.entries.isEmpty
            }
            bookController.view.layoutSubtreeIfNeeded()
        }
        try settled()
        bookController.showStats()
        guard let stats = bookController.statsController else { throw LabError.message("No 统计") }
        let statsWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 640), styleMask: [.titled], backing: .buffered, defer: false)
        statsWindow.isReleasedWhenClosed = false
        statsWindow.contentViewController = stats
        defer { statsWindow.close() }
        stats.reload()
        let color = { (hex: String) in ElementSwatch.color(hex: hex)! }
        let red = color("#E5484D"), green = color("#72C096"), neutral = BookRhythmChart.color(actIndex: nil)
        func check(_ firstHex: String, _ secondHex: String, _ step: String) throws {
            try wait {
                book.layout.acts.map(\.hex) == [firstHex, secondHex] && !outline.busy
                    && outline.actHex(actID: first.id) == firstHex && outline.actHex(actID: second.id) == secondHex
            }
            try settled()
            stats.reload()
            bookController.scroll(toAct: first.id); try settled()
            guard let firstRow = bookController.actRow(first.id) else { throw LabError.message("No separator for the first act") }
            bookController.scroll(toAct: second.id); try settled()
            guard let secondRow = bookController.actRow(second.id) else { throw LabError.message("No separator for the second act") }
            let bars = (0..<4).map { stats.rhythm.color(at: $0) }
            let actButtons = stats.actRows.arrangedSubviews.compactMap { ($0 as? BookStatsActButton)?.act?.hex }
            try require(firstRow.wash.tint == color(firstHex) && secondRow.wash.tint == color(secondHex)
                && stats.actStrip.colors == [color(firstHex), color(secondHex)] && actButtons == [firstHex, secondHex]
                && bars == [neutral, color(firstHex), color(firstHex), color(secondHex)]
                && outline.actHex(actID: first.id) == firstHex && outline.actHex(actID: second.id) == secondHex,
                "\(step): the acts are drawn in \(String(describing: firstRow.wash.tint)) / \(actButtons)")
        }
        try check(BookPalette.act(0), BookPalette.act(1), "The default cycle")

        // 整书大纲 › 幕颜色 › 红.
        var mark = try harness.journal.mark()
        func outlineColour(_ act: WorkspaceAct, _ identifier: String) throws -> NSMenuItem {
            try reviewItem(outlineController.actionItems(entryID: act.id), identifier)
        }
        try reviewPress(try outlineColour(first, "outline-act-color-e5484d"))
        try wait { !outline.busy }
        try harness.journal.expect([["field.set book-act"]], since: mark, "The outline's 幕颜色")
        try require(outline.entries.first { $0.id == first.id }?.color == "#E5484D"
            && outlineController.rowView(entryID: first.id)?.arrangedSubviews.first?.toolTip == "#E5484D", "The outline does not show red")
        try check("#E5484D", BookPalette.act(1), "After the outline's red")
        mark = try harness.journal.mark()
        let checked = try outlineColour(first, "outline-act-color-e5484d")
        try require(checked.state == .on && (try outlineColour(first, "outline-act-color-default")).isEnabled, "The stored colour is not checked")
        try reviewPress(checked)
        try wait { !outline.busy }
        try harness.journal.expect([], since: mark, "The current colour again")

        // The separator's menu: 绿 for the second act.
        guard let separator = bookController.actRow(second.id) else { throw LabError.message("No second separator") }
        let menu = bookController.actMenu(for: separator)
        try require((try reviewItem(menu.items, "whole-book-act-color-default")).isEnabled == false, "恢复默认 was offered without a colour")
        try reviewPress(try reviewItem(menu.items, "whole-book-act-color-72c096"))
        try wait { colourChanges == 1 && !outline.busy }
        try harness.journal.expect([["field.set book-act"]], since: mark, "The separator's 幕颜色")
        try check("#E5484D", "#72C096", "After the separator's green")
        try require(outline.entries.first { $0.id == second.id }?.color == "#72C096", "The outline did not follow the separator")

        // 恢复默认 clears the first act's colour.
        mark = try harness.journal.mark()
        guard let firstSeparator = bookController.actRow(first.id) else { throw LabError.message("No first separator") }
        try reviewPress(try reviewItem(bookController.actMenu(for: firstSeparator).items, "whole-book-act-color-default"))
        try wait { colourChanges == 2 && !outline.busy }
        try harness.journal.expect([["field.set book-act"]], since: mark, "恢复默认")
        try check(BookPalette.act(0), "#72C096", "After 恢复默认")
        _ = red; _ = green

        // Cold relaunch.
        try require(bookController.shutdown(), "The long page did not shut down")
        try wait { bookController.isShutDown }
        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed, "The workspace did not close")
        let cold = LabWorkspaceCore(directory: harness.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let entries: [WorkspaceOutlineEntry] = try elementResult { cold.outline(projectID: projectID, completion: $0) }
        try require(entries.filter { $0.kind == "act" }.map(\.color) == [nil, "#72C096"], "Colours did not survive: \(entries.map(\.color))")
        let _: Bool = try elementResult { cold.close(completion: $0) }
    }

    // MARK: 删除项目

    private static func reviewProjectDeletion() throws {
        let harness = try ReviewHarness(name: "将删的书", entities: true)
        defer { harness.cleanup() }
        let workspace = harness.workspace, host = harness.host, project = harness.project
        let kept: WorkspaceProject = try elementResult { workspace.createProject(name: "留下的书", completion: $0) }
        let settings = LabSettingsStore(directory: workspace.dataDirectory)
        settings.setWritingPlan(WritingPlan(projectWordTarget: 50_000, dailyWordGoal: 800), projectID: project.id)
        let chapter = harness.chapters[0]
        let view = try harness.openChapter(chapter)
        try harness.type(view, "钟声在雨夜里响起。")
        let second: NativeDocumentView = try elementResult { host.split(completion: $0) }
        try elementSettled(host, view, second)
        let _: NativeDocumentView = try elementResult { host.open(project: project, element: harness.element, in: 1, completion: $0) }
        try elementSettled(host)
        try harness.openReview()
        let _: WorkspaceComment = try elementResult { harness.model.create(kind: "todo", onFocus: false, body: "删前的待办", priority: nil, completion: $0) }
        let sources = harness.root.appendingPathComponent("sources", isDirectory: true)
        try FileManager.default.createDirectory(at: sources, withIntermediateDirectories: true)
        let png = sources.appendingPathComponent("塔.png")
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 12, pixelsHigh: 12, bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        try rep.representation(using: .png, properties: [:])!.write(to: png)
        let materials = MaterialLibraryModel(workspace: workspace, projectID: project.id)
        materials.load(); try wait { materials.loaded && !materials.busy }
        var imported: [WorkspaceMaterialItem]?
        materials.importFiles([png]) { imported = $0 }
        try wait { imported != nil && !materials.busy }
        guard let stored = materials.items.first?.fileURL, FileManager.default.fileExists(atPath: stored.path) else {
            throw LabError.message("The image was not stored")
        }

        // The coordinator and sheet as AppDelegate wires them.
        let coordinator = ProjectDeletionCoordinator(workspace: workspace, host: host)
        var book: MacWholeBookViewController?
        var panelsClosed = 0
        coordinator.closePanels = { _, done in
            panelsClosed += 1
            harness.controller.commands.endSheets()
            guard let open = book else { done(nil); return }
            if !open.shutdown(completion: { done(nil) }) { done("全书长卷中还有未完成的输入，请等待正文保存后再删除。") }
        }
        coordinator.forgetSettings = { settings.forgetProject($0) }
        let sheet = ProjectDeletionSheet(project: project)
        var outcome: ProjectDeletionCoordinator.Outcome?
        sheet.onConfirm = { done in
            coordinator.delete(project) { result in
                switch result {
                case .success(let value): outcome = value; done(nil)
                case .failure(let error): done(error)
                }
            }
        }
        var finished = false
        sheet.onFinish = { finished = true }
        var summary: ProjectDeletionSummary?
        ProjectDeletionSummary.load(workspace: workspace, projectID: project.id) { summary = $0; sheet.show($0) }
        try wait { summary != nil }
        try require(sheet.summaryLabel.stringValue == "将永久删除：2 个章节、1 条漂流、1 个设定、1 个分类、1 条故事线、1 条批注与待办、1 个素材（连同复制到本地素材库的文件），以及它们的关系、关联、回收站中的内容、历史版本和写作计划。",
            "The sheet reads \(sheet.summaryLabel.stringValue)")

        // Only the exact name enables 删除项目.
        var mark = try harness.journal.mark()
        try require(!sheet.deleteButton.isEnabled, "删除项目 was enabled before typing")
        sheet.type("将删")
        try require(!sheet.deleteButton.isEnabled, "A partial name enabled 删除项目")
        sheet.confirm()
        try require(sheet.errorMessage == "输入的名称与项目名称不一致，项目未删除。" && outcome == nil && panelsClosed == 0, "A wrong name was not refused")
        sheet.type("将删的书 ")
        try require(!sheet.deleteButton.isEnabled, "A name with a trailing space enabled 删除项目")
        sheet.type("将删的书")
        try require(sheet.deleteButton.isEnabled && sheet.errorMessage == nil, "The exact name did not enable 删除项目")

        // Marked input in a tab stops it before anything is written.
        view.textView.setSelectedRange(NSRange(location: 0, length: 0))
        view.textView.setMarkedText("ye", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: 0, length: 0))
        sheet.confirm()
        try wait { !sheet.isDeleting }
        try require(sheet.errorMessage?.contains("无法关闭") == true && sheet.errorMessage?.hasSuffix("项目未删除。") == true
            && outcome == nil && !finished && host.hasTabs(projectID: project.id), "Marked input did not stop deletion: \(sheet.errorMessage ?? "")")
        try harness.journal.expect([], since: mark, "Deletion held by marked input")
        view.textView.insertText("夜", replacementRange: NSRange(location: NSNotFound, length: 0))
        try elementSettled(host, view, second)

        // The 全书长卷 and an owner outside the tabs.
        let bookModel = WholeBookModel(workspace: workspace, projectID: project.id)
        let bookController = MacWholeBookViewController(project: project, model: bookModel, workspace: workspace, host: host)
        book = bookController
        let bookWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 720), styleMask: [.titled, .resizable],
                                  backing: .buffered, defer: false)
        bookWindow.isReleasedWhenClosed = false
        bookWindow.contentViewController = bookController
        defer { bookWindow.close() }
        host.wordCounts(projectID: project.id)
        bookModel.load()
        try wait { bookModel.loaded && bookController.isSettled && !bookController.attachedChapterIDs.isEmpty }
        let driftScope = DriftScope(projectID: project.id, driftID: harness.drift.id)
        let outside: LabCore = try elementResult { workspace.openDrift(projectID: project.id, driftID: driftScope.driftID, completion: $0) }
        _ = outside
        try require(workspace.hasOpenDocument(.drift(driftScope)) && !host.hasTab(.drift(driftScope)), "The outside owner is not open")
        mark = try harness.journal.mark()
        sheet.confirm()
        try wait { !sheet.isDeleting }
        try require(sheet.errorMessage == "请先关闭这个项目里打开的章节和页面，再删除项目" && outcome == nil && bookController.isShutDown
            && !host.hasTabs(projectID: project.id), "Rust's refusal read \(sheet.errorMessage ?? "")")
        try harness.journal.expect([], since: mark, "Deletion refused by Rust")
        let listed: [WorkspaceProject] = try elementResult { workspace.projects(completion: $0) }
        try require(Set(listed.map(\.id)) == [project.id, kept.id] && FileManager.default.fileExists(atPath: stored.path),
            "A refused deletion removed something: \(listed.map(\.name)) \(FileManager.default.fileExists(atPath: stored.path))")
        let _: Bool = try elementResult { workspace.closeDrift(projectID: project.id, driftID: driftScope.driftID, completion: $0) }

        // Tabs opened again close first; then the project goes.
        let reopened = try harness.openChapter(chapter)
        try harness.type(reopened, "又一句。")
        try require(host.hasTabs(projectID: project.id), "No tab to close")
        mark = try harness.journal.mark()
        sheet.confirm()
        try wait { !sheet.isDeleting }
        guard let result = outcome else { throw LabError.message("Deletion failed: \(sheet.errorMessage ?? "")") }
        try harness.journal.expect([["sync-generation.purge sync-generation"]], since: mark, "Deleting the project")
        try require(finished && result.next == kept && !result.created && result.projects == [kept] && result.deletion.projectId == project.id
            && result.deletion.assetIds.count == 1 && !host.hasTabs(projectID: project.id) && host.paneCount >= 1
            && !FileManager.default.fileExists(atPath: stored.path) && settings.writingPlan(projectID: project.id) == WritingPlan(),
            "The deletion outcome differs")
        let reloaded = LabSettingsStore(directory: workspace.dataDirectory)
        try require(reloaded.writingPlan(projectID: project.id) == WritingPlan(), "settings.json kept the deleted project's plan")

        // Cold relaunch without it.
        let closed: Bool = try elementResult { host.close(completion: $0) }
        try require(closed, "The workspace did not close")
        let cold = LabWorkspaceCore(directory: harness.directory)
        let coldProjects: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        try require(coldProjects == [kept], "The deleted project came back: \(coldProjects.map(\.name))")

        // The last project is replaced by a new empty one.
        let (coldWindow, coldHost) = elementHost(cold)
        defer { coldWindow.close() }
        let last = ProjectDeletionCoordinator(workspace: cold, host: coldHost)
        let replaced: ProjectDeletionCoordinator.Outcome = try elementResult { last.delete(kept, completion: $0) }
        let remaining: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        try require(replaced.created && replaced.next?.name == ProjectDeletionCoordinator.replacementName && replaced.projects.count == 1
            && remaining == replaced.projects, "The last project was not replaced: \(remaining.map(\.name))")
        let chaptersLeft: [WorkspaceChapter] = try elementResult { cold.chapters(projectID: replaced.next!.id, completion: $0) }
        try require(chaptersLeft.isEmpty, "The new project is not empty")
        let _: Bool = try elementResult { cold.close(completion: $0) }
    }
}
