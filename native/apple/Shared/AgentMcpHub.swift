import Foundation

/// One project's MCP servers: a connection per enabled server, its health
/// and discovered tools, and calls from the writing assistant. The owner
/// activates it while the project is open and shuts it down when the
/// project closes, is deleted or the app quits; a stopped local command is
/// terminated. A server whose connection settings change is replaced: its
/// old tools leave the list before the new connection starts, and only a
/// completed handshake and `tools/list` make the new ones visible.
/// Handshakes are retried after a failure or a crash; tool calls never are.
/// Main thread only.
final class AgentMcpHub {
    /// Posted (object: the hub) when health or tools changed.
    static let didChange = Notification.Name("AgentMcpHub.didChange")
    static let protocolVersion = "2025-06-18"
    static let supportedVersions: Set<String> = ["2025-06-18", "2025-03-26", "2024-11-05"]
    static let pageLimit = 16
    static let toolLimit = 256
    static let descriptionLimit = 1_000

    enum Health: Equatable {
        case disabled
        case connecting
        case ready(Int)
        case failed(String)

        /// 未启用 / 连接中… / 可用 N 个工具 / 出错：…
        var label: String {
            switch self {
            case .disabled: return "未启用"
            case .connecting: return "连接中…"
            case .ready(let count): return "可用 \(count) 个工具"
            case .failed(let message): return "出错：\(message)"
            }
        }
    }

    /// A discovered tool as the model and the settings pane see it.
    struct Tool: Equatable {
        let serverID: String
        let serverName: String
        /// The server's own name for it.
        let name: String
        /// `mcp__<server>__<tool>`.
        let providerName: String
        let description: String
        let schema: AgentJSON?
        /// Why the model does not get it, e.g. an unsupported schema.
        let skipped: String?
        let policy: AgentMcpToolPolicy
        /// The server's configuration revision when the tool was listed; a
        /// call made later is pinned to it.
        let revision: Int

        var isVisible: Bool { skipped == nil && policy != .deny }
        var schemaObject: [String: Any] { (schema?.any as? [String: Any]) ?? ["type": "object"] }

        var definition: AgentToolDefinition {
            let text = description.isEmpty ? "MCP 服务器“\(serverName)”提供的工具 \(name)。" : description
            return AgentToolDefinition(name: providerName, description: "［MCP · \(serverName)］\(text)", schema: schemaObject, access: .external)
        }
    }

    fileprivate struct Discovered {
        let name: String
        let description: String
        let schema: Any?
        let problem: String?
    }

    final class Server {
        fileprivate(set) var config: AgentMcpServerConfig
        fileprivate(set) var health: Health = .disabled
        fileprivate(set) var tools: [Tool] = []
        /// `name version` from `initialize`.
        fileprivate(set) var serverInfo: String?
        fileprivate var discovered: [Discovered] = []
        /// The ended connection, whose log late lines still reach.
        fileprivate var lastRPC: AgentMcpRPC?
        fileprivate var rpc: AgentMcpRPC?
        fileprivate var key = ""
        fileprivate var generation = 0
        fileprivate var failures = 0
        fileprivate var readySince: Date?
        fileprivate var retry: DispatchWorkItem?
        /// A `tools/list` is running; `listAgain` asks for one more after it.
        fileprivate var listing = false
        fileprivate var listAgain = false
        /// `tools/list` requests sent for this server so far, for acceptance.
        fileprivate(set) var listRequests = 0

        fileprivate init(config: AgentMcpServerConfig) { self.config = config }

        var id: String { config.id }
        /// The running local command's process.
        var processID: Int32? { rpc?.processID }
        /// The last lines the server wrote to standard error.
        var log: [String] { rpc?.stderrLines ?? lastRPC?.stderrLines ?? [] }
        var isConnected: Bool { rpc != nil }
        #if os(macOS)
        /// Bytes of an unfinished standard-error line held now, for acceptance.
        var stderrPending: Int { (rpc as? AgentMcpStdioRPC)?.errorLines.pendingCount ?? 0 }
        #endif
        var isReady: Bool { if case .ready = health { return rpc != nil }; return false }
    }

    let projectID: String
    let secrets: AgentSecretStore
    /// The project's servers as `settings.json` stores them.
    var configs: () -> [AgentMcpServerConfig]
    /// Streamable HTTP goes through this; acceptance installs a stub.
    var urlConfiguration: URLSessionConfiguration = AgentNetwork.standardConfiguration()
    var handshakeTimeout: TimeInterval = 30
    var callTimeout: TimeInterval = 300
    /// How long an HTTP notification's answer may stay open.
    var notificationTimeout: TimeInterval = 30
    /// Waits before each automatic reconnection after a failure or crash.
    var restartDelays: [TimeInterval] = [1, 3, 10]
    /// A connection that stayed up this long starts its retries afresh.
    var stableAfter: TimeInterval = 60
    private(set) var isActive = false
    private var order: [String] = []
    private var servers: [String: Server] = [:]
    private var slugs: [String: String] = [:]
    /// Ended connections whose local command may still be in its shutdown
    /// window (EOF, then SIGTERM, then SIGKILL); quitting ends them at once.
    private var retired: [AgentMcpRPC] = []

    init(projectID: String, secrets: AgentSecretStore, configs: @escaping () -> [AgentMcpServerConfig]) {
        self.projectID = projectID; self.secrets = secrets; self.configs = configs
    }

    // MARK: Inspection

    var allServers: [Server] { order.compactMap { servers[$0] } }
    func server(_ id: String) -> Server? { servers[id] }

    /// What the model gets: the allowed and ask tools of connected servers.
    var visibleTools: [Tool] {
        allServers.filter { $0.config.enabled && $0.isReady }.flatMap { $0.tools.filter(\.isVisible) }
    }
    var definitions: [AgentToolDefinition] { visibleTools.map(\.definition) }
    func tool(named name: String) -> Tool? { visibleTools.first { $0.providerName == name } }
    /// Names of servers with tools the model can call.
    var visibleServerNames: [String] {
        var names: [String] = []
        for tool in visibleTools where !names.contains(tool.serverName) { names.append(tool.serverName) }
        return names
    }
    /// `mcp__<slug>__` of a server.
    func prefix(_ serverID: String) -> String { AgentMcpNames.prefix + (slugs[serverID] ?? "") + "__" }

    private func changed() { NotificationCenter.default.post(name: Self.didChange, object: self) }

    // MARK: Lifecycle

    /// Starts every enabled server of the project.
    func activate() {
        guard !isActive else { return }
        isActive = true
        reconcile()
    }

    /// Follows `settings.json`: removed and disabled servers stop, new,
    /// enabled or reconfigured ones connect, and renamed servers and
    /// changed policies apply to the tools at once.
    func reconcile() {
        let list = configs()
        slugs = AgentMcpNames.serverSlugs(list)
        let ids = Set(list.map(\.id))
        for id in order where !ids.contains(id) {
            if let server = servers.removeValue(forKey: id) { stop(server, health: .disabled) }
        }
        order = list.map(\.id)
        for config in list {
            let server = servers[config.id] ?? Server(config: config)
            servers[config.id] = server
            server.config = config
            guard isActive, config.enabled else {
                if server.isConnected || server.health != .disabled || server.retry != nil { stop(server, health: .disabled) }
                continue
            }
            if server.health == .disabled || server.key != config.connectionKey {
                server.failures = 0
                connect(server)
            } else {
                rebuild(server)
            }
        }
        changed()
    }

    /// 重新连接: a new connection now, with fresh retries.
    func reconnect(_ id: String) {
        guard isActive, let server = servers[id], server.config.enabled else { return }
        server.failures = 0
        connect(server)
    }

    /// The project closed: every connection ends and local commands are
    /// terminated (EOF, then SIGTERM, then SIGKILL).
    func shutdown() {
        isActive = false
        for server in allServers { stop(server, health: .disabled) }
        changed()
    }

    /// The app is quitting: every local command ends before this returns,
    /// running ones and those still in their shutdown window after a
    /// disable, a reconfiguration or a failure.
    func terminateNow() {
        isActive = false
        for server in allServers {
            let rpc = server.rpc
            stop(server, health: .disabled, closing: false)
            rpc?.terminateNow()
        }
        let closing = retired
        retired = []
        for rpc in closing { rpc.terminateNow() }
    }

    /// Local commands of this hub still running, current and retired.
    var runningProcessIDs: [Int32] {
        (allServers.compactMap(\.rpc) + retired).filter(\.isRunning).compactMap(\.processID)
    }

    /// Keeps an ended connection until its process has gone.
    private func retire(_ rpc: AgentMcpRPC) {
        retired.removeAll { !$0.isRunning }
        if rpc.isRunning, !retired.contains(where: { $0 === rpc }) { retired.append(rpc) }
    }

    private func stop(_ server: Server, health: Health, closing: Bool = true) {
        server.generation += 1
        server.retry?.cancel(); server.retry = nil
        server.listing = false; server.listAgain = false
        if let rpc = server.rpc {
            server.lastRPC = rpc
            rpc.onClosed = nil; rpc.onNotification = nil
            if closing {
                rpc.close(reason: AgentMcpError(.closed, "服务器已停用或重新配置，这次调用没有完成（不会自动重试）。"))
                retire(rpc)
            }
        }
        server.rpc = nil
        server.tools = []; server.readySince = nil
        server.health = health
        if health == .disabled { server.key = ""; server.serverInfo = nil }
    }

    // MARK: Connecting

    private func connect(_ server: Server) {
        // The old connection and its tools go before anything new starts.
        stop(server, health: .connecting)
        server.key = server.config.connectionKey
        server.lastRPC = nil
        server.discovered = []
        let generation = server.generation
        changed()
        let rpc: AgentMcpRPC
        do {
            rpc = try makeRPC(server.config)
            server.rpc = rpc
            try rpc.start()
        } catch {
            failed(server, error as? AgentMcpError ?? AgentMcpError(.launch, error.localizedDescription), retry: false)
            return
        }
        rpc.onClosed = { [weak self, weak server] error in
            guard let self, let server, server.generation == generation else { return }
            self.lost(server, error)
        }
        rpc.onNotification = { [weak self, weak server] method in
            guard let self, let server, server.generation == generation, method == "notifications/tools/list_changed" else { return }
            // A storm of changes costs at most one listing in flight and one after it.
            if server.listing { server.listAgain = true; return }
            self.list(server, rpc: rpc, generation: generation)
        }
        let params: [String: Any] = ["protocolVersion": Self.protocolVersion, "capabilities": [String: Any](),
                                     "clientInfo": ["name": "Drifting Native Lab", "version": "0.1.0"]]
        rpc.request("initialize", params: params, timeout: handshakeTimeout) { [weak self, weak server] result in
            guard let self, let server, server.generation == generation else { return }
            switch result {
            case .failure(let error):
                self.failed(server, error.kind == .timeout ? AgentMcpError(.timeout, "握手超时：initialize \(error.message)") : error, retry: true)
            case .success(let value):
                guard let object = value as? [String: Any] else {
                    self.failed(server, AgentMcpError(.protocolError, "initialize 的结果无效。"), retry: true); return
                }
                let version = object["protocolVersion"] as? String ?? ""
                guard Self.supportedVersions.contains(version) else {
                    self.failed(server, AgentMcpError(.protocolError, "服务器使用的协议版本“\(version.prefix(40))”不受支持。"), retry: false); return
                }
                guard (object["capabilities"] as? [String: Any])?["tools"] != nil else {
                    self.failed(server, AgentMcpError(.protocolError, "服务器没有提供工具（tools）能力。"), retry: false); return
                }
                if let info = object["serverInfo"] as? [String: Any], let name = info["name"] as? String {
                    let version = (info["version"] as? String).map { " " + $0 } ?? ""
                    server.serverInfo = String((name + version).prefix(120))
                }
                rpc.protocolVersion = version
                rpc.notify("notifications/initialized", params: nil)
                self.list(server, rpc: rpc, generation: generation)
            }
        }
    }

    /// `tools/list` with pagination: at most 16 pages and 256 tools, no
    /// duplicate names, cursors that do not repeat. One listing runs at a
    /// time; changes announced meanwhile start one more when it completes.
    private func list(_ server: Server, rpc: AgentMcpRPC, generation: Int) {
        server.listing = true
        server.listAgain = false
        var collected: [Discovered] = []
        var names: Set<String> = [], cursors: Set<String> = []
        func page(_ cursor: String?, _ number: Int) {
            server.listRequests += 1
            rpc.request("tools/list", params: cursor.map { ["cursor": $0] }, timeout: handshakeTimeout) { [weak self, weak server] result in
                guard let self, let server, server.generation == generation else { return }
                let invalid = { (text: String) in self.failed(server, AgentMcpError(.protocolError, "工具列表无效：\(text)"), retry: true) }
                switch result {
                case .failure(let error):
                    self.failed(server, error.kind == .timeout ? AgentMcpError(.timeout, "tools/list \(error.message)") : error, retry: true)
                case .success(let value):
                    guard let object = value as? [String: Any], let tools = object["tools"] as? [Any] else { invalid("缺少 tools。"); return }
                    for raw in tools {
                        guard let tool = raw as? [String: Any], let name = tool["name"] as? String,
                              !name.trimmingCharacters(in: .whitespaces).isEmpty, name.count <= 300 else { invalid("有工具的名称无效。"); return }
                        guard names.insert(name).inserted else { invalid("工具“\(name.prefix(40))”重复。"); return }
                        guard names.count <= Self.toolLimit else { invalid("工具超过 \(Self.toolLimit) 个。"); return }
                        let text = (tool["description"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        let description = text.count > Self.descriptionLimit ? String(text.prefix(Self.descriptionLimit)) + "…" : text
                        let schema = tool["inputSchema"]
                        collected.append(Discovered(name: name, description: description, schema: schema, problem: AgentMcpSchema.problem(schema)))
                    }
                    if let next = object["nextCursor"], !(next is NSNull) {
                        guard let text = next as? String, !text.isEmpty, text.count <= 1_000, cursors.insert(text).inserted else {
                            invalid("分页标记无效。"); return
                        }
                        guard number + 1 < Self.pageLimit else { invalid("超过 \(Self.pageLimit) 页。"); return }
                        page(text, number + 1)
                    } else {
                        server.discovered = collected
                        self.rebuild(server)
                        server.health = .ready(collected.filter { $0.problem == nil }.count)
                        if server.readySince == nil { server.readySince = Date() }
                        server.listing = false
                        self.changed()
                        if server.listAgain { self.list(server, rpc: rpc, generation: generation) }
                    }
                }
            }
        }
        page(nil, 0)
    }

    /// Names, descriptions, schemas and policies of the discovered tools.
    private func rebuild(_ server: Server) {
        let config = server.config
        let names = AgentMcpNames.toolNames(server: slugs[config.id] ?? "s", tools: server.discovered.map(\.name))
        server.tools = zip(server.discovered, names).map { tool, providerName in
            Tool(serverID: config.id, serverName: config.name, name: tool.name, providerName: providerName, description: tool.description,
                 schema: tool.problem == nil ? AgentJSON(any: tool.schema) : nil, skipped: tool.problem.map { "已跳过：\($0)" },
                 policy: config.policy(tool.name), revision: config.revision)
        }
    }

    /// The connection ended by itself (a crash, an unreadable message, an
    /// expired session). A connection that had been up for a while retries
    /// afresh.
    private func lost(_ server: Server, _ error: AgentMcpError) {
        if let since = server.readySince, Date().timeIntervalSince(since) >= stableAfter { server.failures = 0 }
        failed(server, error, retry: true)
    }

    private func failed(_ server: Server, _ error: AgentMcpError, retry: Bool) {
        let generation = server.generation
        server.listing = false; server.listAgain = false
        if let rpc = server.rpc {
            server.lastRPC = rpc
            rpc.onClosed = nil; rpc.onNotification = nil
            rpc.close(reason: AgentMcpError(.closed, "服务器连接已断开，这次调用没有完成（不会自动重试）。"))
            retire(rpc)
        }
        server.rpc = nil
        server.tools = []; server.readySince = nil
        server.retry?.cancel(); server.retry = nil
        var message = error.message
        if retry, isActive, server.failures < restartDelays.count {
            let delay = restartDelays[server.failures]
            server.failures += 1
            let seconds = delay < 1 ? "片刻" : "\(Int(delay.rounded())) 秒"
            message += "\(seconds)后自动重新连接（第 \(server.failures)/\(restartDelays.count) 次）。"
            let work = DispatchWorkItem { [weak self, weak server] in
                guard let self, let server, server.generation == generation, self.isActive, server.config.enabled else { return }
                server.retry = nil
                self.connect(server)
            }
            server.retry = work
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        }
        server.health = .failed(message)
        changed()
    }

    private func makeRPC(_ config: AgentMcpServerConfig) throws -> AgentMcpRPC {
        switch config.transport {
        case .stdio:
            #if os(macOS)
            var environment = AgentMcpStdioRPC.baseEnvironment()
            for variable in config.environment { environment[variable.name] = try value(variable, header: false, config) }
            return AgentMcpStdioRPC(command: config.command, arguments: config.arguments, directory: config.workingDirectory,
                                    environment: environment)
            #else
            throw AgentMcpError(.configuration, "本地命令只能在 Mac 上运行。")
            #endif
        case .http:
            if let problem = AgentMcpValidation.urlProblem(config.url) { throw AgentMcpError(.configuration, problem) }
            guard let url = URL(string: config.url.trimmingCharacters(in: .whitespaces)) else {
                throw AgentMcpError(.configuration, "服务器地址无效。")
            }
            var headers: [String: String] = [:]
            for variable in config.headers { headers[variable.name] = try value(variable, header: true, config) }
            return AgentMcpHTTPRPC(url: url, headers: headers, configuration: urlConfiguration, notificationTimeout: notificationTimeout)
        }
    }

    /// A public value, or a secret read from the Keychain now.
    private func value(_ variable: AgentMcpVariable, header: Bool, _ config: AgentMcpServerConfig) throws -> String {
        guard variable.secret else { return variable.value }
        let account = AgentMcpSecrets.account(projectID: projectID, serverID: config.id, header: header, name: variable.name)
        let stored: String?
        do { stored = try secrets.secret(account: account) } catch { throw AgentMcpError(.configuration, error.localizedDescription) }
        guard let stored, !stored.isEmpty else {
            throw AgentMcpError(.configuration, "钥匙串中没有\(header ? "请求头" : "环境变量")“\(variable.name)”的值，请编辑这个服务器重新填写。")
        }
        return stored
    }

    // MARK: Calls

    /// Why the tool the model (or an approval card) named can no longer be
    /// called on the server it was listed for, or nil. The call is pinned:
    /// a server renamed, reconfigured, disabled or deleted since, or a tool
    /// it no longer lists or the author disabled, is refused, and nothing is
    /// looked up again by name.
    func pinProblem(_ pinned: Tool) -> String? {
        guard let server = servers[pinned.serverID] else { return "MCP 服务器“\(pinned.serverName)”已经删除。" }
        let config = server.config
        if config.name != pinned.serverName { return "MCP 服务器“\(pinned.serverName)”已改名为“\(config.name)”。" }
        if config.revision != pinned.revision { return "MCP 服务器“\(pinned.serverName)”已重新配置。" }
        guard config.enabled, server.isReady else { return "MCP 服务器“\(pinned.serverName)”已停用或正在重新连接。" }
        guard let current = server.tools.first(where: { $0.name == pinned.name }) else {
            return "MCP 服务器“\(pinned.serverName)”已不再提供工具 \(pinned.name)。"
        }
        guard current.isVisible else { return "作者已禁用 MCP 工具 \(pinned.name)。" }
        return nil
    }

    /// Calls the pinned tool once on its own server. Nil when `pinProblem`
    /// refuses it. The call is never sent again: a timeout, a crash or a
    /// replaced connection fails it.
    func call(_ pinned: Tool, arguments: [String: Any],
              completion: @escaping (Result<AgentMcpCallResult, AgentMcpError>) -> Void) -> AgentMcpPendingRequest? {
        guard pinProblem(pinned) == nil, let server = servers[pinned.serverID], let rpc = server.rpc else { return nil }
        let generation = server.generation
        return rpc.request("tools/call", params: ["name": pinned.name, "arguments": arguments], timeout: callTimeout) { [weak server] result in
            switch result {
            case .failure(let error):
                completion(.failure(error.kind == .timeout
                    ? AgentMcpError(.timeout, "MCP 工具在 \(error.message)调用已取消，不会自动重试。") : error))
            case .success(let value):
                guard let object = value as? [String: Any] else {
                    completion(.failure(AgentMcpError(.protocolError, "工具结果不是 JSON 对象。"))); return
                }
                do {
                    let outcome = try AgentMcpCallResult(result: object)
                    if let server, server.generation == generation { server.failures = 0 }
                    completion(.success(outcome))
                } catch {
                    completion(.failure(error as? AgentMcpError ?? AgentMcpError(.protocolError, "工具结果无效。")))
                }
            }
        }
    }

    /// Calls a visible tool by its provider name, as the model names it now.
    func call(_ providerName: String, arguments: [String: Any],
              completion: @escaping (Result<AgentMcpCallResult, AgentMcpError>) -> Void) -> AgentMcpPendingRequest? {
        guard let tool = tool(named: providerName) else { return nil }
        return call(tool, arguments: arguments, completion: completion)
    }
}
