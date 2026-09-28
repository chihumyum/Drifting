import Foundation

/// A JSON value kept verbatim, e.g. a provider's reasoning replay.
enum AgentJSON: Codable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([AgentJSON])
    case object([String: AgentJSON])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([AgentJSON].self) { self = .array(value) }
        else { self = .object(try container.decode([String: AgentJSON].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// From a `JSONSerialization` value.
    init(any value: Any?) {
        switch value {
        case nil, is NSNull: self = .null
        case let number as NSNumber:
            self = CFGetTypeID(number) == CFBooleanGetTypeID() ? .bool(number.boolValue) : .number(number.doubleValue)
        case let string as String: self = .string(string)
        case let array as [Any]: self = .array(array.map { AgentJSON(any: $0) })
        case let object as [String: Any]: self = .object(object.mapValues { AgentJSON(any: $0) })
        default: self = .null
        }
    }

    /// A `JSONSerialization` value.
    var any: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let value): return value
        case .number(let value):
            if value.rounded() == value, abs(value) < 9_007_199_254_740_992 { return Int64(value) }
            return value
        case .string(let value): return value
        case .array(let value): return value.map(\.any)
        case .object(let value): return value.mapValues(\.any)
        }
    }

    var arrayValue: [AgentJSON]? { if case .array(let value) = self { return value }; return nil }
    var stringValue: String? { if case .string(let value) = self { return value }; return nil }
}

enum AgentJSONText {
    /// Compact, key-sorted UTF-8 JSON for tool results and request bodies.
    static func encode(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value) || value is String || value is NSNumber,
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed]),
              let text = String(data: data, encoding: .utf8) else { return "null" }
        return text
    }

    static func object(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}

struct AgentToolCall: Codable, Equatable {
    var id: String
    var name: String
    /// The model's raw JSON arguments, exactly as streamed.
    var arguments: String
}

/// Provider state that must go back with a tool call in the same turn:
/// DeepSeek `reasoning_content`, Anthropic thinking blocks, OpenAI output items.
struct AgentReplay: Codable, Equatable {
    var provider: AgentProviderID
    var value: AgentJSON
}

/// One request's token counts as the provider reported them. A count the
/// provider did not report stays nil (unknown); nothing is estimated.
struct AgentUsage: Codable, Equatable {
    /// Every prompt token of the request, including those served from cache.
    var inputTokens: Int?
    /// Of `inputTokens`, the ones read from the provider's prompt cache.
    var cachedTokens: Int?
    var outputTokens: Int?

    var isEmpty: Bool { inputTokens == nil && cachedTokens == nil && outputTokens == nil }
}

/// One transcript entry. `notice` rows (errors, 已停止) are never sent to a model.
struct AgentMessage: Codable, Equatable {
    enum Role: String, Codable { case user, assistant, tool, notice }

    var id: String
    var role: Role
    var turnID: String
    /// The author's words, the reply, a tool result or a notice.
    var text: String
    /// User rows: the runtime note sent before the author's words (the page
    /// the author has open and proposal outcomes). Never shown as theirs.
    var context: String?
    var thinking: String?
    var toolCalls: [AgentToolCall]?
    var replay: AgentReplay?
    var usage: AgentUsage?
    var stop: String?
    var callID: String?
    var toolName: String?
    var ok: Bool?
    /// Tool rows: the activity line, e.g. 读取《启程》.
    var activity: String?
    var proposalID: String?
    var isError: Bool?
    /// Tool rows of a rule tool: the change to 作者规则, shown as a small
    /// card with 撤销, and whether the author undid it.
    var memory: AgentMemoryChange?
    /// Notice rows marking a compaction: the model sees this summary in
    /// place of every message up to `through`.
    var compaction: AgentCompaction?
    /// A round-limit notice after which 继续 may start the next turn.
    var continuable: Bool?
    /// Notice rows asking to call an MCP tool set to 每次询问: the tool,
    /// server, arguments and the author's decision.
    var mcp: AgentMcpInvocation?
    var createdAt: Date

    init(id: String = UUID().uuidString, role: Role, turnID: String, text: String, createdAt: Date = Date()) {
        self.id = id; self.role = role; self.turnID = turnID; self.text = text; self.createdAt = createdAt
    }
}

struct AgentProseChange: Codable, Equatable {
    var currentText: String
    var revisedText: String
    var allOccurrences: Bool
    /// `revisedText` becomes new paragraphs at the end of the body;
    /// `currentText` is empty. Rust allows one append per call, alone.
    var append: Bool

    init(currentText: String, revisedText: String, allOccurrences: Bool = false, append: Bool = false) {
        self.currentText = currentText; self.revisedText = revisedText
        self.allOccurrences = allOccurrences; self.append = append
    }

    static func appending(_ text: String) -> AgentProseChange { AgentProseChange(currentText: "", revisedText: text, append: true) }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        currentText = try container.decode(String.self, forKey: .currentText)
        revisedText = try container.decode(String.self, forKey: .revisedText)
        allOccurrences = try container.decodeIfPresent(Bool.self, forKey: .allOccurrences) ?? false
        append = try container.decodeIfPresent(Bool.self, forKey: .append) ?? false
    }

    var payload: [String: Any] {
        var payload: [String: Any] = ["currentText": currentText, "revisedText": revisedText, "allOccurrences": allOccurrences]
        if append { payload["append"] = true }
        return payload
    }
}

/// One field a domain proposal changes, as its card shows it: the value
/// before (nil when the proposal creates it) and after (empty clears it).
struct AgentFieldChange: Codable, Equatable {
    var label: String
    var before: String?
    var after: String
}

/// A write the model proposed. Nothing is written until the author accepts.
struct AgentProposal: Codable, Equatable {
    /// `domain` is a metadata write (elements, patches, storylines,
    /// relations, notes and TODOs, chapters, drifts, project details) that
    /// `tool` names and `arguments` carries, with resolved identities.
    enum Kind: String, Codable { case revise, append, createChapter, chapterSummary, domain }
    enum State: String, Codable { case pending, applying, accepted, rejected, failed }

    /// The tool call's identity: `callId` of the Agent provenance.
    var id: String
    var turnID: String
    var tool: String
    var kind: Kind
    /// `chapter`, `element` or `drift` for a revision; `chapter` for a summary.
    var targetKind: String?
    var targetID: String?
    var targetTitle: String
    var changes: [AgentProseChange]
    var summary: String?
    var previousSummary: String?
    /// A new chapter's opening text, appended after it is created.
    var initialText: String?
    /// Accepted, but only in part: a new chapter whose text was not written.
    var partial: Bool?
    var state: State
    /// The outcome: how much was applied, or why it failed.
    var message: String?
    /// The outcome was sent to the model in a later turn.
    var reported: Bool
    var createdAt: Date
    var decidedAt: Date?
    /// A domain proposal's headline, e.g. 新建设定「林岚」.
    var label: String?
    /// A domain proposal's explanation on its card, e.g. what trash means.
    var note: String?
    /// What a domain proposal changes, field by field.
    var fields: [AgentFieldChange]?
    /// The resolved arguments an accepted domain proposal applies.
    var arguments: [String: AgentJSON]?

    var kindName: String {
        switch targetKind {
        case "element": return "设定"
        case "category": return "分类"
        case "drift": return "漂流"
        case "storyline": return "故事线"
        default: return "章节"
        }
    }

    /// 修改《启程》, 新建章节《归岸》, 修改《启程》的摘要.
    var headline: String {
        switch kind {
        case .revise: return targetKind == "chapter" ? "修改《\(targetTitle)》" : "修改\(kindName)「\(targetTitle)」"
        case .append: return targetKind == "chapter" ? "续写《\(targetTitle)》" : "续写\(kindName)「\(targetTitle)」"
        case .createChapter: return "新建章节《\(targetTitle)》"
        case .chapterSummary: return "修改《\(targetTitle)》的摘要"
        case .domain: return label ?? tool
        }
    }

    var stateLabel: String {
        switch state {
        case .pending: return "等待你的决定"
        case .applying: return "正在应用…"
        case .accepted: return partial == true ? (kind == .domain ? "已接受 · 部分未写入" : "已接受 · 正文未写入") : "已接受"
        case .rejected: return "已拒绝"
        case .failed: return "应用失败"
        }
    }

    /// What the model reads about this proposal in the author's next turn.
    var outcome: String? {
        switch state {
        case .pending, .applying: return nil
        case .accepted: return "提案 \(id)（\(tool) · \(headline)）：作者已接受。\(message ?? "")"
        case .rejected: return "提案 \(id)（\(tool) · \(headline)）：作者已拒绝，内容未改变。"
        case .failed: return "提案 \(id)（\(tool) · \(headline)）：应用失败：\(message ?? "未知原因")。内容未改变。"
        }
    }
}

struct AgentConversation: Codable, Equatable {
    static let defaultTitle = "新对话"

    var id: String
    var projectID: String
    var title: String
    var createdAt: Date
    var updatedAt: Date
    var choice: AgentModelChoice
    var messages: [AgentMessage]
    var proposals: [AgentProposal]
    /// 工作记忆: the assistant's Markdown note for this conversation.
    var workingMemory: String
    var workingMemoryUpdatedAt: Date?
    /// `assistant` or `author`.
    var workingMemoryUpdatedBy: String?
    /// 长任务计划: goal, ordered steps and constraints.
    var plan: AgentTaskPlan?
    /// Each model request's reported token counts.
    var usage: [AgentUsageRecord]

    init(projectID: String, choice: AgentModelChoice = .standard) {
        id = "agent-" + UUID().uuidString.lowercased()
        self.projectID = projectID
        title = Self.defaultTitle
        createdAt = Date(); updatedAt = createdAt
        self.choice = choice
        messages = []; proposals = []
        workingMemory = ""; usage = []
    }

    /// Files written before memory, plans and usage existed read as empty.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        projectID = try container.decode(String.self, forKey: .projectID)
        title = try container.decode(String.self, forKey: .title)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
        choice = try container.decode(AgentModelChoice.self, forKey: .choice)
        messages = try container.decode([AgentMessage].self, forKey: .messages)
        proposals = try container.decode([AgentProposal].self, forKey: .proposals)
        workingMemory = try container.decodeIfPresent(String.self, forKey: .workingMemory) ?? ""
        workingMemoryUpdatedAt = try container.decodeIfPresent(Date.self, forKey: .workingMemoryUpdatedAt)
        workingMemoryUpdatedBy = try container.decodeIfPresent(String.self, forKey: .workingMemoryUpdatedBy)
        plan = try container.decodeIfPresent(AgentTaskPlan.self, forKey: .plan)
        usage = try container.decodeIfPresent([AgentUsageRecord].self, forKey: .usage) ?? []
    }

    func proposal(_ id: String) -> AgentProposal? { proposals.first { $0.id == id } }
}

/// Conversations of one project as JSON files under the lab's data directory:
/// `<data>/agent/<projectId>/<conversationId>.json`, written atomically (a
/// temporary file renamed over the old one) on one serial queue shared by
/// every store. The project's 作者规则 live beside them in
/// `author-rules.json`. A deleted project's folder is removed on that queue,
/// after the writes already queued, and later writes to it are dropped.
final class AgentConversationStore {
    static let rulesFile = "author-rules.json"
    let directory: URL
    private static let queue = DispatchQueue(label: "cc.drifting.native-lab.agent-store")
    /// Folders of deleted projects; read and written only on `queue`.
    private static var removed: Set<String> = []
    private var queue: DispatchQueue { Self.queue }

    /// `root` is the `agent` folder beside the lab workspace directory.
    init(root: URL, projectID: String) {
        directory = Self.directory(root: root, projectID: projectID)
    }

    private static func directory(root: URL, projectID: String) -> URL {
        let safe = projectID.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) || "-_".unicodeScalars.contains($0) ? String($0) : "_" }.joined()
        return root.appendingPathComponent(safe.isEmpty ? "_" : safe, isDirectory: true)
    }

    /// The project was deleted: its folder (conversations with their memory,
    /// plans and usage, and 作者规则) goes after every write already queued,
    /// and no later save of any store recreates it.
    static func removeProject(root: URL, projectID: String) {
        let directory = directory(root: root, projectID: projectID)
        queue.async {
            removed.insert(directory.standardizedFileURL.path)
            try? FileManager.default.removeItem(at: directory)
        }
    }

    /// ISO 8601 with milliseconds, so the list keeps its order after a reload.
    private static let dates: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(dates.string(from: date))
        }
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }

    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            guard let date = dates.date(from: text) ?? ISO8601DateFormatter().date(from: text) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid date")
            }
            return date
        }
        return decoder
    }

    /// Every readable conversation, newest first. A proposal that was being
    /// applied when the app stopped is offered again.
    func load() -> [AgentConversation] {
        queue.sync {
            guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return [] }
            let decoder = Self.decoder()
            return files.filter { $0.pathExtension == "json" && $0.lastPathComponent.hasPrefix("agent-") }.compactMap { url -> AgentConversation? in
                guard let data = try? Data(contentsOf: url), var conversation = try? decoder.decode(AgentConversation.self, from: data) else { return nil }
                for index in conversation.proposals.indices where conversation.proposals[index].state == .applying {
                    conversation.proposals[index].state = .pending
                }
                // An MCP call still waiting when the app stopped was never made.
                for index in conversation.messages.indices where conversation.messages[index].mcp?.state == .waiting {
                    conversation.messages[index].mcp?.state = .cancelled
                }
                return conversation
            }.sorted { $0.updatedAt > $1.updatedAt }
        }
    }

    func save(_ conversation: AgentConversation) {
        let data: Data
        do { data = try Self.encoder().encode(conversation) } catch { return }
        write(data, name: "\(conversation.id).json")
    }

    /// A temporary file renamed over the target, on the serial queue.
    private func write(_ data: Data, name: String) {
        let directory = self.directory
        queue.async {
            guard !Self.removed.contains(directory.standardizedFileURL.path) else { return }
            let target = directory.appendingPathComponent(name)
            let temporary = directory.appendingPathComponent(".\(name).\(UUID().uuidString).tmp")
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try data.write(to: temporary, options: [.withoutOverwriting])
                guard rename(temporary.path, target.path) == 0 else { throw LabError.message("rename failed") }
            } catch {
                try? FileManager.default.removeItem(at: temporary)
            }
        }
    }

    /// The project's 作者规则 as read: oldest first and none when the file is
    /// missing, or why a file that exists could not be read. An unreadable
    /// file is never treated as empty, so nothing overwrites it.
    enum RulesRead: Equatable {
        case rules([AgentAuthorRule])
        case unreadable(String)
    }

    func loadRules() -> RulesRead {
        queue.sync {
            let url = directory.appendingPathComponent(Self.rulesFile)
            guard FileManager.default.fileExists(atPath: url.path) else { return .rules([]) }
            guard let data = try? Data(contentsOf: url) else { return .unreadable("无法打开 \(Self.rulesFile)") }
            do {
                let file = try Self.decoder().decode(AgentAuthorRulesFile.self, from: data)
                return .rules(file.rules)
            } catch {
                return .unreadable("\(Self.rulesFile) 的内容无法解析")
            }
        }
    }

    /// 重置 of unreadable rules: the file is renamed
    /// `author-rules.unreadable-<yyyyMMdd-HHmmss>.json` beside it, after
    /// every queued write. Returns the new name.
    func setAsideRules(now: Date = Date()) throws -> String {
        try queue.sync {
            let source = directory.appendingPathComponent(Self.rulesFile)
            guard FileManager.default.fileExists(atPath: source.path) else { return "" }
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "yyyyMMdd-HHmmss"
            let stamp = formatter.string(from: now)
            var name = "author-rules.unreadable-\(stamp).json", number = 1
            while FileManager.default.fileExists(atPath: directory.appendingPathComponent(name).path) {
                number += 1
                name = "author-rules.unreadable-\(stamp)-\(number).json"
            }
            do {
                try FileManager.default.moveItem(at: source, to: directory.appendingPathComponent(name))
            } catch {
                throw LabError.message("无法把无法读取的作者规则文件移到一旁：\(error.localizedDescription)")
            }
            return name
        }
    }

    func saveRules(_ rules: [AgentAuthorRule]) {
        guard let data = try? Self.encoder().encode(AgentAuthorRulesFile(rules: rules)) else { return }
        write(data, name: Self.rulesFile)
    }

    /// Copilot's own token usage in this project, oldest first; none when
    /// the file is missing. It is not a conversation and never lists as one.
    static let copilotUsageFile = "copilot-usage.json"

    func loadCopilotUsage() -> [AgentUsageRecord] {
        queue.sync {
            guard let data = try? Data(contentsOf: directory.appendingPathComponent(Self.copilotUsageFile)),
                  let file = try? Self.decoder().decode(CopilotUsageFile.self, from: data) else { return [] }
            return file.usage
        }
    }

    func saveCopilotUsage(_ usage: [AgentUsageRecord]) {
        guard let data = try? Self.encoder().encode(CopilotUsageFile(usage: usage)) else { return }
        write(data, name: Self.copilotUsageFile)
    }

    func delete(_ id: String) {
        let target = directory.appendingPathComponent("\(id).json")
        queue.async { try? FileManager.default.removeItem(at: target) }
    }

    /// Waits for every queued write.
    func flush() { queue.sync {} }
}
