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
    /// Whether a child process is still running, e.g. in its shutdown window.
    var isRunning: Bool { false }
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
    /// Bytes of an unfinished standard-error line kept; older ones are dropped.
    static let stderrPendingLimit = 64 * 1024
    static let inheritedVariables = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "LC_ALL"]
    /// Seconds after EOF before SIGTERM, and after SIGTERM before SIGKILL.
    /// Acceptance lengthens them to show that quitting does not wait for them.
    static var shutdownDelays: (terminate: TimeInterval, kill: TimeInterval) = (0.5, 1.5)

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
    /// Standard error split into display lines, bounded.
    let errorLines = AgentMcpStderrSplitter(limit: AgentMcpStdioRPC.stderrPendingLimit, keep: AgentMcpStdioRPC.stderrLimit)

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
    override var isRunning: Bool { process?.isRunning == true }
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
        let errorLines = self.errorLines
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            let text = errorLines.append(data)
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
        let delays = Self.shutdownDelays
        // EOF first; then SIGTERM; then SIGKILL, as the MCP lifecycle describes.
        DispatchQueue.main.asyncAfter(deadline: .now() + delays.terminate) {
            guard process.isRunning else { return }
            process.terminate()
            DispatchQueue.main.asyncAfter(deadline: .now() + delays.kill) { if process.isRunning { kill(pid, SIGKILL) } }
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

/// Splits a byte stream into newline-terminated JSON lines, thread-safely.
/// Only the new bytes of each chunk are searched, and a line that grows
/// past the limit ends the stream: nothing more is buffered.
final class AgentMcpLineSplitter {
    private let lock = NSLock()
    private var buffer = Data()
    private var overflowed = false
    private let limit: Int

    init(limit: Int) { self.limit = limit }

    /// Each complete line parsed as JSON (nil for one that is not), and
    /// whether an unfinished line grew past the limit.
    func append(_ data: Data) -> ([Any?], Bool) {
        lock.lock()
        guard !overflowed else { lock.unlock(); return ([], true) }
        var lines: [Data] = []
        var start = data.startIndex
        while let end = data[start...].firstIndex(of: 0x0A) {
            var line = buffer
            line.append(data[start..<end])
            buffer = Data()
            if line.last == 0x0D { line.removeLast() }
            lines.append(line)
            start = data.index(after: end)
        }
        buffer.append(data[start...])
        if buffer.count > limit || lines.contains(where: { $0.count > limit }) { overflowed = true; buffer = Data() }
        let overflow = overflowed
        lock.unlock()
        var messages: [Any?] = []
        // Blank lines are skipped.
        for line in lines where !line.allSatisfy({ $0 == 0x20 || $0 == 0x09 }) {
            if line.count > limit { break }
            messages.append(try? JSONSerialization.jsonObject(with: line, options: [.fragmentsAllowed]))
        }
        return (messages, overflow)
    }
}

/// Standard error as display lines, thread-safely. `\n`, `\r\n` and a lone
/// `\r` (progress output) each end a line; an unfinished line keeps only its
/// newest `limit` bytes, so a stream without line breaks stays bounded, and
/// one chunk yields at most its last `keep` non-empty lines.
final class AgentMcpStderrSplitter {
    private let lock = NSLock()
    private var pending = Data()
    private var afterCR = false
    let limit: Int
    let keep: Int

    init(limit: Int, keep: Int) { self.limit = limit; self.keep = keep }

    /// Bytes of the unfinished line held now; never more than `limit`.
    var pendingCount: Int { lock.lock(); defer { lock.unlock() }; return pending.count }

    func append(_ data: Data) -> [String] {
        lock.lock(); defer { lock.unlock() }
        var lines: [String] = []
        var start = data.startIndex
        while start < data.endIndex {
            if afterCR, data[start] == 0x0A { afterCR = false; start = data.index(after: start); continue }
            afterCR = false
            guard let end = data[start...].firstIndex(where: { $0 == 0x0A || $0 == 0x0D }) else {
                hold(data[start...]); break
            }
            hold(data[start..<end])
            let line = String(decoding: pending, as: UTF8.self)
            pending = Data()
            if !line.trimmingCharacters(in: .whitespaces).isEmpty {
                lines.append(line)
                if lines.count > keep * 2 { lines.removeFirst(lines.count - keep) }
            }
            afterCR = data[end] == 0x0D
            start = data.index(after: end)
        }
        return Array(lines.suffix(keep))
    }

    /// Adds to the unfinished line, dropping its oldest bytes past `limit`.
    private func hold(_ bytes: Data) {
        if bytes.count >= limit {
            pending = Data(bytes.suffix(limit))
        } else {
            pending.append(bytes)
            if pending.count > limit { pending.removeFirst(pending.count - limit) }
        }
    }
}

/// Incremental Server-Sent Events framing for Streamable HTTP. Each byte is
/// looked at once (never rescanned from the start), the `data:` lines of an
/// event are joined, and the unfinished line plus the event's data never
/// exceed `limit`: past it the stream overflows and nothing more is kept.
struct AgentMcpSSEParser {
    let limit: Int
    private var line = Data()
    private var event = Data()
    private var hasData = false
    private var afterCR = false
    private(set) var overflowed = false

    init(limit: Int) { self.limit = limit }

    /// Bytes held for the unfinished line and event.
    var pendingCount: Int { line.count + event.count }

    /// The data of each event completed by this chunk, in order, and
    /// whether the stream overflowed (events before it are still returned).
    mutating func append(_ chunk: Data) -> (events: [Data], overflow: Bool) {
        guard !overflowed else { return ([], true) }
        var events: [Data] = []
        var start = chunk.startIndex
        while start < chunk.endIndex {
            if afterCR, chunk[start] == 0x0A { afterCR = false; start = chunk.index(after: start); continue }
            afterCR = false
            let end = chunk[start...].firstIndex { $0 == 0x0A || $0 == 0x0D }
            line.append(chunk[start..<(end ?? chunk.endIndex)])
            guard pendingCount <= limit else { return overflow(events) }
            guard let end else { break }
            afterCR = chunk[end] == 0x0D
            start = chunk.index(after: end)
            finishLine(into: &events)
            guard pendingCount <= limit else { return overflow(events) }
        }
        return (events, false)
    }

    private mutating func overflow(_ events: [Data]) -> (events: [Data], overflow: Bool) {
        overflowed = true
        line = Data(); event = Data(); hasData = false
        return (events, true)
    }

    /// A blank line ends the event; `data:` lines add to it; comments and
    /// other fields (`event:`, `id:`, `retry:`) are ignored.
    private mutating func finishLine(into events: inout [Data]) {
        let current = line
        line = Data()
        guard !current.isEmpty else {
            if hasData { events.append(event) }
            event = Data(); hasData = false
            return
        }
        guard current.first != 0x3A else { return }
        let bytes = [UInt8](current)
        let colon = bytes.firstIndex(of: 0x3A)
        guard Array(bytes[..<(colon ?? bytes.count)]) == Array("data".utf8) else { return }
        var value = colon.map { Array(bytes[($0 + 1)...]) } ?? []
        if value.first == 0x20 { value.removeFirst() }
        if hasData { event.append(0x0A) }
        event.append(contentsOf: value)
        hasData = true
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
    /// A notification or reply POST whose answer is still open after this
    /// long is cancelled; requests have their own timeouts.
    let notificationTimeout: TimeInterval
    private let configuration: URLSessionConfiguration
    private var session: URLSession?
    private(set) var sessionID: String?
    private var exchanges: [Int: Exchange] = [:]
    private var tasks: [String: URLSessionDataTask] = [:]

    fileprivate final class Exchange {
        let request: AgentMcpPendingRequest?
        var status = 0
        var sse = false
        /// The stream was refused (too large or unreadable); later bytes are dropped.
        var ended = false
        var body = Data()
        var events = AgentMcpSSEParser(limit: AgentMcpRPC.messageLimit)
        var timer: DispatchWorkItem?
        init(request: AgentMcpPendingRequest?) { self.request = request }
    }

    init(url: URL, headers: [String: String], configuration: URLSessionConfiguration, notificationTimeout: TimeInterval = 30) {
        self.url = url; self.headers = headers; self.configuration = configuration; self.notificationTimeout = notificationTimeout
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
        let exchange = Exchange(request: request)
        exchanges[task.taskIdentifier] = exchange
        if let request {
            tasks[request.id] = task
        } else {
            // A notification's answer (202, or a stream the server keeps open) is not awaited for ever.
            let timer = DispatchWorkItem { [weak task] in task?.cancel() }
            exchange.timer = timer
            DispatchQueue.main.asyncAfter(deadline: .now() + notificationTimeout, execute: timer)
        }
        task.resume()
    }

    /// Open POSTs, for acceptance: notifications and replies still waiting for their answer to end.
    var openExchanges: Int { exchanges.count }

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
        for exchange in exchanges.values { exchange.timer?.cancel() }
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
        guard let exchange = exchanges[task.taskIdentifier], !exchange.ended, !isClosed else { return }
        // The stream is refused: the request fails and nothing more is read.
        func refuse(_ message: String) {
            exchange.ended = true
            if let request = exchange.request, isPending(request.id) { finish(request, .failure(AgentMcpError(.protocolError, message))) }
            task.cancel()
        }
        if exchange.sse {
            let (events, overflow) = exchange.events.append(data)
            for payload in events {
                guard let value = try? JSONSerialization.jsonObject(with: payload) else { refuse("服务器的 SSE 数据无法解析。"); return }
                receive(value)
                if isClosed { return }
                // The answer arrived; the stream is not needed any longer.
                if let request = exchange.request, !isPending(request.id) { exchange.ended = true; task.cancel(); return }
            }
            if overflow { refuse("服务器的一条 SSE 消息超过 4 MB（或一直没有结束），这次请求已停止。") }
        } else {
            exchange.body.append(data)
            if exchange.body.count > Self.messageLimit { refuse("服务器的回应超过 4 MB。") }
        }
    }

    fileprivate func complete(_ task: URLSessionTask, _ error: Error?) {
        let removed = exchanges.removeValue(forKey: task.taskIdentifier)
        removed?.timer?.cancel()
        guard let exchange = removed, !isClosed else { return }
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
