import Foundation

/// Streaming model drivers for the native writing Agent: DeepSeek Chat
/// Completions, Anthropic Messages and OpenAI Responses, over one URLSession
/// SSE client. Request and stream shapes follow the renderer's drivers in
/// `src/renderer/lib/agent/runtime/drivers/`. Keys go only into the
/// provider's auth header; they never appear in errors or logs.

enum AgentStopReason: String, Codable {
    case endTurn = "end_turn", toolUse = "tool_use", maxTokens = "max_tokens", contentFilter = "content_filter", unknown
}

struct AgentModelResult {
    var text = ""
    var thinking = ""
    var toolCalls: [AgentToolCall] = []
    var stop = AgentStopReason.unknown
    var usage: AgentUsage?
    var replay: AgentJSON?
}

enum AgentStreamEvent: Equatable {
    case text(String)
    case thinking(String)
    case toolStart(String)
}

/// A turn failure with the Chinese message the transcript shows.
struct AgentFailure: Error, LocalizedError, Equatable {
    enum Kind: Equatable { case cancelled, missingKey, auth, rateLimit, notFound, badRequest, server, network, invalid, http }
    let kind: Kind
    let message: String
    var errorDescription: String? { message }
}

enum AgentErrors {
    static func missingKey(_ provider: AgentProviderID) -> AgentFailure {
        AgentFailure(kind: .missingKey, message: "还没有设置 \(provider.label) 的 API Key。请点击“设置…”填写后再发送。")
    }

    static let cancelled = AgentFailure(kind: .cancelled, message: "已停止。")

    static func http(_ status: Int, body: Data, _ provider: AgentProviderID) -> AgentFailure {
        let name = provider.label
        switch status {
        case 401, 403:
            // The body may echo a masked key; it is never shown.
            return AgentFailure(kind: .auth, message: "\(name) 拒绝了这个 API Key（HTTP \(status)）。请在“设置…”中检查或更换 \(name) 的 API Key。")
        case 429:
            return AgentFailure(kind: .rateLimit, message: "\(name) 请求过于频繁或额度已用尽（HTTP 429），请稍后再试。")
        case 404:
            return AgentFailure(kind: .notFound, message: "\(name) 找不到所选模型（HTTP 404），请换一个模型后重试。")
        case 500...599:
            return AgentFailure(kind: .server, message: "\(name) 服务暂时不可用（HTTP \(status)），请稍后重试。")
        default:
            let detail = providerMessage(body).map { "：\($0)" } ?? "。"
            return AgentFailure(kind: status == 400 ? .badRequest : .http, message: "\(name) 拒绝了这次请求（HTTP \(status)）\(detail)")
        }
    }

    static func network(_ error: Error, _ provider: AgentProviderID) -> AgentFailure {
        let code = (error as? URLError)?.code
        let reason: String
        switch code {
        case .notConnectedToInternet?, .networkConnectionLost?, .dataNotAllowed?: reason = "网络未连接"
        case .timedOut?: reason = "请求超时"
        case .cannotFindHost?, .cannotConnectToHost?, .dnsLookupFailed?: reason = "无法连接服务器"
        case .secureConnectionFailed?, .serverCertificateUntrusted?, .serverCertificateHasBadDate?: reason = "安全连接失败"
        default: reason = "网络错误"
        }
        return AgentFailure(kind: .network, message: "无法连接 \(provider.label)：\(reason)。请检查网络后重试。")
    }

    static func invalid(_ provider: AgentProviderID) -> AgentFailure {
        AgentFailure(kind: .invalid, message: "\(provider.label) 返回的数据无法解析，本轮已停止。")
    }

    static func incomplete(_ provider: AgentProviderID) -> AgentFailure {
        AgentFailure(kind: .invalid, message: "\(provider.label) 的回复中断了，本轮已停止。可以稍后重试。")
    }

    static func stream(_ provider: AgentProviderID, message: String?) -> AgentFailure {
        let detail = message.map { "：\(String($0.prefix(160)))" } ?? "。"
        return AgentFailure(kind: .server, message: "\(provider.label) 在回复过程中出错\(detail)本轮已停止，可以稍后重试。")
    }

    /// `{"error": {"message": …}}`, shortened.
    static func providerMessage(_ body: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return nil }
        let message = (json["error"] as? [String: Any])?["message"] as? String ?? json["message"] as? String
        return message.map { String($0.prefix(160)) }
    }
}

struct AgentModelRequest {
    let choice: AgentModelChoice
    let apiKey: String
    let system: String
    let messages: [AgentMessage]
    /// The current turn: reasoning replay is sent only for its tool calls.
    let turnID: String
    let tools: [AgentToolDefinition]
    let sessionID: String
}

// MARK: - History

enum AgentHistory {
    /// What a provider sees: notices are dropped, empty replies skipped and
    /// every tool call closed by a result (a missing one reads 未执行).
    static func normalized(_ messages: [AgentMessage]) -> [AgentMessage] {
        var result: [AgentMessage] = []
        var pending: [AgentToolCall] = []
        var pendingTurn = ""
        func close() {
            for call in pending {
                var message = AgentMessage(role: .tool, turnID: pendingTurn, text: "工具没有执行：本轮已停止。")
                message.callID = call.id; message.toolName = call.name; message.ok = false
                result.append(message)
            }
            pending = []
        }
        for message in messages {
            switch message.role {
            case .notice: continue
            case .tool:
                guard let id = message.callID, let index = pending.firstIndex(where: { $0.id == id }) else { continue }
                pending.remove(at: index)
                result.append(message)
            case .user:
                close(); result.append(message)
            case .assistant:
                close()
                let calls = message.toolCalls ?? []
                if message.text.isEmpty && calls.isEmpty { continue }
                result.append(message)
                pending = calls; pendingTurn = message.turnID
            }
        }
        close()
        return result
    }

    /// The runtime note, then the author's words.
    static func userContent(_ message: AgentMessage) -> String {
        guard let context = message.context, !context.isEmpty else { return message.text }
        return context + "\n\n" + message.text
    }

    static func toolContent(_ message: AgentMessage) -> String {
        message.ok == false ? "工具失败：" + message.text : message.text
    }

    /// Arguments as an object; invalid JSON is sent back as `{}`.
    static func argumentObject(_ call: AgentToolCall) -> [String: Any] {
        AgentJSONText.object(call.arguments) ?? [:]
    }

    static func argumentText(_ call: AgentToolCall) -> String {
        AgentJSONText.object(call.arguments) == nil || call.arguments.trimmingCharacters(in: .whitespaces).isEmpty ? "{}" : call.arguments
    }
}

// MARK: - Requests

enum AgentDriver {
    static func endpoint(_ provider: AgentProviderID) -> URL {
        switch provider {
        case .deepseek: return URL(string: "https://api.deepseek.com/v1/chat/completions")!
        case .anthropic: return URL(string: "https://api.anthropic.com/v1/messages")!
        case .openai: return URL(string: "https://api.openai.com/v1/responses")!
        }
    }

    static func parser(_ provider: AgentProviderID) -> AgentStreamParser {
        switch provider {
        case .deepseek: return AgentChatCompletionParser(provider: provider)
        case .anthropic: return AgentAnthropicParser()
        case .openai: return AgentResponsesParser()
        }
    }

    static func urlRequest(_ request: AgentModelRequest) throws -> URLRequest {
        var url = URLRequest(url: endpoint(request.choice.provider))
        url.httpMethod = "POST"
        url.setValue("application/json", forHTTPHeaderField: "content-type")
        url.setValue("text/event-stream", forHTTPHeaderField: "accept")
        let body: [String: Any]
        switch request.choice.provider {
        case .deepseek:
            url.setValue("Bearer \(request.apiKey)", forHTTPHeaderField: "authorization")
            body = chatCompletionBody(request)
        case .anthropic:
            url.setValue(request.apiKey, forHTTPHeaderField: "x-api-key")
            url.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
            body = anthropicBody(request)
        case .openai:
            url.setValue("Bearer \(request.apiKey)", forHTTPHeaderField: "authorization")
            body = responsesBody(request)
        }
        url.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes])
        return url
    }

    /// Provider state goes back only inside the current turn's tool loop,
    /// with thinking on and the same provider that produced it.
    private static func replay(_ message: AgentMessage, _ request: AgentModelRequest) -> AgentJSON? {
        guard request.choice.thinkingEnabled, message.turnID == request.turnID, !(message.toolCalls ?? []).isEmpty,
              let replay = message.replay, replay.provider == request.choice.provider else { return nil }
        return replay.value
    }

    /// DeepSeek: OpenAI-compatible Chat Completions with its `thinking` and
    /// `reasoning_effort` extensions; thinking mode rejects `tool_choice`.
    static func chatCompletionBody(_ request: AgentModelRequest) -> [String: Any] {
        let thinking = request.choice.thinkingEnabled
        var messages: [[String: Any]] = [["role": "system", "content": request.system]]
        for message in AgentHistory.normalized(request.messages) {
            switch message.role {
            case .user: messages.append(["role": "user", "content": AgentHistory.userContent(message)])
            case .assistant:
                let calls = message.toolCalls ?? []
                let content: Any = message.text.isEmpty && !calls.isEmpty ? NSNull() : message.text
                var entry: [String: Any] = ["role": "assistant", "content": content]
                if !calls.isEmpty {
                    entry["tool_calls"] = calls.map { call in
                        ["id": call.id, "type": "function", "function": ["name": call.name, "arguments": AgentHistory.argumentText(call)]] as [String: Any]
                    }
                    if thinking, message.turnID == request.turnID {
                        entry["reasoning_content"] = replay(message, request)?.stringValue ?? message.thinking ?? ""
                    }
                }
                messages.append(entry)
            case .tool:
                messages.append(["role": "tool", "tool_call_id": message.callID ?? "", "content": AgentHistory.toolContent(message)])
            case .notice: break
            }
        }
        var body: [String: Any] = [
            "model": request.choice.model,
            "messages": messages,
            "stream": true,
            "stream_options": ["include_usage": true],
            "max_tokens": request.choice.option.maxOutputTokens,
            "thinking": ["type": thinking ? "enabled" : "disabled"],
        ]
        if thinking { body["reasoning_effort"] = request.choice.effort == .max || request.choice.effort == .xhigh ? "max" : "high" }
        if !request.tools.isEmpty {
            body["tools"] = request.tools.map { tool in
                ["type": "function", "function": ["name": tool.name, "description": tool.description, "parameters": tool.schema]] as [String: Any]
            }
            if !thinking { body["tool_choice"] = "auto" }
        }
        return body
    }

    /// Anthropic Messages with adaptive thinking and prompt-cache breakpoints
    /// on the system prompt and the last tool.
    static func anthropicBody(_ request: AgentModelRequest) -> [String: Any] {
        let cache: [String: Any] = ["type": "ephemeral"]
        var messages: [[String: Any]] = []
        func append(_ role: String, _ content: [[String: Any]]) {
            guard !content.isEmpty else { return }
            if let last = messages.last, last["role"] as? String == role, let previous = last["content"] as? [[String: Any]] {
                messages[messages.count - 1]["content"] = previous + content
            } else {
                messages.append(["role": role, "content": content])
            }
        }
        for message in AgentHistory.normalized(request.messages) {
            switch message.role {
            case .user: append("user", [["type": "text", "text": AgentHistory.userContent(message)]])
            case .assistant:
                var content: [[String: Any]] = []
                if let blocks = replay(message, request)?.arrayValue {
                    content += blocks.compactMap { $0.any as? [String: Any] }
                }
                if !message.text.isEmpty { content.append(["type": "text", "text": message.text]) }
                for call in message.toolCalls ?? [] {
                    content.append(["type": "tool_use", "id": call.id, "name": call.name, "input": AgentHistory.argumentObject(call)])
                }
                append("assistant", content)
            case .tool:
                append("user", [["type": "tool_result", "tool_use_id": message.callID ?? "", "content": message.text,
                                 "is_error": message.ok == false]])
            case .notice: break
            }
        }
        let model = request.choice.option
        var body: [String: Any] = [
            "model": model.value,
            "max_tokens": model.maxOutputTokens,
            "stream": true,
            "system": [["type": "text", "text": request.system, "cache_control": cache]],
            "messages": messages,
        ]
        if request.choice.thinkingEnabled { body["thinking"] = ["type": "adaptive", "display": "summarized"] }
        if !model.reasoning.efforts.isEmpty { body["output_config"] = ["effort": request.choice.normalized().effort.rawValue] }
        if !request.tools.isEmpty {
            body["tools"] = request.tools.enumerated().map { index, tool -> [String: Any] in
                var entry: [String: Any] = ["name": tool.name, "description": tool.description, "input_schema": tool.schema]
                if index == request.tools.count - 1 { entry["cache_control"] = cache }
                return entry
            }
            body["tool_choice"] = ["type": "auto"]
        }
        return body
    }

    /// OpenAI Responses, stateless (`store: false`); with thinking on, the
    /// encrypted reasoning items are replayed inside the tool loop.
    static func responsesBody(_ request: AgentModelRequest) -> [String: Any] {
        let thinking = request.choice.thinkingEnabled
        var input: [[String: Any]] = []
        for message in AgentHistory.normalized(request.messages) {
            switch message.role {
            case .user: input.append(["role": "user", "content": AgentHistory.userContent(message)])
            case .assistant:
                if let items = replay(message, request)?.arrayValue {
                    input += items.compactMap { $0.any as? [String: Any] }
                    continue
                }
                if !message.text.isEmpty { input.append(["role": "assistant", "content": message.text]) }
                for call in message.toolCalls ?? [] {
                    input.append(["type": "function_call", "call_id": call.id, "name": call.name, "arguments": AgentHistory.argumentText(call)])
                }
            case .tool:
                input.append(["type": "function_call_output", "call_id": message.callID ?? "", "output": AgentHistory.toolContent(message)])
            case .notice: break
            }
        }
        var reasoning: [String: Any] = ["effort": thinking ? request.choice.normalized().effort.rawValue : "none"]
        if thinking { reasoning["summary"] = "auto"; reasoning["context"] = "current_turn" }
        var body: [String: Any] = [
            "model": request.choice.model,
            "instructions": request.system,
            "input": input,
            "max_output_tokens": request.choice.option.maxOutputTokens,
            "stream": true,
            "store": false,
            "prompt_cache_key": "drifting-agent:\(request.sessionID)",
            "reasoning": reasoning,
        ]
        if thinking { body["include"] = ["reasoning.encrypted_content"] }
        if !request.tools.isEmpty {
            body["tools"] = request.tools.map { tool in
                ["type": "function", "name": tool.name, "description": tool.description, "parameters": tool.schema] as [String: Any]
            }
            body["tool_choice"] = "auto"
        }
        return body
    }
}

// MARK: - Stream parsers

protocol AgentStreamParser: AnyObject {
    func consume(_ event: [String: Any]) throws -> [AgentStreamEvent]
    func finish() throws -> AgentModelResult
}

private func integer(_ value: Any?) -> Int? { (value as? NSNumber).map(\.intValue) }

/// Chat Completions chunks: content, DeepSeek `reasoning_content`, indexed
/// tool-call fragments, a finish reason and a final usage chunk.
final class AgentChatCompletionParser: AgentStreamParser {
    private let provider: AgentProviderID
    private var result = AgentModelResult()
    private var calls: [Int: AgentToolCall] = [:]
    private var order: [Int] = []
    private var finishReason: String?

    init(provider: AgentProviderID) { self.provider = provider }

    func consume(_ event: [String: Any]) throws -> [AgentStreamEvent] {
        if let error = event["error"] as? [String: Any] { throw AgentErrors.stream(provider, message: error["message"] as? String) }
        if let usage = event["usage"] as? [String: Any], let input = integer(usage["prompt_tokens"]), let output = integer(usage["completion_tokens"]) {
            result.usage = AgentUsage(inputTokens: input, outputTokens: output)
        }
        guard let choice = (event["choices"] as? [[String: Any]])?.first else { return [] }
        var events: [AgentStreamEvent] = []
        let delta = choice["delta"] as? [String: Any] ?? [:]
        if let text = delta["content"] as? String, !text.isEmpty { result.text += text; events.append(.text(text)) }
        if let thinking = delta["reasoning_content"] as? String, !thinking.isEmpty { result.thinking += thinking; events.append(.thinking(thinking)) }
        for fragment in delta["tool_calls"] as? [[String: Any]] ?? [] {
            let index = integer(fragment["index"]) ?? 0
            if calls[index] == nil { calls[index] = AgentToolCall(id: "", name: "", arguments: ""); order.append(index) }
            if let id = fragment["id"] as? String, !id.isEmpty { calls[index]!.id = id }
            let function = fragment["function"] as? [String: Any] ?? [:]
            if let name = function["name"] as? String, !name.isEmpty {
                calls[index]!.name += name
                events.append(.toolStart(calls[index]!.name))
            }
            if let arguments = function["arguments"] as? String { calls[index]!.arguments += arguments }
        }
        if let reason = choice["finish_reason"] as? String { finishReason = reason }
        return events
    }

    func finish() throws -> AgentModelResult {
        guard let finishReason else { throw AgentErrors.incomplete(provider) }
        result.toolCalls = order.map { index in
            var call = calls[index]!
            if call.id.isEmpty { call.id = "call_\(index)_\(UUID().uuidString.prefix(8))" }
            return call
        }
        guard result.toolCalls.allSatisfy({ !$0.name.isEmpty }) else { throw AgentErrors.invalid(provider) }
        switch finishReason {
        case "stop": result.stop = .endTurn
        case "tool_calls", "function_call": result.stop = .toolUse
        case "length": result.stop = .maxTokens
        case "content_filter": result.stop = .contentFilter
        default: result.stop = .unknown
        }
        if !result.toolCalls.isEmpty {
            result.stop = .toolUse
            result.replay = .string(result.thinking)
        }
        return result
    }
}

/// Anthropic Messages events: text, thinking (with its signature), redacted
/// thinking and tool_use blocks with streamed JSON input.
final class AgentAnthropicParser: AgentStreamParser {
    private struct Block {
        var type: String
        var id = "", name = "", json = "", thinking = "", signature = "", data = ""
    }
    private var result = AgentModelResult()
    private var blocks: [Int: Block] = [:]
    private var started = false, stopped = false
    private var inputTokens: Int?, outputTokens: Int?
    private var stopReason: String?
    private var replay: [AgentJSON] = []

    func consume(_ event: [String: Any]) throws -> [AgentStreamEvent] {
        let provider = AgentProviderID.anthropic
        guard let type = event["type"] as? String else { throw AgentErrors.invalid(provider) }
        switch type {
        case "ping": return []
        case "error":
            throw AgentErrors.stream(provider, message: (event["error"] as? [String: Any])?["message"] as? String)
        case "message_start":
            started = true
            let usage = (event["message"] as? [String: Any])?["usage"] as? [String: Any]
            inputTokens = integer(usage?["input_tokens"])
            return []
        default: break
        }
        guard started, !stopped else { throw AgentErrors.invalid(provider) }
        switch type {
        case "content_block_start":
            guard let index = integer(event["index"]), let content = event["content_block"] as? [String: Any],
                  let blockType = content["type"] as? String else { throw AgentErrors.invalid(provider) }
            var block = Block(type: blockType)
            switch blockType {
            case "thinking":
                block.thinking = content["thinking"] as? String ?? ""
                block.signature = content["signature"] as? String ?? ""
            case "redacted_thinking":
                block.data = content["data"] as? String ?? ""
            case "tool_use":
                guard let id = content["id"] as? String, let name = content["name"] as? String else { throw AgentErrors.invalid(provider) }
                block.id = id; block.name = name
                if let input = content["input"] as? [String: Any], !input.isEmpty { block.json = AgentJSONText.encode(input) }
                blocks[index] = block
                return [.toolStart(name)]
            default: break
            }
            blocks[index] = block
            return []
        case "content_block_delta":
            guard let index = integer(event["index"]), var block = blocks[index], let delta = event["delta"] as? [String: Any] else {
                throw AgentErrors.invalid(provider)
            }
            var events: [AgentStreamEvent] = []
            switch delta["type"] as? String {
            case "text_delta":
                let text = delta["text"] as? String ?? ""
                result.text += text
                if !text.isEmpty { events.append(.text(text)) }
            case "thinking_delta":
                let text = delta["thinking"] as? String ?? ""
                block.thinking += text; result.thinking += text
                if !text.isEmpty { events.append(.thinking(text)) }
            case "signature_delta": block.signature += delta["signature"] as? String ?? ""
            case "input_json_delta": block.json += delta["partial_json"] as? String ?? ""
            default: break
            }
            blocks[index] = block
            return events
        case "content_block_stop":
            guard let index = integer(event["index"]), let block = blocks.removeValue(forKey: index) else { throw AgentErrors.invalid(provider) }
            switch block.type {
            case "tool_use": result.toolCalls.append(AgentToolCall(id: block.id, name: block.name, arguments: block.json.isEmpty ? "{}" : block.json))
            case "thinking":
                replay.append(.object(["type": .string("thinking"), "thinking": .string(block.thinking), "signature": .string(block.signature)]))
            case "redacted_thinking":
                replay.append(.object(["type": .string("redacted_thinking"), "data": .string(block.data)]))
            default: break
            }
            return []
        case "message_delta":
            if let reason = (event["delta"] as? [String: Any])?["stop_reason"] as? String { stopReason = reason }
            if let output = integer((event["usage"] as? [String: Any])?["output_tokens"]) { outputTokens = output }
            return []
        case "message_stop":
            guard blocks.isEmpty else { throw AgentErrors.invalid(provider) }
            stopped = true
            return []
        default: return []
        }
    }

    func finish() throws -> AgentModelResult {
        guard started, stopped, let stopReason else { throw AgentErrors.incomplete(.anthropic) }
        switch stopReason {
        case "end_turn", "stop_sequence": result.stop = .endTurn
        case "tool_use": result.stop = .toolUse
        case "max_tokens": result.stop = .maxTokens
        case "refusal": result.stop = .contentFilter
        default: result.stop = .unknown
        }
        if let inputTokens, let outputTokens { result.usage = AgentUsage(inputTokens: inputTokens, outputTokens: outputTokens) }
        if !result.toolCalls.isEmpty { result.stop = .toolUse; if !replay.isEmpty { result.replay = .array(replay) } }
        return result
    }
}

/// OpenAI Responses events: output text, reasoning summaries, function-call
/// items with streamed arguments, and the terminal response whose complete
/// output is kept for replay.
final class AgentResponsesParser: AgentStreamParser {
    private struct Call { var itemID: String; var callID: String; var name: String; var arguments: String }
    private var result = AgentModelResult()
    private var calls: [Call] = []
    private var streamed: [Int: [String: Any]] = [:]
    private var terminal: [String: Any]?
    private var terminalType = ""

    func consume(_ event: [String: Any]) throws -> [AgentStreamEvent] {
        let provider = AgentProviderID.openai
        guard let type = event["type"] as? String else { throw AgentErrors.invalid(provider) }
        guard terminal == nil else { return [] }
        switch type {
        case "error":
            throw AgentErrors.stream(provider, message: event["message"] as? String ?? (event["error"] as? [String: Any])?["message"] as? String)
        case "response.failed":
            let error = ((event["response"] as? [String: Any])?["error"] as? [String: Any])?["message"] as? String
            throw AgentErrors.stream(provider, message: error)
        case "response.output_text.delta", "response.refusal.delta":
            let text = event["delta"] as? String ?? ""
            result.text += text
            return text.isEmpty ? [] : [.text(text)]
        case "response.reasoning_summary_text.delta":
            let text = event["delta"] as? String ?? ""
            result.thinking += text
            return text.isEmpty ? [] : [.thinking(text)]
        case "response.output_item.added":
            guard let item = event["item"] as? [String: Any], item["type"] as? String == "function_call" else { return [] }
            guard let itemID = item["id"] as? String, let callID = item["call_id"] as? String, let name = item["name"] as? String else {
                throw AgentErrors.invalid(provider)
            }
            calls.append(Call(itemID: itemID, callID: callID, name: name, arguments: item["arguments"] as? String ?? ""))
            return [.toolStart(name)]
        case "response.function_call_arguments.delta":
            guard let itemID = event["item_id"] as? String, let index = calls.firstIndex(where: { $0.itemID == itemID }) else {
                throw AgentErrors.invalid(provider)
            }
            calls[index].arguments += event["delta"] as? String ?? ""
            return []
        case "response.output_item.done":
            guard let item = event["item"] as? [String: Any] else { throw AgentErrors.invalid(provider) }
            if let index = integer(event["output_index"]) { streamed[index] = item }
            if item["type"] as? String == "function_call", let itemID = item["id"] as? String,
               let index = calls.firstIndex(where: { $0.itemID == itemID }), let arguments = item["arguments"] as? String {
                calls[index].arguments = arguments
            }
            return []
        case "response.completed", "response.incomplete":
            guard let response = event["response"] as? [String: Any] else { throw AgentErrors.invalid(provider) }
            terminal = response; terminalType = type
            return []
        default: return []
        }
    }

    func finish() throws -> AgentModelResult {
        guard let terminal else { throw AgentErrors.incomplete(.openai) }
        var output = terminal["output"] as? [[String: Any]] ?? []
        if output.isEmpty { output = streamed.keys.sorted().compactMap { streamed[$0] } }
        let items = output.filter { $0["type"] as? String == "function_call" }
        if !items.isEmpty {
            result.toolCalls = items.compactMap { item in
                guard let callID = item["call_id"] as? String, let name = item["name"] as? String else { return nil }
                let streamedArguments = calls.first { $0.callID == callID }?.arguments ?? ""
                return AgentToolCall(id: callID, name: name, arguments: item["arguments"] as? String ?? streamedArguments)
            }
        } else {
            result.toolCalls = calls.map { AgentToolCall(id: $0.callID, name: $0.name, arguments: $0.arguments) }
        }
        if let usage = terminal["usage"] as? [String: Any], let input = integer(usage["input_tokens"]), let outputTokens = integer(usage["output_tokens"]) {
            result.usage = AgentUsage(inputTokens: input, outputTokens: outputTokens)
        }
        if !result.toolCalls.isEmpty {
            result.stop = .toolUse
            result.replay = .array(output.map { AgentJSON(any: $0) })
        } else if terminalType == "response.completed" {
            result.stop = .endTurn
        } else {
            switch (terminal["incomplete_details"] as? [String: Any])?["reason"] as? String {
            case "max_output_tokens": result.stop = .maxTokens
            case "content_filter": result.stop = .contentFilter
            default: result.stop = .unknown
            }
        }
        return result
    }
}

// MARK: - SSE transport

/// Splits a byte stream into SSE `data:` payloads. Frames are decoded only
/// once complete, so multi-byte characters may span network chunks.
struct AgentSSEBuffer {
    private var buffer = Data()

    mutating func append(_ data: Data) -> [String] {
        buffer.append(data.filter { $0 != 0x0D })
        var payloads: [String] = []
        let separator = Data([0x0A, 0x0A])
        while let range = buffer.range(of: separator) {
            let frame = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
            buffer.removeSubrange(buffer.startIndex..<range.upperBound)
            guard let text = String(data: frame, encoding: .utf8) else { continue }
            let lines = text.components(separatedBy: "\n").filter { $0.hasPrefix("data:") }
                .map { line -> String in
                    let value = line.dropFirst(5)
                    return String(value.first == " " ? value.dropFirst() : value)
                }
            if !lines.isEmpty { payloads.append(lines.joined(separator: "\n")) }
        }
        return payloads
    }
}

/// The URLSession configuration drivers stream through. Tests install a
/// `URLProtocol` stub here; nothing else reaches the network.
final class AgentNetwork {
    let configuration: URLSessionConfiguration

    init(configuration: URLSessionConfiguration = AgentNetwork.standardConfiguration()) { self.configuration = configuration }

    static func standardConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        // Idle time between stream packets; reasoning can pause output.
        configuration.timeoutIntervalForRequest = 300
        configuration.timeoutIntervalForResource = 900
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        return configuration
    }

    /// Starts one streamed model call; callbacks arrive on the main queue.
    func stream(_ request: AgentModelRequest, onEvent: @escaping (AgentStreamEvent) -> Void,
                completion: @escaping (Result<AgentModelResult, AgentFailure>) -> Void) -> AgentHTTPStream? {
        let urlRequest: URLRequest
        do { urlRequest = try AgentDriver.urlRequest(request) } catch {
            completion(.failure(AgentErrors.invalid(request.choice.provider))); return nil
        }
        let stream = AgentHTTPStream(provider: request.choice.provider, parser: AgentDriver.parser(request.choice.provider),
                                     onEvent: onEvent, completion: completion)
        stream.start(urlRequest, configuration: configuration)
        return stream
    }
}

final class AgentHTTPStream: NSObject, URLSessionDataDelegate {
    static let responseLimit = 32 * 1024 * 1024
    private let provider: AgentProviderID
    private let parser: AgentStreamParser
    private let onEvent: (AgentStreamEvent) -> Void
    private var completion: ((Result<AgentModelResult, AgentFailure>) -> Void)?
    private var task: URLSessionDataTask?
    private var status = 0
    private var errorBody = Data()
    private var received = 0
    private var sse = AgentSSEBuffer()

    init(provider: AgentProviderID, parser: AgentStreamParser, onEvent: @escaping (AgentStreamEvent) -> Void,
         completion: @escaping (Result<AgentModelResult, AgentFailure>) -> Void) {
        self.provider = provider; self.parser = parser; self.onEvent = onEvent; self.completion = completion
    }

    var isFinished: Bool { completion == nil }

    func start(_ request: URLRequest, configuration: URLSessionConfiguration) {
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
        let task = session.dataTask(with: request)
        self.task = task
        task.resume()
        // The session releases this delegate once the task ends.
        session.finishTasksAndInvalidate()
    }

    /// Stops at once; the partial reply stays with the caller.
    func cancel() {
        guard !isFinished else { return }
        finish(.failure(AgentErrors.cancelled))
        task?.cancel()
    }

    private func finish(_ result: Result<AgentModelResult, AgentFailure>) {
        guard let completion else { return }
        self.completion = nil
        completion(result)
    }

    private func fail(_ failure: AgentFailure) {
        finish(.failure(failure))
        task?.cancel()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Credentials are never forwarded to another location.
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        status = (response as? HTTPURLResponse)?.statusCode ?? 0
        completionHandler(isFinished ? .cancel : .allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !isFinished else { return }
        received += data.count
        guard received <= Self.responseLimit else { fail(AgentErrors.invalid(provider)); return }
        guard (200..<300).contains(status) else {
            if errorBody.count < 65_536 { errorBody.append(data) }
            return
        }
        do {
            for payload in sse.append(data) where payload != "[DONE]" {
                guard let event = try JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any] else {
                    throw AgentErrors.invalid(provider)
                }
                for next in try parser.consume(event) {
                    guard !isFinished else { return }
                    onEvent(next)
                }
            }
        } catch let failure as AgentFailure {
            fail(failure)
        } catch {
            fail(AgentErrors.invalid(provider))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !isFinished else { return }
        if let error {
            finish(.failure((error as? URLError)?.code == .cancelled ? AgentErrors.cancelled : AgentErrors.network(error, provider)))
            return
        }
        guard (200..<300).contains(status) else { finish(.failure(AgentErrors.http(status, body: errorBody, provider))); return }
        do { finish(.success(try parser.finish())) } catch let failure as AgentFailure {
            finish(.failure(failure))
        } catch {
            finish(.failure(AgentErrors.invalid(provider)))
        }
    }
}
