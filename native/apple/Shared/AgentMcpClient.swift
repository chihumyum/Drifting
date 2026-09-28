import Foundation

/// A request in flight. `cancel()` completes it with `cancelled` at once
/// and tells the server; a late response is ignored.
final class AgentMcpPendingRequest {
    let id: String
    let method: String
    fileprivate var completion: ((Result<Any, AgentMcpError>) -> Void)?
    fileprivate var timer: DispatchWorkItem?
    fileprivate weak var owner: AgentMcpRPC?

    fileprivate init(id: String, method: String) { self.id = id; self.method = method }

    var isFinished: Bool { completion == nil }

    func cancel() { owner?.cancel(self) }
}

/// JSON-RPC 2.0 with one MCP server. Main thread only; every callback
/// arrives on the main queue. Subclasses carry the messages: a child
/// process's standard input and output, or Streamable HTTP.
class AgentMcpRPC {
    static let messageLimit = 4 * 1024 * 1024

    /// The connection ended by itself: a crash, an unreadable message or
    /// an expired session. Never called after `close()`.
    var onClosed: ((AgentMcpError) -> Void)?
    /// A notification from the server, e.g. `notifications/tools/list_changed`.
    var onNotification: ((String) -> Void)?
    /// Sent as `MCP-Protocol-Version` once negotiated.
    var protocolVersion: String?
    private(set) var isClosed = false
    private var pending: [String: AgentMcpPendingRequest] = [:]
    private var counter = 0

    /// The child process, for a local command.
    var processID: Int32? { nil }
    /// The last lines the server wrote to standard error.
    var stderrLines: [String] { [] }

    func start() throws {}

    /// Sends a request; `completion` runs once with the `result`, a
    /// JSON-RPC error, a timeout, `cancelled` or the connection's end.
    @discardableResult
    func request(_ method: String, params: [String: Any]?, timeout: TimeInterval,
                 completion: @escaping (Result<Any, AgentMcpError>) -> Void) -> AgentMcpPendingRequest {
        counter += 1
        let request = AgentMcpPendingRequest(id: "rpc-\(counter)", method: method)
        request.owner = self
        request.completion = completion
        guard !isClosed else {
            DispatchQueue.main.async { [weak self] in self?.finish(request, .failure(AgentMcpError(.closed, "连接已关闭。"))) }
            return request
        }
        pending[request.id] = request
        let timer = DispatchWorkItem { [weak self, weak request] in
            guard let self, let request, !request.isFinished else { return }
            self.abandon(request, reason: "timeout")
            let seconds = timeout < 1 ? String(format: "%.1f", timeout) : String(Int(timeout.rounded()))
            self.finish(request, .failure(AgentMcpError(.timeout, "\(seconds) 秒内没有回应。")))
        }
        request.timer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: timer)
        var message: [String: Any] = ["jsonrpc": "2.0", "id": request.id, "method": method]
        if let params { message["params"] = params }
        send(message, request: request)
        return request
    }

    func notify(_ method: String, params: [String: Any]?) {
        guard !isClosed else { return }
        var message: [String: Any] = ["jsonrpc": "2.0", "method": method]
        if let params { message["params"] = params }
        send(message, request: nil)
    }

    /// Delivers one message; `request` is nil for notifications and replies.
    func send(_ message: [String: Any], request: AgentMcpPendingRequest?) {}

    /// The server is told a request was given up (except `initialize`).
    func abandon(_ request: AgentMcpPendingRequest, reason: String) {
        guard request.method != "initialize" else { return }
        notify("notifications/cancelled", params: ["requestId": request.id, "reason": reason == "timeout" ? "timed out in Drifting" : "cancelled in Drifting"])
    }

    fileprivate func cancel(_ request: AgentMcpPendingRequest) {
        guard !request.isFinished, pending[request.id] != nil else { return }
        abandon(request, reason: "cancelled")
        finish(request, .failure(.cancelled))
    }

    func finish(_ request: AgentMcpPendingRequest, _ result: Result<Any, AgentMcpError>) {
        pending[request.id] = nil
        request.timer?.cancel()
        guard let completion = request.completion else { return }
        request.completion = nil
        completion(result)
    }

    /// Whether a request is still waiting.
    func isPending(_ id: String) -> Bool { pending[id] != nil }

    /// A message from the server: a response, a request or a notification.
    /// Anything else ends the connection.
    func receive(_ value: Any) {
        guard !isClosed else { return }
        guard let message = value as? [String: Any], message["jsonrpc"] as? String == "2.0" else {
            lost(AgentMcpError(.protocolError, "服务器发来了无法识别的消息，连接已断开。")); return
        }
        if let method = message["method"] as? String {
            if let id = message["id"] {
                // A request from the server: only ping is answered.
                if method == "ping" { send(["jsonrpc": "2.0", "id": id, "result": [String: Any]()], request: nil) }
                else { send(["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "Method not found"]], request: nil) }
            } else {
                onNotification?(method)
            }
            return
        }
        guard let key = Self.key(message["id"]) else {
            lost(AgentMcpError(.protocolError, "服务器的回应缺少请求编号，连接已断开。")); return
        }
        // A late answer to a request already given up is ignored.
        guard let request = pending[key] else { return }
        finish(request, Self.parse(message))
    }

    static func key(_ id: Any?) -> String? {
        if let text = id as? String, !text.isEmpty { return text }
        if let number = id as? NSNumber, !AgentMcpSchema.isBool(number) { return number.stringValue }
        return nil
    }

    /// `result`, or the JSON-RPC error in Chinese.
    static func parse(_ message: [String: Any]) -> Result<Any, AgentMcpError> {
        let hasResult = message.keys.contains("result"), hasError = message.keys.contains("error")
        guard hasResult != hasError else { return .failure(AgentMcpError(.protocolError, "服务器的回应格式无效。")) }
        if hasResult { return .success(message["result"] ?? NSNull()) }
        let error = message["error"] as? [String: Any] ?? [:]
        let code = (error["code"] as? NSNumber)?.intValue.description ?? "?"
        let text = (error["message"] as? String).map { "：" + String($0.prefix(200)) } ?? ""
        return .failure(AgentMcpError(.rpc, "服务器拒绝了请求（错误 \(code)\(text)）。"))
    }

    /// The connection ended by itself.
    func lost(_ error: AgentMcpError) {
        guard !isClosed else { return }
        isClosed = true
        failAll(error)
        shutdown()
        onClosed?(error)
    }

    private func failAll(_ error: AgentMcpError) {
        for request in Array(pending.values) { finish(request, .failure(error)) }
    }

    /// Ends the connection on purpose; waiting requests fail with `reason`.
    func close(reason: AgentMcpError = AgentMcpError(.closed, "连接已关闭。")) {
        guard !isClosed else { return }
        isClosed = true
        failAll(reason)
        shutdown()
    }

    /// Transport cleanup after `close` or `lost`.
    func shutdown() {}

    /// Ends a child process before returning (the app is quitting).
    func terminateNow() { close() }
}

// MARK: - Local command (stdio)

#if os(macOS)
/// Line-delimited JSON-RPC over a child process: requests to its standard
/// input, responses from its standard output, standard error kept as a
/// bounded log. The process gets a minimal environment plus the
/// configured variables. Closing sends EOF, then SIGTERM, then SIGKILL.
final class AgentMcpStdioRPC: AgentMcpRPC {
    static let stderrLimit = 200
    static let stderrLineLimit = 1_000
    static let inheritedVariables = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "LC_ALL"]

    let command: String
    let arguments: [String]
    let directory: String
    let environment: [String: String]
    private var process: Process?
    private var input: FileHandle?
    private var outputPipe: Pipe?
    private var errorPipe: Pipe?
    private let writes = DispatchQueue(label: "cc.drifting.native-lab.mcp-stdio-write")
    private var errors: [String] = []

    /// The variables every server gets from this app's environment.
    static func baseEnvironment() -> [String: String] {
        var environment: [String: String] = [:]
        let current = ProcessInfo.processInfo.environment
        for name in inheritedVariables { if let value = current[name] { environment[name] = value } }
        if environment["PATH"] == nil { environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin" }
        return environment
    }

    init(command: String, arguments: [String], directory: String, environment: [String: String]) {
        self.command = command; self.arguments = arguments; self.directory = directory; self.environment = environment
    }

    override var processID: Int32? { process.map(\.processIdentifier) }
    override var stderrLines: [String] { errors }

    override func start() throws {
        // A server that exits while a write is queued must not end this app.
        signal(SIGPIPE, SIG_IGN)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command)
        process.arguments = arguments
        if !directory.isEmpty { process.currentDirectoryURL = URL(fileURLWithPath: directory, isDirectory: true) }
        process.environment = environment
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        process.standardInput = stdin; process.standardOutput = stdout; process.standardError = stderr
        let lines = AgentMcpLineSplitter(limit: Self.messageLimit)
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            let (messages, overflow) = lines.append(data)
            DispatchQueue.main.async {
                guard let self else { return }
                for message in messages {
                    guard let value = message else {
                        self.lost(AgentMcpError(.protocolError, "服务器在标准输出中写了无法解析的内容，连接已断开。")); return
                    }
                    self.receive(value)
                }
                if overflow { self.lost(AgentMcpError(.protocolError, "服务器的一条消息超过 4 MB，连接已断开。")) }
            }
        }
        let errorLines = AgentMcpLineSplitter(limit: 64 * 1024)
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            let text = errorLines.appendText(data)
            guard !text.isEmpty else { return }
            DispatchQueue.main.async { self?.logError(text) }
        }
        process.terminationHandler = { [weak self] process in
            let status = process.terminationStatus, signalled = process.terminationReason == .uncaughtSignal
            DispatchQueue.main.async { self?.exited(status: status, signalled: signalled) }
        }
        do {
            try process.run()
        } catch {
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            let exists = FileManager.default.fileExists(atPath: command)
            throw AgentMcpError(.launch, exists ? "无法启动 \(command)，请确认它是可执行文件并有执行权限。" : "找不到可执行文件：\(command)。")
        }
        self.process = process
        input = stdin.fileHandleForWriting
        outputPipe = stdout; errorPipe = stderr
    }

    private func logError(_ lines: [String]) {
        for line in lines { errors.append(String(line.prefix(Self.stderrLineLimit))) }
        if errors.count > Self.stderrLimit { errors.removeFirst(errors.count - Self.stderrLimit) }
    }

    private func exited(status: Int32, signalled: Bool) {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        errorPipe?.fileHandleForReading.readabilityHandler = nil
        guard !isClosed else { return }
        lost(AgentMcpError(.closed, signalled ? "服务器进程被信号 \(status) 结束。" : "服务器进程意外退出（退出码 \(status)）。"))
    }

    override func send(_ message: [String: Any], request: AgentMcpPendingRequest?) {
        guard let input, var data = try? JSONSerialization.data(withJSONObject: message, options: [.withoutEscapingSlashes]) else {
            if let request { finish(request, .failure(AgentMcpError(.protocolError, "请求无法编码为 JSON。"))) }
            return
        }
        guard data.count <= Self.messageLimit else {
            if let request { finish(request, .failure(AgentMcpError(.protocolError, "请求超过 4 MB。"))) }
            return
        }
        data.append(0x0A)
        writes.async { try? input.write(contentsOf: data) }
    }

    override func shutdown() {
        guard let process else { return }
        let handle = input
        input = nil
        writes.async { try? handle?.close() }
        let pid = process.processIdentifier
        // EOF first; then SIGTERM; then SIGKILL, as the MCP lifecycle describes.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            guard process.isRunning else { return }
            process.terminate()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { if process.isRunning { kill(pid, SIGKILL) } }
        }
    }

    override func terminateNow() {
        close()
        guard let process, process.isRunning else { return }
        process.terminate()
        let deadline = Date().addingTimeInterval(1)
        while process.isRunning && Date() < deadline { usleep(10_000) }
        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
            let hard = Date().addingTimeInterval(1)
            while process.isRunning && Date() < hard { usleep(10_000) }
        }
    }
}
#endif

/// Splits a byte stream into newline-terminated lines, thread-safely.
final class AgentMcpLineSplitter {
    private let lock = NSLock()
    private var buffer = Data()
    private let limit: Int

    init(limit: Int) { self.limit = limit }

    /// Each complete line parsed as JSON (nil for one that is not), and
    /// whether an unfinished line grew past the limit.
    func append(_ data: Data) -> ([Any?], Bool) {
        var messages: [Any?] = []
        var overflow = false
        // Blank lines are skipped.
        for line in split(data) where !line.allSatisfy({ $0 == 0x20 || $0 == 0x09 }) {
            if line.count > limit { overflow = true; break }
            messages.append(try? JSONSerialization.jsonObject(with: line, options: [.fragmentsAllowed]))
        }
        lock.lock(); if buffer.count > limit { overflow = true }; lock.unlock()
        return (messages, overflow)
    }

    /// Complete lines as text (standard error).
    func appendText(_ data: Data) -> [String] {
        split(data).map { String(decoding: $0, as: UTF8.self) }.filter { !$0.isEmpty }
    }

    private func split(_ data: Data) -> [Data] {
        lock.lock(); defer { lock.unlock() }
        buffer.append(data)
        var lines: [Data] = []
        while let index = buffer.firstIndex(of: 0x0A) {
            var line = buffer.subdata(in: buffer.startIndex..<index)
            buffer.removeSubrange(buffer.startIndex...index)
            if line.last == 0x0D { line.removeLast() }
            lines.append(line)
        }
        return lines
    }
}

// MARK: - Streamable HTTP

/// Streamable HTTP: each JSON-RPC message is a POST; a response is JSON or
/// an SSE stream that carries it. The session id from `initialize` goes
/// with every later message, and closing sends DELETE. Redirects are never
/// followed, so headers never reach another location.
final class AgentMcpHTTPRPC: AgentMcpRPC {
    let url: URL
    let headers: [String: String]
    private let configuration: URLSessionConfiguration
    private var session: URLSession?
    private(set) var sessionID: String?
    private var exchanges: [Int: Exchange] = [:]
    private var tasks: [String: URLSessionDataTask] = [:]

    fileprivate final class Exchange {
        let request: AgentMcpPendingRequest?
        var status = 0
        var sse = false
        var body = Data()
        var events = AgentSSEBuffer()
        init(request: AgentMcpPendingRequest?) { self.request = request }
    }

    init(url: URL, headers: [String: String], configuration: URLSessionConfiguration) {
        self.url = url; self.headers = headers; self.configuration = configuration
        super.init()
        session = URLSession(configuration: configuration, delegate: AgentMcpHTTPDelegate(owner: self), delegateQueue: .main)
    }

    deinit { session?.invalidateAndCancel() }

    private func urlRequest(method: String) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let sessionID { request.setValue(sessionID, forHTTPHeaderField: "Mcp-Session-Id") }
        if let protocolVersion { request.setValue(protocolVersion, forHTTPHeaderField: "MCP-Protocol-Version") }
        return request
    }

    override func send(_ message: [String: Any], request: AgentMcpPendingRequest?) {
        guard let session, let body = try? JSONSerialization.data(withJSONObject: message, options: [.withoutEscapingSlashes]),
              body.count <= Self.messageLimit else {
            if let request { finish(request, .failure(AgentMcpError(.protocolError, "请求无法编码或超过 4 MB。"))) }
            return
        }
        var post = urlRequest(method: "POST")
        post.httpBody = body
        let task = session.dataTask(with: post)
        exchanges[task.taskIdentifier] = Exchange(request: request)
        if let request { tasks[request.id] = task }
        task.resume()
    }

    override func abandon(_ request: AgentMcpPendingRequest, reason: String) {
        tasks.removeValue(forKey: request.id)?.cancel()
        super.abandon(request, reason: reason)
    }

    override func finish(_ request: AgentMcpPendingRequest, _ result: Result<Any, AgentMcpError>) {
        tasks[request.id] = nil
        super.finish(request, result)
    }

    override func shutdown() {
        if let sessionID {
            // The server may end the session; the answer is not awaited.
            var delete = URLRequest(url: url)
            delete.httpMethod = "DELETE"
            for (name, value) in headers { delete.setValue(value, forHTTPHeaderField: name) }
            delete.setValue(sessionID, forHTTPHeaderField: "Mcp-Session-Id")
            if let protocolVersion { delete.setValue(protocolVersion, forHTTPHeaderField: "MCP-Protocol-Version") }
            delete.timeoutInterval = 10
            let once = URLSession(configuration: configuration, delegate: AgentMcpNoRedirects(), delegateQueue: nil)
            once.dataTask(with: delete).resume()
            once.finishTasksAndInvalidate()
        }
        sessionID = nil
        session?.invalidateAndCancel()
        session = nil
        exchanges = [:]; tasks = [:]
    }

    // Delegate events, on the main queue.

    fileprivate func response(_ task: URLSessionTask, _ response: URLResponse) -> Bool {
        guard let exchange = exchanges[task.taskIdentifier], !isClosed else { return false }
        let http = response as? HTTPURLResponse
        exchange.status = http?.statusCode ?? 0
        exchange.sse = (http?.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased().contains("text/event-stream")
        if let value = http?.value(forHTTPHeaderField: "Mcp-Session-Id"), !value.isEmpty, sessionID == nil,
           value.range(of: "^[\\x21-\\x7E]{1,512}$", options: .regularExpression) != nil {
            sessionID = value
        }
        if exchange.status == 404, sessionID != nil, exchange.request?.method != "initialize" {
            // The server forgot the session; it is not ended again.
            sessionID = nil
            lost(AgentMcpError(.sessionExpired, "MCP 会话已过期，需要重新连接。"))
            return false
        }
        guard (200..<300).contains(exchange.status) else {
            if let request = exchange.request { finish(request, .failure(Self.failure(exchange.status))) }
            return false
        }
        return true
    }

    fileprivate func data(_ task: URLSessionTask, _ data: Data) {
        guard let exchange = exchanges[task.taskIdentifier], !isClosed else { return }
        if exchange.sse {
            for payload in exchange.events.append(data) {
                guard let value = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) else {
                    if let request = exchange.request { finish(request, .failure(AgentMcpError(.protocolError, "服务器的 SSE 数据无法解析。"))) }
                    task.cancel(); return
                }
                receive(value)
                if isClosed { return }
                // The answer arrived; the stream is not needed any longer.
                if let request = exchange.request, !isPending(request.id) { task.cancel(); return }
            }
        } else {
            exchange.body.append(data)
            if exchange.body.count > Self.messageLimit {
                if let request = exchange.request { finish(request, .failure(AgentMcpError(.protocolError, "服务器的回应超过 4 MB。"))) }
                task.cancel()
            }
        }
    }

    fileprivate func complete(_ task: URLSessionTask, _ error: Error?) {
        guard let exchange = exchanges.removeValue(forKey: task.taskIdentifier), !isClosed else { return }
        guard let request = exchange.request, isPending(request.id) else { return }
        if let error {
            if (error as? URLError)?.code == .cancelled { return }
            finish(request, .failure(Self.network(error))); return
        }
        if exchange.sse || exchange.body.isEmpty {
            finish(request, .failure(AgentMcpError(.protocolError, "服务器的回应中没有这次请求的结果。"))); return
        }
        guard let value = try? JSONSerialization.jsonObject(with: exchange.body) else {
            finish(request, .failure(AgentMcpError(.protocolError, "服务器的回应不是有效的 JSON。"))); return
        }
        for message in (value as? [Any]) ?? [value] { receive(message) }
        if isPending(request.id) { finish(request, .failure(AgentMcpError(.protocolError, "服务器的回应中没有这次请求的结果。"))) }
    }

    static func failure(_ status: Int) -> AgentMcpError {
        switch status {
        case 401, 403: return AgentMcpError(.http, "服务器拒绝了认证（HTTP \(status)），请检查请求头。")
        case 404: return AgentMcpError(.http, "服务器地址不存在（HTTP 404）。")
        case 500...599: return AgentMcpError(.http, "服务器暂时不可用（HTTP \(status)）。")
        default: return AgentMcpError(.http, "服务器拒绝了请求（HTTP \(status)）。")
        }
    }

    static func network(_ error: Error) -> AgentMcpError {
        switch (error as? URLError)?.code {
        case .notConnectedToInternet?, .networkConnectionLost?, .dataNotAllowed?: return AgentMcpError(.closed, "网络未连接。")
        case .timedOut?: return AgentMcpError(.timeout, "请求超时。")
        case .cannotFindHost?, .cannotConnectToHost?, .dnsLookupFailed?: return AgentMcpError(.closed, "无法连接服务器。")
        case .secureConnectionFailed?, .serverCertificateUntrusted?, .serverCertificateHasBadDate?: return AgentMcpError(.closed, "安全连接失败。")
        default: return AgentMcpError(.closed, "网络错误。")
        }
    }
}

private final class AgentMcpHTTPDelegate: NSObject, URLSessionDataDelegate {
    weak var owner: AgentMcpHTTPRPC?
    init(owner: AgentMcpHTTPRPC) { self.owner = owner }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        completionHandler(owner?.response(dataTask, response) == true ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        owner?.data(dataTask, data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        owner?.complete(task, error)
    }
}

private final class AgentMcpNoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
