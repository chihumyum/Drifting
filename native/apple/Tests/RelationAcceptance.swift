import AppKit

/// Relation types and curated relations through the real 关系类型 manager,
/// the 关系 sections of element, chapter, drift and storyline pages, the add
/// sheet and row menus over the Rust workspace. The wiring mirrors
/// AppDelegate; input is programmatic and every step checks the originals it
/// wrote. Test data is synthetic.
extension BindingAcceptance {
    private final class RelationHarness {
        let directory: URL
        let workspace: LabWorkspaceCore
        let project: WorkspaceProject
        let chapters: [WorkspaceChapter]
        let category: WorkspaceElementCategory
        let elements: [String: WorkspaceElement]
        let drift: WorkspaceDrift
        let storyline: WorkspaceStoryline
        let window: NSWindow
        let host: MacChapterWorkspace
        let model: RelationLibraryModel
        let manager: MacRelationTypesViewController
        /// Answers the next alerts; nil cancels.
        var answer: ((NSAlert) -> NSApplication.ModalResponse)?
        private(set) var alerts: [NSAlert] = []

        init() throws {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                .appendingPathComponent("apple-native-lab")
            let workspace = LabWorkspaceCore(directory: directory)
            self.directory = directory
            self.workspace = workspace
            let initial: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(initial.isEmpty, "Relation fixture was not isolated")
            let project: WorkspaceProject = try BindingAcceptance.elementResult { workspace.createProject(name: "关系合成项目", completion: $0) }
            self.project = project
            chapters = try ["启程", "航行"].map { title in
                try BindingAcceptance.elementResult { workspace.createChapter(projectID: project.id, title: title, completion: $0) }
            }
            let category: WorkspaceElementReply<WorkspaceElementCategory> = try BindingAcceptance.elementResult {
                workspace.createElementCategory(projectID: project.id, name: "人物", completion: $0)
            }
            self.category = category.result!
            var elements: [String: WorkspaceElement] = [:]
            for name in ["老周", "阿岚", "小七"] {
                let reply: WorkspaceElementReply<WorkspaceElement> = try BindingAcceptance.elementResult {
                    workspace.createElement(projectID: project.id, categoryID: category.result!.id, name: name, completion: $0)
                }
                elements[name] = reply.result!
            }
            self.elements = elements
            let drift: WorkspaceDriftReply<WorkspaceDrift> = try BindingAcceptance.elementResult {
                workspace.createDrift(projectID: project.id, title: "潮汐手记", groupID: nil, completion: $0)
            }
            self.drift = drift.result!
            let storyline: WorkspaceStorylineReply<WorkspaceStoryline> = try BindingAcceptance.elementResult {
                workspace.createStoryline(projectID: project.id, name: "主线", completion: $0)
            }
            self.storyline = storyline.result!
            (window, host) = BindingAcceptance.elementHost(workspace)
            // Sheets stay programmatic: the window is never ordered on screen.
            host.relations.presentSheet = { _, _ in }
            model = host.relations.model(projectID: project.id)
            manager = MacRelationTypesViewController(model: model)
            manager.presentSheet = { _ in }
            host.relations.presentAlert = { [weak self] alert, done in
                self?.alerts.append(alert)
                done(self?.answer?(alert) ?? .alertSecondButtonReturn)
            }
            manager.presentAlert = host.relations.presentAlert
            _ = manager.view
            try BindingAcceptance.wait { self.model.loaded && !self.model.busy }
        }

        func element(_ name: String) -> WorkspaceElement { elements[name]! }
        func endpoint(_ name: String) -> RelationEndpoint { RelationEndpoint(kind: "element", id: element(name).id) }
        var chapterEnds: [RelationEndpoint] { chapters.map { RelationEndpoint(kind: "node", id: $0.id) } }

        /// The last change-set rowid; steps compare the originals after it.
        func mark() throws -> Int64 {
            guard case .integer(let value)? = try WorkspaceRemoteProseFixture.query(in: directory,
                sql: "SELECT COALESCE(MAX(rowid), 0) AS n FROM sync_change_set").first?["n"] else {
                throw LabError.message("Journal mark query returned no row")
            }
            return value
        }

        /// “action kind” of every mutation, one list per original after `since`.
        func originals(since: Int64) throws -> [[String]] {
            try WorkspaceRemoteProseFixture.query(in: directory,
                sql: "SELECT change_set_id FROM sync_change_set WHERE rowid > \(since) ORDER BY rowid").map { row in
                guard case .text(let id)? = row["change_set_id"] else { throw LabError.message("Journal row has no identity") }
                return try WorkspaceRemoteProseFixture.query(in: directory,
                    sql: "SELECT action || ' ' || target_kind AS m FROM sync_mutation WHERE change_set_id = ? ORDER BY mutation_index",
                    parameters: [.text(id)]).map { mutation in
                    guard case .text(let value)? = mutation["m"] else { throw LabError.message("Journal mutation is unreadable") }
                    return value
                }
            }
        }

        func expect(_ expected: [[String]], since: Int64, _ step: String) throws {
            let written = try originals(since: since)
            try BindingAcceptance.require(written == expected, "\(step) wrote \(written) instead of \(expected)")
        }

        func type(_ name: String) throws -> WorkspaceRelationType {
            guard let type = model.library.types.first(where: { $0.name == name }) else { throw LabError.message("No relation type \(name)") }
            return type
        }

        func elementPage(_ name: String) -> MacElementPageView? {
            host.retainedElementPage(pane: 0, scope: ElementScope(projectID: project.id, elementID: element(name).id))
        }
        func chapterPage(_ index: Int) -> MacChapterPageView? {
            host.retainedChapterPage(pane: 0, scope: ChapterScope(projectID: project.id, chapterID: chapters[index].id))
        }

        func openElement(_ name: String) throws -> MacElementPageView {
            try BindingAcceptance.wait { self.host.canNavigate }
            let view: NativeDocumentView = try BindingAcceptance.elementResult { host.open(project: project, element: element(name), completion: $0) }
            try BindingAcceptance.elementSettled(host, view)
            guard let page = elementPage(name) else { throw LabError.message("\(name) has no element page") }
            try BindingAcceptance.relationsLoaded(page.relationsView)
            return page
        }

        func openChapter(_ index: Int) throws -> MacChapterPageView {
            try BindingAcceptance.wait { self.host.canNavigate }
            let view: NativeDocumentView = try BindingAcceptance.elementResult { host.open(project: project, chapter: chapters[index], completion: $0) }
            try BindingAcceptance.elementSettled(host, view)
            guard let page = chapterPage(index) else { throw LabError.message("Chapter \(index) has no page") }
            try BindingAcceptance.relationsLoaded(page.relationsView)
            return page
        }

        /// 添加关系… on a section: the coordinator's sheet.
        func beginAdd(_ section: RelationsSectionView) throws -> AddRelationSheet {
            try BindingAcceptance.require(host.relations.addSheet == nil, "An add sheet was already open")
            BindingAcceptance.relationPress(section.addButton)
            guard let sheet = host.relations.addSheet else { throw LabError.message("添加关系… did not open the sheet") }
            return sheet
        }

        /// Chooses the other end and a type, then 添加, and waits for the sheet to close.
        func add(_ section: RelationsSectionView, other: RelationEndpoint, type: String, swap: Bool = false) throws {
            let sheet = try beginAdd(section)
            sheet.choose(other)
            try BindingAcceptance.require(sheet.target?.endpoint == other, "The add sheet did not list \(other.key)")
            if swap { sheet.swapDirection() }
            sheet.chooseType(try self.type(type).id)
            try BindingAcceptance.require(sheet.addButton.isEnabled, "添加 was disabled: \(sheet.errorMessage ?? "none")")
            BindingAcceptance.relationPress(sheet.addButton)
            try BindingAcceptance.wait { self.host.relations.addSheet == nil && !self.model.busy }
        }

        func item(_ section: RelationsSectionView, _ relationID: String, _ identifier: String) throws -> LibraryMenuItem {
            guard let entry = section.entries.first(where: { $0.relation.id == relationID }),
                  let item = section.menuItems(for: entry).first(where: { $0.accessibilityIdentifier() == identifier }) as? LibraryMenuItem else {
                throw LabError.message("Relation row lacks \(identifier)")
            }
            return item
        }

        func close() throws {
            try BindingAcceptance.wait { self.host.canNavigate && !self.model.busy }
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "Relation workspace failed to close")
            window.close()
        }

        func remove() { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
    }

    static func relationPress(_ button: NSButton) { button.sendAction(button.action, to: button.target) }

    static func relationsLoaded(_ section: RelationsSectionView) throws {
        try wait { !section.mutedLines.contains("正在读取关系…") }
    }

    /// Row texts newest first, including collapsed rows.
    private static func relationTexts(_ section: RelationsSectionView?) -> [String] { section?.entries.map(\.text) ?? [] }

    /// Chooses the type with this identity in 改为其他类型… and confirms.
    private static func relationChoice(_ id: String) -> (NSAlert) -> NSApplication.ModalResponse {
        { alert in
            guard let popup = alert.accessoryView as? NSPopUpButton,
                  let index = popup.itemArray.firstIndex(where: { $0.representedObject as? String == id }) else { return .alertSecondButtonReturn }
            popup.selectItem(at: index)
            return .alertFirstButtonReturn
        }
    }

    /// Fills the editor and saves; the kinds listed are checked, the other native kinds cleared.
    private static func fillType(_ editor: RelationTypeEditorSheet, name: String, orientation: String = "directed",
                                 roles: (String, String), sources: [String], targets: [String] = [], description: String? = nil) {
        editor.nameField.stringValue = name
        editor.chooseOrientation(orientation)
        editor.sourceRoleField.stringValue = roles.0
        editor.targetRoleField.stringValue = roles.1
        if let description { editor.descriptionField.stringValue = description }
        for kind in RelationKind.native { editor.set(kind: kind, side: "source", checked: sources.contains(kind)) }
        if orientation == "directed" {
            for kind in RelationKind.native { editor.set(kind: kind, side: "target", checked: targets.contains(kind)) }
        }
    }

    static func relationAcceptance() throws -> [String] {
        let harness = try RelationHarness()
        defer { harness.remove() }
        try relationTypesInManager(harness)
        try relationsAddedFromPages(harness)
        try relationRowActions(harness)
        try relationTrashAndColdReopen(harness)
        return [
            "AppKit 关系类型 manager creates a directed and a symmetric type, refuses a duplicate name and built-in edits without writing, edits a type, writes nothing when unchanged and deletes an unused type after confirmation",
            "AppKit 关系 sections on element, chapter, drift and storyline pages add relations through the sheet and an inline type, refuse a reversed direction in the sheet, the inline editor and Rust without writing, list a symmetric edge on both sides, open the other entity and follow renames",
            "AppKit 关系 row menus swap a directed relation, retype it with and without swapped ends, write nothing for the current type, remove a relation and refuse deleting a type in use, with every open section following each reply",
            "AppKit element trash purges its relations inside the trash original and from the other entities' open sections, restore does not bring them back, the freed type deletes, and types and relations survive cold reopen",
        ]
    }

    // MARK: (a) 关系类型 manager

    private static func relationTypesInManager(_ h: RelationHarness) throws {
        let (manager, model) = (h.manager, h.model)
        guard let builtIn = model.library.types.first(where: { !$0.isAuthored }) else { throw LabError.message("No built-in type") }
        try require(manager.rows.map(\.id) == [builtIn.id] && builtIn.displayName == "关联" && builtIn.summary == "关联项 → 对象"
            && manager.menuItems(for: builtIn).allSatisfy { !$0.isEnabled || $0.isSeparatorItem },
            "The manager did not show only the locked built-in type")

        // A directed type; the name is trimmed by Rust.
        var start = try h.mark()
        relationPress(manager.createButton)
        guard let mentor = manager.editor else { throw LabError.message("新建关系类型 opened no editor") }
        try require(mentor.sourceBoxes.filter { $0.box.isEnabled }.map(\.kind) == RelationKind.native
            && mentor.sourceBoxes.filter { !$0.box.isEnabled }.map(\.kind) == ["patch", "comment", "library_item"]
            && mentor.targetBoxes.filter { !$0.box.isEnabled }.map(\.kind) == ["patch"],
            "The editor did not disable the kinds the native client cannot address")
        fillType(mentor, name: " 师徒 ", roles: ("师父", "徒弟"), sources: ["element"], targets: ["element"])
        relationPress(mentor.saveButton)
        try wait { manager.editor == nil && !model.busy }
        try h.expect([["entity.create entity-relation-type"]], since: start, "Creating 师徒")
        let stored = try h.type("师徒")
        try require(stored.sourceKinds == ["element"] && stored.targetKinds == ["element"] && stored.summary == "师父 → 徒弟"
            && manager.rows.first?.id == stored.id && manager.statusText == "关系类型“师徒”已创建。",
            "师徒 was not stored as typed: \(stored)")

        // A symmetric type has one role and the same kinds at both ends.
        start = try h.mark()
        relationPress(manager.createButton)
        guard let ally = manager.editor else { throw LabError.message("No editor for 同盟") }
        fillType(ally, name: "同盟", orientation: "symmetric", roles: ("盟友", ""), sources: ["node", "element", "storyline"])
        try require(ally.definition.targetKinds == ["node", "element", "storyline"]
            && ally.targetBoxes.filter { $0.box.state == .on }.map(\.kind) == ["node", "element", "storyline"]
            && ally.sourceRoleLabel.stringValue == "端点角色", "The symmetric editor did not mirror its kinds")
        relationPress(ally.saveButton)
        try wait { manager.editor == nil && !model.busy }
        try h.expect([["entity.create entity-relation-type"]], since: start, "Creating 同盟")
        let allyType = try h.type("同盟")
        try require(allyType.isSymmetric && allyType.sourceRole == "盟友" && allyType.targetRole == "盟友"
            && allyType.sourceKinds == ["node", "element", "storyline"] && allyType.targetKinds == allyType.sourceKinds
            && allyType.summary == "对称 · 盟友", "同盟 was not stored symmetric: \(allyType)")

        // A directed type from elements to chapters, for retypes that swap the ends.
        relationPress(manager.createButton)
        guard let appears = manager.editor else { throw LabError.message("No editor for 现身") }
        fillType(appears, name: "现身", roles: ("人物", "章节"), sources: ["element"], targets: ["node"])
        relationPress(appears.saveButton)
        try wait { manager.editor == nil && !model.busy }

        // A duplicate name is refused without writing; the editor keeps the typed values.
        start = try h.mark()
        relationPress(manager.createButton)
        guard let duplicate = manager.editor else { throw LabError.message("No editor for the duplicate") }
        fillType(duplicate, name: "师徒", roles: ("甲", "乙"), sources: ["node"], targets: ["node"])
        relationPress(duplicate.saveButton)
        try wait { !model.busy && duplicate.errorMessage != nil }
        try require(duplicate.errorMessage == "关系类型「师徒」已存在" && manager.editor === duplicate
            && duplicate.nameField.stringValue == "师徒" && duplicate.sourceRoleField.stringValue == "甲",
            "The duplicate name was not refused in the editor: \(duplicate.errorMessage ?? "none")")
        try h.expect([], since: start, "A duplicate type name")
        relationPress(duplicate.cancelButton)
        try require(manager.editor == nil && model.library.authoredTypes.count == 3, "Cancel did not close the editor")

        // Editing writes all ten fields once; an unchanged edit writes nothing.
        manager.beginEdit(allyType)
        guard let edit = manager.editor else { throw LabError.message("编辑… opened no editor") }
        try require(edit.isSymmetric && edit.nameField.stringValue == "同盟" && edit.sourceRoleField.stringValue == "盟友",
            "The editor did not show the stored type")
        edit.descriptionField.stringValue = "并肩作战"
        relationPress(edit.saveButton)
        try wait { manager.editor == nil && !model.busy }
        try h.expect([Array(repeating: "field.set entity-relation-type", count: 10)], since: start, "Editing 同盟")
        try require(try h.type("同盟").description == "并肩作战", "The description was not stored")
        start = try h.mark()
        manager.beginEdit(try h.type("同盟"))
        relationPress(manager.editor!.saveButton)
        try wait { manager.editor == nil && !model.busy }
        try h.expect([], since: start, "An unchanged edit")

        // The built-in type refuses edits and deletes, before writing.
        let refused = try elementRefused({ model.updateType(id: builtIn.id, definition: RelationTypeDefinition(type: builtIn), completion: $0) },
            "The built-in type took an edit")
        try require(refused == "内建关系类型不能修改", "The built-in edit refusal read \(refused)")
        manager.delete(builtIn)
        try wait { !model.busy && manager.statusText == "内建关系类型不能删除" }
        try h.expect([], since: start, "Built-in refusals")

        // An unused type is deleted after confirmation.
        relationPress(manager.createButton)
        fillType(manager.editor!, name: "临时", roles: ("源端", "目标端"), sources: RelationKind.native, targets: RelationKind.native)
        relationPress(manager.editor!.saveButton)
        try wait { manager.editor == nil && !model.busy }
        let spare = try h.type("临时")
        start = try h.mark()
        h.answer = { _ in .alertFirstButtonReturn }
        guard let delete = manager.menuItems(for: spare).first(where: { $0.accessibilityIdentifier() == "delete-relation-type" }) as? LibraryMenuItem,
              delete.isEnabled else { throw LabError.message("删除… was not offered for an unused type") }
        delete.press()
        try wait { !model.busy && model.library.type(id: spare.id) == nil }
        h.answer = nil
        try require(h.alerts.last?.messageText == "删除关系类型“临时”？" && !manager.rows.contains { $0.id == spare.id },
            "Deleting an unused type was not confirmed")
        try h.expect([["entity.purge entity-relation-type"]], since: start, "Deleting 临时")
    }

    // MARK: (b) Adding from pages

    private static func relationsAddedFromPages(_ h: RelationHarness) throws {
        let (host, model) = (h.host, h.model)
        let zhou = try h.openElement("老周")
        try require(zhou.relationsView.entries.isEmpty && zhou.relationsView.mutedLines.first?.hasPrefix("还没有关系") == true,
            "A new element page did not show an empty 关系 section")

        // The sheet lists every live entity except this one, by kind and search.
        var start = try h.mark()
        let sheet = try h.beginAdd(zhou.relationsView)
        try wait { sheet.names.storylinesKnown }
        let listed = Set(sheet.candidates.map(\.endpoint))
        let expected: Set<RelationEndpoint> = Set(h.chapterEnds + [RelationEndpoint(kind: "node", id: h.drift.id), h.endpoint("阿岚"),
            h.endpoint("小七"), RelationEndpoint(kind: "category", id: h.category.id), RelationEndpoint(kind: "storyline", id: h.storyline.id)])
        try require(listed == expected && Array(sheet.candidates.prefix(2).map(\.name)) == ["启程", "航行"]
            && sheet.titleLabel.stringValue == "为「老周」添加关系", "The sheet did not list the other entities: \(sheet.candidates.map(\.name))")
        sheet.groupControl.selectedSegment = 3
        sheet.groupControl.sendAction(sheet.groupControl.action, to: sheet.groupControl.target)
        try require(Set(sheet.candidates.map(\.name)) == ["阿岚", "小七"], "The 设定 filter did not narrow the list")
        sheet.searchField.stringValue = "阿"
        sheet.searchField.sendAction(sheet.searchField.action, to: sheet.searchField.target)
        try require(sheet.candidates.map(\.name) == ["阿岚"], "Search did not narrow the list")
        try require(!sheet.addButton.isEnabled && !sheet.typePopup.isEnabled, "The sheet allowed adding without an end")
        sheet.choose(h.endpoint("阿岚"))
        try require(Set(sheet.typeOptions.map(\.name)) == ["师徒", "同盟"] && sheet.directionLabel.stringValue == "老周 → 阿岚"
            && !sheet.addButton.isEnabled, "The sheet did not offer the element types")
        sheet.chooseType(try h.type("师徒").id)
        relationPress(sheet.addButton)
        try wait { host.relations.addSheet == nil && !model.busy }
        try h.expect([["entity.create entity-relation"]], since: start, "Adding 师徒 from an element page")
        try require(relationTexts(zhou.relationsView) == ["师徒 · 师父 → 阿岚"] && zhou.relationsView.rows.first?.kindLabel.stringValue == "设定",
            "老周's section did not list the relation: \(relationTexts(zhou.relationsView))")

        // The name opens the other element; its section shows the other side.
        relationPress(zhou.relationsView.rows[0].nameButton)
        try wait { host.activeElement?.id == h.element("阿岚").id && host.canNavigate }
        guard let lan = h.elementPage("阿岚") else { throw LabError.message("The row did not open 阿岚") }
        try relationsLoaded(lan.relationsView)
        try require(relationTexts(lan.relationsView) == ["师徒 · 徒弟 ← 老周"], "阿岚's section read \(relationTexts(lan.relationsView))")

        // From a chapter page, with a type created inline. A definition that
        // would not fit the chosen direction is refused before writing.
        let departure = try h.openChapter(0)
        start = try h.mark()
        let chapterSheet = try h.beginAdd(departure.relationsView)
        chapterSheet.choose(h.endpoint("阿岚"))
        try require(Set(chapterSheet.typeOptions.map(\.name)) == ["同盟", "现身"], "The chapter sheet offered \(chapterSheet.typeOptions.map(\.name))")
        chapterSheet.chooseType("create-relation-type")
        guard let inline = chapterSheet.typeEditor else { throw LabError.message("新建关系类型… opened no editor") }
        try require(inline.definition.sourceKinds == ["node"] && inline.definition.targetKinds == ["element"],
            "The inline editor did not start from the pair's kinds")
        fillType(inline, name: "出场", roles: ("场景", "角色"), sources: ["element"], targets: ["node"])
        relationPress(inline.saveButton)
        try wait { inline.errorMessage != nil && !model.busy }
        try require(inline.errorMessage == "关系类型「出场」要求 场景 → 角色；当前两端方向相反，请交换两端后重试。" && chapterSheet.typeEditor === inline,
            "The inline editor did not refuse the reversed type: \(inline.errorMessage ?? "none")")
        try h.expect([], since: start, "A reversed inline type")
        fillType(inline, name: "出场", roles: ("场景", "角色"), sources: ["node"], targets: ["element"])
        relationPress(inline.saveButton)
        try wait { chapterSheet.typeEditor == nil && !model.busy }
        let cast = try h.type("出场")
        try require(chapterSheet.typeID == cast.id && chapterSheet.addButton.isEnabled, "The new type was not chosen in the sheet")
        relationPress(chapterSheet.addButton)
        try wait { host.relations.addSheet == nil && !model.busy }
        try h.expect([["entity.create entity-relation-type"], ["entity.create entity-relation"]], since: start, "Adding 出场 inline")
        try require(relationTexts(departure.relationsView) == ["出场 · 场景 → 阿岚"]
            && relationTexts(lan.relationsView) == ["出场 · 角色 ← 启程", "师徒 · 徒弟 ← 老周"],
            "The chapter relation did not reach both sections: \(relationTexts(lan.relationsView))")

        // A reversed direction is explained in the sheet and 添加 waits; the
        // swap fixes it. Rust gives the same refusal and writes nothing.
        start = try h.mark()
        let lanSheet = try h.beginAdd(lan.relationsView)
        try require(!lanSheet.candidates.contains { [h.endpoint("老周"), h.endpoint("阿岚"), h.chapterEnds[0]].contains($0.endpoint) },
            "The sheet listed this entity or an already related one")
        lanSheet.choose(h.chapterEnds[1])
        lanSheet.chooseType(cast.id)
        let reversed = "关系类型「出场」要求 场景 → 角色；当前两端方向相反，请交换两端后重试。"
        try require(lanSheet.errorMessage == reversed && !lanSheet.addButton.isEnabled, "The sheet did not refuse the reversed direction")
        relationPress(lanSheet.addButton)
        try h.expect([], since: start, "A refused direction in the sheet")
        relationPress(lanSheet.swapButton)
        try require(lanSheet.errorMessage == nil && lanSheet.addButton.isEnabled && lanSheet.directionLabel.stringValue == "航行 → 阿岚",
            "交换方向 did not fix the direction")
        relationPress(lanSheet.addButton)
        try wait { host.relations.addSheet == nil && !model.busy }
        try h.expect([["entity.create entity-relation"]], since: start, "Adding after 交换方向")
        let before = model.library
        let refused = try elementRefused({ model.add(from: h.endpoint("阿岚"), to: h.chapterEnds[1], typeID: cast.id, completion: $0) },
            "Rust accepted a reversed direction")
        try require(refused == reversed && model.library == before, "Rust's reversed refusal read \(refused)")
        try h.expect([["entity.create entity-relation"]], since: start, "A refused direction in Rust")
        try require(relationTexts(lan.relationsView).first == "出场 · 角色 ← 航行", "阿岚's section read \(relationTexts(lan.relationsView))")

        // A symmetric edge lists on both sides with ↔.
        start = try h.mark()
        try h.add(departure.relationsView, other: h.endpoint("小七"), type: "同盟")
        try h.expect([["entity.create entity-relation"]], since: start, "Adding 同盟 from a chapter page")
        let pact = model.library.relations.last!
        try require(pact.fromKind == "element" && pact.toKind == "node", "The symmetric edge was not stored canonically")
        try require(relationTexts(departure.relationsView).first == "同盟 · 盟友 ↔ 小七", "启程 read \(relationTexts(departure.relationsView))")
        relationPress(departure.relationsView.rows[0].nameButton)
        try wait { host.activeElement?.id == h.element("小七").id && host.canNavigate }
        guard let qi = h.elementPage("小七") else { throw LabError.message("The row did not open 小七") }
        try relationsLoaded(qi.relationsView)
        try require(relationTexts(qi.relationsView) == ["同盟 · 盟友 ↔ 启程"] && qi.relationsView.rows[0].kindLabel.stringValue == "章节",
            "小七 read \(relationTexts(qi.relationsView))")

        // Drift and storyline pages have the same section.
        try wait { host.canNavigate }
        let driftView: NativeDocumentView = try elementResult { host.open(project: h.project, drift: h.drift, completion: $0) }
        try elementSettled(host, driftView)
        guard let driftPage = host.retainedDriftPage(pane: 0, scope: DriftScope(projectID: h.project.id, driftID: h.drift.id)) else {
            throw LabError.message("The drift has no page")
        }
        try relationsLoaded(driftPage.relationsView)
        start = try h.mark()
        try h.add(driftPage.relationsView, other: h.endpoint("老周"), type: "同盟")
        try wait { host.canNavigate }
        let storylineView: NativeDocumentView = try elementResult { host.open(project: h.project, storyline: h.storyline, completion: $0) }
        try elementSettled(host, storylineView)
        guard let storylinePage = host.retainedStorylinePage(pane: 0,
                scope: StorylineScope(projectID: h.project.id, storylineID: h.storyline.id)) else { throw LabError.message("The storyline has no page") }
        try relationsLoaded(storylinePage.relationsView)
        try h.add(storylinePage.relationsView, other: h.endpoint("老周"), type: "同盟")
        try h.expect([["entity.create entity-relation"], ["entity.create entity-relation"]], since: start, "Adding from drift and storyline pages")
        try require(relationTexts(driftPage.relationsView) == ["同盟 · 盟友 ↔ 老周"]
            && relationTexts(storylinePage.relationsView) == ["同盟 · 盟友 ↔ 老周"], "The drift or storyline page did not list its relation")
        try wait { relationTexts(zhou.relationsView) == ["同盟 · 盟友 ↔ 主线", "同盟 · 盟友 ↔ 潮汐手记", "师徒 · 师父 → 阿岚"] }
        try require(zhou.relationsView.rows.map(\.kindLabel.stringValue) == ["故事线", "漂流", "设定"], "Kinds did not read 故事线, 漂流 and 设定")

        // Names follow renames through the library callbacks.
        var changes = WorkspaceElementChanges()
        changes.name = "阿岚姐"
        let renamed: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            h.workspace.updateElement(projectID: h.project.id, elementID: h.element("阿岚").id, changes: changes, completion: $0)
        }
        host.applyElementLibrary(projectID: h.project.id, library: renamed.library)
        try require(relationTexts(zhou.relationsView).last == "师徒 · 师父 → 阿岚姐" && relationTexts(departure.relationsView).last == "出场 · 场景 → 阿岚姐",
            "Rows did not follow the element rename")
        try wait { host.canNavigate }
        let chapter: WorkspaceChapter = try elementResult {
            h.workspace.renameChapter(projectID: h.project.id, chapterID: h.chapters[0].id, title: "启程篇", completion: $0)
        }
        host.rename(chapter: chapter, projectID: h.project.id)
        try wait { relationTexts(lan.relationsView).contains("出场 · 角色 ← 启程篇") && relationTexts(qi.relationsView) == ["同盟 · 盟友 ↔ 启程篇"] }
    }

    // MARK: (c) Row menus

    private static func relationRowActions(_ h: RelationHarness) throws {
        let model = h.model
        guard let zhou = h.elementPage("老周"), let lan = h.elementPage("阿岚"), let departure = h.chapterPage(0),
              let qi = h.elementPage("小七") else { throw LabError.message("A page closed") }
        guard let mentor = zhou.relationsView.entries.first(where: { $0.typeName == "师徒" })?.relation,
              let cast = departure.relationsView.entries.first(where: { $0.typeName == "出场" })?.relation,
              let pact = departure.relationsView.entries.first(where: { $0.typeName == "同盟" })?.relation,
              let voyage = lan.relationsView.entries.first(where: { $0.text == "出场 · 角色 ← 航行" })?.relation else {
            throw LabError.message("Missing relations before the row actions")
        }
        // Symmetric rows offer no swap; a swap that would not fit is disabled.
        try require(!zhou.relationsView.menuItems(for: zhou.relationsView.entries[0]).contains { $0.accessibilityIdentifier() == "relation-swap" }
            && !(try h.item(departure.relationsView, cast.id, "relation-swap")).isEnabled, "Swap was offered where it cannot apply")

        // 交换方向 journals all five endpoint fields; both sections follow.
        var start = try h.mark()
        try h.item(zhou.relationsView, mentor.id, "relation-swap").press()
        try wait { !model.busy && relationTexts(zhou.relationsView).last == "师徒 · 徒弟 ← 阿岚姐" }
        try h.expect([Array(repeating: "field.set entity-relation", count: 5)], since: start, "交换方向")
        try require(relationTexts(lan.relationsView).last == "师徒 · 师父 → 老周", "阿岚姐's section did not follow the swap")

        // 改为其他类型…: the current type writes nothing; another type journals the five fields.
        start = try h.mark()
        h.answer = relationChoice(try h.type("师徒").id)
        try h.item(zhou.relationsView, mentor.id, "relation-retype").press()
        guard let popup = h.alerts.last?.accessoryView as? NSPopUpButton else { throw LabError.message("改为其他类型… showed no choice") }
        try require(Set(popup.itemArray.compactMap { $0.representedObject as? String }) == [try h.type("师徒").id, try h.type("同盟").id]
            && popup.selectedItem?.representedObject as? String == mentor.relationTypeId, "The retype choice did not offer the fitting types")
        try wait { !model.busy }
        try h.expect([], since: start, "Choosing the current type")
        h.answer = relationChoice(try h.type("同盟").id)
        try h.item(zhou.relationsView, mentor.id, "relation-retype").press()
        try wait { !model.busy && relationTexts(zhou.relationsView).last == "同盟 · 盟友 ↔ 阿岚姐" }
        try h.expect([Array(repeating: "field.set entity-relation", count: 5)], since: start, "Retyping to 同盟")
        try require(relationTexts(lan.relationsView).last == "同盟 · 盟友 ↔ 老周", "阿岚姐's section did not follow the retype")

        // A type that fits only the other way round swaps the ends with the retype.
        start = try h.mark()
        let appears = try h.type("现身")
        h.answer = relationChoice(appears.id)
        try h.item(lan.relationsView, voyage.id, "relation-retype").press()
        guard let swapPopup = h.alerts.last?.accessoryView as? NSPopUpButton,
              swapPopup.itemArray.first(where: { $0.representedObject as? String == appears.id })?.title.hasSuffix("· 交换两端") == true else {
            throw LabError.message("现身 was not offered with swapped ends")
        }
        try wait { !model.busy && relationTexts(lan.relationsView).contains("现身 · 人物 → 航行") }
        h.answer = nil
        try h.expect([Array(repeating: "field.set entity-relation", count: 5)], since: start, "Retyping with swapped ends")
        let stored = model.library.relation(id: voyage.id)
        try require(stored?.fromKind == "element" && stored?.toId == h.chapters[1].id, "The retype did not swap the ends")

        // 删除关系 purges the relation; both sides drop it.
        start = try h.mark()
        try h.item(departure.relationsView, pact.id, "relation-remove").press()
        try wait { !model.busy && !relationTexts(departure.relationsView).contains { $0.hasPrefix("同盟") } }
        try h.expect([["entity.purge entity-relation"]], since: start, "删除关系")
        try require(qi.relationsView.entries.isEmpty && qi.relationsView.mutedLines.first?.hasPrefix("还没有关系") == true,
            "小七's section kept the removed relation")

        // A type in use is refused with its count; nothing is written.
        start = try h.mark()
        h.manager.delete(try h.type("出场"))
        try wait { !model.busy && h.manager.statusText == "关系类型仍被 1 条关系使用，不能删除" }
        try h.expect([], since: start, "Deleting a type in use")
        try require(model.library.type(id: cast.relationTypeId) != nil, "A type in use was deleted")
    }

    // MARK: (d) Trash, restore and cold reopen

    private static func relationTrashAndColdReopen(_ h: RelationHarness) throws {
        let (host, model) = (h.host, h.model)
        guard let zhou = h.elementPage("老周"), let departure = h.chapterPage(0) else { throw LabError.message("A page closed") }
        let lan = h.element("阿岚")
        let touching = model.library.relations.filter { $0.from.id == lan.id || $0.to.id == lan.id }.count
        try require(touching == 3, "阿岚姐 should have three relations before the trash, has \(touching)")

        // The trash original purges every relation first; open sections of
        // the other entities drop them after the library is read again.
        var start = try h.mark()
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            host.trashElement(projectID: h.project.id, elementID: lan.id, completion: $0)
        }
        try h.expect([Array(repeating: "entity.purge entity-relation", count: 3) + ["entity.trash element"]], since: start, "Trashing 阿岚姐")
        try wait { !model.busy && model.library.related(to: h.endpoint("阿岚")).isEmpty }
        try wait { relationTexts(zhou.relationsView) == ["同盟 · 盟友 ↔ 主线", "同盟 · 盟友 ↔ 潮汐手记"] && departure.relationsView.entries.isEmpty }
        try require(h.elementPage("阿岚") == nil, "The trashed element kept its tab")

        // Restore does not bring relations back.
        let restored: WorkspaceElementReply<WorkspaceElement> = try elementResult {
            h.workspace.restoreElement(projectID: h.project.id, elementID: lan.id, completion: $0)
        }
        host.applyElementLibrary(projectID: h.project.id, library: restored.library)
        try wait { !model.busy }
        let lanPage = try h.openElement("阿岚")
        try require(lanPage.relationsView.entries.isEmpty && model.library.related(to: h.endpoint("阿岚")).isEmpty,
            "Restore brought relations back")

        // The freed type deletes after confirmation.
        start = try h.mark()
        h.answer = { _ in .alertFirstButtonReturn }
        h.manager.delete(try h.type("出场"))
        try wait { !model.busy && model.library.types.allSatisfy { $0.name != "出场" } }
        h.answer = nil
        try h.expect([["entity.purge entity-relation-type"]], since: start, "Deleting the freed type")

        // Cold reopen: the same library, and a fresh page lists the same rows.
        let library = model.library
        let rows = relationTexts(zhou.relationsView)
        try h.close()
        let cold = LabWorkspaceCore(directory: h.directory)
        let _: [WorkspaceProject] = try elementResult { cold.projects(completion: $0) }
        let (coldWindow, coldHost) = elementHost(cold)
        defer { coldWindow.close() }
        let coldModel = coldHost.relations.model(projectID: h.project.id)
        try wait { coldModel.loaded && !coldModel.busy }
        try require(coldModel.library == library, "The relation library did not survive cold reopen")
        let view: NativeDocumentView = try elementResult { coldHost.open(project: h.project, element: h.element("老周"), completion: $0) }
        try elementSettled(coldHost, view)
        guard let coldPage = coldHost.activeElementPage else { throw LabError.message("The cold element tab has no page") }
        try wait { relationTexts(coldPage.relationsView) == rows }
        let coldTypes = MacRelationTypesViewController(model: coldModel)
        _ = coldTypes.view
        try require(coldTypes.rows.map(\.name) == library.authoredTypes.map(\.name) + library.types.filter { !$0.isAuthored }.map(\.name),
            "A cold manager did not list the stored types")
        let closed: Bool = try elementResult { coldHost.close(completion: $0) }
        try require(closed, "Cold relation workspace failed to close")
    }
}
