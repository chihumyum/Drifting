import AppKit

/// Stubbed network: every request the writing assistant makes is answered
/// by a scripted synthetic SSE reply. Nothing reaches a real provider.
final class AgentStubProtocol: URLProtocol {
    struct Reply {
        var status = 200
        var body = Data()
        /// Deliver the body and keep the request open (a stalled stream).
        var hold = false
        /// Fail before any response.
        var failure: URLError.Code?
        /// Chunk size in bytes; small sizes split frames and characters.
        var chunk = 7
    }
    struct Captured {
        let url: URL
        let headers: [String: String]
        let body: [String: Any]
    }
    private static let lock = NSLock()
    private static var replies: [Reply] = []
    private static var captured: [Captured] = []
    private static var stoppedCount = 0

    static func reset(_ next: [Reply]) { lock.lock(); replies = next; captured = []; stoppedCount = 0; lock.unlock() }
    static func enqueue(_ next: [Reply]) { lock.lock(); replies += next; lock.unlock() }
    static var requests: [Captured] { lock.lock(); defer { lock.unlock() }; return captured }
    static var stopped: Int { lock.lock(); defer { lock.unlock() }; return stoppedCount }
    static var remaining: Int { lock.lock(); defer { lock.unlock() }; return replies.count }

    static var configuration: URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AgentStubProtocol.self]
        return configuration
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }

    override func startLoading() {
        let body = (try? JSONSerialization.jsonObject(with: Self.body(of: request))) as? [String: Any] ?? [:]
        Self.lock.lock()
        let headers = Dictionary((request.allHTTPHeaderFields ?? [:]).map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { first, _ in first })
        Self.captured.append(Captured(url: request.url!, headers: headers, body: body))
        let reply = Self.replies.isEmpty ? nil : Self.replies.removeFirst()
        Self.lock.unlock()
        guard let reply else { client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable)); return }
        if let failure = reply.failure { client?.urlProtocol(self, didFailWithError: URLError(failure)); return }
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1",
                                       headerFields: ["content-type": reply.status == 200 ? "text/event-stream" : "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        var offset = 0
        while offset < reply.body.count {
            let end = min(offset + reply.chunk, reply.body.count)
            client?.urlProtocol(self, didLoad: reply.body.subdata(in: offset..<end))
            offset = end
        }
        if !reply.hold { client?.urlProtocolDidFinishLoading(self) }
    }

    override func stopLoading() { Self.lock.lock(); Self.stoppedCount += 1; Self.lock.unlock() }
}

/// Synthetic provider streams.
enum AgentSSE {
    static func frames(_ events: [[String: Any]], done: Bool = false) -> Data {
        var text = events.map { event in "data: " + AgentJSONText.encode(event) + "\n\n" }.joined()
        if done { text += "data: [DONE]\n\n" }
        return Data(text.utf8)
    }

    static func reply(_ events: [[String: Any]], done: Bool = false, hold: Bool = false) -> AgentStubProtocol.Reply {
        AgentStubProtocol.Reply(body: frames(events, done: done), hold: hold)
    }

    // DeepSeek Chat Completions
    static func deepseekText(_ parts: [String], thinking: String? = nil) -> AgentStubProtocol.Reply {
        var events: [[String: Any]] = [["choices": [["index": 0, "delta": ["role": "assistant", "content": ""]]]]]
        if let thinking { events.append(["choices": [["index": 0, "delta": ["reasoning_content": thinking]]]]) }
        events += parts.map { ["choices": [["index": 0, "delta": ["content": $0]]]] }
        events.append(["choices": [["index": 0, "delta": [:], "finish_reason": "stop"]]])
        events.append(["choices": [], "usage": ["prompt_tokens": 120, "completion_tokens": 18]])
        return reply(events, done: true)
    }

    static func deepseekTools(_ calls: [(id: String, name: String, arguments: String)], thinking: String? = nil) -> AgentStubProtocol.Reply {
        var events: [[String: Any]] = []
        if let thinking {
            let middle = thinking.index(thinking.startIndex, offsetBy: thinking.count / 2)
            events.append(["choices": [["index": 0, "delta": ["reasoning_content": String(thinking[..<middle])]]]])
            events.append(["choices": [["index": 0, "delta": ["reasoning_content": String(thinking[middle...])]]]])
        }
        for (index, call) in calls.enumerated() {
            events.append(["choices": [["index": 0, "delta": ["tool_calls": [["index": index, "id": call.id, "type": "function",
                                                                              "function": ["name": call.name, "arguments": ""]]]]]]])
            // Arguments arrive in two fragments.
            let middle = call.arguments.index(call.arguments.startIndex, offsetBy: call.arguments.count / 2)
            for fragment in [String(call.arguments[..<middle]), String(call.arguments[middle...])] {
                events.append(["choices": [["index": 0, "delta": ["tool_calls": [["index": index, "function": ["arguments": fragment]]]]]]])
            }
        }
        events.append(["choices": [["index": 0, "delta": [:], "finish_reason": "tool_calls"]]])
        events.append(["choices": [], "usage": ["prompt_tokens": 200, "completion_tokens": 30]])
        return reply(events, done: true)
    }

    // Anthropic Messages
    static func anthropicText(_ parts: [String]) -> AgentStubProtocol.Reply {
        var events: [[String: Any]] = [
            ["type": "message_start", "message": ["id": "msg_synthetic", "type": "message", "role": "assistant", "content": [],
                                                  "model": "claude-sonnet-5", "usage": ["input_tokens": 90, "output_tokens": 1]]],
            ["type": "content_block_start", "index": 0, "content_block": ["type": "thinking", "thinking": "", "signature": ""]],
            ["type": "content_block_delta", "index": 0, "delta": ["type": "thinking_delta", "thinking": "作者问钟声。"]],
            ["type": "content_block_delta", "index": 0, "delta": ["type": "signature_delta", "signature": "c3ludGhldGlj"]],
            ["type": "content_block_stop", "index": 0],
            ["type": "content_block_start", "index": 1, "content_block": ["type": "text", "text": ""]],
            ["type": "ping"],
        ]
        events += parts.map { ["type": "content_block_delta", "index": 1, "delta": ["type": "text_delta", "text": $0]] }
        events += [
            ["type": "content_block_stop", "index": 1],
            ["type": "message_delta", "delta": ["stop_reason": "end_turn", "stop_sequence": NSNull()], "usage": ["output_tokens": 21]],
            ["type": "message_stop"],
        ]
        return reply(events)
    }

    // OpenAI Responses
    static func openAIText(_ parts: [String]) -> AgentStubProtocol.Reply {
        let text = parts.joined()
        let message: [String: Any] = ["type": "message", "id": "msg_synthetic", "role": "assistant", "status": "completed",
                                      "content": [["type": "output_text", "text": text, "annotations": []]]]
        var events: [[String: Any]] = [
            ["type": "response.created", "response": ["id": "resp_synthetic", "status": "in_progress", "output": []]],
            ["type": "response.output_item.added", "output_index": 0,
             "item": ["type": "message", "id": "msg_synthetic", "role": "assistant", "status": "in_progress", "content": []]],
        ]
        events += parts.map { ["type": "response.output_text.delta", "item_id": "msg_synthetic", "output_index": 0, "content_index": 0, "delta": $0] }
        events += [
            ["type": "response.output_item.done", "output_index": 0, "item": message],
            ["type": "response.completed", "response": ["id": "resp_synthetic", "status": "completed", "output": [message],
                                                        "usage": ["input_tokens": 150, "output_tokens": 12]]],
        ]
        return reply(events)
    }

    static func error(_ status: Int, _ message: String) -> AgentStubProtocol.Reply {
        AgentStubProtocol.Reply(status: status, body: Data(AgentJSONText.encode(["error": ["message": message]]).utf8))
    }
}

/// The writing assistant through the real 写作助手 panel, tab host and Rust
/// workspace, wired as AppDelegate wires them. Providers are stubbed with
/// synthetic streams, keys live in an in-memory store, and every write goes
/// through the author's 接受 on a proposal card. Test data is synthetic.
extension BindingAcceptance {
    private final class AgentHarness {
        let directory: URL
        let workspace: LabWorkspaceCore
        let project: WorkspaceProject
        let chapters: [WorkspaceChapter]
        let window: NSWindow
        let host: MacChapterWorkspace
        let credentials: AgentMemoryCredentialStore
        let network = AgentNetwork(configuration: AgentStubProtocol.configuration)
        private(set) var controller: AgentChatController!
        private(set) var panel: MacAgentPanelView!
        private(set) var panelWindow: NSWindow!
        var effects: [AgentWorkspaceEffect] = []
        /// Answers the panel's alerts; nil cancels.
        var answer: ((NSAlert) -> NSApplication.ModalResponse)?

        init(titles: [String], keys: [AgentProviderID: String] = [.deepseek: "synthetic-deepseek-key-0001",
                                                                   .anthropic: "synthetic-anthropic-key-0002",
                                                                   .openai: "synthetic-openai-key-0003"]) throws {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                .appendingPathComponent("apple-native-lab")
            let workspace = LabWorkspaceCore(directory: directory)
            self.directory = directory
            self.workspace = workspace
            let listed: [WorkspaceProject] = try BindingAcceptance.elementResult { workspace.projects(completion: $0) }
            try BindingAcceptance.require(listed.isEmpty, "Agent fixture was not isolated")
            let project: WorkspaceProject = try BindingAcceptance.elementResult { workspace.createProject(name: "写作助手合成项目", completion: $0) }
            self.project = project
            chapters = try titles.map { title in
                try BindingAcceptance.elementResult { workspace.createChapter(projectID: project.id, title: title, completion: $0) }
            }
            (window, host) = BindingAcceptance.elementHost(workspace)
            credentials = AgentMemoryCredentialStore(keys)
            reopenPanel()
        }

        /// A new controller and panel over the same directory, as
        /// AppDelegate.ensureAgent builds them.
        func reopenPanel() {
            panelWindow?.close()
            let controller = AgentChatController(workspace: workspace, projectID: project.id, projectName: project.name,
                                                 credentials: credentials, network: network)
            let host = self.host, projectID = project.id
            controller.editorContext = { host.agentContext(projectID: projectID) }
            controller.onWorkspaceEffect = { [weak self] effect in
                self?.effects.append(effect)
                host.adoptAgentEffect(effect)
            }
            let panel = MacAgentPanelView(frame: NSRect(x: 0, y: 0, width: 360, height: 720))
            panel.presentAlert = { [weak self] alert, done in done(self?.answer?(alert) ?? .alertSecondButtonReturn) }
            panel.bind(controller)
            let panelWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 720),
                                       styleMask: [.titled, .resizable], backing: .buffered, defer: false)
            panelWindow.isReleasedWhenClosed = false
            panelWindow.contentView = panel
            panel.layoutSubtreeIfNeeded()
            self.controller = controller; self.panel = panel; self.panelWindow = panelWindow
        }

        func open(_ index: Int) throws -> NativeDocumentView {
            let view: NativeDocumentView = try BindingAcceptance.elementResult { host.open(project: project, chapter: chapters[index], completion: $0) }
            try BindingAcceptance.elementSettled(host, view)
            return view
        }

        func type(_ view: NativeDocumentView, _ text: String) throws {
            view.textView.insertText(text, replacementRange: NSRange(location: (view.textView.string as NSString).length, length: 0))
            try BindingAcceptance.elementSettled(host, view)
        }

        /// Types into the composer and presses 发送; waits for the turn to end.
        func send(_ text: String, file: String = #fileID, line: Int = #line) throws {
            let before = controller.current?.messages.count ?? 0
            panel.composer.string = text
            panel.composer.didChangeText()
            panel.sendButton.performClick(nil)
            try BindingAcceptance.require(controller.isRunning || (controller.current?.messages.count ?? 0) > before,
                "The panel did not send at \(file):\(line)")
            try BindingAcceptance.wait(file: file, line: line) { !self.controller.isRunning }
        }

        var conversation: AgentConversation { controller.current! }
        func proposal(_ id: String) -> AgentProposal? { conversation.proposal(id) }
        func card(_ id: String) -> AgentProposalCard? { panel.element("agent-proposal-\(id)") as? AgentProposalCard }
        var notices: [String] { conversation.messages.filter { $0.role == .notice }.map(\.text) }
        var lastReply: AgentMessage? { conversation.messages.last { $0.role == .assistant } }

        /// The provider-facing text of the last user message in a request.
        static func lastUserText(_ body: [String: Any]) -> String {
            if let messages = body["messages"] as? [[String: Any]], let user = messages.last(where: { $0["role"] as? String == "user" }) {
                if let text = user["content"] as? String { return text }
                return (user["content"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined(separator: "\n")
            }
            if let input = body["input"] as? [[String: Any]], let user = input.last(where: { $0["role"] as? String == "user" }) {
                return user["content"] as? String ?? ""
            }
            return ""
        }

        func agentRevisions(_ chapterID: String, call: String) throws -> Int64 {
            guard case .integer(let count)? = try WorkspaceRemoteProseFixture.query(in: directory, sql: """
                SELECT COUNT(*) AS n FROM yjs_document_revision_provenance
                WHERE document_id = ? AND source_kind = 'agent' AND agent_session_id = ? AND agent_call_id = ?
                """, parameters: [.text("node-content:\(chapterID)"), .text(conversation.id), .text(call)]).first?["n"] else {
                throw LabError.message("Provenance query returned no row")
            }
            return count
        }

        func close() throws {
            try BindingAcceptance.wait { self.host.canNavigate && !self.host.isBusy }
            controller.store.flush()
            let closed: Bool = try BindingAcceptance.elementResult { host.close(completion: $0) }
            try BindingAcceptance.require(closed, "Agent workspace failed to close")
            window.close(); panelWindow.close()
        }

        func remove() { try? FileManager.default.removeItem(at: directory.deletingLastPathComponent()) }
    }

    static func agentAcceptance() throws -> [String] {
        try agentProviders()
        try agentToolLoop()
        try agentRevisionReview()
        try agentStopAndErrors()
        try agentCreateAndSummary()
        try agentAppend()
        try agentPersistence()
        return [
            "AppKit 写作助手 streams one reply from each of DeepSeek, Anthropic and OpenAI through a stubbed URLProtocol, renders its Markdown-light text, and sends each provider's request shape with the model, the Chinese system prompt, the open-chapter line, seventeen tools and the key only in its auth header",
            "AppKit 写作助手 runs a DeepSeek thinking tool loop of list_chapters, read_chapter of the open chapter's live text and an answer, replays reasoning_content inside the turn, shows each tool as an activity line and stops cleanly after 24 tool rounds",
            "AppKit revise_chapter proposal changes nothing until 接受, then applies through Rust into the open editor as one undo step with Agent provenance for its session, turn and call; 拒绝 leaves the text, a refused original shows Rust's message, and the next turn tells the model every outcome",
            "AppKit 停止 mid-stream keeps the partial reply and closes the request, and a missing key, HTTP 401, HTTP 429 and an offline network show Chinese errors without sending or storing the key",
            "AppKit create_chapter with opening text and set_chapter_summary proposals from one parallel tool call apply on 接受: the chapter joins the book with its paragraphs written as one Agent append and the open page shows the stored summary",
            "AppKit append_to_body proposal shows the added paragraphs and changes nothing until 接受, then appends them to the open chapter as one Agent undo step with provenance, undo and redo follow, and a blank or mixed append is refused before any proposal",
            "AppKit conversations persist per project as atomic JSON beside the lab workspace and survive a cold reopen of the panel with messages, proposal states and model choice; rename, delete after confirmation and a pending proposal accepted after reopen work, and the key sheet stores and clears keys showing only a masked tail",
        ]
    }

    /// Stored dates keep milliseconds; everything else must match exactly.
    private static func undated(_ conversation: AgentConversation) -> AgentConversation {
        let fixed = Date(timeIntervalSince1970: 0)
        var copy = conversation
        copy.createdAt = fixed; copy.updatedAt = fixed
        for index in copy.messages.indices { copy.messages[index].createdAt = fixed }
        for index in copy.proposals.indices {
            copy.proposals[index].createdAt = fixed
            if copy.proposals[index].decidedAt != nil { copy.proposals[index].decidedAt = fixed }
        }
        return copy
    }

    // MARK: (a) Providers

    private static func agentProviders() throws {
        let harness = try AgentHarness(titles: ["启程"])
        defer { harness.remove() }
        let view = try harness.open(0)
        try harness.type(view, "雨夜里钟声响起。")
        let parts = ["雨夜里，", "**钟楼**", "响了十二下。"]
        for provider in AgentProviderID.allCases {
            let reply: AgentStubProtocol.Reply
            switch provider {
            case .deepseek: reply = AgentSSE.deepseekText(parts)
            case .anthropic: reply = AgentSSE.anthropicText(parts)
            case .openai: reply = AgentSSE.openAIText(parts)
            }
            AgentStubProtocol.reset([reply])
            harness.controller.newConversation()
            var choice = AgentModelChoice.standard.with(provider: provider)
            if provider == .anthropic { choice.thinking = .adaptive; choice.effort = .medium }
            harness.controller.setChoice(choice)
            if provider == .openai {
                // ⌘↩ in the composer sends; the event goes to the view, not the system.
                harness.panelWindow.makeFirstResponder(harness.panel.composer)
                harness.panel.composer.string = "钟楼响了几下？"
                let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0,
                                             windowNumber: harness.panelWindow.windowNumber, context: nil, characters: "\r",
                                             charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36)!
                try require(harness.panel.composer.performKeyEquivalent(with: event), "⌘↩ did not send from the composer")
                try wait { !harness.controller.isRunning }
            } else {
                try harness.send("钟楼响了几下？")
            }
            let requests = AgentStubProtocol.requests
            try require(requests.count == 1, "\(provider) sent \(requests.count) requests")
            let request = requests[0], body = request.body
            try require(request.url == AgentDriver.endpoint(provider), "\(provider) used another endpoint")
            try require(body["model"] as? String == choice.model && body["stream"] as? Bool == true, "\(provider) body lacks the model or stream")
            let user = AgentHarness.lastUserText(body)
            try require(user.contains("钟楼响了几下？") && user.contains("作者当前打开：《启程》（章节）"),
                "\(provider) did not send the author's words with the open chapter: \(user)")
            let names: [String]
            switch provider {
            case .deepseek:
                let messages = body["messages"] as? [[String: Any]] ?? []
                try require(messages.first?["role"] as? String == "system" && (messages.first?["content"] as? String ?? "").contains("写作助手"),
                    "DeepSeek lacks the system prompt")
                names = (body["tools"] as? [[String: Any]] ?? []).compactMap { ($0["function"] as? [String: Any])?["name"] as? String }
                try require(body["tool_choice"] as? String == "auto" && (body["thinking"] as? [String: Any])?["type"] as? String == "disabled"
                    && (body["stream_options"] as? [String: Any])?["include_usage"] as? Bool == true, "DeepSeek request shape differs")
                try require(request.headers["authorization"] == "Bearer synthetic-deepseek-key-0001", "DeepSeek key was not in its auth header")
            case .anthropic:
                let system = (body["system"] as? [[String: Any]])?.first?["text"] as? String ?? ""
                try require(system.contains("写作助手") && (body["messages"] as? [[String: Any]])?.first?["role"] as? String == "user",
                    "Anthropic lacks the system prompt or user message")
                let tools = body["tools"] as? [[String: Any]] ?? []
                names = tools.compactMap { $0["name"] as? String }
                try require(tools.allSatisfy { $0["input_schema"] is [String: Any] } && (body["tool_choice"] as? [String: Any])?["type"] as? String == "auto"
                    && (body["thinking"] as? [String: Any])?["type"] as? String == "adaptive"
                    && (body["output_config"] as? [String: Any])?["effort"] as? String == "medium"
                    && body["max_tokens"] as? Int == 32_000, "Anthropic request shape differs: \(body.keys.sorted())")
                try require(request.headers["x-api-key"] == "synthetic-anthropic-key-0002" && request.headers["anthropic-version"] == "2023-06-01"
                    && request.headers["authorization"] == nil, "Anthropic key was not in x-api-key only")
            case .openai:
                try require((body["instructions"] as? String ?? "").contains("写作助手") && body["store"] as? Bool == false
                    && (body["reasoning"] as? [String: Any])?["effort"] as? String == "none" && body["tool_choice"] as? String == "auto",
                    "OpenAI Responses request shape differs")
                names = (body["tools"] as? [[String: Any]] ?? []).compactMap { $0["type"] as? String == "function" ? $0["name"] as? String : nil }
                try require(request.headers["authorization"] == "Bearer synthetic-openai-key-0003", "OpenAI key was not in its auth header")
            }
            try require(names == AgentToolRegistry.all.map(\.name) && names.count == 17 && names.contains("revise_chapter"),
                "\(provider) did not send the tool definitions: \(names)")
            // Parsed and rendered.
            guard let reply = harness.lastReply else { throw LabError.message("\(provider) reply was not recorded") }
            try require(reply.text == parts.joined() && reply.usage != nil && reply.stop == "end_turn", "\(provider) reply was not parsed: \(reply)")
            guard let label = harness.panel.element("agent-message-\(reply.id)-text") as? NSTextField else {
                throw LabError.message("\(provider) reply was not rendered")
            }
            let rendered = label.attributedStringValue
            let bold = (rendered.string as NSString).range(of: "钟楼")
            let font = rendered.attribute(.font, at: bold.location, effectiveRange: nil) as? NSFont
            try require(rendered.string == "雨夜里，钟楼响了十二下。" && font?.fontDescriptor.symbolicTraits.contains(.bold) == true,
                "\(provider) Markdown-light rendering differs: \(rendered.string)")
            try require(harness.panel.transcriptTexts.first == "钟楼响了几下？" && harness.notices.isEmpty, "\(provider) transcript differs")
            if provider == .anthropic {
                try require(reply.thinking == "作者问钟声。", "Anthropic thinking was not kept")
            }
        }
        // Keys never reach a conversation file.
        harness.controller.store.flush()
        let files = try FileManager.default.contentsOfDirectory(at: harness.controller.store.directory, includingPropertiesForKeys: nil)
        try require(files.count == 3, "Each provider's conversation was not written: \(files.count)")
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            try require(!text.contains("synthetic-") && text.contains("钟楼响了几下？"), "A conversation file holds a key or lost the message")
        }
        try harness.close()
    }

    // MARK: (b) Tool loop

    private static func agentToolLoop() throws {
        let harness = try AgentHarness(titles: ["启程", "航行"])
        defer { harness.remove() }
        let view = try harness.open(0)
        try harness.type(view, "雨夜里钟声响起。")
        // list_chapters reads every chapter's summary in one nodes read.
        let projectID = harness.project.id, voyage = harness.chapters[1].id
        let _: WorkspaceNodeMetadata = try elementResult {
            harness.workspace.setNodeSummary(projectID: projectID, nodeID: voyage, summary: "船驶向北岸。", completion: $0)
        }
        var choice = AgentModelChoice.standard
        choice.thinking = .adaptive
        harness.controller.setChoice(choice)
        AgentStubProtocol.reset([
            AgentSSE.deepseekTools([("call_list", "list_chapters", "{}")], thinking: "先看章节列表。"),
            AgentSSE.deepseekTools([("call_read", "read_chapter", #"{"title":"启程"}"#)], thinking: "读第一章。"),
            AgentSSE.deepseekText(["《启程》写的是", "雨夜钟声。"]),
        ])
        try harness.send("第一章写了什么？")
        let requests = AgentStubProtocol.requests
        try require(requests.count == 3 && harness.notices.isEmpty, "The tool loop sent \(requests.count) requests: \(harness.notices)")
        let second = requests[1].body, third = requests[2].body
        try require(second["tool_choice"] == nil && (second["thinking"] as? [String: Any])?["type"] as? String == "enabled"
            && second["reasoning_effort"] as? String == "high", "DeepSeek thinking mode sent tool_choice or lacked thinking")
        let secondMessages = second["messages"] as? [[String: Any]] ?? []
        guard let call = secondMessages.first(where: { ($0["tool_calls"] as? [[String: Any]]) != nil }),
              let listed = secondMessages.last(where: { $0["role"] as? String == "tool" })?["content"] as? String else {
            throw LabError.message("The second request lacks the tool call or its result")
        }
        try require(call["reasoning_content"] as? String == "先看章节列表。"
            && ((call["tool_calls"] as? [[String: Any]])?.first?["function"] as? [String: Any])?["name"] as? String == "list_chapters",
            "reasoning_content was not replayed with the tool call")
        try require(listed.contains("启程") && listed.contains("航行") && listed.contains("\"order\":2") && listed.contains("船驶向北岸。"),
            "list_chapters result differs: \(listed)")
        let thirdMessages = third["messages"] as? [[String: Any]] ?? []
        let read = thirdMessages.last { $0["role"] as? String == "tool" }?["content"] as? String ?? ""
        try require(read.contains("雨夜里钟声响起。") && read.contains("\"title\":\"启程\""), "read_chapter did not read the live text: \(read)")
        try require(thirdMessages.filter { $0["reasoning_content"] != nil }.count == 2, "Both tool rounds did not replay reasoning_content")
        try require(harness.lastReply?.text == "《启程》写的是雨夜钟声。", "The final answer was not recorded")
        let texts = harness.panel.transcriptTexts
        try require(texts.contains("列出章节（2 章）") && texts.contains("读取《启程》") && texts.last == "《启程》写的是雨夜钟声。",
            "Activity lines or the answer were not rendered: \(texts)")

        // A loop that never ends stops after 24 rounds.
        AgentStubProtocol.reset((0..<30).map { AgentSSE.deepseekTools([("call_loop_\($0)", "list_chapters", "{}")], thinking: "再看一次。") })
        try harness.send("一直列章节。")
        try require(AgentStubProtocol.requests.count == AgentChatController.maxToolRounds
            && harness.notices.last?.contains("24 轮") == true, "The tool loop was not bounded: \(AgentStubProtocol.requests.count)")
        // Every tool call has its result before the next turn.
        AgentStubProtocol.reset([AgentSSE.deepseekText(["好的。"])])
        try harness.send("停下。")
        let body = AgentStubProtocol.requests[0].body["messages"] as? [[String: Any]] ?? []
        let calls = body.flatMap { ($0["tool_calls"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String } }
        let results = body.compactMap { $0["role"] as? String == "tool" ? $0["tool_call_id"] as? String : nil }
        try require(calls.count == 26 && calls == results, "Tool calls and results do not pair: \(calls.count) / \(results.count)")
        try require(body.filter { $0["reasoning_content"] != nil }.isEmpty, "An earlier turn replayed reasoning_content")
        try harness.close()
    }

    // MARK: (c) Review

    private static func agentRevisionReview() throws {
        let harness = try AgentHarness(titles: ["启程"])
        defer { harness.remove() }
        let chapter = harness.chapters[0]
        let view = try harness.open(0)
        try harness.type(view, "雨夜里钟声响起。")
        try harness.type(view, "\n她推开北塔的门。")
        let original = "雨夜里钟声响起。\n她推开北塔的门。"
        try require(view.textView.string == original, "The fixture text differs: \(view.textView.string)")

        AgentStubProtocol.reset([
            AgentSSE.deepseekTools([("call_revise", "revise_chapter",
                #"{"title":"启程","changes":[{"currentText":"钟声响起","revisedText":"钟声悠悠响起"}]}"#)]),
            AgentSSE.deepseekText(["我提出了一处修改。"]),
        ])
        try harness.send("让钟声更悠长。")
        guard let pending = harness.proposal("call_revise"), let card = harness.card("call_revise") else {
            throw LabError.message("The revision did not create a proposal card")
        }
        let toolResult = (AgentStubProtocol.requests[1].body["messages"] as? [[String: Any]])?.last { $0["role"] as? String == "tool" }?["content"] as? String ?? ""
        try require(pending.state == .pending && card.stateLabel.stringValue == "等待你的决定" && card.acceptButton.isEnabled
            && (harness.panel.element("agent-proposal-before-call_revise-0") as? AgentDiffBlock)?.text == "钟声响起"
            && (harness.panel.element("agent-proposal-after-call_revise-0") as? AgentDiffBlock)?.text == "钟声悠悠响起"
            && toolResult.contains("作者会在对话中接受或拒绝"), "The proposal card or the pending tool result differs")
        // Nothing is written before 接受.
        let before: WorkspaceAgentProse = try elementResult { harness.workspace.agentReadProse(projectID: harness.project.id, kind: "chapter", id: chapter.id, completion: $0) }
        try require(view.textView.string == original && before.text == original && before.live
            && harness.agentRevisions(chapter.id, call: "call_revise") == 0, "A proposal changed the chapter before 接受")

        card.acceptButton.performClick(nil)
        try wait { harness.proposal("call_revise")?.state != .applying && harness.proposal("call_revise")?.state != .pending }
        try elementSettled(harness.host, view)
        let revised = "雨夜里钟声悠悠响起。\n她推开北塔的门。"
        try require(harness.proposal("call_revise")?.state == .accepted && harness.card("call_revise")?.stateLabel.stringValue == "已接受"
            && harness.card("call_revise")?.acceptButton.superview == nil, "The accepted card differs")
        try require(view.textView.string == revised, "The open editor did not show the accepted revision: \(view.textView.string)")
        try require(harness.agentRevisions(chapter.id, call: "call_revise") == 1, "The revision lacks Agent provenance for its session and call")
        guard case .integer(let userRows)? = try WorkspaceRemoteProseFixture.query(in: harness.directory, sql: """
            SELECT COUNT(*) AS n FROM yjs_document_revision_provenance WHERE document_id = ? AND source_kind = 'user'
            """, parameters: [.text("node-content:\(chapter.id)")]).first?["n"], userRows > 0 else {
            throw LabError.message("The author's typing lost its user provenance")
        }
        let turn = try WorkspaceRemoteProseFixture.query(in: harness.directory, sql: """
            SELECT agent_turn_id AS turn FROM yjs_document_revision_provenance WHERE agent_call_id = 'call_revise'
            """).first?["turn"]
        try require(turn == .text(pending.turnID), "The provenance does not name the proposing turn")
        guard case .prose(_, "chapter", chapter.id, true)? = harness.effects.last else {
            throw LabError.message("The accepted revision did not report a live prose effect")
        }
        // One undo step in the open editor, then redo.
        view.undoProse(); try elementSettled(harness.host, view)
        try require(view.textView.string == original, "Undo did not revert the Agent revision: \(view.textView.string)")
        view.redoProse(); try elementSettled(harness.host, view)
        try require(view.textView.string == revised, "Redo did not restore the Agent revision")

        // 拒绝 leaves the text.
        AgentStubProtocol.reset([
            AgentSSE.deepseekTools([("call_reject", "revise_chapter",
                "{\"chapterId\":\"\(chapter.id)\",\"changes\":[{\"currentText\":\"北塔\",\"revisedText\":\"钟楼\"}]}")]),
            AgentSSE.deepseekText(["等你决定。"]),
        ])
        try harness.send("把北塔改成钟楼。")
        // That turn told the model the accepted outcome.
        let accepted = AgentHarness.lastUserText(AgentStubProtocol.requests[0].body)
        try require(accepted.contains("【运行提示】") && accepted.contains("作者当前打开：《启程》（章节）")
            && accepted.contains("call_revise") && accepted.contains("作者已接受") && accepted.contains("已应用 1 处修改")
            && accepted.hasSuffix("把北塔改成钟楼。"), "The accepted outcome was not reported: \(accepted)")
        guard let rejectCard = harness.card("call_reject") else { throw LabError.message("The second proposal has no card") }
        rejectCard.rejectButton.performClick(nil)
        try require(harness.proposal("call_reject")?.state == .rejected && harness.card("call_reject")?.stateLabel.stringValue == "已拒绝"
            && view.textView.string == revised && harness.agentRevisions(chapter.id, call: "call_reject") == 0, "拒绝 changed the chapter")

        // A proposal whose original the author changed is refused by Rust.
        AgentStubProtocol.reset([
            AgentSSE.deepseekTools([("call_refused", "revise_chapter",
                #"{"title":"启程","changes":[{"currentText":"推开","revisedText":"轻轻推开"}]}"#)]),
            AgentSSE.deepseekText(["提出了。"]),
        ])
        try harness.send("推门的动作轻一点。")
        // That turn told the model the rejection, and not the acceptance again.
        let decided = AgentHarness.lastUserText(AgentStubProtocol.requests[0].body)
        try require(decided.contains("call_reject") && decided.contains("作者已拒绝") && !decided.contains("call_revise")
            && decided.hasSuffix("推门的动作轻一点。"), "The rejected outcome was not reported once: \(decided)")
        let push = (view.textView.string as NSString).range(of: "推开")
        view.textView.insertText("拉开", replacementRange: push)
        try elementSettled(harness.host, view)
        let edited = "雨夜里钟声悠悠响起。\n她拉开北塔的门。"
        try require(view.textView.string == edited, "The author's edit did not land")
        harness.card("call_refused")?.acceptButton.performClick(nil)
        try wait { harness.proposal("call_refused")?.state == .failed }
        let refusal = harness.proposal("call_refused")?.message ?? ""
        try require(refusal.contains("正文中找不到要修改的原文") && refusal.contains("推开")
            && (harness.panel.element("agent-proposal-message-call_refused") as? NSTextField)?.stringValue == refusal
            && harness.card("call_refused")?.stateLabel.stringValue == "应用失败", "Rust's refusal was not shown: \(refusal)")
        try require(view.textView.string == edited && harness.agentRevisions(chapter.id, call: "call_refused") == 0, "A refused proposal wrote")

        // The next turn tells the model the failure; each outcome is told once.
        AgentStubProtocol.reset([AgentSSE.deepseekText(["明白。"]), AgentSSE.deepseekText(["好。"])])
        try harness.send("收到了吗？")
        let note = AgentHarness.lastUserText(AgentStubProtocol.requests[0].body)
        try require(note.contains("call_refused") && note.contains("应用失败") && note.contains("找不到要修改的原文")
            && !note.contains("call_revise") && !note.contains("call_reject") && note.hasSuffix("收到了吗？"),
            "The failure was not reported once: \(note)")
        try harness.send("还有吗？")
        let later = AgentHarness.lastUserText(AgentStubProtocol.requests[1].body)
        try require(!later.contains("提案"), "Outcomes were reported twice: \(later)")
        try require(!harness.panel.transcriptTexts.contains { $0.contains("运行提示") }, "The runtime note was shown as the author's words")
        try harness.close()
    }

    // MARK: (d) Stop and errors

    private static func agentStopAndErrors() throws {
        let harness = try AgentHarness(titles: ["启程"], keys: [.deepseek: "synthetic-deepseek-key-0001"])
        defer { harness.remove() }
        // A stalled stream: the first sentence arrives, then nothing.
        AgentStubProtocol.reset([AgentSSE.reply([["choices": [["index": 0, "delta": ["content": "第一句，"]]]]], hold: true)])
        harness.panel.composer.string = "写一段。"
        harness.panel.composer.didChangeText()
        harness.panel.sendButton.performClick(nil)
        try wait { harness.controller.streamingText == "第一句，" }
        let streaming = harness.panel.element("agent-streaming-text") as? NSTextField
        try require(streaming?.stringValue == "第一句，" && !harness.panel.stopButton.isHidden && !harness.panel.sendButton.isEnabled,
            "The streamed text or the stop button was not shown")
        harness.panel.stopButton.performClick(nil)
        try require(!harness.controller.isRunning, "停止 did not end the turn")
        try wait { AgentStubProtocol.stopped == 1 }
        try require(harness.lastReply?.text == "第一句，" && harness.lastReply?.stop == "cancelled" && harness.notices == ["已停止。"]
            && harness.panel.stopButton.isHidden && harness.panel.transcriptTexts.suffix(2) == ["第一句，", "已停止。"],
            "The partial reply or the stop notice differs: \(harness.panel.transcriptTexts)")
        // The conversation continues with the partial reply in its history.
        AgentStubProtocol.reset([AgentSSE.deepseekText(["继续。"])])
        try harness.send("接着写。")
        let history = AgentStubProtocol.requests[0].body["messages"] as? [[String: Any]] ?? []
        try require(history.contains { $0["role"] as? String == "assistant" && $0["content"] as? String == "第一句，" }
            && harness.lastReply?.text == "继续。", "The conversation did not continue after 停止")

        // A provider without a key sends nothing.
        var openai = AgentModelChoice.standard.with(provider: .openai)
        openai.thinking = .adaptive
        harness.controller.setChoice(openai)
        AgentStubProtocol.reset([])
        try harness.send("换个模型试试。")
        try require(AgentStubProtocol.requests.isEmpty && harness.notices.last == "还没有设置 OpenAI 的 API Key。请点击“设置…”填写后再发送。"
            && (harness.panel.transcriptTexts.last ?? "").contains("还没有设置 OpenAI 的 API Key"), "A missing key was not reported: \(harness.notices)")
        let row = harness.conversation.messages.last!
        try require((harness.panel.element("agent-notice-\(row.id)") as? NSTextField)?.textColor == .systemRed, "The error was not shown as an error")

        try harness.credentials.setKey("synthetic-openai-key-0003", for: .openai)
        let cases: [(AgentStubProtocol.Reply, String)] = [
            (AgentSSE.error(401, "Incorrect API key provided: synthetic-openai-****0003"), "OpenAI 拒绝了这个 API Key（HTTP 401）"),
            (AgentSSE.error(429, "Rate limit reached"), "OpenAI 请求过于频繁或额度已用尽（HTTP 429）"),
            (AgentStubProtocol.Reply(failure: .notConnectedToInternet), "无法连接 OpenAI：网络未连接"),
        ]
        for (reply, message) in cases {
            AgentStubProtocol.reset([reply])
            try harness.send("再试一次。")
            let notice = harness.notices.last ?? ""
            try require(notice.hasPrefix(message) && !notice.contains("Incorrect") && !notice.contains("synthetic"),
                "The error was not reported in Chinese: \(notice)")
            try require(AgentStubProtocol.requests.count == 1
                && AgentStubProtocol.requests[0].headers["authorization"] == "Bearer synthetic-openai-key-0003"
                && (AgentStubProtocol.requests[0].body["reasoning"] as? [String: Any])?["summary"] as? String == "auto"
                && (AgentStubProtocol.requests[0].body["include"] as? [String]) == ["reasoning.encrypted_content"],
                "The OpenAI thinking request differs")
        }
        harness.controller.store.flush()
        for file in try FileManager.default.contentsOfDirectory(at: harness.controller.store.directory, includingPropertiesForKeys: nil) {
            try require(!(try String(contentsOf: file, encoding: .utf8)).contains("synthetic-"), "A key reached a conversation file")
        }
        try harness.close()
    }

    // MARK: (e) Create and summary

    private static func agentCreateAndSummary() throws {
        let harness = try AgentHarness(titles: ["启程"])
        defer { harness.remove() }
        let chapter = harness.chapters[0]
        let view = try harness.open(0)
        try harness.type(view, "雨夜里钟声响起。")
        AgentStubProtocol.reset([
            AgentSSE.deepseekTools([("call_create", "create_chapter", #"{"title":"归岸","text":"潮水退去。\n她回到岸上。"}"#),
                                    ("call_summary", "set_chapter_summary", #"{"title":"启程","summary":"雨夜，钟声。"}"#)]),
            AgentSSE.deepseekText(["提出了两项提案。"]),
        ])
        try harness.send("新建一章《归岸》，再给第一章写个摘要。")
        try require(harness.proposal("call_create")?.state == .pending && harness.proposal("call_summary")?.state == .pending
            && harness.card("call_create")?.plainText.contains("在书末新建章节《归岸》，并写入初始正文") == true
            && (harness.panel.element("agent-proposal-after-call_create-0") as? AgentDiffBlock)?.text == "潮水退去。\n她回到岸上。"
            && (harness.panel.element("agent-proposal-after-call_summary-0") as? AgentDiffBlock)?.text == "雨夜，钟声。",
            "The parallel proposals were not both shown")
        let listed: [WorkspaceChapter] = try elementResult { harness.workspace.chapters(projectID: harness.project.id, completion: $0) }
        try require(listed.map(\.title) == ["启程"], "create_chapter wrote before 接受")

        harness.card("call_create")?.acceptButton.performClick(nil)
        try wait { harness.proposal("call_create")?.state == .accepted }
        let created: [WorkspaceChapter] = try elementResult { harness.workspace.chapters(projectID: harness.project.id, completion: $0) }
        guard case .chapterCreated(_, let chapterCreated)? = harness.effects.last else { throw LabError.message("No chapter effect") }
        try require(created.map(\.title) == ["启程", "归岸"] && chapterCreated.title == "归岸"
            && harness.proposal("call_create")?.message?.contains("并写入了初始正文") == true
            && harness.proposal("call_create")?.targetID == chapterCreated.id && harness.proposal("call_create")?.partial == nil,
            "The accepted chapter differs: \(harness.proposal("call_create")?.message ?? "")")
        // The opening text is the new chapter's body, written as the proposal's Agent append.
        let opening: WorkspaceAgentProse = try elementResult {
            harness.workspace.agentReadProse(projectID: harness.project.id, kind: "chapter", id: chapterCreated.id, completion: $0)
        }
        try require(opening.text == "潮水退去。\n她回到岸上。" && !opening.live
            && harness.agentRevisions(chapterCreated.id, call: "call_create") == 1, "The new chapter lacks its opening text: \(opening.text)")
        let createdView: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, chapter: chapterCreated, completion: $0) }
        try elementSettled(harness.host, createdView)
        try require(createdView.textView.string == "潮水退去。\n她回到岸上。" && createdView.binding.state?.projection.blocks.count == 2,
            "The new chapter page does not show two paragraphs: \(createdView.textView.string)")
        let _: NativeDocumentView = try elementResult { harness.host.open(project: harness.project, chapter: chapter, completion: $0) }
        try elementSettled(harness.host, view)

        harness.card("call_summary")?.acceptButton.performClick(nil)
        try wait { harness.proposal("call_summary")?.state == .accepted }
        let metadata: WorkspaceNodeMetadata = try elementResult {
            harness.workspace.nodeMetadata(projectID: harness.project.id, nodeID: chapter.id, completion: $0)
        }
        let page = harness.host.retainedChapterPage(pane: 0, scope: ChapterScope(projectID: harness.project.id, chapterID: chapter.id))
        try require(metadata.summary == "雨夜，钟声。" && page?.metadataEditor.summaryView.string == "雨夜，钟声。",
            "The accepted summary was not stored or shown")
        try require(view.textView.string == "雨夜里钟声响起。", "Metadata proposals changed the body")
        try harness.close()
    }

    // MARK: (f) Append

    private static func agentAppend() throws {
        let harness = try AgentHarness(titles: ["启程"])
        defer { harness.remove() }
        let chapter = harness.chapters[0]
        let view = try harness.open(0)
        try harness.type(view, "雨夜里钟声响起。")
        let original = "雨夜里钟声响起。"
        // Refused before any proposal: blank text, an unknown kind.
        AgentStubProtocol.reset([
            AgentSSE.deepseekTools([("call_blank", "append_to_body", #"{"kind":"chapter","name":"启程","text":"  \n "}"#),
                                    ("call_kind", "append_to_body", #"{"kind":"comment","name":"启程","text":"x"}"#),
                                    ("call_mixed", "revise_chapter", #"{"title":"启程","changes":[{"currentText":"雨夜","revisedText":"x","append":true}]}"#)]),
            AgentSSE.deepseekTools([("call_append", "append_to_body",
                #"{"kind":"chapter","name":"《启程》","text":"她推开北塔的门。\n风从海上来。"}"#)]),
            AgentSSE.deepseekText(["我提议续写两段。"]),
        ])
        try harness.send("接着写两段。")
        let refusals = harness.conversation.messages.filter { $0.role == .tool && $0.ok == false }.map(\.text)
        try require(refusals.count == 3 && refusals[0].contains("不能为空") && refusals[1].contains("kind")
            && refusals[2].contains("append_to_body") && harness.conversation.proposals.map(\.id) == ["call_append"],
            "Invalid appends were not refused before a proposal: \(refusals)")
        guard let card = harness.card("call_append"), let proposal = harness.proposal("call_append") else {
            throw LabError.message("The append has no proposal card")
        }
        try require(proposal.kind == .append && proposal.headline == "续写《启程》" && card.stateLabel.stringValue == "等待你的决定"
            && (harness.panel.element("agent-proposal-after-call_append-0") as? AgentDiffBlock)?.text == "她推开北塔的门。\n风从海上来。"
            && harness.panel.element("agent-proposal-before-call_append-0") == nil
            && harness.panel.transcriptTexts.contains("提议续写《启程》（14 字）"), "The append card differs: \(harness.panel.transcriptTexts)")
        try require(view.textView.string == original && harness.agentRevisions(chapter.id, call: "call_append") == 0,
            "An append proposal wrote before 接受")

        card.acceptButton.performClick(nil)
        try wait { harness.proposal("call_append")?.state == .accepted }
        try elementSettled(harness.host, view)
        let appended = "雨夜里钟声响起。\n她推开北塔的门。\n风从海上来。"
        try require(view.textView.string == appended && view.binding.state?.projection.blocks.count == 3
            && harness.proposal("call_append")?.message == "已追加到正文末尾。", "The open editor did not show the appended paragraphs: \(view.textView.string)")
        try require(harness.agentRevisions(chapter.id, call: "call_append") == 1, "The append lacks Agent provenance")
        guard case .prose(_, "chapter", chapter.id, true)? = harness.effects.last else {
            throw LabError.message("The append did not report a live prose effect")
        }
        view.undoProse(); try elementSettled(harness.host, view)
        try require(view.textView.string == original, "Undo did not remove the whole append: \(view.textView.string)")
        view.redoProse(); try elementSettled(harness.host, view)
        try require(view.textView.string == appended, "Redo did not restore the append")
        // The author keeps typing after it.
        try harness.type(view, "潮声。")
        try require(view.textView.string == appended + "潮声。", "Typing after the append was lost")
        try harness.close()
    }

    // MARK: (g) Persistence

    private static func agentPersistence() throws {
        let harness = try AgentHarness(titles: ["启程"])
        defer { harness.remove() }
        let view = try harness.open(0)
        try harness.type(view, "雨夜里钟声响起。")
        var choice = AgentModelChoice.standard.with(provider: .anthropic)
        choice.model = "claude-haiku-4-5-20251001"
        harness.controller.setChoice(choice)
        AgentStubProtocol.reset([
            AgentSSE.anthropicToolCalls([("toolu_keep", "revise_chapter",
                #"{"title":"启程","changes":[{"currentText":"雨夜","revisedText":"寒夜"}]}"#)]),
            AgentSSE.anthropicText(["等你决定。"]),
        ])
        try harness.send("把雨夜改成寒夜。")
        let second = AgentStubProtocol.requests[1].body["messages"] as? [[String: Any]] ?? []
        let blocks = second.flatMap { $0["content"] as? [[String: Any]] ?? [] }
        try require(blocks.contains { $0["type"] as? String == "tool_use" && $0["id"] as? String == "toolu_keep" }
            && blocks.contains { $0["type"] as? String == "tool_result" && $0["tool_use_id"] as? String == "toolu_keep" },
            "The Anthropic tool loop did not pair tool_use and tool_result")
        try require(harness.proposal("toolu_keep")?.state == .pending, "The proposal is not pending")
        let saved = harness.conversation
        let first = saved.id
        // A second, renamed conversation.
        harness.controller.newConversation()
        AgentStubProtocol.reset([AgentSSE.deepseekText(["好。"])])
        harness.controller.setChoice(.standard)
        try harness.send("第二个对话。")
        let secondID = harness.conversation.id
        harness.answer = { alert in
            (alert.accessoryView as? NSTextField)?.stringValue = "  钟声笔记  "
            return .alertFirstButtonReturn
        }
        harness.panel.renameButton.performClick(nil)
        try require(harness.conversation.title == "钟声笔记" && harness.panel.conversationPopup.titleOfSelectedItem == "钟声笔记", "Rename failed")
        harness.controller.store.flush()
        // Files live beside the lab workspace, one per conversation.
        let folder = harness.directory.deletingLastPathComponent().appendingPathComponent("agent").appendingPathComponent(harness.project.id)
        try require(harness.controller.store.directory.standardizedFileURL == folder.standardizedFileURL
            && FileManager.default.fileExists(atPath: folder.appendingPathComponent("\(first).json").path)
            && FileManager.default.fileExists(atPath: folder.appendingPathComponent("\(secondID).json").path)
            && (try FileManager.default.contentsOfDirectory(atPath: folder.path)).allSatisfy { $0.hasSuffix(".json") },
            "Conversation files are not atomic JSON beside the workspace")

        // Cold reopen: a new store, controller and panel read the files.
        let before = harness.controller.conversations.map(undated)
        harness.reopenPanel()
        try require(harness.controller.conversations.map(undated) == before && harness.controller.currentID == secondID
            && harness.panel.conversationPopup.itemTitles == ["钟声笔记", "把雨夜改成寒夜。"], "Conversations did not survive a cold reopen")
        harness.controller.select(first)
        try require(undated(harness.conversation) == undated(saved) && harness.conversation.choice.model == "claude-haiku-4-5-20251001"
            && harness.panel.modelPopup.titleOfSelectedItem == "Claude Haiku 4.5 · 快速"
            && harness.panel.transcriptTexts.contains("把雨夜改成寒夜。") && harness.panel.transcriptTexts.contains("等你决定。")
            && harness.panel.transcriptTexts.contains("提出修改《启程》（1 处）"), "The reopened transcript differs: \(harness.panel.transcriptTexts)")
        // The proposal still waits and applies after the reopen.
        guard let card = harness.card("toolu_keep"), card.acceptButton.isEnabled else { throw LabError.message("The reopened proposal cannot be accepted") }
        card.acceptButton.performClick(nil)
        try wait { harness.proposal("toolu_keep")?.state == .accepted }
        try elementSettled(harness.host, view)
        try require(view.textView.string == "寒夜里钟声响起。" && harness.agentRevisions(harness.chapters[0].id, call: "toolu_keep") == 1,
            "The reopened proposal did not apply with its original identity")
        harness.controller.store.flush()
        harness.reopenPanel()
        harness.controller.select(first)
        try require(harness.proposal("toolu_keep")?.state == .accepted && harness.card("toolu_keep")?.stateLabel.stringValue == "已接受",
            "The accepted state did not persist")

        // Delete asks first: 取消 keeps it, 删除 removes the file.
        harness.controller.select(secondID)
        harness.answer = { _ in .alertSecondButtonReturn }
        harness.panel.deleteButton.performClick(nil)
        try require(harness.controller.conversations.count == 2, "Delete did not wait for confirmation")
        harness.answer = { alert in alert.messageText.contains("钟声笔记") ? .alertFirstButtonReturn : .alertSecondButtonReturn }
        harness.panel.deleteButton.performClick(nil)
        harness.controller.store.flush()
        try require(harness.controller.conversations.map(\.id) == [first] && harness.controller.currentID == first
            && !FileManager.default.fileExists(atPath: folder.appendingPathComponent("\(secondID).json").path), "Delete did not remove the conversation")
        harness.reopenPanel()
        try require(harness.controller.conversations.map(\.id) == [first], "A deleted conversation came back")

        // The key sheet stores and clears keys; only a masked tail is shown.
        let sheet = MacAgentSettingsSheet(credentials: harness.credentials)
        let field = sheet.fields[.deepseek]!, state = sheet.states[.deepseek]!
        try require(state.stringValue == "已保存 ····0001", "A stored key was not masked: \(state.stringValue)")
        field.stringValue = "  synthetic-deepseek-key-0099\n"
        sheet.save(.deepseek)
        try require(try harness.credentials.key(for: .deepseek) == "synthetic-deepseek-key-0099" && field.stringValue.isEmpty
            && state.stringValue == "已保存 ····0099", "Saving a key failed")
        sheet.clear(.deepseek)
        try require(try harness.credentials.key(for: .deepseek) == nil && state.stringValue == "未设置", "Clearing a key failed")
        field.stringValue = "   "
        sheet.save(.deepseek)
        try require(!sheet.message.isHidden && sheet.message.stringValue == "API Key 不能为空。", "An empty key was accepted")
        try require(AgentCredentials.service == "Drifting Native Lab" && AgentCredentials.account(.deepseek) == "byok.deepseek",
            "The lab keychain namespace differs")
        try harness.close()
    }
}

extension AgentSSE {
    static func anthropicToolCalls(_ calls: [(id: String, name: String, arguments: String)]) -> AgentStubProtocol.Reply {
        var events: [[String: Any]] = [
            ["type": "message_start", "message": ["id": "msg_tool", "type": "message", "role": "assistant", "content": [],
                                                  "model": "claude-haiku-4-5-20251001", "usage": ["input_tokens": 80, "output_tokens": 1]]],
        ]
        for (index, call) in calls.enumerated() {
            events.append(["type": "content_block_start", "index": index, "content_block": ["type": "tool_use", "id": call.id, "name": call.name, "input": [:]]])
            let middle = call.arguments.index(call.arguments.startIndex, offsetBy: call.arguments.count / 2)
            for fragment in [String(call.arguments[..<middle]), String(call.arguments[middle...])] {
                events.append(["type": "content_block_delta", "index": index, "delta": ["type": "input_json_delta", "partial_json": fragment]])
            }
            events.append(["type": "content_block_stop", "index": index])
        }
        events += [
            ["type": "message_delta", "delta": ["stop_reason": "tool_use"], "usage": ["output_tokens": 40]],
            ["type": "message_stop"],
        ]
        return reply(events)
    }
}
