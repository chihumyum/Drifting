import AVFoundation
import Foundation

// MARK: - Credential

/// The speech transcription key: the author's DashScope (阿里云百炼) key for
/// Qwen3-ASR, a Keychain item beside the writing assistant's provider keys
/// (`Drifting Native Lab`, account `byok.dashscope`, as the renderer names
/// it). It is not an LLM key and never reaches a model provider.
enum SpeechCredentials {
    static let account = "byok.dashscope"

    static func key(_ secrets: AgentSecretStore) throws -> String? {
        guard let key = try secrets.secret(account: account), !key.isEmpty else { return nil }
        return key
    }

    static func masked(_ secrets: AgentSecretStore) -> String? {
        guard let key = try? key(secrets) else { return nil }
        return AgentCredentials.masked(key)
    }

    static func save(_ key: String, in secrets: AgentSecretStore) throws {
        guard let key = AgentCredentials.normalized(key) else { throw LabError.message("Key 不能为空。") }
        try secrets.setSecret(key, account: account)
    }
}

// MARK: - Recognition context

/// The project's proper nouns for transcription: a recognition context the
/// ASR model is biased with (elements with categories and aliases first,
/// then storylines, chapter and drift titles, clipped to 6,000 characters)
/// and the glossary the pinyin correction restores (every element name and
/// alias, and storyline names).
struct VoiceRecognitionContext: Equatable {
    static let limit = 6_000

    var text: String
    var glossary: [String]

    static let empty = VoiceRecognitionContext(text: "", glossary: [])

    static func make(projectName: String, library: WorkspaceElementLibrary, storylines: [WorkspaceStoryline],
                     chapters: [String], drifts: [String], limit: Int = limit) -> VoiceRecognitionContext {
        var remaining = limit
        let categories = Dictionary(library.categories.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        func names(_ element: WorkspaceElement) -> [String] {
            ([element.name] + element.aliases).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        }
        let elementEntries = library.elements.compactMap { element -> String? in
            let all = names(element)
            guard let first = all.first else { return nil }
            let category = element.categoryId.flatMap { categories[$0] }.map { "[\($0)] " } ?? ""
            let alias = all.count > 1 ? "（又称：\(all.dropFirst().joined(separator: "、"))）" : ""
            return category + first + alias
        }
        func clipped(_ header: String, _ entries: [String]) -> String {
            let entries = entries.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
            guard !entries.isEmpty, remaining > header.count else { return "" }
            var kept: [String] = [], used = header.count
            for entry in entries {
                let cost = entry.count + 1
                if used + cost > remaining { break }
                kept.append(entry); used += cost
            }
            guard !kept.isEmpty else { return "" }
            remaining -= used
            return header + kept.joined(separator: "、")
        }
        let intro = "这是长篇写作项目《\(projectName)》的口述录音。请按下列专有名词的准确写法转写，保留作者的口语表达。"
        remaining -= intro.count
        let sections = [clipped("\n项目设定：", elementEntries), clipped("\n故事线：", storylines.map(\.name)),
                        clipped("\n章节：", chapters), clipped("\n灵感：", drifts)]
        var seen = Set<String>(), glossary: [String] = []
        for term in library.elements.flatMap(names) + storylines.map({ $0.name.trimmingCharacters(in: .whitespacesAndNewlines) })
        where !term.isEmpty && seen.insert(term).inserted {
            glossary.append(term)
        }
        return VoiceRecognitionContext(text: intro + sections.joined(), glossary: glossary)
    }

    /// Reads the project's library, storylines, chapters and drifts. A
    /// part that cannot be read is left out; transcription still works.
    static func read(workspace: LabWorkspaceCore, projectID: String, projectName: String,
                     completion: @escaping (VoiceRecognitionContext) -> Void) {
        workspace.elementLibrary(projectID: projectID) { library in
            workspace.storylineLibrary(projectID: projectID) { storylines in
                workspace.chapters(projectID: projectID) { chapters in
                    workspace.driftLibrary(projectID: projectID) { drifts in
                        completion(make(projectName: projectName,
                                        library: (try? library.get()) ?? .empty,
                                        storylines: (try? storylines.get())?.storylines ?? [],
                                        chapters: ((try? chapters.get()) ?? []).map(\.title),
                                        drifts: ((try? drifts.get())?.drifts ?? []).map(\.title)))
                    }
                }
            }
        }
    }
}

// MARK: - Proper-noun correction

/// One proper noun restored in a transcript.
struct VoiceCorrection: Equatable {
    let index: Int
    let from: String
    let to: String
}

/// Deterministic post-ASR correction, as the renderer's pinyin layer: a run
/// of Han characters that sounds like a glossary term takes the project's
/// spelling. Two-character terms need the same syllables with the same
/// tones; longer terms match toneless pinyin, then the common fuzzy merges
/// z/zh, c/ch, s/sh, n/l and -n/-ng. ü stays distinct from u (路 lu, 旅 lv),
/// so everyday words (黎明, 路人, 知识) are not taken for names that only
/// sound alike without tones. A run that sounds like two different terms is
/// left alone. Readings come from macOS's Mandarin transliteration: each
/// character's own reading, and for glossary terms also the reading in the
/// term, so a polyphone read differently in the name still lines up.
enum VoicePinyin {
    static let fuzzyMinimumSyllables = 3
    /// Terms shorter than this must match with tones.
    static let tonelessMinimumSyllables = 3
    static let maximumTermCharacters = 8

    static func isHan(_ character: Character) -> Bool {
        guard character.unicodeScalars.count == 1, let scalar = character.unicodeScalars.first else { return false }
        switch scalar.value {
        case 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xF900...0xFAFF, 0x20000...0x2EBEF, 0x30000...0x3134F: return true
        default: return false
        }
    }

    /// One syllable: toneless with ü as v (旅 → lv, 略 → lve) and as
    /// transliterated with its tone mark (lǚ).
    struct Syllable: Hashable {
        let plain: String
        let toned: String

        init?(_ latin: String) {
            let toned = latin.precomposedStringWithCanonicalMapping.lowercased().trimmingCharacters(in: .whitespaces)
            var folded = String.UnicodeScalarView()
            for scalar in toned.unicodeScalars {
                switch scalar {
                case "ü", "ǖ", "ǘ", "ǚ", "ǜ": folded.append("v")
                default: folded.append(scalar)
                }
            }
            let plain = String(folded).applyingTransform(.stripDiacritics, reverse: false) ?? ""
            guard !plain.isEmpty, plain.allSatisfy({ $0.isASCII && $0.isLetter }) else { return nil }
            self.plain = plain; self.toned = toned
        }
    }

    private static var cache: [Character: Syllable?] = [:]
    private static let lock = NSLock()

    /// The reading of one character, e.g. 岚 → lan (lán).
    static func syllable(_ character: Character) -> Syllable? {
        lock.lock(); defer { lock.unlock() }
        if let cached = cache[character] { return cached }
        let value = String(character).applyingTransform(.mandarinToLatin, reverse: false).flatMap(Syllable.init)
        cache[character] = .some(value)
        return value
    }

    /// The toneless reading of one character, e.g. 岚 → lan, 旅 → lv.
    static func reading(_ character: Character) -> String? { syllable(character)?.plain }

    /// Each syllable of a term read in context, when it splits one per character.
    static func contextReadings(_ term: String) -> [Syllable]? {
        let syllables = (term.applyingTransform(.mandarinToLatin, reverse: false) ?? "").split(separator: " ").map { Syllable(String($0)) }
        guard syllables.count == term.count, syllables.allSatisfy({ $0 != nil }) else { return nil }
        return syllables.compactMap { $0 }
    }

    static func fuzzy(_ syllable: String) -> String {
        var out = syllable
        if out.hasPrefix("zh") || out.hasPrefix("ch") || out.hasPrefix("sh") { out = String(out.prefix(1)) + out.dropFirst(2) }
        else if out.hasPrefix("n") { out = "l" + out.dropFirst() }
        if out.hasSuffix("ng") { out = String(out.dropLast()) }
        return out
    }

    private struct Entry {
        let term: String
        let characters: [Character]
        let readings: [Set<String>]
        let tonedReadings: [Set<String>]
        let fuzzyReadings: [Set<String>]
    }

    static func correct(_ text: String, glossary: [String]) -> (text: String, corrections: [VoiceCorrection]) {
        let terms = Array(Set(glossary.filter { term in
            term.count >= 2 && term.count <= maximumTermCharacters && term.allSatisfy(isHan)
        })).sorted { $0.count != $1.count ? $0.count > $1.count : $0 < $1 }
        guard !text.isEmpty, !terms.isEmpty else { return (text, []) }
        let entries = terms.map { term -> Entry in
            let characters = Array(term), inContext = contextReadings(term)
            let syllables = characters.enumerated().map { index, character -> Set<Syllable> in
                var set = Set<Syllable>()
                if let own = syllable(character) { set.insert(own) }
                if let inContext { set.insert(inContext[index]) }
                return set
            }
            let readings = syllables.map { Set($0.map(\.plain)) }
            return Entry(term: term, characters: characters, readings: readings, tonedReadings: syllables.map { Set($0.map(\.toned)) },
                         fuzzyReadings: readings.map { Set($0.map(fuzzy)) })
        }
        let characters = Array(text)
        let syllables = characters.map { isHan($0) ? syllable($0) : nil }
        let readings = syllables.map { $0.map { Set([$0.plain]) } }
        let tonedReadings = syllables.map { $0.map { Set([$0.toned]) } }
        let fuzzyReadings = readings.map { $0.map { Set($0.map(fuzzy)) } }
        var corrections: [VoiceCorrection] = [], output = "", index = 0
        while index < characters.count {
            var replaced = false
            if readings[index] != nil {
                for fuzzy in [false, true] {
                    var candidates = Set<String>(), matched = 0
                    for entry in entries {
                        if fuzzy && entry.characters.count < fuzzyMinimumSyllables { continue }
                        let length = entry.characters.count
                        if matched > 0 && length != matched { continue }
                        if index + length > characters.count { continue }
                        let toned = length < tonelessMinimumSyllables
                        let fits = (0..<length).allSatisfy { offset in
                            let window = fuzzy ? fuzzyReadings[index + offset] : toned ? tonedReadings[index + offset] : readings[index + offset]
                            guard let window else { return false }
                            let wanted = fuzzy ? entry.fuzzyReadings[offset] : toned ? entry.tonedReadings[offset] : entry.readings[offset]
                            return !window.isDisjoint(with: wanted)
                        }
                        guard fits else { continue }
                        candidates.insert(entry.term)
                        matched = length
                    }
                    guard !candidates.isEmpty else { continue }
                    let original = String(characters[index..<(index + matched)])
                    if candidates.contains(original) {
                        // Already the project's spelling: kept whole.
                        output += original; index += matched; replaced = true
                        break
                    }
                    guard candidates.count == 1, let term = candidates.first else { break }
                    corrections.append(VoiceCorrection(index: index, from: original, to: term))
                    output += term; index += matched; replaced = true
                    break
                }
            }
            if !replaced { output.append(characters[index]); index += 1 }
        }
        return (output, corrections)
    }
}

// MARK: - Audio

/// 16 kHz mono 16-bit PCM, the shape recordings are sent in.
enum VoiceAudio {
    static let sampleRate = 16_000

    /// A RIFF/WAVE file around little-endian PCM samples.
    static func wav(_ samples: [Int16], sampleRate: Int = sampleRate) -> Data {
        var data = Data()
        func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        let bytes = samples.count * 2
        data.append(contentsOf: Array("RIFF".utf8)); append(UInt32(36 + bytes))
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); append(UInt32(16)); append(UInt16(1)); append(UInt16(1))
        append(UInt32(sampleRate)); append(UInt32(sampleRate * 2)); append(UInt16(2)); append(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); append(UInt32(bytes))
        for sample in samples { append(sample) }
        return data
    }
}

enum VoiceMicrophoneStatus { case authorized, denied, notDetermined }

/// Microphone permission. macOS asks the author only on first use.
protocol VoiceMicrophone: AnyObject {
    var status: VoiceMicrophoneStatus { get }
    func request(_ done: @escaping (Bool) -> Void)
}

/// Where recorded samples come from: 16 kHz mono Int16 on the main queue.
protocol VoiceAudioSource: AnyObject {
    func start(onSamples: @escaping ([Int16]) -> Void, onFailure: @escaping (String) -> Void) throws
    func stop()
}

final class SystemMicrophone: VoiceMicrophone {
    var status: VoiceMicrophoneStatus {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return .authorized
        case .notDetermined: return .notDetermined
        default: return .denied
        }
    }

    func request(_ done: @escaping (Bool) -> Void) {
        AVCaptureDevice.requestAccess(for: .audio) { granted in DispatchQueue.main.async { done(granted) } }
    }
}

/// The default input through AVAudioEngine, converted to 16 kHz mono Int16.
/// When the audio hardware or its format changes (a headset plugged in or
/// out, another default input) the engine stops itself and the tap goes
/// quiet; the recording then ends with `deviceChanged` so what was captured
/// is still transcribed.
final class AudioEngineSource: VoiceAudioSource {
    static let deviceChanged = "音频设备发生了变化（例如接上或拔下了耳机、麦克风），录音已停止，已录下的部分会照常转写。"

    let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var running = false
    private var configurationObserver: NSObjectProtocol?

    func start(onSamples: @escaping ([Int16]) -> Void, onFailure: @escaping (String) -> Void) throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0,
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(VoiceAudio.sampleRate), channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: format, to: target) else {
            throw LabError.message("找不到可用的麦克风输入。请检查 系统设置 › 声音 › 输入。")
        }
        self.converter = converter
        input.installTap(onBus: 0, bufferSize: 4_096, format: format) { buffer, _ in
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / format.sampleRate) + 32
            guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
            var consumed = false
            var error: NSError?
            converter.convert(to: output, error: &error) { _, status in
                if consumed { status.pointee = .noDataNow; return nil }
                consumed = true
                status.pointee = .haveData
                return buffer
            }
            guard error == nil, let channel = output.int16ChannelData else { return }
            let samples = Array(UnsafeBufferPointer(start: channel[0], count: Int(output.frameLength)))
            DispatchQueue.main.async { onSamples(samples) }
        }
        engine.prepare()
        do { try engine.start() } catch {
            input.removeTap(onBus: 0)
            throw LabError.message("麦克风没有开始录音：\(error.localizedDescription)")
        }
        running = true
        watchConfigurationChanges(onFailure: onFailure)
    }

    /// Reports this engine's configuration change once, on the main queue,
    /// until `stop`.
    func watchConfigurationChanges(onFailure: @escaping (String) -> Void) {
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
        configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine,
                                                                       queue: .main) { [weak self] _ in
            guard let self, let observer = self.configurationObserver else { return }
            NotificationCenter.default.removeObserver(observer)
            self.configurationObserver = nil
            onFailure(Self.deviceChanged)
        }
    }

    func stop() {
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }
        guard running else { return }
        running = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}

// MARK: - DashScope Qwen3-ASR

/// DashScope (阿里云百炼) Qwen3-ASR over its synchronous multimodal
/// generation endpoint, as the renderer calls it: the recording as a WAV
/// data URI in the user message, the recognition context as the system
/// message, inverse text normalization off. The key goes only into the
/// `authorization` header.
enum DashScopeASR {
    static let endpoint = URL(string: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation")!
    static let model = "qwen3-asr-flash"
    /// Raw audio per request, keeping the base64 body under the 10 MB cap.
    static let maxAudioBytes = 7_000_000

    static func request(wav: Data, context: String, apiKey: String) throws -> URLRequest {
        guard wav.count <= maxAudioBytes else { throw LabError.message("这段录音太长，无法一次转写。") }
        var messages: [[String: Any]] = []
        let context = context.trimmingCharacters(in: .whitespacesAndNewlines)
        if !context.isEmpty { messages.append(["role": "system", "content": [["text": context]]]) }
        messages.append(["role": "user", "content": [["audio": "data:audio/wav;base64," + wav.base64EncodedString()]]])
        let body: [String: Any] = ["model": model, "input": ["messages": messages], "parameters": ["asr_options": ["enable_itn": false]]]
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes])
        return request
    }

    /// The transcript text of a reply.
    static func transcript(_ data: Data) throws -> String {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = (json["output"] as? [String: Any])?["choices"] as? [[String: Any]],
              let content = (choices.first?["message"] as? [String: Any])?["content"] as? [[String: Any]] else {
            throw LabError.message("转写服务返回的数据无法解析。")
        }
        return content.compactMap { $0["text"] as? String }.joined().trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A failed request in Chinese; bodies of 401/403 are never shown.
    static func failure(status: Int) -> String {
        switch status {
        case 401, 403: return "语音转写 Key 无效或已过期（HTTP \(status)）。请在 设置 › 模型服务 › 语音转写 中检查。"
        case 429: return "转写请求过于频繁或额度已用尽（HTTP 429），录音已保留，可以稍后重试。"
        case 400..<500: return "这段录音被转写服务拒绝（HTTP \(status)），录音已保留，可以重试。"
        default: return "转写失败（HTTP \(status)），录音已保留，可以重试。"
        }
    }
}

/// One transcription request; redirects are refused so the key never goes
/// elsewhere. The callback arrives once, on the main queue.
final class VoiceTranscriptionCall: NSObject, URLSessionTaskDelegate {
    private var completion: ((Result<String, LabError>) -> Void)?
    private var task: URLSessionDataTask?

    init(_ request: URLRequest, configuration: URLSessionConfiguration, completion: @escaping (Result<String, LabError>) -> Void) {
        self.completion = completion
        super.init()
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
        let task = session.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            if let error {
                let reason = (error as? URLError)?.code == .notConnectedToInternet ? "网络未连接" : "无法连接转写服务"
                self.finish(.failure(.message("\(reason)，录音已保留，可以重试。"))); return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else { self.finish(.failure(.message(DashScopeASR.failure(status: status)))); return }
            do { self.finish(.success(try DashScopeASR.transcript(data ?? Data()))) } catch {
                self.finish(.failure(.message((error as? LabError)?.errorDescription ?? "转写服务返回的数据无法解析。")))
            }
        }
        self.task = task
        task.resume()
        session.finishTasksAndInvalidate()
    }

    func cancel() { completion = nil; task?.cancel() }

    private func finish(_ result: Result<String, LabError>) {
        guard let completion else { return }
        self.completion = nil
        completion(result)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

// MARK: - Dictation

/// 听写 in the writing assistant's composer: records the microphone,
/// transcribes each piece with the author's DashScope key and inserts the
/// text, proper nouns corrected, for the author to review before sending.
/// Pieces are cut every `pieceSeconds` so each stays within the synchronous
/// API's limits; they transcribe in order. A failed piece is kept for 重试
/// and the pieces after it wait behind it, so the text keeps spoken order.
/// Nothing is recorded to disk. Main thread only.
final class VoiceDictation {
    enum Phase: Equatable { case idle, recording, transcribing }

    let secrets: AgentSecretStore
    let network: AgentNetwork
    let microphone: VoiceMicrophone
    /// A new source per recording.
    let makeSource: () -> VoiceAudioSource
    /// The open project's recognition context, read when recording starts.
    var context: ((@escaping (VoiceRecognitionContext) -> Void) -> Void)?
    /// Asked once before the system permission prompt; nil proceeds.
    var explainPermission: ((@escaping (Bool) -> Void) -> Void)?
    var onInsert: ((String) -> Void)?
    var onChange: (() -> Void)?
    /// Seconds of audio per request.
    var pieceSeconds: Double = 180
    var now: () -> Date = Date.init

    private(set) var phase = Phase.idle
    /// The last failure, in Chinese; cleared by the next start or retry.
    private(set) var error: String?
    /// No transcription key: 设置… is offered.
    private(set) var needsSetup = false
    private(set) var recordingStartedAt: Date?
    /// Proper nouns restored since recording started.
    private(set) var corrections: [VoiceCorrection] = []
    /// Text inserted since recording started, in order.
    private(set) var inserted: [String] = []
    private(set) var requests = 0

    private struct Piece { let samples: [Int16] }
    private var source: VoiceAudioSource?
    private var buffer: [Int16] = []
    private var pending: [Piece] = []
    /// A failed piece and every piece cut after it, in spoken order, kept
    /// for 重试.
    private var failed: [Piece] = []
    private var call: VoiceTranscriptionCall?
    private var recognition = VoiceRecognitionContext.empty
    /// The recognition context has arrived; pieces wait for it.
    private var recognitionReady = true
    private var apiKey = ""

    /// Pieces kept for 重试: the failed one and those waiting behind it.
    var failedPieces: Int { failed.count }

    /// Why quitting now would lose audio (recording, transcribing, or
    /// pieces kept for 重试), in Chinese; nil when nothing would be lost.
    var quitWarning: String? {
        switch phase {
        case .recording: return "听写正在录音。现在退出，这段录音不会转写，也不会保留。"
        case .transcribing: return "听写还有录音正在转写。现在退出，尚未转写的录音会被丢弃。"
        case .idle:
            return failed.isEmpty ? nil : "听写还有 \(failed.count) 段录音没有转写成功，正等待重试。现在退出，这些录音会被丢弃。"
        }
    }

    init(secrets: AgentSecretStore, network: AgentNetwork = AgentNetwork(), microphone: VoiceMicrophone = SystemMicrophone(),
         makeSource: @escaping () -> VoiceAudioSource = { AudioEngineSource() }) {
        self.secrets = secrets; self.network = network; self.microphone = microphone; self.makeSource = makeSource
    }

    private func changed() { onChange?() }

    /// 录音中 0:12 · 点击停止, 转写中…, the failure, or the corrections note.
    var statusText: String? {
        switch phase {
        case .recording:
            let seconds = max(0, Int(now().timeIntervalSince(recordingStartedAt ?? now())))
            return String(format: "录音中 %d:%02d · 点击停止", seconds / 60, seconds % 60)
        case .transcribing: return "转写中…"
        case .idle:
            if let error { return failed.isEmpty ? error : "\(error)（\(failed.count) 段待重试）" }
            if !failed.isEmpty { return "\(failed.count) 段录音待重试" }
            return corrections.isEmpty ? nil : "已按设定名校正 \(corrections.count) 处专名"
        }
    }

    /// Starts recording: the key first, then the microphone permission
    /// (explained and asked only when macOS has not been asked yet).
    func start() {
        guard phase == .idle else { return }
        error = nil; needsSetup = false; corrections = []; inserted = []
        do {
            guard let key = try SpeechCredentials.key(secrets) else {
                needsSetup = true
                error = "还没有设置语音转写的 Key。请在 设置 › 模型服务 › 语音转写 中填写阿里云百炼（DashScope）的 API Key。"
                changed(); return
            }
            apiKey = key
        } catch {
            self.error = error.localizedDescription; changed(); return
        }
        switch microphone.status {
        case .authorized: begin()
        case .denied:
            error = "无法使用麦克风。请在 系统设置 › 隐私与安全性 › 麦克风 中允许 Drifting Native Lab，然后再试。"
            changed()
        case .notDetermined:
            let ask = { [weak self] in
                self?.microphone.request { granted in
                    guard let self else { return }
                    if granted { self.begin() } else {
                        self.error = "没有获得麦克风权限，无法听写。可以在 系统设置 › 隐私与安全性 › 麦克风 中允许后再试。"
                        self.changed()
                    }
                }
            }
            if let explainPermission { explainPermission { proceed in if proceed { ask() } } } else { ask() }
        }
    }

    private func begin() {
        guard phase == .idle else { return }
        let source = makeSource()
        do {
            try source.start(onSamples: { [weak self] samples in self?.received(samples) },
                             onFailure: { [weak self] message in self?.recordingFailed(message) })
        } catch {
            self.error = (error as? LabError)?.errorDescription ?? "麦克风没有开始录音。"
            changed(); return
        }
        self.source = source
        phase = .recording
        recordingStartedAt = now()
        buffer = []
        recognition = .empty
        if let context {
            recognitionReady = false
            context { [weak self] context in
                guard let self else { return }
                self.recognition = context; self.recognitionReady = true
                self.pump()
            }
        }
        changed()
    }

    private func received(_ samples: [Int16]) {
        guard phase == .recording else { return }
        buffer += samples
        let limit = max(1, Int(pieceSeconds * Double(VoiceAudio.sampleRate)))
        while buffer.count >= limit {
            pending.append(Piece(samples: Array(buffer.prefix(limit))))
            buffer.removeFirst(limit)
            pump()
        }
    }

    private func recordingFailed(_ message: String) {
        guard phase == .recording else { return }
        error = "录音中断：\(message)"
        stop()
    }

    /// Stops recording; the last piece is transcribed and inserted.
    func stop() {
        guard phase == .recording else { return }
        source?.stop(); source = nil
        recordingStartedAt = nil
        // A tenth of a second or less is noise, not speech.
        if buffer.count > VoiceAudio.sampleRate / 10 { pending.append(Piece(samples: buffer)) }
        buffer = []
        phase = pending.isEmpty && call == nil ? .idle : .transcribing
        pump()
        changed()
    }

    /// 重试: failed pieces are transcribed again, in order.
    func retry() {
        guard phase == .idle, !failed.isEmpty else { return }
        do {
            guard let key = try SpeechCredentials.key(secrets) else {
                needsSetup = true
                error = "还没有设置语音转写的 Key。请在 设置 › 模型服务 › 语音转写 中填写。"
                changed(); return
            }
            apiKey = key
        } catch { self.error = error.localizedDescription; changed(); return }
        error = nil
        pending = failed + pending
        failed = []
        phase = .transcribing
        pump()
        changed()
    }

    /// Drops the recording and everything not yet transcribed, including
    /// pieces kept for 重试.
    func cancel() {
        source?.stop(); source = nil
        call?.cancel(); call = nil
        buffer = []; pending = []; failed = []; error = nil; recognitionReady = true
        phase = .idle; recordingStartedAt = nil
        changed()
    }

    private func pump() {
        guard recognitionReady else { return }
        // Behind a failed piece, later pieces wait for 重试 in spoken order.
        if !failed.isEmpty, !pending.isEmpty { failed += pending; pending = [] }
        guard call == nil, let piece = pending.first else {
            if call == nil, pending.isEmpty, phase == .transcribing { phase = .idle; changed() }
            return
        }
        pending.removeFirst()
        let request: URLRequest
        do {
            request = try DashScopeASR.request(wav: VoiceAudio.wav(piece.samples), context: recognition.text, apiKey: apiKey)
        } catch {
            failed.append(piece); self.error = (error as? LabError)?.errorDescription ?? "这段录音无法转写。"
            pump(); changed(); return
        }
        requests += 1
        call = VoiceTranscriptionCall(request, configuration: network.configuration) { [weak self] result in
            guard let self else { return }
            self.call = nil
            switch result {
            case .success(let text):
                let corrected = VoicePinyin.correct(text, glossary: self.recognition.glossary)
                self.corrections += corrected.corrections
                if !corrected.text.isEmpty { self.inserted.append(corrected.text); self.onInsert?(corrected.text) }
            case .failure(let failure):
                self.failed.append(piece)
                self.error = failure.errorDescription
            }
            self.pump()
            self.changed()
        }
    }
}
