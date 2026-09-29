import Foundation

/// The native writing Agent's providers and models. The catalog mirrors the
/// renderer's `agent-provider-contract.ts` (DeepSeek, Anthropic, OpenAI with
/// their thinking and effort options). The ChatGPT-subscription route
/// (`openai-codex`) needs OAuth and is not ported.
enum AgentProviderID: String, Codable, CaseIterable {
    case deepseek, anthropic, openai

    var label: String {
        switch self {
        case .deepseek: return "DeepSeek"
        case .anthropic: return "Anthropic"
        case .openai: return "OpenAI"
        }
    }
}

enum AgentThinking: String, Codable, CaseIterable {
    case off, adaptive

    var label: String { self == .off ? "不思考" : "自适应思考" }
}

enum AgentEffort: String, Codable, CaseIterable {
    case low, medium, high, xhigh, max

    var label: String {
        switch self {
        case .low: return "低"
        case .medium: return "中"
        case .high: return "高"
        case .xhigh: return "很高"
        case .max: return "最高"
        }
    }
}

struct AgentReasoningProfile: Equatable {
    let thinkingModes: [AgentThinking]
    let efforts: [AgentEffort]
    let defaultThinking: AgentThinking
    let defaultEffort: AgentEffort

    static let adaptive = AgentReasoningProfile(thinkingModes: [.off, .adaptive], efforts: [.low, .medium, .high, .xhigh, .max],
                                                defaultThinking: .off, defaultEffort: .high)
    static let deepseek = AgentReasoningProfile(thinkingModes: [.off, .adaptive], efforts: [.high, .max],
                                                defaultThinking: .off, defaultEffort: .high)
    static let none = AgentReasoningProfile(thinkingModes: [.off], efforts: [], defaultThinking: .off, defaultEffort: .high)
}

struct AgentModelOption: Equatable {
    let value: String
    let label: String
    let short: String
    let contextWindowTokens: Int
    /// The per-request output ceiling this client sends.
    let maxOutputTokens: Int
    let reasoning: AgentReasoningProfile
}

struct AgentProviderOption: Equatable {
    let id: AgentProviderID
    let models: [AgentModelOption]
}

enum AgentProviderCatalog {
    static let defaultProvider = AgentProviderID.deepseek

    static let providers: [AgentProviderOption] = [
        AgentProviderOption(id: .deepseek, models: [
            AgentModelOption(value: "deepseek-v4-flash", label: "DeepSeek Flash · 快速", short: "DeepSeek Flash",
                             contextWindowTokens: 200_000, maxOutputTokens: 8_192, reasoning: .deepseek),
            AgentModelOption(value: "deepseek-v4-pro", label: "DeepSeek Pro · 稳健", short: "DeepSeek Pro",
                             contextWindowTokens: 200_000, maxOutputTokens: 8_192, reasoning: .deepseek),
        ]),
        AgentProviderOption(id: .anthropic, models: [
            AgentModelOption(value: "claude-sonnet-5", label: "Claude Sonnet 5 · 均衡", short: "Sonnet 5",
                             contextWindowTokens: 1_000_000, maxOutputTokens: 32_000, reasoning: .adaptive),
            AgentModelOption(value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 · 快速", short: "Haiku 4.5",
                             contextWindowTokens: 200_000, maxOutputTokens: 32_000, reasoning: .none),
        ]),
        AgentProviderOption(id: .openai, models: [
            AgentModelOption(value: "gpt-5.6-sol", label: "GPT-5.6 Sol · 前沿", short: "5.6 Sol",
                             contextWindowTokens: 1_050_000, maxOutputTokens: 32_000, reasoning: .adaptive),
            AgentModelOption(value: "gpt-5.6-terra", label: "GPT-5.6 Terra · 均衡", short: "5.6 Terra",
                             contextWindowTokens: 1_050_000, maxOutputTokens: 32_000, reasoning: .adaptive),
            AgentModelOption(value: "gpt-5.6-luna", label: "GPT-5.6 Luna · 高效", short: "5.6 Luna",
                             contextWindowTokens: 1_050_000, maxOutputTokens: 32_000, reasoning: .adaptive),
        ]),
    ]

    static func option(_ provider: AgentProviderID) -> AgentProviderOption {
        providers.first { $0.id == provider } ?? providers[0]
    }

    static func model(_ provider: AgentProviderID, _ value: String) -> AgentModelOption {
        let option = option(provider)
        return option.models.first { $0.value == value } ?? option.models[0]
    }
}

/// A conversation's provider, model, thinking mode and effort, and whether
/// it uses the model's full 1M context (Max · 1M 上下文). Values are
/// normalized against the catalog, as the renderer's `normalizeAgentProvider*`.
struct AgentModelChoice: Codable, Equatable {
    /// The standard window, as the renderer's planner: a larger declared
    /// window is used only with Max · 1M 上下文.
    static let standardContextWindow = 200_000
    static let maxContextWindow = 1_000_000

    var provider: AgentProviderID
    var model: String
    var thinking: AgentThinking
    var effort: AgentEffort
    /// Max · 1M 上下文: the model's declared window (up to about 1M tokens)
    /// instead of the 200k standard window. Only models that declare 1M
    /// offer it; it changes when older turns are compacted, nothing sent.
    var maxContext = false

    static var standard: AgentModelChoice {
        let model = AgentProviderCatalog.option(AgentProviderCatalog.defaultProvider).models[0]
        return AgentModelChoice(provider: AgentProviderCatalog.defaultProvider, model: model.value,
                                thinking: model.reasoning.defaultThinking, effort: model.reasoning.defaultEffort)
    }

    var option: AgentModelOption { AgentProviderCatalog.model(provider, model) }

    func normalized() -> AgentModelChoice {
        let model = AgentProviderCatalog.model(provider, self.model)
        let reasoning = model.reasoning
        return AgentModelChoice(provider: provider, model: model.value,
            thinking: reasoning.thinkingModes.contains(thinking) ? thinking : reasoning.defaultThinking,
            effort: reasoning.efforts.contains(effort) ? effort : reasoning.defaultEffort,
            maxContext: maxContext && Self.offersMaxContext(model))
    }

    /// Whether a model declares a window of about 1M tokens.
    static func offersMaxContext(_ model: AgentModelOption) -> Bool { model.contextWindowTokens >= maxContextWindow }
    var offersMaxContext: Bool { Self.offersMaxContext(option) }

    /// The window compaction and the context indicator count against: the
    /// declared one with Max · 1M 上下文, else at most the standard 200k.
    var contextWindow: Int {
        let declared = option.contextWindowTokens
        return normalized().maxContext ? declared : min(declared, Self.standardContextWindow)
    }

    /// Another provider starts at its first model with that model's defaults.
    func with(provider: AgentProviderID) -> AgentModelChoice {
        guard provider != self.provider else { return self }
        let model = AgentProviderCatalog.option(provider).models[0]
        return AgentModelChoice(provider: provider, model: model.value, thinking: model.reasoning.defaultThinking,
                                effort: model.reasoning.defaultEffort)
    }

    func with(model: String) -> AgentModelChoice {
        var next = self; next.model = model; return next.normalized()
    }

    var thinkingEnabled: Bool { normalized().thinking == .adaptive }

    var label: String {
        var parts = [provider.label, option.short]
        if thinkingEnabled { parts.append("思考·\(effort.label)") }
        if normalized().maxContext { parts.append("1M 上下文") }
        return parts.joined(separator: " · ")
    }
}

extension AgentModelChoice {
    private enum CodingKeys: String, CodingKey { case provider, model, thinking, effort, maxContext }

    /// Conversations written before Max · 1M 上下文 read as the standard window.
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(provider: try values.decode(AgentProviderID.self, forKey: .provider), model: try values.decode(String.self, forKey: .model),
                  thinking: try values.decode(AgentThinking.self, forKey: .thinking), effort: try values.decode(AgentEffort.self, forKey: .effort),
                  maxContext: (try? values.decodeIfPresent(Bool.self, forKey: .maxContext)) ?? false)
    }
}
