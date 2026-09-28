import Foundation

// MARK: - 作者规则

/// Standing guidance for one project: an author's preference (偏好), veto
/// (否决) or directive (指令) in self-contained words. Rules are the
/// assistant's memory, not the book: they apply at once, go into every
/// turn's system prompt and are stored beside the conversations, never in
/// SQLite, settings or the journal.
struct AgentAuthorRule: Codable, Equatable {
    enum Kind: String, Codable, CaseIterable {
        case preference, veto, directive

        var label: String {
            switch self {
            case .preference: return "偏好"
            case .veto: return "否决"
            case .directive: return "指令"
            }
        }
    }

    var id: String
    var kind: Kind
    var text: String
    /// `author` (written in the panel) or `assistant` (a rule tool).
    var source: String
    var createdAt: Date
    var updatedAt: Date

    init(kind: Kind, text: String, source: String, now: Date = Date()) {
        id = "rule-" + UUID().uuidString.lowercased()
        self.kind = kind; self.text = text; self.source = source
        createdAt = now; updatedAt = now
    }

    /// 【偏好】对话少用感叹号。
    var line: String { "【\(kind.label)】\(text)" }
}

struct AgentAuthorRulesFile: Codable {
    var version = 1
    var rules: [AgentAuthorRule]
}

enum AgentAuthorRules {
    static let limit = 40
    static let textLimit = 500

    /// One line: trimmed, inner line breaks become spaces.
    static func normalized(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{0000}", with: "")
            .components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// Why a rule text cannot be stored, or nil.
    static func refusal(_ text: String, kind: AgentAuthorRule.Kind, in rules: [AgentAuthorRule], except id: String?) -> String? {
        if text.isEmpty { return "规则内容不能为空。" }
        if text.count > textLimit { return "一条规则最多 \(textLimit) 字，这条有 \(text.count) 字。请写得更简洁。" }
        if rules.contains(where: { $0.id != id && $0.kind == kind && $0.text == text }) { return "已经有这条\(kind.label)规则。" }
        if id == nil, rules.count >= limit { return "作者规则最多 \(limit) 条。请先删除或合并不再需要的规则。" }
        return nil
    }
}

/// What a rule tool changed, kept on its tool row so the card can undo it.
struct AgentMemoryChange: Codable, Equatable {
    enum Action: String, Codable { case created, updated, deleted }

    var action: Action
    /// The rule after the change; the removed rule for `deleted`.
    var rule: AgentAuthorRule
    /// The rule before an update.
    var previous: AgentAuthorRule?
    var undone: Bool?
    /// An undo was told to the model in a later turn.
    var reported: Bool?

    /// 已记住：【偏好】…
    var headline: String {
        let prefix: String
        switch action {
        case .created: prefix = undone == true ? "已撤销记住" : "已记住"
        case .updated: prefix = undone == true ? "已撤销修改" : "已更新记忆"
        case .deleted: prefix = undone == true ? "已撤销忘记" : "已忘记"
        }
        return "\(prefix)：\(rule.line)"
    }

    /// What the model reads after the author undid it.
    var undoneOutcome: String {
        switch action {
        case .created: return "作者撤销了你刚记住的规则 \(rule.id)，它已删除：\(rule.line)"
        case .updated: return "作者撤销了你对规则 \(rule.id) 的修改，它恢复为\(previous?.line ?? rule.line)"
        case .deleted: return "作者撤销了你对规则 \(rule.id) 的删除，它仍然有效：\(rule.line)"
        }
    }
}

/// A rule or working-memory write asked for in a turn that has already
/// received an MCP tool result. External content may be steering it, so it
/// waits as a card for 允许 or 拒绝 instead of applying at once; 停止, or a
/// turn that ended first, leaves it 未执行. Kept on a notice row, never
/// sent to the model.
struct AgentMemoryApproval: Codable, Equatable {
    /// The memory tools that ask after an MCP result in the same turn.
    static let guarded: Set<String> = ["create_author_rule", "update_author_rule", "delete_author_rule", "checkpoint_working_memory"]

    var callID: String
    var tool: String
    /// 记住一条作者规则, 替换工作记忆（120 字）….
    var action: String
    /// The complete change: the rule as it would read, or the whole new note.
    var detail: String
    var state: AgentMcpInvocation.State

    var stateLabel: String {
        switch state {
        case .waiting: return "等待你的决定"
        case .allowed: return "已允许"
        case .denied: return "已拒绝"
        case .cancelled: return "未执行"
        }
    }

    /// What the call would do to the rules or the note as they are now.
    static func describe(_ call: AgentToolCall, _ a: [String: Any], rules: [AgentAuthorRule], workingMemory: String) -> (action: String, detail: String) {
        let id = (a["ruleId"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        let rule = rules.first { $0.id == id }
        let kind = (a["kind"] as? String).flatMap(AgentAuthorRule.Kind.init(rawValue:))
        let text = (a["text"] as? String).map(AgentAuthorRules.normalized)
        switch call.name {
        case "create_author_rule":
            return ("记住一条作者规则", "【\(kind?.label ?? "?")】\(text ?? "")")
        case "update_author_rule":
            guard let rule else { return ("修改作者规则 \(id)", "找不到编号为 \(id) 的规则。") }
            return ("修改作者规则 \(id)", "原来：\(rule.line)\n改为：【\((kind ?? rule.kind).label)】\(text ?? rule.text)")
        case "delete_author_rule":
            return ("忘记作者规则 \(id)", rule?.line ?? "找不到编号为 \(id) 的规则。")
        default:
            let note = AgentWorkingMemory.normalized(a["text"] as? String ?? "")
            let before = workingMemory.isEmpty ? "" : "（替换现有的 \(workingMemory.count) 字）"
            return note.isEmpty ? ("清空工作记忆", "（清空）\(before)") : ("替换工作记忆（\(note.count) 字）", note)
        }
    }
}

// MARK: - 工作记忆

/// The assistant's Markdown note for one conversation, bounded in size.
enum AgentWorkingMemory {
    static let limit = 6_000

    static func normalized(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{0000}", with: "").replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func refusal(_ text: String) -> String? {
        text.count > limit ? "工作记忆最多 \(limit) 字，这次有 \(text.count) 字。请只保留需要延续的进度、结论和下一步，精简后再保存。" : nil
    }
}

// MARK: - 长任务计划

struct AgentTaskPlan: Codable, Equatable {
    struct Step: Codable, Equatable {
        enum Status: String, Codable, CaseIterable {
            case todo, inProgress = "in_progress", done, skipped

            var label: String {
                switch self {
                case .todo: return "待办"
                case .inProgress: return "进行中"
                case .done: return "完成"
                case .skipped: return "跳过"
                }
            }

            var mark: String {
                switch self {
                case .todo: return "○"
                case .inProgress: return "◐"
                case .done: return "✓"
                case .skipped: return "–"
                }
            }
        }

        var id: String
        var title: String
        var status: Status
        var note: String?
    }

    struct Constraint: Codable, Equatable {
        var id: String
        var text: String
    }

    static let stepLimit = 40
    static let titleLimit = 200
    static let goalLimit = 500
    static let noteLimit = 500
    static let constraintLimit = 20
    static let constraintTextLimit = 300

    var goal: String
    var steps: [Step]
    var constraints: [Constraint]
    var updatedAt: Date

    var unfinished: Int { steps.filter { $0.status == .todo || $0.status == .inProgress }.count }
    var finished: Int { steps.filter { $0.status == .done || $0.status == .skipped }.count }

    /// The plan as the model reads it.
    var value: [String: Any] {
        ["goal": goal,
         "steps": steps.enumerated().map { index, step -> [String: Any] in
             var row: [String: Any] = ["step": index + 1, "title": step.title, "status": step.status.rawValue, "statusLabel": step.status.label]
             if let note = step.note, !note.isEmpty { row["note"] = note }
             return row
         },
         "constraints": constraints.map { ["constraintId": $0.id, "text": $0.text] },
         "unfinished": unfinished]
    }

    /// Lines for the system prompt.
    var promptLines: [String] {
        var lines = ["目标：\(goal)"]
        for (index, step) in steps.enumerated() {
            let note = step.note.map { $0.isEmpty ? "" : "（备注：\($0)）" } ?? ""
            lines.append("\(index + 1). [\(step.status.label)] \(step.title)\(note)")
        }
        if !constraints.isEmpty {
            lines.append("限制：")
            lines += constraints.map { "- \($0.id)：\($0.text)" }
        }
        return lines
    }
}

// MARK: - Tool definitions

extension AgentToolRegistry {
    private static let ruleKind: [String: Any] = [
        "type": "string", "enum": AgentAuthorRule.Kind.allCases.map(\.rawValue),
        "description": "偏好（preference）、否决（veto，作者明确不要的做法）或指令（directive，作者要求一直遵守的做法）。",
    ]
    private static let immediate = "立即生效，作者可以撤销；这是写作助手的记忆，不会写入作品。"

    static let memoryReads: [AgentToolDefinition] = [
        AgentToolDefinition(name: "list_author_rules",
                            description: "列出本项目的作者规则（作者长期的偏好、否决和指令）：编号、类型和内容。规则也已附在系统提示中。",
                            schema: object([:]), access: .read),
        AgentToolDefinition(name: "read_working_memory",
                            description: "读取本对话的工作记忆：写作助手为延续工作记下的 Markdown 笔记。它也已附在系统提示中。",
                            schema: object([:]), access: .read),
        AgentToolDefinition(name: "read_task_plan",
                            description: "读取本对话的任务计划：目标、按顺序的步骤（状态和备注）和限制。",
                            schema: object([:]), access: .read),
    ]

    static let memoryWrites: [AgentToolDefinition] = [
        AgentToolDefinition(name: "create_author_rule",
                            description: "记下一条作者规则：作者明确表达、希望以后一直适用的偏好、否决或指令。text 必须是不依赖上下文也能看懂的完整一句话。不要把一次性的请求记成规则。" + immediate,
                            schema: object(["kind": ruleKind, "text": text("自包含的规则内容，最多 500 字。")], required: ["kind", "text"]),
                            access: .memory),
        AgentToolDefinition(name: "update_author_rule",
                            description: "修改一条作者规则的类型或内容。只给出要改的项。" + immediate,
                            schema: object(["ruleId": text("规则编号（来自 list_author_rules 或系统提示）。"), "kind": ruleKind,
                                            "text": text("新的规则内容。")], required: ["ruleId"]),
                            access: .memory),
        AgentToolDefinition(name: "delete_author_rule",
                            description: "删除一条作者规则，只在作者明确要求忘记它时使用。" + immediate,
                            schema: object(["ruleId": text("规则编号（来自 list_author_rules 或系统提示）。")], required: ["ruleId"]),
                            access: .memory),
        AgentToolDefinition(name: "checkpoint_working_memory",
                            description: "用新的 Markdown 整体替换本对话的工作记忆，记下需要延续的进度、结论和下一步。最多 \(AgentWorkingMemory.limit) 字；空字符串表示清空。立即生效，不会写入作品。",
                            schema: object(["text": text("完整的新工作记忆（Markdown）。")], required: ["text"]),
                            access: .memory),
        AgentToolDefinition(name: "update_task_plan",
                            description: "设定或整体替换本对话的任务计划：目标和按顺序的步骤。标题不变的步骤保留原来的状态和备注，限制保持不变。用于需要多轮工具调用的长任务，立即生效。",
                            schema: object([
                                "goal": text("任务目标，最多 \(AgentTaskPlan.goalLimit) 字。"),
                                "steps": ["type": "array", "minItems": 1, "maxItems": AgentTaskPlan.stepLimit, "items": text("一个步骤的标题。"),
                                          "description": "按顺序排列的全部步骤。"],
                            ], required: ["goal", "steps"]),
                            access: .memory),
        AgentToolDefinition(name: "update_task_step",
                            description: "更新任务计划中一个步骤的状态：待办（todo）、进行中（in_progress）、完成（done）或跳过（skipped），可以附带备注。",
                            schema: object([
                                "step": ["type": "integer", "minimum": 1, "description": "步骤序号，从 1 开始。"],
                                "status": ["type": "string", "enum": AgentTaskPlan.Step.Status.allCases.map(\.rawValue), "description": "新的状态。"],
                                "note": text("可选的备注，例如完成了什么或为什么跳过；空字符串表示清除。"),
                            ], required: ["step", "status"]),
                            access: .memory),
        AgentToolDefinition(name: "update_task_constraint",
                            description: "增加、删除或替换任务计划中的一条限制（作者对这项任务的要求）。add 需要 text；remove 需要 constraintId；replace 需要 constraintId 和 text。",
                            schema: object([
                                "operation": ["type": "string", "enum": ["add", "remove", "replace"], "description": "增加、删除或替换。"],
                                "constraintId": text("限制编号（来自 read_task_plan）。"),
                                "text": text("限制内容。"),
                            ], required: ["operation"]),
                            access: .memory),
    ]
}

// MARK: - Running memory tools

/// Rule, working-memory and plan tools. They change only the assistant's
/// memory: the project's rules and the conversation's note and plan.
enum AgentMemoryTools {
    static let names: Set<String> = Set((AgentToolRegistry.memoryReads + AgentToolRegistry.memoryWrites).map(\.name))

    struct Result {
        var outcome: AgentToolOutcome
        var change: AgentMemoryChange?
        var rulesChanged = false
    }

    private static func json(_ value: Any) -> String { AgentJSONText.encode(value) }
    private static func failure(_ message: String, _ activity: String) -> Result {
        Result(outcome: .failure(message, activity: activity))
    }
    private static func success(_ value: Any, _ activity: String, change: AgentMemoryChange? = nil, rules: Bool = false) -> Result {
        Result(outcome: AgentToolOutcome(ok: true, content: json(value), activity: activity, proposal: nil), change: change, rulesChanged: rules)
    }

    static func ruleValue(_ rule: AgentAuthorRule) -> [String: Any] {
        ["ruleId": rule.id, "kind": rule.kind.rawValue, "kindLabel": rule.kind.label, "text": rule.text]
    }

    static func progress(_ name: String) -> String? {
        switch name {
        case "list_author_rules": return "正在读取作者规则…"
        case "read_working_memory": return "正在读取工作记忆…"
        case "read_task_plan": return "正在读取任务计划…"
        case "create_author_rule", "update_author_rule", "delete_author_rule": return "正在更新作者规则…"
        case "checkpoint_working_memory": return "正在更新工作记忆…"
        default: return name.hasPrefix("update_task_") ? "正在更新任务计划…" : nil
        }
    }

    /// Runs one validated call against the rules and the conversation.
    static func run(_ call: AgentToolCall, _ a: [String: Any], rules: inout [AgentAuthorRule],
                    conversation: inout AgentConversation, now: Date = Date()) -> Result {
        switch call.name {
        case "list_author_rules":
            return success(["count": rules.count, "rules": rules.map(ruleValue)], "读取作者规则（\(rules.count) 条）")

        case "create_author_rule":
            guard let kind = (a["kind"] as? String).flatMap(AgentAuthorRule.Kind.init(rawValue:)) else {
                return failure("kind 必须是 preference、veto 或 directive。", "记住规则失败")
            }
            let text = AgentAuthorRules.normalized(a["text"] as? String ?? "")
            if let refusal = AgentAuthorRules.refusal(text, kind: kind, in: rules, except: nil) { return failure(refusal, "记住规则失败") }
            let rule = AgentAuthorRule(kind: kind, text: text, source: "assistant", now: now)
            rules.append(rule)
            return success(["result": "已记住，作者可以在对话中撤销。", "rule": ruleValue(rule)], "记住\(rule.line)",
                           change: AgentMemoryChange(action: .created, rule: rule), rules: true)

        case "update_author_rule", "delete_author_rule":
            let id = (a["ruleId"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
            guard let index = rules.firstIndex(where: { $0.id == id }) else {
                return failure("找不到编号为 \(id) 的作者规则。请先用 list_author_rules 查看。", "更新作者规则失败")
            }
            let before = rules[index]
            if call.name == "delete_author_rule" {
                rules.remove(at: index)
                return success(["result": "已删除这条规则，作者可以在对话中撤销。", "rule": ruleValue(before)], "忘记\(before.line)",
                               change: AgentMemoryChange(action: .deleted, rule: before), rules: true)
            }
            var after = before
            if let raw = a["kind"] as? String, let kind = AgentAuthorRule.Kind(rawValue: raw) { after.kind = kind }
            if let raw = a["text"] as? String { after.text = AgentAuthorRules.normalized(raw) }
            guard after.kind != before.kind || after.text != before.text else {
                return failure("规则 \(id) 已经是这些内容。", "更新作者规则失败")
            }
            if let refusal = AgentAuthorRules.refusal(after.text, kind: after.kind, in: rules, except: id) { return failure(refusal, "更新作者规则失败") }
            after.updatedAt = now; after.source = "assistant"
            rules[index] = after
            return success(["result": "已更新，作者可以在对话中撤销。", "rule": ruleValue(after)], "更新\(after.line)",
                           change: AgentMemoryChange(action: .updated, rule: after, previous: before), rules: true)

        case "read_working_memory":
            let text = conversation.workingMemory
            var value: [String: Any] = ["text": text, "characters": text.count, "limit": AgentWorkingMemory.limit]
            if text.isEmpty { value["note"] = "工作记忆是空的。" }
            if let by = conversation.workingMemoryUpdatedBy { value["updatedBy"] = by == "author" ? "作者" : "写作助手" }
            return success(value, "读取工作记忆（\(text.count) 字）")

        case "checkpoint_working_memory":
            let text = AgentWorkingMemory.normalized(a["text"] as? String ?? "")
            if let refusal = AgentWorkingMemory.refusal(text) { return failure(refusal, "更新工作记忆失败") }
            guard text != conversation.workingMemory else { return failure("工作记忆已经是这些内容。", "更新工作记忆失败") }
            conversation.workingMemory = text
            conversation.workingMemoryUpdatedAt = now; conversation.workingMemoryUpdatedBy = "assistant"
            return success(["result": text.isEmpty ? "工作记忆已清空。" : "工作记忆已更新。", "characters": text.count, "limit": AgentWorkingMemory.limit],
                           text.isEmpty ? "清空工作记忆" : "更新工作记忆（\(text.count) 字）")

        case "read_task_plan":
            guard let plan = conversation.plan else { return success(["plan": NSNull(), "note": "本对话还没有任务计划。"], "读取任务计划（无）") }
            return success(["plan": plan.value], "读取任务计划（\(plan.finished)/\(plan.steps.count) 完成）")

        case "update_task_plan":
            let goal = AgentAuthorRules.normalized(a["goal"] as? String ?? "")
            guard !goal.isEmpty else { return failure("任务目标不能为空。", "更新任务计划失败") }
            guard goal.count <= AgentTaskPlan.goalLimit else { return failure("任务目标最多 \(AgentTaskPlan.goalLimit) 字。", "更新任务计划失败") }
            let titles = (a["steps"] as? [String] ?? []).map(AgentAuthorRules.normalized)
            guard !titles.isEmpty, !titles.contains(where: \.isEmpty) else { return failure("每个步骤都需要标题。", "更新任务计划失败") }
            if let long = titles.first(where: { $0.count > AgentTaskPlan.titleLimit }) {
                return failure("步骤标题最多 \(AgentTaskPlan.titleLimit) 字：“\(long.prefix(20))…”。", "更新任务计划失败")
            }
            var kept = conversation.plan?.steps ?? []
            let steps = titles.map { title -> AgentTaskPlan.Step in
                if let index = kept.firstIndex(where: { $0.title == title }) { return kept.remove(at: index) }
                return AgentTaskPlan.Step(id: "step-" + UUID().uuidString.lowercased(), title: title, status: .todo, note: nil)
            }
            let plan = AgentTaskPlan(goal: goal, steps: steps, constraints: conversation.plan?.constraints ?? [], updatedAt: now)
            conversation.plan = plan
            return success(["result": "任务计划已更新。", "plan": plan.value], "更新任务计划（\(steps.count) 步）")

        case "update_task_step":
            guard var plan = conversation.plan else { return failure("本对话还没有任务计划，请先用 update_task_plan 设定。", "更新任务步骤失败") }
            let number = (a["step"] as? NSNumber)?.intValue ?? 0
            guard number >= 1, number <= plan.steps.count else {
                return failure("任务计划只有 \(plan.steps.count) 步，没有第 \(number) 步。", "更新任务步骤失败")
            }
            guard let status = (a["status"] as? String).flatMap(AgentTaskPlan.Step.Status.init(rawValue:)) else {
                return failure("status 必须是 todo、in_progress、done 或 skipped。", "更新任务步骤失败")
            }
            var step = plan.steps[number - 1]
            step.status = status
            if let raw = a["note"] as? String {
                let note = AgentAuthorRules.normalized(raw)
                guard note.count <= AgentTaskPlan.noteLimit else { return failure("备注最多 \(AgentTaskPlan.noteLimit) 字。", "更新任务步骤失败") }
                step.note = note.isEmpty ? nil : note
            }
            plan.steps[number - 1] = step; plan.updatedAt = now
            conversation.plan = plan
            return success(["result": "第 \(number) 步已标为\(status.label)。", "plan": plan.value], "第 \(number) 步：\(status.label)")

        case "update_task_constraint":
            guard var plan = conversation.plan else { return failure("本对话还没有任务计划，请先用 update_task_plan 设定。", "更新任务限制失败") }
            let operation = a["operation"] as? String ?? ""
            let text = (a["text"] as? String).map(AgentAuthorRules.normalized)
            let id = (a["constraintId"] as? String)?.trimmingCharacters(in: .whitespaces)
            if operation == "add" || operation == "replace" {
                guard let text, !text.isEmpty else { return failure("\(operation) 需要非空的 text。", "更新任务限制失败") }
                guard text.count <= AgentTaskPlan.constraintTextLimit else {
                    return failure("一条限制最多 \(AgentTaskPlan.constraintTextLimit) 字。", "更新任务限制失败")
                }
            }
            switch operation {
            case "add":
                guard plan.constraints.count < AgentTaskPlan.constraintLimit else { return failure("一项任务最多 \(AgentTaskPlan.constraintLimit) 条限制。", "更新任务限制失败") }
                guard !plan.constraints.contains(where: { $0.text == text }) else { return failure("已经有这条限制。", "更新任务限制失败") }
                let number = (plan.constraints.compactMap { Int($0.id.dropFirst()) }.max() ?? 0) + 1
                plan.constraints.append(.init(id: "c\(number)", text: text!))
            case "remove", "replace":
                guard let id, let index = plan.constraints.firstIndex(where: { $0.id == id }) else {
                    return failure("找不到编号为 \(id ?? "") 的限制。请先用 read_task_plan 查看。", "更新任务限制失败")
                }
                if operation == "remove" { plan.constraints.remove(at: index) } else { plan.constraints[index].text = text! }
            default:
                return failure("operation 必须是 add、remove 或 replace。", "更新任务限制失败")
            }
            plan.updatedAt = now
            conversation.plan = plan
            return success(["result": "任务限制已更新。", "plan": plan.value], "更新任务限制（\(plan.constraints.count) 条）")

        default:
            return failure("没有名为 \(call.name) 的工具。", "未知工具 \(call.name)")
        }
    }

    /// Reverts a rule change, only while the rule is still as the card
    /// recorded it: a created rule is removed, an updated one returns to its
    /// previous words, a deleted one comes back within the 40-rule limit
    /// and without duplicating another rule. Returns why nothing changed.
    static func undo(_ change: AgentMemoryChange, rules: inout [AgentAuthorRule]) -> String? {
        let same = { (rule: AgentAuthorRule, recorded: AgentAuthorRule) in rule.kind == recorded.kind && rule.text == recorded.text }
        switch change.action {
        case .created:
            guard let current = rules.first(where: { $0.id == change.rule.id }) else {
                return "这条规则已经不在作者规则里了，无需撤销。"
            }
            guard same(current, change.rule) else {
                return "这条规则记下之后又被修改过（现在是\(current.line)），撤销不会删除它。需要时请在作者规则中直接删除。"
            }
            rules.removeAll { $0.id == change.rule.id }
        case .updated:
            guard let previous = change.previous else { return "这次修改没有记录原来的内容，无法撤销。" }
            guard let index = rules.firstIndex(where: { $0.id == previous.id }) else {
                return "这条规则已经被删除，撤销不会把它加回来。"
            }
            guard same(rules[index], change.rule) else {
                return "这条规则在这次修改之后又变过（现在是\(rules[index].line)），撤销不会覆盖它。"
            }
            if rules.contains(where: { $0.id != previous.id && same($0, previous) }) {
                return "已经有一条相同的规则（\(previous.line)），撤销没有进行。"
            }
            rules[index] = previous
        case .deleted:
            guard !rules.contains(where: { $0.id == change.rule.id }) else { return "这条规则已经在作者规则里了。" }
            if let duplicate = rules.first(where: { same($0, change.rule) }) {
                return "已经有一条相同的规则（\(duplicate.line)），撤销不会再加一条。"
            }
            guard rules.count < AgentAuthorRules.limit else {
                return "作者规则已有 \(AgentAuthorRules.limit) 条，恢复这条会超过上限。请先删除或合并不再需要的规则。"
            }
            rules.append(change.rule)
        }
        return nil
    }
}
