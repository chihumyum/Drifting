import Foundation

/// The resolved arguments a domain proposal stores and applies.
struct AgentDomainArguments {
    let values: [String: AgentJSON]

    func string(_ key: String) -> String? { values[key]?.stringValue }
    func has(_ key: String) -> Bool { values[key] != nil }
    /// Present and `null`: the field is cleared.
    func cleared(_ key: String) -> Bool { values[key] == .null }
    func strings(_ key: String) -> [String]? { values[key]?.arrayValue?.compactMap(\.stringValue) }
    func bool(_ key: String) -> Bool? { if case .bool(let value)? = values[key] { return value }; return nil }
    func facts(_ key: String) -> [WorkspaceFact]? {
        values[key]?.arrayValue?.compactMap { item in
            guard case .object(let row) = item, let key = row["key"]?.stringValue, let value = row["value"]?.stringValue else { return nil }
            return WorkspaceFact(key: key, value: value)
        }
    }
}

extension AgentWorkspaceTools {
    typealias Completion = (AgentToolOutcome) -> Void
    typealias ApplyCompletion = (Result<AgentApplyOutcome, AgentApplyRefusal>) -> Void

    // MARK: Helpers

    private static func trimmed(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private static func lines(_ facts: [WorkspaceFact]) -> String { facts.map { "\($0.key)：\($0.value)" }.joined(separator: "\n") }
    private static func folded(_ text: String) -> String { trimmed(text).lowercased() }

    /// Facts as Rust stores them: rows with a blank key and value dropped.
    private static func factList(_ value: Any?) -> [WorkspaceFact]? {
        guard let rows = value as? [[String: Any]] else { return nil }
        return ElementText.stored(facts: rows.compactMap { row in
            guard let key = row["key"] as? String, let value = row["value"] as? String else { return nil }
            return WorkspaceFact(key: key, value: value)
        })
    }

    /// Trimmed aliases without blanks or repeats, in the given order.
    private static func aliasList(_ value: Any?) -> [String]? {
        guard let items = value as? [String] else { return nil }
        var seen = Set<String>()
        return items.map(trimmed).filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    /// Names and aliases are unique across live elements.
    private static func nameConflict(_ names: [String], in library: WorkspaceElementLibrary, except id: String?) -> String? {
        for name in names {
            if let other = library.elements.first(where: { $0.id != id && ($0.name == name || $0.aliases.contains(name)) }) {
                return "“\(name)”已被设定「\(other.name)」使用，请换一个名称或别名。"
            }
        }
        return nil
    }

    private func domainProposal(_ call: AgentToolCall, turnID: String, label: String, targetKind: String, targetID: String?,
                                title: String, fields: [AgentFieldChange], note: String? = nil,
                                arguments: [String: Any]) -> AgentProposal {
        var proposal = AgentProposal(id: call.id, turnID: turnID, tool: call.name, kind: .domain, targetKind: targetKind,
                                     targetID: targetID, targetTitle: title, changes: [], summary: nil, previousSummary: nil,
                                     state: .pending, message: nil, reported: false, createdAt: Date(), decidedAt: nil)
        proposal.label = label; proposal.note = note; proposal.fields = fields
        proposal.arguments = arguments.mapValues { AgentJSON(any: $0) }
        return proposal
    }

    private func offer(_ proposal: AgentProposal, _ completion: Completion) {
        let detail = (proposal.fields ?? []).map(\.label).joined(separator: "、")
        completion(AgentToolOutcome(ok: true, content: Self.pending(proposal, detail: detail.isEmpty ? "见提案卡片" : "涉及\(detail)"),
                                    activity: "提议\(proposal.headline)", proposal: proposal))
    }

    /// What a domain write proposes, for the transcript's activity line.
    private static let actions: [String: String] = [
        "create_element": "新建设定", "update_element": "修改设定", "set_element_facts": "修改设定字段",
        "create_element_category": "新建分类", "update_element_category": "修改分类", "trash_element": "把设定移到回收站",
        "create_element_patch": "添加设定补丁", "update_element_patch": "修改设定补丁", "delete_element_patch": "删除设定补丁",
        "create_storyline": "新建故事线", "update_storyline": "修改故事线", "set_chapter_storylines": "设置章节的故事线",
        "create_relation": "新建关系", "update_relation": "修改关系", "delete_relation": "删除关系", "create_relation_type": "新建关系类型",
        "create_comment": "添加批注或待办", "update_comment": "修改批注或待办", "resolve_comment": "解决批注或待办",
        "rename_chapter": "修改章节标题", "trash_chapter": "把章节移到回收站", "create_drift": "新建漂流", "rename_drift": "修改漂流标题",
        "set_drift_summary": "修改漂流摘要", "update_project_facts": "修改本书字段", "update_project_summary": "修改本书简介",
    ]

    private static func refuse(_ message: String, _ tool: String, _ completion: Completion) {
        completion(.failure(message, activity: "提议\(actions[tool] ?? "修改")失败"))
    }

    /// Resolves the reference, or refuses with its reason.
    private static func unwrap<Value>(_ result: Result<Value, AgentApplyRefusalText>, _ tool: String, _ completion: Completion) -> Value? {
        switch result {
        case .success(let value): return value
        case .failure(let refusal): refuse(refusal.message, tool, completion); return nil
        }
    }

    private static func unwrap<Value>(_ result: Result<Value, Error>, _ tool: String, _ completion: Completion) -> Value? {
        switch result {
        case .success(let value): return value
        case .failure(let error): refuse(message(error), tool, completion); return nil
        }
    }

    /// A category by `categoryId` or exact name; 未分类 (or blank) is nil.
    private static func categoryChoice(id: String?, name: String?, in library: WorkspaceElementLibrary)
        -> Result<WorkspaceElementCategory?, AgentApplyRefusalText> {
        if let id {
            guard let category = library.categories.first(where: { $0.id == id }) else {
                return .failure(AgentApplyRefusalText("找不到编号为 \(id) 的分类（可能已移到回收站）。"))
            }
            return .success(category)
        }
        guard let name = name.map(clean), !name.isEmpty, name != "未分类" else { return .success(nil) }
        let matches = library.categories.filter { clean($0.name) == name }
        switch matches.count {
        case 1: return .success(matches[0])
        case 0: return .failure(AgentApplyRefusalText("找不到名为「\(name)」的分类。请先用 list_elements 查看。"))
        default: return .failure(AgentApplyRefusalText("有 \(matches.count) 个分类都叫「\(name)」：\(candidates(matches.map(\.id)))。请改用 categoryId 指定。"))
        }
    }

    /// Chapter and drift titles are unique (ignoring case) across both; Rust
    /// would add a number to a taken one.
    func titleTaken(_ title: String, except id: String?, _ done: @escaping (Result<Bool, Error>) -> Void) {
        workspace.chapters(projectID: projectID) { [self] chapters in
            workspace.driftLibrary(projectID: projectID) { drifts in
                do {
                    let titles = try chapters.get().filter { $0.id != id }.map(\.title) + (try drifts.get()).drifts.filter { $0.id != id }.map(\.title)
                    done(.success(titles.contains { Self.folded($0) == Self.folded(title) }))
                } catch { done(.failure(error)) }
            }
        }
    }

    /// The live relations touching an end, for trash cards.
    private func relationCount(_ endpoint: RelationEndpoint, _ done: @escaping (Int) -> Void) {
        workspace.relationLibrary(projectID: projectID) { result in
            done(((try? result.get())?.relations ?? []).filter { $0.from == endpoint || $0.to == endpoint }.count)
        }
    }

    // MARK: Proposals

    /// Checks a domain write and adds a pending proposal. False when `call`
    /// is not a domain write.
    func proposeDomain(_ call: AgentToolCall, turnID: String, _ a: [String: Any], _ completion: @escaping Completion) -> Bool {
        let tool = call.name
        let make = { (label: String, kind: String, id: String?, title: String, fields: [AgentFieldChange], note: String?, arguments: [String: Any]) in
            self.offer(self.domainProposal(call, turnID: turnID, label: label, targetKind: kind, targetID: id, title: title,
                                           fields: fields, note: note, arguments: arguments), completion)
        }
        switch tool {
        case "create_element":
            guard let name = Self.string(a["name"]) else { Self.refuse("新设定的名称不能为空。", tool, completion); return true }
            guard Self.string(a["categoryId"]) != nil || Self.string(a["category"]) != nil else {
                Self.refuse("请用 categoryId 或 category 指定新设定所在的分类；没有分类时先用 create_element_category 提议新建。", tool, completion); return true
            }
            workspace.elementLibrary(projectID: projectID) { result in
                guard let library = Self.unwrap(result, tool, completion) else { return }
                guard let chosen = Self.unwrap(Self.categoryChoice(id: Self.string(a["categoryId"]), name: Self.string(a["category"]), in: library), tool, completion) else { return }
                guard let category = chosen else { Self.refuse("新设定需要一个分类。", tool, completion); return }
                let aliases = Self.aliasList(a["aliases"]) ?? []
                if let conflict = Self.nameConflict([name] + aliases, in: library, except: nil) { Self.refuse(conflict, tool, completion); return }
                let group = Self.string(a["group"]), summary = Self.string(a["summary"]), facts = Self.factList(a["facts"])
                let text = Self.paragraphs(a["text"])
                var fields = [AgentFieldChange(label: "分类", before: nil, after: category.name), AgentFieldChange(label: "名称", before: nil, after: name)]
                var arguments: [String: Any] = ["categoryId": category.id, "name": name]
                if let group { fields.append(.init(label: "分组", before: nil, after: group)); arguments["groupName"] = group }
                if let summary { fields.append(.init(label: "简介", before: nil, after: summary)); arguments["summary"] = summary }
                if !aliases.isEmpty { fields.append(.init(label: "别名", before: nil, after: aliases.joined(separator: "，"))); arguments["aliases"] = aliases }
                if let facts, !facts.isEmpty {
                    fields.append(.init(label: "字段", before: nil, after: Self.lines(facts))); arguments["facts"] = facts.map(\.payload)
                } else if !category.templateFacts.isEmpty {
                    fields.append(.init(label: "字段（来自分类模板）", before: nil, after: Self.lines(category.templateFacts)))
                }
                if let text { fields.append(.init(label: "开头正文", before: nil, after: text)); arguments["text"] = text }
                let note = "在分类「\(category.name)」中新建设定。" + (text == nil ? "" : "开头正文追加在分类模版正文（如有）之后，每行成为一个段落。")
                make("新建设定「\(name)」", "element", nil, name, fields, note, arguments)
            }

        case "update_element":
            element(a) { resolved in
                guard let (element, library) = Self.unwrap(resolved, tool, completion) else { return }
                var fields: [AgentFieldChange] = [], arguments: [String: Any] = ["elementId": element.id]
                var names: [String] = []
                if let name = Self.string(a["newName"]).map(Self.clean), name != element.name {
                    fields.append(.init(label: "名称", before: element.name, after: name)); arguments["name"] = name; names.append(name)
                }
                if let summary = (a["summary"] as? String).map(Self.trimmed), summary != element.summary {
                    fields.append(.init(label: "简介", before: element.summary, after: summary)); arguments["summary"] = summary
                }
                if let aliases = Self.aliasList(a["aliases"]), aliases != element.aliases {
                    fields.append(.init(label: "别名", before: element.aliases.joined(separator: "，"), after: aliases.joined(separator: "，")))
                    arguments["aliases"] = aliases; names += aliases
                }
                if a["categoryId"] != nil || a["category"] != nil {
                    guard let chosen = Self.unwrap(Self.categoryChoice(id: Self.string(a["categoryId"]), name: a["category"] as? String, in: library), tool, completion) else { return }
                    if chosen?.id != element.categoryId {
                        let before = element.categoryId.flatMap { id in library.categories.first { $0.id == id }?.name } ?? "未分类"
                        fields.append(.init(label: "分类", before: before, after: chosen?.name ?? "未分类"))
                        arguments["categoryId"] = chosen?.id ?? NSNull()
                    }
                }
                if let group = (a["group"] as? String).map(Self.trimmed) {
                    let next: String? = group.isEmpty ? nil : group
                    if next != element.groupName {
                        fields.append(.init(label: "分组", before: element.groupName ?? "", after: next ?? "")); arguments["groupName"] = next ?? NSNull()
                    }
                }
                guard !fields.isEmpty else { Self.refuse("设定「\(element.name)」已经是这些内容，没有需要修改的地方。", tool, completion); return }
                if let conflict = Self.nameConflict(names, in: library, except: element.id) { Self.refuse(conflict, tool, completion); return }
                make("修改设定「\(element.name)」", "element", element.id, element.name, fields, nil, arguments)
            }

        case "set_element_facts":
            element(a) { resolved in
                guard let (element, _) = Self.unwrap(resolved, tool, completion) else { return }
                let facts = Self.factList(a["facts"]) ?? []
                guard facts != element.facts else { Self.refuse("设定「\(element.name)」的字段已经是这些内容。", tool, completion); return }
                make("修改设定「\(element.name)」的字段", "element", element.id, element.name,
                     [.init(label: "字段", before: Self.lines(element.facts), after: Self.lines(facts))], nil,
                     ["elementId": element.id, "facts": facts.map(\.payload)])
            }

        case "create_element_category":
            guard let name = Self.string(a["name"]).map(Self.clean), !name.isEmpty else { Self.refuse("分类名称不能为空。", tool, completion); return true }
            workspace.elementLibrary(projectID: projectID) { result in
                guard let library = Self.unwrap(result, tool, completion) else { return }
                if library.categories.contains(where: { Self.folded($0.name) == Self.folded(name) }) {
                    Self.refuse("已有名为「\(name)」的分类，请换一个名称。", tool, completion); return
                }
                make("新建分类「\(name)」", "category", nil, name, [.init(label: "名称", before: nil, after: name)], "颜色由应用选择。", ["name": name])
            }

        case "update_element_category":
            category(a) { resolved in
                guard let (category, library) = Self.unwrap(resolved, tool, completion) else { return }
                var fields: [AgentFieldChange] = [], arguments: [String: Any] = ["categoryId": category.id]
                if let name = Self.string(a["newName"]).map(Self.clean), name != category.name {
                    if library.categories.contains(where: { $0.id != category.id && Self.folded($0.name) == Self.folded(name) }) {
                        Self.refuse("已有名为「\(name)」的分类，请换一个名称。", tool, completion); return
                    }
                    fields.append(.init(label: "名称", before: category.name, after: name)); arguments["name"] = name
                }
                if let color = (a["color"] as? String)?.uppercased(), color != category.color.uppercased() {
                    fields.append(.init(label: "颜色", before: category.color, after: color)); arguments["color"] = color
                }
                guard !fields.isEmpty else { Self.refuse("分类「\(category.name)」已经是这些内容。", tool, completion); return }
                make("修改分类「\(category.name)」", "category", category.id, category.name, fields, nil, arguments)
            }

        case "trash_element":
            element(a) { resolved in
                guard let (element, _) = Self.unwrap(resolved, tool, completion) else { return }
                self.relationCount(RelationEndpoint(kind: "element", id: element.id)) { count in
                    let note = "设定会移到回收站，可以在设定库中恢复；打开的设定页面会关闭。"
                        + (count > 0 ? "它的 \(count) 条关系会被删除，恢复后不会回来。" : "")
                    make("把设定「\(element.name)」移到回收站", "element", element.id, element.name,
                         [.init(label: "设定", before: element.name, after: "（移到回收站）")], note, ["elementId": element.id])
                }
            }

        case "create_element_patch":
            element(a) { resolved in
                guard let (element, _) = Self.unwrap(resolved, tool, completion) else { return }
                let title = PatchText.title(a["title"] as? String ?? ""), body = PatchText.body(a["body"] as? String ?? "")
                guard title != nil || !body.isEmpty else { Self.refuse("补丁的标题和内容不能都为空。", tool, completion); return }
                var fields: [AgentFieldChange] = [], arguments: [String: Any] = ["elementId": element.id, "body": body]
                if let title { fields.append(.init(label: "标题", before: nil, after: title)); arguments["title"] = title }
                if !body.isEmpty { fields.append(.init(label: "内容", before: nil, after: body)) }
                let finish = { (source: WorkspaceChapter?) in
                    if let source { fields.append(.init(label: "来源章节", before: nil, after: "《\(source.title)》")); arguments["sourceNodeId"] = source.id }
                    make("为设定「\(element.name)」添加补丁", "patch", nil, element.name, fields, nil, arguments)
                }
                guard a["sourceChapterId"] != nil || a["sourceChapterTitle"] != nil else { finish(nil); return }
                self.chapter(["chapterId": a["sourceChapterId"], "title": a["sourceChapterTitle"]].compactMapValues { $0 }) { chapter in
                    guard let chapter = Self.unwrap(chapter, tool, completion) else { return }
                    finish(chapter)
                }
            }

        case "update_element_patch", "delete_element_patch":
            element(a) { resolved in
                guard let (element, _) = Self.unwrap(resolved, tool, completion) else { return }
                self.workspace.elementPatches(projectID: self.projectID, elementID: element.id) { result in
                    guard let patches = Self.unwrap(result, tool, completion) else { return }
                    guard let id = Self.string(a["patchId"]), let patch = patches.first(where: { $0.id == id }) else {
                        Self.refuse("设定「\(element.name)」没有编号为 \(Self.string(a["patchId"]) ?? "") 的补丁。请先用 get_element_patches 查看。", tool, completion); return
                    }
                    if tool == "delete_element_patch" {
                        let text = [patch.title, patch.body.isEmpty ? nil : patch.body].compactMap { $0 }.joined(separator: "\n")
                        make("删除设定「\(element.name)」的补丁", "patch", patch.id, element.name,
                             [.init(label: "补丁", before: text, after: "（删除）")], nil, ["elementId": element.id, "patchId": patch.id])
                        return
                    }
                    var fields: [AgentFieldChange] = [], arguments: [String: Any] = ["elementId": element.id, "patchId": patch.id]
                    var title = patch.title, body = patch.body
                    if let typed = a["title"] as? String, PatchText.title(typed) != patch.title {
                        title = PatchText.title(typed)
                        fields.append(.init(label: "标题", before: patch.title ?? "", after: title ?? "")); arguments["title"] = title ?? NSNull()
                    }
                    if let typed = a["body"] as? String, PatchText.body(typed) != patch.body {
                        body = PatchText.body(typed)
                        fields.append(.init(label: "内容", before: patch.body, after: body)); arguments["body"] = body
                    }
                    guard !fields.isEmpty else { Self.refuse("这条补丁已经是这些内容。", tool, completion); return }
                    guard title != nil || !body.isEmpty else { Self.refuse("补丁的标题和内容不能都为空。", tool, completion); return }
                    make("修改设定「\(element.name)」的补丁", "patch", patch.id, element.name, fields, nil, arguments)
                }
            }

        case "create_storyline":
            guard let name = Self.string(a["name"]).map(Self.clean), !name.isEmpty else { Self.refuse("故事线名称不能为空。", tool, completion); return true }
            workspace.storylineLibrary(projectID: projectID) { [self] result in
                guard let library = Self.unwrap(result, tool, completion) else { return }
                if library.storylines.contains(where: { Self.folded($0.name) == Self.folded(name) }) {
                    Self.refuse("已有名为「\(name)」的故事线，请换一个名称。", tool, completion); return
                }
                workspace.projectDetails(projectID: projectID) { [self] details in
                    workspace.chapters(projectID: projectID) { chapters in
                        guard let details = Self.unwrap(details, tool, completion), let chapters = Self.unwrap(chapters, tool, completion) else { return }
                        var fields = [AgentFieldChange(label: "名称", before: nil, after: name)], arguments: [String: Any] = ["name": name]
                        if let summary = Self.string(a["summary"]) { fields.append(.init(label: "简介", before: nil, after: summary)); arguments["summary"] = summary }
                        let template = ElementText.stored(facts: details.storylineTemplate)
                        if !template.isEmpty { fields.append(.init(label: "字段（来自故事线字段模版）", before: nil, after: Self.lines(template))) }
                        let note = library.storylines.isEmpty && !chapters.isEmpty
                            ? "这是第一条故事线：全书 \(chapters.count) 章都会归入它，并以它为主线。" : nil
                        make("新建故事线「\(name)」", "storyline", nil, name, fields, note, arguments)
                    }
                }
            }

        case "update_storyline":
            storyline(a) { resolved in
                guard let (storyline, library) = Self.unwrap(resolved, tool, completion) else { return }
                var fields: [AgentFieldChange] = [], arguments: [String: Any] = ["storylineId": storyline.id]
                if let name = Self.string(a["newName"]).map(Self.clean), name != storyline.name {
                    if library.storylines.contains(where: { $0.id != storyline.id && Self.folded($0.name) == Self.folded(name) }) {
                        Self.refuse("已有名为「\(name)」的故事线，请换一个名称。", tool, completion); return
                    }
                    fields.append(.init(label: "名称", before: storyline.name, after: name)); arguments["name"] = name
                }
                if let summary = (a["summary"] as? String).map(Self.trimmed), summary != storyline.summary {
                    fields.append(.init(label: "简介", before: storyline.summary, after: summary)); arguments["summary"] = summary
                }
                if let color = (a["color"] as? String)?.uppercased(), color != storyline.color.uppercased() {
                    fields.append(.init(label: "颜色", before: storyline.color, after: color)); arguments["color"] = color
                }
                guard !fields.isEmpty else { Self.refuse("故事线「\(storyline.name)」已经是这些内容。", tool, completion); return }
                make("修改故事线「\(storyline.name)」", "storyline", storyline.id, storyline.name, fields, nil, arguments)
            }

        case "set_chapter_storylines":
            chapter(a) { [self] resolved in
                guard let chapter = Self.unwrap(resolved, tool, completion) else { return }
                workspace.storylineLibrary(projectID: projectID) { result in
                    guard let library = Self.unwrap(result, tool, completion) else { return }
                    func pick(_ reference: String) -> Result<WorkspaceStoryline, AgentApplyRefusalText> {
                        if let found = library.storyline(id: reference) { return .success(found) }
                        let matches = library.storylines.filter { Self.clean($0.name) == Self.clean(reference) }
                        switch matches.count {
                        case 1: return .success(matches[0])
                        case 0: return .failure(AgentApplyRefusalText("找不到故事线「\(reference)」。请先用 list_storylines 查看。"))
                        default: return .failure(AgentApplyRefusalText("有 \(matches.count) 条故事线都叫「\(reference)」：\(Self.candidates(matches.map(\.id)))。请改用编号。"))
                        }
                    }
                    var chosen = Set<String>()
                    for reference in a["storylines"] as? [String] ?? [] {
                        guard let storyline = Self.unwrap(pick(reference), tool, completion) else { return }
                        chosen.insert(storyline.id)
                    }
                    let ordered = library.storylines.filter { chosen.contains($0.id) }
                    var primary = ordered.first
                    if let reference = Self.string(a["primary"]) {
                        guard let named = Self.unwrap(pick(reference), tool, completion) else { return }
                        guard chosen.contains(named.id) else { Self.refuse("主线「\(named.name)」必须在 storylines 之中。", tool, completion); return }
                        primary = named
                    }
                    let current = library.membership(chapterID: chapter.id)
                    let before = library.storylines.filter { current?.storylineIds.contains($0.id) == true }
                    guard Set(before.map(\.id)) != chosen || current?.primary != primary?.id else {
                        Self.refuse("《\(chapter.title)》已经是这样归属的。", tool, completion); return
                    }
                    let list = { (items: [WorkspaceStoryline]) in items.isEmpty ? "未归属" : items.map(\.name).joined(separator: "、") }
                    let beforePrimary = current?.primary.flatMap { library.storyline(id: $0)?.name } ?? "无"
                    make("设置《\(chapter.title)》的故事线", "chapter", chapter.id, chapter.title,
                         [.init(label: "故事线", before: list(before), after: list(ordered)),
                          .init(label: "主线", before: beforePrimary, after: primary?.name ?? "无")], nil,
                         ["chapterId": chapter.id, "storylineIds": ordered.map(\.id), "primary": primary?.id ?? NSNull()])
                }
            }

        case "create_relation":
            names { [self] named in
                guard let names = Self.unwrap(named, tool, completion) else { return }
                guard let fromReference = a["from"] as? [String: Any], let toReference = a["to"] as? [String: Any],
                      let from = Self.unwrap(names.resolve(fromReference), tool, completion),
                      let to = Self.unwrap(names.resolve(toReference), tool, completion) else { return }
                workspace.relationLibrary(projectID: projectID) { result in
                    guard let library = Self.unwrap(result, tool, completion) else { return }
                    guard let type = Self.unwrap(Self.relationType(Self.string(a["relationType"]) ?? "", in: library, current: nil), tool, completion) else { return }
                    if let problem = type.check(from: from.endpoint, to: to.endpoint).message { Self.refuse(problem, tool, completion); return }
                    if let existing = library.relations.first(where: { $0.relationTypeId == type.id
                        && (($0.from == from.endpoint && $0.to == to.endpoint) || (type.isSymmetric && $0.from == to.endpoint && $0.to == from.endpoint)) }) {
                        Self.refuse("这条关系已经存在（编号 \(existing.id)）。", tool, completion); return
                    }
                    let draft = WorkspaceRelation(id: "", projectId: "", fromKind: from.endpoint.kind, fromId: from.endpoint.id,
                                                  toKind: to.endpoint.kind, toId: to.endpoint.id, relationTypeId: type.id, createdAt: "", updatedAt: "")
                    make("新建关系「\(type.displayName)」", "relation", nil, type.displayName,
                         [.init(label: "类型", before: nil, after: "\(type.displayName)（\(type.summary)）"),
                          .init(label: "关系", before: nil, after: Self.relationText(draft, type: type, names: names))], nil,
                         ["fromKind": from.endpoint.kind, "fromId": from.endpoint.id, "toKind": to.endpoint.kind, "toId": to.endpoint.id,
                          "relationTypeId": type.id])
                }
            }

        case "update_relation", "delete_relation":
            names { [self] named in
                guard let names = Self.unwrap(named, tool, completion) else { return }
                workspace.relationLibrary(projectID: projectID) { result in
                    guard let library = Self.unwrap(result, tool, completion) else { return }
                    guard let id = Self.string(a["relationId"]), let relation = library.relation(id: id) else {
                        Self.refuse("找不到编号为 \(Self.string(a["relationId"]) ?? "") 的关系。请先用 list_relations 查看。", tool, completion); return
                    }
                    let current = library.type(id: relation.relationTypeId)
                    let text = Self.relationText(relation, type: current, names: names)
                    if tool == "delete_relation" {
                        make("删除关系「\(current?.displayName ?? "关系")」", "relation", relation.id, current?.displayName ?? "关系",
                             [.init(label: "关系", before: text, after: "（删除）")], nil, ["relationId": relation.id])
                        return
                    }
                    var type = current
                    if let reference = Self.string(a["relationType"]) {
                        guard let chosen = Self.unwrap(Self.relationType(reference, in: library, current: relation.relationTypeId), tool, completion) else { return }
                        type = chosen
                    }
                    guard let type else { Self.refuse("这条关系的类型已缺失，请用 relationType 指定新类型。", tool, completion); return }
                    let swap = a["swap"] as? Bool ?? false
                    if swap && type.isSymmetric { Self.refuse("对称关系没有方向，不需要交换两端。", tool, completion); return }
                    guard type.id != relation.relationTypeId || swap else { Self.refuse("这条关系已经是这个类型。", tool, completion); return }
                    let from = swap ? relation.to : relation.from, to = swap ? relation.from : relation.to
                    if let problem = type.check(from: from, to: to).message { Self.refuse(problem, tool, completion); return }
                    let next = WorkspaceRelation(id: relation.id, projectId: relation.projectId, fromKind: from.kind, fromId: from.id,
                                                 toKind: to.kind, toId: to.id, relationTypeId: type.id, createdAt: "", updatedAt: "")
                    var fields: [AgentFieldChange] = []
                    if type.id != relation.relationTypeId {
                        fields.append(.init(label: "类型", before: current?.displayName ?? "缺失的关系类型", after: type.displayName))
                    }
                    fields.append(.init(label: "关系", before: text, after: Self.relationText(next, type: type, names: names)))
                    make("修改关系「\(current?.displayName ?? "关系")」", "relation", relation.id, current?.displayName ?? "关系", fields, nil,
                         ["relationId": relation.id, "relationTypeId": type.id, "swap": swap])
                }
            }

        case "create_relation_type":
            guard let name = Self.string(a["name"]).map(Self.clean), !name.isEmpty else { Self.refuse("关系类型的名称不能为空。", tool, completion); return true }
            let symmetric = a["orientation"] as? String == "symmetric"
            let sourceRole = Self.trimmed(a["sourceRole"] as? String ?? "")
            let targetRole = symmetric ? sourceRole : Self.trimmed(a["targetRole"] as? String ?? "")
            guard !sourceRole.isEmpty, !targetRole.isEmpty else {
                Self.refuse(symmetric ? "请提供两端共用的角色（sourceRole）。" : "有向关系需要两端的角色（sourceRole 和 targetRole）。", tool, completion); return true
            }
            let sources = RelationKind.ordered(a["sourceKinds"] as? [String] ?? [])
            let targets = symmetric ? sources : RelationKind.ordered(a["targetKinds"] as? [String] ?? [])
            guard !sources.isEmpty, !targets.isEmpty else { Self.refuse("请给出两端可以连接的对象（sourceKinds 和 targetKinds）。", tool, completion); return true }
            let description = Self.string(a["description"]) ?? ""
            workspace.relationLibrary(projectID: projectID) { result in
                guard let library = Self.unwrap(result, tool, completion) else { return }
                if library.types.contains(where: { Self.folded($0.name) == Self.folded(name) || Self.folded($0.displayName) == Self.folded(name) }) {
                    Self.refuse("已有名为「\(name)」的关系类型。", tool, completion); return
                }
                var fields: [AgentFieldChange] = [
                    .init(label: "名称", before: nil, after: name),
                    .init(label: "方向", before: nil, after: symmetric ? "对称" : "有向"),
                    .init(label: "角色", before: nil, after: symmetric ? sourceRole : "\(sourceRole) → \(targetRole)"),
                    .init(label: symmetric ? "两端" : "源端", before: nil, after: Self.kindLabels(sources).joined(separator: "、")),
                ]
                if !symmetric { fields.append(.init(label: "目标端", before: nil, after: Self.kindLabels(targets).joined(separator: "、"))) }
                if !description.isEmpty { fields.append(.init(label: "说明", before: nil, after: description)) }
                make("新建关系类型「\(name)」", "relationType", nil, name, fields, nil,
                     ["name": name, "orientation": symmetric ? "symmetric" : "directed", "sourceRole": sourceRole, "targetRole": targetRole,
                      "sourceKinds": sources, "targetKinds": targets, "description": description])
            }

        case "create_comment":
            let kind = a["kind"] as? String ?? "todo"
            guard let body = Self.string(a["body"]) else { Self.refuse("内容不能为空。", tool, completion); return true }
            let priority = a["priority"] as? String
            let finish = { (target: (endpoint: RelationEndpoint, name: String)?, place: String) in
                var fields = [AgentFieldChange(label: "位置", before: nil, after: place),
                              AgentFieldChange(label: "类型", before: nil, after: kind == "todo" ? "待办" : "批注")]
                if let priority { fields.append(.init(label: "优先级", before: nil, after: CommentPriority(rawValue: priority)?.label ?? priority)) }
                fields.append(.init(label: "内容", before: nil, after: body))
                var arguments: [String: Any] = ["kind": kind, "body": body]
                if let target { arguments["targetKind"] = target.endpoint.kind; arguments["targetId"] = target.endpoint.id }
                if let priority { arguments["priority"] = priority }
                let what = kind == "todo" ? "待办" : "批注"
                make(target == nil ? "添加浮动待办" : "在\(place)上添加\(what)", "comment", nil, place, fields, nil, arguments)
            }
            guard let reference = a["target"] as? [String: Any] else {
                guard kind == "todo" else { Self.refuse("批注需要写在一个页面上（target）；浮动的只能是待办。", tool, completion); return true }
                finish(nil, "浮动待办"); return true
            }
            names { named in
                guard let names = Self.unwrap(named, tool, completion), let target = Self.unwrap(names.resolve(reference), tool, completion) else { return }
                finish(target, names.describe(target.endpoint))
            }

        case "update_comment", "resolve_comment":
            names { [self] named in
                guard let names = Self.unwrap(named, tool, completion) else { return }
                workspace.projectComments(projectID: projectID) { result in
                    guard let comments = Self.unwrap(result, tool, completion) else { return }
                    guard let id = Self.string(a["commentId"]), let comment = comments.first(where: { $0.id == id }) else {
                        Self.refuse("找不到编号为 \(Self.string(a["commentId"]) ?? "") 的批注或待办。请先用 list_comments 查看。", tool, completion); return
                    }
                    let what = comment.isTodo ? "待办" : "批注"
                    let place = comment.target.map { names.describe($0) } ?? "浮动待办"
                    if tool == "resolve_comment" {
                        let resolved = a["resolved"] as? Bool ?? true
                        guard comment.canChangeResolution else { Self.refuse("已转化的建议不能解决或重新打开。", tool, completion); return }
                        guard (comment.review == .resolved) != resolved else { Self.refuse("这条\(what)已经是\(comment.review.label)。", tool, completion); return }
                        let named = comment.isFloating ? "浮动待办" : "\(place)的\(what)"
                        make(resolved ? "把\(named)标为已解决" : "重新打开\(named)", "comment", comment.id, place,
                             [.init(label: "状态", before: comment.review.label, after: resolved ? "已解决" : "未解决"),
                              .init(label: "内容", before: nil, after: comment.bodyText)], nil,
                             ["commentId": comment.id, "resolved": resolved])
                        return
                    }
                    var fields: [AgentFieldChange] = [], arguments: [String: Any] = ["commentId": comment.id]
                    if let body = (a["body"] as? String).map(Self.trimmed), body != comment.bodyText {
                        guard !body.isEmpty else { Self.refuse("内容不能为空。", tool, completion); return }
                        guard comment.canEditBody else { Self.refuse("这条\(what)是自动生成的，内容不能修改。", tool, completion); return }
                        fields.append(.init(label: "内容", before: comment.bodyText, after: body)); arguments["body"] = body
                    }
                    if let kind = a["kind"] as? String, kind != comment.kind {
                        guard !(comment.isFloating && kind == "note") else { Self.refuse("浮动的待办不能转为批注。", tool, completion); return }
                        fields.append(.init(label: "类型", before: what, after: kind == "todo" ? "待办" : "批注")); arguments["kind"] = kind
                    }
                    if let raw = a["priority"] as? String {
                        let next: String? = raw == "none" ? nil : raw
                        if next != comment.priority {
                            let label = { (value: String?) in value.flatMap { CommentPriority(rawValue: $0)?.label } ?? "无" }
                            fields.append(.init(label: "优先级", before: label(comment.priority), after: label(next))); arguments["priority"] = next ?? NSNull()
                        }
                    }
                    guard !fields.isEmpty else { Self.refuse("这条\(what)已经是这些内容。", tool, completion); return }
                    make(comment.isFloating ? "修改浮动待办" : "修改\(place)的\(what)", "comment", comment.id, place, fields, nil, arguments)
                }
            }

        case "rename_chapter", "trash_chapter":
            chapter(a) { [self] resolved in
                guard let chapter = Self.unwrap(resolved, tool, completion) else { return }
                if tool == "trash_chapter" {
                    relationCount(RelationEndpoint(kind: "node", id: chapter.id)) { count in
                        let note = "章节会移到回收站，可以从章节回收站恢复；打开的标签会关闭。" + (count > 0 ? "它的 \(count) 条关系会被删除，恢复后不会回来。" : "")
                        make("把《\(chapter.title)》移到回收站", "chapter", chapter.id, chapter.title,
                             [.init(label: "章节", before: chapter.title, after: "（移到回收站）")], note, ["chapterId": chapter.id])
                    }
                    return
                }
                guard let title = Self.string(a["newTitle"]).map(Self.clean), !title.isEmpty else { Self.refuse("新标题不能为空。", tool, completion); return }
                guard title.count <= 100 else { Self.refuse("章节标题太长（最多 100 字）。", tool, completion); return }
                guard title != chapter.title else { Self.refuse("《\(chapter.title)》已经是这个标题。", tool, completion); return }
                titleTaken(title, except: chapter.id) { taken in
                    guard let taken = Self.unwrap(taken, tool, completion) else { return }
                    if taken { Self.refuse("已有章节或漂流叫《\(title)》，请换一个标题。", tool, completion); return }
                    make("把《\(chapter.title)》改名为《\(title)》", "chapter", chapter.id, chapter.title,
                         [.init(label: "标题", before: chapter.title, after: title)], nil, ["chapterId": chapter.id, "title": title])
                }
            }

        case "create_drift":
            guard let title = Self.string(a["title"]).map(Self.clean), !title.isEmpty else { Self.refuse("漂流标题不能为空。", tool, completion); return true }
            let text = Self.paragraphs(a["text"])
            titleTaken(title, except: nil) { taken in
                guard let taken = Self.unwrap(taken, tool, completion) else { return }
                if taken { Self.refuse("已有章节或漂流叫「\(title)」，请换一个标题。", tool, completion); return }
                var fields = [AgentFieldChange(label: "标题", before: nil, after: title)], arguments: [String: Any] = ["title": title]
                if let text { fields.append(.init(label: "正文", before: nil, after: text)); arguments["text"] = text }
                make("新建漂流「\(title)」", "drift", nil, title, fields, text == nil ? nil : "正文每行成为一个段落。", arguments)
            }

        case "rename_drift", "set_drift_summary":
            drift(a) { [self] resolved in
                guard let (drift, _) = Self.unwrap(resolved, tool, completion) else { return }
                if tool == "set_drift_summary" {
                    let summary = Self.trimmed(a["summary"] as? String ?? "")
                    guard summary != drift.summary else { Self.refuse("漂流「\(drift.title)」的摘要已经是这段内容。", tool, completion); return }
                    make("修改漂流「\(drift.title)」的摘要", "drift", drift.id, drift.title,
                         [.init(label: "摘要", before: drift.summary, after: summary)], nil, ["driftId": drift.id, "summary": summary])
                    return
                }
                guard let title = Self.string(a["newTitle"]).map(Self.clean), !title.isEmpty else { Self.refuse("新标题不能为空。", tool, completion); return }
                guard title != drift.title else { Self.refuse("漂流「\(drift.title)」已经是这个标题。", tool, completion); return }
                titleTaken(title, except: drift.id) { taken in
                    guard let taken = Self.unwrap(taken, tool, completion) else { return }
                    if taken { Self.refuse("已有章节或漂流叫「\(title)」，请换一个标题。", tool, completion); return }
                    make("把漂流「\(drift.title)」改名为「\(title)」", "drift", drift.id, drift.title,
                         [.init(label: "标题", before: drift.title, after: title)], nil, ["driftId": drift.id, "title": title])
                }
            }

        case "update_project_facts", "update_project_summary":
            workspace.projectDetails(projectID: projectID) { result in
                guard let details = Self.unwrap(result, tool, completion) else { return }
                if tool == "update_project_facts" {
                    let facts = Self.factList(a["facts"]) ?? []
                    guard facts != details.facts else { Self.refuse("本书字段已经是这些内容。", tool, completion); return }
                    make("修改本书字段", "project", details.id, details.name,
                         [.init(label: "本书字段", before: Self.lines(details.facts), after: Self.lines(facts))], nil, ["facts": facts.map(\.payload)])
                } else {
                    let summary = Self.trimmed(a["summary"] as? String ?? "")
                    guard summary != details.summary else { Self.refuse("本书简介已经是这段内容。", tool, completion); return }
                    make("修改本书简介", "project", details.id, details.name,
                         [.init(label: "本书简介", before: details.summary, after: summary)], nil, ["summary": summary])
                }
            }

        default:
            return false
        }
        return true
    }

    /// An author-defined relation type by identity or exact name. The
    /// built-in 关联 links TODOs and materials only; the current type of a
    /// relation being changed is also accepted.
    private static func relationType(_ reference: String, in library: WorkspaceRelationLibrary, current: String?)
        -> Result<WorkspaceRelationType, AgentApplyRefusalText> {
        let usable = library.types.filter { $0.isAuthored || $0.id == current }
        if let type = usable.first(where: { $0.id == reference }) { return .success(type) }
        let name = clean(reference)
        let matches = usable.filter { clean($0.name) == name || clean($0.displayName) == name }
        switch matches.count {
        case 1: return .success(matches[0])
        case 0:
            if library.types.contains(where: { $0.id == reference || $0.displayName == name }) {
                return .failure(AgentApplyRefusalText("内置的“关联”只用于待办和素材，不能用在这里。"))
            }
            return .failure(AgentApplyRefusalText("找不到关系类型「\(reference)」。请先用 list_relation_types 查看，或用 create_relation_type 提议新建。"))
        default:
            return .failure(AgentApplyRefusalText("有 \(matches.count) 种关系类型都叫「\(name)」：\(candidates(matches.map(\.id)))。请改用编号。"))
        }
    }

    // MARK: Applying

    /// Applies an accepted domain proposal through Rust. Creations with an
    /// opening body or a later summary report that step's failure as partial.
    func applyDomain(_ proposal: AgentProposal, agent: [String: String], completion: @escaping ApplyCompletion) {
        let a = AgentDomainArguments(values: proposal.arguments ?? [:])
        let projectID = self.projectID
        let fail: (Error) -> Void = { completion(.failure(AgentApplyRefusal($0))) }
        let done = { (message: String, created: String?, effects: [AgentWorkspaceEffect]) in
            completion(.success(.domain(message: message, created: created, partial: false, effects: effects)))
        }
        func required(_ key: String) -> String? {
            guard let value = a.string(key) else { fail(LabError.message("提案缺少 \(key)。")); return nil }
            return value
        }
        func reply<Value>(_ result: Result<Value, Error>, _ success: (Value) -> Void) {
            switch result {
            case .failure(let error): fail(error)
            case .success(let value): success(value)
            }
        }

        switch proposal.tool {
        case "create_element":
            // Name, group, summary, aliases and facts are one original, so a
            // refused alias or fact leaves nothing; only the opening body is a
            // second step.
            guard let categoryID = required("categoryId"), let name = required("name") else { return }
            workspace.createElement(projectID: projectID, categoryID: categoryID, name: name, groupName: a.string("groupName"),
                                    summary: a.string("summary"), aliases: a.strings("aliases"), facts: a.facts("facts")) { [self] result in
                reply(result) { created in
                    guard let element = created.result else { fail(LabError.message("设定库结果缺失。")); return }
                    let category = created.library.categories.first { $0.id == categoryID }?.name ?? "分类"
                    let made = "已在分类「\(category)」中创建设定「\(element.name)」（编号 \(element.id)）"
                    let library: AgentWorkspaceEffect = .elements(projectID: projectID, library: created.library)
                    guard let text = a.string("text") else { done(made + "。", element.id, [library]); return }
                    workspace.agentApplyChanges(projectID: projectID, kind: "element", id: element.id,
                                                changes: [AgentProseChange.appending(text).payload], agent: agent) { appended in
                        switch appended {
                        case .success(let applied):
                            done(made + "，并写入了开头正文。", element.id,
                                 [library, .prose(projectID: projectID, kind: "element", id: element.id, live: applied.handle != nil)])
                        case .failure(let error):
                            completion(.success(.domain(message: made + "，但开头正文没有写入：\(AgentApplyRefusal(error).message)。", created: element.id,
                                                        partial: true, effects: [library])))
                        }
                    }
                }
            }

        case "update_element":
            guard let id = required("elementId") else { return }
            var changes = WorkspaceElementChanges()
            changes.name = a.string("name"); changes.summary = a.string("summary"); changes.aliases = a.strings("aliases")
            if a.has("categoryId") { changes.categoryID = .some(a.string("categoryId")) }
            if a.has("groupName") { changes.groupName = .some(a.string("groupName")) }
            workspace.updateElement(projectID: projectID, elementID: id, changes: changes) { result in
                reply(result) { done("设定「\($0.result?.name ?? proposal.targetTitle)」已更新。", nil, [.elements(projectID: projectID, library: $0.library)]) }
            }

        case "set_element_facts":
            guard let id = required("elementId") else { return }
            workspace.setElementFacts(projectID: projectID, elementID: id, facts: a.facts("facts") ?? []) { result in
                reply(result) { done("设定「\(proposal.targetTitle)」的字段已更新。", nil, [.elements(projectID: projectID, library: $0.library)]) }
            }

        case "create_element_category":
            guard let name = required("name") else { return }
            workspace.createElementCategory(projectID: projectID, name: name) { result in
                reply(result) { reply in
                    let category = reply.result
                    done("已创建分类「\(category?.name ?? name)」（编号 \(category?.id ?? "")）。", category?.id,
                         [.elements(projectID: projectID, library: reply.library)])
                }
            }

        case "update_element_category":
            guard let id = required("categoryId") else { return }
            workspace.updateElementCategory(projectID: projectID, categoryID: id, name: a.string("name"), color: a.string("color")) { result in
                reply(result) { done("分类「\($0.result?.name ?? proposal.targetTitle)」已更新。", nil, [.elements(projectID: projectID, library: $0.library)]) }
            }

        case "trash_element":
            guard let id = required("elementId") else { return }
            let finish: (Result<WorkspaceElementReply<WorkspaceElement>, Error>) -> Void = { result in
                reply(result) {
                    done("设定「\(proposal.targetTitle)」已移到回收站，可以在设定库中恢复。", nil,
                         [.elements(projectID: projectID, library: $0.library), .relations(projectID: projectID)])
                }
            }
            if let lifecycle { lifecycle.trashElement(id, finish) } else { workspace.trashElement(projectID: projectID, elementID: id, completion: finish) }

        case "create_element_patch":
            guard let elementID = required("elementId") else { return }
            let source = a.string("sourceNodeId").map { WorkspacePatchSource(nodeID: $0, blockID: nil, blockText: nil, anchorText: nil) }
            workspace.createPatch(projectID: projectID, elementID: elementID, title: a.string("title"), body: a.string("body") ?? "", source: source) { result in
                reply(result) {
                    done("已为设定「\(proposal.targetTitle)」添加补丁（编号 \($0.result?.id ?? "")）。", $0.result?.id,
                         [.patches(projectID: projectID, elementID: elementID)])
                }
            }

        case "update_element_patch":
            guard let elementID = required("elementId"), let patchID = required("patchId") else { return }
            var changes = WorkspacePatchChanges()
            if a.has("title") { changes.title = .some(a.string("title")) }
            changes.body = a.string("body")
            workspace.updatePatch(projectID: projectID, patchID: patchID, changes: changes) { result in
                reply(result) { _ in done("补丁已更新。", nil, [.patches(projectID: projectID, elementID: elementID)]) }
            }

        case "delete_element_patch":
            guard let elementID = required("elementId"), let patchID = required("patchId") else { return }
            workspace.deletePatch(projectID: projectID, patchID: patchID) { result in
                reply(result) { _ in done("补丁已删除。", nil, [.patches(projectID: projectID, elementID: elementID)]) }
            }

        case "create_storyline":
            guard let name = required("name") else { return }
            workspace.createStoryline(projectID: projectID, name: name) { [self] result in
                reply(result) { created in
                    guard let storyline = created.result else { fail(LabError.message("故事线结果缺失。")); return }
                    let made = "已创建故事线「\(storyline.name)」（编号 \(storyline.id)）"
                    guard let summary = a.string("summary") else {
                        done(made + "。", storyline.id, [.storylines(projectID: projectID, library: created.library)]); return
                    }
                    var changes = WorkspaceStorylineChanges(); changes.summary = summary
                    workspace.updateStoryline(projectID: projectID, storylineID: storyline.id, changes: changes) { updated in
                        switch updated {
                        case .success(let reply): done(made + "。", storyline.id, [.storylines(projectID: projectID, library: reply.library)])
                        case .failure(let error):
                            completion(.success(.domain(message: made + "，但简介没有写入：\(AgentApplyRefusal(error).message)。", created: storyline.id,
                                                        partial: true, effects: [.storylines(projectID: projectID, library: created.library)])))
                        }
                    }
                }
            }

        case "update_storyline":
            guard let id = required("storylineId") else { return }
            var changes = WorkspaceStorylineChanges()
            changes.name = a.string("name"); changes.summary = a.string("summary"); changes.color = a.string("color")
            workspace.updateStoryline(projectID: projectID, storylineID: id, changes: changes) { result in
                reply(result) { done("故事线「\($0.result?.name ?? proposal.targetTitle)」已更新。", nil, [.storylines(projectID: projectID, library: $0.library)]) }
            }

        case "set_chapter_storylines":
            guard let id = required("chapterId") else { return }
            workspace.setChapterStorylines(projectID: projectID, chapterID: id, storylineIDs: a.strings("storylineIds") ?? [],
                                           primary: a.string("primary")) { result in
                reply(result) { done("《\(proposal.targetTitle)》的故事线已更新。", nil, [.storylines(projectID: projectID, library: $0.library)]) }
            }

        case "create_relation":
            guard let fromKind = required("fromKind"), let fromID = required("fromId"), let toKind = required("toKind"),
                  let toID = required("toId"), let typeID = required("relationTypeId") else { return }
            workspace.addRelation(projectID: projectID, from: RelationEndpoint(kind: fromKind, id: fromID), to: RelationEndpoint(kind: toKind, id: toID),
                                  relationTypeID: typeID) { result in
                reply(result) { done("关系已创建（编号 \($0.result?.id ?? "")）。", $0.result?.id, [.relations(projectID: projectID)]) }
            }

        case "update_relation":
            guard let id = required("relationId"), let typeID = required("relationTypeId") else { return }
            workspace.retypeRelation(projectID: projectID, relationID: id, relationTypeID: typeID, swap: a.bool("swap") ?? false) { result in
                reply(result) { _ in done("关系已更新。", nil, [.relations(projectID: projectID)]) }
            }

        case "delete_relation":
            guard let id = required("relationId") else { return }
            workspace.removeRelation(projectID: projectID, relationID: id) { result in
                reply(result) { _ in done("关系已删除。", nil, [.relations(projectID: projectID)]) }
            }

        case "create_relation_type":
            guard let name = required("name"), let orientation = required("orientation") else { return }
            let definition = RelationTypeDefinition(name: name, description: a.string("description") ?? "", orientation: orientation,
                                                    sourceRole: a.string("sourceRole") ?? "", targetRole: a.string("targetRole") ?? "",
                                                    sourceKinds: a.strings("sourceKinds") ?? [], targetKinds: a.strings("targetKinds") ?? [])
            workspace.createRelationType(projectID: projectID, definition: definition) { result in
                reply(result) { done("已创建关系类型「\($0.result?.name ?? name)」（编号 \($0.result?.id ?? "")）。", $0.result?.id, [.relations(projectID: projectID)]) }
            }

        case "create_comment":
            guard let kind = required("kind"), let body = required("body") else { return }
            let target = a.string("targetKind").flatMap { kind in a.string("targetId").map { RelationEndpoint(kind: kind, id: $0) } }
            workspace.createComment(projectID: projectID, kind: kind, target: target, body: body, priority: a.string("priority"),
                                    byAssistant: true) { result in
                reply(result) {
                    done("已添加\(kind == "todo" ? "待办" : "批注")（编号 \($0.result?.id ?? "")）。", $0.result?.id,
                         [.comments(projectID: projectID, comments: $0.comments)])
                }
            }

        case "update_comment":
            guard let id = required("commentId") else { return }
            var changes = WorkspaceCommentChanges()
            changes.body = a.string("body"); changes.kind = a.string("kind")
            if a.has("priority") { changes.priority = .some(a.string("priority").flatMap(CommentPriority.init(rawValue:))) }
            workspace.updateComment(projectID: projectID, commentID: id, changes: changes) { result in
                reply(result) { done("已更新。", nil, [.comments(projectID: projectID, comments: $0.comments)]) }
            }

        case "resolve_comment":
            guard let id = required("commentId") else { return }
            let resolved = a.bool("resolved") ?? true
            workspace.setCommentResolved(projectID: projectID, commentID: id, resolved: resolved) { result in
                reply(result) { done(resolved ? "已标为已解决。" : "已重新打开。", nil, [.comments(projectID: projectID, comments: $0.comments)]) }
            }

        case "rename_chapter":
            guard let id = required("chapterId"), let title = required("title") else { return }
            workspace.renameChapter(projectID: projectID, chapterID: id, title: title) { result in
                reply(result) { done("章节已改名为《\($0.title)》。", nil, [.chapterRenamed(projectID: projectID, chapter: $0)]) }
            }

        case "trash_chapter":
            guard let id = required("chapterId") else { return }
            let finish: (Result<WorkspaceChapterTrashReply, Error>) -> Void = { result in
                reply(result) {
                    done("《\(proposal.targetTitle)》已移到回收站，可以从章节回收站恢复。", nil,
                         [.chapterTrashed(projectID: projectID, reply: $0), .relations(projectID: projectID)])
                }
            }
            if let lifecycle { lifecycle.trashChapter(id, finish) } else { workspace.trashChapter(projectID: projectID, chapterID: id, completion: finish) }

        case "create_drift":
            guard let title = required("title") else { return }
            workspace.createDrift(projectID: projectID, title: title, groupID: nil) { [self] result in
                reply(result) { created in
                    guard let drift = created.result else { fail(LabError.message("漂流结果缺失。")); return }
                    let made = "已创建漂流「\(drift.title)」（编号 \(drift.id)）"
                    let library: AgentWorkspaceEffect = .drifts(projectID: projectID, library: created.library)
                    guard let text = a.string("text") else { done(made + "。", drift.id, [library]); return }
                    workspace.agentApplyChanges(projectID: projectID, kind: "drift", id: drift.id,
                                                changes: [AgentProseChange.appending(text).payload], agent: agent) { appended in
                        switch appended {
                        case .success(let applied):
                            done(made + "，并写入了正文。", drift.id,
                                 [library, .prose(projectID: projectID, kind: "drift", id: drift.id, live: applied.handle != nil)])
                        case .failure(let error):
                            completion(.success(.domain(message: made + "，但正文没有写入：\(AgentApplyRefusal(error).message)。", created: drift.id,
                                                        partial: true, effects: [library])))
                        }
                    }
                }
            }

        case "rename_drift":
            guard let id = required("driftId"), let title = required("title") else { return }
            var changes = WorkspaceDriftChanges(); changes.title = title
            workspace.updateDrift(projectID: projectID, driftID: id, changes: changes) { result in
                reply(result) { done("漂流已改名为「\($0.result?.title ?? title)」。", nil, [.drifts(projectID: projectID, library: $0.library)]) }
            }

        case "set_drift_summary":
            guard let id = required("driftId") else { return }
            workspace.setNodeSummary(projectID: projectID, nodeID: id, summary: a.string("summary") ?? "") { result in
                reply(result) { done("漂流「\(proposal.targetTitle)」的摘要已更新。", nil, [.nodeMetadata(projectID: projectID, metadata: $0)]) }
            }

        case "update_project_facts", "update_project_summary":
            var changes = WorkspaceProjectChanges()
            if proposal.tool == "update_project_facts" { changes.facts = a.facts("facts") ?? [] } else { changes.summary = a.string("summary") ?? "" }
            workspace.updateProject(projectID: projectID, changes: changes) { result in
                reply(result) {
                    done(proposal.tool == "update_project_facts" ? "本书字段已更新。" : "本书简介已更新。", nil, [.project(projectID: projectID, details: $0)])
                }
            }

        default:
            fail(LabError.message("没有名为 \(proposal.tool) 的修改。"))
        }
    }
}
