import AppKit

/// 页面统计, the 大纲轨道 and the scrollbar markers through the real tab
/// host, pages, editors, the Rust workspace and SQLite, with synthetic prose
/// whose statistics are computed by hand below. Nothing is shown on screen.
extension BindingAcceptance {
    static let readingAidsCases = [
        "AppKit 统计 of a chapter (from its header button) and of a drift (from 视图 › 页面统计) shows the place in the book (第 2 章 / 共 3 章 and its act), canonical words, paragraphs, sentences (CJK and Latin ends, an ellipsis mid-paragraph and at its end), 对白比 over “”, 「」 and straight quotes, the elements the body links with counts (most first; a click opens the element), the chapters and drifts it cites and the bodies that cite it, all as computed by hand, reading every body without opening an owner or writing to the journal",
        "AppKit 统计 of an element (chapters and drifts it appears in with counts, first and last appearance in book order), a category (设定 mentioned and never mentioned, most mentioned) and a storyline (chapters and words by status, core elements) matches hand-computed values and writes nothing",
        "AppKit 大纲轨道 lists a chapter's headings by level and the fixed sections of element, storyline and category pages before 正文, highlights the heading at the top of the prose while it scrolls, scrolls to a heading (the caret there) or brings a section into view on a click, follows a new heading, and is shown or hidden per page kind from 视图, kept in settings.json through a cold relaunch",
        "AppKit scrollbar markers tick open notes and TODOs at their anchors' heights in both panes, follow typing above them, a note turned into a TODO, a resolve and a delete, select the anchor on a click, and the 全书长卷's rows have none",
        "AppKit a pending revision of the writing assistant is ticked at the text it would replace, a click selects that text, and 拒绝 removes the tick",
        "AppKit 便笺栏: 放入便笺栏 in a note's ⋯ in 审阅 pins it to its page's margin (a floating TODO offers none), several stack with the newest on top and 展开 spreads them, a card opens its note and selects a passage's text, a changed body and a resolve show on the card, a deleted note leaves, 移出 and 清空便笺栏 unpin, and the pins and 展开 are kept per page in settings.json through a cold relaunch",
    ]

    static let readingAidsMarkerLayoutCase = "AppKit scrollbar ticks are measured (laying the text out) only when the ticks, the strip or the column change or much of the text does: a typing pause reuses the measured positions while each tick's anchor still follows the text, and a new note measures again"

    static func readingAidsAcceptance() throws -> [String] {
        let saved = (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay, WordCountModel.refreshDelay, NativeDocumentView.markerDelay)
        defer {
            (DocumentStore.entityLinkDelay, MacChapterWorkspace.backlinkDelay, WordCountModel.refreshDelay, NativeDocumentView.markerDelay) = saved
        }
        DocumentStore.entityLinkDelay = 0.05
        MacChapterWorkspace.backlinkDelay = 0.05
        WordCountModel.refreshDelay = 0.05
        NativeDocumentView.markerDelay = 0.01
        let typography = DocumentStyle.typography
        DocumentStyle.typography = .standard
        defer { DocumentStyle.typography = typography }
        try raStatistics()
        try raRail()
        try raMarkers()
        try raProposals()
        try raStickyNotes()
        return readingAidsCases + [readingAidsMarkerLayoutCase]
    }

    // MARK: Harness

    private final class RAHarness {
        let root: URL
        let directory: URL
        let journal: JournalProbe
        private(set) var workspace: LabWorkspaceCore
        private(set) var settings: LabSettingsStore
        private(set) var window: NSWindow
        private(set) var host: MacChapterWorkspace

        init(root existing: URL? = nil) throws {
            root = existing ?? FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            directory = root.appendingPathComponent("apple-native-lab")
            journal = JournalProbe(directory: directory)
            workspace = LabWorkspaceCore(directory: directory)
            settings = LabSettingsStore(directory: root)
            (window, host) = BindingAcceptance.elementHost(workspace)
            let workspace = self.workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(existing != nil || listed.isEmpty, "The reading-aids fixture was not isolated")
            host.railSettings = settings
            host.listFilterSettings = settings
        }

        func result<T>(file: String = #fileID, line: Int = #line, _ run: (LabWorkspaceCore, @escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
            let workspace = self.workspace
            do { return try BindingAcceptance.elementResult { run(workspace, $0) } } catch {
                throw LabError.message("\(file):\(line): \(error.localizedDescription)")
            }
        }

        func chapter(_ project: WorkspaceProject, _ title: String, _ blocks: [BookImportBlock]) throws -> WorkspaceChapter {
            let imported: WorkspaceImportedEntity = try result {
                $0.importBlocks(projectID: project.id, title: title, target: .chapter, blocks: blocks, completion: $1)
            }
            guard case .chapter(let chapter) = imported else { throw LabError.message("\(title) was not imported as a chapter") }
            return chapter
        }

        /// Opens a page as a tab and waits until its body settled and links.
        @discardableResult
        func open(_ project: WorkspaceProject, _ target: WorkspaceTabTarget, in pane: Int? = nil) throws -> NativeDocumentView {
            let host = self.host
            let view: NativeDocumentView = try BindingAcceptance.elementResult { done in
                switch target {
                case .chapter(let chapter): host.open(project: project, chapter: chapter, in: pane, completion: done)
                case .element(let element): host.open(project: project, element: element, in: pane, completion: done)
                case .storyline(let storyline): host.open(project: project, storyline: storyline, in: pane, completion: done)
                case .drift(let drift): host.open(project: project, drift: drift, in: pane, completion: done)
                case .category(let category): host.open(project: project, category: category, in: pane, completion: done)
                }
            }
            try settled(view)
            return view
        }

        func settled(_ views: NativeDocumentView..., file: String = #fileID, line: Int = #line) throws {
            try BindingAcceptance.wait(file: file, line: line) {
                !self.host.isBusy && views.allSatisfy {
                    $0.binding.state != nil && !$0.binding.hasPendingWork && !$0.binding.store.hasScheduledLinks
                        && !$0.binding.store.isLinking && $0.deferredFormat == nil && !$0.hasScheduledMarkers
                }
            }
            window.contentView?.layoutSubtreeIfNeeded()
        }

        func close(_ scope: DocumentScope, pane: Int = 0) throws {
            let host = self.host
            let closed: Bool = try BindingAcceptance.elementResult { host.closeTab(pane: pane, scope: scope, completion: $0) }
            try BindingAcceptance.require(closed, "A tab did not close")
        }

        func type(_ view: NativeDocumentView, _ text: String, at location: Int? = nil) throws {
            let at = location ?? (view.textView.string as NSString).length
            view.textView.setSelectedRange(NSRange(location: at, length: 0))
            view.textView.insertText(text, replacementRange: NSRange(location: at, length: 0))
            try settled(view)
        }

        func settingsJSON() throws -> [String: Any] {
            (try JSONSerialization.jsonObject(with: Data(contentsOf: settings.fileURL)) as? [String: Any]) ?? [:]
        }

        /// A cold relaunch: the host and workspace close, then a new
        /// workspace, settings store (read from disk), window and host open.
        func relaunch() throws {
            try shut()
            workspace = LabWorkspaceCore(directory: directory)
            let workspace = self.workspace
            let _: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            settings = LabSettingsStore(directory: root)
            (window, host) = BindingAcceptance.elementHost(workspace)
            host.railSettings = settings
            host.listFilterSettings = settings
        }

        func shut() throws {
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            let host = self.host
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "The reading-aids workspace failed to close")
            window.close()
        }

        func remove() { try? FileManager.default.removeItem(at: root) }
    }

    private static func raPress(_ button: NSButton?) throws {
        guard let button else { throw LabError.message("No button to press") }
        button.sendAction(button.action, to: button.target)
    }

    // MARK: 页面统计

    /// The body of 雨夜, with its statistics computed by hand:
    ///
    /// - 段落 5 (the heading is not a paragraph).
    /// - 句子 3 + 1 + 2 + 2 + 1 = 9: A ends at 。, at 。” and at the closing
    ///   ……”; B's …… is mid-paragraph; C ends at 。」 and 。; D at .” (the
    ///   ... and 3.14 are not ends) plus its unended tail; E at 。.
    /// - 对白比 18 / 88 → 20%: characters (no whitespace or quotation
    ///   marks) A 24, B 15, C 7, D 35, E 7; inside quotes A 你来了。 (4) and
    ///   雨还没停…… (6), C 走吧。 (3), D wait. (5).
    /// - 字数 54: ideographs 潮声 2, A 19, B 12, C 5, E 6, and D's 10 Latin tokens.
    /// - Links: 林雾 in A, B and C (3), 北塔 and 老渔夫 in A, 归航 and 旧信 in E.
    private static let rainyBody: [BookImportBlock] = [
        BookImportBlock(kind: .heading, level: 1, text: "潮声", marks: []),
        .paragraph("林雾推开北塔的门。“你来了。”老渔夫说，“雨还没停……”"),
        .paragraph("她没有回答……林雾只是看着海。"),
        .paragraph("「走吧。」林雾说。"),
        .paragraph("He said \"wait.\" Then he left... It was 3.14 km"),
        .paragraph("见归航与旧信。"),
    ]

    private static func raStatistics() throws {
        let harness = try RAHarness()
        defer { harness.remove() }
        let host = harness.host
        let project: WorkspaceProject = try harness.result { $0.createProject(name: "统计合成项目", completion: $1) }
        let people: WorkspaceElementReply<WorkspaceElementCategory> = try harness.result {
            $0.createElementCategory(projectID: project.id, name: "人物", completion: $1)
        }
        let places: WorkspaceElementReply<WorkspaceElementCategory> = try harness.result {
            $0.createElementCategory(projectID: project.id, name: "地点", completion: $1)
        }
        guard let peopleCategory = people.result, let placesCategory = places.result else { throw LabError.message("No categories") }
        func element(_ name: String, in category: WorkspaceElementCategory) throws -> WorkspaceElement {
            let reply: WorkspaceElementReply<WorkspaceElement> = try harness.result {
                $0.createElement(projectID: project.id, categoryID: category.id, name: name, completion: $1)
            }
            guard let element = reply.result else { throw LabError.message("\(name) was not created") }
            return element
        }
        let lin = try element("林雾", in: peopleCategory)
        let fisher = try element("老渔夫", in: peopleCategory)
        _ = try element("阿岚", in: peopleCategory)
        let tower = try element("北塔", in: placesCategory)
        let prologue = try harness.chapter(project, "序章", [.paragraph("雨夜之前。雨夜之后。")])
        let rainy = try harness.chapter(project, "雨夜", rainyBody)
        let homecoming = try harness.chapter(project, "归航", [.paragraph("林雾回来了。")])
        let driftReply: WorkspaceDriftReply<WorkspaceDrift> = try harness.result {
            $0.createDrift(projectID: project.id, title: "旧信", groupID: nil, completion: $1)
        }
        guard let letter = driftReply.result else { throw LabError.message("The drift was not created") }
        let act: WorkspaceAct = try harness.result { $0.createAct(projectID: project.id, chapterID: rainy.id, completion: $1) }
        let _: WorkspaceAct = try harness.result { $0.renameAct(projectID: project.id, actID: act.id, name: "启程", completion: $1) }
        let storyline: WorkspaceStorylineReply<WorkspaceStoryline> = try harness.result {
            $0.createStoryline(projectID: project.id, name: "主线", completion: $1)
        }
        guard let main = storyline.result else { throw LabError.message("No storyline") }
        // The first storyline takes every chapter; 序章 leaves it.
        for chapter in [prologue, rainy, homecoming] {
            let joins = chapter.id != prologue.id
            let _: WorkspaceStorylineReply<WorkspaceChapterStorylines> = try harness.result {
                $0.setChapterStorylines(projectID: project.id, chapterID: chapter.id, storylineIDs: joins ? [main.id] : [],
                                        primary: joins ? main.id : nil, completion: $1)
            }
        }
        let _: WorkspaceNodeMetadata = try harness.result { $0.setNodeStatus(projectID: project.id, nodeID: homecoming.id, status: "finished", completion: $1) }
        host.chaptersChanged(projectID: project.id)
        host.elementsChanged(projectID: project.id)
        host.driftsChanged(projectID: project.id)
        host.storylinesChanged(projectID: project.id)
        try wait { host.elementLibrary(projectID: project.id)?.elements.count == 4 && host.driftLibrary(projectID: project.id) != nil
            && host.storylineLibrary(projectID: project.id) != nil && host.linkDirectory(projectID: project.id) != nil }
        // Every body opens once so its link pass runs, and the drift gets its body.
        for chapter in [prologue, homecoming] {
            try harness.open(project, .chapter(chapter))
            try harness.close(.chapter(ChapterScope(projectID: project.id, chapterID: chapter.id)))
        }
        let letterView = try harness.open(project, .drift(letter))
        try harness.type(letterView, "林雾写信。雨夜里。")
        try harness.close(.drift(DriftScope(projectID: project.id, driftID: letter.id)))
        let view = try harness.open(project, .chapter(rainy))
        try require(view.binding.store.projection?.blocks.flatMap(\.runs).contains { !$0.attributes.links.isEmpty } == true,
                    "雨夜 was not linked")
        host.wordCounts(projectID: project.id, refresh: true)
        try wait { host.wordCountLibrary(projectID: project.id).map { $0.ready && $0.count(nodeID: rainy.id) == 54 && $0.count(nodeID: letter.id) == 7 } == true }

        // 统计 from the chapter's header button.
        let owners = harness.workspace.openDocumentCount
        let mark = try harness.journal.mark()
        guard let page = host.retainedChapterPage(pane: 0, scope: ChapterScope(projectID: project.id, chapterID: rainy.id)) else {
            throw LabError.message("No chapter page")
        }
        try require(page.statsButton.title == "统计" && page.statsButton.accessibilityIdentifier() == "page-stats-button", "The header has no 统计 button")
        try raPress(page.statsButton)
        guard let chapterStats = host.pageStatsController else { throw LabError.message("统计 did not open") }
        try wait { chapterStats.stats.value("page-stats-backlinks") != WordCountText.counting
            && chapterStats.stats.value("page-stats-position") != WordCountText.counting }
        var stats = chapterStats.stats
        try require(stats.title == "统计 · 章节「雨夜」", "The statistics are titled \(stats.title)")
        let values = ["page-stats-position": "第 2 章 / 共 3 章", "page-stats-act": "第一幕「启程」", "page-stats-words": "54 字",
                      "page-stats-paragraphs": "5", "page-stats-sentences": "9", "page-stats-dialogue": "20%",
                      "page-stats-backlinks": "1 章 · 1 条漂流 · 共 3 次"]
        for (id, expected) in values {
            try require(stats.value(id) == expected, "\(id) reads \(stats.value(id) ?? "nothing"), not \(expected)")
        }
        func same(_ rows: [(title: String, detail: String)], _ expected: [(String, String)]) -> Bool {
            rows.count == expected.count && zip(rows, expected).allSatisfy { $0.title == $1.0 && $0.detail == $1.1 }
        }
        try require(same(stats.links(in: "提到的设定"), [("林雾", "3 次"), ("北塔", "1 次"), ("老渔夫", "1 次")]),
                    "提到的设定 lists \(stats.links(in: "提到的设定"))")
        try require(same(stats.links(in: "引用其他"), [("第 3 章「归航」", "1 次"), ("漂流「旧信」", "1 次")]), "引用其他 lists \(stats.links(in: "引用其他"))")
        try require(same(stats.links(in: "被引用"), [("第 1 章「序章」", "2 次"), ("漂流「旧信」", "1 次")]), "被引用 lists \(stats.links(in: "被引用"))")
        try require(chapterStats.linkButtons["page-stats-element-\(lin.id)"]?.title == "林雾"
                    && chapterStats.preferredContentSize.width == 300 && chapterStats.preferredContentSize.height > 80,
                    "The 林雾 row is not a button")
        // Reading every body opened no owner and wrote nothing.
        try require(host.linkIndexBodyReads == 4 && harness.workspace.openDocumentCount == owners, "统计 opened owners or read \(host.linkIndexBodyReads) bodies")
        try harness.journal.expect([], since: mark, "统计 of a chapter")
        // The hand-computed shape, directly.
        let shape = ProseShape(text: view.textView.string, blocks: view.binding.displayedBlocks)
        try require(shape == { var value = ProseShape(); value.paragraphs = 5; value.sentences = 9; value.dialogueCharacters = 18; value.characters = 88; return value }(),
                    "The prose shape is \(shape)")
        try require(ProseShape.sentences(in: "我不知道……") == 1 && ProseShape.sentences(in: "他停了一下……然后走了。") == 1
                    && ProseShape.sentences(in: "“等等……”她说，“别走！”") == 1 && ProseShape.dialogue(in: "『里』「外」").quoted == 2,
                    "Ellipses or nested quotes are counted wrongly")
        // A click opens the element in the chapter's pane.
        try require(chapterStats.open("page-stats-element-\(lin.id)"), "The 林雾 row did not open")
        try wait { host.activeElement?.id == lin.id && !host.isBusy }

        // 统计 of an element, from 视图 › 页面统计.
        try harness.settled(host.activeView!)
        host.showPageStats()
        guard let elementStats = host.pageStatsController, elementStats !== chapterStats else { throw LabError.message("No element statistics") }
        try wait { elementStats.stats.value("page-stats-appearances") != WordCountText.counting }
        stats = elementStats.stats
        try require(stats.title == "统计 · 设定「林雾」" && stats.value("page-stats-appearances") == "2 章 · 1 条漂流 · 共 5 次"
                    && stats.value("page-stats-first") == "第 2 章「雨夜」" && stats.value("page-stats-last") == "第 3 章「归航」",
                    "The element reads \(stats.sections)")
        try require(same(stats.links(in: "出现的章节和漂流"), [("第 2 章「雨夜」", "3 次"), ("第 3 章「归航」", "1 次"), ("漂流「旧信」", "1 次")]),
                    "出现 lists \(stats.links(in: "出现的章节和漂流"))")

        // A category: 健康度 and the most and never mentioned.
        try harness.open(project, .category(peopleCategory))
        host.showPageStats()
        guard let categoryStats = host.pageStatsController, categoryStats !== elementStats else { throw LabError.message("No category statistics") }
        try wait { categoryStats.stats.value("page-stats-health") != WordCountText.counting }
        stats = categoryStats.stats
        try require(stats.value("page-stats-elements") == "3 个" && stats.value("page-stats-health") == "2 / 3 已在正文中出现 · 67%"
                    && same(stats.links(in: "最常提到"), [("林雾", "5 次"), ("老渔夫", "1 次")])
                    && same(stats.links(in: "从未提到"), [("阿岚", "未出现")]), "The category reads \(stats.sections)")
        _ = (fisher, tower)

        // A storyline: chapters and words by status, core elements.
        try require(host.storylineLibrary(projectID: project.id)?.chapters(storylineID: main.id).map(\.chapterId) == [rainy.id, homecoming.id],
                    "主线 holds other chapters")
        try harness.open(project, .storyline(main))
        host.showPageStats()
        guard let storylineStats = host.pageStatsController, storylineStats !== categoryStats else { throw LabError.message("No storyline statistics") }
        do {
            try wait { storylineStats.stats.links(in: "核心设定").count == 3 && storylineStats.stats.value("page-stats-chapters")?.contains("59") == true }
        } catch { throw LabError.message("The storyline statistics stayed \(storylineStats.stats.sections)") }
        stats = storylineStats.stats
        try require(stats.value("page-stats-chapters") == "2 章 · 59 字" && stats.value("page-stats-status-draft") == "1 章 · 54 字"
                    && stats.value("page-stats-status-finished") == "1 章 · 5 字" && stats.value("page-stats-status-discarded") == "0 章 · 0 字"
                    && same(stats.links(in: "核心设定"), [("林雾", "4 次"), ("北塔", "1 次"), ("老渔夫", "1 次")]),
                    "The storyline reads \(stats.sections)")

        // The drift, from 视图 › 页面统计.
        try harness.open(project, .drift(letter))
        host.showPageStats()
        guard let driftStats = host.pageStatsController, driftStats !== storylineStats else { throw LabError.message("No drift statistics") }
        try wait { driftStats.stats.value("page-stats-backlinks") != WordCountText.counting }
        stats = driftStats.stats
        try require(stats.value("page-stats-position") == "漂流（不在全书顺序中）" && stats.value("page-stats-act") == "未绑定幕"
                    && stats.value("page-stats-words") == "7 字" && stats.value("page-stats-paragraphs") == "1"
                    && stats.value("page-stats-sentences") == "2" && stats.value("page-stats-dialogue") == "0%"
                    && stats.value("page-stats-backlinks") == "1 章 · 共 1 次"
                    && same(stats.links(in: "提到的设定"), [("林雾", "1 次")]) && same(stats.links(in: "引用其他"), [("第 2 章「雨夜」", "1 次")]),
                    "The drift reads \(stats.sections)")
        try harness.journal.expect([], since: mark, "统计 of every kind of page")
        // The menu names both commands in 视图.
        guard let viewMenu = MacMainMenu.layout.first(where: { $0.title == "视图" }) else { throw LabError.message("No 视图 menu") }
        try require(viewMenu.items.contains(.pageStats) && viewMenu.items.contains(.outlineRail)
                    && MacMenuCommand.pageStats.title == "页面统计" && MacMenuCommand.outlineRail.title == "大纲轨道", "视图 lacks 页面统计 or 大纲轨道")
        try harness.shut()
    }

    // MARK: 大纲轨道

    private static func raRail() throws {
        let harness = try RAHarness()
        defer { harness.remove() }
        let host = harness.host
        let project: WorkspaceProject = try harness.result { $0.createProject(name: "大纲轨道合成项目", completion: $1) }
        var blocks: [BookImportBlock] = []
        for (title, level) in [("第一节", 1), ("第一节·续", 2), ("第二节", 1)] {
            blocks.append(BookImportBlock(kind: .heading, level: level, text: title, marks: []))
            blocks += (1...40).map { .paragraph("\(title)的第\($0)段，海风从北岸吹来。") }
        }
        let long = try harness.chapter(project, "长章", blocks)
        let view = try harness.open(project, .chapter(long))
        guard let rail = host.rail(pane: 0, scope: .chapter(ChapterScope(projectID: project.id, chapterID: long.id))) else {
            throw LabError.message("The chapter tab has no 大纲轨道")
        }
        try require(!rail.isHidden && rail.items.map(\.title) == ["第一节", "第一节·续", "第二节"] && rail.items.map(\.level) == [1, 2, 1]
                    && rail.emptyText == nil && rail.current == 0, "The rail lists \(rail.items.map(\.title)) with \(String(describing: rail.current))")
        let headings = view.headings()
        // Scrolling: the heading at the top of the prose is current.
        func scroll(to location: Int, below: CGFloat) throws {
            guard let top = view.textView.proseLineTop(at: location), let clip = view.textView.enclosingScrollView?.contentView else {
                throw LabError.message("No line at \(location)")
            }
            clip.scroll(to: NSPoint(x: 0, y: top + below))
            view.textView.enclosingScrollView?.reflectScrolledClipView(clip)
        }
        try scroll(to: headings[1].location, below: -8)
        try require(rail.current == 1, "Scrolling to 第一节·续 highlights \(String(describing: rail.current))")
        try scroll(to: headings[1].location - 200, below: 0)
        try require(rail.current == 0, "Scrolling back into 第一节 highlights \(String(describing: rail.current))")
        func weight(_ button: NSButton) -> CGFloat {
            let font = button.attributedTitle.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
            return ((font?.fontDescriptor.object(forKey: .traits) as? [NSFontDescriptor.TraitKey: Any])?[.weight] as? CGFloat) ?? 0
        }
        try require(weight(rail.buttons[0]) > weight(rail.buttons[1]), "The current item is not set heavier")
        // A click scrolls the heading to the top and puts the caret there.
        rail.choose(1)
        try require(rail.current == 1 && view.textView.selectedRange() == NSRange(location: headings[1].location, length: 0)
                    && view.firstVisibleLocation >= headings[1].location && view.firstVisibleLocation <= headings[1].location + 5,
                    "第一节·续 was not scrolled to the top: \(view.firstVisibleLocation) for \(headings[1].location)")
        rail.choose(2)
        try require(rail.current == 2 && view.textView.selectedRange() == NSRange(location: headings[2].location, length: 0)
                    && view.firstVisibleLocation >= headings[2].location && view.firstVisibleLocation <= headings[2].location + 5,
                    "第二节 was not scrolled to the top: \(view.firstVisibleLocation) for \(headings[2].location)")
        // Scrolled to its very end, the prose's current item is the last heading.
        if let clip = view.textView.enclosingScrollView?.contentView {
            clip.scroll(to: NSPoint(x: 0, y: view.textView.frame.height))
            view.textView.enclosingScrollView?.reflectScrolledClipView(clip)
        }
        try require(view.endVisibleLocation != nil && rail.current == 2, "At the end the rail highlights \(String(describing: rail.current))")
        // A new heading joins the rail.
        let paragraph = headings[2].location + 4
        let target = view.binding.displayedBlocks.first { $0.range.location > headings[2].location }!
        view.binding.format(.heading3, range: NSRange(location: target.range.location, length: 0))
        try harness.settled(view)
        try require(rail.items.map(\.title) == ["第一节", "第一节·续", "第二节", "第二节的第1段，海风从北岸吹来。"] && rail.items.last?.level == 3,
                    "The new heading is not listed: \(rail.items.map(\.title)) (\(paragraph))")

        // Element, storyline and category pages list their sections before 正文.
        let categoryReply: WorkspaceElementReply<WorkspaceElementCategory> = try harness.result {
            $0.createElementCategory(projectID: project.id, name: "人物", completion: $1)
        }
        guard let category = categoryReply.result else { throw LabError.message("No category") }
        let elementReply: WorkspaceElementReply<WorkspaceElement> = try harness.result {
            $0.createElement(projectID: project.id, categoryID: category.id, name: "守灯人", completion: $1)
        }
        guard let keeper = elementReply.result else { throw LabError.message("No element") }
        host.applyElementLibrary(projectID: project.id, library: elementReply.library)
        try harness.open(project, .element(keeper))
        guard let elementRail = host.rail(pane: 0, scope: .element(ElementScope(projectID: project.id, elementID: keeper.id))),
              let elementPage = host.activeElementPage else { throw LabError.message("The element page has no rail") }
        try require(elementRail.items.map(\.title) == ["概述", "字段", "关系", "补丁", "被引用", "正文"] && elementRail.emptyText != nil
                    && elementRail.current == 5, "The element rail lists \(elementRail.items.map(\.title))")
        elementRail.choose(0)
        try require(elementRail.revealedSection == "overview" && elementPage.nameField.currentEditor() != nil, "概述 did not take the name")
        elementRail.choose(5)
        try require(host.activeView?.textView.selectedRange().location == 0 && harness.window.firstResponder === host.activeView?.textView,
                    "正文 did not put the caret in the body")
        let storylineReply: WorkspaceStorylineReply<WorkspaceStoryline> = try harness.result {
            $0.createStoryline(projectID: project.id, name: "主线", completion: $1)
        }
        guard let storyline = storylineReply.result else { throw LabError.message("No storyline") }
        host.applyStorylineLibrary(projectID: project.id, library: storylineReply.library)
        try harness.open(project, .storyline(storyline))
        try require(host.rail(pane: 0, scope: .storyline(StorylineScope(projectID: project.id, storylineID: storyline.id)))?.items.map(\.title)
                    == ["概述", "字段", "章节", "章节模版", "关系", "正文"], "The storyline rail differs")
        try harness.open(project, .category(category))
        try require(host.rail(pane: 0, scope: .category(CategoryScope(projectID: project.id, categoryID: category.id)))?.items.map(\.title)
                    == ["概述", "模板字段", "设定", "关系", "模版", "正文"], "The category rail differs")

        // 视图 › 大纲轨道 hides the rail on every chapter page and only there.
        try harness.open(project, .chapter(long))
        guard let chapterFrame = rail.superview as? MacPageFrame else { throw LabError.message("The rail is not beside its page") }
        let shownX = chapterFrame.page.frame.minX
        try require(host.isActiveOutlineRailShown && shownX >= PageOutlineRail.width, "The page does not sit beside the rail")
        host.toggleOutlineRail()
        chapterFrame.layoutSubtreeIfNeeded()
        try require(!host.isActiveOutlineRailShown && rail.isHidden && chapterFrame.page.frame.minX == 0 && !elementRail.isHidden,
                    "Hiding the chapter rail did not give the page the width, or hid another kind's")
        let json = try harness.settingsJSON()
        try require((json["outlineRails"] as? [String: Bool]) == ["chapter": false], "settings.json keeps \(String(describing: json["outlineRails"]))")
        host.toggleOutlineRail()
        try require(host.isActiveOutlineRailShown && !rail.isHidden && (((try harness.settingsJSON())["outlineRails"] as? [String: Bool]) ?? [:]).isEmpty,
                    "Showing the rail again kept an entry")
        host.toggleOutlineRail()
        try harness.relaunch()
        let reopened = try harness.open(project, .chapter(long))
        _ = reopened
        try require(harness.host.rail(pane: 0, scope: .chapter(ChapterScope(projectID: project.id, chapterID: long.id)))?.isHidden == true
                    && !harness.host.isActiveOutlineRailShown, "The hidden chapter rail came back after a relaunch")
        try harness.open(project, .element(keeper))
        try require(harness.host.rail(pane: 0, scope: .element(ElementScope(projectID: project.id, elementID: keeper.id)))?.isHidden == false,
                    "The element rail was hidden too")
        try harness.shut()
    }

    // MARK: Scrollbar markers

    private static func raMarkers() throws {
        let harness = try RAHarness()
        defer { harness.remove() }
        let host = harness.host
        let project: WorkspaceProject = try harness.result { $0.createProject(name: "标记合成项目", completion: $1) }
        let chapter = try harness.chapter(project, "潮间带", (1...60).map { .paragraph("第\($0)段：潮水退去，礁石露出水面。") })
        let view = try harness.open(project, .chapter(chapter))
        let twin: NativeDocumentView = try BindingAcceptance.elementResult { host.split(completion: $0) }
        try harness.settled(view, twin)
        func note(_ paragraph: Int, _ body: String) throws -> WorkspaceComment {
            let at = (view.textView.string as NSString).range(of: "第\(paragraph)段").location
            guard let revision = view.binding.store.projection?.revision else { throw LabError.message("No projection") }
            let comment: WorkspaceComment = try BindingAcceptance.elementResult {
                view.addComment(body, range: NSRange(location: at, length: 3), revision: revision, completion: $0)
            }
            try harness.settled(view, twin)
            return comment
        }
        let early = try note(3, "开头的批注（合成）"), middle = try note(30, "中间的批注（合成）"), late = try note(55, "结尾的批注（合成）")
        try wait { view.markers.count == 3 && twin.markers.count == 3 }
        for pane in [view, twin] {
            let marks = pane.markers
            try require(marks.map(\.kind) == [.comment, .comment, .comment] && marks.map(\.id) == [early.id, middle.id, late.id]
                        && marks[0].fraction < 0.1 && marks[1].fraction > 0.4 && marks[1].fraction < 0.6 && marks[2].fraction > 0.85
                        && zip(marks, marks.dropFirst()).allSatisfy { $0.fraction < $1.fraction },
                        "The ticks are \(marks.map { ($0.kind.rawValue, $0.fraction) })")
        }
        // The strip hit-tests only its ticks and reports the anchor.
        guard let strip = view.markerStrip else { throw LabError.message("No marker strip") }
        let tick = strip.tickRect(view.markers[1])
        try require(strip.marker(at: NSPoint(x: tick.midX, y: tick.midY))?.id == middle.id && strip.marker(at: NSPoint(x: tick.midX, y: tick.midY + 40)) == nil,
                    "The strip does not find the tick under the mouse")
        try require(strip.frame.maxX <= view.textView.enclosingScrollView!.frame.maxX + 1 && strip.frame.width == ProseMarkerStrip.width,
                    "The strip is not at the prose's trailing edge: \(strip.frame)")

        // 审阅 turns the middle note into a TODO, resolves the last, deletes the first.
        let model = ReviewModel(workspace: harness.workspace, projectID: project.id, associations: host.relations.associations(projectID: project.id))
        model.onChanged = { host.commentsChanged($0, projectID: project.id) }
        model.observe(host) { if model.loaded { host.adoptComments(projectID: project.id, comments: model.comments) } }
        model.load()
        try wait { model.loaded }
        let _: WorkspaceComment = try BindingAcceptance.elementResult { model.convert(id: middle.id, completion: $0) }
        try wait { view.markers.map(\.kind) == [.comment, .todo, .comment] && twin.markers.map(\.kind) == [.comment, .todo, .comment] }
        let _: WorkspaceComment = try BindingAcceptance.elementResult { model.setResolved(id: late.id, resolved: true, completion: $0) }
        try wait { view.markers.map(\.id) == [early.id, middle.id] && twin.markers.map(\.id) == [early.id, middle.id] }
        let _: Void = try BindingAcceptance.elementResult { model.delete(id: early.id, completion: $0) }
        try harness.settled(view, twin)
        try wait { view.markers.map(\.id) == [middle.id] && twin.markers.map(\.id) == [middle.id] }

        // Typing above the TODO moves its tick's anchor with the text.
        let before = view.markers[0].range
        try harness.type(view, "（新增的开头）", at: 0)
        try harness.settled(view, twin)
        try wait { view.markers.first?.range.location == before.location + 7 && twin.markers.first?.range.location == before.location + 7 }
        // A typing pause reuses the measured positions; the anchor follows.
        let layouts = view.markerLayouts, anchored = view.markers[0].range.location
        try harness.type(view, "又", at: 0)
        try harness.settled(view, twin)
        try require(view.markerLayouts == layouts && view.markers.first?.range.location == anchored + 1,
                    "A typing pause measured the ticks again (\(view.markerLayouts - layouts)) or lost the anchor")
        let fresh = try note(10, "新的批注（合成）")
        try wait { view.markers.map(\.id).contains(fresh.id) }
        try require(view.markerLayouts > layouts, "A new note did not measure the ticks")
        // A click selects the anchor.
        try require(view.revealMarker(view.markers[1]) && view.textView.selectedRange() == view.markers[1].range,
                    "The tick did not select its anchor")
        try require((view.textView.string as NSString).substring(with: view.markers[1].range) == "第30", "The tick names other text")
        // The 全书长卷's rows have no strip.
        let row = NativeDocumentView(core: host.activeCore!, minimumTextHeight: 48, growsWithText: true)
        try require(row.markerStrip == nil, "A long page's row has scrollbar markers")
        try require(row.binding.detach(), "The row did not detach")
        try harness.shut()
    }

    // MARK: Proposals

    private static func raProposals() throws {
        let harness = try AgentHarness(titles: ["启程"])
        defer { harness.remove() }
        let controller = harness.controller!
        harness.host.pendingProposals = { _ in controller.pendingRevisions }
        let view = try harness.open(0)
        var text = ""
        for index in 1...30 { text += (index == 1 ? "" : "\n") + "第\(index)段，雾气沉在港口。" }
        text += "\n深夜里钟声响起。"
        try harness.type(view, text)
        AgentStubProtocol.reset([
            AgentSSE.deepseekTools([("call_tick", "revise_chapter",
                #"{"title":"启程","changes":[{"currentText":"钟声响起","revisedText":"钟声悠悠响起"}]}"#)]),
            AgentSSE.deepseekText(["提出了一处修改。"]),
        ])
        try harness.send("让钟声更悠长。")
        try wait { view.markers.count == 1 && !view.hasScheduledMarkers }
        let marker = view.markers[0]
        let expected = (view.textView.string as NSString).range(of: "钟声响起")
        try require(marker.kind == .proposal && marker.range == expected && marker.fraction > 0.85 && marker.label.contains("修改《启程》"),
                    "The proposal tick is \(marker)")
        try require(view.revealMarker(marker) && view.textView.selectedRange() == expected, "The proposal tick did not select its text")
        guard let card = harness.card("call_tick") else { throw LabError.message("No proposal card") }
        card.rejectButton.performClick(nil)
        try wait { view.markers.isEmpty && !view.hasScheduledMarkers }
    }

    // MARK: 便笺栏

    private static func raStickyNotes() throws {
        let harness = try RAHarness()
        defer { harness.remove() }
        var host = harness.host
        let project: WorkspaceProject = try harness.result { $0.createProject(name: "便笺合成项目", completion: $1) }
        let chapter = try harness.chapter(project, "便笺章", (1...20).map { .paragraph("第\($0)段：灯塔在雾里亮着。") })
        let scope = DocumentScope.chapter(ChapterScope(projectID: project.id, chapterID: chapter.id))
        let page = "node:\(chapter.id)"
        let view = try harness.open(project, .chapter(chapter))
        func passage(_ paragraph: Int, _ body: String) throws -> WorkspaceComment {
            let at = (view.textView.string as NSString).range(of: "第\(paragraph)段").location
            guard let revision = view.binding.store.projection?.revision else { throw LabError.message("No projection") }
            let comment: WorkspaceComment = try BindingAcceptance.elementResult {
                view.addComment(body, range: NSRange(location: at, length: ("第\(paragraph)段" as NSString).length), revision: revision, completion: $0)
            }
            try harness.settled(view)
            return comment
        }
        let first = try passage(3, "第三段要再改（合成）"), second = try passage(12, "第十二段的伏笔（合成）")
        // 审阅 as the app wires it.
        let model = ReviewModel(workspace: harness.workspace, projectID: project.id, associations: host.relations.associations(projectID: project.id))
        model.onChanged = { host.commentsChanged($0, projectID: project.id) }
        model.observe(host) { if model.loaded { host.adoptComments(projectID: project.id, comments: model.comments) } }
        model.setFocus(host.activeFocus)
        model.load()
        try wait { model.loaded && model.comments.count == 2 }
        let todo: WorkspaceComment = try BindingAcceptance.elementResult { model.create(kind: "todo", onFocus: true, body: "整章再读一遍（合成）", priority: nil, completion: $0) }
        let floating: WorkspaceComment = try BindingAcceptance.elementResult { model.create(kind: "todo", onFocus: false, body: "浮动的事（合成）", priority: nil, completion: $0) }
        let commands = ReviewCommands(model: model)
        commands.stickyNotes = { host.isStickyPinned($0) }
        commands.onPinSticky = { host.setStickyPinned($0, pinned: $1) }
        func sticky(_ comment: WorkspaceComment) throws -> LibraryMenuItem? {
            guard let current = model.comment(id: comment.id) else { throw LabError.message("\(comment.id) is gone") }
            return commands.menuItems(for: current).first { $0.accessibilityIdentifier() == "review-sticky" } as? LibraryMenuItem
        }
        try require(try sticky(floating) == nil, "A floating TODO offers 放入便笺栏")
        guard let rail = host.stickyRail(pane: 0, scope: scope), let frame = rail.superview as? MacPageFrame else {
            throw LabError.message("The page has no 便笺栏")
        }
        try require(rail.isHidden && !frame.stickyShown, "An empty 便笺栏 shows")
        // Pinning from ⋯: the column appears beside the page.
        guard let pinFirst = try sticky(first), pinFirst.title == "放入便笺栏" else { throw LabError.message("No 放入便笺栏 for a passage note") }
        pinFirst.press()
        frame.layoutSubtreeIfNeeded()
        try require(!rail.isHidden && rail.cards.map(\.id) == [first.id] && rail.cards[0].quote == "第3段" && rail.cards[0].body == "第三段要再改（合成）"
                    && frame.page.frame.maxX <= frame.bounds.width - StickyNoteRail.width, "The pinned note is not beside the page: \(rail.cards)")
        try require(try sticky(first)?.title == "移出便笺栏", "⋯ does not offer 移出便笺栏 for a pinned note")
        try sticky(second)?.press()
        try sticky(todo)?.press()
        // Stacked: the newest on top, the rest counted; 展开 spreads them.
        try require(rail.cards.map(\.id) == [first.id, second.id, todo.id] && rail.cardViews.map(\.card.id) == [todo.id]
                    && !rail.expanded && rail.toggleButton.title == "展开", "The stack shows \(rail.cardViews.map(\.card.id))")
        rail.toggleButton.performClick(nil)
        try require(rail.expanded && rail.cardViews.map(\.card.id) == [first.id, second.id, todo.id] && rail.toggleButton.title == "叠起",
                    "展开 did not spread the cards")
        var stored = harness.settings.stickyNotes(projectID: project.id, page: page)
        try require(stored == StickyNotePage(pinned: [first.id, second.id, todo.id], expanded: true)
                    && ((try harness.settingsJSON())["stickyNotes"] as? [String: [String: Any]])?[project.id]?[page] != nil,
                    "settings.json keeps \(String(describing: stored))")
        // A card opens its note and selects the passage.
        guard let card = rail.cardViews.first(where: { $0.card.id == first.id }) else { throw LabError.message("No card for the first note") }
        card.open()
        try harness.settled(view)
        try wait { (view.textView.string as NSString).substring(with: view.textView.selectedRange()) == "第3段" }
        // Edits, a resolve and a deletion reach the cards.
        let _: WorkspaceComment = try BindingAcceptance.elementResult { model.updateBody(id: second.id, body: "伏笔已经埋好（合成）", completion: $0) }
        let _: WorkspaceComment = try BindingAcceptance.elementResult { model.setResolved(id: todo.id, resolved: true, completion: $0) }
        try wait { rail.cards.first { $0.id == second.id }?.body == "伏笔已经埋好（合成）" && rail.cards.first { $0.id == todo.id }?.kind == "待办 · 已解决" }
        let _: Void = try BindingAcceptance.elementResult { model.delete(id: first.id, completion: $0) }
        try harness.settled(view)
        try wait { rail.cards.map(\.id) == [second.id, todo.id]
            && harness.settings.stickyNotes(projectID: project.id, page: page)?.pinned == [second.id, todo.id] }
        // 移出 and 清空便笺栏.
        rail.cardViews.first { $0.card.id == second.id }?.unpinButton.performClick(nil)
        try require(rail.cards.map(\.id) == [todo.id] && harness.settings.stickyNotes(projectID: project.id, page: page)?.pinned == [todo.id],
                    "移出 left \(rail.cards.map(\.id))")
        try sticky(second)?.press()
        rail.clearButton.performClick(nil)
        frame.layoutSubtreeIfNeeded()
        try require(rail.cards.isEmpty && rail.isHidden && frame.page.frame.maxX == frame.bounds.width
                    && harness.settings.stickyNotes(projectID: project.id, page: page) == nil
                    && ((try harness.settingsJSON())["stickyNotes"] as? [String: Any])?[project.id] == nil, "清空便笺栏 kept notes")
        try require(model.comments.count == 3, "The 便笺栏 changed the notes themselves")
        // Kept through a cold relaunch, stacked as left.
        try sticky(todo)?.press()
        try sticky(second)?.press()
        try harness.relaunch()
        host = harness.host
        try harness.open(project, .chapter(chapter))
        guard let reopened = host.stickyRail(pane: 0, scope: scope) else { throw LabError.message("The reopened page has no 便笺栏") }
        try wait { reopened.cards.map(\.id) == [todo.id, second.id] }
        try require(!reopened.isHidden && !reopened.expanded && reopened.cardViews.map(\.card.id) == [second.id],
                    "The relaunched 便笺栏 shows \(reopened.cardViews.map(\.card.id))")
        stored = harness.settings.stickyNotes(projectID: project.id, page: page)
        try require(stored == StickyNotePage(pinned: [todo.id, second.id], expanded: false), "The stored 便笺栏 is \(String(describing: stored))")
        try harness.shut()
    }
}
