import Foundation

/// Every live chapter, drift, element, category and storyline of a project,
/// read together so references resolve by identity or exact name.
struct AgentProjectNames {
    let chapters: [WorkspaceChapter]
    let elements: WorkspaceElementLibrary
    let drifts: WorkspaceDriftLibrary
    let storylines: WorkspaceStorylineLibrary

    var directory: RelationNameDirectory {
        RelationNameDirectory(elements: elements, chapters: chapters, drifts: drifts, storylines: storylines)
    }

    /// 章节《启程》, 设定「林岚」, 漂流「灯塔」…; a missing end is named as such.
    func describe(_ endpoint: RelationEndpoint) -> String {
        let named = directory.name(of: endpoint)
        if endpoint.kind == "node", chapters.contains(where: { $0.id == endpoint.id }) { return "章节《\(named.name)》" }
        return "\(named.kindLabel)「\(named.name)」"
    }

    /// `chapter`, `drift`, `element`, `category` or `storyline` of a live end.
    func entityKind(_ endpoint: RelationEndpoint) -> String {
        guard endpoint.kind == "node" else { return endpoint.kind }
        return chapters.contains { $0.id == endpoint.id } ? "chapter" : "drift"
    }

    /// A reference `{kind, id?, name?}`: by identity, else by exact name
    /// (an element also by alias). Ambiguous names are refused with every
    /// candidate's identity.
    func resolve(_ reference: [String: Any]) -> Result<(endpoint: RelationEndpoint, name: String), AgentApplyRefusalText> {
        guard let kind = reference["kind"] as? String else { return .failure("对象缺少 kind。") }
        let id = AgentWorkspaceTools.string(reference["id"])
        let name = AgentWorkspaceTools.string(reference["name"]).map(AgentWorkspaceTools.clean)
        let label: String, measure: String, candidates: [(id: String, name: String, aliases: [String])], endpointKind: String
        switch kind {
        case "chapter": label = "章节"; measure = "个"; endpointKind = "node"; candidates = chapters.map { ($0.id, $0.title, []) }
        case "drift": label = "漂流"; measure = "条"; endpointKind = "node"; candidates = drifts.drifts.map { ($0.id, $0.title, []) }
        case "element": label = "设定"; measure = "个"; endpointKind = "element"; candidates = elements.elements.map { ($0.id, $0.name, $0.aliases) }
        case "category": label = "分类"; measure = "个"; endpointKind = "category"; candidates = elements.categories.map { ($0.id, $0.name, []) }
        case "storyline": label = "故事线"; measure = "条"; endpointKind = "storyline"; candidates = storylines.storylines.map { ($0.id, $0.name, []) }
        default: return .failure(AgentApplyRefusalText("kind 必须是 chapter、drift、element、category 或 storyline。"))
        }
        guard id != nil || name != nil else { return .failure(AgentApplyRefusalText("请提供\(label)的 id 或 name。")) }
        if let id, let found = candidates.first(where: { $0.id == id }) {
            return .success((RelationEndpoint(kind: endpointKind, id: found.id), found.name))
        }
        guard let name else { return .failure(AgentApplyRefusalText("找不到编号为 \(id ?? "") 的\(label)（可能已移到回收站）。")) }
        var matches = candidates.filter { AgentWorkspaceTools.clean($0.name) == name }
        if matches.isEmpty, kind == "element" { matches = candidates.filter { $0.aliases.contains(name) } }
        let quoted = kind == "chapter" ? "《\(name)》" : "「\(name)」"
        switch matches.count {
        case 1: return .success((RelationEndpoint(kind: endpointKind, id: matches[0].id), matches[0].name))
        case 0: return .failure(AgentApplyRefusalText("找不到名为\(quoted)的\(label)。请先用列表工具查看。"))
        default:
            return .failure(AgentApplyRefusalText("有 \(matches.count) \(measure)\(label)都叫\(quoted)：\(AgentWorkspaceTools.candidates(matches.map(\.id)))。请改用 id 指定。"))
        }
    }
}

extension AgentWorkspaceTools {
    static func domainProgress(_ name: String, title: String?) -> String? {
        switch name {
        case "list_relation_types": return "正在列出关系类型…"
        case "list_relations": return "正在列出关系…"
        case "list_comments": return "正在列出批注和待办…"
        case "list_materials": return "正在列出素材…"
        case "read_material": return title.map { "正在读取素材「\($0)」…" } ?? "正在读取素材…"
        case "get_element_patches": return title.map { "正在读取「\($0)」的设定补丁…" } ?? "正在读取设定补丁…"
        case "search_project": return "正在搜索全书…"
        case "find_element_appearances": return title.map { "正在查找「\($0)」出现的位置…" } ?? "正在查找设定出现的位置…"
        case "read_storyline": return title.map { "正在读取故事线「\($0)」…" } ?? "正在读取故事线…"
        default: return nil
        }
    }

    /// Runs a domain tool. False when `call` is not one.
    func runDomain(_ call: AgentToolCall, turnID: String, _ arguments: [String: Any],
                   _ completion: @escaping (AgentToolOutcome) -> Void) -> Bool {
        switch call.name {
        case "list_relation_types": listRelationTypes(completion)
        case "list_relations": listRelations(arguments, completion)
        case "list_comments": listComments(arguments, completion)
        case "list_materials": listMaterials(completion)
        case "read_material": readMaterial(arguments, completion)
        case "get_element_patches": elementPatches(arguments, completion)
        case "search_project": searchProject(arguments, completion)
        case "find_element_appearances": elementAppearances(arguments, completion)
        case "read_storyline": readStoryline(arguments, completion)
        default: return proposeDomain(call, turnID: turnID, arguments, completion)
        }
        return true
    }

    func names(_ done: @escaping (Result<AgentProjectNames, AgentApplyRefusalText>) -> Void) {
        workspace.chapters(projectID: projectID) { [self] chapters in
            workspace.elementLibrary(projectID: projectID) { [self] elements in
                workspace.driftLibrary(projectID: projectID) { [self] drifts in
                    workspace.storylineLibrary(projectID: projectID) { storylines in
                        do {
                            done(.success(AgentProjectNames(chapters: try chapters.get(), elements: try elements.get(),
                                                            drifts: try drifts.get(), storylines: try storylines.get())))
                        } catch {
                            done(.failure(AgentApplyRefusalText(Self.message(error))))
                        }
                    }
                }
            }
        }
    }

    static func kindLabels(_ kinds: [String]) -> [String] { kinds.map(RelationKind.label) }

    /// “《启程》（师父）→ 设定「林岚」（徒弟）”, or “A ↔ B（盟友）”.
    static func relationText(_ relation: WorkspaceRelation, type: WorkspaceRelationType?, names: AgentProjectNames) -> String {
        let from = names.describe(relation.from), to = names.describe(relation.to)
        guard let type else { return "\(from) → \(to)" }
        if type.isSymmetric { return "\(from) ↔ \(to)（\(type.displaySourceRole)）" }
        return "\(from)（\(type.displaySourceRole)）→ \(to)（\(type.displayTargetRole)）"
    }

    // MARK: Reads

    private func listRelationTypes(_ completion: @escaping (AgentToolOutcome) -> Void) {
        workspace.relationLibrary(projectID: projectID) { result in
            switch result {
            case .failure(let error): completion(.failure(Self.message(error), activity: "列出关系类型失败"))
            case .success(let library):
                let rows: [[String: Any]] = library.authoredTypes.map { type in
                    ["id": type.id, "name": type.name, "orientation": type.isSymmetric ? "对称" : "有向",
                     "sourceRole": type.sourceRole, "targetRole": type.targetRole,
                     "sourceKinds": Self.kindLabels(type.sourceKinds), "targetKinds": Self.kindLabels(type.targetKinds),
                     "description": type.description, "relationCount": library.usage(typeID: type.id)]
                }
                var value: [String: Any] = ["count": rows.count, "types": rows]
                if rows.isEmpty { value["note"] = "还没有作者定义的关系类型。可以用 create_relation_type 提议新建。" }
                completion(AgentToolOutcome(ok: true, content: Self.json(value), activity: "列出关系类型（\(rows.count) 种）", proposal: nil))
            }
        }
    }

    private func listRelations(_ arguments: [String: Any], _ completion: @escaping (AgentToolOutcome) -> Void) {
        names { [self] named in
            guard case .success(let names) = named else {
                if case .failure(let refusal) = named { completion(.failure(refusal.message, activity: "列出关系失败")) }
                return
            }
            var filter: (endpoint: RelationEndpoint, name: String)?
            if let reference = arguments["entity"] as? [String: Any] {
                switch names.resolve(reference) {
                case .failure(let refusal): completion(.failure(refusal.message, activity: "列出关系失败")); return
                case .success(let found): filter = found
                }
            }
            workspace.relationLibrary(projectID: projectID) { result in
                switch result {
                case .failure(let error): completion(.failure(Self.message(error), activity: "列出关系失败"))
                case .success(let library):
                    let native = Set(RelationKind.native)
                    let listed = library.relations.filter { native.contains($0.fromKind) && native.contains($0.toKind) }
                    let shown = listed.filter { relation in filter.map { relation.from == $0.endpoint || relation.to == $0.endpoint } ?? true }
                    let rows: [[String: Any]] = shown.prefix(Self.listLimit).map { relation in
                        let type = library.type(id: relation.relationTypeId)
                        func end(_ endpoint: RelationEndpoint, role: String) -> [String: Any] {
                            ["kind": names.entityKind(endpoint), "id": endpoint.id, "name": names.directory.name(of: endpoint).name, "role": role]
                        }
                        return ["id": relation.id, "type": type?.displayName ?? "缺失的关系类型", "typeId": relation.relationTypeId,
                                "symmetric": type?.isSymmetric ?? false,
                                "from": end(relation.from, role: type?.displaySourceRole ?? ""),
                                "to": end(relation.to, role: type?.displayTargetRole ?? ""),
                                "text": Self.relationText(relation, type: type, names: names)]
                    }
                    var value: [String: Any] = ["count": shown.count, "relations": rows]
                    if let filter { value["entity"] = names.describe(filter.endpoint) }
                    let associations = library.relations.count - listed.count
                    if associations > 0, filter == nil { value["note"] = "另有 \(associations) 条待办或素材的关联未列出。" }
                    let scope = filter.map { "「\($0.name)」的" } ?? ""
                    completion(AgentToolOutcome(ok: true, content: Self.json(value), activity: "列出\(scope)关系（\(shown.count) 条）", proposal: nil))
                }
            }
        }
    }

    private func listComments(_ arguments: [String: Any], _ completion: @escaping (AgentToolOutcome) -> Void) {
        let kind = arguments["kind"] as? String, status = arguments["status"] as? String ?? "open"
        names { [self] named in
            guard case .success(let names) = named else {
                if case .failure(let refusal) = named { completion(.failure(refusal.message, activity: "列出批注和待办失败")) }
                return
            }
            workspace.projectComments(projectID: projectID) { result in
                switch result {
                case .failure(let error): completion(.failure(Self.message(error), activity: "列出批注和待办失败"))
                case .success(let comments):
                    let chosen = comments.filter { comment in
                        (kind.map { comment.kind == $0 } ?? true)
                            && (status == "all" || (status == "open" ? comment.review == .open : comment.review == .resolved))
                    }
                    let rows: [[String: Any]] = chosen.prefix(Self.listLimit).map { comment in
                        var row: [String: Any] = ["id": comment.id, "kind": comment.isTodo ? "待办" : "批注",
                                                  "status": comment.review.label, "body": comment.bodyText,
                                                  "priority": comment.priority.flatMap { CommentPriority(rawValue: $0)?.label } ?? "",
                                                  "on": comment.target.map { names.describe($0) } ?? "浮动待办"]
                        let quote = comment.selectedText
                        if comment.isBlock, !quote.isEmpty { row["quote"] = quote }
                        return row
                    }
                    var value: [String: Any] = ["count": chosen.count, "comments": rows]
                    if chosen.count > rows.count { value["note"] = "结果较多，只返回了前 \(rows.count) 条。" }
                    completion(AgentToolOutcome(ok: true, content: Self.json(value), activity: "列出批注和待办（\(chosen.count) 条）", proposal: nil))
                }
            }
        }
    }

    private static func materialKind(_ kind: String) -> String {
        switch kind {
        case "image": return "图片"
        case "pdf": return "PDF"
        case "url": return "链接"
        case "text": return "文字"
        default: return kind
        }
    }

    private static func excerpt(_ text: String, _ limit: Int) -> String { text.count > limit ? String(text.prefix(limit)) + "…" : text }

    private func listMaterials(_ completion: @escaping (AgentToolOutcome) -> Void) {
        workspace.materialLibrary(projectID: projectID) { result in
            switch result {
            case .failure(let error): completion(.failure(Self.message(error), activity: "列出素材失败"))
            case .success(let library):
                // Titles, notes and text only: never file bytes or stored paths.
                let rows: [[String: Any]] = library.items.prefix(Self.listLimit).map { item in
                    var row: [String: Any] = ["id": item.id, "title": item.title, "kind": Self.materialKind(item.kind),
                                              "notes": Self.excerpt(item.notes, 200)]
                    if let url = item.externalUrl { row["url"] = url }
                    if item.kind == "text" { row["preview"] = Self.excerpt(item.text, 120); row["characters"] = item.text.count }
                    return row
                }
                completion(AgentToolOutcome(ok: true, content: Self.json(["count": library.items.count, "materials": rows]),
                                            activity: "列出素材（\(library.items.count) 条）", proposal: nil))
            }
        }
    }

    private func readMaterial(_ arguments: [String: Any], _ completion: @escaping (AgentToolOutcome) -> Void) {
        let id = Self.string(arguments["materialId"]), title = Self.string(arguments["title"]).map(Self.clean)
        guard id != nil || title != nil else { completion(.failure("请提供 materialId 或素材标题。", activity: "读取素材失败")); return }
        workspace.materialLibrary(projectID: projectID) { result in
            switch result {
            case .failure(let error): completion(.failure(Self.message(error), activity: "读取素材失败"))
            case .success(let library):
                let item: WorkspaceMaterialItem
                if let id, let found = library.item(id: id) { item = found } else {
                    guard let title else {
                        completion(.failure("找不到编号为 \(id ?? "") 的素材。请先用 list_materials 查看。", activity: "读取素材失败")); return
                    }
                    let matches = library.items.filter { Self.clean($0.title) == title }
                    guard matches.count == 1 else {
                        completion(.failure(matches.isEmpty ? "找不到标题为「\(title)」的素材。请先用 list_materials 查看。"
                            : "有 \(matches.count) 条素材都叫「\(title)」：\(Self.candidates(matches.map(\.id)))。请改用 materialId 指定。",
                            activity: "读取素材失败")); return
                    }
                    item = matches[0]
                }
                var value: [String: Any] = item.kind == "text" ? Self.bounded(item.text) : [:]
                value["id"] = item.id; value["title"] = item.title; value["kind"] = Self.materialKind(item.kind); value["notes"] = item.notes
                if let url = item.externalUrl { value["url"] = url }
                if item.hasFile { value["note"] = "这是\(Self.materialKind(item.kind))文件，只能读取标题和备注。" }
                completion(AgentToolOutcome(ok: true, content: Self.json(value), activity: "读取素材「\(item.title)」", proposal: nil))
            }
        }
    }

    private func elementPatches(_ arguments: [String: Any], _ completion: @escaping (AgentToolOutcome) -> Void) {
        element(arguments) { [self] resolved in
            guard case .success(let (element, _)) = resolved else {
                if case .failure(let refusal) = resolved { completion(.failure(refusal.message, activity: "读取设定补丁失败")) }
                return
            }
            workspace.elementPatches(projectID: projectID, elementID: element.id) { result in
                switch result {
                case .failure(let error): completion(.failure(Self.message(error), activity: "读取「\(element.name)」的设定补丁失败"))
                case .success(let patches):
                    let valid = patches.filter { !$0.isInvalid }
                    let rows: [[String: Any]] = valid.map { patch in
                        var row: [String: Any] = ["id": patch.id, "title": patch.title ?? "", "body": patch.body]
                        if patch.sourceNodeId != nil { row["sourceChapter"] = patch.sourceNodeTitle ?? "（来源章节已移到回收站）" }
                        if let anchor = patch.anchorText, !anchor.isEmpty { row["quote"] = anchor }
                        return row
                    }
                    var value: [String: Any] = ["element": element.name, "elementId": element.id, "count": valid.count, "patches": rows]
                    let hidden = patches.count - valid.count
                    if hidden > 0 { value["note"] = "另有 \(hidden) 条补丁已失效（所引原文已不在来源章节中），未列出。" }
                    completion(AgentToolOutcome(ok: true, content: Self.json(value),
                                                activity: "读取「\(element.name)」的设定补丁（\(valid.count) 条）", proposal: nil))
                }
            }
        }
    }

    private static func entityKindLabel(_ kind: String) -> String {
        switch kind {
        case "chapter": return "章节摘要"
        case "drift": return "漂流"
        case "element": return "设定"
        case "category": return "分类"
        case "storyline": return "故事线"
        case "library": return "素材"
        default: return kind
        }
    }

    private func searchProject(_ arguments: [String: Any], _ completion: @escaping (AgentToolOutcome) -> Void) {
        guard let query = Self.string(arguments["query"]) else { completion(.failure("请提供要搜索的文字。", activity: "搜索失败")); return }
        workspace.search(projectID: projectID, query: query) { [self] chapters in
            workspace.searchEntities(projectID: projectID, query: query) { entities in
                guard case .success(let prose) = chapters, case .success(let found) = entities else {
                    let error = chapters.error ?? entities.error
                    completion(.failure(error.map(Self.message) ?? "搜索失败。", activity: "搜索“\(query)”失败")); return
                }
                let chapterHits: [[String: Any]] = prose.hits.prefix(30).map {
                    ["chapterId": $0.chapterId, "chapterTitle": $0.chapterTitle, "in": $0.kind == "title" ? "标题" : "正文", "excerpt": $0.preview]
                }
                let entityHits: [[String: Any]] = found.hits.prefix(40).map {
                    ["kind": Self.entityKindLabel($0.kind), "id": $0.id, "title": $0.title,
                     "field": WorkspaceSearchText.field($0.field), "excerpt": $0.preview]
                }
                var value: [String: Any] = ["query": query, "chapters": chapterHits, "entities": entityHits]
                if prose.truncated || found.truncated || prose.hits.count > chapterHits.count || found.hits.count > entityHits.count {
                    value["note"] = "结果较多，只返回了一部分。可以换用更具体的文字。"
                }
                let unavailable = prose.unavailable.map { "章节《\($0.chapterTitle)》" }
                    + found.unavailable.map { "\(Self.entityKindLabel($0.kind))「\($0.title)」" }
                if !unavailable.isEmpty { value["unavailable"] = unavailable }
                let total = prose.hits.count + found.hits.count
                completion(AgentToolOutcome(ok: true, content: Self.json(value), activity: "搜索全书“\(query)”（\(total) 处）", proposal: nil))
            }
        }
    }

    private func elementAppearances(_ arguments: [String: Any], _ completion: @escaping (AgentToolOutcome) -> Void) {
        element(arguments) { [self] resolved in
            guard case .success(let (element, _)) = resolved else {
                if case .failure(let refusal) = resolved { completion(.failure(refusal.message, activity: "查找设定出现的位置失败")) }
                return
            }
            workspace.elementBacklinks(projectID: projectID, elementID: element.id) { result in
                switch result {
                case .failure(let error): completion(.failure(Self.message(error), activity: "查找「\(element.name)」出现的位置失败"))
                case .success(let links):
                    var value: [String: Any] = [
                        "element": element.name, "elementId": element.id,
                        "chapters": links.chapters.map { ["chapterId": $0.chapterId, "title": $0.chapterTitle, "paragraphs": $0.blocks, "links": $0.spans] },
                        "pages": links.sources.map { ["kind": $0.kindLabel, "id": $0.id, "title": $0.title, "paragraphs": $0.blocks, "links": $0.spans] },
                        "note": "只统计链接到这个设定的名称和别名；没有链接的提及请用 search_project 查找。",
                    ]
                    let unavailable = links.unavailable.map { "章节《\($0.chapterTitle)》" } + links.unavailableSources.map { "\($0.kindLabel)「\($0.title)」" }
                    if !unavailable.isEmpty { value["unavailable"] = unavailable }
                    completion(AgentToolOutcome(ok: true, content: Self.json(value),
                        activity: "查找「\(element.name)」出现的位置（\(links.chapters.count) 章，\(links.sources.count) 个页面）", proposal: nil))
                }
            }
        }
    }

    private func readStoryline(_ arguments: [String: Any], _ completion: @escaping (AgentToolOutcome) -> Void) {
        storyline(arguments) { [self] resolved in
            guard case .success(let (storyline, library)) = resolved else {
                if case .failure(let refusal) = resolved { completion(.failure(refusal.message, activity: "读取故事线失败")) }
                return
            }
            workspace.agentReadProse(projectID: projectID, kind: "storyline", id: storyline.id) { [self] prose in
                guard case .success(let body) = prose else {
                    completion(.failure(Self.message(prose.error!), activity: "读取故事线「\(storyline.name)」失败")); return
                }
                workspace.chapters(projectID: projectID) { chapters in
                    let titles = Dictionary(((try? chapters.get()) ?? []).map { ($0.id, $0.title) }, uniquingKeysWith: { first, _ in first })
                    var value = Self.bounded(body.text)
                    value["id"] = storyline.id; value["name"] = storyline.name; value["summary"] = storyline.summary
                    value["color"] = storyline.color
                    value["facts"] = storyline.facts.map { ["key": $0.key, "value": $0.value] }
                    value["chapters"] = library.chapters(storylineID: storyline.id).compactMap { membership -> [String: Any]? in
                        titles[membership.chapterId].map { ["id": membership.chapterId, "title": $0, "primary": membership.primary == storyline.id] }
                    }
                    if body.text.isEmpty { value["note"] = "故事线正文是空白的。" }
                    completion(AgentToolOutcome(ok: true, content: Self.json(value), activity: "读取故事线「\(storyline.name)」", proposal: nil))
                }
            }
        }
    }

    /// `project_overview`'s counts beyond chapters and words.
    func overviewCounts(_ done: @escaping ([String: Any]) -> Void) {
        workspace.elementLibrary(projectID: projectID) { [self] elements in
            workspace.storylineLibrary(projectID: projectID) { [self] storylines in
                workspace.driftLibrary(projectID: projectID) { [self] drifts in
                    workspace.relationLibrary(projectID: projectID) { [self] relations in
                        workspace.projectComments(projectID: projectID) { [self] comments in
                            workspace.materialLibrary(projectID: projectID) { materials in
                                var value: [String: Any] = [:]
                                if let library = try? elements.get() {
                                    value["elementCount"] = library.elements.count; value["categoryCount"] = library.categories.count
                                }
                                if let library = try? storylines.get() { value["storylineCount"] = library.storylines.count }
                                if let library = try? drifts.get() { value["driftCount"] = library.drifts.count }
                                if let library = try? relations.get() {
                                    let native = Set(RelationKind.native)
                                    value["relationCount"] = library.relations.filter { native.contains($0.fromKind) && native.contains($0.toKind) }.count
                                }
                                if let list = try? comments.get() {
                                    value["openTodoCount"] = list.filter { $0.isTodo && $0.review == .open }.count
                                    value["openNoteCount"] = list.filter { !$0.isTodo && $0.review == .open }.count
                                }
                                if let library = try? materials.get() { value["materialCount"] = library.items.count }
                                done(value)
                            }
                        }
                    }
                }
            }
        }
    }
}
