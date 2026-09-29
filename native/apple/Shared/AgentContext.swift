import Foundation

/// How large a request is before it is sent: the provider's serialized body
/// (system prompt, history and tool definitions) counted with a deliberately
/// conservative per-provider ratio. It is an estimate for deciding when to
/// compact, never a usage record.
enum AgentContextBudget {
    /// Compaction starts above this share of the model's context window.
    static let threshold = 0.7

    /// Characters per token for text outside CJK scripts, and tokens per CJK
    /// character, rounded towards more tokens.
    private static func ratios(_ provider: AgentProviderID) -> (latin: Double, cjk: Double) {
        switch provider {
        case .deepseek: return (3.2, 1.0)
        case .anthropic: return (3.0, 1.2)
        case .openai: return (3.4, 1.0)
        }
    }

    static func tokens(_ text: String, provider: AgentProviderID) -> Int {
        var cjk = 0, other = 0
        for scalar in text.unicodeScalars {
            if scalar.value >= 0x2E80 { cjk += 1 } else { other += 1 }
        }
        let ratio = ratios(provider)
        return Int((Double(cjk) * ratio.cjk + Double(other) / ratio.latin).rounded(.up))
    }

    /// The estimated input tokens of the request as it would be sent.
    static func estimate(_ request: AgentModelRequest) -> Int {
        guard let body = try? AgentDriver.urlRequest(request).httpBody, let text = String(data: body, encoding: .utf8) else { return 0 }
        return tokens(text, provider: request.choice.provider)
    }

    static func limit(window: Int) -> Int { Int(Double(window) * threshold) }
}

/// What the context indicator shows for a conversation: the tokens the
/// model read and wrote at its latest request (the provider's own usage
/// report, input including cached tokens plus output), against the window
/// compaction counts with, and the compaction threshold. Before any report,
/// or once a compaction replaced the history that report covered, the
/// next request's estimate stands in, marked as such.
struct AgentContextUsage: Equatable {
    /// The window compaction counts against.
    let window: Int
    /// Older turns are compacted above this many estimated input tokens.
    let threshold: Int
    /// Reported input and output of the latest request, or the estimate.
    let used: Int
    let reported: Bool
    let input: Int?
    let cached: Int?
    let output: Int?
    /// The next request's estimated input tokens, as compaction counts it.
    let estimate: Int?
    let compactions: Int

    var fraction: Double { window > 0 ? min(1, Double(used) / Double(window)) : 0 }

    /// 12.3% or 0.4%, one decimal below 10%.
    var percentText: String {
        let percent = fraction * 100
        return percent < 10 ? String(format: "%.1f%%", percent) : "\(Int(percent.rounded()))%"
    }

    /// 上下文 1,234 / 200,000（0.6%）, or 约 … before a usage report.
    var text: String {
        let used = AgentUsageTotals.format(self.used), window = AgentUsageTotals.format(self.window)
        return "上下文 \(reported ? "" : "约 ")\(used) / \(window)（\(percentText)）"
    }

    /// The detail lines shown on demand.
    var detail: [String] {
        var lines: [String] = []
        if reported {
            let cachedText = cached.map { "（缓存 \(AgentUsageTotals.format($0))）" } ?? ""
            lines.append("最近一次请求：输入 \(input.map(AgentUsageTotals.format) ?? "未知")\(cachedText) · 输出 \(output.map(AgentUsageTotals.format) ?? "未知")，由模型服务报告")
        } else {
            lines.append("还没有模型服务报告的用量，显示的是按压缩规则估算的下一次请求。")
        }
        if let estimate { lines.append("下一次请求估算：约 \(AgentUsageTotals.format(estimate)) tokens") }
        lines.append("上下文窗口 \(AgentUsageTotals.format(window)) tokens；估算超过 \(AgentUsageTotals.format(threshold))（70%）时压缩较早的对话")
        lines.append(compactions > 0 ? "本对话已压缩 \(compactions) 次" : "本对话还没有压缩过")
        return lines
    }

    /// The latest request's report after the last compaction, else the estimate.
    static func of(_ conversation: AgentConversation, window: Int, estimate: Int?) -> AgentContextUsage {
        let marker = conversation.messages.lastIndex { $0.compaction != nil }
        let compactions = conversation.messages.filter { $0.compaction != nil }.count
        let latest = conversation.messages.indices.last { index in
            conversation.messages[index].role == .assistant && conversation.messages[index].usage?.inputTokens != nil
                && (marker.map { index > $0 } ?? true)
        }.flatMap { conversation.messages[$0].usage }
        let threshold = AgentContextBudget.limit(window: window)
        if let latest, let input = latest.inputTokens {
            return AgentContextUsage(window: window, threshold: threshold, used: input + (latest.outputTokens ?? 0), reported: true,
                                     input: input, cached: latest.cachedTokens, output: latest.outputTokens, estimate: estimate,
                                     compactions: compactions)
        }
        return AgentContextUsage(window: window, threshold: threshold, used: estimate ?? 0, reported: false, input: nil, cached: nil,
                                 output: nil, estimate: estimate, compactions: compactions)
    }
}

/// A compaction the conversation records at the point it happened: the
/// model reads `summary` in place of every message up to `through`.
struct AgentCompaction: Codable, Equatable {
    enum Method: String, Codable {
        /// Summarised by the conversation's provider.
        case summary
        /// The summary failed; older turns were trimmed by rule.
        case trim
    }

    /// The last message it covers.
    var through: String
    var summary: String
    var method: Method
    /// How many transcript messages it covers.
    var messages: Int
}

/// Older turns become one structured summary; the last `keepTurns` turns
/// (the current one included) stay verbatim. Proposals, rules, working
/// memory and the plan live outside the transcript and are never lost:
/// every summary ends with the app's own list of proposals and outcomes.
enum AgentCompactor {
    static let keepTurns = 2
    static let transcriptLimit = 120_000
    static let summaryLimit = 8_000
    static let summaryHeading = "【较早对话的摘要】以下是此前对话的整理，较早的原文已不在上下文中。"

    struct Plan {
        /// The last message the compaction covers.
        let through: String
        /// Messages summarised, including an earlier summary's.
        let count: Int
        let previousSummary: String?
        let transcript: String
        let requests: [String]
    }

    private static func clip(_ text: String, _ limit: Int) -> String {
        text.count > limit ? String(text.prefix(limit)) + "…（已截断）" : text
    }

    /// What to compact, or nil when every remaining turn is recent.
    static func plan(_ messages: [AgentMessage], keepTurns: Int = keepTurns) -> Plan? {
        let marker = messages.lastIndex { $0.compaction != nil }
        let previous = marker.flatMap { messages[$0].compaction }
        let start = previous.flatMap { compaction in messages.firstIndex { $0.id == compaction.through }.map { $0 + 1 } } ?? 0
        // A 补充 belongs to the turn it was added to; only the author's
        // turn-starting messages split the history.
        let turns = messages.indices.filter { $0 >= start && messages[$0].role == .user && messages[$0].steer != true }
        guard turns.count > keepTurns else { return nil }
        let split = turns[turns.count - keepTurns]
        let covered = messages[start..<split].filter { $0.compaction == nil && $0.role != .notice }
        guard !covered.isEmpty, split > 0 else { return nil }
        var lines: [String] = []
        var requests: [String] = []
        for message in covered {
            switch message.role {
            case .user:
                if let context = message.context, !context.isEmpty { lines.append("（应用附加：\(clip(context, 1_500))）") }
                lines.append("作者：\(clip(message.text, 4_000))")
                requests.append(clip(message.text, 200))
            case .assistant:
                if !message.text.isEmpty { lines.append("写作助手：\(clip(message.text, 4_000))") }
                for call in message.toolCalls ?? [] { lines.append("写作助手调用 \(call.name)：\(clip(call.arguments, 600))") }
            case .tool:
                lines.append("工具 \(message.toolName ?? "") 的结果\(message.ok == false ? "（失败）" : "")：\(clip(message.text, 1_500))")
            case .notice:
                break
            }
        }
        var transcript = lines.joined(separator: "\n")
        if transcript.count > transcriptLimit { transcript = "…（更早的部分已截断）\n" + String(transcript.suffix(transcriptLimit)) }
        return Plan(through: messages[split - 1].id, count: covered.count + (previous?.messages ?? 0),
                    previousSummary: previous?.summary, transcript: transcript, requests: requests)
    }

    static let summarySystem = """
        你负责为 Drifting 写作助手整理较早的对话，让它在上下文变短后继续工作。只根据给出的对话内容写，不要编造。用中文输出 Markdown，依次包含以下小标题，没有内容的写“无”：
        ## 目标
        作者想完成的事和仍然有效的要求。
        ## 已做的决定
        作者和写作助手已经确定的内容与改动方向。
        ## 待处理的提案
        仍在等待作者决定的修改提案（提案编号和内容），以及已知的处理结果。
        ## 已了解的事实
        从作品中读到、后面还会用到的事实（人物、情节、设定、章节位置等）。
        总长度不超过 3000 字。
        """

    static func prompt(_ plan: Plan) -> String {
        var parts: [String] = []
        if let previous = plan.previousSummary { parts.append("此前的摘要：\n\(previous)") }
        parts.append("需要整理的对话：\n\(plan.transcript)")
        parts.append("请按要求的小标题输出摘要。")
        return parts.joined(separator: "\n\n")
    }

    /// The app's own record of every proposal, so none is lost to a summary.
    static func proposals(_ proposals: [AgentProposal]) -> String {
        guard !proposals.isEmpty else { return "## 修改提案（应用记录）\n无" }
        let lines = proposals.suffix(60).map { proposal -> String in
            let state: String
            switch proposal.state {
            case .pending, .applying: state = "等待作者决定"
            case .accepted: state = proposal.partial == true ? "已接受（部分未写入）" : "已接受"
            case .rejected: state = "已拒绝"
            case .failed: state = "应用失败：\(proposal.message ?? "")"
            }
            return "- 提案 \(proposal.id)（\(proposal.tool) · \(proposal.headline)）：\(state)"
        }
        return "## 修改提案（应用记录）\n" + lines.joined(separator: "\n")
    }

    /// The provider's summary with the proposal record appended.
    static func summarized(_ text: String, proposals list: [AgentProposal]) -> String {
        clip(text.trimmingCharacters(in: .whitespacesAndNewlines), summaryLimit) + "\n\n" + proposals(list)
    }

    /// The deterministic fallback: the earlier summary, the author's requests
    /// and the proposal record. The system prompt still carries the rules,
    /// working memory and plan, and recent turns stay verbatim.
    static func trimmed(_ plan: Plan, proposals list: [AgentProposal]) -> String {
        var parts = ["（较早的对话因长度被裁剪，没有生成摘要；以下是应用按规则保留的要点。）"]
        if let previous = plan.previousSummary { parts.append("## 更早的摘要\n" + clip(previous, 4_000)) }
        let requests = plan.requests.suffix(12)
        parts.append("## 作者较早的请求\n" + (requests.isEmpty ? "无" : requests.map { "- \($0)" }.joined(separator: "\n")))
        parts.append(proposals(list))
        return parts.joined(separator: "\n\n")
    }
}
