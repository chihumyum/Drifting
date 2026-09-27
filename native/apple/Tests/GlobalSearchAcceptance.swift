import AppKit

/// 全局搜索 (⇧⌘F beyond chapters) through the real search panel controller,
/// the tab host, element/storyline/drift/category pages, the 素材库 list, the
/// Rust workspace and SQLite, wired as AppDelegate wires them. Every name and
/// body is synthetic.
extension BindingAcceptance {
    static func globalSearchAcceptance() throws -> [String] {
        try globalSearchSections()
        try globalSearchOpensAndSelects()
        try globalSearchRefusesStaleAndShowsLimits()
        return [
            "AppKit 全局搜索 lists chapter results, then 章节摘要, 漂流, 设定, 分类, 故事线 and 素材 sections naming each entity and its field (名称, 别名, 摘要, 设定项, 正文, 文字, 备注) with the match emphasised in the preview, reads live page bodies and closed cold bodies without opening owners, and writes nothing to the journal",
            "AppKit 全局搜索 opens element, storyline, drift and category body hits as tabs and selects the match through workspaceResolveEntityHit once the owner is idle, also after text typed before the match and in an open page, opens field hits and a chapter summary as tabs and a material in the 素材库, without authoring history",
            "AppKit 全局搜索 refuses a replaced match and a body whose scope changed with Rust's Chinese reason keeping the selection, refuses a draft in Rust and marked input at selection, lists an unreadable body and truncation explicitly, and discards superseded and cleared queries",
        ]
    }

    // MARK: Harness

    private final class GlobalSearchHarness {
        let root: URL
        let directory: URL
        let workspace: LabWorkspaceCore
        let project: WorkspaceProject
        let journal: JournalProbe
        let window: NSWindow
        let host: MacChapterWorkspace
        /// The last `reveal` outcome: "ok" or the refusal.
        var outcome: String?

        init(name: String) throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            directory = root.appendingPathComponent("apple-native-lab")
            journal = JournalProbe(directory: directory)
            let workspace = LabWorkspaceCore(directory: directory)
            self.workspace = workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(listed.isEmpty, "Global search fixture was not isolated")
            project = try BindingAcceptance.elementResult { workspace.createProject(name: name, completion: $0) }
            (window, host) = BindingAcceptance.elementHost(workspace)
        }

        var projectID: String { project.id }

        func chapter(_ title: String, _ paragraphs: [String]) throws -> WorkspaceChapter {
            let workspace = self.workspace, projectID = self.projectID
            let imported: WorkspaceImportedEntity = try BindingAcceptance.elementResult {
                workspace.importBlocks(projectID: projectID, title: title, target: .chapter, blocks: paragraphs.map { .paragraph($0) }, completion: $0)
            }
            guard case .chapter(let chapter) = imported else { throw LabError.message("Import did not create a chapter") }
            return chapter
        }

        func summary(_ nodeID: String, _ text: String) throws {
            let workspace = self.workspace, projectID = self.projectID
            let _: WorkspaceNodeMetadata = try BindingAcceptance.elementResult {
                workspace.setNodeSummary(projectID: projectID, nodeID: nodeID, summary: text, completion: $0)
            }
        }

        /// Types at the start of a page body and waits for it to settle.
        func type(_ text: String, in view: NativeDocumentView, at location: Int = 0) throws {
            view.textView.setSelectedRange(NSRange(location: location, length: 0))
            view.textView.insertText(text, replacementRange: NSRange(location: location, length: 0))
            try BindingAcceptance.elementSettled(host, view)
        }

        func closeTab(_ scope: DocumentScope) throws {
            let host = self.host
            let _: Bool = try BindingAcceptance.elementResult { host.closeTab(pane: 0, scope: scope, completion: $0) }
        }

        /// A global model after one query has returned.
        func search(_ query: String) throws -> WorkspaceSearchModel {
            let model = WorkspaceSearchModel(workspace: workspace, projectID: projectID, includesEntities: true)
            model.search(query)
            try BindingAcceptance.wait { !model.busy }
            return model
        }

        /// The panel as AppDelegate.showSearch builds it, wired to the tab host.
        func panel(_ model: WorkspaceSearchModel, materials: MacMaterialLibraryViewController? = nil) -> MacWorkspaceSearchViewController {
            let controller = MacWorkspaceSearchViewController(model: model)
            _ = controller.view
            controller.canNavigate = { [weak self] in self?.host.canNavigate == true }
            controller.onOpenEntity = { [weak self] hit in
                guard let self else { return }
                if hit.kind == "library" { materials?.reveal(itemID: hit.id); return }
                self.outcome = nil
                self.host.reveal(searchHit: hit, project: self.project) { [weak self] refusal in self?.outcome = refusal ?? "ok" }
            }
            return controller
        }

        /// Chooses the panel row of a hit and waits for the reveal to finish.
        func open(_ controller: MacWorkspaceSearchViewController, kind: String, field: String, title: String? = nil) throws -> String {
            guard let row = BindingAcceptance.searchRow(controller, kind: kind, field: field, title: title) else {
                throw LabError.message("No \(kind) \(field) row among \(BindingAcceptance.searchCaptions(controller))")
            }
            outcome = nil
            controller.choose(row: row)
            try BindingAcceptance.wait { self.outcome != nil }
            try BindingAcceptance.wait { !self.host.isBusy && self.host.canNavigate }
            return outcome!
        }

        func close() {
            try? BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            var closed = false
            host.close { _ in closed = true }
            try? BindingAcceptance.wait { closed }
            window.close()
            try? FileManager.default.removeItem(at: root)
        }
    }

    /// The fixture's entities: every searchable field and body holds 北塔.
    private struct SearchCorpus {
        var chapter: WorkspaceChapter
        var drift: WorkspaceDrift
        var category: WorkspaceElementCategory
        var element: WorkspaceElement
        var storyline: WorkspaceStoryline
        var material: WorkspaceMaterialItem
    }

    /// Element and category bodies are typed, then closed (cold); the drift
    /// and storyline pages stay open (live owners).
    private static func searchCorpus(_ h: GlobalSearchHarness) throws -> SearchCorpus {
        let workspace = h.workspace, projectID = h.projectID
        let chapter = try h.chapter("序章", ["北塔下的第一夜。"])
        try h.summary(chapter.id, "初到北塔")
        let driftReply: WorkspaceDriftReply<WorkspaceDrift> = try elementResult {
            workspace.createDrift(projectID: projectID, title: "塔下的梦", groupID: nil, completion: $0)
        }
        let drift = try driftReply.result.unwrapSearch("No drift")
        try h.summary(drift.id, "梦见北塔倒塌")
        let categoryReply: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: projectID, name: "北塔地理", completion: $0)
        }
        let category = try categoryReply.result.unwrapSearch("No category")
        let created: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.createElement(projectID: projectID, categoryID: category.id, name: "林岚", completion: $0)
        }
        let element = try created.result.unwrapSearch("No element")
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.updateElement(projectID: projectID, elementID: element.id,
                                    changes: WorkspaceElementChanges(summary: "住在北塔的人", aliases: ["守塔人"]), completion: $0)
        }
        let withFacts: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.setElementFacts(projectID: projectID, elementID: element.id, facts: [WorkspaceFact(key: "居所", value: "北塔顶层")], completion: $0)
        }
        let storylineReply: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult {
            workspace.createStoryline(projectID: projectID, name: "北塔之谜", completion: $0)
        }
        let storyline = try storylineReply.result.unwrapSearch("No storyline")
        let summarized: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult {
            workspace.updateStoryline(projectID: projectID, storylineID: storyline.id, changes: WorkspaceStorylineChanges(summary: "关于北塔的暗线"), completion: $0)
        }
        let text: WorkspaceMaterialReply<WorkspaceMaterialItem> = try elementResult {
            workspace.createMaterialText(projectID: projectID, title: "北塔速写", body: "北塔共九层", completion: $0)
        }
        let item = try text.result.unwrapSearch("No material")
        let noted: WorkspaceMaterialReply<WorkspaceMaterialItem> = try elementResult {
            workspace.updateMaterial(projectID: projectID, itemID: item.id, changes: WorkspaceMaterialChanges(notes: "北塔的备注"), completion: $0)
        }
        let finalElement = try withFacts.library.elements.first { $0.id == element.id }.unwrapSearch("No element in library")
        // Bodies: element and category cold, drift and storyline live.
        let elementView: NativeDocumentView = try elementResult { h.host.open(project: h.project, element: finalElement, completion: $0) }
        try elementSettled(h.host, elementView)
        try h.type("她每夜登上北塔。", in: elementView)
        try h.closeTab(.element(ElementScope(projectID: projectID, elementID: element.id)))
        let categoryView: NativeDocumentView = try elementResult { h.host.open(project: h.project, category: category, completion: $0) }
        try elementSettled(h.host, categoryView)
        try h.type("北塔以北是雪原。", in: categoryView)
        try h.closeTab(.category(CategoryScope(projectID: projectID, categoryID: category.id)))
        let driftView: NativeDocumentView = try elementResult { h.host.open(project: h.project, drift: drift, completion: $0) }
        try elementSettled(h.host, driftView)
        try h.type("北塔的钟声", in: driftView)
        let storylineTarget = try summarized.result.unwrapSearch("No storyline")
        let storylineView: NativeDocumentView = try elementResult {
            h.host.open(project: h.project, storyline: storylineTarget, completion: $0)
        }
        try elementSettled(h.host, storylineView)
        try h.type("北塔之下另有一层。", in: storylineView)
        return SearchCorpus(chapter: chapter, drift: drift, category: category, element: finalElement,
                            storyline: storyline, material: try noted.result.unwrapSearch("No noted material"))
    }

    static func searchRow(_ controller: MacWorkspaceSearchViewController, kind: String, field: String, title: String? = nil) -> Int? {
        controller.rows.firstIndex {
            guard case .entityHit(let hit) = $0 else { return false }
            return hit.kind == kind && hit.field == field && (title == nil || hit.title == title)
        }
    }

    static func searchCaptions(_ controller: MacWorkspaceSearchViewController) -> [String] {
        controller.rows.map {
            switch $0 {
            case .header(let title): return "# \(title)"
            case .chapterHit(let hit): return "章节 \(hit.chapterTitle) \(hit.kind)"
            case .chapterUnavailable(let item): return "! \(item.chapterTitle)"
            case .entityHit(let hit): return MacWorkspaceSearchViewController.caption(hit)
            case .entityUnavailable(let item): return "! \(item.kind) \(item.title)"
            case .truncated: return "…"
            }
        }
    }

    private static func headers(_ controller: MacWorkspaceSearchViewController) -> [String] {
        controller.rows.compactMap { if case .header(let title) = $0 { return title } else { return nil } }
    }

    private static func selectedText(_ view: NativeDocumentView) -> String {
        (view.textView.string as NSString).substring(with: view.textView.selectedRange())
    }

    // MARK: (a) Sections, fields, previews, live and cold bodies

    private static func globalSearchSections() throws {
        let h = try GlobalSearchHarness(name: "全局搜索合成项目")
        defer { h.close() }
        let corpus = try searchCorpus(h)
        let owners = h.workspace.openDocumentCount
        let mark = try h.journal.mark()

        let model = try h.search(" 北塔 ")
        let controller = h.panel(model)
        let found = Set(model.entityHits.map { "\($0.kind).\($0.field)" })
        let expected: Set<String> = ["chapter.summary", "drift.summary", "drift.body", "element.summary", "element.fact", "element.body",
                                     "category.name", "category.body", "storyline.name", "storyline.summary", "storyline.body",
                                     "library.title", "library.text", "library.notes"]
        try require(found == expected, "The global search found \(found.sorted()) instead of \(expected.sorted())")
        try require(model.hits.count == 1 && model.hits[0].kind == "prose" && model.hits[0].chapterId == corpus.chapter.id,
            "The chapter prose result is missing: \(model.hits.map(\.kind))")
        try require(model.entityUnavailable.isEmpty && !model.entityTruncated && model.unavailable.isEmpty,
            "A complete search reported unreadable bodies or truncation")
        try require(model.status == "找到 15 个结果。", "The status reads \(model.status)")
        try require(headers(controller) == ["章节", "章节摘要", "漂流", "设定", "分类", "故事线", "素材"],
            "The sections read \(headers(controller))")
        let captions = searchCaptions(controller)
        for caption in ["序章 · 摘要", "塔下的梦 · 摘要", "塔下的梦 · 正文", "林岚 · 摘要", "林岚 · 设定项", "林岚 · 正文", "北塔地理 · 名称",
                        "北塔地理 · 正文", "北塔之谜 · 名称", "北塔之谜 · 摘要", "北塔之谜 · 正文", "北塔速写 · 名称", "北塔速写 · 文字", "北塔速写 · 备注"] {
            try require(captions.contains(caption), "No row reads \(caption): \(captions)")
        }
        // Rows follow the section order: 章节摘要 comes before 漂流, and so on.
        let order = captions.filter { !$0.hasPrefix("#") && !$0.hasPrefix("章节 ") }.map { caption in
            ["序章": 0, "塔下的梦": 1, "林岚": 2, "北塔地理": 3, "北塔之谜": 4, "北塔速写": 5][String(caption.split(separator: " ")[0])] ?? -1
        }
        try require(order == order.sorted() && !order.contains(-1), "Rows are not grouped by section: \(captions)")
        // The fact preview shows key and value; the match is emphasised.
        guard let factRow = searchRow(controller, kind: "element", field: "fact"),
              case .entityHit(let fact) = controller.rows[factRow] else { throw LabError.message("No fact row") }
        try require(fact.preview == "居所：北塔顶层" && fact.match == nil && fact.scope == nil, "The fact hit reads \(fact.preview)")
        guard let cell = controller.tableView(controller.table, viewFor: nil, row: factRow) as? NSTextField else {
            throw LabError.message("The fact row has no label")
        }
        let shown = cell.attributedStringValue
        let at = (shown.string as NSString).range(of: "北塔")
        try require(shown.string == "林岚 · 设定项\n居所：北塔顶层" && at.location != NSNotFound, "The fact row reads \(shown.string)")
        let emphasised = shown.attribute(.backgroundColor, at: at.location + 1, effectiveRange: nil) != nil
            && shown.attribute(.foregroundColor, at: at.location, effectiveRange: nil) as? NSColor == .labelColor
        let plain = shown.attribute(.backgroundColor, at: at.location - 1, effectiveRange: nil) == nil
        try require(emphasised && plain, "The match is not emphasised in the preview")
        try require(WorkspaceSearchText.matches(of: "ALPHA", in: "起🙂alpha 与 Alpha") == [NSRange(location: 3, length: 5), NSRange(location: 11, length: 5)],
            "Emphasis does not match case-insensitively in UTF-16")
        // Body hits carry a scope and anchors; field hits do not.
        for hit in model.entityHits where hit.field == "body" {
            try require(hit.scope != nil && hit.match?.matchedText == "北塔", "The \(hit.kind) body hit lacks its anchors")
        }
        // Other fields: 别名, and 名称 of an element and a drift.
        let alias = try h.search("守塔")
        try require(alias.entityHits.map { "\($0.kind).\($0.field).\($0.title)" } == ["element.alias.林岚"], "The alias search found \(alias.entityHits.map(\.field))")
        let names = try h.search("林岚")
        try require(names.entityHits.contains { $0.kind == "element" && $0.field == "name" }, "The element name was not found")
        let driftTitle = try h.search("塔下的梦")
        try require(driftTitle.entityHits.contains { $0.kind == "drift" && $0.field == "title" }
            && h.panel(driftTitle).rows.contains { if case .entityHit(let hit) = $0 { return MacWorkspaceSearchViewController.caption(hit) == "塔下的梦 · 名称" }; return false },
            "The drift title was not found as 名称")
        // Live bodies include text typed in open pages; cold bodies were read
        // without opening an owner or a tab, and nothing was written.
        let live = try h.search("另有一层")
        try require(live.entityHits.map { "\($0.kind).\($0.field)" } == ["storyline.body"], "The live storyline body was not searched")
        try require(h.workspace.openDocumentCount == owners
            && !h.host.hasTab(.element(ElementScope(projectID: h.projectID, elementID: corpus.element.id)))
            && !h.host.hasTab(.category(CategoryScope(projectID: h.projectID, categoryID: corpus.category.id))),
            "Searching opened an owner or a tab")
        let none = try h.search("不存在的词")
        try require(none.hits.isEmpty && none.entityHits.isEmpty && none.status == "没有找到匹配内容。" && h.panel(none).rows.isEmpty,
            "A search without matches reads \(none.status)")
        try h.journal.expect([], since: mark, "Global search")
    }

    // MARK: (b) Opening and selecting

    private static func globalSearchOpensAndSelects() throws {
        let h = try GlobalSearchHarness(name: "全局搜索定位合成项目")
        defer { h.close() }
        let corpus = try searchCorpus(h)
        let projectID = h.projectID
        let storylineScope = DocumentScope.storyline(StorylineScope(projectID: projectID, storylineID: corpus.storyline.id))
        let driftScope = DocumentScope.drift(DriftScope(projectID: projectID, driftID: corpus.drift.id))
        let materials = MaterialLibraryModel(workspace: h.workspace, projectID: projectID)
        let library = MacMaterialLibraryViewController(model: materials)
        _ = library.view
        let model = try h.search("北塔")
        let controller = h.panel(model, materials: library)

        // Text typed before the match in open pages after the search.
        let storylineView = try h.host.retainedView(pane: 0, scope: storylineScope).unwrapSearch("No storyline tab")
        try h.type("冬天，", in: storylineView)
        let driftView = try h.host.retainedView(pane: 0, scope: driftScope).unwrapSearch("No drift tab")
        try h.type("远处", in: driftView)
        var mark = try h.journal.mark()

        // A cold element body opens as a tab and selects its match.
        try require(try h.open(controller, kind: "element", field: "body") == "ok", "The element body hit was refused: \(h.outcome ?? "")")
        let elementView = try h.host.activeView.unwrapSearch("No element tab")
        try require(h.host.activeElement?.id == corpus.element.id && selectedText(elementView) == "北塔"
            && elementView.textView.selectedRange() == NSRange(location: 5, length: 2),
            "The element match was not selected: \(elementView.textView.selectedRange())")
        // Text typed before the match in the element page, then the same hit.
        try h.journal.expect([], since: mark, "Opening a cold element body hit")
        try h.type("冬夜里，", in: elementView)
        mark = try h.journal.mark()
        let beforeElement = try read(try h.host.activeCore.unwrapSearch("No element core")).projection
        try require(try h.open(controller, kind: "element", field: "body") == "ok", "The element body hit was refused after an edit")
        try require(elementView.textView.selectedRange() == NSRange(location: 9, length: 2) && selectedText(elementView) == "北塔",
            "The element match did not follow the edit: \(elementView.textView.selectedRange())")
        let afterElement = try read(try h.host.activeCore.unwrapSearch("No element core")).projection
        try require(afterElement.revision == beforeElement.revision && afterElement.canUndo == beforeElement.canUndo,
            "Selecting a search result authored history")

        // Live storyline and drift pages, after the text typed before the match.
        try require(try h.open(controller, kind: "storyline", field: "body") == "ok", "The storyline body hit was refused")
        try require(h.host.activeView === storylineView && storylineView.textView.selectedRange() == NSRange(location: 3, length: 2)
            && selectedText(storylineView) == "北塔", "The storyline match was not selected: \(storylineView.textView.selectedRange())")
        try require(try h.open(controller, kind: "drift", field: "body") == "ok", "The drift body hit was refused")
        try require(h.host.activeView === driftView && driftView.textView.selectedRange() == NSRange(location: 2, length: 2),
            "The drift match was not selected: \(driftView.textView.selectedRange())")
        // A cold category body.
        try require(try h.open(controller, kind: "category", field: "body") == "ok", "The category body hit was refused")
        let categoryView = try h.host.activeView.unwrapSearch("No category tab")
        try require(h.host.activeCategory?.id == corpus.category.id && categoryView.textView.selectedRange() == NSRange(location: 0, length: 2),
            "The category match was not selected: \(categoryView.textView.selectedRange())")

        // Field hits open their pages; a chapter summary opens the chapter.
        try require(try h.open(controller, kind: "chapter", field: "summary") == "ok", "The chapter summary hit was refused")
        try require(h.host.activeChapter?.id == corpus.chapter.id && h.host.tabTitles(pane: 0).contains("序章"),
            "The chapter summary did not open the chapter: \(h.host.tabTitles(pane: 0))")
        try require(try h.open(controller, kind: "element", field: "fact") == "ok" && h.host.activeElement?.id == corpus.element.id,
            "The fact hit did not open the element page")
        try require(try h.open(controller, kind: "storyline", field: "summary") == "ok" && h.host.activeView === storylineView,
            "The storyline summary hit did not open its page")
        try require(try h.open(controller, kind: "category", field: "name") == "ok" && h.host.activeCategory?.id == corpus.category.id,
            "The category name hit did not open its page")
        // A material opens in the 素材库, selected once the list has loaded.
        guard let materialRow = searchRow(controller, kind: "library", field: "notes") else { throw LabError.message("No material row") }
        controller.choose(row: materialRow)
        materials.load()
        try wait { materials.loaded && !materials.busy && library.selectedItem?.id == corpus.material.id }
        try h.journal.expect([], since: mark, "Opening and selecting search results")
    }

    // MARK: (c) Stale results, input guards, unreadable bodies, truncation, superseded queries

    private static func globalSearchRefusesStaleAndShowsLimits() throws {
        let h = try GlobalSearchHarness(name: "全局搜索边界合成项目")
        defer { h.close() }
        let corpus = try searchCorpus(h)
        let projectID = h.projectID, workspace = h.workspace
        let storylineScope = DocumentScope.storyline(StorylineScope(projectID: projectID, storylineID: corpus.storyline.id))
        var model = try h.search("北塔")
        var controller = h.panel(model)
        let storylineView = try h.host.retainedView(pane: 0, scope: storylineScope).unwrapSearch("No storyline tab")
        let storylineHit = try model.entityHits.first { $0.kind == "storyline" && $0.field == "body" }.unwrapSearch("No storyline body hit")

        // A draft in Rust refuses resolution in Chinese; the view is untouched.
        try require(try h.open(controller, kind: "storyline", field: "body") == "ok", "The storyline hit was refused")
        let storylineCore = try h.host.activeCore.unwrapSearch("No storyline core")
        let revision = try read(storylineCore).projection.revision
        let _: Bool = try elementResult { storylineCore.beginDraft(key: "global-search-pending", revision: revision, range: NSRange(location: 0, length: 0), completion: $0) }
        let drafted = try elementRefused({ workspace.resolveEntityHit(projectID: projectID, hit: storylineHit, completion: $0) }, "A draft did not refuse")
        try require(drafted == "请先完成或恢复当前编辑，再定位搜索结果", "The draft refusal reads \(drafted)")
        let _: Bool = try elementResult { storylineCore.cancelDraft(key: "global-search-pending", completion: $0) }
        let location: WorkspaceSearchLocation = try elementResult { workspace.resolveEntityHit(projectID: projectID, hit: storylineHit, completion: $0) }
        // A resolved range is stale once text arrives before the reveal.
        try h.type("又", in: storylineView)
        try require(!storylineView.reveal(range: try location.range.unwrapSearch("No range"), revision: location.revision),
            "A stale revision selected text")

        // Marked input blocks choosing a row; the composition stays.
        storylineView.textView.setSelectedRange(NSRange(location: 0, length: 0))
        storylineView.textView.setMarkedText("bei", selectedRange: NSRange(location: 3, length: 0), replacementRange: NSRange(location: 0, length: 0))
        let marked = storylineView.textView.string, markedSelection = storylineView.textView.selectedRange()
        let driftRow = try searchRow(controller, kind: "drift", field: "body").unwrapSearch("No drift row")
        h.outcome = nil
        controller.choose(row: driftRow)
        try require(h.outcome == nil && h.host.activeView === storylineView && storylineView.textView.hasMarkedText()
            && NativeText.identical(storylineView.textView.string, marked) && storylineView.textView.selectedRange() == markedSelection,
            "A search result was opened during composition")
        storylineView.textView.insertText("北", replacementRange: NSRange(location: NSNotFound, length: 0))
        try elementSettled(h.host, storylineView)
        try require(try h.open(controller, kind: "drift", field: "body") == "ok", "The drift hit was refused after the commit")

        // A body whose scope changed (trash and restore) is refused.
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            h.host.trashElement(projectID: projectID, elementID: corpus.element.id, completion: $0)
        }
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            workspace.restoreElement(projectID: projectID, elementID: corpus.element.id, completion: $0)
        }
        try require(try h.open(controller, kind: "element", field: "body") == "搜索结果的正文已更改，请重新搜索",
            "A body with a changed scope was selected: \(h.outcome ?? "")")

        // The matched text replaced: Rust refuses, the selection stays.
        model = try h.search("北塔")
        controller = h.panel(model)
        try require(try h.open(controller, kind: "element", field: "body") == "ok", "The restored element's new hit was refused")
        let elementView = try h.host.activeView.unwrapSearch("No element tab")
        try require(selectedText(elementView) == "北塔", "The restored element's match was not selected")
        elementView.textView.insertText("南塔", replacementRange: elementView.textView.selectedRange())
        try elementSettled(h.host, elementView)
        let caret = elementView.textView.selectedRange()
        try require(try h.open(controller, kind: "element", field: "body") == "搜索结果原文已更改，请重新搜索" && elementView.textView.selectedRange() == caret,
            "A replaced match was selected: \(h.outcome ?? "")")

        // An unreadable closed body is listed in its section, not as no match.
        let brokenReply: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: projectID, name: "残卷", completion: $0)
        }
        let broken = try brokenReply.result.unwrapSearch("No category")
        let brokenView: NativeDocumentView = try elementResult { h.host.open(project: h.project, category: broken, completion: $0) }
        try elementSettled(h.host, brokenView)
        try h.type("残卷里也有北塔。", in: brokenView)
        try h.closeTab(.category(CategoryScope(projectID: projectID, categoryID: broken.id)))
        for sql in ["UPDATE yjs_snapshots SET state_blob = X'FF00FF' WHERE document_id = ?", "UPDATE yjs_updates SET update_blob = X'FF00FF' WHERE document_id = ?"] {
            try WorkspaceRemoteProseFixture.execute(in: h.directory, sql: sql, parameters: [.text(broken.documentId)])
        }
        // More than 100 hits for the truncation below.
        let _: WorkspaceImportedEntity = try elementResult {
            workspace.importBlocks(projectID: projectID, title: "钟声合集", target: .drift,
                                   blocks: (1...110).map { .paragraph("第\($0)声钟") }, completion: $0)
        }
        let mark = try h.journal.mark()
        let unreadable = try h.search("北塔")
        let unreadablePanel = h.panel(unreadable)
        try require(unreadable.entityUnavailable.map(\.id) == [broken.id] && unreadable.entityHits.contains { $0.kind == "category" && $0.field == "name" && $0.id == corpus.category.id },
            "The unreadable body was not listed: \(unreadable.entityUnavailable.map(\.title))")
        try require(unreadable.status.contains("1 处正文暂时无法读取"), "The status does not name the unreadable body: \(unreadable.status)")
        guard let unreadableRow = unreadablePanel.rows.firstIndex(where: { if case .entityUnavailable = $0 { return true }; return false }),
              let label = unreadablePanel.tableView(unreadablePanel.table, viewFor: nil, row: unreadableRow) as? NSTextField else {
            throw LabError.message("No unreadable row")
        }
        let categorySection = try unreadablePanel.rows.firstIndex { if case .header("分类") = $0 { return true }; return false }.unwrapSearch("No 分类 section")
        let storylineSection = try unreadablePanel.rows.firstIndex { if case .header("故事线") = $0 { return true }; return false }.unwrapSearch("No 故事线 section")
        try require(label.stringValue.hasPrefix("暂不可读取 · 残卷 · 正文") && unreadableRow > categorySection && unreadableRow < storylineSection
            && !unreadablePanel.tableView(unreadablePanel.table, shouldSelectRow: unreadableRow),
            "The unreadable row reads \(label.stringValue) at \(unreadableRow)")

        // Truncation: more than 100 hits are cut and said so.
        let capped = try h.search("钟")
        let cappedPanel = h.panel(capped)
        guard case .truncated(let notice)? = cappedPanel.rows.last else { throw LabError.message("No truncation row") }
        try require(capped.entityTruncated && capped.entityHits.count == 100 && capped.status.contains("结果已截断")
            && notice.hasPrefix("结果已截断"), "Truncation was not shown: \(capped.entityHits.count), \(capped.status)")

        // Superseded and cleared queries never show older replies.
        let latest = WorkspaceSearchModel(workspace: workspace, projectID: projectID, includesEntities: true)
        latest.search("北塔"); latest.search("不存在的词")
        try wait { !latest.busy }
        try require(latest.query == "不存在的词" && latest.hits.isEmpty && latest.entityHits.isEmpty && latest.requests == 1,
            "A superseded query was sent or shown")
        latest.search("北塔")
        try wait { latest.requests == 2 }
        latest.search("钟")
        try wait { !latest.busy }
        try require(latest.entityHits.allSatisfy { $0.preview.contains("钟") || $0.title.contains("钟") } && !latest.entityHits.isEmpty,
            "An older reply replaced the latest query")
        latest.search("北塔")
        try wait { latest.requests == 4 }
        latest.search("")
        let _: [WorkspaceChapter] = try elementResult { workspace.chapters(projectID: projectID, completion: $0) }
        let _: [WorkspaceChapter] = try elementResult { workspace.chapters(projectID: projectID, completion: $0) }
        try require(latest.query.isEmpty && latest.hits.isEmpty && latest.entityHits.isEmpty && !latest.busy,
            "A cleared search repopulated from an older reply")
        try h.journal.expect([], since: mark, "Searching unreadable, capped and superseded queries")
    }
}

private extension Optional {
    func unwrapSearch(_ message: String) throws -> Wrapped {
        guard let value = self else { throw LabError.message(message) }
        return value
    }
}
