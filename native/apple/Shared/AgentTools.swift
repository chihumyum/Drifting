import Foundation

/// The native writing Agent's tools over the Rust workspace. Reads run as
/// soon as the model calls them. Writes only create a pending proposal;
/// nothing is written until the author accepts it. Memory tools change only
/// the assistant's own rules, working memory and task plan, at once.
enum AgentToolAccess: String { case read, write, memory }

struct AgentToolDefinition {
    let name: String
    let description: String
    /// JSON Schema of the arguments object.
    let schema: [String: Any]
    let access: AgentToolAccess
}

enum AgentToolRegistry {
    static func object(_ properties: [String: Any], required: [String] = []) -> [String: Any] {
        var schema: [String: Any] = ["type": "object", "properties": properties, "additionalProperties": false]
        if !required.isEmpty { schema["required"] = required }
        return schema
    }
    static func text(_ description: String) -> [String: Any] { ["type": "string", "description": description] }

    static let chapterTarget: [String: Any] = [
        "chapterId": text("章节编号（来自 list_chapters）。"),
        "title": text("完全一致的章节标题；没有 chapterId 时使用。"),
    ]
    static let changes: [String: Any] = [
        "type": "array", "minItems": 1, "maxItems": 20,
        "description": "逐处修改。currentText 必须逐字出现在最新正文中（含标点），足够长以唯一定位；多处修改不能重叠。",
        "items": object([
            "currentText": text("要替换的原文：最新正文中逐字存在的连续片段。"),
            "revisedText": text("替换后的文字；可以为空（删除），需要分段时使用换行符。"),
            "allOccurrences": ["type": "boolean", "description": "为 true 时替换原文的全部出现；默认只允许唯一出现。"],
        ], required: ["currentText", "revisedText"]),
    ]

    /// Every tool, reads first: the prose tools, then the domain tools
    /// (`AgentDomainTools.swift`) and the memory tools (`AgentMemory.swift`).
    static let all: [AgentToolDefinition] = proseReads + domainReads + memoryReads + proseWrites + domainWrites + memoryWrites

    static let proseReads: [AgentToolDefinition] = [
        AgentToolDefinition(name: "list_chapters", description: "按书中顺序列出全部章节：编号、标题、顺序、写作状态、字数和摘要。",
                            schema: object([:]), access: .read),
        AgentToolDefinition(name: "read_chapter", description: "读取一个章节的最新正文、摘要和写作状态。作者正在编辑的章节读取的是实时内容。",
                            schema: object(chapterTarget), access: .read),
        AgentToolDefinition(name: "search_prose", description: "在全书章节标题和正文中搜索文字，返回命中的章节和摘录。",
                            schema: object(["query": text("要搜索的文字。")], required: ["query"]), access: .read),
        AgentToolDefinition(name: "list_elements", description: "列出设定库中的全部分类（编号、名称、设定数）和全部设定：编号、名称、别名、分类、分组和简介。",
                            schema: object([:]), access: .read),
        AgentToolDefinition(name: "read_element", description: "读取一个设定：名称、别名、分类、简介、字段和正文。",
                            schema: object(["elementId": text("设定编号（来自 list_elements）。"),
                                            "name": text("设定的名称或别名；没有 elementId 时使用。")]), access: .read),
        AgentToolDefinition(name: "read_category", description: "读取设定库中的一个分类：名称、所含设定、模板字段、新设定模版和分类正文（札记）。",
                            schema: object(["categoryId": text("分类编号（来自 list_elements）。"),
                                            "name": text("完全一致的分类名称；没有 categoryId 时使用。")]), access: .read),
        AgentToolDefinition(name: "list_storylines", description: "列出全部故事线：名称、简介、字段和所含章节（按书中顺序，标出主线）。",
                            schema: object([:]), access: .read),
        AgentToolDefinition(name: "list_drifts", description: "列出全部漂流（灵感）：编号、标题、摘要和分组。",
                            schema: object([:]), access: .read),
        AgentToolDefinition(name: "read_drift", description: "读取一条漂流（灵感）的摘要和正文。",
                            schema: object(["driftId": text("漂流编号（来自 list_drifts）。"),
                                            "title": text("完全一致的漂流标题；没有 driftId 时使用。")]), access: .read),
        AgentToolDefinition(name: "project_overview",
                            description: "读取项目概况：书名、本书简介、本书字段、章节数、全书字数，以及设定、分类、故事线、漂流、关系、未完成待办和素材的数量。",
                            schema: object([:]), access: .read),
    ]

    static let proseWrites: [AgentToolDefinition] = [
        AgentToolDefinition(name: "revise_chapter",
                            description: "提出对一个章节正文的修改：把每处 currentText 替换为 revisedText。只替换已有文字；在末尾续写新段落请用 append_to_body。只生成修改提案，作者在对话中接受后才会写入正文。",
                            schema: object(chapterTarget.merging(["changes": changes]) { $1 }, required: ["changes"]), access: .write),
        AgentToolDefinition(name: "revise_element",
                            description: "提出对一个设定正文的修改：把每处 currentText 替换为 revisedText。只替换已有文字；在末尾追加请用 append_to_body。只生成修改提案，作者接受后才会写入。",
                            schema: object(["elementId": text("设定编号。"), "name": text("设定的名称或别名；没有 elementId 时使用。"),
                                            "changes": changes], required: ["changes"]), access: .write),
        AgentToolDefinition(name: "revise_category",
                            description: "提出对一个分类正文（札记）的修改：把每处 currentText 替换为 revisedText。只替换已有文字；在末尾追加请用 append_to_body。只生成修改提案，作者接受后才会写入。",
                            schema: object(["categoryId": text("分类编号。"), "name": text("完全一致的分类名称；没有 categoryId 时使用。"),
                                            "changes": changes], required: ["changes"]), access: .write),
        AgentToolDefinition(name: "revise_drift",
                            description: "提出对一条漂流（灵感）正文的修改：把每处 currentText 替换为 revisedText。只替换已有文字；在末尾追加请用 append_to_body。只生成修改提案，作者接受后才会写入。",
                            schema: object(["driftId": text("漂流编号。"), "title": text("完全一致的漂流标题；没有 driftId 时使用。"),
                                            "changes": changes], required: ["changes"]), access: .write),
        AgentToolDefinition(name: "revise_storyline",
                            description: "提出对一条故事线正文的修改：把每处 currentText 替换为 revisedText。只替换已有文字；在末尾追加请用 append_to_body。只生成修改提案，作者接受后才会写入。",
                            schema: object(["storylineId": text("故事线编号。"), "name": text("完全一致的故事线名称；没有 storylineId 时使用。"),
                                            "changes": changes], required: ["changes"]), access: .write),
        AgentToolDefinition(name: "append_to_body",
                            description: "提议在一个章节、设定、分类、漂流（灵感）或故事线的正文末尾续写新段落；空白正文也可以直接写入。只生成修改提案，作者接受后才会写入。",
                            schema: object([
                                "kind": ["type": "string", "enum": ["chapter", "element", "category", "drift", "storyline"],
                                         "description": "正文属于章节、设定、分类、漂流还是故事线。"],
                                "id": text("章节、设定、分类、漂流或故事线的编号。"),
                                "name": text("完全一致的章节或漂流标题、分类或故事线名称，或设定的名称、别名；没有 id 时使用。"),
                                "text": text("要追加的正文；用换行符分段，每行成为一个新段落。"),
                            ], required: ["kind", "text"]), access: .write),
        AgentToolDefinition(name: "create_chapter",
                            description: "提议在书末新建一个章节，可以附带开头正文。作者接受后才会创建并写入。",
                            schema: object(["title": text("新章节的标题。"),
                                            "text": text("可选的初始正文；用换行符分段。")], required: ["title"]), access: .write),
        AgentToolDefinition(name: "set_chapter_summary",
                            description: "提议把一个章节的摘要改为新的内容。作者接受后才会写入。",
                            schema: object(chapterTarget.merging(["summary": text("新的摘要全文；空字符串表示清空。")]) { $1 },
                                           required: ["summary"]), access: .write),
    ]

    static func definition(_ name: String) -> AgentToolDefinition? { all.first { $0.name == name } }
}

/// One executed tool call: what the model reads, the transcript's activity
/// line and, for a write, the proposal it created.
struct AgentToolOutcome {
    var ok: Bool
    var content: String
    var activity: String
    var proposal: AgentProposal?

    static func failure(_ message: String, activity: String) -> AgentToolOutcome {
        AgentToolOutcome(ok: false, content: message, activity: "\(activity)：\(message)", proposal: nil)
    }
}

/// A call refused before it ran.
struct AgentToolRefusal: Error {
    let outcome: AgentToolOutcome
    init(_ outcome: AgentToolOutcome) { self.outcome = outcome }
}

/// What an accepted proposal changed.
enum AgentApplyOutcome {
    case prose(applied: Int, live: Bool, appended: Bool)
    /// `textError` is why the opening text was not written; the chapter exists.
    case chapter(WorkspaceChapter, wroteText: Bool, textError: String?)
    case metadata(WorkspaceNodeMetadata)
    /// A domain write: what the model is told, the identity it created (if
    /// any), whether a later step of it failed, and what views follow.
    case domain(message: String, created: String?, partial: Bool, effects: [AgentWorkspaceEffect])

    var message: String {
        switch self {
        case .prose(_, _, true): return "已追加到正文末尾。"
        case .prose(let applied, _, false): return "已应用 \(applied) 处修改。"
        case .chapter(let chapter, let wroteText, let textError):
            let created = "已在书末创建章节《\(chapter.title)》（编号 \(chapter.id)）"
            if let textError { return "\(created)，但初始正文没有写入：\(textError)。章节现在是空白的。" }
            return created + (wroteText ? "，并写入了初始正文。" : "。")
        case .metadata: return "摘要已更新。"
        case .domain(let message, _, _, _): return message
        }
    }

    var partial: Bool {
        switch self {
        case .chapter(_, _, let error?): return !error.isEmpty
        case .domain(_, _, let partial, _): return partial
        default: return false
        }
    }
}

/// An apply refusal. A transient one (the author is typing, a save or an
/// owner change is pending) leaves the proposal pending for another try.
struct AgentApplyRefusal: Error, LocalizedError {
    let message: String
    let transient: Bool
    var errorDescription: String? { message }

    init(_ error: Error) {
        let reason = (error as? LabError)?.errorDescription ?? error.localizedDescription
        let chinese = reason.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) }
        message = chinese ? reason : "目标已不可用（可能已移到回收站），内容未改变。"
        // “修改已应用但尚未保存” is not transient: another try would apply twice.
        transient = !reason.contains("已应用")
            && ["正在输入", "尚未保存", "正在切换", "请先完成输入", "请先完成所有标签中的输入", "待恢复草稿"].contains { reason.contains($0) }
    }
}

/// Page lifecycle writes run by the tab host, so a trashed page's tabs
/// close once Rust commits. Without a host the workspace is called directly.
struct AgentPageLifecycle {
    var trashChapter: (_ chapterID: String, _ done: @escaping (Result<WorkspaceChapterTrashReply, Error>) -> Void) -> Void
    var trashElement: (_ elementID: String, _ done: @escaping (Result<WorkspaceElementReply<WorkspaceElement>, Error>) -> Void) -> Void
}

final class AgentWorkspaceTools {
    static let readLimit = 40_000
    static let listLimit = 400
    let workspace: LabWorkspaceCore
    let projectID: String
    /// Set by the Mac tab host; trash then closes the page's tabs.
    var lifecycle: AgentPageLifecycle?

    init(workspace: LabWorkspaceCore, projectID: String) {
        self.workspace = workspace; self.projectID = projectID
    }

    /// Present-tense progress for the transcript while a call runs.
    static func progress(_ call: AgentToolCall) -> String {
        let arguments = AgentJSONText.object(call.arguments) ?? [:]
        let title = (arguments["title"] as? String) ?? (arguments["name"] as? String)
        switch call.name {
        case "list_chapters": return "正在列出章节…"
        case "read_chapter": return title.map { "正在读取《\(clean($0))》…" } ?? "正在读取章节…"
        case "search_prose": return "正在搜索…"
        case "list_elements": return "正在列出设定…"
        case "read_element": return title.map { "正在读取设定「\($0)」…" } ?? "正在读取设定…"
        case "read_category": return title.map { "正在读取分类「\($0)」…" } ?? "正在读取分类…"
        case "list_storylines": return "正在列出故事线…"
        case "list_drifts": return "正在列出漂流…"
        case "read_drift": return title.map { "正在读取漂流「\($0)」…" } ?? "正在读取漂流…"
        case "project_overview": return "正在读取项目概况…"
        default: return AgentMemoryTools.progress(call.name) ?? domainProgress(call.name, title: title) ?? "正在准备修改提案…"
        }
    }

    static func clean(_ title: String) -> String {
        title.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "《》「」“”\""))
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    static func string(_ value: Any?) -> String? {
        guard let text = value as? String else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    static func message(_ error: Error) -> String { AgentApplyRefusal(error).message }
    static func json(_ value: Any) -> String { AgentJSONText.encode(value) }

    /// Text for the model, cut at `readLimit` characters.
    static func bounded(_ text: String) -> [String: Any] {
        guard text.count > readLimit else { return ["text": text, "characters": text.count] }
        return ["text": String(text.prefix(readLimit)), "characters": text.count, "truncated": true,
                "note": "正文过长，只返回了前 \(readLimit) 字。需要后文时请用 search_prose 定位。"]
    }

    // MARK: Running a call

    /// The call's arguments checked against its schema, or the refusal.
    static func validated(_ call: AgentToolCall) -> Result<[String: Any], AgentToolRefusal> {
        guard let definition = AgentToolRegistry.definition(call.name) else {
            return .failure(AgentToolRefusal(.failure("没有名为 \(call.name) 的工具。", activity: "未知工具 \(call.name)")))
        }
        guard let raw = AgentJSONText.object(call.arguments) else {
            return .failure(AgentToolRefusal(.failure("参数不是有效的 JSON 对象。", activity: "\(call.name) 参数无效")))
        }
        // An append inside a revision gets its own guidance before the schema.
        if call.name.hasPrefix("revise_"), (raw["changes"] as? [[String: Any]])?.contains(where: { $0["append"] as? Bool == true }) == true {
            return .failure(AgentToolRefusal(.failure("revise 工具只替换已有文字；在末尾续写请用 append_to_body。", activity: "提出修改失败")))
        }
        let arguments = AgentSchema.withoutNulls(raw, schema: definition.schema)
        if let violation = AgentSchema.violation(arguments, schema: definition.schema) {
            return .failure(AgentToolRefusal(.failure("\(violation)请按工具说明重新调用。", activity: "\(call.name) 参数无效")))
        }
        return .success(arguments)
    }

    func run(_ call: AgentToolCall, turnID: String, completion: @escaping (AgentToolOutcome) -> Void) {
        let arguments: [String: Any]
        switch Self.validated(call) {
        case .failure(let refusal): completion(refusal.outcome); return
        case .success(let valid): arguments = valid
        }
        if runDomain(call, turnID: turnID, arguments, completion) { return }
        switch call.name {
        case "list_chapters": listChapters(completion)
        case "read_chapter": readChapter(arguments, completion)
        case "search_prose": search(arguments, completion)
        case "list_elements": listElements(completion)
        case "read_element": readElement(arguments, completion)
        case "read_category": readCategory(arguments, completion)
        case "list_storylines": listStorylines(completion)
        case "list_drifts": listDrifts(completion)
        case "read_drift": readDrift(arguments, completion)
        case "project_overview": overview(completion)
        case "revise_chapter", "revise_element", "revise_category", "revise_drift", "revise_storyline":
            propose(call, turnID: turnID, arguments, completion)
        case "append_to_body": proposeAppend(call, turnID: turnID, arguments, completion)
        case "create_chapter": proposeChapter(call, turnID: turnID, arguments, completion)
        case "set_chapter_summary": proposeSummary(call, turnID: turnID, arguments, completion)
        default: completion(.failure("没有名为 \(call.name) 的工具。", activity: "未知工具 \(call.name)"))
        }
    }

    // MARK: Targets

    struct Target { let kind: String; let id: String; let title: String }

    /// Ambiguous names are refused with every candidate's identity.
    static func candidates(_ items: [String]) -> String {
        let shown = items.prefix(8).joined(separator: "、")
        return items.count > 8 ? shown + " 等 \(items.count) 个" : shown
    }

    func chapter(_ arguments: [String: Any], _ done: @escaping (Result<WorkspaceChapter, AgentApplyRefusalText>) -> Void) {
        let id = Self.string(arguments["chapterId"]), title = Self.string(arguments["title"]).map(Self.clean)
        guard id != nil || title != nil else { done(.failure("请提供 chapterId 或章节标题。")); return }
        workspace.chapters(projectID: projectID) { result in
            switch result {
            case .failure(let error): done(.failure(AgentApplyRefusalText(Self.message(error))))
            case .success(let chapters):
                if let id, let chapter = chapters.first(where: { $0.id == id }) { done(.success(chapter)); return }
                guard let title else { done(.failure(AgentApplyRefusalText("找不到编号为 \(id ?? "") 的章节（可能已移到回收站）。请先用 list_chapters 查看。"))); return }
                let matches = chapters.filter { Self.clean($0.title) == title }
                switch matches.count {
                case 1: done(.success(matches[0]))
                case 0: done(.failure(AgentApplyRefusalText("找不到标题为《\(title)》的章节。请先用 list_chapters 查看章节列表。")))
                default:
                    let listed = matches.map { match in "\(match.id)（第 \((chapters.firstIndex { $0.id == match.id } ?? 0) + 1) 章）" }
                    done(.failure(AgentApplyRefusalText("有 \(matches.count) 个章节都叫《\(title)》：\(Self.candidates(listed))。请改用 chapterId 指定。")))
                }
            }
        }
    }

    func element(_ arguments: [String: Any],
                         _ done: @escaping (Result<(WorkspaceElement, WorkspaceElementLibrary), AgentApplyRefusalText>) -> Void) {
        let id = Self.string(arguments["elementId"]), name = Self.string(arguments["name"]).map(Self.clean)
        guard id != nil || name != nil else { done(.failure("请提供 elementId 或设定名称。")); return }
        workspace.elementLibrary(projectID: projectID) { result in
            switch result {
            case .failure(let error): done(.failure(AgentApplyRefusalText(Self.message(error))))
            case .success(let library):
                if let id, let element = library.elements.first(where: { $0.id == id }) { done(.success((element, library))); return }
                guard let name else { done(.failure(AgentApplyRefusalText("找不到编号为 \(id ?? "") 的设定（可能已移到回收站）。"))); return }
                let named = library.elements.filter { $0.name == name }
                let matches = named.isEmpty ? library.elements.filter { $0.aliases.contains(name) } : named
                switch matches.count {
                case 1: done(.success((matches[0], library)))
                case 0: done(.failure(AgentApplyRefusalText("找不到名为「\(name)」的设定。请先用 list_elements 查看。")))
                default:
                    let categories = Dictionary(library.categories.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
                    let listed = matches.map { "\($0.id)（\($0.name)，\($0.categoryId.flatMap { categories[$0] } ?? "未分类")）" }
                    done(.failure(AgentApplyRefusalText("有 \(matches.count) 个设定都叫「\(name)」：\(Self.candidates(listed))。请改用 elementId 指定。")))
                }
            }
        }
    }

    func category(_ arguments: [String: Any],
                          _ done: @escaping (Result<(WorkspaceElementCategory, WorkspaceElementLibrary), AgentApplyRefusalText>) -> Void) {
        let id = Self.string(arguments["categoryId"]), name = Self.string(arguments["name"]).map(Self.clean)
        guard id != nil || name != nil else { done(.failure("请提供 categoryId 或分类名称。")); return }
        workspace.elementLibrary(projectID: projectID) { result in
            switch result {
            case .failure(let error): done(.failure(AgentApplyRefusalText(Self.message(error))))
            case .success(let library):
                if let id, let category = library.categories.first(where: { $0.id == id }) { done(.success((category, library))); return }
                guard let name else { done(.failure(AgentApplyRefusalText("找不到编号为 \(id ?? "") 的分类（可能已移到回收站）。"))); return }
                let matches = library.categories.filter { Self.clean($0.name) == name }
                switch matches.count {
                case 1: done(.success((matches[0], library)))
                case 0: done(.failure(AgentApplyRefusalText("找不到名为「\(name)」的分类。请先用 list_elements 查看。")))
                default: done(.failure(AgentApplyRefusalText("有 \(matches.count) 个分类都叫「\(name)」：\(Self.candidates(matches.map(\.id)))。请改用 categoryId 指定。")))
                }
            }
        }
    }

    func drift(_ arguments: [String: Any],
                       _ done: @escaping (Result<(WorkspaceDrift, WorkspaceDriftLibrary), AgentApplyRefusalText>) -> Void) {
        let id = Self.string(arguments["driftId"]), title = Self.string(arguments["title"]).map(Self.clean)
        guard id != nil || title != nil else { done(.failure("请提供 driftId 或漂流标题。")); return }
        workspace.driftLibrary(projectID: projectID) { result in
            switch result {
            case .failure(let error): done(.failure(AgentApplyRefusalText(Self.message(error))))
            case .success(let library):
                if let id, let drift = library.drifts.first(where: { $0.id == id }) { done(.success((drift, library))); return }
                guard let title else { done(.failure(AgentApplyRefusalText("找不到编号为 \(id ?? "") 的漂流（可能已移到回收站）。"))); return }
                let matches = library.drifts.filter { Self.clean($0.title) == title }
                switch matches.count {
                case 1: done(.success((matches[0], library)))
                case 0: done(.failure(AgentApplyRefusalText("找不到标题为「\(title)」的漂流。请先用 list_drifts 查看。")))
                default: done(.failure(AgentApplyRefusalText("有 \(matches.count) 条漂流都叫「\(title)」：\(Self.candidates(matches.map(\.id)))。请改用 driftId 指定。")))
                }
            }
        }
    }

    func storyline(_ arguments: [String: Any],
                   _ done: @escaping (Result<(WorkspaceStoryline, WorkspaceStorylineLibrary), AgentApplyRefusalText>) -> Void) {
        let id = Self.string(arguments["storylineId"]), name = Self.string(arguments["name"]).map(Self.clean)
        guard id != nil || name != nil else { done(.failure("请提供 storylineId 或故事线名称。")); return }
        workspace.storylineLibrary(projectID: projectID) { result in
            switch result {
            case .failure(let error): done(.failure(AgentApplyRefusalText(Self.message(error))))
            case .success(let library):
                if let id, let storyline = library.storyline(id: id) { done(.success((storyline, library))); return }
                guard let name else { done(.failure(AgentApplyRefusalText("找不到编号为 \(id ?? "") 的故事线（可能已移到回收站）。"))); return }
                let matches = library.storylines.filter { Self.clean($0.name) == name }
                switch matches.count {
                case 1: done(.success((matches[0], library)))
                case 0: done(.failure(AgentApplyRefusalText("找不到名为「\(name)」的故事线。请先用 list_storylines 查看。")))
                default: done(.failure(AgentApplyRefusalText("有 \(matches.count) 条故事线都叫「\(name)」：\(Self.candidates(matches.map(\.id)))。请改用 storylineId 指定。")))
                }
            }
        }
    }

    private func target(_ tool: String, _ arguments: [String: Any], _ done: @escaping (Result<Target, AgentApplyRefusalText>) -> Void) {
        switch tool {
        case "revise_element": target(kind: "element", arguments, done)
        case "revise_category": target(kind: "category", arguments, done)
        case "revise_drift": target(kind: "drift", arguments, done)
        case "revise_storyline": target(kind: "storyline", arguments, done)
        default: target(kind: "chapter", arguments, done)
        }
    }

    private func target(kind: String, _ arguments: [String: Any], _ done: @escaping (Result<Target, AgentApplyRefusalText>) -> Void) {
        switch kind {
        case "element": element(arguments) { done($0.map { Target(kind: "element", id: $0.0.id, title: $0.0.name) }) }
        case "category": category(arguments) { done($0.map { Target(kind: "category", id: $0.0.id, title: $0.0.name) }) }
        case "drift": drift(arguments) { done($0.map { Target(kind: "drift", id: $0.0.id, title: $0.0.title) }) }
        case "storyline": storyline(arguments) { done($0.map { Target(kind: "storyline", id: $0.0.id, title: $0.0.name) }) }
        default: chapter(arguments) { done($0.map { Target(kind: "chapter", id: $0.id, title: $0.title) }) }
        }
    }

    // MARK: Reads

    private func listChapters(_ completion: @escaping (AgentToolOutcome) -> Void) {
        workspace.chapters(projectID: projectID) { [workspace, projectID] result in
            guard case .success(let chapters) = result else {
                completion(.failure(Self.message(result.error!), activity: "列出章节失败")); return
            }
            workspace.wordCounts(projectID: projectID) { counts in
                let library = (try? counts.get()).map { WordCountLibrary($0.counts) }
                // Every chapter's summary in one read.
                workspace.nodesMetadata(projectID: projectID) { metadata in
                    let summaries = Dictionary(((try? metadata.get()) ?? []).map { ($0.id, $0.summary) }, uniquingKeysWith: { first, _ in first })
                    let rows: [[String: Any]] = chapters.prefix(Self.listLimit).enumerated().map { index, chapter in
                        ["id": chapter.id, "title": chapter.title, "order": index + 1,
                         "status": WritingStatus.label(chapter.writingStatus ?? "draft"),
                         "wordCount": library?.count(nodeID: chapter.id).map { $0 as Any } ?? NSNull(),
                         "summary": summaries[chapter.id] ?? ""]
                    }
                    completion(AgentToolOutcome(ok: true, content: Self.json(["count": chapters.count, "chapters": rows]),
                                                activity: "列出章节（\(chapters.count) 章）", proposal: nil))
                }
            }
        }
    }

    private func readChapter(_ arguments: [String: Any], _ completion: @escaping (AgentToolOutcome) -> Void) {
        chapter(arguments) { [workspace, projectID] result in
            switch result {
            case .failure(let refusal): completion(.failure(refusal.message, activity: "读取章节失败"))
            case .success(let chapter):
                workspace.agentReadProse(projectID: projectID, kind: "chapter", id: chapter.id) { prose in
                    guard case .success(let body) = prose else {
                        completion(.failure(Self.message(prose.error!), activity: "读取《\(chapter.title)》失败")); return
                    }
                    workspace.nodeMetadata(projectID: projectID, nodeID: chapter.id) { metadata in
                        var value = Self.bounded(body.text)
                        value["id"] = chapter.id; value["title"] = chapter.title
                        if case .success(let metadata) = metadata {
                            value["summary"] = metadata.summary; value["status"] = WritingStatus.label(metadata.writingStatus)
                        }
                        if body.text.isEmpty { value["note"] = "正文是空白的。" }
                        completion(AgentToolOutcome(ok: true, content: Self.json(value), activity: "读取《\(chapter.title)》", proposal: nil))
                    }
                }
            }
        }
    }

    private func search(_ arguments: [String: Any], _ completion: @escaping (AgentToolOutcome) -> Void) {
        guard let query = Self.string(arguments["query"]) else { completion(.failure("请提供要搜索的文字。", activity: "搜索失败")); return }
        workspace.search(projectID: projectID, query: query) { result in
            switch result {
            case .failure(let error): completion(.failure(Self.message(error), activity: "搜索“\(query)”失败"))
            case .success(let found):
                let hits: [[String: Any]] = found.hits.prefix(40).map {
                    ["chapterId": $0.chapterId, "chapterTitle": $0.chapterTitle, "in": $0.kind == "title" ? "标题" : "正文", "excerpt": $0.preview]
                }
                var value: [String: Any] = ["query": query, "hits": hits]
                if found.truncated || found.hits.count > hits.count { value["note"] = "结果较多，只返回了前 \(hits.count) 处。" }
                if !found.unavailable.isEmpty { value["unavailable"] = found.unavailable.map { ["chapterTitle": $0.chapterTitle, "message": $0.message] } }
                completion(AgentToolOutcome(ok: true, content: Self.json(value), activity: "搜索“\(query)”（\(found.hits.count) 处）", proposal: nil))
            }
        }
    }

    private func listElements(_ completion: @escaping (AgentToolOutcome) -> Void) {
        workspace.elementLibrary(projectID: projectID) { result in
            switch result {
            case .failure(let error): completion(.failure(Self.message(error), activity: "列出设定失败"))
            case .success(let library):
                let categories = Dictionary(library.categories.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
                let rows: [[String: Any]] = library.elements.prefix(Self.listLimit).map { element in
                    ["id": element.id, "name": element.name, "aliases": element.aliases,
                     "category": element.categoryId.flatMap { categories[$0] } ?? "未分类",
                     "group": element.groupName ?? "", "summary": element.summary]
                }
                let categoryRows: [[String: Any]] = library.categories.map { category in
                    ["id": category.id, "name": category.name,
                     "elementCount": library.elements.filter { $0.categoryId == category.id }.count]
                }
                completion(AgentToolOutcome(ok: true, content: Self.json(["categories": categoryRows, "count": library.elements.count,
                                                                          "elements": rows]),
                                            activity: "列出设定（\(library.elements.count) 个）", proposal: nil))
            }
        }
    }

    private func readElement(_ arguments: [String: Any], _ completion: @escaping (AgentToolOutcome) -> Void) {
        element(arguments) { [workspace, projectID] result in
            switch result {
            case .failure(let refusal): completion(.failure(refusal.message, activity: "读取设定失败"))
            case .success(let (element, library)):
                workspace.agentReadProse(projectID: projectID, kind: "element", id: element.id) { prose in
                    guard case .success(let body) = prose else {
                        completion(.failure(Self.message(prose.error!), activity: "读取设定「\(element.name)」失败")); return
                    }
                    var value = Self.bounded(body.text)
                    value["id"] = element.id; value["name"] = element.name; value["aliases"] = element.aliases
                    value["category"] = element.categoryId.flatMap { id in library.categories.first { $0.id == id }?.name } ?? "未分类"
                    value["group"] = element.groupName ?? ""
                    value["summary"] = element.summary
                    value["facts"] = element.facts.map { ["key": $0.key, "value": $0.value] }
                    completion(AgentToolOutcome(ok: true, content: Self.json(value), activity: "读取设定「\(element.name)」", proposal: nil))
                }
            }
        }
    }

    private func readCategory(_ arguments: [String: Any], _ completion: @escaping (AgentToolOutcome) -> Void) {
        category(arguments) { [workspace, projectID] result in
            switch result {
            case .failure(let refusal): completion(.failure(refusal.message, activity: "读取分类失败"))
            case .success(let (category, library)):
                workspace.agentReadProse(projectID: projectID, kind: "category", id: category.id) { prose in
                    guard case .success(let body) = prose else {
                        completion(.failure(Self.message(prose.error!), activity: "读取分类「\(category.name)」失败")); return
                    }
                    workspace.elementTemplate(projectID: projectID, categoryID: category.id) { template in
                        var value = Self.bounded(body.text)
                        value["id"] = category.id; value["name"] = category.name
                        let members = library.elements.filter { $0.categoryId == category.id }
                        value["elementCount"] = members.count
                        value["elements"] = members.prefix(Self.listLimit).map { ["id": $0.id, "name": $0.name] }
                        value["templateFacts"] = category.templateFacts.map { ["key": $0.key, "value": $0.value] }
                        if case .success(let blocks) = template {
                            value["elementTemplate"] = blocks.map { block -> [String: Any] in
                                ["kind": block.kind == .heading ? "标题 \(block.level ?? 1)" : "正文", "text": block.text]
                            }
                        }
                        if body.text.isEmpty { value["note"] = "分类正文是空白的。" }
                        completion(AgentToolOutcome(ok: true, content: Self.json(value), activity: "读取分类「\(category.name)」", proposal: nil))
                    }
                }
            }
        }
    }

    private func listStorylines(_ completion: @escaping (AgentToolOutcome) -> Void) {
        workspace.storylineLibrary(projectID: projectID) { [workspace, projectID] result in
            guard case .success(let library) = result else {
                completion(.failure(Self.message(result.error!), activity: "列出故事线失败")); return
            }
            workspace.chapters(projectID: projectID) { chapters in
                let titles = Dictionary(((try? chapters.get()) ?? []).map { ($0.id, $0.title) }, uniquingKeysWith: { first, _ in first })
                let rows: [[String: Any]] = library.storylines.map { storyline in
                    ["id": storyline.id, "name": storyline.name, "summary": storyline.summary,
                     "facts": storyline.facts.map { ["key": $0.key, "value": $0.value] },
                     "chapters": library.chapters(storylineID: storyline.id).compactMap { membership -> [String: Any]? in
                         titles[membership.chapterId].map { ["id": membership.chapterId, "title": $0, "primary": membership.primary == storyline.id] }
                     }]
                }
                completion(AgentToolOutcome(ok: true, content: Self.json(["count": rows.count, "storylines": rows]),
                                            activity: "列出故事线（\(rows.count) 条）", proposal: nil))
            }
        }
    }

    private func listDrifts(_ completion: @escaping (AgentToolOutcome) -> Void) {
        workspace.driftLibrary(projectID: projectID) { result in
            switch result {
            case .failure(let error): completion(.failure(Self.message(error), activity: "列出漂流失败"))
            case .success(let library):
                let groups = Dictionary(library.groups.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
                let rows: [[String: Any]] = library.drifts.prefix(Self.listLimit).map { drift in
                    ["id": drift.id, "title": drift.title, "summary": drift.summary,
                     "group": drift.driftGroupId.flatMap { groups[$0] } ?? "", "actNote": drift.actId != nil]
                }
                completion(AgentToolOutcome(ok: true, content: Self.json(["count": library.drifts.count, "drifts": rows]),
                                            activity: "列出漂流（\(library.drifts.count) 条）", proposal: nil))
            }
        }
    }

    private func readDrift(_ arguments: [String: Any], _ completion: @escaping (AgentToolOutcome) -> Void) {
        drift(arguments) { [workspace, projectID] result in
            switch result {
            case .failure(let refusal): completion(.failure(refusal.message, activity: "读取漂流失败"))
            case .success(let (drift, _)):
                workspace.agentReadProse(projectID: projectID, kind: "drift", id: drift.id) { prose in
                    guard case .success(let body) = prose else {
                        completion(.failure(Self.message(prose.error!), activity: "读取漂流「\(drift.title)」失败")); return
                    }
                    var value = Self.bounded(body.text)
                    value["id"] = drift.id; value["title"] = drift.title; value["summary"] = drift.summary
                    completion(AgentToolOutcome(ok: true, content: Self.json(value), activity: "读取漂流「\(drift.title)」", proposal: nil))
                }
            }
        }
    }

    private func overview(_ completion: @escaping (AgentToolOutcome) -> Void) {
        workspace.projectDetails(projectID: projectID) { [self] result in
            guard case .success(let details) = result else {
                completion(.failure(Self.message(result.error!), activity: "读取项目概况失败")); return
            }
            workspace.chapters(projectID: projectID) { [self] chapters in
                workspace.wordCounts(projectID: projectID) { [self] counts in
                    overviewCounts { more in
                        var value: [String: Any] = ["name": details.name, "summary": details.summary,
                                                    "facts": details.facts.map { ["key": $0.key, "value": $0.value] }]
                        value.merge(more) { first, _ in first }
                        if let chapters = try? chapters.get() { value["chapterCount"] = chapters.count }
                        if let counts = try? counts.get() {
                            let library = WordCountLibrary(counts.counts)
                            value["wordCount"] = library.chapterTotal
                            if !library.ready { value["note"] = "部分章节的字数尚未统计。" }
                        }
                        completion(AgentToolOutcome(ok: true, content: Self.json(value), activity: "读取项目概况", proposal: nil))
                    }
                }
            }
        }
    }

    // MARK: Proposals

    /// Non-overlapping UTF-16 occurrences, as Rust locates them.
    static func occurrences(of needle: String, in text: String) -> [Int] {
        let haystack = Array(text.utf16), pattern = Array(needle.utf16)
        guard !pattern.isEmpty, pattern.count <= haystack.count else { return [] }
        var found: [Int] = [], at = 0
        while at + pattern.count <= haystack.count {
            if haystack[at..<(at + pattern.count)].elementsEqual(pattern) { found.append(at); at += pattern.count } else { at += 1 }
        }
        return found
    }

    private static func excerpt(_ text: String) -> String { text.count > 24 ? String(text.prefix(24)) + "…" : text }

    private func propose(_ call: AgentToolCall, turnID: String, _ arguments: [String: Any],
                         _ completion: @escaping (AgentToolOutcome) -> Void) {
        let label = "提出修改"
        guard let raw = arguments["changes"] as? [[String: Any]], !raw.isEmpty else {
            completion(.failure("请至少提供一处修改（changes）。", activity: "\(label)失败")); return
        }
        guard raw.count <= 20 else { completion(.failure("一次最多提出 20 处修改。", activity: "\(label)失败")); return }
        var changes: [AgentProseChange] = []
        for entry in raw {
            guard let current = entry["currentText"] as? String, !current.isEmpty else {
                completion(.failure("每处修改都需要非空的 currentText。", activity: "\(label)失败")); return
            }
            guard let revised = entry["revisedText"] as? String else {
                completion(.failure("每处修改都需要 revisedText。", activity: "\(label)失败")); return
            }
            guard revised != current else { completion(.failure("修改前后的文字相同：“\(Self.excerpt(current))”。", activity: "\(label)失败")); return }
            changes.append(AgentProseChange(currentText: current, revisedText: revised, allOccurrences: entry["allOccurrences"] as? Bool ?? false))
            if entry["append"] as? Bool == true {
                completion(.failure("revise 工具只替换已有文字；在末尾续写请用 append_to_body。", activity: "\(label)失败")); return
            }
        }
        target(call.name, arguments) { [workspace, projectID] result in
            guard case .success(let target) = result else {
                if case .failure(let refusal) = result { completion(.failure(refusal.message, activity: "\(label)失败")) }
                return
            }
            let named = target.kind == "chapter" ? "《\(target.title)》" : "「\(target.title)」"
            workspace.agentReadProse(projectID: projectID, kind: target.kind, id: target.id) { prose in
                guard case .success(let body) = prose else {
                    completion(.failure(Self.message(prose.error!), activity: "修改\(named)失败")); return
                }
                guard !body.text.isEmpty else {
                    completion(.failure("\(named)的正文是空白的，没有可以替换的原文。要写入新内容请用 append_to_body。", activity: "修改\(named)失败"))
                    return
                }
                // Checked now so the model can correct itself; Rust checks again on accept.
                var ranges: [(Int, Int)] = []
                for change in changes {
                    let found = Self.occurrences(of: change.currentText, in: body.text)
                    if found.isEmpty {
                        completion(.failure("\(named)的正文中找不到要修改的原文：“\(Self.excerpt(change.currentText))”。请先读取最新正文，逐字引用其中的片段。",
                                            activity: "修改\(named)失败")); return
                    }
                    if found.count > 1 && !change.allOccurrences {
                        completion(.failure("要修改的原文在\(named)中出现了 \(found.count) 次：“\(Self.excerpt(change.currentText))”。请给出更长、能唯一定位的原文，或设置 allOccurrences。",
                                            activity: "修改\(named)失败")); return
                    }
                    ranges += found.map { ($0, change.currentText.utf16.count) }
                }
                ranges.sort { $0.0 < $1.0 }
                if zip(ranges, ranges.dropFirst()).contains(where: { $0.0 + $0.1 > $1.0 }) {
                    completion(.failure("多处修改的原文相互重叠，请合并为一处。", activity: "修改\(named)失败")); return
                }
                let proposal = AgentProposal(id: call.id, turnID: turnID, tool: call.name, kind: .revise, targetKind: target.kind,
                                             targetID: target.id, targetTitle: target.title, changes: changes, summary: nil,
                                             previousSummary: nil, state: .pending, message: nil, reported: false,
                                             createdAt: Date(), decidedAt: nil)
                completion(AgentToolOutcome(ok: true, content: Self.pending(proposal, detail: "共 \(changes.count) 处修改"),
                                            activity: "提出\(proposal.headline)（\(changes.count) 处）", proposal: proposal))
            }
        }
    }

    static func pending(_ proposal: AgentProposal, detail: String) -> String {
        "已生成修改提案 \(proposal.id)：\(proposal.headline)，\(detail)。内容尚未改变；作者会在对话中接受或拒绝，结果会附在作者的下一条消息里。不要重复提出同样的修改。"
    }

    /// Text for an append: line endings normalized, blank text refused.
    static func paragraphs(_ value: Any?) -> String? {
        guard let text = value as? String else { return nil }
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: "\u{2029}", with: "\n")
        return normalized.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : normalized
    }

    private func proposeAppend(_ call: AgentToolCall, turnID: String, _ arguments: [String: Any],
                               _ completion: @escaping (AgentToolOutcome) -> Void) {
        guard let kind = arguments["kind"] as? String, ["chapter", "element", "category", "drift", "storyline"].contains(kind) else {
            completion(.failure("kind 必须是 chapter、element、category、drift 或 storyline。", activity: "提议续写失败")); return
        }
        guard let text = Self.paragraphs(arguments["text"]) else {
            completion(.failure("要追加的正文不能为空。", activity: "提议续写失败")); return
        }
        let id = arguments["id"], name = arguments["name"]
        let resolved: [String: Any?]
        switch kind {
        case "element": resolved = ["elementId": id, "name": name]
        case "category": resolved = ["categoryId": id, "name": name]
        case "drift": resolved = ["driftId": id, "title": name]
        case "storyline": resolved = ["storylineId": id, "name": name]
        default: resolved = ["chapterId": id, "title": name]
        }
        target(kind: kind, resolved.compactMapValues { $0 }) { [workspace, projectID] result in
            switch result {
            case .failure(let refusal): completion(.failure(refusal.message, activity: "提议续写失败"))
            case .success(let target):
                let named = target.kind == "chapter" ? "《\(target.title)》" : "「\(target.title)」"
                // The body must still be readable; Rust places the text on accept.
                workspace.agentReadProse(projectID: projectID, kind: target.kind, id: target.id) { prose in
                    guard case .success(let body) = prose else {
                        completion(.failure(Self.message(prose.error!), activity: "续写\(named)失败")); return
                    }
                    let proposal = AgentProposal(id: call.id, turnID: turnID, tool: call.name, kind: .append, targetKind: target.kind,
                                                 targetID: target.id, targetTitle: target.title, changes: [.appending(text)],
                                                 summary: nil, previousSummary: nil, state: .pending, message: nil, reported: false,
                                                 createdAt: Date(), decidedAt: nil)
                    let paragraphs = text.components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.count
                    let place = body.text.isEmpty ? "写入空白正文" : "追加在正文末尾"
                    completion(AgentToolOutcome(ok: true, content: Self.pending(proposal, detail: "\(place)，共 \(paragraphs) 段"),
                                                activity: "提议\(proposal.headline)（\(text.filter { !$0.isNewline }.count) 字）", proposal: proposal))
                }
            }
        }
    }

    private func proposeChapter(_ call: AgentToolCall, turnID: String, _ arguments: [String: Any],
                                _ completion: @escaping (AgentToolOutcome) -> Void) {
        guard let title = Self.string(arguments["title"]).map(Self.clean), !title.isEmpty else {
            completion(.failure("请提供新章节的标题。", activity: "提议新建章节失败")); return
        }
        guard title.count <= 100 else { completion(.failure("章节标题太长（最多 100 字）。", activity: "提议新建章节失败")); return }
        let text = Self.paragraphs(arguments["text"])
        // Rust would number a title another chapter or drift already has.
        titleTaken(title, except: nil) { taken in
            if case .success(true) = taken {
                completion(.failure("已有章节或漂流叫《\(title)》，请换一个标题。", activity: "提议新建章节失败")); return
            }
            let proposal = AgentProposal(id: call.id, turnID: turnID, tool: call.name, kind: .createChapter, targetKind: "chapter",
                                         targetID: nil, targetTitle: title, changes: [], summary: nil, previousSummary: nil,
                                         initialText: text, state: .pending, message: nil, reported: false, createdAt: Date(), decidedAt: nil)
            let detail = text.map { "在书末创建，并写入 \($0.filter { !$0.isNewline }.count) 字的初始正文" } ?? "在书末创建，正文为空"
            completion(AgentToolOutcome(ok: true, content: Self.pending(proposal, detail: detail),
                                        activity: "提议\(proposal.headline)", proposal: proposal))
        }
    }

    private func proposeSummary(_ call: AgentToolCall, turnID: String, _ arguments: [String: Any],
                                _ completion: @escaping (AgentToolOutcome) -> Void) {
        guard let summary = arguments["summary"] as? String else {
            completion(.failure("请提供新的摘要（summary）。", activity: "提议修改摘要失败")); return
        }
        let trimmed = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        chapter(arguments) { [workspace, projectID] result in
            switch result {
            case .failure(let refusal): completion(.failure(refusal.message, activity: "提议修改摘要失败"))
            case .success(let chapter):
                workspace.nodeMetadata(projectID: projectID, nodeID: chapter.id) { metadata in
                    let previous = (try? metadata.get())?.summary
                    guard previous != trimmed else {
                        completion(.failure("《\(chapter.title)》的摘要已经是这段内容。", activity: "提议修改《\(chapter.title)》的摘要失败")); return
                    }
                    let proposal = AgentProposal(id: call.id, turnID: turnID, tool: call.name, kind: .chapterSummary, targetKind: "chapter",
                                                 targetID: chapter.id, targetTitle: chapter.title, changes: [], summary: trimmed,
                                                 previousSummary: previous, state: .pending, message: nil, reported: false,
                                                 createdAt: Date(), decidedAt: nil)
                    completion(AgentToolOutcome(ok: true, content: Self.pending(proposal, detail: "新摘要 \(trimmed.count) 字"),
                                                activity: "提议\(proposal.headline)", proposal: proposal))
                }
            }
        }
    }

    // MARK: Applying an accepted proposal

    /// Applies through Rust with the Agent identity of the proposing call:
    /// the conversation is the session, the proposing turn and call follow.
    func apply(_ proposal: AgentProposal, sessionID: String, completion: @escaping (Result<AgentApplyOutcome, AgentApplyRefusal>) -> Void) {
        let agent = ["sessionId": sessionID, "turnId": proposal.turnID, "callId": proposal.id]
        switch proposal.kind {
        case .revise, .append:
            guard let kind = proposal.targetKind, let id = proposal.targetID else {
                completion(.failure(AgentApplyRefusal(LabError.message("提案缺少修改目标。")))); return
            }
            workspace.agentApplyChanges(projectID: projectID, kind: kind, id: id, changes: proposal.changes.map(\.payload), agent: agent) { result in
                completion(result.map { .prose(applied: $0.applied, live: $0.handle != nil, appended: proposal.kind == .append) }
                    .mapError(AgentApplyRefusal.init))
            }
        case .createChapter:
            // One proposal: the chapter, then its opening text as one Agent append.
            workspace.createChapter(projectID: projectID, title: proposal.targetTitle) { [workspace, projectID] result in
                switch result {
                case .failure(let error): completion(.failure(AgentApplyRefusal(error)))
                case .success(let chapter):
                    guard let text = proposal.initialText, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                        completion(.success(.chapter(chapter, wroteText: false, textError: nil))); return
                    }
                    workspace.agentApplyChanges(projectID: projectID, kind: "chapter", id: chapter.id,
                                                changes: [AgentProseChange.appending(text).payload], agent: agent) { appended in
                        switch appended {
                        case .success: completion(.success(.chapter(chapter, wroteText: true, textError: nil)))
                        case .failure(let error):
                            completion(.success(.chapter(chapter, wroteText: false, textError: AgentApplyRefusal(error).message)))
                        }
                    }
                }
            }
        case .chapterSummary:
            guard let id = proposal.targetID else { completion(.failure(AgentApplyRefusal(LabError.message("提案缺少章节。")))); return }
            workspace.setNodeSummary(projectID: projectID, nodeID: id, summary: proposal.summary ?? "") { result in
                completion(result.map(AgentApplyOutcome.metadata).mapError(AgentApplyRefusal.init))
            }
        case .domain:
            applyDomain(proposal, agent: agent, completion: completion)
        }
    }
}

/// A tool-facing refusal message.
struct AgentApplyRefusalText: Error, ExpressibleByStringLiteral {
    let message: String
    init(_ message: String) { self.message = message }
    init(stringLiteral value: String) { message = value }
}

extension Result {
    var error: Failure? { if case .failure(let error) = self { return error }; return nil }
}
