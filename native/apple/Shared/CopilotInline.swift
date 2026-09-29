import Foundation

// MARK: - Target

/// What Copilot 修改 works on in a chapter or drift body: the selection, or
/// the paragraph holding the caret, with the paragraphs around it as local
/// context. Ranges are UTF-16, in the text as the editor shows it.
///
/// The target never starts or ends with white space or a line break: a
/// selection that takes in a paragraph break, or a paragraph's own indent
/// (such as U+3000), leaves them outside the rewrite so they stay as they
/// are. The target is placed by `prefix + original + suffix`, the text
/// around it widened until it occurs once, as Rust locates changes; 接受
/// requires exactly that string again.
struct CopilotInlineTarget: Equatable {
    static let contextLimit = 600

    let kind: CopilotBodyKind
    let id: String
    let range: NSRange
    let original: String
    let isSelection: Bool
    /// The paragraphs just above and below, for context only.
    let before: String
    let after: String
    /// The text just around the target that makes it unique in the body.
    let prefix: String
    let suffix: String

    var anchor: String { prefix + original + suffix }

    /// 所选文字（12 字） or 光标所在段落（40 字）.
    var label: String { "\(isSelection ? "所选文字" : "光标所在段落")（\(original.count) 字）" }

    /// Nil when there is nothing to work on (an empty paragraph, a caret
    /// outside text, a selection of white space).
    static func make(kind: CopilotBodyKind, id: String, text: String, blocks: [NativeBlock], selection: NSRange) -> CopilotInlineTarget? {
        let string = text as NSString
        guard selection.location != NSNotFound, selection.location <= string.length else { return nil }
        var range: NSRange
        let isSelection = selection.length > 0
        if isSelection {
            range = NSRange(location: selection.location, length: min(selection.length, string.length - selection.location))
        } else {
            guard let index = NativeLayout.index(selection.location, blocks: blocks), blocks[index].editable else { return nil }
            range = blocks[index].range.nsRange
        }
        guard range.length > 0, NSMaxRange(range) <= string.length else { return nil }
        // Leading and trailing white space and line breaks stay outside.
        let visible = CharacterSet.whitespacesAndNewlines.inverted
        let first = string.rangeOfCharacter(from: visible, options: [], range: range)
        let last = string.rangeOfCharacter(from: visible, options: .backwards, range: range)
        guard first.location != NSNotFound, last.location != NSNotFound else { return nil }
        range = NSRange(location: first.location, length: NSMaxRange(last) - first.location)
        let original = string.substring(with: range)
        guard let context = unique(range, in: text) else { return nil }
        let texts = blocks.map { block -> (range: NSRange, text: String) in
            let blockRange = block.range.nsRange
            return (blockRange, NSMaxRange(blockRange) <= string.length ? string.substring(with: blockRange) : "")
        }
        func gather(_ candidates: [String]) -> String {
            var kept: [String] = [], used = 0
            for text in candidates where !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                if used + text.count > contextLimit {
                    if kept.isEmpty { kept.append(String(text.prefix(contextLimit))) }
                    break
                }
                kept.append(text); used += text.count
            }
            return kept.joined(separator: "\n")
        }
        let before = gather(texts.filter { NSMaxRange($0.range) <= range.location && $0.range.location < range.location }.reversed().map(\.text))
        let beforeText = before.components(separatedBy: "\n").reversed().joined(separator: "\n")
        let after = gather(texts.filter { $0.range.location >= NSMaxRange(range) }.map(\.text))
        return CopilotInlineTarget(kind: kind, id: id, range: range, original: original, isSelection: isSelection,
                                   before: beforeText, after: after, prefix: context.prefix, suffix: context.suffix)
    }

    /// A rewrite with the same number of lines gets back each line's
    /// leading indent (such as U+3000) where the original had one and the
    /// rewrite dropped it.
    func restoringIndents(_ edited: String) -> String {
        let old = original.components(separatedBy: "\n"), new = edited.components(separatedBy: "\n")
        guard old.count > 1, old.count == new.count else { return edited }
        func isIndent(_ character: Character) -> Bool { character.isWhitespace && !character.isNewline }
        return zip(old, new).map { old, new in
            let indent = String(old.prefix(while: isIndent))
            guard !indent.isEmpty, !new.hasPrefix(indent) else { return new }
            return indent + String(new.drop(while: isIndent))
        }.joined(separator: "\n")
    }

    /// The text before and after `range` that, widened a character at a
    /// time on each side, makes it occur once in `text`, counting
    /// overlapping matches (the last “哈哈” of “哈哈哈” is not unique), with
    /// that one match where the range is. Nil when no context within 400
    /// characters on each side does.
    static func unique(_ range: NSRange, in text: String) -> (prefix: String, suffix: String)? {
        let string = text as NSString
        guard NSMaxRange(range) <= string.length else { return nil }
        var widened = range
        for _ in 0..<400 {
            if matches(of: string.substring(with: widened), in: text) == [widened.location] {
                let prefix = string.substring(with: NSRange(location: widened.location, length: range.location - widened.location))
                let suffix = string.substring(with: NSRange(location: NSMaxRange(range), length: NSMaxRange(widened) - NSMaxRange(range)))
                return (prefix, suffix)
            }
            let canLeft = widened.location > 0, canRight = NSMaxRange(widened) < string.length
            guard canLeft || canRight else { return nil }
            if canLeft {
                let previous = string.rangeOfComposedCharacterSequence(at: widened.location - 1)
                widened = NSRange(location: previous.location, length: NSMaxRange(widened) - previous.location)
            }
            if canRight {
                let next = string.rangeOfComposedCharacterSequence(at: NSMaxRange(widened))
                widened.length = NSMaxRange(next) - widened.location
            }
        }
        return nil
    }

    /// Every UTF-16 offset where `needle` starts in `text`, overlapping
    /// matches included.
    static func matches(of needle: String, in text: String) -> [Int] {
        let haystack = Array(text.utf16), pattern = Array(needle.utf16)
        guard !pattern.isEmpty, pattern.count <= haystack.count else { return [] }
        return (0...(haystack.count - pattern.count)).filter { haystack[$0..<($0 + pattern.count)].elementsEqual(pattern) }
    }
}

// MARK: - Diff

/// A character diff for the inline preview: kept, removed and added runs.
enum CopilotTextDiff {
    enum Kind: Equatable { case kept, removed, added }
    struct Segment: Equatable { let kind: Kind; let text: String }

    static func segments(_ old: String, _ new: String) -> [Segment] {
        let a = Array(old), b = Array(new)
        var prefix = 0
        while prefix < a.count, prefix < b.count, a[prefix] == b[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < a.count - prefix, suffix < b.count - prefix, a[a.count - 1 - suffix] == b[b.count - 1 - suffix] { suffix += 1 }
        let x = Array(a[prefix..<(a.count - suffix)]), y = Array(b[prefix..<(b.count - suffix)])
        var middle: [Segment] = []
        if x.count * y.count <= 250_000, !x.isEmpty, !y.isEmpty {
            // Longest common subsequence over the changed middle.
            var table = Array(repeating: Array(repeating: 0, count: y.count + 1), count: x.count + 1)
            for i in stride(from: x.count - 1, through: 0, by: -1) {
                for j in stride(from: y.count - 1, through: 0, by: -1) {
                    table[i][j] = x[i] == y[j] ? table[i + 1][j + 1] + 1 : max(table[i + 1][j], table[i][j + 1])
                }
            }
            var i = 0, j = 0
            while i < x.count || j < y.count {
                if i < x.count, j < y.count, x[i] == y[j] { middle.append(Segment(kind: .kept, text: String(x[i]))); i += 1; j += 1 }
                else if j < y.count, i == x.count || table[i][j + 1] >= table[i + 1][j] { middle.append(Segment(kind: .added, text: String(y[j]))); j += 1 }
                else { middle.append(Segment(kind: .removed, text: String(x[i]))); i += 1 }
            }
        } else {
            if !x.isEmpty { middle.append(Segment(kind: .removed, text: String(x))) }
            if !y.isEmpty { middle.append(Segment(kind: .added, text: String(y))) }
        }
        var result: [Segment] = []
        func push(_ segment: Segment) {
            guard !segment.text.isEmpty else { return }
            if let last = result.last, last.kind == segment.kind {
                result[result.count - 1] = Segment(kind: last.kind, text: last.text + segment.text)
            } else { result.append(segment) }
        }
        push(Segment(kind: .kept, text: String(a[..<prefix])))
        middle.forEach(push)
        push(Segment(kind: .kept, text: String(a[(a.count - suffix)...])))
        return result
    }
}

// MARK: - Prompts

enum CopilotInlinePrompt {
    static let editOutputTokens = 4_096
    static let askOutputTokens = 2_048
    static let summaryOutputTokens = 1_024
    static let summarySourceLimit = 16_000

    /// Instructions that plainly ask for new story content; 局部修改 only
    /// polishes what is there, so these are refused without a request.
    static func asksForNewContent(_ instruction: String) -> Bool {
        let patterns = ["续写|接着写|往下写|写下去|后续剧情|接下来(发生|写)|加一?段|新增一?段|添一?段|扩写|展开剧情|编一?个|虚构一?个|脑补|帮我想",
                        "(?i)\\bcontinue\\b|what happens next|write (the )?(next|more)|add a (new )?(scene|paragraph|chapter)|expand the (plot|story)|make up|invent (a|an)"]
        return patterns.contains { instruction.range(of: $0, options: .regularExpression) != nil }
    }

    static let newContentRefusal = "局部修改只润色已有的文字，不生成新的情节或段落。需要续写时，请在写作助手里提出。"

    static let editSystem = """
        你是小说写作软件里的局部修改助手。作者选中自己正文中的一小段（或光标所在的段落），给出一句简短的要求，你只改写这段文字。
        必须遵守：
        1. 只做局部修改：修正语病、收紧措辞、换更准确的词、加强意象、调整节奏、删去重复。只改变说法，不改变发生了什么。
        2. 不要编造故事内容：不增加新的情节、人物、地点、设定或对白含义。
        3. 保留原意、专有名词、叙述视角和时态；除非要求本身与长度有关，长度大致不变。
        4. 使用与原文相同的语言，不要换语言。
        5. 原文有几段，改写后就有几段，段与段之间用换行符分隔。
        6. 如果要求是续写、补写新段落或新情节，不要照做：refused 为 true，editedText 原样返回原文，并在 reason 中简短说明。
        只输出一个 JSON 对象，不要输出其他文字：{"editedText":"","refused":false,"reason":""}
        editedText 只包含改写后的文字，不加引号、不加 Markdown、不加说明；reason 用一句话说明改了什么（或为什么没有改）。
        """

    static func edit(_ target: CopilotInlineTarget, instruction: String) -> String {
        var parts = ["【修改要求】\(instruction)"]
        if !target.before.isEmpty { parts.append("【上文（只作参考，不要修改或复述）】\n\(target.before)") }
        parts.append("【要修改的文字】\n\(target.original)")
        if !target.after.isEmpty { parts.append("【下文（只作参考，不要修改或复述）】\n\(target.after)") }
        return parts.joined(separator: "\n\n")
    }

    static let askSystem = """
        你是小说写作软件里坦率、敏锐的写作伙伴。作者就自己正文中的一段文字提问（征求意见、第二种看法或推敲写法），请直接、具体地回答，以给出的文字为依据。
        你看到的只是局部：所选的一段和前后几段，没有全书的设定、大纲和人物弧线。所以：
        - 着重于文字本身：语病、清晰度、节奏、用词、意象、语气、重复、段内节奏。
        - 不要评判情节、伏笔、人物是否前后一致或事件是否合理；作者问到时，说明你只看到局部，只在这段文字能支持的范围内回答。
        - 这是讨论，不是改稿：除非作者明确要求，不要直接给出整段改写；需要举例时只给简短片段。
        - 具体指出词句，好的和不足的都说，不要客套、不要铺垫，不要编造文字以外的事实。
        - 只用纯文本回答，不要使用 Markdown；需要列举时用“1. ”“2. ”。
        """

    static func ask(_ target: CopilotInlineTarget, turns: [(question: String, answer: String)], question: String) -> String {
        var parts: [String] = []
        if !target.before.isEmpty { parts.append("【上文（只作参考）】\n\(target.before)") }
        parts.append("【讨论的文字】\n\(target.original)")
        if !target.after.isEmpty { parts.append("【下文（只作参考）】\n\(target.after)") }
        if !turns.isEmpty {
            parts.append("【此前的问答】\n" + turns.map { "作者：\($0.question)\n你：\($0.answer)" }.joined(separator: "\n\n"))
        }
        parts.append("【作者的问题】\(question)")
        return parts.joined(separator: "\n\n")
    }

    static let summarySystem = """
        你为小说作者写一段简短的章节摘要，依据给出的完整正文（过长时是开头和结尾）。用 2–4 句话概括这一章的走向和关键情节点，使用正文中的专有名词。
        要求：如实、好读；不评论，不写元话语，不编造正文中没有的内容；纯文本，不要标题和列表。
        只输出一个 JSON 对象，不要输出其他文字：{"summary":""}
        """

    static func summary(title: String, body: String, language: String) -> String {
        let text: String
        if body.count > summarySourceLimit {
            let half = summarySourceLimit / 2
            text = String(body.prefix(half)) + "\n……（中间省略）……\n" + String(body.suffix(half))
        } else { text = body }
        return "【输出语言】\(language)\n【标题】\(title)\n【正文】\n\(text)"
    }

    struct Edit: Equatable { let text: String; let refused: Bool; let reason: String }

    static func edit(reply: String) -> Edit? {
        guard let object = CopilotPrompt.object(from: reply), let text = object["editedText"] as? String else { return nil }
        let cleaned = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return Edit(text: cleaned, refused: object["refused"] as? Bool == true,
                    reason: (object["reason"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func summary(reply: String) -> String? {
        let text = (CopilotPrompt.object(from: reply)?["summary"] as? String)
            ?? (reply.contains("{") ? nil : reply)
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : String(trimmed.prefix(1_000))
    }
}

// MARK: - Requests

/// One Copilot 修改 request through Copilot's provider, model and key, with
/// the writing assistant's retry policy; usage is recorded with Copilot's.
final class CopilotInlineCall {
    private var call: AgentHTTPCall?
    private var retry: DispatchWorkItem?
    private(set) var cancelled = false

    func cancel() {
        cancelled = true
        retry?.cancel(); retry = nil
        call?.cancel(); call = nil
    }

    fileprivate func attach(_ call: AgentHTTPCall) { self.call = call }
    fileprivate func wait(_ work: DispatchWorkItem) { retry = work }
}

extension CopilotController {
    /// Copilot 修改 works while Copilot is on, as its privacy note says.
    var allowsInline: Bool { settings().normalized().enabled }

    /// A complete reply to one system prompt and prompt. Refused while
    /// Copilot is off or its provider has no key.
    func inlineRequest(system: String, prompt: String, maxTokens: Int, completion: @escaping (Result<String, LabError>) -> Void) -> CopilotInlineCall? {
        let settings = self.settings().normalized()
        guard settings.enabled else {
            completion(.failure(.message("Copilot 已关闭。请先在 设置 › Copilot（实验）中开启。"))); return nil
        }
        let choice = settings.choice
        let key: String
        do {
            guard let stored = try credentials.key(for: choice.provider), !stored.isEmpty else {
                completion(.failure(.message("还没有设置 \(choice.provider.label) 的 API Key。请在 设置 › Copilot（实验）中管理 API Key。"))); return nil
            }
            key = stored
        } catch { completion(.failure(.message(error.localizedDescription))); return nil }
        let handle = CopilotInlineCall()
        func attempt(_ number: Int) {
            guard !handle.cancelled else { return }
            let request: URLRequest
            do {
                request = try AgentDriver.completionRequest(choice: choice, apiKey: key, system: system, prompt: prompt, maxTokens: maxTokens)
            } catch { completion(.failure(.message(AgentErrors.invalid(choice.provider).message))); return }
            let call = network.complete(request, provider: choice.provider, timeout: requestTimeout) { [weak self] result in
                guard let self, !handle.cancelled else { return }
                switch result {
                case .success(let reply):
                    self.recordInlineUsage(choice, reply.usage)
                    completion(.success(reply.text))
                case .failure(let failure):
                    if failure.responded { self.recordInlineUsage(choice, nil) }
                    if failure.kind != .cancelled, AgentRetryPolicy.retryable(failure), number < self.retryPolicy.attempts {
                        let delay = self.retryPolicy.delay(attempt: number + 1,
                                                           retryAfter: failure.kind == .rateLimit || failure.kind == .server ? failure.retryAfter : nil)
                        let work = DispatchWorkItem { attempt(number + 1) }
                        handle.wait(work)
                        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
                        return
                    }
                    completion(.failure(.message(failure.kind == .cancelled ? "已停止。" : failure.message)))
                }
            }
            handle.attach(call)
        }
        attempt(0)
        return handle
    }
}

// MARK: - Session

/// One Copilot 修改 popover on a chapter or drift body:
/// - 局部修改: the instruction and target go to the model; the preview
///   shows removed and added text; 接受 applies it through the body's live
///   owner (`workspaceAgent applyChanges`, one undo step with Copilot's
///   Agent identity), refused when the target or the text that placed it
///   changed meanwhile; 重写 asks again; 放弃 writes nothing.
/// - 问: a question about the target, answered in the popover; writes nothing.
/// - 生成章节摘要: a summary proposed from the body; 接受 writes it with
///   `setNodeSummary` (one original), refused with the preview kept when
///   the stored summary is no longer the one shown; 放弃 writes nothing.
/// Main thread only.
final class CopilotInlineSession {
    enum Mode: String, CaseIterable { case edit, ask, summary }

    enum Phase: Equatable {
        case ready
        /// 正在修改…, 正在思考…, 正在生成摘要…, 正在应用…
        case working(String)
        case edited(original: String, edited: String, reason: String)
        case refused(String)
        case answered(String)
        case summary(before: String, after: String)
        case applied(String)
        case failed(String)
    }

    let projectID: String
    let target: CopilotInlineTarget
    let title: String
    private let workspace: LabWorkspaceCore
    private weak var copilot: CopilotController?
    private(set) var mode = Mode.edit
    private(set) var phase = Phase.ready
    private(set) var turns: [(question: String, answer: String)] = []
    private(set) var instruction: String?
    /// Why the last 接受 was refused while its preview stays.
    private(set) var acceptRefusal: String?
    private var call: CopilotInlineCall?
    var onChange: (() -> Void)?
    var onWorkspaceEffect: ((AgentWorkspaceEffect) -> Void)?

    init(workspace: LabWorkspaceCore, copilot: CopilotController, projectID: String, target: CopilotInlineTarget, title: String) {
        self.workspace = workspace; self.copilot = copilot; self.projectID = projectID; self.target = target; self.title = title
    }

    var isWorking: Bool { if case .working = phase { return true }; return false }

    private func set(_ next: Phase) { phase = next; onChange?() }

    func select(_ next: Mode) {
        guard next != mode, !isWorking else { return }
        mode = next
        acceptRefusal = nil
        set(.ready)
    }

    /// Stops a request in flight; nothing is written.
    func cancel() {
        call?.cancel(); call = nil
        if isWorking { set(.ready) }
    }

    private func languageInstruction() -> String {
        guard let copilot else { return "简体中文" }
        return copilot.settings().normalized().languageInstruction(manuscriptLocale: copilot.manuscriptLocale())
    }

    // MARK: 局部修改

    func edit(_ instruction: String) {
        let instruction = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instruction.isEmpty, !isWorking, let copilot else { return }
        mode = .edit
        self.instruction = instruction
        acceptRefusal = nil
        if CopilotInlinePrompt.asksForNewContent(instruction) { set(.refused(CopilotInlinePrompt.newContentRefusal)); return }
        set(.working("正在修改…"))
        call = copilot.inlineRequest(system: CopilotInlinePrompt.editSystem, prompt: CopilotInlinePrompt.edit(target, instruction: instruction),
                                     maxTokens: CopilotInlinePrompt.editOutputTokens) { [weak self] result in
            guard let self else { return }
            self.call = nil
            switch result {
            case .failure(let error): self.set(.failed(error.errorDescription ?? "修改失败。"))
            case .success(let reply):
                guard let edit = CopilotInlinePrompt.edit(reply: reply) else {
                    self.set(.failed("模型返回的修改无法解析，可以点“重写”再试一次。")); return
                }
                if edit.refused { self.set(.refused(edit.reason.isEmpty ? CopilotInlinePrompt.newContentRefusal : edit.reason)); return }
                guard !edit.text.isEmpty else { self.set(.failed("模型返回了空白的修改，可以点“重写”再试一次。")); return }
                // The reply is trimmed as the target is; inner indents come back.
                let edited = self.target.restoringIndents(edit.text)
                guard edited != self.target.original else { self.set(.refused("模型没有修改这段文字。可以换个要求再试。")); return }
                self.set(.edited(original: self.target.original, edited: edited, reason: edit.reason))
            }
        }
        if call == nil, isWorking { set(.failed("Copilot 不可用。")) }
    }

    /// 重写: the same instruction again.
    func rewrite() {
        guard let instruction, !isWorking else { return }
        edit(instruction)
    }

    /// 放弃: the preview or proposed summary goes; nothing is written.
    func discard() {
        call?.cancel(); call = nil
        acceptRefusal = nil
        set(.ready)
    }

    /// 接受 of an edit or a summary.
    func accept() {
        switch phase {
        case .edited(_, let edited, _): applyEdit(edited)
        case .summary(_, let after): applySummary(after)
        default: break
        }
    }

    private func applyEdit(_ edited: String) {
        let previous = phase
        acceptRefusal = nil
        set(.working("正在应用…"))
        let target = self.target, projectID = self.projectID
        workspace.agentReadProse(projectID: projectID, kind: target.kind.rawValue, id: target.id) { [weak self] prose in
            guard let self else { return }
            let refuse = { (message: String, keep: Bool) in
                self.acceptRefusal = message
                self.set(keep ? previous : .failed(message))
            }
            guard case .success(let body) = prose else {
                refuse(AgentApplyRefusal(prose.error!).message, false); return
            }
            // Exactly the text around the target as it was when it was made,
            // once even counting overlapping matches; never another copy of
            // the original elsewhere.
            guard CopilotInlineTarget.matches(of: target.anchor, in: body.text).count == 1 else {
                refuse("原文在生成修改后已经改变，这处修改没有应用。请重新选择文字后再试。", false); return
            }
            // The context only makes the target unique: Rust keeps it exactly
            // and narrows the revision inside it.
            let change = AgentProseChange(currentText: target.anchor, revisedText: target.prefix + edited + target.suffix,
                                          contextBefore: target.prefix.utf16.count, contextAfter: target.suffix.utf16.count)
            let identity = ["sessionId": "copilot-inline", "turnId": "copilot-inline-" + UUID().uuidString.lowercased(),
                            "callId": "copilot-edit-" + UUID().uuidString.lowercased()]
            self.workspace.agentApplyChanges(projectID: projectID, kind: target.kind.rawValue, id: target.id, changes: [change.payload],
                                             agent: identity) { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(let applied):
                    self.onWorkspaceEffect?(.prose(projectID: projectID, kind: target.kind.rawValue, id: target.id, live: applied.handle != nil))
                    self.set(.applied("已应用修改，可以用 ⌘Z 撤销。"))
                case .failure(let error):
                    let refusal = AgentApplyRefusal(error)
                    refuse(refusal.message, refusal.transient)
                }
            }
        }
    }

    // MARK: 问

    func ask(_ question: String) {
        let question = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, !isWorking, let copilot else { return }
        mode = .ask
        set(.working("正在思考…"))
        call = copilot.inlineRequest(system: CopilotInlinePrompt.askSystem, prompt: CopilotInlinePrompt.ask(target, turns: turns, question: question),
                                     maxTokens: CopilotInlinePrompt.askOutputTokens) { [weak self] result in
            guard let self else { return }
            self.call = nil
            switch result {
            case .failure(let error): self.set(.failed(error.errorDescription ?? "回答失败。"))
            case .success(let reply):
                let answer = reply.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !answer.isEmpty else { self.set(.failed("模型没有回答，可以再问一次。")); return }
                self.turns.append((question, answer))
                self.set(.answered(answer))
            }
        }
        if call == nil, isWorking { set(.failed("Copilot 不可用。")) }
    }

    // MARK: 生成章节摘要

    func proposeSummary() {
        guard !isWorking, let copilot else { return }
        mode = .summary
        acceptRefusal = nil
        set(.working("正在生成摘要…"))
        let target = self.target, projectID = self.projectID, title = self.title
        workspace.agentReadProse(projectID: projectID, kind: target.kind.rawValue, id: target.id) { [weak self] prose in
            guard let self else { return }
            guard case .success(let body) = prose else { self.set(.failed(AgentApplyRefusal(prose.error!).message)); return }
            guard !body.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                self.set(.failed("正文是空白的，没有可以概括的内容。")); return
            }
            self.workspace.nodeMetadata(projectID: projectID, nodeID: target.id) { [weak self] metadata in
                guard let self else { return }
                let before = (try? metadata.get())?.summary ?? ""
                self.call = copilot.inlineRequest(system: CopilotInlinePrompt.summarySystem,
                                                  prompt: CopilotInlinePrompt.summary(title: title, body: body.text, language: self.languageInstruction()),
                                                  maxTokens: CopilotInlinePrompt.summaryOutputTokens) { [weak self] result in
                    guard let self else { return }
                    self.call = nil
                    switch result {
                    case .failure(let error): self.set(.failed(error.errorDescription ?? "生成摘要失败。"))
                    case .success(let reply):
                        guard let summary = CopilotInlinePrompt.summary(reply: reply) else {
                            self.set(.failed("模型返回的摘要无法解析，可以再生成一次。")); return
                        }
                        self.set(.summary(before: before, after: summary))
                    }
                }
                if self.call == nil, self.isWorking { self.set(.failed("Copilot 不可用。")) }
            }
        }
    }

    private func applySummary(_ summary: String) {
        guard case .summary(let shown, _) = phase else { return }
        let previous = phase
        acceptRefusal = nil
        set(.working("正在应用…"))
        let refuse = { [weak self] (message: String) in
            self?.acceptRefusal = message
            self?.set(previous)
        }
        // The summary the author saw beside the proposal must still be the stored one.
        workspace.nodeMetadata(projectID: projectID, nodeID: target.id) { [weak self] current in
            guard let self else { return }
            guard case .success(let metadata) = current else { refuse(AgentApplyRefusal(current.error!).message); return }
            guard metadata.summary == shown else {
                refuse("摘要在生成后已经改变，这次没有写入。请重新生成后再接受。"); return
            }
            self.workspace.setNodeSummary(projectID: self.projectID, nodeID: self.target.id, summary: summary) { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(let metadata):
                    self.onWorkspaceEffect?(.nodeMetadata(projectID: self.projectID, metadata: metadata))
                    self.set(.applied("摘要已写入。"))
                case .failure(let error): refuse(AgentApplyRefusal(error).message)
                }
            }
        }
    }
}
