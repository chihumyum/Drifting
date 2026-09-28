import Foundation

// MCP 扩展: MCP servers the author adds per project in 设置 › 写作助手 ›
// MCP 扩展. Their discovered tools join the writing assistant's tools as
// `mcp__<server>__<tool>`; a result only ever goes back to the model, never
// into the book. This file holds the configuration, the names, schema
// checks, result rendering and the approval record; the transports and the
// per-project lifecycle are in `AgentMcpClient.swift` and `AgentMcpHub.swift`.

// MARK: - Configuration

enum AgentMcpTransportKind: String, Codable, CaseIterable {
    /// A local command speaking JSON-RPC over its standard input and output.
    case stdio
    /// Streamable HTTP: JSON-RPC POSTs answered with JSON or SSE.
    case http

    var label: String { self == .stdio ? "本地命令" : "HTTP" }
}

/// Whether the model may call a discovered tool.
enum AgentMcpToolPolicy: String, Codable, CaseIterable {
    case allow, ask, deny

    /// A tool the author has not decided on asks each time.
    static let standard = AgentMcpToolPolicy.ask

    var label: String {
        switch self {
        case .allow: return "允许"
        case .ask: return "每次询问"
        case .deny: return "禁用"
        }
    }
}

/// An environment variable or HTTP header. A secret's value lives in the
/// Keychain only; `value` is always empty for it in `settings.json`.
struct AgentMcpVariable: Codable, Equatable {
    var name: String
    var value: String
    var secret: Bool

    private enum CodingKeys: String, CodingKey { case name, value, secret }

    init(name: String, value: String, secret: Bool = false) {
        self.name = name; self.value = secret ? "" : value; self.secret = secret
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        name = try values.decode(String.self, forKey: .name)
        secret = (try? values.decodeIfPresent(Bool.self, forKey: .secret)) ?? false
        value = secret ? "" : ((try? values.decodeIfPresent(String.self, forKey: .value)) ?? "")
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(name, forKey: .name)
        try values.encode(secret ? "" : value, forKey: .value)
        try values.encode(secret, forKey: .secret)
    }
}

/// One MCP server of a project, as `settings.json` stores it under
/// `mcpServers.<projectId>`. Secret values are never part of it.
struct AgentMcpServerConfig: Codable, Equatable {
    static let nameLimit = 40
    static let argumentLimit = 64
    static let variableLimit = 64

    var id: String
    var name: String
    var transport: AgentMcpTransportKind
    var enabled: Bool
    var command: String
    var arguments: [String]
    var workingDirectory: String
    var environment: [AgentMcpVariable]
    var url: String
    var headers: [AgentMcpVariable]
    /// The author's choice per discovered tool name; absent means 每次询问.
    var toolPolicies: [String: AgentMcpToolPolicy]
    /// Raised by every change to how the server is reached, a secret value
    /// included; a new revision replaces the running connection.
    var revision: Int

    init(id: String = "mcp-" + UUID().uuidString.lowercased(), name: String, transport: AgentMcpTransportKind, enabled: Bool = true) {
        self.id = id; self.name = name; self.transport = transport; self.enabled = enabled
        command = ""; arguments = []; workingDirectory = ""; environment = []
        url = ""; headers = []; toolPolicies = [:]; revision = 1
    }

    /// Unknown or damaged values fall back one by one, so an older or
    /// hand-edited file still opens.
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        name = (try? values.decodeIfPresent(String.self, forKey: .name)) ?? "MCP"
        transport = (try? values.decodeIfPresent(AgentMcpTransportKind.self, forKey: .transport)) ?? .stdio
        enabled = (try? values.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        command = (try? values.decodeIfPresent(String.self, forKey: .command)) ?? ""
        arguments = (try? values.decodeIfPresent([String].self, forKey: .arguments)) ?? []
        workingDirectory = (try? values.decodeIfPresent(String.self, forKey: .workingDirectory)) ?? ""
        environment = (try? values.decodeIfPresent([AgentMcpVariable].self, forKey: .environment)) ?? []
        url = (try? values.decodeIfPresent(String.self, forKey: .url)) ?? ""
        headers = (try? values.decodeIfPresent([AgentMcpVariable].self, forKey: .headers)) ?? []
        let raw = (try? values.decodeIfPresent([String: String].self, forKey: .toolPolicies)) ?? [:]
        toolPolicies = raw.compactMapValues(AgentMcpToolPolicy.init(rawValue:))
        revision = (try? values.decodeIfPresent(Int.self, forKey: .revision)) ?? 1
    }

    func policy(_ tool: String) -> AgentMcpToolPolicy { toolPolicies[tool] ?? .standard }

    /// What a connection depends on; a change replaces it.
    var connectionKey: String {
        AgentJSONText.encode(["transport": transport.rawValue, "command": command, "arguments": arguments, "directory": workingDirectory,
                              "environment": environment.map { [$0.name, $0.value, $0.secret ? "1" : "0"] },
                              "url": url, "headers": headers.map { [$0.name, $0.value, $0.secret ? "1" : "0"] }, "revision": revision])
    }

    /// Where the server is reached: the transport, then the command, its
    /// arguments and working folder, or the URL's scheme, host, port and
    /// path. A change resets every tool policy to 每次询问, because the
    /// author's 允许 was given to whatever answered there before.
    /// Variables, headers, secrets and the URL's query do not count.
    var endpointKey: String {
        switch transport {
        case .stdio:
            return AgentJSONText.encode(["stdio", command, arguments.joined(separator: "\n"), workingDirectory])
        case .http:
            let text = url.trimmingCharacters(in: .whitespaces)
            guard let components = URLComponents(string: text) else { return AgentJSONText.encode(["http", text]) }
            let scheme = components.scheme?.lowercased() ?? ""
            let port = components.port ?? (scheme == "https" ? 443 : scheme == "http" ? 80 : 0)
            let path = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
            return AgentJSONText.encode(["http", scheme, components.host?.lowercased() ?? "", String(port), path])
        }
    }

    /// 本地命令 /usr/local/bin/x, or HTTP https://….
    var summary: String {
        transport == .stdio ? "本地命令 \(command)" + (arguments.isEmpty ? "" : " " + arguments.joined(separator: " ")) : "HTTP \(url)"
    }
}

/// Keychain accounts of secret values, under the lab's own service
/// (`Drifting Native Lab`, never the production `Drifting` service).
enum AgentMcpSecrets {
    static func account(projectID: String, serverID: String, header: Bool, name: String) -> String {
        "mcp.\(projectID).\(serverID).\(header ? "header" : "env").\(name)"
    }

    static func accounts(projectID: String, config: AgentMcpServerConfig) -> [String] {
        config.environment.filter(\.secret).map { account(projectID: projectID, serverID: config.id, header: false, name: $0.name) }
            + config.headers.filter(\.secret).map { account(projectID: projectID, serverID: config.id, header: true, name: $0.name) }
    }

    /// Removes every secret of the server; a missing one is fine.
    static func remove(projectID: String, config: AgentMcpServerConfig, from store: AgentSecretStore) {
        for account in accounts(projectID: projectID, config: config) { try? store.removeSecret(account: account) }
    }
}

// MARK: - Validation

enum AgentMcpValidation {
    static let reservedHeaders: Set<String> = ["accept", "content-type", "content-length", "mcp-session-id", "mcp-protocol-version"]
    static let forbiddenHeaders: Set<String> = ["host", "cookie", "connection", "origin", "referer", "transfer-encoding", "upgrade"]

    private static func hasBreak(_ text: String) -> Bool {
        text.contains("\n") || text.contains("\r") || text.contains("\u{0000}")
    }

    /// Why the server cannot be saved, in Chinese, or nil. `others` are
    /// the project's other servers; `hasSecret` says whether a secret
    /// variable has a value (typed now or already in the Keychain).
    static func refusal(_ config: AgentMcpServerConfig, others: [AgentMcpServerConfig],
                        hasSecret: (_ header: Bool, _ name: String) -> Bool) -> String? {
        let name = config.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return "请填写服务器名称。" }
        if name.count > AgentMcpServerConfig.nameLimit { return "服务器名称最多 \(AgentMcpServerConfig.nameLimit) 字。" }
        if hasBreak(name) { return "服务器名称不能包含换行。" }
        if others.contains(where: { $0.id != config.id && $0.name.trimmingCharacters(in: .whitespacesAndNewlines) == name }) {
            return "已经有名为“\(name)”的服务器。"
        }
        switch config.transport {
        case .stdio:
            let command = config.command
            if command.trimmingCharacters(in: .whitespaces).isEmpty { return "请填写要运行的命令的完整路径，例如 /usr/local/bin/my-server。" }
            if !command.hasPrefix("/") { return "命令必须是可执行文件的完整路径（以 / 开头）。" }
            if hasBreak(command) || command.count > 2_000 { return "命令路径无效。" }
            var directory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: command, isDirectory: &directory), !directory.boolValue else {
                return "找不到可执行文件：\(command)。"
            }
            if !FileManager.default.isExecutableFile(atPath: command) { return "没有执行权限：\(command)。" }
            if config.arguments.count > AgentMcpServerConfig.argumentLimit { return "参数最多 \(AgentMcpServerConfig.argumentLimit) 个。" }
            if let bad = config.arguments.first(where: { $0.count > 2_000 || hasBreak($0) }) {
                return "参数“\(bad.prefix(20))”无效：每个参数占一行，最多 2000 字。"
            }
            let folder = config.workingDirectory
            if !folder.isEmpty {
                if !folder.hasPrefix("/") { return "工作文件夹必须是完整路径（以 / 开头）。" }
                var isFolder: ObjCBool = false
                guard FileManager.default.fileExists(atPath: folder, isDirectory: &isFolder), isFolder.boolValue else {
                    return "找不到工作文件夹：\(folder)。"
                }
            }
            if let problem = variables(config.environment, header: false, hasSecret: hasSecret) { return problem }
        case .http:
            let text = config.url.trimmingCharacters(in: .whitespaces)
            if text.isEmpty { return "请填写服务器地址，例如 https://example.com/mcp。" }
            if let problem = urlProblem(text) { return problem }
            if let problem = variables(config.headers, header: true, hasSecret: hasSecret) { return problem }
        }
        return nil
    }

    /// HTTPS, or HTTP to this Mac only; no user name, password or fragment.
    static func urlProblem(_ text: String) -> String? {
        guard let components = URLComponents(string: text), let scheme = components.scheme?.lowercased(),
              let host = components.host, !host.isEmpty else {
            return "服务器地址无效。"
        }
        let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host.lowercased())
        guard scheme == "https" || (scheme == "http" && loopback) else {
            return "服务器地址必须以 https:// 开头；只有本机地址（localhost、127.0.0.1）可以用 http://。"
        }
        if components.user != nil || components.password != nil { return "服务器地址中不能包含用户名或密码；请改用请求头。" }
        if components.fragment != nil { return "服务器地址中不能包含 #。" }
        return nil
    }

    private static func variables(_ list: [AgentMcpVariable], header: Bool, hasSecret: (Bool, String) -> Bool) -> String? {
        let noun = header ? "请求头" : "环境变量"
        if list.count > AgentMcpServerConfig.variableLimit { return "\(noun)最多 \(AgentMcpServerConfig.variableLimit) 个。" }
        var seen: Set<String> = []
        for variable in list {
            let name = variable.name
            if header {
                let lower = name.lowercased()
                if name.range(of: "^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,200}$", options: .regularExpression) == nil {
                    return "请求头名称“\(name)”无效。"
                }
                if reservedHeaders.contains(lower) { return "请求头“\(name)”由 MCP 连接自动设置，不能自定义。" }
                if forbiddenHeaders.contains(lower) || lower.hasPrefix("sec-") || lower.hasPrefix("proxy-") {
                    return "请求头“\(name)”不能自定义。"
                }
                if !seen.insert(lower).inserted { return "请求头“\(name)”重复。" }
            } else {
                if name.range(of: "^[A-Za-z_][A-Za-z0-9_]{0,199}$", options: .regularExpression) == nil {
                    return "环境变量名“\(name)”无效：只能包含字母、数字和下划线，且不能以数字开头。"
                }
                if !seen.insert(name).inserted { return "环境变量“\(name)”重复。" }
            }
            if variable.secret {
                if !hasSecret(header, name) { return "请填写密钥\(noun)“\(name)”的值。" }
            } else if variable.value.count > 8_000 || hasBreak(variable.value) {
                return "\(noun)“\(name)”的值不能包含换行，最多 8000 字。"
            }
        }
        return nil
    }
}

// MARK: - Tool names

/// `mcp__<server>__<tool>` within the providers' 64-character
/// `[A-Za-z0-9_-]` tool names. A name that had to change, or would clash,
/// ends with a short hash of the original.
enum AgentMcpNames {
    static let prefix = "mcp__"
    static let limit = 64
    static let serverLimit = 16

    static func isMcp(_ name: String) -> Bool { name.hasPrefix(prefix) }

    static func hash(_ text: String) -> String {
        var value: UInt32 = 0x811c9dc5
        for byte in text.utf8 { value ^= UInt32(byte); value = value &* 0x01000193 }
        return String(format: "%08x", value)
    }

    /// Letters and digits, runs of anything else as one `_`.
    static func slug(_ text: String, lowercase: Bool, allowHyphen: Bool) -> String {
        var result = ""
        for scalar in text.unicodeScalars {
            let ascii = scalar.isASCII && (CharacterSet.alphanumerics.contains(scalar) || (allowHyphen && scalar == "-"))
            if ascii { result.unicodeScalars.append(scalar) } else if !result.hasSuffix("_") { result += "_" }
        }
        let trimmed = result.trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        return lowercase ? trimmed.lowercased() : trimmed
    }

    /// Each server's segment, unique within the project, in list order.
    static func serverSlugs(_ configs: [AgentMcpServerConfig]) -> [String: String] {
        var used: Set<String> = [], result: [String: String] = [:]
        for config in configs {
            var slug = String(slug(config.name, lowercase: true, allowHyphen: false).prefix(serverLimit))
            if slug.isEmpty { slug = "s" + hash(config.id).prefix(6) }
            if used.contains(slug) { slug = String(slug.prefix(serverLimit - 5)) + "_" + hash(config.id).prefix(4) }
            used.insert(slug)
            result[config.id] = slug
        }
        return result
    }

    /// Provider names for a server's tools, in order, unique.
    static func toolNames(server: String, tools: [String]) -> [String] {
        let room = limit - prefix.count - server.count - 2
        var used: Set<String> = [], result: [String] = []
        for tool in tools {
            var name = slug(tool, lowercase: false, allowHyphen: true)
            if name != tool || name.count > room || used.contains(name) || name.isEmpty {
                name = String((name.isEmpty ? "tool" : name).prefix(max(1, room - 7))) + "_" + hash(tool).prefix(6)
            }
            used.insert(name)
            result.append(prefix + server + "__" + name)
        }
        return result
    }
}

// MARK: - Input schemas

/// Checks an MCP tool's `inputSchema` before the model sees it, and a
/// call's arguments against it before the call is sent. Unsupported
/// constructs make the tool skipped with the reason, as in the renderer.
enum AgentMcpSchema {
    static let byteLimit = 64 * 1024
    static let nodeLimit = 2_048
    static let depthLimit = 24

    static let annotationKeys: Set<String> = ["$schema", "$id", "$comment", "title", "description", "default", "examples", "deprecated",
                                              "readOnly", "writeOnly", "format", "contentMediaType", "contentEncoding"]
    static let assertionKeys: Set<String> = ["type", "enum", "const", "properties", "required", "additionalProperties", "minProperties",
                                             "maxProperties", "items", "minItems", "maxItems", "uniqueItems", "minLength", "maxLength",
                                             "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
                                             "anyOf", "oneOf", "allOf", "not"]
    static let types: Set<String> = ["object", "array", "string", "number", "integer", "boolean", "null"]

    /// Why the schema cannot be offered to the model, or nil.
    static func problem(_ value: Any?) -> String? {
        guard let schema = value as? [String: Any] else { return "没有提供输入参数的结构（inputSchema）。" }
        guard schema["type"] as? String == "object" else { return "输入参数的结构必须是 JSON 对象（type 为 object）。" }
        guard let data = try? JSONSerialization.data(withJSONObject: schema) else { return "输入参数的结构不是有效的 JSON。" }
        if data.count > byteLimit { return "输入参数的结构超过 64 KB。" }
        var nodes = 0
        return check(schema, path: "$", depth: 0, nodes: &nodes)
    }

    private static func check(_ value: Any, path: String, depth: Int, nodes: inout Int) -> String? {
        nodes += 1
        if nodes > nodeLimit { return "输入参数的结构过于复杂。" }
        if depth > depthLimit { return "输入参数的结构嵌套过深。" }
        guard let schema = value as? [String: Any] else { return "\(path) 不是结构对象。" }
        if schema["$ref"] != nil { return "输入参数的结构使用了 $ref（\(path)），暂不支持。" }
        for key in schema.keys.sorted() where !annotationKeys.contains(key) && !assertionKeys.contains(key) {
            return "输入参数的结构使用了暂不支持的关键字“\(key)”（\(path)）。"
        }
        if let type = schema["type"] {
            let list = (type as? String).map { [$0] } ?? (type as? [Any])?.compactMap { $0 as? String }
            guard let list, !list.isEmpty, list.count == (type as? [Any])?.count ?? 1, Set(list).count == list.count,
                  list.allSatisfy(types.contains) else { return "\(path).type 无效。" }
        }
        if let required = schema["required"] {
            guard let list = required as? [Any], list.allSatisfy({ $0 is String }), Set(list.compactMap { $0 as? String }).count == list.count else {
                return "\(path).required 必须是不重复的文字数组。"
            }
        }
        if let properties = schema["properties"] {
            guard let map = properties as? [String: Any] else { return "\(path).properties 必须是对象。" }
            for key in map.keys.sorted() {
                if let problem = check(map[key]!, path: "\(path).properties.\(key)", depth: depth + 1, nodes: &nodes) { return problem }
            }
        }
        if let extra = schema["additionalProperties"], !isBool(extra) {
            if let problem = check(extra, path: "\(path).additionalProperties", depth: depth + 1, nodes: &nodes) { return problem }
        }
        if let items = schema["items"] {
            if items is [Any] { return "\(path).items 不支持元组形式。" }
            if let problem = check(items, path: "\(path).items", depth: depth + 1, nodes: &nodes) { return problem }
        }
        for key in ["anyOf", "oneOf", "allOf"] {
            guard let children = schema[key] else { continue }
            guard let list = children as? [Any], !list.isEmpty else { return "\(path).\(key) 必须是非空数组。" }
            for (index, child) in list.enumerated() {
                if let problem = check(child, path: "\(path).\(key)[\(index)]", depth: depth + 1, nodes: &nodes) { return problem }
            }
        }
        if let not = schema["not"], let problem = check(not, path: "\(path).not", depth: depth + 1, nodes: &nodes) { return problem }
        if let options = schema["enum"], (options as? [Any])?.isEmpty != false { return "\(path).enum 必须是非空数组。" }
        if let unique = schema["uniqueItems"], !isBool(unique) { return "\(path).uniqueItems 必须是 true 或 false。" }
        for key in ["minProperties", "maxProperties", "minItems", "maxItems", "minLength", "maxLength"] {
            guard let candidate = schema[key] else { continue }
            guard let number = candidate as? NSNumber, !isBool(number), number.doubleValue >= 0, number.doubleValue.rounded() == number.doubleValue else {
                return "\(path).\(key) 必须是非负整数。"
            }
        }
        for key in ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"] {
            guard let candidate = schema[key] else { continue }
            guard let number = candidate as? NSNumber, !isBool(number), number.doubleValue.isFinite else { return "\(path).\(key) 必须是数字。" }
            if key == "multipleOf", number.doubleValue <= 0 { return "\(path).multipleOf 必须大于 0。" }
        }
        // A server's `pattern` is advisory: the model reads it, but it is
        // never compiled or evaluated here, so a hostile expression cannot
        // stall the app. The server checks its own input.
        if let pattern = schema["pattern"], !(pattern is String) { return "\(path).pattern 必须是文字。" }
        return nil
    }

    static func isBool(_ value: Any) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    private static func typeLabel(_ type: String) -> String {
        switch type {
        case "object": return "对象"
        case "array": return "数组"
        case "string": return "文字"
        case "number": return "数字"
        case "integer": return "整数"
        case "boolean": return "true 或 false"
        default: return "null"
        }
    }

    private static func matches(_ value: Any, type: String) -> Bool {
        switch type {
        case "object": return value is [String: Any]
        case "array": return value is [Any]
        case "string": return value is String
        case "boolean": return isBool(value)
        case "null": return value is NSNull
        case "number":
            guard let number = value as? NSNumber, !isBool(number) else { return false }
            return number.doubleValue.isFinite
        case "integer":
            guard let number = value as? NSNumber, !isBool(number) else { return false }
            return number.doubleValue.rounded() == number.doubleValue && abs(number.doubleValue) < 1e15
        default: return false
        }
    }

    private static func same(_ left: Any, _ right: Any) -> Bool { AgentJSON(any: left) == AgentJSON(any: right) }

    /// The first way the arguments break the schema, in Chinese, or nil.
    /// `pattern` is not checked (see `check`).
    static func violation(_ value: Any, schema: [String: Any], path: String = "") -> String? {
        let name = path.isEmpty ? "参数" : "参数 \(path) "
        if let type = schema["type"] {
            let list = (type as? String).map { [$0] } ?? (type as? [String]) ?? []
            if !list.isEmpty, !list.contains(where: { matches(value, type: $0) }) {
                return "\(name)必须是\(list.map(typeLabel).joined(separator: "或"))。"
            }
        }
        if let options = schema["enum"] as? [Any], !options.contains(where: { same($0, value) }) {
            let shown = options.prefix(12).map { AgentJSONText.encode($0) }.joined(separator: "、")
            return "\(name)必须是以下之一：\(shown)。"
        }
        if let constant = schema["const"], !same(constant, value) { return "\(name)必须是 \(AgentJSONText.encode(constant))。" }
        if let text = value as? String {
            if let minimum = (schema["minLength"] as? NSNumber)?.intValue, text.count < minimum { return "\(name)至少 \(minimum) 字。" }
            if let maximum = (schema["maxLength"] as? NSNumber)?.intValue, text.count > maximum { return "\(name)最多 \(maximum) 字。" }
        }
        if let number = value as? NSNumber, !isBool(number) {
            let double = number.doubleValue
            if let minimum = (schema["minimum"] as? NSNumber)?.doubleValue, double < minimum { return "\(name)不能小于 \(format(minimum))。" }
            if let maximum = (schema["maximum"] as? NSNumber)?.doubleValue, double > maximum { return "\(name)不能大于 \(format(maximum))。" }
            if let minimum = (schema["exclusiveMinimum"] as? NSNumber)?.doubleValue, double <= minimum { return "\(name)必须大于 \(format(minimum))。" }
            if let maximum = (schema["exclusiveMaximum"] as? NSNumber)?.doubleValue, double >= maximum { return "\(name)必须小于 \(format(maximum))。" }
            if let step = (schema["multipleOf"] as? NSNumber)?.doubleValue, step > 0 {
                let ratio = double / step
                if abs(ratio - ratio.rounded()) > 1e-9 { return "\(name)必须是 \(format(step)) 的倍数。" }
            }
        }
        if let array = value as? [Any] {
            if let minimum = (schema["minItems"] as? NSNumber)?.intValue, array.count < minimum { return "\(name)至少需要 \(minimum) 项。" }
            if let maximum = (schema["maxItems"] as? NSNumber)?.intValue, array.count > maximum { return "\(name)最多 \(maximum) 项。" }
            if (schema["uniqueItems"] as? NSNumber)?.boolValue == true, Set(array.map { AgentJSONText.encode($0) }).count != array.count {
                return "\(name)的各项不能重复。"
            }
            if let items = schema["items"] as? [String: Any] {
                for (index, item) in array.enumerated() {
                    if let problem = violation(item, schema: items, path: "\(path)[\(index)]") { return problem }
                }
            }
        }
        if let object = value as? [String: Any] {
            let properties = schema["properties"] as? [String: Any] ?? [:]
            for key in schema["required"] as? [String] ?? [] where object[key] == nil { return "缺少必填参数 \(join(path, key))。" }
            if let minimum = (schema["minProperties"] as? NSNumber)?.intValue, object.count < minimum { return "\(name)至少需要 \(minimum) 项。" }
            if let maximum = (schema["maxProperties"] as? NSNumber)?.intValue, object.count > maximum { return "\(name)最多 \(maximum) 项。" }
            for key in object.keys.sorted() {
                if let child = properties[key] as? [String: Any] {
                    if let problem = violation(object[key]!, schema: child, path: join(path, key)) { return problem }
                } else if let extra = schema["additionalProperties"] {
                    if isBool(extra), (extra as? NSNumber)?.boolValue == false { return "不支持参数 \(join(path, key))。" }
                    if let extraSchema = extra as? [String: Any], let problem = violation(object[key]!, schema: extraSchema, path: join(path, key)) {
                        return problem
                    }
                }
            }
        }
        if let all = schema["allOf"] as? [[String: Any]] {
            for child in all { if let problem = violation(value, schema: child, path: path) { return problem } }
        }
        if let any = schema["anyOf"] as? [[String: Any]], !any.contains(where: { violation(value, schema: $0, path: path) == nil }) {
            return violation(value, schema: any[0], path: path) ?? "\(name)不符合任何一种允许的形式。"
        }
        if let one = schema["oneOf"] as? [[String: Any]] {
            let passing = one.filter { violation(value, schema: $0, path: path) == nil }.count
            if passing != 1 { return passing == 0 ? (violation(value, schema: one[0], path: path) ?? "\(name)不符合任何一种允许的形式。") : "\(name)同时符合多种形式，无法确定。" }
        }
        if let not = schema["not"] as? [String: Any], violation(value, schema: not, path: path) == nil { return "\(name)是不允许的形式。" }
        return nil
    }

    private static func format(_ value: Double) -> String {
        value.rounded() == value && abs(value) < 1e15 ? String(Int64(value)) : String(value)
    }

    private static func join(_ path: String, _ key: String) -> String { path.isEmpty ? key : "\(path).\(key)" }
}

// MARK: - Results

/// A `tools/call` result as the model reads it: text parts in order, other
/// content summarised (never stored), bounded with a note.
struct AgentMcpCallResult: Equatable {
    static let textLimit = 16_000
    static let errorLimit = 1_000

    var text: String
    var isError: Bool
    /// Characters before truncation.
    var characters: Int
    var truncated: Bool

    init(text: String, isError: Bool, characters: Int, truncated: Bool) {
        self.text = text; self.isError = isError; self.characters = characters; self.truncated = truncated
    }

    /// Reads `content` (text, image, audio, resource, resource_link) and
    /// `structuredContent`. Throws on a result that is neither.
    init(result: [String: Any]) throws {
        let flag = result["isError"]
        if let flag, !(flag is NSNull), !AgentMcpSchema.isBool(flag) { throw AgentMcpError(.protocolError, "工具结果的 isError 无效。") }
        isError = (flag as? NSNumber)?.boolValue == true
        var parts: [String] = []
        if let content = result["content"] as? [Any] {
            for item in content {
                guard let block = item as? [String: Any] else { continue }
                parts.append(Self.describe(block))
            }
        }
        if parts.isEmpty, let structured = result["structuredContent"], !(structured is NSNull) {
            parts.append(AgentJSONText.encode(structured))
        }
        guard result["content"] is [Any] || result["structuredContent"] != nil else {
            throw AgentMcpError(.protocolError, "工具结果既没有 content，也没有 structuredContent。")
        }
        let full = parts.joined(separator: "\n")
        characters = full.count
        let limit = isError ? Self.errorLimit : Self.textLimit
        if full.count > limit {
            truncated = true
            text = String(full.prefix(limit)) + "\n（结果过长，只保留了前 \(limit) 字；原结果共 \(full.count) 字。）"
        } else {
            truncated = false
            text = full.isEmpty ? "（工具没有返回文字内容。）" : full
        }
    }

    private static func size(_ base64: Any?) -> String {
        let length = (base64 as? String)?.count ?? 0
        let bytes = length * 3 / 4
        return bytes >= 1_024 ? "约 \(bytes / 1_024) KB" : "\(bytes) 字节"
    }

    private static func describe(_ block: [String: Any]) -> String {
        let type = block["type"] as? String ?? ""
        let mime = (block["mimeType"] as? String).map { "，\($0)" } ?? ""
        switch type {
        case "text": return block["text"] as? String ?? ""
        case "image": return "［图片\(mime)，\(size(block["data"]))，没有保存］"
        case "audio": return "［音频\(mime)，\(size(block["data"]))，没有保存］"
        case "resource":
            let resource = block["resource"] as? [String: Any] ?? [:]
            let uri = resource["uri"] as? String ?? "（无地址）"
            let kind = (resource["mimeType"] as? String).map { "，\($0)" } ?? ""
            if let text = resource["text"] as? String { return "［资源 \(uri)\(kind)，\(text.count) 字的内容没有展开］" }
            return "［资源 \(uri)\(kind)，\(size(resource["blob"]))的内容没有保存］"
        case "resource_link":
            let uri = block["uri"] as? String ?? ""
            let title = (block["name"] as? String).map { "“\($0)” " } ?? ""
            return "［资源链接 \(title)\(uri)］"
        default:
            return "［不支持的内容类型 \(type.isEmpty ? "未知" : type)］"
        }
    }
}

// MARK: - Errors

struct AgentMcpError: Error, LocalizedError, Equatable {
    enum Kind: Equatable { case configuration, launch, timeout, closed, protocolError, rpc, http, sessionExpired, cancelled }
    let kind: Kind
    let message: String
    var errorDescription: String? { message }

    init(_ kind: Kind, _ message: String) { self.kind = kind; self.message = message }

    static let cancelled = AgentMcpError(.cancelled, "已取消。")
}

// MARK: - Approval

/// 每次询问: the card in the conversation before a call, kept on a notice
/// row (never sent to the model). A waiting card whose turn ended reads 未执行,
/// and so does one whose server was renamed, reconfigured, disabled or
/// deleted before 允许一次: the call is pinned to the server and tool the
/// card named and is never resolved again by name.
struct AgentMcpInvocation: Codable, Equatable {
    enum State: String, Codable { case waiting, allowed, denied, cancelled }

    var callID: String
    var serverID: String
    var serverName: String
    var tool: String
    /// The call's complete arguments as indented JSON, exactly what is sent.
    var arguments: String
    var state: State
    /// Why an allowed card was not executed, e.g. the server was renamed.
    var reason: String?

    var stateLabel: String {
        switch state {
        case .waiting: return "等待你的决定"
        case .allowed: return "已允许一次"
        case .denied: return "已拒绝"
        case .cancelled: return "未执行"
        }
    }

    /// The complete arguments; never shortened, so the author approves
    /// exactly what the server receives.
    static func display(_ arguments: [String: Any]) -> String {
        guard !arguments.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: arguments, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
              let text = String(data: data, encoding: .utf8) else { return "（无参数）" }
        return text
    }
}
