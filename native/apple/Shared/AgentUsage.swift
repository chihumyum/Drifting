import Foundation

/// One model request's token counts, kept in its conversation file. Counts
/// come only from the provider's usage fields; a count it did not report is
/// nil and shown as unknown. No prices are derived.
struct AgentUsageRecord: Codable, Equatable {
    enum Purpose: String, Codable {
        /// A turn's streamed request.
        case reply
        /// A compaction summary.
        case summary
    }

    var id: String
    var at: Date
    var provider: AgentProviderID
    var model: String
    var purpose: Purpose
    var inputTokens: Int?
    var cachedTokens: Int?
    var outputTokens: Int?

    init(provider: AgentProviderID, model: String, purpose: Purpose, usage: AgentUsage?, at: Date = Date()) {
        id = "usage-" + UUID().uuidString.lowercased()
        self.at = at; self.provider = provider; self.model = model; self.purpose = purpose
        inputTokens = usage?.inputTokens; cachedTokens = usage?.cachedTokens; outputTokens = usage?.outputTokens
    }

    /// Input and output were both reported.
    var known: Bool { inputTokens != nil && outputTokens != nil }
}

struct AgentUsageTotals: Equatable {
    var requests = 0
    /// Requests whose input or output count was not reported.
    var unknown = 0
    var inputTokens = 0
    var cachedTokens = 0
    var outputTokens = 0

    mutating func add(_ record: AgentUsageRecord) {
        requests += 1
        if !record.known { unknown += 1 }
        inputTokens += record.inputTokens ?? 0
        cachedTokens += record.cachedTokens ?? 0
        outputTokens += record.outputTokens ?? 0
    }

    private static let number: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.usesGroupingSeparator = true
        formatter.groupingSeparator = ","
        formatter.groupingSize = 3
        return formatter
    }()

    static func format(_ value: Int) -> String { number.string(from: NSNumber(value: value)) ?? String(value) }

    /// 输入 1,234（缓存 200）· 输出 56 · 3 次请求（1 次用量未知）
    var text: String {
        guard requests > 0 else { return "没有请求" }
        let unknownText = unknown > 0 ? "（\(unknown) 次用量未知）" : ""
        return "输入 \(Self.format(inputTokens))（缓存 \(Self.format(cachedTokens))）· 输出 \(Self.format(outputTokens)) · \(requests) 次请求\(unknownText)"
    }
}

/// A project's usage: today and the last 30 days (today included) by
/// provider and model, and each conversation's total.
struct AgentUsageReport: Equatable {
    struct ModelRow: Equatable {
        let provider: AgentProviderID
        let model: String
        var today = AgentUsageTotals()
        var month = AgentUsageTotals()

        /// DeepSeek · DeepSeek Flash
        var label: String {
            let option = AgentProviderCatalog.option(provider).models.first { $0.value == model }
            return "\(provider.label) · \(option?.short ?? model)"
        }
    }

    struct ConversationRow: Equatable {
        let id: String
        let title: String
        let totals: AgentUsageTotals
    }

    static let days = 30

    var today = AgentUsageTotals()
    var month = AgentUsageTotals()
    var models: [ModelRow] = []
    var conversations: [ConversationRow] = []

    init(conversations list: [AgentConversation], now: Date = Date(), calendar: Calendar = .current) {
        let startOfToday = calendar.startOfDay(for: now)
        let monthStart = calendar.date(byAdding: .day, value: -(Self.days - 1), to: startOfToday) ?? startOfToday
        var rows: [String: ModelRow] = [:]
        for conversation in list {
            var total = AgentUsageTotals()
            for record in conversation.usage {
                total.add(record)
                guard record.at >= monthStart else { continue }
                let key = "\(record.provider.rawValue)\u{1F}\(record.model)"
                var row = rows[key] ?? ModelRow(provider: record.provider, model: record.model)
                row.month.add(record); month.add(record)
                if record.at >= startOfToday { row.today.add(record); today.add(record) }
                rows[key] = row
            }
            if total.requests > 0 { conversations.append(ConversationRow(id: conversation.id, title: conversation.title, totals: total)) }
        }
        let order = AgentProviderID.allCases
        models = rows.values.sorted { a, b in
            if a.month.requests != b.month.requests { return a.month.requests > b.month.requests }
            let first = order.firstIndex(of: a.provider) ?? 0, second = order.firstIndex(of: b.provider) ?? 0
            return first != second ? first < second : a.model < b.model
        }
    }
}
