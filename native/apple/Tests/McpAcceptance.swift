import AppKit
import CryptoKit

/// MCP 扩展 through the real 写作助手 panel, controller, 设置 › 写作助手 ›
/// MCP 扩展 pane and hub: a synthetic stdio server (a Python script this
/// case writes into a temporary folder and runs with /usr/bin/python3)
/// and a Streamable HTTP stub (URLProtocol). Providers are stubbed as in
/// the other assistant cases; secrets live in the in-memory credential
/// store; nothing reaches the network and every value is synthetic.
extension BindingAcceptance {
    static func mcpAcceptance() throws -> [String] {
        try mcpHandshakeAndSettings()
        try mcpCallsAndPolicies()
        try mcpCrashesAndTimeouts()
        try mcpReconfigurationAndCleanup()
        try mcpStreamableHTTP()
        return [
            "AppKit MCP 扩展 adds a local-command server through the settings sheet, refuses invalid commands, folders, variable names and URLs in Chinese, runs the initialize and notifications/initialized handshake and paginated tools/list, shows 可用 N 个工具 with each tool's 允许/每次询问/禁用 policy (每次询问 by default) and skips a $ref schema with its reason, offers valid tools to the model as mcp__<server>__<tool> with their schemas, and keeps the secret environment value only in the Keychain store, never in settings.json",
            "AppKit MCP tool calls: 允许 calls at once with schema-checked arguments and returns text truncated to 16,000 characters with a note, summarises images and resources without storing them, reports isError; 每次询问 shows an approval card with tool, server and arguments and calls only after 允许一次, 拒绝 sends nothing, 停止 while waiting marks it 未执行; 禁用 tools leave the tool list and are refused; MCP results write nothing to the journal",
            "AppKit MCP server crash fails the running call without replaying it and restarts the server with its tools, stderr is kept as a bounded log and shown with 出错, a slow call times out with notifications/cancelled while the late answer is ignored, and a handshake that never answers reports 握手超时",
            "AppKit MCP reconfiguration through the sheet raises the revision, removes the old tools before the new connection and fails a call in flight on the old one; disabling, closing the project, quitting and deleting a server terminate the local command, and deletion removes its Keychain secrets",
            "AppKit MCP Streamable HTTP runs the handshake with JSON and SSE responses, sends the session id and protocol version on later requests and a secret Authorization header only from the Keychain, calls a tool, reconnects after an expired session without replaying the call and sends DELETE when disabled",
        ]
    }

    // MARK: Fixture

    fileprivate enum McpFixture {
        static let probeToken = "synthetic-probe-token-0001"
        static let httpToken = "Bearer synthetic-mcp-token-0001"

        static let script = #"""
        import sys, json, os, time, hashlib, base64
        mode = sys.argv[1] if len(sys.argv) > 1 else "basic"
        page = int(os.environ.get("MCP_FIXTURE_PAGE", "0") or "0")
        log_path = os.environ.get("MCP_FIXTURE_LOG", "")

        def log(entry):
            if log_path:
                with open(log_path, "a", encoding="utf-8") as handle:
                    handle.write(json.dumps(entry, ensure_ascii=False) + "\n")

        def send(message):
            sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
            sys.stdout.flush()

        def text(ident, value, error=False):
            result = {"content": [{"type": "text", "text": value}]}
            if error:
                result["isError"] = True
            send({"jsonrpc": "2.0", "id": ident, "result": result})

        def obj(properties, required=()):
            return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}

        BASIC = [
            {"name": "echo", "description": "重复一段文字。", "inputSchema": obj({"text": {"type": "string", "minLength": 1}, "times": {"type": "integer", "minimum": 1, "maximum": 5000}}, ["text"])},
            {"name": "media", "description": "返回图片和资源。", "inputSchema": obj({})},
            {"name": "probe", "description": "报告环境变量的摘要。", "inputSchema": obj({})},
            {"name": "pid", "description": "报告进程号。", "inputSchema": obj({})},
            {"name": "crash", "description": "让服务器退出。", "inputSchema": obj({})},
            {"name": "slow", "description": "很晚才回答。", "inputSchema": obj({})},
            {"name": "fail", "description": "报告工具错误。", "inputSchema": obj({})},
            {"name": "bad_schema", "description": "使用 $ref。", "inputSchema": {"type": "object", "properties": {"x": {"$ref": "#/$defs/x"}}}},
        ]
        ALT = [{"name": "alt_lookup", "description": "另一套工具。", "inputSchema": obj({"term": {"type": "string"}}, ["term"])}]
        tools = ALT if mode == "alt" else BASIC

        sys.stderr.write("fixture ready " + mode + "\n")
        sys.stderr.flush()
        log({"event": "start", "pid": os.getpid(), "mode": mode})
        if mode == "exit7":
            sys.stderr.write("合成的启动失败\n")
            sys.stderr.flush()
            sys.exit(7)

        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            message = json.loads(line)
            method = message.get("method")
            ident = message.get("id")
            params = message.get("params") or {}
            log({"event": "message", "method": method, "id": ident, "params": params})
            if ident is None or mode == "hang":
                continue
            if method == "initialize":
                send({"jsonrpc": "2.0", "id": ident, "result": {"protocolVersion": "2025-06-18", "capabilities": {"tools": {"listChanged": True}},
                                                               "serverInfo": {"name": "synthetic-stdio", "version": "1.0"}}})
            elif method == "tools/list":
                start = int(params["cursor"][1:]) if params.get("cursor") else 0
                size = page or len(tools)
                result = {"tools": tools[start:start + size]}
                if start + size < len(tools):
                    result["nextCursor"] = "p" + str(start + size)
                send({"jsonrpc": "2.0", "id": ident, "result": result})
            elif method == "tools/call":
                name = params.get("name")
                args = params.get("arguments") or {}
                if name == "echo":
                    text(ident, args.get("text", "") * int(args.get("times", 1)))
                elif name == "media":
                    data = base64.b64encode(bytes(range(256)) * 12).decode()
                    send({"jsonrpc": "2.0", "id": ident, "result": {"content": [
                        {"type": "text", "text": "媒体结果"},
                        {"type": "image", "data": data, "mimeType": "image/png"},
                        {"type": "resource", "resource": {"uri": "file:///synthetic/notes.txt", "mimeType": "text/plain", "text": "资源正文" * 50}},
                        {"type": "resource_link", "uri": "file:///synthetic/map.png", "name": "地图"}]}})
                elif name == "probe":
                    token = os.environ.get("PROBE_TOKEN", "")
                    text(ident, "sha256:" + hashlib.sha256(token.encode()).hexdigest() + ";public:" + os.environ.get("PUBLIC_FLAG", ""))
                elif name == "pid":
                    text(ident, str(os.getpid()))
                elif name == "crash":
                    sys.stderr.write("合成的崩溃\n")
                    sys.stderr.flush()
                    os._exit(3)
                elif name == "slow":
                    time.sleep(1.5)
                    text(ident, "迟到的结果")
                elif name == "fail":
                    text(ident, "合成的工具错误", error=True)
                elif name == "alt_lookup":
                    text(ident, "查到：" + args.get("term", ""))
                else:
                    send({"jsonrpc": "2.0", "id": ident, "error": {"code": -32602, "message": "unknown tool"}})
            elif method == "ping":
                send({"jsonrpc": "2.0", "id": ident, "result": {}})
            else:
                send({"jsonrpc": "2.0", "id": ident, "error": {"code": -32601, "message": "method not found"}})
        """#
    }

    fileprivate final class McpHarness {
        let agent: AgentHarness
        let settings: LabSettingsStore
        let hub: AgentMcpHub
        let pane: MacMcpSettingsViewController
        let paneWindow: NSWindow
        let folder: URL
        let script: URL
        let log: URL
        let journal: JournalProbe
        var answer: ((NSAlert) -> NSApplication.ModalResponse)?

        init() throws {
            agent = try AgentHarness(titles: ["启程"])
            folder = agent.directory.deletingLastPathComponent().appendingPathComponent("mcp-fixture", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            script = folder.appendingPathComponent("server.py")
            try McpFixture.script.write(to: script, atomically: true, encoding: .utf8)
            log = folder.appendingPathComponent("server-log.jsonl")
            journal = JournalProbe(directory: agent.directory)
            let settings = LabSettingsStore(directory: agent.workspace.dataDirectory)
            self.settings = settings
            let projectID = agent.project.id, name = agent.project.name
            let hub = AgentMcpHub(projectID: projectID, secrets: agent.credentials) { settings.mcpServers(projectID: projectID) }
            hub.urlConfiguration = McpHTTPStub.configuration
            hub.handshakeTimeout = 5
            hub.callTimeout = 5
            hub.restartDelays = [0.2, 0.4, 0.6]
            self.hub = hub
            agent.controller.mcp = hub
            hub.activate()
            pane = MacMcpSettingsViewController(store: settings)
            pane.secrets = agent.credentials
            pane.presentSheet = { _ in }
            paneWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
            paneWindow.isReleasedWhenClosed = false
            paneWindow.contentViewController = pane
            pane.presentAlert = { [weak self] alert, done in done(self?.answer?(alert) ?? .alertSecondButtonReturn) }
            pane.source = { MacMcpSettingsViewController.Project(id: projectID, name: name, hub: hub) }
        }

        var projectID: String { agent.project.id }
        var controller: AgentChatController { agent.controller }

        /// 添加服务器… through the sheet; returns the refusal, if any.
        @discardableResult
        func addStdio(name: String, mode: String, variables: [(String, String, Bool)] = [], command: String = "/usr/bin/python3",
                      folder: String = "") throws -> String? {
            pane.addButton.performClick(nil)
            guard let sheet = pane.sheet else { throw LabError.message("添加服务器… did not open the sheet") }
            sheet.nameField.stringValue = name
            sheet.transportControl.selectedSegment = 0
            sheet.transportChanged()
            sheet.commandField.stringValue = command
            sheet.argumentsView.string = "\(script.path)\n\(mode)"
            sheet.folderField.stringValue = folder
            sheet.environment.add(name: "MCP_FIXTURE_LOG", value: log.path, secret: false)
            for (name, value, secret) in variables { sheet.environment.add(name: name, value: value, secret: secret) }
            sheet.saveButton.performClick(nil)
            if pane.sheet != nil {
                let refusal = sheet.message.stringValue
                sheet.cancelButton.performClick(nil)
                return refusal
            }
            return nil
        }

        func config(named name: String) throws -> AgentMcpServerConfig {
            guard let config = settings.mcpServers(projectID: projectID).first(where: { $0.name == name }) else {
                throw LabError.message("No server named \(name)")
            }
            return config
        }

        func ready(_ id: String, file: String = #fileID, line: Int = #line) throws {
            try BindingAcceptance.wait(file: file, line: line) { self.hub.server(id)?.isReady == true }
        }

        func row(_ id: String) throws -> MacMcpServerRow {
            guard let row = pane.rows[id] else { throw LabError.message("The pane has no row for \(id)") }
            return row
        }

        /// Everything the stdio fixture logged, in order.
        func entries() -> [[String: Any]] {
            guard let text = try? String(contentsOf: log, encoding: .utf8) else { return [] }
            return text.split(separator: "\n").compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
        }

        func calls(_ tool: String) -> Int {
            entries().filter { $0["method"] as? String == "tools/call" && ($0["params"] as? [String: Any])?["name"] as? String == tool }.count
        }

        func methods(_ method: String) -> [[String: Any]] { entries().filter { $0["method"] as? String == method } }

        /// Process ids of every start, in order.
        var starts: [Int32] { entries().filter { $0["event"] as? String == "start" }.compactMap { ($0["pid"] as? NSNumber)?.int32Value } }

        /// Presses 发送 without waiting for the turn.
        func start(_ text: String) throws {
            agent.panel.composer.string = text
            agent.panel.composer.didChangeText()
            agent.panel.sendButton.performClick(nil)
            try BindingAcceptance.require(controller.isRunning, "The panel did not send \(text)")
        }

        /// One round of tool calls, then a short answer; waits for the turn.
        func turn(_ calls: [(id: String, name: String, arguments: String)], _ text: String) throws {
            AgentStubProtocol.reset([AgentSSE.deepseekTools(calls), AgentSSE.deepseekText(["好。"])])
            try agent.send(text)
        }

        func result(_ callID: String) -> AgentMessage? {
            agent.conversation.messages.last { $0.role == .tool && $0.callID == callID }
        }

        func approval(_ callID: String) -> AgentMessage? {
            agent.conversation.messages.last { $0.mcp?.callID == callID }
        }

        func card(_ callID: String) -> AgentMcpApprovalCard? {
            approval(callID).flatMap { agent.panel.element("agent-mcp-approval-\($0.id)") as? AgentMcpApprovalCard }
        }

        func close() throws {
            hub.shutdown()
            paneWindow.close()
            try agent.close()
        }
    }

    static func mcpArguments(_ value: [String: Any]) -> String { AgentJSONText.encode(value) }

    /// A process that has exited (and been reaped) no longer answers signal 0.
    static func processGone(_ pid: Int32) -> Bool { kill(pid, 0) != 0 && errno == ESRCH }

    static func sha256(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }

    /// The provider-facing tool names of a captured DeepSeek request.
    static func mcpToolNames(_ body: [String: Any]) -> [String] {
        (body["tools"] as? [[String: Any]] ?? []).compactMap { ($0["function"] as? [String: Any])?["name"] as? String }
    }

    // MARK: (a) Handshake, listing and settings

    private static func mcpHandshakeAndSettings() throws {
        let harness = try McpHarness()
        defer { harness.agent.remove() }
        let pane = harness.pane
        try require(pane.projectLabel.stringValue == "项目《写作助手合成项目》的 MCP 服务器" && pane.rows.isEmpty, "The empty pane differs")

        // Refusals, in Chinese, keep the sheet open and store nothing.
        let missing = try harness.addStdio(name: "坏命令", mode: "basic", command: "/usr/bin/no-such-mcp-server")
        let relative = try harness.addStdio(name: "相对路径", mode: "basic", command: "python3")
        let badFolder = try harness.addStdio(name: "坏文件夹", mode: "basic", folder: "/no/such/folder")
        let badVariable = try harness.addStdio(name: "坏变量", mode: "basic", variables: [("1BAD", "x", false)])
        let blank = try harness.addStdio(name: "  ", mode: "basic")
        try require(missing == "找不到可执行文件：/usr/bin/no-such-mcp-server。" && relative == "命令必须是可执行文件的完整路径（以 / 开头）。"
            && badFolder == "找不到工作文件夹：/no/such/folder。" && badVariable?.hasPrefix("环境变量名“1BAD”无效") == true
            && blank == "请填写服务器名称。" && harness.settings.mcpServers(projectID: harness.projectID).isEmpty,
            "Refusals differ: \([missing, relative, badFolder, badVariable, blank])")
        let noSecret = try harness.addStdio(name: "缺密钥", mode: "basic", variables: [("PROBE_TOKEN", "", true)])
        try require(noSecret == "请填写密钥环境变量“PROBE_TOKEN”的值。", "A secret without a value was accepted: \(noSecret ?? "")")
        try require(AgentMcpValidation.urlProblem("http://example.com/mcp")?.hasPrefix("服务器地址必须以 https:// 开头") == true
            && AgentMcpValidation.urlProblem("http://localhost:8123/mcp") == nil
            && AgentMcpValidation.urlProblem("https://user:pass@example.com/mcp")?.contains("用户名或密码") == true, "URL checks differ")

        // A server with a secret and a public variable, listed in pages of three.
        let refused = try harness.addStdio(name: "lore 资料", mode: "basic", variables: [
            ("MCP_FIXTURE_PAGE", "3", false), ("PUBLIC_FLAG", "公开值", false), ("PROBE_TOKEN", McpFixture.probeToken, true),
        ])
        try require(refused == nil, "The server was refused: \(refused ?? "")")
        let config = try harness.config(named: "lore 资料")
        try require(config.enabled && config.transport == .stdio && config.toolPolicies.isEmpty && config.revision == 1
            && config.environment.map(\.name) == ["MCP_FIXTURE_LOG", "MCP_FIXTURE_PAGE", "PUBLIC_FLAG", "PROBE_TOKEN"]
            && config.environment.last?.secret == true && config.environment.last?.value == "", "The stored server differs: \(config)")
        try require(harness.hub.server(config.id)?.health == .connecting || harness.hub.server(config.id)?.isReady == true,
            "Saving did not start the connection")
        try harness.ready(config.id)
        let server = harness.hub.server(config.id)!
        try require(server.health == .ready(7) && server.health.label == "可用 7 个工具" && server.serverInfo == "synthetic-stdio 1.0",
            "The server's health differs: \(server.health.label)")
        // The handshake, then three pages.
        let methods = harness.entries().compactMap { $0["method"] as? String }
        let cursors = harness.methods("tools/list").map { (($0["params"] as? [String: Any])?["cursor"] as? String) ?? "" }
        try require(Array(methods.prefix(2)) == ["initialize", "notifications/initialized"] && cursors == ["", "p3", "p6"],
            "The handshake or pages differ: \(methods) \(cursors)")
        let initialize = harness.methods("initialize").first?["params"] as? [String: Any]
        try require(initialize?["protocolVersion"] as? String == "2025-06-18"
            && (initialize?["clientInfo"] as? [String: Any])?["name"] as? String == "Drifting Native Lab", "initialize differs: \(initialize ?? [:])")

        // The pane shows health, tools, policies and the skipped schema.
        let row = try harness.row(config.id)
        try require(row.statusLabel.stringValue == "可用 7 个工具" && row.enabledCheckbox.state == .on
            && row.toolLines == ["echo", "media", "probe", "pid", "crash", "slow", "fail",
                                 "bad_schema · 已跳过：输入参数的结构使用了 $ref（$.properties.x），暂不支持。"]
            && row.policies.values.allSatisfy { $0.titleOfSelectedItem == "每次询问" } && row.policies["echo"]?.itemTitles == ["允许", "每次询问", "禁用"],
            "The row differs: \(row.statusLabel.stringValue) \(row.toolLines)")
        try require(harness.hub.prefix(config.id) == "mcp__lore__", "The prefix differs")

        // The model gets the valid tools with their schemas.
        AgentStubProtocol.reset([AgentSSE.deepseekText(["看到了。"])])
        try harness.agent.send("有哪些外部工具？")
        let body = AgentStubProtocol.requests[0].body
        let names = mcpToolNames(body)
        let echo = (body["tools"] as? [[String: Any]] ?? []).first { ($0["function"] as? [String: Any])?["name"] as? String == "mcp__lore__echo" }
        let parameters = (echo?["function"] as? [String: Any])?["parameters"] as? [String: Any]
        try require(names.count == 63 + 7 && names.suffix(7) == ["mcp__lore__echo", "mcp__lore__media", "mcp__lore__probe", "mcp__lore__pid",
                                                                   "mcp__lore__crash", "mcp__lore__slow", "mcp__lore__fail"]
            && !names.contains { $0.contains("bad_schema") } && (parameters?["required"] as? [String]) == ["text"]
            && ((echo?["function"] as? [String: Any])?["description"] as? String)?.hasPrefix("［MCP · lore 资料］重复一段文字。") == true,
            "The model's tools differ: \(names.suffix(8))")
        let system = (body["messages"] as? [[String: Any]])?.first?["content"] as? String ?? ""
        try require(system.contains("外部工具：名称以 mcp__ 开头的工具来自作者添加的 MCP 服务器（“lore 资料”）"), "The prompt lacks the MCP note")

        // Secrets: only in the Keychain store, never in settings.json.
        let account = AgentMcpSecrets.account(projectID: harness.projectID, serverID: config.id, header: false, name: "PROBE_TOKEN")
        let stored = try String(contentsOf: harness.settings.fileURL, encoding: .utf8)
        try require(harness.agent.credentials.secrets[account] == McpFixture.probeToken && !stored.contains(McpFixture.probeToken)
            && stored.contains("PROBE_TOKEN") && stored.contains("mcpServers") && stored.contains("公开值"),
            "The secret reached settings.json or missed the Keychain")
        // A relaunch reads the same servers.
        let reread = LabSettingsStore(directory: harness.agent.workspace.dataDirectory)
        try require(reread.mcpServers(projectID: harness.projectID) == harness.settings.mcpServers(projectID: harness.projectID),
            "settings.json did not read back")
        // 设置 › 写作助手 has the 用量 and MCP 扩展 tabs.
        let window = MacSettingsWindowController(store: harness.settings)
        window.showMcpPane()
        try require(window.agentPane.sections?.tabViewItems.map(\.label) == ["用量", "MCP 扩展"]
            && window.agentPane.sections?.selectedTabViewItem?.label == "MCP 扩展" && window.mcpPane.title == "MCP 扩展",
            "设置 › 写作助手 lacks the MCP 扩展 tab")
        window.close()
        try harness.close()
    }

    // MARK: (b) Calls and policies

    private static func mcpCallsAndPolicies() throws {
        let harness = try McpHarness()
        defer { harness.agent.remove() }
        try harness.addStdio(name: "lore", mode: "basic", variables: [("PROBE_TOKEN", McpFixture.probeToken, true), ("PUBLIC_FLAG", "on", false)])
        let config = try harness.config(named: "lore")
        try harness.ready(config.id)
        let mark = try harness.journal.mark()
        for tool in ["echo", "media", "probe", "fail"] { try harness.row(config.id).choose(.allow, for: tool) }
        try require(harness.settings.mcpServers(projectID: harness.projectID).first?.toolPolicies
            == ["echo": .allow, "media": .allow, "probe": .allow, "fail": .allow], "Policies were not stored")
        try require(harness.hub.tool(named: "mcp__lore__echo")?.policy == .allow && harness.hub.server(config.id)?.isReady == true,
            "A policy change reconnected or did not apply")

        // 允许: schema-checked arguments, then one call with a truncated result.
        try harness.turn([("call_bad", "mcp__lore__echo", mcpArguments(["text": "钟声", "times": 9_000])),
                          ("call_echo", "mcp__lore__echo", mcpArguments(["text": "钟声回响。", "times": 4_000])),
                          ("call_media", "mcp__lore__media", "{}"),
                          ("call_probe", "mcp__lore__probe", "{}"),
                          ("call_fail", "mcp__lore__fail", "{}")], "用外部工具查一下。")
        let bad = harness.result("call_bad"), echo = harness.result("call_echo")
        try require(bad?.ok == false && bad?.text == "参数 times 不能大于 5000。请按工具说明重新调用。" && harness.calls("echo") == 1,
            "A schema violation was sent: \(bad?.text ?? "")")
        let expected = String(repeating: "钟声回响。", count: 4_000)
        try require(echo?.ok == true && echo?.text == String(expected.prefix(16_000)) + "\n（结果过长，只保留了前 16000 字；原结果共 20000 字。）"
            && echo?.activity == "调用MCP 工具「echo」（lore）（20000 字，已截断）", "The truncated result differs: \(echo?.activity ?? "")")
        let echoCall = harness.methods("tools/call").first { (($0["params"] as? [String: Any])?["name"] as? String) == "echo" }
        try require(((echoCall?["params"] as? [String: Any])?["arguments"] as? [String: Any])?["times"] as? Int == 4_000,
            "The call's arguments differ")
        let media = harness.result("call_media")?.text ?? ""
        try require(media == "媒体结果\n［图片，image/png，约 3 KB，没有保存］\n［资源 file:///synthetic/notes.txt，text/plain，200 字的内容没有展开］\n［资源链接 “地图” file:///synthetic/map.png］",
            "The media summary differs: \(media)")
        try require(harness.result("call_probe")?.text == "sha256:\(sha256(McpFixture.probeToken));public:on", "The secret did not reach the server")
        try require(harness.result("call_fail")?.ok == false && harness.result("call_fail")?.text == "MCP 工具报告了错误：合成的工具错误",
            "isError differs: \(harness.result("call_fail")?.text ?? "")")
        harness.controller.store.flush()
        let file = try String(contentsOf: harness.controller.store.directory.appendingPathComponent("\(harness.agent.conversation.id).json"), encoding: .utf8)
        try require(!file.contains("AAECAwQF") && !file.contains(String(repeating: "资源正文", count: 50)), "Media bytes were stored")
        try require(harness.agent.panel.transcriptTexts.contains("调用MCP 工具「media」（lore）（\(media.count) 字）"), "The activity line is missing")

        // 每次询问: the card, then 允许一次.
        AgentStubProtocol.reset([AgentSSE.deepseekTools([("call_pid", "mcp__lore__pid", "{}")]), AgentSSE.deepseekText(["进程号拿到了。"])])
        try harness.start("进程号是多少？")
        try wait { harness.card("call_pid") != nil }
        let card = harness.card("call_pid")!
        try require(harness.controller.isRunning && card.plainText == "允许调用 MCP 工具？\n等待你的决定\n工具：pid\n服务器：lore\n参数：\n（无参数）"
            && card.allowButton.isEnabled && harness.calls("pid") == 0 && harness.controller.activity == "等待你允许调用MCP 工具「pid」（lore）…",
            "The approval card differs: \(card.plainText)")
        card.allowButton.performClick(nil)
        try wait { !harness.controller.isRunning }
        let pidCall = harness.result("call_pid")
        try require(harness.calls("pid") == 1 && pidCall?.ok == true && Int32(pidCall?.text ?? "") == harness.starts.last
            && harness.approval("call_pid")?.mcp?.state == .allowed && harness.card("call_pid")?.plainText.contains("已允许一次") == true
            && harness.card("call_pid")?.allowButton.superview == nil, "允许一次 differs: \(pidCall?.text ?? "")")

        // 拒绝 sends nothing.
        AgentStubProtocol.reset([AgentSSE.deepseekTools([("call_pid_2", "mcp__lore__pid", mcpArguments([:]))]), AgentSSE.deepseekText(["好。"])])
        try harness.start("再看一次进程号。")
        try wait { harness.card("call_pid_2") != nil }
        harness.card("call_pid_2")!.denyButton.performClick(nil)
        try wait { !harness.controller.isRunning }
        try require(harness.calls("pid") == 1 && harness.result("call_pid_2")?.ok == false
            && harness.result("call_pid_2")?.text == "作者拒绝了这次调用，工具没有执行。除非作者要求，不要再请求同样的调用。"
            && harness.approval("call_pid_2")?.mcp?.state == .denied, "拒绝 differs")
        let deniedBody = AgentStubProtocol.requests.last?.body["messages"] as? [[String: Any]] ?? []
        try require(deniedBody.contains { $0["role"] as? String == "tool" && ($0["content"] as? String)?.hasPrefix("工具失败：作者拒绝了这次调用") == true },
            "The model was not told of the refusal")

        // 停止 while waiting: the call is 未执行.
        AgentStubProtocol.reset([AgentSSE.deepseekTools([("call_pid_3", "mcp__lore__pid", "{}"), ("call_after", "list_chapters", "{}")])])
        try harness.start("第三次。")
        try wait { harness.card("call_pid_3") != nil }
        harness.agent.panel.stopButton.performClick(nil)
        try require(!harness.controller.isRunning && harness.approval("call_pid_3")?.mcp?.state == .cancelled
            && harness.card("call_pid_3")?.plainText.contains("未执行") == true && harness.result("call_after")?.ok == false
            && harness.agent.notices.last == "已停止。" && harness.calls("pid") == 1, "停止 during approval differs")
        // A relaunch shows the waiting card as 未执行 too.
        harness.controller.store.flush()
        let conversation = harness.agent.conversation.id
        let reloaded = harness.controller.store.load().first { $0.id == conversation }
        try require(reloaded?.messages.first { $0.mcp?.callID == "call_pid_3" }?.mcp?.state == .cancelled, "The stopped card did not persist")

        // 禁用: the tool leaves the list and a call to it is refused.
        try harness.row(config.id).choose(.deny, for: "echo")
        try harness.turn([("call_denied", "mcp__lore__echo", mcpArguments(["text": "x"]))], "再重复一次。")
        let names = mcpToolNames(AgentStubProtocol.requests[0].body)
        try require(!names.contains("mcp__lore__echo") && names.contains("mcp__lore__media") && harness.calls("echo") == 1
            && harness.result("call_denied")?.text.hasPrefix("这个 MCP 工具现在不可用") == true, "禁用 differs: \(names.suffix(7))")
        // An unknown provider name is refused the same way.
        try harness.turn([("call_ghost", "mcp__ghost__tool", "{}")], "试一个不存在的。")
        try require(harness.result("call_ghost")?.ok == false, "An unknown MCP tool ran")
        // MCP results never reach the book.
        try harness.journal.expect([], since: mark, "MCP calls")
        try harness.close()
    }

    // MARK: (c) Crashes, logs and timeouts

    private static func mcpCrashesAndTimeouts() throws {
        let harness = try McpHarness()
        defer { harness.agent.remove() }
        harness.hub.callTimeout = 0.5
        try harness.addStdio(name: "lore", mode: "basic")
        let config = try harness.config(named: "lore")
        try harness.ready(config.id)
        for tool in ["crash", "echo", "slow"] { try harness.row(config.id).choose(.allow, for: tool) }
        let first = harness.starts
        try require(first.count == 1, "The server started \(first.count) times")

        // A crash fails the running call once; the server restarts with its tools.
        try harness.turn([("call_crash", "mcp__lore__crash", "{}")], "让它崩溃。")
        let crash = harness.result("call_crash")
        try require(crash?.ok == false && crash?.text == "调用失败：服务器进程意外退出（退出码 3）。", "The crash result differs: \(crash?.text ?? "")")
        try wait { harness.hub.server(config.id)?.isReady == true && harness.starts.count == 2 }
        try require(harness.calls("crash") == 1 && processGone(first[0]) && harness.starts[1] != first[0], "The crashed call was replayed or not restarted")
        try harness.turn([("call_after_crash", "mcp__lore__echo", mcpArguments(["text": "又好了"]))], "再试一次。")
        try require(harness.result("call_after_crash")?.text == "又好了", "The restarted server did not answer")

        // A slow call times out and is cancelled; its late answer is ignored.
        try harness.turn([("call_slow", "mcp__lore__slow", "{}")], "慢慢来。")
        let slow = harness.result("call_slow")
        try require(slow?.ok == false && slow?.text == "调用失败：MCP 工具在 0.5 秒内没有回应。调用已取消，不会自动重试。", "The timeout differs: \(slow?.text ?? "")")
        try wait { !harness.methods("notifications/cancelled").isEmpty }
        let cancelled = harness.methods("notifications/cancelled").first?["params"] as? [String: Any]
        try require((cancelled?["requestId"] as? String)?.hasPrefix("rpc-") == true, "notifications/cancelled differs")
        pump(1.6)
        try require(harness.hub.server(config.id)?.isReady == true && harness.calls("slow") == 1, "The late answer broke the connection")

        // A server that fails at start retries three times, then shows 出错
        // with its standard error until 重新连接.
        try harness.addStdio(name: "exit", mode: "exit7")
        let exiting = try harness.config(named: "exit")
        let exits = { harness.entries().filter { $0["event"] as? String == "start" && $0["mode"] as? String == "exit7" }.count }
        try wait {
            if case .failed(let message) = harness.hub.server(exiting.id)?.health, message.hasPrefix("服务器进程意外退出（退出码 7）。") {
                return message.contains("自动重新连接（第 1/3 次）")
            }
            return false
        }
        try wait {
            guard case .failed(let message) = harness.hub.server(exiting.id)?.health else { return false }
            return !message.contains("自动重新连接") && exits() == 4 && harness.hub.server(exiting.id)?.log.contains("合成的启动失败") == true
        }
        harness.pane.refresh()
        let exitRow = try harness.row(exiting.id)
        try require(exitRow.statusLabel.stringValue == "出错：服务器进程意外退出（退出码 7）。" && exitRow.logLabel.stringValue.contains("合成的启动失败")
            && harness.hub.server(exiting.id)!.log.count <= AgentMcpStdioRPC.stderrLimit,
            "The failed row differs: \(exitRow.statusLabel.stringValue) / \(exitRow.logLabel.stringValue)")
        pump(0.8)
        try require(exits() == 4, "A server kept restarting after its retries")
        exitRow.reconnectButton.performClick(nil)
        try wait { exits() == 5 }
        harness.pane.setEnabled(exiting.id, false)

        // A handshake that never answers reports 握手超时.
        harness.hub.handshakeTimeout = 0.5
        harness.hub.restartDelays = []
        try harness.addStdio(name: "hang", mode: "hang")
        let hanging = try harness.config(named: "hang")
        try wait { if case .failed = harness.hub.server(hanging.id)?.health { return true }; return false }
        try require(harness.hub.server(hanging.id)?.health.label == "出错：握手超时：initialize 0.5 秒内没有回应。"
            && !harness.hub.visibleTools.contains { $0.serverID == hanging.id }, "The handshake timeout differs: \(harness.hub.server(hanging.id)?.health.label ?? "")")
        try harness.close()
    }

    private static func pump(_ seconds: TimeInterval) {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
    }

    // MARK: (d) Reconfiguration and process cleanup

    private static func mcpReconfigurationAndCleanup() throws {
        let harness = try McpHarness()
        defer { harness.agent.remove() }
        try harness.addStdio(name: "lore", mode: "basic", variables: [("PROBE_TOKEN", McpFixture.probeToken, true)])
        var config = try harness.config(named: "lore")
        try harness.ready(config.id)
        let firstPID = harness.hub.server(config.id)!.processID!
        try require(!processGone(firstPID) && harness.starts == [firstPID], "The first process is not running")

        // A call in flight on the old connection fails when it is replaced.
        harness.hub.callTimeout = 10
        var inflight: Result<AgentMcpCallResult, AgentMcpError>?
        let request = harness.hub.call("mcp__lore__slow", arguments: [:]) { inflight = $0 }
        try require(request != nil, "The slow call was not sent")
        try wait { harness.calls("slow") == 1 }

        // 编辑… : a new argument replaces the connection and its tools.
        try harness.row(config.id).editButton.performClick(nil)
        guard let sheet = harness.pane.sheet else { throw LabError.message("编辑… did not open the sheet") }
        try require(sheet.nameField.stringValue == "lore" && sheet.environment.rows.count == 2
            && sheet.environment.rows[1].valueField is NSSecureTextField && sheet.environment.rows[1].valueField.stringValue.isEmpty
            && sheet.environment.rows[1].valueField.placeholderString == "已保存在钥匙串，留空保持不变", "The edit sheet differs")
        sheet.argumentsView.string = "\(harness.script.path)\nalt"
        sheet.saveButton.performClick(nil)
        // At once, before the new connection answers: none of the old tools.
        let toolsAtSave = harness.hub.visibleTools.map(\.providerName)
        config = try harness.config(named: "lore")
        guard case .some(.failure(let replaced)) = inflight else { throw LabError.message("The call in flight did not fail: \(String(describing: inflight))") }
        try require(toolsAtSave.isEmpty && harness.hub.server(config.id)?.health == .connecting && config.revision == 2
            && replaced.message == "服务器已停用或重新配置，这次调用没有完成（不会自动重试）。", "Reconfiguration differs: \(toolsAtSave) \(replaced.message)")
        try harness.ready(config.id)
        try wait { processGone(firstPID) }
        try require(harness.hub.visibleTools.map(\.providerName) == ["mcp__lore__alt_lookup"] && harness.starts.count == 2
            && harness.calls("slow") == 1 && harness.agent.credentials.secrets.count == 1, "The replaced tools differ")
        // An unchanged save keeps the connection and its revision.
        try harness.row(config.id).editButton.performClick(nil)
        harness.pane.sheet?.saveButton.performClick(nil)
        try require(try harness.config(named: "lore").revision == 2 && harness.starts.count == 2, "An unchanged save reconnected")
        // A new secret value alone raises the revision.
        try harness.row(config.id).editButton.performClick(nil)
        harness.pane.sheet?.environment.rows[1].valueField.stringValue = "synthetic-probe-token-0002"
        harness.pane.sheet?.saveButton.performClick(nil)
        try require(try harness.config(named: "lore").revision == 3, "A new secret did not replace the connection")
        try harness.ready(config.id)
        try require(harness.starts.count == 3, "The new secret did not restart the server")

        // 停用 terminates the local command.
        var pid = harness.hub.server(config.id)!.processID!
        harness.pane.refresh()
        try harness.row(config.id).enabledCheckbox.performClick(nil)
        try require(harness.hub.server(config.id)?.health == .disabled && harness.hub.visibleTools.isEmpty
            && (try harness.row(config.id)).statusLabel.stringValue == "未启用" && !(try harness.config(named: "lore")).enabled, "Disabling differs")
        try wait { processGone(pid) }

        // Enabled again, then the project closes.
        try harness.row(config.id).enabledCheckbox.performClick(nil)
        try harness.ready(config.id)
        pid = harness.hub.server(config.id)!.processID!
        harness.hub.shutdown()
        try require(harness.hub.visibleTools.isEmpty, "Closing kept tools")
        try wait { processGone(pid) }
        // The app quits: the process is gone before terminateNow returns.
        harness.hub.activate()
        try harness.ready(config.id)
        pid = harness.hub.server(config.id)!.processID!
        harness.hub.terminateNow()
        try require(processGone(pid), "terminateNow left the process running")
        harness.hub.activate()
        try harness.ready(config.id)
        pid = harness.hub.server(config.id)!.processID!

        // 删除… asks, then removes the server, its secret and its process.
        harness.answer = { $0.messageText == "删除 MCP 服务器“lore”？" ? .alertFirstButtonReturn : .alertSecondButtonReturn }
        try harness.row(config.id).deleteButton.performClick(nil)
        try require(harness.settings.mcpServers(projectID: harness.projectID).isEmpty && harness.agent.credentials.secrets.isEmpty
            && harness.hub.server(config.id) == nil && harness.pane.rows.isEmpty, "Deletion differs")
        try wait { processGone(pid) }
        try harness.close()
    }

    // MARK: (e) Streamable HTTP

    private static func mcpStreamableHTTP() throws {
        let harness = try McpHarness()
        defer { harness.agent.remove() }
        McpHTTPStub.reset()
        harness.pane.addButton.performClick(nil)
        guard let sheet = harness.pane.sheet else { throw LabError.message("The sheet did not open") }
        sheet.nameField.stringValue = "web"
        sheet.transportControl.selectedSegment = 1
        sheet.transportChanged()
        sheet.urlField.stringValue = "https://mcp.example.invalid/mcp"
        sheet.headers.add(name: "Accept", value: "text/plain", secret: false)
        sheet.saveButton.performClick(nil)
        try require(sheet.message.stringValue == "请求头“Accept”由 MCP 连接自动设置，不能自定义。" && harness.pane.sheet != nil, "A reserved header was accepted")
        sheet.headers.rows[0].onRemove?(sheet.headers.rows[0])
        sheet.headers.add(name: "Authorization", value: McpFixture.httpToken, secret: true)
        sheet.headers.add(name: "X-Fixture", value: "public-value", secret: false)
        sheet.saveButton.performClick(nil)
        try require(harness.pane.sheet == nil, "The HTTP server was refused: \(sheet.message.stringValue)")
        let config = try harness.config(named: "web")
        try harness.ready(config.id)
        try require(harness.hub.server(config.id)?.health == .ready(2) && harness.hub.server(config.id)?.serverInfo == "synthetic-http 1",
            "The HTTP server's health differs")
        let seen = McpHTTPStub.requests
        try require(seen.map(\.rpc) == ["initialize", "notifications/initialized", "tools/list", "tools/list"]
            && seen[0].headers["mcp-session-id"] == nil && seen[0].headers["accept"] == "application/json, text/event-stream"
            && seen[1].headers["mcp-session-id"] == "synthetic-session-1" && seen[2].headers["mcp-protocol-version"] == "2025-06-18"
            && seen.allSatisfy { $0.headers["authorization"] == McpFixture.httpToken && $0.headers["x-fixture"] == "public-value" },
            "The HTTP requests differ: \(seen.map(\.rpc))")
        let stored = try String(contentsOf: harness.settings.fileURL, encoding: .utf8)
        let account = AgentMcpSecrets.account(projectID: harness.projectID, serverID: config.id, header: true, name: "Authorization")
        try require(!stored.contains("synthetic-mcp-token") && stored.contains("Authorization")
            && harness.agent.credentials.secrets[account] == McpFixture.httpToken, "The header secret reached settings.json")

        // A call through the model.
        try harness.row(config.id).choose(.allow, for: "lookup")
        try harness.turn([("call_web", "mcp__web__lookup", mcpArguments(["term": "北塔"]))], "查一下北塔。")
        try require(harness.result("call_web")?.text == "北塔：auth ok，fixture public-value", "The HTTP result differs: \(harness.result("call_web")?.text ?? "")")

        // An expired session fails the call without replaying it and reconnects.
        McpHTTPStub.expireNext = true
        try harness.turn([("call_expired", "mcp__web__lookup", mcpArguments(["term": "南渡"]))], "再查一个。")
        try require(harness.result("call_expired")?.text == "调用失败：MCP 会话已过期，需要重新连接。", "Session expiry differs: \(harness.result("call_expired")?.text ?? "")")
        try wait { harness.hub.server(config.id)?.isReady == true && McpHTTPStub.requests.filter { $0.rpc == "initialize" }.count == 2 }
        try require(McpHTTPStub.requests.filter { $0.rpc == "tools/call" }.count == 2, "The expired call was replayed")
        try harness.turn([("call_again", "mcp__web__lookup", mcpArguments(["term": "南渡"]))], "现在呢？")
        try require(harness.result("call_again")?.text == "南渡：auth ok，fixture public-value"
            && McpHTTPStub.requests.last { $0.rpc == "tools/call" }?.headers["mcp-session-id"] == "synthetic-session-2", "The new session was not used")

        // Disabling ends the session with DELETE.
        harness.pane.setEnabled(config.id, false)
        try wait { McpHTTPStub.requests.contains { $0.method == "DELETE" } }
        let delete = McpHTTPStub.requests.first { $0.method == "DELETE" }
        try require(delete?.headers["mcp-session-id"] == "synthetic-session-2" && harness.hub.visibleTools.isEmpty, "DELETE differs")
        try harness.close()
    }
}

/// A Streamable HTTP MCP server in-process: JSON for initialize and calls,
/// SSE (with a notification before the answer) for tools/list in two pages,
/// 202 for notifications, a session id per initialize and 404 for an
/// expired one. It records every request; nothing reaches the network.
final class McpHTTPStub: URLProtocol {
    struct Seen {
        let method: String
        let rpc: String
        let headers: [String: String]
    }
    private static let lock = NSLock()
    private static var seen: [Seen] = []
    private static var sessions = 0
    private static var session = ""
    private static var expire = false

    static var requests: [Seen] { lock.lock(); defer { lock.unlock() }; return seen }
    static var expireNext: Bool {
        get { lock.lock(); defer { lock.unlock() }; return expire }
        set { lock.lock(); expire = newValue; lock.unlock() }
    }

    static func reset() { lock.lock(); seen = []; sessions = 0; session = ""; expire = false; lock.unlock() }

    static var configuration: URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [McpHTTPStub.self]
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

    private func respond(_ status: Int, _ headers: [String: String], _ body: Data) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !body.isEmpty { client?.urlProtocol(self, didLoad: body) }
        client?.urlProtocolDidFinishLoading(self)
    }

    private func json(_ value: [String: Any], headers: [String: String] = [:]) {
        respond(200, ["Content-Type": "application/json"].merging(headers) { $1 }, Data(AgentJSONText.encode(value).utf8))
    }

    override func startLoading() {
        let message = (try? JSONSerialization.jsonObject(with: Self.body(of: request))) as? [String: Any] ?? [:]
        let headers = Dictionary((request.allHTTPHeaderFields ?? [:]).map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { first, _ in first })
        let rpc = message["method"] as? String ?? ""
        let id = message["id"] ?? NSNull()
        Self.lock.lock()
        Self.seen.append(Seen(method: request.httpMethod ?? "", rpc: rpc, headers: headers))
        if rpc == "initialize" { Self.sessions += 1; Self.session = "synthetic-session-\(Self.sessions)" }
        let session = Self.session
        let expired = rpc == "tools/call" && Self.expire
        if expired { Self.expire = false; Self.session = "" }
        Self.lock.unlock()
        if request.httpMethod == "DELETE" { respond(200, [:], Data()); return }
        if rpc != "initialize", headers["mcp-session-id"] != session || expired {
            respond(404, ["Content-Type": "application/json"], Data(#"{"error":"unknown session"}"#.utf8)); return
        }
        switch rpc {
        case "initialize":
            json(["jsonrpc": "2.0", "id": id, "result": ["protocolVersion": "2025-06-18", "capabilities": ["tools": [String: Any]()],
                                                         "serverInfo": ["name": "synthetic-http", "version": "1"]]],
                 headers: ["Mcp-Session-Id": session])
        case "notifications/initialized", "notifications/cancelled":
            respond(202, [:], Data())
        case "tools/list":
            let cursor = (message["params"] as? [String: Any])?["cursor"] as? String
            let tool: [String: Any] = cursor == nil
                ? ["name": "lookup", "description": "查找名称。", "inputSchema": ["type": "object", "properties": ["term": ["type": "string"]], "required": ["term"]]]
                : ["name": "status", "description": "服务器状态。", "inputSchema": ["type": "object"]]
            var result: [String: Any] = ["tools": [tool]]
            if cursor == nil { result["nextCursor"] = "page-2" }
            let note = AgentJSONText.encode(["jsonrpc": "2.0", "method": "notifications/message", "params": ["level": "info", "data": "listing"]])
            let answer = AgentJSONText.encode(["jsonrpc": "2.0", "id": id, "result": result])
            respond(200, ["Content-Type": "text/event-stream"], Data("event: message\ndata: \(note)\n\nevent: message\ndata: \(answer)\n\n".utf8))
        case "tools/call":
            let params = message["params"] as? [String: Any] ?? [:]
            let term = (params["arguments"] as? [String: Any])?["term"] as? String ?? ""
            let auth = headers["authorization"] == BindingAcceptance.McpFixture.httpToken ? "ok" : "missing"
            json(["jsonrpc": "2.0", "id": id, "result": ["content": [["type": "text", "text": "\(term)：auth \(auth)，fixture \(headers["x-fixture"] ?? "")"]]]])
        default:
            json(["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "method not found"]])
        }
    }

    override func stopLoading() {}
}
