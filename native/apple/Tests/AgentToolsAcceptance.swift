import AppKit

/// The writing assistant's domain tools through the real 写作助手 panel, tab
/// host and Rust workspace, with stubbed providers (synthetic SSE) and an
/// in-memory key store. Every project, name and text is synthetic.
extension BindingAcceptance {
    /// Synthetic entities the tool cases address, by their names.
    struct ToolFixture {
        var chapter: [String: WorkspaceChapter] = [:]
        var category: [String: WorkspaceElementCategory] = [:]
        var element: [String: WorkspaceElement] = [:]
        var storyline: [String: WorkspaceStoryline] = [:]
        var drift: [String: WorkspaceDrift] = [:]
        var type: [String: WorkspaceRelationType] = [:]
        var relation: [String: WorkspaceRelation] = [:]
        var comment: [String: WorkspaceComment] = [:]
        var patch: [String: WorkspacePatch] = [:]
        var material: [String: WorkspaceMaterialItem] = [:]
    }

    /// One write tool: a schema violation, a resolution or validation
    /// refusal, the call accepted and the same call rejected.
    struct ToolWriteCase {
        let tool: String
        let valid: [String: Any]
        let invalid: [String: Any]
        let invalidReason: String
        let refused: [String: Any]
        let refusedReason: [String]
        let card: [String]
        let journal: [[String]]
        var extra: [(arguments: [String: Any], reason: String)] = []
    }

    static let toolChapters = ["启程", "北岸", "《北岸》", "归途", "旧章", "改名章"]

    static func agentToolsAcceptance() throws -> [String] {
        let linkDelay = DocumentStore.entityLinkDelay, backlinkDelay = MacChapterWorkspace.backlinkDelay
        defer { DocumentStore.entityLinkDelay = linkDelay; MacChapterWorkspace.backlinkDelay = backlinkDelay }
        DocumentStore.entityLinkDelay = 0.05
        MacChapterWorkspace.backlinkDelay = 0.05
        try agentToolSchemasAndReads()
        try agentToolWrites()
        try agentToolRefusals()
        try agentActRailBoundaries()
        return [
            "AppKit 写作助手 registers 64 tools with Chinese descriptions and strict object schemas, refuses unknown, missing and mistyped arguments of every tool before it runs, and its relation, comment, material, patch, search, appearance, storyline and overview reads return the synthetic project while writing nothing to the journal",
            "AppKit element page 被引用 lists the drift, element, category and storyline pages that link the element after its chapters, opens a page at its first link, and find_element_appearances reports the same chapters and pages",
            "AppKit 写作助手 domain proposals for elements, categories, patches, storylines, relations, relation types, notes and TODOs, chapters, drifts and project details resolve names exactly, refuse ambiguous names with the candidates, show each changed field on the card, write nothing before 接受, apply exactly the expected originals through Rust on 接受, write nothing on 拒绝, and report each outcome to the model once",
            "AppKit 写作助手 domain proposals whose target changed before 接受 fail with Rust's Chinese reason and write nothing, pending input keeps a chapter rename pending until it settles, and after the project is deleted every write tool's proposal fails without writing",
            "AppKit 底部时间轴 幕 rail places each act by its stored book-axis boundary from workspaceOutline",
        ]
    }

    // MARK: Helpers

    private static func arguments(_ value: [String: Any]) -> String { AgentJSONText.encode(value) }

    /// The tool results of the conversation by call identity.
    private static func results(_ harness: AgentHarness) -> [String: AgentMessage] {
        Dictionary(harness.conversation.messages.filter { $0.role == .tool }.compactMap { message in message.callID.map { ($0, message) } },
                   uniquingKeysWith: { _, last in last })
    }

    private static func json(_ message: AgentMessage?) -> [String: Any] { message.flatMap { AgentJSONText.object($0.text) } ?? [:] }

    /// Runs one model turn that calls every tool in `calls`, then answers.
    private static func turn(_ harness: AgentHarness, _ calls: [(id: String, name: String, arguments: String)], _ text: String) throws {
        AgentStubProtocol.reset([AgentSSE.deepseekTools(calls), AgentSSE.deepseekText(["好。"])])
        harness.panel.composer.string = text
        harness.panel.composer.didChangeText()
        harness.panel.sendButton.performClick(nil)
        try require(harness.controller.isRunning, "The panel did not send \(text)")
        let deadline = Date().addingTimeInterval(120)
        while harness.controller.isRunning && Date() < deadline {
            _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
        try require(!harness.controller.isRunning, "The tool turn \(text) did not finish")
        try require(harness.notices.isEmpty, "The tool turn ended with a notice: \(harness.notices)")
    }

    private static func accept(_ harness: AgentHarness, _ id: String) throws {
        guard let card = harness.card(id), card.acceptButton.isEnabled else { throw LabError.message("\(id) has no pending card") }
        card.acceptButton.performClick(nil)
        try wait { harness.proposal(id)?.state != .applying }
        try wait { harness.host.canNavigate && !harness.host.isBusy }
    }

    private static func count(_ haystack: String, _ needle: String) -> Int { haystack.components(separatedBy: needle).count - 1 }

    private static let agentIdentity = ["sessionId": "fixture-session", "turnId": "fixture-turn", "callId": "fixture-call"]

    /// The synthetic project every case addresses. `bodies` adds typed
    /// links in a chapter and a drift page and a patch made invalid by an edit.
    private static func toolFixture(_ harness: AgentHarness, bodies: Bool) throws -> ToolFixture {
        let w = harness.workspace, p = harness.project.id
        var f = ToolFixture()
        for chapter in harness.chapters { f.chapter[chapter.title] = chapter }
        for (key, name) in [("人物", "人物"), ("地点", "地点"), ("器物1", "器物"), ("器物2", "器物")] {
            let reply: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult { w.createElementCategory(projectID: p, name: name, completion: $0) }
            f.category[key] = reply.result!
        }
        for (name, category, aliases) in [("林岚", "人物", ["阿岚"]), ("周策", "人物", []), ("北塔", "地点", []), ("旧物", "器物1", []), ("灯笼", "器物2", [])] {
            let created: WorkspaceElementReply<WorkspaceElement> = try elementResult {
                w.createElement(projectID: p, categoryID: f.category[category]!.id, name: name, completion: $0)
            }
            f.element[name] = created.result!
            if !aliases.isEmpty {
                var changes = WorkspaceElementChanges(); changes.aliases = aliases
                let updated: WorkspaceElementReply<WorkspaceElement> = try elementResult {
                    w.updateElement(projectID: p, elementID: created.result!.id, changes: changes, completion: $0)
                }
                f.element[name] = updated.result!
            }
        }
        for name in ["主线", "暗线", "《暗线》", "支线"] {
            let reply: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult { w.createStoryline(projectID: p, name: name, completion: $0) }
            f.storyline[name] = reply.result!
        }
        for title in ["灯塔笔记", "潮汐", "《潮汐》", "待改名"] {
            let reply: WorkspaceDriftReply<WorkspaceDrift> = try elementResult { w.createDrift(projectID: p, title: title, groupID: nil, completion: $0) }
            f.drift[title] = reply.result!
        }
        for definition in [
            RelationTypeDefinition(name: "师徒", orientation: "directed", sourceRole: "师父", targetRole: "徒弟", sourceKinds: ["element"], targetKinds: ["element"]),
            RelationTypeDefinition(name: "盟友", orientation: "symmetric", sourceRole: "盟友", targetRole: "盟友", sourceKinds: ["element"], targetKinds: ["element"]),
            RelationTypeDefinition(name: "发生于", orientation: "directed", sourceRole: "人物", targetRole: "地点", sourceKinds: ["element"], targetKinds: ["node"]),
        ] {
            let reply: WorkspaceRelationReply<WorkspaceRelationType> = try elementResult { w.createRelationType(projectID: p, definition: definition, completion: $0) }
            f.type[definition.name] = reply.result!
        }
        func relate(_ key: String, _ from: RelationEndpoint, _ to: RelationEndpoint, _ type: String) throws {
            let reply: WorkspaceRelationReply<WorkspaceRelation> = try elementResult {
                w.addRelation(projectID: p, from: from, to: to, relationTypeID: f.type[type]!.id, completion: $0)
            }
            f.relation[key] = reply.result!
        }
        let lan = RelationEndpoint(kind: "element", id: f.element["林岚"]!.id), ce = RelationEndpoint(kind: "element", id: f.element["周策"]!.id)
        try relate("师徒", lan, ce, "师徒")
        try relate("发生于", ce, RelationEndpoint(kind: "node", id: f.chapter["启程"]!.id), "发生于")
        try relate("盟友", RelationEndpoint(kind: "element", id: f.element["旧物"]!.id), RelationEndpoint(kind: "element", id: f.element["灯笼"]!.id), "盟友")
        func comment(_ key: String, _ kind: String, _ target: RelationEndpoint?, _ body: String, _ priority: String?) throws {
            let reply: WorkspaceCommentsReply = try elementResult {
                w.createComment(projectID: p, kind: kind, target: target, body: body, priority: priority, completion: $0)
            }
            f.comment[key] = reply.result!
        }
        try comment("时间线", "todo", nil, "整理时间线", "low")
        try comment("节奏", "note", RelationEndpoint(kind: "node", id: f.chapter["北岸"]!.id), "这里节奏慢", nil)
        try comment("年龄", "todo", lan, "核对年龄", nil)
        try comment("已处理", "note", RelationEndpoint(kind: "node", id: f.chapter["启程"]!.id), "已处理", nil)
        let _: WorkspaceCommentsReply = try elementResult {
            w.setCommentResolved(projectID: p, commentID: f.comment["已处理"]!.id, resolved: true, completion: $0)
        }
        for (key, body) in [("受伤", "左臂受伤。"), ("离开", "离开北塔。")] {
            let reply: WorkspacePatchReply<WorkspacePatch> = try elementResult {
                w.createPatch(projectID: p, elementID: lan.id, title: key, body: body, source: nil, completion: $0)
            }
            f.patch[key] = reply.result!
        }
        for (title, body) in [("潮汐表", "初一大潮。\n十五小潮。"), ("草图", "甲"), ("草图", "乙")] {
            let reply: WorkspaceMaterialReply<WorkspaceMaterialItem> = try elementResult { w.createMaterialText(projectID: p, title: title, body: body, completion: $0) }
            f.material[f.material[title] == nil ? title : title + "2"] = reply.result!
        }
        let link: WorkspaceMaterialReply<WorkspaceMaterialItem> = try elementResult {
            w.createMaterialLink(projectID: p, title: "参考站点", url: "https://example.com/tides", completion: $0)
        }
        f.material["参考站点"] = link.result!
        var project = WorkspaceProjectChanges()
        project.summary = "一部关于灯塔的小说。"; project.facts = [WorkspaceFact(key: "视角", value: "第三人称")]
        let _: WorkspaceProjectDetails = try elementResult { w.updateProject(projectID: p, changes: project, completion: $0) }
        let _: WorkspaceAgentApplied = try elementResult {
            w.agentApplyChanges(projectID: p, kind: "storyline", id: f.storyline["主线"]!.id,
                                changes: [AgentProseChange.appending("林岚回到灯塔。").payload], agent: agentIdentity, completion: $0)
        }
        guard bodies else { return f }

        // Links typed in a chapter and a drift page; a patch whose anchored text is then deleted.
        let start = try harness.open(0)
        try harness.type(start, "林岚走进北塔。")
        try wait { EntityLinkAcceptanceProbe.linkedNames(start) == ["林岚", "北塔"] && !start.binding.hasPendingWork && !harness.host.isBusy }
        let driftView: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, drift: f.drift["灯塔笔记"]!, completion: $0) }
        try elementSettled(harness.host, driftView)
        driftView.textView.insertText("林岚守着灯。", replacementRange: NSRange(location: 0, length: 0))
        try wait { EntityLinkAcceptanceProbe.linkedNames(driftView) == ["林岚"] && !driftView.binding.hasPendingWork && !harness.host.isBusy }
        let back = try harness.open(3)
        try harness.type(back, "旧句在此。")
        let block = back.binding.store.projection!.blocks[0]
        let source = WorkspacePatchSource(nodeID: f.chapter["归途"]!.id, blockID: block.id, blockText: "旧句在此。", anchorText: "旧句")
        let invalid: WorkspacePatchReply<WorkspacePatch> = try elementResult {
            w.createPatch(projectID: p, elementID: ce.id, title: "失效", body: "旧的变化。", source: source, completion: $0)
        }
        back.textView.insertText("", replacementRange: NSRange(location: 0, length: 2))
        try elementSettled(harness.host, back)
        var reading = false, invalidated = false
        try wait {
            if !reading {
                reading = true
                w.elementPatches(projectID: p, elementID: ce.id) { result in
                    invalidated = (try? result.get())?.first { $0.id == invalid.result!.id }?.isInvalid == true
                    reading = false
                }
            }
            return invalidated
        }
        f.patch["失效"] = invalid.result!
        return f
    }

    // MARK: (a) Schemas and reads

    private static func agentToolSchemasAndReads() throws {
        let harness = try AgentHarness(titles: toolChapters)
        defer { harness.remove() }
        let f = try toolFixture(harness, bodies: true)
        let journal = JournalProbe(directory: harness.directory)

        // Every schema is a strict object with Chinese descriptions.
        func strict(_ schema: [String: Any], _ path: String) throws {
            if schema["type"] as? String == "object" {
                let properties = schema["properties"] as? [String: Any] ?? [:]
                try require(schema["additionalProperties"] as? Bool == false, "\(path) allows unknown properties")
                try require((schema["required"] as? [String] ?? []).allSatisfy { properties[$0] != nil }, "\(path) requires an undefined property")
                for (key, value) in properties {
                    guard let child = value as? [String: Any] else { throw LabError.message("\(path).\(key) has no schema") }
                    try require(child["type"] is String, "\(path).\(key) has no type")
                    try strict(child, "\(path).\(key)")
                }
            }
            if let items = schema["items"] as? [String: Any] { try strict(items, "\(path)[]") }
        }
        let cjk = { (text: String) in text.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) } }
        try require(AgentToolRegistry.all.count == 64 && Set(AgentToolRegistry.all.map(\.name)).count == 64
            && AgentToolRegistry.all.filter { $0.access == .read }.count == 23 && AgentToolRegistry.all.filter { $0.access == .memory }.count == 7,
            "The registry differs: \(AgentToolRegistry.all.map(\.name))")
        for tool in AgentToolRegistry.all {
            try require(cjk(tool.description), "\(tool.name) has no Chinese description")
            try strict(tool.schema, tool.name)
        }

        // Unknown, missing and mistyped arguments are refused before a tool runs.
        var mark = try journal.mark()
        var calls = AgentToolRegistry.all.map { (id: "call_unknown_\($0.name)", name: $0.name, arguments: arguments(["bogus": true])) }
        calls += [
            ("call_missing_search", "search_project", "{}"),
            ("call_type_material", "read_material", arguments(["materialId": 3])),
            ("call_enum_comments", "list_comments", arguments(["status": "later"])),
            ("call_nested_relations", "list_relations", arguments(["entity": ["kind": "person", "name": "林岚"]])),
            ("call_null_patches", "get_element_patches", arguments(["elementId": NSNull(), "name": "林岚"])),
        ]
        try turn(harness, calls, "检查参数。")
        var found = results(harness)
        for tool in AgentToolRegistry.all {
            let result = found["call_unknown_\(tool.name)"]
            try require(result?.ok == false && result?.text.contains("不支持参数 bogus。") == true, "\(tool.name) accepted an unknown argument: \(result?.text ?? "none")")
        }
        try require(found["call_missing_search"]?.text.hasPrefix("缺少必填参数 query。") == true
            && found["call_type_material"]?.text.hasPrefix("参数 materialId 必须是文字。") == true
            && found["call_enum_comments"]?.text.hasPrefix("参数 status 必须是以下之一：open、resolved、all。") == true
            && found["call_nested_relations"]?.text.hasPrefix("参数 entity.kind 必须是以下之一") == true
            && found["call_null_patches"]?.ok == true, "Schema refusals differ: \(calls.suffix(5).map { found[$0.id]?.text ?? "" })")
        try require(harness.conversation.proposals.isEmpty && (try journal.originals(since: mark)).isEmpty, "Refused calls wrote or proposed")

        // Reads return the synthetic project and write nothing.
        mark = try journal.mark()
        let lan = f.element["林岚"]!
        try turn(harness, [
            ("call_types", "list_relation_types", "{}"),
            ("call_relations", "list_relations", "{}"),
            ("call_relations_lan", "list_relations", arguments(["entity": ["kind": "element", "name": "阿岚"]])),
            ("call_relations_ambiguous", "list_relations", arguments(["entity": ["kind": "chapter", "name": "北岸"]])),
            ("call_comments", "list_comments", "{}"),
            ("call_comments_resolved", "list_comments", arguments(["status": "resolved"])),
            ("call_comments_todo", "list_comments", arguments(["kind": "todo", "status": "all"])),
            ("call_materials", "list_materials", "{}"),
            ("call_material", "read_material", arguments(["title": "潮汐表"])),
            ("call_material_link", "read_material", arguments(["materialId": f.material["参考站点"]!.id])),
            ("call_material_ambiguous", "read_material", arguments(["title": "草图"])),
            ("call_patches_lan", "get_element_patches", arguments(["name": "林岚"])),
            ("call_patches_ce", "get_element_patches", arguments(["elementId": f.element["周策"]!.id])),
            ("call_search", "search_project", arguments(["query": "林岚"])),
            ("call_appearances", "find_element_appearances", arguments(["name": "林岚"])),
            ("call_storyline", "read_storyline", arguments(["name": "主线"])),
            ("call_storyline_ambiguous", "read_storyline", arguments(["name": "暗线"])),
            ("call_overview", "project_overview", "{}"),
        ], "读一读项目。")
        found = results(harness)
        try require((try journal.originals(since: mark)).isEmpty && harness.conversation.proposals.isEmpty, "Reads wrote to the journal")

        let types = json(found["call_types"])["types"] as? [[String: Any]] ?? []
        try require(types.map { $0["name"] as? String ?? "" }.sorted() == ["发生于", "师徒", "盟友"]
            && types.first { $0["name"] as? String == "盟友" }?["orientation"] as? String == "对称"
            && types.first { $0["name"] as? String == "师徒" }?["relationCount"] as? Int == 1
            && types.first { $0["name"] as? String == "发生于" }?["targetKinds"] as? [String] == ["章节或漂流"], "list_relation_types differs: \(types)")
        let relations = json(found["call_relations"]), lanRelations = json(found["call_relations_lan"])
        try require(relations["count"] as? Int == 3 && lanRelations["count"] as? Int == 1
            && ((lanRelations["relations"] as? [[String: Any]])?.first?["text"] as? String) == "设定「林岚」（师父）→ 设定「周策」（徒弟）",
            "list_relations differs: \(lanRelations)")
        let ambiguous = found["call_relations_ambiguous"]?.text ?? ""
        try require(found["call_relations_ambiguous"]?.ok == false && ambiguous.contains("有 2 个章节都叫《北岸》")
            && ambiguous.contains(f.chapter["北岸"]!.id) && ambiguous.contains(f.chapter["《北岸》"]!.id), "An ambiguous chapter was not refused with candidates: \(ambiguous)")
        let open = json(found["call_comments"])["comments"] as? [[String: Any]] ?? []
        try require(open.count == 3 && Set(open.compactMap { $0["on"] as? String }) == ["浮动待办", "章节《北岸》", "设定「林岚」"]
            && open.first { $0["body"] as? String == "整理时间线" }?["priority"] as? String == "低"
            && json(found["call_comments_resolved"])["count"] as? Int == 1 && json(found["call_comments_todo"])["count"] as? Int == 2,
            "list_comments differs: \(open)")
        let materials = json(found["call_materials"])["materials"] as? [[String: Any]] ?? []
        let materialText = found["call_materials"]?.text ?? ""
        try require(materials.count == 4 && !materialText.contains("assetPath")
            && !materialText.replacingOccurrences(of: "https://example.com/tides", with: "").contains("/"), "list_materials differs: \(materialText)")
        try require(materials.first { $0["title"] as? String == "潮汐表" }?["preview"] as? String == "初一大潮。\n十五小潮。"
            && json(found["call_material"])["text"] as? String == "初一大潮。\n十五小潮。"
            && json(found["call_material_link"])["url"] as? String == "https://example.com/tides", "read_material differs")
        let sketch = found["call_material_ambiguous"]?.text ?? ""
        try require(sketch.contains("有 2 条素材都叫「草图」") && sketch.contains(f.material["草图"]!.id) && sketch.contains(f.material["草图2"]!.id),
            "Ambiguous materials were not refused with candidates: \(sketch)")
        let lanPatches = json(found["call_patches_lan"]), cePatches = json(found["call_patches_ce"])
        try require(lanPatches["count"] as? Int == 2 && (lanPatches["patches"] as? [[String: Any]])?.map { $0["title"] as? String ?? "" } == ["受伤", "离开"]
            && cePatches["count"] as? Int == 0 && (cePatches["note"] as? String)?.contains("另有 1 条补丁已失效") == true,
            "get_element_patches differs: \(lanPatches) \(cePatches)")
        let search = json(found["call_search"])
        let chapterHits = search["chapters"] as? [[String: Any]] ?? [], entityHits = search["entities"] as? [[String: Any]] ?? []
        try require(chapterHits.contains { $0["chapterTitle"] as? String == "启程" }
            && entityHits.contains { $0["kind"] as? String == "设定" && $0["title"] as? String == "林岚" }
            && entityHits.contains { $0["kind"] as? String == "漂流" && $0["title"] as? String == "灯塔笔记" }
            && entityHits.contains { $0["kind"] as? String == "故事线" && $0["title"] as? String == "主线" }, "search_project differs: \(search)")
        let appearances = json(found["call_appearances"])
        try require((appearances["chapters"] as? [[String: Any]])?.map { $0["title"] as? String ?? "" } == ["启程"]
            && (appearances["pages"] as? [[String: Any]])?.map { "\($0["kind"] as? String ?? "")·\($0["title"] as? String ?? "")" } == ["漂流·灯塔笔记"],
            "find_element_appearances differs: \(appearances)")
        let storyline = json(found["call_storyline"])
        try require(storyline["text"] as? String == "林岚回到灯塔。" && (storyline["chapters"] as? [[String: Any]])?.count == toolChapters.count
            && (storyline["chapters"] as? [[String: Any]])?.allSatisfy { $0["primary"] as? Bool == true } == true, "read_storyline differs: \(storyline)")
        try require(found["call_storyline_ambiguous"]?.text.contains("有 2 条故事线都叫「暗线」") == true, "An ambiguous storyline was not refused")
        let overview = json(found["call_overview"])
        try require(overview["elementCount"] as? Int == 5 && overview["categoryCount"] as? Int == 4 && overview["storylineCount"] as? Int == 4
            && overview["driftCount"] as? Int == 4 && overview["relationCount"] as? Int == 3 && overview["openTodoCount"] as? Int == 2
            && overview["materialCount"] as? Int == 4 && overview["chapterCount"] as? Int == toolChapters.count
            && (overview["facts"] as? [[String: Any]])?.first?["value"] as? String == "第三人称", "project_overview differs: \(overview)")
        let texts = harness.panel.transcriptTexts
        try require(texts.contains("列出关系类型（3 种）") && texts.contains("查找「林岚」出现的位置（1 章，1 个页面）")
            && texts.contains("读取故事线「主线」"), "Read activity lines differ: \(texts)")

        // 被引用 lists the drift page after the chapter and opens it at its first link.
        let _: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, element: lan, completion: $0) }
        guard let page = harness.host.retainedElementPage(pane: 0, scope: ElementScope(projectID: harness.project.id, elementID: lan.id)) else {
            throw LabError.message("The element page was not retained")
        }
        try wait { page.backlinks?.chapters.count == 1 && page.backlinks?.sources.count == 1 }
        let links = page.backlinks!
        try require(links.sources[0].kind == "drift" && links.sources[0].id == f.drift["灯塔笔记"]!.id
            && links.sources[0].first == NativeRange(location: 0, length: 2) && links.unavailableSources.isEmpty,
            "The page sources differ: \(links.sources)")
        try require(page.backlinksView.chapterButtons.map { $0.accessibilityLabel() ?? "" } == ["启程，1 处 · 1 次"]
            && page.backlinksView.sourceButtons.map { $0.accessibilityLabel() ?? "" } == ["漂流「灯塔笔记」，1 处 · 1 次"],
            "被引用 rows differ: \(page.backlinksView.sourceButtons.map { $0.accessibilityLabel() ?? "" })")
        page.backlinksView.show(WorkspaceElementBacklinks(elementId: lan.id, chapters: links.chapters, sources: links.sources, unavailable: [],
                                                          unavailableSources: [.init(kind: "category", id: "unreadable", title: "远方")]))
        try require(page.backlinksView.mutedLines == ["分类「远方」 · 暂时无法读取"], "An unreadable page was not listed muted")
        page.backlinksView.show(links)
        let driftView = harness.host.openView(scope: .drift(DriftScope(projectID: harness.project.id, driftID: f.drift["灯塔笔记"]!.id)))
        driftView?.textView.setSelectedRange(NSRange(location: 5, length: 0))
        page.backlinksView.sourceButtons[0].performClick(nil)
        try wait { !harness.host.isBusy && harness.host.activeDrift?.id == f.drift["灯塔笔记"]!.id
            && harness.host.activeView?.textView.selectedRange() == NSRange(location: 0, length: 2) }
        try require(harness.host.activeView === driftView, "The drift page opened with another owner")
        try require((try journal.originals(since: mark)).isEmpty, "Backlink navigation wrote to the journal")
        try harness.close()
    }

    // MARK: (b) Writes

    private static func writeCases(_ f: ToolFixture) -> [ToolWriteCase] {
        let ambiguousChapter = ["有 2 个章节都叫《北岸》", f.chapter["北岸"]!.id, f.chapter["《北岸》"]!.id]
        let ambiguousCategory = ["有 2 个分类都叫「器物」", f.category["器物1"]!.id, f.category["器物2"]!.id]
        let ambiguousStoryline = ["有 2 条故事线都叫「暗线」", f.storyline["暗线"]!.id, f.storyline["《暗线》"]!.id]
        let ambiguousDrift = ["有 2 条漂流都叫「潮汐」", f.drift["潮汐"]!.id, f.drift["《潮汐》"]!.id]
        let lan = f.element["林岚"]!
        return [
            ToolWriteCase(tool: "create_element",
                          valid: ["category": "人物", "name": "沈舟", "group": "北岸众", "summary": "渡口的船夫。", "aliases": ["老沈", " "],
                                  "facts": [["key": "年龄", "value": "四十"]], "text": "他在渡口等了一夜。\n天亮时起风。"],
                          invalid: ["category": "人物", "name": 3], invalidReason: "参数 name 必须是文字。",
                          refused: ["category": "器物", "name": "铜铃"], refusedReason: ambiguousCategory,
                          card: ["新建设定「沈舟」", "分类", "人物", "北岸众", "渡口的船夫。", "老沈", "年龄：四十", "他在渡口等了一夜。\n天亮时起风。"],
                          journal: [["entity.create kv-entry", "order.move kv-entry", "entity.create element", "set.add alias", "yjs.update prose-document"], ["yjs.update prose-document"]], extra: [(["category": "人物", "name": "阿岚"], "“阿岚”已被设定「林岚」使用"),
                                               (["name": "无类"], "请用 categoryId 或 category 指定")]),
            ToolWriteCase(tool: "update_element",
                          valid: ["name": "周策", "newName": "周子策", "summary": "北塔守卫。", "aliases": ["阿策"], "group": "守卫"],
                          invalid: ["elementId": ["x"]], invalidReason: "参数 elementId 必须是文字。",
                          refused: ["name": "周策", "category": "器物"], refusedReason: ambiguousCategory,
                          card: ["修改设定「周策」", "名称", "周子策", "北塔守卫。", "阿策", "守卫"], journal: [["set.add alias", "field.set element", "field.set element", "field.set element"]],
                          extra: [(["name": "周策", "summary": ""], "已经是这些内容"), (["name": "不存在的人"], "找不到名为「不存在的人」的设定")]),
            ToolWriteCase(tool: "set_element_facts",
                          valid: ["name": "北塔", "facts": [["key": "高度", "value": "九层"], ["key": "建于", "value": "旧朝"], ["key": " ", "value": ""]]],
                          invalid: ["name": "北塔"], invalidReason: "缺少必填参数 facts。",
                          refused: ["name": "不存在的设定", "facts": []], refusedReason: ["找不到名为「不存在的设定」的设定"],
                          card: ["修改设定「北塔」的字段", "高度：九层\n建于：旧朝"], journal: [["entity.create kv-entry", "entity.create kv-entry", "order.move kv-entry", "order.move kv-entry"]]),
            ToolWriteCase(tool: "create_element_category",
                          valid: ["name": "天象"], invalid: ["name": "天象", "color": "#FFFFFF"], invalidReason: "不支持参数 color。",
                          refused: ["name": "人物"], refusedReason: ["已有名为「人物」的分类"],
                          card: ["新建分类「天象」", "名称", "天象", "颜色由应用选择。"], journal: [["entity.create element-category", "yjs.update prose-document"]]),
            ToolWriteCase(tool: "update_element_category",
                          valid: ["name": "地点", "newName": "地理", "color": "#3366cc"],
                          invalid: ["name": "地点", "color": "blue"], invalidReason: "参数 color 的格式不正确。",
                          refused: ["name": "器物", "newName": "器具"], refusedReason: ambiguousCategory,
                          card: ["修改分类「地点」", "地点", "地理", "#3366CC"], journal: [["field.set element-category", "field.set element-category"]]),
            ToolWriteCase(tool: "trash_element",
                          valid: ["name": "旧物"], invalid: ["name": "旧物", "hard": true], invalidReason: "不支持参数 hard。",
                          refused: ["elementId": "element-missing"], refusedReason: ["找不到编号为 element-missing 的设定"],
                          card: ["把设定「旧物」移到回收站", "它的 1 条关系会被删除", "（移到回收站）"], journal: [["entity.purge entity-relation", "entity.trash element"]]),
            ToolWriteCase(tool: "create_element_patch",
                          valid: ["name": "林岚", "title": "复明", "body": "她的眼睛好了。", "sourceChapterTitle": "启程"],
                          invalid: ["name": "林岚"], invalidReason: "缺少必填参数 body。",
                          refused: ["name": "林岚", "body": "x", "sourceChapterTitle": "北岸"], refusedReason: ambiguousChapter,
                          card: ["为设定「林岚」添加补丁", "复明", "她的眼睛好了。", "来源章节", "《启程》"], journal: [["entity.create element-patch", "order.move element-patch"]],
                          extra: [(["name": "林岚", "title": " ", "body": "\n"], "补丁的标题和内容不能都为空")]),
            ToolWriteCase(tool: "update_element_patch",
                          valid: ["name": "林岚", "patchId": f.patch["受伤"]!.id, "title": "重伤", "body": "左臂重伤。"],
                          invalid: ["name": "林岚"], invalidReason: "缺少必填参数 patchId。",
                          refused: ["name": "林岚", "patchId": "patch-missing"], refusedReason: ["没有编号为 patch-missing 的补丁"],
                          card: ["修改设定「林岚」的补丁", "受伤", "重伤", "左臂受伤。", "左臂重伤。"], journal: [["field.set element-patch", "field.set element-patch"]]),
            ToolWriteCase(tool: "delete_element_patch",
                          valid: ["elementId": lan.id, "patchId": f.patch["离开"]!.id],
                          invalid: ["elementId": lan.id, "patchId": 5], invalidReason: "参数 patchId 必须是文字。",
                          refused: ["name": "不存在", "patchId": f.patch["离开"]!.id], refusedReason: ["找不到名为「不存在」的设定"],
                          card: ["删除设定「林岚」的补丁", "离开\n离开北塔。", "（删除）"], journal: [["entity.trash element-patch"]]),
            ToolWriteCase(tool: "create_storyline",
                          valid: ["name": "回忆线", "summary": "林岚的童年。"], invalid: [:], invalidReason: "缺少必填参数 name。",
                          refused: ["name": "主线"], refusedReason: ["已有名为「主线」的故事线"],
                          card: ["新建故事线「回忆线」", "回忆线", "林岚的童年。"], journal: [["entity.create storyline", "yjs.update prose-document", "order.move storyline"], ["field.set storyline"]]),
            ToolWriteCase(tool: "update_storyline",
                          valid: ["name": "支线", "newName": "副线", "summary": "周策的故事。", "color": "#22AA66"],
                          invalid: ["name": "支线", "color": "#12"], invalidReason: "参数 color 的格式不正确。",
                          refused: ["name": "暗线", "summary": "x"], refusedReason: ambiguousStoryline,
                          card: ["修改故事线「支线」", "副线", "周策的故事。", "#22AA66"], journal: [["field.set storyline", "field.set storyline", "field.set storyline"]]),
            ToolWriteCase(tool: "set_chapter_storylines",
                          valid: ["title": "归途", "storylines": ["主线", f.storyline["支线"]!.id], "primary": f.storyline["支线"]!.id],
                          invalid: ["title": "归途", "storylines": "主线"], invalidReason: "参数 storylines 必须是数组。",
                          refused: ["title": "北岸", "storylines": ["主线"]], refusedReason: ambiguousChapter,
                          card: ["设置《归途》的故事线", "故事线", "主线、支线", "主线", "支线"], journal: [["set.add membership", "field.set node-storyline-primary"]],
                          extra: [(["title": "归途", "storylines": ["暗线"]], "有 2 条故事线都叫「暗线」"),
                                  (["title": "归途", "storylines": ["主线"], "primary": "支线"], "必须在 storylines 之中"),
                                  (["title": "归途", "storylines": ["主线"]], "已经是这样归属的")]),
            ToolWriteCase(tool: "revise_storyline",
                          valid: ["name": "主线", "changes": [["currentText": "灯塔", "revisedText": "北塔灯塔"]]],
                          invalid: ["name": "主线", "changes": []], invalidReason: "参数 changes 至少需要 1 项。",
                          refused: ["name": "暗线", "changes": [["currentText": "a", "revisedText": "b"]]], refusedReason: ambiguousStoryline,
                          card: ["修改故事线「主线」", "灯塔", "北塔灯塔"], journal: [["yjs.update prose-document"]]),
            ToolWriteCase(tool: "append_to_body",
                          valid: ["kind": "storyline", "name": "主线", "text": "后来她离开了。"],
                          invalid: ["kind": "storyline", "name": "主线"], invalidReason: "缺少必填参数 text。",
                          refused: ["kind": "storyline", "name": "暗线", "text": "x"], refusedReason: ambiguousStoryline,
                          card: ["续写故事线「主线」", "后来她离开了。"], journal: [["yjs.update prose-document"]]),
            ToolWriteCase(tool: "create_relation",
                          valid: ["from": ["kind": "element", "name": "阿岚"], "to": ["kind": "element", "id": f.element["北塔"]!.id], "relationType": "盟友"],
                          invalid: ["from": ["kind": "person", "name": "林岚"], "to": ["kind": "element", "name": "北塔"], "relationType": "盟友"],
                          invalidReason: "参数 from.kind 必须是以下之一",
                          refused: ["from": ["kind": "drift", "name": "潮汐"], "to": ["kind": "element", "name": "林岚"], "relationType": "盟友"],
                          refusedReason: ambiguousDrift,
                          card: ["新建关系「盟友」", "盟友（对称 · 盟友）", "设定「林岚」 ↔ 设定「北塔」（盟友）"], journal: [["entity.create entity-relation"]],
                          extra: [(["from": ["kind": "chapter", "name": "启程"], "to": ["kind": "element", "name": "林岚"], "relationType": "师徒"],
                                   "关系类型「师徒」要求 师父 → 徒弟"),
                                  (["from": ["kind": "element", "name": "林岚"], "to": ["kind": "element", "name": "周策"], "relationType": "师徒"],
                                   "这条关系已经存在"),
                                  (["from": ["kind": "element", "name": "林岚"], "to": ["kind": "element", "name": "北塔"], "relationType": "师生"],
                                   "找不到关系类型「师生」")]),
            ToolWriteCase(tool: "update_relation",
                          valid: ["relationId": f.relation["师徒"]!.id, "swap": true],
                          invalid: ["relationId": f.relation["师徒"]!.id, "swap": "yes"], invalidReason: "参数 swap 必须是 true 或 false。",
                          refused: ["relationId": "relation-missing"], refusedReason: ["找不到编号为 relation-missing 的关系"],
                          card: ["修改关系「师徒」", "设定「林岚」（师父）→ 设定「周策」（徒弟）", "设定「周策」（师父）→ 设定「林岚」（徒弟）"], journal: [Array(repeating: "field.set entity-relation", count: 5)],
                          extra: [(["relationId": f.relation["盟友"]!.id, "swap": true], "对称关系没有方向"),
                                  (["relationId": f.relation["师徒"]!.id], "已经是这个类型")]),
            ToolWriteCase(tool: "delete_relation",
                          valid: ["relationId": f.relation["发生于"]!.id], invalid: [:], invalidReason: "缺少必填参数 relationId。",
                          refused: ["relationId": "relation-missing"], refusedReason: ["找不到编号为 relation-missing 的关系"],
                          card: ["删除关系「发生于」", "设定「周策」（人物）→ 章节《启程》（地点）", "（删除）"], journal: [["entity.purge entity-relation"]]),
            ToolWriteCase(tool: "create_relation_type",
                          valid: ["name": "宿敌", "orientation": "symmetric", "sourceRole": "宿敌", "sourceKinds": ["element", "node"]],
                          invalid: ["name": "宿敌", "orientation": "both", "sourceRole": "x", "sourceKinds": ["element"]],
                          invalidReason: "参数 orientation 必须是以下之一：directed、symmetric。",
                          refused: ["name": "师徒", "orientation": "directed", "sourceRole": "a", "targetRole": "b", "sourceKinds": ["element"], "targetKinds": ["element"]],
                          refusedReason: ["已有名为「师徒」的关系类型"],
                          card: ["新建关系类型「宿敌」", "对称", "宿敌", "章节或漂流、设定"], journal: [["entity.create entity-relation-type"]],
                          extra: [(["name": "对手", "orientation": "directed", "sourceRole": "a", "sourceKinds": ["element"]], "有向关系需要两端的角色")]),
            ToolWriteCase(tool: "create_comment",
                          valid: ["kind": "note", "target": ["kind": "element", "name": "林岚"], "body": "补充她的来历。", "priority": "high"],
                          invalid: ["kind": "memo", "body": "x"], invalidReason: "参数 kind 必须是以下之一：note、todo。",
                          refused: ["kind": "note", "target": ["kind": "chapter", "name": "北岸"], "body": "x"], refusedReason: ambiguousChapter,
                          card: ["在设定「林岚」上添加批注", "位置", "批注", "高", "补充她的来历。"], journal: [["entity.create comment"]],
                          extra: [(["kind": "note", "body": "x"], "浮动的只能是待办")]),
            ToolWriteCase(tool: "update_comment",
                          valid: ["commentId": f.comment["时间线"]!.id, "body": "整理全书时间线。", "priority": "high"],
                          invalid: ["commentId": f.comment["时间线"]!.id, "priority": "urgent"],
                          invalidReason: "参数 priority 必须是以下之一：low、med、high、none。",
                          refused: ["commentId": "comment-missing"], refusedReason: ["找不到编号为 comment-missing 的批注或待办"],
                          card: ["修改浮动待办", "整理时间线", "整理全书时间线。", "低", "高"], journal: [["field.set comment", "field.set comment"]],
                          extra: [(["commentId": f.comment["时间线"]!.id, "kind": "note"], "浮动的待办不能转为批注")]),
            ToolWriteCase(tool: "resolve_comment",
                          valid: ["commentId": f.comment["节奏"]!.id], invalid: ["commentId": f.comment["节奏"]!.id, "resolved": "yes"],
                          invalidReason: "参数 resolved 必须是 true 或 false。",
                          refused: ["commentId": "comment-missing"], refusedReason: ["找不到编号为 comment-missing 的批注或待办"],
                          card: ["把章节《北岸》的批注标为已解决", "未解决", "已解决", "这里节奏慢"], journal: [["field.set comment", "field.set comment"]],
                          extra: [(["commentId": f.comment["已处理"]!.id], "已经是已解决")]),
            ToolWriteCase(tool: "rename_chapter",
                          valid: ["title": "改名章", "newTitle": "潮声"], invalid: ["title": "改名章"], invalidReason: "缺少必填参数 newTitle。",
                          refused: ["title": "北岸", "newTitle": "x"], refusedReason: ambiguousChapter,
                          card: ["把《改名章》改名为《潮声》", "改名章", "潮声"], journal: [["field.set node"]],
                          extra: [(["title": "改名章", "newTitle": "潮汐"], "已有章节或漂流叫《潮汐》")]),
            ToolWriteCase(tool: "trash_chapter",
                          valid: ["title": "旧章"], invalid: ["title": "旧章", "force": true], invalidReason: "不支持参数 force。",
                          refused: ["title": "北岸"], refusedReason: ambiguousChapter,
                          card: ["把《旧章》移到回收站", "（移到回收站）", "可以从章节回收站恢复"], journal: [["entity.trash node"]]),
            ToolWriteCase(tool: "create_drift",
                          valid: ["title": "雾港", "text": "雾从港口升起。"], invalid: ["title": "雾港", "text": 7], invalidReason: "参数 text 必须是文字。",
                          refused: ["title": "潮汐"], refusedReason: ["已有章节或漂流叫「潮汐」"],
                          card: ["新建漂流「雾港」", "雾港", "雾从港口升起。"], journal: [["entity.create node", "yjs.update prose-document"], ["yjs.update prose-document"]]),
            ToolWriteCase(tool: "rename_drift",
                          valid: ["title": "待改名", "newTitle": "夜航"], invalid: ["title": "待改名"], invalidReason: "缺少必填参数 newTitle。",
                          refused: ["title": "潮汐", "newTitle": "x"], refusedReason: ambiguousDrift,
                          card: ["把漂流「待改名」改名为「夜航」", "待改名", "夜航"], journal: [["field.set node"]]),
            ToolWriteCase(tool: "set_drift_summary",
                          valid: ["title": "灯塔笔记", "summary": "守灯人的记录。"], invalid: ["title": "灯塔笔记"], invalidReason: "缺少必填参数 summary。",
                          refused: ["title": "潮汐", "summary": "x"], refusedReason: ambiguousDrift,
                          card: ["修改漂流「灯塔笔记」的摘要", "守灯人的记录。"], journal: [["field.set node"]]),
            ToolWriteCase(tool: "update_project_facts",
                          valid: ["facts": [["key": "视角", "value": "第一人称"], ["key": "时代", "value": "近未来"]]],
                          invalid: ["facts": [["key": "视角"]]], invalidReason: "缺少必填参数 facts[0].value。",
                          refused: ["facts": [["key": "视角", "value": "第三人称"]]], refusedReason: ["本书字段已经是这些内容"],
                          card: ["修改本书字段", "视角：第三人称", "视角：第一人称\n时代：近未来"], journal: [["field.set kv-entry", "entity.create kv-entry", "order.move kv-entry"]]),
            ToolWriteCase(tool: "update_project_summary",
                          valid: ["summary": "灯塔与潮汐。"], invalid: ["summary": NSNull()], invalidReason: "参数 summary 必须是文字。",
                          refused: ["summary": "一部关于灯塔的小说。"], refusedReason: ["本书简介已经是这段内容"],
                          card: ["修改本书简介", "一部关于灯塔的小说。", "灯塔与潮汐。"], journal: [["field.set project"]]),
        ]
    }

    private static func agentToolWrites() throws {
        let harness = try AgentHarness(titles: toolChapters)
        defer { harness.remove() }
        let f = try toolFixture(harness, bodies: false)
        let journal = JournalProbe(directory: harness.directory)
        let p = harness.project.id, w = harness.workspace
        let cases = writeCases(f)
        try require(Set(cases.map(\.tool)) == Set(AgentToolRegistry.all.filter { $0.access == .write }.map(\.name))
            .subtracting(["revise_chapter", "revise_element", "revise_category", "revise_drift", "create_chapter", "set_chapter_summary"]),
            "Not every domain write has a case")

        // One turn proposes every case: refusals leave no proposal, nothing is written.
        var calls: [(id: String, name: String, arguments: String)] = []
        for (index, item) in cases.enumerated() {
            calls.append(("w\(index)_invalid", item.tool, arguments(item.invalid)))
            calls.append(("w\(index)_refused", item.tool, arguments(item.refused)))
            for (extra, entry) in item.extra.enumerated() { calls.append(("w\(index)_extra\(extra)", item.tool, arguments(entry.arguments))) }
            calls.append(("w\(index)_accept", item.tool, arguments(item.valid)))
            calls.append(("w\(index)_reject", item.tool, arguments(item.valid)))
        }
        var mark = try journal.mark()
        try turn(harness, calls, "按这些要求修改。")
        let found = results(harness)
        for (index, item) in cases.enumerated() {
            let invalid = found["w\(index)_invalid"], refused = found["w\(index)_refused"]
            try require(invalid?.ok == false && invalid?.text.contains(item.invalidReason) == true,
                "\(item.tool) did not refuse its schema violation: \(invalid?.text ?? "none")")
            try require(refused?.ok == false && item.refusedReason.allSatisfy { refused?.text.contains($0) == true },
                "\(item.tool) did not refuse its reference: \(refused?.text ?? "none")")
            for (extra, entry) in item.extra.enumerated() {
                let result = found["w\(index)_extra\(extra)"]
                try require(result?.ok == false && result?.text.contains(entry.reason) == true, "\(item.tool) extra \(extra) differs: \(result?.text ?? "none")")
            }
            for suffix in ["accept", "reject"] {
                let id = "w\(index)_\(suffix)"
                guard let proposal = harness.proposal(id), let card = harness.card(id) else { throw LabError.message("\(item.tool) made no proposal: \(found[id]?.text ?? "")") }
                try require(proposal.state == .pending && found[id]?.ok == true && found[id]?.text.contains("内容尚未改变") == true
                    && card.stateLabel.stringValue == "等待你的决定", "\(item.tool) proposal is not pending")
                try require(item.card.allSatisfy { card.plainText.contains($0) }, "\(item.tool) card lacks \(item.card.filter { !card.plainText.contains($0) }): \(card.plainText)")
            }
        }
        try require(harness.conversation.proposals.count == cases.count * 2, "Refusals made proposals: \(harness.conversation.proposals.count)")
        try require((try journal.originals(since: mark)).isEmpty, "Proposals wrote before 接受")

        // 旧章 is open in a tab; its trash closes the tab once Rust commits.
        let old = try harness.open(toolChapters.firstIndex(of: "旧章")!)
        try require(harness.host.hasTab(.chapter(ChapterScope(projectID: p, chapterID: f.chapter["旧章"]!.id))), "旧章 did not open")
        _ = old

        // 接受 applies exactly the expected originals; 拒绝 writes nothing.
        for (index, item) in cases.enumerated() {
            mark = try journal.mark()
            try accept(harness, "w\(index)_accept")
            let proposal = harness.proposal("w\(index)_accept")
            try require(proposal?.state == .accepted && harness.card("w\(index)_accept")?.stateLabel.stringValue == "已接受"
                && harness.card("w\(index)_accept")?.acceptButton.superview == nil,
                "\(item.tool) was not accepted: \(proposal?.message ?? "")")
            try journal.expect(item.journal, since: mark, "\(item.tool) 接受")
            mark = try journal.mark()
            harness.card("w\(index)_reject")?.rejectButton.performClick(nil)
            try require(harness.proposal("w\(index)_reject")?.state == .rejected && (try journal.originals(since: mark)).isEmpty,
                "\(item.tool) 拒绝 wrote to the journal")
        }

        // Stored results.
        let library: WorkspaceElementLibrary = try elementResult { w.elementLibrary(projectID: p, completion: $0) }
        guard let shen = library.elements.first(where: { $0.name == "沈舟" }) else { throw LabError.message("沈舟 was not created") }
        try require(shen.categoryId == f.category["人物"]!.id && shen.groupName == "北岸众" && shen.summary == "渡口的船夫。"
            && shen.aliases == ["老沈"] && shen.facts == [WorkspaceFact(key: "年龄", value: "四十")]
            && harness.proposal("w0_accept")?.targetID == shen.id, "create_element stored \(shen)")
        let shenBody: WorkspaceAgentProse = try elementResult { w.agentReadProse(projectID: p, kind: "element", id: shen.id, completion: $0) }
        try require(shenBody.text == "他在渡口等了一夜。\n天亮时起风。", "create_element body differs: \(shenBody.text)")
        let ce = library.elements.first { $0.id == f.element["周策"]!.id }
        try require(ce?.name == "周子策" && ce?.summary == "北塔守卫。" && ce?.aliases == ["阿策"] && ce?.groupName == "守卫", "update_element stored \(String(describing: ce))")
        try require(library.elements.first { $0.id == f.element["北塔"]!.id }?.facts
            == [WorkspaceFact(key: "高度", value: "九层"), WorkspaceFact(key: "建于", value: "旧朝")], "set_element_facts differs")
        try require(library.categories.contains { $0.name == "天象" } && library.categories.first { $0.id == f.category["地点"]!.id }.map { ($0.name, $0.color) } ?? ("", "") == ("地理", "#3366CC"),
            "Category writes differ: \(library.categories.map { ($0.name, $0.color) })")
        try require(library.trashedElements.contains { $0.id == f.element["旧物"]!.id }, "trash_element did not trash 旧物")
        let patches: [WorkspacePatch] = try elementResult { w.elementPatches(projectID: p, elementID: f.element["林岚"]!.id, completion: $0) }
        try require(patches.map { "\($0.title ?? "")|\($0.body)|\($0.sourceNodeId ?? "")" }
            == ["重伤|左臂重伤。|", "复明|她的眼睛好了。|\(f.chapter["启程"]!.id)"], "Patch writes differ: \(patches.map { $0.title ?? "" })")
        let storylines: WorkspaceStorylineLibrary = try elementResult { w.storylineLibrary(projectID: p, completion: $0) }
        try require(storylines.storylines.contains { $0.name == "回忆线" && $0.summary == "林岚的童年。" }
            && storylines.storyline(id: f.storyline["支线"]!.id).map { ($0.name, $0.summary, $0.color) } ?? ("", "", "") == ("副线", "周策的故事。", "#22AA66")
            && storylines.membership(chapterID: f.chapter["归途"]!.id).map { (Set($0.storylineIds), $0.primary) } ?? ([], nil)
                == (Set([f.storyline["主线"]!.id, f.storyline["支线"]!.id]), f.storyline["支线"]!.id), "Storyline writes differ")
        let mainBody: WorkspaceAgentProse = try elementResult { w.agentReadProse(projectID: p, kind: "storyline", id: f.storyline["主线"]!.id, completion: $0) }
        try require(mainBody.text == "林岚回到北塔灯塔。\n后来她离开了。", "Storyline body writes differ: \(mainBody.text)")
        guard case .integer(let storylineAgentRows)? = try WorkspaceRemoteProseFixture.query(in: harness.directory, sql: """
            SELECT COUNT(*) AS n FROM yjs_document_revision_provenance WHERE document_id = ? AND source_kind = 'agent' AND agent_session_id = ?
            """, parameters: [.text("storyline:\(f.storyline["主线"]!.id)"), .text(harness.conversation.id)]).first?["n"], storylineAgentRows == 2 else {
            throw LabError.message("The storyline revision and append lack Agent provenance")
        }
        let relations: WorkspaceRelationLibrary = try elementResult { w.relationLibrary(projectID: p, completion: $0) }
        let lanEnd = RelationEndpoint(kind: "element", id: f.element["林岚"]!.id), ceEnd = RelationEndpoint(kind: "element", id: f.element["周策"]!.id)
        try require(relations.relation(id: f.relation["师徒"]!.id).map { ($0.from, $0.to) } ?? (lanEnd, lanEnd) == (ceEnd, lanEnd)
            && relations.relation(id: f.relation["发生于"]!.id) == nil && relations.relation(id: f.relation["盟友"]!.id) == nil
            && relations.relations.contains { $0.relationTypeId == f.type["盟友"]!.id && Set([$0.fromId, $0.toId]) == Set([f.element["林岚"]!.id, f.element["北塔"]!.id]) }
            && relations.types.contains { $0.name == "宿敌" && $0.isSymmetric && $0.sourceKinds == ["node", "element"] }, "Relation writes differ")
        let comments: [WorkspaceComment] = try elementResult { w.projectComments(projectID: p, completion: $0) }
        try require(comments.contains { $0.kind == "note" && $0.targetId == f.element["林岚"]!.id && $0.bodyText == "补充她的来历。" && $0.priority == "high" }
            && comments.first { $0.id == f.comment["时间线"]!.id }.map { ($0.bodyText, $0.priority) } ?? ("", nil) == ("整理全书时间线。", "high")
            && comments.first { $0.id == f.comment["节奏"]!.id }?.review == .resolved, "Comment writes differ")
        let chapters: [WorkspaceChapter] = try elementResult { w.chapters(projectID: p, completion: $0) }
        try require(chapters.map(\.title) == ["启程", "北岸", "《北岸》", "归途", "潮声"], "Chapter writes differ: \(chapters.map(\.title))")
        try require(!harness.host.hasTab(.chapter(ChapterScope(projectID: p, chapterID: f.chapter["旧章"]!.id))), "The trashed chapter's tab stayed open")
        let drifts: WorkspaceDriftLibrary = try elementResult { w.driftLibrary(projectID: p, completion: $0) }
        guard let fog = drifts.drifts.first(where: { $0.title == "雾港" }) else { throw LabError.message("雾港 was not created") }
        let fogBody: WorkspaceAgentProse = try elementResult { w.agentReadProse(projectID: p, kind: "drift", id: fog.id, completion: $0) }
        try require(fogBody.text == "雾从港口升起。" && drifts.drift(id: f.drift["待改名"]!.id)?.title == "夜航"
            && drifts.drift(id: f.drift["灯塔笔记"]!.id)?.summary == "守灯人的记录。", "Drift writes differ")
        let details: WorkspaceProjectDetails = try elementResult { w.projectDetails(projectID: p, completion: $0) }
        try require(details.summary == "灯塔与潮汐。" && details.facts == [WorkspaceFact(key: "视角", value: "第一人称"), WorkspaceFact(key: "时代", value: "近未来")],
            "Project writes differ")
        // Open views followed: the element library, chapter list and relations.
        try require(harness.effects.contains { if case .elements = $0 { return true }; return false }
            && harness.effects.contains { if case .chapterTrashed = $0 { return true }; return false }
            && harness.effects.contains { if case .comments = $0 { return true }; return false }, "Effects were not reported")

        // Each outcome is told to the model once.
        AgentStubProtocol.reset([AgentSSE.deepseekText(["收到。"]), AgentSSE.deepseekText(["好。"])])
        try harness.send("结果如何？")
        let note = AgentHarness.lastUserText(AgentStubProtocol.requests[0].body)
        for index in cases.indices {
            try require(count(note, "提案 w\(index)_accept（") == 1 && count(note, "提案 w\(index)_reject（") == 1,
                "\(cases[index].tool) outcomes were not reported once: \(note)")
        }
        try require(count(note, "作者已接受") == cases.count && count(note, "作者已拒绝") == cases.count && note.contains("创建设定「沈舟」"),
            "The outcome lines differ: \(note)")
        try harness.send("还有吗？")
        try require(!AgentHarness.lastUserText(AgentStubProtocol.requests[1].body).contains("提案"), "Outcomes were reported twice")
        try harness.close()
    }

    // MARK: (c) Refusals

    private static func agentToolRefusals() throws {
        let harness = try AgentHarness(titles: toolChapters)
        defer { harness.remove() }
        let f = try toolFixture(harness, bodies: false)
        let journal = JournalProbe(directory: harness.directory)
        let p = harness.project.id, w = harness.workspace

        // Targets that change before 接受: Rust refuses, nothing is written.
        try turn(harness, [
            ("r_update", "update_element", arguments(["name": "周策", "summary": "新的简介。"])),
            ("r_create", "create_element", arguments(["category": "人物", "name": "新人"])),
            ("r_relation", "create_relation", arguments(["from": ["kind": "element", "name": "灯笼"], "to": ["kind": "element", "name": "林岚"], "relationType": "盟友"])),
            ("r_comment", "update_comment", arguments(["commentId": f.comment["时间线"]!.id, "body": "新的内容"])),
            ("r_patch", "update_element_patch", arguments(["name": "林岚", "patchId": f.patch["受伤"]!.id, "body": "新的变化"])),
            ("r_storylines", "set_chapter_storylines", arguments(["title": "归途", "storylines": ["支线"]])),
            ("r_rename", "rename_chapter", arguments(["title": "改名章", "newTitle": "潮声"])),
        ], "改一改。")
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult { w.trashElement(projectID: p, elementID: f.element["周策"]!.id, completion: $0) }
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult { w.createElement(projectID: p, categoryID: f.category["地点"]!.id, name: "新人", completion: $0) }
        let _: WorkspaceElementReply<WorkspaceElement> = try elementResult { w.trashElement(projectID: p, elementID: f.element["灯笼"]!.id, completion: $0) }
        let _: WorkspaceCommentsReply = try elementResult { w.deleteComment(projectID: p, commentID: f.comment["时间线"]!.id, completion: $0) }
        let _: WorkspacePatchReply<WorkspacePatch> = try elementResult { w.deletePatch(projectID: p, patchID: f.patch["受伤"]!.id, completion: $0) }
        let _: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult { w.trashStoryline(projectID: p, storylineID: f.storyline["支线"]!.id, completion: $0) }
        let expected: [(String, String)] = [("r_update", "设定"), ("r_create", "已被设定"), ("r_relation", "已不可用"),
                                           ("r_comment", "批注或待办"), ("r_patch", "补丁"), ("r_storylines", "故事线已不可用")]
        for (id, reason) in expected {
            let mark = try journal.mark()
            try accept(harness, id)
            let proposal = harness.proposal(id)
            let message = proposal?.message ?? ""
            try require(proposal?.state == .failed && message.contains(reason) && message.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) }
                && harness.card(id)?.stateLabel.stringValue == "应用失败"
                && (harness.panel.element("agent-proposal-message-\(id)") as? NSTextField)?.stringValue == message,
                "\(id) was not refused by Rust: \(proposal?.state.rawValue ?? "") \(message)")
            try require((try journal.originals(since: mark)).isEmpty, "\(id) wrote although Rust refused it")
        }

        // Pending input keeps a chapter rename pending with the reason; it applies once the input settles.
        let view = try harness.open(toolChapters.firstIndex(of: "启程")!)
        view.textView.insertText("潮水", replacementRange: NSRange(location: 0, length: 0))
        try require(view.binding.hasPendingWork, "The typed text settled before the rename")
        harness.card("r_rename")?.acceptButton.performClick(nil)
        try wait { harness.proposal("r_rename")?.state == .pending && harness.proposal("r_rename")?.message != nil }
        try require(harness.proposal("r_rename")?.message?.contains("请先完成输入") == true && harness.card("r_rename")?.acceptButton.isEnabled == true,
            "Pending input did not keep the rename pending: \(harness.proposal("r_rename")?.message ?? "")")
        try elementSettled(harness.host, view)
        var mark = try journal.mark()
        try accept(harness, "r_rename")
        let renamed: [WorkspaceChapter] = try elementResult { w.chapters(projectID: p, completion: $0) }
        try require(harness.proposal("r_rename")?.state == .accepted && (try journal.originals(since: mark)).count == 1
            && renamed.contains { $0.title == "潮声" } && view.textView.string == "潮水", "The rename did not apply after the input settled")

        // After the project is deleted, every write tool's proposal fails without writing.
        let sweep = try AgentHarness(titles: toolChapters)
        defer { sweep.remove() }
        let g = try toolFixture(sweep, bodies: false)
        let cases = writeCases(g)
        try turn(sweep, cases.enumerated().map { ("s\($0.offset)", $0.element.tool, arguments($0.element.valid)) }, "全部改。")
        try require(sweep.conversation.proposals.count == cases.count, "The sweep did not propose every write tool")
        let deleted: WorkspaceProjectDeletionReply = try elementResult { sweep.workspace.deleteProject(projectID: sweep.project.id, completion: $0) }
        _ = deleted
        let sweepJournal = JournalProbe(directory: sweep.directory)
        mark = try sweepJournal.mark()
        for (index, item) in cases.enumerated() {
            try accept(sweep, "s\(index)")
            let proposal = sweep.proposal("s\(index)")
            try require(proposal?.state == .failed && (proposal?.message ?? "").unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) },
                "\(item.tool) did not fail after the project was deleted: \(proposal?.state.rawValue ?? "") \(proposal?.message ?? "")")
        }
        try require((try sweepJournal.originals(since: mark)).isEmpty, "A refused proposal wrote after the project was deleted")
        try harness.close()
        try sweep.close()
    }

    // MARK: (d) Act rail boundaries

    private static func agentActRailBoundaries() throws {
        let harness = try AgentHarness(titles: ["一", "二", "三", "四"])
        defer { harness.remove() }
        let p = harness.project.id, w = harness.workspace
        let listed: [WorkspaceChapter] = try elementResult { w.chapters(projectID: p, completion: $0) }
        let orders = listed.compactMap(\.bookOrder)
        try require(orders.count == 4, "Chapters lack book orders")
        let act: WorkspaceAct = try elementResult { w.createAct(projectID: p, chapterID: listed[1].id, completion: $0) }
        // A boundary between two chapters' coordinates starts at the later one.
        let _: WorkspaceAct = try elementResult { w.moveAct(projectID: p, actID: act.id, startOrder: (orders[2] + orders[3]) / 2, completion: $0) }
        let entries: [WorkspaceOutlineEntry] = try elementResult { w.outline(projectID: p, completion: $0) }
        try require(entries.first { $0.kind == "act" }?.startOrder == (orders[2] + orders[3]) / 2
            && entries.filter { $0.kind == "chapter" }.allSatisfy { $0.startOrder == nil }, "Outline rows lack the stored boundary")
        let model = BottomTimelineModel(workspace: w, projectID: p)
        model.load()
        try wait { model.loaded && !model.busy && model.acts.count == 1 }
        try require(model.acts.map(\.start) == [3] && model.acts.map(\.end) == [4], "The rail did not use the stored boundary: \(model.acts)")
        try harness.close()
    }
}

/// Linked element names in a view's projection, in text order.
enum EntityLinkAcceptanceProbe {
    static func linkedNames(_ view: NativeDocumentView) -> [String] {
        guard let projection = view.binding.store.projection else { return [] }
        return BindingAcceptance.linkedRuns(projection).map(\.0)
    }
}
