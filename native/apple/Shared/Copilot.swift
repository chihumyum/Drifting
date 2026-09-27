import Foundation

// MARK: - Settings

/// 设置 › Copilot（实验）. Off by default and kept in the lab's
/// `settings.json`; provider keys are the writing assistant's Keychain
/// items. Values are read one by one, so a damaged value falls back alone.
struct CopilotSettings: Codable, Equatable {
    enum Trigger: String, Codable, CaseIterable {
        /// After `idleSeconds` without typing, and by hand.
        case idle
        /// Only 编辑 › Copilot 分析 (⇧⌘I) and the prose context menu.
        case manual
    }

    /// 输出语言: `auto` follows the manuscript.
    static let languages: [(code: String, label: String)] = [
        ("auto", "跟随手稿"), ("zh-CN", "简体中文"), ("zh-TW", "繁體中文"), ("en", "English"), ("ja", "日本語"), ("ko", "한국어"), ("fr", "Français"),
    ]
    static let idleRange: ClosedRange<Double> = 5...300
    static let standardIdleSeconds: Double = 20

    var enabled = false
    var provider = AgentProviderCatalog.defaultProvider
    var model = AgentProviderCatalog.option(AgentProviderCatalog.defaultProvider).models[0].value
    /// 设定抽取: new characters, places and objects.
    var extractElements = true
    /// 补丁建议: state changes of existing elements.
    var suggestPatches = true
    var trigger = Trigger.idle
    var idleSeconds = standardIdleSeconds
    var language = "auto"
    /// 在灵感中启用: drift bodies are analysed too.
    var inDrifts = false

    init() {}

    private enum CodingKeys: String, CodingKey {
        case enabled, provider, model, extractElements, suggestPatches, trigger, idleSeconds, language, inDrifts
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let standard = CopilotSettings()
        enabled = (try? values.decodeIfPresent(Bool.self, forKey: .enabled)) ?? standard.enabled
        provider = (try? values.decodeIfPresent(AgentProviderID.self, forKey: .provider)) ?? standard.provider
        model = (try? values.decodeIfPresent(String.self, forKey: .model)) ?? standard.model
        extractElements = (try? values.decodeIfPresent(Bool.self, forKey: .extractElements)) ?? standard.extractElements
        suggestPatches = (try? values.decodeIfPresent(Bool.self, forKey: .suggestPatches)) ?? standard.suggestPatches
        trigger = (try? values.decodeIfPresent(Trigger.self, forKey: .trigger)) ?? standard.trigger
        idleSeconds = (try? values.decodeIfPresent(Double.self, forKey: .idleSeconds)) ?? standard.idleSeconds
        language = (try? values.decodeIfPresent(String.self, forKey: .language)) ?? standard.language
        inDrifts = (try? values.decodeIfPresent(Bool.self, forKey: .inDrifts)) ?? standard.inDrifts
        self = normalized()
    }

    /// A model outside the provider's catalog becomes its first; the idle
    /// delay is whole seconds within 5–300; an unknown language follows the
    /// manuscript.
    func normalized() -> CopilotSettings {
        var next = self
        next.model = AgentProviderCatalog.model(provider, model).value
        let seconds = idleSeconds.isFinite ? idleSeconds.rounded() : Self.standardIdleSeconds
        next.idleSeconds = min(max(seconds, Self.idleRange.lowerBound), Self.idleRange.upperBound)
        if !Self.languages.contains(where: { $0.code == language }) { next.language = "auto" }
        return next
    }

    /// The provider and model, without thinking: tasks are short and structured.
    var choice: AgentModelChoice {
        let option = AgentProviderCatalog.model(provider, model)
        return AgentModelChoice(provider: provider, model: option.value, thinking: .off, effort: option.reasoning.defaultEffort).normalized()
    }

    /// Whether a body of this kind is analysed at all.
    func allows(_ kind: CopilotBodyKind) -> Bool { enabled && (kind == .chapter || inDrifts) }

    /// The language summaries, titles and bodies are written in.
    func languageInstruction(manuscriptLocale: String) -> String {
        let names = ["zh-CN": "简体中文", "zh-TW": "繁體中文", "en": "English", "ja": "日本語", "ko": "한국어", "fr": "Français"]
        if language != "auto", let name = names[language] { return name }
        return "与【新写的段落】相同的语言（手稿默认语言：\(names[manuscriptLocale] ?? "简体中文")）"
    }
}

/// Copilot's own token usage in a project, beside its conversations.
struct CopilotUsageFile: Codable {
    var version = 1
    var usage: [AgentUsageRecord]
}

enum CopilotBodyKind: String {
    case chapter, drift

    var label: String { self == .chapter ? "章节" : "灵感" }
}

// MARK: - Proposals

/// 设定抽取: a new element the text names.
struct CopilotElementCandidate: Equatable {
    var name: String
    /// An existing category's name, or 未分类.
    var category: String
    var summary: String
    var evidence: String
}

/// 补丁建议: a state change of an existing element.
struct CopilotPatchCandidate: Equatable {
    var elementID: String
    var elementName: String
    var title: String
    var body: String
    var evidence: String
}

/// What a suggestion proposes. Its metadata is the comment's `metadataJson`
/// and, once decided, the action's payload.
enum CopilotProposal: Equatable {
    case element(CopilotElementCandidate)
    case patch(CopilotPatchCandidate)

    static let uncategorized = "未分类"

    init?(metadata: [String: Any]) {
        let text = { (key: String) in (metadata[key] as? String) ?? "" }
        switch metadata["type"] as? String {
        case "element":
            guard !text("name").isEmpty else { return nil }
            self = .element(CopilotElementCandidate(name: text("name"), category: text("category").isEmpty ? Self.uncategorized : text("category"),
                                                    summary: text("summary"), evidence: text("evidence")))
        case "patch":
            guard !text("elementId").isEmpty else { return nil }
            self = .patch(CopilotPatchCandidate(elementID: text("elementId"), elementName: text("elementName"), title: text("title"),
                                                body: text("body"), evidence: text("evidence")))
        default: return nil
        }
    }

    init?(json: String?) {
        guard let object = AgentJSONText.object(json ?? "") else { return nil }
        self.init(metadata: object)
    }

    init?(_ comment: WorkspaceComment) {
        guard comment.isCopilot else { return nil }
        self.init(json: comment.metadataJson)
    }

    var evidence: String {
        switch self {
        case .element(let candidate): return candidate.evidence
        case .patch(let candidate): return candidate.evidence
        }
    }

    /// The metadata stored with the suggestion.
    func metadata(provider: AgentProviderID, model: String, blockID: String?, blockText: String?) -> [String: Any] {
        var metadata: [String: Any] = ["provider": provider.rawValue, "model": model]
        switch self {
        case .element(let candidate):
            metadata["type"] = "element"; metadata["task"] = "extract"
            metadata["name"] = candidate.name; metadata["category"] = candidate.category
            metadata["summary"] = candidate.summary; metadata["evidence"] = candidate.evidence
        case .patch(let candidate):
            metadata["type"] = "patch"; metadata["task"] = "patch"
            metadata["elementId"] = candidate.elementID; metadata["elementName"] = candidate.elementName
            metadata["title"] = candidate.title; metadata["body"] = candidate.body; metadata["evidence"] = candidate.evidence
            if let blockID { metadata["blockId"] = blockID }
            if let blockText { metadata["blockText"] = blockText }
        }
        return metadata
    }

    /// 新设定「林岚」（人物） / 设定补丁「林岚」：左臂受伤.
    var label: String {
        switch self {
        case .element(let candidate): return "新设定「\(candidate.name)」（\(candidate.category)）"
        case .patch(let candidate):
            let title = candidate.title.isEmpty ? "状态变化" : candidate.title
            return "设定补丁「\(candidate.elementName)」：\(title)"
        }
    }

    /// The suggestion's comment body: the label, then the summary or the
    /// patch body as its own paragraph.
    var body: String {
        switch self {
        case .element(let candidate): return candidate.summary.isEmpty ? label : label + "\n\n" + candidate.summary
        case .patch(let candidate): return candidate.body.isEmpty ? label : label + "\n\n" + candidate.body
        }
    }

    /// The live category an element suggestion names, if any.
    static func category(named name: String, in library: WorkspaceElementLibrary) -> WorkspaceElementCategory? {
        let folded = CopilotNames.folded(name)
        guard !folded.isEmpty, folded != CopilotNames.folded(uncategorized) else { return nil }
        return library.categories.first { CopilotNames.folded($0.name) == folded }
    }
}

enum CopilotNames {
    /// Case, surrounding white space and book or quotation brackets are
    /// ignored when names are compared.
    static func folded(_ name: String) -> String {
        let brackets = CharacterSet(charactersIn: "《》「」『』“”\"'‘’〈〉【】")
        return name.trimmingCharacters(in: .whitespacesAndNewlines.union(brackets)).lowercased()
    }

    static func clean(_ text: String, limit: Int) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.count > limit ? String(trimmed.prefix(limit)) : trimmed
    }
}

// MARK: - Paragraphs

/// One non-blank block of a body: its identity, text and range.
struct CopilotParagraph: Equatable {
    /// The block identity, or its position when it has none.
    let key: String
    let blockID: String?
    let text: String
    let range: NSRange
}

/// Which paragraphs a run reads: those changed since the body's last
/// completed run (never the whole book), bounded in count and length.
enum CopilotParagraphs {
    static let maxParagraphs = 12
    static let maxCharacters = 6_000

    static func paragraphs(_ projection: NativeProjection) -> [CopilotParagraph] {
        let text = projection.text as NSString
        return projection.blocks.enumerated().compactMap { index, block in
            let range = block.range.nsRange
            guard range.location >= 0, range.length > 0, NSMaxRange(range) <= text.length else { return nil }
            let value = text.substring(with: range)
            guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return CopilotParagraph(key: block.id ?? "#\(index)", blockID: block.id, text: value, range: range)
        }
    }

    static func snapshot(_ paragraphs: [CopilotParagraph]) -> [String: String] {
        Dictionary(paragraphs.map { ($0.key, $0.text) }, uniquingKeysWith: { first, _ in first })
    }

    /// New paragraphs and those whose text differs from the baseline.
    static func changed(_ current: [CopilotParagraph], since baseline: [String: String]) -> [CopilotParagraph] {
        current.filter { baseline[$0.key] != $0.text }
    }

    /// The paragraphs a selection touches, or the one holding the caret.
    static func covering(_ selection: NSRange, in current: [CopilotParagraph]) -> [CopilotParagraph] {
        guard selection.location != NSNotFound else { return [] }
        if selection.length == 0 {
            return current.filter { selection.location >= $0.range.location && selection.location <= NSMaxRange($0.range) }.prefix(1).map { $0 }
        }
        return current.filter { NSIntersectionRange($0.range, selection).length > 0 }
    }

    /// The last `maxParagraphs`, then fewer until `maxCharacters` fit; one
    /// paragraph longer than that is cut to it.
    static func bounded(_ list: [CopilotParagraph]) -> [CopilotParagraph] {
        var kept = Array(list.suffix(maxParagraphs))
        while kept.count > 1, kept.reduce(0, { $0 + $1.text.count }) > maxCharacters { kept.removeFirst() }
        if let only = kept.first, kept.count == 1, only.text.count > maxCharacters {
            kept = [CopilotParagraph(key: only.key, blockID: only.blockID, text: String(only.text.prefix(maxCharacters)), range: only.range)]
        }
        return kept
    }
}

// MARK: - Evidence

enum CopilotEvidence {
    /// The model's quote without surrounding white space or quotation marks.
    static func normalized(_ evidence: String) -> String {
        evidence.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "“”\"「」『』'‘’")))
    }

    /// Where the quote is verbatim: inside the analysed blocks first, then
    /// anywhere in the body. Nil when it is not there.
    static func range(of evidence: String, in projection: NativeProjection, preferring blockIDs: [String]) -> NSRange? {
        let quote = normalized(evidence)
        guard !quote.isEmpty, quote.count <= 400 else { return nil }
        let text = projection.text as NSString
        let preferred = projection.blocks.filter { block in block.id.map(blockIDs.contains) ?? false }
        for block in preferred where NSMaxRange(block.range.nsRange) <= text.length {
            let found = text.range(of: quote, options: .literal, range: block.range.nsRange)
            if found.location != NSNotFound { return found }
        }
        let found = text.range(of: quote, options: .literal)
        return found.location == NSNotFound ? nil : found
    }

    /// The block holding a range's start, and its text.
    static func block(at range: NSRange, in projection: NativeProjection) -> (id: String?, text: String)? {
        let text = projection.text as NSString
        guard let block = projection.blocks.first(where: {
            range.location >= $0.range.location && range.location < NSMaxRange($0.range.nsRange)
        }), NSMaxRange(block.range.nsRange) <= text.length else { return nil }
        return (block.id, text.substring(with: block.range.nsRange))
    }
}

// MARK: - Context and prompts

/// What a run knows about the project: names to leave out, categories,
/// the author's earlier decisions and open suggestions.
struct CopilotContext {
    let library: WorkspaceElementLibrary
    let comments: [WorkspaceComment]
    let actions: [WorkspaceCommentAction]

    /// Every live element's name and aliases.
    var knownNames: [String] {
        var names: [String] = []
        for element in library.elements { names.append(element.name); names += element.aliases }
        return names.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    private var rejected: [CopilotProposal] {
        actions.filter { !$0.accepted }.compactMap { CopilotProposal(json: $0.payloadJson) }
    }

    private var open: [CopilotProposal] {
        comments.filter(\.isOpenSuggestion).compactMap { CopilotProposal($0) }
    }

    /// Names of rejected element suggestions, oldest first.
    var rejectedNames: [String] {
        rejected.compactMap { if case .element(let candidate) = $0 { return candidate.name }; return nil }
    }

    /// Rejected patch suggestions as (element, title).
    var rejectedPatches: [(elementID: String, elementName: String, title: String)] {
        rejected.compactMap { if case .patch(let candidate) = $0 { return (candidate.elementID, candidate.elementName, candidate.title) }; return nil }
    }

    /// Folded names nothing new may take: existing, rejected and open.
    var takenNames: Set<String> {
        var names = Set((knownNames + rejectedNames).map(CopilotNames.folded))
        for proposal in open { if case .element(let candidate) = proposal { names.insert(CopilotNames.folded(candidate.name)) } }
        return names
    }

    /// Open patch suggestions as folded (element, title).
    var openPatchKeys: Set<String> {
        Set(open.compactMap { if case .patch(let candidate) = $0 { return "\(candidate.elementID)\u{1F}\(CopilotNames.folded(candidate.title))" }; return nil })
    }

    /// Live elements named (or aliased) in the paragraphs, in library order.
    func mentioned(in paragraphs: [CopilotParagraph], limit: Int = 12) -> [WorkspaceElement] {
        let text = paragraphs.map(\.text).joined(separator: "\n")
        return Array(library.elements.filter { element in
            ([element.name] + element.aliases).contains { name in
                let trimmed = name.trimmingCharacters(in: .whitespaces)
                return !trimmed.isEmpty && text.contains(trimmed)
            }
        }.prefix(limit))
    }
}

enum CopilotPrompt {
    static let outputTokens = 2_048

    static let extractSystem = """
    你是小说作者的设定抽取助手（Copilot）。你只阅读作者【新写的段落】，找出其中新出现、而设定库里还没有的人物、地点和物件。
    规则：
    1. 只提出在段落中以专有名称出现的设定；代词、称谓、泛称和普通名词都不算。
    2. 不要提出【已有名称】里的任何名称或别名，也不要提出【作者拒绝过的名称】。
    3. category 从【可用分类】中选一个最合适的；都不合适或没有分类时写“未分类”。
    4. summary 是一句话，只依据段落中写明的信息，不要编造；段落没有提供信息时写空字符串。
    5. evidence 必须是段落中逐字出现的一小段原文（不超过 60 字），并包含这个名称。
    6. 宁缺毋滥；没有新设定时返回空数组。
    只输出一个 JSON 对象，不要输出任何其他文字：{"elements":[{"name":"","category":"","summary":"","evidence":""}]}
    """

    static let patchSystem = """
    你是小说作者的设定补丁助手（Copilot）。设定补丁记录一个已有设定从故事某处开始的状态变化，例如伤势、身份、关系、所在地、持有物或认知的变化。
    你只阅读作者【新写的段落】，针对【段落中提到的设定】，找出段落明确写出的状态变化。
    规则：
    1. elementId 必须是【段落中提到的设定】里某个设定的编号。
    2. title 用一句话概括变化（不超过 20 字）；body 用一两句说明变化，只依据段落内容，不要编造。
    3. 不要重复该设定【已有补丁】里的变化，也不要提出【作者拒绝过的补丁】。
    4. evidence 必须是段落中逐字出现的一小段原文（不超过 60 字），能证明这个变化。
    5. 没有明确的状态变化时返回空数组；宁缺毋滥。
    只输出一个 JSON 对象，不要输出任何其他文字：{"patches":[{"elementId":"","title":"","body":"","evidence":""}]}
    """

    private static func list(_ values: [String]) -> String { values.isEmpty ? "（无）" : values.joined(separator: "、") }

    private static func paragraphLines(_ paragraphs: [CopilotParagraph]) -> String {
        paragraphs.enumerated().map { "[\($0.offset + 1)] \($0.element.text)" }.joined(separator: "\n")
    }

    static func extract(paragraphs: [CopilotParagraph], context: CopilotContext, language: String) -> String {
        """
        【可用分类】\(list(context.library.categories.map(\.name)))
        【已有名称】\(list(context.knownNames))
        【作者拒绝过的名称】\(list(context.rejectedNames))
        【输出语言】summary 使用\(language)。
        【新写的段落】
        \(paragraphLines(paragraphs))
        """
    }

    static func patches(paragraphs: [CopilotParagraph], elements: [(element: WorkspaceElement, patches: [WorkspacePatch])],
                        context: CopilotContext, language: String) -> String {
        let categories = Dictionary(context.library.categories.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        let described = elements.map { entry -> String in
            let element = entry.element
            var line = "- 编号 \(element.id)：\(element.name)"
            var facts: [String] = []
            if !element.aliases.isEmpty { facts.append("别名：" + element.aliases.joined(separator: "、")) }
            facts.append(element.categoryId.flatMap { categories[$0] } ?? CopilotProposal.uncategorized)
            line += "（\(facts.joined(separator: "；"))）"
            if !element.summary.isEmpty { line += " 简介：\(CopilotNames.clean(element.summary, limit: 80))" }
            let titles = entry.patches.prefix(10).map { $0.title ?? CopilotNames.clean($0.body, limit: 30) }
            if !titles.isEmpty { line += "\n  已有补丁：" + titles.joined(separator: "；") }
            return line
        }.joined(separator: "\n")
        let rejected = context.rejectedPatches.map { "- \($0.elementName.isEmpty ? $0.elementID : $0.elementName)：\($0.title)" }
        return """
        【段落中提到的设定】
        \(described)
        【作者拒绝过的补丁】
        \(rejected.isEmpty ? "（无）" : rejected.joined(separator: "\n"))
        【输出语言】title 和 body 使用\(language)。
        【新写的段落】
        \(paragraphLines(paragraphs))
        """
    }

    /// The first JSON object in a reply, fences and chatter around it ignored.
    static func object(from reply: String) -> [String: Any]? {
        if let direct = AgentJSONText.object(reply.trimmingCharacters(in: .whitespacesAndNewlines)) { return direct }
        guard let start = reply.firstIndex(of: "{"), let end = reply.lastIndex(of: "}"), start < end else { return nil }
        return AgentJSONText.object(String(reply[start...end]))
    }

    static func elementCandidates(_ reply: String) -> [CopilotElementCandidate]? {
        guard let rows = object(from: reply)?["elements"] as? [[String: Any]] else { return nil }
        return rows.compactMap { row in
            let name = CopilotNames.clean((row["name"] as? String ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "《》「」『』“”\"")), limit: 40)
            let evidence = CopilotNames.clean(row["evidence"] as? String ?? "", limit: 200)
            guard !name.isEmpty, !evidence.isEmpty else { return nil }
            let category = CopilotNames.clean(row["category"] as? String ?? "", limit: 40)
            return CopilotElementCandidate(name: name, category: category.isEmpty ? CopilotProposal.uncategorized : category,
                                           summary: CopilotNames.clean(row["summary"] as? String ?? "", limit: 200), evidence: evidence)
        }
    }

    struct RawPatch { let elementID: String; let elementName: String; let title: String; let body: String; let evidence: String }

    static func patchCandidates(_ reply: String) -> [RawPatch]? {
        guard let rows = object(from: reply)?["patches"] as? [[String: Any]] else { return nil }
        return rows.compactMap { row in
            let title = CopilotNames.clean(row["title"] as? String ?? "", limit: 40)
            let body = CopilotNames.clean(row["body"] as? String ?? "", limit: 400)
            let evidence = CopilotNames.clean(row["evidence"] as? String ?? "", limit: 200)
            guard !(title.isEmpty && body.isEmpty), !evidence.isEmpty else { return nil }
            return RawPatch(elementID: CopilotNames.clean(row["elementId"] as? String ?? "", limit: 200),
                            elementName: CopilotNames.clean(row["element"] as? String ?? "", limit: 40), title: title, body: body, evidence: evidence)
        }
    }
}

/// Which replies become suggestions: new names only, existing categories
/// or 未分类, and patches that repeat nothing.
enum CopilotFilter {
    static func elements(_ candidates: [CopilotElementCandidate], context: CopilotContext) -> [CopilotElementCandidate] {
        var taken = context.takenNames
        var kept: [CopilotElementCandidate] = []
        for var candidate in candidates {
            let folded = CopilotNames.folded(candidate.name)
            guard !folded.isEmpty, !taken.contains(folded) else { continue }
            taken.insert(folded)
            candidate.category = CopilotProposal.category(named: candidate.category, in: context.library)?.name ?? CopilotProposal.uncategorized
            kept.append(candidate)
        }
        return kept
    }

    static func patches(_ raw: [CopilotPrompt.RawPatch], elements: [(element: WorkspaceElement, patches: [WorkspacePatch])],
                        context: CopilotContext) -> [CopilotPatchCandidate] {
        var seen = context.openPatchKeys
        for rejected in context.rejectedPatches { seen.insert("\(rejected.elementID)\u{1F}\(CopilotNames.folded(rejected.title))") }
        var kept: [CopilotPatchCandidate] = []
        for row in raw {
            guard let entry = elements.first(where: { $0.element.id == row.elementID })
                    ?? elements.first(where: { entry in
                        !row.elementName.isEmpty && ([entry.element.name] + entry.element.aliases).map(CopilotNames.folded)
                            .contains(CopilotNames.folded(row.elementName))
                    }) else { continue }
            let element = entry.element
            let title = CopilotNames.folded(row.title), body = CopilotNames.folded(row.body)
            let key = "\(element.id)\u{1F}\(title)"
            guard !seen.contains(key) else { continue }
            // An existing valid patch with the same title or body is not repeated.
            if entry.patches.contains(where: { patch in
                (!title.isEmpty && CopilotNames.folded(patch.title ?? "") == title) || (!body.isEmpty && CopilotNames.folded(patch.body) == body)
            }) { continue }
            seen.insert(key)
            kept.append(CopilotPatchCandidate(elementID: element.id, elementName: element.name, title: row.title, body: row.body, evidence: row.evidence))
        }
        return kept
    }
}

// MARK: - Status

enum CopilotStatus: Equatable {
    case idle
    case analyzing
    case retrying(attempt: Int, of: Int)
    case proposed(Int)
    case nothing
    /// A quiet note, e.g. nothing new to analyse.
    case note(String)
    case failed(String)
    case cancelled

    /// The quiet line beside the editor; nil hides it.
    var text: String? {
        switch self {
        case .idle: return nil
        case .analyzing: return "Copilot 正在分析…"
        case .retrying(let attempt, let total): return "Copilot 正在分析…（重试 \(attempt)/\(total)）"
        case .proposed(let count): return "Copilot 已提出 \(count) 条建议"
        case .nothing: return "Copilot 没有新建议"
        case .note(let text): return "Copilot：\(text)"
        case .failed(let message): return "Copilot 出错：\(message)"
        case .cancelled: return "Copilot 已停止：页面已关闭"
        }
    }
}

/// What the last completed run did, for the status and acceptance.
struct CopilotRunRecord: Equatable {
    let kind: CopilotBodyKind
    let bodyID: String
    let manual: Bool
    /// The paragraph texts the requests carried.
    let paragraphs: [String]
    var requests = 0
    var created: [String] = []
    /// Why each dropped proposal was dropped.
    var dropped: [String] = []
    /// Rust's refusal of the last suggestion it would not anchor.
    var refusal: String?
}

/// What a decision or a run changed in the review.
enum CopilotReviewChange {
    /// Suggestions were anchored in a body through its owner.
    case created(kind: CopilotBodyKind, bodyID: String, comments: [WorkspaceComment])
    /// 接受 or 拒绝 was recorded; every comment of the project follows.
    case decided(commentID: String, comments: [WorkspaceComment], message: String)
    /// 接受 or 拒绝 failed; the suggestion stays open with the reason.
    case failed(commentID: String, message: String)
    /// A decision started.
    case deciding(commentID: String)
}

// MARK: - Controller

/// One project's Copilot. It watches the chapter (and, when allowed,
/// drift) bodies the author edits, reads the paragraphs changed since the
/// last run after the idle delay or on request, asks the chosen provider
/// for new elements and element state changes, and anchors each proposal
/// whose evidence is in the body as a Copilot suggestion through that
/// body's owner. It never writes prose, never holds typing, runs one
/// request at a time, stops a run whose body closes, and records usage
/// beside the writing assistant's. Main thread only.
final class CopilotController {
    let projectID: String
    private let workspace: LabWorkspaceCore
    let credentials: AgentCredentialStore
    let network: AgentNetwork
    let store: AgentConversationStore
    var settings: () -> CopilotSettings = { CopilotSettings() }
    /// The manuscript's language for 跟随手稿.
    var manuscriptLocale: () -> String = { "zh-CN" }
    var retryPolicy = AgentRetryPolicy()
    var requestTimeout: TimeInterval = 120
    /// Seconds without typing before an automatic run; the settings' own
    /// unless overridden.
    var idleDelay: ((CopilotSettings) -> TimeInterval)?
    /// How often a waiting suggestion checks whether its body is idle.
    var settleInterval: TimeInterval = 0.15
    /// How long suggestions wait for typing to settle before they are dropped.
    var settleLimit: TimeInterval = 120
    /// The open owner of a chapter or drift body, for anchoring an accepted patch.
    var openStore: ((CopilotBodyKind, String) -> DocumentStore?)?
    var onStatus: ((CopilotStatus) -> Void)?
    var onWorkspaceEffect: ((AgentWorkspaceEffect) -> Void)?
    var onReviewChange: ((CopilotReviewChange) -> Void)?

    private(set) var status = CopilotStatus.idle
    private(set) var usage: [AgentUsageRecord]
    /// Why the last 接受 or 拒绝 of a suggestion failed.
    private(set) var failures: [String: String] = [:]
    private(set) var deciding: Set<String> = []
    private(set) var lastRun: CopilotRunRecord?
    var isRunning: Bool { run != nil }

    private final class Body {
        let kind: CopilotBodyKind
        let id: String
        weak var store: DocumentStore?
        var baseline: [String: String]?
        var dirty = false
        init(kind: CopilotBodyKind, id: String, store: DocumentStore) { self.kind = kind; self.id = id; self.store = store }
    }

    private struct Pending {
        let proposal: CopilotProposal
        var waited: TimeInterval = 0
        var attempts = 0
    }

    private struct Run {
        let generation: Int
        let key: String
        let snapshot: [String: String]
        var record: CopilotRunRecord
        var call: AgentHTTPCall?
        var retry: DispatchWorkItem?
        var waiter: DispatchWorkItem?
    }

    private var bodies: [String: Body] = [:]
    private var timer: DispatchWorkItem?
    private var timerKey: String?
    private var run: Run?
    private var generation = 0
    /// An automatic run came due while another was running.
    private var rerunKey: String?

    init(workspace: LabWorkspaceCore, projectID: String, credentials: AgentCredentialStore, network: AgentNetwork = AgentNetwork(),
         root: URL? = nil) {
        self.workspace = workspace
        self.projectID = projectID
        self.credentials = credentials
        self.network = network
        store = AgentConversationStore(root: root ?? workspace.agentDirectory, projectID: projectID)
        usage = store.loadCopilotUsage()
    }

    private static func key(_ kind: CopilotBodyKind, _ id: String) -> String { "\(kind.rawValue):\(id)" }

    /// 设置 › 写作助手 › 用量 lists Copilot's requests as one more row.
    static func usageConversation(projectID: String, usage: [AgentUsageRecord]) -> AgentConversation? {
        guard !usage.isEmpty else { return nil }
        var row = AgentConversation(projectID: projectID)
        row.id = "copilot"; row.title = "Copilot（实验）"; row.usage = usage
        return row
    }

    private func set(_ next: CopilotStatus) {
        status = next
        onStatus?(next)
    }

    /// Whether Copilot works in a body of this kind now.
    func allows(_ kind: CopilotBodyKind) -> Bool { settings().normalized().allows(kind) }

    /// Whether 编辑 › Copilot 分析 is offered for a body of this kind.
    func canAnalyze(_ kind: CopilotBodyKind) -> Bool {
        let settings = self.settings().normalized()
        return settings.allows(kind) && (settings.extractElements || settings.suggestPatches) && run == nil
    }

    private func body(_ kind: CopilotBodyKind, _ id: String, store: DocumentStore) -> Body {
        let key = Self.key(kind, id)
        if let body = bodies[key], body.store === store { return body }
        let body = Body(kind: kind, id: id, store: store)
        // The last authoritative text: an optimistic edit is not in it yet.
        body.baseline = (store.state?.projection).map { CopilotParagraphs.snapshot(CopilotParagraphs.paragraphs($0)) }
        bodies[key] = body
        return body
    }

    // MARK: Triggers

    /// The author edited an open chapter or drift body. With 自动触发 the
    /// idle delay starts again; nothing is read or sent while Copilot is off.
    func edited(kind: CopilotBodyKind, id: String, store: DocumentStore) {
        let settings = self.settings().normalized()
        guard settings.allows(kind) else { return }
        let body = body(kind, id, store: store)
        body.dirty = true
        guard settings.trigger == .idle else { return }
        timer?.cancel()
        let key = Self.key(kind, id)
        let work = DispatchWorkItem { [weak self] in self?.fire(key) }
        timer = work; timerKey = key
        DispatchQueue.main.asyncAfter(deadline: .now() + (idleDelay?(settings) ?? settings.idleSeconds), execute: work)
    }

    private func fire(_ key: String) {
        timer = nil; timerKey = nil
        guard let body = bodies[key], body.dirty else { return }
        guard run == nil else { rerunKey = key; return }
        _ = start(body, manual: false, selection: nil)
    }

    /// 编辑 › Copilot 分析 (⇧⌘I) or the context menu: the paragraphs changed
    /// since the last run, else those the selection touches. False when
    /// nothing started (off, a run already going, nothing to read).
    @discardableResult
    func analyze(kind: CopilotBodyKind, id: String, store: DocumentStore, selection: NSRange?) -> Bool {
        guard allows(kind), run == nil else { return false }
        let body = body(kind, id, store: store)
        if timerKey == Self.key(kind, id) { timer?.cancel(); timer = nil; timerKey = nil }
        return start(body, manual: true, selection: selection)
    }

    /// The body's last tab closed: its baseline goes, and a run reading it
    /// stops without adding anything more.
    func closed(kind: CopilotBodyKind, id: String) {
        let key = Self.key(kind, id)
        if timerKey == key { timer?.cancel(); timer = nil; timerKey = nil }
        if rerunKey == key { rerunKey = nil }
        bodies.removeValue(forKey: key)
        if run?.key == key { cancelRun(.cancelled) }
    }

    /// 设置 changed: turning Copilot (or its drift switch) off stops what it
    /// was doing; 仅手动 cancels a pending automatic run.
    func settingsChanged() {
        let settings = self.settings().normalized()
        if !settings.enabled {
            timer?.cancel(); timer = nil; timerKey = nil; rerunKey = nil
            // Re-enabling starts from the text as it is then.
            bodies.removeAll()
            cancelRun(.idle)
            if status != .idle { set(.idle) }
            return
        }
        if !settings.inDrifts {
            for (key, body) in bodies where body.kind == .drift {
                bodies.removeValue(forKey: key)
                if timerKey == key { timer?.cancel(); timer = nil; timerKey = nil }
                if run?.key == key { cancelRun(.idle) }
            }
        }
        if settings.trigger == .manual { timer?.cancel(); timer = nil; timerKey = nil; rerunKey = nil }
    }

    /// Stops everything, e.g. when the project is deleted or the window closes.
    func cancelAll() {
        timer?.cancel(); timer = nil; timerKey = nil; rerunKey = nil
        bodies.removeAll()
        cancelRun(.idle)
    }

    private func cancelRun(_ next: CopilotStatus) {
        guard let current = run else { return }
        generation += 1
        run = nil
        current.retry?.cancel(); current.waiter?.cancel()
        current.call?.cancel()
        set(next)
    }

    // MARK: Runs

    private func start(_ body: Body, manual: Bool, selection: NSRange?) -> Bool {
        let settings = self.settings().normalized()
        guard settings.allows(body.kind), run == nil else { return false }
        guard settings.extractElements || settings.suggestPatches else {
            if manual { set(.note("设定抽取和补丁建议都已关闭。")) }
            return false
        }
        guard let store = body.store, let projection = store.projection else { return false }
        let current = CopilotParagraphs.paragraphs(projection)
        var chosen = body.baseline.map { CopilotParagraphs.changed(current, since: $0) } ?? []
        if manual, chosen.isEmpty, let selection { chosen = CopilotParagraphs.covering(selection, in: current) }
        guard !chosen.isEmpty else {
            body.dirty = false
            if manual { set(.note("没有需要分析的新段落。")) }
            return false
        }
        let paragraphs = CopilotParagraphs.bounded(chosen)
        let choice = settings.choice
        let apiKey: String
        do {
            guard let stored = try credentials.key(for: choice.provider), !stored.isEmpty else {
                set(.failed("还没有设置 \(choice.provider.label) 的 API Key。请在 设置 › Copilot（实验）中管理 API Key。"))
                return false
            }
            apiKey = stored
        } catch {
            set(.failed(error.localizedDescription)); return false
        }
        generation += 1
        let run = generation
        let key = Self.key(body.kind, body.id)
        self.run = Run(generation: run, key: key, snapshot: CopilotParagraphs.snapshot(current),
                       record: CopilotRunRecord(kind: body.kind, bodyID: body.id, manual: manual, paragraphs: paragraphs.map(\.text)))
        body.dirty = false
        set(.analyzing)
        readContext(run) { [weak self] context in
            guard let self else { return }
            self.extract(run, settings: settings, apiKey: apiKey, paragraphs: paragraphs, context: context) { elements in
                self.suggestPatches(run, settings: settings, apiKey: apiKey, paragraphs: paragraphs, context: context) { patches in
                    let pending = elements.map { Pending(proposal: .element($0)) } + patches.map { Pending(proposal: .patch($0)) }
                    self.create(run, key: key, choice: choice, preferring: paragraphs.compactMap(\.blockID), pending: pending[...])
                }
            }
        }
        return true
    }

    private func current(_ run: Int) -> Bool { self.run?.generation == run }

    private func fail(_ run: Int, _ message: String) {
        guard current(run) else { return }
        self.run = nil
        set(.failed(message))
        continueDue()
    }

    private func readContext(_ run: Int, then: @escaping (CopilotContext) -> Void) {
        workspace.elementLibrary(projectID: projectID) { [weak self] library in
            guard let self, self.current(run) else { return }
            self.workspace.projectComments(projectID: self.projectID) { comments in
                guard self.current(run) else { return }
                self.workspace.suggestionActions(projectID: self.projectID) { actions in
                    guard self.current(run) else { return }
                    do {
                        then(CopilotContext(library: try library.get(), comments: try comments.get(), actions: try actions.get()))
                    } catch { self.fail(run, error.localizedDescription) }
                }
            }
        }
    }

    private func extract(_ run: Int, settings: CopilotSettings, apiKey: String, paragraphs: [CopilotParagraph], context: CopilotContext,
                         then: @escaping ([CopilotElementCandidate]) -> Void) {
        guard settings.extractElements else { then([]); return }
        let prompt = CopilotPrompt.extract(paragraphs: paragraphs, context: context,
                                           language: settings.languageInstruction(manuscriptLocale: manuscriptLocale()))
        request(run, choice: settings.choice, apiKey: apiKey, system: CopilotPrompt.extractSystem, prompt: prompt) { [weak self] text in
            guard let self else { return }
            guard let candidates = CopilotPrompt.elementCandidates(text) else {
                self.fail(run, "\(settings.choice.provider.label) 返回的设定抽取结果无法解析。"); return
            }
            then(CopilotFilter.elements(candidates, context: context))
        }
    }

    private func suggestPatches(_ run: Int, settings: CopilotSettings, apiKey: String, paragraphs: [CopilotParagraph], context: CopilotContext,
                                then: @escaping ([CopilotPatchCandidate]) -> Void) {
        let mentioned = context.mentioned(in: paragraphs)
        guard settings.suggestPatches, !mentioned.isEmpty else { then([]); return }
        var entries: [(element: WorkspaceElement, patches: [WorkspacePatch])] = []
        func read(_ remaining: ArraySlice<WorkspaceElement>) {
            guard let element = remaining.first else { ask(); return }
            workspace.elementPatches(projectID: projectID, elementID: element.id) { [weak self] result in
                guard let self, self.current(run) else { return }
                entries.append((element, ((try? result.get()) ?? []).filter { !$0.isInvalid }))
                read(remaining.dropFirst())
            }
        }
        func ask() {
            let prompt = CopilotPrompt.patches(paragraphs: paragraphs, elements: entries, context: context,
                                               language: settings.languageInstruction(manuscriptLocale: manuscriptLocale()))
            request(run, choice: settings.choice, apiKey: apiKey, system: CopilotPrompt.patchSystem, prompt: prompt) { [weak self] text in
                guard let self else { return }
                guard let raw = CopilotPrompt.patchCandidates(text) else {
                    self.fail(run, "\(settings.choice.provider.label) 返回的补丁建议无法解析。"); return
                }
                then(CopilotFilter.patches(raw, elements: entries, context: context))
            }
        }
        read(mentioned[...])
    }

    /// One complete request with the writing assistant's retry policy.
    private func request(_ run: Int, choice: AgentModelChoice, apiKey: String, system: String, prompt: String, attempt: Int = 0,
                         then: @escaping (String) -> Void) {
        guard current(run) else { return }
        let urlRequest: URLRequest
        do {
            urlRequest = try AgentDriver.completionRequest(choice: choice, apiKey: apiKey, system: system, prompt: prompt,
                                                           maxTokens: CopilotPrompt.outputTokens)
        } catch { fail(run, AgentErrors.invalid(choice.provider).message); return }
        if attempt == 0 { self.run?.record.requests += 1 }
        let call = network.complete(urlRequest, provider: choice.provider, timeout: requestTimeout) { [weak self] result in
            guard let self, self.current(run) else { return }
            self.run?.call = nil
            switch result {
            case .success(let reply):
                self.recordUsage(choice, reply.usage)
                then(reply.text)
            case .failure(let failure):
                if failure.responded { self.recordUsage(choice, nil) }
                if failure.kind != .cancelled, AgentRetryPolicy.retryable(failure), attempt < self.retryPolicy.attempts {
                    let delay = self.retryPolicy.delay(attempt: attempt + 1,
                                                       retryAfter: failure.kind == .rateLimit || failure.kind == .server ? failure.retryAfter : nil)
                    self.set(.retrying(attempt: attempt + 1, of: self.retryPolicy.attempts))
                    let work = DispatchWorkItem { [weak self] in
                        guard let self, self.current(run) else { return }
                        self.run?.retry = nil
                        self.set(.analyzing)
                        self.request(run, choice: choice, apiKey: apiKey, system: system, prompt: prompt, attempt: attempt + 1, then: then)
                    }
                    self.run?.retry = work
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
                    return
                }
                self.fail(run, failure.message)
            }
        }
        if current(run), !call.isFinished { self.run?.call = call }
    }

    private func recordUsage(_ choice: AgentModelChoice, _ reported: AgentUsage?) {
        usage.append(AgentUsageRecord(provider: choice.provider, model: choice.model, purpose: .copilot, usage: reported))
        store.saveCopilotUsage(usage)
        NotificationCenter.default.post(name: AgentChatController.usageDidChange, object: self)
    }

    /// Anchors each proposal through the body's owner once it is idle,
    /// locating its evidence in the text as it is then. Typing is never
    /// held: a suggestion waits for input to settle, then tries again.
    private func create(_ run: Int, key: String, choice: AgentModelChoice, preferring blockIDs: [String], pending: ArraySlice<Pending>) {
        guard current(run) else { return }
        guard var next = pending.first else { finish(run); return }
        guard let body = bodies[key], let store = body.store else { cancelRun(.cancelled); return }
        let rest = pending.dropFirst()
        func wait() {
            next.waited += settleInterval
            guard next.waited <= settleLimit else {
                self.run?.record.dropped.append("正文一直在输入，建议没有挂上：\(next.proposal.label)")
                create(run, key: key, choice: choice, preferring: blockIDs, pending: rest); return
            }
            let work = DispatchWorkItem { [weak self] in
                guard let self, self.current(run) else { return }
                self.run?.waiter = nil
                self.create(run, key: key, choice: choice, preferring: blockIDs, pending: ([next] + rest)[...])
            }
            self.run?.waiter = work
            DispatchQueue.main.asyncAfter(deadline: .now() + settleInterval, execute: work)
        }
        guard !store.hasPendingWork, store.canEdit, let projection = store.projection else { wait(); return }
        guard let range = CopilotEvidence.range(of: next.proposal.evidence, in: projection, preferring: blockIDs) else {
            self.run?.record.dropped.append("原文里找不到依据「\(CopilotEvidence.normalized(next.proposal.evidence))」：\(next.proposal.label)")
            create(run, key: key, choice: choice, preferring: blockIDs, pending: rest); return
        }
        let block = CopilotEvidence.block(at: range, in: projection)
        let metadata = next.proposal.metadata(provider: choice.provider, model: choice.model, blockID: block?.id, blockText: block?.text)
        let revision = projection.revision
        store.createComment(range: range, revision: revision, body: next.proposal.body, suggestion: ["metadata": metadata]) { [weak self, weak store] result in
            guard let self else { return }
            switch result {
            case .success(let comment):
                // A run stopped meanwhile keeps the row Rust already stored.
                if self.current(run) { self.run?.record.created.append(comment.id) }
                self.onReviewChange?(.created(kind: body.kind, bodyID: body.id, comments: [comment]))
                self.create(run, key: key, choice: choice, preferring: blockIDs, pending: rest)
            case .failure(let error):
                guard self.current(run) else { return }
                // Input arrived between the check and the command: try again.
                if next.attempts < 20, let store, store.hasPendingWork || store.projection?.revision != revision {
                    next.attempts += 1; wait(); return
                }
                // Rust anchors suggestions in chapters only for now.
                let reason = body.kind == .drift ? "灵感正文暂时不能挂载 Copilot 建议（核心只接受章节中的建议）。"
                                                 : error.localizedDescription
                self.run?.record.dropped.append("\(next.proposal.label)：\(reason)")
                self.run?.record.refusal = reason
                self.create(run, key: key, choice: choice, preferring: blockIDs, pending: rest)
            }
        }
    }

    private func finish(_ run: Int) {
        guard current(run), let finished = self.run else { return }
        self.run = nil
        bodies[finished.key]?.baseline = finished.snapshot
        lastRun = finished.record
        let created = finished.record.created.count
        if created > 0 { set(.proposed(created)) }
        else if let refusal = finished.record.refusal { set(.failed(refusal)) }
        else { set(.nothing) }
        continueDue()
    }

    /// An automatic run that came due during the last one starts now.
    private func continueDue() {
        guard let key = rerunKey else { return }
        rerunKey = nil
        DispatchQueue.main.async { [weak self] in self?.fire(key) }
    }

    // MARK: Review

    /// The categories 接受 may choose from when a suggestion's own category
    /// is not in the library; nil when it is (or for a patch).
    static func categoryChoices(for comment: WorkspaceComment, library: WorkspaceElementLibrary?) -> [WorkspaceElementCategory]? {
        guard case .element(let candidate)? = CopilotProposal(comment), let library,
              CopilotProposal.category(named: candidate.category, in: library) == nil else { return nil }
        return library.categories
    }

    private func decisionFailed(_ comment: WorkspaceComment, _ message: String, _ completion: ((Result<Void, Error>) -> Void)?) {
        deciding.remove(comment.id)
        failures[comment.id] = message
        onReviewChange?(.failed(commentID: comment.id, message: message))
        completion?(.failure(LabError.message(message)))
    }

    /// 接受: creates the element (in its category, or the one chosen) or the
    /// patch anchored to the evidence, then records the decision with what
    /// was created. A refused create leaves the suggestion open with Rust's
    /// reason and writes nothing.
    func accept(_ comment: WorkspaceComment, categoryID: String? = nil, completion: ((Result<Void, Error>) -> Void)? = nil) {
        guard !deciding.contains(comment.id) else { completion?(.failure(LabError.message("正在处理这条建议。"))); return }
        guard comment.isOpenSuggestion, let proposal = CopilotProposal(comment) else {
            completion?(.failure(LabError.message("这条建议已经处理过或无法识别。"))); return
        }
        deciding.insert(comment.id); failures[comment.id] = nil
        onReviewChange?(.deciding(commentID: comment.id))
        workspace.elementLibrary(projectID: projectID) { [weak self] result in
            guard let self else { return }
            let library: WorkspaceElementLibrary
            do { library = try result.get() } catch { self.decisionFailed(comment, error.localizedDescription, completion); return }
            switch proposal {
            case .element(let candidate):
                let category = categoryID.flatMap { id in library.categories.first { $0.id == id } }
                    ?? CopilotProposal.category(named: candidate.category, in: library)
                guard let category else {
                    let reason = library.categories.isEmpty ? "设定库里还没有分类。请先新建一个分类，再接受这条建议。"
                        : "设定库里没有「\(candidate.category)」分类，请选择一个分类再接受。"
                    self.decisionFailed(comment, reason, completion); return
                }
                self.workspace.createElement(projectID: self.projectID, categoryID: category.id, name: candidate.name,
                                             summary: candidate.summary.isEmpty ? nil : candidate.summary) { created in
                    switch created {
                    case .failure(let error): self.decisionFailed(comment, error.localizedDescription, completion)
                    case .success(let reply):
                        self.onWorkspaceEffect?(.elements(projectID: self.projectID, library: reply.library))
                        guard let element = reply.result else { self.decisionFailed(comment, "设定结果缺失。", completion); return }
                        self.resolve(comment, accepted: true, result: ["elementId": element.id],
                                     message: "已接受：设定「\(element.name)」已加入「\(category.name)」。", completion: completion)
                    }
                }
            case .patch(let candidate):
                guard let element = library.elements.first(where: { $0.id == candidate.elementID }) else {
                    self.decisionFailed(comment, "设定「\(candidate.elementName)」已不可用（可能已移到回收站），补丁没有创建。", completion); return
                }
                self.workspace.createPatch(projectID: self.projectID, elementID: element.id, title: PatchText.title(candidate.title),
                                           body: candidate.body, source: self.patchSource(comment, candidate)) { created in
                    switch created {
                    case .failure(let error): self.decisionFailed(comment, error.localizedDescription, completion)
                    case .success(let reply):
                        self.onWorkspaceEffect?(.patches(projectID: self.projectID, elementID: element.id))
                        guard let patch = reply.result else { self.decisionFailed(comment, "补丁结果缺失。", completion); return }
                        self.resolve(comment, accepted: true, result: ["patchId": patch.id],
                                     message: "已接受：补丁已加到设定「\(element.name)」。", completion: completion)
                    }
                }
            }
        }
    }

    /// 拒绝: recorded as the author's decision; Copilot leaves the name (or
    /// the element's change) alone afterwards.
    func reject(_ comment: WorkspaceComment, completion: ((Result<Void, Error>) -> Void)? = nil) {
        guard !deciding.contains(comment.id) else { completion?(.failure(LabError.message("正在处理这条建议。"))); return }
        guard comment.isOpenSuggestion else { completion?(.failure(LabError.message("这条建议已经处理过了。"))); return }
        deciding.insert(comment.id); failures[comment.id] = nil
        onReviewChange?(.deciding(commentID: comment.id))
        resolve(comment, accepted: false, result: nil, message: "已拒绝这条建议，Copilot 不会再提出它。", completion: completion)
    }

    private func resolve(_ comment: WorkspaceComment, accepted: Bool, result: [String: Any]?, message: String,
                         completion: ((Result<Void, Error>) -> Void)?) {
        workspace.resolveSuggestion(projectID: projectID, commentID: comment.id, accepted: accepted, result: result) { [weak self] reply in
            guard let self else { return }
            switch reply {
            case .success(let reply):
                self.deciding.remove(comment.id); self.failures[comment.id] = nil
                self.onReviewChange?(.decided(commentID: comment.id, comments: reply.comments, message: message))
                completion?(.success(()))
            case .failure(let error):
                self.decisionFailed(comment, accepted ? "已写入，但这条建议的状态没有更新：\(error.localizedDescription)"
                                                      : error.localizedDescription, completion)
            }
        }
    }

    /// The patch's source: the suggestion's live anchor in its open owner,
    /// else the block and text recorded when it was made.
    private func patchSource(_ comment: WorkspaceComment, _ candidate: CopilotPatchCandidate) -> WorkspacePatchSource? {
        guard comment.targetKind == "node", let nodeID = comment.targetId else { return nil }
        for kind in [CopilotBodyKind.chapter, .drift] {
            guard let store = openStore?(kind, nodeID), let projection = store.projection,
                  let anchor = projection.comments.first(where: { $0.id == comment.id }), anchor.anchorStatus == .anchored,
                  let range = anchor.locatableRange,
                  let source = PatchText.source(nodeID: nodeID, projection: projection, shown: projection.text, range: range.nsRange) else { continue }
            return source
        }
        let metadata = AgentJSONText.object(comment.metadataJson ?? "") ?? [:]
        let anchor = comment.selectedText.isEmpty ? CopilotEvidence.normalized(candidate.evidence) : comment.selectedText
        return WorkspacePatchSource(nodeID: nodeID, blockID: (metadata["blockId"] as? String) ?? comment.targetBlockId,
                                    blockText: metadata["blockText"] as? String, anchorText: anchor)
    }
}
