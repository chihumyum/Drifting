import Foundation

// MARK: - Argument schema

/// Strict argument checks against a tool's JSON schema: required and
/// unknown properties, value types, enums, patterns and array sizes. A
/// `null` for an optional property counts as absent.
enum AgentSchema {
    static func withoutNulls(_ arguments: [String: Any], schema: [String: Any]) -> [String: Any] {
        (strip(arguments, schema) as? [String: Any]) ?? arguments
    }

    private static func strip(_ value: Any, _ schema: [String: Any]) -> Any {
        if let object = value as? [String: Any], let properties = schema["properties"] as? [String: Any] {
            let required = Set(schema["required"] as? [String] ?? [])
            var result: [String: Any] = [:]
            for (key, item) in object where !(item is NSNull && !required.contains(key)) {
                result[key] = (properties[key] as? [String: Any]).map { strip(item, $0) } ?? item
            }
            return result
        }
        if let array = value as? [Any], let items = schema["items"] as? [String: Any] { return array.map { strip($0, items) } }
        return value
    }

    /// The first violation, in Chinese, or nil.
    static func violation(_ value: Any, schema: [String: Any], path: String = "") -> String? {
        let name = path.isEmpty ? "参数" : "参数 \(path) "
        switch schema["type"] as? String {
        case "object":
            guard let object = value as? [String: Any] else { return "\(name)必须是对象。" }
            let properties = schema["properties"] as? [String: Any] ?? [:]
            if schema["additionalProperties"] as? Bool == false,
               let unknown = object.keys.sorted().first(where: { properties[$0] == nil }) {
                return "不支持参数 \(join(path, unknown))。"
            }
            for key in schema["required"] as? [String] ?? [] where object[key] == nil {
                return "缺少必填参数 \(join(path, key))。"
            }
            for key in object.keys.sorted() {
                guard let child = properties[key] as? [String: Any], let item = object[key] else { continue }
                if let problem = violation(item, schema: child, path: join(path, key)) { return problem }
            }
            return nil
        case "string":
            guard let text = value as? String else { return "\(name)必须是文字。" }
            if let options = schema["enum"] as? [String], !options.contains(text) {
                return "\(name)必须是以下之一：\(options.joined(separator: "、"))。"
            }
            if let pattern = schema["pattern"] as? String, text.range(of: pattern, options: .regularExpression) == nil {
                return "\(name)的格式不正确。"
            }
            if let limit = schema["maxLength"] as? Int, text.count > limit { return "\(name)最多 \(limit) 字。" }
            return nil
        case "boolean":
            guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
                return "\(name)必须是 true 或 false。"
            }
            return nil
        case "integer":
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.rounded() == number.doubleValue, abs(number.doubleValue) < 1e15 else {
                return "\(name)必须是整数。"
            }
            if let minimum = schema["minimum"] as? Int, number.intValue < minimum { return "\(name)不能小于 \(minimum)。" }
            if let maximum = schema["maximum"] as? Int, number.intValue > maximum { return "\(name)不能大于 \(maximum)。" }
            return nil
        case "array":
            guard let array = value as? [Any] else { return "\(name)必须是数组。" }
            if let minimum = schema["minItems"] as? Int, array.count < minimum { return "\(name)至少需要 \(minimum) 项。" }
            if let maximum = schema["maxItems"] as? Int, array.count > maximum { return "\(name)最多 \(maximum) 项。" }
            if let items = schema["items"] as? [String: Any] {
                for (index, item) in array.enumerated() {
                    if let problem = violation(item, schema: items, path: "\(path)[\(index)]") { return problem }
                }
            }
            return nil
        default:
            return nil
        }
    }

    private static func join(_ path: String, _ key: String) -> String { path.isEmpty ? key : "\(path).\(key)" }
}

// MARK: - Domain tool definitions

extension AgentToolRegistry {
    static let entityKinds = ["chapter", "drift", "element", "category", "storyline"]
    /// Relation type ends: `node` is a chapter or a drift.
    static let relationKinds = ["node", "element", "category", "storyline"]

    private static let entity: [String: Any] = object([
        "kind": ["type": "string", "enum": entityKinds, "description": "章节、漂流、设定、分类还是故事线。"],
        "id": text("编号（来自列表工具）。"),
        "name": text("完全一致的章节或漂流标题、分类或故事线名称，或设定的名称、别名；没有 id 时使用。"),
    ], required: ["kind"])
    private static let facts: [String: Any] = [
        "type": "array", "maxItems": 64, "description": "按顺序排列的全部字段；会整体替换原有字段。",
        "items": object(["key": text("字段名，例如“年龄”。"), "value": text("字段值。")], required: ["key", "value"]),
    ]
    private static let names: [String: Any] = ["type": "array", "maxItems": 32, "items": text("一个别名。"),
                                               "description": "全部别名；会整体替换原有别名，空数组表示清空。"]
    private static let color: [String: Any] = ["type": "string", "pattern": "^#[0-9A-Fa-f]{6}$", "description": "颜色，格式为 #RRGGBB。"]
    private static let elementTarget: [String: Any] = [
        "elementId": text("设定编号（来自 list_elements）。"), "name": text("设定的名称或别名；没有 elementId 时使用。"),
    ]
    private static let categoryTarget: [String: Any] = [
        "categoryId": text("分类编号（来自 list_elements）。"), "name": text("完全一致的分类名称；没有 categoryId 时使用。"),
    ]
    private static let storylineTarget: [String: Any] = [
        "storylineId": text("故事线编号（来自 list_storylines）。"), "name": text("完全一致的故事线名称；没有 storylineId 时使用。"),
    ]
    private static let driftTarget: [String: Any] = [
        "driftId": text("漂流编号（来自 list_drifts）。"), "title": text("完全一致的漂流标题；没有 driftId 时使用。"),
    ]
    private static let proposalNote = "只生成修改提案，作者接受后才会写入。"

    private static func merged(_ parts: [String: Any]...) -> [String: Any] {
        parts.reduce(into: [:]) { result, part in result.merge(part) { $1 } }
    }

    static let domainReads: [AgentToolDefinition] = [
        AgentToolDefinition(name: "list_relation_types",
                            description: "列出作者定义的全部关系类型：编号、名称、有向或对称、两端角色、两端可以连接的对象和已有关系数。",
                            schema: object([:]), access: .read),
        AgentToolDefinition(name: "list_relations",
                            description: "列出章节、漂流、设定、分类和故事线之间的关系：编号、类型、两端和各自的角色。提供 entity 时只列出与它相关的关系。",
                            schema: object(["entity": entity]), access: .read),
        AgentToolDefinition(name: "list_comments",
                            description: "列出批注和待办：编号、类型、状态、优先级、内容、所在页面（或浮动）以及批注所引的原文。",
                            schema: object([
                                "kind": ["type": "string", "enum": ["note", "todo"], "description": "只列出批注（note）或待办（todo）。"],
                                "status": ["type": "string", "enum": ["open", "resolved", "all"], "description": "未解决（open，默认）、已解决（resolved）或全部（all）。"],
                            ]), access: .read),
        AgentToolDefinition(name: "list_materials",
                            description: "列出素材库：编号、标题、类型（图片、PDF、链接、文字）、备注摘录、链接地址和文字素材的开头。不包含文件内容。",
                            schema: object([:]), access: .read),
        AgentToolDefinition(name: "read_material",
                            description: "读取一条素材：标题、类型、备注、链接地址和文字素材的全文。图片和 PDF 只提供标题和备注。",
                            schema: object(["materialId": text("素材编号（来自 list_materials）。"),
                                            "title": text("完全一致的素材标题；没有 materialId 时使用。")]), access: .read),
        AgentToolDefinition(name: "get_element_patches",
                            description: "读取一个设定的设定补丁（它从故事某处起的变化）：编号、标题、内容、来源章节和所引原文。已失效的补丁不列出，只说明数量。",
                            schema: object(elementTarget), access: .read),
        AgentToolDefinition(name: "search_project",
                            description: "在全书搜索文字：章节标题和正文，以及章节摘要、漂流、设定（名称、别名、简介、字段、正文）、分类、故事线和素材。返回命中的位置和摘录。",
                            schema: object(["query": text("要搜索的文字。")], required: ["query"]), access: .read),
        AgentToolDefinition(name: "find_element_appearances",
                            description: "列出正文中链接到一个设定的章节，以及链接到它的漂流、设定、分类和故事线页面：每处的段落数和链接次数。未链接的提及请用 search_project。",
                            schema: object(elementTarget), access: .read),
        AgentToolDefinition(name: "read_storyline",
                            description: "读取一条故事线：名称、简介、字段、所含章节（按书中顺序，标出主线）和正文。",
                            schema: object(storylineTarget), access: .read),
    ]

    static let domainWrites: [AgentToolDefinition] = [
        AgentToolDefinition(name: "create_element",
                            description: "提议在一个分类中新建设定，可以同时给出分组、简介、别名、字段和开头正文（追加在分类模版正文之后）。" + proposalNote,
                            schema: object([
                                "categoryId": text("分类编号。"), "category": text("完全一致的分类名称；没有 categoryId 时使用。"),
                                "name": text("新设定的名称。"), "group": text("可选的分组名称。"), "summary": text("可选的简介。"),
                                "aliases": names, "facts": facts, "text": text("可选的开头正文；用换行符分段。"),
                            ], required: ["name"]), access: .write),
        AgentToolDefinition(name: "update_element",
                            description: "提议修改一个设定的名称、简介、别名、分类或分组。只给出要改的项。" + proposalNote,
                            schema: object(merged(elementTarget, [
                                "newName": text("新的名称。"), "summary": text("新的简介全文；空字符串表示清空。"), "aliases": names,
                                "categoryId": text("移到这个编号的分类。"),
                                "category": text("移到这个名称的分类；“未分类”表示移出分类。"),
                                "group": text("新的分组名称；空字符串表示移出分组。"),
                            ])), access: .write),
        AgentToolDefinition(name: "set_element_facts",
                            description: "提议整体替换一个设定的字段（有序的字段名和值）。" + proposalNote,
                            schema: object(merged(elementTarget, ["facts": facts]), required: ["facts"]), access: .write),
        AgentToolDefinition(name: "create_element_category",
                            description: "提议在设定库中新建一个分类。颜色由应用选择。" + proposalNote,
                            schema: object(["name": text("新分类的名称。")], required: ["name"]), access: .write),
        AgentToolDefinition(name: "update_element_category",
                            description: "提议修改一个分类的名称或颜色。" + proposalNote,
                            schema: object(merged(categoryTarget, ["newName": text("新的名称。"), "color": color])), access: .write),
        AgentToolDefinition(name: "trash_element",
                            description: "提议把一个设定移到回收站（可以恢复）；它的关系会被删除。" + proposalNote,
                            schema: object(elementTarget), access: .write),
        AgentToolDefinition(name: "create_element_patch",
                            description: "提议为一个设定新建设定补丁：它从故事某处起发生的变化。可以注明来源章节。标题和内容不能都为空。" + proposalNote,
                            schema: object(merged(elementTarget, [
                                "title": text("可选的补丁标题。"), "body": text("补丁内容；空行分段。"),
                                "sourceChapterId": text("可选的来源章节编号。"),
                                "sourceChapterTitle": text("可选的来源章节标题；没有 sourceChapterId 时使用。"),
                            ]), required: ["body"]), access: .write),
        AgentToolDefinition(name: "update_element_patch",
                            description: "提议修改一个设定补丁的标题或内容。只给出要改的项。" + proposalNote,
                            schema: object(merged(elementTarget, [
                                "patchId": text("补丁编号（来自 get_element_patches）。"),
                                "title": text("新的标题；空字符串表示清除标题。"), "body": text("新的内容全文。"),
                            ]), required: ["patchId"]), access: .write),
        AgentToolDefinition(name: "delete_element_patch",
                            description: "提议删除一个设定补丁。" + proposalNote,
                            schema: object(merged(elementTarget, ["patchId": text("补丁编号（来自 get_element_patches）。")]),
                                           required: ["patchId"]), access: .write),
        AgentToolDefinition(name: "create_storyline",
                            description: "提议新建一条故事线，可以附带简介。新故事线会复制本书的故事线字段模版；如果这是第一条故事线，全书章节都会归入它并以它为主线。" + proposalNote,
                            schema: object(["name": text("新故事线的名称。"), "summary": text("可选的简介。")], required: ["name"]), access: .write),
        AgentToolDefinition(name: "update_storyline",
                            description: "提议修改一条故事线的名称、简介或颜色。只给出要改的项。" + proposalNote,
                            schema: object(merged(storylineTarget, [
                                "newName": text("新的名称。"), "summary": text("新的简介全文；空字符串表示清空。"), "color": color,
                            ])), access: .write),
        AgentToolDefinition(name: "set_chapter_storylines",
                            description: "提议设定一个章节属于哪些故事线，以及哪一条是它的主线。会整体替换原有归属；空数组表示未归属。" + proposalNote,
                            schema: object(merged(chapterTarget, [
                                "storylines": ["type": "array", "maxItems": 32, "items": text("故事线编号或完全一致的名称。"),
                                               "description": "章节所属的全部故事线。"],
                                "primary": text("主线的编号或名称，必须在 storylines 之中；不提供时取其中排在最前的一条。"),
                            ]), required: ["storylines"]), access: .write),
        AgentToolDefinition(name: "create_relation",
                            description: "提议在两个对象（章节、漂流、设定、分类或故事线）之间新建一条关系。关系类型须允许这两端。" + proposalNote,
                            schema: object([
                                "from": entity, "to": entity,
                                "relationType": text("关系类型的编号或完全一致的名称（来自 list_relation_types）。"),
                            ], required: ["from", "to", "relationType"]), access: .write),
        AgentToolDefinition(name: "update_relation",
                            description: "提议修改一条关系：改为另一种关系类型，或交换两端的方向。" + proposalNote,
                            schema: object([
                                "relationId": text("关系编号（来自 list_relations）。"),
                                "relationType": text("新的关系类型编号或名称；不提供时保持原类型。"),
                                "swap": ["type": "boolean", "description": "为 true 时交换两端。"],
                            ], required: ["relationId"]), access: .write),
        AgentToolDefinition(name: "delete_relation",
                            description: "提议删除一条关系。" + proposalNote,
                            schema: object(["relationId": text("关系编号（来自 list_relations）。")], required: ["relationId"]), access: .write),
        AgentToolDefinition(name: "create_relation_type",
                            description: "提议新建一种关系类型，例如有向的“师徒”（师父 → 徒弟）或对称的“盟友”。node 表示章节或漂流。" + proposalNote,
                            schema: object([
                                "name": text("类型名称。"),
                                "orientation": ["type": "string", "enum": ["directed", "symmetric"], "description": "有向（directed）或对称（symmetric）。"],
                                "sourceRole": text("源端的角色，例如“师父”；对称类型两端共用这个角色。"),
                                "targetRole": text("目标端的角色，例如“徒弟”；对称类型不需要。"),
                                "sourceKinds": ["type": "array", "minItems": 1, "maxItems": 4,
                                                "items": ["type": "string", "enum": relationKinds], "description": "源端可以连接的对象。"],
                                "targetKinds": ["type": "array", "minItems": 1, "maxItems": 4,
                                                "items": ["type": "string", "enum": relationKinds], "description": "目标端可以连接的对象；对称类型与源端相同。"],
                                "description": text("可选的说明。"),
                            ], required: ["name", "orientation", "sourceRole", "sourceKinds"]), access: .write),
        AgentToolDefinition(name: "create_comment",
                            description: "提议添加一条批注或待办：写在一个章节、漂流、设定、分类或故事线上，或作为不属于任何页面的浮动待办。" + proposalNote,
                            schema: object([
                                "kind": ["type": "string", "enum": ["note", "todo"], "description": "批注（note）或待办（todo）。"],
                                "target": entity,
                                "body": text("内容。"),
                                "priority": ["type": "string", "enum": ["low", "med", "high"], "description": "可选的优先级：低、中、高。"],
                            ], required: ["kind", "body"]), access: .write),
        AgentToolDefinition(name: "update_comment",
                            description: "提议修改一条批注或待办的内容、类型或优先级。只给出要改的项。" + proposalNote,
                            schema: object([
                                "commentId": text("批注或待办的编号（来自 list_comments）。"),
                                "body": text("新的内容全文。"),
                                "kind": ["type": "string", "enum": ["note", "todo"], "description": "改为批注或待办。"],
                                "priority": ["type": "string", "enum": ["low", "med", "high", "none"], "description": "新的优先级；none 表示清除。"],
                            ], required: ["commentId"]), access: .write),
        AgentToolDefinition(name: "resolve_comment",
                            description: "提议把一条批注或待办标为已解决，或重新打开。" + proposalNote,
                            schema: object([
                                "commentId": text("批注或待办的编号（来自 list_comments）。"),
                                "resolved": ["type": "boolean", "description": "默认 true（标为已解决）；false 表示重新打开。"],
                            ], required: ["commentId"]), access: .write),
        AgentToolDefinition(name: "rename_chapter",
                            description: "提议修改一个章节的标题。" + proposalNote,
                            schema: object(merged(chapterTarget, ["newTitle": text("新的标题。")]), required: ["newTitle"]), access: .write),
        AgentToolDefinition(name: "trash_chapter",
                            description: "提议把一个章节移到回收站（可以恢复）；它的关系会被删除。" + proposalNote,
                            schema: object(chapterTarget), access: .write),
        AgentToolDefinition(name: "create_drift",
                            description: "提议新建一条漂流（灵感），可以附带正文。" + proposalNote,
                            schema: object(["title": text("新漂流的标题。"), "text": text("可选的正文；用换行符分段。")], required: ["title"]),
                            access: .write),
        AgentToolDefinition(name: "rename_drift",
                            description: "提议修改一条漂流（灵感）的标题。" + proposalNote,
                            schema: object(merged(driftTarget, ["newTitle": text("新的标题。")]), required: ["newTitle"]), access: .write),
        AgentToolDefinition(name: "set_drift_summary",
                            description: "提议把一条漂流（灵感）的摘要改为新的内容。" + proposalNote,
                            schema: object(merged(driftTarget, ["summary": text("新的摘要全文；空字符串表示清空。")]), required: ["summary"]),
                            access: .write),
        AgentToolDefinition(name: "update_project_facts",
                            description: "提议整体替换本书字段（作者定义的全书设定和规则，有序的字段名和值）。" + proposalNote,
                            schema: object(["facts": facts], required: ["facts"]), access: .write),
        AgentToolDefinition(name: "update_project_summary",
                            description: "提议把本书简介改为新的内容。" + proposalNote,
                            schema: object(["summary": text("新的本书简介全文；空字符串表示清空。")], required: ["summary"]), access: .write),
    ]
}
