import AppKit
import AVFoundation

/// The writing assistant's extras (ask_user, 补充, 在当前工具后停止, the
/// context indicator and Max · 1M 上下文), Copilot 修改 and 听写, through
/// the real panel, tab host, editors, Rust workspace and SQLite. Providers
/// and the ASR endpoint are stubbed with synthetic replies, keys are
/// synthetic and in memory, and audio is a synthetic PCM buffer; nothing
/// reaches a real service or the microphone.
extension BindingAcceptance {
    static let assistantExtrasCases = [
        "AppKit ask_user pauses the turn on a question card with its choices and an answer field (the composer's button becomes 回答 and an empty answer is refused); 回答 from a choice or the composer returns the answer as the tool result and the turn continues with one more request; 停止 leaves the card 未回答, records the question and the calls after it as not run and ends the turn; a question still waiting when the panel is reopened reads 未回答, and the registry lists 64 tools",
        "AppKit 补充 while a turn runs is queued below the streamed reply, sent to the model at its next call as the author's message with a runtime note (never in the earlier request), shown as 你（补充） in the same turn without renaming the conversation, makes one more call when the reply had already ended, and returns to the composer when the turn is stopped first",
        "AppKit 在当前工具后停止 lets the running tool finish and records its result, marks the calls after it as not run and ends the turn without another request; pressed while the reply streams, the reply is kept and none of its tool calls run",
        "AppKit the context indicator shows the latest request's reported input plus output against the window compaction counts with and its 70% threshold (an estimate marked 约 before any report or after a compaction), and Max · 1M 上下文 is offered only for models declaring 1M, switches the window between 200,000 and the declared one and is stored with the conversation",
        "AppKit Copilot 修改 (编辑 menu ⌃⌘I and the prose context menu, only while Copilot is on) opens on the selection or the caret's paragraph: 局部修改 sends the instruction, the text and its neighbours with the key only in the auth header, previews removed and added text, 重写 asks again, 接受 applies it through the chapter's live owner as one Agent-provenance edit that one ⌘Z undoes, a target changed meanwhile is refused writing nothing, 放弃 writes nothing and a request to continue the story is refused without a request; 问 answers in the popover with follow-ups and writes nothing",
        "AppKit Copilot 修改 leaves a selection's leading or trailing paragraph break and a paragraph's U+3000 indent outside the rewrite, so 接受 keeps the break and the indent, puts back the inner indent a rewrite with as many lines dropped, and reads a reply that differs only by white space as 没有修改; 接受 needs the text that made the target unique when it was made, so a target moved by an edit elsewhere lands on its own copy and one changed meanwhile is refused writing nothing although the original text occurs once elsewhere; the last of overlapping repeats (哈哈 in 哈哈哈) is widened until it is the only overlapping match and 接受 lands there, sending the widening as context that stays exactly",
        "AppKit Copilot 修改's 生成章节摘要 proposes a summary from the chapter body beside the current one; 放弃 writes nothing and 接受 writes it with setNodeSummary as one field.set original that the chapter page shows, 接受 after the stored summary changed is refused writing nothing and keeps the preview, and Copilot's usage records every request",
        "AppKit 听写 in the composer needs the DashScope key from 设置 › 模型服务 › 语音转写 (kept in the Keychain store under its own 语音转写 Key label, shown masked), explains and asks for the microphone only on first use, records a synthetic 16 kHz PCM buffer, sends it as a WAV data URI with the project's names as recognition context and the key only in the authorization header, restores proper nouns from element names and aliases, inserts the text into the composer, and refuses a denied microphone in Chinese",
        "AppKit 听写 keeps a failed piece and every piece after it for 重试, which inserts them in spoken order; an audio device change ends the recording and transcribes what was captured, saying why in Chinese; while pieces wait for 重试 a new recording does not start behind them: the mic asks to 重试 or 放弃并录音 (取消 records nothing) and 放弃 gives them up; the panel's quit check, which quitting or closing the window runs, asks while dictation records, transcribes or keeps pieces for 重试 and not otherwise, 取消 keeping them and 退出 leaving them until the close has succeeded, when they are dropped; and name correction needs matching tones for two-character names and keeps ü apart from u, so 黎明, 路人 and 知识 stay while 林蓝 becomes 林岚 and longer names still match without tones",
    ]

    static func assistantExtrasAcceptance() throws -> [String] {
        try extrasAskUser()
        try extrasSteer()
        try extrasStopAfterTool()
        try extrasContext()
        try extrasCopilotInline()
        try extrasCopilotTargets()
        try extrasCopilotSummary()
        try extrasDictation()
        return assistantExtrasCases
    }

    // MARK: Helpers

    /// Types into the composer and presses its button without waiting.
    private static func extrasPress(_ harness: AgentHarness, _ text: String) {
        harness.panel.composer.string = text
        harness.panel.composer.didChangeText()
        harness.panel.sendButton.performClick(nil)
    }

    private static func extrasCall(_ id: String, _ name: String, _ arguments: [String: Any]) -> (id: String, name: String, arguments: String) {
        (id, name, AgentJSONText.encode(arguments))
    }

    private static func extrasTool(_ harness: AgentHarness, _ callID: String) -> AgentMessage? {
        harness.conversation.messages.first { $0.role == .tool && $0.callID == callID }
    }

    private static func extrasMessages(_ index: Int) -> [[String: Any]] {
        let requests = AgentStubProtocol.requests
        guard requests.indices.contains(index) else { return [] }
        return requests[index].body["messages"] as? [[String: Any]] ?? []
    }

    // MARK: ask_user

    private static func extrasAskUser() throws {
        let harness = try AgentHarness(titles: ["启程", "归岸"])
        defer { harness.remove() }
        try require(AgentToolRegistry.all.count == 64 && AgentToolRegistry.definition("ask_user")?.access == .read
                    && AgentToolRegistry.all.filter { $0.access == .read }.count == 23, "The registry does not list ask_user")

        // Answered from the composer, after an empty answer is refused.
        let question = extrasCall("call_ask_1", "ask_user", ["question": "林岚应该在哪一章出场？", "choices": ["第一章", "第二章"]])
        AgentStubProtocol.reset([AgentSSE.deepseekTools([question]), AgentSSE.deepseekText(["好的，按第二章安排。"])])
        extrasPress(harness, "帮我安排林岚出场")
        try wait { harness.controller.waitingQuestion != nil }
        guard let cardID = harness.controller.waitingQuestion,
              let card = harness.panel.element("agent-question-\(cardID)") as? AgentQuestionCard else { throw LabError.message("No question card") }
        try require(card.plainText.contains("林岚应该在哪一章出场？") && card.choiceButtons.map(\.title) == ["第一章", "第二章"]
                    && card.stateLabel.stringValue == "等待你的回答" && harness.panel.sendButton.title == "回答"
                    && AgentStubProtocol.requests.count == 1 && harness.controller.isRunning, "The question card differs: \(card.plainText)")
        card.answerField.stringValue = "   "
        card.pressAnswer()
        try require(card.messageLabel.stringValue == "回答不能为空。" && harness.controller.waitingQuestion == cardID, "An empty answer was taken")
        extrasPress(harness, "第二章，雨夜那一场")
        try wait { !harness.controller.isRunning }
        let answered = harness.conversation.messages.first { $0.id == cardID }?.question
        try require(answered?.state == .answered && answered?.answer == "第二章，雨夜那一场"
                    && extrasTool(harness, "call_ask_1")?.text == AgentJSONText.encode(["answer": "第二章，雨夜那一场"])
                    && extrasTool(harness, "call_ask_1")?.ok == true, "The answer was not the tool result")
        let second = extrasMessages(1)
        try require(AgentStubProtocol.requests.count == 2
                    && second.contains { $0["role"] as? String == "tool" && ($0["content"] as? String ?? "").contains("第二章，雨夜那一场") },
                    "The answer did not reach the next request")
        try require(harness.panel.transcriptTexts.contains { $0.contains("你的回答：第二章，雨夜那一场") } && harness.lastReply?.text == "好的，按第二章安排。",
                    "The answered card or reply is not shown: \(harness.panel.transcriptTexts)")

        // Answered from a choice button.
        AgentStubProtocol.reset([AgentSSE.deepseekTools([extrasCall("call_ask_2", "ask_user", ["question": "用第几人称？", "choices": ["第一人称", "第三人称"]])]),
                                 AgentSSE.deepseekText(["明白。"])])
        extrasPress(harness, "开始写吧")
        try wait { harness.controller.waitingQuestion != nil }
        guard let choiceCard = harness.panel.element("agent-question-\(harness.controller.waitingQuestion!)") as? AgentQuestionCard else {
            throw LabError.message("No second question card")
        }
        choiceCard.choiceButtons[1].performClick(nil)
        try wait { !harness.controller.isRunning }
        try require(extrasTool(harness, "call_ask_2")?.text == AgentJSONText.encode(["answer": "第三人称"]), "The choice was not the answer")

        // 停止 while it waits: 未回答, the calls after it not run.
        AgentStubProtocol.reset([AgentSSE.deepseekTools([extrasCall("call_ask_3", "ask_user", ["question": "要删掉第二章吗？"]),
                                                         ("call_after_3", "list_chapters", "{}")])])
        extrasPress(harness, "整理一下")
        try wait { harness.controller.waitingQuestion != nil }
        let stoppedID = harness.controller.waitingQuestion!
        harness.panel.stopButton.performClick(nil)
        try wait { !harness.controller.isRunning }
        let stopped = harness.conversation.messages.first { $0.id == stoppedID }?.question
        try require(stopped?.state == .unanswered && extrasTool(harness, "call_ask_3")?.ok == false
                    && extrasTool(harness, "call_ask_3")?.text == "作者没有回答这个问题，本轮已停止。"
                    && extrasTool(harness, "call_after_3")?.text == "作者停止了本轮，这个工具没有执行。"
                    && harness.notices.last == "已停止。" && AgentStubProtocol.requests.count == 1, "停止 did not leave the question unanswered")
        try require((harness.panel.element("agent-question-\(stoppedID)") as? AgentQuestionCard)?.stateLabel.stringValue == "未回答",
                    "The stopped card does not read 未回答")

        // Waiting when the panel closes: a cold reopen reads 未回答.
        AgentStubProtocol.reset([AgentSSE.deepseekTools([extrasCall("call_ask_4", "ask_user", ["question": "结尾要开放吗？"])])])
        extrasPress(harness, "想想结尾")
        try wait { harness.controller.waitingQuestion != nil }
        let closedID = harness.controller.waitingQuestion!
        let running = harness.controller!
        harness.controller.store.flush()
        harness.reopenPanel()
        let reopened = harness.conversation.messages.first { $0.id == closedID }?.question
        try require(reopened?.state == .unanswered && harness.controller.waitingQuestion == nil
                    && (harness.panel.element("agent-question-\(closedID)") as? AgentQuestionCard)?.answerField.superview == nil,
                    "A question waiting at close did not reopen unanswered")
        running.stop()
        try wait { !running.isRunning }
        try harness.close()
    }

    // MARK: 补充

    private static func extrasSteer() throws {
        let harness = try AgentHarness(titles: ["启程", "归岸", "尾声"])
        defer { harness.remove() }
        // Queued while the first request is out, delivered in the second.
        var first = AgentSSE.deepseekTools([("call_list_s", "list_chapters", "{}")])
        first.delay = 0.5
        AgentStubProtocol.reset([first, AgentSSE.deepseekText(["只看了前两章。"])])
        extrasPress(harness, "列出章节")
        try wait { AgentStubProtocol.requests.count == 1 }
        try require(harness.panel.sendButton.title == "补充", "The composer does not offer 补充 while running")
        extrasPress(harness, "只看前两章")
        try require(harness.controller.queuedSteers == ["只看前两章"] && harness.panel.composer.string.isEmpty
                    && harness.panel.element("agent-steer-queued-0") != nil, "补充 was not queued")
        try wait { !harness.controller.isRunning }
        let firstText = AgentHarness.lastUserText(AgentStubProtocol.requests[0].body)
        let secondText = AgentHarness.lastUserText(AgentStubProtocol.requests[1].body)
        let steer = harness.conversation.messages.first { $0.steer == true }
        let turn = harness.conversation.messages.first { $0.role == .user }?.turnID
        try require(!firstText.contains("只看前两章") && secondText.contains("只看前两章") && secondText.contains("【运行提示】")
                    && steer?.text == "只看前两章" && steer?.turnID == turn && harness.conversation.title == "列出章节"
                    && harness.panel.element("agent-steer-queued-0") == nil, "补充 was not delivered at the next call")
        guard let row = harness.panel.element("agent-message-\(steer!.id)") as? AgentMessageRow else { throw LabError.message("No 补充 row") }
        try require(row.plainText == "只看前两章" && harness.panel.transcriptTexts.contains("只看前两章"), "The 补充 row is not shown")
        // The next request order: the tool result, then the author's 补充.
        let roles = extrasMessages(1).compactMap { $0["role"] as? String }
        try require(roles.suffix(3) == ["assistant", "tool", "user"], "补充 is not after the tool result: \(roles)")

        // Queued while the final reply streams: one more call reads it.
        var text = AgentSSE.deepseekText(["第一稿。"])
        text.delay = 0.5
        AgentStubProtocol.reset([text, AgentSSE.deepseekText(["改成第二稿。"])])
        extrasPress(harness, "写一句")
        try wait { AgentStubProtocol.requests.count == 1 }
        extrasPress(harness, "再短一点")
        try wait { !harness.controller.isRunning }
        try require(AgentStubProtocol.requests.count == 2 && AgentHarness.lastUserText(AgentStubProtocol.requests[1].body).contains("再短一点")
                    && harness.lastReply?.text == "改成第二稿。", "A 补充 after the last reply was not delivered")

        // 停止 first: the 补充 goes back to the composer.
        var held = AgentSSE.deepseekText(["慢慢写。"])
        held.delay = 0.6
        AgentStubProtocol.reset([held])
        extrasPress(harness, "写下去")
        try wait { AgentStubProtocol.requests.count == 1 }
        extrasPress(harness, "换个角度")
        harness.panel.stopButton.performClick(nil)
        try wait { !harness.controller.isRunning }
        harness.panel.updateStreaming()
        try require(harness.panel.composer.string == "换个角度" && harness.controller.queuedSteers.isEmpty
                    && !harness.conversation.messages.contains { $0.text == "换个角度" }, "An undelivered 补充 was lost: \(harness.panel.composer.string)")
        harness.panel.composer.string = ""
        try harness.close()
    }

    // MARK: 在当前工具后停止

    private static func extrasStopAfterTool() throws {
        let harness = try AgentHarness(titles: ["启程", "归岸"])
        defer { harness.remove() }
        // Pressed while list_chapters runs: it finishes, read_chapter does not.
        AgentStubProtocol.reset([AgentSSE.deepseekTools([("call_list_t", "list_chapters", "{}"),
                                                         ("call_read_t", "read_chapter", AgentJSONText.encode(["title": "启程"]))])])
        let bound = harness.controller.onChange
        var pressed = false
        harness.controller.onChange = { [weak harness] change in
            bound?(change)
            guard let harness, !pressed, change == .streaming, harness.controller.activity == "正在列出章节…" else { return }
            pressed = true
            harness.panel.stopAfterToolButton.performClick(nil)
        }
        extrasPress(harness, "读一读")
        try wait { !harness.controller.isRunning }
        harness.controller.onChange = bound
        try require(pressed && extrasTool(harness, "call_list_t")?.ok == true
                    && extrasTool(harness, "call_read_t")?.text == "作者要求在当前工具完成后停止，这个工具没有执行。"
                    && harness.notices.last == "已在当前工具完成后停止。" && AgentStubProtocol.requests.count == 1,
                    "在当前工具后停止 differs: \(harness.conversation.messages.map(\.text))")

        // Pressed while the reply streams: the reply stays, its calls do not run.
        var streaming = AgentSSE.deepseekTools([("call_list_u", "list_chapters", "{}")])
        streaming.delay = 0.5
        AgentStubProtocol.reset([streaming])
        extrasPress(harness, "再读一次")
        try wait { AgentStubProtocol.requests.count == 1 }
        try require(!harness.panel.stopAfterToolButton.isHidden && harness.panel.stopAfterToolButton.isEnabled, "The button is not offered")
        harness.panel.stopAfterToolButton.performClick(nil)
        try require(harness.panel.statusLabel.stringValue == "将在当前工具完成后停止…" && !harness.panel.stopAfterToolButton.isEnabled,
                    "The status does not say it will stop")
        try wait { !harness.controller.isRunning }
        try require(extrasTool(harness, "call_list_u")?.ok == false && harness.notices.last == "已在当前工具完成后停止。"
                    && AgentStubProtocol.requests.count == 1, "A streamed reply's tool ran after 在当前工具后停止")
        try harness.close()
    }

    // MARK: Context indicator

    private static func extrasContext() throws {
        let harness = try AgentHarness(titles: ["启程"])
        defer { harness.remove() }
        harness.controller.newConversation()
        harness.panel.reload()
        guard let before = harness.controller.contextUsage() else { throw LabError.message("No context usage") }
        try require(!before.reported && (before.estimate ?? 0) > 1_000 && before.window == 200_000
                    && harness.panel.contextLabel.stringValue.hasPrefix("上下文 约 ") && harness.panel.contextLabel.stringValue.hasSuffix(" / 200,000（\(before.percentText)）"),
                    "The estimate before any report differs: \(harness.panel.contextLabel.stringValue)")

        // DeepSeek's reported 120 input + 18 output.
        AgentStubProtocol.reset([AgentSSE.deepseekText(["好。"])])
        try harness.send("你好")
        guard let usage = harness.controller.contextUsage() else { throw LabError.message("No context usage after a reply") }
        try require(usage.reported && usage.used == 138 && usage.input == 120 && usage.output == 18 && usage.window == 200_000
                    && usage.threshold == 140_000 && harness.panel.contextLabel.stringValue == "上下文 138 / 200,000（0.1%）",
                    "The reported usage differs: \(harness.panel.contextLabel.stringValue)")
        let detail = harness.panel.contextLabel.toolTip ?? ""
        try require(detail.contains("最近一次请求：输入 120") && detail.contains("输出 18") && detail.contains("140,000（70%）")
                    && detail.contains("下一次请求估算"), "The detail differs: \(detail)")

        // Max · 1M 上下文: only for 1M models; switches the window.
        harness.panel.providerPopup.selectItem(at: AgentProviderID.allCases.firstIndex(of: .anthropic)!)
        harness.panel.providerPopup.sendAction(harness.panel.providerPopup.action, to: harness.panel.providerPopup.target)
        try require(harness.conversation.choice.model == "claude-sonnet-5" && harness.panel.maxContextCheckbox.isEnabled
                    && harness.controller.contextUsage()?.window == 200_000, "Sonnet 5 does not offer Max · 1M 上下文")
        harness.panel.maxContextCheckbox.state = .on
        harness.panel.maxContextCheckbox.sendAction(harness.panel.maxContextCheckbox.action, to: harness.panel.maxContextCheckbox.target)
        try require(harness.conversation.choice.maxContext && harness.controller.contextUsage()?.window == 1_000_000
                    && harness.panel.contextLabel.stringValue.hasSuffix(" / 1,000,000（0.0%）") && harness.conversation.choice.label.hasSuffix("1M 上下文"),
                    "Max · 1M 上下文 did not switch the window: \(harness.panel.contextLabel.stringValue)")
        harness.controller.store.flush()
        let saved = AgentConversationStore(root: harness.workspace.agentDirectory, projectID: harness.project.id).load()
        try require(saved.first { $0.id == harness.conversation.id }?.choice.maxContext == true, "Max · 1M 上下文 was not stored")
        harness.panel.modelPopup.selectItem(at: 1)
        harness.panel.modelPopup.sendAction(harness.panel.modelPopup.action, to: harness.panel.modelPopup.target)
        try require(harness.conversation.choice.model == "claude-haiku-4-5-20251001" && !harness.conversation.choice.maxContext
                    && !harness.panel.maxContextCheckbox.isEnabled && harness.controller.contextUsage()?.window == 200_000,
                    "Haiku kept Max · 1M 上下文")
        var sol = AgentModelChoice(provider: .openai, model: "gpt-5.6-sol", thinking: .off, effort: .high)
        try require(sol.contextWindow == 200_000, "GPT-5.6 Sol's standard window differs")
        sol.maxContext = true
        try require(sol.contextWindow == 1_050_000 && AgentModelChoice.standard.with(model: "deepseek-v4-pro").contextWindow == 200_000,
                    "The declared window differs")

        // Anthropic's reported input includes cache reads and writes.
        AgentStubProtocol.reset([AgentSSE.anthropicText(["短。"])])
        try harness.send("再来")
        let anthropic = harness.controller.contextUsage()
        try require(anthropic?.used == 111 && anthropic?.window == 200_000, "Anthropic usage differs: \(String(describing: anthropic))")

        // A compaction after the latest report: the estimate stands in.
        var conversation = harness.conversation
        var marker = AgentMessage(role: .notice, turnID: "", text: "已压缩较早的对话：2 条消息整理成了摘要。")
        marker.compaction = AgentCompaction(through: conversation.messages[1].id, summary: "摘要", method: .summary, messages: 2)
        conversation.messages.append(marker)
        let compacted = AgentContextUsage.of(conversation, window: 200_000, estimate: 4_321)
        try require(!compacted.reported && compacted.used == 4_321 && compacted.compactions == 1 && compacted.text.contains("约 4,321")
                    && compacted.detail.contains("本对话已压缩 1 次"), "Usage after a compaction differs: \(compacted)")
        try harness.close()
    }

    // MARK: Copilot 修改

    private static func extrasComplete(_ object: [String: Any]) -> AgentStubProtocol.Reply {
        AgentSSE.deepseekComplete(AgentJSONText.encode(object), usage: ["prompt_tokens": 300, "completion_tokens": 40])
    }

    private static func extrasInlinePrompt(_ index: Int) -> (system: String, user: String) {
        let messages = extrasMessages(index)
        return (messages.first { $0["role"] as? String == "system" }?["content"] as? String ?? "",
                messages.first { $0["role"] as? String == "user" }?["content"] as? String ?? "")
    }

    private static func extrasInline(_ harness: CopilotHarness, _ view: NativeDocumentView, select text: String, length: Int? = nil) throws -> MacCopilotInlineController {
        let found = (view.textView.string as NSString).range(of: text)
        try require(found.location != NSNotFound, "“\(text)” is not in the prose")
        view.textView.setSelectedRange(NSRange(location: found.location, length: length ?? found.length))
        harness.host.copilotInline = nil
        view.textView.copilotInlineEdit(nil)
        guard let inline = harness.host.copilotInline else { throw LabError.message("Copilot 修改 did not open") }
        _ = inline.view
        return inline
    }

    private static func extrasCopilotInline() throws {
        let harness = try CopilotHarness(titles: ["雨夜"])
        defer { harness.remove() }
        let view = try harness.open(0)
        try harness.type(view, "林岚推开门。\n雨下得很大，她很冷。\n钟声响了三下。")
        try harness.settle(view)
        // Off by default: nothing offered.
        let menu = MacMainMenu.build([:])
        guard let item = MacMainMenu.item(.copilotInline, in: menu) else { throw LabError.message("编辑 has no Copilot 修改") }
        item.target = view.textView
        try require(item.title == "Copilot 修改…" && item.keyEquivalent == "i" && item.keyEquivalentModifierMask == [.command, .control]
                    && !view.textView.validateMenuItem(item) && !view.canRequestCopilotInline, "Copilot 修改 is offered while Copilot is off")
        harness.enable { $0.trigger = .manual; $0.extractElements = false; $0.suggestPatches = false }
        try require(view.textView.validateMenuItem(item) && (try harness.contextMenu(view, at: 3)).items.contains { $0.accessibilityIdentifier() == "context-copilot-inline" },
                    "Copilot 修改 is not offered while Copilot is on")
        let usageBefore = harness.controller.usage.count

        // 局部修改 on a selection: the request, the preview, 重写, then 接受.
        var inline = try extrasInline(harness, view, select: "她很冷")
        try require(inline.targetLabel.stringValue == "修改所选文字（3 字）" && inline.session.target.before == "林岚推开门。"
                    && inline.session.target.after == "钟声响了三下。", "The target differs: \(inline.targetLabel.stringValue)")
        AgentStubProtocol.reset([extrasComplete(["editedText": "寒意浸透了她", "refused": false, "reason": "写得更具体"]),
                                 extrasComplete(["editedText": "她冷得发抖", "refused": false, "reason": "更直接"])])
        inline.inputField.stringValue = "写得更具体"
        inline.go()
        try wait { if case .edited = inline.session.phase { return true }; return false }
        let (system, user) = extrasInlinePrompt(0)
        let request = AgentStubProtocol.requests[0]
        try require(system == CopilotInlinePrompt.editSystem && user.contains("【修改要求】写得更具体") && user.contains("【要修改的文字】\n她很冷")
                    && user.contains("【上文（只作参考，不要修改或复述）】\n林岚推开门。") && user.contains("钟声响了三下。")
                    && request.headers["authorization"] == "Bearer synthetic-deepseek-key-0001" && request.body["stream"] as? Bool == false
                    && !AgentJSONText.encode(request.body).contains("synthetic-deepseek-key"), "The edit request differs: \(user)")
        let preview = inline.previewLabel.attributedStringValue
        // 她 is kept; 很冷 is removed and 寒意浸透了 added.
        let removed = (preview.string as NSString).range(of: "很冷")
        let added = (preview.string as NSString).range(of: "寒意浸透了")
        try require(preview.string == "寒意浸透了她很冷" && !inline.previewLabel.isHidden && removed.location != NSNotFound && added.location != NSNotFound
                    && preview.attribute(.strikethroughStyle, at: added.location + 5, effectiveRange: nil) == nil
                    && preview.attribute(.strikethroughStyle, at: removed.location, effectiveRange: nil) as? Int == NSUnderlineStyle.single.rawValue
                    && preview.attribute(.backgroundColor, at: added.location, effectiveRange: nil) != nil
                    && !inline.acceptButton.isHidden && !inline.rewriteButton.isHidden && inline.reasonLabel.stringValue == "说明：写得更具体",
                    "The preview differs: \(preview.string)")
        inline.rewrite()
        try wait { if case .edited(_, let edited, _) = inline.session.phase { return edited == "她冷得发抖" }; return false }
        try require(AgentStubProtocol.requests.count == 2 && extrasInlinePrompt(1).user.contains("【修改要求】写得更具体"), "重写 did not ask again")
        var mark = try harness.journal.mark()
        let original = view.textView.string
        inline.accept()
        try wait { if case .applied = inline.session.phase { return true }; return false }
        try harness.settle(view)
        try require(view.textView.string == original.replacingOccurrences(of: "她很冷", with: "她冷得发抖"), "接受 did not reach the editor: \(view.textView.string)")
        try harness.journal.expect([["yjs.update prose-document"]], since: mark, "Copilot 修改 接受")
        guard case .integer(let provenance)? = try WorkspaceRemoteProseFixture.query(in: harness.directory, sql: """
            SELECT COUNT(*) AS n FROM yjs_document_revision_provenance WHERE document_id = ? AND source_kind = 'agent' AND agent_session_id = 'copilot-inline'
            """, parameters: [.text("node-content:\(harness.chapters[0].id)")]).first?["n"] else { throw LabError.message("No provenance row") }
        try require(provenance == 1, "The edit has no Agent provenance: \(provenance)")
        view.undoProse(); try harness.settle(view)
        try require(view.textView.string == original, "One ⌘Z did not undo the Copilot edit: \(view.textView.string)")
        view.redoProse(); try harness.settle(view)

        // 放弃 writes nothing.
        inline = try extrasInline(harness, view, select: "林岚推开门")
        AgentStubProtocol.reset([extrasComplete(["editedText": "林岚轻轻推开门", "refused": false, "reason": ""])])
        inline.inputField.stringValue = "更轻"
        inline.go()
        try wait { if case .edited = inline.session.phase { return true }; return false }
        mark = try harness.journal.mark()
        inline.discard()
        try require(inline.session.phase == .ready && inline.previewLabel.isHidden && (try harness.journal.originals(since: mark)).isEmpty
                    && view.textView.string.contains("林岚推开门。"), "放弃 wrote or kept the preview")

        // A target changed meanwhile is refused and nothing is written.
        inline = try extrasInline(harness, view, select: "钟声响了三下")
        AgentStubProtocol.reset([extrasComplete(["editedText": "钟声沉沉地响了三下", "refused": false, "reason": ""])])
        inline.inputField.stringValue = "加点分量"
        inline.go()
        try wait { if case .edited = inline.session.phase { return true }; return false }
        let at = (view.textView.string as NSString).range(of: "响了").location
        view.textView.setSelectedRange(NSRange(location: at, length: 0))
        view.textView.insertText("又", replacementRange: NSRange(location: at, length: 0))
        try harness.settle(view)
        let changed = view.textView.string
        mark = try harness.journal.mark()
        inline.accept()
        try wait { if case .failed = inline.session.phase { return true }; return false }
        try require(inline.statusLabel.stringValue.contains("原文在生成修改后已经改变") && view.textView.string == changed
                    && (try harness.journal.originals(since: mark)).isEmpty, "A changed target was not refused: \(inline.statusLabel.stringValue)")

        // Continuing the story is refused without a request.
        inline = try extrasInline(harness, view, select: "林岚推开门")
        AgentStubProtocol.reset([])
        inline.inputField.stringValue = "续写接下来发生的事"
        inline.go()
        try require(AgentStubProtocol.requests.isEmpty && inline.statusLabel.stringValue.contains("不生成新的情节"), "A continuation was sent")

        // 问 at the caret's paragraph: answered in the popover, nothing written.
        let caret = (view.textView.string as NSString).range(of: "雨下得很大").location + 2
        view.textView.setSelectedRange(NSRange(location: caret, length: 0))
        harness.host.copilotInline = nil
        view.requestCopilotInline()
        guard let ask = harness.host.copilotInline else { throw LabError.message("Copilot 修改 did not open at the caret") }
        _ = ask.view
        try require(ask.session.target.original == "雨下得很大，她冷得发抖。" && ask.session.target.isSelection == false, "The caret target differs")
        ask.modeControl.selectedSegment = 1
        ask.modeControl.sendAction(ask.modeControl.action, to: ask.modeControl.target)
        try require(ask.session.mode == .ask && ask.goButton.title == "问" && ask.targetLabel.stringValue.hasPrefix("讨论光标所在段落"), "问 was not selected")
        AgentStubProtocol.reset([AgentSSE.deepseekComplete("节奏干脆，“发抖”落得实。", usage: ["prompt_tokens": 200, "completion_tokens": 20]),
                                 AgentSSE.deepseekComplete("可以删去“很”。", usage: ["prompt_tokens": 220, "completion_tokens": 12])])
        mark = try harness.journal.mark()
        ask.inputField.stringValue = "这句节奏如何？"
        ask.go()
        try wait { if case .answered = ask.session.phase { return true }; return false }
        ask.inputField.stringValue = "还能更短吗？"
        ask.go()
        try wait { ask.session.turns.count == 2 }
        let followUp = extrasInlinePrompt(1)
        try require(extrasInlinePrompt(0).system == CopilotInlinePrompt.askSystem && extrasInlinePrompt(0).user.contains("【讨论的文字】\n雨下得很大，她冷得发抖。")
                    && followUp.user.contains("【此前的问答】\n作者：这句节奏如何？\n你：节奏干脆") && followUp.user.hasSuffix("【作者的问题】还能更短吗？")
                    && ask.answerLabel.stringValue.contains("Copilot：可以删去“很”。") && (try harness.journal.originals(since: mark)).isEmpty,
                    "问 differs: \(ask.answerLabel.stringValue)")
        try require(harness.controller.usage.count - usageBefore == 6, "Copilot 修改's usage was not recorded: \(harness.controller.usage.count - usageBefore)")
        ask.close()
        try require(harness.host.copilotInline == nil, "Closing did not release the popover")
        try harness.close()
    }

    /// Copilot 修改 on the last occurrence of `text`, selected.
    private static func extrasInlineLast(_ harness: CopilotHarness, _ view: NativeDocumentView, select text: String) throws -> MacCopilotInlineController {
        let found = (view.textView.string as NSString).range(of: text, options: .backwards)
        try require(found.location != NSNotFound, "“\(text)” is not in the prose")
        view.textView.setSelectedRange(found)
        harness.host.copilotInline = nil
        view.textView.copilotInlineEdit(nil)
        guard let inline = harness.host.copilotInline else { throw LabError.message("Copilot 修改 did not open") }
        _ = inline.view
        return inline
    }

    private static func extrasEdit(_ inline: MacCopilotInlineController, _ reply: [String: Any], instruction: String = "润色") throws {
        AgentStubProtocol.reset([extrasComplete(reply)])
        inline.inputField.stringValue = instruction
        inline.go()
        try wait { !inline.session.isWorking }
    }

    private static func extrasCopilotTargets() throws {
        let harness = try CopilotHarness(titles: ["晨钟"])
        defer { harness.remove() }
        let view = try harness.open(0)
        let indent = "\u{3000}\u{3000}"
        let prose = "林岚推开门。\n\(indent)雨下得很大。\n他说：好。\n钟声响了。\n她说：好。\n他说：走。\n她说：走。"
        try harness.type(view, prose)
        try harness.settle(view)
        try require(view.textView.string == prose, "The synthetic prose differs: \(view.textView.string)")
        harness.enable { $0.trigger = .manual; $0.extractElements = false; $0.suggestPatches = false }

        // A selection ending with the paragraph break and the next indent: both stay.
        var inline = try extrasInline(harness, view, select: "林岚推开门。\n\(indent)")
        try require(inline.session.target.original == "林岚推开门。" && inline.targetLabel.stringValue == "修改所选文字（6 字）",
                    "The trailing break was taken into the target: \(inline.session.target.original.debugDescription)")
        try extrasEdit(inline, ["editedText": "林岚轻轻推开门。\n", "refused": false, "reason": ""])
        try require(extrasInlinePrompt(0).user.contains("【要修改的文字】\n林岚推开门。\n\n【下文"), "The request carried the break")
        inline.accept()
        try wait { if case .applied = inline.session.phase { return true }; return false }
        try harness.settle(view)
        var expected = prose.replacingOccurrences(of: "林岚推开门。", with: "林岚轻轻推开门。")
        try require(view.textView.string == expected, "接受 joined the paragraphs: \(view.textView.string.debugDescription)")

        // A selection starting with the break and the indent: both stay.
        inline = try extrasInline(harness, view, select: "\n\(indent)雨下得很大。")
        try require(inline.session.target.original == "雨下得很大。", "The leading break or indent was taken into the target")
        try extrasEdit(inline, ["editedText": "\(indent)雨下得正大。", "refused": false, "reason": ""])
        guard case .edited(_, let edited, _) = inline.session.phase, edited == "雨下得正大。" else {
            throw LabError.message("The edit differs: \(inline.session.phase)")
        }
        inline.accept()
        try wait { if case .applied = inline.session.phase { return true }; return false }
        try harness.settle(view)
        expected = expected.replacingOccurrences(of: "雨下得很大。", with: "雨下得正大。")
        try require(view.textView.string == expected, "接受 lost the break or the indent: \(view.textView.string.debugDescription)")

        // The caret's indented paragraph: the indent is not rewritten.
        let caret = (view.textView.string as NSString).range(of: "雨下得正大").location + 2
        view.textView.setSelectedRange(NSRange(location: caret, length: 0))
        harness.host.copilotInline = nil
        view.requestCopilotInline()
        guard let paragraph = harness.host.copilotInline else { throw LabError.message("Copilot 修改 did not open at the caret") }
        try require(paragraph.session.target.original == "雨下得正大。" && !paragraph.session.target.isSelection
                    && paragraph.session.target.range.location == caret - 2, "The caret target took the indent")
        paragraph.close()

        // A reply that only adds white space is 没有修改; nothing is written.
        inline = try extrasInline(harness, view, select: "钟声响了。\n")
        var mark = try harness.journal.mark()
        try extrasEdit(inline, ["editedText": "\n钟声响了。\n", "refused": false, "reason": ""])
        try require(inline.session.phase == .refused("模型没有修改这段文字。可以换个要求再试。") && inline.statusLabel.stringValue.contains("没有修改")
                    && (try harness.journal.originals(since: mark)).isEmpty, "An unchanged reply was offered: \(inline.statusLabel.stringValue)")

        // Several paragraphs: an inner indent the reply dropped comes back.
        inline = try extrasInline(harness, view, select: "林岚轻轻推开门。\n\(indent)雨下得正大。")
        try extrasEdit(inline, ["editedText": "林岚推门。\n雨下得很急。", "refused": false, "reason": ""])
        guard case .edited(_, let restored, _) = inline.session.phase, restored == "林岚推门。\n\(indent)雨下得很急。" else {
            throw LabError.message("The inner indent was not restored: \(inline.session.phase)")
        }
        inline.discard()

        // Moved by an edit elsewhere: the unique context still places it on its own copy.
        inline = try extrasInlineLast(harness, view, select: "走。")
        let moved = inline.session.target
        try require(moved.original == "走。" && moved.prefix == "她说：" && moved.suffix.isEmpty
                    && AgentWorkspaceTools.occurrences(of: "走。", in: view.textView.string).count == 2,
                    "The target was not widened until unique: \(moved.anchor)")
        try extrasEdit(inline, ["editedText": "走吧。", "refused": false, "reason": ""])
        view.textView.setSelectedRange(NSRange(location: 0, length: 0))
        view.textView.insertText("夜里，", replacementRange: NSRange(location: 0, length: 0))
        try harness.settle(view)
        inline.accept()
        try wait { if case .applied = inline.session.phase { return true }; return false }
        try harness.settle(view)
        expected = "夜里，" + expected.replacingOccurrences(of: "她说：走。", with: "她说：走吧。")
        try require(view.textView.string == expected, "A moved target was not applied to its own copy: \(view.textView.string.debugDescription)")

        // The target changed meanwhile: refused although “好。” now occurs once elsewhere.
        inline = try extrasInlineLast(harness, view, select: "好。")
        let target = inline.session.target
        try require(!target.prefix.isEmpty && AgentWorkspaceTools.occurrences(of: target.anchor, in: view.textView.string).count == 1
                    && AgentWorkspaceTools.occurrences(of: "好。", in: view.textView.string).count == 2, "The target was not widened: \(target.anchor)")
        try extrasEdit(inline, ["editedText": "好吧。", "refused": false, "reason": ""])
        let at = (view.textView.string as NSString).range(of: "好。", options: .backwards).location + 1
        view.textView.setSelectedRange(NSRange(location: at, length: 0))
        view.textView.insertText("的", replacementRange: NSRange(location: at, length: 0))
        try harness.settle(view)
        let changed = view.textView.string
        try require(AgentWorkspaceTools.occurrences(of: "好。", in: changed).count == 1, "The other copy is not unique")
        mark = try harness.journal.mark()
        inline.accept()
        try wait { if case .failed = inline.session.phase { return true }; return false }
        try require(inline.statusLabel.stringValue.contains("原文在生成修改后已经改变") && view.textView.string == changed
                    && changed.contains("他说：好。") && (try harness.journal.originals(since: mark)).isEmpty,
                    "A changed target landed elsewhere: \(view.textView.string.debugDescription)")
        inline.close()

        // Overlapping repeats: the last “哈哈” of “哈哈哈” is not unique by
        // itself; widened until it is the only overlapping match, 接受 lands
        // there and the widening stays exactly.
        try harness.type(view, "\n哈哈哈")
        try harness.settle(view)
        inline = try extrasInlineLast(harness, view, select: "哈哈")
        let laugh = inline.session.target
        let laughAt = (view.textView.string as NSString).range(of: "哈哈", options: .backwards).location
        try require(laugh.original == "哈哈" && laugh.range.location == laughAt && laugh.prefix == "哈" && laugh.suffix.isEmpty
                    && CopilotInlineTarget.matches(of: "哈哈", in: view.textView.string) == [laughAt - 1, laughAt]
                    && CopilotInlineTarget.matches(of: laugh.anchor, in: view.textView.string) == [laughAt - 1],
                    "The overlapping target was not widened: \(laugh.anchor)")
        try extrasEdit(inline, ["editedText": "嘿嘿", "refused": false, "reason": ""])
        mark = try harness.journal.mark()
        inline.accept()
        try wait { if case .applied = inline.session.phase { return true }; return false }
        try harness.settle(view)
        try require(view.textView.string.hasSuffix("\n哈嘿嘿") && (try harness.journal.originals(since: mark)).count == 1,
                    "The overlapping target landed elsewhere: \(view.textView.string.debugDescription)")
        inline.close()
        try harness.close()
    }

    private static func extrasCopilotSummary() throws {
        let harness = try CopilotHarness(titles: ["雨夜"])
        defer { harness.remove() }
        let view = try harness.open(0)
        try harness.type(view, "林岚推开门。\n雨下得很大。")
        try harness.settle(view)
        harness.enable { $0.trigger = .manual; $0.extractElements = false; $0.suggestPatches = false }
        let usage = harness.controller.usage.count
        let inline = try extrasInline(harness, view, select: "雨下得很大")
        inline.modeControl.selectedSegment = 2
        inline.modeControl.sendAction(inline.modeControl.action, to: inline.modeControl.target)
        try require(inline.session.mode == .summary && inline.inputField.isHidden && inline.goButton.title == "生成", "生成章节摘要 was not selected")
        AgentStubProtocol.reset([extrasComplete(["summary": "林岚在雨夜推门而出。"]), extrasComplete(["summary": "雨夜里，林岚推门离开。"])])
        var mark = try harness.journal.mark()
        inline.go()
        try wait { if case .summary = inline.session.phase { return true }; return false }
        let prompt = extrasInlinePrompt(0)
        try require(prompt.system == CopilotInlinePrompt.summarySystem && prompt.user.contains("【标题】雨夜") && prompt.user.contains("林岚推开门。\n雨下得很大。")
                    && inline.summaryBeforeLabel.stringValue == "原摘要：（空）" && inline.summaryAfterLabel.stringValue == "新摘要：林岚在雨夜推门而出。",
                    "The summary proposal differs: \(prompt.user)")
        inline.discard()
        try require((try harness.journal.originals(since: mark)).isEmpty, "放弃 wrote a summary")
        inline.go()
        try wait { if case .summary = inline.session.phase { return true }; return false }
        mark = try harness.journal.mark()
        inline.accept()
        try wait { if case .applied = inline.session.phase { return true }; return false }
        try harness.journal.expect([["field.set node"]], since: mark, "生成章节摘要 接受")
        let workspace = harness.workspace, projectID = harness.project.id, chapterID = harness.chapters[0].id
        let metadata: WorkspaceNodeMetadata = try elementResult { workspace.nodeMetadata(projectID: projectID, nodeID: chapterID, completion: $0) }
        try require(metadata.summary == "雨夜里，林岚推门离开。" && harness.effects.contains {
            if case .nodeMetadata(_, let value) = $0 { return value.summary == "雨夜里，林岚推门离开。" }; return false
        }, "The summary was not written: \(metadata.summary)")
        try require(harness.host.activeChapterPage?.metadataEditor.summaryText == "雨夜里，林岚推门离开。", "The chapter page does not show the summary")
        try require(harness.controller.usage.count == usage + 2 && harness.controller.usage.suffix(2).allSatisfy { $0.purpose == .copilot && $0.inputTokens == 300 },
                    "The summary requests' usage was not recorded")

        // The stored summary changed after the proposal: 接受 refuses and keeps the preview.
        AgentStubProtocol.reset([extrasComplete(["summary": "林岚冒雨出门。"])])
        inline.go()
        try wait { if case .summary = inline.session.phase { return true }; return false }
        try require(inline.summaryBeforeLabel.stringValue == "原摘要：雨夜里，林岚推门离开。", "The shown summary differs: \(inline.summaryBeforeLabel.stringValue)")
        let _: WorkspaceNodeMetadata = try elementResult {
            workspace.setNodeSummary(projectID: projectID, nodeID: chapterID, summary: "作者刚改过的摘要。", completion: $0)
        }
        mark = try harness.journal.mark()
        inline.accept()
        try wait { !inline.session.isWorking }
        let stored: WorkspaceNodeMetadata = try elementResult { workspace.nodeMetadata(projectID: projectID, nodeID: chapterID, completion: $0) }
        try require(inline.session.phase == .summary(before: "雨夜里，林岚推门离开。", after: "林岚冒雨出门。")
                    && inline.session.acceptRefusal?.contains("摘要在生成后已经改变") == true
                    && inline.statusLabel.stringValue == inline.session.acceptRefusal && !inline.acceptButton.isHidden
                    && inline.summaryAfterLabel.stringValue == "新摘要：林岚冒雨出门。"
                    && stored.summary == "作者刚改过的摘要。" && (try harness.journal.originals(since: mark)).isEmpty,
                    "A changed summary was overwritten: \(stored.summary) \(inline.statusLabel.stringValue)")
        inline.close()
        try harness.close()
    }

    // MARK: 听写

    final class SyntheticMicrophone: VoiceMicrophone {
        var status: VoiceMicrophoneStatus
        private(set) var requests = 0
        var grants = true
        init(_ status: VoiceMicrophoneStatus) { self.status = status }
        func request(_ done: @escaping (Bool) -> Void) {
            requests += 1
            status = grants ? .authorized : .denied
            DispatchQueue.main.async { done(self.grants) }
        }
    }

    final class SyntheticAudio: VoiceAudioSource {
        private(set) var onSamples: (([Int16]) -> Void)?
        private(set) var onFailure: ((String) -> Void)?
        private(set) var starts = 0, stops = 0
        func start(onSamples: @escaping ([Int16]) -> Void, onFailure: @escaping (String) -> Void) throws {
            starts += 1; self.onSamples = onSamples; self.onFailure = onFailure
        }
        func stop() { stops += 1; onSamples = nil; onFailure = nil }
        /// A 440 Hz tone.
        func push(_ count: Int) {
            let samples = (0..<count).map { Int16(sin(Double($0) * 2 * .pi * 440 / 16_000) * 8_000) }
            onSamples?(samples)
        }
        /// The source stops by itself, as AudioEngineSource does on a device change.
        func fail(_ message: String) { onFailure?(message) }
    }

    private static func extrasASR(_ text: String, status: Int = 200) -> AgentStubProtocol.Reply {
        if status != 200 { return AgentStubProtocol.Reply(status: status, body: Data("{\"message\":\"synthetic failure\"}".utf8)) }
        return AgentStubProtocol.Reply(body: Data(AgentJSONText.encode(["output": ["choices": [["message": ["role": "assistant", "content": [["text": text]]]]]],
                                                                        "usage": ["seconds": 1]]).utf8))
    }

    private static func extrasDictation() throws {
        let harness = try AgentHarness(titles: ["雨夜"])
        defer { harness.remove() }
        let workspace = harness.workspace, projectID = harness.project.id
        let people: WorkspaceElementReply<WorkspaceElementCategory> = try elementResult {
            workspace.createElementCategory(projectID: projectID, name: "人物", completion: $0)
        }
        for (name, aliases) in [("林岚", ["阿岚"]), ("沈舟", [])] {
            let _: WorkspaceElementReply<WorkspaceElement> = try elementResult {
                workspace.createElement(projectID: projectID, categoryID: people.result!.id, name: name, aliases: aliases.isEmpty ? nil : aliases, completion: $0)
            }
        }
        let _: WorkspaceStorylineReply<WorkspaceStoryline> = try elementResult { workspace.createStoryline(projectID: projectID, name: "主线", completion: $0) }
        let _: WorkspaceDriftReply<WorkspaceDrift> = try elementResult { workspace.createDrift(projectID: projectID, title: "灯塔笔记", groupID: nil, completion: $0) }
        let microphone = SyntheticMicrophone(.notDetermined)
        let audio = SyntheticAudio()
        let dictation = VoiceDictation(secrets: harness.credentials, network: harness.network, microphone: microphone, makeSource: { audio })
        dictation.context = { done in
            VoiceRecognitionContext.read(workspace: workspace, projectID: projectID, projectName: harness.project.name, completion: done)
        }
        harness.panel.dictation = dictation
        var alerts: [NSAlert] = []
        var response = NSApplication.ModalResponse.alertFirstButtonReturn
        harness.answer = { alert in alerts.append(alert); return response }
        func explanations() -> Int { alerts.filter { $0.messageText == "允许写作助手使用麦克风？" }.count }
        /// The panel's quit check answered with `reply`: the alert it showed, if any, and its decision.
        func quit(_ reply: NSApplication.ModalResponse) -> (alert: NSAlert?, proceed: Bool?) {
            response = reply
            let before = alerts.count
            var proceed: Bool?
            harness.panel.confirmQuitDuringDictation { proceed = $0 }
            response = .alertFirstButtonReturn
            return (alerts.count > before ? alerts.last : nil, proceed)
        }
        try require(!harness.panel.micButton.isHidden && harness.panel.micButton.title == "听写", "The composer has no 听写 button")

        // No key: 设置 is offered and the microphone is not asked.
        harness.panel.micButton.performClick(nil)
        try require(dictation.needsSetup && microphone.requests == 0 && !harness.panel.dictationSetupButton.isHidden
                    && harness.panel.dictationLabel.stringValue.contains("设置 › 模型服务 › 语音转写"), "A missing key was not reported")

        // 设置 › 模型服务 › 语音转写 stores the key in the Keychain store.
        let pane = MacModelServicesSettingsViewController()
        pane.credentials = harness.credentials
        pane.secrets = harness.credentials
        _ = pane.view
        try require(pane.speechStatus.stringValue == "未设置" && pane.providerLabels[.deepseek]?.stringValue == "已保存 ····0001",
                    "The pane's key states differ")
        pane.speechField.stringValue = "  synthetic-dashscope-key-0004 "
        pane.saveSpeechKey()
        try require(harness.credentials.secrets[SpeechCredentials.account] == "synthetic-dashscope-key-0004"
                    && pane.speechStatus.stringValue == "已保存 ····0004" && pane.speechField.stringValue.isEmpty, "The speech key was not saved")
        // Keychain Access lists it by its own name, not as an MCP secret.
        let mcpAccount = AgentMcpSecrets.account(projectID: projectID, serverID: "server", header: false, name: "TOKEN")
        try require(AgentCredentials.secretLabel(account: SpeechCredentials.account) == "Drifting Native Lab · 语音转写 Key"
                    && AgentCredentials.secretLabel(account: mcpAccount) == "Drifting Native Lab · MCP 密钥",
                    "The Keychain labels differ: \(AgentCredentials.secretLabel(account: SpeechCredentials.account))")

        // First use: explained, then asked once; the tone is sent as WAV.
        AgentStubProtocol.reset([extrasASR("林蓝走进雨里，沈周跟在后面，阿蓝没有回头。")])
        harness.panel.micButton.performClick(nil)
        try wait { dictation.phase == .recording }
        try require(alerts.count == 1 && alerts[0].messageText == "允许写作助手使用麦克风？" && alerts[0].informativeText.contains("DashScope")
                    && microphone.requests == 1 && audio.starts == 1 && harness.panel.micButton.title == "停止"
                    && harness.panel.dictationLabel.stringValue.hasPrefix("录音中 0:0"), "The first recording did not start as expected")
        audio.push(8_000)
        harness.panel.micButton.performClick(nil)
        try wait { dictation.phase == .idle }
        try require(audio.stops == 1 && AgentStubProtocol.requests.count == 1, "The recording was not sent once")
        let request = AgentStubProtocol.requests[0]
        let body = request.body
        let messages = (body["input"] as? [String: Any])?["messages"] as? [[String: Any]] ?? []
        let context = ((messages.first?["content"] as? [[String: Any]])?.first?["text"] as? String) ?? ""
        let audioURI = (((messages.last?["content"] as? [[String: Any]])?.first)?["audio"] as? String) ?? ""
        let wav = Data(base64Encoded: String(audioURI.dropFirst("data:audio/wav;base64,".count))) ?? Data()
        let rate = wav.count >= 28 ? wav.subdata(in: 24..<28).withUnsafeBytes { $0.load(as: UInt32.self).littleEndian } : 0
        let dataBytes = wav.count >= 44 ? wav.subdata(in: 40..<44).withUnsafeBytes { $0.load(as: UInt32.self).littleEndian } : 0
        try require(request.url == DashScopeASR.endpoint && body["model"] as? String == "qwen3-asr-flash"
                    && ((body["parameters"] as? [String: Any])?["asr_options"] as? [String: Any])?["enable_itn"] as? Bool == false
                    && messages.first?["role"] as? String == "system" && messages.last?["role"] as? String == "user"
                    && context.contains("《写作助手合成项目》") && context.contains("[人物] 林岚（又称：阿岚）") && context.contains("沈舟")
                    && context.contains("故事线：主线") && context.contains("章节：雨夜") && context.contains("灵感：灯塔笔记")
                    && audioURI.hasPrefix("data:audio/wav;base64,") && String(data: wav.prefix(4), encoding: .ascii) == "RIFF"
                    && rate == 16_000 && dataBytes == 16_000 && wav.count == 44 + 16_000,
                    "The ASR request differs: \(context)")
        try require(request.headers["authorization"] == "Bearer synthetic-dashscope-key-0004"
                    && !AgentJSONText.encode(body).contains("synthetic-dashscope-key") && !request.url.absoluteString.contains("synthetic"),
                    "The key is not only in the authorization header")
        try require(harness.panel.composer.string == "林岚走进雨里，沈舟跟在后面，阿岚没有回头。" && dictation.corrections.count == 3
                    && harness.panel.dictationLabel.stringValue == "已按设定名校正 3 处专名", "The proper nouns were not corrected: \(harness.panel.composer.string)")
        // Two-character names need matching tones and ü stays apart from u, so
        // everyday words stay; longer names still match without tones.
        let everyday = VoicePinyin.correct("黎明时分，路人看见林蓝。这只是知识。", glossary: ["李明", "旅人", "芝士", "林岚"])
        try require(VoicePinyin.correct("临岚和林岚", glossary: ["林岚"]).text == "林岚和林岚" && VoicePinyin.correct("今天下雨", glossary: ["林岚"]).corrections.isEmpty
                    && everyday.text == "黎明时分，路人看见林岚。这只是知识。" && everyday.corrections.map(\.from) == ["林蓝"]
                    && VoicePinyin.reading("路") == "lu" && VoicePinyin.reading("旅") == "lv" && VoicePinyin.reading("略") == "lve"
                    && VoicePinyin.correct("陈丝缘来了", glossary: ["陈思远"]).text == "陈思远来了",
                    "The pinyin correction differs: \(everyday.text)")

        // Nothing would be lost: the quit check does not ask.
        let idleQuit = quit(.alertSecondButtonReturn)
        try require(idleQuit.alert == nil && idleQuit.proceed == true, "The quit check asked with nothing to lose")

        // Authorized now: no second explanation. A failed piece and the piece
        // after it wait for 重试, which inserts them in spoken order.
        harness.panel.composer.string = ""
        dictation.pieceSeconds = 0.25
        var slow = extrasASR("第一段。")
        slow.delay = 0.5
        AgentStubProtocol.reset([extrasASR("", status: 500), slow, extrasASR("第二段。")])
        var stops = audio.stops
        harness.panel.micButton.performClick(nil)
        try wait { dictation.phase == .recording }
        // Recording: the quit check asks, and 取消 keeps recording.
        let recordingQuit = quit(.alertSecondButtonReturn)
        try require(recordingQuit.alert?.messageText == "退出并丢弃听写录音？" && recordingQuit.alert?.informativeText.contains("正在录音") == true
                    && recordingQuit.alert?.buttons.map(\.title) == ["退出", "取消"] && recordingQuit.proceed == false
                    && dictation.phase == .recording && audio.stops == stops, "The quit check while recording differs")
        audio.push(6_000)
        try wait { AgentStubProtocol.requests.count == 1 && dictation.failedPieces == 1 }
        harness.panel.micButton.performClick(nil)
        try wait { dictation.phase == .idle }
        try require(explanations() == 1 && microphone.requests == 1 && harness.panel.composer.string.isEmpty && dictation.failedPieces == 2
                    && AgentStubProtocol.requests.count == 1 && !harness.panel.dictationRetryButton.isHidden
                    && harness.panel.dictationLabel.stringValue.contains("录音已保留") && harness.panel.dictationLabel.stringValue.contains("2 段待重试"),
                    "The later piece did not wait behind the failed one: \(harness.panel.composer.string) \(harness.panel.dictationLabel.stringValue)")
        // Pieces kept for 重试: the quit check asks, and 取消 keeps them.
        let keptQuit = quit(.alertSecondButtonReturn)
        try require(keptQuit.alert?.informativeText.contains("2 段录音没有转写成功") == true && keptQuit.proceed == false && dictation.failedPieces == 2,
                    "The quit check with kept pieces differs")
        // A new recording would wait behind them: the mic asks first, and 取消 records nothing.
        let startsBefore = audio.starts, asked = alerts.count
        response = .alertThirdButtonReturn
        harness.panel.micButton.performClick(nil)
        response = .alertFirstButtonReturn
        try require(alerts.count == asked + 1 && alerts.last?.messageText == "先处理等待重试的录音？"
                    && alerts.last?.buttons.map(\.title) == ["重试", "放弃并录音", "取消"] && dictation.phase == .idle
                    && dictation.failedPieces == 2 && audio.starts == startsBefore && AgentStubProtocol.requests.count == 1
                    && !harness.panel.dictationDiscardButton.isHidden, "The mic did not ask about the kept pieces")
        dictation.start()
        try require(dictation.phase == .idle && audio.starts == startsBefore && dictation.error?.contains("2 段录音等待重试") == true,
                    "A recording started behind the kept pieces")
        harness.panel.dictationRetryButton.performClick(nil)
        try wait { AgentStubProtocol.requests.count == 2 }
        // Transcribing: the quit check asks.
        let transcribingQuit = quit(.alertSecondButtonReturn)
        try require(dictation.phase == .transcribing && transcribingQuit.alert?.informativeText.contains("正在转写") == true
                    && transcribingQuit.proceed == false, "The quit check while transcribing differs")
        try wait { dictation.phase == .idle && dictation.failedPieces == 0 }
        try require(harness.panel.composer.string == "第一段。\n第二段。" && AgentStubProtocol.requests.count == 3 && harness.panel.dictationRetryButton.isHidden,
                    "重试 did not keep spoken order: \(harness.panel.composer.string)")

        // A device change ends the recording; what was captured is transcribed, saying why.
        harness.panel.composer.string = ""
        dictation.pieceSeconds = 180
        AgentStubProtocol.reset([extrasASR("第三段。")])
        stops = audio.stops
        harness.panel.micButton.performClick(nil)
        try wait { dictation.phase == .recording }
        audio.push(4_000)
        audio.fail(AudioEngineSource.deviceChanged)
        try wait { dictation.phase == .idle }
        try require(audio.stops == stops + 1 && AgentStubProtocol.requests.count == 1 && harness.panel.composer.string == "第三段。"
                    && harness.panel.dictationLabel.stringValue == "录音中断：\(AudioEngineSource.deviceChanged)" && harness.panel.micButton.title == "听写",
                    "A device change did not end and transcribe the recording: \(harness.panel.dictationLabel.stringValue)")
        // The engine source reports its own engine's configuration change once, until stopped.
        let engineSource = AudioEngineSource()
        var reasons: [String] = []
        engineSource.watchConfigurationChanges { reasons.append($0) }
        NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: NSObject())
        NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: engineSource.engine)
        NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: engineSource.engine)
        try wait { !reasons.isEmpty }
        engineSource.watchConfigurationChanges { reasons.append("stopped: " + $0) }
        engineSource.stop()
        NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: engineSource.engine)
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        try require(reasons == [AudioEngineSource.deviceChanged], "The engine's configuration change was not reported once: \(reasons)")

        // A failed piece, then 放弃并录音: it is given up and a new recording starts.
        AgentStubProtocol.reset([extrasASR("", status: 500)])
        harness.panel.micButton.performClick(nil)
        try wait { dictation.phase == .recording }
        audio.push(4_000)
        harness.panel.micButton.performClick(nil)
        try wait { dictation.phase == .idle && dictation.failedPieces == 1 }
        response = .alertSecondButtonReturn
        harness.panel.micButton.performClick(nil)
        response = .alertFirstButtonReturn
        try wait { dictation.phase == .recording }
        try require(dictation.failedPieces == 0 && harness.panel.dictationDiscardButton.isHidden && AgentStubProtocol.requests.count == 1,
                    "放弃并录音 did not give up the piece and record")
        // 退出 keeps the recording until the close has succeeded; then it is dropped and nothing is sent.
        audio.push(4_000)
        let leave = quit(.alertFirstButtonReturn)
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        try require(leave.alert != nil && leave.proceed == true && dictation.phase == .recording && dictation.quitWarning != nil,
                    "退出 dropped the recording before the close succeeded")
        harness.panel.discardDictation()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        try require(dictation.phase == .idle && dictation.failedPieces == 0 && dictation.quitWarning == nil
                    && AgentStubProtocol.requests.count == 1 && harness.panel.micButton.title == "听写", "The closed workspace did not drop the recording")

        // A denied microphone is refused in Chinese and records nothing.
        let starts = audio.starts
        microphone.status = .denied
        harness.panel.micButton.performClick(nil)
        try require(dictation.phase == .idle && audio.starts == starts && harness.panel.dictationLabel.stringValue.contains("系统设置 › 隐私与安全性 › 麦克风"),
                    "A denied microphone was not refused")
        pane.clearSpeechKey()
        try require(harness.credentials.secrets[SpeechCredentials.account] == nil && pane.speechStatus.stringValue == "未设置", "清除 kept the key")
        try harness.close()
    }

}
